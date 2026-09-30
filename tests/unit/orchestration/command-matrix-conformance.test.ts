import { describe, expect, it } from "vitest"
import { digestDispatchEnvelope } from "../../../src/orchestration/digest.js"
import {
  commandIdSchema,
  correlationIdSchema,
  epochSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  taskIdSchema,
} from "../../../src/orchestration/identifiers.js"
import { COMMAND_MATRIX, validateCommandStateByType } from "../../../src/orchestration/invariants.js"
import { dispatchEnvelopeSchema, orchestrationCommandSchema } from "../../../src/orchestration/schemas.js"
import {
  APPROVAL_STATES,
  DISPATCH_STATES,
  RUN_STATES,
  SESSION_STATES,
  TASK_STATES,
} from "../../../src/orchestration/transitions.js"
import type {
  ApprovalState,
  DispatchState,
  RunState,
  SessionObservedState,
  SessionState,
  TaskState,
} from "../../../src/orchestration/transitions.js"
import { reduceEvent } from "../../../src/orchestration/projections/index.js"
import type { RunProjectionState } from "../../../src/orchestration/projections/types.js"
import { DispatchCoordinator, type CommandLog, type CoordinatorDependencies } from "../../../src/orchestration/coordinator/index.js"
import type { OrchestrationCommand } from "../../../src/orchestration/types.js"
import type { EventInput, OutboxRecordInput } from "../../../src/orchestration/event-store/types.js"

/**
 * M4-M conformance.
 *
 * The plan's gate is blunt about why this file exists: "This criterion is what
 * stops the matrix from becoming decorative again." `COMMAND_MATRIX` was
 * exhaustive and compile-checked for years while NOTHING read it in production,
 * and it carried a self-contradictory entry for `dispatch.retry` the whole time.
 * An exhaustive `Record<CommandType, ...>` is a documentation device, not a gate.
 * It only became a gate when `DispatchCoordinator.submit` started consulting it,
 * and it only stays one if something proves — for every command type and every
 * forbidden state — that the seam actually refuses.
 *
 * So this file does not test the matrix in isolation. It tests the SEAM, and it
 * tests it from the RECORDED projection, which is the only place an
 * authorization may come from.
 */

const PROJECT = projectIdSchema.parse("proj-1")
const RUN = runIdSchema.parse("run-1")
const TASK_ID = taskIdSchema.parse("task-1")
const ACTOR = { kind: "user" as const, userId: "user-1" as never }
const NOW = "2026-09-28T00:00:00.000Z"
const DISPATCH_ID = "disp-1"
const SESSION_ID = "sess-1"

// --- Command vocabulary, derived rather than restated -----------------------

/**
 * Every command type, taken from the Zod discriminated union itself.
 *
 * A hand-written list here would be a second place to forget to update, and
 * forgetting is exactly the failure this file exists to catch. Deriving it means
 * adding a command type to `orchestrationCommandSchema` without a matrix entry
 * fails THIS test, not just the compiler.
 */
const UNION_OPTIONS = orchestrationCommandSchema.options ?? []
const ALL_COMMAND_TYPES = UNION_OPTIONS.map((option) => option.shape.type.value) as readonly OrchestrationCommand["type"][]

/** Command types the coordinator can actually plan. */
const PLANNED_BY_COORDINATOR = [
  "run.create",
  "run.pause",
  "run.resume",
  "run.cancel",
  "dispatch.propose",
  "dispatch.approve",
  "dispatch.retry",
  "dispatch.timeout.request",
  "dispatch.execute",
] as const satisfies readonly OrchestrationCommand["type"][]

/** Command types the coordinator refuses as unimplemented, matrix first. */
const SESSION_COMMAND_TYPES = [
  "session.prompt",
  "session.respond",
  "session.interrupt",
  "session.terminate",
] as const satisfies readonly OrchestrationCommand["type"][]

// --- Fixtures ---------------------------------------------------------------

/**
 * The matrix dimensions, in the order the negative suite covers them.
 *
 * Declared as a literal tuple rather than derived from `Object.keys` so the
 * element type is the union of the five fields. A `Record<string, ...>` would
 * force a cast at every use and the cast is exactly where a typo would hide.
 */
const MATRIX_FIELDS = [
  "allowedRunStates",
  "allowedTaskStates",
  "allowedDispatchStates",
  "allowedApprovalStates",
  "allowedSessionStates",
] as const

type MatrixField = (typeof MATRIX_FIELDS)[number]
type MatrixDimension = "runState" | "taskState" | "dispatchState" | "approvalState" | "sessionState"

/**
 * The kernel's state vocabulary, per matrix dimension, read from
 * `../transitions.js` rather than restated.
 *
 * A test that lists the states itself is a second source of truth: adding a
 * kernel state would leave the test green and the matrix entry silently stale.
 */
const ALL_STATES_BY_FIELD: Readonly<Record<MatrixField, readonly string[]>> = {
  allowedRunStates: RUN_STATES,
  allowedTaskStates: TASK_STATES,
  allowedDispatchStates: DISPATCH_STATES,
  allowedApprovalStates: APPROVAL_STATES,
  allowedSessionStates: SESSION_STATES,
}

const DIMENSION_BY_FIELD: Readonly<Record<MatrixField, MatrixDimension>> = {
  allowedRunStates: "runState",
  allowedTaskStates: "taskState",
  allowedDispatchStates: "dispatchState",
  allowedApprovalStates: "approvalState",
  allowedSessionStates: "sessionState",
}

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return dispatchEnvelopeSchema.parse({
    schemaVersion: 1,
    dispatchId: DISPATCH_ID,
    attempt: 1,
    projectId: PROJECT,
    runId: RUN,
    taskId: TASK_ID,
    targetNodeId: "node-1",
    installationId: "inst-1",
    runtimeKind: "opencode",
    projectPathId: "path-1",
    prompt: "do the thing",
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "role-1",
      templateVersion: 1,
      projectId: PROJECT,
      name: "Runner",
      purpose: "run",
      instructions: "run",
      requiredCapabilities: ["fs.read"],
      preferredRuntimeKinds: ["opencode"],
      contextSelectionPolicyReference: { namespace: "t", id: "r" },
      permissionRestrictions: {
        allowedCapabilities: ["fs.read"],
        deniedCapabilities: [],
        approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
      },
      author: ACTOR,
      createdAt: NOW,
    },
    ruleSnapshots: [],
    contextManifest: { references: [], manifestDigest: `sha256:${"0".repeat(64)}` },
    requestedCapabilities: ["fs.read"],
    permissionEnvelope: {
      allowedCapabilities: ["fs.read"],
      deniedCapabilities: [],
      approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
    },
    dependencies: [],
    timeoutSeconds: 600,
    controllerEpoch: 1,
    ...overrides,
  })
}

function makeApproval(overrides: Record<string, unknown> = {}) {
  const envelope = makeEnvelope()
  return {
    schemaVersion: 1,
    approvalId: "appr-1",
    projectId: PROJECT,
    runId: RUN,
    dispatchId: envelope.dispatchId,
    envelopeDigest: digestDispatchEnvelope(envelope),
    decision: "approved",
    state: "approved",
    basis: { kind: "user" },
    actor: ACTOR,
    decidedAt: NOW,
    ...overrides,
  }
}

function makeDispatch(overrides: Record<string, unknown> = {}, envelopeOverrides: Record<string, unknown> = {}) {
  const envelope = makeEnvelope(envelopeOverrides)
  return {
    schemaVersion: 1,
    envelope,
    envelopeDigest: digestDispatchEnvelope(envelope),
    state: "proposed",
    createdAt: NOW,
    externalReferences: [],
    ...overrides,
  }
}

function makeRun(state: RunState = "active") {
  return {
    schemaVersion: 1,
    runId: RUN,
    projectId: PROJECT,
    goal: "g",
    state,
    paused: false,
    createdAt: NOW,
    updatedAt: NOW,
    externalReferences: [],
  }
}

function makeTask(state: TaskState = "ready") {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    runId: RUN,
    projectId: PROJECT,
    title: "t",
    description: "d",
    state,
    failurePolicy: "block",
    dependencies: [],
    externalReferences: [],
  }
}

function baseCommand(type: OrchestrationCommand["type"], payload: unknown, commandId = `cmd-${type}`): OrchestrationCommand {
  return {
    schemaVersion: 1,
    commandId: commandIdSchema.parse(commandId),
    type,
    projectId: PROJECT,
    runId: RUN,
    actor: ACTOR,
    controllerNodeId: nodeIdSchema.parse("node-1"),
    controllerEpoch: epochSchema.parse(1),
    leaseId: leaseIdSchema.parse("lease-1"),
    issuedAt: NOW,
    expiresAt: "2026-09-28T01:00:00.000Z",
    correlationId: correlationIdSchema.parse("corr-1"),
    causation: null,
    payload,
  } as unknown as OrchestrationCommand
}

function seedEvent(type: string, payload: unknown, sequence: number) {
  return {
    schemaVersion: 1,
    eventId: `seed-${sequence}`,
    sequence,
    type,
    projectId: PROJECT,
    runId: RUN,
    occurredAt: NOW,
    actor: ACTOR,
    controllerEpoch: 1,
    correlationId: "corr-1",
    causation: null,
    payload,
  } as never
}

const OBSERVED_FOR_SESSION: Readonly<Record<SessionState, SessionObservedState>> = {
  launching: "starting",
  running: "working",
  idle: "idle",
  completed: "completed",
  failed: "failed",
  cancelled: "unknown",
  timed_out: "unknown",
}

/**
 * The neutral recorded state: an ACTIVE run, a READY task, an APPROVED dispatch
 * with a live APPROVED approval.
 *
 * Built by replaying events rather than by hand, because "what the log actually
 * produces" is the thing the matrix is supposed to be reading.
 */
function baselineProjection(): RunProjectionState {
  let projection = reduceEvent(null, seedEvent("run.created", { run: makeRun("active") }, 1))
  projection = reduceEvent(projection, seedEvent("task.created", { task: makeTask("ready") }, 2))
  projection = reduceEvent(projection, seedEvent("dispatch.proposed", { dispatch: makeDispatch() }, 3))
  projection = reduceEvent(projection, seedEvent("approval.decided", { approval: makeApproval() }, 4))
  return projection
}

/**
 * The baseline plus a started session in `lifecycle`.
 *
 * `dispatch.started` is the only event that carries a session, and it also moves
 * the dispatch to `running` — which is precisely the state
 * `dispatch.timeout.request` and every `session.*` command want, so no hand
 * editing is needed for the session dimension at all.
 */
function withSession(lifecycle: SessionState = "running"): RunProjectionState {
  return reduceEvent(
    baselineProjection(),
    seedEvent(
      "dispatch.started",
      {
        session: {
          schemaVersion: 1,
          sessionId: SESSION_ID,
          projectId: PROJECT,
          runId: RUN,
          taskId: TASK_ID,
          dispatchId: DISPATCH_ID,
          nodeId: "node-1",
          installationId: "inst-1",
          runtimeKind: "opencode",
          lifecycleState: lifecycle,
          observedState: OBSERVED_FOR_SESSION[lifecycle],
        },
      },
      5,
    ),
  )
}

/**
 * Forces ONE recorded aggregate state, leaving every other dimension alone.
 *
 * Overriding rather than replaying is deliberate and is the only place this file
 * stops being a faithful replay. The reducer couples states on purpose: a single
 * task that reaches a terminal dispatch necessarily drives the run terminal too,
 * so no event sequence can produce "run `active`, dispatch `completed`". A
 * negative test that varies two dimensions at once proves nothing about either,
 * so the log is asked to hold one state at a time. The states themselves are real
 * kernel states from `../transitions.js` — the matrix still refuses exactly the
 * states a real log could have produced.
 */
function inState(overrides: {
  runState?: RunState
  taskState?: TaskState
  dispatchState?: DispatchState
  approvalState?: ApprovalState
  sessionState?: SessionState
}): RunProjectionState {
  // A session exists only when the session dimension is the one under test.
  // `dispatch.started` also moves the dispatch to `running`, and a `running`
  // dispatch with a recorded session makes `dispatch.execute` converge to a
  // no-op, so leaving the session in every seed would quietly exempt half of
  // this file from testing anything.
  let projection: RunProjectionState = overrides.sessionState === undefined ? baselineProjection() : withSession()
  if (overrides.runState !== undefined) {
    projection = {
      ...projection,
      run: { ...projection.run, lifecycleState: overrides.runState, state: overrides.runState },
    }
  }
  if (overrides.taskState !== undefined) {
    const task = projection.tasks[TASK_ID]!
    projection = {
      ...projection,
      tasks: { ...projection.tasks, [TASK_ID]: { ...task, lifecycleState: overrides.taskState, state: overrides.taskState } },
    }
  }
  if (overrides.dispatchState !== undefined) {
    const dispatch = projection.dispatches[DISPATCH_ID]!
    projection = {
      ...projection,
      dispatches: {
        ...projection.dispatches,
        [DISPATCH_ID]: { ...dispatch, lifecycleState: overrides.dispatchState, state: overrides.dispatchState },
      },
    }
  }
  if (overrides.approvalState !== undefined) {
    const approval = projection.approvals["appr-1"]!
    projection = {
      ...projection,
      approvals: { ...projection.approvals, "appr-1": { ...approval, state: overrides.approvalState } },
    }
  }
  if (overrides.sessionState !== undefined) {
    const session = projection.sessions[SESSION_ID]!
    projection = {
      ...projection,
      sessions: { ...projection.sessions, [SESSION_ID]: { ...session, state: overrides.sessionState } },
    }
  }
  return projection
}

/**
 * A command log that records everything, plus a `readRun` spy.
 *
 * The spy is load-bearing. `#plan`'s fallback for the `session.*` types returns
 * `command_unsupported` WITHOUT reading anything, so any `readRun` call for one
 * of those commands can only have come from the matrix — which is how the
 * "consulted before the coordinator's own refusal" claim is proven rather than
 * asserted.
 */
function makeHarness(seed: RunProjectionState) {
  const calls: { command: OrchestrationCommand; events: readonly EventInput[]; outboxRecords: readonly OutboxRecordInput[] }[] = []
  const readRunCalls: string[] = []

  const log: CommandLog = {
    append(options) {
      calls.push({ command: options.command, events: options.events, outboxRecords: options.outboxRecords ?? [] })
      return { duplicate: false, events: options.events }
    },
  }

  const deps: CoordinatorDependencies = {
    log,
    now: () => NOW,
    newEventId: () => "evt-1",
    readRun: (runId) => {
      readRunCalls.push(runId)
      return seed.run.runId === runId ? seed : undefined
    },
  }

  return { coordinator: new DispatchCoordinator(deps), calls, readRunCalls }
}

/** The payload each command type needs, named so a refusal is unambiguous. */
function payloadFor(type: OrchestrationCommand["type"]): unknown {
  switch (type) {
    case "run.create":
      return { run: makeRun("draft"), tasks: [makeTask("pending")] }
    case "run.pause":
    case "run.resume":
    case "run.cancel":
      return { reason: "operator" }
    case "dispatch.propose":
      return { dispatch: makeDispatch() }
    case "dispatch.approve":
      return { dispatch: makeDispatch({ state: "approved" }), approval: makeApproval() }
    case "dispatch.retry":
      return { dispatch: makeDispatch({}, { dispatchId: "disp-2", attempt: 2 }), previousDispatchId: DISPATCH_ID, previousAttempt: 1 }
    case "dispatch.timeout.request":
      return { dispatchId: DISPATCH_ID, reason: "too slow" }
    case "dispatch.execute":
      return { dispatch: makeDispatch({ state: "approved" }), approval: makeApproval() }
    case "session.prompt":
      return { sessionId: SESSION_ID, prompt: "hello" }
    case "session.respond":
      return { sessionId: SESSION_ID, requestId: "req-1", decision: "allow_once" }
    case "session.interrupt":
    case "session.terminate":
      return { sessionId: SESSION_ID, reason: "operator" }
  }
}

function commandFor(type: OrchestrationCommand["type"], commandId = `cmd-${type}`): OrchestrationCommand {
  return baseCommand(type, payloadFor(type), commandId)
}

/**
 * The forbidden transitions, stated as the dimensions each entry does NOT allow.
 *
 * The expectation is per row, not per case, because the kernel has one
 * deliberate exception and it would be dishonest to dress it up as a refusal:
 * `run.cancel` against a terminal run is the at-least-once redelivery case. A
 * retried cancel must not read as an operator-visible conflict, so it converges
 * to a recorded no-op. What it may NEVER do is append anything, and that is
 * asserted for every row.
 */
const FORBIDDEN_TRANSITIONS: readonly {
  type: OrchestrationCommand["type"]
  dimension: "runState" | "taskState" | "dispatchState" | "approvalState" | "sessionState"
  forbidden: readonly string[]
  expectation: "refused" | "converged-no-op"
}[] = [
  { type: "run.create", dimension: "runState", forbidden: RUN_STATES.filter((s) => s !== "draft"), expectation: "refused" },
  { type: "run.pause", dimension: "runState", forbidden: ["completed", "failed", "cancelled"], expectation: "refused" },
  { type: "run.resume", dimension: "runState", forbidden: ["completed", "failed", "cancelled"], expectation: "refused" },
  { type: "run.cancel", dimension: "runState", forbidden: ["completed", "failed", "cancelled"], expectation: "converged-no-op" },
  { type: "dispatch.propose", dimension: "runState", forbidden: ["completed", "failed", "cancelled"], expectation: "refused" },
  {
    type: "dispatch.propose",
    dimension: "taskState",
    forbidden: TASK_STATES.filter((s) => s !== "ready"),
    expectation: "refused",
  },
  { type: "dispatch.approve", dimension: "runState", forbidden: ["completed", "failed", "cancelled"], expectation: "refused" },
  {
    type: "dispatch.approve",
    dimension: "dispatchState",
    forbidden: DISPATCH_STATES.filter((s) => !COMMAND_MATRIX["dispatch.approve"].allowedDispatchStates!.includes(s as never)),
    expectation: "refused",
  },
  {
    type: "dispatch.approve",
    dimension: "taskState",
    forbidden: TASK_STATES.filter((s) => s !== "ready"),
    expectation: "refused",
  },
  { type: "dispatch.retry", dimension: "runState", forbidden: ["completed", "failed", "cancelled"], expectation: "refused" },
  {
    type: "dispatch.retry",
    dimension: "dispatchState",
    forbidden: DISPATCH_STATES.filter(
      (s) => !COMMAND_MATRIX["dispatch.retry"].allowedDispatchStates!.includes(s as never),
    ),
    expectation: "refused",
  },
  { type: "dispatch.timeout.request", dimension: "runState", forbidden: ["completed", "failed", "cancelled"], expectation: "refused" },
  {
    type: "dispatch.timeout.request",
    dimension: "dispatchState",
    forbidden: DISPATCH_STATES.filter(
      (s) => !COMMAND_MATRIX["dispatch.timeout.request"].allowedDispatchStates!.includes(s as never),
    ),
    expectation: "refused",
  },
  {
    type: "dispatch.timeout.request",
    dimension: "sessionState",
    forbidden: SESSION_STATES.filter(
      (s) => !COMMAND_MATRIX["dispatch.timeout.request"].allowedSessionStates!.includes(s as never),
    ),
    expectation: "refused",
  },
  { type: "dispatch.execute", dimension: "runState", forbidden: ["completed", "failed", "cancelled"], expectation: "refused" },
  {
    type: "dispatch.execute",
    dimension: "dispatchState",
    forbidden: DISPATCH_STATES.filter((s) => s !== "approved"),
    expectation: "refused",
  },
  {
    type: "dispatch.execute",
    dimension: "approvalState",
    forbidden: APPROVAL_STATES.filter((s) => s !== "approved"),
    expectation: "refused",
  },
  {
    type: "dispatch.execute",
    dimension: "taskState",
    forbidden: TASK_STATES.filter((s) => s !== "ready"),
    expectation: "refused",
  },
  { type: "session.prompt", dimension: "runState", forbidden: RUN_STATES.filter((s) => s !== "active"), expectation: "refused" },
  {
    type: "session.prompt",
    dimension: "sessionState",
    forbidden: SESSION_STATES.filter((s) => s !== "idle"),
    expectation: "refused",
  },
  { type: "session.respond", dimension: "runState", forbidden: RUN_STATES.filter((s) => s !== "active"), expectation: "refused" },
  {
    type: "session.respond",
    dimension: "sessionState",
    forbidden: SESSION_STATES.filter((s) => !["running", "idle"].includes(s)),
    expectation: "refused",
  },
  { type: "session.interrupt", dimension: "runState", forbidden: RUN_STATES.filter((s) => s !== "active"), expectation: "refused" },
  {
    type: "session.interrupt",
    dimension: "sessionState",
    forbidden: SESSION_STATES.filter((s) => s !== "running"),
    expectation: "refused",
  },
  { type: "session.terminate", dimension: "runState", forbidden: ["completed", "failed", "cancelled"], expectation: "refused" },
  {
    type: "session.terminate",
    dimension: "sessionState",
    forbidden: SESSION_STATES.filter((s) => !["launching", "running", "idle"].includes(s)),
    expectation: "refused",
  },
]

// --- 1. Conformance: the vocabulary and the matrix agree ---------------------

describe("M4-M conformance: the matrix covers the command vocabulary", () => {
  it("derives the command types from the Zod union, so the list cannot drift", () => {
    // If this ever comes back empty the whole file is vacuous, and a vacuous
    // conformance suite is worse than none: it reports green while proving
    // nothing.
    expect(ALL_COMMAND_TYPES.length).toBeGreaterThan(0)
    expect(new Set(ALL_COMMAND_TYPES).size).toBe(ALL_COMMAND_TYPES.length)
    expect([...ALL_COMMAND_TYPES].sort()).toEqual(
      [...PLANNED_BY_COORDINATOR, ...SESSION_COMMAND_TYPES].sort(),
    )
  })

  it("has an entry for every command type, and no entry for a type that does not exist", () => {
    for (const type of ALL_COMMAND_TYPES) {
      expect(COMMAND_MATRIX[type], `COMMAND_MATRIX is missing an entry for '${type}'`).toBeDefined()
    }
    expect(Object.keys(COMMAND_MATRIX).sort()).toEqual([...ALL_COMMAND_TYPES].sort())
  })

  it("states only real kernel states, and never an empty list", () => {
    // An empty allowlist would be a plausible-looking way to disable a command
    // while keeping the entry present, and a typo'd state would silently make
    // the command permanently unplannable. Both are checked against
    // `../transitions.js` rather than against a list written here.
    for (const type of ALL_COMMAND_TYPES) {
      const rule = COMMAND_MATRIX[type]
      expect(rule.allowedRunStates.length, `'${type}' must state the run states it acts in`).toBeGreaterThan(0)
      for (const field of MATRIX_FIELDS) {
        const states = rule[field]
        if (states === undefined) continue
        expect(states.length, `'${type}'.${field} is present but empty`).toBeGreaterThan(0)
        for (const state of states) {
          expect(
            ALL_STATES_BY_FIELD[field].includes(state),
            `'${type}'.${field} names '${state}', which is not a kernel ${DIMENSION_BY_FIELD[field]} state`,
          ).toBe(true)
        }
      }
    }
  })
})

// --- 2. Conformance: the seam consults the matrix ---------------------------

describe("M4-M conformance: the seam consults the matrix for every command type", () => {
  for (const type of PLANNED_BY_COORDINATOR) {
    it(`refuses '${type}' in a state its entry forbids`, () => {
      const rule = COMMAND_MATRIX[type]
      // The run is the one dimension every entry constrains, so the run
      // dimension alone is enough to prove the seam reaches the matrix for this
      // type. `run.create` is the exception that proves the rule: its entry
      // allows `draft`, so `active` is the forbidden state.
      const forbiddenRun = RUN_STATES.find((state) => !rule.allowedRunStates.includes(state))!
      const harness = makeHarness(inState({ runState: forbiddenRun }))

      const result = harness.coordinator.submit(commandFor(type))

      // The outcome follows the same table the negative suite uses, so the
      // one deliberate exemption is visible in both places instead of being
      // quietly re-decided here.
      const expectation = FORBIDDEN_TRANSITIONS.find((row) => row.type === type && row.dimension === "runState")!
      if (expectation.expectation === "refused") {
        expect(result.ok).toBe(false)
        expect(harness.calls).toHaveLength(0)
      } else {
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.events).toEqual([])
        // The converged no-op still goes through `log.append`, because the
        // command receipt is what makes the redelivery a duplicate rather than
        // a second cancel. What must be empty is the EVENT list and the outbox.
        expect(harness.calls.flatMap((call) => call.events)).toEqual([])
        expect(harness.calls.flatMap((call) => call.outboxRecords)).toEqual([])
      }
      // And the matrix refuses this context in its own terms, so the seam was
      // not reading an answer and then ignoring it.
      expect(validateCommandStateByType(type, { runState: forbiddenRun }).ok).toBe(false)
    })
  }

  for (const type of SESSION_COMMAND_TYPES) {
    it(`consults the matrix before refusing unimplemented '${type}'`, () => {
      // The coordinator cannot plan these at all, so the ONLY thing that can be
      // observed is whether the matrix ran first. `readRun` is the proof: the
      // `command_unsupported` fallback never reads the recorded log, so a read is
      // attributable to `#matrixContext` alone.
      const rule = COMMAND_MATRIX[type]
      const forbiddenRun = RUN_STATES.find((state) => !rule.allowedRunStates.includes(state))!
      const harness = makeHarness(inState({ runState: forbiddenRun }))

      const result = harness.coordinator.submit(commandFor(type))

      expect(harness.readRunCalls).toContain(RUN)
      expect(harness.calls).toHaveLength(0)
      // The coordinator's own, more specific reason is what the caller sees —
      // the matrix refusal is still binding, it is just not the most informative
      // thing to say about a command nothing implements.
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe("coordinator.command_unsupported")
      // And the matrix really does refuse this context, so the seam was not
      // reading it and then ignoring the answer.
      expect(validateCommandStateByType(type, { runState: forbiddenRun }).ok).toBe(false)
    })
  }
})

// --- 3. Negative evidence: every forbidden transition -----------------------

describe("M4-M negative evidence: a forbidden transition is refused and writes nothing", () => {
  it("has a case for every dimension every command type constrains", () => {
    // Without this, adding `allowedTaskStates` to a new entry would silently
    // escape the negative suite, and the suite is the only thing that would have
    // noticed. A dimension whose entry lists EVERY state — `dispatch.approve`'s
    // approval states, for instance — has no forbidden state to test, so it is
    // exempt from the requirement; what it must not do is carry an empty
    // forbidden list, because that is how a dimension gets dropped by accident.
    const covered = new Set(FORBIDDEN_TRANSITIONS.map((row) => `${row.type}:${row.dimension}`))
    for (const type of ALL_COMMAND_TYPES) {
      for (const field of MATRIX_FIELDS) {
        const states = COMMAND_MATRIX[type][field]
        if (states === undefined) continue
        const dimension = DIMENSION_BY_FIELD[field]
        const row = FORBIDDEN_TRANSITIONS.find((candidate) => candidate.type === type && candidate.dimension === dimension)
        if (row === undefined) {
          // No forbidden state at all is only legitimate when the entry allows
          // the entire vocabulary; otherwise the dimension was simply forgotten.
          if (states.length < ALL_STATES_BY_FIELD[field].length) {
            throw new Error(`no negative case for ${type}.${dimension}, and the entry forbids nothing`)
          }
          continue
        }
        expect(row.forbidden.length, `the ${type}.${dimension} case covers no state`).toBeGreaterThan(0)
        // Every state the row claims is forbidden really is forbidden, or the
        // row is asserting a refusal for a state the matrix licenses.
        for (const state of row.forbidden) {
          expect(states.includes(state as never), `${type}.${dimension} lists '${state}' as forbidden but allows it`).toBe(false)
        }
        // And the row covers every state the entry does not allow, so a widened
        // allowlist cannot quietly fall out of the suite.
        expect([...row.forbidden].sort()).toEqual(
          ALL_STATES_BY_FIELD[field].filter((state) => !states.includes(state as never)).sort(),
        )
        expect(covered.has(`${type}:${dimension}`)).toBe(true)
      }
    }
  })

  for (const row of FORBIDDEN_TRANSITIONS) {
    for (const state of row.forbidden) {
      it(`${row.type} in ${row.dimension} '${state}' is ${row.expectation === "refused" ? "refused" : "a no-op that appends nothing"}`, () => {
        const harness = makeHarness(inState({ [row.dimension]: state } as never))
        const command = commandFor(row.type, `cmd-${row.type}-${row.dimension}-${state}`)

        const result = harness.coordinator.submit(command)

        // The invariant that holds for EVERY row, exception or not: a forbidden
        // command writes no EVENT and names no EFFECT. The append itself is a
        // different matter — the converged no-op still writes a command receipt,
        // which is the whole reason a redelivery is a duplicate instead of a
        // second cancel.
        expect(harness.calls.flatMap((call) => call.events)).toEqual([])
        expect(harness.calls.flatMap((call) => call.outboxRecords)).toEqual([])

        if (row.expectation === "refused") {
          expect(result.ok).toBe(false)
          expect(harness.calls).toHaveLength(0)
        } else {
          expect(result.ok).toBe(true)
          if (result.ok) expect(result.value.events).toEqual([])
        }

        // The matrix refuses this context on its own terms, whatever the
        // coordinator then said about it.
        expect(validateCommandStateByType(row.type, { [row.dimension]: state } as never).ok).toBe(false)
      })
    }
  }
})

// --- 4. The matrix reads the RECORDED log, not the payload ------------------

describe("M4-M: authorization resolves against the recorded log, never the payload", () => {
  it("refuses a command whose payload claims a state the log does not have", () => {
    // The plan's guardrail: "Do not authorize a remote command against its own
    // payload. Authorization resolves against durable recorded state; a payload
    // is a claim, not a grant." A `dispatch.execute` here is entirely
    // self-consistent — the payload dispatch says `approved` and the payload
    // approval is approved and digest-bound — while the LOG says the dispatch is
    // only `proposed`. Nothing is appended.
    const harness = makeHarness(inState({ dispatchState: "proposed" }))
    const command = baseCommand("dispatch.execute", {
      dispatch: makeDispatch({ state: "approved" }),
      approval: makeApproval(),
    })

    const result = harness.coordinator.submit(command)

    expect(result.ok).toBe(false)
    expect(harness.calls).toHaveLength(0)
    // The coordinator's own precondition also catches this one, which is exactly
    // why the matrix is not the only gate — the ordering decides which error the
    // caller sees, not whether the command happens to be caught.
    expect(validateCommandStateByType("dispatch.execute", { dispatchState: "proposed" }).ok).toBe(false)
  })

  it("refuses on a dimension the coordinator never inspects at all", () => {
    // The strong form of the test above. `#requestTimeout` checks the dispatch
    // and nothing else, so this refusal can only have come from the matrix: the
    // recorded SESSION is `completed`, the recorded dispatch is `running` and
    // un-requested, and the payload names nothing about sessions at all.
    const harness = makeHarness(inState({ sessionState: "completed" }))

    const result = harness.coordinator.submit(commandFor("dispatch.timeout.request"))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("command.terminal_state_immutable")
    expect(harness.calls).toHaveLength(0)
  })
})

// --- 5. The converged no-op exemption cannot be abused ----------------------

describe("M4-M: the converged no-op exemption cannot launder a forbidden command", () => {
  it("the exemption applies only when the plan is genuinely empty", () => {
    // The exemption exists so at-least-once redelivery is harmless. It is
    // checked on the coordinator's own plan, which is why it is safe: a command
    // that WOULD append an event is refused no matter how harmless the retry
    // looks. Proof that this command really does plan a real event comes from the
    // first half, where the session is legal and the append happens.
    const legal = makeHarness(inState({ sessionState: "running" }))
    const licensed = legal.coordinator.submit(commandFor("dispatch.timeout.request", "cmd-timeout-licensed"))
    expect(licensed.ok).toBe(true)
    if (licensed.ok) expect(licensed.value.events).toEqual(["dispatch.timeout.requested"])
    expect(legal.calls).toHaveLength(1)
    expect(legal.calls[0]!.outboxRecords).toHaveLength(0)

    // Same command, forbidden session: the plan is identical and non-empty, and
    // the matrix is the only thing that refuses it. If the exemption were
    // "the matrix said no, so return a no-op", this would have been accepted.
    const forbidden = makeHarness(inState({ sessionState: "failed" }))
    const refused = forbidden.coordinator.submit(commandFor("dispatch.timeout.request", "cmd-timeout-forbidden"))
    expect(refused.ok).toBe(false)
    expect(forbidden.calls).toHaveLength(0)
  })

  it("an exemption may not be reached by a command that would name an outbox effect", () => {
    // `dispatch.execute` is the only command that names a runtime destination, so
    // it is the one where "empty plan" must be read as "no events AND no
    // effects". With a recorded approval that is not approved, the coordinator
    // refuses anyway, and the point is that nothing reaches the log or an outbox
    // on the strength of the matrix having said no.
    const harness = makeHarness(inState({ approvalState: "invalidated" }))

    const result = harness.coordinator.submit(
      baseCommand("dispatch.execute", { dispatch: makeDispatch({ state: "approved" }), approval: makeApproval() }),
    )

    expect(result.ok).toBe(false)
    expect(harness.calls).toHaveLength(0)
    expect(harness.calls.flatMap((call) => call.outboxRecords)).toEqual([])
  })

  it("a matrix refusal can still surface as a success, and that is pinned on purpose", () => {
    // The sharpest edge of the exemption, recorded here so a future change to it
    // has to be a decision rather than an accident. When the log holds a
    // terminal run AND a session for this dispatch, `#executeDispatch` answers a
    // repeat of the very command that launched it with the recorded session and
    // an empty plan. The matrix refuses (the run is terminal), and the exemption
    // then converts that refusal into `ok` with zero events.
    //
    // This is not a hole — nothing is appended and no outbox record is named, so
    // the recorded log is untouched — but it IS the shape that will matter in
    // M4.4, where a controller-epoch gate is to be enforced through this same
    // matrix: a stale controller must be REFUSED, and "ok, nothing to do" is the
    // worst possible answer to that. The epoch gate will need its own check that
    // a refusal is not quietly answered as a no-op.
    const harness = makeHarness(inState({ runState: "completed", sessionState: "running" }))

    const result = harness.coordinator.submit(commandFor("dispatch.execute", "cmd-execute-terminal-run"))

    expect(validateCommandStateByType("dispatch.execute", { runState: "completed" }).ok).toBe(false)
    expect(harness.calls.flatMap((call) => call.events)).toEqual([])
    expect(harness.calls.flatMap((call) => call.outboxRecords)).toEqual([])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.events).toEqual([])
  })
})

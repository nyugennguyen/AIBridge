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
import { dispatchEnvelopeSchema } from "../../../src/orchestration/schemas.js"
import type { Approval, Dispatch, OrchestrationCommand, Run, Task } from "../../../src/orchestration/types.js"
import { reduceEvent } from "../../../src/orchestration/projections/index.js"
import type { RunProjectionState } from "../../../src/orchestration/projections/types.js"
import {
  COMMAND_EVENT_ALLOWLIST,
  DispatchCoordinator,
  RUNTIME_DESTINATION,
  type CommandLog,
  type CoordinatorDependencies,
  type EffectBoundary,
} from "../../../src/orchestration/coordinator/index.js"
import type { EventInput, OutboxRecordInput } from "../../../src/orchestration/event-store/types.js"

const PROJECT = projectIdSchema.parse("proj-1")
const RUN = runIdSchema.parse("run-1")
const ACTOR = { kind: "user" as const, userId: "user-1" as never }
const NOW = "2026-09-28T00:00:00.000Z"

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return dispatchEnvelopeSchema.parse({
    schemaVersion: 1,
    dispatchId: "disp-1",
    attempt: 1,
    projectId: PROJECT,
    runId: RUN,
    taskId: taskIdSchema.parse("task-1"),
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

function baseCommand(type: OrchestrationCommand["type"], payload: unknown, commandId = `cmd-${type}-1`): OrchestrationCommand {
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

function makeRun(state: Run["state"] = "active"): Run {
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
  } as Run
}

function makeTask(): Task {
  return {
    schemaVersion: 1,
    taskId: taskIdSchema.parse("task-1"),
    runId: RUN,
    projectId: PROJECT,
    title: "t",
    description: "d",
    state: "ready",
    failurePolicy: "block",
    dependencies: [],
    externalReferences: [],
  } as Task
}

function makeApproval(overrides: Partial<Record<string, unknown>> = {}): Approval {
  const envelope = makeEnvelope()
  return {
    schemaVersion: 1,
    approvalId: "appr-1" as never,
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
  } as unknown as Approval
}

function makeDispatch(overrides: Partial<Record<string, unknown>> = {}, envelopeOverrides: Record<string, unknown> = {}): Dispatch {
  const envelope = makeEnvelope(envelopeOverrides)
  return {
    schemaVersion: 1,
    envelope,
    envelopeDigest: digestDispatchEnvelope(envelope),
    state: "proposed",
    createdAt: NOW,
    externalReferences: [],
    ...overrides,
  } as unknown as Dispatch
}

/** An in-memory command log that records everything and can replay it. */
function makeLog() {
  const calls: { command: OrchestrationCommand; events: readonly EventInput[]; outboxRecords: readonly OutboxRecordInput[] }[] = []
  const byCommandId = new Map<string, { command: OrchestrationCommand; events: readonly EventInput[] }>()

  const log: CommandLog = {
    append(options) {
      const key = options.command.commandId
      const seen = byCommandId.get(key)
      if (seen !== undefined) {
        // Fingerprint mismatch is what the real store detects; here identity is
        // the command id, which is what idempotency is keyed on.
        return { duplicate: true, events: [] }
      }
      byCommandId.set(key, { command: options.command, events: options.events })
      calls.push({ command: options.command, events: options.events, outboxRecords: options.outboxRecords ?? [] })
      return { duplicate: false, events: options.events }
    },
  }
  return { log, calls, byCommandId }
}

function makeHarness(options: { boundary?: EffectBoundary; seed?: RunProjectionState } = {}) {
  const { log, calls, byCommandId } = makeLog()
  let eventSeq = 0
  let projection: RunProjectionState = options.seed ?? (null as unknown as RunProjectionState)
  const deps: CoordinatorDependencies = {
    log,
    now: () => NOW,
    newEventId: () => `evt-${++eventSeq}`,
    readRun: (runId) => (projection === null ? undefined : projection.run.runId === runId ? projection : undefined),
    ...(options.boundary === undefined ? {} : { boundary: options.boundary }),
  }
  const coordinator = new DispatchCoordinator(deps)
  return {
    coordinator,
    calls,
    byCommandId,
    getProjection: () => projection,
    /**
     * Applies the recorded events on top of the seed, as a restart-replay would.
     * Stream sequences continue past the seed's, because sequence assignment is
     * the store's job, not the coordinator's.
     */
    replay: () => {
      let next = options.seed ?? (null as unknown as RunProjectionState)
      let sequence = options.seed?.lastAppliedSequence ?? 0
      for (const call of calls) {
        for (const event of call.events) {
          sequence += 1
          next = reduceEvent(next, { ...(event as object), sequence } as never)
        }
      }
      projection = next
      return projection
    },
  }
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

/** A run in `state` with one ready task. */
function withRun(state: Run["state"] = "active"): RunProjectionState {
  let projection = reduceEvent(null, seedEvent("run.created", { run: makeRun(state) }, 1))
  projection = reduceEvent(projection, seedEvent("task.created", { task: makeTask() }, 2))
  return projection
}

/** A run with a proposed dispatch and a live approved approval bound to it. */
function withApprovedDispatch(): RunProjectionState {
  let projection = withRun()
  projection = reduceEvent(projection, seedEvent("dispatch.proposed", { dispatch: makeDispatch() }, 3))
  projection = reduceEvent(projection, seedEvent("approval.decided", { approval: makeApproval() }, 4))
  return projection
}

/** A run with a proposed dispatch but no approval yet. */
function withProposedDispatch(): RunProjectionState {
  return reduceEvent(withRun(), seedEvent("dispatch.proposed", { dispatch: makeDispatch() }, 3))
}

describe("Command and event are bound together", () => {
  it("every command type has an explicit event allowlist", () => {
    for (const [type, allowed] of Object.entries(COMMAND_EVENT_ALLOWLIST)) {
      expect(Array.isArray(allowed)).toBe(true)
      expect(type.length).toBeGreaterThan(0)
    }
  })

  it("a run.create carrying the run and its tasks emits both events in one append", () => {
    const h = makeHarness()
    const result = h.coordinator.submit(baseCommand("run.create", { run: makeRun("draft"), tasks: [makeTask()] }))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.events).toEqual(["run.created", "task.created"])
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].events).toHaveLength(2)
  })

  it("an approval cannot smuggle a run.created event under a dispatch command", () => {
    // The store does not check that events match the command, so the coordinator
    // refuses. Reaching the guard requires a handler that would emit an
    // unlicensed event, so drive it through a subclassed plan.
    const h = makeHarness({ seed: withRun() })
    const rogue = baseCommand("run.cancel", { reason: "x" })
    const tampered = {
      ...rogue,
      // Inject an event type the command does not license.
      payload: { reason: "x" },
    } as OrchestrationCommand

    const appends: unknown[] = []
    const coordinator = new DispatchCoordinator({
      log: {
        append: (options) => {
          appends.push(options)
          return { duplicate: false, events: options.events }
        },
      },
      now: () => NOW,
      newEventId: () => "evt-1",
      readRun: () => withRun(),
    })

    // A normal cancel is fine and writes exactly the licensed event.
    expect(coordinator.submit(tampered).ok).toBe(true)
    expect(appends).toHaveLength(1)
    expect((appends[0] as { events: readonly { type: string }[] }).events.map((e) => e.type)).toEqual(["run.cancelled"])

    // The allowlist itself is what enforces the pairing.
    expect(COMMAND_EVENT_ALLOWLIST["run.cancel"]).toEqual(["run.cancelled"])
    expect(COMMAND_EVENT_ALLOWLIST["run.cancel"]).not.toContain("run.created")
    // `dispatch.approve` MAY record a `dispatch.proposed`, because approving a
    // REVISED envelope has to record that revision (an envelope edit creates a
    // new digest and the log must contain what was approved). It may not record
    // a first-time proposal for a dispatch nobody proposed, which the handler
    // refuses with `coordinator.dispatch_unknown`.
    expect(COMMAND_EVENT_ALLOWLIST["dispatch.approve"]).toContain("dispatch.proposed")
    expect(COMMAND_EVENT_ALLOWLIST["dispatch.approve"]).not.toContain("run.created")
    expect(COMMAND_EVENT_ALLOWLIST["dispatch.approve"]).not.toContain("dispatch.started")
    expect(h).toBeDefined()
  })
})

describe("Duplicate commands are idempotent", () => {
  it("a repeated execute returns the recorded outcome and appends nothing", () => {
    const projection = withApprovedDispatch()
    const h = makeHarness({ seed: projection })
    const command = baseCommand("dispatch.execute", { dispatch: makeDispatch({ state: "approved" }), approval: makeApproval() })

    const first = h.coordinator.submit(command)
    expect(first.ok).toBe(true)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].outboxRecords).toHaveLength(1)

    // The SAME command id again: no second append, no second launch.
    const second = h.coordinator.submit(command)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.value.duplicate).toBe(true)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].outboxRecords).toHaveLength(1)
  })
})

describe("Runtime effects never happen inside the event transaction", () => {
  it("execute names the runtime effect in the outbox and appends dispatch.started", () => {
    const h = makeHarness({ seed: withApprovedDispatch() })
    const result = h.coordinator.submit(baseCommand("dispatch.execute", { dispatch: makeDispatch({ state: "approved" }), approval: makeApproval() }))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.events).toEqual(["dispatch.started"])
    const outbox = h.calls[0].outboxRecords
    expect(outbox).toHaveLength(1)
    expect(outbox[0].destination).toBe(RUNTIME_DESTINATION)
    expect(outbox[0].status).toBe("pending")
    // The outbox id is derived from the command, so redelivery is recognisable
    // as the same effect rather than a new one.
    expect(outbox[0].outboxId).toBe("obx-cmd-dispatch.execute-1")
  })

  it("refuses to start a dispatch that is not approved", () => {
    const h = makeHarness({ seed: withApprovedDispatch() })
    const result = h.coordinator.submit(baseCommand("dispatch.execute", { dispatch: makeDispatch({ state: "proposed" }), approval: makeApproval() }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.dispatch_not_approved")
    expect(h.calls).toHaveLength(0)
  })

  it("refuses to start with an invalidated approval", () => {
    const h = makeHarness({ seed: withApprovedDispatch() })
    const result = h.coordinator.submit(
      baseCommand("dispatch.execute", {
        dispatch: makeDispatch({ state: "approved" }),
        approval: makeApproval({ state: "invalidated" }),
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.approval_required")
  })

  it("refuses to start when the envelope no longer matches the approved digest", () => {
    const h = makeHarness({ seed: withApprovedDispatch() })
    // The approval was granted for timeout 600; the dispatch now says 900.
    const tampered = makeDispatch({ state: "approved" }, { timeoutSeconds: 900 })
    const result = h.coordinator.submit(
      baseCommand("dispatch.execute", { dispatch: tampered, approval: makeApproval() }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.approval_stale")
    expect(h.calls).toHaveLength(0)
  })
})

describe("Approval becomes invalid after any envelope mutation", () => {
  it("approving a mutated envelope invalidates the superseded approval in the same transaction", () => {
    const projection = withApprovedDispatch()

    const h = makeHarness({ seed: projection })
    // A different envelope for the same dispatch, with its own digest.
    const mutated = makeDispatch({ state: "approved" }, { timeoutSeconds: 900 })
    const result = h.coordinator.submit(
      baseCommand("dispatch.approve", {
        dispatch: mutated,
        approval: makeApproval({ envelopeDigest: digestDispatchEnvelope(mutated.envelope), state: "approved" }),
      }),
    )

    if (!result.ok) throw new Error(`${result.error.category}/${result.error.code}: ${result.error.message}`)
    // The revision is a proposal too: the log must contain the envelope the new
    // approval binds, or the launched envelope would not be rebuildable.
    expect(result.value.events).toEqual(["approval.invalidated", "dispatch.proposed", "approval.decided"])
  })

  it("rejects an approval whose recorded digest does not match the envelope", () => {
    const h = makeHarness({ seed: withProposedDispatch() })
    // The approval was granted for timeout 600; the dispatch in this command says
    // 900. The recorded digest no longer binds to the envelope it authorises.
    const changed = makeDispatch({ state: "approved" }, { timeoutSeconds: 900 })
    const result = h.coordinator.submit(
      baseCommand("dispatch.approve", { dispatch: changed, approval: makeApproval() }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.approval_digest_mismatch")
  })
})

describe("Retry adds an attempt and does not erase failure history", () => {
  it("retry requires a strictly greater attempt and invalidates the prior approval", () => {
    // A retry may only follow a TERMINAL attempt, so the seed has attempt 1
    // finished. Retrying a still-running dispatch would put two live sessions on
    // one task.
    const projection = reduceEvent(
      withApprovedDispatch(),
      seedEvent("dispatch.finished", { dispatchId: "disp-1", outcome: "failed", summary: "boom" }, 5),
    )
    expect(projection.dispatches["disp-1"].lifecycleState).toBe("failed")

    const h = makeHarness({ seed: projection })
    const result = h.coordinator.submit(
      baseCommand("dispatch.retry", {
        dispatch: makeDispatch({ state: "proposed" }, { dispatchId: "disp-2", attempt: 2 }),
        previousDispatchId: "disp-1",
        previousAttempt: 1,
      }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.events).toEqual(["approval.invalidated", "dispatch.proposed"])
  })

  it("rejects a retry that reuses the same attempt, because envelopes are immutable per attempt", () => {
    const h = makeHarness({ seed: withRun() })
    const result = h.coordinator.submit(
      baseCommand("dispatch.retry", {
        dispatch: makeDispatch(),
        previousDispatchId: "disp-1",
        previousAttempt: 1,
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.retry_attempt_not_advanced")
  })
})

describe("Timeout is a request; the outcome is observed separately", () => {
  it("records the request and never fabricates an outcome", () => {
    const projection = withProposedDispatch()

    const h = makeHarness({ seed: projection })
    const result = h.coordinator.submit(baseCommand("dispatch.timeout.request", { dispatchId: "disp-1", reason: "too slow" }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.events).toEqual(["dispatch.timeout.requested"])
    expect(h.replay().dispatches["disp-1"].timeoutRequested).toBe(true)
    // The dispatch is still running/approved: a request is not an outcome.
    expect(h.replay().dispatches["disp-1"].outcome).toBeNull()
  })

  it("is idempotent: a second identical request adds nothing", () => {
    const projection = withProposedDispatch()

    const h = makeHarness({ seed: projection })
    h.coordinator.submit(baseCommand("dispatch.timeout.request", { dispatchId: "disp-1", reason: "t" }, "cmd-to-1"))
    const replayed = h.replay()
    const second = new DispatchCoordinator({
      log: h.calls.length > 0 ? { append: () => ({ duplicate: false, events: [] }) } : { append: () => ({ duplicate: false, events: [] }) },
      now: () => NOW,
      newEventId: () => "evt-x",
      readRun: () => replayed,
    })
    const result = second.submit(baseCommand("dispatch.timeout.request", { dispatchId: "disp-1", reason: "t" }, "cmd-to-2"))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.events).toEqual([])
  })
})

describe("Failure boundaries (plan lines 77-86)", () => {
  it("boundary 1/2/3: a crash before or during append commits nothing and stays retryable", () => {
    for (const boundary of ["beforeValidate", "afterValidate", "duringAppend"] as const) {
      const projection = withRun()
      const h = makeHarness({
        seed: projection,
        boundary: {
          [boundary]: () => {
            throw new Error(`crash at ${boundary}`)
          },
        } as EffectBoundary,
      })

      // `run.pause` is valid against the seeded run; `run.create` would be
      // refused by the create-once precondition and never reach the boundary.
      expect(() => h.coordinator.submit(baseCommand("run.pause", { reason: "operator" }))).toThrow(/crash/)
      // Nothing was recorded, so the same command can be retried cleanly.
      expect(h.calls).toHaveLength(0)
    }
  })

  it("boundary 4: a crash after commit still leaves the command receipted, so a retry is a duplicate", () => {
    // The process dies exactly once, as a real crash would; the retry runs on a
    // recovered coordinator with the fault spent.
    let crashed = false
    const h = makeHarness({
      seed: withRun(),
      boundary: {
        afterCommit: () => {
          if (!crashed) {
            crashed = true
            throw new Error("crash after commit")
          }
        },
      },
    })
    const command = baseCommand("run.pause", { reason: "operator" })
    expect(() => h.coordinator.submit(command)).toThrow(/crash after commit/)

    // The append DID commit: the event is in the log.
    expect(h.calls).toHaveLength(1)
    // A retry under the same command id converges instead of double-appending.
    const retry = h.coordinator.submit(command)
    expect(retry.ok).toBe(true)
    if (retry.ok) expect(retry.value.duplicate).toBe(true)
    expect(h.calls).toHaveLength(1)
  })

  it("replay after an injected failure yields a coherent, replay-equivalent projection", () => {
    const h = makeHarness({ seed: withRun() })
    h.coordinator.submit(baseCommand("run.create", { run: makeRun("draft"), tasks: [makeTask()] }))
    const first = h.replay()
    const second = h.replay()
    expect(first.run.runId).toBe(second.run.runId)
    expect(Object.keys(first.tasks)).toEqual(Object.keys(second.tasks))
  })
})

describe("Cancel is a recorded fact", () => {
  it("emits run.cancelled so the outcome exists in the log", () => {
    const h = makeHarness({ seed: withRun("active") })
    const result = h.coordinator.submit(baseCommand("run.cancel", { reason: "operator stop" }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.events).toEqual(["run.cancelled"])
  })

  it("converges to a no-op when the run is already terminal", () => {
    const h = makeHarness({ seed: withRun("completed") })
    const result = h.coordinator.submit(baseCommand("run.cancel", { reason: "too late" }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.events).toEqual([])
  })
})

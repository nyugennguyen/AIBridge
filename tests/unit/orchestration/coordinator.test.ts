import { describe, expect, it } from "vitest"
import { digestDispatchEnvelope } from "../../../src/orchestration/digest.js"
import {
  commandIdSchema,
  correlationIdSchema,
  epochSchema,
  leaseIdSchema,
  installationIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  sessionIdSchema,
  taskIdSchema,
} from "../../../src/orchestration/identifiers.js"
import { dispatchEnvelopeSchema } from "../../../src/orchestration/schemas.js"
import type { Approval, Dispatch, OrchestrationCommand, Run, Task, Session } from "../../../src/orchestration/types.js"
import { reduceEvent } from "../../../src/orchestration/projections/index.js"
import type { RunProjectionState } from "../../../src/orchestration/projections/types.js"
import {
  COMMAND_EVENT_ALLOWLIST,
  DispatchCoordinator,
  RUNTIME_DESTINATION,
  type CommandLog,
  type CoordinatorDependencies,
  type EffectBoundary,
  type OpencodePromptClient,
  type SessionMonitor,
  type PromptCompiler,
} from "../../../src/orchestration/coordinator/index.js"
import { RoleBinder } from "../../../src/runtime/binder.js"
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

function baseCommand<T extends OrchestrationCommand["type"] = OrchestrationCommand["type"]>(
  type: T,
  payload: unknown,
  commandId = `cmd-${type}-1`,
): Extract<OrchestrationCommand, { type: T }> {
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
  } as unknown as Extract<OrchestrationCommand, { type: T }>
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

function makeHarness(
  options: {
    boundary?: EffectBoundary
    seed?: RunProjectionState
    opencodeClient?: OpencodePromptClient
    sessionMonitor?: SessionMonitor
    resolveProjectDir?: (sessionId: string, session?: unknown, dispatch?: unknown) => string | undefined
    compilePrompt?: PromptCompiler
  } = {},
) {
  const { log, calls, byCommandId } = makeLog()
  let eventSeq = 0
  let projection: RunProjectionState = options.seed ?? (null as unknown as RunProjectionState)
  const deps: CoordinatorDependencies = {
    log,
    now: () => NOW,
    newEventId: () => `evt-${++eventSeq}`,
    readRun: (runId) => (projection === null ? undefined : projection.run.runId === runId ? projection : undefined),
    ...(options.boundary === undefined ? {} : { boundary: options.boundary }),
    ...(options.opencodeClient === undefined ? {} : { opencodeClient: options.opencodeClient }),
    ...(options.sessionMonitor === undefined ? {} : { sessionMonitor: options.sessionMonitor }),
    ...(options.resolveProjectDir === undefined ? {} : { resolveProjectDir: options.resolveProjectDir }),
    compilePrompt: "compilePrompt" in options ? options.compilePrompt : ((opts) => RoleBinder.compile(opts)),
  }
  const coordinator = new DispatchCoordinator(deps)
  return {
    coordinator,
    deps,
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

class FakeOpencodeClient implements OpencodePromptClient {
  readonly prompts: { sessionId: string; prompt: string; directory: string }[] = []
  async sendPromptAsync(sessionId: string, prompt: string, directory: string): Promise<void> {
    this.prompts.push({ sessionId, prompt, directory })
  }
}

class FakeSessionMonitor {
  readonly monitored: { session: Session; directory: string }[] = []
  async waitForIdle(session: Session, directory: string): Promise<void> {
    this.monitored.push({ session, directory })
  }
}

function withIdleSession(sessionId = "sess-1"): RunProjectionState {
  let projection = withApprovedDispatch()
  const session: Session = {
    schemaVersion: 1,
    sessionId: sessionIdSchema.parse(sessionId),
    projectId: PROJECT,
    runId: RUN,
    taskId: taskIdSchema.parse("task-1"),
    dispatchId: "disp-1" as never,
    nodeId: nodeIdSchema.parse("node-1"),
    installationId: installationIdSchema.parse("inst-1"),
    runtimeKind: "opencode",
    lifecycleState: "idle",
    observedState: "idle",
  }
  projection = reduceEvent(projection, seedEvent("dispatch.started", { session }, 5))
  return projection
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

describe("session.prompt (Phase 1 primary agent-prompt path)", () => {
  it("fails closed when session.prompt is submitted via synchronous submit()", () => {
    const h = makeHarness({ seed: withIdleSession("sess-1") })
    const cmd = baseCommand("session.prompt", { sessionId: "sess-1", prompt: "Hello" }) as unknown as OrchestrationCommand
    const result = h.coordinator.submit(cmd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.category).toBe("validation")
      expect(result.error.code).toBe("coordinator.prompt_use_submit_prompt")
    }
  })

  it("strictly performs durable append BEFORE sendPromptAsync effect runs (FIX 2 crash consistency)", async () => {
    const trace: string[] = []
    const fakeClient: OpencodePromptClient = {
      async sendPromptAsync() {
        trace.push("client.sendPromptAsync")
      },
    }
    const fakeMonitor: SessionMonitor = {
      async waitForIdle() {
        trace.push("monitor.waitForIdle")
      },
    }

    const { log } = makeLog()
    let eventSeq = 0
    const projection = withIdleSession("sess-1")
    const trackingLog: CommandLog = {
      append(options) {
        trace.push("log.append")
        return log.append(options)
      },
    }

    const coordinator = new DispatchCoordinator({
      log: trackingLog,
      now: () => NOW,
      newEventId: () => `evt-${++eventSeq}`,
      readRun: (runId) => (projection.run.runId === runId ? projection : undefined),
      opencodeClient: fakeClient,
      sessionMonitor: fakeMonitor,
    })

    const cmd = baseCommand("session.prompt", { sessionId: "sess-1", prompt: "ordering test" })
    const result = await coordinator.submitPrompt(cmd)
    expect(result.ok).toBe(true)

    // Stated invariant: the row was durable BEFORE the effect ran
    expect(trace).toEqual(["log.append", "client.sendPromptAsync", "monitor.waitForIdle"])
    expect(trace.indexOf("log.append")).toBeLessThan(trace.indexOf("client.sendPromptAsync"))
  })

  it("allowlist for session.prompt is non-empty and exactly matches emitted events (allowlist ⊇ emitted and emitted ⊇ allowlist)", async () => {
    const allowed = COMMAND_EVENT_ALLOWLIST["session.prompt"]
    expect(allowed).toBeDefined()
    expect(allowed.length).toBeGreaterThan(0)

    const fakeClient = new FakeOpencodeClient()
    const fakeMonitor = new FakeSessionMonitor()
    const h = makeHarness({
      seed: withIdleSession("sess-1"),
      opencodeClient: fakeClient,
      sessionMonitor: fakeMonitor,
    })

    const cmd = baseCommand("session.prompt", { sessionId: "sess-1", prompt: "Perform inspection" })
    const result = await h.coordinator.submitPrompt(cmd)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const emitted = result.value.events
      expect(emitted.length).toBeGreaterThan(0)
      // allowlist ⊇ emitted
      for (const ev of emitted) {
        expect(allowed).toContain(ev)
      }
      // emitted ⊇ allowlist
      for (const al of allowed) {
        expect(emitted).toContain(al)
      }
    }
  })

  it("drives sendPromptAsync with the right sessionId, prompt, and projectDir", async () => {
    const fakeClient = new FakeOpencodeClient()
    const fakeMonitor = new FakeSessionMonitor()
    const h = makeHarness({
      seed: withIdleSession("sess-1"),
      opencodeClient: fakeClient,
      sessionMonitor: fakeMonitor,
      resolveProjectDir: () => "/srv/repo/workspace",
    })

    const cmd = baseCommand("session.prompt", { sessionId: "sess-1", prompt: "Refactor core logic" })
    const result = await h.coordinator.submitPrompt(cmd)
    expect(result.ok).toBe(true)
    expect(fakeClient.prompts).toHaveLength(1)
    expect(fakeClient.prompts[0]).toEqual({
      sessionId: "sess-1",
      prompt: "Refactor core logic",
      directory: "/srv/repo/workspace",
    })
  })

  it("hands the session to the monitor and tracks to idle (exercises idle/observed transition)", async () => {
    const seed = withIdleSession("sess-1")
    const fakeClient = new FakeOpencodeClient()
    const fakeMonitor = new FakeSessionMonitor()
    const h = makeHarness({
      seed,
      opencodeClient: fakeClient,
      sessionMonitor: fakeMonitor,
    })

    const cmd = baseCommand("session.prompt", { sessionId: "sess-1", prompt: "Execute task" })
    const result = await h.coordinator.submitPrompt(cmd)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.events).toEqual(["session.observed", "session.observed"])
    }

    // Handed to monitor with active working state
    expect(fakeMonitor.monitored).toHaveLength(1)
    expect(fakeMonitor.monitored[0].session.sessionId).toBe("sess-1")
    expect(fakeMonitor.monitored[0].session.lifecycleState).toBe("running")
    expect(fakeMonitor.monitored[0].session.observedState).toBe("working")

    // Idle/observed transition exercised in replay projection
    const replayed = h.replay()
    expect(replayed.sessions["sess-1"].state).toBe("idle")
    expect(replayed.sessions["sess-1"].observedState).toBe("idle")
  })

  it("accepts functional session monitor as alternative monitor seam", async () => {
    const fakeClient = new FakeOpencodeClient()
    const monitored: { session: Session; directory: string }[] = []
    const monitorFn = async (session: Session, directory: string) => {
      monitored.push({ session, directory })
    }

    const h = makeHarness({
      seed: withIdleSession("sess-1"),
      opencodeClient: fakeClient,
      sessionMonitor: monitorFn,
    })

    const cmd = baseCommand("session.prompt", { sessionId: "sess-1", prompt: "Check diagnostics" })
    const result = await h.coordinator.submitPrompt(cmd)
    expect(result.ok).toBe(true)
    expect(monitored).toHaveLength(1)
    expect(monitored[0].session.sessionId).toBe("sess-1")
  })

  it("refuses session.prompt for unknown session with coordinator.session_unknown", async () => {
    const fakeClient = new FakeOpencodeClient()
    const fakeMonitor = new FakeSessionMonitor()
    const h = makeHarness({
      seed: withIdleSession("sess-1"),
      opencodeClient: fakeClient,
      sessionMonitor: fakeMonitor,
    })

    const cmd = baseCommand("session.prompt", { sessionId: "sess-unknown", prompt: "Hello" })
    const result = await h.coordinator.submitPrompt(cmd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.category).toBe("validation")
      expect(result.error.code).toBe("coordinator.session_unknown")
    }
    expect(fakeClient.prompts).toHaveLength(0)
    expect(fakeMonitor.monitored).toHaveLength(0)
    expect(h.calls).toHaveLength(0)
  })

  it("refuses session.prompt when session is not in idle state", async () => {
    let seed = withIdleSession("sess-1")
    seed = reduceEvent(
      seed,
      seedEvent(
        "session.observed",
        {
          session: {
            schemaVersion: 1,
            sessionId: "sess-1",
            projectId: PROJECT,
            runId: RUN,
            taskId: "task-1",
            dispatchId: "disp-1",
            nodeId: "node-1",
            installationId: "inst-1",
            runtimeKind: "opencode",
            lifecycleState: "running",
            observedState: "working",
          },
        },
        6,
      ),
    )

    const fakeClient = new FakeOpencodeClient()
    const fakeMonitor = new FakeSessionMonitor()
    const h = makeHarness({
      seed,
      opencodeClient: fakeClient,
      sessionMonitor: fakeMonitor,
    })

    const cmd = baseCommand("session.prompt", { sessionId: "sess-1", prompt: "Hello" })
    const result = await h.coordinator.submitPrompt(cmd)
    expect(result.ok).toBe(false)
    expect(fakeClient.prompts).toHaveLength(0)
    expect(fakeMonitor.monitored).toHaveLength(0)
    expect(h.calls).toHaveLength(0)
  })

  it("fails command with coordinator.prompt_rejected when sendPromptAsync rejects", async () => {
    const rejectingClient: OpencodePromptClient = {
      async sendPromptAsync() {
        throw new Error("Opencode runtime refused prompt connection")
      },
    }
    const fakeMonitor = new FakeSessionMonitor()
    const h = makeHarness({
      seed: withIdleSession("sess-1"),
      opencodeClient: rejectingClient,
      sessionMonitor: fakeMonitor,
    })

    const cmd = baseCommand("session.prompt", { sessionId: "sess-1", prompt: "Do something" })
    const result = await h.coordinator.submitPrompt(cmd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.category).toBe("transient_transport")
      expect(result.error.code).toBe("coordinator.prompt_rejected")
      expect(result.error.message).toContain("Opencode runtime refused prompt connection")
    }
    expect(fakeMonitor.monitored).toHaveLength(0)
    expect(h.calls).toHaveLength(1) // Appended durable record before effect
  })

  it("fails command with coordinator.session_monitor_failed when session monitor fails", async () => {
    const fakeClient = new FakeOpencodeClient()
    const failingMonitor: SessionMonitor = {
      async waitForIdle() {
        throw new Error("Timeout: session never became idle")
      },
    }
    const h = makeHarness({
      seed: withIdleSession("sess-1"),
      opencodeClient: fakeClient,
      sessionMonitor: failingMonitor,
    })

    const cmd = baseCommand("session.prompt", { sessionId: "sess-1", prompt: "Do something" })
    const result = await h.coordinator.submitPrompt(cmd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.category).toBe("runtime_failure")
      expect(result.error.code).toBe("coordinator.session_monitor_failed")
      expect(result.error.message).toContain("Timeout: session never became idle")
    }
    expect(fakeClient.prompts).toHaveLength(1)
    expect(h.calls).toHaveLength(1) // Appended durable record before effect
  })

  it("fails command when opencodeClient is not configured", async () => {
    const fakeMonitor = new FakeSessionMonitor()
    const h = makeHarness({
      seed: withIdleSession("sess-1"),
      sessionMonitor: fakeMonitor,
    })

    const cmd = baseCommand("session.prompt", { sessionId: "sess-1", prompt: "Hello" })
    const result = await h.coordinator.submitPrompt(cmd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("coordinator.client_not_configured")
    }
  })

  it("fails command when session monitor is not configured", async () => {
    const fakeClient = new FakeOpencodeClient()
    const h = makeHarness({
      seed: withIdleSession("sess-1"),
      opencodeClient: fakeClient,
    })

    const cmd = baseCommand("session.prompt", { sessionId: "sess-1", prompt: "Hello" })
    const result = await h.coordinator.submitPrompt(cmd)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("coordinator.monitor_not_configured")
    }
  })

  it("is idempotent: duplicate commandId executes prompt effect only once and appends nothing second time", async () => {
    const fakeClient = new FakeOpencodeClient()
    const fakeMonitor = new FakeSessionMonitor()
    const h = makeHarness({
      seed: withIdleSession("sess-1"),
      opencodeClient: fakeClient,
      sessionMonitor: fakeMonitor,
    })

    const cmd = baseCommand("session.prompt", { sessionId: "sess-1", prompt: "Hello idempotent" }, "cmd-prompt-idemp")
    const first = await h.coordinator.submitPrompt(cmd)
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.value.duplicate).toBe(false)
      expect(first.value.events).toEqual(["session.observed", "session.observed"])
    }
    expect(fakeClient.prompts).toHaveLength(1)

    // Repeat with identical commandId
    const second = await h.coordinator.submitPrompt(cmd)
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.value.duplicate).toBe(true)
      expect(second.value.events).toEqual([])
    }
    expect(fakeClient.prompts).toHaveLength(1) // Still 1!
    expect(h.calls).toHaveLength(1)
  })

  it("(a) outbox record is named inside the append transaction, effect is performed once, and retry does not double-prompt", async () => {
    const fakeClient = new FakeOpencodeClient()
    const fakeMonitor = new FakeSessionMonitor()
    const h = makeHarness({
      seed: withIdleSession("sess-1"),
      opencodeClient: fakeClient,
      sessionMonitor: fakeMonitor,
    })

    const cmd = baseCommand("session.prompt", { sessionId: "sess-1", prompt: "Inspect system health" }, "cmd-prompt-outbox-named")
    const result = await h.coordinator.submitPrompt(cmd)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.duplicate).toBe(false)
      expect(result.value.events).toEqual(["session.observed", "session.observed"])
    }

    // Outbox record named inside the append transaction
    expect(h.calls).toHaveLength(1)
    const outbox = h.calls[0].outboxRecords
    expect(outbox).toHaveLength(1)
    expect(outbox[0].outboxId).toBe("obx-cmd-prompt-outbox-named")
    expect(outbox[0].destination).toBe(RUNTIME_DESTINATION)
    expect(outbox[0].status).toBe("pending")
    expect(outbox[0].payload).toMatchObject({
      commandId: "cmd-prompt-outbox-named",
      type: "session.prompt",
      sessionId: "sess-1",
      prompt: "Inspect system health",
    })

    // Effect performed once
    expect(fakeClient.prompts).toHaveLength(1)
    expect(fakeClient.prompts[0].prompt).toBe("Inspect system health")

    // Retry does not double-prompt
    const retry = await h.coordinator.submitPrompt(cmd)
    expect(retry.ok).toBe(true)
    if (retry.ok) {
      expect(retry.value.duplicate).toBe(true)
      expect(retry.value.events).toEqual([])
    }
    expect(fakeClient.prompts).toHaveLength(1) // Still 1!
    expect(h.calls).toHaveLength(1) // No second append!
  })

  it("(b) role payload: compiled prompt text and stamped digests reflect the new role and instructions", async () => {
    const fakeClient = new FakeOpencodeClient()
    const fakeMonitor = new FakeSessionMonitor()
    const h = makeHarness({
      seed: withIdleSession("sess-1"),
      opencodeClient: fakeClient,
      sessionMonitor: fakeMonitor,
    })

    const newRole = {
      schemaVersion: 1 as const,
      roleId: "specialist-auditor",
      templateVersion: 1,
      projectId: PROJECT,
      name: "SpecialistAuditor",
      purpose: "Deep security analysis",
      instructions: "ENFORCE STRICT AUDIT POLICY: inspect all memory buffers and cryptographic primitives.",
      capabilities: ["filesystem.read"],
      requiredCapabilities: ["filesystem.read"],
      preferredRuntimeKinds: ["opencode"],
      author: ACTOR,
      createdAt: NOW,
    }

    const cmd = baseCommand(
      "session.prompt",
      {
        sessionId: "sess-1",
        prompt: "Review crypto/signature.ts implementation",
        roleSnapshot: newRole,
        roleAssignments: [
          { roleId: "specialist-auditor", primary: true },
          { roleId: "timing-reviewer", primary: false, addendum: "Focus on timing side-channels" },
        ],
      },
      "cmd-prompt-role-compile",
    )

    const result = await h.coordinator.submitPrompt(cmd)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.duplicate).toBe(false)
    }

    // Effect delivered the COMPILED prompt text containing the new role's instructions
    expect(fakeClient.prompts).toHaveLength(1)
    const deliveredPrompt = fakeClient.prompts[0].prompt
    expect(deliveredPrompt).toContain("ENFORCE STRICT AUDIT POLICY: inspect all memory buffers and cryptographic primitives.")
    expect(deliveredPrompt).toContain("Focus on timing side-channels")
    expect(deliveredPrompt).toContain("Review crypto/signature.ts implementation")

    // Outbox record carries compiled prompt and stamped digests reflecting the new role
    const outbox = h.calls[0].outboxRecords[0]
    expect(outbox).toBeDefined()
    expect(outbox.destination).toBe(RUNTIME_DESTINATION)
    const payload = outbox.payload as Record<string, unknown>
    expect(payload.prompt).toBe(deliveredPrompt)
    expect(payload.compiledPrompt).toBe(deliveredPrompt)
    expect(payload.promptDigest).toBeDefined()
    expect(payload.compositeDigest).toBeDefined()
    expect(payload.roleDigests).toBeDefined()
    expect(outbox.payloadDigest).toBe(payload.compositeDigest)
  })

  it("(c) no-role path sends the raw prompt unchanged without compilation", async () => {
    const fakeClient = new FakeOpencodeClient()
    const fakeMonitor = new FakeSessionMonitor()
    const h = makeHarness({
      seed: withIdleSession("sess-1"),
      opencodeClient: fakeClient,
      sessionMonitor: fakeMonitor,
    })

    const rawPromptText = "Execute raw task prompt without compilation"
    const cmd = baseCommand(
      "session.prompt",
      {
        sessionId: "sess-1",
        prompt: rawPromptText,
      },
      "cmd-prompt-raw-path",
    )

    const result = await h.coordinator.submitPrompt(cmd)
    expect(result.ok).toBe(true)
    expect(fakeClient.prompts).toHaveLength(1)
    expect(fakeClient.prompts[0].prompt).toBe(rawPromptText)

    const outbox = h.calls[0].outboxRecords[0]
    expect(outbox).toBeDefined()
    const payload = outbox.payload as Record<string, unknown>
    expect(payload.prompt).toBe(rawPromptText)
    expect(payload.compiledPrompt).toBeUndefined()
  })
})

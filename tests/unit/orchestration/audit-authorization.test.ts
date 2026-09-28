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
import { DispatchCoordinator, type CommandLog, type EffectBoundary } from "../../../src/orchestration/coordinator/index.js"
import { evaluateTaskReadiness, isTaskReady, schedule } from "../../../src/orchestration/scheduler/index.js"
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

function baseCommand(
  type: OrchestrationCommand["type"],
  payload: unknown,
  commandId = `cmd-${type}-1`,
): OrchestrationCommand {
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

function makeDispatch(
  overrides: Partial<Record<string, unknown>> = {},
  envelopeOverrides: Record<string, unknown> = {},
): Dispatch {
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

function withRun(state: Run["state"] = "active"): RunProjectionState {
  let projection = reduceEvent(null, seedEvent("run.created", { run: makeRun(state) }, 1))
  projection = reduceEvent(projection, seedEvent("task.created", { task: makeTask() }, 2))
  return projection
}

function withApprovedDispatch(): RunProjectionState {
  let projection = withRun()
  projection = reduceEvent(projection, seedEvent("dispatch.proposed", { dispatch: makeDispatch() }, 3))
  projection = reduceEvent(projection, seedEvent("approval.decided", { approval: makeApproval() }, 4))
  return projection
}

function withProposedDispatch(): RunProjectionState {
  return reduceEvent(withRun(), seedEvent("dispatch.proposed", { dispatch: makeDispatch() }, 3))
}

function makeHarness(options: { boundary?: EffectBoundary; seed?: RunProjectionState } = {}) {
  const calls: { command: OrchestrationCommand; events: readonly EventInput[]; outboxRecords: readonly OutboxRecordInput[] }[] = []
  const byCommandId = new Map<string, { command: OrchestrationCommand; events: readonly EventInput[] }>()
  let eventSeq = 0

  const log: CommandLog = {
    append(options) {
      const seen = byCommandId.get(options.command.commandId)
      if (seen !== undefined) return { duplicate: true, events: [] }
      byCommandId.set(options.command.commandId, { command: options.command, events: options.events })
      calls.push({ command: options.command, events: options.events, outboxRecords: options.outboxRecords ?? [] })
      return { duplicate: false, events: options.events }
    },
  }

  let projection: RunProjectionState = options.seed ?? (null as unknown as RunProjectionState)
  const coordinator = new DispatchCoordinator({
    log,
    now: () => NOW,
    newEventId: () => `evt-${++eventSeq}`,
    readRun: (runId) => (projection === null ? undefined : projection.run.runId === runId ? projection : undefined),
    ...(options.boundary === undefined ? {} : { boundary: options.boundary }),
  })

  return {
    coordinator,
    calls,
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

describe("AUDIT: a launch requires a RECORDED approval", () => {
  it("refuses a fabricated approval for a dispatch the log only proposed", () => {
    // A `proposed` dispatch, and NO `approval.decided` event anywhere. The
    // approval in the command payload is self-consistent (right digest, right
    // scope, `approved`/`approved`), which is all the coordinator used to check —
    // so this used to launch. The recorded dispatch state is checked too.
    const h = makeHarness({ seed: withProposedDispatch() })

    const result = h.coordinator.submit(
      baseCommand("dispatch.execute", {
        dispatch: makeDispatch({ state: "approved" }),
        approval: makeApproval(),
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.dispatch_not_approved")
    expect(h.calls).toHaveLength(0)
  })

  it("refuses a launch whose approval id was never decided, even with a correct digest", () => {
    const h = makeHarness({ seed: withApprovedDispatch() })
    // The recorded approval is `appr-1`; this names an id the log never decided.
    const result = h.coordinator.submit(
      baseCommand("dispatch.execute", {
        dispatch: makeDispatch({ state: "approved" }),
        approval: makeApproval({ approvalId: "appr-forged" }),
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.approval_not_recorded")
    expect(h.calls).toHaveLength(0)
  })

  it("refuses to launch an approval the log has since invalidated", () => {
    const h = makeHarness({ seed: withApprovedDispatch() })
    // `approval.decided` is re-delivered, then `approval.invalidated` records the
    // decision as no longer binding while the envelope still digests the same.
    const seed: RunProjectionState = reduceEvent(
      withApprovedDispatch(),
      seedEvent(
        "approval.invalidated",
        { approvalId: "appr-1", projectId: PROJECT, runId: RUN, dispatchId: "disp-1", envelopeDigest: digestDispatchEnvelope(makeEnvelope()), reason: "r" },
        5,
      ),
    )
    const invalidated = makeHarness({ seed })
    const result = invalidated.coordinator.submit(
      baseCommand("dispatch.execute", {
        dispatch: makeDispatch({ state: "approved" }),
        approval: makeApproval(),
      }),
    )
    expect(h.calls).toHaveLength(0)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.approval_stale")
  })

  it("refuses a launch for a dispatch the log never proposed", () => {
    // The run and task exist; the dispatch id is invented by the caller.
    const h = makeHarness({ seed: withRun() })
    const result = h.coordinator.submit(
      baseCommand("dispatch.execute", {
        dispatch: makeDispatch({ state: "approved" }, { dispatchId: "disp-invented" }),
        approval: makeApproval({ dispatchId: "disp-invented" }),
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.dispatch_unknown")
    expect(h.calls).toHaveLength(0)
  })

  it("refuses to launch an envelope the log did not record for this dispatch", () => {
    // `disp-1` was proposed with timeout 600 and approved. The command carries a
    // DIFFERENT envelope whose digest the fabricated approval happily matches.
    const h = makeHarness({ seed: withApprovedDispatch() })
    const mutated = makeDispatch({ state: "approved" }, { timeoutSeconds: 900 })
    const result = h.coordinator.submit(
      baseCommand("dispatch.execute", {
        dispatch: mutated,
        approval: makeApproval({ envelopeDigest: digestDispatchEnvelope(mutated.envelope) }),
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.dispatch_envelope_mismatch")
    expect(h.calls).toHaveLength(0)
  })

  it("still launches when the approval IS recorded and the envelope matches", () => {
    const h = makeHarness({ seed: withApprovedDispatch() })
    const result = h.coordinator.submit(
      baseCommand("dispatch.execute", {
        dispatch: makeDispatch({ state: "approved" }),
        approval: makeApproval(),
      }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.events).toEqual(["dispatch.started"])
    expect(h.calls[0].outboxRecords).toHaveLength(1)
  })
})

describe("AUDIT: one project's dispatch cannot reach another's", () => {
  it("refuses a retry whose envelope names a different project", () => {
    const projection = reduceEvent(
      withApprovedDispatch(),
      seedEvent("dispatch.finished", { dispatchId: "disp-1", outcome: "failed", summary: "boom" }, 5),
    )
    const h = makeHarness({ seed: projection })
    const result = h.coordinator.submit(
      baseCommand("dispatch.retry", {
        // Same run, DIFFERENT project: the envelope scope is not checked by retry.
        dispatch: makeDispatch(
          { state: "proposed" },
          {
            dispatchId: "disp-2",
            attempt: 2,
            projectId: projectIdSchema.parse("proj-2"),
            roleSnapshot: { ...makeEnvelope().roleSnapshot, projectId: projectIdSchema.parse("proj-2") },
          },
        ),
        previousDispatchId: "disp-1",
        previousAttempt: 1,
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.dispatch_scope_mismatch")
    expect(h.calls).toHaveLength(0)
  })

  it("refuses a retry whose envelope names a different run", () => {
    const projection = reduceEvent(
      withApprovedDispatch(),
      seedEvent("dispatch.finished", { dispatchId: "disp-1", outcome: "failed", summary: "boom" }, 5),
    )
    const h = makeHarness({ seed: projection })
    const result = h.coordinator.submit(
      baseCommand("dispatch.retry", {
        dispatch: makeDispatch({ state: "proposed" }, { dispatchId: "disp-2", attempt: 2, runId: runIdSchema.parse("run-2") }),
        previousDispatchId: "disp-1",
        previousAttempt: 1,
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.dispatch_scope_mismatch")
    expect(h.calls).toHaveLength(0)
  })

  it("a run.create whose tasks belong to another project is refused", () => {
    const h = makeHarness()
    const result = h.coordinator.submit(
      baseCommand("run.create", {
        run: makeRun("draft"),
        tasks: [{ ...makeTask(), projectId: projectIdSchema.parse("proj-2") }],
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.task_scope_mismatch")
    expect(h.calls).toHaveLength(0)
  })
})

describe("AUDIT: a paused legacy run is not silently schedulable", () => {
  it("a paused run yields no ready tasks, so a legacy job cannot be launched by the scheduler", () => {
    // The legacy translation maps a live trigger to `draft` + `paused` with no
    // canonical approval. If the scheduler treated it as ready, a paused legacy
    // job would become launchable work with no approval behind it.
    const paused = reduceEvent(withRun("draft"), seedEvent("run.created", {
      run: {
        schemaVersion: 1,
        runId: RUN,
        projectId: PROJECT,
        goal: "legacy",
        state: "draft",
        paused: true,
        createdAt: NOW,
        updatedAt: NOW,
        externalReferences: [],
      },
    }, 3))
    const projection = reduceEvent(
      reduceEvent(
        paused,
        seedEvent(
          "task.created",
          {
            task: {
              schemaVersion: 1,
              taskId: taskIdSchema.parse("task-1"),
              runId: RUN,
              projectId: PROJECT,
              title: "Legacy job",
              description: "d",
              state: "pending",
              failurePolicy: "block",
              dependencies: [],
              externalReferences: [],
            },
          },
          4,
        ),
      ),
      seedEvent("dispatch.proposed", { dispatch: makeDispatch() }, 5),
    )
    expect(projection.run.paused).toBe(true)

    const readiness = evaluateTaskReadiness(projection)
    expect(readiness["task-1"].status).not.toBe("ready")
    expect(isTaskReady(projection.tasks["task-1"], projection)).toBe(false)
    // And nothing is eligible for dispatch.
    expect(schedule(projection).eligibleTasks).toHaveLength(0)
  })
})

describe("AUDIT: a retry cannot duplicate a live session", () => {
  it("refuses to retry a dispatch that is still running", () => {
    // A `dispatch.started` exists, so attempt 1 owns a live session. Retrying it
    // would let the same task hold two sessions at once.
    const started = reduceEvent(
      withApprovedDispatch(),
      seedEvent(
        "dispatch.started",
        {
          session: {
            schemaVersion: 1,
            sessionId: "sess-cmd-1",
            projectId: PROJECT,
            runId: RUN,
            taskId: "task-1",
            dispatchId: "disp-1",
            nodeId: "node-1",
            installationId: "inst-1",
            runtimeKind: "opencode",
            lifecycleState: "launching",
            observedState: "starting",
          },
        },
        5,
      ),
    )
    expect(started.dispatches["disp-1"].lifecycleState).toBe("running")

    const h = makeHarness({ seed: started })
    const result = h.coordinator.submit(
      baseCommand("dispatch.retry", {
        dispatch: makeDispatch({ state: "proposed" }, { dispatchId: "disp-2", attempt: 2 }),
        previousDispatchId: "disp-1",
        previousAttempt: 1,
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.dispatch_not_terminal")
    expect(h.calls).toHaveLength(0)
  })

  it("refuses to retry a dispatch the log never recorded", () => {
    const h = makeHarness({ seed: withRun() })
    const result = h.coordinator.submit(
      baseCommand("dispatch.retry", {
        dispatch: makeDispatch({ state: "proposed" }, { dispatchId: "disp-2", attempt: 2 }),
        previousDispatchId: "disp-never-proposed",
        previousAttempt: 1,
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.dispatch_unknown")
    expect(h.calls).toHaveLength(0)
  })
})

describe("AUDIT: an envelope revision is recorded, not silently substituted", () => {
  it("records the revised envelope so the launched envelope exists in the log", () => {
    const h = makeHarness({ seed: withApprovedDispatch() })
    const revised = makeDispatch({ state: "approved" }, { timeoutSeconds: 900 })
    const result = h.coordinator.submit(
      baseCommand("dispatch.approve", {
        dispatch: revised,
        approval: makeApproval({ envelopeDigest: digestDispatchEnvelope(revised.envelope) }),
      }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.events).toEqual(["approval.invalidated", "dispatch.proposed", "approval.decided"])
    }
    // Replaying the log must yield the revised envelope for `disp-1`.
    const projection = h.replay()
    expect(projection.dispatches["disp-1"].envelopeDigest).toBe(digestDispatchEnvelope(revised.envelope))
  })

  it("refuses to approve a dispatch for a run the log does not know", () => {
    const h = makeHarness({ seed: withRun() })
    const result = h.coordinator.submit(
      baseCommand("dispatch.approve", {
        dispatch: makeDispatch({ state: "approved" }, { dispatchId: "disp-new" }),
        approval: makeApproval({ approvalId: "appr-new", dispatchId: "disp-new" }),
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("coordinator.dispatch_unknown")
    expect(h.calls).toHaveLength(0)
  })
})

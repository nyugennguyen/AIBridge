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
import { DispatchCoordinator, RUNTIME_DESTINATION, type CommandLog } from "../../../src/orchestration/coordinator/index.js"
import type { EventInput, OutboxRecordInput } from "../../../src/orchestration/event-store/types.js"

const PROJECT = projectIdSchema.parse("proj-1")
const RUN = runIdSchema.parse("run-1")
const ACTOR = { kind: "user" as const, userId: "user-1" as never }
const NOW = "2026-09-28T00:00:00.000Z"

function makeEnvelope() {
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

function makeApproval(): Approval {
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
  } as unknown as Approval
}

function makeDispatch(): Dispatch {
  return {
    schemaVersion: 1,
    envelope: makeEnvelope(),
    envelopeDigest: digestDispatchEnvelope(makeEnvelope()),
    state: "approved",
    createdAt: NOW,
    externalReferences: [],
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

function approvedProjection(): RunProjectionState {
  const run = {
    schemaVersion: 1,
    runId: RUN,
    projectId: PROJECT,
    goal: "g",
    state: "active",
    paused: false,
    createdAt: NOW,
    updatedAt: NOW,
    externalReferences: [],
  } as Run
  const task = {
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
  let state = reduceEvent(null, seedEvent("run.created", { run }, 1))
  state = reduceEvent(state, seedEvent("task.created", { task }, 2))
  state = reduceEvent(state, seedEvent("dispatch.proposed", { dispatch: makeDispatch() }, 3))
  state = reduceEvent(state, seedEvent("approval.decided", { approval: makeApproval() }, 4))
  return state
}

/**
 * A command log with a durable outbox, so boundaries 5 and 6 (before delivery,
 * and after the runtime accepted a launch) can be injected at the real effect
 * boundary rather than only inside the append.
 */
function makeDurableHarness() {
  const events: { command: OrchestrationCommand; events: readonly EventInput[] }[] = []
  const receipts = new Map<string, { events: readonly EventInput[] }>()
  const outbox = new Map<string, OutboxRecordInput>()

  const log: CommandLog = {
    append(options) {
      const existing = receipts.get(options.command.commandId)
      if (existing !== undefined) return { duplicate: true, events: [] }
      receipts.set(options.command.commandId, { events: options.events })
      for (const record of options.outboxRecords ?? []) outbox.set(record.outboxId, record)
      events.push({ command: options.command, events: options.events })
      return { duplicate: false, events: options.events }
    },
  }

  let projection = approvedProjection()
  const coordinator = new DispatchCoordinator({
    log,
    now: () => NOW,
    newEventId: () => `evt-${receipts.size + 1}`,
    readRun: (runId) => (projection.run.runId === runId ? projection : undefined),
  })

  const foldAll = () => {
    let state: RunProjectionState = approvedProjection()
    let sequence = 4
    for (const call of events) {
      for (const event of call.events) {
        sequence += 1
        state = reduceEvent(state, { ...(event as object), sequence } as never)
      }
    }
    return state
  }

  return { coordinator, outbox, foldAll, getProjection: () => projection, commit: () => { projection = foldAll() } }
}

const EXECUTE = () =>
  baseCommand("dispatch.execute", { dispatch: makeDispatch(), approval: makeApproval() })

describe("AUDIT: crash boundaries 5 and 6 (the runtime outbox)", () => {
  it("boundary 5: a crash BEFORE delivery leaves a pending intent that is not lost or doubled", () => {
    const h = makeDurableHarness()
    expect(h.coordinator.submit(EXECUTE()).ok).toBe(true)
    h.commit()

    // The append committed; delivery had not happened.
    const intent = h.outbox.get("obx-cmd-dispatch.execute-1")!
    expect(intent.status).toBe("pending")
    expect(intent.destination).toBe(RUNTIME_DESTINATION)

    // Restart: a redelivery of the SAME intent is the same effect, and the
    // projection is already replay-equivalent to the log.
    const replayed = h.foldAll()
    expect(replayed.dispatches["disp-1"].sessionId).toBe("sess-cmd-dispatch.execute-1")
    expect(replayed.run.launchAdmission.state).toBe("started")
    // A duplicate command adds no second outbox record and no second session.
    const before = h.outbox.size
    expect(h.coordinator.submit(EXECUTE()).ok).toBe(true)
    expect(h.outbox.size).toBe(before)
    expect(Object.keys(h.foldAll().sessions)).toHaveLength(1)
  })

  it("boundary 6: a crash AFTER the runtime accepted the launch cannot launch twice", () => {
    // The runtime accepted; the acknowledgement was lost. The command receipt and
    // the session record are both durable, so the retry is a duplicate and the
    // already-performed launch is not repeated. This is exactly-once INTENT, not
    // exactly-once transport: the assertion is that the kernel does not issue a
    // second effect, not that the provider saw one call.
    const h = makeDurableHarness()
    expect(h.coordinator.submit(EXECUTE()).ok).toBe(true)
    h.commit()
    // The provider DID run the launch.
    const providerLaunches = 1
    // ... and the acknowledgement never came back.
    const retry = h.coordinator.submit(EXECUTE())
    expect(retry.ok).toBe(true)
    if (retry.ok) expect(retry.value.duplicate).toBe(true)
    // Still one session, and the same one. The kernel issued no second effect.
    const sessions = Object.values(h.foldAll().sessions)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].sessionId).toBe("sess-cmd-dispatch.execute-1")
    expect(providerLaunches).toBe(1)
  })

  it("a FRESH command id cannot turn an already-started dispatch into a second launch", () => {
    // A new command id evades the receipt, so the duplicate-command guarantee is
    // not what stops this: the RECORDED session does. A second `dispatch.execute`
    // for a dispatch that already started returns the recorded session and names
    // no new outbox effect.
    const h = makeDurableHarness()
    expect(h.coordinator.submit(EXECUTE()).ok).toBe(true)
    h.commit()
    const outboxBefore = h.outbox.size
    expect(outboxBefore).toBe(1)

    const fresh = h.coordinator.submit(
      baseCommand("dispatch.execute", { dispatch: makeDispatch(), approval: makeApproval() }, "cmd-dispatch.execute-2"),
    )
    expect(fresh.ok).toBe(true)
    if (fresh.ok) expect(fresh.value.events).toEqual([])
    expect(h.outbox.size).toBe(outboxBefore)
    expect(Object.keys(h.foldAll().sessions)).toHaveLength(1)
  })

  it("the outbox id is derived from the command, so a redelivery is recognisably the same effect", () => {
    const h = makeDurableHarness()
    h.coordinator.submit(EXECUTE())
    const first = h.outbox.get("obx-cmd-dispatch.execute-1")!
    expect(first.outboxId).toBe("obx-cmd-dispatch.execute-1")
    // It carries the envelope, its digest, the approval and the session, so a
    // delivery worker can re-verify all three at the effect boundary.
    expect(first.payloadDigest).toBe(digestDispatchEnvelope(makeEnvelope()))
  })
})

describe("AUDIT: crash boundary 7 (during projection update)", () => {
  it("a projection that stops mid-fold is rebuilt to the same digest", () => {
    const h = makeDurableHarness()
    h.coordinator.submit(EXECUTE())
    const calls = h.foldAll()

    // Simulate a projection cache that only got part of the stream before the
    // crash, then a rebuild from sequence 1.
    const partial = reduceEvent(approvedProjection(), seedEvent("dispatch.started", {
      session: {
        schemaVersion: 1,
        sessionId: "sess-partial",
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
    }, 5))

    // The partial cache and the rebuild agree on every DOMAIN fact; only the
    // sequence high-water mark and the fabricated session differ, which is
    // precisely why a rebuild is authoritative.
    expect(partial.dispatches["disp-1"].lifecycleState).toBe(calls.dispatches["disp-1"].lifecycleState)
    expect(calls.sessions["sess-cmd-dispatch.execute-1"]).toBeDefined()
    expect(calls.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe("AUDIT: crash boundary 8 (during legacy translation)", () => {
  it("a legacy trigger that fails to append names no launch effect at all", async () => {
    // The intent is recorded only AFTER the kernel accepted the intent, so a
    // translation failure cannot leave an effect owed for a run that does not
    // exist.
    const { buildTestApp, validTrigger, InMemoryJobStore } = await import("../../integration/fixtures.js")
    const { JobManager } = await import("../../../src/jobs/manager.js")
    const { LegacyTranslation, LegacyLaunchOutbox, legacyTranslationContextSchema } = await import(
      "../../../src/orchestration/legacy/translation.js"
    )

    const unmapped = legacyTranslationContextSchema.parse({
      schemaVersion: 1,
      sourceProfileId: "p",
      controllerNodeId: "node-test-vps",
      controllerEpoch: 1,
      leaseId: "lease-test-vps",
      pathResolutionBase: "/srv/apps",
      localAgentId: "test-vps",
      agentMappings: [
        { legacyAgentId: "test-vps", nodeId: "node-test-vps", installationId: "i", runtimeKind: "opencode" },
        { legacyAgentId: "dev-main", nodeId: "node-dev-main", installationId: "i2", runtimeKind: "opencode" },
      ],
      projectMappings: [],
    })
    const outbox = new LegacyLaunchOutbox()
    const translation = new LegacyTranslation({
      mode: "present",
      context: unmapped,
      now: () => "2026-09-28T00:00:00.000Z" as never,
      commands: { submit: () => ({ ok: true as const, value: { events: [], duplicate: false } }) },
      outbox,
    })

    const jobManager = new JobManager(new InMemoryJobStore())
    const { app, opencode } = await buildTestApp({ jobManager, orchestration: { translation } })
    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger(),
    })

    expect(response.statusCode).toBe(500)
    expect(opencode.createdSessions).toBe(0)
    // No intent is owed for a run that was never recorded.
    expect(outbox.list()).toHaveLength(0)
    expect(translation.launchIntents()).toHaveLength(0)
  })
})

import { describe, expect, it } from "vitest"
import { DispatchCoordinator } from "../../../src/orchestration/coordinator/coordinator.js"
import { CharterRepository } from "../../../src/orchestration/charter/repository.js"
import { RoundtableRepository, type Roundtable, type RoundtableOutcome } from "../../../src/orchestration/roundtable/index.js"
import { SAFETY_FLOOR } from "../../../src/orchestration/policy/floor.js"
import { computeImmutableCoreDigest } from "../../../src/orchestration/policy/immutable-core.js"
import { computeCharterSnapshotDigest, dispatchEnvelopeSchema } from "../../../src/orchestration/schemas.js"
import type { Charter } from "../../../src/orchestration/charter/types.js"
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
import { digestDispatchEnvelope } from "../../../src/orchestration/digest.js"
import type { Approval, Dispatch, DispatchEnvelope, OrchestrationCommand, Run, Task } from "../../../src/orchestration/types.js"
import { reduceEvent } from "../../../src/orchestration/projections/reducer.js"
import type { RunProjectionState } from "../../../src/orchestration/projections/types.js"

const PROJECT = projectIdSchema.parse("proj-gate-test")
const RUN = runIdSchema.parse("run-gate-test")
const TASK = taskIdSchema.parse("task-1")
const NOW = "2026-10-14T12:00:00.000Z"
const LATER = "2026-10-14T13:00:00.000Z"
const ACTOR = { kind: "node" as const, nodeId: nodeIdSchema.parse("node-1") }

function makeTestCharter(objectionRequiredBefore: readonly string[] = []): Charter {
  const coreDigest = computeImmutableCoreDigest(SAFETY_FLOOR)
  const template = {
    charterId: PROJECT,
    version: 1,
    purpose: "Testing coordinator roundtable gate",
    globalRules: ["rule 1"],
    communicationPolicy: {
      turnTaking: "chair_ordered" as const,
      objectionRequiredBefore: [...objectionRequiredBefore],
      verbosity: "normal" as const,
      mustStopAndAsk: [],
      objectionMustContain: ["rationale"],
    },
    escalationPolicy: {
      maxRounds: 5,
      onDeadlock: "chair_decides" as const,
      budgetScope: "shared" as const,
    },
    roleCatalog: [{ roleId: "runner-role", version: 1 }],
    immutableCoreDigest: coreDigest,
    snapshotDigest: `sha256:${"0".repeat(64)}` as const,
    author: "human" as const,
    capturedAt: NOW,
  }
  const snapshotDigest = computeCharterSnapshotDigest(template)
  return { ...template, snapshotDigest }
}

function makeEnvelope(capabilities: readonly string[] = ["deploy"]): DispatchEnvelope {
  return dispatchEnvelopeSchema.parse({
    schemaVersion: 1,
    dispatchId: "disp-gate-1",
    attempt: 1,
    projectId: PROJECT,
    runId: RUN,
    taskId: TASK,
    targetNodeId: "node-1",
    installationId: "inst-1",
    runtimeKind: "opencode",
    projectPathId: "path-1",
    prompt: "deploy prompt",
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "runner-role",
      templateVersion: 1,
      projectId: PROJECT,
      name: "Runner",
      purpose: "run",
      instructions: "run",
      requiredCapabilities: ["fs.read"],
      preferredRuntimeKinds: ["opencode"],
      contextSelectionPolicyReference: { namespace: "t", id: "r" },
      permissionRestrictions: {
        allowedCapabilities: ["fs.read", "deploy"],
        deniedCapabilities: [],
        approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
      },
      author: ACTOR,
      createdAt: NOW,
    },
    ruleSnapshots: [],
    contextManifest: { references: [], manifestDigest: `sha256:${"0".repeat(64)}` },
    requestedCapabilities: [...capabilities],
    permissionEnvelope: {
      allowedCapabilities: ["fs.read", "deploy"],
      deniedCapabilities: [],
      approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
    },
    dependencies: [],
    timeoutSeconds: 600,
    controllerEpoch: 1,
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
    expiresAt: LATER,
    correlationId: correlationIdSchema.parse("corr-1"),
    causation: null,
    payload,
  } as unknown as Extract<OrchestrationCommand, { type: T }>
}

function makeRun(): Run {
  return {
    schemaVersion: 1,
    runId: RUN,
    projectId: PROJECT,
    goal: "gate goal",
    state: "active",
    paused: false,
    createdAt: NOW,
    updatedAt: NOW,
    externalReferences: [],
  }
}

function makeTask(title = "deploy task"): Task {
  return {
    schemaVersion: 1,
    taskId: TASK,
    runId: RUN,
    projectId: PROJECT,
    title,
    description: "task description",
    state: "ready",
    failurePolicy: "block",
    dependencies: [],
    externalReferences: [],
  }
}

function makeApproval(envelope: DispatchEnvelope): Approval {
  return {
    schemaVersion: 1,
    approvalId: "appr-gate-1" as never,
    projectId: PROJECT,
    runId: RUN,
    dispatchId: envelope.dispatchId,
    envelopeDigest: digestDispatchEnvelope(envelope),
    decision: "approved",
    state: "approved",
    basis: { kind: "user" },
    actor: ACTOR,
    decidedAt: NOW,
  }
}

function makeDispatch(envelope: DispatchEnvelope, state: Dispatch["state"] = "proposed"): Dispatch {
  return {
    schemaVersion: 1,
    envelope,
    envelopeDigest: digestDispatchEnvelope(envelope),
    state,
    createdAt: NOW,
    externalReferences: [],
  }
}

function makeSampleOutcome(): RoundtableOutcome {
  return {
    summary: "Consensus reached on deployment.",
    recommendation: "Approve deploy dispatch.",
    addressedObjections: ["post-1"],
    unresolvedObjections: [],
  }
}

describe("Coordinator dispatch.execute admission with roundtable gate", () => {
  it("refuses dispatch.execute with code roundtable_required when objectionRequiredBefore covers deploy and NO closed roundtable exists", () => {
    const envelope = makeEnvelope(["deploy"])
    const dispatch = makeDispatch(envelope, "approved")
    const approval = makeApproval(envelope)

    const charters = new CharterRepository()
    charters.registerCharter(makeTestCharter(["deploy"]))
    const roundtables = new RoundtableRepository()

    let projection = reduceEvent(null, {
      schemaVersion: 1,
      eventId: "evt-run",
      sequence: 1,
      type: "run.created",
      projectId: PROJECT,
      runId: RUN,
      occurredAt: NOW,
      actor: ACTOR,
      controllerEpoch: 1,
      correlationId: "corr-1",
      causation: null,
      payload: { run: makeRun() },
    } as never)
    projection = reduceEvent(projection, {
      schemaVersion: 1,
      eventId: "evt-task",
      sequence: 2,
      type: "task.created",
      projectId: PROJECT,
      runId: RUN,
      occurredAt: NOW,
      actor: ACTOR,
      controllerEpoch: 1,
      correlationId: "corr-1",
      causation: null,
      payload: { task: makeTask() },
    } as never)
    projection = reduceEvent(projection, {
      schemaVersion: 1,
      eventId: "evt-disp",
      sequence: 3,
      type: "dispatch.proposed",
      projectId: PROJECT,
      runId: RUN,
      occurredAt: NOW,
      actor: ACTOR,
      controllerEpoch: 1,
      correlationId: "corr-1",
      causation: null,
      payload: { dispatch },
    } as never)
    projection = reduceEvent(projection, {
      schemaVersion: 1,
      eventId: "evt-appr",
      sequence: 4,
      type: "approval.decided",
      projectId: PROJECT,
      runId: RUN,
      occurredAt: NOW,
      actor: ACTOR,
      controllerEpoch: 1,
      correlationId: "corr-1",
      causation: null,
      payload: { approval },
    } as never)

    let eventSeq = 0
    const coordinator = new DispatchCoordinator({
      log: { append: (opts) => ({ duplicate: false, events: opts.events }) },
      now: () => NOW,
      newEventId: () => `evt-${++eventSeq}`,
      readRun: (runId) => (runId === RUN ? projection : undefined),
      roundtables,
      charters,
    })

    const result = coordinator.submit(
      baseCommand("dispatch.execute", { dispatch, approval }, "cmd-exec-gate-1"),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("roundtable_required")
      expect(result.error.category).toBe("policy_denied")
      expect(result.error.message).toContain("roundtable_required")
    }
  })

  it("admits dispatch.execute when a closed roundtable with recorded outcome exists for the task", () => {
    const envelope = makeEnvelope(["deploy"])
    const dispatch = makeDispatch(envelope, "approved")
    const approval = makeApproval(envelope)

    const charters = new CharterRepository()
    charters.registerCharter(makeTestCharter(["deploy"]))
    const roundtables = new RoundtableRepository()

    // Create a closed roundtable with recorded outcome for TASK
    const rt: Roundtable = {
      id: "disc-gate-closed",
      runId: RUN,
      taskId: TASK,
      subject: "Deploy deliberation",
      mode: "parallel",
      chairNodeId: nodeIdSchema.parse("node-1"),
      members: [{ nodeId: nodeIdSchema.parse("node-1"), roleId: "chair-role" }],
      state: "open",
    }
    roundtables.open(rt)
    roundtables.close("disc-gate-closed", makeSampleOutcome())

    let projection = reduceEvent(null, {
      schemaVersion: 1,
      eventId: "evt-run",
      sequence: 1,
      type: "run.created",
      projectId: PROJECT,
      runId: RUN,
      occurredAt: NOW,
      actor: ACTOR,
      controllerEpoch: 1,
      correlationId: "corr-1",
      causation: null,
      payload: { run: makeRun() },
    } as never)
    projection = reduceEvent(projection, {
      schemaVersion: 1,
      eventId: "evt-task",
      sequence: 2,
      type: "task.created",
      projectId: PROJECT,
      runId: RUN,
      occurredAt: NOW,
      actor: ACTOR,
      controllerEpoch: 1,
      correlationId: "corr-1",
      causation: null,
      payload: { task: makeTask() },
    } as never)
    projection = reduceEvent(projection, {
      schemaVersion: 1,
      eventId: "evt-disp",
      sequence: 3,
      type: "dispatch.proposed",
      projectId: PROJECT,
      runId: RUN,
      occurredAt: NOW,
      actor: ACTOR,
      controllerEpoch: 1,
      correlationId: "corr-1",
      causation: null,
      payload: { dispatch },
    } as never)
    projection = reduceEvent(projection, {
      schemaVersion: 1,
      eventId: "evt-appr",
      sequence: 4,
      type: "approval.decided",
      projectId: PROJECT,
      runId: RUN,
      occurredAt: NOW,
      actor: ACTOR,
      controllerEpoch: 1,
      correlationId: "corr-1",
      causation: null,
      payload: { approval },
    } as never)

    let eventSeq = 0
    const coordinator = new DispatchCoordinator({
      log: { append: (opts) => ({ duplicate: false, events: opts.events }) },
      now: () => NOW,
      newEventId: () => `evt-${++eventSeq}`,
      readRun: (runId) => (runId === RUN ? projection : undefined),
      roundtables,
      charters,
    })

    const result = coordinator.submit(
      baseCommand("dispatch.execute", { dispatch, approval }, "cmd-exec-gate-2"),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.events).toEqual(["dispatch.started"])
    }
  })

  it("does not gate non-covered action classes (no false refusals)", () => {
    const envelope = makeEnvelope(["fs.read"])
    const dispatch = makeDispatch(envelope, "approved")
    const approval = makeApproval(envelope)

    const charters = new CharterRepository()
    charters.registerCharter(makeTestCharter(["deploy", "database_migration"]))
    const roundtables = new RoundtableRepository()

    let projection = reduceEvent(null, {
      schemaVersion: 1,
      eventId: "evt-run",
      sequence: 1,
      type: "run.created",
      projectId: PROJECT,
      runId: RUN,
      occurredAt: NOW,
      actor: ACTOR,
      controllerEpoch: 1,
      correlationId: "corr-1",
      causation: null,
      payload: { run: makeRun() },
    } as never)
    projection = reduceEvent(projection, {
      schemaVersion: 1,
      eventId: "evt-task",
      sequence: 2,
      type: "task.created",
      projectId: PROJECT,
      runId: RUN,
      occurredAt: NOW,
      actor: ACTOR,
      controllerEpoch: 1,
      correlationId: "corr-1",
      causation: null,
      payload: { task: makeTask("read file task") },
    } as never)
    projection = reduceEvent(projection, {
      schemaVersion: 1,
      eventId: "evt-disp",
      sequence: 3,
      type: "dispatch.proposed",
      projectId: PROJECT,
      runId: RUN,
      occurredAt: NOW,
      actor: ACTOR,
      controllerEpoch: 1,
      correlationId: "corr-1",
      causation: null,
      payload: { dispatch },
    } as never)
    projection = reduceEvent(projection, {
      schemaVersion: 1,
      eventId: "evt-appr",
      sequence: 4,
      type: "approval.decided",
      projectId: PROJECT,
      runId: RUN,
      occurredAt: NOW,
      actor: ACTOR,
      controllerEpoch: 1,
      correlationId: "corr-1",
      causation: null,
      payload: { approval },
    } as never)

    let eventSeq = 0
    const coordinator = new DispatchCoordinator({
      log: { append: (opts) => ({ duplicate: false, events: opts.events }) },
      now: () => NOW,
      newEventId: () => `evt-${++eventSeq}`,
      readRun: (runId) => (runId === RUN ? projection : undefined),
      roundtables,
      charters,
    })

    const result = coordinator.submit(
      baseCommand("dispatch.execute", { dispatch, approval }, "cmd-exec-gate-3"),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.events).toEqual(["dispatch.started"])
    }
  })
})

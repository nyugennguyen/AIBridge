/**
 * M4.9 — the wire records the two fault-harness nodes exchange.
 *
 * Every record here is built RAW and left for the receiver's own
 * `safeParseMeshEnvelope`, for the reason every fixture in this repository is
 * built that way: a builder that parsed first would let a negative test pass for
 * the wrong reason, because the record would already be valid by the time the
 * seam under test refused it. One exception is `mesh.command`, which goes through
 * `mintMeshCommand` so its `payloadDigest` is real — a command with a hand-written
 * digest is refused at the integrity step, and a stale-epoch test that tripped
 * that first would be asserting the wrong guard.
 *
 * Nothing reads a clock. Every instant is a number a caller passes, so "ten
 * seconds after the lease was claimed" is arithmetic rather than a sleep.
 */
import {
  CURRENT_SCHEMA_VERSION,
  commandIdSchema,
  correlationIdSchema,
  epochSchema,
  leaseIdSchema,
  meshIdSchema,
  nodeIdSchema,
  projectIdSchema,
  projectPathIdSchema,
  runIdSchema,
  sessionIdSchema,
  taskIdSchema,
  type CommandId,
  type Epoch,
  type LeaseId,
  type MeshId,
  type NodeId,
  type ProjectId,
  type RunId,
  type TaskId,
} from "../../orchestration/identifiers.js"
import { digestDispatchEnvelope } from "../../orchestration/digest.js"
import {
  actorSchema,
  approvalSchema,
  dispatchEnvelopeSchema,
  dispatchSchema,
  orchestrationCommandSchema,
  sessionSchema,
} from "../../orchestration/schemas.js"
import type { Actor, Dispatch, OrchestrationCommand, Session } from "../../orchestration/types.js"
import { mintMeshCommand } from "../protocol/command.js"
import { mintMeshEvent, type MeshEvent } from "../protocol/event.js"
import { meshAckSchema, type MeshAck } from "../protocol/ack.js"
import type { MeshHeartbeat } from "../protocol/heartbeat.js"
import type { MeshLease } from "../protocol/lease.js"
import { orchestrationEventSchema } from "../../orchestration/schemas.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../protocol/negotiation.js"

export const FAULT_MESH_ID: MeshId = meshIdSchema.parse("mesh-fault")
export const FAULT_PROJECT: ProjectId = projectIdSchema.parse("project-fault")
export const FAULT_RUN: RunId = runIdSchema.parse("run-fault-1")
export const FAULT_TASK: TaskId = taskIdSchema.parse("task-fault-1")
export const FAULT_DISPATCH = "dispatch-fault-1"
export const FAULT_APPROVAL = "approval-fault-1"
export const FAULT_LEASE: LeaseId = leaseIdSchema.parse("lease-run-fault-1-e1")
export const SUCCESSOR_LEASE: LeaseId = leaseIdSchema.parse("lease-run-fault-1-e2")
/**
 * The project path every record in the harness names.
 *
 * Parsed once and shared because a heartbeat advertises a `projectPathId` list and
 * a dispatch envelope carries the same id, and the two have to AGREE: a scenario
 * that advertised one path and dispatched against another would be testing
 * capability matching with two fixture bugs cancelling out.
 */
export const FAULT_PROJECT_PATH: ReturnType<typeof projectPathIdSchema.parse> = projectPathIdSchema.parse("path-fault-1")

/** The default lease window. Thirty seconds, matching M4.4's own lease duration. */
export const FAULT_LEASE_DURATION_SECONDS = 30

/** The controller's actor. A controller driving a run is the kernel's `node` actor. */
export function controllerActor(nodeId: NodeId): Actor {
  return actorSchema.parse({ kind: "node", nodeId })
}

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

// --- mesh.lease -----------------------------------------------------------

export interface LeaseRecordInput {
  readonly leaseId?: string
  readonly projectId?: ProjectId
  readonly runId?: RunId
  readonly controllerNodeId: NodeId
  readonly recipientNodeId: NodeId
  readonly epoch: number
  readonly operation: MeshLease["operation"]
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  readonly predecessorLeaseId?: string
  readonly predecessorEpoch?: number
  readonly takeoverReason?: string
  readonly acknowledgedUnreconciledNodeIds?: readonly NodeId[]
}

/**
 * A `mesh.lease` envelope.
 *
 * `durationSeconds` is DERIVED from the two timestamps rather than stated beside
 * them, because `meshLeaseSchema` refuses a record where the three disagree — and a
 * fixture that could disagree with itself would let a test trip that refusal for a
 * reason that has nothing to do with the guard under test.
 */
export function leaseEnvelope(input: LeaseRecordInput): Record<string, unknown> {
  // Parenthesised because `??` binds LOOSER than the conditional, so the
  // unparenthesised form parsed as `(input.leaseId ?? (String(input.epoch) === "1"))
  // ? FAULT_LEASE : SUCCESSOR_LEASE` — which discarded every lease id a caller
  // named and minted a takeover onto its PREDECESSOR's id. The history table is
  // keyed by lease id, so the epoch-2 row was silently swallowed by
  // `INSERT OR IGNORE` and a worker at epoch 2 could never resolve the lease its
  // own commands named: the harness could not execute anything at a successor
  // epoch at all.
  const leaseId = leaseIdSchema.parse(input.leaseId ?? (String(input.epoch) === "1" ? FAULT_LEASE : SUCCESSOR_LEASE))
  const issuedAt = iso(input.issuedAtMs)
  const expiresAt = iso(input.expiresAtMs)
  const durationSeconds = Math.round((input.expiresAtMs - input.issuedAtMs) / 1000)
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.lease",
    messageId: `msg-${leaseId}`,
    correlationId: leaseId,
    causation: null,
    senderNodeId: input.controllerNodeId,
    recipientNodeId: input.recipientNodeId,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt,
    expiresAt,
    payload: {
      leaseId,
      projectId: input.projectId ?? FAULT_PROJECT,
      runId: input.runId ?? FAULT_RUN,
      controllerNodeId: input.controllerNodeId,
      epoch: epochSchema.parse(input.epoch),
      operation: input.operation,
      issuedAt,
      expiresAt,
      durationSeconds,
      ...(input.predecessorLeaseId === undefined ? {} : { predecessorLeaseId: input.predecessorLeaseId }),
      ...(input.predecessorEpoch === undefined ? {} : { predecessorEpoch: input.predecessorEpoch }),
      ...(input.takeoverReason === undefined ? {} : { takeoverReason: input.takeoverReason }),
      acknowledgedUnreconciledNodeIds: input.acknowledgedUnreconciledNodeIds ?? [],
    },
  }
}

// --- mesh.heartbeat -------------------------------------------------------

export function heartbeatEnvelope(input: {
  readonly nodeId: NodeId
  readonly meshId?: MeshId
  readonly sequence: number
  readonly observedAtMs: number
}): Record<string, unknown> {
  const heartbeat: MeshHeartbeat = {
    meshId: input.meshId ?? FAULT_MESH_ID,
    nodeId: input.nodeId,
    observedAt: iso(input.observedAtMs),
    sequence: input.sequence,
    liveness: "live",
    runtimeKinds: ["opencode"],
    capabilities: ["session.execute"],
    projectPathIds: [FAULT_PROJECT_PATH],
    maxConcurrentSessions: 4,
    protocolVersions: [CURRENT_MESH_PROTOCOL_VERSION],
    agentCount: 1,
    load: { activeSessions: 0, queuedSessions: 0 },
  }
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.heartbeat",
    messageId: `msg-hb-${input.sequence}`,
    correlationId: `hb-${input.sequence}`,
    causation: null,
    senderNodeId: input.nodeId,
    recipientNodeId: input.nodeId,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: iso(input.observedAtMs),
    expiresAt: iso(input.observedAtMs + 3_600_000),
    payload: heartbeat,
  }
}

// --- mesh.command ----------------------------------------------------------

/** A `dispatch` envelope, digest-bound to its own canonical form. */
export function aDispatchEnvelope(overrides: {
  readonly dispatchId?: string
  readonly taskId?: TaskId
  readonly attempt?: number
  readonly prompt?: string
  readonly targetNodeId: NodeId
  readonly controllerEpoch: number
  readonly projectId?: ProjectId
  readonly runId?: RunId
}): Dispatch["envelope"] {
  const projectId = overrides.projectId ?? FAULT_PROJECT
  const runId = overrides.runId ?? FAULT_RUN
  const now = "2026-09-28T00:00:00.000Z"
  return dispatchEnvelopeSchema.parse({
    schemaVersion: 1,
    dispatchId: overrides.dispatchId ?? FAULT_DISPATCH,
    attempt: overrides.attempt ?? 1,
    projectId,
    runId,
    taskId: overrides.taskId ?? FAULT_TASK,
    targetNodeId: overrides.targetNodeId,
    installationId: "install-fault-1",
    runtimeKind: "opencode",
    projectPathId: FAULT_PROJECT_PATH,
    prompt: overrides.prompt ?? "Run the fault-harness dispatch",
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "role-fault-1",
      templateVersion: 1,
      projectId,
      name: "Fault runner",
      purpose: "fuzz",
      instructions: "run under fault",
      requiredCapabilities: ["fs.read"],
      preferredRuntimeKinds: ["opencode"],
      contextSelectionPolicyReference: { namespace: "t", id: "fault" },
      permissionRestrictions: {
        allowedCapabilities: ["fs.read"],
        deniedCapabilities: [],
        approvalRequirements: { destructiveEffects: true, externalEffects: true, capabilities: ["fs.read"] },
      },
      author: { kind: "user", userId: "user-fault" },
      createdAt: now,
    },
    ruleSnapshots: [],
    contextManifest: { references: [], manifestDigest: `sha256:${"0".repeat(64)}` },
    requestedCapabilities: ["fs.read"],
    permissionEnvelope: {
      allowedCapabilities: ["fs.read"],
      deniedCapabilities: [],
      approvalRequirements: { destructiveEffects: true, externalEffects: true, capabilities: ["fs.read"] },
    },
    dependencies: [],
    timeoutSeconds: 600,
    controllerEpoch: overrides.controllerEpoch,
  })
}

/** A `dispatch` record in a named lifecycle state, digest-bound to its envelope. */
export function aDispatch(envelope: Dispatch["envelope"], state: Dispatch["state"]): Dispatch {
  return dispatchSchema.parse({
    schemaVersion: 1,
    envelope,
    envelopeDigest: digestDispatchEnvelope(envelope),
    state,
    createdAt: "2026-09-28T00:00:00.000Z",
    externalReferences: [],
  })
}

/** A proposed `dispatch` record, digest-bound to its envelope. */
export function aProposedDispatch(envelope: Dispatch["envelope"]): Dispatch {
  return aDispatch(envelope, "proposed")
}

/**
 * The SAME dispatch, one lifecycle step on.
 *
 * A separate builder rather than a `state` parameter on {@link aProposedDispatch}
 * because the two records are not interchangeable and the difference is the whole
 * point of the approve step: `dispatch.propose` records the dispatch as
 * `proposed`, and `dispatch.approve` records the same envelope AGAIN in state
 * `approved`. A fixture that handed the coordinator a `proposed` dispatch to
 * approve would be refused with `dispatch_not_approvable` — correctly, since
 * approving a dispatch into the state it already holds is a no-op the kernel
 * declines on purpose.
 */
export function anApprovedDispatch(envelope: Dispatch["envelope"]): Dispatch {
  return aDispatch(envelope, "approved")
}

/** An approved `approval` bound to `envelope`'s digest. */
export function anApproval(envelope: Dispatch["envelope"]): ReturnType<typeof approvalSchema.parse> {
  return approvalSchema.parse({
    schemaVersion: 1,
    approvalId: FAULT_APPROVAL,
    projectId: envelope.projectId,
    runId: envelope.runId,
    dispatchId: envelope.dispatchId,
    envelopeDigest: digestDispatchEnvelope(envelope),
    decision: "approved",
    state: "approved",
    basis: { kind: "user" },
    actor: { kind: "user", userId: "user-fault" },
    decidedAt: "2026-09-28T00:00:00.000Z",
  })
}

export interface CommandEnvelopeInput {
  readonly commandId?: string
  readonly type: OrchestrationCommand["type"]
  readonly payload: unknown
  readonly controllerNodeId: NodeId
  readonly targetNodeId: NodeId
  readonly leaseId?: string
  readonly epoch: number
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  readonly projectId?: ProjectId
  readonly runId?: RunId
  /** Breaks the minted record, for the one test that deliberately violates the wire. */
  readonly tamper?: (record: Record<string, unknown>) => Record<string, unknown>
}

/** A `mesh.command` envelope, minted through the protocol's own seam. */
export function commandEnvelope(input: CommandEnvelopeInput): Record<string, unknown> {
  const commandId = commandIdSchema.parse(input.commandId ?? `cmd-fault-${input.type.replace(".", "-")}`)
  const correlationId = correlationIdSchema.parse(commandId)
  const issuedAt = iso(input.issuedAtMs)
  const expiresAt = iso(input.expiresAtMs)
  const command: OrchestrationCommand = orchestrationCommandSchema.parse({
    schemaVersion: 1,
    commandId,
    projectId: input.projectId ?? FAULT_PROJECT,
    runId: input.runId ?? FAULT_RUN,
    actor: controllerActor(input.controllerNodeId),
    controllerNodeId: input.controllerNodeId,
    controllerEpoch: epochSchema.parse(input.epoch),
    leaseId: leaseIdSchema.parse(input.leaseId ?? FAULT_LEASE),
    issuedAt,
    expiresAt,
    correlationId,
    causation: null,
    type: input.type,
    payload: input.payload,
  })
  const minted = mintMeshCommand({ command, targetNodeId: input.targetNodeId }) as unknown as Record<string, unknown>
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.command",
    messageId: `msg-${commandId}`,
    correlationId,
    causation: null,
    senderNodeId: input.controllerNodeId,
    recipientNodeId: input.targetNodeId,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt,
    expiresAt,
    payload: input.tamper === undefined ? minted : input.tamper(minted),
  }
}

// --- mesh.event -----------------------------------------------------------

export interface EventInput {
  readonly eventId: string
  readonly sourceNodeId: NodeId
  readonly localSequence: number
  readonly runId?: RunId
  readonly projectId?: ProjectId
  readonly sessionId?: string
  readonly dispatchId?: string
  readonly commandCorrelation?: CommandId | null
  readonly occurredAtMs: number
  readonly type?: "dispatch.started" | "session.observed" | "dispatch.finished"
  readonly controllerEpoch?: number
}

export function aMeshEvent(input: EventInput): MeshEvent {
  const projectId = input.projectId ?? FAULT_PROJECT
  const runId = input.runId ?? FAULT_RUN
  const sessionId = sessionIdSchema.parse(input.sessionId ?? `sess-fault-${input.localSequence}`)
  const correlation =
    input.commandCorrelation === undefined ? commandIdSchema.parse("cmd-fault-dispatch-execute") : input.commandCorrelation
  const occurredAt = iso(input.occurredAtMs)
  const type = input.type ?? "dispatch.started"
  const event = orchestrationEventSchema.parse({
    schemaVersion: 1,
    eventId: input.eventId,
    sequence: input.localSequence,
    projectId,
    runId,
    occurredAt,
    actor: { kind: "node", nodeId: input.sourceNodeId },
    correlationId: input.eventId,
    causation: correlation === null ? null : { kind: "command", commandId: correlation },
    controllerEpoch: input.controllerEpoch ?? 1,
    ...(correlation === null ? {} : { commandId: correlation }),
    type,
    payload:
      type === "dispatch.finished"
        ? { dispatchId: input.dispatchId ?? FAULT_DISPATCH, outcome: "completed" }
        : {
            session: sessionSchema.parse({
              schemaVersion: 1,
              sessionId,
              projectId,
              runId,
              taskId: FAULT_TASK,
              dispatchId: input.dispatchId ?? FAULT_DISPATCH,
              nodeId: input.sourceNodeId,
              installationId: "install-fault-1",
              runtimeKind: "opencode",
              lifecycleState: type === "session.observed" ? "running" : "launching",
              observedState: type === "session.observed" ? "working" : "starting",
            }),
          },
  })
  return mintMeshEvent({
    event,
    sourceNodeId: input.sourceNodeId,
    localSequence: input.localSequence,
    commandCorrelation: correlation,
  })
}

/** The `mesh.event` envelope carrying `event`, addressed to `destination`. */
export function eventEnvelope(event: MeshEvent, destination: NodeId): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.event",
    messageId: `msg-${event.eventId}`,
    correlationId: event.eventId,
    causation: null,
    senderNodeId: event.sourceNodeId,
    recipientNodeId: destination,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: event.observedAt,
    expiresAt: iso(Date.parse(event.observedAt) + 3_600_000),
    payload: event,
  }
}

// --- mesh.ack -------------------------------------------------------------

/**
 * The envelope for an event already canonicalised into an outbox row.
 *
 * The outbox stores the event's CANONICAL JSON, so the bytes that go on the wire
 * are read back out of the row rather than re-serialised from a live object. That
 * is what makes "the controller parsed the bytes the outbox stored" checkable: a
 * harness that rebuilt the envelope from its own copy of the event would be
 * asserting that two serialisations agree, which is not the same claim.
 */
export function eventEnvelopeFor(
  entry: { readonly eventJson: string; readonly destination: string },
  senderNodeId: NodeId,
): Record<string, unknown> {
  const event = JSON.parse(entry.eventJson) as MeshEvent
  return { ...eventEnvelope(event, nodeIdSchema.parse(entry.destination)), senderNodeId }
}

/** The `mesh.ack` payload a controller answers a `mesh.event` with. */
export function anEventAck(event: MeshEvent, outcome: MeshAck["outcome"]): MeshAck {
  return meshAckSchema.parse({
    acksEventId: event.eventId,
    ackKind: "event",
    acknowledgedAt: event.observedAt,
    outcome,
    ...(outcome === "accepted" ? { acknowledgedThroughLocalSequence: event.localSequence } : {}),
  })
}

// --- mesh.reconciliation --------------------------------------------------

export function aReconciliationRequest(input: {
  readonly reconcileId: string
  readonly controllerNodeId: NodeId
  readonly peerNodeId: NodeId
  readonly epoch: number
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  readonly inventory?: readonly { sessionId: string; dispatchId: string }[]
}): Record<string, unknown> {
  const reconcileId = input.reconcileId
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.reconciliation.request",
    messageId: `msg-${reconcileId}`,
    correlationId: reconcileId,
    causation: null,
    senderNodeId: input.controllerNodeId,
    recipientNodeId: input.peerNodeId,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: iso(input.issuedAtMs),
    expiresAt: iso(input.expiresAtMs),
    payload: {
      reconcileId,
      projectId: FAULT_PROJECT,
      runId: FAULT_RUN,
      controllerNodeId: input.controllerNodeId,
      controllerEpoch: input.epoch,
      peerNodeId: input.peerNodeId,
      peerProtocolVersions: [CURRENT_MESH_PROTOCOL_VERSION],
      controllerLastAcknowledgedInboxSequence: 0,
      controllerLastAcknowledgedOutboxSequence: 0,
      observedAt: iso(input.issuedAtMs),
      activeSessionInventory: (input.inventory ?? []).map((entry) => ({
        sessionId: sessionIdSchema.parse(entry.sessionId),
        dispatchId: entry.dispatchId,
        startedAt: iso(input.issuedAtMs),
      })),
    },
  }
}

// --- The legacy record M4-B hook 8 translates -------------------------------

/**
 * A legacy job record, shaped exactly as the released JSON store holds one.
 *
 * In the fault harness rather than a test file because hook 8 is the ONE boundary
 * a scenario cannot reach through the wire: nothing in `src/mesh` translates a
 * legacy trigger, so a fault harness that wanted to crash inside translation
 * would have no way to get there. The record lives here so the harness's own
 * translation seam and the tests that drive it cannot disagree about its shape.
 */
export function aLegacyJob(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "job_1",
    trigger: {
      job_id: "job_1",
      source_agent_id: "dev-main",
      target_agent_id: "test-vps",
      capability: "testing",
      project_dir: "/srv/apps/app",
      prompt: "Run the fault-harness translation",
      callback_url: "http://dev-main.tailnet:8787/report",
      timeout_seconds: 60,
    },
    status: "running",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:01.000Z",
    ...overrides,
  }
}

export { nodeIdSchema, taskIdSchema, commandIdSchema, sessionIdSchema }
export type { Session }

/**
 * Protocol test fixtures.
 *
 * Every record is built through its family schema, so a fixture that drifts from
 * the contract fails HERE rather than producing a quietly invalid wire record
 * that a later assertion happens to be lenient about. The one exception is
 * `rawEnvelope`, which is a plain object on purpose: the negative tests need to
 * feed the registry records it should refuse.
 *
 * Every timestamp is a literal. Nothing in this directory reads a clock, which
 * is what lets the partition and restart tests express "ten minutes after the
 * lease stopped being renewed" as a number instead of a wait.
 */
import {
  actorSchema,
  approvalSchema,
  dispatchEnvelopeSchema,
  dispatchSchema,
  orchestrationCommandSchema,
  orchestrationEventSchema,
  runSchema,
  taskSchema,
} from "../../../src/orchestration/schemas.js"
import type { OrchestrationCommand, OrchestrationEvent } from "../../../src/orchestration/types.js"
import { digestJson } from "../../../src/orchestration/digest.js"
import { makeEnvelope } from "../orchestration/fixtures/recorded-events.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../../src/mesh/protocol/negotiation.js"
import {
  CURRENT_SCHEMA_VERSION,
  epochSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
} from "../../../src/orchestration/identifiers.js"
import { mintMeshCommand } from "../../../src/mesh/protocol/command.js"
import { mintMeshEvent } from "../../../src/mesh/protocol/event.js"
import { MESH_RECORD_TYPES, type MeshRecordType } from "../../../src/mesh/protocol/envelope.js"

/**
 * Branded at the kernel's own brands, not left as bare strings.
 *
 * These constants reach both kinds of call site: `rawEnvelope` takes untyped
 * strings, while `mintMeshCommand` and `mintMeshEvent` take `NodeId`. Branding
 * here means the second kind typechecks WITHOUT a cast at the fixture, and the
 * brands are still assignable to `string` everywhere the first kind wants them —
 * so a fixture cannot quietly hand a `NodeId` to something expecting a `RunId`.
 */
export const PROJECT_ID = projectIdSchema.parse("project-release")
export const RUN_ID = runIdSchema.parse("run-release-1")
export const CONTROLLER_ID = nodeIdSchema.parse("node-controller-1")
export const WORKER_ID = nodeIdSchema.parse("node-worker-1")
export const OTHER_WORKER_ID = nodeIdSchema.parse("node-worker-2")
export const LEASE_ID = leaseIdSchema.parse("lease-run-1")
export const EPOCH = epochSchema.parse(4)
export const PROTOCOL_VERSION = CURRENT_MESH_PROTOCOL_VERSION

export const T0 = "2026-09-28T00:00:00.000Z"
export const T1 = "2026-09-28T00:00:10.000Z"
export const T2 = "2026-09-28T00:00:20.000Z"
export const T_PLUS_10M = "2026-09-28T00:10:00.000Z"

export function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString()
}

const CONTROLLER_ACTOR = actorSchema.parse({ kind: "node", nodeId: CONTROLLER_ID })
const WORKER_ACTOR = actorSchema.parse({ kind: "node", nodeId: WORKER_ID })

/**
 * A `dispatch.propose` payload, which is the shape that exercises `dispatchId`.
 *
 * The envelope's `controllerEpoch` is restated at the mesh epoch rather than
 * inherited from the shared kernel fixture, because the kernel's dispatch
 * envelope requires the dispatch epoch to equal the command epoch and a
 * cross-fixture mismatch would be a fixture defect dressed up as a protocol
 * assertion.
 */
export function makeDispatch(
  options: { readonly dispatchId: string; readonly prompt?: string; readonly controllerEpoch?: number } = {
    dispatchId: "dispatch-1",
  },
) {
  const base = makeEnvelope({ dispatchId: options.dispatchId, taskId: "task-1", attempt: 1, prompt: options.prompt ?? "Do the work" })
  const envelope = dispatchEnvelopeSchema.parse({ ...base, controllerEpoch: options.controllerEpoch ?? EPOCH })
  return dispatchSchema.parse({
    schemaVersion: 1,
    envelope,
    envelopeDigest: digestJson(envelope),
    state: "proposed",
    createdAt: T0,
    externalReferences: [],
  })
}

/**
 * A recorded approval, digest-bound to the dispatch envelope it approves.
 *
 * Exists so the command tests can exercise the one path where a payload carries
 * an authorization POINTER. The point of building it here is that it is a
 * *recorded* value: nothing in `verifyIncomingCommand` resolves it, and a test
 * that asserted the command was "authorized" because it carried an approval id
 * would be asserting the exact defect this milestone closed twice.
 */
export function makeApproval(dispatch = makeDispatch()) {
  return approvalSchema.parse({
    schemaVersion: 1,
    approvalId: "approval-1",
    projectId: PROJECT_ID,
    runId: RUN_ID,
    dispatchId: dispatch.envelope.dispatchId,
    envelopeDigest: dispatch.envelopeDigest,
    decision: "approved",
    state: "approved",
    basis: { kind: "user" },
    actor: { kind: "user", userId: "user-1" },
    decidedAt: T1,
  })
}

export interface CommandOverrides {
  readonly commandId?: string
  readonly type?: OrchestrationCommand["type"]
  readonly issuedAt?: string
  readonly expiresAt?: string
  readonly controllerEpoch?: number
  readonly controllerNodeId?: string
  readonly leaseId?: string
  readonly payload?: Record<string, unknown>
}

export function makeCommand(overrides: CommandOverrides = {}): OrchestrationCommand {
  const type = overrides.type ?? "run.pause"
  const issuedAt = overrides.issuedAt ?? T0
  const expiresAt = overrides.expiresAt ?? T2
  const base = {
    schemaVersion: 1,
    commandId: overrides.commandId ?? "cmd-7",
    projectId: PROJECT_ID,
    runId: RUN_ID,
    actor: CONTROLLER_ACTOR,
    controllerNodeId: overrides.controllerNodeId ?? CONTROLLER_ID,
    controllerEpoch: overrides.controllerEpoch ?? EPOCH,
    leaseId: overrides.leaseId ?? LEASE_ID,
    issuedAt,
    expiresAt,
    correlationId: overrides.commandId ?? "cmd-7",
    causation: null,
  }
  const payload =
    overrides.payload ??
    (type === "dispatch.propose"
      ? { dispatch: makeDispatch() }
      : type === "session.prompt"
        ? { sessionId: "session-1", prompt: "hello" }
        : { reason: "operator asked" })
  return orchestrationCommandSchema.parse({ ...base, type, payload })
}

/**
 * A `run.create` command whose canonical size is whatever the caller asked for.
 *
 * Exists because `MAX_COMMAND_PAYLOAD_BYTES` (128 KiB) is larger than any SINGLE
 * bounded field in the kernel — the biggest text field is a 64 KiB prompt — so a
 * bound test that used one field would be testing a limit the shape already
 * enforces. Two task descriptions of 64 KiB each is the smallest construction
 * that genuinely crosses the wire bound, and it crosses it while still being a
 * record the KERNEL would accept: a limit that is only reachable by an invalid
 * record is not applied to anything.
 */
export function makeRunCreateCommand(taskCount: number, descriptionLength: number): OrchestrationCommand {
  const run = runSchema.parse({
    schemaVersion: 1,
    runId: RUN_ID,
    projectId: PROJECT_ID,
    goal: "Release the thing",
    state: "draft",
    paused: false,
    createdAt: T0,
    updatedAt: T0,
    externalReferences: [],
  })
  const tasks = Array.from({ length: taskCount }, (_, index) =>
    taskSchema.parse({
      schemaVersion: 1,
      taskId: `task-${index + 1}`,
      runId: RUN_ID,
      projectId: PROJECT_ID,
      title: `Task ${index + 1}`,
      description: "d".repeat(descriptionLength),
      state: "pending",
      failurePolicy: "block",
      dependencies: [],
      externalReferences: [],
    }),
  )
  return makeCommand({ commandId: "cmd-create", type: "run.create", payload: { run, tasks } })
}

export interface EventOverrides {
  readonly eventId?: string
  readonly sequence?: number
  readonly type?: OrchestrationEvent["type"]
  readonly occurredAt?: string
  readonly commandId?: string
  readonly payload?: Record<string, unknown>
}

export function makeEvent(overrides: EventOverrides = {}): OrchestrationEvent {
  const type = overrides.type ?? "session.observed"
  return orchestrationEventSchema.parse({
    schemaVersion: 1,
    eventId: overrides.eventId ?? "evt-1",
    sequence: overrides.sequence ?? 1,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    actor: WORKER_ACTOR,
    occurredAt: overrides.occurredAt ?? T1,
    correlationId: "corr-1",
    causation: null,
    controllerEpoch: EPOCH,
    ...(overrides.commandId === undefined ? {} : { commandId: overrides.commandId }),
    type,
    payload: overrides.payload ?? sessionObservedPayload(),
  })
}

function sessionObservedPayload(): Record<string, unknown> {
  return {
    session: {
      schemaVersion: 1,
      sessionId: "session-1",
      projectId: PROJECT_ID,
      runId: RUN_ID,
      taskId: "task-1",
      dispatchId: "dispatch-1",
      nodeId: WORKER_ID,
      installationId: "install-1",
      runtimeKind: "opencode",
      lifecycleState: "running",
      observedState: "working",
    },
  }
}

/**
 * A `run.created` event that is valid to the KERNEL and over the mesh's
 * `MAX_EVENT_PAYLOAD_BYTES`.
 *
 * The bulk comes from `externalReferences` rather than from a long field,
 * because every single field in a kernel record is bounded well under 128 KiB:
 * a payload bound larger than the largest field it could carry is only reachable
 * through a collection, and a bound test that used one oversized field would be
 * testing a limit the kernel schema already enforces.
 */
export function makeOversizedEvent(referenceCount: number, referenceIdLength: number): OrchestrationEvent {
  const run = runSchema.parse({
    schemaVersion: 1,
    runId: RUN_ID,
    projectId: PROJECT_ID,
    goal: "Release the thing",
    state: "draft",
    paused: false,
    createdAt: T0,
    updatedAt: T0,
    externalReferences: Array.from({ length: referenceCount }, (_, index) => ({
      namespace: "runbook",
      id: `${index}:${"r".repeat(referenceIdLength)}`,
    })),
  })
  return makeEvent({ eventId: "evt-oversized", type: "run.created", payload: { run } })
}

export interface EnvelopeOverrides {
  readonly correlationId?: string
  readonly causation?: unknown
  readonly senderNodeId?: string
  readonly recipientNodeId?: string | null
  readonly issuedAt?: string
  readonly expiresAt?: string
  readonly schemaVersion?: unknown
  readonly protocolVersion?: number
  readonly messageId?: string
}

/**
 * A wire envelope as a PLAIN object.
 *
 * Not schema-parsed: the negative tests deliberately produce envelopes the
 * schemas must refuse, and parsing them here would move the failure to the
 * fixture. The happy-path tests still get their real validation, because
 * `parseMeshEnvelope` is the only thing that performs it.
 */
export function rawEnvelope(recordType: MeshRecordType | string, payload: unknown, overrides: EnvelopeOverrides = {}): Record<string, unknown> {
  return {
    schemaVersion: overrides.schemaVersion === undefined ? CURRENT_SCHEMA_VERSION : overrides.schemaVersion,
    recordType,
    messageId: overrides.messageId ?? `msg-${Math.abs(hash(recordType + JSON.stringify(payload)))}`,
    correlationId: overrides.correlationId ?? "corr-1",
    causation: overrides.causation === undefined ? null : overrides.causation,
    senderNodeId: overrides.senderNodeId ?? CONTROLLER_ID,
    recipientNodeId: overrides.recipientNodeId === undefined ? WORKER_ID : overrides.recipientNodeId,
    protocolVersion: overrides.protocolVersion ?? PROTOCOL_VERSION,
    issuedAt: overrides.issuedAt ?? T0,
    expiresAt: overrides.expiresAt ?? T2,
    payload,
  }
}

function hash(value: string): number {
  let h = 0
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0
  return h
}

// --- Family payload builders --------------------------------------------

export function heartbeatPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meshId: "mesh-1",
    nodeId: WORKER_ID,
    observedAt: T1,
    sequence: 1,
    liveness: "live",
    runtimeKinds: ["opencode"],
    capabilities: ["fs.read", "fs.write"],
    projectPathIds: ["path-release-1"],
    maxConcurrentSessions: 4,
    protocolVersions: [PROTOCOL_VERSION],
    agentCount: 1,
    load: { activeSessions: 1, queuedSessions: 0 },
    ...overrides,
  }
}

export function leasePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    leaseId: LEASE_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    controllerNodeId: CONTROLLER_ID,
    epoch: EPOCH,
    operation: "claim",
    issuedAt: T0,
    expiresAt: at(30),
    durationSeconds: 30,
    acknowledgedUnreconciledNodeIds: [],
    ...overrides,
  }
}

export function enrollmentRequestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meshId: "mesh-1",
    enrollmentId: "enr-1",
    enrollmentCodeHash: `sha256:${"a".repeat(64)}`,
    nodePublicKey: "AAAA",
    nodeDisplayName: "worker-1",
    provisionalNodeId: "provisional-1",
    requestedAt: T0,
    codeExpiresAt: at(60),
    ...overrides,
  }
}

export function enrollmentResponsePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enrollmentId: "enr-1",
    meshId: "mesh-1",
    outcome: "accepted",
    nodeId: WORKER_ID,
    nodeKeyId: "key-1",
    peerKeyPins: [],
    decidedAt: T1,
    ...overrides,
  }
}

export function ackPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    acksCommandId: "cmd-7",
    ackKind: "command",
    acknowledgedAt: T1,
    outcome: "accepted",
    ...overrides,
  }
}

export function terminalControlPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    terminalId: "terminal-1",
    projectId: PROJECT_ID,
    sessionId: "session-1",
    nodeId: WORKER_ID,
    clientId: "client-1",
    operation: "attach",
    epoch: EPOCH,
    ...overrides,
  }
}

export function terminalDataPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    terminalId: "terminal-1",
    clientId: "client-1",
    direction: "to_viewer",
    encoding: "base64",
    chunk: "aGVsbG8=",
    sequence: 1,
    ...overrides,
  }
}

export function reconciliationRequestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reconcileId: "rec-1",
    projectId: PROJECT_ID,
    runId: RUN_ID,
    controllerNodeId: CONTROLLER_ID,
    controllerEpoch: EPOCH,
    peerNodeId: WORKER_ID,
    peerProtocolVersions: [PROTOCOL_VERSION],
    controllerLastAcknowledgedInboxSequence: 0,
    controllerLastAcknowledgedOutboxSequence: 0,
    observedAt: T1,
    activeSessionInventory: [{ sessionId: "session-1", dispatchId: "dispatch-1", startedAt: T0 }],
    ...overrides,
  }
}

export function reconciliationResponsePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reconcileId: "rec-1",
    outcome: "converged",
    acceptedControllerEpoch: EPOCH,
    resendCommandIds: [],
    resendEventIds: [],
    unreconciled: [],
    ...overrides,
  }
}

// --- One valid envelope per family ---------------------------------------

/**
 * A structurally VALID envelope for each of the eleven `recordType` values.
 *
 * The tests that need a wrong record build it by taking one of these and breaking
 * exactly one thing, so a failure names the defect rather than the difference
 * between two hand-written envelopes. Anything a family binds to its envelope —
 * the correlation closure, the first-person sender rule, the command's
 * self-causation — is satisfied here, because those bindings are the family's
 * own contract and re-testing them in every file would only add noise.
 */
export function sampleEnvelope(recordType: MeshRecordType, overrides: EnvelopeOverrides = {}): Record<string, unknown> {
  switch (recordType) {
    case "mesh.enrollment.request":
      return rawEnvelope(recordType, enrollmentRequestPayload(), { correlationId: "enr-1", ...overrides })
    case "mesh.enrollment.response":
      return rawEnvelope(recordType, enrollmentResponsePayload(), { correlationId: "enr-1", ...overrides })
    case "mesh.heartbeat":
      return rawEnvelope(recordType, heartbeatPayload(), {
        senderNodeId: WORKER_ID,
        recipientNodeId: null,
        ...overrides,
      })
    case "mesh.command":
      return rawEnvelope(recordType, mintMeshCommand({ command: makeCommand(), targetNodeId: WORKER_ID }), {
        correlationId: "cmd-7",
        ...overrides,
      })
    case "mesh.ack":
      return rawEnvelope(recordType, ackPayload(), { correlationId: "cmd-7", ...overrides })
    case "mesh.event":
      return rawEnvelope(recordType, mintMeshEvent({ event: makeEvent(), sourceNodeId: WORKER_ID, localSequence: 1 }), {
        correlationId: "evt-1",
        senderNodeId: WORKER_ID,
        recipientNodeId: CONTROLLER_ID,
        ...overrides,
      })
    case "mesh.lease":
      return rawEnvelope(recordType, leasePayload(), { ...overrides })
    case "mesh.reconciliation.request":
      return rawEnvelope(recordType, reconciliationRequestPayload(), { correlationId: "rec-1", ...overrides })
    case "mesh.reconciliation.response":
      return rawEnvelope(recordType, reconciliationResponsePayload(), { correlationId: "rec-1", ...overrides })
    case "mesh.terminal.control":
      return rawEnvelope(recordType, terminalControlPayload(), { correlationId: "client-1", ...overrides })
    case "mesh.terminal.data":
      return rawEnvelope(recordType, terminalDataPayload(), { correlationId: "client-1", ...overrides })
  }
}

/** Every family, in the order §4 of the spec introduces them. */
export const ALL_RECORD_TYPES: readonly MeshRecordType[] = MESH_RECORD_TYPES

/**
 * M4.8 test fixtures.
 *
 * Everything a snapshot needs is built through the OWNING schema — `nodeRecordSchema`,
 * `leaseRecordSchema`, `unreconciledEntrySchema`, `sessionSchema`, `parseMeshTuiSnapshot` —
 * and then PARSED again by the snapshot parser. That round trip is the point: a
 * fixture that assembled a `MeshTuiSnapshot` by hand would satisfy a view model
 * with values the mesh could never produce, and every negative test in this
 * directory would then be testing a shape that does not exist in production.
 *
 * Nothing here reads a clock. There is no clock to read: the TUI derives no time
 * of its own, and every age it displays arrives as `RegisteredNode.ageMs` that
 * M4.3 computed with ITS injected clock. A fixture that called `Date.now()` would
 * make "a stale node shows its heartbeat age" a sleep rather than a number.
 */
import {
  CURRENT_SCHEMA_VERSION,
  dispatchIdSchema,
  leaseIdSchema,
  meshIdSchema,
  nodeIdSchema,
  projectIdSchema,
  projectPathIdSchema,
  runIdSchema,
  taskIdSchema,
  type LeaseId,
  type MeshId,
  type NodeId,
  type ProjectId,
  type RunId,
} from "../../../../src/orchestration/identifiers.js"
import { sessionSchema } from "../../../../src/orchestration/schemas.js"
import type { Session } from "../../../../src/orchestration/types.js"
import { nodeKeyIdSchema } from "../../../../src/mesh/identity/wire-ids.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../../../src/mesh/protocol/negotiation.js"
import { MESH_OUTBOX_MAX_ATTEMPTS } from "../../../../src/mesh/outbox/policy.js"
import type { UnreconciledEntry } from "../../../../src/mesh/protocol/reconciliation.js"
import {
  MESH_TUI_LEASE_STANDINGS,
  MESH_TUI_NETWORK_STATES,
  parseMeshTuiSnapshot,
  type MeshRemoteSessionSnapshot,
  type MeshTuiLeaseSnapshot,
  type MeshTuiNetworkState,
  type MeshTuiOutboxRow,
  type MeshTuiSnapshot,
  type MeshTuiTerminalSnapshot,
} from "../../../../src/mesh/tui/index.js"

export const MESH: MeshId = meshIdSchema.parse("mesh-release")
export const PROJECT: ProjectId = projectIdSchema.parse("project-release")
export const RUN: RunId = runIdSchema.parse("run-release-1")
export const OTHER_RUN: RunId = runIdSchema.parse("run-release-2")
export const SCOPE = Object.freeze({ projectId: PROJECT, runId: RUN })

export const LOCAL: NodeId = nodeIdSchema.parse("node-controller-a")
export const WORKER_1: NodeId = nodeIdSchema.parse("node-worker-1")
export const WORKER_2: NodeId = nodeIdSchema.parse("node-worker-2")
export const WORKER_3: NodeId = nodeIdSchema.parse("node-worker-3")

/** The lease this node held, and the one that fenced it. Both are real links in a chain. */
export const LEASE_1: LeaseId = leaseIdSchema.parse("lease-run-release-1-e1")
export const LEASE_2: LeaseId = leaseIdSchema.parse("lease-run-release-1-e2")
export const PATH_1 = projectPathIdSchema.parse("path-release-1")

/** T0. Only used to BUILD records; the TUI itself never compares against it. */
export const T0_MS = Date.parse("2026-09-28T00:00:00.000Z")

export function at(seconds: number): number {
  return T0_MS + seconds * 1000
}

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function capability(overrides: Record<string, unknown> = {}) {
  return {
    observedAt: iso(at(0)),
    sequence: 1,
    runtimeKinds: ["opencode"],
    capabilities: ["session.execute"],
    projectPathIds: [PATH_1],
    maxConcurrentSessions: 4,
    agentCount: 1,
    load: { activeSessions: 0, queuedSessions: 0 },
    offeredProtocolVersions: [CURRENT_MESH_PROTOCOL_VERSION],
    negotiatedProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    ...overrides,
  }
}

function revocation(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: WORKER_3,
    meshId: MESH,
    revokedKeyId: nodeKeyIdSchema.parse("key-worker-3"),
    reason: "compromised laptop",
    revokedBy: "operator-1",
    revokedAt: at(10),
    ...overrides,
  }
}

export interface NodeOverrides {
  readonly nodeId?: NodeId
  readonly displayName?: string
  readonly enrolledAt?: number
  /** `null` for a node that has never heartbeated; omitted keeps the default. */
  readonly capability?: Record<string, unknown> | null
  readonly revocation?: Record<string, unknown> | null
  readonly liveness?: "live" | "stale" | "revoked" | "never-seen"
  readonly lastHeartbeatAt?: string | null
  readonly ageMs?: number | null
  readonly negotiatedProtocolVersion?: number | null
}

/**
 * One `RegisteredNode`, the shape M4.3's `NodeRegistry.node` returns.
 *
 * The `liveness` / `ageMs` / `negotiatedProtocolVersion` triple is supplied rather
 * than derived, because the TUI deliberately does not re-derive any of them: they
 * are M4.3's answers at the registry's clock, and a fixture that computed them
 * here would be a second liveness rule in a test helper. The `node` member is
 * still validated by the registry's own `nodeRecordSchema` through the snapshot
 * parser.
 */
export function aRegisteredNode(overrides: NodeOverrides = {}) {
  const nodeId = overrides.nodeId ?? WORKER_1
  const hasCapability = overrides.capability === undefined
  return {
    node: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      nodeId,
      meshId: MESH,
      nodeKeyId: nodeKeyIdSchema.parse(`key-${nodeId}`),
      // The id without its `node-` prefix, so a rendered row reads as a machine
      // name rather than as a doubly-prefixed id. A fixture that defaulted to the
      // raw id would make every rendered-line assertion in this directory carry
      // that noise.
      displayName: overrides.displayName ?? nodeId.replace(/^node-/, ""),
      enrolledAt: overrides.enrolledAt ?? at(0),
      capability: overrides.capability === null ? null : hasCapability ? capability() : overrides.capability!,
      revocation: overrides.revocation === null ? null : overrides.revocation === undefined ? null : overrides.revocation,
    },
    liveness: overrides.liveness ?? (overrides.capability === null ? "never-seen" : "live"),
    lastHeartbeatAt: overrides.lastHeartbeatAt === undefined ? iso(at(0)) : overrides.lastHeartbeatAt,
    ageMs: overrides.ageMs === undefined ? (overrides.capability === null ? null : 0) : overrides.ageMs,
    negotiatedProtocolVersion:
      overrides.negotiatedProtocolVersion === undefined
        ? overrides.capability === null
          ? null
          : CURRENT_MESH_PROTOCOL_VERSION
        : overrides.negotiatedProtocolVersion,
  }
}

/** A live, reachable, compatible node. The healthy baseline of every matrix row. */
export function aHealthyNode(overrides: NodeOverrides = {}): ReturnType<typeof aRegisteredNode> {
  return aRegisteredNode({ ...overrides, liveness: "live" })
}

/** A node that spoke and then went quiet past the heartbeat bound. */
export function aStaleNode(overrides: NodeOverrides = {}): ReturnType<typeof aRegisteredNode> {
  // The defaults go FIRST so an `ageMs` in `overrides` wins. Written the other
  // way round, a test that varied the age to check how it renders would silently
  // get 91 000 back and pass for the wrong reason.
  const ageMs = overrides.ageMs ?? 91_000
  return aRegisteredNode({
    liveness: "stale",
    lastHeartbeatAt: iso(at(0) - ageMs),
    ageMs,
    ...overrides,
  })
}

/** A revoked node. Its capabilities are irrelevant; the revocation is the fact. */
export function aRevokedNode(overrides: NodeOverrides = {}): ReturnType<typeof aRegisteredNode> {
  return aRegisteredNode({
    liveness: "revoked",
    revocation: revocation(),
    lastHeartbeatAt: iso(at(0) - 5_000),
    ageMs: 5_000,
    ...overrides,
  })
}

/** A node that has never reported anything. */
export function aNeverSeenNode(overrides: NodeOverrides = {}): ReturnType<typeof aRegisteredNode> {
  return aRegisteredNode({ capability: null, lastHeartbeatAt: null, ageMs: null, ...overrides })
}

/**
 * A node that IS talking and speaks no version in common.
 *
 * The distinction this fixture exists to prove: `reachable` is true and
 * `liveness` is `live`, so a view that reported it as "offline" would be wrong
 * about a machine that just answered.
 */
export function anIncompatibleNode(overrides: NodeOverrides = {}): ReturnType<typeof aRegisteredNode> {
  return aRegisteredNode({
    liveness: "live",
    capability: capability({
      offeredProtocolVersions: [CURRENT_MESH_PROTOCOL_VERSION + 9],
      negotiatedProtocolVersion: null,
    }),
    negotiatedProtocolVersion: null,
    ...overrides,
  })
}

// --- The lease -------------------------------------------------------------

export interface LeaseOverrides {
  readonly kind?: MeshTuiLeaseSnapshot["kind"]
  readonly leaseId?: string
  readonly controllerNodeId?: NodeId
  readonly epoch?: number
  readonly issuedAt?: string
  readonly expiresAt?: string
  readonly durationSeconds?: number
  readonly operation?: "claim" | "renew" | "release" | "takeover"
  readonly runId?: RunId
  readonly projectId?: ProjectId
  readonly predecessorLeaseId?: string | null
  readonly predecessorEpoch?: number | null
  readonly takeoverReason?: string | null
  readonly acknowledgedUnreconciledNodeIds?: readonly NodeId[]
  readonly unreconciledNodeIds?: readonly NodeId[]
  readonly recordedAt?: number
}

/**
 * A stored lease record, built through `leaseRecordSchema`.
 *
 * The fence fields default to the shapes a takeover needs (a predecessor, a
 * reason, an acknowledgement) and a plain claim sets them to `null`, because
 * `leaseRecordSchema`'s `superRefine` refuses a takeover missing any of the three
 * and refuses a NON-takeover carrying any of them. A fixture that defaulted them
 * one way would make a test fail for a reason that has nothing to do with the
 * guard under test.
 */
export function aLeaseRecord(overrides: LeaseOverrides = {}) {
  const kind = overrides.kind ?? "held"
  const operation = overrides.operation ?? (kind === "superseded" ? "takeover" : "claim")
  const isTakeover = operation === "takeover"
  // A takeover is the SECOND link in the chain, so its own epoch is 2 and it
  // names epoch 1 as the predecessor. Both are positive because `epochSchema` is
  // `z.number().int().positive()` — there is no epoch zero, and a fixture that
  // reached for one to mean "nothing before this" would be refused by the very
  // schema this directory is supposed to compose.
  const leaseId = leaseIdSchema.parse(overrides.leaseId ?? (isTakeover ? LEASE_2 : LEASE_1))
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    leaseId,
    projectId: overrides.projectId ?? PROJECT,
    runId: overrides.runId ?? RUN,
    controllerNodeId: overrides.controllerNodeId ?? (isTakeover ? WORKER_2 : LOCAL),
    epoch: overrides.epoch ?? (isTakeover ? 2 : 1),
    operation,
    issuedAt: overrides.issuedAt ?? iso(at(0)),
    expiresAt: overrides.expiresAt ?? iso(at(30)),
    durationSeconds: overrides.durationSeconds ?? 30,
    predecessorLeaseId: isTakeover ? leaseIdSchema.parse(overrides.predecessorLeaseId ?? LEASE_1) : null,
    predecessorEpoch: isTakeover ? (overrides.predecessorEpoch ?? 1) : null,
    takeoverReason: isTakeover ? (overrides.takeoverReason ?? "operator moved control after inspecting the degraded nodes") : null,
    acknowledgedUnreconciledNodeIds: isTakeover ? [...(overrides.acknowledgedUnreconciledNodeIds ?? [])] : [],
    unreconciledNodeIds: [...(overrides.unreconciledNodeIds ?? [])],
    recordedAt: overrides.recordedAt ?? at(0),
  }
}

/**
 * The lease member of a snapshot.
 *
 * `permitsNewWork` is stated on the type as a literal, and it is not derived here
 * from `expiresAt` — M4.4's `permitsNewWork` owns that question, and the view
 * shows the answer rather than re-deriving it. Building the member directly keeps
 * the fixture from acquiring a second expiry rule.
 */
export function aLeaseSnapshot(overrides: LeaseOverrides = {}): MeshTuiLeaseSnapshot {
  const kind = overrides.kind ?? "held"
  if (kind === "absent") return { kind: "absent" }
  const record = aLeaseRecord({ ...overrides, kind })
  if (kind === "held") return { kind: "held", record, permitsNewWork: true } as MeshTuiLeaseSnapshot
  if (kind === "expired") return { kind: "expired", record, permitsNewWork: false } as MeshTuiLeaseSnapshot
  return { kind: "superseded", record, permitsNewWork: false } as MeshTuiLeaseSnapshot
}

// --- Sessions --------------------------------------------------------------

export function aRemoteSession(overrides: Record<string, unknown> = {}): Session {
  return sessionSchema.parse({
    schemaVersion: 1,
    sessionId: "session-1",
    projectId: PROJECT,
    runId: RUN,
    taskId: taskIdSchema.parse("task-1"),
    dispatchId: dispatchIdSchema.parse("dispatch-1"),
    nodeId: WORKER_1,
    installationId: "install-1",
    runtimeKind: "opencode",
    lifecycleState: "running",
    observedState: "working",
    ...overrides,
  })
}

export function aTerminalSnapshot(overrides: Partial<MeshTuiTerminalSnapshot> = {}): MeshTuiTerminalSnapshot {
  return {
    terminalId: "terminal-1" as MeshTuiTerminalSnapshot["terminalId"],
    sessionId: "session-1" as MeshTuiTerminalSnapshot["sessionId"],
    nodeId: WORKER_1,
    viewerCount: 1,
    inputOwnerClientId: null,
    lossy: false,
    ...overrides,
  }
}

export function aSessionSnapshot(overrides: Partial<MeshRemoteSessionSnapshot> = {}): MeshRemoteSessionSnapshot {
  return {
    session: aRemoteSession(),
    launchOutcome: null,
    terminal: null,
    ...overrides,
  }
}

// --- Reconciliation --------------------------------------------------------

export function anUnreconciledEntry(overrides: Partial<UnreconciledEntry> = {}): UnreconciledEntry {
  return {
    nodeId: WORKER_2,
    reason: "session_not_in_projection" as const,
    detail:
      "Peer reports session 'session-remote-1' for dispatch 'dispatch-remote-1', and this node's dispatch projections record no session for that dispatch. A running session with no recorded dispatch is either a partition that lost the proposal or work this node did not authorise; reconciliation marks it for review and does not resolve it.",
    ...overrides,
  }
}

// --- The outbox ------------------------------------------------------------

/**
 * An outbox row at M4.5's own attempt threshold, i.e. one M4.5 made terminal.
 *
 * `attempts` comes from `MESH_OUTBOX_MAX_ATTEMPTS` rather than from a literal
 * written here, and the view model decides "poison" with the same
 * `exceedsMaxAttempts`. That is the whole reason the fixture can be trusted to
 * produce a poisoned row: a hard-coded `8` in a fixture would keep producing one
 * after somebody raised the policy, and the degraded view would then report a
 * retrying row as terminal.
 */
export function aPoisonedOutboxRow(overrides: Partial<MeshTuiOutboxRow> = {}): MeshTuiOutboxRow {
  return {
    outboxId: "outbox-evt-1",
    status: "failed",
    attempts: MESH_OUTBOX_MAX_ATTEMPTS,
    destination: LOCAL,
    lastError: "peer refused: no_common_version",
    ...overrides,
  }
}

/** A row still inside the threshold. Not poison, and must not be shown as such. */
export function aRetryingOutboxRow(overrides: Partial<MeshTuiOutboxRow> = {}): MeshTuiOutboxRow {
  return {
    outboxId: "outbox-evt-2",
    status: "pending",
    attempts: 1,
    destination: LOCAL,
    ...overrides,
  }
}

// --- The snapshot ----------------------------------------------------------

export interface SnapshotOverrides {
  readonly lease?: MeshTuiLeaseSnapshot
  readonly leaseKind?: MeshTuiLeaseSnapshot["kind"]
  readonly network?: MeshTuiNetworkState
  readonly nodes?: ReturnType<typeof aRegisteredNode>[]
  readonly sessions?: readonly MeshRemoteSessionSnapshot[]
  /**
   * Reconciliation differences, typed as the protocol's own `UnreconciledEntry`
   * rather than as the return type of one fixture. The narrow version inferred
   * from a single `reason` literal made a test that used two different reasons
   * un-typeable, which is the wrong pressure to put on a test.
   */
  readonly unreconciled?: readonly UnreconciledEntry[]
  readonly outbox?: readonly MeshTuiOutboxRow[]
  readonly localNodeId?: NodeId
  readonly runId?: RunId
}

/**
 * A snapshot, PARSED.
 *
 * The parse is not decoration: it is what proves the fixtures build records the
 * mesh's own schemas accept, and it means every test in this directory exercises
 * the same validation production would.
 */
export function aSnapshot(overrides: SnapshotOverrides = {}): MeshTuiSnapshot {
  const runId = overrides.runId ?? RUN
  const parsed = parseMeshTuiSnapshot({
    meshId: MESH,
    localNodeId: overrides.localNodeId ?? LOCAL,
    scope: { projectId: PROJECT, runId },
    lease: overrides.lease ?? aLeaseSnapshot({ kind: overrides.leaseKind ?? "held", runId }),
    network: overrides.network ?? "up",
    nodes: overrides.nodes ?? [aHealthyNode({ nodeId: LOCAL }), aHealthyNode({ nodeId: WORKER_1 })],
    sessions: overrides.sessions ?? [],
    unreconciled: overrides.unreconciled ?? [],
    outbox: overrides.outbox ?? [],
  })
  if (!parsed.ok) throw new Error(`fixture snapshot was refused: ${parsed.error.code} — ${parsed.error.message}`)
  return parsed.value
}

export { MESH_TUI_LEASE_STANDINGS, MESH_TUI_NETWORK_STATES }

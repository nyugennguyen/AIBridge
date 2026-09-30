/**
 * M4.3 — node registry and capabilities.
 *
 * The seam M4.4 (controller lease), M4.6 (SSE), M4.7 (terminal WebSocket) and M4.8
 * (TUI) consume. Five things a consumer must know before importing anything from
 * here:
 *
 *   1. **`NodeRegistry` is the read/ingest seam, and it is not an authority.**
 *      `canScheduleOn` is a CANDIDATE FILTER. The `dispatchEnvelope`'s
 *      `permissionEnvelope`, the project path allowlist, and the recorded approval
 *      are the authorities, and a verdict carries `authorizes: false` on every
 *      member so a caller cannot read a pass as a grant. See `./capability.js`.
 *   2. **A heartbeat is a claim, and it authenticates nothing.** `recordHeartbeat`
 *      stores what a node said about itself and derives liveness from it against an
 *      injected clock. It never enrolls a node, never revokes one, and never
 *      accepts a node that has no enrollment row.
 *   3. **Nothing in this directory reads a clock.** Every time value arrives through
 *      an injected `now`, which is what makes "ninety-one seconds after the last
 *      heartbeat" a test rather than a `setTimeout`.
 *   4. **`NodeRegistryStore` is a separate port from `NodeRegistry` on purpose.**
 *      Enrollment is written through the store (M4.2's accepted enrollment
 *      response is the only path that makes a node addressable) and the durable
 *      store has to be exercisable directly, because "the revocation and its key
 *      index are one write" is a tested property or it is a comment.
 *   5. **No member anywhere in this directory can express a cross-agent dependency
 *      or a task's retry eligibility** (Milestone 3 R5 and R6). That is a property
 *      of the shapes, not a convention, and
 *      `tests/unit/mesh/registry/no-scheduling-edges.test.ts` asserts it against the
 *      Zod shapes and against the physical SQLite columns.
 *
 * Purity: only `./sqlite-registry.js` and `./migrations.js` touch storage, and both
 * take a `SqliteDriver` by injection rather than opening one. Tailscale
 * reachability is not an identity input anywhere here, and a heartbeat is not
 * authentication.
 */

export {
  NODE_LIVENESS_STATES,
  nodeLivenessSchema,
  capabilitySnapshotSchema,
  registryRevocationSchema,
  nodeRecordSchema,
  parseNodeRecord,
  unreadableNodeRecord,
  type NodeLiveness,
  type CapabilitySnapshot,
  type NodeRecord,
  type RegisteredNode,
  type RegistryRevocation,
} from "./schemas.js"

export {
  CAPABILITY_VERDICT_REFUSALS,
  capabilityRequestSchema,
  canScheduleOn,
  selectCandidates,
  defaultNodeCandidateSelector,
  type CapabilityAuthority,
  type CapabilityRequest,
  type CapabilityShortfall,
  type CapabilityVerdict,
  type CapabilityVerdictRefusal,
  type NodeCandidate,
  type NodeCandidateSelector,
} from "./capability.js"

export {
  type HeartbeatIngestResult,
  type HeartbeatWrite,
  type HeartbeatWriteOutcome,
  type NodeEnrollmentInput,
  type NodeEnrollmentOutcome,
  type NodeRegistry,
  type NodeRegistryDependencies,
  type NodeRegistryStore,
  type SequenceGap,
} from "./types.js"

export { MeshNodeRegistry, deriveLiveness } from "./registry.js"

export { InMemoryNodeRegistryStore } from "./memory-registry.js"

export { SqliteNodeRegistryStore } from "./sqlite-registry.js"

export { readHeartbeatGaps } from "./gaps.js"

export {
  CURRENT_REGISTRY_DATABASE_VERSION,
  MESH_REGISTRY_MIGRATIONS,
  MESH_REGISTRY_MIGRATIONS_TABLE_SQL,
  MESH_REGISTRY_INITIAL_SCHEMA_SQL,
  REQUIRED_MESH_REGISTRY_OBJECTS,
  CAS_UPDATE_HEARTBEAT_SQL,
  SELECT_NODE_SQL,
  SELECT_NODE_BY_ID_SQL,
  SELECT_NODES_BY_MESH_SQL,
  SELECT_REVOCATION_BY_KEY_SQL,
  SELECT_REVOCATION_BY_NODE_SQL,
  SELECT_HEARTBEAT_GAPS_SQL,
  runMeshRegistryMigrations,
  verifyMeshRegistrySchema,
  getRegistrySchemaVersion,
  type Migration,
  type MigrationResult,
  type RunMeshRegistryMigrationsOptions,
  type MeshRegistryNodeRow,
  type MeshRegistryRevocationRow,
  type MeshRegistryHeartbeatGapRow,
} from "./migrations.js"

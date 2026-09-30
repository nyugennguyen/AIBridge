/**
 * M4.4 — controller lease and epoch enforcement.
 *
 * The seam M4.5 (durable command inbox/event outbox), M4.6 (SSE gateway and
 * reconciliation), M4.7 (terminal WebSocket) and M4.8 (TUI mesh and takeover UX)
 * consume. Six things a consumer must know before importing anything from here:
 *
 *   1. **`ControllerLease` is the lease seam; `ControllerLeaseStore` is the write
 *      port underneath it.** They are separate for the same reason the registry's
 *      are: the durable store has to be exercisable on its own, because "two
 *      controllers racing to take over, exactly one wins" is a tested property of
 *      the transaction or it is a comment about it.
 *   2. **`MeshCommandEpochGate.authorize` is the ONLY place a `mesh.command` is
 *      decided admissible, and it does not persist.** It answers; M4.5's inbox
 *      writes. That separation is what makes "a refused command is not stored for
 *      later" a property of the control flow rather than of a rollback.
 *   3. **`takeover` is the only operation that may raise the epoch, and it needs
 *      something to raise it from.** Not a policy preference — a surface fact.
 *      `claim`, `renew` and `release` are methods on `ControllerLease`, and none of
 *      them can reach a higher epoch, because `evaluateLease` refuses one and the
 *      store's compare-and-set refuses it again on the way to disk. A takeover is
 *      additionally refused against a run this node holds no lease for, which is
 *      STRICTER than the protocol evaluator and was added because the split-brain
 *      model test reached a two-controller mesh through that gap (see `./lease.js`).
 *      There is no election, no quorum, no gossip and no consensus anywhere in this
 *      directory, and `tests/unit/mesh/lease/takeover.test.ts` asserts the absence
 *      structurally.
 *   4. **`COMMAND_MATRIX` is the single source of allowed states.** The gate calls
 *      `validateCommandStateByType` and nothing else decides states. The one rule
 *      added here is a COMPLETENESS rule — a recorded state the matrix constrains
 *      must be supplied — and `requiredRecordedStateEntities` derives which arms
 *      those are from the matrix's own row rather than from a list kept here.
 *   5. **Nothing here reads a clock.** Every time value arrives through an
 *      injected `now`, which is what makes "ten minutes after the renewal stopped"
 *      a number rather than a sleep.
 *   6. **No member in this directory can express a session transition.** Expiry
 *      stops NEW work and leaves every running agent untouched; the plan guardrail
 *      is "do not terminate agents because a controller or network disappeared",
 *      and the way that is enforced here is that there is no field, no code and no
 *      reason string a caller could read as "stop the sessions".
 *      `tests/unit/mesh/lease/expiry.test.ts` asserts that as an absence, and
 *      asserts a partition leaves the live-session inventory byte-identical.
 *
 * Purity: only `./sqlite-lease-store.js` and `./migrations.js` touch storage, and
 * both take a `SqliteDriver` by injection rather than opening one, so the
 * durability the tests exercise is the durability production runs on.
 */

export {
  leaseRecordSchema,
  leaseHistoryEntrySchema,
  parseLeaseRecord,
  unreadableLeaseRecord,
  heldLeaseOf,
  type LeaseHistoryEntry,
  type LeaseRecord,
  type LeaseScope,
} from "./schemas.js"

export {
  COMMAND_GATE_REFUSALS,
  COMMAND_GATE_STAGES,
  type CommandAdmission,
  type CommandEpochGate,
  type CommandEpochGateDependencies,
  type CommandGateOutcome,
  type CommandGateRefusal,
  type CommandGateStage,
  type CommandMatrixDecision,
  type CommandRefusal,
  type ControllerLease,
  type ControllerLeaseDependencies,
  type ControllerLeaseStore,
  type LeaseOperationAccepted,
  type LeaseOperationOutcome,
  type LeaseOperationRefused,
  type LeaseOperationWriteLost,
  type LeaseWrite,
  type LeaseWriteOutcome,
  type NewWorkPermit,
  type RecordedCommandStateResolver,
  type UnreconciledNodeSource,
} from "./types.js"

export {
  MeshControllerLease,
  InMemoryUnreconciledNodeSource,
  createEmptyUnreconciledNodeSource,
  createUnreconciledNodeSource,
} from "./lease.js"

export { InMemoryControllerLeaseStore } from "./memory-lease-store.js"

export { SqliteControllerLeaseStore } from "./sqlite-lease-store.js"

export { MeshCommandEpochGate, requiredRecordedStateEntities } from "./command-gate.js"

export {
  CURRENT_LEASE_DATABASE_VERSION,
  MESH_LEASE_INITIAL_SCHEMA_SQL,
  MESH_LEASE_MIGRATIONS,
  MESH_LEASE_MIGRATIONS_TABLE_SQL,
  REQUIRED_MESH_LEASE_OBJECTS,
  CAS_UPSERT_ACTIVE_LEASE_SQL,
  INSERT_LEASE_HISTORY_SQL,
  SELECT_ACTIVE_LEASE_SQL,
  SELECT_LEASE_HISTORY_SQL,
  runMeshLeaseMigrations,
  verifyMeshLeaseSchema,
  getLeaseSchemaVersion,
  type Migration,
  type MigrationResult,
  type RunMeshLeaseMigrationsOptions,
  type MeshLeaseActiveRow,
  type MeshLeaseHistoryRow,
} from "./migrations.js"

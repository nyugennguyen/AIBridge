/**
 * M4.5 — the worker's durable command inbox.
 *
 * The seam M4.6 (SSE gateway and reconciliation), M4.8 (TUI) and M4.9 (the
 * two-node fault harness) consume. Five things a consumer must know before
 * importing anything from here:
 *
 *   1. **`MeshCommandInbox` is the ingest seam; `CommandInboxStore` is the write
 *      port underneath it.** Separate for the same reason the registry's and the
 *      lease's are: "a refused command leaves the table byte-identical" is a
 *      statement about a control flow, and the only way to show it is to look at
 *      the thing a write would have changed.
 *   2. **The gate order is fixed and load-bearing.** Authenticate (M4.2) → gate
 *      (M4.4) → dedupe/digest → recorded-log authorization → persist → ack.
 *      Dedupe comes BEFORE authorization because a duplicate is the same
 *      instruction and re-authorizing one consults a projection that has
 *      legitimately moved on. The dedupe decision itself is
 *      `decideCommandReceipt` from `../protocol/ack.js` and is NOT restated here:
 *      it keys on the SEMANTIC fingerprint from `fingerprintCommand`, never the
 *      wire `payloadDigest`, which covers `issuedAt`/`expiresAt` and would answer
 *      every legitimate retry with a conflict. See `./inbox.ts`.
 *   3. **Authorization resolves against `RecordedLogReader`, never the payload.**
 *      This is the plan's guardrail quoted verbatim, and it is enforced by the
 *      port's SHAPE: the only thing a payload contributes is ids to look up.
 *      `tests/unit/mesh/inbox/inbox-authorization.test.ts` submits a
 *      self-consistent payload claiming a live approval the log does not hold and
 *      asserts refusal with nothing persisted.
 *   3a. **Authentication is a STAGE, not a caller-side precondition.** It runs
 *      first, and the authenticated `nodeId` is compared against the controller
 *      the command names, so the step contributes something a reader can check
 *      rather than being a line in a doc comment. See `./types.ts`.
 *   4. **R4 is closed, and not by editing the kernel.** An ambiguous launch is a
 *      WORKER fact with a durable home: `InboxEffectState`'s `runtime_accepted`,
 *      stamped at `EffectBoundary.afterRuntimeAccept`. The kernel's
 *      `ProjectionLaunchAdmission` is deliberately unchanged because
 *      `src/orchestration/schemas.ts` is inside the M0 contract digest and because
 *      the ambiguity is not a controller event. Read `./launch-outcome.ts` before
 *      changing anything here; the full argument is in it.
 *   5. **Nothing in this directory reads a clock.** Every time value arrives
 *      through an injected `now`, which is what makes "the worker restarted while a
 *      launch was in flight" a number rather than a sleep.
 *
 * Purity: only `./sqlite-inbox-store.ts` and `./migrations.ts` touch storage, and
 * both take a `SqliteDriver` by injection rather than opening one — so the
 * durability the tests exercise is the durability production runs on.
 */

export {
  inboxRowSchema,
  parseInboxRow,
  unreadableInboxRow,
  rowToValue,
  type StoredInboxRow,
  type MeshInboxRowShape,
} from "./schemas.js"

export {
  APPROVAL_CREATING_COMMAND_TYPES,
  DISPATCH_CREATING_COMMAND_TYPES,
  approvalIsCreatedBy,
  authorizeAgainstRecordedLog,
  dispatchIsCreatedBy,
  type AuthorizationPointers,
  type RecordedApproval,
  type RecordedAuthorization,
  type RecordedDispatch,
  type RecordedLease,
  type RecordedLogReader,
} from "./authorization.js"

export {
  INBOX_EFFECT_STATES,
  INBOX_REFUSAL_STAGES,
  type AuthenticatedPeer,
  type CommandAckEmitter,
  type CommandInbox,
  type CommandInboxDependencies,
  type CommandInboxOutcome,
  type CommandInboxStore,
  type GateOutcomeLike,
  type InboxEffectState,
  type InboxRow,
  type InboxRowFilter,
  type InboxScope,
  type InboxWriteOutcome,
  type MeshInboxAuthenticator,
  type NewInboxRow,
} from "./types.js"

export { MeshCommandInbox, storedResultOf } from "./inbox.js"

export {
  CURRENT_LAUNCH_OUTCOME_VERSION,
  LAUNCH_OUTCOME_VERSIONS,
  MESH_LAUNCH_OUTCOMES,
  canReadLaunchOutcomeVersion,
  deriveLaunchOutcome,
  explainKernelLaunchAdmissionGap,
  launchOutcomeNeedsAttention,
  unknownLaunchOutcomeVersion,
  type LaunchOutcomeDetail,
  type LaunchOutcomeVersion,
  type MeshLaunchOutcome,
  type RecordedLaunchObservation,
} from "./launch-outcome.js"

export { InMemoryCommandInboxStore } from "./memory-inbox-store.js"

export { SqliteCommandInboxStore, describeInboxStoreError, inboxStoreUnavailable } from "./sqlite-inbox-store.js"

export {
  CURRENT_INBOX_DATABASE_VERSION,
  MESH_INBOX_INITIAL_SCHEMA_SQL,
  MESH_INBOX_RECORD_VERSION_COLUMN_SQL,
  MESH_INBOX_MIGRATIONS,
  MESH_INBOX_MIGRATIONS_TABLE_SQL,
  REQUIRED_MESH_INBOX_OBJECTS,
  INSERT_INBOX_ROW_SQL,
  MARK_ACK_EMITTED_SQL,
  MARK_RUNTIME_ACCEPTED_SQL,
  RECORD_INBOX_RESULT_SQL,
  SELECT_INBOX_ROW_SQL,
  SELECT_INBOX_ROWS_BY_RUN_SQL,
  SELECT_NEXT_ACCEPTED_SEQUENCE_SQL,
  runMeshInboxMigrations,
  verifyMeshInboxSchema,
  getInboxSchemaVersion,
  assertInboxMigrationHistoryIsContiguous,
  assertInboxSchemaObjectsPresent,
  type Migration,
  type MigrationResult,
  type RunMeshInboxMigrationsOptions,
} from "./migrations.js"

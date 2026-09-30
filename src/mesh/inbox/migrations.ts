import type { SqliteDriver } from "../../orchestration/event-store/sqlite-driver.js"
import {
  DestructiveMigrationNotPermittedError,
  FailedMigrationError,
  IncompleteMigrationHistoryError,
  IncompleteSchemaError,
  UnsupportedDatabaseVersionError,
} from "../../orchestration/event-store/errors.js"

/**
 * The inbox store's own storage layout and its own version axis.
 *
 * Copied structurally from `src/mesh/lease/migrations.ts` and `registry`, for the
 * same three reasons that file gives, and the same one thing NOT copied:
 *
 *   1. **A separate migration table (`mesh_inbox_migrations`).** The lease's
 *      answers "what is the lease layout", this one answers "what is the inbox
 *      layout". Protocol spec §3 is explicit that the database version is a third
 *      axis from the record version; folding three of them into one counter would
 *      make an inbox migration silently advance the kernel's schema version.
 *   2. **The event store's error classes**, so "this database is newer than this
 *      binary" is one vocabulary across all three storage seams.
 *   3. **An injected `now`** for the journal stamp, for the same reason: a test
 *      that cannot choose the timestamp cannot assert it.
 *
 * There is no "join" pairing to copy from the registry or split from the lease —
 * one admitted command is one fact — so `mesh_inbox_commands` is a single table.
 */

/** The inbox storage-layout version. Independent of the record schema version. */
export const CURRENT_INBOX_DATABASE_VERSION = 2

export const MESH_INBOX_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS mesh_inbox_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  name TEXT NOT NULL
);
`

/**
 * One admitted `mesh.command`.
 *
 * `command_id` is the PRIMARY KEY and nothing else is unique. That is the whole
 * dedupe invariant expressed as a storage fact: there can be at most ONE row per
 * command id, so a second arrival converges rather than appending, and "no second
 * session, no second prompt" stops depending on a caller remembering to check.
 *
 * `semantic_fingerprint` is indexed NOT because it is queried by digest — it never
 * is — but so an operator can answer "which other commands carry this exact
 * payload?" after a conflict. A conflict names two digests and a reader needs
 * somewhere to go with them.
 *
 * `accepted_sequence` is monotonic and gapless per database, assigned in the same
 * statement as the insert. It is NOT `AUTOINCREMENT`: an accepted command that
 * rolled back must not burn a sequence, because the sequence IS the ack order and
 * an ack emitted for a row that does not exist is an ack about nothing.
 *
 * There is NO `acknowledged_at` and no status enum. The presence of the row IS
 * the acknowledgement that the command was accepted; a separate "acked" flag would
 * have to be kept in step with the row's existence and could disagree with it.
 */
export const MESH_INBOX_INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mesh_inbox_commands (
  command_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  dispatch_id TEXT,
  target_node_id TEXT NOT NULL,
  controller_node_id TEXT NOT NULL,
  controller_epoch INTEGER NOT NULL,
  lease_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  command_json TEXT NOT NULL,
  effect_state TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  accepted_sequence INTEGER NOT NULL,
  runtime_accepted_at INTEGER,
  result_json TEXT,
  ack_emitted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mesh_inbox_run ON mesh_inbox_commands(project_id, run_id, accepted_sequence ASC);
CREATE INDEX IF NOT EXISTS idx_mesh_inbox_fingerprint ON mesh_inbox_commands(semantic_fingerprint);
CREATE INDEX IF NOT EXISTS idx_mesh_inbox_dispatch ON mesh_inbox_commands(dispatch_id);
`

/**
 * v2 — the record-version column the first layout was missing.
 *
 * The v1 table stored a row whose `InboxRow` carries `schemaVersion` (M4-V: a
 * PERSISTED record is versioned, not only a wire one) and no column to hold it,
 * so `rowToValue` read `row.schema_version` and got `undefined`. Every read
 * therefore failed `inboxRowSchema` and the durable store answered
 * `inbox.record_unreadable` for every row it had itself written — an in-memory
 * pass and a durable fail on identical input.
 *
 * Recorded as an additive migration rather than folded into the v1 DDL because
 * `CREATE TABLE IF NOT EXISTS` means an edited v1 leaves an already-migrated
 * database on the broken layout forever, with a journal claiming v1 is current.
 * The lesson is the same one the event store's v2 migration states, and it is
 * why a layout this codebase does not yet ship still migrates rather than
 * edits.
 */
export const MESH_INBOX_RECORD_VERSION_COLUMN_SQL = `
ALTER TABLE mesh_inbox_commands ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 2;
`

/**
 * The objects a complete inbox database must contain.
 *
 * Checked after every migration run rather than trusted, for the registry's
 * reason: a migration that "succeeded" against a database that already had the
 * objects is a migration that was never applied, and the failure has to surface
 * here rather than as a missing-column error in production.
 */
export const REQUIRED_MESH_INBOX_OBJECTS: readonly { readonly type: string; readonly name: string }[] = Object.freeze([
  { type: "table", name: "mesh_inbox_commands" },
  { type: "index", name: "idx_mesh_inbox_run" },
  { type: "index", name: "idx_mesh_inbox_fingerprint" },
  { type: "index", name: "idx_mesh_inbox_dispatch" },
])

export interface Migration {
  readonly version: number
  readonly name: string
  readonly destructive: boolean
  up(driver: SqliteDriver): void
}

export interface MigrationResult {
  readonly appliedCount: number
  readonly currentVersion: number
}

export interface RunMeshInboxMigrationsOptions {
  readonly targetVersion?: number
  readonly allowDestructive?: boolean
  /** The clock, for the journal's `applied_at` and nothing else. */
  readonly now: () => number
}

export const MESH_INBOX_MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: "initial_inbox_schema",
    destructive: false,
    up(driver: SqliteDriver): void {
      driver.exec(MESH_INBOX_INITIAL_SCHEMA_SQL)
    },
  }),
  Object.freeze({
    version: 2,
    name: "inbox_record_version_column",
    destructive: false,
    up(driver: SqliteDriver): void {
      driver.exec(MESH_INBOX_RECORD_VERSION_COLUMN_SQL)
    },
  }),
])

function ensureMigrationsTable(driver: SqliteDriver): void {
  driver.exec(MESH_INBOX_MIGRATIONS_TABLE_SQL)
}

export function getInboxSchemaVersion(driver: SqliteDriver): number {
  ensureMigrationsTable(driver)
  const row = driver.get<{ max_version: number | null }>("SELECT MAX(version) as max_version FROM mesh_inbox_migrations")
  return row?.max_version ?? 0
}

function readAppliedVersions(driver: SqliteDriver): number[] {
  return driver
    .all<{ version: number }>("SELECT version FROM mesh_inbox_migrations ORDER BY version ASC")
    .map((row) => row.version)
}

export function assertInboxMigrationHistoryIsContiguous(
  driver: SqliteDriver,
  maxKnownVersion: number = CURRENT_INBOX_DATABASE_VERSION,
): void {
  ensureMigrationsTable(driver)
  const applied = readAppliedVersions(driver)
  if (applied.length === 0) return
  const maxApplied = applied[applied.length - 1]
  const missing: number[] = []
  for (let version = 1; version <= maxApplied; version += 1) {
    if (!applied.includes(version)) missing.push(version)
  }
  if (missing.length > 0) throw new IncompleteMigrationHistoryError(maxApplied, missing)
  const unknown = applied.filter((version) => version > maxKnownVersion)
  if (unknown.length > 0) throw new UnsupportedDatabaseVersionError(Math.max(...unknown), maxKnownVersion)
}

export function assertInboxSchemaObjectsPresent(
  driver: SqliteDriver,
  expectedVersion: number = CURRENT_INBOX_DATABASE_VERSION,
): void {
  if (expectedVersion < 1) return
  const missing: { type: string, name: string }[] = []
  for (const object of REQUIRED_MESH_INBOX_OBJECTS) {
    const row = driver.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", object.type, object.name)
    if (!row) missing.push(object)
  }
  if (missing.length > 0) throw new IncompleteSchemaError(missing)
}

/**
 * Applies pending inbox migrations.
 *
 * DDL and the bookkeeping row go in ONE transaction, as in the event store's, the
 * registry's and the lease's: a crash mid-migration must not leave the schema and
 * the journal disagreeing. The lesson was paid once in this codebase and the shape
 * is worth copying rather than reinventing per storage seam.
 */
export function runMeshInboxMigrations(driver: SqliteDriver, options: RunMeshInboxMigrationsOptions): MigrationResult {
  const targetVersion = options.targetVersion ?? CURRENT_INBOX_DATABASE_VERSION

  ensureMigrationsTable(driver)

  const currentVersion = getInboxSchemaVersion(driver)
  if (currentVersion > targetVersion) {
    // Fail closed rather than downgrade. An inbox row written by a newer build may
    // carry an `effect_state` this build cannot interpret, and misreading that is
    // deciding whether a redelivered command re-runs its effect.
    throw new UnsupportedDatabaseVersionError(currentVersion, targetVersion)
  }

  assertInboxMigrationHistoryIsContiguous(driver, targetVersion)

  const appliedSet = new Set(readAppliedVersions(driver))
  const pending = MESH_INBOX_MIGRATIONS.filter(
    (migration) => migration.version <= targetVersion && !appliedSet.has(migration.version),
  ).sort((a, b) => a.version - b.version)

  const destructive = pending.filter((migration) => migration.destructive)
  if (destructive.length > 0 && !options.allowDestructive) {
    const first = destructive[0]
    throw new DestructiveMigrationNotPermittedError(first.version, first.name)
  }

  if (pending.length === 0) {
    assertInboxSchemaObjectsPresent(driver, targetVersion)
    return { appliedCount: 0, currentVersion }
  }

  const appliedAt = new Date(options.now()).toISOString()
  driver.transaction(() => {
    for (const migration of pending) {
      try {
        migration.up(driver)
      } catch (cause) {
        throw new FailedMigrationError(migration.version, migration.name, cause)
      }
      driver.run(
        "INSERT INTO mesh_inbox_migrations (version, applied_at, name) VALUES (?, ?, ?)",
        migration.version,
        appliedAt,
        migration.name,
      )
    }
  })

  assertInboxSchemaObjectsPresent(driver, targetVersion)
  return { appliedCount: pending.length, currentVersion: getInboxSchemaVersion(driver) }
}

export function verifyMeshInboxSchema(
  driver: SqliteDriver,
  expectedVersion: number = CURRENT_INBOX_DATABASE_VERSION,
): void {
  const currentVersion = getInboxSchemaVersion(driver)
  if (currentVersion > expectedVersion) throw new UnsupportedDatabaseVersionError(currentVersion, expectedVersion)
  assertInboxMigrationHistoryIsContiguous(driver, expectedVersion)
  assertInboxSchemaObjectsPresent(driver, expectedVersion)
}

/**
 * The insert, with the convergence rule in the statement.
 *
 * `ON CONFLICT (command_id) DO NOTHING` and then a re-read, rather than a
 * `SELECT` followed by an `INSERT`. A check and a write that are not one statement
 * are two operations, and the gap between them is exactly where two redeliveries
 * of one command both observe "no row" and both insert. The re-read is inside the
 * same transaction, so it observes the winner's row or the absence of any, never a
 * torn middle.
 *
 * `accepted_sequence` is computed from `MAX(...) + 1` rather than from a
 * sequence table, in the SAME statement. SQLite serialises writers, so two
 * concurrent accepts cannot both read the same MAX and both write the same
 * sequence; and a rolled-back insert rolls back its sequence with it.
 */
export const INSERT_INBOX_ROW_SQL = `
INSERT INTO mesh_inbox_commands (
  command_id, project_id, run_id, dispatch_id, target_node_id, controller_node_id,
  controller_epoch, lease_id, command_type, payload_digest, semantic_fingerprint,
  command_json, effect_state, accepted_at, accepted_sequence, runtime_accepted_at,
  result_json, ack_emitted_at, schema_version
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_started', ?, ?, NULL, NULL, NULL, ?)
ON CONFLICT (command_id) DO NOTHING
`

/**
 * The next `accepted_sequence`, for `peekAcceptedSequence`.
 *
 * Exposed as SQL rather than as a method returning `MAX + 1` so a caller that
 * peeks and a store that assigns read the SAME expression. Two copies of "the next
 * sequence" is two definitions of the ack order.
 */
export const SELECT_NEXT_ACCEPTED_SEQUENCE_SQL = `
SELECT COALESCE(MAX(accepted_sequence), 0) + 1 AS next_sequence FROM mesh_inbox_commands
`

export const SELECT_INBOX_ROW_SQL = `
SELECT * FROM mesh_inbox_commands WHERE command_id = ?
`

export const SELECT_INBOX_ROWS_BY_RUN_SQL = `
SELECT * FROM mesh_inbox_commands
WHERE project_id = ? AND run_id = ?
ORDER BY accepted_sequence ASC
`

/**
 * The `runtime_accepted` transition, R4's durable ambiguous-launch marker.
 *
 * Guarded on `effect_state = 'not_started'` so the transition is idempotent: a
 * redelivery that reaches this write twice records the FIRST instant, not the
 * last. Which instant an ambiguous launch happened at is the only thing the state
 * is for, and an operator reading a later one would conclude the effect was
 * accepted after a redelivery that in fact re-accepted nothing.
 *
 * Written at `EffectBoundary.afterRuntimeAccept`, which is the crash window R4 is
 * about: after the peer took the effect and before the ack is committed.
 */
export const MARK_RUNTIME_ACCEPTED_SQL = `
UPDATE mesh_inbox_commands
   SET effect_state = 'runtime_accepted', runtime_accepted_at = ?
 WHERE command_id = ? AND effect_state = 'not_started'
`

export const RECORD_INBOX_RESULT_SQL = `
UPDATE mesh_inbox_commands
   SET effect_state = 'result_recorded', result_json = ?
 WHERE command_id = ? AND effect_state != 'result_recorded'
`

/**
 * The ack stamp.
 *
 * Guarded on `ack_emitted_at IS NULL` for the same reason the runtime-accept
 * transition is: the first ack is the one the controller is waiting for, and a
 * second emission overwrites the record of when the first went out. It is also the
 * structural statement of the ordering rule — this column can only be written
 * after `INSERT_INBOX_ROW_SQL` succeeded, because the row has to exist.
 */
export const MARK_ACK_EMITTED_SQL = `
UPDATE mesh_inbox_commands
   SET ack_emitted_at = ?
 WHERE command_id = ? AND ack_emitted_at IS NULL
`

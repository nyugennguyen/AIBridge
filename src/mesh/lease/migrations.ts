import type { SqliteDriver } from "../../orchestration/event-store/sqlite-driver.js"
import {
  DestructiveMigrationNotPermittedError,
  FailedMigrationError,
  IncompleteMigrationHistoryError,
  IncompleteSchemaError,
  UnsupportedDatabaseVersionError,
} from "../../orchestration/event-store/errors.js"
import type { Epoch, ProjectId, RunId } from "../../orchestration/identifiers.js"

/**
 * The lease store's own storage layout and its own version axis.
 *
 * Copied structurally from `src/mesh/registry/migrations.ts`, deliberately, and
 * the three choices that made there apply here for the same reasons:
 *
 *   1. **A SEPARATE migration table (`mesh_lease_migrations`).** The event store's
 *      `schema_migrations` answers "what is the kernel's layout"; this one answers
 *      "what is the lease layout". A shared counter would mean an M4.5 inbox
 *      migration silently advancing the lease's version and a lease rollback
 *      silently rewinding the kernel's. §3 of the protocol spec is explicit that
 *      the database version is a third axis which must not be conflated with the
 *      record version, and folding these into the kernel's `MIGRATIONS` was not
 *      available in any case — M4.4 may not edit `src/orchestration/`.
 *   2. **The event store's error classes.** One vocabulary for "this database is
 *      newer than this binary", across both storage seams.
 *   3. **A `now` injected rather than read.** The journal stamp is an operator's
 *      record of when a layout changed; a test that cannot choose it cannot assert
 *      it, and a module that reads a clock "for a timestamp" has already made the
 *      clock a dependency of everything under it.
 *
 * The one thing that is NOT copied is the registry's "one row, one fact" join for
 * revocations: there is no such pairing here. The active lease and the history
 * rows are genuinely different facts — one is the authority in force now, the
 * others are the audit trail of how it got there — so they are two tables, and
 * both are written in ONE transaction so the audit trail can never be missing the
 * record that is currently in force.
 */

/** The lease storage-layout version. Independent of the record schema version. */
export const CURRENT_LEASE_DATABASE_VERSION = 1

export const MESH_LEASE_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS mesh_lease_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  name TEXT NOT NULL
);
`

/**
 * The active lease, one row per run.
 *
 * `(project_id, run_id)` is the primary key, not `lease_id`, because the SCOPE of
 * a lease is a run and the invariant under test is that a run has at most one
 * authority in force. Keying on `lease_id` would allow two rows for one run and
 * move "at most one controller may create work for this run" from a database
 * constraint into a convention.
 *
 * There is no `liveness` or `expired` column, for the registry's reason: expiry is
 * DERIVED at read time against the injected clock. A stored `expired` flag needs a
 * sweeper, and a sweeper that stops running leaves every lease on the mesh
 * claiming to be live forever — the exact failure a lease TTL exists to prevent.
 */
export const MESH_LEASE_INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mesh_lease_active (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  controller_node_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  operation TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  predecessor_lease_id TEXT,
  predecessor_epoch INTEGER,
  takeover_reason TEXT,
  acknowledged_unreconciled_node_ids TEXT NOT NULL,
  unreconciled_node_ids TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  PRIMARY KEY (project_id, run_id)
);

CREATE TABLE IF NOT EXISTS mesh_lease_history (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  controller_node_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  operation TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  PRIMARY KEY (project_id, run_id, lease_id)
);

CREATE INDEX IF NOT EXISTS idx_mesh_lease_history_run ON mesh_lease_history(project_id, run_id, epoch ASC);
`

/**
 * The objects a complete lease database must contain.
 *
 * Checked after every migration run rather than trusted: a migration that
 * "succeeded" against a database that already had the objects is a migration that
 * was never applied, and the failure has to surface here rather than as a
 * missing-column error in production.
 */
export const REQUIRED_MESH_LEASE_OBJECTS: readonly { readonly type: string; readonly name: string }[] = Object.freeze([
  { type: "table", name: "mesh_lease_active" },
  { type: "table", name: "mesh_lease_history" },
  { type: "index", name: "idx_mesh_lease_history_run" },
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

export interface RunMeshLeaseMigrationsOptions {
  readonly targetVersion?: number
  readonly allowDestructive?: boolean
  /** The clock, for the journal's `applied_at` and nothing else. */
  readonly now: () => number
}

export const MESH_LEASE_MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: "initial_lease_schema",
    destructive: false,
    up(driver: SqliteDriver): void {
      driver.exec(MESH_LEASE_INITIAL_SCHEMA_SQL)
    },
  }),
])

function ensureMigrationsTable(driver: SqliteDriver): void {
  driver.exec(MESH_LEASE_MIGRATIONS_TABLE_SQL)
}

export function getLeaseSchemaVersion(driver: SqliteDriver): number {
  ensureMigrationsTable(driver)
  const row = driver.get<{ max_version: number | null }>("SELECT MAX(version) as max_version FROM mesh_lease_migrations")
  return row?.max_version ?? 0
}

function readAppliedVersions(driver: SqliteDriver): number[] {
  return driver
    .all<{ version: number }>("SELECT version FROM mesh_lease_migrations ORDER BY version ASC")
    .map((row) => row.version)
}

export function assertLeaseMigrationHistoryIsContiguous(
  driver: SqliteDriver,
  maxKnownVersion: number = CURRENT_LEASE_DATABASE_VERSION,
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

export function assertLeaseSchemaObjectsPresent(
  driver: SqliteDriver,
  expectedVersion: number = CURRENT_LEASE_DATABASE_VERSION,
): void {
  if (expectedVersion < 1) return
  const missing: { type: string, name: string }[] = []
  for (const object of REQUIRED_MESH_LEASE_OBJECTS) {
    const row = driver.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", object.type, object.name)
    if (!row) missing.push(object)
  }
  if (missing.length > 0) throw new IncompleteSchemaError(missing)
}

/**
 * Applies pending lease migrations.
 *
 * DDL and the bookkeeping row go in ONE transaction, as in the event store's and
 * the registry's runners: a crash mid-migration must not leave the schema and the
 * journal disagreeing, because the next start would then either re-apply a
 * migration that partly ran or skip one that ran. The lesson was paid for once in
 * this codebase and the shape is worth copying rather than reinventing.
 */
export function runMeshLeaseMigrations(driver: SqliteDriver, options: RunMeshLeaseMigrationsOptions): MigrationResult {
  const targetVersion = options.targetVersion ?? CURRENT_LEASE_DATABASE_VERSION

  ensureMigrationsTable(driver)

  const currentVersion = getLeaseSchemaVersion(driver)
  if (currentVersion > targetVersion) {
    // Fail closed rather than downgrade. A lease store written by a newer build
    // may hold epochs and takeover records this build would misread, and "misread"
    // here means "decide wrongly who may create work for a run".
    throw new UnsupportedDatabaseVersionError(currentVersion, targetVersion)
  }

  assertLeaseMigrationHistoryIsContiguous(driver, targetVersion)

  const appliedSet = new Set(readAppliedVersions(driver))
  const pending = MESH_LEASE_MIGRATIONS.filter(
    (migration) => migration.version <= targetVersion && !appliedSet.has(migration.version),
  ).sort((a, b) => a.version - b.version)

  const destructive = pending.filter((migration) => migration.destructive)
  if (destructive.length > 0 && !options.allowDestructive) {
    const first = destructive[0]
    throw new DestructiveMigrationNotPermittedError(first.version, first.name)
  }

  if (pending.length === 0) {
    assertLeaseSchemaObjectsPresent(driver, targetVersion)
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
        "INSERT INTO mesh_lease_migrations (version, applied_at, name) VALUES (?, ?, ?)",
        migration.version,
        appliedAt,
        migration.name,
      )
    }
  })

  assertLeaseSchemaObjectsPresent(driver, targetVersion)
  return { appliedCount: pending.length, currentVersion: getLeaseSchemaVersion(driver) }
}

export function verifyMeshLeaseSchema(
  driver: SqliteDriver,
  expectedVersion: number = CURRENT_LEASE_DATABASE_VERSION,
): void {
  const currentVersion = getLeaseSchemaVersion(driver)
  if (currentVersion > expectedVersion) throw new UnsupportedDatabaseVersionError(currentVersion, expectedVersion)
  assertLeaseMigrationHistoryIsContiguous(driver, expectedVersion)
  assertLeaseSchemaObjectsPresent(driver, expectedVersion)
}

/** The physical active-lease row, before it is re-validated into a `LeaseRecord`. */
export interface MeshLeaseActiveRow {
  project_id: string
  run_id: string
  lease_id: string
  controller_node_id: string
  epoch: number
  operation: string
  issued_at: string
  expires_at: string
  duration_seconds: number
  predecessor_lease_id: string | null
  predecessor_epoch: number | null
  takeover_reason: string | null
  acknowledged_unreconciled_node_ids: string
  unreconciled_node_ids: string
  recorded_at: number
  schema_version: number
}

export interface MeshLeaseHistoryRow {
  project_id: string
  run_id: string
  lease_id: string
  controller_node_id: string
  epoch: number
  operation: string
  issued_at: string
  expires_at: string
  recorded_at: number
  schema_version: number
}

export const SELECT_ACTIVE_LEASE_SQL = `
SELECT project_id, run_id, lease_id, controller_node_id, epoch, operation,
       issued_at, expires_at, duration_seconds, predecessor_lease_id, predecessor_epoch,
       takeover_reason, acknowledged_unreconciled_node_ids, unreconciled_node_ids,
       recorded_at, schema_version
FROM mesh_lease_active
WHERE project_id = ? AND run_id = ?
`

export const SELECT_LEASE_HISTORY_SQL = `
SELECT project_id, run_id, lease_id, controller_node_id, epoch, operation,
       issued_at, expires_at, recorded_at, schema_version
FROM mesh_lease_history
WHERE project_id = ? AND run_id = ?
ORDER BY recorded_at ASC, epoch ASC, lease_id ASC
`

/**
 * The compare-and-set a lease write goes through.
 *
 * The `WHERE mesh_lease_active.epoch IS ?` clause is the entire fencing
 * mechanism at the storage layer, and it is in the `ON CONFLICT ... DO UPDATE`
 * guard rather than in a preceding `SELECT` because a check and a write that are
 * not one statement are two operations, and the gap between them is where two
 * controllers taking over from the same epoch both observe a predecessor they can
 * each supersede.
 *
 * `IS ?` is SQLite's NULL-safe equality, bound twice on purpose: the first-ever
 * claim expects `NULL` because there is no row, and every later write goes through
 * the SAME statement. Two statements would mean two code paths, and the path for
 * "no previous lease" is the one nobody tests.
 *
 * `epoch` is also required to be strictly greater than the stored one for a
 * `takeover`, enforced by the caller's `evaluateEpochMonotonicity` — not here,
 * because a renewal and an expired-claim legitimately write the SAME epoch, and a
 * storage-level `epoch >` would refuse the renewal path.
 */
export const CAS_UPSERT_ACTIVE_LEASE_SQL = `
INSERT INTO mesh_lease_active
  (project_id, run_id, lease_id, controller_node_id, epoch, operation, issued_at, expires_at,
   duration_seconds, predecessor_lease_id, predecessor_epoch, takeover_reason,
   acknowledged_unreconciled_node_ids, unreconciled_node_ids, recorded_at, schema_version)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (project_id, run_id) DO UPDATE SET
  lease_id = excluded.lease_id,
  controller_node_id = excluded.controller_node_id,
  epoch = excluded.epoch,
  operation = excluded.operation,
  issued_at = excluded.issued_at,
  expires_at = excluded.expires_at,
  duration_seconds = excluded.duration_seconds,
  predecessor_lease_id = excluded.predecessor_lease_id,
  predecessor_epoch = excluded.predecessor_epoch,
  takeover_reason = excluded.takeover_reason,
  acknowledged_unreconciled_node_ids = excluded.acknowledged_unreconciled_node_ids,
  unreconciled_node_ids = excluded.unreconciled_node_ids,
  recorded_at = excluded.recorded_at,
  schema_version = excluded.schema_version
WHERE mesh_lease_active.epoch IS ?
`

/**
 * `OR IGNORE`, not a plain insert, because the same lease record arriving twice
 * must converge rather than abort the transaction. A redelivered `mesh.lease` is
 * the ordinary case after a partition heal, and a store that treats the second
 * copy as an error would report a successful lease as a failure forever.
 */
export const INSERT_LEASE_HISTORY_SQL = `
INSERT OR IGNORE INTO mesh_lease_history
  (project_id, run_id, lease_id, controller_node_id, epoch, operation, issued_at, expires_at, recorded_at, schema_version)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

export type { Epoch, ProjectId, RunId }

import type { SqliteDriver } from "../../orchestration/event-store/sqlite-driver.js"
import {
  DestructiveMigrationNotPermittedError,
  FailedMigrationError,
  IncompleteMigrationHistoryError,
  IncompleteSchemaError,
  UnsupportedDatabaseVersionError,
} from "../../orchestration/event-store/errors.js"
import type { MeshId, NodeId } from "../../orchestration/identifiers.js"
import type { NodeKeyId } from "../identity/wire-ids.js"
import type { CapabilitySnapshot, RegistryRevocation } from "./schemas.js"

/**
 * The registry's own storage layout and its own version axis.
 *
 * Three deliberate choices, each of which is a decision someone could reasonably
 * have made differently:
 *
 *   1. **A SEPARATE migration table (`mesh_registry_migrations`), separate from
 *      the event store's `schema_migrations`.** They can be two tables in one
 *      database file or two files; what must not happen is one axis. The event
 *      store's version answers "what is the kernel's storage layout", and this one
 *      answers "what is the node registry's storage layout". Sharing a counter would
 *      mean an M4.5 inbox migration silently advancing the registry's version and
 *      a registry rollback silently rewinding the kernel's — and §3 of the protocol
 *      spec is explicit that the database version is a third axis that must not
 *      appear in a wire record and must not be conflated with the record version.
 *      M4.3 is additionally forbidden from editing `src/orchestration/`, so folding
 *      these tables into `MIGRATIONS` was not available in the first place.
 *   2. **Reusing the event store's error classes.** One vocabulary for "this
 *      database is newer than this binary" and "this migration failed" across both
 *      storage seams. A second, mesh-local copy of `UnsupportedDatabaseVersionError`
 *      would be a second thing to catch, and the thing an operator's tooling has to
 *      recognise.
 *   3. **A revocation is ONE row, not a flag on the node plus an index row.** The
 *      obvious design — `nodes.revoked_at` for the node's state, a separate
 *      `revocations` table for the key index — has two copies of one fact and
 *      therefore a window between them, and that window is exactly the one in which
 *      a revoked key gets re-pinned. Here the node's revocation state IS the
 *      key-indexed row, read back by a join, so the two cannot disagree because
 *      there is only one of them. `revokeNode` writes it inside a transaction and
 *      re-checks the index before the insert, so the guarantee is a property of the
 *      code rather than a hope about ordering.
 */

/** The registry's storage-layout version. Independent of the record schema version. */
export const CURRENT_REGISTRY_DATABASE_VERSION = 1

export const MESH_REGISTRY_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS mesh_registry_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  name TEXT NOT NULL
);
`

/**
 * The `mesh.heartbeat` subscription the registry is, expressed in SQL.
 *
 * There is no `liveness` column and that is the point. Liveness is DERIVED at read
 * time from `capability_json.observedAt` against the injected clock, because a
 * stored liveness needs something to recompute it, and a recompute that stops
 * running — a crash, a suspended controller, a clock step — leaves every node on
 * the mesh claiming to be `live` forever. That is the exact failure a heartbeat TTL
 * exists to prevent, reintroduced by the column that would have avoided the
 * sweeper.
 */
export const MESH_REGISTRY_INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mesh_registry_nodes (
  node_id TEXT PRIMARY KEY,
  mesh_id TEXT NOT NULL,
  node_key_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enrolled_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  last_heartbeat_sequence INTEGER,
  capability_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_mesh_registry_nodes_mesh ON mesh_registry_nodes(mesh_id);

CREATE TABLE IF NOT EXISTS mesh_registry_revocations (
  node_id TEXT PRIMARY KEY,
  mesh_id TEXT NOT NULL,
  revoked_key_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  revoked_by TEXT NOT NULL,
  revoked_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mesh_registry_revocations_key
  ON mesh_registry_revocations(revoked_key_id);

CREATE TABLE IF NOT EXISTS mesh_registry_heartbeat_gaps (
  node_id TEXT NOT NULL,
  from_sequence INTEGER NOT NULL,
  to_sequence INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, from_sequence)
);
`

/**
 * The objects a complete registry database must contain.
 *
 * Checked after every migration run rather than trusted, for the reason
 * `assertSchemaObjectsPresent` gives in the event store: a migration that "succeeded"
 * against a database that already had the objects is a migration that was never
 * applied, and the failure surfaces here instead of as a missing-column error in
 * production.
 */
export const REQUIRED_MESH_REGISTRY_OBJECTS: readonly { readonly type: string; readonly name: string }[] = Object.freeze([
  { type: "table", name: "mesh_registry_nodes" },
  { type: "table", name: "mesh_registry_revocations" },
  { type: "table", name: "mesh_registry_heartbeat_gaps" },
  { type: "index", name: "idx_mesh_registry_nodes_mesh" },
  { type: "index", name: "idx_mesh_registry_revocations_key" },
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

export interface RunMeshRegistryMigrationsOptions {
  readonly targetVersion?: number
  /** Required acknowledgement for a destructive migration. See `runMigrations`. */
  readonly allowDestructive?: boolean
  /**
   * The clock, for the journal's `applied_at` and nothing else.
   *
   * Injected rather than read from `Date`, unlike the event store's equivalent
   * runner. The journal timestamp is the operator's record of when a layout
   * changed, so a test that cannot choose it cannot assert it — and a module that
   * reads a clock once "for a timestamp" has already made the clock a dependency of
   * everything below it, which is how "ninety-one seconds after the last heartbeat"
   * turns into a sleep in the next test that touches this file.
   */
  readonly now: () => number
}

export const MESH_REGISTRY_MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: "initial_node_registry_schema",
    destructive: false,
    up(driver: SqliteDriver): void {
      driver.exec(MESH_REGISTRY_INITIAL_SCHEMA_SQL)
    },
  }),
])

function ensureMigrationsTable(driver: SqliteDriver): void {
  driver.exec(MESH_REGISTRY_MIGRATIONS_TABLE_SQL)
}

export function getRegistrySchemaVersion(driver: SqliteDriver): number {
  ensureMigrationsTable(driver)
  const row = driver.get<{ max_version: number | null }>(
    "SELECT MAX(version) as max_version FROM mesh_registry_migrations",
  )
  return row?.max_version ?? 0
}

function readAppliedVersions(driver: SqliteDriver): number[] {
  return driver
    .all<{ version: number }>("SELECT version FROM mesh_registry_migrations ORDER BY version ASC")
    .map((row) => row.version)
}

export function assertRegistryMigrationHistoryIsContiguous(
  driver: SqliteDriver,
  maxKnownVersion: number = CURRENT_REGISTRY_DATABASE_VERSION,
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

export function assertRegistrySchemaObjectsPresent(
  driver: SqliteDriver,
  expectedVersion: number = CURRENT_REGISTRY_DATABASE_VERSION,
): void {
  if (expectedVersion < 1) return
  const missing: { type: string, name: string }[] = []
  for (const object of REQUIRED_MESH_REGISTRY_OBJECTS) {
    const row = driver.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = ? AND name = ?",
      object.type,
      object.name,
    )
    if (!row) missing.push({ type: object.type, name: object.name })
  }
  if (missing.length > 0) throw new IncompleteSchemaError(missing)
}

/**
 * Applies pending registry migrations.
 *
 * DDL and the bookkeeping row go in ONE transaction, exactly as the event store's
 * runner does: a crash mid-migration must not leave the schema and the journal
 * disagreeing, because the next start would then either re-apply a migration that
 * partly ran or skip one that ran. The lesson was already paid for once in this
 * codebase and the shape is worth copying rather than reinventing.
 *
 * The one place the event store's runner is deliberately NOT copied is its
 * `new Date().toISOString()` journal stamp: `now` is injected here. Every time value
 * in this directory arrives through a clock the caller supplied, and
 * "ninety-one seconds after the last heartbeat" has to stay a number rather than
 * becoming a sleep.
 */
export function runMeshRegistryMigrations(
  driver: SqliteDriver,
  options: RunMeshRegistryMigrationsOptions,
): MigrationResult {
  const targetVersion = options.targetVersion ?? CURRENT_REGISTRY_DATABASE_VERSION

  ensureMigrationsTable(driver)

  const currentVersion = getRegistrySchemaVersion(driver)
  if (currentVersion > targetVersion) {
    // Fail closed rather than downgrade. A registry written by a newer build may
    // hold capability advertisements this build would misread, and "misread" for a
    // registry means "match a node against a request this controller cannot itself
    // express".
    throw new UnsupportedDatabaseVersionError(currentVersion, targetVersion)
  }

  assertRegistryMigrationHistoryIsContiguous(driver, targetVersion)

  const appliedSet = new Set(readAppliedVersions(driver))
  const pending = MESH_REGISTRY_MIGRATIONS.filter(
    (migration) => migration.version <= targetVersion && !appliedSet.has(migration.version),
  ).sort((a, b) => a.version - b.version)

  const destructive = pending.filter((migration) => migration.destructive)
  if (destructive.length > 0 && !options.allowDestructive) {
    const first = destructive[0]
    throw new DestructiveMigrationNotPermittedError(first.version, first.name)
  }

  if (pending.length === 0) {
    assertRegistrySchemaObjectsPresent(driver, targetVersion)
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
        "INSERT INTO mesh_registry_migrations (version, applied_at, name) VALUES (?, ?, ?)",
        migration.version,
        appliedAt,
        migration.name,
      )
    }
  })

  assertRegistrySchemaObjectsPresent(driver, targetVersion)
  return { appliedCount: pending.length, currentVersion: getRegistrySchemaVersion(driver) }
}

export function verifyMeshRegistrySchema(
  driver: SqliteDriver,
  expectedVersion: number = CURRENT_REGISTRY_DATABASE_VERSION,
): void {
  const currentVersion = getRegistrySchemaVersion(driver)
  if (currentVersion > expectedVersion) throw new UnsupportedDatabaseVersionError(currentVersion, expectedVersion)
  assertRegistryMigrationHistoryIsContiguous(driver, expectedVersion)
  assertRegistrySchemaObjectsPresent(driver, expectedVersion)
}

/** The physical node row, before it is re-validated into a `NodeRecord`. */
export interface MeshRegistryNodeRow {
  node_id: string
  mesh_id: string
  node_key_id: string
  display_name: string
  enrolled_at: number
  schema_version: number
  last_heartbeat_sequence: number | null
  capability_json: string | null
  /** Present only when a LEFT JOIN found one. `null` otherwise. */
  revocation_node_id: string | null
  revocation_mesh_id: string | null
  revocation_key_id: string | null
  revocation_reason: string | null
  revocation_by: string | null
  revocation_at: number | null
}

export interface MeshRegistryRevocationRow {
  node_id: string
  mesh_id: string
  revoked_key_id: string
  reason: string
  revoked_by: string
  revoked_at: number
}

export interface MeshRegistryHeartbeatGapRow {
  node_id: string
  from_sequence: number
  to_sequence: number
  observed_at: string
  detected_at: number
}

/** The node read, with its revocation joined in. One row, one fact. */
export const SELECT_NODE_SQL = `
SELECT
  n.node_id, n.mesh_id, n.node_key_id, n.display_name, n.enrolled_at, n.schema_version,
  n.last_heartbeat_sequence, n.capability_json,
  r.node_id AS revocation_node_id, r.mesh_id AS revocation_mesh_id,
  r.revoked_key_id AS revocation_key_id, r.reason AS revocation_reason,
  r.revoked_by AS revocation_by, r.revoked_at AS revocation_at
FROM mesh_registry_nodes n
LEFT JOIN mesh_registry_revocations r ON r.node_id = n.node_id
`

export const SELECT_NODES_BY_MESH_SQL = `${SELECT_NODE_SQL} WHERE n.mesh_id = ? ORDER BY n.node_id ASC`

export const SELECT_NODE_BY_ID_SQL = `${SELECT_NODE_SQL} WHERE n.node_id = ?`

export const SELECT_REVOCATION_BY_KEY_SQL =
  "SELECT node_id, mesh_id, revoked_key_id, reason, revoked_by, revoked_at FROM mesh_registry_revocations WHERE revoked_key_id = ?"

export const SELECT_REVOCATION_BY_NODE_SQL =
  "SELECT node_id, mesh_id, revoked_key_id, reason, revoked_by, revoked_at FROM mesh_registry_revocations WHERE node_id = ?"

export const INSERT_NODE_SQL = `
INSERT INTO mesh_registry_nodes
  (node_id, mesh_id, node_key_id, display_name, enrolled_at, schema_version, last_heartbeat_sequence, capability_json)
VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
`

export const SELECT_NODE_ENROLLMENT_SQL =
  "SELECT node_id, mesh_id, node_key_id, display_name, enrolled_at, schema_version, last_heartbeat_sequence, capability_json FROM mesh_registry_nodes WHERE node_id = ?"

export const INSERT_REVOCATION_SQL = `
INSERT INTO mesh_registry_revocations (node_id, mesh_id, revoked_key_id, reason, revoked_by, revoked_at)
VALUES (?, ?, ?, ?, ?, ?)
`

/**
 * The compare-and-set a heartbeat write goes through.
 *
 * `expectedSequence` is bound twice on purpose. The `IS ?` form is SQLite's NULL-safe
 * equality, so the first-ever heartbeat (which expects `NULL` because the column is
 * `NULL`) and every later one go through the SAME statement — two statements would
 * mean two code paths, and the path for "no previous sequence" is the one nobody
 * tests.
 *
 * The check lives in the `WHERE` clause rather than in a preceding `SELECT` because
 * a check and a write that are not one statement are two operations, and the gap
 * between them is where two racing heartbeats both observe a sequence that makes
 * them look in-order.
 */
export const CAS_UPDATE_HEARTBEAT_SQL = `
UPDATE mesh_registry_nodes
SET last_heartbeat_sequence = ?, capability_json = ?
WHERE node_id = ? AND last_heartbeat_sequence IS ?
`

export const INSERT_HEARTBEAT_GAP_SQL = `
INSERT INTO mesh_registry_heartbeat_gaps (node_id, from_sequence, to_sequence, observed_at, detected_at)
VALUES (?, ?, ?, ?, ?)
`

export const SELECT_HEARTBEAT_GAPS_SQL = `
SELECT node_id, from_sequence, to_sequence, observed_at, detected_at
FROM mesh_registry_heartbeat_gaps
WHERE node_id = ?
ORDER BY from_sequence ASC
`

export type { MeshId, NodeId, NodeKeyId, CapabilitySnapshot, RegistryRevocation }

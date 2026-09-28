import type { SqliteDriver } from "./sqlite-driver.js"
import {
  CURRENT_SCHEMA_VERSION,
  DISPATCH_ENVELOPE_TOMBSTONE_SQL,
  INITIAL_SCHEMA_SQL,
  OUTBOX_LEASE_COLUMNS_SQL,
  RECEIPT_FINGERPRINT_VERSION_COLUMN_SQL,
  REQUIRED_V2_OBJECTS,
  SCHEMA_MIGRATIONS_TABLE_SQL,
} from "./schema.js"
import {
  DestructiveMigrationNotPermittedError,
  FailedMigrationError,
  IncompleteMigrationHistoryError,
  IncompleteSchemaError,
  UnsupportedSchemaVersionError,
} from "./errors.js"

export interface Migration {
  readonly version: number
  readonly name: string
  /**
   * A destructive migration drops or rewrites existing data. Destructive
   * migrations are refused unless the operator has explicitly opted in after
   * taking a consistent backup via `SqliteEventStore.backup()`.
   */
  readonly destructive: boolean
  up(driver: SqliteDriver): void
}

export interface MigrationResult {
  readonly appliedCount: number
  readonly currentVersion: number
}

export interface RunMigrationsOptions {
  readonly targetVersion?: number
  /**
   * Required acknowledgement that a backup exists when a pending migration is
   * marked `destructive`. Ignored for non-destructive migrations.
   */
  readonly allowDestructive?: boolean
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_event_store_schema",
    destructive: false,
    up(driver: SqliteDriver): void {
      driver.exec(INITIAL_SCHEMA_SQL)
    },
  },
  {
    // Rollback boundary for v2:
    //   forward  - additive only (ALTER TABLE ADD COLUMN, CREATE INDEX,
    //              CREATE TABLE). No existing row is rewritten or dropped.
    //   backward - the extra columns are nullable and unused by v1 code, so a
    //              v1 binary can still read a v2 database. Downgrading the
    //              *binary* to v1 will, however, reject the file outright
    //              (schema version 2 > supported 1) until the operator
    //              deletes the `2` row from `schema_migrations`. That deletion
    //              is a manual rollback step and is not performed automatically
    //              because the tombstone table would then lose its uniqueness
    //              guarantee.
    //
    // NOT covered by this boundary - EVENT PAYLOAD COMPATIBILITY.
    //   The database version tracks the *storage layout*, not the shape of the
    //   domain records inside it. Milestone 3 changed the event payload shape
    //   (run gained `paused`, task gained `failurePolicy`, session replaced
    //   `state` with `lifecycleState` + `observedState`) while
    //   `schemaVersionSchema` remained `z.literal(1)`, so that shape break is
    //   UNVERSIONABLE under the current contract.
    //
    //   The practical consequence: a pre-split event log is NOT readable by
    //   current code, regardless of the database version, and a current log is
    //   not readable by pre-split code. The failure is LOUD, not silent - the
    //   strict schemas reject a pre-split `run.created` or `session.observed` at
    //   read time - but it is a shape break that the v2 rollback note above does
    //   not describe, and an operator must not read "a v1 binary can still read
    //   a v2 database" as covering it.
    //
    //   Action for the next shape change: widen `schemaVersionSchema` to a
    //   versioned enum BEFORE changing a persisted record shape, so this becomes
    //   an ordinary versioned migration. Flagged by both reviewers of the
    //   Milestone 3 contract re-approval.
    //   data     - `command_receipts.fingerprint_version` defaults to 1 for
    //              pre-existing receipts, which keeps legacy whole-command
    //              digests resolvable. Rows written after this migration store
    //              a semantic fingerprint with version 2 and must not be
    //              rewritten by hand.
    version: 2,
    name: "outbox_leases_and_dispatch_envelope_immutability",
    destructive: false,
    up(driver: SqliteDriver): void {
      driver.exec(OUTBOX_LEASE_COLUMNS_SQL)
      driver.exec(RECEIPT_FINGERPRINT_VERSION_COLUMN_SQL)
      driver.exec(DISPATCH_ENVELOPE_TOMBSTONE_SQL)
    },
  },
]

export function ensureMigrationsTable(driver: SqliteDriver): void {
  driver.exec(SCHEMA_MIGRATIONS_TABLE_SQL)
}

export function getSchemaVersion(driver: SqliteDriver): number {
  ensureMigrationsTable(driver)
  const row = driver.get<{ max_version: number | null }>(
    "SELECT MAX(version) as max_version FROM schema_migrations"
  )
  return row?.max_version ?? 0
}

function readAppliedVersions(driver: SqliteDriver): number[] {
  return driver
    .all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version ASC")
    .map((r) => r.version)
}

/**
 * Startup check: refuse to touch a database whose recorded migration history
 * has a hole (for example version 2 present but version 1 missing). Applying
 * the missing earlier migration on top of a later schema is never safe.
 */
export function assertMigrationHistoryIsContiguous(
  driver: SqliteDriver,
  maxKnownVersion: number = CURRENT_SCHEMA_VERSION
): void {
  ensureMigrationsTable(driver)
  const applied = readAppliedVersions(driver)
  if (applied.length === 0) return
  const maxApplied = applied[applied.length - 1]
  const missing: number[] = []
  for (let version = 1; version <= maxApplied; version++) {
    if (!applied.includes(version)) missing.push(version)
  }
  if (missing.length > 0) {
    throw new IncompleteMigrationHistoryError(maxApplied, missing)
  }
  const unknown = applied.filter((v) => v > maxKnownVersion)
  if (unknown.length > 0) {
    throw new UnsupportedSchemaVersionError(Math.max(...unknown), maxKnownVersion)
  }
}

export function assertSchemaObjectsPresent(
  driver: SqliteDriver,
  expectedVersion: number = CURRENT_SCHEMA_VERSION
): void {
  if (expectedVersion < 2) return
  const missing: { type: string, name: string }[] = []
  for (const object of REQUIRED_V2_OBJECTS) {
    const row = driver.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = ? AND name = ?",
      object.type,
      object.name
    )
    if (!row) missing.push(object)
  }
  if (missing.length > 0) {
    throw new IncompleteSchemaError(missing)
  }
}

/**
 * Startup check: a database written by a newer build must fail closed rather
 * than be silently downgraded.
 */
export function assertSchemaVersionSupported(
  driver: SqliteDriver,
  expectedVersion: number = CURRENT_SCHEMA_VERSION
): void {
  const currentVersion = getSchemaVersion(driver)
  if (currentVersion > expectedVersion) {
    throw new UnsupportedSchemaVersionError(currentVersion, expectedVersion)
  }
}

export function runMigrations(
  driver: SqliteDriver,
  optionsOrTarget?: RunMigrationsOptions | number
): MigrationResult {
  const options: RunMigrationsOptions =
    typeof optionsOrTarget === "number" ? { targetVersion: optionsOrTarget } : (optionsOrTarget ?? {})
  const targetVersion = options.targetVersion ?? CURRENT_SCHEMA_VERSION

  ensureMigrationsTable(driver)

  const currentVersion = getSchemaVersion(driver)
  if (currentVersion > targetVersion) {
    throw new UnsupportedSchemaVersionError(currentVersion, targetVersion)
  }

  assertMigrationHistoryIsContiguous(driver, targetVersion)

  const appliedSet = new Set(readAppliedVersions(driver))

  const pending = MIGRATIONS.filter(
    (m) => m.version <= targetVersion && !appliedSet.has(m.version)
  ).sort((a, b) => a.version - b.version)

  const destructive = pending.filter((m) => m.destructive)
  if (destructive.length > 0 && !options.allowDestructive) {
    const first = destructive[0]
    throw new DestructiveMigrationNotPermittedError(first.version, first.name)
  }

  if (pending.length === 0) {
    assertSchemaObjectsPresent(driver, targetVersion)
    return {
      appliedCount: 0,
      currentVersion,
    }
  }

  // Migrations are DDL-only, so they belong in the same transaction as the
  // bookkeeping row. A crash mid-migration rolls the whole thing back; it can
  // never leave schema and migration journal disagreeing.
  driver.transaction(() => {
    for (const migration of pending) {
      try {
        migration.up(driver)
      } catch (cause) {
        throw new FailedMigrationError(migration.version, migration.name, cause)
      }
      const now = new Date().toISOString()
      driver.run(
        "INSERT INTO schema_migrations (version, applied_at, name) VALUES (?, ?, ?)",
        migration.version,
        now,
        migration.name
      )
    }
  })

  assertSchemaObjectsPresent(driver, targetVersion)

  return {
    appliedCount: pending.length,
    currentVersion: getSchemaVersion(driver),
  }
}

export function verifySchemaVersion(
  driver: SqliteDriver,
  expectedVersion: number = CURRENT_SCHEMA_VERSION
): void {
  assertSchemaVersionSupported(driver, expectedVersion)
  assertMigrationHistoryIsContiguous(driver, expectedVersion)
  assertSchemaObjectsPresent(driver, expectedVersion)
}

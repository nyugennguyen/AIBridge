import type { SqliteDriver } from "./sqlite-driver.js"
import { CURRENT_SCHEMA_VERSION, INITIAL_SCHEMA_SQL, SCHEMA_MIGRATIONS_TABLE_SQL } from "./schema.js"
import { UnsupportedSchemaVersionError } from "./errors.js"

export interface Migration {
  readonly version: number
  readonly name: string
  up(driver: SqliteDriver): void
}

export interface MigrationResult {
  readonly appliedCount: number
  readonly currentVersion: number
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_event_store_schema",
    up(driver: SqliteDriver): void {
      driver.exec(INITIAL_SCHEMA_SQL)
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

export function runMigrations(
  driver: SqliteDriver,
  targetVersion: number = CURRENT_SCHEMA_VERSION
): MigrationResult {
  ensureMigrationsTable(driver)

  const currentVersion = getSchemaVersion(driver)
  if (currentVersion > targetVersion) {
    throw new UnsupportedSchemaVersionError(currentVersion, targetVersion)
  }

  const appliedRows = driver.all<{ version: number }>(
    "SELECT version FROM schema_migrations ORDER BY version ASC"
  )
  const appliedSet = new Set(appliedRows.map((r) => r.version))

  const pending = MIGRATIONS.filter(
    (m) => m.version <= targetVersion && !appliedSet.has(m.version)
  ).sort((a, b) => a.version - b.version)

  if (pending.length === 0) {
    return {
      appliedCount: 0,
      currentVersion,
    }
  }

  driver.transaction(() => {
    for (const migration of pending) {
      migration.up(driver)
      const now = new Date().toISOString()
      driver.run(
        "INSERT INTO schema_migrations (version, applied_at, name) VALUES (?, ?, ?)",
        migration.version,
        now,
        migration.name
      )
    }
  })

  return {
    appliedCount: pending.length,
    currentVersion: getSchemaVersion(driver),
  }
}

export function verifySchemaVersion(
  driver: SqliteDriver,
  expectedVersion: number = CURRENT_SCHEMA_VERSION
): void {
  const currentVersion = getSchemaVersion(driver)
  if (currentVersion > expectedVersion) {
    throw new UnsupportedSchemaVersionError(currentVersion, expectedVersion)
  }
}

/**
 * Database integrity checks and unsupported-version diagnostics (M8.2).
 */

import {
  createSqliteDriver,
  type SqliteDriver,
} from "../orchestration/event-store/sqlite-driver.js"
import { CURRENT_DATABASE_VERSION } from "../orchestration/event-store/schema.js"
import type {
  DatabaseStatus,
  IntegrityCheckReport,
  OutboxStats,
} from "./types.js"

export interface IntegrityCheckOptions {
  readonly maxSupportedVersion?: number
  readonly storeType?: "event" | "ingress" | "egress" | "mesh" | "auto"
}

export function checkDatabaseIntegrity(
  pathOrDriver: string | SqliteDriver,
  options?: IntegrityCheckOptions,
): IntegrityCheckReport {
  let driver: SqliteDriver
  let shouldClose = false
  const dbPath = typeof pathOrDriver === "string" ? pathOrDriver : ":memory:"

  try {
    if (typeof pathOrDriver === "string") {
      driver = createSqliteDriver({ path: pathOrDriver, create: false, readonly: true })
      shouldClose = true
    } else {
      driver = pathOrDriver
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: "corrupt",
      dbPath,
      userVersion: 0,
      supportedVersion: options?.maxSupportedVersion ?? CURRENT_DATABASE_VERSION,
      pragmaResult: errorMsg,
      errors: [`Failed to open database: ${errorMsg}`],
      tables: [],
    }
  }

  try {
    const errors: string[] = []

    // 1. Run PRAGMA integrity_check
    let pragmaResult = "unknown"
    try {
      const integrityRows = driver.all<{ integrity_check: string }>("PRAGMA integrity_check")
      pragmaResult = integrityRows.map((r) => r.integrity_check).join("; ")
      if (pragmaResult !== "ok") {
        errors.push(`SQLite integrity check failed: ${pragmaResult}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      pragmaResult = `Error running integrity_check: ${msg}`
      errors.push(pragmaResult)
    }

    // 2. Run PRAGMA foreign_key_check
    try {
      const fkRows = driver.all<{ table: string; rowid: number; parent: string; fkid: number }>(
        "PRAGMA foreign_key_check",
      )
      if (fkRows.length > 0) {
        errors.push(
          `Foreign key violations detected in ${fkRows.length} rows (${fkRows.map((r) => r.table).join(", ")})`,
        )
      }
    } catch {
      // Ignored if table doesn't support fk check
    }

    // 3. User version & unsupported-version diagnostics
    let userVersion = 0
    try {
      const row = driver.get<{ user_version: number }>("PRAGMA user_version")
      userVersion = row?.user_version ?? 0
    } catch {
      // user_version unreadable
    }

    // 4. Query tables
    let tables: string[] = []
    try {
      const tableRows = driver.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      tables = tableRows.map((r) => r.name)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`Failed to query database schema: ${msg}`)
      return {
        ok: false,
        status: "corrupt",
        dbPath,
        userVersion,
        supportedVersion: options?.maxSupportedVersion ?? CURRENT_DATABASE_VERSION,
        pragmaResult,
        errors,
        tables: [],
      }
    }
    if (tables.includes("schema_migrations")) {
      try {
        const migRow = driver.get<{ max_version: number | null }>(
          "SELECT MAX(version) as max_version FROM schema_migrations",
        )
        if (migRow?.max_version !== null && migRow?.max_version !== undefined) {
          userVersion = Math.max(userVersion, migRow.max_version)
        }
      } catch {
        // Ignored
      }
    }

    // Determine max supported version
    let supportedVersion = options?.maxSupportedVersion ?? CURRENT_DATABASE_VERSION
    if (tables.includes("ingress_outbox")) {
      supportedVersion = 1
    } else if (tables.includes("egress_outbox") && !tables.includes("outbox_records")) {
      supportedVersion = 1
    }

    let status: DatabaseStatus = "healthy"
    if (errors.length > 0) {
      status = "corrupt"
    } else if (userVersion > supportedVersion) {
      status = "unsupported_version"
      errors.push(
        `Database user_version ${userVersion} exceeds maximum supported version ${supportedVersion}. Upgrade required.`,
      )
    }

    // 5. Outbox statistics if outbox table is present
    let outboxStats: OutboxStats | undefined
    if (tables.includes("ingress_outbox")) {
      outboxStats = queryOutboxStats(driver, "ingress_outbox", "status", "terminal_error")
    } else if (tables.includes("egress_outbox")) {
      outboxStats = queryOutboxStats(driver, "egress_outbox", "status", "terminal_error")
    } else if (tables.includes("outbox_records")) {
      outboxStats = queryMeshOutboxStats(driver)
    }

    return {
      ok: status === "healthy",
      status,
      dbPath,
      userVersion,
      supportedVersion,
      pragmaResult,
      errors,
      tables,
      ...(outboxStats ? { outboxStats } : {}),
    }
  } finally {
    if (shouldClose) {
      driver.close()
    }
  }
}

function queryOutboxStats(
  driver: SqliteDriver,
  table: string,
  statusCol: string,
  terminalCol: string,
): OutboxStats {
  try {
    const totalRow = driver.get<{ count: number }>(`SELECT COUNT(*) as count FROM ${table}`)
    const pendingRow = driver.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${table} WHERE ${statusCol} = 'pending'`,
    )
    const sendingRow = driver.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${table} WHERE ${statusCol} = 'sending'`,
    )
    const deliveredRow = driver.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${table} WHERE ${statusCol} IN ('delivered', 'acknowledged')`,
    )
    const failedRow = driver.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${table} WHERE ${statusCol} = 'failed'`,
    )
    const terminalRow = driver.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${table} WHERE ${terminalCol} IS NOT NULL OR ${statusCol} = 'failed'`,
    )

    return {
      total: totalRow?.count ?? 0,
      pending: pendingRow?.count ?? 0,
      sending: sendingRow?.count ?? 0,
      delivered: deliveredRow?.count ?? 0,
      failed: failedRow?.count ?? 0,
      terminalEvidenceRows: terminalRow?.count ?? 0,
    }
  } catch {
    return {
      total: 0,
      pending: 0,
      sending: 0,
      delivered: 0,
      failed: 0,
      terminalEvidenceRows: 0,
    }
  }
}

function queryMeshOutboxStats(driver: SqliteDriver): OutboxStats {
  try {
    const totalRow = driver.get<{ count: number }>("SELECT COUNT(*) as count FROM outbox_records")
    const pendingRow = driver.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM outbox_records WHERE status = 'pending'",
    )
    const sendingRow = driver.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM outbox_records WHERE status = 'sending'",
    )
    const deliveredRow = driver.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM outbox_records WHERE status = 'acknowledged'",
    )
    const failedRow = driver.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM outbox_records WHERE status = 'failed'",
    )
    const terminalRow = driver.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM outbox_records WHERE status = 'failed' OR attempts >= 8",
    )

    return {
      total: totalRow?.count ?? 0,
      pending: pendingRow?.count ?? 0,
      sending: sendingRow?.count ?? 0,
      delivered: deliveredRow?.count ?? 0,
      failed: failedRow?.count ?? 0,
      terminalEvidenceRows: terminalRow?.count ?? 0,
    }
  } catch {
    return {
      total: 0,
      pending: 0,
      sending: 0,
      delivered: 0,
      failed: 0,
      terminalEvidenceRows: 0,
    }
  }
}

/**
 * Database backup creation and validation (M8.2).
 */

import { existsSync, statSync, mkdirSync, unlinkSync, copyFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  createSqliteDriver,
  type SqliteDriver,
} from "../orchestration/event-store/sqlite-driver.js"
import type { BackupOptions, BackupResult } from "./types.js"

export function createDatabaseBackup(
  sourcePath: string,
  backupPath: string,
  options?: BackupOptions,
): BackupResult {
  if (!existsSync(sourcePath)) {
    throw new Error(`Cannot backup non-existent database: ${sourcePath}`)
  }

  const targetDir = dirname(backupPath)
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  // Remove existing file at backup destination so VACUUM INTO / copy succeeds
  if (existsSync(backupPath)) {
    unlinkSync(backupPath)
  }

  const shouldCheckpoint = options?.checkpoint ?? true
  const shouldVerify = options?.verify ?? true

  let driver: SqliteDriver | undefined
  try {
    driver = createSqliteDriver({ path: sourcePath, create: false })
    if (shouldCheckpoint) {
      try {
        driver.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      } catch {
        // Ignored if not in WAL mode
      }
    }

    let vacuumSucceeded = false
    try {
      // Escape single quotes for SQLite string literal
      const escaped = backupPath.replace(/'/g, "''")
      driver.exec(`VACUUM INTO '${escaped}'`)
      vacuumSucceeded = true
    } catch {
      vacuumSucceeded = false
    }

    if (!vacuumSucceeded) {
      // Fall back to clean file copy while checkpointed
      copyFileSync(sourcePath, backupPath)
    }
  } finally {
    if (driver) {
      driver.close()
    }
  }

  // Verify backup integrity
  if (shouldVerify) {
    let verifyDriver: SqliteDriver | undefined
    try {
      verifyDriver = createSqliteDriver({ path: backupPath, create: false, readonly: true })
      const check = verifyDriver.get<{ quick_check: string }>("PRAGMA quick_check")
      if (check?.quick_check !== "ok") {
        unlinkSync(backupPath)
        throw new Error(`Backup failed integrity verification: ${check?.quick_check}`)
      }
    } catch (e) {
      if (existsSync(backupPath)) {
        unlinkSync(backupPath)
      }
      throw new Error(`Backup integrity check failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (verifyDriver) {
        verifyDriver.close()
      }
    }
  }

  const stat = statSync(backupPath)
  return {
    sourcePath,
    backupPath,
    bytes: stat.size,
    verified: shouldVerify,
    timestampMs: Date.now(),
  }
}

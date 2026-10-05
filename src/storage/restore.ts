/**
 * Safe database restoration with pre-restore backup, atomic cutover, and verification (M8.2).
 */

import { existsSync, mkdirSync, unlinkSync, copyFileSync, renameSync } from "node:fs"
import { dirname } from "node:path"
import { checkDatabaseIntegrity } from "./integrity.js"
import { createDatabaseBackup } from "./backup.js"
import type { RestoreOptions, RestoreResult } from "./types.js"

export function restoreDatabaseFromBackup(
  backupPath: string,
  destinationPath: string,
  options?: RestoreOptions,
): RestoreResult {
  if (!existsSync(backupPath)) {
    throw new Error(`Cannot restore from non-existent backup: ${backupPath}`)
  }

  const shouldVerify = options?.verify ?? true

  // 1. Verify backup file integrity before touching anything
  if (shouldVerify) {
    try {
      const backupCheck = checkDatabaseIntegrity(backupPath)
      if (!backupCheck.ok) {
        throw new Error(
          `Backup file integrity check failed; refusing restore: ${backupCheck.errors.join("; ")}`,
        )
      }
    } catch (e) {
      throw new Error(
        `Backup file integrity check failed; refusing restore: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  const destDir = dirname(destinationPath)
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true })
  }

  // 2. Pre-restore backup if destination already exists
  let preRestoreBackupPath: string | undefined
  if (existsSync(destinationPath)) {
    preRestoreBackupPath =
      options?.preRestoreBackupPath ??
      `${destinationPath}.pre-restore.${Date.now()}.bak`
    try {
      createDatabaseBackup(destinationPath, preRestoreBackupPath, { verify: false })
    } catch {
      // If destination was already corrupted, proceed with restore
      preRestoreBackupPath = undefined
    }
  }

  // 3. Staged restoration via atomic temporary swap
  const tempPath = `${destinationPath}.tmp.${Date.now()}`
  try {
    copyFileSync(backupPath, tempPath)

    if (shouldVerify) {
      const tempCheck = checkDatabaseIntegrity(tempPath)
      if (!tempCheck.ok) {
        throw new Error(
          `Staged restored database failed integrity check: ${tempCheck.errors.join("; ")}`,
        )
      }
    }

    // Also remove WAL / SHM auxiliary files if destination exists
    const walFile = `${destinationPath}-wal`
    const shmFile = `${destinationPath}-shm`
    if (existsSync(walFile)) {
      unlinkSync(walFile)
    }
    if (existsSync(shmFile)) {
      unlinkSync(shmFile)
    }

    // Atomic cutover
    renameSync(tempPath, destinationPath)

    // Final verification of destination
    if (shouldVerify) {
      const finalCheck = checkDatabaseIntegrity(destinationPath)
      if (!finalCheck.ok) {
        throw new Error(
          `Final restored database failed verification: ${finalCheck.errors.join("; ")}`,
        )
      }
    }

    return {
      backupPath,
      destinationPath,
      ...(preRestoreBackupPath ? { preRestoreBackupPath } : {}),
      restored: true,
      verified: shouldVerify,
    }
  } catch (error) {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath)
    }
    // Attempt rollback if pre-restore backup exists
    if (preRestoreBackupPath && existsSync(preRestoreBackupPath)) {
      try {
        copyFileSync(preRestoreBackupPath, destinationPath)
      } catch {
        // Failed rollback
      }
    }
    throw error
  }
}

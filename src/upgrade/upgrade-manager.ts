/**
 * Upgrade and Rollback execution engine (M8.6).
 *
 * Enforces:
 * - Preflight check before any mutation
 * - Pre-upgrade verified backup before irreversible migration
 * - Downgrade refusal with actionable message
 * - Atomic rollback on failure
 */

import { dirname, basename, join } from "node:path"
import { existsSync } from "node:fs"
import { checkDatabaseIntegrity } from "../storage/integrity.js"
import { createDatabaseBackup } from "../storage/backup.js"
import { restoreDatabaseFromBackup } from "../storage/restore.js"
import {
  createSqliteDriver,
  type SqliteDriver,
} from "../orchestration/event-store/sqlite-driver.js"
import {
  MIGRATIONS,
  runMigrations,
} from "../orchestration/event-store/migrations.js"
import {
  CURRENT_SUPPORTED_DATABASE_VERSION,
  MIN_SUPPORTED_DATABASE_VERSION,
  type RollbackOptions,
  type RollbackResult,
  type UpgradeOptions,
  type UpgradePlan,
  type UpgradePreflightResult,
  type UpgradeResult,
} from "./types.js"

export class UpgradeManager {
  planUpgrade(
    currentVersion: number,
    targetVersion = CURRENT_SUPPORTED_DATABASE_VERSION,
  ): UpgradePlan {
    const isDowngrade = currentVersion > targetVersion
    const isNoOp = currentVersion === targetVersion

    const pending = isDowngrade
      ? []
      : MIGRATIONS.filter((m) => m.version > currentVersion && m.version <= targetVersion)

    return {
      currentVersion,
      targetVersion,
      isDowngrade,
      isNoOp,
      pendingMigrations: pending,
      preUpgradeBackupRequired: pending.length > 0,
    }
  }

  preflightUpgrade(
    dbPath: string,
    targetVersion = CURRENT_SUPPORTED_DATABASE_VERSION,
  ): UpgradePreflightResult {
    if (!existsSync(dbPath)) {
      return {
        ok: false,
        currentVersion: 0,
        targetVersion,
        isDowngrade: false,
        canUpgrade: false,
        actionableMessage: `Database file does not exist: ${dbPath}`,
        errors: [`Database file not found at ${dbPath}`],
      }
    }

    // 1. Check integrity of source database
    const integrity = checkDatabaseIntegrity(dbPath)
    if (!integrity.ok) {
      return {
        ok: false,
        currentVersion: integrity.userVersion,
        targetVersion,
        isDowngrade: false,
        canUpgrade: false,
        actionableMessage: "Database integrity check failed. Run repair tooling before attempting upgrade.",
        errors: [...integrity.errors],
      }
    }

    const currentVersion = integrity.userVersion

    // 2. Refuse downgrade
    if (currentVersion > targetVersion) {
      return {
        ok: false,
        currentVersion,
        targetVersion,
        isDowngrade: true,
        canUpgrade: false,
        actionableMessage:
          `Downgrade from database version ${currentVersion} to ${targetVersion} is refused to prevent data corruption. ` +
          `To downgrade safely, restore an earlier verified backup taken before version ${targetVersion + 1} was applied.`,
        errors: [`Downgrade from ${currentVersion} to ${targetVersion} refused`],
      }
    }

    // 3. Refuse unsupported legacy version
    if (currentVersion < MIN_SUPPORTED_DATABASE_VERSION && currentVersion !== 0) {
      return {
        ok: false,
        currentVersion,
        targetVersion,
        isDowngrade: false,
        canUpgrade: false,
        actionableMessage:
          `Database version ${currentVersion} is older than minimum supported version ${MIN_SUPPORTED_DATABASE_VERSION}. ` +
          "Upgrade must proceed through intermediate release milestones.",
        errors: [`Unsupported legacy database version ${currentVersion}`],
      }
    }

    return {
      ok: true,
      currentVersion,
      targetVersion,
      isDowngrade: false,
      canUpgrade: true,
      actionableMessage:
        currentVersion === targetVersion
          ? `Database is already at target version ${targetVersion}. No migrations required.`
          : `Ready to upgrade from version ${currentVersion} to ${targetVersion}.`,
      errors: [],
    }
  }

  executeUpgrade(dbPath: string, options?: UpgradeOptions): UpgradeResult {
    const targetVersion = options?.targetVersion ?? CURRENT_SUPPORTED_DATABASE_VERSION
    const preflight = this.preflightUpgrade(dbPath, targetVersion)

    if (!preflight.canUpgrade) {
      return {
        success: false,
        previousVersion: preflight.currentVersion,
        newVersion: preflight.currentVersion,
        appliedCount: 0,
        rollbackAvailable: false,
        errors: [preflight.actionableMessage, ...preflight.errors],
      }
    }

    if (preflight.currentVersion === targetVersion) {
      return {
        success: true,
        previousVersion: preflight.currentVersion,
        newVersion: targetVersion,
        appliedCount: 0,
        rollbackAvailable: false,
        errors: [],
      }
    }

    // 1. Create verified pre-upgrade backup
    const backupDir = options?.backupDir ?? dirname(dbPath)
    const baseName = basename(dbPath)
    const backupPath = join(
      backupDir,
      `${baseName}.pre-upgrade-v${preflight.currentVersion}.${Date.now()}.bak`,
    )

    try {
      createDatabaseBackup(dbPath, backupPath, { verify: true })
    } catch (e) {
      return {
        success: false,
        previousVersion: preflight.currentVersion,
        newVersion: preflight.currentVersion,
        appliedCount: 0,
        rollbackAvailable: false,
        errors: [
          `Failed to create pre-upgrade backup; aborting migration: ${e instanceof Error ? e.message : String(e)}`,
        ],
      }
    }

    // Dry-run mode exits cleanly after verifying backup
    if (options?.dryRun) {
      return {
        success: true,
        previousVersion: preflight.currentVersion,
        newVersion: preflight.currentVersion,
        appliedCount: 0,
        backupPath,
        rollbackAvailable: true,
        errors: [],
      }
    }

    // 2. Execute migration with automatic rollback protection
    let driver: SqliteDriver | undefined
    try {
      driver = createSqliteDriver({ path: dbPath, create: false })
      const migrationResult = runMigrations(driver, {
        targetVersion,
        allowDestructive: options?.allowDestructive ?? false,
      })
      driver.close()
      driver = undefined

      // 3. Post-migration integrity verification
      const postIntegrity = checkDatabaseIntegrity(dbPath)
      if (!postIntegrity.ok) {
        throw new Error(`Post-migration integrity check failed: ${postIntegrity.errors.join("; ")}`)
      }

      return {
        success: true,
        previousVersion: preflight.currentVersion,
        newVersion: migrationResult.currentVersion,
        appliedCount: migrationResult.appliedCount,
        backupPath,
        rollbackAvailable: true,
        errors: [],
      }
    } catch (migrationError) {
      if (driver) {
        driver.close()
      }

      // Automatic emergency rollback to pre-upgrade backup
      try {
        restoreDatabaseFromBackup(backupPath, dbPath, { verify: true })
      } catch (rollbackErr) {
        return {
          success: false,
          previousVersion: preflight.currentVersion,
          newVersion: preflight.currentVersion,
          appliedCount: 0,
          backupPath,
          rollbackAvailable: false,
          errors: [
            `Migration failed: ${migrationError instanceof Error ? migrationError.message : String(migrationError)}`,
            `CRITICAL: Automatic rollback also failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          ],
        }
      }

      return {
        success: false,
        previousVersion: preflight.currentVersion,
        newVersion: preflight.currentVersion,
        appliedCount: 0,
        backupPath,
        rollbackAvailable: true,
        errors: [
          `Migration failed and was rolled back to pre-upgrade backup: ${migrationError instanceof Error ? migrationError.message : String(migrationError)}`,
        ],
      }
    }
  }

  executeRollback(dbPath: string, options: RollbackOptions): RollbackResult {
    if (!options.backupPath || !existsSync(options.backupPath)) {
      return {
        success: false,
        rolledBackToVersion: 0,
        errors: [`Cannot rollback without valid backup path: ${options.backupPath}`],
      }
    }

    try {
      const restored = restoreDatabaseFromBackup(options.backupPath, dbPath, { verify: true })
      const integrity = checkDatabaseIntegrity(dbPath)

      return {
        success: restored.restored && integrity.ok,
        rolledBackToVersion: integrity.userVersion,
        restoredFromBackup: options.backupPath,
        errors: integrity.errors,
      }
    } catch (e) {
      return {
        success: false,
        rolledBackToVersion: 0,
        errors: [`Rollback failed: ${e instanceof Error ? e.message : String(e)}`],
      }
    }
  }
}

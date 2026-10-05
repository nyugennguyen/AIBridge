import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UpgradeManager } from "../../../src/upgrade/index.js"
import { createSqliteDriver } from "../../../src/orchestration/event-store/sqlite-driver.js"
import { runMigrations } from "../../../src/orchestration/event-store/migrations.js"
import { checkDatabaseIntegrity } from "../../../src/storage/integrity.js"

describe("M8.6: Upgrade and Rollback Framework", () => {
  it("plans upgrade steps and detects no-op vs pending migrations", () => {
    const manager = new UpgradeManager()

    const planV1toV2 = manager.planUpgrade(1, 2)
    expect(planV1toV2.isDowngrade).toBe(false)
    expect(planV1toV2.isNoOp).toBe(false)
    expect(planV1toV2.pendingMigrations.length).toBe(1)
    expect(planV1toV2.preUpgradeBackupRequired).toBe(true)

    const planV2toV2 = manager.planUpgrade(2, 2)
    expect(planV2toV2.isNoOp).toBe(true)
    expect(planV2toV2.pendingMigrations.length).toBe(0)

    const planDowngrade = manager.planUpgrade(2, 1)
    expect(planDowngrade.isDowngrade).toBe(true)
    expect(planDowngrade.pendingMigrations.length).toBe(0)
  })

  it("refuses unsafe downgrades with actionable guidance", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-upg-downgrade-"))
    const dbPath = join(tempDir, "v2-store.db")

    try {
      const driver = createSqliteDriver({ path: dbPath, create: true })
      runMigrations(driver, { targetVersion: 2 })
      driver.close()

      const manager = new UpgradeManager()
      const preflight = manager.preflightUpgrade(dbPath, 1)

      expect(preflight.canUpgrade).toBe(false)
      expect(preflight.isDowngrade).toBe(true)
      expect(preflight.actionableMessage).toContain("Downgrade from database version 2 to 1 is refused")
      expect(preflight.actionableMessage).toContain("restore an earlier verified backup")

      // Attempting execution also fails safely without touching the file
      const result = manager.executeUpgrade(dbPath, { targetVersion: 1 })
      expect(result.success).toBe(false)
      expect(result.appliedCount).toBe(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("executes clean upgrade from v1 to v2 creating verified backup", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-upg-v1v2-"))
    const dbPath = join(tempDir, "store.db")

    try {
      // 1. Initialize store at v1
      const driver = createSqliteDriver({ path: dbPath, create: true })
      runMigrations(driver, { targetVersion: 1 })
      driver.close()

      const manager = new UpgradeManager()

      // 2. Preflight confirms readiness
      const preflight = manager.preflightUpgrade(dbPath, 2)
      expect(preflight.canUpgrade).toBe(true)
      expect(preflight.currentVersion).toBe(1)
      expect(preflight.targetVersion).toBe(2)

      // 3. Execute upgrade
      const result = manager.executeUpgrade(dbPath, { targetVersion: 2 })
      expect(result.success).toBe(true)
      expect(result.previousVersion).toBe(1)
      expect(result.newVersion).toBe(2)
      expect(result.appliedCount).toBe(1)
      expect(result.backupPath).toBeDefined()
      expect(existsSync(result.backupPath!)).toBe(true)

      // Backup is verifiable
      const backupCheck = checkDatabaseIntegrity(result.backupPath!)
      expect(backupCheck.ok).toBe(true)
      expect(backupCheck.userVersion).toBe(1)

      // Live database is now v2
      const liveCheck = checkDatabaseIntegrity(dbPath)
      expect(liveCheck.ok).toBe(true)
      expect(liveCheck.userVersion).toBe(2)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("supports manual rollback using an earlier backup", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-upg-manual-rb-"))
    const dbPath = join(tempDir, "store.db")

    try {
      const driver = createSqliteDriver({ path: dbPath, create: true })
      runMigrations(driver, { targetVersion: 1 })
      driver.close()

      const manager = new UpgradeManager()
      const upgrade = manager.executeUpgrade(dbPath, { targetVersion: 2 })
      expect(upgrade.success).toBe(true)

      // Roll back using pre-upgrade backup
      const rollback = manager.executeRollback(dbPath, { backupPath: upgrade.backupPath })
      expect(rollback.success).toBe(true)
      expect(rollback.rolledBackToVersion).toBe(1)

      // Verify database is back at version 1
      const liveCheck = checkDatabaseIntegrity(dbPath)
      expect(liveCheck.ok).toBe(true)
      expect(liveCheck.userVersion).toBe(1)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

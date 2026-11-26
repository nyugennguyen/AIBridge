import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkDatabaseIntegrity } from "../../src/storage/integrity.js"
import { createSqliteDriver } from "../../src/orchestration/event-store/sqlite-driver.js"
import { runMigrations } from "../../src/orchestration/event-store/migrations.js"

describe("Database integrity check (M8.2, used by the diagnostics bundle)", () => {
  it("detects healthy databases and returns structured integrity report", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-integrity-"))
    const dbPath = join(tempDir, "healthy.db")

    try {
      const driver = createSqliteDriver({ path: dbPath, create: true })
      runMigrations(driver)
      driver.close()

      const report = checkDatabaseIntegrity(dbPath)
      expect(report.ok).toBe(true)
      expect(report.status).toBe("healthy")
      expect(report.pragmaResult).toBe("ok")
      expect(report.errors).toHaveLength(0)
      expect(report.userVersion).toBe(2)
      expect(report.tables).toContain("run_streams")
      expect(report.tables).toContain("run_events")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("detects corrupt databases and reports errors", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-corrupt-"))
    const dbPath = join(tempDir, "corrupt.db")

    try {
      // Write random junk data to simulate corruption
      writeFileSync(dbPath, "SQLite format 3\0THIS IS CORRUPTED HEADER AND JUNK DATA PAYLOAD")

      const report = checkDatabaseIntegrity(dbPath)
      expect(report.ok).toBe(false)
      expect(report.status).toBe("corrupt")
      expect(report.errors.length).toBeGreaterThan(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("diagnoses unsupported newer database versions", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-version-"))
    const dbPath = join(tempDir, "future-version.db")

    try {
      const driver = createSqliteDriver({ path: dbPath, create: true })
      runMigrations(driver)
      // Stamp with future user_version 99
      driver.exec("PRAGMA user_version = 99")
      driver.close()

      const report = checkDatabaseIntegrity(dbPath, { maxSupportedVersion: 2 })
      expect(report.ok).toBe(false)
      expect(report.status).toBe("unsupported_version")
      expect(report.errors[0]).toContain("exceeds maximum supported version")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

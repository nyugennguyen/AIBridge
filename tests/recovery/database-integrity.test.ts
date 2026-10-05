import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkDatabaseIntegrity,
  createDatabaseBackup,
  restoreDatabaseFromBackup,
  rebuildAllProjections,
  repairOutboxStore,
} from "../../src/storage/index.js"
import { createSqliteDriver } from "../../src/orchestration/event-store/sqlite-driver.js"
import { SqliteEventStore } from "../../src/orchestration/event-store/event-store.js"
import { runMigrations } from "../../src/orchestration/event-store/migrations.js"
import { EgressOutboxStore } from "../../src/callback/egress-outbox.js"
import { orchestrationCommandSchema, orchestrationEventSchema } from "../../src/orchestration/schemas.js"

describe("Database Integrity and Repair Tooling (M8.2)", () => {
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

  it("creates verified backups and refuses corrupt source databases", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-backup-"))
    const dbPath = join(tempDir, "source.db")
    const backupPath = join(tempDir, "backup.db")

    try {
      const driver = createSqliteDriver({ path: dbPath, create: true })
      runMigrations(driver)
      driver.close()

      const result = createDatabaseBackup(dbPath, backupPath)
      expect(result.verified).toBe(true)
      expect(result.bytes).toBeGreaterThan(0)
      expect(existsSync(backupPath)).toBe(true)

      const backupReport = checkDatabaseIntegrity(backupPath)
      expect(backupReport.ok).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("restores database safely with pre-restore backup and atomic cutover", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-restore-"))
    const origPath = join(tempDir, "original.db")
    const backupPath = join(tempDir, "good-backup.db")
    const destPath = join(tempDir, "dest.db")

    try {
      // 1. Create a good database and back it up
      const origDriver = createSqliteDriver({ path: origPath, create: true })
      runMigrations(origDriver)
      origDriver.exec("CREATE TABLE custom_data (id INT, val TEXT)")
      origDriver.run("INSERT INTO custom_data VALUES (1, 'persisted_val')")
      origDriver.close()

      createDatabaseBackup(origPath, backupPath)

      // 2. Create existing destination with different data
      const destDriver = createSqliteDriver({ path: destPath, create: true })
      destDriver.exec("CREATE TABLE existing (id INT)")
      destDriver.close()

      // 3. Restore from backup
      const restoreResult = restoreDatabaseFromBackup(backupPath, destPath)
      expect(restoreResult.restored).toBe(true)
      expect(restoreResult.verified).toBe(true)
      expect(restoreResult.preRestoreBackupPath).toBeTruthy()
      expect(existsSync(restoreResult.preRestoreBackupPath!)).toBe(true)

      // 4. Verify restored data matches backup
      const checkDriver = createSqliteDriver({ path: destPath, create: false })
      const row = checkDriver.get<{ val: string }>("SELECT val FROM custom_data WHERE id = 1")
      expect(row?.val).toBe("persisted_val")
      checkDriver.close()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("refuses restoring from a corrupt backup file and preserves destination", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-restore-corrupt-"))
    const badBackup = join(tempDir, "bad.bak")
    const destPath = join(tempDir, "live.db")

    try {
      // Valid live database
      const liveDriver = createSqliteDriver({ path: destPath, create: true })
      liveDriver.exec("CREATE TABLE live_table (id INT)")
      liveDriver.run("INSERT INTO live_table VALUES (42)")
      liveDriver.close()

      // Corrupt backup file
      writeFileSync(badBackup, "INVALID_HEADER_JUNK")

      // Attempt restore -> throws
      expect(() => restoreDatabaseFromBackup(badBackup, destPath)).toThrow(/refusing restore/)

      // Destination is unharmed
      const check = createSqliteDriver({ path: destPath, create: false })
      const val = check.get<{ id: number }>("SELECT id FROM live_table")
      expect(val?.id).toBe(42)
      check.close()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("rebuilds projections deterministically from immutable event log (M8.2)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-proj-"))
    const dbPath = join(tempDir, "events.db")

    try {
      const driver = createSqliteDriver({ path: dbPath, create: true })
      runMigrations(driver)
      const store = new SqliteEventStore(driver)

      // Append sample event
      const runId = "run-proj-1"
      const command = orchestrationCommandSchema.parse({
        schemaVersion: 1,
        commandId: "cmd-proj-1",
        projectId: "proj-1",
        runId,
        actor: { kind: "user", userId: "user-tester" },
        controllerNodeId: "node-test",
        controllerEpoch: 1,
        leaseId: "lease-test",
        issuedAt: "2026-09-17T00:00:00.000Z",
        expiresAt: "2026-09-17T00:10:00.000Z",
        correlationId: "corr-test",
        causation: null,
        type: "run.cancel",
        payload: {
          reason: "Test cancel reason",
        },
      })
      const event = orchestrationEventSchema.parse({
        schemaVersion: 1,
        eventId: "ev-proj-1",
        projectId: "proj-1",
        runId,
        sequence: 1,
        actor: { kind: "user", userId: "user-tester" },
        controllerEpoch: 1,
        commandId: "cmd-proj-1",
        occurredAt: "2026-09-17T00:00:00.000Z",
        correlationId: "corr-test",
        causation: null,
        type: "run.cancelled",
        payload: {
          runId,
          reason: "Test cancel reason",
        },
      })
      store.append({ command, events: [event] })
      const rebuildResult = await rebuildAllProjections(store)
      expect(rebuildResult.rebuiltRuns).toBe(1)
      expect(rebuildResult.runs[0]?.runId).toBe(runId)
      expect(rebuildResult.runs[0]?.verified).toBe(true)

      // Assert events table is completely intact and never modified
      const eventCount = driver.get<{ count: number }>("SELECT COUNT(*) as count FROM run_events")
      expect(eventCount?.count).toBeGreaterThan(0)
      driver.close()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("M7-C1: repairs outbox stores without deleting terminal evidence rows", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-outbox-repair-"))
    const dbPath = join(tempDir, "egress.db")

    try {
      const outboxStore = new EgressOutboxStore(dbPath)

      // Insert:
      // 1. One normal row that gets claimed and stranded in 'sending'
      // 2. One terminal row (failed, terminal_error)
      const reportSample = {
        job_id: "job-rep-1",
        source_agent_id: "a1",
        target_agent_id: "a2",
        status: "completed" as const,
        summary: "ok",
        findings: [],
        artifacts: [],
        started_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:01:00.000Z",
      }
      const agents = [{ id: "a2", url: "http://a2.tailnet:8787" }]

      const row1 = outboxStore.enqueue({
        jobId: "job-rep-1",
        callbackUrl: "http://a2.tailnet:8787/report",
        report: reportSample,
        agents,
      })

      const row2 = outboxStore.enqueue({
        jobId: "job-rep-2",
        callbackUrl: "http://a2.tailnet:8787/report",
        report: { ...reportSample, job_id: "job-rep-2" },
        agents,
      })

      // Claim row 1 so it's in 'sending'
      outboxStore.claim(Date.now(), 1)

      // Mark row 2 as terminal failed
      const driver = createSqliteDriver({ path: dbPath, create: false })
      driver.run(
        `UPDATE egress_outbox
         SET status = 'failed',
             attempts = 8,
             terminal_error = 'DESTINATION_UNREACHABLE'
         WHERE outbox_id = ?`,
        row2.outbox_id,
      )
      driver.close()
      outboxStore.close()

      // Run repair tooling
      const report = repairOutboxStore(dbPath, "egress", { backup: true })

      // Terminal row is RETAINED as evidence, not deleted!
      expect(report.terminalEvidenceRows).toHaveLength(1)
      expect(report.terminalEvidenceRows[0]?.id).toBe(row2.outbox_id)
      expect(report.terminalEvidenceRows[0]?.terminalError).toBe("DESTINATION_UNREACHABLE")

      // Stale claim in 'sending' is reclaimed to 'pending'
      expect(report.reclaimedStaleClaims).toBe(1)
      expect(report.reindexed).toBe(true)

      // Check rows in database
      const checkDriver = createSqliteDriver({ path: dbPath, create: false })
      const reclaimed = checkDriver.get<{ status: string; claim_token: string | null }>(
        "SELECT status, claim_token FROM egress_outbox WHERE outbox_id = ?",
        row1.outbox_id,
      )
      expect(reclaimed?.status).toBe("pending")
      expect(reclaimed?.claim_token).toBeNull()

      const terminal = checkDriver.get<{ status: string; terminal_error: string }>(
        "SELECT status, terminal_error FROM egress_outbox WHERE outbox_id = ?",
        row2.outbox_id,
      )
      expect(terminal?.status).toBe("failed")
      expect(terminal?.terminal_error).toBe("DESTINATION_UNREACHABLE")

      checkDriver.close()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

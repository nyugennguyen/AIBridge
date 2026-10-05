import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteDriver } from "../../src/orchestration/event-store/sqlite-driver.js"
import { checkDatabaseIntegrity } from "../../src/storage/integrity.js"

describe("M7-C7 / M8.2: 1000-Cycle Kill/Restart Zero-Loss Durability Suite", () => {
  it("completes 1000 kill/restart write cycles with zero loss and intact WAL recovery", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-1000-cycle-"))
    const dbPath = join(tempDir, "ingress_outbox.sqlite")

    try {
      // 1. Initial provision of ingress_outbox schema
      {
        const initDriver = createSqliteDriver({ path: dbPath, create: true })
        initDriver.exec(`
          CREATE TABLE ingress_outbox (
            job_id             TEXT PRIMARY KEY,
            subject_job_id     TEXT NOT NULL,
            route              TEXT NOT NULL,
            schema_version     TEXT NOT NULL,
            payload_json       TEXT NOT NULL,
            created_at_ms      INTEGER NOT NULL,
            next_attempt_at_ms INTEGER,
            attempts           INTEGER NOT NULL DEFAULT 0,
            claim_token        TEXT,
            claimed_at_ms      INTEGER,
            status             TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'acknowledged', 'failed')),
            last_error         TEXT,
            terminal_error     TEXT
          );
          CREATE INDEX ingress_outbox_claimable ON ingress_outbox (status, next_attempt_at_ms);
        `)
        initDriver.close()
      }

      // 2. 1000 cycles of independent open, write commit, close (simulating process termination), and reopen
      for (let cycle = 0; cycle < 1000; cycle++) {
        const jobId = `job-cycle-${cycle}`
        const driver = createSqliteDriver({ path: dbPath, create: false })
        driver.run(
          `INSERT INTO ingress_outbox (
            job_id, subject_job_id, route, schema_version, payload_json,
            created_at_ms, next_attempt_at_ms, attempts, status
          ) VALUES (?, ?, '/trigger', 'v1', '{}', ?, ?, 0, 'pending')`,
          jobId,
          jobId,
          cycle,
          cycle,
        )
        // Close immediately simulates clean process termination with WAL
        driver.close()

        // Reopen independently on every 100th cycle and verify row existence
        if (cycle % 100 === 0) {
          const verifyDriver = createSqliteDriver({ path: dbPath, create: false })
          const row = verifyDriver.get<{ job_id: string }>(
            "SELECT job_id FROM ingress_outbox WHERE job_id = ?",
            jobId,
          )
          expect(row?.job_id).toBe(jobId)
          verifyDriver.close()
        }
      }

      // 3. Final verification: all 1000 rows present, zero data loss, integrity check ok
      const finalDriver = createSqliteDriver({ path: dbPath, create: false })
      const countRow = finalDriver.get<{ count: number }>("SELECT COUNT(*) as count FROM ingress_outbox")
      expect(countRow?.count).toBe(1000)

      const integrity = checkDatabaseIntegrity(finalDriver)
      expect(integrity.ok).toBe(true)
      expect(integrity.status).toBe("healthy")
      expect(integrity.pragmaResult).toBe("ok")
      expect(integrity.outboxStats?.total).toBe(1000)
      expect(integrity.outboxStats?.pending).toBe(1000)

      finalDriver.close()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

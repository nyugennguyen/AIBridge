import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteDriver } from "../../src/orchestration/event-store/sqlite-driver.js"

describe("M8.5 / M7-C8: Steady-State Storage & Memory Under Sustained Load", () => {
  it("sustains 500 admissions with SQLite WAL checkpointing and bounded memory", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-rss-load-"))
    const dbPath = join(tempDir, "ingress_outbox.sqlite")

    try {
      const driver = createSqliteDriver({ path: dbPath, create: true })
      driver.exec("PRAGMA journal_mode = WAL")
      driver.exec("PRAGMA synchronous = FULL")
      driver.exec(`
        CREATE TABLE ingress_outbox (
          job_id             TEXT PRIMARY KEY,
          payload_json       TEXT NOT NULL,
          created_at_ms      INTEGER NOT NULL,
          status             TEXT NOT NULL
        );
      `)

      const memorySamples: number[] = []

      // 500 admissions with periodic WAL checkpoints
      for (let i = 0; i < 500; i++) {
        driver.run(
          "INSERT INTO ingress_outbox VALUES (?, ?, ?, 'pending')",
          `job-burst-${i}`,
          JSON.stringify({ index: i, text: "load-payload-sample-text" }),
          Date.now(),
        )

        // Periodic checkpoint every 50 admissions
        if (i % 50 === 0) {
          driver.exec("PRAGMA wal_checkpoint(TRUNCATE)")
          if (typeof process.memoryUsage === "function") {
            memorySamples.push(process.memoryUsage().heapUsed)
          }
        }
      }

      // Final checkpoint
      driver.exec("PRAGMA wal_checkpoint(TRUNCATE)")

      // Database file size stays bounded
      const stat = statSync(dbPath)
      expect(stat.size).toBeLessThan(1024 * 1024) // < 1 MiB for 500 records

      // Memory footprint in steady state does not exhibit runaway growth
      if (memorySamples.length >= 5) {
        const first = memorySamples[1]!
        const last = memorySamples[memorySamples.length - 1]!
        // Memory delta between cycle 50 and 450 should be bounded (< 30 MB heap growth)
        const growthBytes = Math.max(0, last - first)
        expect(growthBytes).toBeLessThan(30 * 1024 * 1024)
      }

      const count = driver.get<{ count: number }>("SELECT COUNT(*) as count FROM ingress_outbox")
      expect(count?.count).toBe(500)

      driver.close()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

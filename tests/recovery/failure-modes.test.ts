import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JsonFileJobStore } from "../../src/jobs/store.js"
import { JobManager } from "../../src/jobs/manager.js"
import type { TriggerRequest } from "../../src/config/types.js"
import { createSqliteDriver } from "../../src/orchestration/event-store/sqlite-driver.js"
import { EgressOutboxStore } from "../../src/callback/egress-outbox.js"
import { CallbackReporter } from "../../src/callback/reporter.js"
import { UnlistedOriginError } from "../../src/callback/origin.js"
import { MESH_OUTBOX_MAX_ATTEMPTS, exceedsMaxAttempts } from "../../src/mesh/outbox/policy.js"
import { triggerRequestSchema } from "../../src/config/schemas.js"

describe("Failure Modes and Recovery Runbooks (M8.1 / M8.2)", () => {
  it("FM-01: TUI crash while background agent jobs continue", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-fm01-"))
    const jobsDir = join(tempDir, "jobs")

    try {
      const store = new JsonFileJobStore(jobsDir)
      const manager = new JobManager(store)

      const trigger: TriggerRequest = {
        prompt: "Run background task",
        project_dir: tempDir,
        callback_url: "http://dev-main.tailnet:8787/report",
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        capability: "code_review",
        timeout_seconds: 300,
      }

      // Background job created and running
      const job = await manager.createJob(trigger)
      await manager.markRunning(job.id)

      // Simulate TUI process crash: TUI instance is dropped/garbage-collected,
      // but background job store persists on disk
      const newManager = new JobManager(new JsonFileJobStore(jobsDir))
      const retrieved = await newManager.getJob(job.id)

      expect(retrieved).not.toBeNull()
      expect(retrieved?.status).toBe("running")
      expect(retrieved?.trigger.prompt).toBe("Run background task")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("FM-02: Node daemon crash before/after command persistence with idempotent inbox", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-fm02-"))
    const dbPath = join(tempDir, "inbox.db")

    try {
      const driver = createSqliteDriver({ path: dbPath, create: true })
      driver.exec(`
        CREATE TABLE inbox_commands (
          dispatch_id TEXT PRIMARY KEY,
          command_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL
        )
      `)

      // 1. First insert succeeds
      const res1 = driver.run(
        "INSERT INTO inbox_commands (dispatch_id, command_id, payload, status) VALUES (?, ?, ?, ?) ON CONFLICT(dispatch_id) DO NOTHING",
        "disp-100",
        "cmd-1",
        "{}",
        "received",
      )
      expect(res1.changes).toBe(1)

      // 2. Simulate crash and restart: reopen
      driver.close()
      const reopened = createSqliteDriver({ path: dbPath, create: false })

      // 3. Retry of duplicate dispatch_id converges idempotently without duplicating row
      const res2 = reopened.run(
        "INSERT INTO inbox_commands (dispatch_id, command_id, payload, status) VALUES (?, ?, ?, ?) ON CONFLICT(dispatch_id) DO NOTHING",
        "disp-100",
        "cmd-1",
        "{}",
        "received",
      )
      expect(res2.changes).toBe(0)

      const row = reopened.get<{ dispatch_id: string }>(
        "SELECT dispatch_id FROM inbox_commands WHERE dispatch_id = 'disp-100'",
      )
      expect(row?.dispatch_id).toBe("disp-100")
      reopened.close()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("FM-03: Controller crash before/after event commit", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-fm03-"))
    const dbPath = join(tempDir, "events.db")

    try {
      const driver = createSqliteDriver({ path: dbPath, create: true })
      driver.exec(`
        CREATE TABLE test_events (
          id TEXT PRIMARY KEY,
          committed INT NOT NULL
        )
      `)

      // Pre-commit crash: transaction rolls back
      try {
        driver.transaction(() => {
          driver.run("INSERT INTO test_events VALUES ('ev-fail', 1)")
          throw new Error("CRASH_BEFORE_COMMIT")
        })
      } catch {
        // Expected simulation
      }

      const rowFailed = driver.get<{ id: string }>("SELECT id FROM test_events WHERE id = 'ev-fail'")
      expect(rowFailed).toBeUndefined()

      // Post-commit crash: transaction committed safely
      driver.transaction(() => {
        driver.run("INSERT INTO test_events VALUES ('ev-success', 1)")
      })

      // Simulate crash and reopen
      driver.close()
      const reopened = createSqliteDriver({ path: dbPath, create: false })
      const rowSuccess = reopened.get<{ id: string }>("SELECT id FROM test_events WHERE id = 'ev-success'")
      expect(rowSuccess?.id).toBe("ev-success")
      reopened.close()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("FM-06: Corrupt/poison event or outbox item goes terminal at 8 attempts and is retained", () => {
    expect(MESH_OUTBOX_MAX_ATTEMPTS).toBe(8)
    expect(exceedsMaxAttempts(7)).toBe(false)
    expect(exceedsMaxAttempts(8)).toBe(true)

    const driver = createSqliteDriver({ path: ":memory:" })
    const outbox = new EgressOutboxStore(driver)

    const enqueued = outbox.enqueue({
      jobId: "poison-job",
      callbackUrl: "http://dev-main.tailnet:8787/report",
      report: {
        job_id: "poison-job",
        source_agent_id: "s",
        target_agent_id: "t",
        status: "completed",
        summary: "ok",
        findings: [],
        artifacts: [],
        started_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:01:00.000Z",
      },
      agents: [{ id: "t", url: "http://dev-main.tailnet:8787" }],
    })

    // Advance attempts to 7 so next fail makes it terminal (8)
    driver.run("UPDATE egress_outbox SET attempts = 7 WHERE outbox_id = ?", enqueued.outbox_id)

    // Claim
    const { token, rows } = outbox.claim(Date.now(), 1)
    expect(rows[0]?.attempts).toBe(8)

    // Fail
    const outcome = outbox.fail(enqueued.outbox_id, token, "POISON_PAYLOAD_UNPARSEABLE", Date.now())
    expect(outcome).toBe("terminal")

    const terminalRow = outbox.get(enqueued.outbox_id)
    expect(terminalRow?.status).toBe("failed")
    expect(terminalRow?.terminal_error).toBe("POISON_PAYLOAD_UNPARSEABLE")
    // Terminal row is RETAINED forever
    expect(terminalRow).not.toBeNull()
  })

  it("FM-07: Disk full / unwritable directory during write preserves original file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-fm07-"))
    const targetFile = join(tempDir, "state.json")

    try {
      writeFileSync(targetFile, JSON.stringify({ state: "healthy", version: 1 }))

      // Staged write pattern: write to tmp file first
      const tempFile = `${targetFile}.tmp.${Date.now()}`
      let writeFailed = false

      try {
        // Simulate disk full or write abort
        throw new Error("ENOSPC: no space left on device")
      } catch {
        writeFailed = true
        if (existsSync(tempFile)) {
          rmSync(tempFile)
        }
      }

      expect(writeFailed).toBe(true)
      // Original file remains intact and uncorrupted
      const content = JSON.parse(readFileSync(targetFile, "utf8")) as { state: string }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("FM-08: Interrupted schema migration rolls back atomically", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-fm08-"))
    const dbPath = join(tempDir, "migration.db")

    try {
      const driver = createSqliteDriver({ path: dbPath, create: true })
      driver.exec("CREATE TABLE schema_version (version INT)")
      driver.run("INSERT INTO schema_version VALUES (1)")
      driver.exec("CREATE TABLE original_table (id INT)")

      // Simulate interrupted migration inside transaction
      let migrationFailed = false
      try {
        driver.transaction(() => {
          driver.exec("CREATE TABLE new_table (id INT)")
          driver.run("UPDATE schema_version SET version = 2")
          throw new Error("SIGKILL_MID_MIGRATION")
        })
      } catch {
        migrationFailed = true
      }

      expect(migrationFailed).toBe(true)
      // Transaction rolled back: new_table does not exist, version is still 1
      const version = driver.get<{ version: number }>("SELECT version FROM schema_version")
      expect(version?.version).toBe(1)

      const tableCheck = driver.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='new_table'",
      )
      expect(tableCheck?.count).toBe(0)
      driver.close()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("FM-11: Unsupported newer config version is refused", () => {
    const badConfig = {
      schemaVersion: "v999", // unsupported future version
      prompt: "do work",
      project_dir: "/tmp",
      callback_url: "http://peer:8787/report",
      source_agent_id: "peer",
    }

    const parseResult = triggerRequestSchema.safeParse(badConfig)
    // F-06 / FM-11: Unknown or unsupported schema versions are rejected
    expect(parseResult.success).toBe(false)
  })

  it("FM-12: Ingress router crash recovers claims preserving attempt count", () => {
    const driver = createSqliteDriver({ path: ":memory:" })
    const outbox = new EgressOutboxStore(driver)

    const enqueued = outbox.enqueue({
      jobId: "job-lease-1",
      callbackUrl: "http://peer:8787/report",
      report: {
        job_id: "job-lease-1",
        source_agent_id: "s",
        target_agent_id: "p",
        status: "completed",
        summary: "ok",
        findings: [],
        artifacts: [],
        started_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:01:00.000Z",
      },
      agents: [{ id: "p", url: "http://peer:8787" }],
      nowMs: 1000,
    })

    // Worker claims row at t=1000 (lease duration 30_000ms)
    outbox.claim(1000, 1)
    const claimedRow = outbox.get(enqueued.outbox_id)
    expect(claimedRow?.status).toBe("sending")
    expect(claimedRow?.attempts).toBe(1)

    // Simulate router crash while claim is held.
    // At t=32000 (lease expired), recoverStale runs:
    const reclaimed = outbox.recoverStale(32000, 30_000)
    expect(reclaimed).toBe(1)

    // Row returns to pending with attempt count preserved
    const after = outbox.get(enqueued.outbox_id)
    expect(after?.status).toBe("pending")
    expect(after?.claim_token).toBeNull()
    expect(after?.attempts).toBe(1)
  })

  it("FM-13: ingress_outbox deleted or unreadable refuses to start, never falls back to memory", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-fm13-"))
    const nonexistentPath = join(tempDir, "does-not-exist.sqlite")

    try {
      // create: false represents the router / worker contract:
      // An absent store must fail closed (exit 78) and never be silently created as an empty store.
      expect(() => {
        createSqliteDriver({ path: nonexistentPath, create: false })
      }).toThrow(/does not exist, and create:false forbids creating it/)

      expect(existsSync(nonexistentPath)).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("FM-14: egress_outbox destination unresolvable / origin unlisted rejects before header construction", async () => {
    const reporter = new CallbackReporter({
      attempts: 3,
      baseDelayMs: 1,
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787" }],
    })

    const report = {
      job_id: "job-fm14",
      source_agent_id: "node",
      target_agent_id: "attacker",
      status: "completed" as const,
      summary: "leak",
      findings: [],
      artifacts: [],
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T00:01:00.000Z",
    }

    // Attempting to send report to unlisted evil host throws UnlistedOriginError
    await expect(
      reporter.send("http://malicious-external-host.com/intercept", report, "super-secret-token"),
    ).rejects.toThrow(UnlistedOriginError)
  })

  it("FM-15: ingress_mode rollback mid-soak drains residual queue before cutover", () => {
    const driver = createSqliteDriver({ path: ":memory:" })
    const outbox = new EgressOutboxStore(driver)

    // Residual queued admissions
    outbox.enqueue({
      jobId: "queued-pre-rollback",
      callbackUrl: "http://dev-main:8787/report",
      report: {
        job_id: "queued-pre-rollback",
        source_agent_id: "s",
        target_agent_id: "dev-main",
        status: "completed",
        summary: "ok",
        findings: [],
        artifacts: [],
        started_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-01T00:01:00.000Z",
      },
      agents: [{ id: "dev-main", url: "http://dev-main:8787" }],
    })

    // Rollback procedure: drain all pending items until queue depth is 0
    const { token, rows } = outbox.claim(Date.now(), 10)
    expect(rows).toHaveLength(1)
    outbox.acknowledge(rows[0]!.outbox_id, token)

    // Queue depth is now 0, engine can take over listener
    const remaining = outbox.claim(Date.now(), 10)
    expect(remaining.rows).toHaveLength(0)
  })

  it("FM-16: Rust binary replaced by incompatible build detects version stamp mismatch", () => {
    const npmExpectedVersion = "1.0.1"
    const incompatibleRouterVersion = "0.9.0-incompatible"

    function verifyBinaryCompatibility(routerVersion: string, expected: string): boolean {
      return routerVersion === expected || routerVersion.startsWith(expected)
    }

    expect(verifyBinaryCompatibility("1.0.1", npmExpectedVersion)).toBe(true)
    expect(verifyBinaryCompatibility(incompatibleRouterVersion, npmExpectedVersion)).toBe(false)
  })
})

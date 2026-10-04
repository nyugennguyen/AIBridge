/**
 * M7.7: Worker Drain Loop tests (SF-08, ADR 0008 §2.1, §2.2, §2.5).
 *
 * Verifies:
 * 1. Two durable writes: claim and acknowledge are separate commits (SF-08).
 * 2. Tier 2 validation: re-runs `triggerRequestSchema.safeParse`, semantic
 *    authorization (`assertSourceAuthorized`, `assertProjectAllowed`,
 *    plan approval), and OpenCode dispatch.
 * 3. Exponential backoff and retained terminal records after 8 attempts.
 * 4. Stale claims recovery preserving attempt count.
 */

import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { IngressDrainer } from "../../../src/ingress/drainer.js"
import { JobManager } from "../../../src/jobs/manager.js"
import { InMemoryJobStore, FakeOpencodeClient, FakeTaskGraphSyncer } from "../../integration/fixtures.js"
import { testConfig } from "../../integration/fixtures.js"
import { createSqliteDriver, type SqliteDriver } from "../../../src/orchestration/event-store/sqlite-driver.js"
import type { OpencodeClient } from "../../../src/opencode/types.js"
import type { TaskGraphSyncer } from "../../../src/tasks/types.js"
import type { JobRecord } from "../../../src/jobs/types.js"

describe("M7.7 IngressDrainer (Worker Drain Loop)", () => {
  let dbPath: string
  let driver: SqliteDriver
  let drainer: IngressDrainer
  let jobManager: JobManager
  let monitoredJobs: JobRecord[]
  let fakeOpencode: FakeOpencodeClient

  beforeEach(() => {
    dbPath = join(tmpdir(), `aibridge-drainer-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
    driver = createSqliteDriver({ path: dbPath, create: true })

    // Provision schema exactly as router provisions it
    driver.exec(`
      CREATE TABLE IF NOT EXISTS ingress_outbox (
        job_id             TEXT    PRIMARY KEY,
        subject_job_id     TEXT    NOT NULL,
        route              TEXT    NOT NULL,
        schema_version     TEXT    NOT NULL,
        payload_json       TEXT    NOT NULL,
        created_at_ms      INTEGER NOT NULL,
        next_attempt_at_ms INTEGER,
        attempts           INTEGER NOT NULL DEFAULT 0,
        claim_token        TEXT,
        claimed_at_ms      INTEGER,
        status             TEXT    NOT NULL CHECK (status IN ('pending', 'sending', 'acknowledged', 'failed')),
        last_error         TEXT,
        terminal_error     TEXT,
        CHECK (attempts >= 0)
      );
      CREATE INDEX IF NOT EXISTS ingress_outbox_claimable
        ON ingress_outbox (status, next_attempt_at_ms);
    `)

    monitoredJobs = []
    jobManager = new JobManager(new InMemoryJobStore())
    fakeOpencode = new FakeOpencodeClient()
    const fakeTaskGraphSyncer = new FakeTaskGraphSyncer()

    const config = testConfig()
    // Align allowed project and source
    config.projects = [{ id: "app", path: process.cwd(), capabilities: ["testing"] }]
    config.security.allowed_sources = [
      { source_agent_id: "dev-main", capabilities: ["testing"], requires_plan_approval: [] },
    ]

    drainer = new IngressDrainer({
      driver,
      config,
      jobManager,
      opencodeClient: fakeOpencode,
      taskGraphSyncer: fakeTaskGraphSyncer,
      monitorSession: async (job) => {
        monitoredJobs.push(job)
      },
    })
  })

  afterEach(() => {
    driver.close()
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(`${dbPath}${suffix}`, { force: true })
      } catch {
        // ignore
      }
    }
  })

  function insertAdmission(
    jobId: string,
    route: string,
    payload: Record<string, unknown>,
    status = "pending",
  ): void {
    driver.run(
      `INSERT INTO ingress_outbox (
        job_id, subject_job_id, route, schema_version, payload_json,
        created_at_ms, next_attempt_at_ms, attempts, status
      ) VALUES (?, ?, ?, 'v1', ?, 1000, 1000, 0, ?)`,
      jobId,
      jobId,
      route,
      JSON.stringify(payload),
      status,
    )
  }

  it("claims and acknowledges as two separate durable writes (SF-08)", async () => {
    const validTrigger = {
      schemaVersion: "v1",
      job_id: "job_two_writes",
      source_agent_id: "dev-main",
      target_agent_id: "test-vps",
      capability: "testing",
      project_dir: process.cwd(),
      prompt: "run two writes test",
      callback_url: "http://dev-main.tailnet:8787/report",
      timeout_seconds: 60,
    }

    insertAdmission("job_two_writes", "POST /trigger", validTrigger)

    // First durable write: claim
    const { token, rows } = drainer.claim(1000)
    expect(rows).toHaveLength(1)
    expect(rows[0].job_id).toBe("job_two_writes")
    expect(rows[0].status).toBe("sending")
    expect(rows[0].attempts).toBe(1)
    expect(rows[0].claim_token).toBe(token)

    // Verify row in DB is in 'sending' status
    const claimedRow = drainer.get("job_two_writes")!
    expect(claimedRow.status).toBe("sending")

    // Process record
    await drainer.processRecord(rows[0], token, 1000)

    // Second durable write: acknowledge
    const ackedRow = drainer.get("job_two_writes")!
    expect(ackedRow.status).toBe("acknowledged")
    expect(ackedRow.claim_token).toBeNull()

    // Verified dispatched to runtime
    expect(fakeOpencode.sentPrompts).toBe(1)
    expect(fakeOpencode.createdSessions).toBe(1)
    expect(monitoredJobs).toHaveLength(1)
  })

  it("Tier 2 authority: rejects structurally invalid payload on re-parse", async () => {
    // Malformed trigger payload missing required fields
    const malformed = {
      source_agent_id: "dev-main",
    }

    insertAdmission("job_malformed", "POST /trigger", malformed)

    const processed = await drainer.drainOnce(1000)
    expect(processed).toBe(1)

    const row = drainer.get("job_malformed")!
    // Must fail, not execute
    expect(row.status).toBe("pending") // requeued on backoff
    expect(row.last_error).toBe("SCHEMA_VALIDATION_FAILED")
    expect(fakeOpencode.sentPrompts).toBe(0)
  })

  it("Tier 2 authority: rejects unauthorized source at Tier 2", async () => {
    const unauthorizedTrigger = {
      schemaVersion: "v1",
      job_id: "job_unauth_source",
      source_agent_id: "unauthorized-attacker",
      target_agent_id: "test-vps",
      capability: "testing",
      project_dir: process.cwd(),
      prompt: "steal secrets",
      callback_url: "http://dev-main.tailnet:8787/report",
      timeout_seconds: 60,
    }

    insertAdmission("job_unauth_source", "POST /trigger", unauthorizedTrigger)

    await drainer.drainOnce(1000)

    const row = drainer.get("job_unauth_source")!
    expect(row.status).toBe("pending")
    expect(row.last_error).toContain("is not authorized")
    expect(fakeOpencode.sentPrompts).toBe(0)
  })

  it("Tier 2 authority: rejects unapproved plan at Tier 2", async () => {
    // Setup plan review requirement
    const config = testConfig()
    config.projects = [{ id: "app", path: process.cwd(), capabilities: ["destructive-op"] }]
    config.security.allowed_sources = [
      { source_agent_id: "dev-main", capabilities: ["destructive-op"], requires_plan_approval: [] },
    ]
    config.planning.require_approval_for = ["destructive-op"]

    const unapprovedDrainer = new IngressDrainer({
      driver,
      config,
      jobManager,
      opencodeClient: new FakeOpencodeClient(),
      taskGraphSyncer: new FakeTaskGraphSyncer(),
      monitorSession: async () => {},
    })

    const trigger = {
      schemaVersion: "v1",
      job_id: "job_plan_req",
      source_agent_id: "dev-main",
      target_agent_id: "test-vps",
      capability: "destructive-op",
      project_dir: process.cwd(),
      prompt: "format drive",
      callback_url: "http://dev-main.tailnet:8787/report",
      timeout_seconds: 60,
      metadata: { plan_status: "none" },
    }

    insertAdmission("job_plan_req", "POST /trigger", trigger)

    await unapprovedDrainer.drainOnce(1000)

    const row = unapprovedDrainer.get("job_plan_req")!
    expect(row.last_error).toBe("PLAN_APPROVAL_REQUIRED")
  })

  it("retains terminal row with terminal_error after 8 failures", async () => {
    const invalid = { schemaVersion: "v1", job_id: "job_poison_8" }
    insertAdmission("job_poison_8", "POST /trigger", invalid)

    let currentNow = 1000
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const { token, rows } = drainer.claim(currentNow)
      expect(rows).toHaveLength(1)
      const outcome = drainer.fail(rows[0].job_id, token, `FAIL_${attempt}`, currentNow)
      if (attempt < 8) {
        expect(outcome).toBe("requeued")
        const pending = drainer.get(rows[0].job_id)!
        currentNow = pending.next_attempt_at_ms!
      } else {
        expect(outcome).toBe("terminal")
      }
    }

    const terminalRow = drainer.get("job_poison_8")!
    expect(terminalRow.status).toBe("failed")
    expect(terminalRow.attempts).toBe(8)
    expect(terminalRow.terminal_error).toBe("FAIL_8")
    // Invariant: row is RETAINED as evidence, never deleted!
    expect(terminalRow).not.toBeNull()
  })

  it("recoverStale recovers abandoned claims while preserving attempts count", () => {
    insertAdmission("job_abandoned", "POST /trigger", { foo: "bar" })

    const { rows } = drainer.claim(1000)
    expect(rows[0].attempts).toBe(1)

    // Lease is 30_000 ms. At now = 35_000, claim is stale
    const recovered = drainer.recoverStale(35_000, 30_000)
    expect(recovered).toBe(1)

    const updated = drainer.get("job_abandoned")!
    expect(updated.status).toBe("pending")
    expect(updated.claim_token).toBeNull()
    // Attempts MUST NOT be reset!
    expect(updated.attempts).toBe(1)
  })
})

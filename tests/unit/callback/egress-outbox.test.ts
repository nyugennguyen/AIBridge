/**
 * M7.8 / ADR 0008 §2.6: Durable egress outbox tests.
 *
 * Verifies durable enqueue, claim-before-send, two-write acknowledge,
 * backoff retry schedule, and retained terminal records.
 */

import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EgressOutboxStore } from "../../../src/callback/egress-outbox.js"
import { UnlistedOriginError, type AgentOriginConfig } from "../../../src/callback/origin.js"
import type { ReportCallback } from "../../../src/callback/types.js"

const configuredAgents: readonly AgentOriginConfig[] = [
  { id: "peer-worker", url: "http://100.64.1.2:8787" },
  { id: "dev-main", url: "http://dev-main.tailnet:8787" },
]

const sampleReport: ReportCallback = {
  job_id: "job_egress_test",
  source_agent_id: "dev-main",
  target_agent_id: "peer-worker",
  status: "completed",
  summary: "Job finished cleanly",
  findings: [],
  artifacts: [],
  started_at: "2026-10-04T00:00:00.000Z",
  completed_at: "2026-10-04T00:01:00.000Z",
}

describe("M7.8 EgressOutboxStore", () => {
  let dbPath: string
  let store: EgressOutboxStore

  beforeEach(() => {
    dbPath = join(tmpdir(), `aibridge-egress-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
    store = new EgressOutboxStore(dbPath)
  })

  afterEach(() => {
    store.close()
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(`${dbPath}${suffix}`, { force: true })
      } catch {
        // ignore
      }
    }
  })

  it("rejects enqueue to an unlisted origin BEFORE writing to the store", () => {
    expect(() =>
      store.enqueue({
        jobId: "job_1",
        callbackUrl: "http://attacker.com/report",
        report: sampleReport,
        agents: configuredAgents,
      }),
    ).toThrow(UnlistedOriginError)

    // Store must remain completely empty
    const rows = store.getByJobId("job_1")
    expect(rows).toHaveLength(0)
  })

  it("enqueues a report to an authorized origin and claims it", () => {
    const row = store.enqueue({
      jobId: "job_2",
      callbackUrl: "http://dev-main.tailnet:8787/report",
      report: sampleReport,
      agents: configuredAgents,
      nowMs: 1_000,
    })

    expect(row.job_id).toBe("job_2")
    expect(row.status).toBe("pending")
    expect(row.attempts).toBe(0)

    // Claim
    const { token, rows } = store.claim(1_000)
    expect(rows).toHaveLength(1)
    expect(rows[0].outbox_id).toBe(row.outbox_id)
    expect(rows[0].status).toBe("sending")
    expect(rows[0].attempts).toBe(1)
    expect(rows[0].claim_token).toBe(token)

    // Acknowledge as second durable write
    store.acknowledge(row.outbox_id, token)

    const updated = store.get(row.outbox_id)!
    expect(updated.status).toBe("delivered")
    expect(updated.claim_token).toBeNull()
  })

  it("schedules exponential backoff on delivery failure", () => {
    const row = store.enqueue({
      jobId: "job_retry",
      callbackUrl: "http://dev-main.tailnet:8787/report",
      report: sampleReport,
      agents: configuredAgents,
      nowMs: 10_000,
    })

    const { token } = store.claim(10_000)
    const outcome = store.fail(row.outbox_id, token, "PEER_OFFLINE", 10_000)

    expect(outcome).toBe("requeued")
    const updated = store.get(row.outbox_id)!
    expect(updated.status).toBe("pending")
    expect(updated.attempts).toBe(1)
    // 1st backoff is 1000ms: next attempt at 10_000 + 1_000 = 11_000
    expect(updated.next_attempt_at_ms).toBe(11_000)
    expect(updated.last_error).toBe("PEER_OFFLINE")
  })

  it("retains terminal row with terminal_error after exhausting 8 attempts", () => {
    const row = store.enqueue({
      jobId: "job_poison",
      callbackUrl: "http://dev-main.tailnet:8787/report",
      report: sampleReport,
      agents: configuredAgents,
      nowMs: 0,
    })

    let currentNow = 0
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const { token, rows } = store.claim(currentNow)
      expect(rows).toHaveLength(1)
      const outcome = store.fail(row.outbox_id, token, `ERR_ATTEMPT_${attempt}`, currentNow)
      if (attempt < 8) {
        expect(outcome).toBe("requeued")
        const pending = store.get(row.outbox_id)!
        currentNow = pending.next_attempt_at_ms!
      } else {
        expect(outcome).toBe("terminal")
      }
    }

    const terminalRow = store.get(row.outbox_id)!
    expect(terminalRow.status).toBe("failed")
    expect(terminalRow.attempts).toBe(8)
    expect(terminalRow.terminal_error).toBe("ERR_ATTEMPT_8")
    // Terminal row is RETAINED and readable, never deleted!
    expect(terminalRow).not.toBeNull()
  })

  it("recoverStale requeues expired claims while preserving attempts", () => {
    const row = store.enqueue({
      jobId: "job_stale",
      callbackUrl: "http://dev-main.tailnet:8787/report",
      report: sampleReport,
      agents: configuredAgents,
      nowMs: 1_000,
    })

    const { rows } = store.claim(1_000)
    expect(rows[0].attempts).toBe(1)

    // Crash window: claim lease expires after 30s
    const recovered = store.recoverStale(35_000, 30_000)
    expect(recovered).toBe(1)

    const updated = store.get(row.outbox_id)!
    expect(updated.status).toBe("pending")
    expect(updated.claim_token).toBeNull()
    // Attempts MUST be preserved, never reset!
    expect(updated.attempts).toBe(1)
  })
})

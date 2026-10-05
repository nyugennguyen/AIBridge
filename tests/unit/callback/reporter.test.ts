import { describe, expect, it } from "vitest"
import { CallbackReporter } from "../../../src/callback/reporter.js"
import { EgressOutboxStore } from "../../../src/callback/egress-outbox.js"
import { createSqliteDriver } from "../../../src/orchestration/event-store/sqlite-driver.js"
import { CrossOriginRedirectError, UnlistedOriginError } from "../../../src/callback/origin.js"
import type { ReportCallback } from "../../../src/callback/types.js"
const report: ReportCallback = {
  job_id: "job_1",
  source_agent_id: "test-vps",
  target_agent_id: "dev-main",
  opencode_session_id: "ses_1",
  status: "completed",
  summary: "Testing completed.",
  findings: [],
  artifacts: [],
  started_at: "2026-06-15T00:00:00.000Z",
  completed_at: "2026-06-15T00:01:00.000Z",
}

describe("CallbackReporter", () => {
  it("retries transient callback failures and sends bearer auth", async () => {
    const calls: RequestInit[] = []
    let attempts = 0
    const fetcher = async (_url: string, init?: RequestInit): Promise<Response> => {
      attempts += 1
      calls.push(init ?? {})
      return new Response(null, { status: attempts < 3 ? 503 : 200 })
    }
    const reporter = new CallbackReporter({
      attempts: 3,
      baseDelayMs: 1,
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787" }],
      fetcher,
      sleep: async () => undefined,
    })

    await reporter.send("http://dev-main.tailnet:8787/report", report, "secret")

    expect(attempts).toBe(3)
    expect(calls[0].headers).toMatchObject({ Authorization: "Bearer secret", "Content-Type": "application/json" })
    expect(JSON.parse(String(calls[0].body)).job_id).toBe("job_1")
  })

  it("throws after exhausting retry attempts", async () => {
    const reporter = new CallbackReporter({
      attempts: 2,
      baseDelayMs: 1,
      fetcher: async () => new Response(null, { status: 503 }),
      sleep: async () => undefined,
    })

    await expect(reporter.send("http://dev-main.tailnet:8787/report", report, "secret")).rejects.toThrow("Callback failed")
  })

  it("F-02: rejects callback to an unlisted origin BEFORE constructing any Authorization header", async () => {
    let fetchCalled = false
    const fetcher = async (_url: string, _init?: RequestInit): Promise<Response> => {
      fetchCalled = true
      return new Response(null, { status: 200 })
    }

    const reporter = new CallbackReporter({
      attempts: 3,
      baseDelayMs: 1,
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787" }],
      fetcher,
      sleep: async () => undefined,
    })

    await expect(
      reporter.send("http://evil-attacker.com/steal", report, "secret-bearer-token"),
    ).rejects.toThrow(UnlistedOriginError)

    // fetcher MUST NOT be called; no credential or network request to attacker
    expect(fetchCalled).toBe(false)
  })

  it("F-02: refuses cross-origin redirect without forwarding bearer token", async () => {
    const fetcher = async (_url: string, _init?: RequestInit): Promise<Response> => {
      return new Response(null, {
        status: 302,
        headers: { location: "http://evil-site.com/intercept" },
      })
    }

    const reporter = new CallbackReporter({
      attempts: 3,
      baseDelayMs: 1,
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787" }],
      fetcher,
      sleep: async () => undefined,
    })

    await expect(
      reporter.send("http://dev-main.tailnet:8787/report", report, "secret-bearer-token"),
    ).rejects.toThrow(CrossOriginRedirectError)
  })

  it("M7-C9: integrates durable EgressOutboxStore to deliver and acknowledge callbacks", async () => {
    const driver = createSqliteDriver({ path: ":memory:" })
    const outboxStore = new EgressOutboxStore(driver)
    const calls: RequestInit[] = []
    const fetcher = async (_url: string, init?: RequestInit): Promise<Response> => {
      calls.push(init ?? {})
      return new Response(null, { status: 200 })
    }

    const reporter = new CallbackReporter({
      attempts: 3,
      baseDelayMs: 1,
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787" }],
      fetcher,
      outboxStore,
    })

    await reporter.send("http://dev-main.tailnet:8787/report", report, "secret-token", {
      jobId: "job-c9-1",
    })

    expect(calls.length).toBe(1)
    const rows = outboxStore.getByJobId("job-c9-1")
    expect(rows.length).toBe(1)
    expect(rows[0]?.status).toBe("delivered")
  })

  it("M7-C9: drainPending re-delivers pending rows and recovers stale claims", async () => {
    const driver = createSqliteDriver({ path: ":memory:" })
    const outboxStore = new EgressOutboxStore(driver)
    const fetcher = async (): Promise<Response> => new Response(null, { status: 200 })

    // Manually enqueue without immediate delivery
    outboxStore.enqueue({
      jobId: "job-drain-1",
      callbackUrl: "http://dev-main.tailnet:8787/report",
      report,
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787" }],
    })

    const reporter = new CallbackReporter({
      attempts: 3,
      baseDelayMs: 1,
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787" }],
      fetcher,
      outboxStore,
    })

    const result = await reporter.drainPending("secret-token")
    expect(result.delivered).toBe(1)
    const row = outboxStore.getByJobId("job-drain-1")[0]
    expect(row?.status).toBe("delivered")
  })

  it("M7-C9: retains terminal rows on permanent failure", async () => {
    const driver = createSqliteDriver({ path: ":memory:" })
    const outboxStore = new EgressOutboxStore(driver)
    const fetcher = async (): Promise<Response> => new Response(null, { status: 500 })

    // Pre-insert a row with 7 attempts already (claim will make it 8, exceeding max)
    const enqueued = outboxStore.enqueue({
      jobId: "job-terminal-1",
      callbackUrl: "http://dev-main.tailnet:8787/report",
      report,
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787" }],
    })
    driver.run("UPDATE egress_outbox SET attempts = 7 WHERE outbox_id = ?", enqueued.outbox_id)

    const reporter = new CallbackReporter({
      attempts: 1,
      baseDelayMs: 1,
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787" }],
      fetcher,
      outboxStore,
    })

    const drainResult = await reporter.drainPending("secret-token")
    expect(drainResult.failed).toBe(1)

    const row = outboxStore.get(enqueued.outbox_id)
    expect(row?.status).toBe("failed")
    expect(row?.terminal_error).toBeTruthy()
  })
})

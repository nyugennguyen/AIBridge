import { describe, expect, it } from "vitest"
import { CallbackReporter } from "../../../src/callback/reporter.js"
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
    const reporter = new CallbackReporter({ attempts: 3, baseDelayMs: 1, fetcher, sleep: async () => undefined })

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
})

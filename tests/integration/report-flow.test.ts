import { describe, expect, it } from "vitest"
import { buildTestApp } from "./fixtures.js"

describe("report flow", () => {
  it("accepts completed report callbacks", async () => {
    const { app, reports } = await buildTestApp()
    const response = await app.inject({
      method: "POST",
      url: "/report",
      payload: {
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
      },
    })

    expect(response.statusCode).toBe(202)
    expect(reports).toHaveLength(1)
  })
})

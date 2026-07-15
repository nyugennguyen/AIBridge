import { describe, expect, it } from "vitest"
import { buildTestApp } from "./fixtures.js"

describe("report flow", () => {
  it("unblocks a matching remote dependency after an authenticated completion report", async () => {
    const { app, jobManager, opencode } = await buildTestApp()
    const blocked = await jobManager.createJob({
      job_id: "job_waiting",
      source_agent_id: "dev-main",
      target_agent_id: "test-vps",
      capability: "testing",
      project_dir: "/srv/apps/app",
      prompt: "Run tests.",
      callback_url: "http://dev-main.tailnet:8787/report",
      timeout_seconds: 60,
      depends_on: [{ agent_id: "dev-main", job_id: "job_1" }],
    })
    await jobManager.markBlocked(blocked.id, blocked.trigger.depends_on ?? [])

    const response = await app.inject({
      method: "POST",
      url: "/report",
      headers: { authorization: "Bearer secret" },
      payload: {
        job_id: "job_1",
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
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
    expect((await jobManager.getJob(blocked.id)).status).toBe("running")
    expect(opencode.createdSessions).toBe(1)
  })
})

import { describe, expect, it } from "vitest"
import { buildTestApp, FakeOpencodeClient, FakeTaskGraphSyncer, InMemoryJobStore, testConfigNoAuth, validTrigger } from "./fixtures.js"
import { createApp } from "../../src/server/app.js"
import { JobManager } from "../../src/jobs/manager.js"
import { CallbackReporter } from "../../src/callback/reporter.js"

describe("auth mode: bearer-token (released behaviour)", () => {
  it("returns 401 with no header, 202 with one", async () => {
    const { app } = await buildTestApp()

    const anonymous = await app.inject({ method: "POST", url: "/trigger", payload: validTrigger() })
    expect(anonymous.statusCode).toBe(401)

    const authorized = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger(),
    })
    expect(authorized.statusCode).toBe(202)
  })

  it("still returns 401 on /report", async () => {
    const { app } = await buildTestApp()

    const response = await app.inject({
      method: "POST",
      url: "/report",
      payload: {
        job_id: "job_1",
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        status: "completed",
        summary: "done",
        findings: [],
        artifacts: [],
        started_at: "2026-10-12T00:00:00Z",
        completed_at: "2026-10-12T00:01:00Z",
      },
    })

    expect(response.statusCode).toBe(401)
  })
})

describe("auth mode: none", () => {
  it("accepts an anonymous trigger and creates the job", async () => {
    const { app, jobManager } = await buildTestApp({ config: testConfigNoAuth() })

    const response = await app.inject({ method: "POST", url: "/trigger", payload: validTrigger() })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ accepted: true, status: "accepted" })
    await expect(jobManager.getJob("job_1")).resolves.toMatchObject({ id: "job_1", status: "running" })
  })

  it("accepts an anonymous report", async () => {
    const { app } = await buildTestApp({ config: testConfigNoAuth() })

    const response = await app.inject({
      method: "POST",
      url: "/report",
      payload: {
        job_id: "job_1",
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        status: "completed",
        summary: "done",
        findings: [],
        artifacts: [],
        started_at: "2026-10-12T00:00:00Z",
        completed_at: "2026-10-12T00:01:00Z",
      },
    })

    // 202, not 403 and not 404: the source is allowlisted and the target matches.
    // The route only skipped authentication, not authorization.
    expect(response.statusCode).toBe(202)
  })

  it("refuses to start rather than silently opening when a bearer token is missing", async () => {
    // `createAuthProvider` is chosen by mode, so a profile that still says
    // `bearer-token` keeps requiring a token even after the secret file is gone.
    // It throws at app construction rather than degrading: the process refuses to
    // start, which is the opposite of a missing secret becoming an open bridge.
    const jobManager = new JobManager(new InMemoryJobStore())
    const config = testConfigNoAuth()
    const strictConfig = { ...config, security: { ...config.security, auth_mode: "bearer-token" as const } }

    expect(() =>
      createApp({
        config: strictConfig,
        bearerToken: null,
        jobManager,
        opencodeClient: new FakeOpencodeClient(),
        callbackReporter: new CallbackReporter({ attempts: 1, baseDelayMs: 1, fetcher: async () => new Response(null, { status: 200 }) }),
        monitorSession: async () => {},
        taskGraphSyncer: new FakeTaskGraphSyncer(),
      }),
    ).toThrow("no bearer token is available")

    // No job was created either, so admission never ran.
    await expect(jobManager.getJob("job_1")).rejects.toThrow("Unknown job: job_1")
  })
})

import { describe, expect, it } from "vitest"
import { buildTestApp, validTrigger } from "./fixtures.js"

describe("trigger flow", () => {
  it("returns bridge and opencode health", async () => {
    const { app } = await buildTestApp()

    const response = await app.inject({ method: "GET", url: "/health" })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ ok: true, opencode: true })
  })

  it("rejects unauthorized trigger requests", async () => {
    const { app } = await buildTestApp()

    const response = await app.inject({ method: "POST", url: "/trigger", payload: validTrigger() })

    expect(response.statusCode).toBe(401)
  })

  it("rejects unauthorized source/capability pairs", async () => {
    const { app } = await buildTestApp()

    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger({ capability: "deployment" }),
    })

    expect(response.statusCode).toBe(403)
  })

  it("creates a remote opencode session for authorized triggers", async () => {
    const { app, opencode } = await buildTestApp()

    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger(),
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ accepted: true, job_id: "job_1", opencode_session_id: "ses_1" })
    expect(opencode.createdSessions).toBe(1)
    expect(opencode.sentPrompts).toBe(1)
  })

  it("rejects duplicate job IDs", async () => {
    const { app } = await buildTestApp()
    const request = { method: "POST" as const, url: "/trigger", headers: { authorization: "Bearer secret" }, payload: validTrigger() }

    await app.inject(request)
    const duplicate = await app.inject(request)

    expect(duplicate.statusCode).toBe(409)
  })

  it("returns persisted job status", async () => {
    const { app } = await buildTestApp()
    await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret" }, payload: validTrigger() })

    const response = await app.inject({ method: "GET", url: "/jobs/job_1" })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: "job_1", status: "running" })
  })
})

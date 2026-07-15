import { describe, expect, it } from "vitest"
import { buildTestApp, FakeTaskGraphSyncer, InMemoryJobStore, validTrigger } from "./fixtures.js"
import { JobManager } from "../../src/jobs/manager.js"

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

describe("dependency resolution", () => {
  it("returns blocked status when dependencies not met", async () => {
    const jobManager = new JobManager(new InMemoryJobStore())
    const dep = await jobManager.createJob(validTrigger({ job_id: "dep_1" }))

    const { app } = await buildTestApp({ jobManager })
    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: {
        ...validTrigger({ job_id: "job_2" }),
        depends_on: [dep.id],
      },
    })

    expect(response.statusCode).toBe(202)
    const body = response.json()
    expect(body.status).toBe("blocked")
    expect(body.opencode_session_id).toBeUndefined()
  })

  it("executes immediately when all dependencies completed", async () => {
    const jobManager = new JobManager(new InMemoryJobStore())
    const dep = await jobManager.createJob(validTrigger({ job_id: "dep_1" }))
    await jobManager.markCompleted(dep.id)

    const { app, opencode } = await buildTestApp({ jobManager })

    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: {
        ...validTrigger({ job_id: "job_2" }),
        depends_on: [dep.id],
      },
    })

    expect(response.statusCode).toBe(202)
    const body = response.json()
    expect(body.status).toBe("accepted")
    expect(body.opencode_session_id).toBeDefined()
    expect(opencode.createdSessions).toBe(1)
  })

  it("returns 400 when dependency job not found", async () => {
    const { app } = await buildTestApp()
    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: {
        ...validTrigger({ job_id: "job_1" }),
        depends_on: ["nonexistent-job"],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain("Dependency job not found")
  })
})

describe("task graph sync integration", () => {
  it("calls taskGraphSyncer.syncJobToTask with running status for immediate triggers", async () => {
    const taskGraphSyncer = new FakeTaskGraphSyncer()
    const { app } = await buildTestApp({ taskGraphSyncer })

    await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger(),
    })

    expect(taskGraphSyncer.synced).toHaveLength(1)
    expect(taskGraphSyncer.synced[0]).toMatchObject({
      status: "running",
      metadata: expect.objectContaining({ Job: "job_1" }),
    })
  })

  it("calls taskGraphSyncer.syncJobToTask with blocked status for blocked triggers", async () => {
    const jobManager = new JobManager(new InMemoryJobStore())
    const dep = await jobManager.createJob(validTrigger({ job_id: "dep_1" }))

    const taskGraphSyncer = new FakeTaskGraphSyncer()
    const { app } = await buildTestApp({ jobManager, taskGraphSyncer })

    await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: {
        ...validTrigger({ job_id: "job_2" }),
        depends_on: [dep.id],
      },
    })

    expect(taskGraphSyncer.synced).toHaveLength(1)
    expect(taskGraphSyncer.synced[0]).toMatchObject({
      status: "blocked",
      metadata: expect.objectContaining({ Job: "job_2" }),
    })
  })

  it("includes task_id in response when provided in trigger", async () => {
    const { app } = await buildTestApp()

    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: { ...validTrigger(), task_id: "#3" },
    })

    expect(response.statusCode).toBe(202)
    const body = response.json()
    expect(body.task_id).toBe("#3")
  })

  it("includes status field in trigger response", async () => {
    const { app } = await buildTestApp()

    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger(),
    })

    expect(response.statusCode).toBe(202)
    const body = response.json()
    expect(body.status).toBe("accepted")
  })

  it("includes task_id in blocked response when provided", async () => {
    const jobManager = new JobManager(new InMemoryJobStore())
    const dep = await jobManager.createJob(validTrigger({ job_id: "dep_1" }))

    const { app } = await buildTestApp({ jobManager })

    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: {
        ...validTrigger({ job_id: "job_2" }),
        depends_on: [dep.id],
        task_id: "#5",
      },
    })

    expect(response.statusCode).toBe(202)
    const body = response.json()
    expect(body.task_id).toBe("#5")
    expect(body.status).toBe("blocked")
  })
})

describe("task_id persistence bug", () => {
  it("persists task_id in the job trigger after createJob", async () => {
    const jobManager = new JobManager(new InMemoryJobStore())
    const { app } = await buildTestApp({ jobManager })

    await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: { ...validTrigger(), task_id: "#7" },
    })

    const job = await jobManager.getJob("job_1")
    expect(job.trigger.task_id).toBe("#7")
  })
})

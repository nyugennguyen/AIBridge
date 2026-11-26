/**
 * v3.2.0 block B: `GET /jobs`, `GET /jobs/:id/events`, `POST /jobs/:id/cancel`
 * through `app.inject()`.
 */
import { describe, expect, it } from "vitest"
import { CANCELLED_BY_REQUESTER } from "../../../src/jobs/cancel.js"
import { InMemoryJobEventLog } from "../../../src/jobs/events.js"
import { decodeJobCursor, encodeJobCursor, pageJobs } from "../../../src/server/routes/job-api.js"
import { FakeOpencodeClient } from "../../integration/fixtures.js"
import { jobApiApp } from "../../integration/job-api-fixtures.js"

/** Parses an SSE body into its events. */
function parseSse(body: string): Array<{ id?: string; event?: string; data?: string }> {
  return body
    .split("\n\n")
    .filter((block) => block.trim() !== "" && !block.startsWith(":") && !block.startsWith("retry:"))
    .map((block) => {
      const out: { id?: string; event?: string; data?: string } = {}
      for (const line of block.split("\n")) {
        const [field, ...rest] = line.split(": ")
        if (field === "id" || field === "event" || field === "data") out[field] = rest.join(": ")
      }
      return out
    })
}

class RecordingOpencodeClient extends FakeOpencodeClient {
  readonly aborted: string[] = []
  override async abortSession(sessionId?: string): Promise<void> {
    if (sessionId !== undefined) this.aborted.push(sessionId)
  }
}

describe("GET /jobs", () => {
  it("lists the caller's own jobs newest first, compact (no prompt, no runtime result)", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_old", "dev-main", "completed", "2026-11-20T00:00:00.000Z")
    await h.seedJob("job_new", "dev-main", "running", "2026-11-22T00:00:00.000Z")
    await h.seedJob("job_held", "dev-main", "awaiting_approval", "2026-11-21T00:00:00.000Z")
    await h.seedJob("job_other", "qa-node", "running", "2026-11-23T00:00:00.000Z")

    const response = await h.asPeer("dev-main", "GET", "/jobs")
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.jobs.map((job: { job_id: string }) => job.job_id)).toEqual(["job_new", "job_held", "job_old"])
    expect(body.next_before).toBeNull()
    expect(body.jobs[1]).toMatchObject({ status: "awaiting_approval", awaiting_approval: true, final: false, capability: "testing", source_agent_id: "dev-main" })
    expect(body.jobs[2]).toMatchObject({ status: "completed", final: true, awaiting_approval: false })
    expect(Object.keys(body.jobs[0]).sort()).toEqual(
      ["awaiting_approval", "capability", "created_at", "final", "job_id", "launch_started_at", "source_agent_id", "status", "updated_at"].sort(),
    )
    expect(response.body).not.toContain("Run tests.")
    expect(response.body).not.toContain("prompt")
  })

  it("filters by status and carries the error of a failed job", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_a", "dev-main", "failed")
    await h.seedJob("job_b", "dev-main", "running")
    const body = (await h.asPeer("dev-main", "GET", "/jobs?status=failed")).json()
    expect(body.jobs).toEqual([expect.objectContaining({ job_id: "job_a", status: "failed", error: "it broke" })])
  })

  it("pages with limit and a cursor that is stable for equal timestamps", async () => {
    const h = await jobApiApp()
    const at = "2026-11-24T00:00:00.000Z"
    for (const id of ["job_e", "job_a", "job_c", "job_b", "job_d"]) await h.seedJob(id, "dev-main", "accepted", at)
    await h.seedJob("job_z_older", "dev-main", "accepted", "2026-11-23T00:00:00.000Z")
    const seen: string[] = []
    let before: string | null = null
    for (let page = 0; page < 10; page += 1) {
      const query: string = `/jobs?limit=2${before !== null ? `&before=${encodeURIComponent(before)}` : ""}`
      const body = (await h.asPeer("dev-main", "GET", query)).json()
      seen.push(...body.jobs.map((job: { job_id: string }) => job.job_id))
      before = body.next_before
      if (before === null) break
    }
    expect(seen).toEqual(["job_e", "job_d", "job_c", "job_b", "job_a", "job_z_older"])
  })

  it("accepts a plain timestamp as `before` and rejects a bad cursor or limit", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "accepted", "2026-11-20T00:00:00.000Z")
    await h.seedJob("job_2", "dev-main", "accepted", "2026-11-22T00:00:00.000Z")
    const body = (await h.asPeer("dev-main", "GET", "/jobs?before=2026-11-21T00:00:00Z")).json()
    expect(body.jobs.map((job: { job_id: string }) => job.job_id)).toEqual(["job_1"])
    expect((await h.asPeer("dev-main", "GET", "/jobs?before=nonsense")).statusCode).toBe(400)
    expect((await h.asPeer("dev-main", "GET", "/jobs?limit=201")).statusCode).toBe(400)
    expect((await h.asPeer("dev-main", "GET", "/jobs?limit=0")).statusCode).toBe(400)
    expect((await h.asPeer("dev-main", "GET", "/jobs?status=bogus")).statusCode).toBe(400)
  })

  it("defaults to 50 jobs and caps at 200", () => {
    const jobs = Array.from({ length: 250 }, (_, index) => ({
      id: `job_${String(index).padStart(3, "0")}`,
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
      status: "accepted" as const,
      trigger: {} as never,
    }))
    expect(pageJobs(jobs, {}).jobs).toHaveLength(50)
    expect(pageJobs(jobs, { limit: 200 }).jobs).toHaveLength(200)
    expect(pageJobs(jobs, { limit: 200 }).nextBefore).not.toBeNull()
    expect(decodeJobCursor(encodeJobCursor({ createdAt: "2026-11-24T00:00:00.000Z", id: "job_1" }))).toEqual({
      createdAt: "2026-11-24T00:00:00.000Z",
      id: "job_1",
    })
  })

  it("shows the operator every job", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_dev", "dev-main")
    await h.seedJob("job_qa", "qa-node")
    const body = (await h.asOperator("GET", "/jobs")).json()
    expect(body.jobs.map((job: { job_id: string }) => job.job_id).sort()).toEqual(["job_dev", "job_qa"])
  })

  it("refuses the operator credential from another host, like aibr approve", async () => {
    const h = await jobApiApp()
    const response = await h.asOperator("GET", "/jobs", { remoteAddress: "100.64.0.77" })
    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe("operator_not_local")
  })

  it("accepts the operator credential from another host when approval_from_loopback_only is false", async () => {
    const h = await jobApiApp({ config: (base) => ({ ...base, security: { ...base.security, approval_from_loopback_only: false } }) })
    expect((await h.asOperator("GET", "/jobs", { remoteAddress: "100.64.0.77" })).statusCode).toBe(200)
  })

  it("needs the bearer, and a signature to know whose jobs to show", async () => {
    const h = await jobApiApp()
    expect((await h.app.inject({ method: "GET", url: "/jobs" })).statusCode).toBe(401)
    const unsigned = await h.app.inject({ method: "GET", url: "/jobs", headers: { authorization: "Bearer secret" } })
    expect(unsigned.statusCode).toBe(401)
    expect(unsigned.json().code).toBe("signature_required")
  })

  it("refuses an unsigned peer on optional and off nodes (no identity to scope by)", async () => {
    for (const signing of ["optional", "off"] as const) {
      const h = await jobApiApp({ signing })
      await h.seedJob("job_1", "dev-main")
      const response = await h.app.inject({ method: "GET", url: "/jobs", headers: { authorization: "Bearer secret" } })
      expect(response.statusCode).toBe(403)
      expect(response.json().code).toBe("requester_identity_required")
    }
  })
})

describe("GET /jobs/:id/events", () => {
  it("returns the job's events as JSON pages with `next`", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "running")
    await h.events.append("job_1", { type: "tool", data: { detail: "Tool call: Read" } })
    const first = (await h.asPeer("dev-main", "GET", "/jobs/job_1/events?limit=2")).json()
    expect(first).toMatchObject({ job_id: "job_1", status: "running", final: false, next: 2 })
    expect(first.events.map((event: { type: string; data: { status?: string } }) => [event.type, event.data.status])).toEqual([
      ["status", "accepted"],
      ["status", "running"],
    ])
    const second = (await h.asPeer("dev-main", "GET", `/jobs/job_1/events?after=${first.next}`)).json()
    expect(second.events).toEqual([expect.objectContaining({ seq: 3, type: "tool", data: { detail: "Tool call: Read" } })])
    expect(second.next).toBe(3)
  })

  it("streams SSE to the end of a finished job, honouring Last-Event-ID", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "completed")
    const all = await h.asPeer("dev-main", "GET", "/jobs/job_1/events", { accept: "text/event-stream" })
    expect(all.statusCode).toBe(200)
    expect(all.headers["content-type"]).toContain("text/event-stream")
    const events = parseSse(all.body)
    expect(events.map((event) => [event.id, event.event])).toEqual([
      ["1", "status"],
      ["2", "status"],
      ["3", "status"],
      [undefined, "end"],
    ])
    expect(JSON.parse(events.at(-1)!.data!)).toMatchObject({ status: "completed", next: 3 })

    const resumed = parseSse((await h.asPeer("dev-main", "GET", "/jobs/job_1/events", { accept: "text/event-stream", "last-event-id": "2" })).body)
    expect(resumed.map((event) => event.id ?? event.event)).toEqual(["3", "end"])
  })

  it("pushes events while the job runs and ends when it finishes", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "running")
    const streaming = h.asPeer("dev-main", "GET", "/jobs/job_1/events", { accept: "text/event-stream", "last-event-id": "2" })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await h.events.append("job_1", { type: "message", data: { detail: "working" } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await h.jobManager.markCompleted("job_1")
    const events = parseSse((await streaming).body)
    expect(events.map((event) => [event.id, event.event])).toEqual([
      ["3", "message"],
      ["4", "status"],
      [undefined, "end"],
    ])
  })

  it("ends open streams when the bridge closes, so a follower never holds up a stop", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "running")
    const streaming = h.asPeer("dev-main", "GET", "/jobs/job_1/events", { accept: "text/event-stream" })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await h.app.close()
    const events = parseSse((await streaming).body)
    expect(events.map((event) => event.id)).toEqual(["1", "2"])
  })

  it("ends a finished job's stream even when it has no events (records older than the log)", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "completed")
    // Resuming past every event looks the same as a job that never wrote one.
    const response = await h.asPeer("dev-main", "GET", "/jobs/job_1/events", { accept: "text/event-stream", "last-event-id": "99" })
    expect(parseSse(response.body).map((event) => event.event)).toEqual(["end"])
  })

  it("serves a truncated log ending with its `truncated` event", async () => {
    const events = new InMemoryJobEventLog({ maxEvents: 4 })
    const h = await jobApiApp({ events })
    await h.seedJob("job_1", "dev-main", "running")
    for (let index = 0; index < 5; index += 1) await events.append("job_1", { type: "message", data: { index } })
    const body = (await h.asPeer("dev-main", "GET", "/jobs/job_1/events")).json()
    expect(body.events).toHaveLength(4)
    expect(body.events.at(-1)).toMatchObject({ seq: 4, type: "truncated" })
  })

  it("serves only redacted data", async () => {
    const events = new InMemoryJobEventLog({ redact: (text) => text.replaceAll("ghp_secretvalue", "[REDACTED]") })
    const h = await jobApiApp({ events })
    await h.seedJob("job_1", "dev-main", "running")
    await events.append("job_1", { type: "result", data: { summary: "token ghp_secretvalue used" } })
    const response = await h.asPeer("dev-main", "GET", "/jobs/job_1/events")
    expect(response.body).not.toContain("ghp_secretvalue")
    expect(response.body).toContain("token [REDACTED] used")
  })

  it("refuses another peer's job, an unknown job and a bad cursor", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "running")
    const other = await h.asPeer("qa-node", "GET", "/jobs/job_1/events")
    expect(other.statusCode).toBe(403)
    expect(other.json().code).toBe("not_job_requester")
    expect((await h.asPeer("dev-main", "GET", "/jobs/nope/events")).statusCode).toBe(404)
    expect((await h.asPeer("dev-main", "GET", "/jobs/job_1/events?after=-1")).statusCode).toBe(400)
    expect((await h.asOperator("GET", "/jobs/job_1/events")).statusCode).toBe(200)
  })
})

describe("POST /jobs/:id/cancel", () => {
  it("cancels a never-launched job, reports it once, and logs the caller", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "accepted")
    const response = await h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ job_id: "job_1", status: "failed", error: CANCELLED_BY_REQUESTER, cancelled: true })
    expect(h.reports.map((job) => [job.id, job.status, job.error])).toEqual([["job_1", "failed", CANCELLED_BY_REQUESTER]])
    expect(h.logLines).toEqual(["info job job_1 cancel by requester dev-main: cancelled (status failed)"])
    expect(h.taskGraphSyncer.synced).toContainEqual(expect.objectContaining({ jobId: "#job_1", status: "failed" }))
    // A cancelled job can no longer launch.
    await expect(h.jobManager.markLaunchStarted("job_1")).rejects.toThrow(/cannot be launched/)
  })

  it("cancels a blocked job", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "blocked")
    expect((await h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")).statusCode).toBe(200)
    expect((await h.jobManager.getJob("job_1")).error).toBe(CANCELLED_BY_REQUESTER)
  })

  it("is idempotent: a second cancel answers 409 with the current status and reports nothing more", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "accepted")
    expect((await h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")).statusCode).toBe(200)
    const again = await h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: "job_finished", status: "failed", job_error: CANCELLED_BY_REQUESTER })
    expect(h.reports).toHaveLength(1)
  })

  it("answers 409 for a finished job", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "completed")
    const response = await h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: "job_finished", status: "completed" })
    expect(h.reports).toHaveLength(0)
  })

  it("answers 409 for a job awaiting approval and points at reject", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "awaiting_approval")
    const response = await h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")
    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe("awaiting_approval")
    expect(response.json().error).toMatch(/aibr reject job_1/)
    expect((await h.jobManager.getJob("job_1")).status).toBe("awaiting_approval")
    // The operator credential cannot cancel it either: rejecting is the operator's tool.
    expect((await h.asOperator("POST", "/jobs/job_1/cancel")).statusCode).toBe(409)
  })

  it("ends a running OpenCode job first, then aborts its session, then reports it", async () => {
    const opencode = new RecordingOpencodeClient()
    const h = await jobApiApp({ opencodeClient: opencode })
    await h.seedJob("job_1", "dev-main", "accepted")
    await h.jobManager.markLaunchStarted("job_1")
    await h.jobManager.attachSession("job_1", "ses_42")
    await h.jobManager.markRunning("job_1")
    const response = await h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")
    expect(response.statusCode).toBe(200)
    expect(opencode.aborted).toEqual(["ses_42"])
    expect(h.reports).toHaveLength(1)
    // The session monitor, seeing the session go idle, cannot complete the job.
    await expect(h.jobManager.markCompleted("job_1")).rejects.toThrow(/terminal/)
  })

  it("lets the operator cancel any job, and only from this host", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "qa-node", "accepted")
    expect((await h.asOperator("POST", "/jobs/job_1/cancel", { remoteAddress: "100.64.0.77" })).statusCode).toBe(403)
    expect((await h.asOperator("POST", "/jobs/job_1/cancel")).statusCode).toBe(200)
    expect(h.logLines).toContain("info job job_1 cancel by operator: cancelled (status failed)")
  })

  it("refuses another peer (403), an unsigned peer, and an unknown job (404)", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "running")
    const other = await h.asPeer("qa-node", "POST", "/jobs/job_1/cancel")
    expect(other.statusCode).toBe(403)
    expect(other.json().code).toBe("not_job_requester")
    expect((await h.app.inject({ method: "POST", url: "/jobs/job_1/cancel", headers: { authorization: "Bearer secret" } })).statusCode).toBe(401)
    expect((await h.app.inject({ method: "POST", url: "/jobs/job_1/cancel" })).statusCode).toBe(401)
    expect((await h.asPeer("dev-main", "POST", "/jobs/nope/cancel")).statusCode).toBe(404)
    expect((await h.jobManager.getJob("job_1")).status).toBe("running")
    expect(h.reports).toHaveLength(0)
  })

  it("is not an approval action: nothing is written to the approval ledger", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "accepted")
    await h.seedJob("job_2", "qa-node", "accepted")
    expect((await h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")).statusCode).toBe(200)
    expect((await h.asOperator("POST", "/jobs/job_2/cancel")).statusCode).toBe(200)
    expect(h.ledger.lines).toEqual([])
  })
})

/**
 * v3.2.0 block B: `GET /jobs`, `GET /jobs/:id/events`, `POST /jobs/:id/cancel`
 * through `app.inject()`.
 */
import { describe, expect, it } from "vitest"
import type { TriggerRequest } from "../../../src/config/types.js"
import { CANCELLED_BY_OPERATOR, CANCELLED_BY_REQUESTER } from "../../../src/jobs/cancel.js"
import { InMemoryJobEventLog } from "../../../src/jobs/events.js"
import { decodeJobCursor, encodeJobCursor, pageJobs } from "../../../src/server/routes/job-api.js"
import { FakeOpencodeClient, validTrigger } from "../../integration/fixtures.js"
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

/** Polls `condition` every 2 ms for up to 2 s. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2))
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

  it("ends open streams when the bridge closes and releases their subscriptions", async () => {
    const events = new InMemoryJobEventLog()
    const h = await jobApiApp({ events })
    await h.seedJob("job_1", "dev-main", "running")
    const streaming = h.asPeer("dev-main", "GET", "/jobs/job_1/events", { accept: "text/event-stream" })
    await until(() => events.subscriberCount("job_1") === 1)
    await h.app.close()
    const parsed = parseSse((await streaming).body)
    expect(parsed.map((event) => event.id)).toEqual(["1", "2"])
    expect(events.subscriberCount("job_1")).toBe(0)
  })

  it("releases a stream's subscription and slot when the client disconnects", async () => {
    const events = new InMemoryJobEventLog()
    const h = await jobApiApp({ events, jobEventStreamLimits: { perCaller: 1 } })
    await h.seedJob("job_1", "dev-main", "running")
    const address = await h.app.listen({ host: "127.0.0.1", port: 0 })
    try {
      const path = "/jobs/job_1/events"
      const controller = new AbortController()
      const response = await fetch(`${address}${path}`, {
        headers: { ...h.peerHeaders("dev-main", "GET", path), accept: "text/event-stream" },
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      // A live GET over a real socket is not taken for a gone client: its events arrive.
      let received = ""
      while (!received.includes("id: 2\n")) {
        const chunk = await reader.read()
        if (chunk.done) break
        received += new TextDecoder().decode(chunk.value)
      }
      expect(received).toContain("id: 1\nevent: status")
      expect(received).toContain("id: 2\nevent: status")
      await until(() => events.subscriberCount("job_1") === 1)
      // The one slot this caller has is taken.
      expect((await h.asPeer("dev-main", "GET", path, { accept: "text/event-stream" })).statusCode).toBe(429)
      controller.abort()
      await reader.cancel().catch(() => undefined)
      await until(() => events.subscriberCount("job_1") === 0)
      expect(events.subscriberCount("job_1")).toBe(0)
      // The slot is free again: a finished job's stream opens and ends.
      await h.jobManager.markCompleted("job_1")
      expect((await h.asPeer("dev-main", "GET", path, { accept: "text/event-stream" })).statusCode).toBe(200)
    } finally {
      await h.app.close()
    }
  })

  it("takes no slot for a client that left before its stream started", async () => {
    const events = new InMemoryJobEventLog()
    const h = await jobApiApp({ events, jobEventStreamLimits: { perCaller: 1 } })
    await h.seedJob("job_1", "dev-main", "running")
    await h.seedJob("job_2", "dev-main", "completed")
    // Hold the request inside the handler (before the stream starts) until the client is gone.
    let entered = false
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const getJob = h.jobManager.getJob.bind(h.jobManager)
    let armed = true
    h.jobManager.getJob = async (id: string) => {
      if (armed && id === "job_1") {
        armed = false
        entered = true
        await gate
      }
      return getJob(id)
    }
    let aborted = false
    h.app.addHook("onRequestAbort", (_request, done) => {
      aborted = true
      done()
    })
    const address = await h.app.listen({ host: "127.0.0.1", port: 0 })
    try {
      const path = "/jobs/job_1/events"
      const controller = new AbortController()
      const request = fetch(`${address}${path}`, {
        headers: { ...h.peerHeaders("dev-main", "GET", path), accept: "text/event-stream" },
        signal: controller.signal,
      }).catch(() => undefined)
      await until(() => entered)
      controller.abort()
      await request
      await until(() => aborted)
      expect(aborted).toBe(true)
      release()
      // The caller's only slot is free: a stream of its finished job opens (and ends).
      let status = 0
      for (let attempt = 0; attempt < 200 && status !== 200; attempt += 1) {
        status = (await h.asPeer("dev-main", "GET", "/jobs/job_2/events", { accept: "text/event-stream" })).statusCode
        if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(status).toBe(200)
      expect(events.subscriberCount("job_1")).toBe(0)
    } finally {
      await h.app.close()
    }
  })

  it("caps open streams per caller, per job and in total (429)", async () => {
    const events = new InMemoryJobEventLog()
    const h = await jobApiApp({ events, jobEventStreamLimits: { global: 3, perCaller: 2, perJob: 2 } })
    for (const [id, peer] of [["job_a", "dev-main"], ["job_b", "dev-main"], ["job_q", "qa-node"], ["job_q2", "qa-node"]] as const) {
      await h.seedJob(id, peer, "running")
    }
    const open = (peer: "dev-main" | "qa-node", id: string) => h.asPeer(peer, "GET", `/jobs/${id}/events`, { accept: "text/event-stream" })
    const streams = [open("dev-main", "job_a"), open("dev-main", "job_b")]
    await until(() => events.subscriberCount("job_a") === 1 && events.subscriberCount("job_b") === 1)
    const perCaller = await open("dev-main", "job_a")
    expect(perCaller.statusCode).toBe(429)
    expect(perCaller.json().code).toBe("too_many_streams")
    streams.push(open("qa-node", "job_q"))
    await until(() => events.subscriberCount("job_q") === 1)
    // Three are open: the global cap refuses a fourth from a caller with room.
    expect((await open("qa-node", "job_q2")).statusCode).toBe(429)
    // The JSON page is not a stream and is never capped.
    expect((await h.asPeer("qa-node", "GET", "/jobs/job_q2/events")).statusCode).toBe(200)
    await h.app.close()
    await Promise.all(streams)
  })

  it("sends a follower only the events stored after its wake, never a repeat", async () => {
    const events = new InMemoryJobEventLog()
    const h = await jobApiApp({ events })
    await h.seedJob("job_1", "dev-main", "running")
    const streaming = h.asPeer("dev-main", "GET", "/jobs/job_1/events", { accept: "text/event-stream" })
    await until(() => events.subscriberCount("job_1") === 1)
    for (let index = 0; index < 5; index += 1) {
      await events.append("job_1", { type: "message", data: { index } })
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    await h.jobManager.markCompleted("job_1")
    const ids = parseSse((await streaming).body)
      .filter((event) => event.id !== undefined)
      .map((event) => Number(event.id))
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it("sets `final` only on a page that reaches the ended job's last event", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "running")
    // The job ends, but its terminal event is not in the log yet (the window
    // between the record's write and the event's append).
    const append = h.events.append.bind(h.events)
    h.events.append = async () => undefined
    await h.jobManager.markCompleted("job_1")
    const early = (await h.asPeer("dev-main", "GET", "/jobs/job_1/events")).json()
    expect(early).toMatchObject({ status: "completed", final: false, next: 2 })
    h.events.append = append
    await h.events.append("job_1", { type: "status", data: { status: "completed", from: "running" } })
    // A page cut by `limit` before the terminal event is not final either.
    expect((await h.asPeer("dev-main", "GET", "/jobs/job_1/events?limit=1")).json().final).toBe(false)
    expect((await h.asPeer("dev-main", "GET", "/jobs/job_1/events")).json().final).toBe(true)
    // Past the terminal event: final, with nothing more to read.
    expect((await h.asPeer("dev-main", "GET", "/jobs/job_1/events?after=3")).json()).toMatchObject({ final: true, events: [], next: 3 })
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
    const response = await h.asOperator("POST", "/jobs/job_1/cancel")
    expect(response.statusCode).toBe(200)
    // The operator's cancel says so; it is not recorded as the requester's.
    expect(response.json().error).toBe(CANCELLED_BY_OPERATOR)
    expect(h.reports.map((job) => job.error)).toEqual([CANCELLED_BY_OPERATOR])
    expect(h.logLines).toContain("info job job_1 cancel by operator: cancelled (status failed)")
  })

  it("answers 202 (still stopping), not 409, to a cancel that comes while an earlier stop is still ending the job", async () => {
    const h = await jobApiApp({
      claudeJobRunner: {
        start: async () => {
          throw new Error("unused")
        },
        monitor: async () => undefined,
        isActive: () => true,
        // The first stop was asked earlier and the job has not ended yet.
        stop: async () => "already_stopping" as const,
      },
    })
    await h.seedJob("job_1", "dev-main", "running")
    const response = await h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")
    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ status: "running", cancelling: true })
  })

  it("answers 409 cancel_in_progress to a cancel made while another is in flight", async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    let stops = 0
    const h = await jobApiApp({
      claudeJobRunner: {
        start: async () => {
          throw new Error("unused")
        },
        monitor: async () => undefined,
        isActive: () => true,
        stop: async () => {
          stops += 1
          await held
          return "stopping" as const
        },
      },
    })
    await h.seedJob("job_1", "dev-main", "running")
    const first = h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")
    for (let attempt = 0; attempt < 100 && stops === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(stops).toBe(1)
    const second = await h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")
    expect(second.statusCode).toBe(409)
    expect(second.json().code).toBe("cancel_in_progress")
    release()
    expect((await first).statusCode).toBe(202)
    expect(stops).toBe(1)
  })

  it("fails and reports the local dependents of a cancelled job at once", async () => {
    const opencode = new RecordingOpencodeClient()
    const h = await jobApiApp({ opencodeClient: opencode })
    await h.seedJob("job_1", "dev-main", "running")
    await h.jobManager.createJob(validTrigger({ job_id: "job_2", depends_on: ["job_1"] }) as TriggerRequest)
    await h.jobManager.markBlocked("job_2", ["job_1"])
    await h.jobManager.createJob(validTrigger({ job_id: "job_3", depends_on: ["job_2"] }) as TriggerRequest)
    await h.jobManager.markBlocked("job_3", ["job_2"])
    expect((await h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")).statusCode).toBe(200)
    expect(await h.jobManager.getJob("job_2")).toMatchObject({ status: "failed", error: "Dependency job_1 failed" })
    expect(await h.jobManager.getJob("job_3")).toMatchObject({ status: "failed", error: "Dependency job_2 failed" })
    expect(h.reports.map((job) => job.id)).toEqual(["job_1", "job_2", "job_3"])
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

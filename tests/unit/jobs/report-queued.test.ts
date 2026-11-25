/**
 * A report that sits in the durable egress outbox for a retry is NOT delivered:
 * `CallbackReporter.send` throws `CallbackQueuedError`, and the terminal job
 * reporter records `callbackDelivery: pending` with "queued for retry" instead
 * of the former, false, "delivered".
 */
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import { CallbackQueuedError, CallbackReporter } from "../../../src/callback/reporter.js"
import { EgressOutboxStore } from "../../../src/callback/egress-outbox.js"
import { createSqliteDriver } from "../../../src/orchestration/event-store/sqlite-driver.js"
import type { ReportCallback } from "../../../src/callback/types.js"
import { JobManager } from "../../../src/jobs/manager.js"
import { JsonFileJobStore } from "../../../src/jobs/store.js"
import { createTerminalJobReporter } from "../../../src/jobs/report.js"
import { trigger } from "./fixtures.js"

const report: ReportCallback = {
  job_id: "job_q",
  source_agent_id: "test-vps",
  target_agent_id: "dev-main",
  status: "completed",
  summary: "done",
  findings: [],
  artifacts: [],
  started_at: "2026-06-15T00:00:00.000Z",
  completed_at: "2026-06-15T00:01:00.000Z",
}

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function completedJob(): Promise<{ jobs: JobManager; id: string }> {
  const dir = await mkdtemp(join(tmpdir(), "aibr-report-queued-"))
  dirs.push(dir)
  const jobs = new JobManager(new JsonFileJobStore(dir))
  const job = await jobs.createJob(trigger({ job_id: "job_q" }))
  await jobs.markCompleted(job.id)
  return { jobs, id: job.id }
}

describe("CallbackReporter with the egress outbox", () => {
  it("throws CallbackQueuedError when the first attempt fails and the row is kept for a retry", async () => {
    const outboxStore = new EgressOutboxStore(createSqliteDriver({ path: ":memory:" }))
    const reporter = new CallbackReporter({
      attempts: 3,
      baseDelayMs: 1,
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787" }],
      fetcher: async () => new Response(null, { status: 503 }),
      outboxStore,
    })
    const sent = reporter.send("http://dev-main.tailnet:8787/report", report, "tok", { jobId: "job_q" })
    await expect(sent).rejects.toBeInstanceOf(CallbackQueuedError)
    await expect(reporter.send("http://dev-main.tailnet:8787/report", report, "tok", { jobId: "job_q2" })).rejects.toThrow(
      /^Callback queued for retry/,
    )
    const rows = outboxStore.getByJobId("job_q")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).not.toBe("delivered")
    expect(rows[0]?.status).not.toBe("failed")
  })

  it("still resolves when the first attempt is delivered", async () => {
    const outboxStore = new EgressOutboxStore(createSqliteDriver({ path: ":memory:" }))
    const reporter = new CallbackReporter({
      attempts: 3,
      baseDelayMs: 1,
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787" }],
      fetcher: async () => new Response(null, { status: 200 }),
      outboxStore,
    })
    await expect(reporter.send("http://dev-main.tailnet:8787/report", report, "tok", { jobId: "job_ok" })).resolves.toBeUndefined()
  })
})

describe("CallbackQueuedError", () => {
  it("names the last attempt when there was one", () => {
    expect(new CallbackQueuedError("HTTP 503").message).toBe("Callback queued for retry (last attempt: HTTP 503)")
    expect(new CallbackQueuedError(null).message).toBe("Callback queued for retry")
    expect(new CallbackQueuedError("").message).toBe("Callback queued for retry")
  })
})

describe("createTerminalJobReporter", () => {
  function reporterThatThrows(error: Error): CallbackReporter {
    return { send: async () => Promise.reject(error) } as unknown as CallbackReporter
  }

  it("records a queued report as pending, with the reason", async () => {
    const { jobs, id } = await completedJob()
    const deliver = createTerminalJobReporter({
      jobManager: jobs,
      callbackReporter: reporterThatThrows(new CallbackQueuedError("HTTP 503")),
      agentId: "test-vps",
      bearerToken: null,
    })
    await deliver(await jobs.getJob(id))
    const job = await jobs.getJob(id)
    expect(job.callbackDelivery).toMatchObject({ status: "pending", error: "Callback queued for retry (last attempt: HTTP 503)" })
    expect(job.status).toBe("completed")
  })

  it("records any other error as failed", async () => {
    const { jobs, id } = await completedJob()
    const deliver = createTerminalJobReporter({
      jobManager: jobs,
      callbackReporter: reporterThatThrows(new Error("Callback failed permanently with status 403")),
      agentId: "test-vps",
      bearerToken: null,
    })
    await deliver(await jobs.getJob(id))
    expect((await jobs.getJob(id)).callbackDelivery).toMatchObject({ status: "failed", error: "Callback failed permanently with status 403" })
  })

  it("records a successful send as delivered", async () => {
    const { jobs, id } = await completedJob()
    const deliver = createTerminalJobReporter({
      jobManager: jobs,
      callbackReporter: { send: async () => undefined } as unknown as CallbackReporter,
      agentId: "test-vps",
      bearerToken: null,
    })
    await deliver(await jobs.getJob(id))
    expect((await jobs.getJob(id)).callbackDelivery?.status).toBe("delivered")
  })
})

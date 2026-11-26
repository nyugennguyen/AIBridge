/**
 * v3.2.0 hardening: outbound egress to a peer has a bounded timeout. A peer
 * that accepts the connection and never answers fails the attempt after the
 * timeout, and the delivery stays retryable: the outbox row is requeued
 * (`pending`), nothing is marked delivered, and the job is listed by
 * `listCallbackRetries`.
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { EgressOutboxStore } from "../../../src/callback/egress-outbox.js"
import { EGRESS_REQUEST_TIMEOUT_MS, EgressTimeoutError, safeEgressFetch } from "../../../src/callback/origin.js"
import { CallbackQueuedError, CallbackReporter } from "../../../src/callback/reporter.js"
import type { ReportCallback } from "../../../src/callback/types.js"
import { JobManager } from "../../../src/jobs/manager.js"
import { createTerminalJobReporter } from "../../../src/jobs/report.js"
import { JsonFileJobStore } from "../../../src/jobs/store.js"
import { createSqliteDriver } from "../../../src/orchestration/event-store/sqlite-driver.js"
import { trigger } from "../jobs/fixtures.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** An HTTP server that accepts every request and never answers it. */
async function silentPeer(): Promise<{ url: string; requests: () => number }> {
  let requests = 0
  const server: Server = createServer(() => {
    requests += 1 // never respond
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => requests }
}

/** A fetcher that never settles and ignores the abort signal. */
const hangingFetcher = (): Promise<Response> => new Promise<Response>(() => undefined)

const report: ReportCallback = {
  job_id: "job_t",
  source_agent_id: "test-vps",
  target_agent_id: "dev-main",
  status: "completed",
  summary: "done",
  findings: [],
  artifacts: [],
  started_at: "2026-11-26T00:00:00.000Z",
  completed_at: "2026-11-26T00:01:00.000Z",
}

describe("safeEgressFetch timeout", () => {
  it("defaults to 15 s", () => {
    expect(EGRESS_REQUEST_TIMEOUT_MS).toBe(15_000)
  })

  it("fails a real request to a peer that never answers after the timeout, and aborts it", async () => {
    const peer = await silentPeer()
    const started = Date.now()
    const outcome = safeEgressFetch(fetch, `${peer.url}/report`, { method: "POST", body: "{}" }, peer.url, { timeoutMs: 150 })
    await expect(outcome).rejects.toBeInstanceOf(EgressTimeoutError)
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(140)
    expect(elapsed).toBeLessThan(5_000)
    expect(peer.requests()).toBe(1)
  })

  it("does not wait for a fetcher that ignores the abort signal", async () => {
    let signal: AbortSignal | undefined
    const fetcher = (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return hangingFetcher()
    }
    await expect(safeEgressFetch(fetcher, "http://dev-main.tailnet:8787/report", { method: "POST" }, "http://dev-main.tailnet:8787", { timeoutMs: 20 })).rejects.toThrow(
      /^EGRESS_TIMEOUT: no response within 20 ms$/,
    )
    expect(signal?.aborted).toBe(true)
  })

  it("leaves a prompt answer untouched", async () => {
    const response = await safeEgressFetch(async () => new Response("ok", { status: 202 }), "http://x.tailnet:8787/report", {}, "http://x.tailnet:8787", { timeoutMs: 20 })
    expect(response.status).toBe(202)
  })
})

describe("a report to a peer that never answers stays retryable", () => {
  it("outbox: the row is requeued with EGRESS_TIMEOUT, never delivered; send throws CallbackQueuedError", async () => {
    const peer = await silentPeer()
    const outboxStore = new EgressOutboxStore(createSqliteDriver({ path: ":memory:" }))
    const reporter = new CallbackReporter({
      attempts: 3,
      baseDelayMs: 1,
      agents: [{ id: "dev-main", url: peer.url }],
      outboxStore,
      requestTimeoutMs: 100,
    })
    await expect(reporter.send(`${peer.url}/report`, report, "tok", { jobId: "job_t" })).rejects.toBeInstanceOf(CallbackQueuedError)
    const rows = outboxStore.getByJobId("job_t")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe("pending")
    expect(rows[0]?.last_error).toMatch(/^EGRESS_TIMEOUT/)
    expect(rows[0]?.next_attempt_at_ms).not.toBeNull()
  })

  it("the terminal reporter records `pending` and the job is listed for retry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aibr-egress-timeout-"))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const jobManager = new JobManager(new JsonFileJobStore(dir))
    const job = await jobManager.createJob(trigger({ job_id: "job_t" }))
    await jobManager.markCompleted(job.id)
    const reporter = new CallbackReporter({
      attempts: 1,
      baseDelayMs: 1,
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787" }],
      fetcher: hangingFetcher,
      outboxStore: new EgressOutboxStore(createSqliteDriver({ path: ":memory:" })),
      requestTimeoutMs: 20,
    })
    await createTerminalJobReporter({ jobManager, callbackReporter: reporter, agentId: "test-vps", bearerToken: "tok" })(await jobManager.getJob(job.id))
    const after = await jobManager.getJob(job.id)
    expect(after.callbackDelivery?.status).toBe("pending")
    expect(after.callbackDelivery?.error).toMatch(/EGRESS_TIMEOUT/)
    expect((await jobManager.listCallbackRetries()).map((retry) => retry.id)).toEqual(["job_t"])
  })

  it("without an outbox: the send fails after the timeout and the job is `failed`, which is retried at startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aibr-egress-timeout-"))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const jobManager = new JobManager(new JsonFileJobStore(dir))
    const job = await jobManager.createJob(trigger({ job_id: "job_t" }))
    await jobManager.markCompleted(job.id)
    const reporter = new CallbackReporter({ attempts: 1, baseDelayMs: 1, fetcher: hangingFetcher, requestTimeoutMs: 20 })
    await createTerminalJobReporter({ jobManager, callbackReporter: reporter, agentId: "test-vps", bearerToken: "tok" })(await jobManager.getJob(job.id))
    const after = await jobManager.getJob(job.id)
    expect(after.callbackDelivery?.status).toBe("failed")
    expect((await jobManager.listCallbackRetries()).map((retry) => retry.id)).toEqual(["job_t"])
  })

  it("drainPending requeues a timed-out row instead of marking it delivered", async () => {
    const outboxStore = new EgressOutboxStore(createSqliteDriver({ path: ":memory:" }))
    outboxStore.enqueue({ jobId: "job_t", callbackUrl: "http://dev-main.tailnet:8787/report", report, agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787" }] })
    const reporter = new CallbackReporter({ attempts: 1, baseDelayMs: 1, fetcher: hangingFetcher, outboxStore, requestTimeoutMs: 20 })
    expect(await reporter.drainPending("tok")).toEqual({ delivered: 0, failed: 0, requeued: 1 })
    expect(outboxStore.getByJobId("job_t")[0]?.status).toBe("pending")
  })
})

/**
 * Review of PR #32: `/report` and the router drainer settle the dependents of
 * a remote job. They must never wait on a dependent's own report (an
 * outbound POST to a requester that may be offline), and a store failure
 * must still answer 500 / leave the row unacknowledged so the sender retries.
 */
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { TriggerRequest } from "../../src/config/types.js"
import { IngressDrainer } from "../../src/ingress/drainer.js"
import { JobManager } from "../../src/jobs/manager.js"
import type { JobRecord } from "../../src/jobs/types.js"
import { createSqliteDriver, type SqliteDriver } from "../../src/orchestration/event-store/sqlite-driver.js"
import { buildTestApp, FakeOpencodeClient, FakeTaskGraphSyncer, InMemoryJobStore, testConfig, validTrigger } from "./fixtures.js"

/** A store whose writes can be made to fail, as a full disk would. */
class FailingStore extends InMemoryJobStore {
  failWrites = false
  override async save(job: JobRecord): Promise<void> {
    if (this.failWrites) throw new Error("disk full")
    await super.save(job)
  }
}

const REMOTE = { agent_id: "dev-main", job_id: "remote_1" }

function remoteReport(status: "completed" | "failed" = "failed") {
  return {
    job_id: REMOTE.job_id,
    source_agent_id: REMOTE.agent_id,
    target_agent_id: "test-vps",
    status,
    summary: "remote job ended",
    findings: [],
    artifacts: [],
    started_at: "2026-11-26T00:00:00.000Z",
    completed_at: "2026-11-26T00:01:00.000Z",
  }
}

/** A job manager holding one job blocked on the remote job. */
async function blockedOnRemote(store = new FailingStore()) {
  const jobManager = new JobManager(store)
  await jobManager.createJob(validTrigger({ job_id: "dependent", depends_on: [REMOTE] }) as TriggerRequest)
  await jobManager.markBlocked("dependent", [REMOTE])
  return { store, jobManager }
}

/** A reporter that never finishes, as when the dependent's requester is offline. */
function hangingReporter() {
  const calls: string[] = []
  return { calls, report: (job: JobRecord) => new Promise<void>(() => void calls.push(job.id)) }
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

describe("POST /report and dependents", () => {
  it("answers 202 at once even when the failed dependent's report never completes", async () => {
    const { jobManager } = await blockedOnRemote()
    const reporter = hangingReporter()
    const { app } = await buildTestApp({ jobManager, reportTerminalJob: reporter.report })
    const response = await within(
      app.inject({ method: "POST", url: "/report", headers: { authorization: "Bearer secret" }, payload: remoteReport("failed") }),
      1_000,
    )
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: true })
    const dependent = await jobManager.getJob("dependent")
    expect(dependent).toMatchObject({ status: "failed", error: "Remote dependency dev-main/remote_1 failed" })
    // Marked before the answer, so a crash is covered by the startup re-delivery.
    expect(dependent.callbackDelivery?.status).toBe("pending")
    expect((await jobManager.listCallbackRetries()).map((job) => job.id)).toEqual(["dependent"])
    expect(reporter.calls).toEqual(["dependent"])
  })

  it("answers 500 when the store fails, so the sender retries; the retry settles the dependent", async () => {
    const { store, jobManager } = await blockedOnRemote()
    const reported: string[] = []
    const { app } = await buildTestApp({ jobManager, reportTerminalJob: async (job) => void reported.push(job.id) })
    store.failWrites = true
    const failing = await app.inject({ method: "POST", url: "/report", headers: { authorization: "Bearer secret" }, payload: remoteReport("failed") })
    expect(failing.statusCode).toBe(500)
    expect((await jobManager.getJob("dependent")).status).toBe("blocked")
    expect(reported).toEqual([])

    store.failWrites = false
    const retried = await app.inject({ method: "POST", url: "/report", headers: { authorization: "Bearer secret" }, payload: remoteReport("failed") })
    expect(retried.statusCode).toBe(202)
    expect((await jobManager.getJob("dependent")).status).toBe("failed")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reported).toEqual(["dependent"])
  })
})

describe("router drainer and dependents", () => {
  const paths: string[] = []
  const drivers: SqliteDriver[] = []
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close()
    for (const path of paths.splice(0)) for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true })
  })

  function outbox(): SqliteDriver {
    const path = join(tmpdir(), `aibridge-drainer-report-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
    paths.push(path)
    const driver = createSqliteDriver({ path, create: true })
    drivers.push(driver)
    driver.exec(`
      CREATE TABLE IF NOT EXISTS ingress_outbox (
        job_id TEXT PRIMARY KEY, subject_job_id TEXT NOT NULL, route TEXT NOT NULL, schema_version TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, next_attempt_at_ms INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, claim_token TEXT, claimed_at_ms INTEGER,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'acknowledged', 'failed')),
        last_error TEXT, terminal_error TEXT, CHECK (attempts >= 0)
      );
    `)
    driver.run(
      `INSERT INTO ingress_outbox (job_id, subject_job_id, route, schema_version, payload_json, created_at_ms, next_attempt_at_ms, attempts, status)
       VALUES ('row_1', 'remote_1', 'POST /report', 'v1', ?, 1000, 1000, 0, 'pending')`,
      JSON.stringify(remoteReport("failed")),
    )
    return driver
  }

  function drainerFor(jobManager: JobManager, driver: SqliteDriver, reportTerminalJob: (job: JobRecord) => Promise<void>) {
    return new IngressDrainer({
      driver,
      config: testConfig(),
      jobManager,
      opencodeClient: new FakeOpencodeClient(),
      taskGraphSyncer: new FakeTaskGraphSyncer(),
      monitorSession: async () => undefined,
      reportTerminalJob,
      log: () => undefined,
    })
  }

  it("acknowledges the row at once even when the failed dependent's report never completes", async () => {
    const { jobManager } = await blockedOnRemote()
    const reporter = hangingReporter()
    const driver = outbox()
    const drainer = drainerFor(jobManager, driver, reporter.report)
    expect(await within(drainer.drainOnce(1000), 1_000)).toBe(1)
    expect(drainer.get("row_1")?.status).toBe("acknowledged")
    const dependent = await jobManager.getJob("dependent")
    expect(dependent.status).toBe("failed")
    expect(dependent.callbackDelivery?.status).toBe("pending")
    expect(reporter.calls).toEqual(["dependent"])
  })

  it("does not acknowledge the row when the store fails", async () => {
    const { store, jobManager } = await blockedOnRemote()
    const driver = outbox()
    const drainer = drainerFor(jobManager, driver, async () => undefined)
    store.failWrites = true
    await drainer.drainOnce(1000)
    const row = drainer.get("row_1")
    expect(row?.status).not.toBe("acknowledged")
    expect(row?.last_error).toBe("disk full")
    expect((await jobManager.getJob("dependent")).status).toBe("blocked")
  })
})

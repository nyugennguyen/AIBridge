import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { JobManager } from "../../../src/jobs/manager.js"
import { JsonFileJobStore } from "../../../src/jobs/store.js"
import { trigger } from "./fixtures.js"

async function manager() {
  const dir = await mkdtemp(join(tmpdir(), "aibridge-manager-"))
  return new JobManager(new JsonFileJobStore(dir))
}

describe("JobManager", () => {
  it("transitions a job through session creation and completion", async () => {
    const jobs = await manager()
    const created = await jobs.createJob(trigger({ job_id: "job_1" }), "2026-06-15T00:00:00.000Z")
    await jobs.attachSession(created.id, "ses_1", "2026-06-15T00:00:01.000Z")
    await jobs.markRunning(created.id, "2026-06-15T00:00:02.000Z")
    await jobs.markCompleted(created.id, "2026-06-15T00:00:03.000Z")

    expect((await jobs.getJob(created.id)).status).toBe("completed")
  })

  it("rejects duplicate client-supplied job IDs", async () => {
    const jobs = await manager()
    await jobs.createJob(trigger({ job_id: "job_1" }), "2026-06-15T00:00:00.000Z")

    await expect(jobs.createJob(trigger({ job_id: "job_1" }), "2026-06-15T00:00:01.000Z")).rejects.toThrow("already exists")
  })

  it("marks expired running jobs as timed out", async () => {
    const jobs = await manager()
    const created = await jobs.createJob(trigger({ job_id: "job_1", timeout_seconds: 10 }), "2026-06-15T00:00:00.000Z")
    await jobs.markRunning(created.id, "2026-06-15T00:00:01.000Z")

    await jobs.sweepExpiredJobs("2026-06-15T00:00:12.000Z")

    expect((await jobs.getJob(created.id)).status).toBe("timed_out")
  })

  it("marks a job as failed with error", async () => {
    const jobs = await manager()
    const created = await jobs.createJob(trigger({ job_id: "job_fail" }), "2026-06-15T00:00:00.000Z")
    await jobs.markRunning(created.id, "2026-06-15T00:00:01.000Z")
    const failed = await jobs.markFailed(created.id, "something broke", "2026-06-15T00:00:02.000Z")

    expect(failed.status).toBe("failed")
    expect(failed.error).toBe("something broke")
  })

  it("rejects transition from terminal status to different status", async () => {
    const jobs = await manager()
    const created = await jobs.createJob(trigger({ job_id: "job_term" }), "2026-06-15T00:00:00.000Z")
    await jobs.markCompleted(created.id, "2026-06-15T00:00:01.000Z")

    await expect(jobs.markRunning(created.id, "2026-06-15T00:00:02.000Z")).rejects.toThrow("Cannot transition terminal job")
  })

  it("skips terminal jobs in sweepExpiredJobs", async () => {
    const jobs = await manager()
    const created = await jobs.createJob(trigger({ job_id: "job_done", timeout_seconds: 1 }), "2026-06-15T00:00:00.000Z")
    await jobs.markCompleted(created.id, "2026-06-15T00:00:01.000Z")

    const expired = await jobs.sweepExpiredJobs("2026-06-15T00:01:00.000Z")

    expect(expired).toHaveLength(0)
    expect((await jobs.getJob(created.id)).status).toBe("completed")
  })

  it("throws on getJob for unknown ID", async () => {
    const jobs = await manager()
    await expect(jobs.getJob("nonexistent")).rejects.toThrow("Unknown job")
  })
})

import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { JobManager } from "../../../src/jobs/manager.js"
import { JsonFileJobStore } from "../../../src/jobs/store.js"
import { trigger, triggerWithDeps } from "./fixtures.js"

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

  describe("markTimedOut", () => {
    it("sets status to timed_out with default error message", async () => {
      const jobs = await manager()
      const created = await jobs.createJob(trigger({ job_id: "job_to" }), "2026-06-15T00:00:00.000Z")
      await jobs.markRunning(created.id, "2026-06-15T00:00:01.000Z")
      const timedOut = await jobs.markTimedOut(created.id, "2026-06-15T00:00:02.000Z")

      expect(timedOut.status).toBe("timed_out")
      expect(timedOut.error).toBe("Job timed out")
    })

    it("marks accepted jobs (not just running) as timed_out", async () => {
      const jobs = await manager()
      const created = await jobs.createJob(trigger({ job_id: "job_acc" }), "2026-06-15T00:00:00.000Z")
      const timedOut = await jobs.markTimedOut(created.id, "2026-06-15T00:00:01.000Z")

      expect(timedOut.status).toBe("timed_out")
    })
  })

  describe("sweepExpiredJobs", () => {
    it("marks accepted (non-running) jobs as timed_out when past deadline", async () => {
      const jobs = await manager()
      await jobs.createJob(trigger({ job_id: "job_acc", timeout_seconds: 5 }), "2026-06-15T00:00:00.000Z")

      const expired = await jobs.sweepExpiredJobs("2026-06-15T00:00:06.000Z")

      expect(expired).toHaveLength(1)
      expect(expired[0].status).toBe("timed_out")
    })

    it("marks session_created jobs as timed_out when past deadline", async () => {
      const jobs = await manager()
      const created = await jobs.createJob(trigger({ job_id: "job_sc", timeout_seconds: 10 }), "2026-06-15T00:00:00.000Z")
      await jobs.attachSession(created.id, "ses_1", "2026-06-15T00:00:01.000Z")

      const expired = await jobs.sweepExpiredJobs("2026-06-15T00:00:12.000Z")

      expect(expired).toHaveLength(1)
      expect(expired[0].status).toBe("timed_out")
    })

    it("does not sweep jobs within their timeout window", async () => {
      const jobs = await manager()
      await jobs.createJob(trigger({ job_id: "job_ok", timeout_seconds: 60 }), "2026-06-15T00:00:00.000Z")

      const expired = await jobs.sweepExpiredJobs("2026-06-15T00:00:30.000Z")

      expect(expired).toHaveLength(0)
      expect((await jobs.getJob("job_ok")).status).toBe("accepted")
    })
  })

  describe("markBlocked", () => {
    it("transitions job to blocked status with depends_on", async () => {
      const jobs = await manager()
      const created = await jobs.createJob(trigger({ job_id: "job_1" }), "2026-06-15T00:00:00.000Z")
      const blocked = await jobs.markBlocked(created.id, ["dep-1", "dep-2"])

      expect(blocked.status).toBe("blocked")
      expect(blocked.depends_on).toEqual(["dep-1", "dep-2"])
      expect(blocked.blockedAt).toBeDefined()
    })

    it("throws if job is in terminal status", async () => {
      const jobs = await manager()
      const created = await jobs.createJob(trigger({ job_id: "job_term" }), "2026-06-15T00:00:00.000Z")
      await jobs.markCompleted(created.id)

      await expect(jobs.markBlocked(created.id, ["dep-1"])).rejects.toThrow("Cannot transition terminal job")
    })
  })

  describe("unblockDependents", () => {
    it("unblocks job when all dependencies completed", async () => {
      const jobs = await manager()
      const dep1 = await jobs.createJob(trigger({ job_id: "dep1" }), "2026-06-15T00:00:00.000Z")
      await jobs.markCompleted(dep1.id)

      const blocked = await jobs.createJob(triggerWithDeps([dep1.id], { job_id: "blocked_1" }), "2026-06-15T00:00:01.000Z")
      await jobs.markBlocked(blocked.id, [dep1.id])

      const unblocked = await jobs.unblockDependents(dep1.id)
      expect(unblocked).toHaveLength(1)
      expect(unblocked[0].status).toBe("accepted")
    })

    it("does not unblock job when some dependencies pending", async () => {
      const jobs = await manager()
      const dep1 = await jobs.createJob(trigger({ job_id: "dep_a" }), "2026-06-15T00:00:00.000Z")
      const dep2 = await jobs.createJob(trigger({ job_id: "dep_b" }), "2026-06-15T00:00:01.000Z")
      await jobs.markCompleted(dep1.id)

      const blocked = await jobs.createJob(triggerWithDeps([dep1.id, dep2.id], { job_id: "blocked_2" }), "2026-06-15T00:00:02.000Z")
      await jobs.markBlocked(blocked.id, [dep1.id, dep2.id])

      const unblocked = await jobs.unblockDependents(dep1.id)
      expect(unblocked).toHaveLength(0)

      const job = await jobs.getJob(blocked.id)
      expect(job.status).toBe("blocked")
    })

    it("cascade-fails job when dependency fails", async () => {
      const jobs = await manager()
      const dep1 = await jobs.createJob(trigger({ job_id: "dep_f" }), "2026-06-15T00:00:00.000Z")
      await jobs.markFailed(dep1.id, "dep failed")

      const blocked = await jobs.createJob(triggerWithDeps([dep1.id], { job_id: "blocked_3" }), "2026-06-15T00:00:01.000Z")
      await jobs.markBlocked(blocked.id, [dep1.id])

      await jobs.unblockDependents(dep1.id)
      const job = await jobs.getJob(blocked.id)
      expect(job.status).toBe("failed")
      expect(job.error).toContain("failed")
    })

    it("cascade-fails job when dependency timed_out", async () => {
      const jobs = await manager()
      const dep1 = await jobs.createJob(trigger({ job_id: "dep_to" }), "2026-06-15T00:00:00.000Z")
      await jobs.markRunning(dep1.id, "2026-06-15T00:00:01.000Z")
      await jobs.markTimedOut(dep1.id, "2026-06-15T00:00:02.000Z")

      const blocked = await jobs.createJob(triggerWithDeps([dep1.id], { job_id: "blocked_to" }), "2026-06-15T00:00:03.000Z")
      await jobs.markBlocked(blocked.id, [dep1.id])

      await jobs.unblockDependents(dep1.id)
      const job = await jobs.getJob(blocked.id)
      expect(job.status).toBe("failed")
      expect(job.error).toContain("timed_out")
    })

    it("keeps job blocked when dependency is missing (not in store)", async () => {
      const jobs = await manager()
      const blocked = await jobs.createJob(
        triggerWithDeps(["nonexistent_dep"], { job_id: "blocked_missing" }),
        "2026-06-15T00:00:00.000Z",
      )
      await jobs.markBlocked(blocked.id, ["nonexistent_dep"])

      const unblocked = await jobs.unblockDependents("nonexistent_dep")
      expect(unblocked).toHaveLength(0)

      const job = await jobs.getJob(blocked.id)
      expect(job.status).toBe("blocked")
    })

    it("returns empty array when no blocked jobs depend on completed job", async () => {
      const jobs = await manager()
      const dep1 = await jobs.createJob(trigger({ job_id: "lonely_dep" }), "2026-06-15T00:00:00.000Z")
      await jobs.markCompleted(dep1.id)

      const unblocked = await jobs.unblockDependents(dep1.id)
      expect(unblocked).toHaveLength(0)
    })
  })

  describe("remote dependencies", () => {
    it("unblocks a job after its matching remote dependency completes", async () => {
      const jobs = await manager()
      const blocked = await jobs.createJob(trigger({ job_id: "blocked_remote" }))
      await jobs.markBlocked(blocked.id, [{ agent_id: "test-vps", job_id: "remote_1" }])

      const unblocked = await jobs.recordRemoteReport({
        source_agent_id: "test-vps",
        job_id: "remote_1",
        status: "completed",
      })

      expect(unblocked).toHaveLength(1)
      expect(unblocked[0].status).toBe("accepted")
      expect((await jobs.getJob(blocked.id)).remoteDependencies?.[0]?.status).toBe("completed")
    })

    it("fails a job after its matching remote dependency fails", async () => {
      const jobs = await manager()
      const blocked = await jobs.createJob(trigger({ job_id: "blocked_remote_failure" }))
      await jobs.markBlocked(blocked.id, [{ agent_id: "test-vps", job_id: "remote_1" }])

      const unblocked = await jobs.recordRemoteReport({
        source_agent_id: "test-vps",
        job_id: "remote_1",
        status: "failed",
      })

      expect(unblocked).toHaveLength(0)
      expect((await jobs.getJob(blocked.id)).status).toBe("failed")
    })
  })

  describe("callback delivery", () => {
    it("keeps a completed job completed when callback delivery fails", async () => {
      const jobs = await manager()
      const job = await jobs.createJob(trigger({ job_id: "callback_delivery" }))
      await jobs.markCompleted(job.id)

      await jobs.markCallbackDelivery(job.id, "failed", "Callback failed after 1 attempts")

      const stored = await jobs.getJob(job.id)
      expect(stored.status).toBe("completed")
      expect(stored.callbackDelivery?.status).toBe("failed")
    })

    it("returns jobs with pending or failed callback delivery for retry", async () => {
      const jobs = await manager()
      const pending = await jobs.createJob(trigger({ job_id: "callback_pending" }))
      const delivered = await jobs.createJob(trigger({ job_id: "callback_delivered" }))
      await jobs.markCompleted(pending.id)
      await jobs.markCompleted(delivered.id)
      await jobs.markCallbackDelivery(pending.id, "pending")
      await jobs.markCallbackDelivery(delivered.id, "delivered")

      expect((await jobs.listCallbackRetries()).map((job) => job.id)).toEqual([pending.id])
    })
  })
})

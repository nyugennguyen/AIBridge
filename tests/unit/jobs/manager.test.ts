import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { DEPENDENCY_RESOLUTION_WINDOW_MS, JobManager } from "../../../src/jobs/manager.js"
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

    it("keeps job blocked inside resolution window when dependency is missing (not in store)", async () => {
      const jobs = await manager()
      const blocked = await jobs.createJob(
        triggerWithDeps(["nonexistent_dep"], { job_id: "blocked_missing" }),
        "2026-06-15T00:00:00.000Z",
      )
      await jobs.markBlocked(blocked.id, ["nonexistent_dep"], "2026-06-15T00:00:00.000Z")

      // Evaluated inside window via sweepExpiredJobs
      const sweptInside = await jobs.sweepExpiredJobs("2026-06-15T00:00:10.000Z")
      expect(sweptInside).toHaveLength(0)
      expect((await jobs.getJob(blocked.id)).status).toBe("blocked")

      // Evaluated inside window via unblockDependents of an unrelated job
      const unrelated = await jobs.createJob(trigger({ job_id: "unrelated" }), "2026-06-15T00:00:00.000Z")
      await jobs.markCompleted(unrelated.id, "2026-06-15T00:00:10.000Z")
      const unblocked = await jobs.unblockDependents(unrelated.id, "2026-06-15T00:00:10.000Z")
      expect(unblocked).toHaveLength(0)
      expect((await jobs.getJob(blocked.id)).status).toBe("blocked")
    })

    it("fails job past resolution window via sweepExpiredJobs when dependency is missing", async () => {
      const jobs = await manager()
      const blocked = await jobs.createJob(
        triggerWithDeps(["nonexistent_dep"], { job_id: "blocked_missing_sweep" }),
        "2026-06-15T00:00:00.000Z",
      )
      await jobs.markBlocked(blocked.id, ["nonexistent_dep"], "2026-06-15T00:00:00.000Z")

      // Past window: blockedAt (0s) + DEPENDENCY_RESOLUTION_WINDOW_MS (30s) + 1s = 31s
      const pastWindowTime = new Date(Date.parse("2026-06-15T00:00:00.000Z") + DEPENDENCY_RESOLUTION_WINDOW_MS + 1000).toISOString()
      const swept = await jobs.sweepExpiredJobs(pastWindowTime)

      expect(swept).toHaveLength(1)
      expect(swept[0].id).toBe(blocked.id)
      expect(swept[0].status).toBe("failed")
      expect(swept[0].error).toContain("missing")

      const stored = await jobs.getJob(blocked.id)
      expect(stored.status).toBe("failed")
      expect(stored.error).toBe("Dependency nonexistent_dep missing")
    })

    it("fails job past resolution window via late recordRemoteReport when local dependency is missing", async () => {
      const jobs = await manager()
      const blocked = await jobs.createJob(
        triggerWithDeps(["nonexistent_dep"], { job_id: "blocked_mixed_deps" }),
        "2026-06-15T00:00:00.000Z",
      )
      await jobs.markBlocked(
        blocked.id,
        ["nonexistent_dep", { agent_id: "test-vps", job_id: "remote_1" }],
        "2026-06-15T00:00:00.000Z",
      )

      const pastWindowTime = new Date(Date.parse("2026-06-15T00:00:00.000Z") + DEPENDENCY_RESOLUTION_WINDOW_MS + 5000).toISOString()
      const unblocked = await jobs.recordRemoteReport(
        {
          source_agent_id: "test-vps",
          job_id: "remote_1",
          status: "completed",
        },
        pastWindowTime,
      )

      expect(unblocked).toHaveLength(0)
      const stored = await jobs.getJob(blocked.id)
      expect(stored.status).toBe("failed")
      expect(stored.error).toBe("Dependency nonexistent_dep missing")
    })

    it("keeps job waiting when local dependency is genuinely pending (non-terminal)", async () => {
      const jobs = await manager()
      const dep = await jobs.createJob(trigger({ job_id: "pending_dep" }), "2026-06-15T00:00:00.000Z")
      await jobs.markRunning(dep.id, "2026-06-15T00:00:01.000Z")

      const blocked = await jobs.createJob(triggerWithDeps([dep.id], { job_id: "blocked_on_running" }), "2026-06-15T00:00:02.000Z")
      await jobs.markBlocked(blocked.id, [dep.id], "2026-06-15T00:00:02.000Z")

      // Even past the resolution window, a genuinely pending dep keeps the job waiting
      const pastWindowTime = new Date(Date.parse("2026-06-15T00:00:02.000Z") + DEPENDENCY_RESOLUTION_WINDOW_MS + 10000).toISOString()
      const swept = await jobs.sweepExpiredJobs(pastWindowTime)
      expect(swept).toHaveLength(0)
      expect((await jobs.getJob(blocked.id)).status).toBe("blocked")
    })

    it("fails blocked job via sweepExpiredJobs before its own timeout when local dependency has failed", async () => {
      const jobs = await manager()
      const dep = await jobs.createJob(trigger({ job_id: "dep_already_failed" }), "2026-06-15T00:00:00.000Z")
      await jobs.markFailed(dep.id, "dep crashed", "2026-06-15T00:00:01.000Z")

      // Job has 60s timeout; blocked on already-failed dep
      const blocked = await jobs.createJob(
        triggerWithDeps([dep.id], { job_id: "blocked_on_failed_dep", timeout_seconds: 60 }),
        "2026-06-15T00:00:02.000Z",
      )
      await jobs.markBlocked(blocked.id, [dep.id], "2026-06-15T00:00:02.000Z")

      // Swept at 10s: well before job's own 60s timeout (deadline: 02s + 60s = 62s)
      const swept = await jobs.sweepExpiredJobs("2026-06-15T00:00:10.000Z")

      expect(swept).toHaveLength(1)
      expect(swept[0].id).toBe(blocked.id)
      expect(swept[0].status).toBe("failed")
      expect(swept[0].error).toBe("Dependency dep_already_failed failed")

      const stored = await jobs.getJob(blocked.id)
      expect(stored.status).toBe("failed")
      expect(stored.error).toBe("Dependency dep_already_failed failed")
    })

    it("fails job with remote error message when remote dep has failed and local dep is missing inside window", async () => {
      const jobs = await manager()
      const blocked = await jobs.createJob(
        triggerWithDeps(["nonexistent_dep"], { job_id: "blocked_remote_failed_in_window" }),
        "2026-06-15T00:00:00.000Z",
      )
      await jobs.markBlocked(
        blocked.id,
        [
          "nonexistent_dep",
          { agent_id: "test-vps", job_id: "remote_failed" },
        ],
        "2026-06-15T00:00:00.000Z",
      )

      // Late remote report arrives INSIDE the window (5s < 30s) indicating remote dependency failed
      const insideWindowTime = "2026-06-15T00:00:05.000Z"
      const unblocked = await jobs.recordRemoteReport(
        { source_agent_id: "test-vps", job_id: "remote_failed", status: "failed" },
        insideWindowTime,
      )

      expect(unblocked).toHaveLength(0)
      const stored = await jobs.getJob(blocked.id)
      expect(stored.status).toBe("failed")
      expect(stored.error).toBe("Remote dependency test-vps/remote_failed failed")
    })

    it("fails job with remote error message when remote dep has failed and local dep is missing past window", async () => {
      const jobs = await manager()
      const blocked = await jobs.createJob(
        triggerWithDeps(["nonexistent_dep"], { job_id: "blocked_remote_failed_past_window" }),
        "2026-06-15T00:00:00.000Z",
      )
      await jobs.markBlocked(
        blocked.id,
        [
          "nonexistent_dep",
          { agent_id: "test-vps", job_id: "remote_failed" },
        ],
        "2026-06-15T00:00:00.000Z",
      )

      // Late remote report arrives PAST the window (35s > 30s) indicating remote dependency failed
      const pastWindowTime = "2026-06-15T00:00:35.000Z"
      const unblocked = await jobs.recordRemoteReport(
        { source_agent_id: "test-vps", job_id: "remote_failed", status: "failed" },
        pastWindowTime,
      )

      expect(unblocked).toHaveLength(0)
      const stored = await jobs.getJob(blocked.id)
      expect(stored.status).toBe("failed")
      expect(stored.error).toBe("Remote dependency test-vps/remote_failed failed")
    })


    it("cascades failure across dependency chain in a single sweep regardless of store order", async () => {
      const jobs = await manager()
      // Create B first so it precedes A in store.list()
      const jobB = await jobs.createJob(
        triggerWithDeps(["job_a"], { job_id: "job_b", timeout_seconds: 60 }),
        "2026-06-15T00:00:00.000Z",
      )
      await jobs.markBlocked(jobB.id, ["job_a"], "2026-06-15T00:00:00.000Z")

      // Create A after B; A depends on a nonexistent dep
      const jobA = await jobs.createJob(
        triggerWithDeps(["nonexistent_dep"], { job_id: "job_a", timeout_seconds: 60 }),
        "2026-06-15T00:00:00.000Z",
      )
      await jobs.markBlocked(jobA.id, ["nonexistent_dep"], "2026-06-15T00:00:00.000Z")

      // One sweep past the window
      const pastWindowTime = new Date(Date.parse("2026-06-15T00:00:00.000Z") + DEPENDENCY_RESOLUTION_WINDOW_MS + 1000).toISOString()
      const swept = await jobs.sweepExpiredJobs(pastWindowTime)

      expect(swept).toHaveLength(2)
      const sweptA = swept.find((j) => j.id === "job_a")
      const sweptB = swept.find((j) => j.id === "job_b")
      expect(sweptA?.status).toBe("failed")
      expect(sweptA?.error).toBe("Dependency nonexistent_dep missing")
      expect(sweptB?.status).toBe("failed")
      expect(sweptB?.error).toBe("Dependency job_a failed")

      const storedA = await jobs.getJob("job_a")
      const storedB = await jobs.getJob("job_b")
      expect(storedA.status).toBe("failed")
      expect(storedB.status).toBe("failed")
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

/**
 * Review of PR #32 (finding A): a dependent can be ended by two paths at once
 * (a cancel of one of its dependencies, and the resolution that follows
 * another dependency's end, or a remote report). Whoever writes the
 * dependent's end reports it; the other path skips it without failing, and
 * the job whose end triggered the resolution is still reported.
 *
 * The interleaving is forced deterministically: the store's `list()` is
 * frozen, so the second path sees the dependent as `blocked` although the
 * first path has already failed it (exactly the window between listing and
 * writing).
 */
import { describe, expect, it } from "vitest"
import { CANCELLED_BY_REQUESTER, cancelJob } from "../../../src/jobs/cancel.js"
import { finishEndedJob } from "../../../src/jobs/dependents.js"
import { JobManager } from "../../../src/jobs/manager.js"
import type { JobRecord } from "../../../src/jobs/types.js"
import { InMemoryJobStore } from "../../integration/fixtures.js"
import { trigger, triggerWithDeps } from "./fixtures.js"

/** A store whose `list()` can be frozen on a snapshot; `get()` always reads the live record. */
class FreezableListStore extends InMemoryJobStore {
  #snapshot: JobRecord[] | undefined
  async freeze(): Promise<void> {
    this.#snapshot = await super.list()
  }
  override async list(): Promise<JobRecord[]> {
    return this.#snapshot ?? super.list()
  }
}

async function scenario() {
  const store = new FreezableListStore()
  const jobManager = new JobManager(store)
  // X never launched (cancellable directly), Y an OpenCode job running, D waiting on both.
  await jobManager.createJob(trigger({ job_id: "X" }))
  await jobManager.createJob(trigger({ job_id: "Y" }))
  await jobManager.markLaunchStarted("Y")
  await jobManager.attachSession("Y", "ses_y")
  await jobManager.markRunning("Y")
  await jobManager.createJob(triggerWithDeps(["X", "Y"], { job_id: "D" }))
  await jobManager.markBlocked("D", ["X", "Y"])
  const reports: Array<[string, string, string | undefined]> = []
  const reporter = (by: string) => async (job: JobRecord) => {
    reports.push([by, job.id, job.status])
  }
  return { store, jobManager, reports, reporter }
}

describe("dependents ended by two paths at once", () => {
  it("Y's resolution skips a dependent the cancel of X already failed, and Y is still reported once", async () => {
    const h = await scenario()
    // Y's monitor has listed the jobs (D is `blocked` in its view)...
    await h.store.freeze()
    // ...when the requester cancels X, which fails D first and reports it.
    const cancelled = await cancelJob("X", { jobManager: h.jobManager, reportTerminalJob: h.reporter("cancel") })
    expect(cancelled.kind).toBe("cancelled")
    expect(await h.jobManager.getJob("D")).toMatchObject({ status: "failed", error: "Dependency X failed" })

    // Y completes and its monitor settles dependents from its stale list.
    const completed = await h.jobManager.markCompleted("Y")
    const launched: string[] = []
    await finishEndedJob(completed, {
      jobManager: h.jobManager,
      reportTerminalJob: h.reporter("monitor"),
      launch: async (job) => void launched.push(job.id),
    })

    expect(h.reports).toEqual([
      ["cancel", "X", "failed"],
      ["cancel", "D", "failed"],
      ["monitor", "Y", "completed"],
    ])
    expect(launched).toEqual([])
    expect((await h.jobManager.getJob("D")).error).toBe("Dependency X failed")
  })

  it("the reverse order: Y's resolution fails D first, the cancel of X skips it", async () => {
    const h = await scenario()
    await h.jobManager.markFailed("Y", "boom")
    await h.store.freeze()
    const failedY = await h.jobManager.getJob("Y")
    await finishEndedJob(failedY, { jobManager: h.jobManager, reportTerminalJob: h.reporter("monitor") })
    const cancelled = await cancelJob("X", { jobManager: h.jobManager, reportTerminalJob: h.reporter("cancel") })
    expect(cancelled.kind).toBe("cancelled")
    expect(h.reports).toEqual([
      ["monitor", "D", "failed"],
      ["monitor", "Y", "failed"],
      ["cancel", "X", "failed"],
    ])
    expect((await h.jobManager.getJob("D")).error).toBe("Dependency Y failed")
  })

  it("unblockDependents and applyRemoteReport never throw on a dependent another path ended", async () => {
    const h = await scenario()
    await h.jobManager.createJob(trigger({ job_id: "E", depends_on: [{ agent_id: "peer", job_id: "R" }, "X"] }))
    await h.jobManager.markBlocked("E", [{ agent_id: "peer", job_id: "R" }, "X"])
    await h.store.freeze()
    await cancelJob("X", { jobManager: h.jobManager, reportTerminalJob: h.reporter("cancel") })
    await h.jobManager.markCompleted("Y")
    await expect(h.jobManager.unblockDependents("Y")).resolves.toEqual([])
    await expect(h.jobManager.applyRemoteReport({ source_agent_id: "peer", job_id: "R", status: "completed" })).resolves.toEqual({
      unblocked: [],
      failed: [],
    })
    expect(h.reports.map(([, id]) => id).sort()).toEqual(["D", "E", "X"])
  })

  it("applyRemoteReport returns the dependents it failed, so its caller reports them", async () => {
    const jobManager = new JobManager(new InMemoryJobStore())
    await jobManager.createJob(trigger({ job_id: "E", depends_on: [{ agent_id: "peer", job_id: "R" }] }))
    await jobManager.markBlocked("E", [{ agent_id: "peer", job_id: "R" }])
    const outcome = await jobManager.applyRemoteReport({ source_agent_id: "peer", job_id: "R", status: "failed" })
    expect(outcome.unblocked).toEqual([])
    expect(outcome.failed.map((job) => [job.id, job.error])).toEqual([["E", "Remote dependency peer/R failed"]])
  })

  it("a cancelled job's error is the cancel reason", async () => {
    const h = await scenario()
    await cancelJob("X", { jobManager: h.jobManager, reportTerminalJob: h.reporter("cancel") })
    expect((await h.jobManager.getJob("X")).error).toBe(CANCELLED_BY_REQUESTER)
  })
})

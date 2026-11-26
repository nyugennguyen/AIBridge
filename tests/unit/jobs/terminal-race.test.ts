/**
 * Review of PR #27: a job is ended (and reported) exactly once, even when the
 * periodic sweep and the job's own monitor race for it.
 */
import { describe, expect, it } from "vitest"
import type { BridgeConfig } from "../../../src/config/types.js"
import { JobManager } from "../../../src/jobs/manager.js"
import type { JobStore } from "../../../src/jobs/store.js"
import type { JobRecord } from "../../../src/jobs/types.js"
import { ClaudeJobRunner } from "../../../src/runtime/claude-job-runner.js"
import type { RunningScript } from "../../../src/runtime/script-runner.js"
import { InMemoryJobStore, testConfig } from "../../integration/fixtures.js"
import { trigger } from "./fixtures.js"

const T0 = "2026-11-26T00:00:00.000Z"
const LATE = "2026-11-26T01:00:00.000Z"

/** A store whose writes yield to the event loop, so racing writers interleave. */
class SlowStore extends InMemoryJobStore {
  onSave?: (job: JobRecord) => void
  override async save(job: JobRecord): Promise<void> {
    this.onSave?.(job)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await super.save(job)
  }
}

describe("JobManager: terminal writes", () => {
  it("refuses to write a terminal job again, even with the same status", async () => {
    const jobs = new JobManager(new InMemoryJobStore())
    await jobs.createJob(trigger({ job_id: "job_1" }), T0)
    await jobs.markFailed("job_1", "first")
    await expect(jobs.markFailed("job_1", "second")).rejects.toThrow(/terminal/)
    await jobs.createJob(trigger({ job_id: "job_2" }), T0)
    await jobs.markTimedOut("job_2")
    await expect(jobs.markTimedOut("job_2")).rejects.toThrow(/terminal/)
    expect((await jobs.getJob("job_1")).error).toBe("first")
  })

  it("a monitor's terminal write and the sweep racing on one job: exactly one wins", async () => {
    for (const monitorWrite of ["completed", "timed_out"] as const) {
      const store = new SlowStore()
      const jobs = new JobManager(store as JobStore)
      await jobs.createJob(trigger({ job_id: "job_1", timeout_seconds: 1 }), T0)
      await jobs.markLaunchStarted("job_1", T0)
      await jobs.markRunning("job_1", T0)

      const ended: string[] = []
      const monitor = (monitorWrite === "completed" ? jobs.markCompleted("job_1") : jobs.markTimedOut("job_1")).then(
        (job) => void ended.push(`monitor:${job.status}`),
        () => undefined,
      )
      const sweep = jobs.sweepExpiredJobs(LATE).then((swept) => swept.forEach((job) => ended.push(`sweep:${job.status}`)))
      await Promise.all([monitor, sweep])
      expect(ended).toHaveLength(1)
    }
  })

  it("the sweep re-reads the job under its lock and skips one that became active", async () => {
    const jobs = new JobManager(new InMemoryJobStore())
    await jobs.createJob(trigger({ job_id: "job_1", timeout_seconds: 1 }), T0)
    let calls = 0
    // Inactive when listed, active by the time the sweep writes.
    const swept = await jobs.sweepExpiredJobs(LATE, { isActive: () => ++calls > 1 })
    expect(swept).toEqual([])
    expect((await jobs.getJob("job_1")).status).toBe("accepted")
  })

  it("redacts before truncating, so a secret cut by the limit leaves no prefix", async () => {
    const secret = "canary-secret-0123456789"
    const jobs = new JobManager(new InMemoryJobStore(), { redactError: (text) => text.replaceAll(secret, "[REDACTED]") })
    await jobs.createJob(trigger({ job_id: "job_1" }), T0)
    const error = `${"x".repeat(30)}${secret}`
    const failed = await jobs.markFailed("job_1", error, undefined, { maxLength: 40 })
    expect(failed.error).not.toContain("canary")
    expect(failed.error?.length).toBeLessThanOrEqual(40)
  })
})

describe("ClaudeJobRunner keeps a job active until its terminal write", () => {
  it("the sweep never sees the job inactive and unfinished, so it is reported once", async () => {
    const { opencode: _opencode, ...base } = testConfig()
    const config: BridgeConfig = {
      ...base,
      runtime: { kind: "claude" },
      capability_profiles: { deploy: { script: "scripts/deploy.sh", requires_approval: false } },
      security: { auth_mode: "bearer-token", allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["deploy"], requires_plan_approval: [] }] },
      projects: [{ id: "app", path: "/srv/apps/app", capabilities: ["deploy"] }],
      planning: { plan_annotator_enabled: false, require_approval_for: [] },
    }
    const store = new SlowStore()
    const jobs = new JobManager(store as JobStore)
    const reported: string[] = []
    const sweepReports: string[] = []
    const script = (): RunningScript => ({
      kill: () => undefined,
      result: Promise.resolve({
        phase: "main",
        script: "scripts/deploy.sh",
        exit_code: 0,
        timed_out: false,
        duration_ms: 1,
        stdout_tail: "",
        stderr_tail: "",
      }),
    })
    const runner = new ClaudeJobRunner({
      config,
      jobManager: jobs,
      reportTerminalJob: async (job) => void reported.push(`${job.id}:${job.status}`),
      scripts: { start: script },
      pollIntervalMs: 5,
    })
    const activeAtTerminalWrite: boolean[] = []
    const sweeps: Array<Promise<void>> = []
    store.onSave = (job) => {
      if (job.status !== "completed") return
      activeAtTerminalWrite.push(runner.activeJobIds().includes(job.id))
      // The periodic sweep firing at the worst moment, with a deadline long past.
      sweeps.push(
        jobs
          .sweepExpiredJobs(LATE, { isActive: (id) => runner.activeJobIds().includes(id) })
          .then((swept) => swept.forEach((swept) => sweepReports.push(swept.id))),
      )
    }

    const job = await jobs.createJob(trigger({ job_id: "job_1", capability: "deploy", timeout_seconds: 1 }), T0)
    const launch = await runner.start(job)
    const terminal = await runner.monitor(launch)
    await Promise.all(sweeps)

    expect(terminal?.status).toBe("completed")
    expect(activeAtTerminalWrite).toEqual([true])
    expect(sweepReports).toEqual([])
    expect(reported).toEqual(["job_1:completed"])
    expect(runner.activeJobIds()).toEqual([])
  })
})

/**
 * Block K (v3.2.0): what a starting bridge does with each stored job, the
 * launch marker, and the deadline anchors of the sweep.
 */
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import type { BridgeConfig } from "../../../src/config/types.js"
import { JobManager, jobDeadlineMs, jobTimeoutAnchor } from "../../../src/jobs/manager.js"
import {
  INTERRUPTED_BY_RESTART,
  reconcileJobsAfterRestart,
  relaunchJobs,
  relaunchRefusal,
  restartDecision,
  startPeriodicSweep,
} from "../../../src/jobs/reconcile.js"
import { JsonFileJobStore } from "../../../src/jobs/store.js"
import type { JobRecord, JobStatus } from "../../../src/jobs/types.js"
import { testConfig } from "../../integration/fixtures.js"
import { trigger } from "./fixtures.js"

const T0 = "2026-11-26T00:00:00.000Z"

/** Polls `condition` (both test runners lack a common waitFor). */
async function eventually(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function manager(): Promise<JobManager> {
  return new JobManager(new JsonFileJobStore(await mkdtemp(join(tmpdir(), "aibridge-reconcile-"))))
}

/** `testing` runs freely; `deployment` needs an operator (planning.require_approval_for). */
function config(): BridgeConfig {
  const base = testConfig()
  return {
    ...base,
    security: {
      ...base.security,
      allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["testing", "deployment"], requires_plan_approval: [] }],
    },
    projects: [{ id: "app", path: "/srv/apps/app", capabilities: ["testing", "deployment"] }],
  }
}

function claudeConfig(): BridgeConfig {
  const { opencode: _opencode, ...base } = config()
  return {
    ...base,
    runtime: { kind: "claude" },
    capability_profiles: {
      investigate: { allow: ["Read"], requires_approval: false },
      "fix-on-branch": { allow: ["Read", "Edit"], requires_approval: true },
    },
    security: {
      ...base.security,
      allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["investigate", "fix-on-branch", "gone"], requires_plan_approval: [] }],
    },
    projects: [{ id: "app", path: "/srv/apps/app", capabilities: ["investigate", "fix-on-branch", "gone"] }],
    planning: { plan_annotator_enabled: false, require_approval_for: [] },
  }
}

function record(status: JobStatus, overrides: Partial<JobRecord> = {}, triggerOverrides: Parameters<typeof trigger>[0] = {}): JobRecord {
  return {
    id: "job_1",
    trigger: trigger({ job_id: "job_1", ...triggerOverrides }),
    status,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

const approved = { status: "approved" as const, requestedAt: T0, decidedAt: "2026-11-26T00:10:00.000Z", decidedBy: "operator" as const }

describe("restartDecision: status x launchStartedAt", () => {
  const MARKER = { launchStartedAt: "2026-11-26T00:00:01.000Z" }

  it.each(["completed", "failed", "timed_out", "callback_failed", "awaiting_approval", "blocked"] as const)(
    "keeps %s, with or without the marker",
    (status) => {
      expect(restartDecision(record(status), config())).toEqual({ action: "keep" })
      expect(restartDecision(record(status, MARKER), config())).toEqual({ action: "keep" })
    },
  )

  it.each(["received", "session_created", "running", "reporting"] as const)(
    "interrupts %s, with or without the marker: it may have run",
    (status) => {
      expect(restartDecision(record(status), config())).toEqual({ action: "interrupt", error: INTERRUPTED_BY_RESTART })
      expect(restartDecision(record(status, MARKER), config())).toEqual({ action: "interrupt", error: INTERRUPTED_BY_RESTART })
    },
  )

  it("interrupts an accepted job that began launching (the Claude runner spawns before markRunning)", () => {
    expect(restartDecision(record("accepted", MARKER), config())).toEqual({ action: "interrupt", error: INTERRUPTED_BY_RESTART })
    expect(restartDecision(record("accepted", { ...MARKER, approval: approved }, { capability: "deployment" }), config())).toEqual({
      action: "interrupt",
      error: INTERRUPTED_BY_RESTART,
    })
  })

  it("relaunches an accepted job without the marker that needs no approval", () => {
    expect(restartDecision(record("accepted"), config())).toEqual({ action: "relaunch" })
  })

  it("relaunches an accepted job without the marker that an operator approved", () => {
    expect(restartDecision(record("accepted", { approval: approved }, { capability: "deployment" }), config())).toEqual({ action: "relaunch" })
  })
})

describe("relaunchRefusal: the approval boundary (security)", () => {
  it("never relaunches a job that needs approval and carries none, whatever the caller's metadata claims", () => {
    const job = record("accepted", {}, { capability: "deployment", metadata: { plan_status: "approved" } })
    expect(relaunchRefusal(job, config())).toBe("this node now requires operator approval for it")
    expect(restartDecision(job, config())).toEqual({
      action: "decline",
      error: "not relaunched after restart: this node now requires operator approval for it (never started)",
    })
  })

  it("re-evaluates approvalRequired with the CURRENT config: a capability gated since the job was accepted is not relaunched", () => {
    const job = record("accepted")
    expect(relaunchRefusal(job, config())).toBeUndefined()
    const stricter = { ...config(), planning: { plan_annotator_enabled: true, require_approval_for: ["testing", "deployment"] } }
    expect(relaunchRefusal(job, stricter)).toBe("this node now requires operator approval for it")
  })

  it("only an approved approval record counts, even if the capability no longer needs approval", () => {
    const relaxed = { ...config(), planning: { plan_annotator_enabled: true, require_approval_for: [] } }
    for (const status of ["pending", "rejected"] as const) {
      const job = record("accepted", { approval: { status, requestedAt: T0 } }, { capability: "deployment" })
      expect(relaunchRefusal(job, relaxed)).toBe(`operator approval is ${status}`)
    }
  })

  it("refuses a source or project that is no longer allowlisted, and a ping", () => {
    expect(relaunchRefusal(record("accepted", {}, { source_agent_id: "intruder" }), config())).toMatch(/intruder/)
    expect(relaunchRefusal(record("accepted", {}, { project_dir: "/etc" }), config())).toBeDefined()
    expect(relaunchRefusal(record("accepted", {}, { capability: "aibr.ping" }), config())).toBe("a ping is never relaunched")
  })

  it("on a Claude node, uses the capability profile: requires_approval and unknown profiles", () => {
    const claude = claudeConfig()
    expect(relaunchRefusal(record("accepted", {}, { capability: "investigate" }), claude)).toBeUndefined()
    expect(relaunchRefusal(record("accepted", {}, { capability: "fix-on-branch" }), claude)).toBe(
      "this node now requires operator approval for it",
    )
    expect(relaunchRefusal(record("accepted", { approval: approved }, { capability: "fix-on-branch" }), claude)).toBeUndefined()
    expect(relaunchRefusal(record("accepted", {}, { capability: "gone" }), claude)).toBe("Unknown capability profile")
  })

  it("never turns awaiting_approval into a run, even with a forged approved record", () => {
    const forged = record("awaiting_approval", { approval: approved }, { capability: "deployment" })
    expect(restartDecision(forged, config())).toEqual({ action: "keep" })
  })
})

describe("JobManager.markLaunchStarted", () => {
  it("records the marker on an accepted job without changing its status", async () => {
    const jobs = await manager()
    await jobs.createJob(trigger({ job_id: "job_1" }), T0)
    const marked = await jobs.markLaunchStarted("job_1", "2026-11-26T00:00:05.000Z")
    expect(marked).toMatchObject({ status: "accepted", launchStartedAt: "2026-11-26T00:00:05.000Z" })
  })

  it("refuses a job awaiting approval, a second launch, and a terminal job", async () => {
    const jobs = await manager()
    await jobs.createJob(trigger({ job_id: "held" }), T0, { awaitingApproval: true })
    await expect(jobs.markLaunchStarted("held")).rejects.toThrow(/cannot be launched from status awaiting_approval/)

    await jobs.createJob(trigger({ job_id: "once" }), T0)
    await jobs.markLaunchStarted("once")
    await expect(jobs.markLaunchStarted("once")).rejects.toThrow(/already launched/)

    await jobs.createJob(trigger({ job_id: "done" }), T0)
    await jobs.markFailed("done", "x")
    await expect(jobs.markLaunchStarted("done")).rejects.toThrow(/cannot be launched from status failed/)
  })

  it("lets exactly one of two concurrent launches through", async () => {
    const jobs = await manager()
    await jobs.createJob(trigger({ job_id: "job_1" }), T0)
    const results = await Promise.allSettled([jobs.markLaunchStarted("job_1"), jobs.markLaunchStarted("job_1")])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  })
})

describe("deadlines: three anchors", () => {
  it("a job awaiting approval counts from creation (the approval window)", () => {
    expect(jobTimeoutAnchor(record("awaiting_approval", { approval: { status: "pending", requestedAt: T0 } }))).toBe(T0)
  })

  it("an approved job not yet launched counts from the decision", () => {
    expect(jobTimeoutAnchor(record("accepted", { approval: approved }))).toBe(approved.decidedAt)
  })

  it("a launched job counts from launchStartedAt", () => {
    const launched = record("running", { approval: approved, launchStartedAt: "2026-11-26T00:20:00.000Z" })
    expect(jobTimeoutAnchor(launched)).toBe("2026-11-26T00:20:00.000Z")
    expect(jobDeadlineMs(launched)).toBe(Date.parse("2026-11-26T00:20:00.000Z") + 60_000)
  })

  it("any other job counts from creation", () => {
    expect(jobTimeoutAnchor(record("running"))).toBe(T0)
  })

  it("the sweep does not charge time spent waiting for approval to the run", async () => {
    const jobs = await manager()
    await jobs.createJob(trigger({ job_id: "job_1", timeout_seconds: 60 }), T0, { awaitingApproval: true })
    await jobs.approve("job_1", "2026-11-26T00:00:50.000Z")
    await jobs.markLaunchStarted("job_1", "2026-11-26T00:00:55.000Z")
    await jobs.markRunning("job_1", "2026-11-26T00:00:56.000Z")

    expect(await jobs.sweepExpiredJobs("2026-11-26T00:01:30.000Z")).toEqual([])
    expect((await jobs.getJob("job_1")).status).toBe("running")
    expect((await jobs.sweepExpiredJobs("2026-11-26T00:01:56.000Z")).map((job) => job.status)).toEqual(["timed_out"])
  })

  it("an unapproved job still lapses timeout_seconds after creation", async () => {
    const jobs = await manager()
    await jobs.createJob(trigger({ job_id: "job_1", timeout_seconds: 60 }), T0, { awaitingApproval: true })
    expect((await jobs.sweepExpiredJobs("2026-11-26T00:01:01.000Z")).map((job) => job.id)).toEqual(["job_1"])
  })

  it("skips jobs a live monitor drives", async () => {
    const jobs = await manager()
    await jobs.createJob(trigger({ job_id: "live", timeout_seconds: 1 }), T0)
    await jobs.createJob(trigger({ job_id: "stale", timeout_seconds: 1 }), T0)
    const swept = await jobs.sweepExpiredJobs("2026-11-26T00:00:10.000Z", { isActive: (id) => id === "live" })
    expect(swept.map((job) => job.id)).toEqual(["stale"])
    expect((await jobs.getJob("live")).status).toBe("accepted")
  })
})

describe("reconcileJobsAfterRestart", () => {
  it("interrupts what may have run, relaunches what never did, keeps the rest, and fails blocked dependents", async () => {
    const jobs = await manager()
    const now = "2026-11-26T00:00:30.000Z"
    await jobs.createJob(trigger({ job_id: "fresh" }), T0)
    await jobs.createJob(trigger({ job_id: "approved", capability: "deployment" }), T0, { awaitingApproval: true })
    await jobs.approve("approved", "2026-11-26T00:00:10.000Z")
    await jobs.createJob(trigger({ job_id: "unapproved", capability: "deployment" }), T0)
    await jobs.createJob(trigger({ job_id: "launched" }), T0)
    await jobs.markLaunchStarted("launched", T0)
    await jobs.createJob(trigger({ job_id: "running" }), T0)
    await jobs.markLaunchStarted("running", T0)
    await jobs.attachSession("running", "ses_9", T0)
    await jobs.markRunning("running", T0)
    await jobs.createJob(trigger({ job_id: "held", capability: "deployment" }), T0, { awaitingApproval: true })
    await jobs.createJob(trigger({ job_id: "dependent", depends_on: ["running"] }), T0)
    await jobs.markBlocked("dependent", ["running"], T0)
    await jobs.createJob(trigger({ job_id: "expired", timeout_seconds: 1 }), T0)

    const aborted: string[] = []
    const synced: string[] = []
    const result = await reconcileJobsAfterRestart({
      jobManager: jobs,
      config: config(),
      now,
      abortOpencodeSession: async (sessionId) => {
        aborted.push(sessionId)
      },
      taskGraphSyncer: { syncJobToTask: async (taskId, status) => void synced.push(`${taskId}:${status}`) },
    })

    expect(result.relaunch.map((job) => job.id).sort()).toEqual(["approved", "fresh"])
    expect(result.interrupted.map((job) => job.id).sort()).toEqual(["launched", "running"])
    for (const job of result.interrupted) {
      expect(job.status).toBe("failed")
      expect(job.error).toBe(INTERRUPTED_BY_RESTART)
    }
    // Never started, so it is declined, not "interrupted" (which says it may have partly run).
    expect(result.declined.map((job) => job.id)).toEqual(["unapproved"])
    expect((await jobs.getJob("unapproved")).error).toBe("not relaunched after restart: this node now requires operator approval for it (never started)")
    expect(result.swept.map((job) => `${job.id}:${job.status}`).sort()).toEqual(["dependent:failed", "expired:timed_out"])
    expect((await jobs.getJob("held")).status).toBe("awaiting_approval")
    expect((await jobs.getJob("fresh")).status).toBe("accepted")
    expect(aborted).toEqual(["ses_9"])
    expect(synced).toContain("#running:failed")
  })

  it("relaunchJobs launches oldest first and keeps going past a failure", async () => {
    const launched: string[] = []
    await relaunchJobs([record("accepted", { id: "a" }), record("accepted", { id: "b" })], async (job) => {
      launched.push(job.id)
      if (job.id === "a") throw new Error("boom")
    })
    expect(launched).toEqual(["a", "b"])
  })
})

describe("startPeriodicSweep", () => {
  it("sweeps on every tick, reports what it ended and stops", async () => {
    const jobs = await manager()
    const longAgo = new Date(Date.now() - 10_000).toISOString()
    await jobs.createJob(trigger({ job_id: "stale", timeout_seconds: 1 }), longAgo)
    await jobs.createJob(trigger({ job_id: "live", timeout_seconds: 1 }), longAgo)
    const reported: string[] = []
    const stop = startPeriodicSweep({
      jobManager: jobs,
      reportTerminalJob: async (job) => void reported.push(job.id),
      isActive: (id) => id === "live",
      intervalMs: 10,
    })
    try {
      await eventually(() => reported.length > 0)
    } finally {
      stop()
    }
    expect(reported).toEqual(["stale"])
    expect((await jobs.getJob("stale")).status).toBe("timed_out")
    expect((await jobs.getJob("live")).status).toBe("accepted")
  })
})

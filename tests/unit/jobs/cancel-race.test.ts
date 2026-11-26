/**
 * v3.2.0 block B: a requester's cancel goes through the same end-once path as
 * every other way a job ends (block K). Whatever races it (the runner's own
 * completion, the periodic sweep, the kill switch, a second cancel) the job is
 * ended by one terminal write and reported exactly once.
 *
 * Each race runs RACE_ROUNDS times with the interleaving shifted, so a lucky
 * schedule cannot hide a double end.
 */
import { describe, expect, it } from "vitest"
import type { BridgeConfig } from "../../../src/config/types.js"
import { CANCELLED_BY_REQUESTER, cancelJob, type CancelDependencies } from "../../../src/jobs/cancel.js"
import { InMemoryJobEventLog } from "../../../src/jobs/events.js"
import { JobManager } from "../../../src/jobs/manager.js"
import type { JobRecord } from "../../../src/jobs/types.js"
import {
  ClaudeJobRunner,
  STOPPED_BY_OPERATOR,
  jobEventFromRuntime,
  type ClaudeJobLaunch,
  type ClaudeRuntimeAdapterPort,
} from "../../../src/runtime/claude-job-runner.js"
import { OpencodeLaunchError, startOpencodeSession } from "../../../src/opencode/launch.js"
import { InMemoryJobStore, testConfig } from "../../integration/fixtures.js"
import { trigger } from "./fixtures.js"

const RACE_ROUNDS = 20

function claudeConfig(): BridgeConfig {
  const { opencode: _opencode, ...base } = testConfig()
  return {
    ...base,
    runtime: { kind: "claude" },
    capability_profiles: { testing: { allow: ["Read"], requires_approval: false } },
    planning: { plan_annotator_enabled: false, require_approval_for: [] },
  }
}

/** A Claude adapter whose run the test finishes (`complete`) or the runner terminates. */
class FakeClaudeAdapter {
  state: "working" | "completed" | "failed" = "working"
  terminations = 0
  launches = 0
  /** Holds `launch` until released, to stop a job while it is launching. */
  launchGate: Promise<void> | undefined
  pending: Array<{ type: "tool" | "message"; detail: string }> = []

  complete(): void {
    this.state = "completed"
  }

  async launch(): Promise<{ ok: true; value: { sessionId: string } }> {
    this.launches += 1
    await this.launchGate
    return { ok: true, value: { sessionId: `ses-${this.launches}` } }
  }

  async *observe(): AsyncIterable<unknown> {
    for (const item of this.pending.splice(0)) {
      yield { ok: true, value: { type: "lifecycle", state: "working", detail: item.detail } }
    }
    if (this.state === "completed") {
      yield { ok: true, value: { type: "result_available", result: { outcome: "succeeded", summary: "all green" } } }
    }
    yield { ok: true, value: { type: "lifecycle", state: this.state, detail: "Claude Code executing" } }
  }

  async terminate(): Promise<{ ok: true; value: undefined }> {
    this.terminations += 1
    if (this.state === "working") this.state = "failed"
    return { ok: true, value: undefined }
  }

  async collectResult(): Promise<{ ok: true; value: { summary: string } }> {
    return { ok: true, value: { summary: this.state === "completed" ? "all green" : "terminated" } }
  }

  usageFor(): undefined {
    return undefined
  }
}

async function harness() {
  const config = claudeConfig()
  const events = new InMemoryJobEventLog()
  const jobManager = new JobManager(new InMemoryJobStore(), { events })
  const adapter = new FakeClaudeAdapter()
  const reports: JobRecord[] = []
  const reportTerminalJob = async (job: JobRecord) => {
    reports.push(job)
  }
  const runner = new ClaudeJobRunner({
    config,
    jobManager,
    reportTerminalJob,
    adapter: adapter as unknown as ClaudeRuntimeAdapterPort,
    events,
    pollIntervalMs: 1,
  })
  const monitors: Array<Promise<JobRecord | undefined>> = []
  /** Creates, starts and monitors a job, as `/trigger` does. */
  const launch = async (id: string, createdAt?: string): Promise<ClaudeJobLaunch> => {
    await jobManager.createJob(trigger({ job_id: id }), createdAt)
    const started = await runner.start(await jobManager.getJob(id))
    monitors.push(runner.monitor(started))
    return started
  }
  const cancelDependencies: CancelDependencies = {
    jobManager,
    runner,
    reportTerminalJob,
    stopWaitMs: 2_000,
  }
  const settle = async () => {
    await Promise.all(monitors)
  }
  return { config, events, jobManager, adapter, reports, runner, launch, cancelDependencies, settle }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

describe("ClaudeJobRunner.stop", () => {
  it("terminates one running job; its monitor fails it 'cancelled by requester' and reports it once", async () => {
    const h = await harness()
    await h.launch("job_1")
    await h.launch("job_2")
    expect(await h.runner.stop("job_1", CANCELLED_BY_REQUESTER)).toBe("stopping")
    expect(h.adapter.terminations).toBeGreaterThanOrEqual(1)
    const stopped = await h.jobManager.getJob("job_1")
    expect(stopped).toMatchObject({ status: "failed", error: CANCELLED_BY_REQUESTER })
    expect(stopped.runtimeResult?.summary).toMatch(/^Cancelled by requester\./)
    expect(h.reports.map((job) => job.id)).toEqual(["job_1"])
    // The other job is untouched and still running.
    expect((await h.jobManager.getJob("job_2")).status).toBe("running")
    expect(h.runner.isActive("job_2")).toBe(true)
    h.adapter.complete()
    await h.settle()
  })

  it("answers not_active for a job it does not drive, and already_stopping for a second stop", async () => {
    const h = await harness()
    expect(await h.runner.stop("nope", CANCELLED_BY_REQUESTER)).toBe("not_active")
    await h.launch("job_1")
    const [first, second] = await Promise.all([h.runner.stop("job_1", CANCELLED_BY_REQUESTER), h.runner.stop("job_1", "other")])
    expect([first, second]).toEqual(["stopping", "already_stopping"])
    expect((await h.jobManager.getJob("job_1")).error).toBe(CANCELLED_BY_REQUESTER)
    expect(h.reports).toHaveLength(1)
  })

  it("stops a job that is still launching without spawning anything more", async () => {
    const h = await harness()
    let release: () => void = () => undefined
    h.adapter.launchGate = new Promise<void>((resolve) => (release = resolve))
    await h.jobManager.createJob(trigger({ job_id: "job_1" }))
    const starting = h.runner.start(await h.jobManager.getJob("job_1"))
    await tick(5)
    expect(h.runner.isActive("job_1")).toBe(true)
    expect((await h.jobManager.getJob("job_1")).launchStartedAt).toBeDefined()
    const stopping = h.runner.stop("job_1", CANCELLED_BY_REQUESTER)
    release()
    const launch = await starting
    void h.runner.monitor(launch)
    expect(await stopping).toBe("stopping")
    expect(await h.jobManager.getJob("job_1")).toMatchObject({ status: "failed", error: CANCELLED_BY_REQUESTER })
    // The process launched before the stop landed was terminated.
    expect(h.adapter.terminations).toBeGreaterThanOrEqual(1)
    expect(h.reports).toHaveLength(1)
  })

  it("skips the launch entirely when the stop lands before it", async () => {
    const h = await harness()
    await h.jobManager.createJob(trigger({ job_id: "job_1" }))
    // A store-level gate: the stop lands between the marker and the launch.
    const job = await h.jobManager.getJob("job_1")
    const original = h.jobManager.markLaunchStarted.bind(h.jobManager)
    h.jobManager.markLaunchStarted = async (id, now) => {
      const marked = await original(id, now)
      await h.runner.stop(id, CANCELLED_BY_REQUESTER, 0)
      return marked
    }
    const launch = await h.runner.start(job)
    expect(h.adapter.launches).toBe(0)
    expect(await h.runner.monitor(launch)).toMatchObject({ status: "failed", error: CANCELLED_BY_REQUESTER })
    expect(h.reports).toHaveLength(1)
  })

  it("records what the run does as events: tools, messages and the result", async () => {
    const h = await harness()
    await h.launch("job_1")
    h.adapter.pending.push({ type: "message", detail: "Claude Code session initialised, model m, 3 tools" })
    h.adapter.pending.push({ type: "tool", detail: "Tool call: Read" })
    await tick(20)
    h.adapter.complete()
    await h.settle()
    const page = await h.events.read("job_1", 0, 100)
    const shape = page.events.map((event) => [event.type, event.data.status ?? event.data.detail ?? event.data.summary])
    expect(shape).toEqual([
      ["status", "accepted"],
      ["status", "session_created"],
      ["status", "running"],
      ["message", "Claude Code session initialised, model m, 3 tools"],
      ["tool", "Tool call: Read"],
      ["result", "all green"],
      ["status", "completed"],
    ])
    // The polling heartbeat is not an event.
    expect(jobEventFromRuntime({ type: "lifecycle", state: "working", detail: "Claude Code executing" } as never)).toBeUndefined()
  })
})

describe("stopAll is unchanged", () => {
  it("stops every running job with 'stopped by operator', reports each once and returns their ids", async () => {
    const h = await harness()
    await h.launch("job_1")
    await h.launch("job_2")
    const stopped = await h.runner.stopAll()
    expect(stopped.sort()).toEqual(["job_1", "job_2"])
    for (const id of ["job_1", "job_2"]) expect((await h.jobManager.getJob(id)).error).toBe(STOPPED_BY_OPERATOR)
    expect(h.reports.map((job) => job.id).sort()).toEqual(["job_1", "job_2"])
    expect(await h.runner.stopAll()).toEqual([])
  })

  it("does not list a job a requester already cancelled", async () => {
    const h = await harness()
    await h.launch("job_1")
    await h.launch("job_2")
    await cancelJob("job_1", h.cancelDependencies)
    expect(await h.runner.stopAll()).toEqual(["job_2"])
    expect((await h.jobManager.getJob("job_1")).error).toBe(CANCELLED_BY_REQUESTER)
    expect((await h.jobManager.getJob("job_2")).error).toBe(STOPPED_BY_OPERATOR)
    expect(h.reports).toHaveLength(2)
  })
})

describe("cancel of an OpenCode job while it launches", () => {
  it(`ends it once and aborts the session it opened (${RACE_ROUNDS} rounds)`, async () => {
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const jobManager = new JobManager(new InMemoryJobStore())
      await jobManager.createJob(trigger({ job_id: "job_1" }))
      const aborted: string[] = []
      let releasePrompt: () => void = () => undefined
      const promptGate = new Promise<void>((resolve) => (releasePrompt = resolve))
      const client = {
        createSession: async () => ({ id: "ses_1" }),
        sendPromptAsync: async () => {
          await promptGate
        },
        abortSession: async (id: string) => {
          aborted.push(id)
        },
      }
      const reports: JobRecord[] = []
      const reportTerminalJob = async (job: JobRecord) => {
        reports.push(job)
      }
      const launching = startOpencodeSession(await jobManager.getJob("job_1"), { jobManager, opencodeClient: client, reportTerminalJob }).catch(
        (error: unknown) => error,
      )
      await tick(round % 3)
      const cancelled = cancelJob("job_1", { jobManager, abortOpencodeSession: client.abortSession, reportTerminalJob })
      await tick(round % 2)
      releasePrompt()
      const [outcome, launched] = await Promise.all([cancelled, launching])
      expect(outcome.kind).toBe("cancelled")
      expect(launched).toBeInstanceOf(OpencodeLaunchError)
      expect(reports).toHaveLength(1)
      expect(await jobManager.getJob("job_1")).toMatchObject({ status: "failed", error: CANCELLED_BY_REQUESTER })
      // The session the launch opened does not keep working for a cancelled job.
      expect(aborted).toContain("ses_1")
    }
  })
})

describe("cancel races: ended once, reported once", () => {
  it(`cancel vs the runner's own completion (${RACE_ROUNDS} rounds)`, async () => {
    const outcomes = new Set<string>()
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const h = await harness()
      await h.launch("job_1")
      const cancelling = (async () => {
        await tick(round % 4)
        return cancelJob("job_1", h.cancelDependencies)
      })()
      const completing = (async () => {
        await tick((round + 2) % 4)
        h.adapter.complete()
      })()
      const [outcome] = await Promise.all([cancelling, completing])
      await h.settle()
      const job = await h.jobManager.getJob("job_1")
      expect(h.reports).toHaveLength(1)
      expect(h.reports[0]!.status).toBe(job.status)
      if (outcome.kind === "cancelled") expect(job).toMatchObject({ status: "failed", error: CANCELLED_BY_REQUESTER })
      else expect(outcome.kind).toBe("finished")
      outcomes.add(`${outcome.kind}:${job.status}`)
    }
    // Both orders are legitimate; neither double-ends.
    for (const outcome of outcomes) expect(["cancelled:failed", "finished:completed"]).toContain(outcome)
  })

  it(`cancel vs the deadline sweep on a never-launched job (${RACE_ROUNDS} rounds)`, async () => {
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const h = await harness()
      await h.jobManager.createJob(trigger({ job_id: "job_1", timeout_seconds: 1 }), "2026-11-26T00:00:00.000Z")
      const sweepReports: JobRecord[] = []
      const [outcome] = await Promise.all([
        (async () => {
          await tick(round % 3)
          return cancelJob("job_1", h.cancelDependencies)
        })(),
        (async () => {
          await tick((round + 1) % 3)
          sweepReports.push(...(await h.jobManager.sweepExpiredJobs(undefined, { isActive: (id) => h.runner.isActive(id) })))
        })(),
      ])
      const job = await h.jobManager.getJob("job_1")
      expect(h.reports.length + sweepReports.length).toBe(1)
      if (outcome.kind === "cancelled") expect(job.error).toBe(CANCELLED_BY_REQUESTER)
      else expect(job.status).toBe("timed_out")
    }
  })

  it(`cancel vs the kill switch (${RACE_ROUNDS} rounds)`, async () => {
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const h = await harness()
      await h.launch("job_1")
      const [outcome, stopped] = await Promise.all([
        (async () => {
          await tick(round % 2)
          return cancelJob("job_1", h.cancelDependencies)
        })(),
        (async () => {
          await tick((round + 1) % 2)
          return h.runner.stopAll()
        })(),
      ])
      await h.settle()
      const job = await h.jobManager.getJob("job_1")
      expect(h.reports).toHaveLength(1)
      expect(job.status).toBe("failed")
      if (outcome.kind === "cancelled") {
        expect(job.error).toBe(CANCELLED_BY_REQUESTER)
        expect(stopped).toEqual([])
      } else {
        expect(job.error).toBe(STOPPED_BY_OPERATOR)
        expect(stopped).toEqual(["job_1"])
      }
    }
  })

  it(`two cancels of one running job (${RACE_ROUNDS} rounds): one cancels, the other finds it ended`, async () => {
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const h = await harness()
      await h.launch("job_1")
      const outcomes = await Promise.all([cancelJob("job_1", h.cancelDependencies), cancelJob("job_1", h.cancelDependencies)])
      await h.settle()
      expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["cancelled", "finished"])
      expect(h.reports).toHaveLength(1)
    }
  })

  it(`two cancels of one never-launched job (${RACE_ROUNDS} rounds)`, async () => {
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const h = await harness()
      await h.jobManager.createJob(trigger({ job_id: "job_1" }))
      const outcomes = await Promise.all([cancelJob("job_1", h.cancelDependencies), cancelJob("job_1", h.cancelDependencies)])
      expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["cancelled", "finished"])
      expect(h.reports).toHaveLength(1)
    }
  })

  it(`cancel vs a launch of the same never-launched job (${RACE_ROUNDS} rounds)`, async () => {
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const h = await harness()
      await h.jobManager.createJob(trigger({ job_id: "job_1" }))
      const job = await h.jobManager.getJob("job_1")
      const [outcome, launched] = await Promise.all([
        (async () => {
          await tick(round % 3)
          return cancelJob("job_1", h.cancelDependencies)
        })(),
        (async () => {
          await tick((round + 1) % 3)
          try {
            const launch = await h.runner.start(job)
            return await h.runner.monitor(launch)
          } catch {
            return undefined
          }
        })(),
      ])
      await h.settle()
      expect(h.reports).toHaveLength(1)
      const final = await h.jobManager.getJob("job_1")
      expect(final).toMatchObject({ status: "failed", error: CANCELLED_BY_REQUESTER })
      expect(outcome.kind).toBe("cancelled")
      // Either the launch was refused, or it ran and the cancel stopped it.
      if (launched === undefined) expect(h.adapter.launches).toBe(0)
      expect(h.runner.isActive("job_1")).toBe(false)
    }
  })
})

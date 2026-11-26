/**
 * Block K (v3.2.0): a bridge restarted over an existing job store.
 *
 * - `startBridge` (OpenCode) on a `JsonFileJobStore` in a temp state dir,
 *   reports delivered over real HTTP to a loopback "orchestrator";
 * - the real `ClaudeJobRunner` (only the child process is faked) for the
 *   Claude relaunch path.
 */
import { EventEmitter } from "node:events"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import { startBridge, type BridgeInstance } from "../../src/bridge.js"
import { CallbackReporter } from "../../src/callback/reporter.js"
import type { BridgeConfig, ReportCallback } from "../../src/config/types.js"
import { JobManager } from "../../src/jobs/manager.js"
import { INTERRUPTED_BY_RESTART, reconcileJobsAfterRestart, relaunchJobs } from "../../src/jobs/reconcile.js"
import { createTerminalJobReporter } from "../../src/jobs/report.js"
import { JsonFileJobStore } from "../../src/jobs/store.js"
import type { JobRecord } from "../../src/jobs/types.js"
import type { ProcessHandle } from "../../src/runtime/claude-adapter.js"
import { ClaudeJobRunner } from "../../src/runtime/claude-job-runner.js"
import { relaunchClaudeJob } from "../../src/server/routes/claude-dispatch.js"
import { FakeOpencodeClient, FakeTaskGraphSyncer, testConfig } from "./fixtures.js"

const T0 = new Date(Date.now() - 5_000).toISOString()

async function eventually(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

class RecordingOpencodeClient extends FakeOpencodeClient {
  readonly aborted: string[] = []
  override async abortSession(sessionId?: string): Promise<void> {
    this.aborted.push(String(sessionId))
  }
}

interface Orchestrator {
  readonly url: string
  readonly reports: ReportCallback[]
  readonly server: Server
}

async function orchestrator(): Promise<Orchestrator> {
  const reports: ReportCallback[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
    request.on("end", () => {
      reports.push(JSON.parse(body) as ReportCallback)
      response.writeHead(202, { "content-type": "application/json" }).end("{}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, reports, server }
}

const servers: Server[] = []
const bridges: BridgeInstance[] = []
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.app.close()
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
})

function opencodeConfig(callbackOrigin: string): BridgeConfig {
  const base = testConfig()
  return {
    ...base,
    security: {
      ...base.security,
      allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["testing", "deployment"], requires_plan_approval: [] }],
    },
    projects: [{ id: "app", path: "/srv/apps/app", capabilities: ["testing", "deployment"] }],
    agents: [{ id: "dev-main", url: callbackOrigin, capabilities: ["development"] }],
  }
}

function stored(id: string, status: JobRecord["status"], callbackOrigin: string, overrides: Partial<JobRecord> = {}, capability = "testing"): JobRecord {
  return {
    id,
    trigger: {
      job_id: id,
      source_agent_id: "dev-main",
      target_agent_id: "test-vps",
      capability,
      project_dir: "/srv/apps/app",
      prompt: `Do ${id}.`,
      callback_url: `${callbackOrigin}/report`,
      timeout_seconds: 600,
    },
    status,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

async function writeStore(stateDir: string, jobs: readonly JobRecord[]): Promise<void> {
  await mkdir(join(stateDir, "jobs"), { recursive: true })
  for (const job of jobs) await writeFile(join(stateDir, "jobs", `${job.id}.json`), JSON.stringify(job))
}

async function boot(
  configPath: string,
  stateDir: string,
  opencode: RecordingOpencodeClient,
  sweepIntervalMs?: number,
): Promise<BridgeInstance> {
  const bridge = await startBridge({
    configPath,
    stateDir,
    bearerToken: "secret",
    environment: {},
    deps: { opencodeClient: opencode, monitorSession: async () => undefined },
    ...(sweepIntervalMs !== undefined ? { sweepIntervalMs } : {}),
  })
  bridges.push(bridge)
  return bridge
}

describe("startBridge over an existing job store (OpenCode)", () => {
  it("relaunches never-launched jobs exactly once, interrupts and reports the rest, never runs an unapproved job", async () => {
    const peer = await orchestrator()
    servers.push(peer.server)
    const directory = await mkdtemp(join(tmpdir(), "aibridge-restart-"))
    const stateDir = join(directory, "state")
    const configPath = join(directory, "config.json")
    const config = opencodeConfig(peer.url)
    await writeFile(configPath, JSON.stringify(config))
    const approval = { status: "approved" as const, requestedAt: T0, decidedAt: T0, decidedBy: "operator" as const }
    await writeStore(stateDir, [
      stored("fresh", "accepted", peer.url),
      stored("approved", "accepted", peer.url, { approval }, "deployment"),
      stored("unapproved", "accepted", peer.url, {}, "deployment"),
      stored("launched", "accepted", peer.url, { launchStartedAt: T0 }),
      stored("running", "running", peer.url, { launchStartedAt: T0, opencodeSessionId: "ses_old" }),
      stored("held", "awaiting_approval", peer.url, { approval: { status: "pending", requestedAt: T0 } }, "deployment"),
    ])

    const opencode = new RecordingOpencodeClient()
    const bridge = await boot(configPath, stateDir, opencode)
    const result = await bridge.restartReconcile
    expect(result?.relaunch.map((job) => job.id)).toEqual(["approved", "fresh"])

    // Relaunched: one session and one prompt each, marker written.
    expect(opencode.createdSessions).toBe(2)
    expect(opencode.sentPrompts).toBe(2)
    for (const id of ["fresh", "approved"]) {
      const job = await bridge.jobManager.getJob(id)
      expect(job.status).toBe("running")
      expect(job.launchStartedAt).toBeDefined()
    }

    // Interrupted, never relaunched, and reported to the requester.
    for (const id of ["launched", "running", "unapproved"]) {
      const job = await bridge.jobManager.getJob(id)
      expect(job.status).toBe("failed")
      expect(job.error?.startsWith(INTERRUPTED_BY_RESTART)).toBe(true)
    }
    expect(opencode.aborted).toEqual(["ses_old"])
    await eventually(() => peer.reports.length === 3)
    expect(peer.reports.map((report) => report.job_id).sort()).toEqual(["launched", "running", "unapproved"])
    for (const report of peer.reports) {
      expect(report.status).toBe("failed")
      expect(report.summary.startsWith(INTERRUPTED_BY_RESTART)).toBe(true)
    }

    // The approval boundary holds across the restart.
    expect((await bridge.jobManager.getJob("held")).status).toBe("awaiting_approval")
    expect((await bridge.jobManager.getJob("held")).launchStartedAt).toBeUndefined()

    // A second restart: what was relaunched is now in flight, so it is
    // interrupted and reported, never launched a second time.
    await bridge.app.close()
    const again = new RecordingOpencodeClient()
    const second = await boot(configPath, stateDir, again)
    expect((await second.restartReconcile)?.relaunch).toEqual([])
    expect(again.createdSessions).toBe(0)
    expect((await second.jobManager.getJob("fresh")).error).toBe(INTERRUPTED_BY_RESTART)
    expect((await second.jobManager.getJob("held")).status).toBe("awaiting_approval")
    await eventually(() => peer.reports.length === 5)
  })

  it("sweeps deadlines periodically while it runs and reports what it times out", async () => {
    const peer = await orchestrator()
    servers.push(peer.server)
    const directory = await mkdtemp(join(tmpdir(), "aibridge-sweep-"))
    const configPath = join(directory, "config.json")
    await writeFile(configPath, JSON.stringify(opencodeConfig(peer.url)))
    const bridge = await boot(configPath, join(directory, "state"), new RecordingOpencodeClient(), 20)
    await bridge.restartReconcile

    // Created after startup, so only the periodic sweep can end it.
    const job = await bridge.jobManager.createJob(
      { ...stored("late", "accepted", peer.url).trigger, timeout_seconds: 1 },
      new Date(Date.now() - 5_000).toISOString(),
      { awaitingApproval: true },
    )
    await eventually(async () => (await bridge.jobManager.getJob(job.id)).status === "timed_out")
    await eventually(() => peer.reports.some((report) => report.job_id === "late" && report.status === "timed_out"))
  })
})

class MockClaudeProcess extends EventEmitter implements ProcessHandle {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.stdout.end()
    this.emit("exit", null, signal)
    return true
  }
}

function claudeConfig(): BridgeConfig {
  const { opencode: _opencode, ...base } = testConfig()
  return {
    ...base,
    runtime: { kind: "claude" },
    limits: { max_concurrent_jobs: 5 },
    capability_profiles: {
      investigate: { allow: ["Read"], requires_approval: false },
      "fix-on-branch": { allow: ["Read", "Edit"], requires_approval: true },
    },
    security: {
      auth_mode: "bearer-token",
      allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["investigate", "fix-on-branch"], requires_plan_approval: [] }],
    },
    projects: [{ id: "app", path: "/srv/apps/app", capabilities: ["investigate", "fix-on-branch"] }],
    planning: { plan_annotator_enabled: false, require_approval_for: [] },
  }
}

describe("restart over an existing job store (Claude runner)", () => {
  it("spawns each approved or ungated never-launched job once, after writing the marker; never a held or unapproved one", async () => {
    const config = claudeConfig()
    const origin = "http://dev-main.tailnet:8787"
    const approval = { status: "approved" as const, requestedAt: T0, decidedAt: T0, decidedBy: "operator" as const }
    const seed = [
      stored("approved", "accepted", origin, { approval }, "fix-on-branch"),
      stored("ungated", "accepted", origin, {}, "investigate"),
      stored("unapproved", "accepted", origin, {}, "fix-on-branch"),
      stored("spawned", "accepted", origin, { launchStartedAt: T0 }, "investigate"),
      stored("running", "running", origin, { launchStartedAt: T0, runtime: "claude", runtimeSessionId: "s" }, "investigate"),
      stored("held", "awaiting_approval", origin, { approval: { status: "pending", requestedAt: T0 } }, "fix-on-branch"),
    ]
    const storeDir = await mkdtemp(join(tmpdir(), "aibridge-restart-claude-"))
    const store = new JsonFileJobStore(storeDir)
    for (const job of seed) await store.save(job)
    const jobs = new JobManager(store)

    const reports: ReportCallback[] = []
    const callbackReporter = new CallbackReporter({
      attempts: 1,
      baseDelayMs: 1,
      fetcher: async (_url, init) => {
        reports.push(JSON.parse(String(init?.body)) as ReportCallback)
        return new Response(null, { status: 200 })
      },
    })
    const reportTerminalJob = createTerminalJobReporter({ jobManager: jobs, callbackReporter, agentId: config.agent_id, bearerToken: "secret" })
    // At each launch spawn, read the job files from disk SYNCHRONOUSLY: the
    // marker must already be persisted when the process starts.
    const markedOnDisk = (): number =>
      ["approved", "ungated"].filter(
        (id) => (JSON.parse(readFileSync(join(storeDir, `${id}.json`), "utf8")) as JobRecord).launchStartedAt !== undefined,
      ).length
    const launches: Array<{ markedAtSpawn: number }> = []
    const runner = new ClaudeJobRunner({
      config,
      jobManager: jobs,
      reportTerminalJob,
      pollIntervalMs: 5,
      adapterOptions: {
        executablePath: "claude-fake",
        exitDrainGraceMs: 5,
        env: { PATH: "/usr/bin", HOME: "/home/aibr" },
        spawn: (_command, args) => {
          if (!args.includes("--version")) launches.push({ markedAtSpawn: markedOnDisk() })
          return new MockClaudeProcess()
        },
      },
    })

    const reconciled = await reconcileJobsAfterRestart({ jobManager: jobs, config })
    for (const job of reconciled.interrupted) void reportTerminalJob(job)
    expect(reconciled.relaunch.map((job) => job.id).sort()).toEqual(["approved", "ungated"])
    await relaunchJobs(reconciled.relaunch, (job) =>
      relaunchClaudeJob(job, {
        config,
        bearerToken: "secret",
        jobManager: jobs,
        opencodeClient: new FakeOpencodeClient(),
        callbackReporter,
        monitorSession: async () => undefined,
        taskGraphSyncer: new FakeTaskGraphSyncer(),
        claudeJobRunner: runner,
        reportTerminalJob,
      }),
    )

    expect(launches).toHaveLength(2)
    launches.forEach((launch, index) => expect(launch.markedAtSpawn).toBeGreaterThanOrEqual(index + 1))
    expect((await jobs.getJob("approved")).launchStartedAt).toBeDefined()
    expect((await jobs.getJob("ungated")).launchStartedAt).toBeDefined()

    for (const id of ["unapproved", "spawned", "running"]) {
      expect((await jobs.getJob(id)).status).toBe("failed")
    }
    expect((await jobs.getJob("held")).status).toBe("awaiting_approval")
    await eventually(() => reports.filter((report) => report.status === "failed").length >= 3)
    expect(
      reports
        .filter((report) => ["unapproved", "spawned", "running"].includes(report.job_id))
        .every((report) => report.summary.startsWith(INTERRUPTED_BY_RESTART)),
    ).toBe(true)

    // The runner itself refuses to start a held job or a second launch, before any spawn.
    await expect(runner.start(await jobs.getJob("held"))).rejects.toThrow(/awaiting_approval/)
    await expect(runner.start(await jobs.getJob("approved"))).rejects.toThrow()
    expect(launches).toHaveLength(2)
    await runner.stopAll("test over", 1_000)
  })
})

/**
 * Block K follow-up: a launch that fails AFTER `launchStartedAt` was written
 * fails the job at once and reports it exactly once, on every launch path;
 * and error text from OpenCode is scrubbed of this node's secrets before it
 * is stored, so it reaches neither `GET /jobs/:id` nor `/report`.
 */
import { EventEmitter } from "node:events"
import { rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import { startBridge, type BridgeInstance } from "../../src/bridge.js"
import { CallbackReporter } from "../../src/callback/reporter.js"
import type { BridgeConfig, ReportCallback } from "../../src/config/types.js"
import { IngressDrainer } from "../../src/ingress/drainer.js"
import { InMemoryApprovalLedger } from "../../src/jobs/approval-ledger.js"
import { JobManager } from "../../src/jobs/manager.js"
import { createTerminalJobReporter } from "../../src/jobs/report.js"
import { JsonFileJobStore } from "../../src/jobs/store.js"
import type { JobRecord } from "../../src/jobs/types.js"
import { OpencodeLaunchError, startOpencodeSession } from "../../src/opencode/launch.js"
import { createSqliteDriver } from "../../src/orchestration/event-store/sqlite-driver.js"
import type { ProcessHandle } from "../../src/runtime/claude-adapter.js"
import { ClaudeJobRunner } from "../../src/runtime/claude-job-runner.js"
import type { AppDependencies } from "../../src/server/app.js"
import { launchClaudeJob } from "../../src/server/routes/claude-dispatch.js"
import { relaunchOpencodeJob, relaunchOpencodeJobs } from "../../src/server/routes/opencode-dispatch.js"
import { notRelaunchedError } from "../../src/jobs/reconcile.js"
import { buildTestApp, FakeOpencodeClient, FakeTaskGraphSyncer, InMemoryJobStore, testConfig, validTrigger } from "./fixtures.js"

const OPERATOR = "operator-token-value-123"

/** OpenCode accepts the session, then refuses the prompt. */
class RefusingOpencodeClient extends FakeOpencodeClient {
  constructor(private readonly message = "OpenCode refused the prompt") {
    super()
  }
  override async sendPromptAsync(): Promise<void> {
    this.sentPrompts += 1
    throw new Error(this.message)
  }
}

function gatedConfig(): BridgeConfig {
  const config = testConfig()
  config.security.allowed_sources = [
    { source_agent_id: "dev-main", capabilities: ["testing", "deployment"], requires_plan_approval: [] },
  ]
  config.projects = [{ id: "app", path: "/srv/apps/app", capabilities: ["testing", "deployment"] }]
  config.planning = { plan_annotator_enabled: true, require_approval_for: ["deployment"] }
  return config
}

async function harness(opencode: FakeOpencodeClient = new RefusingOpencodeClient()) {
  const reported: string[] = []
  const built = await buildTestApp({
    config: gatedConfig(),
    opencodeClient: opencode,
    operatorToken: OPERATOR,
    approvalLedger: new InMemoryApprovalLedger(),
    reportTerminalJob: async (job) => void reported.push(`${job.id}:${job.status}`),
  })
  const trigger = (overrides: Record<string, unknown>) =>
    built.app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret" }, payload: validTrigger(overrides) })
  return { ...built, reported, trigger }
}

describe("startOpencodeSession after the marker", () => {
  it("fails the job with the launch error, reports it once and throws OpencodeLaunchError", async () => {
    const jobManager = new JobManager(new InMemoryJobStore())
    const job = await jobManager.createJob(validTrigger() as never)
    const reported: JobRecord[] = []
    const error = await startOpencodeSession(job, {
      jobManager,
      opencodeClient: new RefusingOpencodeClient(),
      reportTerminalJob: async (failed) => void reported.push(failed),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(OpencodeLaunchError)
    const stored = await jobManager.getJob(job.id)
    expect(stored).toMatchObject({ status: "failed", error: "OpenCode refused the prompt" })
    expect(stored.launchStartedAt).toBeDefined()
    expect(reported.map((failed) => failed.id)).toEqual([job.id])
  })

  it("leaves the job alone when the marker itself is refused", async () => {
    const jobManager = new JobManager(new InMemoryJobStore())
    const job = await jobManager.createJob(validTrigger() as never, undefined, { awaitingApproval: true })
    const opencode = new FakeOpencodeClient()
    const reported: JobRecord[] = []
    await expect(
      startOpencodeSession(job, { jobManager, opencodeClient: opencode, reportTerminalJob: async (failed) => void reported.push(failed) }),
    ).rejects.toThrow(/cannot be launched from status awaiting_approval/)
    expect((await jobManager.getJob(job.id)).status).toBe("awaiting_approval")
    expect(opencode.createdSessions).toBe(0)
    expect(reported).toEqual([])
  })
})

describe("OpenCode launch paths fail and report a refused launch once", () => {
  it("/trigger answers 500 and reports the failed job", async () => {
    const h = await harness()
    const response = await h.trigger({ capability: "testing" })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({ error: "OpenCode refused the prompt", code: "opencode_launch_failed" })
    expect((await h.jobManager.getJob("job_1")).status).toBe("failed")
    expect(h.reported).toEqual(["job_1:failed"])
  })

  it("aibr approve reports it exactly once (no second report from the approve route)", async () => {
    const h = await harness()
    expect((await h.trigger({ capability: "deployment" })).json()).toMatchObject({ status: "awaiting_approval" })
    const approved = await h.app.inject({
      method: "POST",
      url: "/jobs/job_1/approve",
      headers: { authorization: `Bearer ${OPERATOR}` },
      payload: {},
    })
    expect(approved.statusCode).toBe(500)
    expect((await h.jobManager.getJob("job_1")).status).toBe("failed")
    expect(h.reported).toEqual(["job_1:failed"])
  })

  it("/report unblocking fails and reports the dependent job", async () => {
    const h = await harness()
    const blocked = await h.jobManager.createJob(
      validTrigger({ job_id: "job_waiting", depends_on: [{ agent_id: "dev-main", job_id: "remote_1" }] }) as never,
    )
    await h.jobManager.markBlocked(blocked.id, blocked.trigger.depends_on ?? [])
    const response = await h.app.inject({
      method: "POST",
      url: "/report",
      headers: { authorization: "Bearer secret" },
      payload: {
        job_id: "remote_1",
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        status: "completed",
        summary: "done",
        findings: [],
        artifacts: [],
        started_at: "2026-11-26T00:00:00.000Z",
        completed_at: "2026-11-26T00:01:00.000Z",
      },
    })
    expect(response.statusCode).toBe(202)
    expect((await h.jobManager.getJob("job_waiting")).status).toBe("failed")
    expect(h.reported).toEqual(["job_waiting:failed"])
  })

  it("the router drainer fails and reports the job, and fails the row", async () => {
    const dbPath = join(tmpdir(), `aibridge-launch-failure-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
    const driver = createSqliteDriver({ path: dbPath, create: true })
    try {
      driver.exec(`
        CREATE TABLE ingress_outbox (
          job_id TEXT PRIMARY KEY, subject_job_id TEXT NOT NULL, route TEXT NOT NULL,
          schema_version TEXT NOT NULL, payload_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
          next_attempt_at_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0, claim_token TEXT,
          claimed_at_ms INTEGER,
          status TEXT NOT NULL CHECK (status IN ('pending','sending','acknowledged','failed')),
          last_error TEXT, terminal_error TEXT, CHECK (attempts >= 0));
      `)
      const config = testConfig()
      config.bridge = { ...config.bridge, ingress_mode: "router" }
      config.projects = [{ id: "app", path: process.cwd(), capabilities: ["testing"] }]
      config.security.allowed_sources = [{ source_agent_id: "dev-main", capabilities: ["testing"], requires_plan_approval: [] }]
      const jobManager = new JobManager(new InMemoryJobStore())
      const reported: string[] = []
      const drainer = new IngressDrainer({
        driver,
        config,
        jobManager,
        opencodeClient: new RefusingOpencodeClient(),
        taskGraphSyncer: new FakeTaskGraphSyncer(),
        monitorSession: async () => {},
        reportTerminalJob: async (job) => void reported.push(`${job.id}:${job.status}`),
      })
      driver.run(
        `INSERT INTO ingress_outbox (job_id, subject_job_id, route, schema_version, payload_json, created_at_ms, next_attempt_at_ms, attempts, status)
         VALUES ('job_router', 'job_router', 'POST /trigger', 'v1', ?, 1000, 1000, 0, 'pending')`,
        JSON.stringify(validTrigger({ job_id: "job_router", project_dir: process.cwd() })),
      )
      await drainer.drainOnce(1000)
      expect((await jobManager.getJob("job_router")).status).toBe("failed")
      expect(reported).toEqual(["job_router:failed"])
      const row = driver.get<{ last_error: string | null }>("SELECT last_error FROM ingress_outbox WHERE job_id = 'job_router'")
      expect(row?.last_error).toBe("OpenCode refused the prompt")
    } finally {
      driver.close()
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true })
    }
  })
})

class FailingClaudeProcess extends EventEmitter implements ProcessHandle {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  kill(): boolean {
    return true
  }
}

describe("Claude runner launch failure after the marker", () => {
  async function claudeHarness() {
    const { opencode: _opencode, ...base } = testConfig()
    const config: BridgeConfig = {
      ...base,
      runtime: { kind: "claude" },
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
    const jobManager = new JobManager(new JsonFileJobStore(await mkdtemp(join(tmpdir(), "aibridge-claude-launch-failure-"))))
    const reports: ReportCallback[] = []
    const callbackReporter = new CallbackReporter({
      attempts: 1,
      baseDelayMs: 1,
      fetcher: async (_url, init) => {
        reports.push(JSON.parse(String(init?.body)) as ReportCallback)
        return new Response(null, { status: 200 })
      },
    })
    const reportTerminalJob = createTerminalJobReporter({ jobManager, callbackReporter, agentId: config.agent_id, bearerToken: "secret" })
    let spawns = 0
    const runner = new ClaudeJobRunner({
      config,
      jobManager,
      reportTerminalJob,
      pollIntervalMs: 5,
      adapterOptions: {
        executablePath: "claude-fake",
        exitDrainGraceMs: 5,
        env: { PATH: "/usr/bin", HOME: "/home/aibr" },
        spawn: (_command, args) => {
          if (args.includes("--version")) return new FailingClaudeProcess()
          spawns += 1
          throw new Error("spawn claude-fake ENOENT")
        },
      },
    })
    const { app } = await buildTestApp({
      config,
      jobManager,
      operatorToken: OPERATOR,
      approvalLedger: new InMemoryApprovalLedger(),
      reportTerminalJob,
      claudeJobRunner: runner,
    })
    const deps: AppDependencies = {
      config,
      bearerToken: "secret",
      jobManager,
      opencodeClient: new FakeOpencodeClient(),
      callbackReporter,
      monitorSession: async () => undefined,
      taskGraphSyncer: new FakeTaskGraphSyncer(),
      claudeJobRunner: runner,
      reportTerminalJob,
    }
    return { app, jobManager, reports, deps, spawns: () => spawns }
  }

  it("a refused marker (job held for approval) leaves the job untouched and reports nothing", async () => {
    const h = await claudeHarness()
    const held = await h.jobManager.createJob(validTrigger({ capability: "fix-on-branch" }) as never, undefined, { awaitingApproval: true })
    const outcome = await launchClaudeJob(held, h.deps, { reportFailure: true })
    expect(outcome).toMatchObject({ ok: false, statusCode: 409, body: { code: "launch_refused" } })
    expect(await h.jobManager.getJob(held.id)).toEqual(held)
    expect(h.spawns()).toBe(0)
    expect(h.reports).toEqual([])
  })

  it("/trigger: the job is failed at once and reported once", async () => {
    const h = await claudeHarness()
    const response = await h.app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger({ capability: "investigate" }),
    })
    expect(response.statusCode).toBe(500)
    expect(response.json().code).toBe("claude_launch_failed")
    const job = await h.jobManager.getJob("job_1")
    expect(job.status).toBe("failed")
    expect(job.launchStartedAt).toBeDefined()
    expect(h.reports.map((report) => `${report.job_id}:${report.status}`)).toEqual(["job_1:failed"])
  })

  it("aibr approve: reported once, not again by the approve route", async () => {
    const h = await claudeHarness()
    const held = await h.app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger({ capability: "fix-on-branch" }),
    })
    expect(held.json()).toMatchObject({ status: "awaiting_approval" })
    const approved = await h.app.inject({
      method: "POST",
      url: "/jobs/job_1/approve",
      headers: { authorization: `Bearer ${OPERATOR}` },
      payload: {},
    })
    expect(approved.statusCode).toBe(500)
    expect((await h.jobManager.getJob("job_1")).status).toBe("failed")
    expect(h.reports.map((report) => `${report.job_id}:${report.status}`)).toEqual(["job_1:failed"])
  })
})

describe("relaunchOpencodeJob never reports a job twice", () => {
  it("leaves alone a job another path already ended (and reported)", async () => {
    const reported: string[] = []
    const jobManager = new JobManager(new InMemoryJobStore())
    const job = await jobManager.createJob(validTrigger() as never)
    await jobManager.markFailed(job.id, "ended elsewhere")
    const opencode = new FakeOpencodeClient()
    const deps = {
      config: testConfig(),
      bearerToken: "secret",
      jobManager,
      opencodeClient: opencode,
      callbackReporter: new CallbackReporter({ attempts: 1, baseDelayMs: 1, fetcher: async () => new Response(null, { status: 200 }) }),
      monitorSession: async () => undefined,
      taskGraphSyncer: new FakeTaskGraphSyncer(),
      reportTerminalJob: async (failed: JobRecord) => void reported.push(failed.id),
    }
    await relaunchOpencodeJob(job, deps)
    expect(reported).toEqual([])
    expect(opencode.createdSessions).toBe(0)
    expect((await jobManager.getJob(job.id)).error).toBe("ended elsewhere")

    // Unhealthy OpenCode: still no second report for an ended job.
    const unhealthy = new (class extends FakeOpencodeClient {
      override async health(): Promise<boolean> {
        return false
      }
    })()
    await relaunchOpencodeJobs([job], { ...deps, opencodeClient: unhealthy }, { healthWaitMs: 0, healthPollMs: 1 })
    expect(reported).toEqual([])
  })

  it("checks OpenCode health once per batch and declines the whole batch when it is down", async () => {
    const reported: string[] = []
    const jobManager = new JobManager(new InMemoryJobStore())
    const first = await jobManager.createJob(validTrigger({ job_id: "a" }) as never)
    const second = await jobManager.createJob(validTrigger({ job_id: "b" }) as never)
    let healthChecks = 0
    const down = new (class extends FakeOpencodeClient {
      override async health(): Promise<boolean> {
        healthChecks += 1
        return false
      }
    })()
    const started = Date.now()
    await relaunchOpencodeJobs(
      [first, second],
      {
        config: testConfig(),
        bearerToken: "secret",
        jobManager,
        opencodeClient: down,
        callbackReporter: new CallbackReporter({ attempts: 1, baseDelayMs: 1, fetcher: async () => new Response(null, { status: 200 }) }),
        monitorSession: async () => undefined,
        taskGraphSyncer: new FakeTaskGraphSyncer(),
        reportTerminalJob: async (failed: JobRecord) => void reported.push(`${failed.id}:${failed.error}`),
      },
      { healthWaitMs: 50, healthPollMs: 10 },
    )
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(healthChecks).toBeLessThanOrEqual(7)
    expect(down.createdSessions).toBe(0)
    expect(reported).toEqual([
      `a:${notRelaunchedError("OpenCode unavailable")}`,
      `b:${notRelaunchedError("OpenCode unavailable")}`,
    ])
    expect(notRelaunchedError("OpenCode unavailable")).toBe("not relaunched after restart: OpenCode unavailable (never started)")
  })
})

describe("canary: secrets in OpenCode error text", () => {
  const BEARER = "canary-bearer-7f3a9c21d4"
  const OPENCODE_PASSWORD = "canary-oc-pass-5e8b1d"
  const PROVIDER_KEY = "sk-ant-canaryCANARYcanary0123456789"
  const CANARIES = [BEARER, OPENCODE_PASSWORD, PROVIDER_KEY]

  const servers: Server[] = []
  const bridges: BridgeInstance[] = []
  afterEach(async () => {
    for (const bridge of bridges.splice(0)) await bridge.app.close()
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  })

  it("never reach /trigger's answer, GET /jobs/:id or the /report callback", async () => {
    const reports: string[] = []
    const server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
      request.on("end", () => {
        reports.push(body)
        response.writeHead(202, { "content-type": "application/json" }).end("{}")
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    servers.push(server)
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const directory = await mkdtemp(join(tmpdir(), "aibridge-canary-"))
    const configPath = join(directory, "config.json")
    await writeFile(configPath, JSON.stringify({ ...testConfig(), agents: [{ id: "dev-main", url: origin, capabilities: ["development"] }] }))
    const stateDir = join(directory, "state")
    await mkdir(stateDir, { recursive: true })

    const leaky = new RefusingOpencodeClient(
      `POST http://opencode:${OPENCODE_PASSWORD}@127.0.0.1:4096/session failed; Authorization: Bearer ${BEARER}; upstream key ${PROVIDER_KEY}`,
    )
    const bridge = await startBridge({
      configPath,
      stateDir,
      bearerToken: BEARER,
      environment: { OPENCODE_SERVER_PASSWORD: OPENCODE_PASSWORD },
      deps: { opencodeClient: leaky, monitorSession: async () => undefined },
    })
    bridges.push(bridge)

    const triggered = await bridge.app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: `Bearer ${BEARER}` },
      payload: validTrigger({ callback_url: `${origin}/report` }),
    })
    expect(triggered.statusCode).toBe(500)
    const status = await bridge.app.inject({ method: "GET", url: "/jobs/job_1", headers: { authorization: `Bearer ${BEARER}` } })
    expect(status.json()).toMatchObject({ status: "failed" })
    expect(status.json().error).toContain("[REDACTED]")

    const deadline = Date.now() + 5_000
    while (reports.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(reports).toHaveLength(1)
    expect(JSON.parse(reports[0]!)).toMatchObject({ job_id: "job_1", status: "failed" })

    for (const text of [triggered.body, status.body, reports[0]!]) {
      for (const canary of CANARIES) expect(text).not.toContain(canary)
    }
  })
})

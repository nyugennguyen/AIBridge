/**
 * v3.2.0 block B end to end through `app.inject()`: trigger -> events ->
 * cancel on both runtimes, the kill switch unchanged, and the MCP tools
 * (`bridge_events`, `bridge_cancel`) against the real routes.
 */
import { mkdtemp, readdir, writeFile } from "node:fs/promises"
import { startBridge } from "../../src/bridge.js"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { BridgeConfig } from "../../src/config/types.js"
import { CANCELLED_BY_REQUESTER } from "../../src/jobs/cancel.js"
import { InMemoryJobEventLog } from "../../src/jobs/events.js"
import { JobManager } from "../../src/jobs/manager.js"
import { JsonFileJobStore } from "../../src/jobs/store.js"
import type { JobRecord } from "../../src/jobs/types.js"
import { BridgeTools, type BridgeToolDeps } from "../../src/mcp/bridge-tools.js"
import { ClaudeJobRunner, STOPPED_BY_OPERATOR, type ClaudeRuntimeAdapterPort } from "../../src/runtime/claude-job-runner.js"
import { FakeOpencodeClient, testConfig, validTrigger } from "./fixtures.js"
import { jobApiApp, WORKER_URL, type Peer } from "./job-api-fixtures.js"

class FakeClaudeAdapter {
  state: "working" | "completed" | "failed" = "working"
  terminations = 0
  launches = 0
  pending: string[] = []

  async launch(): Promise<{ ok: true; value: { sessionId: string } }> {
    this.launches += 1
    return { ok: true, value: { sessionId: `ses-${this.launches}` } }
  }
  async *observe(): AsyncIterable<unknown> {
    for (const detail of this.pending.splice(0)) yield { ok: true, value: { type: "lifecycle", state: "working", detail } }
    yield { ok: true, value: { type: "lifecycle", state: this.state, detail: "Claude Code executing" } }
  }
  async terminate(): Promise<{ ok: true; value: undefined }> {
    this.terminations += 1
    if (this.state === "working") this.state = "failed"
    return { ok: true, value: undefined }
  }
  async collectResult(): Promise<{ ok: true; value: { summary: string } }> {
    return { ok: true, value: { summary: this.state === "completed" ? "done" : "terminated" } }
  }
  usageFor(): undefined {
    return undefined
  }
}

class RecordingOpencodeClient extends FakeOpencodeClient {
  readonly aborted: string[] = []
  override async abortSession(sessionId?: string): Promise<void> {
    if (sessionId !== undefined) this.aborted.push(sessionId)
  }
}

function claudeConfig(base: BridgeConfig): BridgeConfig {
  const { opencode: _opencode, ...rest } = base
  return {
    ...rest,
    runtime: { kind: "claude" },
    capability_profiles: { testing: { allow: ["Read"], requires_approval: false } },
    planning: { plan_annotator_enabled: false, require_approval_for: [] },
  }
}

async function claudeHarness() {
  const events = new InMemoryJobEventLog()
  const jobManager = new JobManager(new JsonFileJobStore(await mkdtemp(join(tmpdir(), "aibr-job-api-int-"))), { events })
  const adapter = new FakeClaudeAdapter()
  const reports: JobRecord[] = []
  const reportTerminalJob = async (job: JobRecord) => {
    reports.push(job)
  }
  const monitors: Array<Promise<JobRecord | undefined>> = []
  let runner: ClaudeJobRunner | undefined
  const h = await jobApiApp({
    config: claudeConfig,
    jobManager,
    events,
    reportTerminalJob,
    claudeJobRunner: {
      start: (job) => runner!.start(job),
      monitor: (launch) => {
        const monitored = runner!.monitor(launch)
        monitors.push(monitored)
        return monitored
      },
      hasCapacity: () => runner!.hasCapacity(),
      stopAll: (reason?: string, waitMs?: number) => runner!.stopAll(reason, waitMs),
      stop: (id: string, reason: string, waitMs?: number) => runner!.stop(id, reason, waitMs),
      isActive: (id: string) => runner!.isActive(id),
    },
  })
  runner = new ClaudeJobRunner({
    config: h.config,
    jobManager,
    reportTerminalJob,
    adapter: adapter as unknown as ClaudeRuntimeAdapterPort,
    events,
    pollIntervalMs: 1,
  })
  return { ...h, adapter, reports, runner, settle: () => Promise.all(monitors) }
}

describe("trigger -> events -> cancel (Claude runtime)", () => {
  it("follows a running job and cancels it: process terminated, job failed, reported once", async () => {
    const h = await claudeHarness()
    expect((await h.triggerAs("dev-main", { job_id: "job_1", capability: "testing" })).statusCode).toBe(202)
    h.adapter.pending.push("Tool call: Bash")
    await new Promise((resolve) => setTimeout(resolve, 20))

    const listed = (await h.asPeer("dev-main", "GET", "/jobs")).json()
    expect(listed.jobs).toEqual([expect.objectContaining({ job_id: "job_1", status: "running", final: false })])
    const events = (await h.asPeer("dev-main", "GET", "/jobs/job_1/events")).json()
    expect(events.events.map((event: { type: string }) => event.type)).toEqual(["status", "status", "status", "tool"])

    const cancelled = await h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json()).toMatchObject({ job_id: "job_1", status: "failed", error: CANCELLED_BY_REQUESTER, cancelled: true })
    expect(h.adapter.terminations).toBeGreaterThanOrEqual(1)
    await h.settle()
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]!.runtimeResult?.summary).toMatch(/^Cancelled by requester\./)

    const after = (await h.asPeer("dev-main", "GET", `/jobs/job_1/events?after=${events.next}`)).json()
    expect(after.final).toBe(true)
    expect(after.events.at(-1)).toMatchObject({ type: "status", data: { status: "failed", error: CANCELLED_BY_REQUESTER } })

    const again = await h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")
    expect(again.statusCode).toBe(409)
    expect(again.json().status).toBe("failed")
    expect(h.reports).toHaveLength(1)
    expect(h.ledger.lines).toEqual([])
  })

  it("two concurrent cancels: one 200, the other 409, one report", async () => {
    for (let round = 0; round < 20; round += 1) {
      const h = await claudeHarness()
      await h.triggerAs("dev-main", { job_id: "job_1", capability: "testing" })
      const responses = await Promise.all([
        h.asPeer("dev-main", "POST", "/jobs/job_1/cancel"),
        h.asPeer("dev-main", "POST", "/jobs/job_1/cancel"),
      ])
      await h.settle()
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409])
      expect(h.reports).toHaveLength(1)
    }
  })

  it("leaves the kill switch as it was: operator-only, every job 'stopped by operator', ledger entry", async () => {
    const h = await claudeHarness()
    await h.triggerAs("dev-main", { job_id: "job_1", capability: "testing" })
    await h.triggerAs("qa-node", { job_id: "job_2", capability: "testing" })
    // A peer cannot reach it, signed or not.
    expect((await h.asPeer("dev-main", "POST", "/operator/stop-all-jobs")).statusCode).toBe(403)
    const response = await h.asOperator("POST", "/operator/stop-all-jobs")
    expect(response.statusCode).toBe(200)
    expect(response.json().stopped.sort()).toEqual(["job_1", "job_2"])
    await h.settle()
    for (const id of ["job_1", "job_2"]) expect((await h.jobManager.getJob(id)).error).toBe(STOPPED_BY_OPERATOR)
    expect(h.reports).toHaveLength(2)
    expect(h.ledger.lines.map((line) => JSON.parse(line).type)).toEqual(["jobs.stopped"])
  })
})

describe("trigger -> events -> cancel (OpenCode runtime)", () => {
  it("cancels a running OpenCode job: ended, then its session aborted, reported once", async () => {
    const opencode = new RecordingOpencodeClient()
    const h = await jobApiApp({ opencodeClient: opencode })
    expect((await h.triggerAs("dev-main", { job_id: "job_1" })).statusCode).toBe(202)
    const job = await h.jobManager.getJob("job_1")
    expect(job.status).toBe("running")
    const events = (await h.asPeer("dev-main", "GET", "/jobs/job_1/events")).json()
    // OpenCode jobs only have status events.
    expect(events.events.every((event: { type: string }) => event.type === "status")).toBe(true)
    expect(events.events.map((event: { data: { status: string } }) => event.data.status)).toEqual(["accepted", "session_created", "running"])

    const cancelled = await h.asPeer("dev-main", "POST", "/jobs/job_1/cancel")
    expect(cancelled.statusCode).toBe(200)
    expect(opencode.aborted).toEqual([job.opencodeSessionId])
    expect(h.reports.map((report) => [report.id, report.error])).toEqual([["job_1", CANCELLED_BY_REQUESTER]])
  })
})

describe("startBridge wiring", () => {
  it("writes each job's events to <state>/jobs/<id>.events.jsonl and serves them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibr-job-api-bridge-"))
    const stateDir = join(directory, "state")
    const configPath = join(directory, "config.json")
    await writeFile(configPath, JSON.stringify(testConfig()))
    const bridge = await startBridge({
      configPath,
      stateDir,
      bearerToken: "secret",
      operatorToken: "operator-secret",
      environment: {},
      deps: { opencodeClient: new FakeOpencodeClient(), monitorSession: async () => undefined },
    })
    try {
      const triggered = await bridge.app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret" }, payload: validTrigger() })
      expect(triggered.statusCode).toBe(202)
      expect((await readdir(join(stateDir, "jobs"))).sort()).toEqual(["job_1.events.jsonl", "job_1.json"])
      const events = await bridge.app.inject({ method: "GET", url: "/jobs/job_1/events", headers: { authorization: "Bearer operator-secret" } })
      expect(events.statusCode).toBe(200)
      expect(events.json().events.map((event: { data: { status: string } }) => event.data.status)).toEqual(["accepted", "session_created", "running"])
      // The job store reloaded from disk still sees exactly one job.
      expect((await new JsonFileJobStore(join(stateDir, "jobs")).list()).map((job) => job.id)).toEqual(["job_1"])
    } finally {
      await bridge.app.close()
    }
  })
})

describe("MCP tools against the real routes", () => {
  async function mcpFor(h: Awaited<ReturnType<typeof claudeHarness>>, peer: Peer) {
    const home = "/home/mcp"
    const configPath = `${home}/.config/aibridge/dev/config.json`
    const tokenPath = `${home}/.local/share/aibridge/dev/secrets/bearer_token`
    const files: Record<string, string> = {
      [configPath]: JSON.stringify({
        agent_id: peer,
        bridge: { host: "127.0.0.1", port: 8787, public_url: `http://${peer}.tailnet:8787`, ingress_mode: "engine" },
        opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096 },
        security: { auth_mode: "bearer-token", allowed_sources: [] },
        permissions: { default_response: "reject", allow_tools: [], require_plan_approval_for_tools: [] },
        projects: [],
        agents: [{ id: "test-vps", url: WORKER_URL, capabilities: ["testing"] }],
        timeouts: { default_job_seconds: 900, callback_retry_attempts: 1 },
        planning: { plan_annotator_enabled: false, require_approval_for: [] },
      }),
      [tokenPath]: "secret\n",
    }
    const deps = {
      fetch: async (url: string, init?: RequestInit) => {
        const target = new URL(url)
        const response = await h.app.inject({
          method: (init?.method ?? "GET") as "GET" | "POST",
          url: `${target.pathname}${target.search}`,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          ...(typeof init?.body === "string" ? { payload: init.body } : {}),
        })
        return new Response(response.body, { status: response.statusCode, headers: { "content-type": String(response.headers["content-type"] ?? "application/json") } })
      },
      env: { HOME: home },
      readFile: async (path: string) => {
        const value = files[path]
        if (value === undefined) throw new Error("ENOENT")
        return value
      },
      listProfileDirs: async () => ["dev"],
      writeFile: async () => undefined,
      uuid: () => "unused",
      now: () => Date.now(),
      sleep: async () => undefined,
      loadKey: async () => h.keys[peer],
    } as BridgeToolDeps
    return new BridgeTools(deps, "dev")
  }

  it("bridge_events pages a job and bridge_cancel cancels it for its requester", async () => {
    const h = await claudeHarness()
    await h.triggerAs("dev-main", { job_id: "job_1", capability: "testing" })
    const tools = await mcpFor(h, "dev-main")
    const page = JSON.parse((await tools.call("bridge_events", { job_id: "job_1", target: "test-vps" })).content[0]!.text)
    expect(page).toMatchObject({ job_id: "job_1", status: "running", final: false, next: 3 })

    const cancelled = await tools.call("bridge_cancel", { job_id: "job_1", target: "test-vps" })
    expect(cancelled.isError).toBeUndefined()
    expect(JSON.parse(cancelled.content[0]!.text)).toMatchObject({ cancelled: true, status: "failed", error: CANCELLED_BY_REQUESTER })
    await h.settle()

    const again = await tools.call("bridge_cancel", { job_id: "job_1", target: "test-vps" })
    expect(again.isError).toBe(true)
    expect(JSON.parse(again.content[0]!.text).code).toBe("job_finished")
    expect(h.reports).toHaveLength(1)
  })

  it("bridge_cancel from another peer is forbidden and changes nothing", async () => {
    const h = await claudeHarness()
    await h.triggerAs("dev-main", { job_id: "job_1", capability: "testing" })
    const other = await mcpFor(h, "qa-node")
    const result = await other.call("bridge_cancel", { job_id: "job_1", target: "test-vps" })
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]!.text).code).toBe("forbidden")
    expect((await h.jobManager.getJob("job_1")).status).toBe("running")
    h.adapter.state = "completed"
    await h.settle()
  })
})

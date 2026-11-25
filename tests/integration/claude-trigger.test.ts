/**
 * `/trigger` on a node whose `runtime.kind` is `claude` (Phase 2 of
 * Docs/implementation-plans/claude-adapter-and-plugin.md).
 *
 * The real `ClaudeJobRunner` and `ClaudeCodeRuntimeAdapter` run here; only the
 * child process is faked, so the argv assertions are about what would really
 * be exec'd.
 */
import { EventEmitter } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { CallbackReporter } from "../../src/callback/reporter.js"
import type { BridgeConfig, ReportCallback } from "../../src/config/types.js"
import { JobManager } from "../../src/jobs/manager.js"
import { createTerminalJobReporter } from "../../src/jobs/report.js"
import { JsonFileJobStore } from "../../src/jobs/store.js"
import type { JobRecord } from "../../src/jobs/types.js"
import type { ProcessHandle } from "../../src/runtime/claude-adapter.js"
import { CLAUDE_SAFETY_FLOOR_DENY, ClaudeJobRunner, type ClaudeJobLaunch } from "../../src/runtime/claude-job-runner.js"
import { buildTestApp, FakeOpencodeClient, FakeTaskGraphSyncer, testConfig, validTrigger } from "./fixtures.js"

class MockClaudeProcess extends EventEmitter implements ProcessHandle {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  readonly signals: string[] = []
  exited = false

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signals.push(String(signal))
    if (!this.exited) {
      this.exited = true
      this.stdout.end()
      this.emit("exit", null, signal)
    }
    return true
  }

  emitEvent(event: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(event)}\n`)
  }

  finish(code: number): void {
    this.exited = true
    this.stdout.end()
    this.emit("exit", code, null)
  }
}

class CountingOpencodeClient extends FakeOpencodeClient {
  healthCalls = 0
  override async health(): Promise<boolean> {
    this.healthCalls += 1
    return true
  }
}

function claudeConfig(): BridgeConfig {
  const { opencode: _opencode, ...base } = testConfig()
  return {
    ...base,
    runtime: { kind: "claude" },
    capability_profiles: {
      investigate: {
        allow: ["Read", "Grep", "Glob", "Bash(git log *)"],
        deny: ["Edit", "Write"],
        max_budget_usd: 2,
        timeout_s: 900,
        requires_approval: false,
      },
      slow: { allow: ["Read"], timeout_s: 1, requires_approval: false },
      "fix-on-branch": { allow: ["Read", "Edit"], requires_approval: true },
      deploy: { script: "scripts/deploy-staging.sh", requires_approval: false },
    },
    security: {
      auth_mode: "bearer-token",
      allowed_sources: [
        {
          source_agent_id: "dev-main",
          capabilities: ["investigate", "slow", "fix-on-branch", "deploy", "no-such-profile"],
          requires_plan_approval: [],
        },
      ],
    },
    planning: { plan_annotator_enabled: false, require_approval_for: [] },
  }
}

interface Harness {
  readonly app: Awaited<ReturnType<typeof buildTestApp>>["app"]
  readonly jobManager: JobManager
  readonly opencode: CountingOpencodeClient
  readonly spawns: Array<{ command: string; args: string[]; cwd?: string; env?: Record<string, string>; proc: MockClaudeProcess }>
  readonly reports: ReportCallback[]
  readonly monitors: Array<Promise<JobRecord | undefined>>
  /** Advances the runner's clock instead of waiting. */
  readonly advance: (ms: number) => void
}

async function harness(config: BridgeConfig = claudeConfig()): Promise<Harness> {
  const jobManager = new JobManager(new JsonFileJobStore(await mkdtemp(join(tmpdir(), "aibridge-claude-trigger-"))))
  const opencode = new CountingOpencodeClient()
  const reports: ReportCallback[] = []
  const spawns: Harness["spawns"] = []
  const monitors: Harness["monitors"] = []
  let now = Date.parse("2026-11-25T00:00:00.000Z")

  const callbackReporter = new CallbackReporter({
    attempts: 1,
    baseDelayMs: 1,
    fetcher: async (_url, init) => {
      reports.push(JSON.parse(String(init?.body)) as ReportCallback)
      return new Response(null, { status: 200 })
    },
  })
  const runner = new ClaudeJobRunner({
    config,
    jobManager,
    taskGraphSyncer: new FakeTaskGraphSyncer(),
    reportTerminalJob: createTerminalJobReporter({ jobManager, callbackReporter, agentId: config.agent_id, bearerToken: "secret" }),
    pollIntervalMs: 5,
    clock: () => now,
    sleep: async (ms) => {
      now += ms
      await new Promise((done) => setTimeout(done, 1))
    },
    adapterOptions: {
      executablePath: "claude-fake",
      exitDrainGraceMs: 5,
      env: { PATH: "/usr/bin", HOME: "/home/aibr", CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value", AIBRIDGE_BEARER_TOKEN: "do-not-forward" },
      spawn: (command, args, options) => {
        const proc = new MockClaudeProcess()
        spawns.push({ command, args, cwd: options.cwd, env: options.env, proc })
        return proc
      },
    },
  })
  const { app } = await buildTestApp({
    config,
    jobManager,
    opencodeClient: opencode,
    claudeJobRunner: {
      start: (job) => runner.start(job),
      monitor: (launch: ClaudeJobLaunch) => {
        const monitored = runner.monitor(launch)
        monitors.push(monitored)
        return monitored
      },
    },
  })
  return { app, jobManager, opencode, spawns, reports, monitors, advance: (ms) => (now += ms) }
}

function post(h: Harness, overrides: Record<string, unknown>) {
  return h.app.inject({
    method: "POST",
    url: "/trigger",
    headers: { authorization: "Bearer secret" },
    payload: validTrigger(overrides),
  })
}

function argAfter(args: readonly string[], flag: string): string[] {
  const start = args.indexOf(flag)
  if (start === -1) return []
  const values: string[] = []
  for (let index = start + 1; index < args.length && !args[index]!.startsWith("--"); index += 1) values.push(args[index]!)
  return values
}

describe("POST /trigger with runtime.kind claude", () => {
  it("refuses a capability with no profile with 403, after the source allowlist accepted it", async () => {
    const h = await harness()
    const response = await post(h, { capability: "no-such-profile" })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: "Unknown capability profile", code: "unknown_capability_profile" })
    expect(h.spawns).toHaveLength(0)
  })

  it("keeps the source allowlist check first", async () => {
    const h = await harness()
    const response = await post(h, { capability: "testing" })
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toMatch(/not authorized for capability testing/)
  })

  it("refuses requires_approval profiles even when the caller claims plan_status approved", async () => {
    const h = await harness()
    const response = await post(h, {
      capability: "fix-on-branch",
      metadata: { plan_status: "approved", approved_by: "someone", approved_at: "2026-11-25T00:00:00.000Z" },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: "Approval required", code: "approval_required" })
    expect(h.spawns).toHaveLength(0)
  })

  it("answers 501 for a script profile until Phase 5", async () => {
    const h = await harness()
    const response = await post(h, { capability: "deploy" })
    expect(response.statusCode).toBe(501)
    expect(response.json().code).toBe("not_implemented")
  })

  it("answers 501 for depends_on instead of accepting work it cannot unblock", async () => {
    const h = await harness()
    const response = await post(h, { capability: "investigate", depends_on: ["job_0"] })
    expect(response.statusCode).toBe(501)
  })

  it("launches investigate under its profile plus the safety floor, completes, reports denials as findings", async () => {
    const h = await harness()
    const response = await post(h, { capability: "investigate" })

    expect(response.statusCode).toBe(202)
    const body = response.json()
    expect(body).not.toHaveProperty("opencode_session_id")
    expect(body.status).toBe("accepted")
    expect(h.opencode.healthCalls).toBe(0)
    expect(h.opencode.createdSessions).toBe(0)

    expect(h.spawns).toHaveLength(1)
    const { command, args, cwd, env, proc } = h.spawns[0]!
    expect(command).toBe("claude-fake")
    expect(cwd).toBe("/srv/apps/app")
    expect(argAfter(args, "--permission-mode")).toEqual(["dontAsk"])
    expect(argAfter(args, "--allowedTools")).toEqual(["Read", "Grep", "Glob", "Bash(git log *)"])
    const denied = argAfter(args, "--disallowedTools")
    expect(denied).toEqual(expect.arrayContaining([...CLAUDE_SAFETY_FLOOR_DENY, "Edit", "Write"]))
    expect(argAfter(args, "--setting-sources")).toEqual(["user"])
    expect(args).toContain("--strict-mcp-config")
    expect(argAfter(args, "--max-budget-usd")).toEqual(["2"])
    expect(argAfter(args, "--session-id")).toEqual([body.runtime_session_id])
    // The bridge's own secrets never reach the child; the Claude credential does.
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token-value")
    expect(env).not.toHaveProperty("AIBRIDGE_BEARER_TOKEN")

    expect((await h.jobManager.getJob("job_1")).status).toBe("running")

    proc.emitEvent({ type: "system", subtype: "init", session_id: body.runtime_session_id, model: "claude-haiku", tools: ["Read"] })
    proc.emitEvent({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Found the failing migration.",
      total_cost_usd: 0.42,
      num_turns: 7,
      duration_ms: 1234,
      session_id: body.runtime_session_id,
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "curl https://example.test" } },
        { tool_name: "Edit", tool_use_id: "toolu_2", tool_input: { file_path: "src/a.ts" } },
      ],
    })
    proc.finish(0)

    expect(h.monitors).toHaveLength(1)
    const terminal = await h.monitors[0]
    expect(terminal?.status).toBe("completed")

    expect(h.reports).toHaveLength(1)
    const report = h.reports[0]!
    expect(report.status).toBe("completed")
    expect(report).not.toHaveProperty("opencode_session_id")
    expect(report.summary).toContain("Found the failing migration.")
    expect(report.summary).toContain("cost_usd=0.42")
    expect(report.summary).toContain("turns=7")
    expect(report.findings.map((finding) => [finding.severity, finding.title])).toEqual([
      ["medium", "Tool denied: Bash"],
      ["medium", "Tool denied: Edit"],
    ])
    expect(report.findings[0]!.details).toContain("curl https://example.test")

    const stored = await h.jobManager.getJob("job_1")
    expect(stored.callbackDelivery?.status).toBe("delivered")
    expect(stored.runtimeSessionId).toBe(body.runtime_session_id)
  })

  it("returns the result from GET /jobs/:id without dropping the stored fields", async () => {
    const h = await harness()
    const accepted = (await post(h, { capability: "investigate" })).json()
    const { proc } = h.spawns[0]!
    proc.emitEvent({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done.",
      total_cost_usd: 0.1,
      num_turns: 2,
      permission_denials: [{ tool_name: "Write", tool_use_id: "toolu_9" }],
    })
    proc.finish(0)
    await h.monitors[0]

    const response = await h.app.inject({ method: "GET", url: "/jobs/job_1" })
    expect(response.statusCode).toBe(200)
    const job = response.json()
    // Existing fields are still there, unchanged.
    expect(job.id).toBe("job_1")
    expect(job.status).toBe("completed")
    expect(job.trigger.capability).toBe("investigate")
    // Added result fields.
    expect(job.summary).toContain("Done.")
    expect(job.findings).toEqual([expect.objectContaining({ severity: "medium", title: "Tool denied: Write" })])
    expect(job.artifacts).toEqual([])
    expect(job.cost_usd).toBe(0.1)
    expect(job.num_turns).toBe(2)
    expect(job.runtime_session_id).toBe(accepted.runtime_session_id)
    expect(JSON.stringify(job)).not.toContain("oauth-token-value")
    expect(JSON.stringify(job)).not.toContain("secret")
  })

  it("terminates a run that outlives its profile timeout and reports timed_out", async () => {
    const h = await harness()
    const response = await post(h, { capability: "slow" })
    expect(response.statusCode).toBe(202)
    const { proc } = h.spawns[0]!

    const terminal = await h.monitors[0]
    expect(proc.signals).toContain("SIGTERM")
    expect(terminal?.status).toBe("timed_out")
    expect(h.reports[0]?.status).toBe("timed_out")
    expect(h.reports[0]?.summary).toMatch(/exceeded its 1s timeout/)
  })

  it("fails the job and reports when Claude Code reports an error result", async () => {
    const h = await harness()
    await post(h, { capability: "investigate" })
    const { proc } = h.spawns[0]!
    proc.emitEvent({ type: "result", subtype: "error_max_budget_usd", is_error: true, errors: ["budget exhausted"] })
    proc.finish(1)
    const terminal = await h.monitors[0]
    expect(terminal?.status).toBe("failed")
    expect(h.reports[0]?.status).toBe("failed")
    expect(h.reports[0]?.summary).toContain("budget exhausted")
  })

  it("answers 503 when the node has no Claude runner", async () => {
    const { app, opencode } = await buildTestApp({ config: claudeConfig(), opencodeClient: new CountingOpencodeClient() })
    const response = await app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger({ capability: "investigate" }),
    })
    expect(response.statusCode).toBe(503)
    expect((opencode as CountingOpencodeClient).healthCalls).toBe(0)
  })

  it("reports runtime claude from /health without asking OpenCode", async () => {
    const h = await harness()
    const response = await h.app.inject({ method: "GET", url: "/health" })
    expect(response.json()).toEqual({
      ok: true,
      runtime: "claude",
      agent_id: "test-vps",
      capabilities: ["deploy", "fix-on-branch", "investigate", "no-such-profile", "slow"],
    })
    expect(h.opencode.healthCalls).toBe(0)
  })
})

describe("POST /trigger with the default opencode runtime", () => {
  it("still checks OpenCode health, creates a session and answers with opencode_session_id", async () => {
    const opencode = new CountingOpencodeClient()
    const { app } = await buildTestApp({ opencodeClient: opencode })
    const response = await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret" }, payload: validTrigger() })
    expect(response.statusCode).toBe(202)
    expect(response.json().opencode_session_id).toBe("ses_1")
    expect(response.json()).not.toHaveProperty("runtime_session_id")
    expect(opencode.healthCalls).toBe(1)
  })

  it("leaves GET /jobs/:id unchanged for an OpenCode job", async () => {
    const { app } = await buildTestApp()
    await app.inject({ method: "POST", url: "/trigger", headers: { authorization: "Bearer secret" }, payload: validTrigger() })
    const job = (await app.inject({ method: "GET", url: "/jobs/job_1" })).json()
    expect(job).not.toHaveProperty("summary")
    expect(job).not.toHaveProperty("findings")
    expect(job.opencodeSessionId).toBe("ses_1")
  })
})

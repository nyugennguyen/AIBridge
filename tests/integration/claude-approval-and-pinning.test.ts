/**
 * Phase 4 (operator approval), Phase 5 (repo@sha pinning, deterministic
 * scripts, concurrency cap) and the Phase 7 kill switch, end to end through
 * the routes with the real `ClaudeJobRunner` and `ClaudeCodeRuntimeAdapter`.
 * Only the Claude child process and git are faked; scripts are real files.
 */
import { EventEmitter } from "node:events"
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { CallbackReporter } from "../../src/callback/reporter.js"
import type { BridgeConfig, CapabilityProfile, ReportCallback } from "../../src/config/types.js"
import { InMemoryApprovalLedger, verifyApprovalLedger } from "../../src/jobs/approval-ledger.js"
import { JobManager } from "../../src/jobs/manager.js"
import { createTerminalJobReporter } from "../../src/jobs/report.js"
import { JsonFileJobStore } from "../../src/jobs/store.js"
import type { JobRecord } from "../../src/jobs/types.js"
import type { ProcessHandle } from "../../src/runtime/claude-adapter.js"
import { ClaudeJobRunner, type ClaudeJobLaunch } from "../../src/runtime/claude-job-runner.js"
import { GitRefNotFoundError, type ConfiguredRepository } from "../../src/runtime/repo-workspace.js"
import { buildTestApp, FakeOpencodeClient, FakeTaskGraphSyncer, testConfig, validTrigger } from "./fixtures.js"

const OPERATOR = "operator-token-value-123"
const SHA_A = "a".repeat(40)

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

  succeed(text: string): void {
    this.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1 })}\n`)
    this.exited = true
    this.stdout.end()
    this.emit("exit", 0, null)
  }
}

class FakeWorkspaces {
  readonly created: Array<{ repo: string; jobId: string; sha: string; path: string }> = []
  readonly removed: Array<{ repo: string; jobId: string }> = []
  readonly resolved: Array<{ repo: string; ref: string }> = []
  constructor(private readonly root: string) {}

  async resolveSha(repository: ConfiguredRepository, ref: string): Promise<string> {
    this.resolved.push({ repo: repository.name, ref })
    if (ref === "no-such-branch") throw new GitRefNotFoundError(`Ref "${ref}" was not found in repository "${repository.name}".`)
    return ref === "other" ? "b".repeat(40) : SHA_A
  }

  async createWorktree(repo: string, jobId: string, sha: string): Promise<string> {
    const path = join(this.root, "worktrees", jobId)
    await mkdir(path, { recursive: true })
    this.created.push({ repo, jobId, sha, path })
    return path
  }

  async removeWorktree(repo: string, jobId: string): Promise<void> {
    this.removed.push({ repo, jobId })
  }
}

interface HarnessOptions {
  readonly profiles?: Record<string, Partial<CapabilityProfile>>
  readonly config?: (base: BridgeConfig) => BridgeConfig
  readonly operatorToken?: string | null
}

async function harness(options: HarnessOptions = {}) {
  const projectDir = await mkdtemp(join(tmpdir(), "aibridge-phase45-project-"))
  const stateDir = await mkdtemp(join(tmpdir(), "aibridge-phase45-state-"))
  const { opencode: _opencode, ...base } = testConfig()
  const profiles = options.profiles ?? {
    investigate: { allow: ["Read"] },
    "fix-on-branch": { allow: ["Read", "Edit"], requires_approval: true },
  }
  let config: BridgeConfig = {
    ...base,
    runtime: { kind: "claude" },
    projects: [{ id: "app", path: projectDir, capabilities: Object.keys(profiles) }],
    capability_profiles: Object.fromEntries(Object.entries(profiles).map(([name, p]) => [name, { requires_approval: false, ...p }])),
    repositories: { app: { url: "https://git.example.test/app.git", default_branch: "main" } },
    security: {
      auth_mode: "bearer-token",
      allowed_sources: [{ source_agent_id: "dev-main", capabilities: Object.keys(profiles), requires_plan_approval: [] }],
    },
    planning: { plan_annotator_enabled: false, require_approval_for: [] },
  }
  if (options.config) config = options.config(config)

  const jobManager = new JobManager(new JsonFileJobStore(join(stateDir, "jobs")))
  const reports: ReportCallback[] = []
  const spawns: Array<{ args: string[]; cwd?: string; env?: Record<string, string>; proc: MockClaudeProcess }> = []
  const monitors: Array<Promise<JobRecord | undefined>> = []
  const callbackReporter = new CallbackReporter({
    attempts: 1,
    baseDelayMs: 1,
    fetcher: async (_url, init) => {
      reports.push(JSON.parse(String(init?.body)) as ReportCallback)
      return new Response(null, { status: 200 })
    },
  })
  const reportTerminalJob = createTerminalJobReporter({ jobManager, callbackReporter, agentId: config.agent_id, bearerToken: "secret" })
  const workspaces = new FakeWorkspaces(stateDir)
  const sourceEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/home/aibr",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value",
    AIBRIDGE_BEARER_TOKEN: "secret",
    AIBRIDGE_OPERATOR_TOKEN: OPERATOR,
  }
  const runner = new ClaudeJobRunner({
    config,
    jobManager,
    taskGraphSyncer: new FakeTaskGraphSyncer(),
    reportTerminalJob,
    workspaces,
    knownSecrets: [OPERATOR, "secret"],
    pollIntervalMs: 5,
    adapterOptions: {
      executablePath: "claude-fake",
      exitDrainGraceMs: 5,
      env: sourceEnv,
      spawn: (_command, args, spawnOptions) => {
        const proc = new MockClaudeProcess()
        spawns.push({ args, cwd: spawnOptions.cwd, env: spawnOptions.env, proc })
        return proc
      },
    },
  })
  const ledger = new InMemoryApprovalLedger()
  const { app } = await buildTestApp({
    config,
    jobManager,
    opencodeClient: new FakeOpencodeClient(),
    operatorToken: options.operatorToken === undefined ? OPERATOR : options.operatorToken,
    approvalLedger: ledger,
    reportTerminalJob,
    repoWorkspaces: workspaces,
    localAddresses: () => new Set(["100.64.0.3"]),
    claudeJobRunner: {
      start: (job) => runner.start(job),
      monitor: (launch: ClaudeJobLaunch) => {
        const monitored = runner.monitor(launch)
        monitors.push(monitored)
        return monitored
      },
      hasCapacity: () => runner.hasCapacity(),
      stopAll: (reason?: string, waitMs?: number) => runner.stopAll(reason, waitMs),
    },
  })

  const trigger = (overrides: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger({ project_dir: projectDir, ...overrides }),
    })
  const operator = (method: "GET" | "POST", url: string, init: { token?: string | null; remoteAddress?: string; payload?: unknown } = {}) =>
    app.inject({
      method,
      url,
      ...(init.remoteAddress !== undefined ? { remoteAddress: init.remoteAddress } : {}),
      headers: init.token === null ? {} : { authorization: `Bearer ${init.token ?? OPERATOR}` },
      ...(method === "POST" ? { payload: init.payload ?? {} } : {}),
    })
  const script = async (relative: string, body: string) => {
    const path = join(projectDir, relative)
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o755)
  }
  return { app, config, jobManager, runner, reports, spawns, monitors, workspaces, ledger, projectDir, trigger, operator, script }
}

describe("Phase 4 — operator approval", () => {
  it("holds an approval-gated job, ignores metadata.plan_status, and records the request", async () => {
    const h = await harness()
    const response = await h.trigger({ capability: "fix-on-branch", metadata: { plan_status: "approved" } })
    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ accepted: true, status: "awaiting_approval", approve_hint: "aibr approve job_1" })
    expect(h.spawns).toHaveLength(0)
    const job = (await h.app.inject({ method: "GET", url: "/jobs/job_1", headers: { authorization: "Bearer secret" } })).json()
    expect(job.status).toBe("awaiting_approval")
    expect(job.approval).toMatchObject({ status: "pending" })
    const events = await h.ledger.list()
    expect(events).toEqual([expect.objectContaining({ seq: 1, type: "approval.requested", jobId: "job_1", actor: "trigger" })])
  })

  it("refuses a caller-chosen job id with shell metacharacters before holding anything (3.2.0 job id charset)", async () => {
    const h = await harness()
    const response = await h.trigger({ capability: "fix-on-branch", job_id: "x;rm -rf ~" })
    expect(response.statusCode).toBe(400)
    expect(h.spawns).toHaveLength(0)
    const accepted = await h.trigger({ capability: "fix-on-branch", job_id: "Fix-42_a" })
    expect(accepted.json().approve_hint).toBe("aibr approve Fix-42_a")
  })

  it("refuses approval with the peer bearer (403), without a credential (401) and with no operator token configured (403)", async () => {
    const h = await harness()
    await h.trigger({ capability: "fix-on-branch" })
    expect((await h.operator("POST", "/jobs/job_1/approve", { token: "secret" })).statusCode).toBe(403)
    expect((await h.operator("POST", "/jobs/job_1/approve", { token: null })).statusCode).toBe(401)
    expect((await h.operator("POST", "/jobs/job_1/reject", { token: "secret" })).statusCode).toBe(403)
    expect((await h.operator("GET", "/operator/pending-jobs", { token: "secret" })).statusCode).toBe(403)
    expect((await h.operator("POST", "/operator/stop-all-jobs", { token: "secret" })).statusCode).toBe(403)
    expect(h.spawns).toHaveLength(0)

    const unconfigured = await harness({ operatorToken: null })
    await unconfigured.trigger({ capability: "fix-on-branch" })
    const response = await unconfigured.operator("POST", "/jobs/job_1/approve")
    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe("operator_not_configured")
  })

  it("accepts the operator only from this host unless approval_from_loopback_only is false", async () => {
    const h = await harness()
    await h.trigger({ capability: "fix-on-branch" })
    const remote = await h.operator("POST", "/jobs/job_1/approve", { remoteAddress: "198.51.100.7" })
    expect(remote.statusCode).toBe(403)
    expect(remote.json().code).toBe("operator_not_local")
    // The host's own tailnet address counts as this host.
    expect((await h.operator("GET", "/operator/pending-jobs", { remoteAddress: "100.64.0.3" })).statusCode).toBe(200)
    expect((await h.operator("GET", "/operator/pending-jobs", { remoteAddress: "::ffff:127.0.0.1" })).statusCode).toBe(200)

    const open = await harness({ config: (c) => ({ ...c, security: { ...c.security, approval_from_loopback_only: false } }) })
    await open.trigger({ capability: "fix-on-branch" })
    expect((await open.operator("GET", "/operator/pending-jobs", { remoteAddress: "198.51.100.7" })).statusCode).toBe(200)
  })

  it("lists pending jobs with what the operator must see", async () => {
    const h = await harness()
    await h.trigger({ capability: "fix-on-branch", repo: "app", ref: "main", prompt: "Fix the flaky test." })
    await h.trigger({ capability: "investigate", job_id: "job_2" })
    const response = await h.operator("GET", "/operator/pending-jobs")
    expect(response.statusCode).toBe(200)
    expect(response.json().jobs).toEqual([
      expect.objectContaining({
        job_id: "job_1",
        capability: "fix-on-branch",
        source_agent_id: "dev-main",
        project_dir: h.projectDir,
        prompt: "Fix the flaky test.",
        repo: "app",
        ref: "main",
        sha: SHA_A,
        expires_at: expect.any(String),
      }),
    ])
  })

  it("launches exactly once on approval, with the operator token kept out of Claude's environment", async () => {
    const h = await harness()
    await h.trigger({ capability: "fix-on-branch" })
    const approved = await h.operator("POST", "/jobs/job_1/approve")
    expect(approved.statusCode).toBe(200)
    expect(approved.json()).toMatchObject({ job_id: "job_1", status: "running", runtime_session_id: expect.any(String) })
    expect(h.spawns).toHaveLength(1)
    const env = h.spawns[0]!.env!
    expect(env).not.toHaveProperty("AIBRIDGE_OPERATOR_TOKEN")
    expect(env).not.toHaveProperty("AIBRIDGE_BEARER_TOKEN")
    expect(Object.values(env)).not.toContain(OPERATOR)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token-value")

    const again = await h.operator("POST", "/jobs/job_1/approve")
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe("not_awaiting_approval")
    expect(h.spawns).toHaveLength(1)

    h.spawns[0]!.proc.succeed("Fixed.")
    expect((await h.monitors[0])?.status).toBe("completed")
    expect(h.reports.map((r) => r.status)).toEqual(["completed"])
    const stored = await h.jobManager.getJob("job_1")
    expect(stored.approval).toMatchObject({ status: "approved", decidedBy: "operator" })
    expect((await h.ledger.list()).map((event) => event.type)).toEqual(["approval.requested", "approval.granted"])
    expect(verifyApprovalLedger(h.ledger.lines)).toEqual({ ok: true })
  })

  it("lets only one of two concurrent approvals launch", async () => {
    const h = await harness()
    await h.trigger({ capability: "fix-on-branch" })
    const [first, second] = await Promise.all([h.operator("POST", "/jobs/job_1/approve"), h.operator("POST", "/jobs/job_1/approve")])
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409])
    expect(h.spawns).toHaveLength(1)
  })

  it("rejects: fails the job with the operator's reason and sends the callback", async () => {
    const h = await harness()
    await h.trigger({ capability: "fix-on-branch" })
    const response = await h.operator("POST", "/jobs/job_1/reject", { payload: { reason: "not today" } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: "failed", error: "rejected by operator: not today" })
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]).toMatchObject({ status: "failed", summary: "rejected by operator: not today" })
    expect((await h.operator("POST", "/jobs/job_1/approve")).statusCode).toBe(409)
    expect(h.spawns).toHaveLength(0)
    expect((await h.ledger.list()).map((event) => event.type)).toEqual(["approval.requested", "approval.rejected"])
  })

  it("answers 404 for an unknown job and 409 for a job that is not awaiting approval", async () => {
    const h = await harness()
    expect((await h.operator("POST", "/jobs/nope/approve")).statusCode).toBe(404)
    await h.trigger({ capability: "investigate" })
    expect((await h.operator("POST", "/jobs/job_1/approve")).statusCode).toBe(409)
    h.spawns[0]!.proc.succeed("ok")
    await h.monitors[0]
  })

  it("expires an approval request after the trigger's timeout", async () => {
    const h = await harness()
    const job = await h.jobManager.createJob(
      validTrigger({ capability: "fix-on-branch", project_dir: h.projectDir, timeout_seconds: 1 }) as JobRecord["trigger"],
      new Date(Date.now() - 5_000).toISOString(),
      { awaitingApproval: true },
    )
    const response = await h.operator("POST", `/jobs/${job.id}/approve`)
    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe("approval_expired")
    expect((await h.jobManager.getJob(job.id)).status).toBe("timed_out")
    expect(h.reports[0]?.status).toBe("timed_out")
    expect(h.spawns).toHaveLength(0)
  })
})

describe("Phase 5 — repo@sha pinning", () => {
  it("refuses an unconfigured repository, a ref without repo, and an unknown ref", async () => {
    const h = await harness()
    const unconfigured = await h.trigger({ capability: "investigate", repo: "https://evil.example.test/x.git" })
    expect(unconfigured.statusCode).toBe(403)
    expect(unconfigured.json().code).toBe("repository_not_allowed")
    const refOnly = await h.trigger({ capability: "investigate", ref: "main" })
    expect(refOnly.statusCode).toBe(400)
    const unknown = await h.trigger({ capability: "investigate", repo: "app", ref: "no-such-branch" })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().code).toBe("unknown_ref")
    const optionLike = await h.trigger({ capability: "investigate", repo: "app", ref: "--upload-pack=x" })
    expect(optionLike.statusCode).toBe(400)
    expect(h.workspaces.resolved.map((r) => r.ref)).toEqual(["no-such-branch"])
    expect(h.spawns).toHaveLength(0)
  })

  it("accepts the repository's exact url as well as its key", async () => {
    const h = await harness()
    const response = await h.trigger({ capability: "investigate", repo: "https://git.example.test/app.git" })
    expect(response.statusCode).toBe(202)
    expect(h.workspaces.resolved).toEqual([{ repo: "app", ref: "main" }])
    h.spawns[0]!.proc.succeed("ok")
    await h.monitors[0]
  })

  it("runs Claude in a per-job worktree at the resolved sha, reports the sha, and removes the worktree", async () => {
    const h = await harness()
    const response = await h.trigger({ capability: "investigate", repo: "app", ref: "main" })
    expect(response.statusCode).toBe(202)
    expect(response.json().sha).toBe(SHA_A)
    expect(h.workspaces.created).toEqual([expect.objectContaining({ repo: "app", jobId: "job_1", sha: SHA_A })])
    expect(h.spawns[0]!.cwd).toBe(h.workspaces.created[0]!.path)

    h.spawns[0]!.proc.succeed("Looked at it.")
    await h.monitors[0]
    expect(h.workspaces.removed).toEqual([{ repo: "app", jobId: "job_1" }])
    expect(h.reports[0]).toMatchObject({ status: "completed", sha: SHA_A })
    const job = (await h.app.inject({ method: "GET", url: "/jobs/job_1", headers: { authorization: "Bearer secret" } })).json()
    expect(job).toMatchObject({ sha: SHA_A, repo: "app", ref: "main" })
  })

  it("runs two jobs at different shas side by side in separate worktrees", async () => {
    const h = await harness()
    await h.trigger({ capability: "investigate", repo: "app", ref: "main" })
    await h.trigger({ capability: "investigate", repo: "app", ref: "other", job_id: "job_2" })
    expect(h.spawns.map((s) => s.cwd)).toEqual([join(h.workspaces.created[0]!.path), join(h.workspaces.created[1]!.path)])
    expect(new Set(h.spawns.map((s) => s.cwd)).size).toBe(2)
    expect(h.workspaces.created.map((c) => c.sha)).toEqual([SHA_A, "b".repeat(40)])
    for (const spawn of h.spawns) spawn.proc.succeed("ok")
    await Promise.all(h.monitors)
    expect(h.reports.map((r) => r.sha).sort()).toEqual([SHA_A, "b".repeat(40)])
  })

  it("pins the sha at trigger time, so the operator approves an exact commit", async () => {
    const h = await harness()
    await h.trigger({ capability: "fix-on-branch", repo: "app", ref: "main" })
    expect(h.workspaces.created).toHaveLength(0)
    await h.operator("POST", "/jobs/job_1/approve")
    expect(h.workspaces.created).toEqual([expect.objectContaining({ sha: SHA_A })])
    expect(h.workspaces.resolved).toHaveLength(1)
    h.spawns[0]!.proc.succeed("ok")
    await h.monitors[0]
  })
})

describe("Phase 5 — deterministic scripts", () => {
  const profiles = {
    deploy: { script: "scripts/deploy.sh", requires_approval: true, timeout_s: 30 },
    build: { script: "scripts/build.sh", timeout_s: 30 },
    escape: { script: "../outside.sh" },
    wrapped: { allow: ["Read"], pre: ["scripts/pre.sh"], post: ["scripts/post.sh"], timeout_s: 30 },
    "bad-pre": { allow: ["Read"], pre: ["scripts/fail.sh"] },
    slow: { script: "scripts/slow.sh", timeout_s: 1 },
  }

  it("runs a script profile instead of Claude, with a sanitized environment, and reports script_results", async () => {
    const h = await harness({ profiles })
    await h.script("scripts/build.sh", 'echo "built $AIBR_JOB_ID"; env; echo warn >&2')
    const response = await h.trigger({ capability: "build" })
    expect(response.statusCode).toBe(202)
    expect(response.json()).not.toHaveProperty("runtime_session_id")
    const terminal = await h.monitors[0]
    expect(terminal?.status).toBe("completed")
    expect(h.spawns).toHaveLength(0)
    const result = h.reports[0]!.script_results![0]!
    expect(result).toMatchObject({ phase: "main", script: "scripts/build.sh", exit_code: 0, timed_out: false, stderr_tail: "warn\n" })
    expect(result.stdout_tail).toContain("built job_1")
    expect(result.stdout_tail).not.toContain("AIBRIDGE_")
    expect(result.stdout_tail).not.toContain(OPERATOR)
    expect(result.stdout_tail).not.toContain("oauth-token-value")
    const job = (await h.app.inject({ method: "GET", url: "/jobs/job_1", headers: { authorization: "Bearer secret" } })).json()
    expect(job.script_results).toEqual(h.reports[0]!.script_results)
  })

  it("still requires approval for a script profile (deploy), then runs it once approved", async () => {
    const h = await harness({ profiles })
    await h.script("scripts/deploy.sh", "echo deployed")
    expect((await h.trigger({ capability: "deploy" })).json().status).toBe("awaiting_approval")
    expect((await h.operator("POST", "/jobs/job_1/approve")).statusCode).toBe(200)
    await h.monitors[0]
    expect(h.reports[0]).toMatchObject({ status: "completed" })
    expect(h.reports[0]!.script_results![0]!.stdout_tail).toBe("deployed\n")
  })

  it("fails a script whose path escapes the job directory without running anything", async () => {
    const h = await harness({ profiles })
    await writeFile(join(h.projectDir, "..", "outside.sh"), "#!/bin/sh\necho escaped\n").catch(() => undefined)
    await h.trigger({ capability: "escape" })
    expect((await h.monitors[0])?.status).toBe("failed")
    const result = h.reports[0]!.script_results![0]!
    expect(result.exit_code).toBeNull()
    expect(result.stdout_tail).toBe("")
    expect(result.stderr_tail).toMatch(/escapes the job directory/)
    expect(h.reports[0]!.findings[0]).toMatchObject({ severity: "high", title: "Script failed: ../outside.sh" })
  })

  it("runs pre and post scripts around Claude", async () => {
    const h = await harness({ profiles })
    await h.script("scripts/pre.sh", "echo pre")
    await h.script("scripts/post.sh", "echo post")
    await h.trigger({ capability: "wrapped" })
    // Claude is launched only after the pre step finished.
    for (let attempt = 0; attempt < 200 && h.spawns.length === 0; attempt += 1) await new Promise((done) => setTimeout(done, 5))
    expect(h.spawns).toHaveLength(1)
    h.spawns[0]!.proc.succeed("Claude step done.")
    const terminal = await h.monitors[0]
    expect(terminal?.status).toBe("completed")
    expect(h.reports[0]!.script_results!.map((r) => [r.phase, r.stdout_tail])).toEqual([
      ["pre", "pre\n"],
      ["post", "post\n"],
    ])
    expect(h.reports[0]!.summary).toContain("Claude step done.")
  })

  it("fails the job and never launches Claude when a pre script fails", async () => {
    const h = await harness({ profiles })
    await h.script("scripts/fail.sh", "echo nope >&2; exit 3")
    await h.trigger({ capability: "bad-pre" })
    expect((await h.monitors[0])?.status).toBe("failed")
    expect(h.spawns).toHaveLength(0)
    expect(h.reports[0]!.summary).toMatch(/Pre script scripts\/fail.sh failed \(exit 3\)/)
  })

  it("kills a script that outlives the profile timeout and reports timed_out", async () => {
    const h = await harness({ profiles })
    await h.script("scripts/slow.sh", "sleep 30")
    await h.trigger({ capability: "slow" })
    const terminal = await h.monitors[0]
    expect(terminal?.status).toBe("timed_out")
    expect(h.reports[0]!.script_results![0]).toMatchObject({ timed_out: true, exit_code: null })
  }, 15_000)
})

describe("concurrency cap and kill switch", () => {
  it("answers 429 above limits.max_concurrent_jobs, and keeps an approval pending when the node is full", async () => {
    const h = await harness({ config: (c) => ({ ...c, limits: { max_concurrent_jobs: 1 } }) })
    expect((await h.trigger({ capability: "investigate" })).statusCode).toBe(202)
    const second = await h.trigger({ capability: "investigate", job_id: "job_2" })
    expect(second.statusCode).toBe(429)
    expect(second.json().code).toBe("node_at_capacity")
    await expect(h.jobManager.getJob("job_2")).rejects.toThrow()

    expect((await h.trigger({ capability: "fix-on-branch", job_id: "job_3" })).json().status).toBe("awaiting_approval")
    const full = await h.operator("POST", "/jobs/job_3/approve")
    expect(full.statusCode).toBe(429)
    expect((await h.jobManager.getJob("job_3")).status).toBe("awaiting_approval")

    h.spawns[0]!.proc.succeed("done")
    await h.monitors[0]
    expect((await h.operator("POST", "/jobs/job_3/approve")).statusCode).toBe(200)
    h.spawns[1]!.proc.succeed("done")
    await h.monitors[1]
  })

  it("stops every running Claude and script job, fails them 'stopped by operator' and reports them", async () => {
    const h = await harness({ profiles: { investigate: { allow: ["Read"] }, slow: { script: "scripts/slow.sh", timeout_s: 60 } } })
    await h.script("scripts/slow.sh", "sleep 30")
    await h.trigger({ capability: "investigate" })
    await h.trigger({ capability: "slow", job_id: "job_2" })
    expect(h.runner.activeJobIds().sort()).toEqual(["job_1", "job_2"])

    const response = await h.operator("POST", "/operator/stop-all-jobs")
    expect(response.statusCode).toBe(200)
    expect(response.json().stopped.sort()).toEqual(["job_1", "job_2"])
    expect(h.spawns[0]!.proc.signals).toContain("SIGTERM")
    await Promise.all(h.monitors)
    for (const id of ["job_1", "job_2"]) {
      const job = await h.jobManager.getJob(id)
      expect(job.status).toBe("failed")
      expect(job.error).toBe("stopped by operator")
    }
    expect(h.reports.map((r) => r.status)).toEqual(["failed", "failed"])
    expect(h.runner.activeJobIds()).toEqual([])
    expect((await h.ledger.list()).at(-1)).toMatchObject({ type: "jobs.stopped", actor: "operator" })
  }, 20_000)
})

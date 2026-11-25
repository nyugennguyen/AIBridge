/**
 * `aibr approve | reject | jobs pending | stop`, driven against a real app
 * through `app.inject` (the CLI's fetch is routed into it), so the command and
 * the routes are tested together.
 */
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  describeJob,
  loadOperatorEndpoint,
  parseOperatorArgs,
  runDecisionCommand,
  runJobsCommand,
  sanitizeForTerminal,
  type OperatorCliDeps,
} from "../../../src/cli/approve.js"
import { runStopCommand } from "../../../src/cli/jobs-stop.js"
import { runCli, type CliDeps } from "../../../src/cli.js"
import type { BridgeConfig } from "../../../src/config/types.js"
import type { ProcessResult } from "../../../src/host/types.js"
import { buildTestApp, testConfig, validTrigger } from "../../integration/fixtures.js"

const OPERATOR = "op-token-abcdef"

async function setup(options: { confirm?: boolean; token?: string | null } = {}) {
  const { opencode: _opencode, ...base } = testConfig()
  const config: BridgeConfig = {
    ...base,
    runtime: { kind: "claude" },
    capability_profiles: { "fix-on-branch": { allow: ["Read"], requires_approval: true } },
    security: {
      auth_mode: "bearer-token",
      allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["fix-on-branch"], requires_plan_approval: [] }],
    },
  }
  const started: string[] = []
  const stopAllCalls: number[] = []
  const { app, jobManager } = await buildTestApp({
    config,
    operatorToken: OPERATOR,
    claudeJobRunner: {
      start: async (job) => {
        started.push(job.id)
        return { job: await jobManager.markRunning(job.id), cwd: "/srv/apps/app", timeoutSeconds: 60 }
      },
      monitor: async () => undefined,
      hasCapacity: () => true,
      stopAll: async () => {
        stopAllCalls.push(1)
        return started.slice()
      },
    },
  })
  const output: string[] = []
  const questions: string[] = []
  const requests: Array<{ url: string; authorization: string | undefined }> = []
  const deps: OperatorCliDeps = {
    writer: (text) => output.push(text),
    confirm: async (question) => {
      questions.push(question)
      return options.confirm ?? false
    },
    loadEndpoint: async () => ({ baseUrl: "http://127.0.0.1:8787", token: options.token === undefined ? OPERATOR : options.token }),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = (init?.headers ?? {}) as Record<string, string>
      requests.push({ url: url.pathname, authorization: headers.authorization })
      const response = await app.inject({
        method: (init?.method ?? "GET") as "GET" | "POST",
        url: url.pathname,
        headers,
        ...(init?.body !== undefined ? { payload: String(init.body) } : {}),
      })
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } })
    }) as typeof fetch,
  }
  const trigger = (overrides: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: validTrigger({ capability: "fix-on-branch", ...overrides }),
    })
  return { app, jobManager, deps, output, questions, requests, started, stopAllCalls, trigger, text: () => output.join("") }
}

describe("aibr approve", () => {
  it("shows the job, asks (default No) and changes nothing when declined", async () => {
    const h = await setup({ confirm: false })
    await h.trigger({ prompt: "Fix it.\u001b[31mRED\u001b[0m" })
    const code = await runDecisionCommand("approve", ["job_1"], h.deps)
    expect(code).toBe(1)
    expect(h.questions).toEqual(["Approve and run this job?"])
    expect(h.text()).toContain("capability: fix-on-branch")
    expect(h.text()).toContain("source:     dev-main")
    expect(h.text()).toContain("Fix it.[31mRED[0m".replace(/\[31m|\[0m/g, ""))
    expect(h.text()).not.toContain("\u001b")
    expect(h.text()).toContain("Nothing changed.")
    expect((await h.jobManager.getJob("job_1")).status).toBe("awaiting_approval")
    expect(h.started).toEqual([])
  })

  it("approves after confirmation, sending only the operator credential, and never prints it", async () => {
    const h = await setup({ confirm: true })
    await h.trigger()
    expect(await runDecisionCommand("approve", ["job_1", "--profile", "staging"], h.deps)).toBe(0)
    expect(h.started).toEqual(["job_1"])
    expect(h.text()).toContain("Approved job_1: running")
    expect(h.text()).not.toContain(OPERATOR)
    expect(h.requests.every((request) => request.authorization === `Bearer ${OPERATOR}`)).toBe(true)
    // A second approval is refused by the bridge.
    expect(await runDecisionCommand("approve", ["job_1", "--yes"], h.deps)).toBe(1)
    expect(h.text()).toContain("not awaiting approval (status running)")
  })

  it("--yes skips the question", async () => {
    const h = await setup({ confirm: false })
    await h.trigger()
    expect(await runDecisionCommand("approve", ["job_1", "-y"], h.deps)).toBe(0)
    expect(h.questions).toEqual([])
  })

  it("explains a missing operator token and an unknown job", async () => {
    const noToken = await setup({ token: null })
    await noToken.trigger()
    expect(await runDecisionCommand("approve", ["job_1"], noToken.deps)).toBe(1)
    expect(noToken.text()).toMatch(/No operator token/)
    const h = await setup()
    expect(await runDecisionCommand("approve", ["nope"], h.deps)).toBe(1)
    expect(h.text()).toContain("not found")
  })

  it("rejects usage errors with 64", async () => {
    const h = await setup()
    expect(await runDecisionCommand("approve", [], h.deps)).toBe(64)
    expect(await runDecisionCommand("approve", ["a", "b"], h.deps)).toBe(64)
    expect(await runDecisionCommand("approve", ["a", "--reason", "x"], h.deps)).toBe(64)
  })
})

describe("aibr reject", () => {
  it("rejects with a reason after confirmation", async () => {
    const h = await setup({ confirm: true })
    await h.trigger()
    expect(await runDecisionCommand("reject", ["job_1", "--reason", "wrong branch"], h.deps)).toBe(0)
    expect(h.questions).toEqual(["Reject this job?"])
    const job = await h.jobManager.getJob("job_1")
    expect(job.status).toBe("failed")
    expect(job.error).toBe("rejected by operator: wrong branch")
  })
})

describe("aibr jobs pending", () => {
  it("lists the awaiting jobs, or says there are none", async () => {
    const h = await setup()
    expect(await runJobsCommand(["pending"], h.deps)).toBe(0)
    expect(h.text()).toContain("No jobs are awaiting approval.")
    await h.trigger()
    expect(await runJobsCommand(["pending", "--json"], h.deps)).toBe(0)
    const json = JSON.parse(h.output.at(-1)!)
    expect(json.jobs).toEqual([expect.objectContaining({ job_id: "job_1", capability: "fix-on-branch" })])
    expect(await runJobsCommand(["pending"], h.deps)).toBe(0)
    expect(h.text()).toContain("1 job(s) awaiting approval")
    expect(await runJobsCommand(["other"], h.deps)).toBe(64)
  })
})

describe("aibr stop", () => {
  const runner = (result: Partial<ProcessResult>) => {
    const calls: string[][] = []
    return {
      calls,
      exec: async (argv: readonly string[]) => {
        calls.push([...argv])
        return { exitCode: 0, stdout: "", stderr: "", ...result }
      },
    }
  }

  it("--all-jobs asks, then calls the kill switch", async () => {
    const h = await setup({ confirm: true })
    const tmux = runner({})
    expect(await runStopCommand(["--all-jobs"], { ...h.deps, processRunner: tmux })).toBe(0)
    expect(h.questions).toEqual(["Stop EVERY running job on this node?"])
    expect(h.stopAllCalls).toHaveLength(1)
    expect(h.text()).toContain("No jobs were running.")
    expect(tmux.calls).toEqual([])
  })

  it("--all-jobs declined changes nothing", async () => {
    const h = await setup({ confirm: false })
    expect(await runStopCommand(["--all-jobs", "--profile", "staging"], { ...h.deps, processRunner: runner({}) })).toBe(1)
    expect(h.stopAllCalls).toHaveLength(0)
  })

  it("--profile kills the tmux session, and is idempotent", async () => {
    const h = await setup()
    const tmux = runner({})
    expect(await runStopCommand(["--profile", "staging"], { ...h.deps, processRunner: tmux })).toBe(0)
    expect(tmux.calls).toEqual([["tmux", "kill-session", "-t", "aibridge-staging"]])
    expect(await runStopCommand(["-p", "staging"], { ...h.deps, processRunner: runner({ exitCode: 1, stderr: "can't find session: aibridge-staging" }) })).toBe(0)
    expect(h.text()).toContain("Not running: aibridge-staging")
    expect(await runStopCommand([], { ...h.deps, processRunner: tmux })).toBe(64)
  })
})

describe("helpers", () => {
  it("parses flags and refuses unknown ones", () => {
    expect(parseOperatorArgs(["job", "--bogus"], new Set(["--profile"]))).toBe("unknown flag --bogus")
    expect(parseOperatorArgs(["--profile", "../x"], new Set(["--profile"]))).toMatch(/Invalid profile/)
    expect(parseOperatorArgs(["j", "-p", "dev"], new Set(["--profile"]))).toMatchObject({ positional: ["j"], profile: "dev" })
  })

  it("strips terminal control sequences", () => {
    expect(sanitizeForTerminal("a\u001b]0;title\u0007b\u001b[2Jc\nd\te")).toBe("a]0;titlebc\nd\te")
  })

  it("shows repo@sha when the job is pinned", () => {
    expect(describeJob({ id: "j", status: "awaiting_approval", repo: "app", ref: "main", sha: "f".repeat(40), trigger: { prompt: "p" } })).toContain(
      `repo:       app @ main -> ${"f".repeat(40)}`,
    )
  })

  it("loads the endpoint from the profile, preferring the env token, and refuses a loose token file", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibridge-cli-home-"))
    const env = { HOME: home }
    const configDir = join(home, ".config", "aibridge", "staging")
    const secretsDir = join(home, ".local", "share", "aibridge", "staging", "secrets")
    await mkdir(configDir, { recursive: true })
    await mkdir(secretsDir, { recursive: true })
    await writeFile(join(configDir, "config.json"), JSON.stringify({ bridge: { host: "100.64.0.3", port: 8787 } }), { mode: 0o600 })
    expect(await loadOperatorEndpoint("staging", env)).toEqual({ baseUrl: "http://100.64.0.3:8787", token: null })
    await writeFile(join(secretsDir, "operator_token"), "file-token\n", { mode: 0o600 })
    expect((await loadOperatorEndpoint("staging", env)).token).toBe("file-token")
    expect((await loadOperatorEndpoint("staging", { ...env, AIBRIDGE_OPERATOR_TOKEN: "env-token" })).token).toBe("env-token")
    await chmod(join(secretsDir, "operator_token"), 0o644)
    await expect(loadOperatorEndpoint("staging", env)).rejects.toThrow(/mode 0600/)
    await writeFile(join(configDir, "config.json"), JSON.stringify({ bridge: { host: "0.0.0.0", port: 9000 } }), { mode: 0o600 })
    await chmod(join(secretsDir, "operator_token"), 0o600)
    expect((await loadOperatorEndpoint("staging", env)).baseUrl).toBe("http://127.0.0.1:9000")
  })
})

describe("runCli routing", () => {
  it("routes approve/reject/jobs/stop to the operator handler with their raw argv", async () => {
    const seen: Array<[string, readonly string[]]> = []
    const deps = {
      writer: () => undefined,
      isTTY: false,
      version: "0.0.0",
      runOperator: async (command: string, args: readonly string[]) => {
        seen.push([command, args])
        return 0
      },
    } as unknown as CliDeps
    expect(await runCli(["approve", "job_1", "--yes"], deps)).toBe(0)
    expect(await runCli(["stop", "--all-jobs"], deps)).toBe(0)
    expect(await runCli(["jobs", "pending"], deps)).toBe(0)
    expect(seen).toEqual([
      ["approve", ["job_1", "--yes"]],
      ["stop", ["--all-jobs"]],
      ["jobs", ["pending"]],
    ])
  })
})

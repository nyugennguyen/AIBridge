/**
 * `aibr jobs | job | cancel | attach` (v3.2.0 block C), driven against the real
 * job API through `app.inject` (see tests/integration/job-api-fixtures.ts):
 * the operator credential for this node, signed peers for `--node` and
 * `--all-nodes`. No real network.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runCli, type CliDeps } from "../../../src/cli.js"
import { runJobCommand, signedPeerTarget, WATCH_INTERVAL_MS, type JobCliDeps, type JobResponse, type JobTarget } from "../../../src/cli/job-commands.js"
import { BridgeTools, type BridgeToolDeps } from "../../../src/mcp/bridge-tools.js"
import { jobApiApp, type Peer } from "../../integration/job-api-fixtures.js"

type Harness = Awaited<ReturnType<typeof jobApiApp>>

async function respond(promise: Promise<{ statusCode: number; body: string }>): Promise<JobResponse> {
  const response = await promise
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(response.body) as Record<string, unknown>
  } catch {
    // empty body
  }
  return { status: response.statusCode, body }
}

const operatorTarget = (h: Harness): JobTarget => ({ label: "local", kind: "operator", request: (m, p) => respond(h.asOperator(m, p)) })
const peerTarget = (h: Harness, label: string, as: Peer): JobTarget => ({ label, kind: "peer", request: (m, p) => respond(h.asPeer(as, m, p)) })
/** A peer request carrying the bearer but no signature. */
const unsignedTarget = (h: Harness, label: string): JobTarget => ({
  label,
  kind: "peer",
  request: (m, p) => respond(h.app.inject({ method: m, url: p, headers: { authorization: "Bearer secret" } })),
})
const downTarget = (label: string): JobTarget => ({
  label,
  kind: "peer",
  request: async () => {
    throw new Error(`${label} is not reachable: connection refused`)
  },
})

interface Options {
  readonly peers?: readonly JobTarget[]
  readonly tty?: boolean
  readonly confirm?: boolean
  /** Called on each sleep with its 1-based count; return true to interrupt. */
  readonly onSleep?: (count: number) => Promise<boolean | void> | boolean | void
}

function cli(h: Harness, options: Options = {}) {
  const output: string[] = []
  const questions: string[] = []
  const sleeps: number[] = []
  const controller = new AbortController()
  const deps: JobCliDeps = {
    writer: (text) => output.push(text),
    confirm: async (question) => {
      questions.push(question)
      return options.confirm ?? false
    },
    isInputTTY: options.tty ?? false,
    isOutputTTY: options.tty ?? false,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    sleep: async (ms) => {
      sleeps.push(ms)
      if ((await options.onSleep?.(sleeps.length)) === true) controller.abort()
    },
    interrupt: () => ({ signal: controller.signal, dispose: () => undefined }),
    local: async () => operatorTarget(h),
    peer: async (_profile, node) => {
      const found = (options.peers ?? []).find((peer) => peer.label === node)
      if (found === undefined) throw new Error(`Unknown peer "${node}".`)
      return found
    },
    peers: async () => options.peers ?? [],
  }
  return { deps, output, questions, sleeps, text: () => output.join("") }
}

describe("aibr jobs", () => {
  it("lists this node's jobs newest first with the operator credential, and filters by status and limit", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_old", "dev-main", "completed", "2026-01-01T10:00:00.000Z")
    await h.seedJob("job_new", "qa-node", "running", "2026-01-01T11:00:00.000Z")
    const c = cli(h)
    expect(await runJobCommand("jobs", [], c.deps)).toBe(0)
    const lines = c.text().trimEnd().split("\n")
    expect(lines[0]).toMatch(/^JOB\s+STATUS\s+CAPABILITY\s+SOURCE\s+UPDATED$/)
    expect(lines[1]).toMatch(/^job_new\s+running\s+\S+\s+qa-node/)
    expect(lines[2]).toMatch(/^job_old\s+completed/)

    const running = cli(h)
    expect(await runJobCommand("jobs", ["--status", "running"], running.deps)).toBe(0)
    expect(running.text()).toContain("job_new")
    expect(running.text()).not.toContain("job_old")

    const limited = cli(h)
    expect(await runJobCommand("jobs", ["--limit=1", "--json"], limited.deps)).toBe(0)
    const parsed = JSON.parse(limited.text()) as { jobs: Array<{ job_id: string; node: string }> }
    expect(parsed.jobs).toEqual([expect.objectContaining({ job_id: "job_new", node: "local" })])
  })

  it("says so when there is nothing, and rejects bad flags with 64", async () => {
    const h = await jobApiApp()
    const c = cli(h)
    expect(await runJobCommand("jobs", [], c.deps)).toBe(0)
    expect(c.text()).toBe("No jobs.\n")
    for (const argv of [["--limit", "0"], ["--limit", "500"], ["--bogus"], ["--all-nodes", "--node", "x"], ["pending"]]) {
      const bad = cli(h)
      expect(await runJobCommand("jobs", argv, bad.deps), argv.join(" ")).toBe(64)
    }
  })

  it("explains an unauthorized local call instead of listing", async () => {
    const h = await jobApiApp()
    const c = cli(h)
    c.deps = { ...c.deps, local: async () => unsignedTarget(h, "local") as JobTarget }
    const code = await runJobCommand("jobs", [], c.deps)
    expect(code).toBe(1)
    expect(c.text()).toMatch(/^Error: /)
  })

  it("--node <peer> lists only what this node dispatched there; an unsigned peer request is explained", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_mine", "dev-main")
    await h.seedJob("job_theirs", "qa-node")
    const c = cli(h, { peers: [peerTarget(h, "worker", "dev-main")] })
    expect(await runJobCommand("jobs", ["--node", "worker"], c.deps)).toBe(0)
    expect(c.text()).toContain("job_mine")
    expect(c.text()).not.toContain("job_theirs")

    const optional = await jobApiApp({ signing: "optional" })
    const unsigned = cli(optional, { peers: [unsignedTarget(optional, "worker")] })
    expect(await runJobCommand("jobs", ["--node", "worker"], unsigned.deps)).toBe(1)
    expect(unsigned.text()).toMatch(/cannot tell which jobs are yours/)
    expect(unsigned.text()).toContain("request_signing")

    const required = cli(h, { peers: [unsignedTarget(h, "worker")] })
    expect(await runJobCommand("jobs", ["--node", "worker"], required.deps)).toBe(1)
    expect(required.text()).toContain("requires a signed request from a paired node (401)")
  })

  it("--all-nodes merges peers by time with a node column; a failing peer gets one line and does not fail the command", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_a", "dev-main", "running", "2026-01-01T10:00:00.000Z")
    await h.seedJob("job_b", "qa-node", "completed", "2026-01-01T12:00:00.000Z")
    const c = cli(h, { peers: [peerTarget(h, "alpha", "dev-main"), downTarget("broken"), peerTarget(h, "beta", "qa-node")] })
    expect(await runJobCommand("jobs", ["--all-nodes"], c.deps)).toBe(0)
    const lines = c.text().trimEnd().split("\n")
    expect(lines[0]).toBe("broken: broken is not reachable: connection refused")
    expect(lines[1]).toMatch(/^NODE\s+JOB\s+STATUS/)
    expect(lines[2]).toMatch(/^beta\s+job_b\s+completed/)
    expect(lines[3]).toMatch(/^alpha\s+job_a\s+running/)
    expect(lines).toHaveLength(4)

    const json = cli(h, { peers: [peerTarget(h, "alpha", "dev-main"), downTarget("broken")] })
    expect(await runJobCommand("jobs", ["--all-nodes", "--json"], json.deps)).toBe(0)
    expect(JSON.parse(json.text())).toMatchObject({
      jobs: [expect.objectContaining({ node: "alpha", job_id: "job_a" })],
      errors: [{ node: "broken", error: "broken is not reachable: connection refused" }],
    })
  })

  it("--all-nodes exits 1 only when no peer answered, and explains an empty peer list", async () => {
    const h = await jobApiApp()
    const none = cli(h, { peers: [downTarget("a"), downTarget("b")] })
    expect(await runJobCommand("jobs", ["--all-nodes"], none.deps)).toBe(1)
    expect(none.text()).toContain("a: a is not reachable")
    expect(none.text()).toContain("b: b is not reachable")
    const empty = cli(h, { peers: [] })
    expect(await runJobCommand("jobs", ["--all-nodes"], empty.deps)).toBe(1)
    expect(empty.text()).toContain("no peers in agents[]")
  })

  it("--watch outside a terminal prints one line per change, not a redraw, and stops on interrupt", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "accepted")
    const c = cli(h, {
      tty: false,
      onSleep: async (count) => {
        if (count === 1) {
          await h.jobManager.markLaunchStarted("job_1")
          await h.jobManager.markRunning("job_1")
        }
        if (count === 2) await h.seedJob("job_2", "dev-main", "accepted")
        return count === 4 // polls 3 and 4 change nothing
      },
    })
    expect(await runJobCommand("jobs", ["--watch"], c.deps)).toBe(0)
    expect(c.sleeps.every((ms) => ms === WATCH_INTERVAL_MS)).toBe(true)
    const lines = c.text().trimEnd().split("\n")
    expect(lines.map((line) => line.replace(/^\S+ /, ""))).toEqual(["job_1 accepted testing", "job_1 running testing", "job_2 accepted testing"])
    expect(lines[0]).toMatch(/^2026-01-01T00:00:00.000Z /)
    expect(c.text()).not.toContain("\u001b")
  })

  it("--watch on a terminal redraws the list without the alternate screen", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "running")
    const c = cli(h, { tty: true, onSleep: (count) => count === 2 })
    expect(await runJobCommand("jobs", ["--watch"], c.deps)).toBe(0)
    expect(c.output).toHaveLength(2)
    expect(c.text()).toContain("\u001b[H\u001b[J")
    expect(c.text()).not.toContain("\u001b[?1049")
    expect(c.text()).toContain("job_1")
  })

  it("--watch fails at once when the first poll fails, and survives a later failure", async () => {
    const h = await jobApiApp()
    const failing = cli(h, { peers: [downTarget("a")] })
    expect(await runJobCommand("jobs", ["--watch", "--all-nodes"], failing.deps)).toBe(1)
    expect(failing.sleeps).toEqual([])

    let calls = 0
    const flaky: JobTarget = {
      label: "local",
      kind: "operator",
      request: async () => {
        calls += 1
        if (calls === 2) throw new Error("bridge is not reachable")
        return { status: 200, body: { jobs: [] } }
      },
    }
    const c = cli(h, { onSleep: (count) => count === 3 })
    c.deps = { ...c.deps, local: async () => flaky }
    expect(await runJobCommand("jobs", ["--watch"], c.deps)).toBe(0)
    expect(c.text().match(/poll failed: bridge is not reachable/g)).toHaveLength(1)
  })
})

describe("aibr job / attach", () => {
  it("shows one job with the operator credential, as JSON too, and maps 404", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "failed")
    const c = cli(h)
    expect(await runJobCommand("job", ["job_1"], c.deps)).toBe(0)
    expect(c.text()).toContain("Job job_1 (failed)")
    expect(c.text()).toContain("source:     dev-main")
    expect(c.text()).toContain("error:      it broke")

    const json = cli(h)
    expect(await runJobCommand("job", ["job_1", "--json"], json.deps)).toBe(0)
    expect(JSON.parse(json.text())).toMatchObject({ id: "job_1", status: "failed" })

    const missing = cli(h)
    expect(await runJobCommand("job", ["nope"], missing.deps)).toBe(1)
    expect(missing.text()).toContain("Job nope was not found on this node")
    expect(await runJobCommand("job", [], cli(h).deps)).toBe(64)
  })

  it("--events prints what the job did, without following", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "running")
    await h.events.append("job_1", { type: "tool", data: { detail: "Tool call: Bash\u001b[31m" } })
    const c = cli(h)
    expect(await runJobCommand("job", ["job_1", "--events"], c.deps)).toBe(0)
    expect(c.sleeps).toEqual([])
    expect(c.text()).toMatch(/status\s+accepted/)
    expect(c.text()).toMatch(/tool\s+Tool call: Bash/)
    expect(c.text()).not.toContain("\u001b")
  })

  it("-f follows until the job is final, then stops by itself", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "running")
    const c = cli(h, {
      onSleep: async (count) => {
        if (count === 1) {
          await h.events.append("job_1", { type: "message", data: { detail: "working on it" } })
        }
        if (count === 2) await h.jobManager.markCompleted("job_1")
        return count > 6 // safety net: a follower that never stops fails the assertion below
      },
    })
    expect(await runJobCommand("job", ["job_1", "-f"], c.deps)).toBe(0)
    expect(c.sleeps).toHaveLength(2)
    expect(c.text()).toContain("working on it")
    expect(c.text().trimEnd().split("\n").at(-1)).toBe("Job job_1 ended: completed")
  })

  it("attach is read-only job --events -f, and stops at once on an already ended job", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "completed")
    const c = cli(h)
    expect(await runJobCommand("attach", ["job_1"], c.deps)).toBe(0)
    expect(c.sleeps).toEqual([])
    expect(c.text()).toContain("Job job_1 ended: completed")
    expect(await runJobCommand("attach", ["job_1", "--yes"], cli(h).deps)).toBe(64)
  })

  it("-f stops on interrupt, notes a job waiting for approval, and --json prints one event per line", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "awaiting_approval")
    const c = cli(h, { onSleep: (count) => count === 2 })
    expect(await runJobCommand("job", ["job_1", "-f"], c.deps)).toBe(0)
    expect(c.text().match(/awaiting operator approval/g)).toHaveLength(1)

    const json = cli(h, { onSleep: () => true })
    expect(await runJobCommand("job", ["job_1", "--follow", "--json"], json.deps)).toBe(0)
    for (const line of json.text().trimEnd().split("\n")) expect(JSON.parse(line)).toMatchObject({ job_id: "job_1" })
  })

  it("a peer follows only its own job: another peer's job is a 403 not_job_requester", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "qa-node", "completed")
    const c = cli(h, { peers: [peerTarget(h, "worker", "dev-main")] })
    expect(await runJobCommand("job", ["job_1", "--events", "--node", "worker"], c.deps)).toBe(1)
    expect(c.text()).toContain("was not dispatched by this node")
  })

  it("stops after repeated connection failures while following", async () => {
    const h = await jobApiApp()
    const c = cli(h, { peers: [downTarget("worker")] })
    expect(await runJobCommand("attach", ["job_1", "--node", "worker"], c.deps)).toBe(1)
    expect(c.sleeps).toHaveLength(2)
    expect(c.text()).toContain("worker is not reachable")
  })
})

describe("aibr cancel", () => {
  it("asks first (default No) and changes nothing when declined", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "running")
    const c = cli(h, { tty: true, confirm: false })
    expect(await runJobCommand("cancel", ["job_1"], c.deps)).toBe(1)
    expect(c.questions).toHaveLength(1)
    expect(c.questions[0]).toContain("Cancel job job_1?")
    expect(c.text()).toBe("Nothing changed.\n")
    expect((await h.jobManager.getJob("job_1")).status).toBe("running")
  })

  it("cancels after confirmation, and --yes skips the question", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "running")
    await h.seedJob("job_2", "dev-main", "running")
    const asked = cli(h, { tty: true, confirm: true })
    expect(await runJobCommand("cancel", ["job_1"], asked.deps)).toBe(0)
    expect(asked.text()).toBe("Cancelled job_1: failed (cancelled by operator)\n")
    expect((await h.jobManager.getJob("job_1")).status).toBe("failed")

    const yes = cli(h, { tty: false })
    expect(await runJobCommand("cancel", ["job_2", "--yes"], yes.deps)).toBe(0)
    expect(yes.questions).toEqual([])
    expect(yes.text()).toContain("Cancelled job_2")
  })

  it("refuses without --yes when there is no terminal, and sends nothing", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "dev-main", "running")
    const c = cli(h, { tty: false, confirm: true })
    expect(await runJobCommand("cancel", ["job_1"], c.deps)).toBe(64)
    expect(c.text()).toContain("pass --yes")
    expect(c.questions).toEqual([])
    expect((await h.jobManager.getJob("job_1")).status).toBe("running")
  })

  it("maps 409 awaiting_approval (suggests aibr reject), job_finished, 404 and usage errors", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_wait", "dev-main", "awaiting_approval")
    await h.seedJob("job_done", "dev-main", "completed")
    const wait = cli(h)
    expect(await runJobCommand("cancel", ["job_wait", "--yes"], wait.deps)).toBe(1)
    expect(wait.text()).toContain("awaiting operator approval")
    expect(wait.text()).toContain("aibr reject job_wait")
    expect((await h.jobManager.getJob("job_wait")).status).toBe("awaiting_approval")

    const done = cli(h)
    expect(await runJobCommand("cancel", ["job_done", "-y"], done.deps)).toBe(1)
    expect(done.text()).toContain("job job_done has already ended (status completed)")

    const missing = cli(h)
    expect(await runJobCommand("cancel", ["nope", "--yes"], missing.deps)).toBe(1)
    expect(missing.text()).toContain("Job nope was not found")

    expect(await runJobCommand("cancel", [], cli(h).deps)).toBe(64)
    expect(await runJobCommand("cancel", ["a", "b", "--yes"], cli(h).deps)).toBe(64)
  })

  it("maps 202 stopping and 409 cancel_in_progress from the node's own answer", async () => {
    const h = await jobApiApp()
    const scripted = (status: number, body: Record<string, unknown>): JobTarget => ({ label: "local", kind: "operator", request: async () => ({ status, body }) })
    const stopping = cli(h)
    stopping.deps = { ...stopping.deps, local: async () => scripted(202, { job_id: "job_1", status: "running", cancelling: true }) }
    expect(await runJobCommand("cancel", ["job_1", "--yes"], stopping.deps)).toBe(0)
    expect(stopping.text()).toContain("Stopping job_1")
    expect(stopping.text()).toContain("aibr job job_1 -f")

    const busy = cli(h)
    busy.deps = { ...busy.deps, local: async () => scripted(409, { code: "cancel_in_progress", error: "x" }) }
    expect(await runJobCommand("cancel", ["job_1", "--yes"], busy.deps)).toBe(1)
    expect(busy.text()).toContain("already in progress")
  })

  it("maps 403: a peer cannot cancel another peer's job; an unsigned peer is told to pair", async () => {
    const h = await jobApiApp()
    await h.seedJob("job_1", "qa-node", "running")
    const other = cli(h, { peers: [peerTarget(h, "worker", "dev-main")] })
    expect(await runJobCommand("cancel", ["job_1", "--yes", "--node", "worker"], other.deps)).toBe(1)
    expect(other.text()).toContain("was not dispatched by this node")
    expect((await h.jobManager.getJob("job_1")).status).toBe("running")

    const unsigned = cli(h, { peers: [unsignedTarget(h, "worker")] })
    expect(await runJobCommand("cancel", ["job_1", "--yes", "--node", "worker"], unsigned.deps)).toBe(1)
    expect(unsigned.text()).toContain("aibr enroll")

    const own = cli(h, { peers: [peerTarget(h, "worker", "qa-node")] })
    expect(await runJobCommand("cancel", ["job_1", "--yes", "--node", "worker"], own.deps)).toBe(0)
    expect(own.text()).toContain("Cancelled job_1 on worker: failed (cancelled by requester)")
  })
})

describe("real peer target", () => {
  it("sends the bearer token and a node signature, and reports an unreachable peer without secrets", async () => {
    const home = await mkdtemp(join(tmpdir(), "aibr-job-cli-"))
    const configDir = join(home, ".config", "aibridge", "dev")
    const secrets = join(home, ".local", "share", "aibridge", "dev", "secrets")
    await mkdir(configDir, { recursive: true })
    await mkdir(secrets, { recursive: true })
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({
        agent_id: "dev-main",
        bridge: { host: "127.0.0.1", port: 8787, public_url: "http://dev-main.ts.net:8787", ingress_mode: "engine" },
        opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096 },
        security: { auth_mode: "bearer-token", allowed_sources: [] },
        permissions: { default_response: "reject", allow_tools: [], require_plan_approval_for_tools: [] },
        projects: [],
        agents: [{ id: "staging", url: "http://staging.ts.net:8787/", capabilities: [] }],
        timeouts: { default_job_seconds: 900, callback_retry_attempts: 3 },
        planning: { plan_annotator_enabled: false, require_approval_for: [] },
      }),
    )
    await writeFile(join(secrets, "bearer_token"), "tok_SECRET_abcdef123456\n")
    const { readFile } = await import("node:fs/promises")
    const seen: Array<{ url: string; method: string | undefined; authorization: string | null }> = []
    let reachable = true
    const toolDeps: BridgeToolDeps = {
      fetch: async (url, init) => {
        seen.push({ url, method: init?.method, authorization: new Headers(init?.headers).get("authorization") })
        if (!reachable) throw new Error("ECONNREFUSED tok_SECRET_abcdef123456")
        return new Response(JSON.stringify({ jobs: [] }), { status: 200 })
      },
      env: { HOME: home },
      readFile: (path) => readFile(path, "utf8"),
      listProfileDirs: async () => ["dev"],
      writeFile: async () => undefined,
      uuid: () => "id",
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
    }
    const loaded = await new BridgeTools(toolDeps, "dev").loadProfile()
    const target = signedPeerTarget(loaded, loaded.config.agents[0]!, toolDeps)
    expect(target.label).toBe("staging")
    expect(await target.request("GET", "/jobs?limit=5")).toEqual({ status: 200, body: { jobs: [] } })
    expect(seen).toEqual([{ url: "http://staging.ts.net:8787/jobs?limit=5", method: "GET", authorization: "Bearer tok_SECRET_abcdef123456" }])
    reachable = false
    await expect(target.request("GET", "/jobs")).rejects.toThrow(/staging is not reachable/)
  })
})

describe("runCli routing", () => {
  function deps(extra: Partial<CliDeps>): CliDeps {
    return { writer: () => undefined, isTTY: false, ...extra } as unknown as CliDeps
  }

  it("sends `jobs pending` to the operator command and every other jobs form to the job list", async () => {
    const operator: Array<[string, readonly string[]]> = []
    const jobs: Array<[string, readonly string[]]> = []
    const d = deps({
      runOperator: async (command, args) => (operator.push([command, args]), 0),
      runJobs: async (command, args) => (jobs.push([command, args]), 0),
    })
    expect(await runCli(["jobs", "pending", "--json"], d)).toBe(0)
    expect(await runCli(["jobs"], d)).toBe(0)
    expect(await runCli(["jobs", "--all-nodes", "--watch"], d)).toBe(0)
    expect(await runCli(["job", "j1", "--events", "-f"], d)).toBe(0)
    expect(await runCli(["cancel", "j1", "--yes"], d)).toBe(0)
    expect(await runCli(["attach", "j1"], d)).toBe(0)
    expect(operator).toEqual([["jobs", ["pending", "--json"]]])
    expect(jobs).toEqual([
      ["jobs", []],
      ["jobs", ["--all-nodes", "--watch"]],
      ["job", ["j1", "--events", "-f"]],
      ["cancel", ["j1", "--yes"]],
      ["attach", ["j1"]],
    ])
  })

  it("lists the new commands in --help, and the help texts point at each other", async () => {
    const chunks: string[] = []
    await runCli(["--help"], deps({ writer: (text) => chunks.push(text) }))
    const help = chunks.join("")
    for (const command of ["jobs", "job", "cancel", "attach"]) expect(help).toMatch(new RegExp(`^  ${command}\\s`, "m"))
    const text = async (argv: string[]) => {
      const out: string[] = []
      expect(await runCli(argv, deps({ writer: (t) => out.push(t) }))).toBe(0)
      return out.join("")
    }
    expect(await text(["cancel", "--help"])).toContain("aibr stop stops the service")
    expect(await text(["stop", "--help"])).toContain("aibr cancel <job_id>")
    expect(await text(["attach", "--help"])).toContain("does NOT attach a terminal")
    expect(await text(["jobs", "--help"])).toContain("aibr jobs pending")
  })
})

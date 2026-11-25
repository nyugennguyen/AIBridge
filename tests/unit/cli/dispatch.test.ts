import { describe, expect, it } from "vitest"
import {
  chooseCapability,
  chooseProject,
  parseFlags,
  renderPing,
  runPingCommand,
  runSendCommand,
  type DispatchCliDeps,
} from "../../../src/cli/dispatch.js"
import type { PingOutcome } from "../../../src/mcp/bridge-tools.js"
import type { PongInfo } from "../../../src/jobs/types.js"

const PONG: PongInfo = {
  agent_id: "staging",
  role: "worker",
  runtime: "claude",
  version: "3.0.0",
  capabilities: ["investigate", "run-tests"],
  projects: [{ id: "app", path: "/srv/app", capabilities: ["investigate"] }],
}

function okPing(overrides: Partial<PingOutcome> = {}): PingOutcome {
  return {
    ok: true,
    target: "staging",
    url: "http://staging:8787",
    jobId: "ping-1",
    stage: "done",
    rttMs: 42,
    callback: { status: "delivered" },
    pong: PONG,
    ...overrides,
  }
}

function toolResult(data: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) }
}

interface FakeTools {
  pings: Array<{ target: string; options: unknown }>
  calls: Array<{ name: string; args: Record<string, unknown> }>
  loadProfile: () => Promise<unknown>
  ping: (target: string, options?: unknown) => Promise<PingOutcome>
  call: (name: string, args: Record<string, unknown>) => Promise<ReturnType<typeof toolResult>>
}

function fakeTools(opts: {
  agents?: string[]
  ping?: PingOutcome
  responses?: Record<string, Array<ReturnType<typeof toolResult>>>
}): FakeTools {
  const queues = { ...(opts.responses ?? {}) }
  const tools: FakeTools = {
    pings: [],
    calls: [],
    loadProfile: async () => ({ name: "dev", config: { agents: (opts.agents ?? ["staging"]).map((id) => ({ id })) } }),
    ping: async (target, options) => {
      tools.pings.push({ target, options })
      return opts.ping ?? okPing({ target })
    },
    call: async (name, args) => {
      tools.calls.push({ name, args })
      const queue = queues[name]
      if (queue === undefined || queue.length === 0) throw new Error(`unexpected tool call ${name}`)
      return queue.length === 1 ? queue[0]! : queue.shift()!
    },
  }
  return tools
}

function harness(tools: FakeTools, extra: Partial<DispatchCliDeps> = {}) {
  const out: string[] = []
  const sleeps: number[] = []
  const deps: DispatchCliDeps = {
    write: (t) => void out.push(t),
    tools: () => tools as never,
    cwd: "/home/me/work/app",
    gitRoot: async () => "/home/me/work/app",
    sleep: async (ms) => void sleeps.push(ms),
    ...extra,
  }
  return { deps, text: () => out.join(""), sleeps }
}

describe("parseFlags", () => {
  it("splits positionals, value flags and booleans", () => {
    expect(parseFlags(["peer", "do it", "--capability", "x", "--project=/p", "-p", "dev", "--json"])).toEqual({
      positional: ["peer", "do it"],
      flags: new Map([["--capability", "x"], ["--project", "/p"], ["--profile", "dev"]]),
      bools: new Set(["--json"]),
    })
  })

  it("rejects unknown flags and missing values", () => {
    expect(parseFlags(["--bogus"])).toBe("unknown flag --bogus")
    expect(parseFlags(["--capability"])).toBe("--capability needs a value")
    expect(parseFlags(["--project="])).toBe("--project needs a value")
  })

  it("maps -h to --help", () => {
    const parsed = parseFlags(["-h"])
    expect(typeof parsed !== "string" && parsed.bools.has("--help")).toBe(true)
  })
})

describe("chooseCapability", () => {
  it("prefers investigate, then the only one", () => {
    expect(chooseCapability(["run-tests", "investigate"], "p")).toBe("investigate")
    expect(chooseCapability(["run-tests"], "p")).toBe("run-tests")
  })

  it("explains none and many", () => {
    expect(chooseCapability([], "p")).toEqual({ error: expect.stringContaining("aibr enroll issue --capabilities") })
    expect(chooseCapability(["a", "b"], "p")).toEqual({ error: "Choose one with --capability: p accepts a, b." })
  })
})

describe("chooseProject", () => {
  const projects = [
    { id: "app", path: "/srv/app" },
    { id: "api", path: "/srv/backend" },
  ]

  it("uses an absolute --project as is, or maps a project id", () => {
    expect(chooseProject("/x/y", projects, null, "p")).toBe("/x/y")
    expect(chooseProject("api", projects, null, "p")).toBe("/srv/backend")
    expect(chooseProject("/x/y", null, null, "p")).toBe("/x/y")
  })

  it("rejects a relative --project", () => {
    const result = chooseProject("rel/dir", projects, null, "p")
    expect(result).toEqual({ error: expect.stringContaining("one of its project ids: app, api") })
  })

  it("defaults to the only project and explains none", () => {
    expect(chooseProject(undefined, [projects[0]!], null, "p")).toBe("/srv/app")
    expect(chooseProject(undefined, [], null, "p")).toEqual({ error: expect.stringContaining("allowlists no project") })
    expect(chooseProject(undefined, null, null, "p")).toEqual({ error: "Pass --project <dir on p>." })
  })

  it("matches several projects by the local git root's name, else asks", () => {
    expect(chooseProject(undefined, projects, "/home/me/backend", "p")).toBe("/srv/backend")
    expect(chooseProject(undefined, projects, "/home/me/api", "p")).toBe("/srv/backend")
    expect(chooseProject(undefined, projects, "/home/me/other", "p")).toEqual({ error: expect.stringContaining("Choose one with --project") })
    expect(chooseProject(undefined, projects, null, "p")).toEqual({ error: expect.stringContaining("app (/srv/app)") })
  })
})

describe("renderPing", () => {
  it("renders a success with the pong", () => {
    const text = renderPing(okPing())
    expect(text).toContain("✓ ping staging (http://staging:8787): 42 ms")
    expect(text).toContain("callback: delivered")
    expect(text).toContain("accepts:  investigate, run-tests")
    expect(text).toContain("app /srv/app")
  })

  it("says the callback was not checked when skipped", () => {
    expect(renderPing(okPing({ callback: { status: "skipped" } }))).toContain("not checked")
  })

  it("renders a failure with its fix, and the request line at the callback stage", () => {
    const failed = renderPing({ ok: false, target: "s", url: null, stage: "dispatch", rttMs: 1, callback: { status: "unknown" }, error: "boom", hint: "do x" })
    expect(failed).toBe("✗ ping s: boom\n  fix:      do x\n")
    const callback = renderPing({
      ok: false,
      target: "s",
      url: "http://s:1",
      jobId: "ping-9",
      stage: "callback",
      rttMs: 1,
      callback: { status: "failed" },
      error: "not delivered",
    })
    expect(callback).toContain("accepted and completed (job ping-9)")
  })
})

describe("runPingCommand", () => {
  it("pings the only peer when none is named", async () => {
    const tools = fakeTools({})
    const h = harness(tools)
    expect(await runPingCommand([], h.deps)).toBe(0)
    expect(tools.pings[0]).toEqual({ target: "staging", options: { timeoutMs: 20_000 } })
    expect(h.text()).toContain("✓ ping staging")
  })

  it("errors when the profile has no peers or several", async () => {
    const none = harness(fakeTools({ agents: [] }))
    expect(await runPingCommand([], none.deps)).toBe(1)
    expect(none.text()).toContain("has no peers yet")
    const many = harness(fakeTools({ agents: ["a", "b"] }))
    expect(await runPingCommand([], many.deps)).toBe(1)
    expect(many.text()).toContain("Name a peer: a, b.")
  })

  it("parses --timeout and refuses a bad one", async () => {
    const tools = fakeTools({})
    const h = harness(tools)
    expect(await runPingCommand(["staging", "--timeout", "5"], h.deps)).toBe(0)
    expect(tools.pings[0]?.options).toEqual({ timeoutMs: 5000 })
    expect(await runPingCommand(["staging", "--timeout", "0"], h.deps)).toBe(64)
    expect(await runPingCommand(["a", "b"], h.deps)).toBe(64)
  })

  it("--json prints the outcome; a failed ping exits 1", async () => {
    const failed: PingOutcome = { ok: false, target: "staging", url: null, stage: "dispatch", rttMs: 3, callback: { status: "unknown" }, error: "nope" }
    const h = harness(fakeTools({ ping: failed }))
    expect(await runPingCommand(["staging", "--json"], h.deps)).toBe(1)
    expect(JSON.parse(h.text())).toEqual(failed)
  })

  it("prints help", async () => {
    const h = harness(fakeTools({}))
    expect(await runPingCommand(["--help"], h.deps)).toBe(0)
    expect(h.text()).toContain("aibr ping")
  })
})

describe("runSendCommand", () => {
  it("fills capability and project from the pong and waits for the result", async () => {
    const tools = fakeTools({
      responses: {
        bridge_dispatch: [toolResult({ job_id: "j1", target: "staging", status: "accepted", status_url: "http://s/jobs/j1" })],
        bridge_await: [toolResult({ job_id: "j1", status: "completed", still_running: false })],
        bridge_result: [
          toolResult({
            job_id: "j1",
            target: "staging",
            status: "completed",
            summary: "All good.",
            findings: [{ severity: "low", title: "Nit", details: "line 1\nline 2" }],
          }),
        ],
      },
    })
    const h = harness(tools)
    expect(await runSendCommand(["staging", "check it"], h.deps)).toBe(0)
    expect(tools.pings).toEqual([{ target: "staging", options: { waitForCallback: false } }])
    expect(tools.calls[0]).toEqual({
      name: "bridge_dispatch",
      args: { target: "staging", capability: "investigate", project_dir: "/srv/app", prompt: "check it" },
    })
    const text = h.text()
    expect(text).toContain("Dispatched job j1 to staging (capability investigate, project /srv/app).")
    expect(text).toContain("Job j1 on staging: completed")
    expect(text).toContain("All good.")
    expect(text).toContain("[low] Nit")
    expect(text).toContain("      line 2")
  })

  it("skips the ping when both --capability and an absolute --project are given", async () => {
    const tools = fakeTools({
      responses: {
        bridge_dispatch: [toolResult({ job_id: "j2", status: "accepted", status_url: "u" })],
      },
    })
    const h = harness(tools)
    expect(
      await runSendCommand(["staging", "go", "--capability", "run-tests", "--project", "/srv/x", "--no-wait", "--timeout-seconds", "30"], h.deps),
    ).toBe(0)
    expect(tools.pings).toEqual([])
    expect(tools.calls[0]?.args).toEqual({ target: "staging", capability: "run-tests", project_dir: "/srv/x", prompt: "go", timeout_seconds: 30 })
    expect(h.text()).toContain("Not waiting. Status: u")
  })

  it("keeps polling while the job awaits approval, sleeping between polls", async () => {
    const tools = fakeTools({
      responses: {
        bridge_dispatch: [toolResult({ job_id: "j3", status: "accepted" })],
        bridge_await: [
          toolResult({ job_id: "j3", status: "awaiting_approval", message: "Ask the operator" }),
          toolResult({ job_id: "j3", status: "awaiting_approval", message: "Ask the operator" }),
          toolResult({ job_id: "j3", status: "failed" }),
        ],
        bridge_result: [toolResult({ job_id: "j3", target: "staging", status: "failed", error: "rejected" })],
      },
    })
    const h = harness(tools)
    expect(await runSendCommand(["staging", "go", "--capability", "c", "--project", "/p"], h.deps)).toBe(1)
    expect(h.sleeps).toEqual([5000, 5000])
    expect(h.text().match(/Ask the operator/g)).toHaveLength(1)
    expect(h.text()).toContain("Error: rejected")
  })

  it("prints the dispatch error and its fix", async () => {
    const tools = fakeTools({
      responses: {
        bridge_dispatch: [toolResult({ error: "Peer requires a signed request", hint: "Do not retry. Pair it: aibr enroll join <code>" }, true)],
      },
    })
    const h = harness(tools)
    expect(await runSendCommand(["staging", "go", "--capability", "c", "--project", "/p"], h.deps)).toBe(1)
    expect(h.text()).toBe("Error: Peer requires a signed request\n  fix: Pair it: aibr enroll join <code>\n")
  })

  it("fails when the peer cannot be pinged for its defaults", async () => {
    const tools = fakeTools({
      ping: { ok: false, target: "staging", url: null, stage: "dispatch", rttMs: 1, callback: { status: "unknown" }, error: "unreachable", hint: "check tailscale" },
    })
    const h = harness(tools)
    expect(await runSendCommand(["staging", "go"], h.deps)).toBe(1)
    expect(h.text()).toContain("could not reach staging")
    expect(h.text()).toContain("fix: check tailscale")
  })

  it("validates its arguments", async () => {
    const h = harness(fakeTools({}))
    expect(await runSendCommand(["staging"], h.deps)).toBe(64)
    expect(await runSendCommand(["staging", "  "], h.deps)).toBe(64)
    expect(await runSendCommand(["staging", "go", "--timeout-seconds", "x"], h.deps)).toBe(64)
  })
})

import { describe, expect, it } from "vitest"
import { BridgeTools, TOOL_DEFINITIONS, type BridgeToolDeps } from "../../../src/mcp/bridge-tools.js"
import { McpServer, serveStdio } from "../../../src/mcp/server.js"
import { CLI_VERSION } from "../../../src/version.js"

const TOKEN = "tok_SECRET_abcdef123456"
const HOME = "/home/test"
const CONFIG_PATH = `${HOME}/.config/aibridge/dev/config.json`
const TOKEN_PATH = `${HOME}/.local/share/aibridge/dev/secrets/bearer_token`

function config(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agent_id: "dev-main",
    bridge: { host: "127.0.0.1", port: 8787, public_url: "http://dev-main.ts.net:8787", ingress_mode: "engine" },
    opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096 },
    security: { auth_mode: "bearer-token", allowed_sources: [] },
    permissions: { default_response: "reject", allow_tools: [], require_plan_approval_for_tools: [] },
    projects: [],
    agents: [{ id: "staging", url: "http://staging.ts.net:8787", capabilities: ["investigate", "run-tests"] }],
    timeouts: { default_job_seconds: 900, callback_retry_attempts: 3 },
    planning: { plan_annotator_enabled: false, require_approval_for: [] },
    ...overrides,
  })
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function makeDeps(
  handler: (call: Call) => Response | Promise<Response>,
  opts: { files?: Record<string, string>; profiles?: string[]; env?: Record<string, string> } = {},
) {
  const calls: Call[] = []
  const written: Record<string, string> = {}
  let clock = 0
  const files: Record<string, string> = { [CONFIG_PATH]: config(), [TOKEN_PATH]: TOKEN + "\n", ...opts.files }
  const deps: BridgeToolDeps = {
    fetch: async (url, init) => {
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? init.body : undefined,
      }
      calls.push(call)
      return handler(call)
    },
    env: { HOME, ...opts.env },
    readFile: async (path) => {
      const value = written[path] ?? files[path]
      if (value === undefined) throw new Error("ENOENT")
      return value
    },
    listProfileDirs: async () => opts.profiles ?? ["dev"],
    writeFile: async (path, data) => {
      written[path] = data
    },
    uuid: () => "job-uuid-1",
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  }
  return { deps, calls, written, files }
}

function toolsFor(deps: BridgeToolDeps, ...rest: [profile?: string | undefined]) {
  const profile = rest.length === 0 ? "dev" : rest[0]
  return new BridgeTools(deps, profile)
}

function textOf(result: { content: readonly { text: string }[] }): string {
  return result.content[0]?.text ?? ""
}

describe("MCP protocol", () => {
  const server = () => new McpServer(toolsFor(makeDeps(() => json({})).deps))

  it("initialize echoes a supported protocol version and reports serverInfo", async () => {
    const out = JSON.parse((await server().handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }))) as string)
    expect(out.result.protocolVersion).toBe("2025-03-26")
    expect(out.result.capabilities).toEqual({ tools: {} })
    expect(out.result.serverInfo).toEqual({ name: "aibridge", version: CLI_VERSION })
  })

  it("initialize falls back for an unsupported version", async () => {
    const out = JSON.parse((await server().handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }))) as string)
    expect(out.result.protocolVersion).toBe("2025-06-18")
  })

  it("notifications produce no response", async () => {
    expect(await server().handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull()
  })

  it("lists exactly the expected tools and no approve tool", async () => {
    const out = JSON.parse((await server().handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }))) as string)
    const names = out.result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(["bridge_peers", "bridge_dispatch", "bridge_status", "bridge_result", "bridge_await", "bridge_events", "bridge_cancel"])
    // Operator-only actions are never MCP tools (ADR 0014, 0015).
    expect(names.some((n: string) => /approve|reject|stop|pending/i.test(n))).toBe(false)
    // Tool descriptions do not assume which agent orchestrates (ADR 0015).
    for (const tool of TOOL_DEFINITIONS) expect(tool.description).not.toMatch(/claude/i)
    expect(TOOL_DEFINITIONS.every((t) => (t.inputSchema as { type: string }).type === "object")).toBe(true)
  })

  it("answers ping", async () => {
    const out = JSON.parse((await server().handleLine(JSON.stringify({ jsonrpc: "2.0", id: "p", method: "ping" }))) as string)
    expect(out).toEqual({ jsonrpc: "2.0", id: "p", result: {} })
  })

  it("unknown method yields -32601", async () => {
    const out = JSON.parse((await server().handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/list" }))) as string)
    expect(out.error.code).toBe(-32601)
    expect(out.id).toBe(3)
  })

  it("bad JSON yields -32700 with null id", async () => {
    const out = JSON.parse((await server().handleLine("{not json")) as string)
    expect(out.error.code).toBe(-32700)
    expect(out.id).toBeNull()
  })

  it("unknown tool name is an invalid-params error", async () => {
    const out = JSON.parse((await server().handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "bridge_approve", arguments: {} } }))) as string)
    expect(out.error.code).toBe(-32602)
  })

  it("stdout carries only JSON-RPC frames", async () => {
    const written: string[] = []
    const lines = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      "garbage",
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ]
    async function* input() {
      // split across chunk boundaries to exercise buffering
      const all = lines.join("\n") + "\n"
      yield all.slice(0, 17)
      yield all.slice(17)
    }
    await serveStdio(server(), { input: input(), write: (l) => written.push(l) })
    const frames = written.join("").split("\n").filter(Boolean)
    expect(frames).toHaveLength(3)
    for (const frame of frames) expect(JSON.parse(frame).jsonrpc).toBe("2.0")
    expect(written.every((w) => w.endsWith("\n"))).toBe(true)
  })
})

describe("bridge_peers", () => {
  it("reports reachability and runtime per peer, with a 3s abort signal", async () => {
    const { deps, calls } = makeDeps(() => json({ ok: true, opencode: true, agent_id: "staging", capabilities: [] }))
    const result = await toolsFor(deps).call("bridge_peers", {})
    const body = JSON.parse(textOf(result))
    expect(body.peers).toEqual([
      { id: "staging", url: "http://staging.ts.net:8787", capabilities: ["investigate", "run-tests"], reachable: true, runtime: "opencode (up)" },
    ])
    expect(calls[0]?.url).toBe("http://staging.ts.net:8787/health")
  })

  it("reports a Claude worker's runtime from /health (no opencode field)", async () => {
    const { deps } = makeDeps(() => json({ ok: true, runtime: "claude", agent_id: "staging", capabilities: [] }))
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_peers", {})))
    expect(body.peers[0].runtime).toBe("claude")
  })

  it("marks an unreachable peer without failing the call", async () => {
    const { deps } = makeDeps(() => {
      throw new Error("ECONNREFUSED")
    })
    const result = await toolsFor(deps).call("bridge_peers", {})
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(textOf(result)).peers[0].reachable).toBe(false)
  })
})

describe("bridge_dispatch", () => {
  const args = { target: "staging", capability: "run-tests", project_dir: "/srv/app", prompt: "run tests on branch x @ abc123" }

  it("posts /trigger with source, callback and bearer, and never echoes the token", async () => {
    const { deps, calls, written } = makeDeps(() =>
      json({ accepted: true, job_id: "job-uuid-1", target_agent_id: "staging", status_url: "http://staging.ts.net:8787/jobs/job-uuid-1", status: "accepted" }, 202),
    )
    const result = await toolsFor(deps).call("bridge_dispatch", args)
    expect(result.isError).toBeUndefined()
    const call = calls[0] as Call
    expect(call.url).toBe("http://staging.ts.net:8787/trigger")
    expect(call.method).toBe("POST")
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`)
    const sent = JSON.parse(call.body as string)
    expect(sent).toMatchObject({
      job_id: "job-uuid-1",
      source_agent_id: "dev-main",
      target_agent_id: "staging",
      capability: "run-tests",
      callback_url: "http://dev-main.ts.net:8787/report",
      timeout_seconds: 900,
    })
    expect(JSON.parse(textOf(result))).toMatchObject({ job_id: "job-uuid-1", status: "accepted", status_url: "http://staging.ts.net:8787/jobs/job-uuid-1" })
    expect(textOf(result)).not.toContain(TOKEN)
    expect(Object.values(written).join("")).not.toContain(TOKEN)
  })

  it("explains a signature-required 401 as a pairing problem, not a stale token", async () => {
    const { deps } = makeDeps(() =>
      json({ error: "This bridge requires signed requests (security.request_signing: required). Pair this node with `aibr enroll join <code>`.", code: "signature_required" }, 401),
    )
    const result = await toolsFor(deps).call("bridge_dispatch", args)
    expect(result.isError).toBe(true)
    const body = JSON.parse(textOf(result))
    expect(body.code).toBe("signature_required")
    expect(textOf(result)).toContain("aibr enroll join")
    expect(textOf(result)).not.toContain("out of date")
  })

  it("keeps the stale-token message for a plain bearer 401", async () => {
    const { deps } = makeDeps(() => json({ error: "Unauthorized" }, 401))
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_dispatch", args)))
    expect(body.code).toBe("unauthorized")
  })

  it("refuses an unknown peer without any HTTP call", async () => {
    const { deps, calls } = makeDeps(() => json({}))
    const result = await toolsFor(deps).call("bridge_dispatch", { ...args, target: "nope" })
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result)).code).toBe("unknown_peer")
    expect(calls).toHaveLength(0)
  })

  it("refuses a capability the peer does not advertise before sending", async () => {
    const { deps, calls } = makeDeps(() => json({}))
    const result = await toolsFor(deps).call("bridge_dispatch", { ...args, capability: "fix-on-branch" })
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result)).code).toBe("capability_not_advertised")
    expect(calls).toHaveLength(0)
  })

  it("maps a plan-approval 403 to approval_required with a do-not-retry hint", async () => {
    const { deps } = makeDeps(() => json({ error: "Plan approval required" }, 403))
    const result = await toolsFor(deps).call("bridge_dispatch", args)
    const body = JSON.parse(textOf(result))
    expect(result.isError).toBe(true)
    expect(body.code).toBe("approval_required")
    expect(body.hint).toMatch(/Do not retry/)
  })

  it("redacts the token if a peer reflects it in an error", async () => {
    const { deps } = makeDeps(() => json({ error: `bad header Bearer ${TOKEN}` }, 500))
    const result = await toolsFor(deps).call("bridge_dispatch", args)
    expect(textOf(result)).not.toContain(TOKEN)
    expect(textOf(result)).toContain("[redacted]")
  })

  it("redacts the token from transport errors", async () => {
    const { deps } = makeDeps(() => {
      throw new Error(`socket hang up ${TOKEN}`)
    })
    const result = await toolsFor(deps).call("bridge_dispatch", args)
    expect(result.isError).toBe(true)
    expect(textOf(result)).not.toContain(TOKEN)
  })

  it("rejects a non-positive timeout_seconds", async () => {
    const { deps } = makeDeps(() => json({}))
    const result = await toolsFor(deps).call("bridge_dispatch", { ...args, timeout_seconds: 0 })
    expect(JSON.parse(textOf(result)).code).toBe("invalid_argument")
  })

  it("keeps a best-effort ledger of dispatched jobs", async () => {
    const { deps, written } = makeDeps(() => json({ accepted: true, job_id: "job-uuid-1", status: "accepted" }, 202))
    await toolsFor(deps).call("bridge_dispatch", args)
    const ledger = Object.entries(written).find(([path]) => path.endsWith("mcp-jobs.json"))
    expect(JSON.parse(ledger?.[1] ?? "[]")[0]).toMatchObject({ job_id: "job-uuid-1", target: "staging" })
  })
})

describe("bridge_status / bridge_result / bridge_cancel", () => {
  it("bridge_status reports status and finality", async () => {
    const { deps, calls } = makeDeps(() => json({ id: "j1", status: "running", updatedAt: "t" }))
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_status", { job_id: "j1", target: "staging" })))
    expect(body).toMatchObject({ status: "running", final: false })
    expect(calls[0]?.url).toBe("http://staging.ts.net:8787/jobs/j1")
  })

  it("bridge_result surfaces summary and findings, including nested reports", async () => {
    const { deps } = makeDeps(() =>
      json({ id: "j1", status: "completed", report: { summary: "2 failing", findings: [{ severity: "high", title: "x", details: "y" }] } }),
    )
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_result", { job_id: "j1", target: "staging" })))
    expect(body.final).toBe(true)
    expect(body.summary).toBe("2 failing")
    expect(body.findings).toHaveLength(1)
  })

  it("bridge_result is honest when the bridge stored no summary", async () => {
    const { deps } = makeDeps(() => json({ id: "j1", status: "completed" }))
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_result", { job_id: "j1", target: "staging" })))
    expect(body.note).toMatch(/only the status/)
  })

  it("maps a 404 to job_not_found", async () => {
    const { deps } = makeDeps(() => json({ error: "Job not found" }, 404))
    const result = await toolsFor(deps).call("bridge_status", { job_id: "zz", target: "staging" })
    expect(JSON.parse(textOf(result)).code).toBe("job_not_found")
  })

  it("bridge_cancel posts to the cancel route with the bearer and reports the cancelled job", async () => {
    const { deps, calls } = makeDeps(() => json({ job_id: "j1", status: "failed", error: "cancelled by requester", cancelled: true }))
    const result = await toolsFor(deps).call("bridge_cancel", { job_id: "j1", target: "staging" })
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(textOf(result))).toMatchObject({ job_id: "j1", target: "staging", cancelled: true, status: "failed", error: "cancelled by requester" })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: "http://staging.ts.net:8787/jobs/j1/cancel", method: "POST" })
    expect(new Headers(calls[0]!.headers).get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(textOf(result)).not.toContain(TOKEN)
  })

  it("bridge_cancel reports a stop still in progress (202) without an error", async () => {
    const { deps } = makeDeps(() => json({ job_id: "j1", status: "running", cancelling: true }, 202))
    const result = await toolsFor(deps).call("bridge_cancel", { job_id: "j1", target: "staging" })
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(textOf(result))).toMatchObject({ cancelled: false, cancelling: true, status: "running" })
  })

  it("bridge_cancel maps 403 (not the requester) to forbidden", async () => {
    const { deps } = makeDeps(() => json({ error: "This job was not dispatched by the caller", code: "not_job_requester" }, 403))
    const result = await toolsFor(deps).call("bridge_cancel", { job_id: "j1", target: "staging" })
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result))).toMatchObject({ code: "forbidden" })
  })

  it("bridge_cancel maps 403 (unsigned request) to signature_required with the pairing hint", async () => {
    const { deps } = makeDeps(() => json({ error: "needs a verified node signature", code: "requester_identity_required" }, 403))
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_cancel", { job_id: "j1", target: "staging" })))
    expect(body.code).toBe("signature_required")
    expect(body.hint).toMatch(/aibr enroll/)
  })

  it("bridge_cancel maps 409 for a finished job to job_finished with the status", async () => {
    const { deps } = makeDeps(() =>
      json({ error: "Job has already ended (status completed)", code: "job_finished", status: "completed" }, 409),
    )
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_cancel", { job_id: "j1", target: "staging" })))
    expect(body.code).toBe("job_finished")
    expect(body.hint).toMatch(/status completed/)
  })

  it("bridge_cancel maps 409 for a job awaiting approval to awaiting_approval", async () => {
    const { deps } = makeDeps(() => json({ error: "awaiting operator approval", code: "awaiting_approval", status: "awaiting_approval" }, 409))
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_cancel", { job_id: "j1", target: "staging" })))
    expect(body.code).toBe("awaiting_approval")
  })

  it("bridge_cancel says not_supported when the worker has no cancel route (older aibr)", async () => {
    const { deps } = makeDeps(() => json({ message: "Route POST:/jobs/j1/cancel not found", error: "Not Found", statusCode: 404 }, 404))
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_cancel", { job_id: "j1", target: "staging" })))
    expect(body.code).toBe("not_supported")
  })

  it("bridge_cancel rejects an unknown peer before sending anything", async () => {
    const { deps, calls } = makeDeps(() => json({}))
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_cancel", { job_id: "j1", target: "nope" })))
    expect(body.code).toBe("unknown_peer")
    expect(calls).toHaveLength(0)
  })
})

describe("bridge_events", () => {
  it("reads one page of events and returns the cursor for the next", async () => {
    const events = [
      { seq: 1, at: "t1", type: "status", data: { status: "accepted" } },
      { seq: 2, at: "t2", type: "status", data: { status: "running", from: "accepted" } },
    ]
    const { deps, calls } = makeDeps(() => json({ job_id: "j1", status: "running", final: false, events, next: 2 }))
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_events", { job_id: "j1", target: "staging", after: 0, limit: 50 })))
    expect(body).toMatchObject({ job_id: "j1", target: "staging", status: "running", final: false, next: 2 })
    expect(body.events).toHaveLength(2)
    expect(calls[0]?.url).toBe("http://staging.ts.net:8787/jobs/j1/events?after=0&limit=50")
    expect(new Headers(calls[0]!.headers).get("accept")).toBe("application/json")
  })

  it("caps the page size and marks a finished job final", async () => {
    const { deps, calls } = makeDeps(() => json({ status: "completed", events: [], next: 7 }))
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_events", { job_id: "j1", target: "staging", after: 7, limit: 10_000 })))
    expect(body).toMatchObject({ final: true, next: 7, events: [] })
    expect(calls[0]?.url).toContain("limit=200")
  })

  it("rejects a negative cursor without calling the worker", async () => {
    const { deps, calls } = makeDeps(() => json({}))
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_events", { job_id: "j1", target: "staging", after: -1 })))
    expect(body.code).toBe("invalid_argument")
    expect(calls).toHaveLength(0)
  })

  it("maps 403 and 404 like bridge_cancel", async () => {
    const forbidden = makeDeps(() => json({ error: "not yours", code: "not_job_requester" }, 403))
    expect(JSON.parse(textOf(await toolsFor(forbidden.deps).call("bridge_events", { job_id: "j1", target: "staging" }))).code).toBe("forbidden")
    const missing = makeDeps(() => json({ error: "Job not found" }, 404))
    expect(JSON.parse(textOf(await toolsFor(missing.deps).call("bridge_events", { job_id: "j1", target: "staging" }))).code).toBe("job_not_found")
  })
})

describe("bridge_await", () => {
  it("returns the final result once the job completes", async () => {
    let n = 0
    const { deps } = makeDeps(() => json({ status: ++n < 3 ? "running" : "completed", summary: "ok" }))
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_await", { job_id: "j1", target: "staging", timeout_s: 30 })))
    expect(body).toMatchObject({ status: "completed", still_running: false, summary: "ok" })
    expect(n).toBe(3)
  })

  it("polls every 2s and caps the wait at 120s even if asked for more", async () => {
    const { deps, calls } = makeDeps(() => json({ status: "running" }))
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_await", { job_id: "j1", target: "staging", timeout_s: 9999 })))
    expect(body.still_running).toBe(true)
    expect(body.message).toMatch(/call bridge_await again/i)
    // 120s / 2s poll interval = 60 sleeps => 61 fetches, never more.
    expect(calls.length).toBe(61)
  })

  it("defaults to 60s", async () => {
    const { deps, calls } = makeDeps(() => json({ status: "running" }))
    await toolsFor(deps).call("bridge_await", { job_id: "j1", target: "staging" })
    expect(calls.length).toBe(31)
  })

  it("treats failed as final", async () => {
    const { deps } = makeDeps(() => json({ status: "failed", error: "boom" }))
    const body = JSON.parse(textOf(await toolsFor(deps).call("bridge_await", { job_id: "j1", target: "staging" })))
    expect(body).toMatchObject({ status: "failed", still_running: false, error: "boom" })
  })
})

describe("profile resolution", () => {
  it("uses the only existing profile when none is given", async () => {
    const { deps } = makeDeps(() => json({ ok: true, opencode: true }))
    const body = JSON.parse(textOf(await toolsFor(deps, undefined).call("bridge_peers", {})))
    expect(body.profile).toBe("dev")
  })

  it("treats an empty --profile as unset and honours AIBR_PROFILE", async () => {
    const { deps } = makeDeps(() => json({ ok: true, opencode: true }), { env: { AIBR_PROFILE: "dev" }, profiles: ["a", "b"] })
    const body = JSON.parse(textOf(await new BridgeTools(deps, "").call("bridge_peers", {})))
    expect(body.profile).toBe("dev")
  })

  it("returns a clear error when several profiles exist", async () => {
    const { deps } = makeDeps(() => json({}), {
      profiles: ["dev", "prod"],
      files: { [`${HOME}/.config/aibridge/prod/config.json`]: config() },
    })
    const result = await toolsFor(deps, undefined).call("bridge_peers", {})
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result)).code).toBe("ambiguous_profile")
  })

  it("returns a clear error when no profile exists", async () => {
    const { deps } = makeDeps(() => json({}), { profiles: [] })
    const result = await toolsFor(deps, undefined).call("bridge_peers", {})
    expect(JSON.parse(textOf(result)).code).toBe("no_profile")
  })

  it("reads the bearer token at call time", async () => {
    const { deps, calls, files } = makeDeps(() => json({ status: "running" }))
    const tools = toolsFor(deps)
    await tools.call("bridge_status", { job_id: "j1", target: "staging" })
    files[TOKEN_PATH] = "rotated-token\n"
    await tools.call("bridge_status", { job_id: "j1", target: "staging" })
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(calls[1]?.headers.authorization).toBe("Bearer rotated-token")
  })
})

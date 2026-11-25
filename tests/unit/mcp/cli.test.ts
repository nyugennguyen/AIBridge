import { describe, expect, it } from "vitest"
import { parseProfileArg, runMcpServe, runMcpSummary, type McpCliDeps } from "../../../src/cli/mcp.js"

const HOME = "/home/test"
const config = JSON.stringify({
  agent_id: "dev-main",
  bridge: { host: "127.0.0.1", port: 8787, public_url: "http://dev-main.ts.net:8787" },
  opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096 },
  security: { auth_mode: "bearer-token", allowed_sources: [] },
  permissions: { default_response: "reject", allow_tools: [], require_plan_approval_for_tools: [] },
  projects: [],
  agents: [{ id: "staging", url: "http://staging.ts.net:8787", capabilities: ["investigate"] }],
  timeouts: { default_job_seconds: 900, callback_retry_attempts: 3 },
  planning: { plan_annotator_enabled: false, require_approval_for: [] },
})

function deps(fetchImpl: (url: string) => Response, files: Record<string, string>, input: string[] = []) {
  const out: string[] = []
  const d: McpCliDeps = {
    tools: {
      fetch: async (url) => fetchImpl(url),
      env: { HOME },
      readFile: async (p) => {
        if (files[p] === undefined) throw new Error("ENOENT")
        return files[p]
      },
      listProfileDirs: async () => ["dev"],
      writeFile: async () => {},
      uuid: () => "u",
      now: () => 0,
      sleep: async () => {},
    },
    input: (async function* () {
      yield* input
    })(),
    stdout: (t) => out.push(t),
    stderr: () => {},
  }
  return { d, out: () => out.join("") }
}

const FILES = {
  [`${HOME}/.config/aibridge/dev/config.json`]: config,
  [`${HOME}/.local/share/aibridge/dev/secrets/bearer_token`]: "t0k\n",
  [`${HOME}/.local/state/aibridge/dev/mcp-jobs.json`]: JSON.stringify([
    { job_id: "aaaaaaaa-1", target: "staging", at: "x" },
    { job_id: "bbbbbbbb-2", target: "staging", at: "x" },
  ]),
}

describe("parseProfileArg", () => {
  it("handles value, equals form, empty and absent", () => {
    expect(parseProfileArg(["serve", "--profile", "dev"])).toBe("dev")
    expect(parseProfileArg(["--profile=dev"])).toBe("dev")
    expect(parseProfileArg(["--profile", ""])).toBeUndefined()
    expect(parseProfileArg([])).toBeUndefined()
  })
})

describe("runMcpServe", () => {
  it("serves frames on stdout only and exits 0 at EOF", async () => {
    const { d, out } = deps(() => new Response("{}"), FILES, [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n"])
    expect(await runMcpServe(["--profile", "dev"], d)).toBe(0)
    expect(JSON.parse(out())).toEqual({ jsonrpc: "2.0", id: 1, result: {} })
  })
})

describe("runMcpSummary", () => {
  it("prints at most 5 lines: peers and running jobs", async () => {
    const { d, out } = deps((url) => (url.includes("/jobs/aaaaaaaa") ? new Response(JSON.stringify({ status: "running" })) : url.includes("/jobs/") ? new Response(JSON.stringify({ status: "completed" })) : new Response(JSON.stringify({ ok: true }))), FILES)
    expect(await runMcpSummary(["--profile", "dev"], d)).toBe(0)
    const lines = out().trimEnd().split("\n")
    expect(lines.length).toBeLessThanOrEqual(5)
    expect(lines[0]).toContain("staging up")
    expect(out()).toContain("aaaaaaaa@staging:running")
    expect(out()).not.toContain("bbbbbbbb")
    expect(out()).not.toContain("t0k")
  })

  it("is silent and exits 0 on any error", async () => {
    const { d, out } = deps(() => new Response("{}"), {})
    expect(await runMcpSummary(["--profile", "dev"], d)).toBe(0)
    expect(out()).toBe("")
  })
})

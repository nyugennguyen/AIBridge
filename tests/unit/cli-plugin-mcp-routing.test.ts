import { describe, expect, it } from "vitest"
import { runCli, type CliDeps } from "../../src/cli.js"

/** Only the fields the plugin/mcp branch reads; it returns before any other dep is used. */
function deps(extra: Partial<CliDeps>): { deps: CliDeps; out: () => string } {
  const chunks: string[] = []
  const base = { writer: (s: string) => chunks.push(s), isTTY: false, ...extra }
  return { deps: base as unknown as CliDeps, out: () => chunks.join("") }
}

describe("aibr plugin / aibr mcp routing", () => {
  it("passes plugin argv (incl. its own flags) through untouched", async () => {
    let seen: readonly string[] = []
    const { deps: d } = deps({ runPlugin: async (a) => ((seen = a), 3) })
    const code = await runCli(["plugin", "install", "claude", "--scope", "project", "--marketplace", "github"], d)
    expect(seen).toEqual(["install", "claude", "--scope", "project", "--marketplace", "github"])
    expect(code).toBe(3)
  })

  it("prints command help for `plugin --help` and exits 0", async () => {
    const { deps: d, out } = deps({ runPlugin: async () => 99 })
    expect(await runCli(["plugin", "--help"], d)).toBe(0)
    expect(out()).toContain("aibr plugin install claude")
  })

  it("routes mcp serve/summary with the remaining argv", async () => {
    const calls: Array<[string, readonly string[]]> = []
    const { deps: d } = deps({ runMcp: async (s, a) => (calls.push([s, a]), 0) })
    expect(await runCli(["mcp", "serve", "--profile", "dev"], d)).toBe(0)
    expect(await runCli(["mcp", "summary"], d)).toBe(0)
    expect(calls).toEqual([["serve", ["--profile", "dev"]], ["summary", []]])
  })

  it("rejects an unknown mcp subcommand with a usage exit code", async () => {
    const { deps: d, out } = deps({ runMcp: async () => 0 })
    expect(await runCli(["mcp", "bogus"], d)).toBe(64)
    expect(out()).toContain("expected serve or summary")
  })

  it("lists plugin and mcp in the global help", async () => {
    const { deps: d, out } = deps({})
    await runCli(["--help"], d)
    expect(out()).toMatch(/plugin\s+Install\/remove/)
    expect(out()).toMatch(/mcp\s+MCP server/)
  })
})

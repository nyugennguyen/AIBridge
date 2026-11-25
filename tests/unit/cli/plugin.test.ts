import { describe, expect, it } from "vitest"
import { parsePluginList, runPluginCommand, type PluginCommandDeps } from "../../../src/cli/plugin.js"
import type { ProcessResult, ProcessRunner } from "../../../src/host/types.js"

type Responder = (argv: readonly string[]) => Partial<ProcessResult> | undefined

function harness(responder: Responder, confirm?: (m: string) => Promise<boolean>) {
  const argvs: string[][] = []
  const out: string[] = []
  const err: string[] = []
  const runner: ProcessRunner = {
    exec: async (argv) => {
      argvs.push([...argv])
      const r = responder(argv) ?? {}
      return { exitCode: "exitCode" in r ? (r.exitCode as number) : 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
    },
  }
  const deps: PluginCommandDeps = {
    runner,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    packageRoot: "/pkg/root",
    version: "3.0.0",
    confirm,
  }
  return { deps, argvs, out: () => out.join(""), err: () => err.join("") }
}

const joined = (argvs: string[][]) => argvs.map((a) => a.join(" "))

describe("aibr plugin install claude", () => {
  it("fresh install adds the bundled marketplace then installs", async () => {
    const h = harness(() => ({}))
    const code = await runPluginCommand(["install", "claude", "--scope", "project"], h.deps)
    expect(code).toBe(0)
    expect(joined(h.argvs)).toEqual([
      "claude --version",
      "claude plugin --help",
      "claude plugin marketplace add /pkg/root --scope project",
      "claude plugin install aibridge@aibridge --scope project -y",
    ])
  })

  it("is idempotent: an already-added marketplace is refreshed, not an error", async () => {
    const h = harness((argv) => {
      if (argv.includes("add")) return { exitCode: 1, stderr: "Marketplace 'aibridge' is already added" }
      if (argv.includes("install")) return { exitCode: 1, stderr: "Plugin already installed" }
      return undefined
    })
    const code = await runPluginCommand(["install", "claude"], h.deps)
    expect(code).toBe(0)
    const cmds = joined(h.argvs)
    expect(cmds).toContain("claude plugin marketplace update aibridge")
    expect(cmds).toContain("claude plugin update aibridge@aibridge --scope user")
  })

  it("uses the github marketplace pinned to the CLI version", async () => {
    const h = harness(() => ({}))
    await runPluginCommand(["install", "claude", "--marketplace", "github"], h.deps)
    expect(joined(h.argvs)).toContain("claude plugin marketplace add nyugennguyen/AIBridge#v3.0.0 --scope user")
  })

  it("surfaces a real marketplace-add failure with exit 1", async () => {
    const h = harness((argv) => (argv.includes("add") ? { exitCode: 1, stderr: "disk full" } : undefined))
    expect(await runPluginCommand(["install", "claude"], h.deps)).toBe(1)
    expect(h.err()).toContain("disk full")
  })

  it("missing claude exits 2 with an install hint", async () => {
    const h = harness(() => ({ exitCode: null as unknown as number, stderr: "ENOENT" }))
    expect(await runPluginCommand(["install", "claude"], h.deps)).toBe(2)
    expect(h.err()).toMatch(/Install it first/)
  })

  it("too-old claude exits 3 and prints the manual steps", async () => {
    const h = harness((argv) => (argv[1] === "plugin" ? { exitCode: 1, stderr: "error: unknown command 'plugin'" } : undefined))
    expect(await runPluginCommand(["install", "claude", "--scope", "user"], h.deps)).toBe(3)
    expect(h.err()).toContain("/plugin marketplace add /pkg/root")
    expect(h.err()).toContain("/plugin install aibridge@aibridge")
    expect(joined(h.argvs).some((c) => c.includes("install aibridge"))).toBe(false)
  })

  it("rejects bad scope and unknown targets with a usage exit", async () => {
    const h = harness(() => ({}))
    expect(await runPluginCommand(["install", "claude", "--scope", "galaxy"], h.deps)).toBe(64)
    expect(await runPluginCommand(["install", "codex"], h.deps)).toBe(64)
    expect(h.argvs).toHaveLength(0)
  })

  it("--deny-secrets prints rules only after confirmation and never writes", async () => {
    const yes = harness(() => ({}), async () => true)
    await runPluginCommand(["install", "claude", "--deny-secrets"], yes.deps)
    expect(yes.out()).toContain('"deny"')
    expect(yes.out()).toContain("secrets")

    const no = harness(() => ({}), async () => false)
    await runPluginCommand(["install", "claude", "--deny-secrets"], no.deps)
    expect(no.out()).not.toContain('"deny"')
    // only claude CLI invocations; nothing touches settings files
    expect(joined(yes.argvs).every((c) => c.startsWith("claude "))).toBe(true)
  })
})

describe("aibr plugin status/uninstall claude", () => {
  const LIST = [
    "Installed plugins:",
    "",
    "  ❯ other@somewhere",
    "    Version: 1.0.0",
    "    Scope: user",
    "    Status: ✔ enabled",
    "",
    "  ❯ aibridge@aibridge",
    "    Version: 3.0.0",
    "    Scope: project",
    "    Status: ✔ enabled",
    "",
  ].join("\n")

  it("parses the aibridge block, not its neighbours", () => {
    expect(parsePluginList(LIST)).toEqual({ installed: true, version: "3.0.0", scope: "project", status: "✔ enabled" })
    expect(parsePluginList("Built-in plugins:\n  ❯ x@builtin\n    Status: ✔ enabled")).toEqual({ installed: false })
  })

  it("status prints version, scope and state", async () => {
    const h = harness((argv) => (argv.includes("list") ? { stdout: LIST } : undefined))
    expect(await runPluginCommand(["status", "claude"], h.deps)).toBe(0)
    expect(h.out()).toContain("version 3.0.0")
    expect(h.out()).toContain("scope project")
  })

  it("status reports not installed", async () => {
    const h = harness((argv) => (argv.includes("list") ? { stdout: "nothing" } : undefined))
    expect(await runPluginCommand(["status", "claude"], h.deps)).toBe(0)
    expect(h.out()).toContain("not installed")
  })

  it("uninstall runs the CLI with the scope", async () => {
    const h = harness(() => ({}))
    expect(await runPluginCommand(["uninstall", "claude", "-s", "local"], h.deps)).toBe(0)
    expect(joined(h.argvs)).toContain("claude plugin uninstall aibridge@aibridge --scope local -y")
  })

  it("uninstall of a missing plugin is a no-op success", async () => {
    const h = harness((argv) => (argv.includes("uninstall") ? { exitCode: 1, stderr: "Plugin not installed" } : undefined))
    expect(await runPluginCommand(["uninstall", "claude"], h.deps)).toBe(0)
  })
})

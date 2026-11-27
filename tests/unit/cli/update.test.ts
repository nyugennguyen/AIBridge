import { describe, expect, it } from "vitest"
import { compareSemver, detectInstallMethod, runUpdate } from "../../../src/cli/update.js"
import type { ProcessRunner, Prompter, PromptOptions, PromptResult, SelectOption } from "../../../src/host/types.js"

class TestPrompter implements Prompter {
  private readonly confirmQueue: string[]

  constructor(confirms: string[] = []) {
    this.confirmQueue = [...confirms]
  }

  async promptInput(_message: string): Promise<string> {
    return ""
  }

  async promptSecret(_message: string): Promise<string> {
    return ""
  }

  async promptConfirm(_message: string): Promise<string> {
    const val = this.confirmQueue.shift()
    if (val === undefined) throw new Error("No more confirm responses in TestPrompter")
    return val
  }

  async promptSelect(_message: string, _options: readonly SelectOption[]): Promise<string> {
    return ""
  }

  async prompt(options: PromptOptions): Promise<PromptResult> {
    if (options.kind === "confirm") {
      return { value: await this.promptConfirm(options.message) }
    }
    return { value: "" }
  }
}

function makeFakeProcessRunner(params?: { exitCode?: number; stderr?: string }): {
  runner: ProcessRunner
  calls: string[][]
} {
  const calls: string[][] = []
  const runner: ProcessRunner = {
    async exec(argv) {
      calls.push([...argv])
      return {
        exitCode: params?.exitCode ?? 0,
        stdout: "installed",
        stderr: params?.stderr ?? "",
      }
    },
  }
  return { runner, calls }
}

const BUN_ENTRY = ["/home/u/.bun/bin/bun", "/home/u/.bun/install/global/node_modules/@nyugennguyen/aibridge/dist/cli.js"] as const

/** Install succeeds; the installed aibr then reports `version` for --version. */
function installRunner(version: string): { runner: ProcessRunner; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    runner: {
      async exec(argv) {
        calls.push([...argv])
        if (argv[argv.length - 1] === "--version") return { exitCode: 0, stdout: `${version}\n`, stderr: "" }
        return { exitCode: 0, stdout: "installed", stderr: "" }
      },
    },
  }
}

describe("compareSemver", () => {
  it("returns 0 for identical versions", () => {
    expect(compareSemver("1.0.1", "1.0.1")).toBe(0)
    expect(compareSemver("v1.0.1", "1.0.1")).toBe(0)
  })

  it("returns -1 when current is older than latest", () => {
    expect(compareSemver("1.0.1", "1.0.2")).toBe(-1)
    expect(compareSemver("1.0.1", "1.1.0")).toBe(-1)
    expect(compareSemver("1.0.1", "2.0.0")).toBe(-1)
  })

  it("returns 1 when current is newer than latest", () => {
    expect(compareSemver("1.1.0", "1.0.9")).toBe(1)
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1)
  })
})

describe("runUpdate", () => {
  it("reports when AIBridge is already up to date", async () => {
    const result = await runUpdate(
      {},
      {
        currentVersion: "1.0.1",
        fetchLatestVersion: async () => "1.0.1",
      },
    )

    expect(result.ok).toBe(true)
    expect(result.hasUpdate).toBe(false)
    expect(result.updated).toBe(false)
    expect(result.message).toContain("AIBridge is up to date")
  })

  it("handles registry lookup failure gracefully", async () => {
    const result = await runUpdate(
      {},
      {
        currentVersion: "1.0.1",
        fetchLatestVersion: async () => {
          throw new Error("Network unreachable")
        },
      },
    )

    expect(result.ok).toBe(false)
    expect(result.hasUpdate).toBe(false)
    expect(result.updated).toBe(false)
    expect(result.message).toContain("Failed to check for updates")
    expect(result.message).toContain("Network unreachable")
  })

  it("checks only without installing when --check flag is passed", async () => {
    const { runner, calls } = makeFakeProcessRunner()
    const result = await runUpdate(
      { checkOnly: true },
      {
        currentVersion: "1.0.1",
        fetchLatestVersion: async () => "1.1.0",
        processRunner: runner,
      },
    )

    expect(result.ok).toBe(true)
    expect(result.hasUpdate).toBe(true)
    expect(result.updated).toBe(false)
    expect(result.message).toContain("Update available: v1.0.1 -> v1.1.0")
    expect(result.message).toContain('Run "aibr update"')
    expect(calls).toHaveLength(0) // Did not run install
  })

  it("rejects non-interactive update without --yes flag", async () => {
    const { runner, calls } = makeFakeProcessRunner()
    const result = await runUpdate(
      {},
      {
        currentVersion: "1.0.1",
        fetchLatestVersion: async () => "1.1.0",
        processRunner: runner,
        isTTY: false,
        entry: BUN_ENTRY,
      },
    )

    expect(result.ok).toBe(false)
    expect(result.hasUpdate).toBe(true)
    expect(result.updated).toBe(false)
    expect(result.message).toContain("pass --yes")
    expect(calls).toHaveLength(0)
  })

  it("cancels update when user declines confirmation", async () => {
    const { runner, calls } = makeFakeProcessRunner()
    const prompter = new TestPrompter(["n"])
    const result = await runUpdate(
      {},
      {
        currentVersion: "1.0.1",
        fetchLatestVersion: async () => "1.1.0",
        processRunner: runner,
        prompter,
        isTTY: true,
        entry: BUN_ENTRY,
      },
    )

    expect(result.ok).toBe(true)
    expect(result.hasUpdate).toBe(true)
    expect(result.updated).toBe(false)
    expect(result.message).toContain("Update cancelled.")
    expect(calls).toHaveLength(0)
  })

  it("installs with the running bun, confirms the version, and restarts running bridges", async () => {
    const { runner, calls } = installRunner("1.1.0")
    const prompter = new TestPrompter(["y"])
    const restarted: (readonly string[])[] = []
    const result = await runUpdate(
      {},
      {
        currentVersion: "1.0.1",
        fetchLatestVersion: async () => "1.1.0",
        processRunner: runner,
        prompter,
        isTTY: true,
        entry: BUN_ENTRY,
        restartBridges: async (entry) => {
          restarted.push(entry)
          return [
            { profile: "default", runner: "systemd", result: "restarted" },
            { profile: "dev", runner: "tmux", result: "manual" },
          ]
        },
      },
    )

    expect(result).toMatchObject({ ok: true, hasUpdate: true, updated: true })
    expect(calls[0]).toEqual(["/home/u/.bun/bin/bun", "install", "-g", "@nyugennguyen/aibridge@1.1.0"])
    expect(calls[1]).toEqual([...BUN_ENTRY, "--version"])
    expect(restarted).toEqual([BUN_ENTRY])
    expect(result.message).toContain("Updated AIBridge v1.0.1 -> v1.1.0 (bun install)")
    expect(result.message).toContain('Restarted the systemd service of profile "default"')
    expect(result.message).toContain("aibr stop --profile dev && aibr start --foreground --profile dev")
  })

  it("installs without a prompt with --yes, and --no-restart leaves bridges alone", async () => {
    const { runner, calls } = installRunner("1.2.0")
    let restartCalled = false
    const result = await runUpdate(
      { yes: true, noRestart: true },
      {
        currentVersion: "1.0.1",
        fetchLatestVersion: async () => "1.2.0",
        processRunner: runner,
        isTTY: false,
        entry: BUN_ENTRY,
        restartBridges: async () => {
          restartCalled = true
          return []
        },
      },
    )

    expect(result).toMatchObject({ ok: true, updated: true })
    expect(calls).toHaveLength(2)
    expect(restartCalled).toBe(false)
    expect(result.message).toContain("--no-restart")
  })

  it("uses npm for an npm global install", async () => {
    const { runner, calls } = installRunner("1.2.0")
    const entry = ["/usr/bin/bun", "/usr/lib/node_modules/@nyugennguyen/aibridge/dist/cli.js"]
    const result = await runUpdate({ yes: true }, { currentVersion: "1.0.1", fetchLatestVersion: async () => "1.2.0", processRunner: runner, entry, restartBridges: async () => [] })
    expect(result.ok).toBe(true)
    expect(calls[0]).toEqual(["npm", "install", "-g", "@nyugennguyen/aibridge@1.2.0"])
  })

  it("refuses to update a source checkout", async () => {
    const { runner, calls } = installRunner("1.2.0")
    const entry = ["/usr/bin/bun", "/work/AIBridge/src/cli.ts"]
    const result = await runUpdate({ yes: true }, { currentVersion: "1.0.1", fetchLatestVersion: async () => "1.2.0", processRunner: runner, entry })
    expect(result).toMatchObject({ ok: false, updated: false })
    expect(result.message).toContain("runs from /work/AIBridge/src/cli.ts")
    expect(calls).toHaveLength(0)
  })

  it("fails when the new aibr still reports the old version, and restarts nothing", async () => {
    const { runner } = installRunner("1.0.1")
    let restartCalled = false
    const result = await runUpdate(
      { yes: true },
      {
        currentVersion: "1.0.1",
        fetchLatestVersion: async () => "1.2.0",
        processRunner: runner,
        entry: BUN_ENTRY,
        restartBridges: async () => {
          restartCalled = true
          return []
        },
      },
    )
    expect(result).toMatchObject({ ok: false, updated: false })
    expect(result.message).toContain("still reports v1.0.1")
    expect(restartCalled).toBe(false)
  })

  it("fails the update when a bridge could not be restarted", async () => {
    const { runner } = installRunner("1.2.0")
    const result = await runUpdate(
      { yes: true },
      {
        currentVersion: "1.0.1",
        fetchLatestVersion: async () => "1.2.0",
        processRunner: runner,
        entry: BUN_ENTRY,
        restartBridges: async () => [{ profile: "default", runner: "systemd", result: "failed", detail: "port in use" }],
      },
    )
    expect(result).toMatchObject({ ok: false, updated: true })
    expect(result.message).toContain('Could not restart profile "default" (systemd): port in use. Run: aibr start --profile default')
  })

  it("handles installation error gracefully", async () => {
    const { runner, calls } = makeFakeProcessRunner({ exitCode: 1, stderr: "EACCES permission denied" })
    const result = await runUpdate(
      { yes: true },
      {
        currentVersion: "1.0.1",
        fetchLatestVersion: async () => "1.2.0",
        processRunner: runner,
        entry: BUN_ENTRY,
      },
    )

    expect(result.ok).toBe(false)
    expect(result.hasUpdate).toBe(true)
    expect(result.updated).toBe(false)
    expect(result.message).toContain("Update failed")
    expect(result.message).toContain("EACCES permission denied")
    expect(result.message).toContain("Nothing was restarted")
    expect(calls).toHaveLength(1)
  })

  it("asks for --yes when there is no prompter", async () => {
    const { runner, calls } = installRunner("1.2.0")
    const result = await runUpdate({}, { currentVersion: "1.0.1", fetchLatestVersion: async () => "1.2.0", processRunner: runner, entry: BUN_ENTRY })
    expect(result.message).toContain("aibr update --yes")
    expect(calls).toHaveLength(0)
  })
})

describe("detectInstallMethod", () => {
  it("tells bun, npm and a source checkout apart", () => {
    expect(detectInstallMethod(BUN_ENTRY).kind).toBe("bun")
    expect(detectInstallMethod(["/usr/bin/bun", "/usr/local/lib/node_modules/@nyugennguyen/aibridge/dist/cli.js"]).kind).toBe("npm")
    expect(detectInstallMethod(["/usr/bin/bun", "/repo/src/cli.ts"]).kind).toBe("source")
  })
})

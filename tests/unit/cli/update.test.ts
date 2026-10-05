import { describe, expect, it } from "vitest"
import { compareSemver, runUpdate } from "../../../src/cli/update.js"
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
      },
    )

    expect(result.ok).toBe(true)
    expect(result.hasUpdate).toBe(true)
    expect(result.updated).toBe(false)
    expect(result.message).toContain("Update cancelled.")
    expect(calls).toHaveLength(0)
  })

  it("installs update when user confirms in interactive prompt", async () => {
    const { runner, calls } = makeFakeProcessRunner()
    const prompter = new TestPrompter(["y"])
    const result = await runUpdate(
      {},
      {
        currentVersion: "1.0.1",
        fetchLatestVersion: async () => "1.1.0",
        processRunner: runner,
        prompter,
        isTTY: true,
      },
    )

    expect(result.ok).toBe(true)
    expect(result.hasUpdate).toBe(true)
    expect(result.updated).toBe(true)
    expect(result.message).toContain("Successfully updated AIBridge from v1.0.1 to v1.1.0!")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(["bun", "install", "-g", "@nyugennguyen/aibridge@1.1.0"])
  })

  it("installs update automatically when --yes flag is passed", async () => {
    const { runner, calls } = makeFakeProcessRunner()
    const result = await runUpdate(
      { yes: true },
      {
        currentVersion: "1.0.1",
        fetchLatestVersion: async () => "1.2.0",
        processRunner: runner,
        isTTY: false,
      },
    )

    expect(result.ok).toBe(true)
    expect(result.hasUpdate).toBe(true)
    expect(result.updated).toBe(true)
    expect(result.message).toContain("Successfully updated AIBridge from v1.0.1 to v1.2.0!")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(["bun", "install", "-g", "@nyugennguyen/aibridge@1.2.0"])
  })

  it("handles installation error gracefully", async () => {
    const { runner, calls } = makeFakeProcessRunner({ exitCode: 1, stderr: "EACCES permission denied" })
    const result = await runUpdate(
      { yes: true },
      {
        currentVersion: "1.0.1",
        fetchLatestVersion: async () => "1.2.0",
        processRunner: runner,
      },
    )

    expect(result.ok).toBe(false)
    expect(result.hasUpdate).toBe(true)
    expect(result.updated).toBe(false)
    expect(result.message).toContain("Update failed: EACCES permission denied")
    expect(calls).toHaveLength(1)
  })
})

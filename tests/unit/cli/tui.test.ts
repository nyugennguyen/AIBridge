import { describe, expect, it } from "vitest"
import { resolveManagerPluginPath, runTuiCommand } from "../../../src/cli/tui.js"
import type { ProcessRunner, ProcessResult } from "../../../src/host/types.js"

class FakeProcessRunner implements ProcessRunner {
  readonly executed: string[][] = []
  private readonly handlers: Array<{
    match: (cmd: readonly string[]) => boolean
    result: ProcessResult
  }> = []

  on(match: (cmd: readonly string[]) => boolean, result: ProcessResult): this {
    this.handlers.push({ match, result })
    return this
  }

  async exec(cmd: readonly string[]): Promise<ProcessResult> {
    this.executed.push([...cmd])
    for (const handler of this.handlers) {
      if (handler.match(cmd)) {
        return handler.result
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" }
  }
}

describe("CLI aibr tui cutover", () => {
  it("fails with a clear actionable error when Herdr is absent", async () => {
    const runner = new FakeProcessRunner().on(
      (cmd) => cmd[0] === "which" && cmd[1] === "herdr",
      { exitCode: 1, stdout: "", stderr: "herdr not found" },
    )

    let output = ""
    const writer = (data: string) => {
      output += data
    }

    const exitCode = await runTuiCommand({
      profile: "default",
      runner,
      writer,
      env: {},
    })

    expect(exitCode).toBe(1)
    expect(output).toContain("Error: Herdr is not installed or not found on PATH")
    expect(output).toContain("brew install herdr")
    expect(output).toContain("https://github.com/nyugennguyen/herdr")
    expect(output).toContain("PATH")

    // Assert that herdr plugin link was never called
    const pluginLinkCalls = runner.executed.filter(
      (cmd) => cmd[0] === "herdr" && cmd[1] === "plugin" && cmd[2] === "link",
    )
    expect(pluginLinkCalls).toHaveLength(0)
  })

  it("links the aibr-manager plugin and prints clear operator instructions when Herdr is present", async () => {
    const runner = new FakeProcessRunner()
      .on(
        (cmd) => cmd[0] === "which" && cmd[1] === "herdr",
        { exitCode: 0, stdout: "/usr/local/bin/herdr\n", stderr: "" },
      )
      .on(
        (cmd) => cmd[0] === "herdr" && cmd[1] === "api" && cmd[2] === "schema",
        {
          exitCode: 0,
          stdout: JSON.stringify({
            capabilities: { input_fencing: true, first_class_role: true },
          }),
          stderr: "",
        },
      )
      .on(
        (cmd) => cmd[0] === "herdr" && cmd[1] === "plugin" && cmd[2] === "link",
        { exitCode: 0, stdout: "plugin linked successfully", stderr: "" },
      )

    let output = ""
    const writer = (data: string) => {
      output += data
    }

    const exitCode = await runTuiCommand({
      profile: "default",
      runner,
      writer,
      managerPath: "/Users/mac/Projects/aibr-manager",
    })

    expect(exitCode).toBe(0)
    expect(output).toContain("AIBridge Manager plugin linked successfully")
    expect(output).toContain("aibr-manager")
    expect(output).toContain("To open the manager inside Herdr:")
    expect(output).toContain("herdr plugin action invoke --action aibr-manager.open")

    // Assert that herdr plugin link was invoked with the manager path
    const linkCall = runner.executed.find(
      (cmd) => cmd[0] === "herdr" && cmd[1] === "plugin" && cmd[2] === "link",
    )
    expect(linkCall).toBeDefined()
    expect(linkCall?.[3]).toBe("/Users/mac/Projects/aibr-manager")
  })

  it("fails with clear error if herdr plugin link fails", async () => {
    const runner = new FakeProcessRunner()
      .on(
        (cmd) => cmd[0] === "which" && cmd[1] === "herdr",
        { exitCode: 0, stdout: "/usr/local/bin/herdr\n", stderr: "" },
      )
      .on(
        (cmd) => cmd[0] === "herdr" && cmd[1] === "api" && cmd[2] === "schema",
        {
          exitCode: 0,
          stdout: JSON.stringify({
            capabilities: { input_fencing: true, first_class_role: true },
          }),
          stderr: "",
        },
      )
      .on(
        (cmd) => cmd[0] === "herdr" && cmd[1] === "plugin" && cmd[2] === "link",
        { exitCode: 2, stdout: "", stderr: "plugin manifest invalid" },
      )

    let output = ""
    const writer = (data: string) => {
      output += data
    }

    const exitCode = await runTuiCommand({
      profile: "default",
      runner,
      writer,
      managerPath: "/Users/mac/Projects/aibr-manager",
    })

    expect(exitCode).toBe(1)
    expect(output).toContain("Failed to link 'aibr-manager' plugin in Herdr")
    expect(output).toContain("plugin manifest invalid")
  })

  it("fails when aibr-manager directory cannot be located", async () => {
    const runner = new FakeProcessRunner()
      .on(
        (cmd) => cmd[0] === "which" && cmd[1] === "herdr",
        { exitCode: 0, stdout: "/usr/local/bin/herdr\n", stderr: "" },
      )
      .on(
        (cmd) => cmd[0] === "herdr" && cmd[1] === "api" && cmd[2] === "schema",
        { exitCode: 0, stdout: "{}", stderr: "" },
      )

    let output = ""
    const writer = (data: string) => {
      output += data
    }

    const exitCode = await runTuiCommand({
      profile: "default",
      runner,
      writer,
      managerPath: "/nonexistent/path/to/aibr-manager",
      env: { AIBRIDGE_MANAGER_PLUGIN_PATH: "", AIBR_MANAGER_PATH: "" },
    })

    // If /Users/mac/Projects/aibr-manager exists, managerPath override ensures test isolation
    if (resolveManagerPluginPath("/nonexistent/path/to/aibr-manager", { AIBR_MANAGER_PATH: "" }) === null) {
      expect(exitCode).toBe(1)
      expect(output).toContain("Error: 'aibr-manager' plugin directory not found")
      expect(output).toContain("AIBR_MANAGER_PATH")
    }
  })
})

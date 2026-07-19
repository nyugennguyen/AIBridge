import { describe, expect, it } from "vitest"
import type {
  PlatformInfo,
  ProcessOptions,
  ProcessResult,
  ProcessRunner,
} from "../../../src/host/types.js"
import {
  FakePlatformInspector,
  FakePrompter,
} from "./fixtures.js"
import {
  runPreflight,
  planPreflight,
  checkTailscaleStatus,
  type PreflightCheck,
} from "../../../src/host/preflight.js"

// ── SequenceProcessRunner ──────────────────────────────────────────────

/**
 * Test-only ProcessRunner that supports per-call result overrides via an
 * argv→result map, plus a fallback function for dynamic behavior.
 */
class SequenceProcessRunner implements ProcessRunner {
  public calls: Array<{ argv: readonly string[]; options?: ProcessOptions }> = []
  private readonly resultMap: Map<string, ProcessResult>
  private readonly fallback?: (argv: readonly string[]) => ProcessResult

  constructor(
    resultMap: Map<string, ProcessResult>,
    fallback?: (argv: readonly string[]) => ProcessResult,
  ) {
    this.resultMap = resultMap
    this.fallback = fallback
  }

  async exec(argv: readonly string[], options?: ProcessOptions): Promise<ProcessResult> {
    this.calls.push({ argv, options })
    const key = argv.join(" ")
    const mapped = this.resultMap.get(key) ?? (key === "tailscale status --json" ? this.resultMap.get("tailscale status") : undefined)
    if (mapped !== undefined) return mapped
    if (this.fallback !== undefined) return this.fallback(argv)
    return { exitCode: 1, stdout: "", stderr: "unmapped command" }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function successResult(stdout = ""): ProcessResult {
  return { exitCode: 0, stdout, stderr: "" }
}

function failureResult(stderr = "not found"): ProcessResult {
  return { exitCode: 1, stdout: "", stderr }
}

function macInfo(overrides?: Partial<PlatformInfo>): PlatformInfo {
  return { platform: "darwin", arch: "arm64", isTTY: true, ...overrides }
}

function ubuntuInfo(overrides?: Partial<PlatformInfo>): PlatformInfo {
  return { platform: "linux", arch: "x64", isTTY: true, ...overrides }
}

function debianInfo(overrides?: Partial<PlatformInfo>): PlatformInfo {
  return { platform: "linux", arch: "x64", isTTY: true, ...overrides }
}

const TAILSCALE_STATUS_OUTPUT = [
  "100.64.0.1  my-machine user@  linux   active; relay \"lax\", tx 0 rx 0",
  "100.64.0.2  peer-one   user@  linux   active; direct 192.168.1.10:41641, tx 100 rx 200",
  "",
  "HealthStatus: healthy",
  "BackendState: Running",
  "tailnet-lock: not enabled",
].join("\n")

/**
 * Helper to build a Map from entries with multi-word keys.
 */
function resultMap(...entries: Array<[string, ProcessResult]>): Map<string, ProcessResult> {
  return new Map<string, ProcessResult>(entries)
}

// ── planPreflight ──────────────────────────────────────────────────────

describe("planPreflight", () => {
  describe("platform support", () => {
    it("returns ok=false for unsupported Windows platform", async () => {
      const inspector = new FakePlatformInspector({
        platform: "win32", arch: "x64", isTTY: true,
      })
      const runner = new SequenceProcessRunner(resultMap())

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      expect(result.ok).toBe(false)
      expect(result.checks).toEqual([])
      expect(result.tailscale.error).toBe("Unsupported platform: win32")
    })

    it("returns ok=false for unknown platform", async () => {
      const inspector = new FakePlatformInspector({
        platform: "freebsd", arch: "x64", isTTY: true,
      })
      const runner = new SequenceProcessRunner(resultMap())

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      expect(result.ok).toBe(false)
      expect(result.checks).toEqual([])
      expect(result.tailscale.error).toContain("Unsupported platform")
    })

    it("accepts macOS (darwin) as supported", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult("/opt/homebrew/bin/tmux")],
        ["which opencode", successResult("/usr/local/bin/opencode")],
        ["which tailscale", successResult("/usr/local/bin/tailscale")],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      expect(result.ok).toBe(true)
    })

    it("accepts Ubuntu as supported", async () => {
      const inspector = new FakePlatformInspector(ubuntuInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult("/usr/bin/tmux")],
        ["which opencode", successResult("/usr/bin/opencode")],
        ["which tailscale", successResult("/usr/bin/tailscale")],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      expect(result.ok).toBe(true)
    })

    it("accepts Debian as supported", async () => {
      const inspector = new FakePlatformInspector(debianInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult("/usr/bin/tmux")],
        ["which opencode", successResult("/usr/bin/opencode")],
        ["which tailscale", successResult("/usr/bin/tailscale")],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      expect(result.ok).toBe(true)
    })
  })

  describe("all installed", () => {
    it("returns ok=true when all prereqs present (macOS)", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult("/opt/homebrew/bin/tmux")],
        ["which opencode", successResult("/usr/local/bin/opencode")],
        ["which tailscale", successResult("/usr/local/bin/tailscale")],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      expect(result.ok).toBe(true)
      expect(result.checks).toHaveLength(3)
      for (const check of result.checks) {
        expect(check.status).toBe("installed")
        expect(check.installCmd).toBeNull()
      }
    })

    it("does not call prompter when all installed", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult("/opt/homebrew/bin/tmux")],
        ["which opencode", successResult("/usr/local/bin/opencode")],
        ["which tailscale", successResult("/usr/local/bin/tailscale")],
      ))
      const prompter = new FakePrompter({ confirmValue: "y" })

      await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      expect(prompter.confirmCalls).toHaveLength(0)
    })

    it("returns ok=true when all prereqs present (Ubuntu/Debian)", async () => {
      const inspector = new FakePlatformInspector(ubuntuInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult("/usr/bin/tmux")],
        ["which opencode", successResult("/usr/bin/opencode")],
        ["which tailscale", successResult("/usr/bin/tailscale")],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      expect(result.ok).toBe(true)
      for (const check of result.checks) {
        expect(check.status).toBe("installed")
      }
    })
  })

  describe("missing prereqs", () => {
    it("marks tmux as missing with correct macOS install plan", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", successResult("/usr/local/bin/opencode")],
        ["which tailscale", successResult("/usr/local/bin/tailscale")],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      const tmux = result.checks.find((c: PreflightCheck) => c.name === "tmux")!
      expect(tmux.status).toBe("missing")
      expect(tmux.installCmd).toEqual(["brew", "install", "tmux"])
    })

    it("marks tmux as missing with correct Ubuntu/Debian install plan", async () => {
      const inspector = new FakePlatformInspector(ubuntuInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", successResult("/usr/bin/opencode")],
        ["which tailscale", successResult("/usr/bin/tailscale")],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      const tmux = result.checks.find((c: PreflightCheck) => c.name === "tmux")!
      expect(tmux.status).toBe("missing")
      expect(tmux.installCmd).toEqual(["apt-get", "install", "-y", "tmux"])
    })

    it("marks tailscale as missing with correct macOS install plan", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult("/opt/homebrew/bin/tmux")],
        ["which opencode", successResult("/usr/local/bin/opencode")],
        ["which tailscale", failureResult()],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      const ts = result.checks.find((c: PreflightCheck) => c.name === "tailscale")!
      expect(ts.status).toBe("missing")
      expect(ts.installCmd).toEqual(["brew", "install", "tailscale"])
    })

    it("marks tailscale as missing with correct Ubuntu/Debian install plan", async () => {
      const inspector = new FakePlatformInspector(ubuntuInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult("/usr/bin/tmux")],
        ["which opencode", successResult("/usr/bin/opencode")],
        ["which tailscale", failureResult()],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      const ts = result.checks.find((c: PreflightCheck) => c.name === "tailscale")!
      expect(ts.status).toBe("missing")
      expect(ts.installCmd).toEqual([
        "tailscale", "install-from-source",
        "--confirm",
        "--prefix=/usr/local",
      ])
    })

    it("returns ok=false when any prereq missing", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", successResult()],
        ["which tailscale", successResult()],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      expect(result.ok).toBe(false)
    })

    it("sets missing prereq count in result", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", failureResult()],
        ["which tailscale", successResult()],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      expect(result.missing).toBe(2)
    })

    it("returns install plan for multiple missing tools", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", failureResult()],
        ["which tailscale", failureResult()],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      expect(result.missing).toBe(3)
      // tmux and tailscale have install commands; opencode does not
      const installCmds = result.checks
        .filter((c: PreflightCheck) => c.installCmd !== null)
        .map((c: PreflightCheck) => c.installCmd)
      expect(installCmds).toHaveLength(2)
    })

    it("never suggests install for supported platform where no command known", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult()],
        ["which opencode", failureResult()],
        ["which tailscale", successResult()],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      const oc = result.checks.find((c: PreflightCheck) => c.name === "opencode")!
      expect(oc.status).toBe("missing")
      expect(oc.installCmd).toBeNull()
    })
  })

  describe("install commands are fixed argv", () => {
    it("all install commands are arrays of strings (never shell commands)", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", failureResult()],
        ["which tailscale", failureResult()],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      for (const check of result.checks) {
        if (check.installCmd !== null) {
          expect(Array.isArray(check.installCmd)).toBe(true)
          for (const arg of check.installCmd) {
            expect(typeof arg).toBe("string")
          }
          for (const arg of check.installCmd) {
            expect(arg).not.toMatch(/[|;&`$]/)
          }
        }
      }
    })

    it("macOS install commands use brew", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", failureResult()],
        ["which tailscale", failureResult()],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      const tmux = result.checks.find((c: PreflightCheck) => c.name === "tmux")!
      const ts = result.checks.find((c: PreflightCheck) => c.name === "tailscale")!
      expect(tmux.installCmd![0]).toBe("brew")
      expect(ts.installCmd![0]).toBe("brew")
    })

    it("Debian/Ubuntu install commands use apt-get or tailscale", async () => {
      const inspector = new FakePlatformInspector(ubuntuInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", failureResult()],
        ["which tailscale", failureResult()],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      const tmux = result.checks.find((c: PreflightCheck) => c.name === "tmux")!
      const ts = result.checks.find((c: PreflightCheck) => c.name === "tailscale")!
      expect(tmux.installCmd![0]).toBe("apt-get")
      expect(ts.installCmd![0]).toBe("tailscale")
    })

    it("never contains curl pipe patterns", async () => {
      const inspector = new FakePlatformInspector(ubuntuInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", failureResult()],
        ["which tailscale", failureResult()],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      for (const check of result.checks) {
        if (check.installCmd !== null) {
          const joined = check.installCmd.join(" ")
          expect(joined).not.toContain("curl")
          expect(joined).not.toContain("|")
          expect(joined).not.toContain("sh")
          expect(joined).not.toContain("bash")
        }
      }
    })
  })

  describe("which command uses fixed argv", () => {
    it("calls which as fixed argv, never shell command", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult()],
        ["which opencode", successResult()],
        ["which tailscale", successResult()],
        ["tailscale status", successResult("")],
      ))

      await planPreflight({ platformInspector: inspector, processRunner: runner })

      const whichCalls = runner.calls.filter((c) => c.argv[0] === "which")
      expect(whichCalls).toHaveLength(3)
      for (const call of whichCalls) {
        expect(call.argv).toHaveLength(2)
      }
    })
  })

  describe("result structure", () => {
    it("includes platform in result", async () => {
      const inspector = new FakePlatformInspector(macInfo({ arch: "arm64" }))
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult()],
        ["which opencode", successResult()],
        ["which tailscale", successResult()],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      expect(result.platform).toBe("darwin")
    })

    it("includes tailscale facts object in result", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult()],
        ["which opencode", successResult()],
        ["which tailscale", successResult()],
        ["tailscale status", successResult(TAILSCALE_STATUS_OUTPUT)],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      expect(result.tailscale).toBeDefined()
      expect(typeof result.tailscale).toBe("object")
    })

    it("check count always equals 3 (tmux, opencode, tailscale)", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult()],
        ["which opencode", successResult()],
        ["which tailscale", successResult()],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      expect(result.checks).toHaveLength(3)
      expect(result.checks.map((c: PreflightCheck) => c.name).sort()).toEqual(["opencode", "tailscale", "tmux"])
    })
  })
})

// ── runPreflight ───────────────────────────────────────────────────────

describe("runPreflight", () => {
  describe("confirmation flow", () => {
    it("prompts user to confirm before each install", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", failureResult()],
        ["which tailscale", failureResult()],
        ["brew install tmux", successResult()],
        ["brew install tailscale", successResult()],
      ))
      const prompter = new FakePrompter({ confirmValue: "y" })

      await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      expect(prompter.confirmCalls).toHaveLength(2)
      expect(prompter.confirmCalls[0]).toContain("tmux")
      expect(prompter.confirmCalls[0]).toContain("brew install tmux")
      expect(prompter.confirmCalls[1]).toContain("tailscale")
    })

    it("shows the exact command to be executed in the prompt", async () => {
      const inspector = new FakePlatformInspector(ubuntuInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", successResult()],
        ["which tailscale", successResult()],
        ["apt-get install -y tmux", successResult()],
      ))
      const prompter = new FakePrompter({ confirmValue: "y" })

      await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      expect(prompter.confirmCalls[0]).toContain("apt-get install -y tmux")
    })

    it("executes install when user confirms (y)", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", successResult()],
        ["which tailscale", successResult()],
        ["brew install tmux", successResult()],
      ))
      const prompter = new FakePrompter({ confirmValue: "y" })

      await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      const installCall = runner.calls.find((c) => c.argv[0] === "brew")
      expect(installCall).toBeDefined()
      expect(installCall!.argv).toEqual(["brew", "install", "tmux"])
    })

    it("skips install when user declines (n)", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", successResult()],
        ["which tailscale", successResult()],
      ))
      const prompter = new FakePrompter({ confirmValue: "n" })

      const result = await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      const tmux = result.checks.find((c: PreflightCheck) => c.name === "tmux")!
      expect(tmux.status).toBe("declined")
      const installCalls = runner.calls.filter((c) => c.argv[0] === "brew")
      expect(installCalls).toHaveLength(0)
    })

    it("marks declined prereq as declined, not missing", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", failureResult()],
        ["which tailscale", failureResult()],
      ))
      const prompter = new FakePrompter({ confirmValue: "n" })

      const result = await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      // tmux and tailscale have install cmds → declined; opencode has none → stays missing
      expect(result.checks.filter((c: PreflightCheck) => c.status === "declined")).toHaveLength(2)
      expect(result.checks.filter((c: PreflightCheck) => c.status === "missing")).toHaveLength(1)
      expect(result.ok).toBe(false)
    })

    it("only prompts for tools that have install commands", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult()],
        ["which opencode", failureResult()],
        ["which tailscale", successResult()],
      ))
      const prompter = new FakePrompter({ confirmValue: "y" })

      await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      expect(prompter.confirmCalls).toHaveLength(0)
    })
  })

  describe("install success", () => {
    it("marks prereq as installed after successful install", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", successResult()],
        ["which tailscale", successResult()],
        ["brew install tmux", successResult()],
      ))
      const prompter = new FakePrompter({ confirmValue: "y" })

      const result = await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      const tmux = result.checks.find((c: PreflightCheck) => c.name === "tmux")!
      expect(tmux.status).toBe("installed")
    })

    it("returns ok=true after all missing prereqs installed successfully", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", successResult()],
        ["which tailscale", failureResult()],
        ["brew install tmux", successResult()],
        ["brew install tailscale", successResult()],
      ))
      const prompter = new FakePrompter({ confirmValue: "y" })

      const result = await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      expect(result.ok).toBe(true)
    })
  })

  describe("install failure", () => {
    it("marks prereq as failed when install exits nonzero", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", successResult()],
        ["which tailscale", successResult()],
        ["brew install tmux", failureResult("Error: tmux not found")],
      ))
      const prompter = new FakePrompter({ confirmValue: "y" })

      const result = await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      const tmux = result.checks.find((c: PreflightCheck) => c.name === "tmux")!
      expect(tmux.status).toBe("failed")
      expect(tmux.error).toContain("tmux not found")
    })

    it("returns ok=false when install fails", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", successResult()],
        ["which tailscale", successResult()],
        ["brew install tmux", failureResult()],
      ))
      const prompter = new FakePrompter({ confirmValue: "y" })

      const result = await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      expect(result.ok).toBe(false)
    })

    it("captures stderr from failed install in error field", async () => {
      const stderrMsg = "Error: No available formula for tmux."
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", successResult()],
        ["which tailscale", successResult()],
        ["brew install tmux", failureResult(stderrMsg)],
      ))
      const prompter = new FakePrompter({ confirmValue: "y" })

      const result = await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      const tmux = result.checks.find((c: PreflightCheck) => c.name === "tmux")!
      expect(tmux.error).toBe(stderrMsg)
    })

    it("reports null exitCode gracefully", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(
        resultMap(
          ["which tmux", failureResult()],
          ["which opencode", successResult()],
          ["which tailscale", successResult()],
        ),
        () => ({ exitCode: null, stdout: "", stderr: "killed by signal" }),
      )
      const prompter = new FakePrompter({ confirmValue: "y" })

      const result = await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      const tmux = result.checks.find((c: PreflightCheck) => c.name === "tmux")!
      expect(tmux.status).toBe("failed")
      expect(tmux.error).toBe("killed by signal")
    })
  })

  describe("partial decline", () => {
    it("installs confirmed tools, marks declined ones separately", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", successResult()],
        ["which tailscale", failureResult()],
        ["brew install tailscale", successResult()],
      ))
      const prompter = new FakePrompter({ confirmValue: "y" })
      prompter.promptConfirm = async (msg: string): Promise<string> => {
        prompter.confirmCalls.push(msg)
        return msg.includes("tmux") ? "n" : "y"
      }

      const result = await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      const tmux = result.checks.find((c: PreflightCheck) => c.name === "tmux")!
      const ts = result.checks.find((c: PreflightCheck) => c.name === "tailscale")!
      expect(tmux.status).toBe("declined")
      expect(ts.status).toBe("installed")
    })
  })

  describe("safety constraints", () => {
    it("never installs Bun", async () => {
      const inspector = new FakePlatformInspector(ubuntuInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", failureResult()],
        ["which opencode", failureResult()],
        ["which tailscale", failureResult()],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      for (const check of result.checks) {
        if (check.installCmd !== null) {
          expect(check.installCmd).not.toContain("bun")
          const joined = check.installCmd.join(" ").toLowerCase()
          expect(joined).not.toContain("bun")
        }
      }
    })

    it("never binds public addresses", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult()],
        ["which opencode", successResult()],
        ["which tailscale", successResult()],
      ))

      const result = await planPreflight({ platformInspector: inspector, processRunner: runner })

      const resultStr = JSON.stringify(result)
      expect(resultStr).not.toContain("0.0.0.0")
      expect(resultStr).not.toContain("::")
    })

    it("does not run installs when unsupported platform", async () => {
      const inspector = new FakePlatformInspector({
        platform: "win32", arch: "x64", isTTY: true,
      })
      const runner = new SequenceProcessRunner(resultMap())
      const prompter = new FakePrompter({ confirmValue: "y" })

      const result = await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      expect(result.ok).toBe(false)
      expect(runner.calls).toHaveLength(0)
      expect(prompter.confirmCalls).toHaveLength(0)
    })

    it("returns empty checks for unsupported platform", async () => {
      const inspector = new FakePlatformInspector({
        platform: "win32", arch: "x64", isTTY: true,
      })
      const runner = new SequenceProcessRunner(resultMap())
      const prompter = new FakePrompter({ confirmValue: "y" })

      const result = await runPreflight({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
      })

      expect(result.checks).toEqual([])
    })
  })
})

// ── checkTailscaleStatus ───────────────────────────────────────────────

describe("checkTailscaleStatus", () => {
  describe("parsing", () => {
    it("parses healthy Running status", async () => {
      const runner = new SequenceProcessRunner(resultMap(
        ["tailscale status", successResult(TAILSCALE_STATUS_OUTPUT)],
      ))

      const facts = await checkTailscaleStatus(runner)

      expect(facts.healthStatus).toBe("healthy")
      expect(facts.backendState).toBe("Running")
      expect(facts.ip).toBe("100.64.0.1")
      expect(facts.hostname).toBe("my-machine")
      expect(facts.tailnetLock).toBe(false)
    })

    it("parses self machine IP and hostname", async () => {
      const output = [
        "100.99.1.50  dev-main user@  darwin   active; direct 10.0.0.1:41641, tx 0 rx 0",
        "",
        "HealthStatus: ok",
        "BackendState: Running",
      ].join("\n")
      const runner = new SequenceProcessRunner(resultMap(
        ["tailscale status", successResult(output)],
      ))

      const facts = await checkTailscaleStatus(runner)

      expect(facts.ip).toBe("100.99.1.50")
      expect(facts.hostname).toBe("dev-main")
    })

    it("parses tailnet-lock enabled", async () => {
      const output = [
        "100.64.0.1  host user@  linux   active",
        "",
        "tailnet-lock: enabled",
      ].join("\n")
      const runner = new SequenceProcessRunner(resultMap(
        ["tailscale status", successResult(output)],
      ))

      const facts = await checkTailscaleStatus(runner)

      expect(facts.tailnetLock).toBe(true)
    })

    it("parses degraded health status", async () => {
      const output = [
        "100.64.0.1  host user@  linux   active",
        "",
        "HealthStatus: degraded",
        "BackendState: Running",
      ].join("\n")
      const runner = new SequenceProcessRunner(resultMap(
        ["tailscale status", successResult(output)],
      ))

      const facts = await checkTailscaleStatus(runner)

      expect(facts.healthStatus).toBe("degraded")
    })

    it("parses Stopped backend state", async () => {
      const output = [
        "",
        "BackendState: Stopped",
      ].join("\n")
      const runner = new SequenceProcessRunner(resultMap(
        ["tailscale status", successResult(output)],
      ))

      const facts = await checkTailscaleStatus(runner)

      expect(facts.backendState).toBe("Stopped")
    })

    it("handles empty status output", async () => {
      const runner = new SequenceProcessRunner(resultMap(
        ["tailscale status", successResult("")],
      ))

      const facts = await checkTailscaleStatus(runner)

      expect(facts.healthStatus).toBeNull()
      expect(facts.backendState).toBeNull()
      expect(facts.ip).toBeNull()
      expect(facts.hostname).toBeNull()
      expect(facts.tailnetLock).toBeNull()
      expect(facts.error).toBeNull()
    })

    it("handles malformed lines gracefully", async () => {
      const output = [
        "this is garbage",
        "100.64.0.1  host user@  linux   active",
        "more garbage with no structure",
        "",
        "HealthStatus: healthy",
      ].join("\n")
      const runner = new SequenceProcessRunner(resultMap(
        ["tailscale status", successResult(output)],
      ))

      const facts = await checkTailscaleStatus(runner)

      expect(facts.hostname).toBe("host")
      expect(facts.healthStatus).toBe("healthy")
    })

    it("handles missing HealthStatus/BackendState keys", async () => {
      const output = "100.64.0.1  host user@  linux   active\n"
      const runner = new SequenceProcessRunner(resultMap(
        ["tailscale status", successResult(output)],
      ))

      const facts = await checkTailscaleStatus(runner)

      expect(facts.healthStatus).toBeNull()
      expect(facts.backendState).toBeNull()
    })
  })

  describe("error handling", () => {
    it("sets error when tailscale command fails (nonzero exit)", async () => {
      const runner = new SequenceProcessRunner(resultMap(
        ["tailscale status", failureResult("failed to connect to local Tailscale")],
      ))

      const facts = await checkTailscaleStatus(runner)

      expect(facts.error).toContain("failed to connect")
      expect(facts.ip).toBeNull()
      expect(facts.backendState).toBeNull()
    })

    it("sets error message from stderr on failure", async () => {
      const errMsg = "failed to connect to local tailscaled; it's not running"
      const runner = new SequenceProcessRunner(resultMap(
        ["tailscale status", { exitCode: 1, stdout: "", stderr: errMsg }],
      ))

      const facts = await checkTailscaleStatus(runner)

      expect(facts.error).toBe(errMsg)
    })

    it("handles null exitCode (killed by signal)", async () => {
      const runner = new SequenceProcessRunner(resultMap(
        ["tailscale status", { exitCode: null, stdout: "", stderr: "killed" }],
      ))

      const facts = await checkTailscaleStatus(runner)

      expect(facts.error).toBe("killed")
    })

    it("sets error for non-numeric IP in status", async () => {
      const output = [
        "not-an-ip  host user@  linux   active",
        "",
        "HealthStatus: healthy",
        "BackendState: Running",
      ].join("\n")
      const runner = new SequenceProcessRunner(resultMap(
        ["tailscale status", successResult(output)],
      ))

      const facts = await checkTailscaleStatus(runner)

      expect(facts.ip).toBeNull()
      expect(facts.error).toBe("malformed status output")
      expect(facts.healthStatus).toBe("healthy")
      expect(facts.backendState).toBe("Running")
    })
  })

  describe("uses fixed argv", () => {
    it("calls tailscale status as fixed argv array", async () => {
      const runner = new SequenceProcessRunner(resultMap(
        ["tailscale status", successResult("BackendState: Running\n")],
      ))

      await checkTailscaleStatus(runner)

      expect(runner.calls).toHaveLength(1)
      expect(runner.calls[0].argv).toEqual(["tailscale", "status", "--json"])
    })
  })
})

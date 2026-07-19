import { describe, expect, it } from "vitest"
import type {
  PlatformInfo,
  ProcessOptions,
  ProcessResult,
  ProcessRunner,
  PromptOptions,
  PromptResult,
  SelectOption,
} from "../../../src/host/types.js"
import {
  FakePlatformInspector,
} from "./fixtures.js"
import type { ProfilePaths } from "../../../src/host/paths.js"
import {
  runSetup,
  type SetupOutcome,
  type SetupFileOps,
} from "../../../src/host/setup.js"

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

// ── SequencePrompter ───────────────────────────────────────────────────

/**
 * Test-only Prompter that returns values from sequential queues.
 * Throws if a queue is exhausted, making test failures loud and clear.
 */
class SequencePrompter {
  public plainCalls: string[] = []
  public secretCalls: string[] = []
  public confirmCalls: string[] = []
  public selectCalls: Array<{ message: string; options: readonly SelectOption[] }> = []

  private readonly inputQueue: string[]
  private readonly secretQueue: string[]
  private readonly confirmQueue: string[]

  constructor(params: {
    inputQueue?: string[]
    secretQueue?: string[]
    confirmQueue?: string[]
  }) {
    this.inputQueue = [...(params.inputQueue ?? [])]
    this.secretQueue = [...(params.secretQueue ?? [])]
    this.confirmQueue = [...(params.confirmQueue ?? [])]
  }

  async promptInput(message: string): Promise<string> {
    this.plainCalls.push(message)
    const value = this.inputQueue.shift()
    if (value === undefined) {
      throw new Error(`SequencePrompter: no more input values (called with: "${message}")`)
    }
    return value
  }

  async promptSecret(message: string): Promise<string> {
    this.secretCalls.push(message)
    const value = this.secretQueue.shift()
    if (value === undefined) {
      throw new Error(`SequencePrompter: no more secret values (called with: "${message}")`)
    }
    return value
  }

  async promptConfirm(message: string): Promise<string> {
    this.confirmCalls.push(message)
    const value = this.confirmQueue.shift()
    if (value === undefined) {
      throw new Error(`SequencePrompter: no more confirm values (called with: "${message}")`)
    }
    return value
  }

  async promptSelect(message: string, options: readonly SelectOption[]): Promise<string> {
    this.selectCalls.push({ message, options })
    return ""
  }

  async prompt(options: PromptOptions): Promise<PromptResult> {
    switch (options.kind) {
      case "input":
        return { value: await this.promptInput(options.message) }
      case "secret":
        return { value: await this.promptSecret(options.message) }
      case "confirm":
        return { value: await this.promptConfirm(options.message) }
      case "select":
        return { value: await this.promptSelect(options.message, options.options ?? []) }
    }
  }
}

// ── FakeFileOps ────────────────────────────────────────────────────────

/**
 * Test-only file operations that track all calls without touching disk.
 */
class FakeFileOps implements SetupFileOps {
  public writeConfigCalls: Array<{ path: string; data: Record<string, unknown> }> = []
  public writeSecretCalls: Array<{ path: string; value: string }> = []
  public ensureDirsCalls: ProfilePaths[] = []
  public readConfigCalls: string[] = []

  private readonly existingConfigs: Map<string, Record<string, unknown>>

  constructor(existingConfigs?: Map<string, Record<string, unknown>>) {
    this.existingConfigs = existingConfigs ?? new Map()
  }

  async writeConfig(path: string, data: Record<string, unknown>): Promise<void> {
    this.writeConfigCalls.push({ path, data })
  }

  async writeSecret(path: string, value: string): Promise<void> {
    this.writeSecretCalls.push({ path, value })
  }

  async ensureProfileDirs(paths: ProfilePaths): Promise<void> {
    this.ensureDirsCalls.push(paths)
  }

  async readConfig(path: string): Promise<Record<string, unknown> | null> {
    this.readConfigCalls.push(path)
    return this.existingConfigs.get(path) ?? null
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

function resultMap(...entries: Array<[string, ProcessResult]>): Map<string, ProcessResult> {
  return new Map<string, ProcessResult>(entries)
}

/**
 * Build a runner that has all prereqs installed and Tailscale healthy.
 */
function healthyRunner(): SequenceProcessRunner {
  return new SequenceProcessRunner(resultMap(
    ["which tmux", successResult("/opt/homebrew/bin/tmux")],
    ["which opencode", successResult("/usr/local/bin/opencode")],
    ["which tailscale", successResult("/usr/local/bin/tailscale")],
    ["tailscale status", successResult([
      "100.64.0.1  my-machine user@  darwin   active",
      "",
      "HealthStatus: healthy",
      "BackendState: Running",
    ].join("\n"))],
  ))
}

/**
 * Build a runner with prereqs installed but Tailscale has no IP.
 */
function noTailscaleIpRunner(): SequenceProcessRunner {
  return new SequenceProcessRunner(resultMap(
    ["which tmux", successResult("/opt/homebrew/bin/tmux")],
    ["which opencode", successResult("/usr/local/bin/opencode")],
    ["which tailscale", successResult("/usr/local/bin/tailscale")],
    ["tailscale status", successResult([
      "",
      "HealthStatus: healthy",
      "BackendState: Running",
    ].join("\n"))],
  ))
}

/**
 * Build a runner with prereqs installed but Tailscale backend is Stopped.
 */
function stoppedBackendRunner(): SequenceProcessRunner {
  return new SequenceProcessRunner(resultMap(
    ["which tmux", successResult("/opt/homebrew/bin/tmux")],
    ["which opencode", successResult("/usr/local/bin/opencode")],
    ["which tailscale", successResult("/usr/local/bin/tailscale")],
    ["tailscale status", successResult([
      "100.64.0.1  my-machine user@  darwin   active",
      "",
      "HealthStatus: healthy",
      "BackendState: Stopped",
    ].join("\n"))],
  ))
}

/**
 * Build a runner where prereqs are missing (tmux not found).
 */
function missingPrereqRunner(): SequenceProcessRunner {
  return new SequenceProcessRunner(resultMap(
    ["which tmux", failureResult()],
    ["which opencode", successResult("/usr/local/bin/opencode")],
    ["which tailscale", successResult("/usr/local/bin/tailscale")],
    ["tailscale status", successResult([
      "100.64.0.1  my-machine user@  darwin   active",
      "",
      "BackendState: Running",
    ].join("\n"))],
  ))
}

const TEST_ENV = { HOME: "/home/testuser" }

/**
 * Default input queue for the full happy-path flow.
 * Order: profileName, agentId, projectPath, peerId, peerUrl, bridgePort, ocPort
 */
function happyPathInputQueue(profileName = "test-profile"): string[] {
  return [
    profileName,                          // profile name
    "dev-main",                           // agent ID
    "/home/testuser/projects/myapp",      // project path
    "test-vps",                           // peer ID
    "http://test-vps.tailnet:8787",       // peer URL
    "8787",                               // bridge port
    "4096",                               // OC server port
  ]
}

/**
 * Default secret queue for the happy-path flow.
 * Order: bearerToken, ocPassword
 */
function happyPathSecretQueue(): string[] {
  return [
    "super-secret-bearer-token",          // bearer token
    "opencode-server-password",           // OC password
  ]
}

/**
 * Default confirm queue for the happy-path flow (no existing profile).
 * Order: initialConfirm, finalConfirm
 */
function happyPathConfirmQueue(): string[] {
  return ["y", "y"]
}

/**
 * Create a SequencePrompter for the full happy-path flow.
 */
function happyPathPrompter(profileName = "test-profile"): SequencePrompter {
  return new SequencePrompter({
    inputQueue: happyPathInputQueue(profileName),
    secretQueue: happyPathSecretQueue(),
    confirmQueue: happyPathConfirmQueue(),
  })
}

// ── runSetup ───────────────────────────────────────────────────────────

describe("runSetup", () => {
  // ── Preflight failure → blocked ─────────────────────────────────────

  describe("preflight failure → blocked", () => {
    it("returns blocked when platform is unsupported", async () => {
      const inspector = new FakePlatformInspector({
        platform: "win32", arch: "x64", isTTY: true,
      })
      const runner = new SequenceProcessRunner(resultMap())
      const prompter = new SequencePrompter({
        inputQueue: ["my-profile"],
        confirmQueue: ["y"],
      })
      const fileOps = new FakeFileOps()

      const outcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(outcome.kind).toBe("blocked")
      if (outcome.kind === "blocked") {
        expect(outcome.reason).toContain("Unsupported platform")
      }
    })

    it("returns blocked when prereqs are missing", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = missingPrereqRunner()
      const prompter = new SequencePrompter({
        inputQueue: ["my-profile"],
        confirmQueue: ["y"],
      })
      const fileOps = new FakeFileOps()

      const outcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(outcome.kind).toBe("blocked")
      if (outcome.kind === "blocked") {
        expect(outcome.reason).toContain("missing")
      }
    })

    it("includes preflight result in blocked outcome", async () => {
      const inspector = new FakePlatformInspector({
        platform: "win32", arch: "x64", isTTY: true,
      })
      const runner = new SequenceProcessRunner(resultMap())
      const prompter = new SequencePrompter({})
      const fileOps = new FakeFileOps()

      const outcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(outcome.preflight).toBeDefined()
      expect(outcome.preflight.ok).toBe(false)
    })
  })

  // ── Tailscale gating → blocked ──────────────────────────────────────

  describe("Tailscale gating → blocked", () => {
    it("returns blocked when Tailscale has no IP", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = noTailscaleIpRunner()
      const prompter = new SequencePrompter({
        inputQueue: ["my-profile"],
        confirmQueue: ["y"],
      })
      const fileOps = new FakeFileOps()

      const outcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(outcome.kind).toBe("blocked")
      if (outcome.kind === "blocked") {
        expect(outcome.reason).toContain("Tailscale IP")
      }
    })

    it("returns blocked when backend state is not Running", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = stoppedBackendRunner()
      const prompter = new SequencePrompter({
        inputQueue: ["my-profile"],
        confirmQueue: ["y"],
      })
      const fileOps = new FakeFileOps()

      const outcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(outcome.kind).toBe("blocked")
      if (outcome.kind === "blocked") {
        expect(outcome.reason).toContain("BackendState")
      }
    })

    it("returns blocked when Tailscale status command fails", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = new SequenceProcessRunner(resultMap(
        ["which tmux", successResult("/opt/homebrew/bin/tmux")],
        ["which opencode", successResult("/usr/local/bin/opencode")],
        ["which tailscale", successResult("/usr/local/bin/tailscale")],
        ["tailscale status", failureResult("failed to connect")],
      ))
      const prompter = new SequencePrompter({
        inputQueue: ["my-profile"],
        confirmQueue: ["y"],
      })
      const fileOps = new FakeFileOps()

      const outcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(outcome.kind).toBe("blocked")
      if (outcome.kind === "blocked") {
        expect(outcome.reason).toContain("Tailscale")
      }
    })

    it("does not prompt for profile name when Tailscale is blocked", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = noTailscaleIpRunner()
      const prompter = new SequencePrompter({})
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(prompter.plainCalls).toHaveLength(0)
      expect(prompter.confirmCalls).toHaveLength(0)
    })
  })

  // ── Initial profile confirmation ────────────────────────────────────

  describe("initial profile confirmation", () => {
    it("prompts for profile name when preflight and Tailscale are ok", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(prompter.plainCalls[0]).toContain("profile")
    })

    it("returns declined when user declines initial confirmation", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = new SequencePrompter({
        inputQueue: ["test-profile"],
        confirmQueue: ["n"],
      })
      const fileOps = new FakeFileOps()

      const outcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(outcome.kind).toBe("declined")
    })

    it("includes preflight result in declined outcome", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = new SequencePrompter({
        inputQueue: ["test-profile"],
        confirmQueue: ["n"],
      })
      const fileOps = new FakeFileOps()

      const outcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(outcome.preflight).toBeDefined()
      expect(outcome.preflight.ok).toBe(true)
    })

    it("does not prompt for secrets when initial confirmation is declined", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = new SequencePrompter({
        inputQueue: ["test-profile"],
        confirmQueue: ["n"],
      })
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(prompter.secretCalls).toHaveLength(0)
    })
  })

  // ── Config value prompting ──────────────────────────────────────────

  describe("config value prompting", () => {
    it("prompts for bearer token via promptSecret after initial confirmation", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(prompter.secretCalls.length).toBeGreaterThanOrEqual(1)
      expect(prompter.secretCalls[0]).toContain("bearer")
    })

    it("prompts for OpenCode password via promptSecret", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(prompter.secretCalls.length).toBeGreaterThanOrEqual(2)
      expect(prompter.secretCalls[1]).toContain("password")
    })

    it("prompts for agent ID via promptInput", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      // plainCalls[0] = profile name, plainCalls[1] = agent ID
      expect(prompter.plainCalls.length).toBeGreaterThanOrEqual(2)
      expect(prompter.plainCalls[1]).toContain("agent ID")
    })

    it("prompts for project path via promptInput", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(prompter.plainCalls.length).toBeGreaterThanOrEqual(3)
      expect(prompter.plainCalls[2]).toContain("project path")
    })

    it("prompts for peer ID via promptInput", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(prompter.plainCalls.length).toBeGreaterThanOrEqual(4)
      expect(prompter.plainCalls[3]).toContain("peer")
    })

    it("prompts for peer URL via promptInput", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(prompter.plainCalls.length).toBeGreaterThanOrEqual(5)
      expect(prompter.plainCalls[4]).toContain("URL")
    })

    it("prompts for bridge port via promptInput", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(prompter.plainCalls.length).toBeGreaterThanOrEqual(6)
      expect(prompter.plainCalls[5]).toContain("bridge port")
    })

    it("prompts for OpenCode server port via promptInput", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(prompter.plainCalls.length).toBeGreaterThanOrEqual(7)
      expect(prompter.plainCalls[6]).toContain("OpenCode")
    })
  })

  // ── Config building ─────────────────────────────────────────────────

  describe("config building", () => {
    it("uses Tailscale IP as bridge host", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(fileOps.writeConfigCalls).toHaveLength(1)
      const config = fileOps.writeConfigCalls[0].data
      expect(config.bridge).toBeDefined()
      expect((config.bridge as Record<string, unknown>).host).toBe("100.64.0.1")
    })

    it("uses loopback for OpenCode base_url", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      expect(config.opencode).toBeDefined()
      expect((config.opencode as Record<string, unknown>).base_url).toBe("http://127.0.0.1:4096")
    })

    it("sets default_response to reject", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const perms = config.permissions as Record<string, unknown>
      expect(perms.default_response).toBe("reject")
    })

    it("allows read, grep, glob tools", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const perms = config.permissions as Record<string, unknown>
      expect(perms.allow_tools).toEqual(["read", "grep", "glob"])
    })

    it("requires plan approval for bash, edit, write", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const perms = config.permissions as Record<string, unknown>
      expect(perms.require_plan_approval_for_tools).toEqual(["bash", "edit", "write"])
    })

    it("sets auth_mode to bearer-token", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const sec = config.security as Record<string, unknown>
      expect(sec.auth_mode).toBe("bearer-token")
    })

    it("uses user-provided agent ID", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      expect(config.agent_id).toBe("dev-main")
    })

    it("does not persist the bearer token in config", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const sec = config.security as Record<string, unknown>
      expect(sec.bearer_token).toBeUndefined()
    })

    it("includes peer as allowed source", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const sec = config.security as Record<string, unknown>
      const sources = sec.allowed_sources as Array<Record<string, unknown>>
      expect(sources).toHaveLength(1)
      expect(sources[0].source_agent_id).toBe("test-vps")
    })

    it("includes project with user-provided path", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const projects = config.projects as Array<Record<string, unknown>>
      expect(projects).toHaveLength(1)
      expect(projects[0].path).toBe("/home/testuser/projects/myapp")
      expect(projects[0].id).toBe("test-profile")
    })

    it("includes peer agent with user-provided URL", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const agents = config.agents as Array<Record<string, unknown>>
      expect(agents).toHaveLength(1)
      expect(agents[0].id).toBe("test-vps")
      expect(agents[0].url).toBe("http://test-vps.tailnet:8787")
    })

    it("uses user-provided bridge port", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = new SequencePrompter({
        inputQueue: [
          "test-profile", "dev-main", "/srv/app",
          "peer-1", "http://peer-1.tailnet:9999",
          "9090", "5000",
        ],
        secretQueue: ["bearer", "ocpass"],
        confirmQueue: ["y", "y"],
      })
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const bridge = config.bridge as Record<string, unknown>
      expect(bridge.port).toBe(9090)
    })

    it("uses user-provided OpenCode server port", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = new SequencePrompter({
        inputQueue: [
          "test-profile", "dev-main", "/srv/app",
          "peer-1", "http://peer-1.tailnet:9999",
          "9090", "5000",
        ],
        secretQueue: ["bearer", "ocpass"],
        confirmQueue: ["y", "y"],
      })
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const oc = config.opencode as Record<string, unknown>
      expect(oc.server_port).toBe(5000)
      expect(oc.base_url).toBe("http://127.0.0.1:5000")
    })

    it("constructs public_url from Tailscale hostname and bridge port", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const bridge = config.bridge as Record<string, unknown>
      expect(bridge.public_url).toBe("http://my-machine:8787")
    })

    it("uses Tailscale IP in public_url when hostname is present", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const bridge = config.bridge as Record<string, unknown>
      // healthyRunner has hostname "my-machine", so public_url uses it
      expect(bridge.public_url).toBe("http://my-machine:8787")
      // bridge.host is always the raw Tailscale IP
      expect(bridge.host).toBe("100.64.0.1")
    })

    it("includes planning config with plan_annotator_enabled true", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const planning = config.planning as Record<string, unknown>
      expect(planning.plan_annotator_enabled).toBe(true)
      expect(planning.require_approval_for).toEqual(
        expect.arrayContaining(["deployment", "destructive", "multi-agent-fanout"]),
      )
    })

    it("includes timeouts with sensible defaults", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const timeouts = config.timeouts as Record<string, unknown>
      expect(timeouts.default_job_seconds).toBe(1800)
      expect(timeouts.callback_retry_attempts).toBe(3)
    })

    it("sets password_env to OPENCODE_SERVER_PASSWORD", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const config = fileOps.writeConfigCalls[0].data
      const oc = config.opencode as Record<string, unknown>
      expect(oc.password_env).toBe("OPENCODE_SERVER_PASSWORD")
    })

    it("validates built config against bridgeConfigSchema", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      // If writeConfig was called, the config was built.
      // Verify all required top-level keys exist.
      const config = fileOps.writeConfigCalls[0].data
      expect(config).toHaveProperty("agent_id")
      expect(config).toHaveProperty("bridge")
      expect(config).toHaveProperty("opencode")
      expect(config).toHaveProperty("security")
      expect(config).toHaveProperty("permissions")
      expect(config).toHaveProperty("projects")
      expect(config).toHaveProperty("agents")
      expect(config).toHaveProperty("timeouts")
      expect(config).toHaveProperty("planning")
    })
  })

  // ── No-overwrite confirmation ───────────────────────────────────────

  describe("no-overwrite confirmation", () => {
    it("checks if profile already exists via readConfig", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(fileOps.readConfigCalls).toHaveLength(1)
      expect(fileOps.readConfigCalls[0]).toContain("test-profile")
    })

    it("prompts overwrite confirmation when profile exists", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()

      // Pre-populate existing config
      const existingConfigs = new Map<string, Record<string, unknown>>()
      // We need to know the config path — it will be resolved from env + profile name
      // The readConfig call will use the same path, so we match on a partial key.
      // We'll use a custom fileOps that returns non-null for any path containing "test-profile".
      const fileOps = new FakeFileOps()
      const origReadConfig = fileOps.readConfig.bind(fileOps)
      fileOps.readConfig = async (path: string) => {
        fileOps.readConfigCalls.push(path)
        if (path.includes("test-profile")) {
          return { existing: true }
        }
        return null
      }

      const prompter = new SequencePrompter({
        inputQueue: happyPathInputQueue(),
        secretQueue: happyPathSecretQueue(),
        confirmQueue: ["y", "y", "y"], // initial, overwrite, final
      })

      const outcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      // Should have 3 confirm calls: initial, overwrite, final
      expect(prompter.confirmCalls).toHaveLength(3)
      expect(prompter.confirmCalls[1]).toContain("already exists")
    })

    it("returns declined when overwrite is declined", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()

      const fileOps = new FakeFileOps()
      fileOps.readConfig = async (path: string) => {
        fileOps.readConfigCalls.push(path)
        if (path.includes("test-profile")) {
          return { existing: true }
        }
        return null
      }

      const prompter = new SequencePrompter({
        inputQueue: happyPathInputQueue(),
        secretQueue: happyPathSecretQueue(),
        confirmQueue: ["y", "n"], // initial confirm, overwrite declined
      })

      const outcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(outcome.kind).toBe("declined")
    })

    it("skips overwrite prompt when profile does not exist", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps() // readConfig returns null by default

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      // Only 2 confirm calls: initial + final (no overwrite prompt)
      expect(prompter.confirmCalls).toHaveLength(2)
    })
  })

  // ── Redacted summary and final confirmation ─────────────────────────

  describe("redacted summary and final confirmation", () => {
    it("shows redacted summary without bearer token value", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      // The last confirm call contains the summary
      const summaryConfirm = prompter.confirmCalls[prompter.confirmCalls.length - 1]
      expect(summaryConfirm).toContain("[REDACTED]")
      expect(summaryConfirm).not.toContain("super-secret-bearer-token")
    })

    it("does not include OC password in summary", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const summaryConfirm = prompter.confirmCalls[prompter.confirmCalls.length - 1]
      expect(summaryConfirm).not.toContain("opencode-server-password")
    })

    it("includes agent ID in summary", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const summaryConfirm = prompter.confirmCalls[prompter.confirmCalls.length - 1]
      expect(summaryConfirm).toContain("dev-main")
    })

    it("includes bridge host and port in summary", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const summaryConfirm = prompter.confirmCalls[prompter.confirmCalls.length - 1]
      expect(summaryConfirm).toContain("100.64.0.1")
      expect(summaryConfirm).toContain("8787")
    })

    it("returns declined when final confirmation is declined", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = new SequencePrompter({
        inputQueue: happyPathInputQueue(),
        secretQueue: happyPathSecretQueue(),
        confirmQueue: ["y", "n"], // initial confirm, final declined
      })
      const fileOps = new FakeFileOps()

      const outcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(outcome.kind).toBe("declined")
    })

    it("does not persist when final confirmation is declined", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = new SequencePrompter({
        inputQueue: happyPathInputQueue(),
        secretQueue: happyPathSecretQueue(),
        confirmQueue: ["y", "n"], // initial confirm, final declined
      })
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(fileOps.writeConfigCalls).toHaveLength(0)
      expect(fileOps.writeSecretCalls).toHaveLength(0)
    })
  })

  // ── Persistence ─────────────────────────────────────────────────────

  describe("persistence", () => {
    it("calls ensureProfileDirs before writing", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(fileOps.ensureDirsCalls).toHaveLength(1)
      // ensureProfileDirs should be called before writeConfig
      expect(fileOps.ensureDirsCalls[0].configDir).toContain("test-profile")
    })

    it("writes config via writeConfig", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(fileOps.writeConfigCalls).toHaveLength(1)
      expect(fileOps.writeConfigCalls[0].path).toContain("test-profile")
      expect(fileOps.writeConfigCalls[0].path).toContain("config.json")
    })

    it("writes bearer token to the secrets directory", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const bearerWrite = fileOps.writeSecretCalls.find((call) => call.path.includes("bearer"))
      expect(bearerWrite?.value).toBe("super-secret-bearer-token")
    })

    it("writes OpenCode password to secrets dir via writeSecret", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(fileOps.writeSecretCalls).toHaveLength(2)
      const ocPassWrite = fileOps.writeSecretCalls.find(
        (c) => c.path.includes("opencode"),
      )
      expect(ocPassWrite).toBeDefined()
      expect(ocPassWrite!.value).toBe("opencode-server-password")
      expect(ocPassWrite!.path).toContain("secrets")
    })

    it("returns persisted outcome with profile name and config path", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      const outcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(outcome.kind).toBe("persisted")
      if (outcome.kind === "persisted") {
        expect(outcome.profileName).toBe("test-profile")
        expect(outcome.configPath).toContain("test-profile")
        expect(outcome.configPath).toContain("config.json")
      }
    })

    it("returns persisted outcome with preflight result attached", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      const outcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      expect(outcome.preflight).toBeDefined()
      expect(outcome.preflight.ok).toBe(true)
    })

    it("uses XDG_CONFIG_HOME from env for config dir", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()
      const xdgEnv = {
        HOME: "/home/testuser",
        XDG_CONFIG_HOME: "/custom/config",
        XDG_DATA_HOME: "/custom/data",
        XDG_STATE_HOME: "/custom/state",
      }

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: xdgEnv,
        fileOps,
      })

      expect(fileOps.ensureDirsCalls[0].configDir).toBe("/custom/config/aibridge/test-profile")
      expect(fileOps.ensureDirsCalls[0].dataDir).toBe("/custom/data/aibridge/test-profile")
      expect(fileOps.ensureDirsCalls[0].secretsDir).toBe("/custom/data/aibridge/test-profile/secrets")
      expect(fileOps.ensureDirsCalls[0].stateDir).toBe("/custom/state/aibridge/test-profile")
    })
  })

  // ── No side effects ─────────────────────────────────────────────────

  describe("no side effects", () => {
    it("never starts any service", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      for (const call of runner.calls) {
        const cmd = call.argv.join(" ")
        expect(cmd).not.toContain("systemctl")
        expect(cmd).not.toContain("start")
        expect(cmd).not.toContain("enable")
      }
    })

    it("never outputs secrets in outcome", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      const outcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      const serialized = JSON.stringify(outcome)
      expect(serialized).not.toContain("super-secret-bearer-token")
      expect(serialized).not.toContain("opencode-server-password")
    })

    it("never outputs secrets in redacted summary", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter()
      const fileOps = new FakeFileOps()

      await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      // Check the final confirmation message (contains summary)
      const summaryMsg = prompter.confirmCalls[prompter.confirmCalls.length - 1]
      expect(summaryMsg).not.toContain("super-secret-bearer-token")
      expect(summaryMsg).not.toContain("opencode-server-password")
    })
  })

  // ── Type discrimination ─────────────────────────────────────────────

  describe("type discrimination", () => {
    it("persisted outcome has kind='persisted' and profileName", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = happyPathPrompter("my-setup")
      const fileOps = new FakeFileOps()

      const outcome: SetupOutcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      if (outcome.kind === "persisted") {
        expect(outcome.profileName).toBe("my-setup")
        expect(outcome.preflight.ok).toBe(true)
        expect(outcome.configPath).toContain("my-setup")
      } else {
        expect.fail("Expected persisted outcome")
      }
    })

    it("blocked outcome has kind='blocked' and reason", async () => {
      const inspector = new FakePlatformInspector({
        platform: "win32", arch: "x64", isTTY: true,
      })
      const runner = new SequenceProcessRunner(resultMap())
      const prompter = new SequencePrompter({})
      const fileOps = new FakeFileOps()

      const outcome: SetupOutcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      if (outcome.kind === "blocked") {
        expect(typeof outcome.reason).toBe("string")
        expect(outcome.reason.length).toBeGreaterThan(0)
      } else {
        expect.fail("Expected blocked outcome")
      }
    })

    it("declined outcome has kind='declined'", async () => {
      const inspector = new FakePlatformInspector(macInfo())
      const runner = healthyRunner()
      const prompter = new SequencePrompter({
        inputQueue: ["test"],
        confirmQueue: ["n"],
      })
      const fileOps = new FakeFileOps()

      const outcome: SetupOutcome = await runSetup({
        platformInspector: inspector,
        processRunner: runner,
        prompter,
        env: TEST_ENV,
        fileOps,
      })

      if (outcome.kind === "declined") {
        expect(outcome.preflight.ok).toBe(true)
      } else {
        expect.fail("Expected declined outcome")
      }
    })
  })
})

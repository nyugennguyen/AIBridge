import { describe, expect, it } from "vitest"
import {
  runSetupWizard,
  generateBearerToken,
  parseBearerTokenChoice,
  parsePeerSelection,
  resolveEnrolmentCapabilities,
  REACHABILITY_NOT_AUTHENTICATION,
  StepperFSM,
} from "../../../src/cli/setup-wizard.js"
import type { AgentDiscoveryResult, DiscoveredAgent } from "../../../src/cli/setup-step-widgets.js"
import { bridgeConfigSchema } from "../../../src/config/schemas.js"
import { generateLaunchdPlist, generateSystemdUnit, installDaemonUnit } from "../../../src/host/daemonizer.js"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PlatformInspector, ProcessRunner, Prompter, PromptOptions, PromptResult, SelectOption } from "../../../src/host/types.js"
import type { SetupFileOps } from "../../../src/host/setup.js"
import type { ProfilePaths } from "../../../src/host/paths.js"

class TestPrompter implements Prompter {
  public inputs: string[] = []
  public secrets: string[] = []
  public confirms: string[] = []

  private readonly inputQueue: string[]
  private readonly secretQueue: string[]
  private readonly confirmQueue: string[]

  constructor(queues?: {
    inputs?: string[]
    secrets?: string[]
    confirms?: string[]
  }) {
    this.inputQueue = [...(queues?.inputs ?? [])]
    this.secretQueue = [...(queues?.secrets ?? [])]
    this.confirmQueue = [...(queues?.confirms ?? [])]
  }

  async promptInput(message: string): Promise<string> {
    this.inputs.push(message)
    const val = this.inputQueue.shift()
    if (val === undefined) throw new Error(`TestPrompter: no more inputs for: ${message}`)
    return val
  }

  async promptSecret(message: string): Promise<string> {
    this.secrets.push(message)
    const val = this.secretQueue.shift()
    if (val === undefined) throw new Error(`TestPrompter: no more secrets for: ${message}`)
    return val
  }

  async promptConfirm(message: string): Promise<string> {
    this.confirms.push(message)
    const val = this.confirmQueue.shift()
    if (val === undefined) throw new Error(`TestPrompter: no more confirms for: ${message}`)
    return val
  }

  async promptSelect(_message: string, _options: readonly SelectOption[]): Promise<string> {
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

class TestFileOps implements SetupFileOps {
  public writtenConfigs: Record<string, Record<string, unknown>> = {}
  public writtenSecrets: Record<string, string> = {}
  public ensuredDirs: ProfilePaths[] = []
  public existingConfigs: Record<string, Record<string, unknown>> = {}

  async writeConfig(path: string, data: Record<string, unknown>): Promise<void> {
    this.writtenConfigs[path] = data
  }

  async writeSecret(path: string, value: string): Promise<void> {
    this.writtenSecrets[path] = value
  }

  async ensureProfileDirs(paths: ProfilePaths): Promise<void> {
    this.ensuredDirs.push(paths)
  }

  async readConfig(path: string): Promise<Record<string, unknown> | null> {
    return this.existingConfigs[path] ?? null
  }
}

function makeFakeProcessRunner(params?: {
  tmux?: boolean
  opencode?: boolean
  tailscale?: boolean
  tailscaleIp?: string
  tailscaleBackend?: string
}): ProcessRunner {
  const tmux = params?.tmux ?? true
  const opencode = params?.opencode ?? true
  const tailscale = params?.tailscale ?? true
  const tsIp = params?.tailscaleIp ?? "100.64.0.1"
  const tsBackend = params?.tailscaleBackend ?? "Running"

  return {
    async exec(argv) {
      const cmd = argv.join(" ")
      if (cmd === "which tmux") return { exitCode: tmux ? 0 : 1, stdout: "", stderr: "" }
      if (cmd === "which opencode") return { exitCode: opencode ? 0 : 1, stdout: "", stderr: "" }
      if (cmd === "which tailscale") return { exitCode: tailscale ? 0 : 1, stdout: "", stderr: "" }
      if (cmd === "tailscale status --json") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            BackendState: tsBackend,
            Self: { TailscaleIPs: [tsIp], DNSName: "myhost.ts.net.", BackendState: tsBackend },
          }),
          stderr: "",
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" }
    },
  }
}

function makePlatformInspector(): PlatformInspector {
  return {
    inspect: () => ({ platform: "darwin", arch: "arm64", isTTY: true, hasColor: true }),
  }
}

describe("runSetupWizard", () => {
  const env = { HOME: "/mock/home" }

  it("completes full setup generating a new bearer token", async () => {
    const fileOps = new TestFileOps()
    const prompter = new TestPrompter({
      inputs: [
        "dev", // profile name
        "", // default config path
        "y", // generate token?
        "", // acknowledged token display
        "my-agent", // agent ID
        "/mock/path", // project path
        "peer-agent", // peer ID
        "http://100.64.0.2:8787", // peer URL
        "8787", // bridge port
        "4096", // opencode port
      ],
      secrets: [
        "super-secret-oc", // opencode password
      ],
      confirms: [
        "y", // final save confirm
        "n", // do not start the daemon
      ],
    })

    const outcome = await runSetupWizard({
      platformInspector: makePlatformInspector(),
      processRunner: makeFakeProcessRunner(),
      prompter,
      fileOps,
      env,
    })

    expect(outcome.kind).toBe("persisted")
    if (outcome.kind !== "persisted") return
    expect(outcome.profileName).toBe("dev")
    expect(outcome.configPath).toBe("/mock/home/.config/aibridge/dev/config.json")

    // Check secrets persisted
    const bearerSecret = fileOps.writtenSecrets["/mock/home/.local/share/aibridge/dev/secrets/bearer_token"]
    expect(bearerSecret).toBeDefined()
    expect(bearerSecret).toHaveLength(64) // 32 bytes in hex = 64 hex chars

    const ocSecret = fileOps.writtenSecrets["/mock/home/.local/share/aibridge/dev/secrets/opencode_password"]
    expect(ocSecret).toBe("super-secret-oc")

    // Check config persisted
    const savedConfig = fileOps.writtenConfigs["/mock/home/.config/aibridge/dev/config.json"]
    expect(savedConfig).toBeDefined()
    expect(savedConfig.agent_id).toBe("my-agent")
  })

  it("supports entering an existing bearer token when user chooses 'n'", async () => {
    const fileOps = new TestFileOps()
    const prompter = new TestPrompter({
      inputs: [
        "prod",
        "",
        "n", // do not generate token
        "", // agent ID default
        "", // project path default
        "", // peer ID default
        "", // peer URL default
        "", // bridge port default
        "", // oc port default
      ],
      secrets: [
        "existing-bearer-token-1234567890abcdef", // existing token
        "oc-password", // opencode password
      ],
      confirms: [
        "y", // save confirm
        "n", // do not start the daemon
      ],
    })

    const outcome = await runSetupWizard({
      platformInspector: makePlatformInspector(),
      processRunner: makeFakeProcessRunner(),
      prompter,
      fileOps,
      env,
    })

    expect(outcome.kind).toBe("persisted")
    expect(fileOps.writtenSecrets["/mock/home/.local/share/aibridge/prod/secrets/bearer_token"]).toBe(
      "existing-bearer-token-1234567890abcdef",
    )
  })

  it("supports custom config file path", async () => {
    const fileOps = new TestFileOps()
    const customPath = "/custom/dir/my-aibridge.json"
    const prompter = new TestPrompter({
      inputs: [
        "dev",
        customPath, // custom config path
        "y",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ],
      secrets: [
        "oc-pw",
      ],
      confirms: [
        "y",
        "n", // do not start the daemon
      ],
    })

    const outcome = await runSetupWizard({
      platformInspector: makePlatformInspector(),
      processRunner: makeFakeProcessRunner(),
      prompter,
      fileOps,
      env,
    })

    expect(outcome.kind).toBe("persisted")
    if (outcome.kind !== "persisted") return
    expect(outcome.configPath).toBe(customPath)
    expect(fileOps.writtenConfigs[customPath]).toBeDefined()
  })

  it("declines when existing profile overwrite is declined", async () => {
    const fileOps = new TestFileOps()
    const configPath = "/mock/home/.config/aibridge/dev/config.json"
    fileOps.existingConfigs[configPath] = { agent_id: "old" }

    const prompter = new TestPrompter({
      inputs: [
        "dev",
        "",
      ],
      confirms: [
        "n", // decline overwrite
      ],
    })

    const outcome = await runSetupWizard({
      platformInspector: makePlatformInspector(),
      processRunner: makeFakeProcessRunner(),
      prompter,
      fileOps,
      env,
    })

    expect(outcome.kind).toBe("declined")
  })

  it("blocks when prereqs are missing", async () => {
    const fileOps = new TestFileOps()
    const prompter = new TestPrompter({
      confirms: ["n"], // decline installing tmux
    })
    const outcome = await runSetupWizard({
      platformInspector: makePlatformInspector(),
      processRunner: makeFakeProcessRunner({ tmux: false }),
      prompter,
      fileOps,
      env,
    })

    expect(outcome.kind).toBe("blocked")
    if (outcome.kind !== "blocked") return
    expect(outcome.reason).toContain("Prerequisites missing: tmux")
  })

  it("blocks when Tailscale is inactive", async () => {
    const fileOps = new TestFileOps()
    const prompter = new TestPrompter()

    const outcome = await runSetupWizard({
      platformInspector: makePlatformInspector(),
      processRunner: makeFakeProcessRunner({ tailscaleBackend: "Stopped" }),
      prompter,
      fileOps,
      env,
    })

    expect(outcome.kind).toBe("blocked")
    if (outcome.kind !== "blocked") return
    expect(outcome.reason).toContain("Tailscale BackendState is not Running")
  })
})

describe("bearer authentication mode", () => {
  const env = { HOME: "/mock/home" }

  /**
   * Answers for a full run in `none` mode. Confirms are the risky ordering:
   * confirming the no-auth exposure comes FIRST, before the two that finish setup.
   */
  function noneModeQueues() {
    return {
      inputs: ["open", "", "none", "", "", "", "", "", "", ""],
      secrets: ["oc-password"],
      confirms: ["y", "y", "n"],
    }
  }

  it("persists auth_mode none and writes no bearer secret", async () => {
    const fileOps = new TestFileOps()
    const prompter = new TestPrompter(noneModeQueues())

    const outcome = await runSetupWizard({
      platformInspector: makePlatformInspector(),
      processRunner: makeFakeProcessRunner(),
      prompter,
      fileOps,
      env,
    })

    expect(outcome.kind).toBe("persisted")
    if (outcome.kind !== "persisted") return
    const saved = fileOps.writtenConfigs[outcome.configPath]
    expect(saved).toBeDefined()
    expect(saved?.security).toMatchObject({ auth_mode: "none" })
    // The OpenCode password is still written -- only the bearer secret is skipped.
    expect(fileOps.writtenSecrets["/mock/home/.local/share/aibridge/open/secrets/opencode_password"]).toBe("oc-password")
    expect(
      Object.keys(fileOps.writtenSecrets).some((k) => k.endsWith("/bearer_token")),
    ).toBe(false)
  })

  it("refuses no-auth on a bridge that is not bound to a CGNAT address", async () => {
    const fileOps = new TestFileOps()
    // 10.0.0.0/8 is RFC1918, not 100.64.0.0/10: nothing network-level stands in
    // for the bearer token here, so the mode is not authorable.
    const prompter = new TestPrompter({
      inputs: ["open", "", "none"],
      secrets: [],
      confirms: [],
    })

    const outcome = await runSetupWizard({
      platformInspector: makePlatformInspector(),
      processRunner: makeFakeProcessRunner({ tailscaleIp: "10.0.0.5" }),
      prompter,
      fileOps,
      env,
    })

    expect(outcome.kind).toBe("blocked")
    if (outcome.kind !== "blocked") return
    expect(outcome.reason).toContain("not a Tailscale CGNAT address")
    expect(fileOps.writtenConfigs).toEqual({})
  })

  it("refuses no-auth when a stale bearer token secret already exists", async () => {
    const fileOps = new TestFileOps()
    // writeSecret is write-once and never re-read, so a leftover secret would be
    // silently ignored while the operator believed it was protecting the node.
    const prompter = new TestPrompter({
      inputs: ["open", "", "none"],
      secrets: [],
      confirms: [],
    })

    const outcome = await runSetupWizard({
      platformInspector: makePlatformInspector(),
      processRunner: makeFakeProcessRunner(),
      prompter,
      fileOps,
      env,
      pathExists: async (path) => path.endsWith("/bearer_token"),
    })

    expect(outcome.kind).toBe("blocked")
    if (outcome.kind !== "blocked") return
    expect(outcome.reason).toContain("already")
  })

  it("falls back to a generated token when the no-auth exposure is declined", async () => {
    const fileOps = new TestFileOps()
    const prompter = new TestPrompter({
      inputs: ["open", "", "none", "", "", "", "", "", "", ""],
      secrets: ["oc-password"],
      confirms: ["n", "y", "n"], // decline no-auth, then save
    })

    const outcome = await runSetupWizard({
      platformInspector: makePlatformInspector(),
      processRunner: makeFakeProcessRunner(),
      prompter,
      fileOps,
      env,
    })

    expect(outcome.kind).toBe("persisted")
    if (outcome.kind !== "persisted") return
    const saved = fileOps.writtenConfigs[outcome.configPath]
    expect(saved?.security).toMatchObject({ auth_mode: "bearer-token" })
    const bearerSecret = fileOps.writtenSecrets["/mock/home/.local/share/aibridge/open/secrets/bearer_token"]
    expect(bearerSecret).toHaveLength(64)
  })

  it("still reads a bare 'n' as 'paste my own token'", () => {
    // Backward compatibility: "n" has meant "don't generate" since this prompt
    // existed. Rebinding it to no-auth would turn an old muscle memory into an
    // unauthenticated bridge, so only an explicit "none" disables auth.
    expect(parseBearerTokenChoice("n")).toBe("paste")
    expect(parseBearerTokenChoice("no")).toBe("paste")
    expect(parseBearerTokenChoice("p")).toBe("paste")
    expect(parseBearerTokenChoice("y")).toBe("generate")
    expect(parseBearerTokenChoice("")).toBe("generate")
    expect(parseBearerTokenChoice("none")).toBe("none")
    expect(parseBearerTokenChoice("NOAUTH")).toBe("none")
  })
})

describe("generateBearerToken", () => {
  it("generates a 64-character hex string", () => {
    const token = generateBearerToken()
    expect(token).toHaveLength(64)
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true)
  })

  it("generates unique tokens on subsequent calls", () => {
    const t1 = generateBearerToken()
    const t2 = generateBearerToken()
    expect(t1).not.toBe(t2)
  })
})

describe("StepperFSM state machine & keyboard navigation", () => {
  it("initializes at Step 1 (Network) with default profile", () => {
    const fsm = new StepperFSM("my-profile")
    expect(fsm.currentStep).toBe(1)
    expect(fsm.currentState.profileName).toBe("my-profile")
    expect(fsm.currentState.bearerToken).toMatch(/^aibr_sec_[0-9a-f]{32,64}$/)
  })

  it("advances through steps with nextStep and Enter key", () => {
    const fsm = new StepperFSM()
    expect(fsm.currentStep).toBe(1)

    // Advance via Enter
    fsm.handleKey("\n")
    expect(fsm.currentStep).toBe(2)

    // Advance via nextStep()
    expect(fsm.nextStep()).toBe(true)
    expect(fsm.currentStep).toBe(3)

    fsm.handleKey("\r")
    expect(fsm.currentStep).toBe(4)

    fsm.nextStep()
    expect(fsm.currentStep).toBe(5)

    // Cannot advance past Step 5
    expect(fsm.nextStep()).toBe(false)
    expect(fsm.currentStep).toBe(5)
  })

  it("returns to previous steps with Esc or 'b'", () => {
    const fsm = new StepperFSM()
    fsm.nextStep()
    fsm.nextStep()
    expect(fsm.currentStep).toBe(3)

    fsm.handleKey("\x1b")
    expect(fsm.currentStep).toBe(2)

    fsm.handleKey("b")
    expect(fsm.currentStep).toBe(1)

    // Cannot go below step 1
    fsm.handleKey("b")
    expect(fsm.currentStep).toBe(1)
  })

  it("jumps to completed steps using number keys 1..5", () => {
    const fsm = new StepperFSM()
    fsm.nextStep() // step 2
    fsm.nextStep() // step 3
    expect(fsm.currentStep).toBe(3)

    fsm.handleKey("1")
    expect(fsm.currentStep).toBe(1)

    fsm.handleKey("2")
    expect(fsm.currentStep).toBe(2)

    fsm.handleKey("3")
    expect(fsm.currentStep).toBe(3)
  })

  it("regenerates bearer token with 'r' key when in Step 2", () => {
    const fsm = new StepperFSM()
    fsm.nextStep() // Move to Step 2: Security
    expect(fsm.currentStep).toBe(2)

    const initialToken = fsm.currentState.bearerToken
    expect(initialToken).toMatch(/^aibr_sec_/)

    const res = fsm.handleKey("r")
    expect(res.action).toBe("regenerate_token")
    const newToken = fsm.currentState.bearerToken
    expect(newToken).toMatch(/^aibr_sec_/)
    expect(newToken).not.toBe(initialToken)
  })

  it("cycles field focus with Tab and Shift+Tab and toggles with Space", () => {
    const fsm = new StepperFSM()
    fsm.nextStep() // Step 2
    expect(fsm.currentState.focusedField).toBe(0)

    fsm.handleKey("\t")
    expect(fsm.currentState.focusedField).toBe(1)

    fsm.handleKey("\x1b[Z") // Shift+Tab
    expect(fsm.currentState.focusedField).toBe(0)

    // Toggle first checkbox (const-time)
    expect(fsm.currentState.invariants.constTime).toBe(true)
    fsm.handleKey(" ")
    expect(fsm.currentState.invariants.constTime).toBe(false)
    fsm.handleKey(" ")
    expect(fsm.currentState.invariants.constTime).toBe(true)
  })
})

describe("StepperFSM mouse hit-testing", () => {
  it("switches steps by clicking stepper navigation bar", () => {
    const fsm = new StepperFSM()
    fsm.nextStep() // Complete step 1 and move to 2

    // Click on Step 1 (col 8, row 3)
    const res1 = fsm.handleMouseClick(8, 3)
    expect(res1.action).toBe("jump")
    expect(fsm.currentStep).toBe(1)

    // Click on Step 2 (col 25, row 3)
    const res2 = fsm.handleMouseClick(25, 3)
    expect(res2.action).toBe("jump")
    expect(fsm.currentStep).toBe(2)
  })

  it("toggles checkboxes when clicking in step 2 form area", () => {
    const fsm = new StepperFSM()
    fsm.nextStep() // Step 2

    expect(fsm.currentState.invariants.constTime).toBe(true)
    fsm.handleMouseClick(20, 13) // Row 13 is first checkbox
    expect(fsm.currentState.invariants.constTime).toBe(false)
  })

  it("advances and retreats when clicking footer action buttons", () => {
    const fsm = new StepperFSM()
    expect(fsm.currentStep).toBe(1)

    // Click Continue (col 70, row 23)
    fsm.handleMouseClick(70, 23)
    expect(fsm.currentStep).toBe(2)

    // Click Back (col 50, row 23)
    fsm.handleMouseClick(50, 23)
    expect(fsm.currentStep).toBe(1)
  })
})

describe("Service Daemonizer & Preflight Outbox", () => {
  it("generates valid macOS launchd plist structure", () => {
    const plist = generateLaunchdPlist({ profile: "dev" })
    expect(plist).toContain("com.aibridge.daemon")
    expect(plist).toContain("<string>worker</string>")
    expect(plist).toContain("<string>--profile</string>")
    expect(plist).toContain("<string>dev</string>")
    expect(plist).toContain("<string>--ipc-publish</string>")
    expect(plist).toContain("<key>KeepAlive</key>")
  })

  it("generates valid Linux systemd service structure", () => {
    const unit = generateSystemdUnit({ profile: "prod" })
    expect(unit).toContain("Description=AIBridge Distributed Mesh Agent Worker Daemon (prod)")
    expect(unit).toContain("ExecStart=aibr worker --profile prod --ipc-publish")
    expect(unit).toContain("Restart=always")
    expect(unit).toContain("MemoryMax=64M")
  })

  it("refuses a profile name it cannot represent safely in a unit file", () => {
    // The profile lands unescaped in a plist and a systemd ExecStart, so a name
    // carrying XML or unit syntax is refused rather than silently mangled.
    for (const bad of ["a b", "x\nRestart=0", "</string><string>y", "a/b", "p;w"]) {
      expect(() => generateLaunchdPlist({ profile: bad })).toThrow(/Unsafe profile name/)
      expect(() => generateSystemdUnit({ profile: bad })).toThrow(/Unsafe profile name/)
    }
  })

  it("escapes the binary path it interpolates into the plist", () => {
    const plist = generateLaunchdPlist({ aibrPath: "/opt/a&b/<aibr>" })
    expect(plist).toContain("&amp;")
    expect(plist).toContain("&lt;aibr&gt;")
    expect(plist).not.toContain("<aibr>")
  })

  it("writes the unit without activating it unless skipLoad is explicitly false", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aibr-unit-test-"))
    try {
      const res = await installDaemonUnit({ platform: "linux", profile: "dev", homeDir: tempDir })
      expect(res.installed).toBe(true)
      expect(res.unitPath).toBe(join(tempDir, ".config", "systemd", "user", "aibridge.service"))
      // Writing is not starting: the unit exists on disk and nothing was enabled.
      const written = await readFile(res.unitPath!, "utf8")
      expect(written).toContain("ExecStart=aibr worker --profile dev --ipc-publish")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it("reports the unit as installed but not started when the operator declines", async () => {
    const fileOps = new TestFileOps()
    const prompter = new TestPrompter({
      inputs: [
        "dev", // profile name
        "", // default config path
        "y", // generate token?
        "", // acknowledged token display
        "my-agent", // agent ID
        "/mock/path", // project path
        "peer-agent", // peer ID
        "http://100.64.0.2:8787", // peer URL
        "8787", // bridge port
        "4096", // opencode port
      ],
      secrets: ["super-secret-oc"], // opencode password
      confirms: ["y", "n"], // save, then decline starting the daemon
    })

    const outcome = await runSetupWizard({
      platformInspector: makePlatformInspector(),
      processRunner: makeFakeProcessRunner(),
      prompter,
      fileOps,
      env: { HOME: "/mock/home" },
    })

    expect(outcome.kind).toBe("persisted")
    if (outcome.kind !== "persisted") return
    // A daemon that was never activated must not be reported as running: the
    // unit is KeepAlive, and "created" alone reads as "it is up".
    expect(outcome.daemon?.installed).toBe(true)
    expect(outcome.daemon?.started).toBe(false)
    expect(outcome.daemon?.error).toBeNull()
  })
})

// ── Step 4: discovery-driven, explicitly-enrolled peer config ────────────

describe("Step 4 — discovery proposes, the operator enrols", () => {
  const env = { HOME: "/mock/home" }

  // ── Fixtures ────────────────────────────────────────────────────────────

  function peer(overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
    return {
      ip: "100.64.0.4",
      hostname: "alpha.ts.net",
      os: "linux",
      online: true,
      bridgeUrl: "http://100.64.0.4:8787",
      reachable: true,
      agentId: "alpha-agent",
      capabilities: ["deployment"],
      opencodeReachable: true,
      enrolled: false,
      ...overrides,
    }
  }

  function discoveryResult(agents: readonly DiscoveredAgent[]): AgentDiscoveryResult {
    return {
      agents,
      peersFound: agents.length,
      reachableCount: agents.filter((a) => a.reachable).length,
      enrolledCount: agents.filter((a) => a.enrolled).length,
    }
  }

  const ALPHA = peer()
  const BRAVO = peer({
    ip: "100.64.0.2",
    hostname: "bravo.ts.net",
    bridgeUrl: "http://100.64.0.2:8787",
    agentId: "bravo-agent",
    capabilities: ["analysis"],
  })

  /**
   * Run a full setup with an injected discovery result and a collecting writer.
   *
   * The queues below are in the order the prompts fire, which is asserted
   * explicitly in "Step 4 prompt order" so a future reordering shows up as a
   * failure rather than as a mysterious shift in every other test.
   */
  async function runWithDiscovery(params: {
    discovery: AgentDiscoveryResult
    inputs?: string[]
    secrets?: string[]
    confirms?: string[]
    existing?: Record<string, unknown>
  }) {
    const fileOps = new TestFileOps()
    const configPath = "/mock/home/.config/aibridge/default/config.json"
    if (params.existing) fileOps.existingConfigs[configPath] = params.existing
    const prompter = new TestPrompter({
      inputs: params.inputs ?? [],
      secrets: params.secrets ?? ["oc-password"],
      confirms: params.confirms ?? ["y", "n"],
    })
    const output: string[] = []
    const discovered: Array<{ enrolledAgentIds: readonly string[] | undefined }> = []

    const outcome = await runSetupWizard({
      platformInspector: makePlatformInspector(),
      processRunner: makeFakeProcessRunner(),
      prompter,
      fileOps,
      env,
      discoverAgents: async (discoveryDeps) => {
        discovered.push({ enrolledAgentIds: discoveryDeps?.enrolledAgentIds })
        // Honour the `enrolledAgentIds` the wizard passed, the way the real
        // probe does, so the `enrolled` badge is exercised rather than faked.
        const ids = new Set(discoveryDeps?.enrolledAgentIds ?? [])
        const agents = params.discovery.agents.map((agent) => ({
          ...agent,
          enrolled: agent.agentId !== null && ids.has(agent.agentId),
        }))
        return { ...params.discovery, agents }
      },
      write: (text) => void output.push(text),
    })

    return { outcome, fileOps, prompter, output, configPath, discovered }
  }

  function saved(fileOps: TestFileOps, configPath: string): Record<string, unknown> {
    const config = fileOps.writtenConfigs[configPath]
    if (config === undefined) throw new Error(`no config written at ${configPath}`)
    return config
  }

  function agentsOf(config: Record<string, unknown>): Array<Record<string, unknown>> {
    return config.agents as Array<Record<string, unknown>>
  }

  function sourcesOf(config: Record<string, unknown>): Array<Record<string, unknown>> {
    return (config.security as { allowed_sources: Array<Record<string, unknown>> }).allowed_sources
  }

  /** The prompt labels in order, as the prompter saw them. */
  function promptOrder(prompter: TestPrompter): string[] {
    return [...prompter.inputs, ...prompter.secrets, ...prompter.confirms]
  }

  // ── Boundary tests (§18.4 gate) ──────────────────────────────────────────

  it("does not enrol a discovered peer the operator did not select", async () => {
    // THE GATE. Two reachable peers are on the tailnet and the operator
    // declines to pick one. Trust-on-first-use enrolment would put both in
    // the config here.
    const { fileOps, configPath } = await runWithDiscovery({
      discovery: discoveryResult([ALPHA, BRAVO]),
      inputs: [
        "", // profile name -> default
        "", // config path -> default
        "", // generate token
        "", // acknowledge token
        "", // agent id -> default
        "", // project path -> default
        "", // SKIP enrolment
        "", // bridge port
        "", // opencode port
      ],
    })

    const config = saved(fileOps, configPath)
    expect(agentsOf(config)).toEqual([])
    expect(sourcesOf(config)).toEqual([])
  })

  it("skips enrolment on the explicit 's' answer too", async () => {
    // Not just the empty answer. An operator who types something and still
    // means nobody gets the same result.
    const { fileOps, configPath } = await runWithDiscovery({
      discovery: discoveryResult([ALPHA, BRAVO]),
      inputs: ["", "", "", "", "", "", "s", "", ""],
    })

    const config = saved(fileOps, configPath)
    expect(agentsOf(config)).toEqual([])
    expect(sourcesOf(config)).toEqual([])
  })

  it("enrols only the selected peer, in both arrays, with matching ids and capabilities", async () => {
    const { fileOps, configPath } = await runWithDiscovery({
      discovery: discoveryResult([ALPHA, BRAVO]),
      inputs: [
        "", // profile name
        "", // config path
        "", // generate token
        "", // acknowledge token
        "", // agent id
        "", // project path
        "2", // select bravo by number
        "", // capabilities: accept advertised
        "", // bridge port
        "", // opencode port
      ],
      confirms: ["y", "y", "n"], // enrol, save, no daemon
    })

    const config = saved(fileOps, configPath)

    // Both halves, one id, one capability list. `assertSourceAuthorized`
    // authorizes on `source_agent_id` AND capability membership, so a
    // mismatch here is a 403 at the first /trigger.
    expect(agentsOf(config)).toEqual([
      { id: "bravo-agent", url: "http://100.64.0.2:8787", capabilities: ["analysis"] },
    ])
    expect(sourcesOf(config)).toEqual([
      {
        source_agent_id: "bravo-agent",
        capabilities: ["analysis"],
        requires_plan_approval: [],
      },
    ])

    // The peer that was discovered but NOT selected is nowhere in the config.
    expect(JSON.stringify(config)).not.toContain("alpha")
  })

  it("writes both arrays in agreement even when the operator overrides the capabilities", async () => {
    const { fileOps, configPath } = await runWithDiscovery({
      discovery: discoveryResult([ALPHA]),
      inputs: [
        "",
        "",
        "",
        "",
        "",
        "",
        "1", // select alpha
        "development, orchestration", // typed capabilities, not "deployment"
        "",
        "",
      ],
      confirms: ["y", "y", "n"],
    })

    const config = saved(fileOps, configPath)
    expect(agentsOf(config)[0]?.capabilities).toEqual(["development", "orchestration"])
    expect(sourcesOf(config)[0]?.capabilities).toEqual(["development", "orchestration"])
  })

  it("falls back to a conservative capability default when the peer advertised none", async () => {
    // An unidentified peer has no advertised list, and the operator typed
    // none. The wizard's own default is used rather than an empty grant that
    // would silently authorize nothing and read as a mistake later.
    const { fileOps, configPath } = await runWithDiscovery({
      discovery: discoveryResult([peer({ agentId: null, capabilities: [] })]),
      inputs: [
        "",
        "",
        "",
        "",
        "",
        "",
        "1",
        "typed-id", // the agent ID for the unidentified peer
        "", // capabilities -> default
        "",
        "",
      ],
      confirms: ["y", "y", "n"],
    })

    const config = saved(fileOps, configPath)
    const expected = ["development", "orchestration"]
    expect(agentsOf(config)[0]?.capabilities).toEqual(expected)
    expect(sourcesOf(config)[0]?.capabilities).toEqual(expected)
  })

  it("does not enrol a peer whose /health did not identify it unless the operator types the id", async () => {
    // `reachable: true, agentId: null` is the documented case: something
    // answered on that address and did not say what it was. There is nothing
    // to enrol under until the operator supplies one out of band.
    const silent = peer({ agentId: null, capabilities: [] })
    const { fileOps, configPath, prompter, output } = await runWithDiscovery({
      discovery: discoveryResult([silent]),
      inputs: [
        "",
        "",
        "",
        "",
        "",
        "",
        "1",
        "", // Enter at the agent-ID prompt -> enrol nobody
        "", // bridge port
        "", // opencode port
      ],
    })

    const config = saved(fileOps, configPath)
    expect(agentsOf(config)).toEqual([])
    expect(sourcesOf(config)).toEqual([])
    expect(promptOrder(prompter).some((label) => label.includes("did not identify itself"))).toBe(false)
    // The copy does say why, so the operator is not left guessing what went wrong.
    expect(output.join("")).toContain("did not say which agent it is")
    expect(output.join("")).toContain("Answering is not identifying")
  })

  it("enrols an unidentified peer under a hand-typed id once the operator supplies one", async () => {
    const silent = peer({ agentId: null, capabilities: [] })
    const { fileOps, configPath } = await runWithDiscovery({
      discovery: discoveryResult([silent]),
      inputs: [
        "",
        "",
        "",
        "",
        "",
        "",
        "1",
        "spoken-id", // hand-typed identity
        "qa", // capabilities
        "",
        "",
      ],
      confirms: ["y", "y", "n"],
    })

    const config = saved(fileOps, configPath)
    expect(agentsOf(config)).toEqual([
      { id: "spoken-id", url: "http://100.64.0.4:8787", capabilities: ["qa"] },
    ])
    expect(sourcesOf(config)).toEqual([
      { source_agent_id: "spoken-id", capabilities: ["qa"], requires_plan_approval: [] },
    ])
  })

  it("enrols nobody when the operator declines the confirmation", async () => {
    const { fileOps, configPath } = await runWithDiscovery({
      discovery: discoveryResult([ALPHA]),
      inputs: ["", "", "", "", "", "", "1", "", "", ""],
      confirms: ["n", "y", "n"], // decline enrolment, save, no daemon
    })

    const config = saved(fileOps, configPath)
    expect(agentsOf(config)).toEqual([])
    expect(sourcesOf(config)).toEqual([])
  })

  // ── Manual fallback ──────────────────────────────────────────────────────

  it("still offers the manual prompts when discovery finds nothing", async () => {
    // A setup run before Tailscale was joined, or a machine whose daemon is
    // not answering, must not be bricked by a discovery-driven wizard.
    const { fileOps, configPath, prompter } = await runWithDiscovery({
      discovery: discoveryResult([]),
      inputs: [
        "",
        "",
        "",
        "",
        "",
        "",
        "", // manual peer agent ID -> default "peer"
        "", // manual peer URL -> default http://100.64.0.2:8787
        "",
        "",
      ],
    })

    const config = saved(fileOps, configPath)
    expect(agentsOf(config)).toEqual([
      {
        id: "peer",
        url: "http://100.64.0.2:8787",
        capabilities: ["development", "orchestration"],
      },
    ])
    expect(sourcesOf(config)).toEqual([
      {
        source_agent_id: "peer",
        capabilities: ["development", "orchestration"],
        requires_plan_approval: [],
      },
    ])
    // The manual prompts fired verbatim, with the released defaults.
    expect(prompter.inputs).toContain("Enter peer agent ID [peer]:")
    expect(prompter.inputs).toContain("Enter peer agent URL [http://100.64.0.2:8787]:")
  })

  it("honours hand-typed manual values when discovery finds nothing", async () => {
    const { fileOps, configPath } = await runWithDiscovery({
      discovery: discoveryResult([]),
      inputs: ["", "", "", "", "", "", "peer-agent", "http://100.64.0.9:8787", "", ""],
    })

    const config = saved(fileOps, configPath)
    expect(agentsOf(config)[0]).toMatchObject({
      id: "peer-agent",
      url: "http://100.64.0.9:8787",
    })
    expect(sourcesOf(config)[0]).toMatchObject({ source_agent_id: "peer-agent" })
  })

  it("still offers the manual prompts when the operator asks for them over a populated tailnet", async () => {
    // 'm' on a tailnet that HAS peers: the escape hatch stays available, so
    // an operator who does not recognise anything on screen is never stuck.
    const { fileOps, configPath, prompter } = await runWithDiscovery({
      discovery: discoveryResult([ALPHA, BRAVO]),
      inputs: ["", "", "", "", "", "", "m", "manual-peer", "http://100.64.0.77:8787", "", ""],
    })

    const config = saved(fileOps, configPath)
    expect(agentsOf(config)[0]).toMatchObject({ id: "manual-peer" })
    expect(sourcesOf(config)[0]).toMatchObject({ source_agent_id: "manual-peer" })
    expect(prompter.inputs).toContain("Enter peer agent ID [peer]:")
  })

  // ── Security copy and schema ─────────────────────────────────────────────

  it("tells the operator that reachability is not trust, every run", async () => {
    // The green checkmark the table prints is the most misreadable string on
    // the screen, so the de-fusing sentence ships with it — on the skip path
    // as much as the enrol path.
    const { output } = await runWithDiscovery({
      discovery: discoveryResult([ALPHA]),
      inputs: ["", "", "", "", "", "", "", "", "", ""],
    })

    const narration = output.join("")
    expect(narration).toContain(REACHABILITY_NOT_AUTHENTICATION)
    expect(narration).toContain("Reachability is not authentication")
    expect(narration).toContain("not that it is trusted")
    expect(narration).toContain("provides reachability, not identity, enrolment, project membership, or approval")
    expect(narration).toContain("src/mesh/identity/")
    expect(narration).toContain("Discovery enrols nothing")
  })

  it("never surfaces a tskey- enrollment credential from the discovery table", async () => {
    // `agent_id` crosses the network in a response direction, and a `tskey-…`
    // value is a reusable node-enrollment credential. A peer that answers with
    // one is not identifying itself with an agent id, so the wizard must not
    // print it, offer it, or write it into the config.
    const credential = peer({ agentId: "tskey-abcdef0123456789-reusable-secret" })
    const { output, fileOps, configPath } = await runWithDiscovery({
      discovery: discoveryResult([credential]),
      inputs: [
        "",
        "",
        "",
        "",
        "",
        "",
        "1", // select the credential-bearing peer
        "typed-id", // ... and enrol it under something else
        "", // capabilities
        "", // bridge port
        "", // opencode port
      ],
      confirms: ["y", "y", "n"],
    })

    const narration = output.join("")
    expect(narration).not.toContain("tskey-")
    // Scrubbed to "did not identify itself", which routes the operator onto
    // the hand-typed-id path rather than onto an unverified credential.
    expect(narration).toContain("did not identify itself")
    // ...and the credential never reaches the config either.
    expect(JSON.stringify(fileOps.writtenConfigs[configPath])).not.toContain("tskey-")
  })

  it("produces a config that bridgeConfigSchema accepts", async () => {
    // `writeConfig` in src/host/profile-store.ts validates, so a malformed
    // config throws at the worst possible moment. Enrol, skip and manual all
    // have to survive a real parse.
    const cases: Array<{ label: string; inputs: string[]; confirms: string[] }> = [
      { label: "enrolled", inputs: ["", "", "", "", "", "", "1", "", "", ""], confirms: ["y", "y", "n"] },
      { label: "skipped", inputs: ["", "", "", "", "", "", "", "", "", ""], confirms: ["y", "n"] },
      { label: "manual", inputs: ["", "", "", "", "", "", "", "", "", ""], confirms: ["y", "n"] },
    ]

    for (const testCase of cases) {
      const { fileOps, configPath } = await runWithDiscovery({
        discovery: discoveryResult([ALPHA]),
        inputs: testCase.inputs,
        confirms: testCase.confirms,
      })
      const config = saved(fileOps, configPath)
      // Throws on a malformed config, which is the assertion.
      expect(() => bridgeConfigSchema.parse(config)).not.toThrow()
      expect(bridgeConfigSchema.parse(config).agent_id).toBe("default")
    }
  })

  it("labels already-enrolled peers from the config it is about to overwrite", async () => {
    // The `enrolled` badge is a label from the existing config's `agents[]`
    // and nothing else; it must not be a side effect of discovery.
    const { fileOps, output, configPath, discovered } = await runWithDiscovery({
      discovery: discoveryResult([ALPHA]),
      inputs: ["", "", "", "", "", "", "", "", "", ""],
      confirms: ["y", "y", "n"], // confirm overwrite, save, no daemon
      existing: { agent_id: "old", agents: [{ id: "alpha-agent", url: "http://100.64.0.4:8787" }] },
    })

    // The wizard passed the config's own ids in, so the operator sees which
    // peer they are replacing instead of a table claiming nothing is enrolled.
    expect(discovered[0]?.enrolledAgentIds).toEqual(["alpha-agent"])
    expect(output.join("")).toContain("already enrolled here")
    expect(fileOps.writtenConfigs[configPath]).toBeDefined()
  })

  it("passes no enrolled ids when the profile does not exist yet", async () => {
    const { discovered } = await runWithDiscovery({
      discovery: discoveryResult([ALPHA]),
      inputs: ["", "", "", "", "", "", "", "", "", ""],
    })

    expect(discovered[0]?.enrolledAgentIds).toEqual([])
  })

  // ── Step 4 prompt order ──────────────────────────────────────────────────

  it("Step 4 prompt order: select, then identity, then capabilities, then confirm", async () => {
    // The sequence is the UX. Asserting it here means a future reordering is a
    // failing test rather than a surprise at somebody's terminal.
    const { prompter } = await runWithDiscovery({
      discovery: discoveryResult([peer({ agentId: null, capabilities: [] })]),
      inputs: ["", "", "", "", "", "", "1", "typed", "qa", "", ""],
      confirms: ["y", "y", "n"],
    })

    expect(prompter.inputs).toEqual([
      "Enter profile name [default]:",
      "Enter config file path [/mock/home/.config/aibridge/default/config.json]:",
      expect.stringContaining("Bearer authentication"),
      expect.stringContaining("Press Enter to continue"),
      "Enter agent ID [default]:",
      expect.stringContaining("Enter project path"),
      "Enrol a peer by number, hostname, or IP (Enter = enrol nobody, m = enter a peer by hand):",
      "Agent ID for alpha.ts.net (Enter to enrol nobody):",
      expect.stringContaining("Capabilities to grant typed"),
      "Enter bridge port [8787]:",
      "Enter OpenCode server port [4096]:",
    ])
    expect(prompter.confirms).toEqual([
      expect.stringContaining("Enrol typed at http://100.64.0.4:8787"),
      "Save configuration to \"/mock/home/.config/aibridge/default/config.json\"?",
      // The activation command is platform-derived; only its shape is pinned.
      expect.stringContaining("Start the daemon now?"),
    ])
  })

  it("shows every discovered peer with its address, reachability, id and capabilities", async () => {
    const { output } = await runWithDiscovery({
      discovery: discoveryResult([
        ALPHA,
        BRAVO,
        peer({ ip: "100.64.0.9", hostname: "charlie.ts.net", reachable: false, agentId: null, capabilities: [] }),
      ]),
      inputs: ["", "", "", "", "", "", "", "", "", ""],
    })

    const narration = output.join("")
    expect(narration).toContain("alpha.ts.net")
    expect(narration).toContain("100.64.0.4")
    expect(narration).toContain("answered /health")
    expect(narration).toContain("agent_id: alpha-agent")
    expect(narration).toContain("advertises: deployment")
    expect(narration).toContain("charlie.ts.net")
    expect(narration).toContain("no answer on /health")
    expect(narration).toContain("did not identify itself")
  })
})

// ── Parsing helpers ────────────────────────────────────────────────────

describe("parsePeerSelection", () => {
  const agents: DiscoveredAgent[] = [
    {
      ip: "100.64.0.4",
      hostname: "alpha.ts.net",
      os: "linux",
      online: true,
      bridgeUrl: "http://100.64.0.4:8787",
      reachable: true,
      agentId: "alpha-agent",
      capabilities: [],
      opencodeReachable: null,
      enrolled: false,
    },
    {
      ip: "100.64.0.2",
      hostname: "bravo.ts.net",
      os: "linux",
      online: true,
      bridgeUrl: "http://100.64.0.2:8787",
      reachable: false,
      agentId: null,
      capabilities: [],
      opencodeReachable: null,
      enrolled: false,
    },
  ]

  it("reads a 1-based row number as printed", () => {
    expect(parsePeerSelection("1", agents)).toEqual({ kind: "agent", agent: agents[0] })
    expect(parsePeerSelection("2", agents)).toEqual({ kind: "agent", agent: agents[1] })
  })

  it("reads a hostname or an IP case-insensitively", () => {
    expect(parsePeerSelection("ALPHA.TS.NET", agents)).toEqual({ kind: "agent", agent: agents[0] })
    expect(parsePeerSelection("100.64.0.2", agents)).toEqual({ kind: "agent", agent: agents[1] })
  })

  it("treats every unanswered form as skip, never as a default choice", () => {
    // This is the security-relevant property: there is no answer that picks a
    // peer the operator did not name, and no answer that traps them in a loop.
    for (const answer of ["", "   ", "s", "skip", "n", "no", "3", "99", "0", "-1", "who?", "100.64.0.9"]) {
      expect(parsePeerSelection(answer, agents)).toEqual({ kind: "skip" })
    }
  })

  it("routes 'm' to the released manual prompts", () => {
    expect(parsePeerSelection("m", agents)).toEqual({ kind: "manual" })
    expect(parsePeerSelection("MANUAL", agents)).toEqual({ kind: "manual" })
  })
})

describe("resolveEnrolmentCapabilities", () => {
  it("uses what the operator typed, trimmed and de-duplicated, in their order", () => {
    expect(resolveEnrolmentCapabilities(" b , a ,b ", ["deployment"])).toEqual(["b", "a"])
  })

  it("falls back to the advertised list only when the operator typed nothing", () => {
    expect(resolveEnrolmentCapabilities("", ["deployment", "analysis"])).toEqual([
      "deployment",
      "analysis",
    ])
    expect(resolveEnrolmentCapabilities("  ", ["analysis"])).toEqual(["analysis"])
  })

  it("does not silently take a peer's whole advertised list when the peer claims everything", () => {
    // The advertised list is an OFFER, not a grant. `resolveEnrolmentCapabilities`
    // returning it is only reached because the operator pressed Enter on a
    // prompt that showed them exactly what they were accepting.
    const advertised = ["deployment", "destructive", "multi-agent-fanout"]
    expect(resolveEnrolmentCapabilities("deployment", advertised)).toEqual(["deployment"])
  })

  it("uses the conservative wizard default when nothing was typed and nothing was advertised", () => {
    expect(resolveEnrolmentCapabilities("", [])).toEqual(["development", "orchestration"])
  })
})

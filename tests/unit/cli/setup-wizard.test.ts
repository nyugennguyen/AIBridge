import { describe, expect, it } from "vitest"
import { runSetupWizard, generateBearerToken, StepperFSM } from "../../../src/cli/setup-wizard.js"
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

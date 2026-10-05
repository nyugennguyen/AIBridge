import { describe, expect, it } from "vitest"
import { runSetupWizard, generateBearerToken } from "../../../src/cli/setup-wizard.js"
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

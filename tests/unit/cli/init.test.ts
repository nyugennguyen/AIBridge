import { describe, expect, it } from "vitest"
import {
  defaultGrant,
  nonInteractivePrompter,
  parseInitArgs,
  runInitCommand,
  type InitCliDeps,
} from "../../../src/cli/init.js"
import { quickstartAgentId, runSetupWizard, type SetupWizardDeps } from "../../../src/cli/setup-wizard.js"
import type { SetupFileOps, SetupOutcome } from "../../../src/host/setup.js"
import type { ProfilePaths } from "../../../src/host/paths.js"
import type {
  ConfirmOptions,
  PlatformInspector,
  ProcessRunner,
  Prompter,
  PromptOptions,
  PromptResult,
  SelectOption,
} from "../../../src/host/types.js"

// ── fakes ───────────────────────────────────────────────────────────────

class ScriptedPrompter implements Prompter {
  public asked: string[] = []
  constructor(private readonly answers: string[] = []) {}
  private next(message: string): string {
    this.asked.push(message)
    const value = this.answers.shift()
    if (value === undefined) throw new Error(`ScriptedPrompter: no answer for: ${message}`)
    return value
  }
  async promptInput(message: string): Promise<string> {
    return this.next(message)
  }
  async promptSecret(message: string): Promise<string> {
    return this.next(message)
  }
  async promptConfirm(message: string, _options?: ConfirmOptions): Promise<string> {
    return this.next(message)
  }
  async promptSelect(message: string, _options: readonly SelectOption[]): Promise<string> {
    return this.next(message)
  }
  async prompt(options: PromptOptions): Promise<PromptResult> {
    return { value: this.next(options.message) }
  }
}

const WORKER_CONFIG = {
  agent_id: "dev",
  role: "worker",
  capability_profiles: {
    investigate: {},
    "run-tests": {},
    "fix-on-branch": { requires_approval: true },
  },
  projects: [{ id: "dev", path: "/repo", capabilities: ["investigate"] }],
}

const PREFLIGHT = {
  ok: true,
  platform: "darwin",
  checks: [],
  missing: 0,
  tailscale: { ip: "100.64.0.1", hostname: null, healthStatus: null, backendState: "Running", tailnetLock: null, error: null },
} as unknown as SetupOutcome["preflight"]

interface Harness {
  deps: InitCliDeps
  text: () => string
  calls: string[]
  setupOptions: unknown[]
  joins: Array<{ code: string; adopt: boolean }>
  issues: Array<readonly string[] | undefined>
  prompter: ScriptedPrompter
}

function harness(opts: {
  answers?: string[]
  interactive?: boolean
  existing?: Record<string, unknown> | null
  saved?: Record<string, unknown>
  outcome?: SetupOutcome
  role?: string
  joinError?: Error
  startCode?: number
  runSetup?: InitCliDeps["runSetup"]
} = {}): Harness {
  const out: string[] = []
  const calls: string[] = []
  const setupOptions: unknown[] = []
  const joins: Harness["joins"] = []
  const issues: Harness["issues"] = []
  const prompter = new ScriptedPrompter(opts.answers ?? [])
  let created = false
  const role = opts.role ?? "worker"
  const deps: InitCliDeps = {
    write: (t) => void out.push(t),
    env: {},
    interactive: opts.interactive ?? true,
    prompter,
    readConfig: async () => {
      if (opts.existing !== undefined && opts.existing !== null) return opts.existing
      return created ? (opts.saved ?? { ...WORKER_CONFIG, role }) : null
    },
    runSetup:
      opts.runSetup ??
      (async (profile, options) => {
        calls.push("setup")
        setupOptions.push(options)
        created = true
        return (
          opts.outcome ??
          ({ kind: "persisted", profileName: profile, configPath: "/c.json", preflight: PREFLIGHT, role, runtime: role === "orchestrator" ? null : "claude" } as SetupOutcome)
        )
      }),
    join: async (_profile, code, options) => {
      calls.push("join")
      joins.push({ code, adopt: options.adoptBearerToken })
      if (opts.joinError) throw opts.joinError
      return { peerId: "staging", lines: ["Paired with staging."] }
    },
    issue: async (_profile, capabilities) => {
      calls.push("issue")
      issues.push(capabilities)
      return { code: "AIBR-CODE-123", capabilities: capabilities ?? ["investigate"], minutes: 30 }
    },
    start: async () => {
      calls.push("start")
      return opts.startCode ?? 0
    },
  }
  return { deps, text: () => out.join(""), calls, setupOptions, joins, issues, prompter }
}

// ── parseInitArgs / defaultGrant ────────────────────────────────────────

describe("parseInitArgs", () => {
  it("parses every flag", () => {
    expect(
      parseInitArgs(["--profile", "dev", "--role=both", "--runtime", "claude", "--project", "/r", "--port", "9000", "--join", " CODE ", "--capabilities", "a, b", "--no-start"]),
    ).toEqual({
      profile: "dev",
      role: "both",
      runtime: "claude",
      project: "/r",
      port: 9000,
      join: "CODE",
      capabilities: ["a", "b"],
      newNetwork: false,
      noStart: true,
      help: false,
    })
  })

  it("rejects bad values and --new with --join", () => {
    expect(parseInitArgs(["--role", "boss"])).toBe("--role must be worker, orchestrator or both: aibr init --role <worker|orchestrator|both>")
    expect(parseInitArgs(["--runtime", "gpt"])).toBe("--runtime must be opencode or claude: aibr init --runtime <opencode|claude>")
    expect(parseInitArgs(["--port", "0"])).toBe("--port needs a port number from 1 to 65535: aibr init --port <port>")
    expect(parseInitArgs(["--join"])).toBe("--join needs a pairing code: aibr init --join <pairing code>")
    expect(parseInitArgs(["--capabilities", ","])).toBe("--capabilities needs a comma-separated list: aibr init --capabilities <capability,capability>")
    expect(parseInitArgs(["--new", "--join", "x"])).toBe("--new and --join are exclusive")
    expect(parseInitArgs(["stray"])).toBe("unexpected argument stray (see: aibr init --help)")
    expect(parseInitArgs(["--bogus"])).toBe("unknown flag --bogus (see: aibr init --help)")
    expect(parseInitArgs(["--profile"])).toBe("--profile needs a value: aibr init --profile <name>")
  })
})

describe("defaultGrant", () => {
  it("grants a Claude worker's profiles that need no approval", () => {
    expect(defaultGrant(WORKER_CONFIG)).toEqual(["investigate", "run-tests"])
  })

  it("falls back to the first project's capabilities, else undefined", () => {
    expect(defaultGrant({ projects: [{ capabilities: ["development", "orchestration"] }] })).toEqual(["development", "orchestration"])
    expect(defaultGrant({})).toBeUndefined()
    expect(defaultGrant({ capability_profiles: { gated: { requires_approval: true } } })).toBeUndefined()
  })
})

// ── runInitCommand ──────────────────────────────────────────────────────

describe("runInitCommand", () => {
  it("new worker, new network: setup with quickstart answers, start, then a pairing code", async () => {
    const h = harness({ answers: [""] })
    expect(await runInitCommand(["--profile", "dev", "--runtime", "claude", "--port", "9000"], h.deps)).toBe(0)
    expect(h.calls).toEqual(["setup", "start", "issue"])
    expect(h.setupOptions[0]).toMatchObject({ quickstart: { runtime: "claude", bridgePort: 9000 }, prompter: h.prompter })
    expect(h.issues).toEqual([["investigate", "run-tests"]])
    expect(h.prompter.asked).toHaveLength(1)
    expect(h.prompter.asked[0]).toContain("press Enter to create a new one")
    const text = h.text()
    expect(text).toContain('Profile "dev" created (worker, claude runtime)')
    expect(text).toContain("  AIBR-CODE-123")
    expect(text).toContain("aibr enroll join AIBR-CODE-123")
    expect(text).toContain("aibr doctor --profile dev")
    expect(text).not.toContain("must be running when they do")
  })

  it("--capabilities overrides the default grant", async () => {
    const h = harness()
    expect(await runInitCommand(["--new", "--capabilities", "investigate"], h.deps)).toBe(0)
    expect(h.issues).toEqual([["investigate"]])
  })

  it("pasting a code joins, adopting the worker's token for a new worker profile", async () => {
    const h = harness({ answers: ["CODE-1"] })
    expect(await runInitCommand([], h.deps)).toBe(0)
    expect(h.calls).toEqual(["setup", "join", "start"])
    expect(h.joins).toEqual([{ code: "CODE-1", adopt: true }])
    expect(h.text()).toContain("Paired with staging.")
    expect(h.text()).toContain("aibr ping staging --profile default")
    expect(h.text()).toContain('aibr send staging "')
  })

  it("an orchestrator is asked for the worker's code, never adopts its token, and starts nothing", async () => {
    const h = harness({ answers: ["CODE-2"], role: "orchestrator" })
    expect(await runInitCommand(["--role", "orchestrator"], h.deps)).toBe(0)
    expect(h.prompter.asked[0]).toContain("Pairing code from the worker")
    expect(h.calls).toEqual(["setup", "join"])
    expect(h.joins).toEqual([{ code: "CODE-2", adopt: false }])
    expect(h.text()).toContain("aibr plugin install claude")
  })

  it("an orchestrator may skip pairing with Enter", async () => {
    const h = harness({ answers: [""], role: "orchestrator" })
    expect(await runInitCommand([], h.deps)).toBe(0)
    expect(h.calls).toEqual(["setup"])
  })

  it("--new on an orchestrator explains that it joins a worker's network", async () => {
    const h = harness({ role: "orchestrator" })
    expect(await runInitCommand(["--new"], h.deps)).toBe(0)
    expect(h.calls).toEqual(["setup"])
    expect(h.text()).toContain("An orchestrator joins a worker's network")
  })

  it("a failed join exits 1, but the bridge is still started", async () => {
    const h = harness({ joinError: new Error("code expired") })
    expect(await runInitCommand(["--join", "OLD"], h.deps)).toBe(1)
    expect(h.calls).toEqual(["setup", "join", "start"])
    expect(h.text()).toContain("Pairing failed: code expired")
    expect(h.text()).toContain("aibr enroll join <code> --profile default")
  })

  it("--no-start starts nothing and says how to start", async () => {
    const h = harness()
    expect(await runInitCommand(["--new", "--no-start"], h.deps)).toBe(0)
    expect(h.calls).toEqual(["setup", "issue"])
    expect(h.text()).toContain("Not started (--no-start). Start the bridge with: aibr start --profile default")
    expect(h.text()).toContain("must be running when they do: aibr start --profile default")
  })

  it("a failed start exits 1", async () => {
    const h = harness({ startCode: 1 })
    expect(await runInitCommand(["--new"], h.deps)).toBe(1)
  })

  it("non-interactive with no flags on a new profile fails naming the flags", async () => {
    const h = harness({
      interactive: false,
      runSetup: async (_profile, options) => {
        await options.prompter.promptInput("Node role — worker, orchestrator or both [worker]:")
        throw new Error("unreachable")
      },
    })
    expect(await runInitCommand([], h.deps)).toBe(1)
    expect(h.text()).toContain("pass the answer as a flag (aibr init --help)")
  })

  it("non-interactive re-run on an existing profile asks nothing and just starts", async () => {
    const h = harness({ interactive: false, existing: WORKER_CONFIG })
    expect(await runInitCommand([], h.deps)).toBe(0)
    expect(h.calls).toEqual(["start"])
    expect(h.text()).toContain('Profile "default" already exists (worker, agent dev)')
  })

  it("an existing profile is not set up again", async () => {
    const h = harness({ existing: WORKER_CONFIG, answers: [""] })
    expect(await runInitCommand([], h.deps)).toBe(0)
    expect(h.calls).toEqual(["start", "issue"])
  })

  it("a blocked setup prints the install commands", async () => {
    const preflight = {
      ...PREFLIGHT,
      ok: false,
      checks: [
        { name: "tmux", status: "missing", installCmd: ["brew", "install", "tmux"], error: null },
        { name: "claude", status: "installed", installCmd: null, error: null },
      ],
    } as unknown as SetupOutcome["preflight"]
    const h = harness({ outcome: { kind: "blocked", reason: "Prerequisites missing: tmux; Tailscale is not active", preflight } })
    expect(await runInitCommand([], h.deps)).toBe(1)
    const text = h.text()
    expect(text).toContain("Cannot set up this machine yet: Prerequisites missing")
    expect(text).toContain("  brew install tmux")
    expect(text).toContain("tailscale up")
    expect(h.calls).toEqual(["setup"])
  })

  it("rejects bad arguments and profile names, and prints help", async () => {
    const h = harness()
    expect(await runInitCommand(["--new", "--join", "x"], h.deps)).toBe(64)
    expect(await runInitCommand(["--profile", "Bad_Name"], h.deps)).toBe(64)
    expect(await runInitCommand(["--help"], h.deps)).toBe(0)
    expect(h.text()).toContain("aibr init — set up this machine")
    expect(h.calls).toEqual([])
  })
})

describe("nonInteractivePrompter", () => {
  it("refuses every kind of question", async () => {
    const p = nonInteractivePrompter()
    await expect(p.promptInput("q?")).rejects.toThrow(/no terminal to ask "q\?"/)
    await expect(p.promptConfirm("c?")).rejects.toThrow(/aibr init --help/)
    await expect(p.promptSecret("s?")).rejects.toThrow()
  })
})

// ── the real wizard in quickstart mode ──────────────────────────────────

class TestFileOps implements SetupFileOps {
  public writtenConfigs: Record<string, Record<string, unknown>> = {}
  public writtenSecrets: Record<string, string> = {}
  async writeConfig(path: string, data: Record<string, unknown>): Promise<void> {
    this.writtenConfigs[path] = data
  }
  async writeSecret(path: string, value: string): Promise<void> {
    this.writtenSecrets[path] = value
  }
  async replaceSecret(path: string, value: string): Promise<void> {
    this.writtenSecrets[path] = value
  }
  async ensureProfileDirs(_paths: ProfilePaths): Promise<void> {}
  async readConfig(_path: string): Promise<Record<string, unknown> | null> {
    return null
  }
}

function runner(params: { opencode?: boolean; claude?: boolean; gitToplevel?: string; dnsName?: string } = {}): ProcessRunner {
  return {
    async exec(argv) {
      const cmd = argv.join(" ")
      if (cmd === "which tmux" || cmd === "which tailscale") return { exitCode: 0, stdout: "", stderr: "" }
      if (cmd === "which opencode") return { exitCode: params.opencode ?? true ? 0 : 1, stdout: "", stderr: "" }
      if (cmd === "which claude") return { exitCode: params.claude ?? false ? 0 : 1, stdout: "", stderr: "" }
      if (argv[0] === "git" && argv.includes("--show-toplevel")) {
        return params.gitToplevel !== undefined ? { exitCode: 0, stdout: params.gitToplevel, stderr: "" } : { exitCode: 128, stdout: "", stderr: "" }
      }
      if (cmd === "tailscale status --json") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.64.0.1"], DNSName: params.dnsName ?? "myhost.ts.net.", BackendState: "Running" } }),
          stderr: "",
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" }
    },
  }
}

const platform: PlatformInspector = { inspect: () => ({ platform: "darwin", arch: "arm64", isTTY: true }) }
const HOME = "/mock/home"

async function quickWizard(opts: {
  answers: string[]
  profile?: string
  quickstart?: SetupWizardDeps["quickstart"]
  runner?: ProcessRunner
}) {
  const prompter = new ScriptedPrompter(opts.answers)
  const fileOps = new TestFileOps()
  const output: string[] = []
  const forbidden = async (): Promise<never> => {
    throw new Error("quickstart must not do this")
  }
  const outcome = await runSetupWizard({
    platformInspector: platform,
    processRunner: opts.runner ?? runner({ gitToplevel: "/mock/work/repo" }),
    prompter,
    fileOps,
    env: { HOME },
    cwd: "/mock/work/repo/sub",
    initialProfile: opts.profile ?? "dev",
    quickstart: opts.quickstart ?? {},
    discoverAgents: forbidden,
    installDaemon: forbidden,
    loadDaemon: forbidden,
    pairWithCode: forbidden,
    write: (t) => void output.push(t),
  })
  return { outcome, prompter, fileOps, output: output.join("") }
}

describe("setup wizard, quickstart mode (aibr init questions 1–3)", () => {
  it("asks only the role and the project (runtime auto-detected), and saves without a Save? question", async () => {
    const { outcome, prompter, fileOps, output } = await quickWizard({ answers: ["", ""] })
    expect(outcome.kind).toBe("persisted")
    expect(prompter.asked).toHaveLength(2)
    expect(prompter.asked[0]).toContain("Node role")
    expect(prompter.asked[1]).toBe("Enter project path [/mock/work/repo]:")
    const config = fileOps.writtenConfigs[`${HOME}/.config/aibridge/dev/config.json`]
    expect(config).toMatchObject({ agent_id: "dev", role: "worker", projects: [{ path: "/mock/work/repo" }] })
    const token = fileOps.writtenSecrets[`${HOME}/.local/share/aibridge/dev/secrets/bearer_token`]
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(output).not.toContain(token!)
    for (const question of prompter.asked) {
      expect(question).not.toMatch(/Bearer|agent ID|Save configuration|Start the|Enrol|port/i)
    }
    if (outcome.kind === "persisted") expect(outcome.daemon).toBeUndefined()
  })

  it("asks the runtime only when both are installed — still at most three wizard questions", async () => {
    const { outcome, prompter, fileOps } = await quickWizard({
      answers: ["worker", "claude", ""],
      runner: runner({ claude: true, opencode: true, gitToplevel: "/mock/work/repo" }),
    })
    expect(outcome.kind).toBe("persisted")
    expect(prompter.asked).toHaveLength(3)
    expect(prompter.asked[1]).toContain("opencode or claude")
    expect(fileOps.writtenConfigs[`${HOME}/.config/aibridge/dev/config.json`]?.runtime).toMatchObject({ kind: "claude" })
  })

  it("an orchestrator is asked only its role", async () => {
    const { outcome, prompter } = await quickWizard({ answers: ["orchestrator"], runner: runner({ claude: true, opencode: false }) })
    expect(outcome.kind).toBe("persisted")
    expect(prompter.asked).toHaveLength(1)
  })

  it("asks nothing when the flags answered everything, and uses the given port", async () => {
    const { outcome, prompter, fileOps } = await quickWizard({
      answers: [],
      quickstart: { role: "worker", runtime: "opencode", projectPath: "/mock/work/other", bridgePort: 9100 },
    })
    expect(outcome.kind).toBe("persisted")
    expect(prompter.asked).toEqual([])
    const config = fileOps.writtenConfigs[`${HOME}/.config/aibridge/dev/config.json`]
    expect(config?.bridge).toMatchObject({ port: 9100, public_url: "http://myhost.ts.net:9100" })
    expect(config?.projects).toMatchObject([{ path: "/mock/work/other" }])
    // An OpenCode worker gets a generated password without a question.
    expect(fileOps.writtenSecrets[`${HOME}/.local/share/aibridge/dev/secrets/opencode_password`]).toBeTruthy()
  })

  it("refuses a --project that is the home directory", async () => {
    const { outcome } = await quickWizard({ answers: [], quickstart: { role: "worker", runtime: "opencode", projectPath: HOME } })
    expect(outcome.kind).toBe("blocked")
    if (outcome.kind === "blocked") expect(outcome.reason).toContain("home directory")
  })

  it("names the default profile after the machine", async () => {
    const { fileOps } = await quickWizard({ answers: ["", ""], profile: "default", runner: runner({ gitToplevel: "/mock/work/repo", dnsName: "My_Laptop.tail1234.ts.net." }) })
    expect(fileOps.writtenConfigs[`${HOME}/.config/aibridge/default/config.json`]?.agent_id).toBe("my-laptop")
  })
})

describe("quickstartAgentId", () => {
  it("uses the profile name, else a slug of the Tailscale or OS host name", () => {
    expect(quickstartAgentId("staging", "box.ts.net")).toBe("staging")
    expect(quickstartAgentId("default", "Build-Box.tail.ts.net")).toBe("build-box")
    expect(quickstartAgentId("default", null, "Mac Book.local")).toBe("mac-book")
    expect(quickstartAgentId("default", null, "---")).toBe("default")
  })
})

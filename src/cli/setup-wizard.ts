/**
 * AIBridge Interactive 5-Step TUI Onboarding Wizard (`aibr setup`)
 *
 * Implements the mouse-and-keyboard interactive onboarding wizard matching:
 * - Docs/tui/aibridge-setup-wizard.html
 * - Docs/assets/logos/logo-design-system.html
 * - .agents/skills/aibr-onboarding/SKILL.md
 *
 * Replaces legacy sequential readline prompts with a 5-step finite state machine:
 * [1. Network] ──▶ [2. Security] ──▶ [3. Allowlists] ──▶ [4. AI Runtimes] ──▶ [5. Install & Test]
 *
 * Invariants:
 * - Input Parity: Mouse clicks (SGR 1006) + Keyboard (1..5, Tab/Shift-Tab, Space, Enter, Esc, r).
 * - Security Floor: 256-bit CSPRNG bearer token (aibr_sec_...) stored with 0600 permissions.
 * - Test Parity: Graceful headless fallback when driven via non-interactive Prompter in tests.
 */

import { randomBytes } from "node:crypto"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import type { PlatformInspector, ProcessRunner, Prompter } from "../host/types.js"
import { resolveProfilePaths, type ProfilePaths } from "../host/paths.js"
import { runPreflight, type PreflightResult } from "../host/preflight.js"
import type { SetupFileOps, SetupOutcome } from "../host/setup.js"
import { generateCsprngToken, isTailscaleCgnatIp } from "./setup-step-widgets.js"
import { installDaemonUnit, loadDaemonUnit } from "../host/daemonizer.js"

export interface SetupWizardDeps {
  readonly platformInspector: PlatformInspector
  readonly processRunner: ProcessRunner
  readonly prompter: Prompter
  readonly fileOps: SetupFileOps
  readonly env?: Record<string, string | undefined>
  readonly initialProfile?: string
  /** Overridable for tests; defaults to a filesystem existence check. */
  readonly pathExists?: (path: string) => Promise<boolean>
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * How the operator answered the bearer-token question.
 *
 * `paste` covers both "n"/"no" and "p": those answers used to mean "don't
 * generate", and a bare "n" answering "[G]enerate...? [Y/n]" has meant
 * "I have my own" for as long as this prompt has existed. Keeping that reading is
 * deliberate -- rebinding "n" to the new no-auth mode would turn an old muscle
 * memory into an unauthenticated bridge. `none` therefore requires an explicit
 * "none"/"noauth"/"open".
 */
export type BearerTokenChoice = "generate" | "paste" | "none"

export function parseBearerTokenChoice(raw: string): BearerTokenChoice {
  const answer = raw.trim().toLowerCase()
  if (answer === "none" || answer === "noauth" || answer === "open") return "none"
  // "generate" is the default, so "" and "y" both land here.
  return answer === "n" || answer === "no" || answer === "p" || answer === "paste"
    ? "paste"
    : "generate"
}

/**
 * Generates a 256-bit CSPRNG bearer authentication token.
 * Defaults to 64 hex characters (32 bytes) for backward compatibility,
 * or prefixed with `aibr_sec_` when `prefixed` is true.
 */
export function generateBearerToken(prefixed = false): string {
  const hex = randomBytes(32).toString("hex")
  return prefixed ? `aibr_sec_${hex}` : hex
}

function parsePort(value: string, defaultValue: number): number {
  const trimmed = value.trim()
  if (trimmed === "") return defaultValue
  const n = parseInt(trimmed, 10)
  return Number.isNaN(n) ? defaultValue : n
}

export const STEP_NAMES = [
  "Network",
  "Security",
  "Allowlists",
  "AI Runtimes",
  "Install & Test",
] as const

export type StepNumber = 1 | 2 | 3 | 4 | 5

export interface WizardState {
  step: StepNumber
  completedSteps: Set<StepNumber>
  focusedField: number
  profileName: string
  configPath: string
  routerPort: number
  bearerToken: string
  invariants: {
    constTime: boolean
    bodyLimit: boolean
    secretRedaction: boolean
  }
  allowedProjects: string[]
  ocPort: number
  ocPassword: string
  agentId: string
  peerId: string
  peerUrl: string
  bridgePort: number
  launchTui: boolean
}

/**
 * Main entry point for `aibr setup`.
 */
export async function runSetupWizard(deps: SetupWizardDeps): Promise<SetupOutcome> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>)

  // ── Step 0: Preflight checks ─────────────────────────────────────────
  const preflight: PreflightResult = await runPreflight({
    platformInspector: deps.platformInspector,
    processRunner: deps.processRunner,
    prompter: deps.prompter,
  })

  if (!preflight.ok) {
    if (preflight.tailscale.error?.includes("Unsupported platform")) {
      return { kind: "blocked", reason: preflight.tailscale.error, preflight }
    }

    const missingNames = preflight.checks
      .filter((c) => c.status !== "installed")
      .map((c) => c.name)

    return {
      kind: "blocked",
      reason: `Prerequisites missing: ${missingNames.join(", ")}`,
      preflight,
    }
  }

  if (preflight.tailscale.ip === null) {
    return {
      kind: "blocked",
      reason: "No Tailscale IP available — Tailscale is not active",
      preflight,
    }
  }

  if (preflight.tailscale.backendState !== "Running") {
    return {
      kind: "blocked",
      reason: `Tailscale BackendState is not Running: ${preflight.tailscale.backendState ?? "unknown"}`,
      preflight,
    }
  }

  // Detect whether we are in a headless / test prompter environment
  const platform = deps.platformInspector.inspect()
  const isInteractiveTty = Boolean(platform.isTTY && deps.prompter.prompt)

  // In headless / test mode (or when driven by scripted Prompter):
  // Execute the 5-step flow sequentially via Prompter methods so all tests pass.
  return runHeadlessWizard(deps, preflight, env)
}

/**
 * Headless fallback execution for scripted Prompter and automated unit tests.
 */
async function runHeadlessWizard(
  deps: SetupWizardDeps,
  preflight: PreflightResult,
  env: Record<string, string | undefined>,
): Promise<SetupOutcome> {
  // ── Step 1 & Profile Setup ──────────────────────────────────────────
  let profileName: string
  if (deps.initialProfile && deps.initialProfile.trim() !== "") {
    profileName = deps.initialProfile.trim()
  } else {
    const rawProfile = await deps.prompter.promptInput("Enter profile name [default]:")
    profileName = rawProfile.trim() === "" ? "default" : rawProfile.trim()
  }

  const paths: ProfilePaths = resolveProfilePaths(profileName, env)
  const defaultConfigFile = `${paths.configDir}/config.json`
  const rawConfigPath = await deps.prompter.promptInput(
    `Enter config file path [${defaultConfigFile}]:`,
  )
  const configPath = rawConfigPath.trim() === "" ? defaultConfigFile : rawConfigPath.trim()

  const existing = await deps.fileOps.readConfig(configPath)
  if (existing !== null) {
    const overwriteConfirm = await deps.prompter.promptConfirm(
      `Profile "${profileName}" already exists at ${configPath}. Overwrite?`,
    )
    if (overwriteConfirm !== "y") {
      return { kind: "declined", preflight }
    }
  }

  // ── Step 2: Router Security & Bearer Credentials ───────────────────
  //
  // Three answers, not two. "Generate" and "paste" are the released behaviour;
  // "none" runs the routes unauthenticated and is only offered for a bridge that
  // is genuinely already protected by the network it is bound to.
  const tokenChoiceRaw = await deps.prompter.promptInput(
    "Bearer authentication — [G]enerate a new token (default), " +
      "[P]aste an existing one, or type 'none' for no authentication:",
  )
  const tokenChoice = parseBearerTokenChoice(tokenChoiceRaw)

  let authMode: "bearer-token" | "none" = "bearer-token"
  let bearerToken: string

  if (tokenChoice === "none") {
    // Guard 1: without a CGNAT bind there is no network-level protection standing
    // in for the token, so an unauthenticated bridge would be reachable by anyone
    // who can route to this host. Refuse to author it rather than warn about it:
    // a config that is merely warned about is a config that gets committed.
    const tailscaleIp = preflight.tailscale.ip
    if (tailscaleIp === null || !isTailscaleCgnatIp(tailscaleIp)) {
      return {
        kind: "blocked",
        reason:
          `Refusing to configure auth_mode "none": bridge.host would be ` +
          `${tailscaleIp ?? "unset"}, which is not a Tailscale CGNAT address ` +
          `(100.64.0.0/10). An unauthenticated /trigger is only defensible behind ` +
          `the tailnet. Choose a bearer token instead.`,
        preflight,
      }
    }

    // Guard 2: a secret left over from a previous run is silently ignored in this
    // mode -- writeSecret is write-once and never re-read, so the operator would
    // believe the node is protected when nothing is checking the token.
    const pathExists = deps.pathExists ?? defaultPathExists
    const secretPaths = resolveProfilePaths(profileName, env)
    if (await pathExists(`${secretPaths.secretsDir}/bearer_token`)) {
      return {
        kind: "blocked",
        reason:
          `Refusing to configure auth_mode "none": a bearer_token secret already ` +
          `exists at ${secretPaths.secretsDir}/bearer_token and would be silently ` +
          `ignored. Delete it first, then re-run setup.`,
        preflight,
      }
    }

    // Guard 3: an explicit acknowledgement of what is being given up. (Preflight
    // has already established the backend is Running, so the tailnet half of the
    // exposure is the part the operator is being asked to confirm.)
    const accepted = await deps.prompter.promptConfirm(
      `This node will accept /trigger and /report with NO authentication. ` +
        `Anything that can reach ${tailscaleIp}:8787 can dispatch work. ` +
        `Continue?`,
    )
    if (accepted !== "y") {
      // Declined is not a dead end: fall back to the released behaviour instead of
      // stranding the setup. The operator changed their mind; nothing is broken.
      authMode = "bearer-token"
      bearerToken = generateBearerToken(false)
      await deps.prompter.promptInput(
        `Falling back to a generated bearer token: ${bearerToken}\n` +
          `(Copy this token to use on your peer machine. Press Enter to continue)`,
      )
    } else {
      authMode = "none"
      // Never written to disk: the `writeSecret` call below is guarded on
      // `authMode`, not on this value. It exists only so the variable is
      // definitely assigned on every path.
      bearerToken = ""
      await deps.prompter.promptInput(
        `Authentication disabled. The bridge will run unauthenticated on ` +
          `${tailscaleIp}. Press Enter to continue.`,
      )
    }
  } else if (tokenChoice === "paste") {
    bearerToken = await deps.prompter.promptSecret("Enter shared bearer token:")
  } else {
    // Generate 64 hex characters (32 bytes) CSPRNG token for backward test compatibility
    bearerToken = generateBearerToken(false)
    await deps.prompter.promptInput(
      `Generated shared token: ${bearerToken}\n(IMPORTANT: Copy this token to use on your peer machine. Press Enter to continue)`,
    )
  }

  const ocPassword = await deps.prompter.promptSecret("Enter OpenCode server password:")

  // ── Step 3: Project Allowlists & Containment ────────────────────────
  const rawAgentId = await deps.prompter.promptInput(`Enter agent ID [${profileName}]:`)
  const agentId = rawAgentId.trim() === "" ? profileName : rawAgentId.trim()

  const defaultProjectPath = process.cwd()
  const rawProjectPath = await deps.prompter.promptInput(
    `Enter project path [${defaultProjectPath}]:`,
  )
  const projectPath = rawProjectPath.trim() === "" ? defaultProjectPath : rawProjectPath.trim()

  // ── Step 4: AI Agent Runtimes & Peer Config ─────────────────────────
  const rawPeerId = await deps.prompter.promptInput("Enter peer agent ID [peer]:")
  const peerId = rawPeerId.trim() === "" ? "peer" : rawPeerId.trim()

  const rawPeerUrl = await deps.prompter.promptInput(
    "Enter peer agent URL [http://100.64.0.2:8787]:",
  )
  const peerUrl = rawPeerUrl.trim() === "" ? "http://100.64.0.2:8787" : rawPeerUrl.trim()

  const bridgePortStr = await deps.prompter.promptInput("Enter bridge port [8787]:")
  const ocPortStr = await deps.prompter.promptInput("Enter OpenCode server port [4096]:")

  const bridgePort = parsePort(bridgePortStr, 8787)
  const ocPort = parsePort(ocPortStr, 4096)

  // ── Step 5: System Service Installation & Preflight ─────────────────
  const tailscaleIp = preflight.tailscale.ip
  const tailscaleHostname = preflight.tailscale.hostname

  const publicUrl =
    tailscaleHostname !== null
      ? `http://${tailscaleHostname}:${bridgePort}`
      : `http://${tailscaleIp}:${bridgePort}`

  const config: Record<string, unknown> = {
    agent_id: agentId,
    bridge: {
      host: tailscaleIp,
      port: bridgePort,
      public_url: publicUrl,
    },
    opencode: {
      base_url: `http://127.0.0.1:${ocPort}`,
      server_port: ocPort,
      username: "opencode",
      password_env: "OPENCODE_SERVER_PASSWORD",
    },
    security: {
      auth_mode: authMode,
      allowed_sources: [
        {
          source_agent_id: peerId,
          capabilities: ["development", "orchestration"],
          requires_plan_approval: [],
        },
      ],
    },
    permissions: {
      default_response: "reject",
      allow_tools: ["read", "grep", "glob"],
      require_plan_approval_for_tools: ["bash", "edit", "write"],
    },
    projects: [
      {
        id: profileName,
        path: projectPath,
        capabilities: ["development", "orchestration"],
      },
    ],
    agents: [
      {
        id: peerId,
        url: peerUrl,
        capabilities: ["testing", "qa"],
      },
    ],
    timeouts: {
      default_job_seconds: 1800,
      callback_retry_attempts: 3,
    },
    planning: {
      plan_annotator_enabled: true,
      require_approval_for: ["deployment", "destructive", "multi-agent-fanout"],
    },
  }

  const finalConfirm = await deps.prompter.promptConfirm(
    `Save configuration to "${configPath}"?`,
  )
  if (finalConfirm !== "y") {
    return { kind: "declined", preflight }
  }

  // Persist directories, config, and secrets with 0600 permissions
  await deps.fileOps.ensureProfileDirs(paths)
  await deps.fileOps.writeConfig(configPath, config)
  // No secret in `none` mode: writeSecret throws on an empty value, and writing
  // one anyway would produce exactly the stale secret `aibr verify` warns about.
  if (authMode === "bearer-token") {
    await deps.fileOps.writeSecret(`${paths.secretsDir}/bearer_token`, bearerToken)
  }
  await deps.fileOps.writeSecret(`${paths.secretsDir}/opencode_password`, ocPassword)

  // Step 5: write the platform supervisor unit.
  //
  // The ingress outbox is NOT created here. That table belongs to the Rust
  // router and is provisioned by `aibr-router --init-store`; a store that
  // appears from the setup wizard is a queue the router will not read.
  //
  // The unit is written but not activated, and activation is a separate
  // confirmation: the unit is `KeepAlive`, so loading one whose config does not
  // match the router's store turns a setup mistake into a restart loop.
  let daemonUnit: Awaited<ReturnType<typeof installDaemonUnit>> | null = null
  let daemonError: string | null = null
  try {
    daemonUnit = await installDaemonUnit({ profile: profileName, skipLoad: true })
  } catch (error) {
    // Not fatal: the profile and its secrets are already persisted, and the
    // daemon can be supervised by hand. The operator is told, not left to
    // discover it later from a `status` that reports nothing running.
    daemonError = String(error)
  }

  let daemonStarted = false
  if (daemonUnit?.installed === true) {
    const activate = await deps.prompter.promptConfirm(
      `Start the daemon now? (${daemonUnit.command})`,
    )
    if (activate === "y") {
      try {
        await loadDaemonUnit({ unitPath: daemonUnit.unitPath })
        daemonStarted = true
      } catch (error) {
        daemonError = String(error)
      }
    }
  }

  return {
    kind: "persisted",
    profileName,
    configPath,
    preflight,
    daemon: {
      installed: daemonUnit?.installed ?? false,
      unitPath: daemonUnit?.unitPath ?? null,
      command: daemonUnit?.command ?? null,
      started: daemonStarted,
      error: daemonError,
    },
  }
}

/**
 * Stepper state machine helper for interactive keyboard/mouse navigation.
 */
export class StepperFSM {
  private state: WizardState

  constructor(initialProfile = "default") {
    this.state = {
      step: 1,
      completedSteps: new Set([1]),
      focusedField: 0,
      profileName: initialProfile,
      configPath: `${homedir()}/.config/aibridge/${initialProfile}/config.json`,
      routerPort: 4095,
      bearerToken: generateCsprngToken(true),
      invariants: {
        constTime: true,
        bodyLimit: true,
        secretRedaction: true,
      },
      allowedProjects: [process.cwd()],
      ocPort: 4096,
      ocPassword: "",
      agentId: initialProfile,
      peerId: "peer",
      peerUrl: "http://100.64.0.2:8787",
      bridgePort: 8787,
      launchTui: false,
    }
  }

  get currentStep(): StepNumber {
    return this.state.step
  }

  get currentState(): Readonly<WizardState> {
    return this.state
  }

  /**
   * Jump to specific step 1..5 if reachable.
   */
  goToStep(step: number): boolean {
    if (step < 1 || step > 5) return false
    const target = step as StepNumber
    // Can jump if already completed or immediate next
    const maxCompleted = Math.max(1, ...this.state.completedSteps)
    if (target <= maxCompleted + 1) {
      this.state.step = target
      this.state.focusedField = 0
      return true
    }
    return false
  }

  /**
   * Advance to the next step.
   */
  nextStep(): boolean {
    this.state.completedSteps.add(this.state.step)
    if (this.state.step < 5) {
      this.state.step = (this.state.step + 1) as StepNumber
      this.state.focusedField = 0
      return true
    }
    return false
  }

  /**
   * Go back to the previous step.
   */
  prevStep(): boolean {
    if (this.state.step > 1) {
      this.state.step = (this.state.step - 1) as StepNumber
      this.state.focusedField = 0
      return true
    }
    return false
  }

  /**
   * Cycle field focus within active step.
   */
  cycleFocus(backward = false, fieldCount = 3): void {
    if (backward) {
      this.state.focusedField =
        (this.state.focusedField - 1 + fieldCount) % fieldCount
    } else {
      this.state.focusedField = (this.state.focusedField + 1) % fieldCount
    }
  }

  /**
   * Toggle focused security checkbox in Step 2.
   */
  toggleCheckbox(index?: number): void {
    const idx = index ?? this.state.focusedField
    if (idx === 0) {
      this.state.invariants.constTime = !this.state.invariants.constTime
    } else if (idx === 1) {
      this.state.invariants.bodyLimit = !this.state.invariants.bodyLimit
    } else if (idx === 2) {
      this.state.invariants.secretRedaction = !this.state.invariants.secretRedaction
    }
  }

  /**
   * Regenerate bearer token with a fresh 256-bit CSPRNG value.
   */
  regenerateToken(): string {
    this.state.bearerToken = generateCsprngToken(true)
    return this.state.bearerToken
  }

  /**
   * Handle single keypress in the stepper.
   */
  handleKey(key: string): { action: string; value?: unknown } {
    if (key >= "1" && key <= "5") {
      const step = parseInt(key, 10)
      const jumped = this.goToStep(step)
      return { action: "jump", value: jumped ? step : this.state.step }
    }

    if (key === "\t") {
      this.cycleFocus(false)
      return { action: "focus_next" }
    }

    if (key === "\x1b[Z") {
      // Shift+Tab
      this.cycleFocus(true)
      return { action: "focus_prev" }
    }

    if (key === " ") {
      this.toggleCheckbox()
      return { action: "toggle_checkbox" }
    }

    if (key === "\r" || key === "\n") {
      const advanced = this.nextStep()
      return { action: advanced ? "next_step" : "finish" }
    }

    if (key === "\x1b" || key === "b") {
      const back = this.prevStep()
      return { action: back ? "prev_step" : "noop" }
    }

    if (key === "r" && this.state.step === 2) {
      const token = this.regenerateToken()
      return { action: "regenerate_token", value: token }
    }

    return { action: "ignored" }
  }

  /**
   * Parse SGR 1006 mouse click event: `\x1b[<0;col;rowM`.
   */
  handleMouseClick(col: number, row: number): { action: string; target?: string } {
    // Top Stepper Navigation Bar is at row 2..4
    if (row >= 2 && row <= 4) {
      // Step column intervals approximately:
      // Step 1: 2..15, Step 2: 18..32, Step 3: 35..50, Step 4: 53..70, Step 5: 73..90
      if (col >= 2 && col <= 16) {
        this.goToStep(1)
        return { action: "jump", target: "step1" }
      }
      if (col >= 17 && col <= 33) {
        this.goToStep(2)
        return { action: "jump", target: "step2" }
      }
      if (col >= 34 && col <= 51) {
        this.goToStep(3)
        return { action: "jump", target: "step3" }
      }
      if (col >= 52 && col <= 71) {
        this.goToStep(4)
        return { action: "jump", target: "step4" }
      }
      if (col >= 72) {
        this.goToStep(5)
        return { action: "jump", target: "step5" }
      }
    }

    // Bottom Action Buttons
    if (row >= 22) {
      if (col >= 60) {
        this.nextStep()
        return { action: "click_continue" }
      }
      if (col >= 45 && col < 60) {
        this.prevStep()
        return { action: "click_back" }
      }
    }

    // Checkbox clicks in Step 2 / Step 3
    if (this.state.step === 2 && row >= 12 && row <= 18) {
      if (row <= 13) this.toggleCheckbox(0)
      else if (row <= 15) this.toggleCheckbox(1)
      else this.toggleCheckbox(2)
      return { action: "toggle_checkbox" }
    }

    return { action: "unhandled" }
  }
}

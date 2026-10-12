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
 * - Discovery Proposes, The Operator Enrols: Step 4 enumerates the tailnet and PRINTS it,
 *   but nothing reaches the config until the operator names a peer and its capabilities.
 *   `reachable` is reachability, never trust -- see `REACHABILITY_NOT_AUTHENTICATION`.
 */

import { randomBytes } from "node:crypto"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import type { PlatformInspector, ProcessRunner, Prompter } from "../host/types.js"
import { resolveProfilePaths, type ProfilePaths } from "../host/paths.js"
import { runPreflight, type PreflightResult } from "../host/preflight.js"
import type { SetupFileOps, SetupOutcome } from "../host/setup.js"
import {
  generateCsprngToken,
  isTailscaleCgnatIp,
  probeDiscoveredAgents,
  renderAgentDiscoveryProbe,
  type AgentDiscoveryDeps,
  type AgentDiscoveryResult,
  type DiscoveredAgent,
} from "./setup-step-widgets.js"
import {
  isCredentialShapedAgentId,
  scrubCredentialShapedAgentId,
} from "./discovery-safety.js"
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
  /**
   * Overridable for tests; defaults to `probeDiscoveredAgents`.
   *
   * An override exists because discovery has two effects in a unit test — it shells
   * out to `tailscale` and it opens HTTP to every peer — neither of which a scripted
   * `Prompter` can absorb. A test injects a fixed `AgentDiscoveryResult` here and gets
   * the same Step 4 the real probe would have produced.
   */
  readonly discoverAgents?: (deps?: AgentDiscoveryDeps) => Promise<AgentDiscoveryResult>
  /**
   * Where the wizard's own narration goes (the discovery table, the
   * reachability notice, the enrolment explanations).
   *
   * Separate from `prompter` on purpose: a report is not a question, and routing
   * it through `promptInput` would consume an answer from a scripted prompter
   * and make every existing queue in the suite mean something different. Tests
   * pass a collector here and keep their `Prompter` queue as it was.
   */
  readonly write?: (text: string) => void
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

// ── Step 4: discovery-driven, explicitly-enrolled peer configuration ───────

/** The legacy default, kept because the manual fallback must keep working. */
export const DEFAULT_PEER_AGENT_ID = "peer"

/** The legacy default, kept for the same reason. */
export const DEFAULT_PEER_BRIDGE_URL = "http://100.64.0.2:8787"

/**
 * Shown under the discovery table, in the operator's terminal, every time.
 *
 * REACHABILITY IS NOT AUTHENTICATION. `Docs/security/milestone-0-threat-model.md`
 * is explicit that "a Tailscale connection provides reachability, not user
 * identity, enrollment, project membership, or approval", and `src/mesh/` repeats
 * it wherever a peer is admitted. `renderAgentDiscoveryProbe` badges a peer
 * `✔ REACHABLE`, which reads as a green light and is the single most
 * misreadable string on this screen — so the sentence that de-fuses it travels
 * with the table rather than living in a comment nobody reads at the terminal.
 *
 * Trust on this mesh is ed25519 node keys plus enrollment codes plus peer pins
 * (`src/mesh/identity/`). What this step writes is a config file: a routing and
 * authorization convenience the operator is authoring by hand, and nothing more.
 */
export const REACHABILITY_NOT_AUTHENTICATION =
  "Reachability is not authentication: 'REACHABLE' means something answered HTTP on that " +
  "address, not that the node is an AIBridge bridge, and not that it is trusted. A Tailscale " +
  "connection provides reachability, not identity, enrolment, project membership, or approval. " +
  "Trust is established with ed25519 node keys, enrollment codes, and peer pins " +
  "(src/mesh/identity/). Discovery enrols nothing: enrolling a peer below only writes this " +
  "node's own config."

/**
 * Capabilities used when a peer advertised none AND the operator typed none.
 *
 * The `allowed_sources` list the released wizard always wrote, so an operator
 * who answers two prompts with Enter lands on the behaviour they had before
 * this step existed. It is a floor, not a grant: `development` and
 * `orchestration` are the strings this node already treated as inbound work,
 * and the operator still had to pick a peer to get here.
 */
const DEFAULT_ENROLLED_PEER_CAPABILITIES = ["development", "orchestration"] as const

/**
 * Answers to the "which peer do you want to enrol" question.
 *
 * `skip` is the load-bearing one and it is always available, including as the
 * empty answer: a setup that enrols a peer nobody chose is worse than a setup
 * that enrols nobody, so the default outcome of being unsure is "nothing".
 */
export type PeerEnrolmentChoice =
  | { readonly kind: "skip" }
  | { readonly kind: "manual" }
  | { readonly kind: "agent"; readonly agent: DiscoveredAgent }

/**
 * Parse the operator's answer to the peer-selection prompt.
 *
 * Accepts the row NUMBER as printed, the hostname, or the peer's IP, because
 * an operator looking at a table reads whichever of the three their terminal
 * shows most clearly. Anything unrecognised is `skip` rather than a
 * re-prompt loop: a wizard that cannot parse an answer should not trap the
 * operator in it, and "nothing is enrolled" is the safe reading of "I did not
 * mean any of those".
 *
 * Exported for tests because the parsing is the security-relevant part: it is
 * the boundary between "the operator named a peer" and "the wizard chose one".
 */
export function parsePeerSelection(raw: string, agents: readonly DiscoveredAgent[]): PeerEnrolmentChoice {
  const answer = raw.trim().toLowerCase()
  if (answer === "" || answer === "s" || answer === "skip" || answer === "n" || answer === "no") {
    return { kind: "skip" }
  }
  if (answer === "m" || answer === "manual") return { kind: "manual" }

  // 1-based, as printed in the table.
  const index = Number.parseInt(answer, 10)
  if (/^\d+$/.test(answer)) {
    const agent = agents[index - 1]
    return agent === undefined ? { kind: "skip" } : { kind: "agent", agent }
  }

  const byName = agents.find(
    (agent) =>
      agent.hostname.toLowerCase() === answer || agent.ip.toLowerCase() === answer,
  )
  return byName === undefined ? { kind: "skip" } : { kind: "agent", agent: byName }
}

/**
 * Capabilities the operator chose, given what the peer advertised.
 *
 * The advertised list is offered as the default rather than taken, because a
 * `/health` body is the peer's own claim about itself and `src/mesh/` treats
 * such claims as advertisement, never as authorization. Typed capabilities are
 * trimmed, de-duplicated, and kept in the operator's order: the list is read
 * back in a diff, and sorting an operator's deliberate ordering would hide it.
 *
 * An empty or omitted answer means "yes, the advertised list" — but ONLY when
 * the peer advertised something. A peer that said nothing is not a peer the
 * operator can consent to on its behalf, so the fallback is the wizard's own
 * conservative default and the prompt has already told them that.
 */
export function resolveEnrolmentCapabilities(raw: string, advertised: readonly string[]): string[] {
  const typed = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")

  const deduped = [...new Set(typed)]
  if (deduped.length > 0) return deduped
  if (advertised.length > 0) return [...advertised]
  return [...DEFAULT_ENROLLED_PEER_CAPABILITIES]
}

/**
 * A peer the operator has explicitly chosen to enrol, ready to be written into
 * BOTH halves of the config.
 *
 * `id` and `capabilities` are shared by `agents[]` and
 * `security.allowed_sources[]` because `assertSourceAuthorized`
 * (`src/security/source-authorization.ts`) authorizes on `source_agent_id` AND
 * capability membership, and `/trigger` answers 403 to a source that is in
 * `agents[]` but missing from `allowed_sources[]`. One object, two arrays: the
 * parallel arrays cannot drift because there is only one copy of the truth.
 */
export interface EnrolledPeer {
  readonly id: string
  readonly url: string
  readonly capabilities: readonly string[]
}

/**
 * `SetupWizardDeps` with the output channel resolved.
 *
 * A separate type so the Step 4 helpers cannot forget the narration: they take
 * a `WizardIo` and therefore cannot be called without somewhere to write the
 * reachability notice to.
 */
export type WizardIo = SetupWizardDeps & {
  readonly write: (text: string) => void
}

/**
 * Default narration sink.
 *
 * stdout, because this is what the operator is meant to read, and because the
 * released wizard already narrates over the same channel via `promptInput`.
 * Errors are swallowed: a closed pipe or a redirected descriptor must not turn
 * a report into a failed setup.
 */
function writeToStdout(text: string): void {
  try {
    process.stdout.write(text)
  } catch {
    // Nothing useful to do; the setup continues and the prompter still works.
  }
}

/**
 * The probe result with credential-shaped ids removed.
 *
 * Applied BEFORE the render and before the selection prompt, so neither the
 * table nor the enrolment confirmation can carry one, and so a scrubbed id
 * cannot become a configured agent id.
 *
 * The rule lives in `./discovery-safety.js` and is shared with `aibr discover`.
 * It was duplicated here rather than imported, on the reasoning that the wizard
 * should not depend on the command layer to render a table safely — which is
 * true, and is also why the import points one level down at a leaf module that
 * depends on nothing, rather than at `src/cli.ts`.
 */
function sanitizeDiscoveryResult(result: AgentDiscoveryResult): AgentDiscoveryResult {
  if (!result.agents.some((agent) => isCredentialShapedAgentId(agent.agentId))) {
    return result
  }
  return {
    ...result,
    agents: result.agents.map((agent) => ({
      ...agent,
      agentId: scrubCredentialShapedAgentId(agent.agentId),
    })),
  }
}

/**
 * Run the tailnet probe for the wizard, wiring the wizard's own
 * `ProcessRunner` and labelling peers the config already lists.
 *
 * THE `enrolledAgentIds` ARE AN INPUT FOR LABELS ONLY. They decide which rows
 * read `✔ ENROLLED`, and nothing else: `probeDiscoveredAgents` is pure by
 * construction and the wizard's next statement is a prompt, not a write. The
 * ids come from `existing` — the config this run is about to overwrite — so
 * the operator sees which peer they are replacing rather than a table that
 * claims nothing is enrolled.
 *
 * The result is sanitized on the way out, so nothing downstream of this
 * function — the render, the roster, the selection prompt, the config — can
 * carry a `tskey-` credential the remote `/health` handed us.
 */
async function runSetupDiscovery(
  deps: WizardIo,
  existing: Record<string, unknown> | null,
): Promise<AgentDiscoveryResult> {
  const discover = deps.discoverAgents ?? probeDiscoveredAgents
  const result = await discover({
    processRunner: deps.processRunner,
    enrolledAgentIds: enrolledAgentIdsFrom(existing),
  })
  return sanitizeDiscoveryResult(result)
}

/** `agents[].id` from a config object, tolerating anything that is not one. */
function enrolledAgentIdsFrom(existing: Record<string, unknown> | null): readonly string[] {
  if (existing === null) return []
  const agents = existing.agents
  if (!Array.isArray(agents)) return []
  return agents
    .map((entry) => (typeof (entry as { id?: unknown })?.id === "string" ? (entry as { id: string }).id : null))
    .filter((id): id is string => id !== null)
}

/**
 * The numbered roster the selection prompt refers to.
 *
 * `renderAgentDiscoveryProbe` already draws every peer with its address,
 * reachability, `agent_id`, capability count and enrolment badge; this adds
 * only what a selection prompt needs and the table does not carry — the number
 * and the coordinates a human can check against the machine in front of them.
 *
 * Unreachable rows are kept and are selectable. A peer that is down is still a
 * peer the operator recognises, and refusing to let them enrol it by hand would
 * push them back to the typo-prone `100.64.0.2` default.
 */
function renderPeerRoster(agents: readonly DiscoveredAgent[]): string {
  const lines = ["Peers on this tailnet (discovery proposes; it enrols nothing):"]
  agents.forEach((agent, index) => {
    const identity = agent.agentId ?? "did not identify itself"
    const state = agent.reachable ? "answered /health" : "no answer on /health"
    const claimed =
      agent.capabilities.length > 0 ? agent.capabilities.join(", ") : "no capabilities advertised"
    lines.push(
      `  ${index + 1}) ${agent.hostname} (${agent.ip}) — ${state}; agent_id: ${identity}; ` +
        `advertises: ${claimed}${agent.enrolled ? "; already enrolled here" : ""}`,
    )
  })
  return lines.join("\n")
}

/**
 * The released manual prompts, unchanged: peer agent ID, then peer agent URL,
 * with `peer` and `http://100.64.0.2:8787` as the defaults.
 *
 * Kept because a setup run has to survive a tailnet that cannot be enumerated —
 * before `tailscale up`, inside a CI container, or with an injected prompter in
 * a test. The defaults are the released ones and the defaults are wrong more
 * often than not, which is why this is the fallback and not the default path.
 *
 * Capabilities are NOT asked for here: the released prompts did not ask, and
 * adding one would change every existing scripted queue for a path whose whole
 * point is to behave as it did. The wizard's conservative default is used.
 */
async function promptManualPeer(deps: WizardIo): Promise<EnrolledPeer> {
  const rawPeerId = await deps.prompter.promptInput(
    `Enter peer agent ID [${DEFAULT_PEER_AGENT_ID}]:`,
  )
  const peerId = rawPeerId.trim() === "" ? DEFAULT_PEER_AGENT_ID : rawPeerId.trim()

  const rawPeerUrl = await deps.prompter.promptInput(
    `Enter peer agent URL [${DEFAULT_PEER_BRIDGE_URL}]:`,
  )
  const peerUrl = rawPeerUrl.trim() === "" ? DEFAULT_PEER_BRIDGE_URL : rawPeerUrl.trim()

  return {
    id: peerId,
    url: peerUrl,
    capabilities: [...DEFAULT_ENROLLED_PEER_CAPABILITIES],
  }
}

/**
 * Enrol the peer the operator picked, after asking for the two things discovery
 * cannot supply on its own: an identity to enrol it under, and the capabilities
 * it is allowed to have.
 *
 * Returns `null` when the operator declines, and `null` is a first-class
 * outcome rather than an error: it is what "Enrol nobody" means downstream, and
 * both parallel arrays are written empty.
 */
async function enrolDiscoveredPeer(
  deps: WizardIo,
  agent: DiscoveredAgent,
): Promise<EnrolledPeer | null> {
  let peerId: string

  if (agent.agentId === null) {
    // ANSWERED BUT DID NOT IDENTIFY ITSELF. `reachable` here means a process
    // answered an unauthenticated port on that address — anything on the
    // tailnet can do that. There is nothing to enrol under, so the operator
    // types it, and the copy says why rather than presenting an empty field.
    deps.write(
      `\n${agent.hostname} (${agent.ip}) answered /health but did not say which agent it is. ` +
        `Answering is not identifying: type the agent ID to enrol this peer as, out of band ` +
        `from whoever owns that machine.\n`,
    )
    const typed = await deps.prompter.promptInput(
      `Agent ID for ${agent.hostname} (Enter to enrol nobody):`,
    )
    peerId = typed.trim()
    if (peerId === "") {
      deps.write("No agent ID given. Nothing was enrolled.\n")
      return null
    }
  } else {
    peerId = agent.agentId
    // A self-reported id is a claim, not a verified identity, and the operator
    // is the one who can check it against the machine in front of them.
    deps.write(
      `\n${agent.hostname} (${agent.ip}) says its agent_id is "${peerId}". ` +
        `That is the peer's own claim — check it against the machine you mean to enrol, ` +
        `then confirm.\n`,
    )
  }

  const advertised = agent.capabilities
  const advertisedLabel = advertised.length > 0 ? advertised.join(", ") : "nothing"
  const capabilitiesRaw = await deps.prompter.promptInput(
    `Capabilities to grant ${peerId} — comma-separated, advertised: ${advertisedLabel} ` +
      `(Enter to use the advertised list):`,
  )
  const capabilities = resolveEnrolmentCapabilities(capabilitiesRaw, advertised)

  const confirm = await deps.prompter.promptConfirm(
    `Enrol ${peerId} at ${agent.bridgeUrl} with capabilities [${capabilities.join(", ")}]? ` +
      `This writes agents[] and security.allowed_sources[] with the same id and capabilities.`,
  )
  if (confirm !== "y") {
    deps.write("Declined. Nothing was enrolled.\n")
    return null
  }

  return { id: peerId, url: agent.bridgeUrl, capabilities }
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
  const io: WizardIo = { ...deps, write: deps.write ?? writeToStdout }

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

  // ── Step 4: Tailnet Discovery & Explicit Peer Enrolment ─────────────
  //
  // DISCOVERY NEVER ENROLLS — IT ONLY PROPOSES. Everything in this block
  // either reports or asks. The only statements that put a peer id into the
  // config live inside a branch guarded by an answer the operator gave, so
  // there is no path from "a peer answered" to "a peer is enrolled". The
  // released wizard's failure mode — a hardcoded `http://100.64.0.2:8787`
  // default that rots as machines change, and an operator who types Enter
  // into two prompts and gets a peer enrolled — has no equivalent here.
  //
  // `reachable` from the probe is reachability. It is printed as such, and
  // `REACHABILITY_NOT_AUTHENTICATION` goes out with it on every run.
  const discovery = await runSetupDiscovery(io, existing)
  io.write(renderAgentDiscoveryProbe(discovery) + "\n")
  io.write(REACHABILITY_NOT_AUTHENTICATION + "\n\n")

  let enrolledPeer: EnrolledPeer | null = null

  if (discovery.agents.length === 0) {
    // Empty tailnet, no daemon, a setup run before Tailscale was joined, or a
    // test. All of them land here, and all of them must still be able to
    // finish: the manual prompts are the released path, kept verbatim.
    io.write(
      `No peers were discovered on this tailnet. Nothing is enrolled by discovery ` +
        `and nothing will be enrolled without you naming it below.\n\n`,
    )
    enrolledPeer = await promptManualPeer(io)
  } else {
    io.write(renderPeerRoster(discovery.agents) + "\n")
    const rawSelection = await deps.prompter.promptInput(
      `Enrol a peer by number, hostname, or IP (Enter = enrol nobody, ` +
        `m = enter a peer by hand):`,
    )
    const selection = parsePeerSelection(rawSelection, discovery.agents)

    if (selection.kind === "skip") {
      io.write(
        `No peer selected. agents[] and security.allowed_sources[] will both be left ` +
          `empty; this node will not accept /trigger from anyone and cannot dispatch to ` +
          `a peer. Edit the config later, or re-run setup, to change that.\n`,
      )
    } else if (selection.kind === "manual") {
      enrolledPeer = await promptManualPeer(io)
    } else {
      enrolledPeer = await enrolDiscoveredPeer(io, selection.agent)
    }
  }

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
      // THE TWO ARRAYS MUST AGREE, AND THEY ARE BUILT FROM ONE OBJECT.
      //
      // `assertSourceAuthorized` authorizes on `source_agent_id` AND capability
      // membership, and `/trigger` answers 403 to a source that is in `agents[]`
      // but absent from `allowed_sources[]`. The released wizard wrote two
      // separately-typed ids and two DIFFERENT capability lists ("development",
      // "orchestration" inbound; "testing", "qa" outbound) — a config in which
      // the two halves described different grants for the same peer, which is
      // exactly the drift `/trigger` refuses. Both entries now come from the
      // single `enrolledPeer`, and both arrays are empty when nothing was
      // enrolled, so "skip" leaves them consistent rather than half-written.
      allowed_sources:
        enrolledPeer === null
          ? []
          : [
              {
                source_agent_id: enrolledPeer.id,
                capabilities: [...enrolledPeer.capabilities],
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
    agents:
      enrolledPeer === null
        ? []
        : [
            {
              id: enrolledPeer.id,
              url: enrolledPeer.url,
              capabilities: [...enrolledPeer.capabilities],
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

/**
 * AIBridge onboarding wizard (`aibr setup`).
 *
 * A sequential line-prompt flow driven through an injected `Prompter`. It is the
 * flow every `aibr setup` run executes, interactive terminal or scripted test
 * alike. (`StepperFSM` at the bottom of this file models a keyboard/mouse
 * stepper from Docs/tui/aibridge-setup-wizard.html; it is retained and unit
 * tested, but `runSetupWizard` does not drive it.)
 *
 * Flow:
 *   profile → (existing profile? "Update existing profile?") → node role →
 *   runtime (worker/both) → role-aware preflight → bearer token → OpenCode
 *   password (opencode runtime only) → agent id → project path → tailnet
 *   discovery & explicit peer enrolment → ports (`--advanced` only) → save →
 *   supervisor unit (not for orchestrators).
 *
 * Invariants:
 * - Security Floor: 256-bit CSPRNG bearer token stored with 0600 permissions.
 * - Re-running setup is an UPDATE: every existing value is the default, and the
 *   bearer token and OpenCode password are kept unless the operator explicitly
 *   asks for new ones. Silently rotating a token breaks every peer with a 401.
 * - Discovery Proposes, The Operator Enrols: the discovery step enumerates the
 *   tailnet and PRINTS it, but nothing reaches the config until the operator names
 *   a peer and its capabilities. `reachable` is reachability, never trust -- see
 *   `REACHABILITY_NOT_AUTHENTICATION`.
 * - auth_mode "none" is guarded (CGNAT bind, no stale secret, explicit consent).
 */

import { randomBytes } from "node:crypto"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, resolve as resolvePath } from "node:path"
import type { PlatformInspector, ProcessRunner, Prompter } from "../host/types.js"
import { resolveProfilePaths, type ProfilePaths } from "../host/paths.js"
import { runPreflight, skippedPreflight, type PreflightResult } from "../host/preflight.js"
import type { DaemonOutcome, SetupFileOps, SetupOutcome } from "../host/setup.js"
import {
  DEFAULT_NODE_ROLE,
  DEFAULT_RUNTIME_KIND,
  nodeRoleFromConfig,
  parseNodeRole,
  parseRuntimeKind,
  prereqsFor,
  roleRunsJobs,
  type NodeRole,
  type RuntimeKind,
} from "../host/node-role.js"
import {
  generateCsprngToken,
  isTailscaleCgnatIp,
  probeDiscoveredAgents,
  type AgentDiscoveryDeps,
  type AgentDiscoveryResult,
  type DiscoveredAgent,
} from "./setup-step-widgets.js"
import {
  isCredentialShapedAgentId,
  scrubCredentialShapedAgentId,
} from "./discovery-safety.js"
import {
  installDaemonUnit,
  loadDaemonUnit,
  type DaemonIngressMode,
} from "../host/daemonizer.js"

export interface SetupWizardDeps {
  readonly platformInspector: PlatformInspector
  readonly processRunner: ProcessRunner
  readonly prompter: Prompter
  readonly fileOps: SetupFileOps
  readonly env?: Record<string, string | undefined>
  readonly initialProfile?: string
  /**
   * Config file path override (`aibr setup --config <path>`). When absent the
   * standard profile path is used and the operator is not asked for one.
   */
  readonly configPath?: string
  /** `aibr setup --advanced`: also ask for the bridge and OpenCode ports. */
  readonly advanced?: boolean
  /** Working directory used for the project-path default. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /** Overridable for tests; defaults to a filesystem existence check. */
  readonly pathExists?: (path: string) => Promise<boolean>
  /**
   * Overridable for tests; defaults to `probeDiscoveredAgents`.
   *
   * An override exists because discovery has two effects in a unit test — it shells
   * out to `tailscale` and it opens HTTP to every peer — neither of which a scripted
   * `Prompter` can absorb. A test injects a fixed `AgentDiscoveryResult` here and gets
   * the same discovery step the real probe would have produced.
   */
  readonly discoverAgents?: (deps?: AgentDiscoveryDeps) => Promise<AgentDiscoveryResult>
  /**
   * Overridable for tests; default writes the real launchd/systemd unit under
   * `env.HOME`. A test injects a fake so a unit test never writes into the
   * operator's real `~/Library/LaunchAgents`.
   */
  readonly installDaemon?: typeof installDaemonUnit
  /** Overridable for tests; defaults to `loadDaemonUnit`. */
  readonly loadDaemon?: typeof loadDaemonUnit
  /**
   * Where the wizard's own narration goes (the discovery roster, the
   * reachability notice, the enrolment explanations).
   *
   * Separate from `prompter` on purpose: a report is not a question, and routing
   * it through `promptInput` would consume an answer from a scripted prompter
   * and make every existing queue in the suite mean something different. Tests
   * pass a collector here and keep their `Prompter` queue as it was.
   */
  readonly write?: (text: string) => void
  /**
   * Phase 3: redeem a pairing code for an orchestrator (Step 4's first option).
   * Overridable for tests; defaults to the `aibr enroll join` code path. The
   * returned `commit` stores the worker's bearer token (0600) and runs only
   * after the operator saves.
   */
  readonly pairWithCode?: (input: { readonly code: string; readonly agentId: string; readonly paths: ProfilePaths }) => Promise<WizardPairing>
}

export interface WizardPairing {
  readonly agent: { readonly id: string; readonly url: string; readonly capabilities: readonly string[] }
  readonly commit: () => Promise<void>
}

async function defaultPairWithCode(input: { readonly code: string; readonly agentId: string; readonly paths: ProfilePaths }): Promise<WizardPairing> {
  const { joinWithPairingCode, storePeerBearerToken } = await import("../pairing/service.js")
  const joined = await joinWithPairingCode({ code: input.code, agentId: input.agentId, stateDir: input.paths.stateDir, displayName: input.agentId })
  return { agent: joined.agent, commit: () => storePeerBearerToken(input.paths, joined.agent.id, joined.bearerToken) }
}

/**
 * Step 4 for an orchestrator: pair with a worker by one-time code. Enter skips
 * to discovery; a failed pairing is reported and also falls back to discovery.
 */
async function promptPairing(io: WizardIo, agentId: string, paths: ProfilePaths): Promise<WizardPairing | null> {
  const raw = await io.prompter.promptInput(
    "Pair with a worker using an enrolment code — paste the code printed by `aibr enroll issue` on the worker " +
      "(Enter to skip and use discovery):",
  )
  const code = raw.trim()
  if (code === "") return null
  try {
    const paired = await (io.pairWithCode ?? defaultPairWithCode)({ code, agentId, paths })
    io.write(
      `Paired with ${paired.agent.id} at ${paired.agent.url}; capabilities [${paired.agent.capabilities.join(", ")}]. ` +
        `Keys are pinned on both sides; its bearer token is stored when you save (never shown).\n`,
    )
    return paired
  } catch (error) {
    io.write(`Pairing failed: ${error instanceof Error ? error.message : String(error)} Continuing with discovery.\n`)
    return null
  }
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
 *
 * `keep` only exists when the profile already has a token. It is then the
 * default, and only an explicit "g"/"generate" rotates: rotating a token is what
 * makes every peer still holding the old one answer 401, so it must never be what
 * Enter does.
 */
export type BearerTokenChoice = "keep" | "generate" | "paste" | "none"

export function parseBearerTokenChoice(
  raw: string,
  options?: { readonly hasExisting?: boolean },
): BearerTokenChoice {
  const answer = raw.trim().toLowerCase()
  if (answer === "none" || answer === "noauth" || answer === "open") return "none"
  if (answer === "n" || answer === "no" || answer === "p" || answer === "paste") return "paste"
  if (options?.hasExisting === true) {
    // Fail safe: only an explicit request rotates an existing token.
    return answer === "g" || answer === "generate" || answer === "new" || answer === "rotate"
      ? "generate"
      : "keep"
  }
  // "generate" is the default for a new profile, so "" and "y" both land here.
  return "generate"
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

/** A random OpenCode server password (192 bits, URL-safe), for "Enter = generate". */
export function generateOpencodePassword(): string {
  return randomBytes(24).toString("base64url")
}

function parsePort(value: string, defaultValue: number): number {
  const trimmed = value.trim()
  if (trimmed === "") return defaultValue
  const n = parseInt(trimmed, 10)
  return Number.isNaN(n) ? defaultValue : n
}

/** True for an empty answer or an explicit yes; used for confirms whose default is yes. */
function isYesDefaultYes(answer: string): boolean {
  const value = answer.trim().toLowerCase()
  return value === "" || value === "y" || value === "yes"
}

/** True only for an explicit yes; used for confirms whose default is no. */
function isExplicitYes(answer: string): boolean {
  const value = answer.trim().toLowerCase()
  return value === "y" || value === "yes"
}

// ── Project path ───────────────────────────────────────────────────────────

/**
 * Why a directory may not be allowlisted as a project, or `null` when it may.
 *
 * `/`, `$HOME`, and every ancestor of `$HOME` are refused: allowlisting one of
 * them makes every file the operator owns reachable by remote jobs, and the
 * released default (`process.cwd()`) did exactly that for anyone who ran
 * `aibr setup` from their home directory.
 */
export function projectPathProblem(path: string, home: string | undefined): string | null {
  if (!isAbsolute(path)) return `${path} is not an absolute path`
  const normalized = resolvePath(path)
  if (normalized === "/") {
    return "the filesystem root cannot be a project: every file on the machine would be reachable by remote jobs"
  }
  if (home !== undefined && home !== "") {
    const normalizedHome = resolvePath(home)
    if (normalized === normalizedHome) {
      return `${normalized} is your home directory: every file you own would be reachable by remote jobs`
    }
    if (normalizedHome.startsWith(normalized.endsWith("/") ? normalized : `${normalized}/`)) {
      return `${normalized} contains your home directory: every file you own would be reachable by remote jobs`
    }
  }
  return null
}

/** `git rev-parse --show-toplevel` for `cwd`, or `null` outside a repository. */
async function gitToplevel(runner: ProcessRunner, cwd: string): Promise<string | null> {
  try {
    const result = await runner.exec(["git", "-C", cwd, "rev-parse", "--show-toplevel"])
    if (result.exitCode !== 0) return null
    const top = result.stdout.trim()
    return top !== "" && isAbsolute(top) ? top : null
  } catch {
    return null
  }
}

// ── Discovery: discovery-driven, explicitly-enrolled peer configuration ────

/** The legacy default, kept because the manual fallback must keep working. */
export const DEFAULT_PEER_AGENT_ID = "peer"

/** The legacy default, kept for the same reason. */
export const DEFAULT_PEER_BRIDGE_URL = "http://100.64.0.2:8787"

/**
 * Shown under the discovery roster, in the operator's terminal, every time.
 *
 * REACHABILITY IS NOT AUTHENTICATION. `Docs/security/milestone-0-threat-model.md`
 * is explicit that "a Tailscale connection provides reachability, not user
 * identity, enrollment, project membership, or approval", and `src/mesh/` repeats
 * it wherever a peer is admitted. Trust on this mesh is ed25519 node keys plus
 * enrollment codes plus peer pins (`src/mesh/identity/`). What this step writes is
 * a config file: a routing and authorization convenience the operator is
 * authoring by hand, and nothing more.
 *
 * One sentence on purpose: the released ~90-word paragraph sat between two
 * tables and was scrolled past. The warning has to be short enough to be read.
 */
export const REACHABILITY_NOT_AUTHENTICATION =
  "Reachability is not authentication: a peer answering /health is not verified or trusted, " +
  "and discovery enrols nothing — only a peer you name below is written to this node's config."

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
 * Capability profiles a NEW Claude worker starts with. Without them every
 * `/trigger` on a freshly set-up Claude node is a 403 "Unknown capability
 * profile" (found by the dev → staging end-to-end test), so a new user would have
 * to hand-edit JSON before anything works. Both are conservative: `investigate`
 * is read-only, `run-tests` may run the project's test command but not edit.
 * Running tests still executes repository code — the same caveat as the plan's
 * "code from dev is untrusted" risk. Write-capable or approval-gated profiles are
 * left to the operator on purpose. The safety floor in claude-job-runner.ts is
 * applied on top of these.
 */
export const DEFAULT_CLAUDE_CAPABILITY_PROFILES = {
  investigate: {
    allow: ["Read", "Grep", "Glob", "Bash(git log *)", "Bash(git diff *)", "Bash(git status *)", "Bash(git show *)"],
    deny: ["Edit", "Write", "NotebookEdit"],
    max_budget_usd: 1,
    timeout_s: 900,
    append_system_prompt:
      "This is a read-only investigation: you cannot edit files. Use Read, Grep and Glob to inspect code; " +
      "only plain `git log/diff/status/show` shell commands are allowed, never chained with other commands.",
  },
  "run-tests": {
    allow: [
      "Read", "Grep", "Glob",
      "Bash(npm test)", "Bash(npm test *)", "Bash(npm run test *)",
      "Bash(bun test)", "Bash(bun test *)", "Bash(bun run test)", "Bash(bun run test *)",
      "Bash(pytest *)", "Bash(cargo test *)", "Bash(go test *)",
    ],
    deny: ["Edit", "Write", "NotebookEdit"],
    max_budget_usd: 2,
    timeout_s: 1800,
    // Claude Code checks every sub-command of a chained shell line, so
    // `npm test; echo $?; cat -n x.js` is denied as a whole when only the test
    // command is allowed (seen in the dev -> staging run). Allowing cat/echo
    // would let Bash read files the Read deny rules protect, so the worker is
    // told how to work inside the profile instead.
    append_system_prompt:
      "Permissions for this job are fixed in advance and cannot be approved interactively. " +
      "Run the test command on its own (for example `npm test` or `bun run test`), never chained with " +
      "`;`, `&&`, `||` or pipes and without other shell commands — a chained command is denied as a whole. " +
      "Use the Read, Grep and Glob tools to inspect files instead of shell commands.",
  },
} as const

/** What a peer may ask a Claude worker for by default: exactly the default profiles. */
const DEFAULT_CLAUDE_PEER_CAPABILITIES = Object.keys(DEFAULT_CLAUDE_CAPABILITY_PROFILES)

/** Swap the OpenCode-era default capability list for the Claude one; leave operator choices alone. */
function claudeCapabilities(raw: unknown): string[] {
  const capabilities = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : []
  const isLegacyDefault =
    capabilities.length === DEFAULT_ENROLLED_PEER_CAPABILITIES.length &&
    DEFAULT_ENROLLED_PEER_CAPABILITIES.every((c) => capabilities.includes(c))
  return isLegacyDefault ? [...DEFAULT_CLAUDE_PEER_CAPABILITIES] : [...capabilities]
}

/**
 * Answers to the "which peer do you want to enrol" question.
 *
 * `skip` is the load-bearing one and it is always available, including as the
 * empty answer: a setup that enrols a peer nobody chose is worse than a setup
 * that enrols nobody, so the default outcome of being unsure is "nothing new".
 * On a re-run, `skip` keeps the peers the profile already has; `clear` is the
 * explicit way to remove them.
 */
export type PeerEnrolmentChoice =
  | { readonly kind: "skip" }
  | { readonly kind: "clear" }
  | { readonly kind: "manual" }
  | { readonly kind: "agent"; readonly agent: DiscoveredAgent }

/**
 * Parse the operator's answer to the peer-selection prompt.
 *
 * Accepts the row NUMBER as printed, the hostname, or the peer's IP, because
 * an operator looking at a table reads whichever of the three their terminal
 * shows most clearly. Anything unrecognised is `skip` rather than a
 * re-prompt loop: a wizard that cannot parse an answer should not trap the
 * operator in it, and "nothing new is enrolled" is the safe reading of "I did
 * not mean any of those".
 *
 * Exported for tests because the parsing is the security-relevant part: it is
 * the boundary between "the operator named a peer" and "the wizard chose one".
 */
export function parsePeerSelection(raw: string, agents: readonly DiscoveredAgent[]): PeerEnrolmentChoice {
  const answer = raw.trim().toLowerCase()
  if (answer === "" || answer === "s" || answer === "skip" || answer === "n" || answer === "no") {
    return { kind: "skip" }
  }
  if (answer === "clear") return { kind: "clear" }
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
 * A separate type so the discovery helpers cannot forget the narration: they
 * take a `WizardIo` and therefore cannot be called without somewhere to write
 * the reachability notice to.
 */
export type WizardIo = SetupWizardDeps & {
  readonly write: (text: string) => void
}

/**
 * Default narration sink.
 *
 * stdout, because this is what the operator is meant to read, and because the
 * prompter narrates over the same channel. Errors are swallowed: a closed pipe
 * or a redirected descriptor must not turn a report into a failed setup.
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
 * Applied BEFORE the roster and before the selection prompt, so neither the
 * roster nor the enrolment confirmation can carry one, and so a scrubbed id
 * cannot become a configured agent id. The rule lives in `./discovery-safety.js`
 * and is shared with `aibr discover`.
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
 * read "already enrolled here", and nothing else: `probeDiscoveredAgents` is pure
 * by construction and the wizard's next statement is a prompt, not a write.
 *
 * The result is sanitized on the way out, so nothing downstream of this
 * function — the roster, the selection prompt, the config — can carry a `tskey-`
 * credential the remote `/health` handed us.
 */
async function runSetupDiscovery(
  deps: WizardIo,
  existing: Record<string, unknown> | null,
  bridgePort: number,
): Promise<AgentDiscoveryResult> {
  const discover = deps.discoverAgents ?? probeDiscoveredAgents
  const result = await discover({
    processRunner: deps.processRunner,
    enrolledAgentIds: enrolledAgentIdsFrom(existing),
    bridgePort,
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
 * The peers worth listing in detail: those that answered `/health` as an
 * AIBridge bridge, plus those this profile already enrols (a known peer that is
 * down right now is still a peer the operator recognises).
 *
 * Everything else on the tailnet — phones, printers, laptops without a bridge —
 * is summarised in one line instead of being offered as an enrolment candidate.
 */
export function listedBridgePeers(agents: readonly DiscoveredAgent[]): DiscoveredAgent[] {
  return agents.filter((agent) => agent.reachable || agent.enrolled)
}

/**
 * The discovery block the operator reads: one header, one numbered roster of
 * bridges, one summary line for every other device, one sentence of warning.
 */
export function renderDiscoverySummary(result: AgentDiscoveryResult): string {
  const listed = listedBridgePeers(result.agents)
  const others = result.agents.length - listed.length
  const lines = [
    `Tailnet discovery: ${listed.length} AIBridge bridge(s) found` +
      (listed.length > 0 ? " (discovery proposes; it enrols nothing):" : "."),
  ]
  listed.forEach((agent, index) => {
    const identity = agent.agentId ?? "did not identify itself"
    const state = agent.reachable ? "answered /health" : "no answer on /health right now"
    const claimed =
      agent.capabilities.length > 0 ? agent.capabilities.join(", ") : "no capabilities advertised"
    lines.push(
      `  ${index + 1}) ${agent.hostname} (${agent.ip}) — ${state}; agent_id: ${identity}; ` +
        `advertises: ${claimed}${agent.enrolled ? "; already enrolled here" : ""}`,
    )
  })
  if (others > 0) {
    lines.push(
      `${others} other device${others === 1 ? "" : "s"} on the tailnet did not answer as AIBridge bridges.`,
    )
  }
  lines.push(REACHABILITY_NOT_AUTHENTICATION)
  return lines.join("\n")
}

/**
 * The released manual prompts: peer agent ID, then peer agent URL, with `peer`
 * and `http://100.64.0.2:8787` as the defaults.
 *
 * Kept because a setup run has to survive a tailnet that cannot be enumerated —
 * before `tailscale up`, inside a CI container, or with an injected prompter in
 * a test. Capabilities are NOT asked for here; the wizard's conservative
 * default is used.
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
 * outcome rather than an error: it is what "Enrol nobody" means downstream.
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
  if (!isExplicitYes(confirm)) {
    deps.write("Declined. Nothing was enrolled.\n")
    return null
  }

  return { id: peerId, url: agent.bridgeUrl, capabilities }
}

/**
 * The peer step: show the bridges, ask, and return the two arrays to write.
 *
 * Existing entries are carried over verbatim (they may hold fields this wizard
 * does not author), a newly enrolled peer replaces any entry with the same id in
 * BOTH arrays, and `clear` empties both. The arrays therefore stay in agreement
 * on every path.
 */
async function configurePeers(
  io: WizardIo,
  discovery: AgentDiscoveryResult,
  existingAgents: readonly Record<string, unknown>[],
  existingSources: readonly Record<string, unknown>[],
): Promise<{ agents: Record<string, unknown>[]; sources: Record<string, unknown>[] }> {
  const listed = listedBridgePeers(discovery.agents)
  const currentIds = [
    ...new Set([
      ...existingAgents.map((a) => a.id).filter((id): id is string => typeof id === "string"),
      ...existingSources
        .map((s) => s.source_agent_id)
        .filter((id): id is string => typeof id === "string"),
    ]),
  ]
  const hasExisting = currentIds.length > 0

  io.write(renderDiscoverySummary(discovery) + "\n")

  let enrolledPeer: EnrolledPeer | null = null
  let clear = false

  if (listed.length === 0 && !hasExisting) {
    // Empty tailnet, no bridge answering, a setup run before Tailscale was
    // joined, or a test. All of them must still be able to finish: the manual
    // prompts are the released path.
    io.write(
      `No AIBridge bridges were discovered. Nothing is enrolled by discovery; ` +
        `name a peer by hand below.\n`,
    )
    enrolledPeer = await promptManualPeer(io)
  } else {
    const enterMeaning = hasExisting
      ? `Enter = keep current peers (${currentIds.join(", ")}), m = add a peer by hand, ` +
        `clear = remove all peers`
      : `Enter = enrol nobody, m = enter a peer by hand`
    const rawSelection = await io.prompter.promptInput(
      listed.length > 0
        ? `Enrol a peer by number, hostname, or IP (${enterMeaning}):`
        : `Enrol a peer (${enterMeaning}):`,
    )
    const selection = parsePeerSelection(rawSelection, listed)

    if (selection.kind === "skip") {
      io.write(
        hasExisting
          ? `No new peer selected. Keeping the current peers: ${currentIds.join(", ")}.\n`
          : `No peer selected. agents[] and security.allowed_sources[] will both be left ` +
              `empty; this node will not accept /trigger from anyone and cannot dispatch to ` +
              `a peer. Re-run setup to change that.\n`,
      )
    } else if (selection.kind === "clear") {
      clear = true
      io.write("Removing all enrolled peers from this profile.\n")
    } else if (selection.kind === "manual") {
      enrolledPeer = await promptManualPeer(io)
    } else {
      enrolledPeer = await enrolDiscoveredPeer(io, selection.agent)
    }
  }

  if (clear) return { agents: [], sources: [] }

  const agents = [...existingAgents]
  const sources = [...existingSources]
  if (enrolledPeer === null) return { agents, sources }

  const peer = enrolledPeer
  return {
    agents: [
      ...agents.filter((a) => a.id !== peer.id),
      { id: peer.id, url: peer.url, capabilities: [...peer.capabilities] },
    ],
    sources: [
      ...sources.filter((s) => s.source_agent_id !== peer.id),
      {
        source_agent_id: peer.id,
        capabilities: [...peer.capabilities],
        requires_plan_approval: [],
      },
    ],
  }
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

// ── Role & runtime ─────────────────────────────────────────────────────────

async function promptNodeRole(io: WizardIo, defaultRole: NodeRole): Promise<NodeRole> {
  for (;;) {
    const raw = await io.prompter.promptInput(
      `Node role — worker (runs jobs here), orchestrator (Claude Code dispatches work from here), ` +
        `or both [${defaultRole}]:`,
    )
    if (raw.trim() === "") return defaultRole
    const role = parseNodeRole(raw)
    if (role !== null) return role
    io.write(`"${raw.trim()}" is not a role. Type worker, orchestrator, or both.\n`)
  }
}

/**
 * Decide the worker runtime: detect `opencode` and `claude` on PATH and ask
 * only when the answer is not obvious.
 *
 * - the profile's current runtime is installed → keep it, no question;
 * - exactly one of the two is installed → use it, no question;
 * - both or neither → ask, defaulting to the current runtime (or opencode).
 */
async function chooseRuntime(io: WizardIo, current: RuntimeKind | null): Promise<RuntimeKind> {
  const has = async (bin: string): Promise<boolean> => {
    try {
      return (await io.processRunner.exec(["which", bin])).exitCode === 0
    } catch {
      return false
    }
  }
  const installed = {
    opencode: await has("opencode"),
    claude: await has("claude"),
  }

  if (current !== null && installed[current]) return current
  if (installed.opencode !== installed.claude) {
    const detected: RuntimeKind = installed.opencode ? "opencode" : "claude"
    io.write(`Runtime: ${detected} (the only one found on PATH).\n`)
    return detected
  }

  const fallback = current ?? DEFAULT_RUNTIME_KIND
  for (;;) {
    const raw = await io.prompter.promptInput(
      `Agent runtime for jobs on this node — opencode or claude [${fallback}]:`,
    )
    if (raw.trim() === "") return fallback
    const kind = parseRuntimeKind(raw)
    if (kind !== null) return kind
    io.write(`"${raw.trim()}" is not a runtime. Type opencode or claude.\n`)
  }
}

// ── Main entry ─────────────────────────────────────────────────────────────

/**
 * Main entry point for `aibr setup`.
 */
export async function runSetupWizard(deps: SetupWizardDeps): Promise<SetupOutcome> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>)
  const io: WizardIo = { ...deps, write: deps.write ?? writeToStdout }
  const pathExists = deps.pathExists ?? defaultPathExists
  const platform = deps.platformInspector.inspect()

  // ── Profile & existing config ────────────────────────────────────────
  let profileName: string
  if (deps.initialProfile && deps.initialProfile.trim() !== "") {
    profileName = deps.initialProfile.trim()
  } else {
    const rawProfile = await deps.prompter.promptInput("Enter profile name [default]:")
    profileName = rawProfile.trim() === "" ? "default" : rawProfile.trim()
  }

  const paths: ProfilePaths = resolveProfilePaths(profileName, env)
  // Not a question: the standard path is right for everyone who has not
  // already decided otherwise, and those who have pass `--config`.
  const configPath =
    deps.configPath !== undefined && deps.configPath.trim() !== ""
      ? deps.configPath.trim()
      : `${paths.configDir}/config.json`

  const existing = await deps.fileOps.readConfig(configPath)
  if (existing !== null) {
    // A re-run is how an operator enrols the second machine, so it is an
    // update by default: every answer below defaults to what is already there,
    // and nothing secret changes unless explicitly asked for.
    const update = await deps.prompter.promptConfirm(
      `Profile "${profileName}" already exists at ${configPath}. Update existing profile? ` +
        `(current values are the defaults; the bearer token is kept unless you choose otherwise)`,
      { defaultYes: true },
    )
    if (!isYesDefaultYes(update)) {
      return { kind: "declined", preflight: skippedPreflight(platform.platform) }
    }
  }

  // ── Step 1: Node role and runtime ────────────────────────────────────
  //
  // Asked BEFORE preflight, because what preflight must require depends on
  // the answer: a Claude-only orchestrator has no use for tmux or opencode and
  // must not be blocked on them.
  const current = nodeRoleFromConfig(existing)
  const hasCurrentRole = existing !== null && parseNodeRole(existing.role) !== null
  const role = await promptNodeRole(io, hasCurrentRole ? current.role : DEFAULT_NODE_ROLE)
  const runtime: RuntimeKind | null = roleRunsJobs(role)
    ? await chooseRuntime(io, existing !== null ? current.runtime : null)
    : null

  // ── Step 0: Preflight checks (role-aware) ────────────────────────────
  const preflight: PreflightResult = await runPreflight({
    platformInspector: deps.platformInspector,
    processRunner: deps.processRunner,
    prompter: deps.prompter,
    prereqs: prereqsFor(role, runtime),
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

  return runSetupSteps(io, {
    env,
    preflight,
    profileName,
    paths,
    configPath,
    existing,
    role,
    runtime,
    pathExists,
  })
}

interface SetupContext {
  readonly env: Record<string, string | undefined>
  readonly preflight: PreflightResult
  readonly profileName: string
  readonly paths: ProfilePaths
  readonly configPath: string
  readonly existing: Record<string, unknown> | null
  readonly role: NodeRole
  readonly runtime: RuntimeKind | null
  readonly pathExists: (path: string) => Promise<boolean>
}

/**
 * Everything after the preflight gate: secrets, allowlists, peers, persist.
 */
async function runSetupSteps(io: WizardIo, ctx: SetupContext): Promise<SetupOutcome> {
  const { env, preflight, profileName, paths, configPath, existing, role, runtime, pathExists } = ctx
  const deps = io
  const base: Record<string, unknown> = existing ?? {}
  const baseBridge = isRecord(base.bridge) ? base.bridge : {}
  const baseOpencode = isRecord(base.opencode) ? base.opencode : {}
  const baseSecurity = isRecord(base.security) ? base.security : {}
  const usesOpencode = runtime === "opencode"

  const bearerTokenPath = `${paths.secretsDir}/bearer_token`
  const ocPasswordPath = `${paths.secretsDir}/opencode_password`

  // Ports are decided first (not asked yet) so the no-auth warning and the
  // discovery probe use the port this node will really listen on.
  const existingBridgePort =
    typeof baseBridge.port === "number" && Number.isInteger(baseBridge.port) ? baseBridge.port : 8787
  const existingOcPort =
    typeof baseOpencode.server_port === "number" && Number.isInteger(baseOpencode.server_port)
      ? baseOpencode.server_port
      : 4096

  // ── Step 2: Router Security & Bearer Credentials ───────────────────
  //
  // Four answers on a re-run, three on a new profile. "Keep" exists only when a
  // token is already on disk and is then the default; "generate" and "paste"
  // are the released behaviour; "none" runs the routes unauthenticated and is
  // only offered for a bridge that is genuinely protected by its network.
  const hasExistingToken = await pathExists(bearerTokenPath)
  const tokenChoiceRaw = await deps.prompter.promptInput(
    hasExistingToken
      ? "Bearer authentication — this profile already has a token. [K]eep existing (default), " +
          "[G]enerate new (peers using the old token will get 401), [P]aste a different one, " +
          "or type 'none' for no authentication:"
      : "Bearer authentication — [G]enerate a new token (default), " +
          "[P]aste an existing one, or type 'none' for no authentication:",
  )
  const tokenChoice = parseBearerTokenChoice(tokenChoiceRaw, { hasExisting: hasExistingToken })

  let authMode: "bearer-token" | "none" = "bearer-token"
  /** `null` = keep what is on disk; a string = write this value. */
  let newBearerToken: string | null = null

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
    // mode -- the bridge never reads it -- so the operator would believe the node
    // is protected when nothing is checking the token.
    if (hasExistingToken) {
      return {
        kind: "blocked",
        reason:
          `Refusing to configure auth_mode "none": a bearer_token secret already ` +
          `exists at ${bearerTokenPath} and would be silently ` +
          `ignored. Delete it first, then re-run setup.`,
        preflight,
      }
    }

    // Guard 3: an explicit acknowledgement of what is being given up. (Preflight
    // has already established the backend is Running, so the tailnet half of the
    // exposure is the part the operator is being asked to confirm.)
    const accepted = await deps.prompter.promptConfirm(
      `This node will accept /trigger and /report with NO authentication. ` +
        `Anything that can reach ${tailscaleIp}:${existingBridgePort} can dispatch work. ` +
        `Continue?`,
    )
    if (!isExplicitYes(accepted)) {
      // Declined is not a dead end: fall back to the released behaviour instead of
      // stranding the setup. The operator changed their mind; nothing is broken.
      authMode = "bearer-token"
      newBearerToken = generateBearerToken(false)
      await deps.prompter.promptInput(
        `Falling back to a generated bearer token: ${newBearerToken}\n` +
          `(Copy this token to use on your peer machine. Press Enter to continue)`,
      )
    } else {
      authMode = "none"
      await deps.prompter.promptInput(
        `Authentication disabled. The bridge will run unauthenticated on ` +
          `${tailscaleIp}. Press Enter to continue.`,
      )
    }
  } else if (tokenChoice === "keep") {
    io.write(`Keeping the existing bearer token (${bearerTokenPath}); peers need no change.\n`)
  } else if (tokenChoice === "paste") {
    newBearerToken = await deps.prompter.promptSecret("Enter shared bearer token:")
  } else {
    // Generate 64 hex characters (32 bytes) CSPRNG token.
    newBearerToken = generateBearerToken(false)
    const rotationWarning = hasExistingToken
      ? "\nThis REPLACES the existing token: every peer still using the old one will get " +
        "HTTP 401 until it is given this one."
      : ""
    await deps.prompter.promptInput(
      `Generated shared token: ${newBearerToken}${rotationWarning}\n` +
        `(IMPORTANT: Copy this token to use on your peer machine. Press Enter to continue)`,
    )
  }

  // ── OpenCode password (opencode runtime only) ───────────────────────
  //
  // A Claude Code worker and an orchestrator run no `opencode serve`, so there
  // is nothing to protect with this password and nothing is asked.
  /** `null` = keep what is on disk (or none needed); a string = write this value. */
  let newOcPassword: string | null = null
  const hasExistingOcPassword = usesOpencode ? await pathExists(ocPasswordPath) : false
  if (usesOpencode) {
    if (hasExistingOcPassword) {
      const typed = await deps.prompter.promptSecret(
        "OpenCode server password (Enter = keep the existing one):",
      )
      newOcPassword = typed === "" ? null : typed
    } else {
      const typed = await deps.prompter.promptSecret(
        "OpenCode server password (Enter = generate a random one):",
      )
      if (typed === "") {
        newOcPassword = generateOpencodePassword()
        io.write(
          `Generated a random OpenCode password; it is stored in ${ocPasswordPath} ` +
            `and read from there by "aibr start".\n`,
        )
      } else {
        newOcPassword = typed
      }
    }
  }

  // ── Step 3: Project Allowlists & Containment ────────────────────────
  const defaultAgentId =
    typeof base.agent_id === "string" && base.agent_id.trim() !== "" ? base.agent_id : profileName
  const rawAgentId = await deps.prompter.promptInput(`Enter agent ID [${defaultAgentId}]:`)
  const agentId = rawAgentId.trim() === "" ? defaultAgentId : rawAgentId.trim()

  const existingProjects = Array.isArray(base.projects) ? base.projects.filter(isRecord) : []
  const firstProject = existingProjects[0]
  const projectPath = await promptProjectPath(io, env, firstProject)

  // ── Step 4: Tailnet Discovery & Explicit Peer Enrolment ─────────────
  //
  // DISCOVERY NEVER ENROLLS — IT ONLY PROPOSES. Everything in this block
  // either reports or asks. The only statements that put a peer id into the
  // config live inside a branch guarded by an answer the operator gave, so
  // there is no path from "a peer answered" to "a peer is enrolled".
  const existingAgents = Array.isArray(base.agents) ? base.agents.filter(isRecord) : []
  const existingSources = Array.isArray(baseSecurity.allowed_sources)
    ? baseSecurity.allowed_sources.filter(isRecord)
    : []
  // Phase 3: an orchestrator's first option is pairing by one-time code
  // (`aibr enroll join`'s code path); discovery is the fallback.
  const paired = role === "orchestrator" ? await promptPairing(io, agentId, paths) : null
  const peers =
    paired !== null
      ? {
          agents: [...existingAgents.filter((a) => a.id !== paired.agent.id), { ...paired.agent, capabilities: [...paired.agent.capabilities] }],
          sources: existingSources,
        }
      : await configurePeers(io, await runSetupDiscovery(io, existing, existingBridgePort), existingAgents, existingSources)

  // ── Ports (--advanced only) ─────────────────────────────────────────
  let bridgePort = existingBridgePort
  let ocPort = existingOcPort
  if (deps.advanced === true) {
    bridgePort = parsePort(
      await deps.prompter.promptInput(`Enter bridge port [${existingBridgePort}]:`),
      existingBridgePort,
    )
    if (usesOpencode) {
      ocPort = parsePort(
        await deps.prompter.promptInput(`Enter OpenCode server port [${existingOcPort}]:`),
        existingOcPort,
      )
    }
  }

  // ── Build config ────────────────────────────────────────────────────
  const tailscaleIp = preflight.tailscale.ip!
  const tailscaleHostname = preflight.tailscale.hostname

  const publicUrl =
    tailscaleHostname !== null
      ? `http://${tailscaleHostname}:${bridgePort}`
      : `http://${tailscaleIp}:${bridgePort}`

  // An existing profile is the base, so keys this wizard does not author
  // (terminal, ingress_mode, custom permissions, extra projects) survive an
  // update. Keys it does author are overwritten below.
  const { runtime: _previousRuntime, ...baseWithoutRuntime } = base
  // A Claude worker answers capabilities with capability_profiles, so the
  // OpenCode-era defaults ("development", "orchestration") would make every
  // trigger a 403. Only the untouched default is swapped; typed lists are kept.
  const claudeWorker = runtime === "claude" && role !== "orchestrator"
  const peerSources = claudeWorker
    ? peers.sources.map((src) => ({ ...src, capabilities: claudeCapabilities(src.capabilities) }))
    : peers.sources
  const peerAgents = claudeWorker
    ? peers.agents.map((agent) => ({ ...agent, capabilities: claudeCapabilities(agent.capabilities) }))
    : peers.agents
  const config: Record<string, unknown> = {
    ...baseWithoutRuntime,
    agent_id: agentId,
    // Role and runtime are read by `aibr verify` (per-role checks) and by the
    // runtime layer. The current schema is a non-strict object and tolerates them.
    role,
    ...(runtime !== null
      ? { runtime: { ...(isRecord(base.runtime) ? base.runtime : {}), kind: runtime } }
      : {}),
    bridge: {
      ...baseBridge,
      host: tailscaleIp,
      port: bridgePort,
      public_url: publicUrl,
    },
    // Always written, even for a Claude worker or an orchestrator, because the
    // current schema requires the block. Nothing reads it when opencode is unused.
    opencode: {
      ...baseOpencode,
      base_url: `http://127.0.0.1:${ocPort}`,
      server_port: ocPort,
      username: typeof baseOpencode.username === "string" ? baseOpencode.username : "opencode",
      password_env:
        typeof baseOpencode.password_env === "string"
          ? baseOpencode.password_env
          : "OPENCODE_SERVER_PASSWORD",
    },
    security: {
      // Phase 3 (ADR 0012): NEW profiles require signed /trigger and /report;
      // a re-run keeps whatever the profile had (absent = "off").
      ...(existing === null ? { request_signing: "required" } : {}),
      ...baseSecurity,
      auth_mode: authMode,
      // THE TWO ARRAYS MUST AGREE. `assertSourceAuthorized` authorizes on
      // `source_agent_id` AND capability membership, and `/trigger` answers 403 to
      // a source that is in `agents[]` but absent from `allowed_sources[]`. Both
      // come out of `configurePeers` together.
      allowed_sources: peerSources,
    },
    permissions: isRecord(base.permissions)
      ? base.permissions
      : {
          default_response: "reject",
          allow_tools: ["read", "grep", "glob"],
          require_plan_approval_for_tools: ["bash", "edit", "write"],
        },
    projects: [
      {
        ...(firstProject ?? {}),
        id: typeof firstProject?.id === "string" ? firstProject.id : profileName,
        path: projectPath,
        capabilities: Array.isArray(firstProject?.capabilities)
          ? firstProject.capabilities
          : claudeWorker
            ? [...DEFAULT_CLAUDE_PEER_CAPABILITIES]
            : ["development", "orchestration"],
      },
      ...existingProjects.slice(1),
    ],
    agents: peerAgents,
    ...(claudeWorker && !isRecord(base.capability_profiles)
      ? { capability_profiles: DEFAULT_CLAUDE_CAPABILITY_PROFILES }
      : {}),
    timeouts: isRecord(base.timeouts)
      ? base.timeouts
      : {
          default_job_seconds: 1800,
          callback_retry_attempts: 3,
        },
    planning: isRecord(base.planning)
      ? base.planning
      : {
          plan_annotator_enabled: true,
          require_approval_for: ["deployment", "destructive", "multi-agent-fanout"],
        },
  }

  // Enter saves. After a dozen answers, Enter meaning "throw it all away" was
  // the single most expensive keystroke in the wizard.
  const finalConfirm = await deps.prompter.promptConfirm(
    `Save configuration to "${configPath}"?`,
    { defaultYes: true },
  )
  if (!isYesDefaultYes(finalConfirm)) {
    return { kind: "declined", preflight }
  }

  // ── Persist directories, config, and secrets (0600) ─────────────────
  const fileOps = deps.fileOps
  const replaceSecret = (path: string, value: string): Promise<void> =>
    fileOps.replaceSecret !== undefined
      ? fileOps.replaceSecret(path, value)
      : fileOps.writeSecret(path, value)
  await deps.fileOps.ensureProfileDirs(paths)
  await deps.fileOps.writeConfig(configPath, config)
  // No secret in `none` mode: writeSecret throws on an empty value, and writing
  // one anyway would produce exactly the stale secret `aibr verify` warns about.
  // A kept token is not rewritten at all: the file on disk is left untouched.
  if (authMode === "bearer-token" && newBearerToken !== null) {
    if (hasExistingToken) {
      await replaceSecret(bearerTokenPath, newBearerToken)
    } else {
      await deps.fileOps.writeSecret(bearerTokenPath, newBearerToken)
    }
  }
  if (newOcPassword !== null) {
    if (hasExistingOcPassword) {
      await replaceSecret(ocPasswordPath, newOcPassword)
    } else {
      await deps.fileOps.writeSecret(ocPasswordPath, newOcPassword)
    }
  }
  if (paired !== null) await paired.commit()

  // ── Step 5: supervisor unit (not for an orchestrator) ───────────────
  //
  // An orchestrator runs no bridge workload that needs supervising, so no
  // unit is written for it.
  //
  // The ingress outbox is NOT created here. That table belongs to the Rust
  // router and is provisioned by `aibr-router --init-store`.
  //
  // The unit is written but not activated, and activation is a separate
  // confirmation: the unit is `KeepAlive`, so loading one whose config does not
  // match turns a setup mistake into a restart loop.
  let daemon: DaemonOutcome | undefined
  if (role !== "orchestrator") {
    daemon = await installAndMaybeStartDaemon(io, env, profileName, ingressModeOf(baseBridge))
  }

  return {
    kind: "persisted",
    profileName,
    configPath,
    preflight,
    role,
    runtime,
    updated: existing !== null,
    ...(daemon !== undefined ? { daemon } : {}),
  }
}

function ingressModeOf(bridge: Record<string, unknown>): DaemonIngressMode {
  return bridge.ingress_mode === "router" ? "router" : "engine"
}

/**
 * Ask for the project directory, defaulting to the existing project, else the
 * git toplevel of the working directory, else the working directory itself, and
 * refusing `/`, `$HOME`, and any ancestor of `$HOME`.
 */
async function promptProjectPath(
  io: WizardIo,
  env: Record<string, string | undefined>,
  firstProject: Record<string, unknown> | undefined,
): Promise<string> {
  const cwd = io.cwd ?? process.cwd()
  const home = env.HOME ?? homedir()
  const existingPath =
    typeof firstProject?.path === "string" && firstProject.path.trim() !== "" ? firstProject.path : null
  const candidate = existingPath ?? (await gitToplevel(io.processRunner, cwd)) ?? cwd
  const defaultPath = projectPathProblem(candidate, home) === null ? candidate : null

  for (;;) {
    const raw = await io.prompter.promptInput(
      defaultPath !== null
        ? `Enter project path [${defaultPath}]:`
        : "Enter project path (a project directory, not your home directory):",
    )
    const typed = raw.trim()
    if (typed === "" && defaultPath !== null) return defaultPath
    if (typed === "") {
      io.write("A project directory is required.\n")
      continue
    }
    const absolute = resolvePath(cwd, typed)
    const problem = projectPathProblem(absolute, home)
    if (problem === null) return absolute
    io.write(`Refusing to allowlist this path: ${problem}. Choose a project directory.\n`)
  }
}

async function installAndMaybeStartDaemon(
  io: WizardIo,
  env: Record<string, string | undefined>,
  profileName: string,
  ingressMode: DaemonIngressMode,
): Promise<DaemonOutcome> {
  const install = io.installDaemon ?? installDaemonUnit
  const load = io.loadDaemon ?? loadDaemonUnit
  let daemonUnit: Awaited<ReturnType<typeof installDaemonUnit>> | null = null
  let daemonError: string | null = null
  try {
    daemonUnit = await install({
      profile: profileName,
      skipLoad: true,
      ingressMode,
      ...(env.HOME !== undefined && env.HOME !== "" ? { homeDir: env.HOME } : {}),
    })
  } catch (error) {
    // Not fatal: the profile and its secrets are already persisted, and the
    // daemon can be supervised by hand. The operator is told, not left to
    // discover it later from a `status` that reports nothing running.
    daemonError = String(error)
  }

  let daemonStarted = false
  if (daemonUnit?.installed === true) {
    const activate = await io.prompter.promptConfirm(
      `Start the daemon now? (${daemonUnit.command})`,
    )
    if (isExplicitYes(activate)) {
      try {
        await load({ unitPath: daemonUnit.unitPath })
        daemonStarted = true
      } catch (error) {
        daemonError = String(error)
      }
    }
  }

  return {
    installed: daemonUnit?.installed ?? false,
    unitPath: daemonUnit?.unitPath ?? null,
    command: daemonUnit?.command ?? null,
    stopCommand: daemonUnit?.stopCommand ?? null,
    started: daemonStarted,
    error: daemonError,
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

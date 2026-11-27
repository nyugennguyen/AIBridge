/**
 * `aibr doctor` — one ✓/✗ list for "does this node work?".
 *
 * It merges three existing reports and adds the only check that proves two
 * machines can work together:
 *   1. `aibr verify`   — role prerequisites, Tailscale, config schema, project
 *                        directories, secrets, tailnet discovery (it already
 *                        runs `aibr discover`'s probe);
 *   2. `aibr status`   — is the bridge running (user service or tmux) and does
 *                        it answer `/health` (skipped for an orchestrator);
 *   3. `aibr ping`     — a signed no-op job to every peer in `agents[]`, waiting
 *                        for the result (and the callback, on a node with a bridge).
 *
 * Every ✗ line carries the exact command that fixes it. `!` lines are
 * warnings: worth knowing, not failures.
 */
import { resolveProfilePaths } from "../host/paths.js"
import type { VerifyCheck, VerifyReport } from "./verify.js"
import type { ProfileStatus, StatusFacts } from "./service.js"
import { decideStatus, healthUrl } from "./service.js"
import type { PingOutcome } from "../mcp/bridge-tools.js"

export const DOCTOR_HELP = [
  "aibr doctor — check this node end to end, with a fix for every problem",
  "",
  "Usage:",
  "  aibr doctor [--profile <name>] [--no-ping] [--json]",
  "",
  "Runs the checks of \"aibr verify\" (prerequisites, Tailscale, config, project,",
  "secrets, tailnet discovery) and \"aibr status\" (service or tmux, /health), then",
  "pings every peer this profile calls (agents[]) with a signed no-op job and",
  "waits for the result. Each ✗ comes with the command that fixes it.",
  "--profile defaults to AIBR_PROFILE, then the only profile, then \"default\".",
  "Exit code 0 when nothing failed.",
  "",
].join("\n")

export type DoctorStatus = "pass" | "warn" | "fail" | "skip"

export interface DoctorLine {
  readonly section: "node" | "bridge" | "peers"
  readonly status: DoctorStatus
  readonly message: string
  readonly fix?: string
  readonly detail?: string
}

export interface DoctorReport {
  readonly ok: boolean
  readonly profile: string
  readonly lines: readonly DoctorLine[]
}

export interface DoctorConfigFacts {
  readonly role: "worker" | "orchestrator" | "both"
  readonly runtime: string | null
  readonly agentId: string
  readonly agents: readonly { readonly id: string; readonly url: string }[]
  readonly allowedSources: readonly string[]
}

export interface DoctorDeps {
  readonly platform: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly verify: (profile: string) => Promise<VerifyReport>
  /** `null` when the profile has no readable, valid config. */
  readonly config: (profile: string) => Promise<DoctorConfigFacts | null>
  readonly statusFacts: (profile: string) => Promise<StatusFacts>
  readonly ping: (profile: string, target: string) => Promise<PingOutcome>
  /** systemd linger (Linux): `null` when it cannot be told or does not apply. */
  readonly linger?: () => Promise<boolean | null>
}

const PREREQ_FIX: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  darwin: {
    tmux: "brew install tmux",
    tailscale: "brew install --cask tailscale   # then open Tailscale and sign in",
    claude: "npm install -g @anthropic-ai/claude-code",
    opencode: "curl -fsSL https://opencode.ai/install | bash",
  },
  linux: {
    tmux: "sudo apt-get install -y tmux",
    tailscale: "curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up",
    claude: "npm install -g @anthropic-ai/claude-code",
    opencode: "curl -fsSL https://opencode.ai/install | bash",
  },
}

/** The command that fixes a failed or warned `aibr verify` check. */
export function fixForVerifyCheck(check: VerifyCheck, profile: string, platform: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const p = `--profile ${profile}`
  const name = check.name
  if (name === "runtime-bun") return "curl -fsSL https://bun.sh/install | bash"
  if (name.startsWith("prereq-")) {
    const bin = name.slice("prereq-".length)
    const table = PREREQ_FIX[platform] ?? PREREQ_FIX.linux!
    return table[bin] ?? (check.detail?.startsWith("Install with: ") ? check.detail.slice("Install with: ".length) : `install ${bin}`)
  }
  if (name === "tmux") return PREREQ_FIX[platform]?.tmux ?? PREREQ_FIX.linux!.tmux   // optional: only "aibr start --foreground"
  if (name === "tailscale-active") return platform === "darwin" ? "tailscale up   # or open the Tailscale app and sign in" : "sudo tailscale up"
  if (name === "profile-paths") return "export HOME=/absolute/path/to/your/home"
  if (name === "config-exists" || name === "config-readable") return `aibr init ${p}`
  if (name === "config-valid") return `aibr setup ${p}`
  if (name.startsWith("project-")) return `aibr setup ${p}   # choose an existing project directory`
  let secretsDir = "<secrets dir>"
  try {
    secretsDir = resolveProfilePaths(profile, { ...env }).secretsDir
  } catch {
    // keep the placeholder
  }
  if (name === "secret-bearer-token-mode") return `chmod 600 ${secretsDir}/bearer_token`
  if (name === "auth-mode-src-stale-secret") return `rm ${secretsDir}/bearer_token`
  if (name.startsWith("secret-") || name === "auth-mode-src-none") return `aibr setup ${p}`
  if (name === "tailscale-discovery") return `aibr enroll issue ${p}   # on the worker; then "aibr enroll join <code>" on the other node`
  return check.status === "fail" ? `aibr verify ${p}   # for details` : undefined
}

function statusLine(status: ProfileStatus, facts: StatusFacts): DoctorLine {
  const profile = facts.info.profile
  const url = healthUrl(facts.info)
  switch (status.kind) {
    case "healthy": {
      const runner =
        status.runner === "tmux"
          ? `tmux session ${status.sessionName}`
          : status.runner === "unmanaged"
            ? "a process outside the service and tmux"
            : `${status.runner} service`
      const both = facts.service.running && facts.tmux
      return {
        section: "bridge",
        status: both || facts.service.legacyUnitPath !== undefined ? "warn" : "pass",
        message: `Bridge running (${runner}); /health answers at ${url}`,
        ...(both
          ? { fix: `aibr stop --profile ${profile} && aibr start --profile ${profile}`, detail: "Both the user service and a tmux session run this profile." }
          : facts.service.legacyUnitPath !== undefined
            ? { fix: `aibr start --profile ${profile}`, detail: `It runs from the shared unit ${facts.service.legacyUnitPath}.` }
            : {}),
      }
    }
    case "not_running":
      return { section: "bridge", status: "fail", message: `Bridge not running (${url} does not answer)`, fix: `aibr start --profile ${profile}` }
    case "bridge_unavailable":
      return {
        section: "bridge",
        status: "fail",
        message: `${status.runner === "tmux" ? "tmux session" : `${status.runner} service`} is up but ${url} does not answer${status.probeStatus !== 0 ? ` (HTTP ${status.probeStatus})` : ""}`,
        fix: `aibr logs --profile ${profile}`,
        ...(status.hint !== undefined ? { detail: status.hint } : {}),
      }
    case "no_bridge":
      return { section: "bridge", status: "skip", message: "Bridge: none (orchestrator)" }
  }
}

function pingLine(outcome: PingOutcome, ownAgentId: string): DoctorLine {
  if (outcome.ok) {
    const callback = outcome.callback.status === "delivered" ? ", report delivered back here" : ""
    const caps = outcome.pong !== undefined && outcome.pong.capabilities.length > 0 ? `; accepts ${outcome.pong.capabilities.join(", ")}` : ""
    return {
      section: "peers",
      status: outcome.pong !== undefined && outcome.pong.capabilities.length === 0 ? "warn" : "pass",
      message: `ping ${outcome.target}: ${outcome.rttMs} ms${callback}${caps}`,
      ...(outcome.pong !== undefined && outcome.pong.capabilities.length === 0
        ? { fix: `aibr enroll issue --capabilities <list>   # on ${outcome.target}, then aibr enroll join <code> here`, detail: `${outcome.target} accepts nothing from ${ownAgentId} beyond ping.` }
        : {}),
    }
  }
  return {
    section: "peers",
    status: "fail",
    message: `ping ${outcome.target}${outcome.url !== null ? ` (${outcome.url})` : ""}: ${outcome.error ?? "failed"}`,
    fix: pingFix(outcome),
  }
}

function pingFix(outcome: PingOutcome): string {
  switch (outcome.code) {
    case "unreachable":
      return `aibr status   # on ${outcome.target}; and check the tailnet: tailscale ping ${hostOf(outcome.url) ?? outcome.target}`
    case "signature_required":
    case "unauthorized":
      return `aibr enroll issue   # on ${outcome.target}; then here: aibr enroll join <code>`
    case "forbidden":
      return `aibr enroll issue --capabilities <list>   # on ${outcome.target}; then here: aibr enroll join <code>`
    case "ping_unsupported":
      return `bun install -g @nyugennguyen/aibridge && aibr start   # on ${outcome.target}`
    case "unknown_peer":
    case "no_profile":
    case "invalid_config":
      return "aibr enroll list"
    case "callback_not_delivered":
      return outcome.hint ?? "aibr status"
    default:
      return outcome.hint ?? `aibr logs   # on ${outcome.target}`
  }
}

function hostOf(url: string | null): string | null {
  if (url === null) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

export async function buildDoctorReport(
  profile: string,
  deps: DoctorDeps,
  options: { readonly ping?: boolean } = {},
): Promise<DoctorReport> {
  const lines: DoctorLine[] = []

  // 1. node: everything `aibr verify` checks (passes collapsed to one line each).
  const verify = await deps.verify(profile)
  for (const check of verify.checks) {
    const status: DoctorStatus = check.status
    const fix = status === "pass" ? undefined : fixForVerifyCheck(check, profile, deps.platform, deps.env)
    lines.push({
      section: "node",
      status,
      message: check.message,
      ...(fix !== undefined ? { fix } : {}),
      ...(status !== "pass" && check.detail !== undefined ? { detail: check.detail } : {}),
    })
  }

  const config = await deps.config(profile)
  if (config === null) {
    lines.push({ section: "bridge", status: "skip", message: "Bridge: skipped (no usable profile config)" })
    lines.push({ section: "peers", status: "skip", message: "Peers: skipped (no usable profile config)" })
    return finish(profile, lines)
  }

  // 2. bridge: whichever of the service and tmux runs it, and /health.
  let bridgeUp = config.role === "orchestrator"
  if (config.role !== "orchestrator") {
    try {
      const facts = await deps.statusFacts(profile)
      const status = decideStatus(facts)
      lines.push(statusLine(status, facts))
      bridgeUp = status.kind === "healthy"
      if (facts.service.running && facts.service.manager === "systemd" && deps.linger !== undefined && (await deps.linger()) === false) {
        lines.push({
          section: "bridge",
          status: "warn",
          message: "systemd stops this user service when you log out (linger is off)",
          fix: `sudo loginctl enable-linger ${deps.env.USER ?? "$USER"}`,
        })
      }
    } catch (error) {
      lines.push({ section: "bridge", status: "fail", message: `Bridge status unknown: ${error instanceof Error ? error.message : String(error)}`, fix: `aibr status --profile ${profile}` })
    }
  }

  // 3. peers: a signed no-op job to every peer this node calls.
  if (config.agents.length === 0) {
    if (config.role === "orchestrator") {
      lines.push({
        section: "peers",
        status: "fail",
        message: "No peers paired: there is no worker to send work to",
        fix: `aibr enroll join <code> --profile ${profile}   # code from "aibr enroll issue" (or "aibr init") on the worker`,
      })
    } else if (config.allowedSources.length === 0) {
      lines.push({
        section: "peers",
        status: "warn",
        message: "No peer is paired with this node yet: nothing may send it work",
        fix: `aibr enroll issue --profile ${profile}   # then "aibr enroll join <code>" on the other node`,
      })
    } else {
      lines.push({
        section: "peers",
        status: "pass",
        message: `${config.allowedSources.length} peer(s) may send work here (${config.allowedSources.join(", ")}); check from their side: aibr ping ${config.agentId}`,
      })
    }
  } else if (options.ping === false) {
    for (const agent of config.agents) lines.push({ section: "peers", status: "skip", message: `ping ${agent.id}: skipped (--no-ping)` })
  } else if (config.role !== "orchestrator" && !bridgeUp) {
    // A ping would still reach the peer, but its report could not come back.
    for (const agent of config.agents) {
      lines.push({ section: "peers", status: "skip", message: `ping ${agent.id}: skipped until this node's bridge runs` })
    }
  } else {
    const outcomes = await Promise.all(config.agents.map((agent) => deps.ping(profile, agent.id)))
    for (const outcome of outcomes) lines.push(pingLine(outcome, config.agentId))
  }
  return finish(profile, lines)
}

function finish(profile: string, lines: readonly DoctorLine[]): DoctorReport {
  return { ok: !lines.some((l) => l.status === "fail"), profile, lines }
}

const ICON: Readonly<Record<DoctorStatus, string>> = { pass: "✓", warn: "!", fail: "✗", skip: "-" }
const SECTION_TITLE: Readonly<Record<DoctorLine["section"], string>> = { node: "This node", bridge: "Bridge", peers: "Peers (end to end)" }

export function renderDoctorReport(report: DoctorReport, header: string): string {
  const out: string[] = [header, ""]
  for (const section of ["node", "bridge", "peers"] as const) {
    const lines = report.lines.filter((l) => l.section === section)
    if (lines.length === 0) continue
    out.push(SECTION_TITLE[section])
    for (const line of lines) {
      out.push(`  ${ICON[line.status]} ${line.message}`)
      if (line.status !== "pass" && line.detail !== undefined) out.push(`      ${line.detail}`)
      if (line.fix !== undefined) out.push(`      fix: ${line.fix}`)
    }
    out.push("")
  }
  const failures = report.lines.filter((l) => l.status === "fail").length
  const warnings = report.lines.filter((l) => l.status === "warn").length
  out.push(
    failures === 0
      ? `All checks passed${warnings > 0 ? ` (${warnings} warning${warnings === 1 ? "" : "s"})` : ""}.`
      : `${failures} problem${failures === 1 ? "" : "s"} found${warnings > 0 ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}. Run the fix lines above, then aibr doctor again.`,
  )
  return `${out.join("\n")}\n`
}

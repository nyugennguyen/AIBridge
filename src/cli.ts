#!/usr/bin/env bun

/**
 * AIBridge CLI — `aibr`.
 *
 * Zero-dependency argument parser that dispatches to existing host modules
 * (setup, tmux, bridge) via injectable dependencies.
 *
 * Design constraints:
 * - `_opencode` is hidden from `--help` output.
 * - `--profile` is required for `start`, `serve`, `status`, `tui`, `_opencode`;
 *   optional for `setup`, `verify`, and `discover`.
 * - Help and version output are deterministic (no timestamps, no random).
 * - Error messages never leak internal paths, stack traces, or env values.
 * - `setup` rejects non-TTY environments.
 */

import { existsSync } from "node:fs"
import { access } from "node:fs/promises"
import { validateProfileName, resolveProfilePaths } from "./host/paths.js"
import { readSecret, readConfig } from "./host/profile-store.js"
import type { IpcBusHandle } from "./ipc/bridge.js"
// Type-only, so the discovery command costs nothing at import time and `aibr
// --help` on a machine with no Tailscale still runs. The module that defines
// these types is loaded lazily inside `createRealDeps`'s `discoverAgents`.
import type { AgentDiscoveryResult } from "./cli/setup-step-widgets.js"
import {
  isCredentialShapedAgentId,
  scrubCredentialShapedAgentId,
} from "./cli/discovery-safety.js"
import { CLI_VERSION } from "./version.js"
import { findInPath } from "./host/binaries.js"

export { CLI_VERSION }

// ── Types ──────────────────────────────────────────────────────────────

/**
 * A process exit code.
 *
 * `2` is included because the Rust client uses it, and pretending otherwise would
 * make every caller either truncate a real exit code or lose the distinction:
 * `1` means "you have to do something" (no daemon, no TTY) and `2` means "this is a
 * bug". A supervising script must be able to tell those apart, and a type that only
 * admits `0 | 1` would quietly collapse them.
 */
export type CliExitCode = 0 | 1 | 2

/**
 * Injectable CLI dependencies.
 *
 * Every side-effect-producing function is a dependency so tests can supply
 * fakes without touching the real filesystem, tmux, or network.
 */
export interface CliDeps {
  /** Write a string to stdout (or a fake writer in tests). */
  readonly writer: (data: string) => void
  /** Whether the current process stdout is a TTY. */
  readonly isTTY: boolean
  /** Whether the current process stdin is a TTY (needed by the full-screen UI). */
  readonly isInputTTY?: boolean
  /** Run interactive setup. Profile is undefined when not passed. */
  readonly runSetup: (profile?: string) => Promise<{
    readonly kind: "persisted" | "blocked" | "declined"
    readonly profileName?: string
    readonly configPath?: string
    readonly reason?: string
    readonly preflight?: unknown
    readonly launchTui?: boolean
    readonly daemon?: {
      readonly installed: boolean
      readonly unitPath: string | null
      readonly command: string | null
      readonly started: boolean
      readonly error: string | null
    }
  }>
  /** Start a tmux profile (opencode + bridge windows). */
  readonly startProfile: (profile: string) => Promise<{
    readonly kind: "started" | "already_running" | "tmux_error"
    readonly sessionName: string
    readonly stderr?: string
  }>
  /** Serve the bridge for a given profile. */
  readonly serveBridge: (profile: string, options?: { readonly shadowMode?: boolean }) => Promise<void>
  /**
   * Run the Tier 2 ingress drain loop for a profile until a signal arrives.
   *
   * Resolves on `SIGINT`/`SIGTERM`. Binds no socket: ingress belongs to the
   * router once cut over, and a worker that could accept requests would be a
   * second authority (ADR 0008 §2.2).
   *
   * `publishIpc` adds ONE socket, for local clients only, and it is opt-in. That
   * socket is the local bus and not ingress: its listener cannot admit a trigger,
   * and it lives in a `0700` user-scoped directory for the same reason the Rust
   * listener's does.
   */
  readonly runWorker: (profile: string, options?: { readonly publishIpc?: boolean }) => Promise<void>
  /** Query status of a tmux profile. */
  readonly statusProfile: (profile: string) => Promise<{
    readonly kind: "healthy" | "session_missing" | "bridge_unavailable"
    readonly sessionName: string
    readonly body?: string
    readonly probeStatus?: number
  }>
  /** Run `opencode serve` for a given profile. */
  readonly runOpencode: (profile: string) => Promise<void>
  /** Run the separately-composed interactive TUI for a validated profile. */
  readonly runTui?: (profile: string) => Promise<CliExitCode>
  /** Generate diagnostic support bundle. */
  readonly runBundle?: (profile: string, options?: { readonly preview?: boolean }) => Promise<CliExitCode>
  /** Validate dependencies, SSL token, and config format for a profile. */
  readonly verifyProfile?: (profile: string) => Promise<{
    readonly ok: boolean
    readonly summary: string
  }>
  /** Check and update AIBridge to the latest version. */
  readonly runUpdate?: (options?: { readonly checkOnly?: boolean; readonly yes?: boolean }) => Promise<{
    readonly ok: boolean
    readonly message: string
  }>
  /**
   * Enumerate the tailnet and ask each peer to identify itself.
   *
   * Optional because `discover` is a read-only query, not a state-changing
   * command: when this is absent the dispatcher falls back to the same module
   * lazily, the way `verify`/`update` do. Keeping it injectable is what makes
   * the command testable at all — a test cannot conjure a tailnet, and one
   * that shells out to the real `tailscale` binary would be a test that
   * depends on the machine it runs on.
   *
   * `profile` is optional and only ever supplies ids to LABEL rows as already
   * enrolled; omitting it is fully supported and is what makes the command
   * usable before any profile exists.
   *
   * This reports. It must never enrol: there is no code path from a reachable
   * `/health` to a config write, because a Tailscale connection buys
   * reachability and not identity (`Docs/security/milestone-0-threat-model.md`).
   */
  readonly discoverAgents?: (options?: { readonly profile?: string }) => Promise<AgentDiscoveryResult>
  /** Package version string. */
  readonly version: string
}

// ── Constants ──────────────────────────────────────────────────────────

const PROG = "aibr"

const COMMANDS = ["setup", "start", "serve", "worker", "status", "verify", "update", "tui", "bundle", "discover"] as const
const ALL_COMMANDS = [...COMMANDS, "_opencode"] as const

// ── Argv parsing ───────────────────────────────────────────────────────

interface ParsedArgs {
  readonly command: string | null
  readonly profile: string | null
  readonly unknownFlags: readonly string[]
  readonly hasFlag: (name: string) => boolean
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: string | null = null
  let profile: string | null = null
  const knownFlags: string[] = []
  const unknownFlags: string[] = []

  let i = 0

  while (i < argv.length) {
    const arg = argv[i]!

    if (arg === "--profile" || arg === "-p") {
      i++
      profile = i < argv.length ? argv[i]! : ""
    } else if (arg === "--help" || arg === "-h") {
      knownFlags.push("--help")
    } else if (arg === "--version" || arg === "-v") {
      knownFlags.push("--version")
    } else if (arg === "--shadow-mode") {
      knownFlags.push("--shadow-mode")
    } else if (arg === "--ipc-publish") {
      knownFlags.push("--ipc-publish")
    } else if (arg === "--preview") {
      // Known, and therefore NOT pushed onto `unknownFlags`. It used to be
      // pushed onto both lists, which made the unknown-flag guard below reject
      // `aibr bundle --preview` before the bundle branch could ever read it --
      // a flag that was documented and implemented but unreachable. One entry
      // per flag, in one list; the guard's job is to catch typos, not the flags
      // it already recognises.
      knownFlags.push("--preview")
    } else if (arg === "--yes" || arg === "-y") {
      knownFlags.push("--yes")
    } else if (arg === "--check" || arg === "-c") {
      knownFlags.push("--check")
    } else if (arg === "--json") {
      knownFlags.push("--json")
    } else if (command === null) {
      command = arg
    } else {
      unknownFlags.push(arg)
    }

    i++
  }

  return {
    command,
    profile,
    unknownFlags,
    hasFlag: (name: string) => knownFlags.includes(name),
  }
}

// ── Help text ──────────────────────────────────────────────────────────

function helpText(): string {
  return [
    `${PROG} — AIBridge CLI`,
    "",
    "Usage:",
    `  ${PROG} <command> [options]`,
    "",
    "Commands:",
    "  setup    Interactive host setup (profile optional)",
    "  start    Start opencode + bridge in tmux",
    "  serve    Run the bridge server",
    "  worker   Drain the router's admission queue (no listener)",
    "  status   Check tmux session and bridge health",
    "  verify   Validate dependencies, SSL token, and config format",
    "  update   Check and update to the latest version",
    "  tui      Open the interactive local UI",
    "  bundle   Generate diagnostic support bundle",
    "  discover List tailnet peers and probe their /health (read-only)",
    "",
    "Options:",
    "  --profile, -p <name>   Profile name (required for start/serve/worker/status/tui)",
    "  --check, -c            Check for updates without installing (for update)",
    "  --yes, -y              Automatic yes to prompts (for update)",
    "  --json                 Emit one JSON document and nothing else (for discover)",
    "  --help, -h             Show this help",
    "  --version, -v          Show version",
    "  --shadow-mode          Run in shadow mode (mirroring ingress to router)",
    "  --ipc-publish          Serve the local IPC bus for the TUI (worker only)",
    "",
  ].join("\n")
}

/**
 * Returns the ASCII splash banner with brand colors matching
 * Docs/assets/logos/logo-design-system.html:
 * Electric Cyan, Neural Violet, and Mesh Emerald.
 */
export function getCliBanner(hasColor = true): string {
  const cyan = hasColor ? "\x1b[38;2;0;240;255m" : ""
  const violet = hasColor ? "\x1b[38;2;168;85;247m" : ""
  const emerald = hasColor ? "\x1b[38;2;16;185;129m" : ""
  const dim = hasColor ? "\x1b[2m" : ""
  const reset = hasColor ? "\x1b[0m" : ""

  return [
    `${cyan} █████╗ ██╗██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗${reset}`,
    `${cyan}██╔══██╗██║██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝${reset}`,
    `${violet}███████║██║██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗  ${reset}`,
    `${violet}██╔══██║██║██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝  ${reset}`,
    `${emerald}██║  ██║██║██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗${reset}`,
    `${emerald}╚═╝  ╚═╝╚═╝╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝${reset}`,
    `${dim}[ aibr ${CLI_VERSION} ] > Tailscale Mesh Control Plane for AI Agents${reset}`,
  ].join("\n")
}

/**
 * Prints the CLI splash banner to stdout or custom writer.
 */
export function printCliBanner(writer?: (s: string) => void, hasColor = true): void {
  const out = writer ?? ((s: string) => process.stdout.write(s))
  out(getCliBanner(hasColor) + "\n")
}

// ── Profile validation ─────────────────────────────────────────────────

/**
 * Validate a profile name argument.
 *
 * Returns `null` on success, or a user-facing error string on failure.
 * Error strings NEVER echo the raw input (prevents leaking traversal chars).
 */
function validateProfileArg(value: string | null): string | null {
  if (value === null || value.length === 0) {
    return "--profile is required"
  }

  try {
    validateProfileName(value)
    return null
  } catch {
    return "Invalid profile name (use alphanumeric and hyphens, 1-64 chars)"
  }
}

/**
 * Reads a secret that the profile may legitimately not have.
 *
 * `readSecret` throws when the file is absent -- that is correct for a secret that
 * must exist, and wrong for the bearer token of a profile in `none` mode, where
 * `aibr setup` never writes one. Returns `null` for absent, unreadable, or
 * permission-refused, and lets a real error (a symlink, a bad mode) surface, since
 * those are configuration faults an operator needs to hear about rather than a
 * mode that was chosen.
 *
 * Callers pass the result straight into `createAuthProvider`, which fails closed
 * if a `bearer-token` profile turns out to have no secret.
 */
async function readOptionalSecret(secretPath: string): Promise<string | null> {
  try {
    const value = await readSecret(secretPath)
    return value.length === 0 ? null : value
  } catch {
    return null
  }
}

/**
 * The agent ids a profile already lists in its `agents[]`.
 *
 * OPTIONAL BY DESIGN. `aibr discover` must work with no profile at all, so an
 * absent profile is an ordinary empty answer rather than an error — the
 * `enrolled` flag degrades to "we know of no enrolments", which is honest, and
 * the output says so through `enrolledSource`.
 *
 * READ-ONLY, and reads only this one file. Enrolment belongs to a separate,
 * credentialed step; a discovery run that so much as created a profile
 * directory to look inside would be a command that changes state in order to
 * report state.
 */
async function readEnrolledAgentIds(profile: string | undefined): Promise<readonly string[]> {
  if (profile === undefined) return []

  let config: Record<string, unknown> | null
  try {
    const paths = resolveProfilePaths(profile)
    config = await readConfig(`${paths.configDir}/config.json`) as Record<string, unknown> | null
  } catch {
    // An unresolvable HOME or an unreadable config means "no labels to draw",
    // not "abort the report": the tailnet is still worth listing.
    return []
  }
  if (config === null) return []

  const agents = config.agents
  if (!Array.isArray(agents)) return []
  return agents
    .map((entry) => (typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id : null))
    .filter((id): id is string => id !== null)
}

// ── discover output projection ──────────────────────────────────────────

/**
 * Bumped when a field is removed or changes meaning, never for an addition.
 *
 * The Herdr agent-manager plugin parses this document, so a consumer pinned to
 * `schemaVersion: 1` must be able to trust that `peers[i].reachable` still
 * means what it meant when it pinned. Additive keys stay additive.
 */
const DISCOVERY_SCHEMA_VERSION = 1

/**
 * Fixed reminder carried in every `--json` document.
 *
 * It ships IN the machine-readable output rather than in a comment because the
 * field most likely to be misread by a consumer is `reachable`: a downstream
 * that reads it as "trusted" has misread the threat model, and a string in the
 * payload travels with the data to whoever debugs it later.
 */
const DISCOVERY_NOTICE =
  "Reachability is not authentication: 'reachable' means an HTTP answer on the bridge port, " +
  "not an identity. 'enrolled' is a label for ids already listed in this profile's agents[]. " +
  "Trust is established with ed25519 node keys, enrollment codes, and peer pins (src/mesh/identity/). " +
  "Discovery enrols nothing and writes nothing."

/**
 * The probe result with credential-shaped ids removed, for both output paths.
 *
 * Applied to the render as well as the JSON document on purpose: the widget
 * prints `agentId` too, so scrubbing only the machine-readable half would leave
 * the same string on screen for anyone who forgets the flag.
 *
 * The rule itself lives in `./discovery-safety.js`, which `aibr setup` also
 * imports: this was a second copy, and two copies of a redaction guard is one
 * copy too many.
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
 * Project the probe result into the stable `--json` document.
 *
 * Peer fields are otherwise copied verbatim rather than reshaped: the probe
 * already emits exactly the fields a caller needs, and a second projection here
 * would be a second place for the shape to drift. `peersFound` is kept
 * alongside `peers.length` because they answer different questions — the
 * daemon's peer count before probing, versus what this run reported on.
 */
function discoveryDocument(
  result: AgentDiscoveryResult,
  enrolledSource: string | null,
): Record<string, unknown> {
  const safe = sanitizeDiscoveryResult(result)
  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    ok: true,
    // Which profile's `agents[]` supplied the enrolled labels, or `null` when
    // none were loaded. Without this a consumer cannot tell "no peers are
    // enrolled" from "we never looked".
    enrolledSource,
    peers: safe.agents,
    peersFound: safe.peersFound,
    reachableCount: safe.reachableCount,
    enrolledCount: safe.enrolledCount,
    notice: DISCOVERY_NOTICE,
  }
}

/**
 * The same shape with `ok: false`, so a consumer parses one document type
 * whether the run succeeded or not.
 */
function discoveryErrorDocument(message: string): Record<string, unknown> {
  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    ok: false,
    error: message,
    enrolledSource: null,
    peers: [],
    peersFound: 0,
    reachableCount: 0,
    enrolledCount: 0,
    notice: DISCOVERY_NOTICE,
  }
}

/** One line after the widget, for a human at a terminal. */
function discoverySummaryLine(result: AgentDiscoveryResult): string {
  if (result.peersFound === 0) {
    // An empty tailnet is a normal answer, not a failure: a single-node
    // tailnet, a laptop with Tailscale stopped, and "the daemon is not
    // installed" all look identical from here, and none of them is an error
    // an operator needs to be scolded for.
    return "No peers found. Nothing was enrolled and nothing was changed.\n"
  }
  return (
    `Discovered ${result.peersFound} peer(s); ${result.reachableCount} answered /health; ` +
    `${result.enrolledCount} enrolled.\n` +
    "Reachability is not authentication, and a reachable peer is not a trusted one.\n"
  )
}

// ── Main entry ─────────────────────────────────────────────────────────

/**
 * Run discovery through the injected dependency, falling back to the host
 * module.
 *
 * The fallback mirrors `verify`/`update`/`bundle`: a caller that supplies a
 * `CliDeps` without `discoverAgents` (an older embedder, a partial fake) still
 * gets a working command, loaded on demand so nothing discovery-shaped is
 * pulled into a process that only wanted `--help`.
 */
async function runDiscovery(deps: CliDeps, profile: string | undefined): Promise<AgentDiscoveryResult> {
  if (deps.discoverAgents !== undefined) {
    return await deps.discoverAgents(profile === undefined ? undefined : { profile })
  }
  const { probeDiscoveredAgents } = await import("./cli/setup-step-widgets.js")
  return await probeDiscoveredAgents()
}

/**
 * Run the CLI with the given argv and dependencies.
 *
 * @returns 0 on success, 1 on any error.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<CliExitCode> {
  const args = parseArgs(argv)

  // ── Global flags (synchronous, no deps needed) ─────────────────────
  if (args.hasFlag("--help")) {
    deps.writer(helpText())
    return 0
  }

  if (args.hasFlag("--version")) {
    if (deps.isTTY) {
      printCliBanner(deps.writer)
    }
    deps.writer(`${deps.version}\n`)
    return 0
  }

  // ── Unknown flags ──────────────────────────────────────────────────
  if (args.unknownFlags.length > 0) {
    deps.writer(`Error: unknown flag ${args.unknownFlags[0]}\n`)
    return 1
  }

  // ── No command ─────────────────────────────────────────────────────
  if (args.command === null) {
    deps.writer(helpText())
    return 1
  }

  // ── Unknown command ────────────────────────────────────────────────
  if (!(ALL_COMMANDS as readonly string[]).includes(args.command)) {
    deps.writer(`Error: unknown command "${args.command}"\n`)
    return 1
  }

  const command = args.command

  // ── setup ──────────────────────────────────────────────────────────
  if (command === "setup") {
    if (!deps.isTTY) {
      deps.writer("Error: setup requires an interactive TTY\n")
      return 1
    }
    printCliBanner(deps.writer)
    try {
      const outcome = await deps.runSetup(args.profile ?? undefined)
      switch (outcome.kind) {
        case "persisted":
          deps.writer(`Profile "${outcome.profileName}" created. Config: ${outcome.configPath}\n`)
          // The supervisor unit is `KeepAlive`, so "written but not running" is
          // the single most misleading thing setup can report. Say which it is.
          if (outcome.daemon) {
            if (outcome.daemon.error !== null) {
              deps.writer(`Daemon: not started (${outcome.daemon.error})\n`)
            } else if (outcome.daemon.started) {
              deps.writer("Daemon: started\n")
            } else if (outcome.daemon.installed) {
              deps.writer(
                `Daemon: unit written to ${outcome.daemon.unitPath ?? "?"} but not started. Start it with: ${outcome.daemon.command ?? "?"}\n`,
              )
            } else {
              deps.writer("Daemon: no supervisor unit written on this platform\n")
            }
          }
          if (outcome.launchTui && deps.runTui) {
            return await deps.runTui(outcome.profileName ?? "default")
          }
          return 0
        case "blocked":
          deps.writer(`Setup blocked: ${outcome.reason ?? "unknown reason"}\n`)
          return 1
        case "declined":
          deps.writer("Setup declined.\n")
          return 1
      }
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "setup failed"}\n`)
      return 1
    }
  }

  // ── verify ─────────────────────────────────────────────────────────
  if (command === "verify") {
    let profile = "default"
    if (args.profile !== null) {
      const err = validateProfileArg(args.profile)
      if (err !== null) {
        deps.writer(`Error: ${err}\n`)
        return 1
      }
      profile = args.profile
    }

    try {
      if (deps.verifyProfile) {
        const result = await deps.verifyProfile(profile)
        deps.writer(result.summary + "\n")
        return result.ok ? 0 : 1
      }
      const { runVerify } = await import("./cli/verify.js")
      const result = await runVerify(profile)
      deps.writer(result.summary + "\n")
      return result.ok ? 0 : 1
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "verify failed"}\n`)
      return 1
    }
  }

  // ── update ─────────────────────────────────────────────────────────
  if (command === "update") {
    const checkOnly = args.hasFlag("--check")
    const yes = args.hasFlag("--yes")

    try {
      if (deps.runUpdate) {
        const result = await deps.runUpdate({ checkOnly, yes })
        deps.writer(result.message + "\n")
        return result.ok ? 0 : 1
      }
      const { runUpdate } = await import("./cli/update.js")
      const result = await runUpdate(
        { checkOnly, yes },
        { currentVersion: deps.version, isTTY: deps.isTTY },
      )
      deps.writer(result.message + "\n")
      return result.ok ? 0 : 1
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "update failed"}\n`)
      return 1
    }
  }

  // ── discover ────────────────────────────────────────────────────────
  // Ahead of the `--profile` gate below: discovery queries the tailnet, not a
  // profile, and a scriptable command that refuses to run before setup has ever
  // been run is not scriptable.
  if (command === "discover") {
    const json = args.hasFlag("--json")

    // Optional, and validated only when given. It contributes enrolled LABELS
    // and nothing else; an invalid name is still an error rather than a
    // silent downgrade to "no profile".
    let profile: string | undefined
    if (args.profile !== null) {
      const profileErr = validateProfileArg(args.profile)
      if (profileErr !== null) {
        if (json) {
          deps.writer(JSON.stringify(discoveryErrorDocument(profileErr)) + "\n")
        } else {
          deps.writer(`Error: ${profileErr}\n`)
        }
        return 1
      }
      profile = args.profile
    }

    try {
      const result = await runDiscovery(deps, profile)
      if (json) {
        deps.writer(JSON.stringify(discoveryDocument(result, profile ?? null)) + "\n")
      } else {
        // Lazy for the same reason as the probe itself: a `--json` caller on a
        // machine that never renders a widget should not pay to load one.
        const { renderAgentDiscoveryProbe } = await import("./cli/setup-step-widgets.js")
        deps.writer(renderAgentDiscoveryProbe(sanitizeDiscoveryResult(result)) + "\n")
        deps.writer(discoverySummaryLine(result))
      }
      return 0
    } catch {
      // Deliberately not `err.message`. The documented throw paths here are a
      // runner that cannot spawn and a host that cannot resolve its config
      // directory, and both of those put a filesystem path into the message.
      // The CLI's rule is that operator output carries no internal paths, and
      // a fixed string loses nothing an operator can act on here: discovery
      // degrades to an empty list on every ordinary failure, so a throw means
      // the probe itself was broken, not that the tailnet is.
      if (json) {
        deps.writer(JSON.stringify(discoveryErrorDocument("discovery failed")) + "\n")
      } else {
        deps.writer("Error: discovery failed\n")
      }
      return 1
    }
  }

  // ── Commands that require --profile ────────────────────────────────
  const profileErr = validateProfileArg(args.profile)
  if (profileErr !== null) {
    deps.writer(`Error: ${profileErr}\n`)
    return 1
  }

  const profile = args.profile!

  // ── tui ────────────────────────────────────────────────────────────
  if (command === "tui") {
    if (!deps.isTTY || deps.isInputTTY === false) {
      deps.writer("Error: tui requires interactive stdin and stdout TTYs\n")
      return 1
    }
    if (deps.runTui === undefined) {
      deps.writer("Error: TUI application service is unavailable\n")
      return 1
    }
    try {
      return await deps.runTui(profile)
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "tui failed"}\n`)
      return 1
    }
  }

  // ── start ──────────────────────────────────────────────────────────
  if (command === "start") {
    try {
      const result = await deps.startProfile(profile)
      switch (result.kind) {
        case "started":
          deps.writer(`Started tmux session: ${result.sessionName}\n`)
          return 0
        case "already_running":
          deps.writer(`Already running: ${result.sessionName}\n`)
          return 0
        case "tmux_error":
          deps.writer(`tmux_error: ${result.stderr ?? "unknown error"}\n`)
          return 1
      }
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "start failed"}\n`)
      return 1
    }
  }

  // ── serve ──────────────────────────────────────────────────────────
  if (command === "serve") {
    try {
      await deps.serveBridge(profile, { shadowMode: args.hasFlag("--shadow-mode") })
      return 0
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "serve failed"}\n`)
      return 1
    }
  }

  // ── worker ─────────────────────────────────────────────────────────
  if (command === "worker") {
    try {
      await deps.runWorker(profile, { publishIpc: args.hasFlag("--ipc-publish") })
      return 0
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "worker failed"}\n`)
      return 1
    }
  }

  // ── status ─────────────────────────────────────────────────────────
  if (command === "status") {
    try {
      const result = await deps.statusProfile(profile)
      switch (result.kind) {
        case "healthy":
          deps.writer(`healthy: ${result.sessionName}\n${result.body ?? ""}\n`)
          return 0
        case "session_missing":
          deps.writer(`session_missing: ${result.sessionName}\n`)
          return 1
        case "bridge_unavailable":
          deps.writer(`bridge_unavailable: ${result.sessionName} (status ${result.probeStatus ?? "?"})\n`)
          return 1
      }
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "status failed"}\n`)
      return 1
    }
  }

  // ── bundle ─────────────────────────────────────────────────────────
  if (command === "bundle") {
    if (deps.runBundle) {
      try {
        return await deps.runBundle(profile, { preview: args.hasFlag("--preview") })
      } catch (err) {
        deps.writer(`Error: ${err instanceof Error ? err.message : "bundle failed"}\n`)
        return 1
      }
    }
    try {
      const { generateSupportBundle, previewSupportBundle } = await import("./diagnostics/bundle.js")
      const { resolveProfilePaths } = await import("./host/paths.js")
      const paths = resolveProfilePaths(profile)
      const configPath = `${paths.configDir}/config.json`
      const stateDir = paths.stateDir
      const bundle = generateSupportBundle({
        profile,
        configPath,
        stateDir,
      })
      if (args.hasFlag("--preview")) {
        deps.writer(previewSupportBundle(bundle) + "\n")
      } else {
        deps.writer(JSON.stringify(bundle, null, 2) + "\n")
      }
      return 0
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "bundle failed"}\n`)
      return 1
    }
  }

  // ── _opencode (hidden) ─────────────────────────────────────────────
  if (command === "_opencode") {
    try {
      await deps.runOpencode(profile)
      return 0
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "opencode failed"}\n`)
      return 1
    }
  }

  // Unreachable
  return 1
}

async function createRealDeps(): Promise<CliDeps> {
  const { resolve } = await import("node:path")
  const { startBridge } = await import("./bridge.js")
  const { startProfile, statusProfile } = await import("./host/tmux.js")
  const { runSetup } = await import("./host/setup.js")
  const { BunProcessRunner, BunPlatformInspector, BunPrompter, createStreamLineReader } = await import("./host/runtime.js")
  const { ensureProfileDirs, writeConfig, writeSecret } = await import("./host/profile-store.js")
  const { readFile } = await import("node:fs/promises")

  const processRunner = new BunProcessRunner()
  const platformInspector = new BunPlatformInspector()
  const writer = (s: string): void => {
    process.stdout.write(s)
  }

  return {
    writer,
    isTTY: Boolean(process.stdout?.isTTY),
    isInputTTY: Boolean(process.stdin?.isTTY),
    runTui: async (profile: string) => {
      // The Rust client attaches to the IPC daemon. When the daemon socket is
      // active, the Rust client is preferred. If the daemon is not running or the
      // client exits with code 1, the OpenTUI shell remains the fallback so `aibr tui`
      // always launches a working workspace.
      const { findTuiBinary, runRustTui } = await import("./tui/rust-client.js")
      const { resolveSocketPath } = await import("./ipc/publisher.js")
      const binary = findTuiBinary()
      const socketActive = existsSync(resolveSocketPath())
      const forceRust = process.env.AIBRIDGE_TUI_CLIENT === "rust"

      if (binary !== null && (socketActive || forceRust)) {
        try {
          const exitCode = await runRustTui(profile)
          if (exitCode === 0) return 0
          process.stderr.write(
            `\n[aibr] Rust TUI client exited with code ${exitCode}. Falling back to OpenTUI shell...\n`,
          )
        } catch (error) {
          process.stderr.write(
            `aibr tui: failed to launch native Rust client (${error instanceof Error ? error.message : String(error)}), falling back to OpenTUI shell...\n`,
          )
        }
      }
      const { runLocalTui } = await import("./tui/bootstrap.js")
      return runLocalTui(profile)
    },

    runSetup: async (profile?: string) => {
      const reader = createStreamLineReader(Bun.stdin.stream())
      const prompter = new BunPrompter({
        reader,
        writer: { write: (d: Uint8Array) => { void process.stdout.write(d) } },
        isTTY: Boolean(process.stdin?.isTTY),
      })

      const { runSetupWizard } = await import("./cli/setup-wizard.js")
      return runSetupWizard({
        platformInspector,
        processRunner,
        prompter,
        initialProfile: profile,
        env: process.env as Record<string, string | undefined>,
        fileOps: {
          writeConfig: async (path, data) => writeConfig(path, data),
          writeSecret: async (path, value) => writeSecret(path, value),
          ensureProfileDirs: async (paths) => ensureProfileDirs(paths),
          readConfig: async (path) => readConfig(path),
        },
        // The wizard's own stale-secret guard for `auth_mode: "none"`. Backed by a
        // real filesystem lookup here; the module defaults to the same check when
        // a caller (a test) does not supply one.
        pathExists: async (path) => {
          try {
            await access(path)
            return true
          } catch {
            return false
          }
        },
      })
    },

    startProfile: async (profile: string) => {
      const paths = resolveProfilePaths(profile)
      const configPath = `${paths.configDir}/config.json`
      let config: Record<string, unknown> | null = null
      try {
        config = await readConfig(configPath) as Record<string, unknown> | null
      } catch {
        // unreadable
      }
      if (!config) {
        throw new Error(`Profile "${profile}" not found. Run "aibr setup --profile ${profile}" first.`)
      }
      const bridge = config.bridge as Record<string, unknown>
      const opencode = config.opencode as Record<string, unknown>
      let ocPassword = process.env.OPENCODE_SERVER_PASSWORD
      if (!ocPassword) {
        try {
          ocPassword = await readSecret(`${paths.secretsDir}/opencode_password`)
        } catch {
          // unreadable or missing
        }
      }
      const env = {
        ...process.env,
        ...(ocPassword ? { OPENCODE_SERVER_PASSWORD: ocPassword } : {}),
      }
      return startProfile(
        { processRunner, httpProbe: { probe: async () => ({ status: 0, ok: false, body: "" }) }, env },
        {
          name: profile,
          bridgePort: bridge.port as number,
          opencodePort: opencode.server_port as number,
          sessionName: `aibridge-${profile}`,
        },
      )
    },

    serveBridge: async (profile: string, serveOptions?: { readonly shadowMode?: boolean }) => {
      const paths = resolveProfilePaths(profile)
      const configPath = `${paths.configDir}/config.json`
      let ocPassword = process.env.OPENCODE_SERVER_PASSWORD
      if (!ocPassword) {
        try {
          ocPassword = await readSecret(`${paths.secretsDir}/opencode_password`)
        } catch {
          // unreadable or missing
        }
      }
      const bearerToken = await readOptionalSecret(`${paths.secretsDir}/bearer_token`)
      const bridge = await startBridge({
        configPath,
        stateDir: paths.stateDir,
        bearerToken,
        environment: {
          ...process.env as Record<string, string>,
          ...(ocPassword ? { OPENCODE_SERVER_PASSWORD: ocPassword } : {}),
        },
        shadowMode: serveOptions?.shadowMode,
      })

      let bus: IpcBusHandle | undefined
      try {
        const { QueueBridge, startIpcBus } = await import("./ipc/bridge.js")
        const queueBridge = new QueueBridge()
        bus = await startIpcBus({
          config: bridge.config,
          jobManager: bridge.jobManager,
          bridge: queueBridge,
          outboxPendingCount: () => 0,
          // Only a secret that exists is a secret worth scrubbing: a null bearer
          // token handed to the redactor would become a pattern matching every
          // empty string, which redacts nothing and costs a pass per client.
          customSecrets: bearerToken === null ? [] : [bearerToken],
        })
      } catch {
        // IPC bus is optional; bridge continues if socket cannot be bound
      }

      await bridge.app.listen({ host: bridge.config.bridge.host, port: bridge.config.bridge.port })
      await new Promise<void>((resolve) => {
        const onSignal = (): void => {
          if (bus !== undefined) {
            void bus.stop().catch(() => {})
          }
          void bridge.app.close().then(() => resolve(), () => resolve())
        }
        process.once("SIGINT", onSignal)
        process.once("SIGTERM", onSignal)
      })
    },

    runWorker: async (profile: string, workerOptions?: { readonly publishIpc?: boolean }) => {
      const { startIngressWorker } = await import("./ingress/worker.js")
      const paths = resolveProfilePaths(profile)
      const bearerToken = await readOptionalSecret(`${paths.secretsDir}/bearer_token`)
      const publishIpc = workerOptions?.publishIpc === true

      // Created before the worker and attached after, because the drainer needs its
      // observer at construction and the publisher needs the drainer to exist. See
      // `QueueBridge`'s header in src/ipc/bridge.ts.
      const { QueueBridge, startIpcBus } = await import("./ipc/bridge.js")
      const bridge = new QueueBridge()

      const worker = await startIngressWorker({
        configPath: `${paths.configDir}/config.json`,
        stateDir: paths.stateDir,
        bearerToken,
        environment: process.env as Record<string, string>,
        // Supplied here rather than inside `startIngressWorker` so that module keeps
        // no dependency on the IPC surface, and so this flag is the single place
        // that decides whether a socket exists at all.
        ingressObserver: publishIpc ? bridge : undefined,
      })
      let bus: IpcBusHandle | undefined
      if (publishIpc) {
        bus = await startIpcBus({
          config: worker.config,
          jobManager: worker.jobManager,
          bridge,
          // Read through the drainer's own connection, as a `COUNT` against the
          // table rather than a maintained counter: a counter and the table disagree
          // the moment a drainer is killed mid-cycle, and the number a client is
          // shown must not be the optimistic one.
          outboxPendingCount: () => worker.pendingIngressCount(),
          // The node's own bearer token, so a token an agent echoed into a job detail
          // is scrubbed on the way to a client rather than merely on the way to a log.
          // Dropped when there is none: a null in this list would reach the redactor
          // as an empty-string pattern that matches everything and redacts nothing.
          customSecrets: bearerToken === null ? [] : [bearerToken],
        })
      }

      // Announced rather than silent: a socket that appears without a word about it
      // is a socket an operator cannot account for, and this one is reachable by
      // anything running as this user.
      writer(`IPC bus: ${bus === undefined ? "off" : `serving on ${bus.publisher.socketPath}`}\n`)

      // `Restart=always` sends SIGTERM; a drain loop that ignored it would be killed
      // mid-claim on every deploy, and the row would sit in 'sending' until
      // `recoverStale` noticed the lease had expired.
      await new Promise<void>((resolve) => {
        const onSignal = (): void => {
          worker.stop()
          // Closing the LISTENER is the whole shutdown path: it closes client
          // connections and nothing else. No pane is signalled and no job is
          // cancelled, which is the same rule `ControlCommand::detach` follows for
          // one client -- a socket dying is never a signal.
          if (bus === undefined) {
            resolve()
            return
          }
          void bus.stop().then(() => resolve(), () => resolve())
        }
        process.once("SIGINT", onSignal)
        process.once("SIGTERM", onSignal)
      })
    },

    statusProfile: async (profile: string) => {
      const paths = resolveProfilePaths(profile)
      const configPath = `${paths.configDir}/config.json`
      let config: Record<string, unknown> | null = null
      try {
        config = await readConfig(configPath) as Record<string, unknown> | null
      } catch {
        // unreadable
      }
      if (!config) {
        throw new Error(`Profile "${profile}" not found. Run "aibr setup --profile ${profile}" first.`)
      }
      const bridge = config.bridge as Record<string, unknown>
      const opencode = config.opencode as Record<string, unknown>
      const res = await statusProfile(
        { processRunner, httpProbe: { probe: async (url: string) => {
          try {
            const resp = await fetch(url)
            const body = await resp.text()
            return { status: resp.status, ok: resp.ok, body }
          } catch {
            return { status: 0, ok: false, body: "" }
          }
        }}, env: process.env as Record<string, string | undefined> },
        {
          name: profile,
          bridgePort: bridge.port as number,
          opencodePort: opencode.server_port as number,
          sessionName: `aibridge-${profile}`,
        },
      )
      if (res.kind === "healthy") {
        const summary = [
          "Configuration summary:",
          `  Agent ID: ${config.agent_id}`,
          `  Bridge: ${bridge.public_url ?? `http://${bridge.host}:${bridge.port}`}`,
          `  OpenCode: ${opencode.base_url}`,
          "Readiness state: healthy",
          res.body ? `Probe response: ${res.body}` : "",
        ].filter(Boolean).join("\n")
        return {
          ...res,
          body: summary,
        }
      }
      return res
    },
    verifyProfile: async (profile: string) => {
      const { runVerify } = await import("./cli/verify.js")
      const result = await runVerify(profile, {
        processRunner,
        platformInspector,
        env: process.env as Record<string, string | undefined>,
      })
      return {
        ok: result.ok,
        summary: result.summary,
      }
    },
    runUpdate: async (options) => {
      const { runUpdate } = await import("./cli/update.js")
      const { BunPrompter, createStreamLineReader } = await import("./host/runtime.js")
      const reader = createStreamLineReader(Bun.stdin.stream())
      const prompter = new BunPrompter({
        reader,
        writer: { write: (d: Uint8Array) => { void process.stdout.write(d) } },
        isTTY: Boolean(process.stdin?.isTTY),
      })
      const result = await runUpdate(options, {
        currentVersion: CLI_VERSION,
        processRunner,
        prompter,
        isTTY: Boolean(process.stdout?.isTTY),
      })
      return {
        ok: result.ok,
        message: result.message,
      }
    },

    discoverAgents: async (options?: { readonly profile?: string }) => {
      const { probeDiscoveredAgents } = await import("./cli/setup-step-widgets.js")
      // Always passing the list, empty or not: the probe turns it into a
      // lookup set, and an empty set and an absent one behave identically.
      // Which profile the labels came from is reported separately, through
      // `enrolledSource`, so nothing here depends on the array being absent.
      return await probeDiscoveredAgents({
        processRunner,
        enrolledAgentIds: await readEnrolledAgentIds(options?.profile),
      })
    },

    runOpencode: async (profile: string) => {
      const paths = resolveProfilePaths(profile)
      let ocPassword = process.env.OPENCODE_SERVER_PASSWORD
      if (!ocPassword) {
        try {
          ocPassword = await readSecret(`${paths.secretsDir}/opencode_password`)
        } catch {
          // unreadable or missing
        }
      }
      const opencodePort = process.env.OPENCODE_PORT ?? "4096"
      const opencodeBin = process.env.OPENCODE_BIN ?? (findInPath("opencode2") ? "opencode2" : "opencode")
      const result = await processRunner.exec(
        [opencodeBin, "serve", "--port", opencodePort, "--hostname", "127.0.0.1"],
        {
          env: {
            ...process.env as Record<string, string>,
            ...(ocPassword ? { OPENCODE_SERVER_PASSWORD: ocPassword } : {}),
          },
        },
      )
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `${opencodeBin} serve failed`)
      }
    },

    version: CLI_VERSION,
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/cli.js") ||
  process.argv[1]?.endsWith("/cli.ts")

if (isMain) {
  const deps = await createRealDeps()
  const exitCode = await runCli(process.argv.slice(2), deps)
  process.exit(exitCode)
}

import type { PlatformInspector, ProcessRunner } from "../host/types.js"
import type { AgentDiscoveryDeps, AgentDiscoveryResult } from "./setup-step-widgets.js"
import { resolveProfilePaths, type ProfilePaths } from "../host/paths.js"
import { readConfig } from "../host/profile-store.js"
import { planPreflight } from "../host/preflight.js"
import { bridgeConfigSchema } from "../config/schemas.js"
import type { BridgeConfig } from "../config/types.js"
import { lstat, readFile, access } from "node:fs/promises"
import { constants } from "node:fs"

export type CheckStatus = "pass" | "fail" | "warn"

export interface VerifyCheck {
  readonly name: string
  readonly status: CheckStatus
  readonly message: string
  readonly detail?: string
}

export interface VerifyReport {
  readonly ok: boolean
  readonly profile: string
  readonly configPath: string
  readonly checks: readonly VerifyCheck[]
  readonly summary: string
}

export interface VerifyFileOps {
  readonly readConfig: (path: string) => Promise<Record<string, unknown> | null>
  readonly stat: (path: string) => Promise<{ mode: number; isSymbolicLink: () => boolean; isDirectory: () => boolean }>
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>
  readonly pathExists: (path: string) => Promise<boolean>
}

export interface VerifyDeps {
  readonly platformInspector?: PlatformInspector
  readonly processRunner?: ProcessRunner
  readonly fileOps?: VerifyFileOps
  readonly env?: Record<string, string | undefined>
  readonly customConfigPath?: string
  readonly bunVersion?: string
  /**
   * Tailnet discovery probe. Defaults to `probeDiscoveredAgents`, and is a dep
   * rather than a direct import for the same reason `processRunner` is: the real
   * one shells out to `tailscale` and dials every peer over HTTP, so a unit test
   * must be able to say "here is the tailnet" instead of reading the operator's.
   */
  readonly discoverAgents?: (deps?: AgentDiscoveryDeps) => Promise<AgentDiscoveryResult>
}

/** Peers named in the discovery detail line before the list is truncated. */
const DISCOVERY_DETAIL_PEER_LIMIT = 5

/** Shorter than `probeDiscoveredAgents`' default: `verify` is a batch report, not a wizard screen. */
const DISCOVERY_TIMEOUT_MS = 1500

function parseSemverGte(current: string, min: string): boolean {
  const cParts = current.split(".").map((n) => parseInt(n, 10))
  const mParts = min.split(".").map((n) => parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const c = cParts[i] ?? 0
    const m = mParts[i] ?? 0
    if (c > m) return true
    if (c < m) return false
  }
  return true
}

async function defaultStat(path: string): Promise<{ mode: number; isSymbolicLink: () => boolean; isDirectory: () => boolean }> {
  const s = await lstat(path)
  return {
    mode: s.mode,
    isSymbolicLink: () => s.isSymbolicLink(),
    isDirectory: () => s.isDirectory(),
  }
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function runVerify(profileName: string, deps?: VerifyDeps): Promise<VerifyReport> {
  const env = deps?.env ?? (process.env as Record<string, string | undefined>)
  const checks: VerifyCheck[] = []

  // Resolve profile paths
  let paths: ProfilePaths
  try {
    paths = resolveProfilePaths(profileName, env)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      profile: profileName,
      configPath: "",
      checks: [
        {
          name: "profile-paths",
          status: "fail",
          message: `Invalid profile "${profileName}": ${msg}`,
        },
      ],
      summary: `AIBridge Verification for profile "${profileName}":\n  [✗] Invalid profile paths: ${msg}\n\nStatus: FAILED (1 check failed)`,
    }
  }

  const configPath = deps?.customConfigPath ?? `${paths.configDir}/config.json`

  // ── 1. Check Bun runtime ───────────────────────────────────────────
  const bunVer = deps?.bunVersion ?? (typeof process !== "undefined" && process.versions && (process.versions as Record<string, string>).bun ? (process.versions as Record<string, string>).bun : "1.3.14")
  if (parseSemverGte(bunVer, "1.3.0")) {
    checks.push({
      name: "runtime-bun",
      status: "pass",
      message: `Bun runtime >= 1.3.0 (detected: ${bunVer})`,
    })
  } else {
    checks.push({
      name: "runtime-bun",
      status: "fail",
      message: `Bun runtime >= 1.3.0 required, found ${bunVer}`,
    })
  }

  // ── 2. Check Host Prerequisites (tmux, opencode, tailscale) ────────
  let processRunner = deps?.processRunner
  let platformInspector = deps?.platformInspector

  if (!processRunner || !platformInspector) {
    const { BunProcessRunner, BunPlatformInspector } = await import("../host/runtime.js")
    processRunner = processRunner ?? new BunProcessRunner()
    platformInspector = platformInspector ?? new BunPlatformInspector()
  }

  const preflight = await planPreflight({
    platformInspector,
    processRunner,
  })

  for (const check of preflight.checks) {
    if (check.status === "installed") {
      checks.push({
        name: `prereq-${check.name}`,
        status: "pass",
        message: `Dependency ${check.name}: installed`,
      })
    } else {
      checks.push({
        name: `prereq-${check.name}`,
        status: "fail",
        message: `Dependency ${check.name}: missing`,
        detail: check.installCmd ? `Install with: ${check.installCmd.join(" ")}` : undefined,
      })
    }
  }

  // ── 3. Check Tailscale connection ──────────────────────────────────
  if (preflight.tailscale.ip !== null && preflight.tailscale.backendState === "Running") {
    checks.push({
      name: "tailscale-active",
      status: "pass",
      message: `Tailscale active (IP: ${preflight.tailscale.ip}, backend: Running)`,
    })
  } else if (preflight.tailscale.backendState && preflight.tailscale.backendState !== "Running") {
    checks.push({
      name: "tailscale-active",
      status: "fail",
      message: `Tailscale backend state is not Running (${preflight.tailscale.backendState})`,
      detail: preflight.tailscale.error ?? undefined,
    })
  } else if (preflight.tailscale.ip === null) {
    checks.push({
      name: "tailscale-active",
      status: "fail",
      message: "Tailscale is not active or has no assigned IP",
      detail: preflight.tailscale.error ?? undefined,
    })
  }
  // ── 3b. Check Herdr workspace orchestrator (informational) ──────────
  //
  // Per ADR 0009 / ADR 0011 / docs/implementation-plans/aibridge-herdr-orchestration.md §8:
  // Herdr is an optional user-installed terminal backend (`brew install herdr`), never
  // an npm dependency. Headless nodes continue using tmux by default.
  // The AIBridge orchestration fork exposes two capability flags:
  // - F1: input-ownership fencing (`pane.claim_input` / `pane.release_input`)
  // - F2: first-class `role` on pane/agent records
  // Absence of Herdr or absence of fork flags is informational, never a hard failure.
  const herdrFacts = preflight.herdr ?? {
    installed: false,
    path: null,
    capabilities: { inputFencing: "no", firstClassRole: "no" },
    error: null,
  }
  if (herdrFacts.installed) {
    const { inputFencing, firstClassRole } = herdrFacts.capabilities
    const detailParts: string[] = []
    if (herdrFacts.path) detailParts.push(`Binary: ${herdrFacts.path}`)
    if (herdrFacts.error) detailParts.push(`Schema probe note: ${herdrFacts.error}`)
    checks.push({
      name: "herdr",
      status: "pass",
      message: `herdr: found (fork capabilities: input-fencing=${inputFencing}, first-class-role=${firstClassRole})`,
      detail: detailParts.length > 0 ? detailParts.join("; ") : undefined,
    })
  } else {
    checks.push({
      name: "herdr",
      status: "pass",
      message: "herdr: not found",
      detail:
        "Informational: tmux remains the default terminal backend. Install Herdr (e.g. brew install herdr) for GUI workspace orchestration.",
    })
  }

  // ── 4. Check Config File & Schema ───────────────────────────────────
  const fileOps: VerifyFileOps = deps?.fileOps ?? {
    readConfig: (p) => readConfig(p),
    stat: defaultStat,
    readFile: (p, enc) => readFile(p, enc),
    pathExists: defaultPathExists,
  }

  let configData: Record<string, unknown> | null = null
  // The parsed profile, carried forward so the secret checks below can read
  // `security.auth_mode` and `bridge.host` without a second schema parse: two
  // parses are two opinions about the same file, and only one of them is the one
  // that decided the checks are safe to run.
  let parsedConfig: BridgeConfig | null = null
  try {
    configData = await fileOps.readConfig(configPath)
  } catch (err) {
    checks.push({
      name: "config-readable",
      status: "fail",
      message: `Failed to read config file: ${configPath}`,
      detail: err instanceof Error ? err.message : String(err),
    })
  }

  if (configData === null) {
    checks.push({
      name: "config-exists",
      status: "fail",
      message: `Configuration not found at ${configPath}. Run "aibr setup --profile ${profileName}" first.`,
    })
  } else {
    const parseResult = bridgeConfigSchema.safeParse(configData)
    if (parseResult.success) {
      parsedConfig = parseResult.data
      checks.push({
        name: "config-valid",
        status: "pass",
        message: `Configuration valid against schema (${configPath})`,
      })

      // Check project paths existence
      const projects = parseResult.data.projects
      for (const proj of projects) {
        const exists = await fileOps.pathExists(proj.path)
        if (exists) {
          checks.push({
            name: `project-${proj.id}`,
            status: "pass",
            message: `Project directory exists: ${proj.path}`,
          })
        } else {
          checks.push({
            name: `project-${proj.id}`,
            status: "fail",
            message: `Project directory not found: ${proj.path}`,
          })
        }
      }
    } else {
      const issueDetails = parseResult.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
      checks.push({
        name: "config-valid",
        status: "fail",
        message: `Configuration schema validation failed: ${issueDetails}`,
      })
    }
  }

  // ── 5. Check Secrets (Bearer token & OpenCode password) ────────────
  //
  // A profile in `auth_mode: "none"` has no bearer secret by construction, so the
  // block below is skipped and replaced by a standing warning. Reporting a missing
  // secret as a failure there would tell an operator their install is broken when
  // it is in the mode they chose -- and a check that is always wrong is a check
  // people learn to ignore.
  const authMode = parsedConfig?.security.auth_mode === "none" ? "none" : "bearer-token"
  const bridgeHost = parsedConfig?.bridge.host ?? null
  const bearerTokenPath = `${paths.secretsDir}/bearer_token`
  if (authMode === "none") {
    checks.push({
      name: "auth-mode-src-none",
      status: "warn",
      message:
        "Node runs with security.auth_mode \"none\": /trigger and /report accept " +
        "unauthenticated requests. Only safe on a Tailscale CGNAT bind.",
      detail: `bridge.host is ${bridgeHost ?? "unset"}`,
    })
    const staleToken = await fileOps.pathExists(bearerTokenPath).catch(() => false)
    if (staleToken) {
      checks.push({
        name: "auth-mode-src-stale-secret",
        status: "warn",
        message:
          "A bearer_token secret exists but security.auth_mode is \"none\", so it " +
          "is never read. Delete it if it is no longer wanted.",
        detail: bearerTokenPath,
      })
    }
  } else {
  const bearerTokenPath = `${paths.secretsDir}/bearer_token`
  try {
    const stat = await fileOps.stat(bearerTokenPath)
    if (stat.isSymbolicLink()) {
      checks.push({
        name: "secret-bearer-token",
        status: "fail",
        message: `Bearer token secret at ${bearerTokenPath} is a symlink (insecure)`,
      })
    } else {
      const isOverlyPermissive = (stat.mode & 0o077) !== 0
      if (isOverlyPermissive) {
        checks.push({
          name: "secret-bearer-token-mode",
          status: "fail",
          message: `Bearer token secret has overly permissive permissions (mode: 0${(stat.mode & 0o777).toString(8)}, must be 0600 or 0400)`,
        })
      }
      const token = await fileOps.readFile(bearerTokenPath, "utf8")
      const trimmed = token.trim()
      if (trimmed.length < 16) {
        checks.push({
          name: "secret-bearer-token-content",
          status: "fail",
          message: `Bearer token secret is too short (length ${trimmed.length}, minimum 16 characters recommended)`,
        })
      } else {
        checks.push({
          name: "secret-bearer-token",
          status: "pass",
          message: `Bearer token secret valid (stored securely at ${bearerTokenPath})`,
        })
      }
    }
  } catch {
    checks.push({
      name: "secret-bearer-token",
      status: "fail",
      message: `Bearer token secret not found at ${bearerTokenPath}`,
    })
  }
  }

  const ocPasswordPath = `${paths.secretsDir}/opencode_password`
  try {
    const stat = await fileOps.stat(ocPasswordPath)
    if (stat.isSymbolicLink()) {
      checks.push({
        name: "secret-opencode-password",
        status: "fail",
        message: `OpenCode password secret at ${ocPasswordPath} is a symlink (insecure)`,
      })
    } else {
      const pass = await fileOps.readFile(ocPasswordPath, "utf8")
      if (pass.trim().length === 0) {
        checks.push({
          name: "secret-opencode-password",
          status: "fail",
          message: `OpenCode password secret at ${ocPasswordPath} is empty`,
        })
      } else {
        checks.push({
          name: "secret-opencode-password",
          status: "pass",
          message: `OpenCode password secret configured securely at ${ocPasswordPath}`,
        })
      }
    }
  } catch {
    checks.push({
      name: "secret-opencode-password",
      status: "fail",
      message: `OpenCode password secret not found at ${ocPasswordPath}`,
    })
  }

  // ── 6. Tailnet peer discovery (informational) ──────────────────────
  //
  // REACHABILITY IS NOT AUTHENTICATION. Everything below reports what the tailnet
  // looked like and which peers this profile already names. A node with no peers, an
  // empty tailnet, or a missing `tailscale` binary is a normal single-machine
  // install, so none of those paths may reach `fail` — `ok` is computed from
  // `failCount`, and spending a check on "this host is alone" is how a report that
  // is supposed to be trusted becomes one people scroll past.
  //
  // Only two things here are more than trivia: peers that answer while this profile
  // enrols none of them (work sent there would be refused, which is a real gap
  // between what is visible and what is configured), and a probe that could not run
  // at all. Both are `warn`, neither is `fail`.
  // The trust caveat rides along with every projection of this check rather than
  // living in one branch: an operator reading `3 peers reachable` in a green report
  // should not have to know which module to go read to find out what "reachable"
  // does not mean.
  const TRUST_NOTE = "Reachability only: a peer answering /health is not enrolled or trusted by this check."

  const discoverAgents = deps?.discoverAgents ?? (await import("./setup-step-widgets.js")).probeDiscoveredAgents

  const enrolledIds: string[] = []
  if (parsedConfig !== null) {
    for (const agent of parsedConfig.agents) enrolledIds.push(agent.id)
    for (const source of parsedConfig.security.allowed_sources) {
      if (!enrolledIds.includes(source.source_agent_id)) {
        enrolledIds.push(source.source_agent_id)
      }
    }
  }

  let discovery: AgentDiscoveryResult
  try {
    discovery = await discoverAgents({
      ...(processRunner !== undefined ? { processRunner } : {}),
      ...(parsedConfig !== null ? { bridgePort: parsedConfig.bridge.port } : {}),
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      enrolledAgentIds: enrolledIds,
    })
  } catch (err) {
    checks.push({
      name: "tailscale-discovery",
      status: "warn",
      message: "Tailnet discovery could not run",
      detail:
        `${err instanceof Error ? err.message : String(err)}. This check is advisory and ` +
        "proves nothing about authentication; verify the peer list with `aibr discover`. " +
        TRUST_NOTE,
    })
    discovery = { agents: [], reachableCount: 0, enrolledCount: 0, peersFound: 0 }
  }

  const enrolledAgents = discovery.agents.filter((a) => a.enrolled)
  const enrolledDetail = (): string | undefined => {
    if (enrolledAgents.length === 0) return undefined
    const shown = enrolledAgents.slice(0, DISCOVERY_DETAIL_PEER_LIMIT)
    const names = shown.map((a) => `${a.hostname} (${a.ip})`).join(", ")
    const overflow = enrolledAgents.length - shown.length
    // Counts, not identities, for the peers we could not reach: a tailnet of 30
    // sleeping laptops would otherwise bury the config and secret checks below.
    return `Enrolled in this profile: ${names}${overflow > 0 ? `, +${overflow} more` : ""}. ${TRUST_NOTE}`
  }

  if (discovery.reachableCount === 0) {
    if (discovery.peersFound === 0) {
      checks.push({
        name: "tailscale-discovery",
        status: "pass",
        message: "Tailnet discovery: 0 peers reachable, 0 enrolled (no peers on the tailnet)",
        detail:
          "No peers were enumerated — normal for a single-machine install, and also " +
          "what an absent tailscaled or a daemon that cannot be read looks like. " +
          `Discovery is advisory. ${TRUST_NOTE}`,
      })
    } else {
      checks.push({
        name: "tailscale-discovery",
        status: "pass",
        message:
          `Tailnet discovery: 0 peers reachable, 0 enrolled ` +
          `(${discovery.peersFound} peer(s) on the tailnet, none answering /health)`,
        detail:
          "Every peer was offline, or its bridge is not running. A peer that is " +
          `down is not a fault in this node. ${TRUST_NOTE}`,
      })
    }
  } else if (discovery.enrolledCount === 0) {
    checks.push({
      name: "tailscale-discovery",
      status: "warn",
      message: `Tailnet discovery: ${discovery.reachableCount} peers reachable, 0 enrolled`,
      detail:
        `${discovery.reachableCount} peer(s) answered /health but this profile names none of them ` +
        `in agents[] or security.allowed_sources[]. Work sent to them would be refused. ` +
        TRUST_NOTE,
    })
  } else {
    checks.push({
      name: "tailscale-discovery",
      status: "pass",
      message:
        `Tailnet discovery: ${discovery.reachableCount} peers reachable, ` +
        `${discovery.enrolledCount} enrolled`,
      detail: enrolledDetail(),
    })
  }

  // ── Build summary ──────────────────────────────────────────────────
  //
  // `ok` is "nothing failed", not "everything passed": a `warn` is an exposure the
  // operator should see, not a broken install. Scoring it as a failure means the
  // first node configured without a bearer token reports FAILED through no fault
  // of its own, which teaches operators to ignore `aibr verify` entirely.
  const failCount = checks.filter((c) => c.status === "fail").length
  const warnCount = checks.filter((c) => c.status === "warn").length
  const passCount = checks.filter((c) => c.status === "pass").length
  const ok = failCount === 0

  const lines = [
    `AIBridge Verification Report for profile "${profileName}":`,
    ...checks.map((c) => {
      const icon = c.status === "pass" ? "[✓]" : c.status === "warn" ? "[!]" : "[✗]"
      const detail = c.detail ? `\n      ${c.detail}` : ""
      return `  ${icon} ${c.message}${detail}`
    }),
    "",
    ok
      ? `Status: PASSED (${passCount}/${checks.length} checks passed${
          warnCount > 0 ? `, ${warnCount} warning${warnCount === 1 ? "" : "s"}` : ""
        })`
      : `Status: FAILED (${failCount} check${failCount === 1 ? "" : "s"} failed)`,
  ]

  return {
    ok,
    profile: profileName,
    configPath,
    checks,
    summary: lines.join("\n"),
  }
}

/**
 * Deterministic prerequisite inspection and install planning.
 *
 * Checks for tmux, opencode, and tailscale on macOS, Debian, and Ubuntu.
 * Install commands are fixed argv arrays — never shell commands.
 * User confirmation is required before any install executes.
 *
 * Safety invariants:
 * - Never installs Bun.
 * - Never executes curl-pipe patterns.
 * - Never binds public addresses.
 * - Unsupported platforms fail immediately with zero side-effects.
 * - Declined installs are recorded as "declined", not "missing".
 * - Nonzero exit codes produce "failed" status with captured stderr.
 */

import type {
  PlatformInspector,
  ProcessRunner,
  Prompter,
} from "./types.js"
import { z } from "zod"

// ── Types ──────────────────────────────────────────────────────────────

export type PreflightCheckStatus =
  | "installed"
  | "missing"
  | "declined"
  | "failed"

export interface PreflightCheck {
  readonly name: string
  readonly status: PreflightCheckStatus
  /** Fixed argv install command, or null when no known install exists. */
  readonly installCmd: readonly string[] | null
  /** Error message from a failed install, or null. */
  readonly error: string | null
}

export interface TailscaleFacts {
  readonly ip: string | null
  readonly hostname: string | null
  readonly healthStatus: string | null
  readonly backendState: string | null
  readonly tailnetLock: boolean | null
  readonly error: string | null
}

export interface PreflightResult {
  readonly ok: boolean
  readonly platform: string
  readonly checks: readonly PreflightCheck[]
  readonly missing: number
  readonly tailscale: TailscaleFacts
}

export interface PreflightDeps {
  readonly platformInspector: PlatformInspector
  readonly processRunner: ProcessRunner
  readonly prompter?: Prompter
}

// ── Supported platforms ────────────────────────────────────────────────

type OsFamily = "macos" | "debian" | "ubuntu"

const PLATFORM_TO_OS: Record<string, OsFamily> = {
  darwin: "macos",
}

/**
 * Detect OS family from platform string.
 * macOS (darwin) maps to "macos".  Linux maps to "ubuntu" (superset of
 * debian for our install commands).  Everything else returns null.
 */
function detectOs(platform: string): OsFamily | null {
  const mapped = PLATFORM_TO_OS[platform]
  if (mapped !== undefined) return mapped
  if (platform === "linux") return "ubuntu"
  return null
}

// ── Install command table ──────────────────────────────────────────────

/**
 * Fixed argv install commands per (osFamily, toolName).
 * null means no known automated install for this combination.
 *
 * Safety: no curl-pipe, no shell metacharacters, no Bun.
 */
const INSTALL_CMD_TABLE: Record<OsFamily, Record<string, readonly string[] | null>> = {
  macos: {
    tmux: ["brew", "install", "tmux"],
    opencode: null,
    tailscale: ["brew", "install", "tailscale"],
  },
  debian: {
    tmux: ["apt-get", "install", "-y", "tmux"],
    opencode: null,
    tailscale: ["tailscale", "install-from-source", "--confirm", "--prefix=/usr/local"],
  },
  ubuntu: {
    tmux: ["apt-get", "install", "-y", "tmux"],
    opencode: null,
    tailscale: ["tailscale", "install-from-source", "--confirm", "--prefix=/usr/local"],
  },
}

function getInstallCmd(os: OsFamily, tool: string): readonly string[] | null {
  const osCmds = INSTALL_CMD_TABLE[os]
  if (osCmds === undefined) return null
  return osCmds[tool] ?? null
}

// ── Which check ────────────────────────────────────────────────────────

const PREREQS = ["tmux", "opencode", "tailscale"] as const

async function isInstalled(runner: ProcessRunner, name: string): Promise<boolean> {
  const result = await runner.exec(["which", name])
  return result.exitCode === 0
}

// ── Shared check logic ─────────────────────────────────────────────────

interface CheckPlan {
  readonly name: string
  readonly installed: boolean
  readonly installCmd: readonly string[] | null
}

async function checkPrereqs(
  runner: ProcessRunner,
  os: OsFamily,
): Promise<CheckPlan[]> {
  const plans: CheckPlan[] = []
  for (const name of PREREQS) {
    const installed = await isInstalled(runner, name)
    plans.push({
      name,
      installed,
      installCmd: installed ? null : getInstallCmd(os, name),
    })
  }
  return plans
}

// ── planPreflight (dry-run: check + plan, no prompting, no installs) ──

export async function planPreflight(deps: PreflightDeps): Promise<PreflightResult> {
  const info = deps.platformInspector.inspect()
  const os = detectOs(info.platform)

  if (os === null) {
    return {
      ok: false,
      platform: info.platform,
      checks: [],
      missing: 0,
      tailscale: emptyFacts(`Unsupported platform: ${info.platform}`),
    }
  }

  const plans = await checkPrereqs(deps.processRunner, os)

  const checks: PreflightCheck[] = plans.map((p) => ({
    name: p.name,
    status: p.installed ? "installed" as const : "missing" as const,
    installCmd: p.installCmd,
    error: null,
  }))

  const hasMissing = checks.some((c) => c.status === "missing")

  // Gather tailscale status
  const tailscale = await checkTailscaleStatus(deps.processRunner)

  return {
    ok: !hasMissing,
    platform: info.platform,
    checks,
    missing: checks.filter((c) => c.status === "missing").length,
    tailscale,
  }
}

// ── checkTailscaleStatus ───────────────────────────────────────────────

const IP_RE = /^\d+\.\d+\.\d+\.\d+/
const tailscaleStatusSchema = z.object({
  BackendState: z.string().optional(),
  Health: z.array(z.string()).optional(),
  Self: z
    .object({
      BackendState: z.string().optional(),
      DNSName: z.string().optional(),
      TailscaleIPs: z.array(z.string()).optional(),
    })
    .optional(),
})

export async function checkTailscaleStatus(runner: ProcessRunner): Promise<TailscaleFacts> {
  const result = await runner.exec(["tailscale", "status", "--json"])

  if (result.exitCode !== 0) {
    return {
      ip: null,
      hostname: null,
      healthStatus: null,
      backendState: null,
      tailnetLock: null,
      error: result.stderr || "tailscale status failed",
    }
  }

  if (result.stdout.trimStart().startsWith("{")) {
    const parsed = tailscaleStatusSchema.safeParse(JSON.parse(result.stdout))
    if (!parsed.success) return emptyFacts("malformed Tailscale JSON status")
    const self = parsed.data.Self
    const ip = self?.TailscaleIPs?.[0] ?? null
    return {
      ip,
      hostname: self?.DNSName?.replace(/\.$/, "") ?? null,
      healthStatus: parsed.data.Health?.join("; ") ?? null,
      backendState: self?.BackendState ?? parsed.data.BackendState ?? null,
      tailnetLock: null,
      error: ip === null ? "Tailscale is not active" : null,
    }
  }

  let ip: string | null = null
  let hostname: string | null = null
  let healthStatus: string | null = null
  let backendState: string | null = null
  let tailnetLock: boolean | null = null
  let ipMalformed = false

  const lines = result.stdout.split("\n")

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === "") continue

    // Key-value lines: "Key: value"
    const colonIdx = trimmed.indexOf(": ")
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx)
      const value = trimmed.slice(colonIdx + 2)

      switch (key) {
        case "HealthStatus":
          healthStatus = value
          break
        case "BackendState":
          backendState = value
          break
        case "tailnet-lock":
          tailnetLock = value === "enabled"
          break
      }
      continue
    }

    // Machine lines: "100.64.0.1  hostname user@  os   status"
    // Detect machine entries by the presence of a user@ field.
    const parts = trimmed.split(/\s+/)
    const hasUserField = parts.some((p) => p.includes("@"))
    if (!hasUserField || parts.length < 3) continue

    const parsedIp = parts[0] ?? null
    const parsedHostname = parts[1] ?? null

    if (parsedIp !== null && IP_RE.test(parsedIp)) {
      // First valid machine entry is the self machine
      if (ip === null) {
        ip = parsedIp
        hostname = parsedHostname
      }
    } else {
      ipMalformed = true
    }
  }

  return {
    ip,
    hostname,
    healthStatus,
    backendState,
    tailnetLock,
    error: ipMalformed ? "malformed status output" : null,
  }
}

// ── runPreflight (full flow: check → plan → prompt → install) ─────────

export async function runPreflight(deps: PreflightDeps): Promise<PreflightResult> {
  const info = deps.platformInspector.inspect()
  const os = detectOs(info.platform)

  if (os === null) {
    return {
      ok: false,
      platform: info.platform,
      checks: [],
      missing: 0,
      tailscale: emptyFacts(`Unsupported platform: ${info.platform}`),
    }
  }

  // Phase 1: Check which prereqs are installed
  const plans = await checkPrereqs(deps.processRunner, os)

  // Phase 2: Prompt and install missing prereqs
  const checks: PreflightCheck[] = []
  for (const plan of plans) {
    if (plan.installed) {
      checks.push({ name: plan.name, status: "installed", installCmd: null, error: null })
      continue
    }

    // Missing — do we have an install command?
    if (plan.installCmd === null) {
      checks.push({ name: plan.name, status: "missing", installCmd: null, error: null })
      continue
    }

    // We have an install command — prompt for confirmation
    if (deps.prompter === undefined) {
      checks.push({ name: plan.name, status: "missing", installCmd: plan.installCmd, error: null })
      continue
    }

    const cmdStr = plan.installCmd.join(" ")
    const confirmed = await deps.prompter.promptConfirm(
      `Install ${plan.name}? Run: ${cmdStr}`,
    )

    if (confirmed !== "y") {
      checks.push({ name: plan.name, status: "declined", installCmd: plan.installCmd, error: null })
      continue
    }

    // Execute the install
    const installResult = await deps.processRunner.exec(plan.installCmd)
    if (installResult.exitCode === 0) {
      checks.push({ name: plan.name, status: "installed", installCmd: plan.installCmd, error: null })
    } else {
      checks.push({
        name: plan.name,
        status: "failed",
        installCmd: plan.installCmd,
        error: installResult.stderr || "install failed",
      })
    }
  }

  // Phase 3: Gather tailscale status
  const tailscale = await checkTailscaleStatus(deps.processRunner)

  // Determine overall ok
  const hasBlocking = checks.some(
    (c) => c.status === "missing" || c.status === "declined" || c.status === "failed",
  )

  return {
    ok: !hasBlocking,
    platform: info.platform,
    checks,
    missing: checks.filter((c) => c.status === "missing").length,
    tailscale,
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function emptyFacts(error: string | null = null): TailscaleFacts {
  return {
    ip: null,
    hostname: null,
    healthStatus: null,
    backendState: null,
    tailnetLock: null,
    error,
  }
}

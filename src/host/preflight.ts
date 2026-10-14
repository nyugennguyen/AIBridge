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
export type HerdrCapabilityStatus = "yes" | "no" | "unknown"

export interface HerdrCapabilities {
  readonly inputFencing: HerdrCapabilityStatus
  readonly firstClassRole: HerdrCapabilityStatus
}

export interface HerdrFacts {
  readonly installed: boolean
  readonly path: string | null
  readonly capabilities: HerdrCapabilities
  readonly error: string | null
}

export interface PreflightResult {
  readonly ok: boolean
  readonly platform: string
  readonly checks: readonly PreflightCheck[]
  readonly missing: number
  readonly tailscale: TailscaleFacts
  readonly herdr: HerdrFacts
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
      herdr: emptyHerdrFacts(`Unsupported platform: ${info.platform}`),
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
  // Gather herdr status
  const herdr = await checkHerdrStatus(deps.processRunner)

  return {
    ok: !hasMissing,
    platform: info.platform,
    checks,
    missing: checks.filter((c) => c.status === "missing").length,
    tailscale,
    herdr,
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
      herdr: emptyHerdrFacts(`Unsupported platform: ${info.platform}`),
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
  // Phase 3b: Gather herdr status
  const herdr = await checkHerdrStatus(deps.processRunner)

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
    herdr,
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

function emptyHerdrFacts(error: string | null = null): HerdrFacts {
  return {
    installed: false,
    path: null,
    capabilities: {
      inputFencing: "unknown",
      firstClassRole: "unknown",
    },
    error,
  }
}

/** Timeout for `herdr api schema --json` probe in milliseconds. */
const HERDR_PROBE_TIMEOUT_MS = 2500

/**
 * Format capability flags into canonical string representation
 * (e.g. "input-fencing=yes, first-class-role=no").
 */
export function formatHerdrCapabilities(caps: HerdrCapabilities): string {
  return `input-fencing=${caps.inputFencing}, first-class-role=${caps.firstClassRole}`
}

/**
 * Detects presence of the Herdr binary on PATH and inspects the daemon IPC
 * JSON Schema via `herdr api schema --json` for AIBridge orchestration fork capability flags:
 * - F1: Input-ownership fencing (socket methods `pane.claim_input` / `pane.release_input`)
 * - F2: First-class `role` field on pane/agent records
 *
 * Architectural invariants:
 * - Herdr is a detected user-installed binary (`brew install herdr`), never an npm dependency.
 * - Absence of Herdr or absence of fork capabilities is INFORMATIONAL, never a hard failure;
 *   tmux remains the default headless/supervisor terminal backend.
 * - Nonzero exit codes or malformed schema JSON output report flags as "unknown" without throwing.
 */
export async function checkHerdrStatus(runner: ProcessRunner): Promise<HerdrFacts> {
  const whichResult = await runner.exec(["which", "herdr"])
  if (whichResult.exitCode !== 0) {
    return {
      installed: false,
      path: null,
      capabilities: {
        inputFencing: "no",
        firstClassRole: "no",
      },
      error: null,
    }
  }

  const binaryPath = whichResult.stdout.trim() || "herdr"

  let schemaResult: { exitCode: number | null; stdout: string; stderr: string }
  try {
    schemaResult = await runner.exec(["herdr", "api", "schema", "--json"], {
      timeoutMs: HERDR_PROBE_TIMEOUT_MS,
    })
  } catch (err) {
    return {
      installed: true,
      path: binaryPath,
      capabilities: {
        inputFencing: "unknown",
        firstClassRole: "unknown",
      },
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (schemaResult.exitCode !== 0) {
    return {
      installed: true,
      path: binaryPath,
      capabilities: {
        inputFencing: "unknown",
        firstClassRole: "unknown",
      },
      error: schemaResult.stderr || "herdr api schema --json failed",
    }
  }

  const rawStdout = schemaResult.stdout.trim()
  if (rawStdout === "") {
    return {
      installed: true,
      path: binaryPath,
      capabilities: {
        inputFencing: "unknown",
        firstClassRole: "unknown",
      },
      error: "empty schema output",
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawStdout)
  } catch {
    return {
      installed: true,
      path: binaryPath,
      capabilities: {
        inputFencing: "unknown",
        firstClassRole: "unknown",
      },
      error: "malformed schema JSON",
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      installed: true,
      path: binaryPath,
      capabilities: {
        inputFencing: "unknown",
        firstClassRole: "unknown",
      },
      error: "schema output is not a JSON object",
    }
  }

  const obj = parsed as Record<string, unknown>
  if (typeof obj.error === "string" || obj.status === "error") {
    return {
      installed: true,
      path: binaryPath,
      capabilities: {
        inputFencing: "unknown",
        firstClassRole: "unknown",
      },
      error: typeof obj.error === "string" ? obj.error : "daemon error reported in schema output",
    }
  }

  if (!isSchemaStructure(obj)) {
    return {
      installed: true,
      path: binaryPath,
      capabilities: {
        inputFencing: "unknown",
        firstClassRole: "unknown",
      },
      error: "unrecognized or malformed schema structure",
    }
  }

  const hasFencing = containsToken(obj, "pane.claim_input") && containsToken(obj, "pane.release_input")
  const hasRole = hasFirstClassRoleField(obj)

  return {
    installed: true,
    path: binaryPath,
    capabilities: {
      inputFencing: hasFencing ? "yes" : "no",
      firstClassRole: hasRole ? "yes" : "no",
    },
    error: null,
  }
}

/**
 * Validates that an object resembles a JSON Schema or IPC API definition.
 */
function isSchemaStructure(obj: Record<string, unknown>): boolean {
  const schemaMarkers = [
    "$schema",
    "type",
    "properties",
    "definitions",
    "$defs",
    "methods",
    "paths",
    "title",
    "components",
    "schemas",
    "records",
    "types",
    "rpc",
  ]
  if (schemaMarkers.some((marker) => marker in obj)) {
    return true
  }
  // Check if any key resembles a Herdr socket method / IPC endpoint
  return Object.keys(obj).some(
    (k) =>
      k.startsWith("pane.") ||
      k.startsWith("agent.") ||
      k.startsWith("workspace.") ||
      k === "pane.claim_input" ||
      k === "pane.release_input",
  )
}

function containsToken(data: unknown, token: string): boolean {
  if (typeof data === "string") {
    return data === token || data === `/${token}`
  }
  if (Array.isArray(data)) {
    return data.some((item) => containsToken(item, token))
  }
  if (typeof data === "object" && data !== null) {
    for (const [key, value] of Object.entries(data)) {
      if (key === token || key === `/${token}`) {
        return true
      }
      if (containsToken(value, token)) {
        return true
      }
    }
  }
  return false
}

/**
 * Probes whether the schema exposes a first-class `role` field on pane or agent records (F2).
 */
function hasFirstClassRoleField(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false

  function search(node: unknown, inPaneOrAgentScope: boolean): boolean {
    if (typeof node !== "object" || node === null) return false

    if (Array.isArray(node)) {
      if (inPaneOrAgentScope && node.includes("role")) return true
      return node.some((item) => search(item, inPaneOrAgentScope))
    }

    const obj = node as Record<string, unknown>

    for (const [key, value] of Object.entries(obj)) {
      const isPaneOrAgent = /pane|agent/i.test(key)
      const currentScope = inPaneOrAgentScope || isPaneOrAgent

      if (currentScope) {
        if (key === "role") return true
        if (typeof value === "object" && value !== null) {
          const vObj = value as Record<string, unknown>
          if ("role" in vObj) return true
          if (vObj.properties && typeof vObj.properties === "object" && vObj.properties !== null) {
            if ("role" in (vObj.properties as Record<string, unknown>)) return true
          }
          if (vObj.fields && typeof vObj.fields === "object" && vObj.fields !== null) {
            if ("role" in (vObj.fields as Record<string, unknown>)) return true
          }
        }
      }

      // Root / definition level checks:
      if (
        (key === "properties" || key === "definitions" || key === "$defs" || key === "records" || key === "types") &&
        typeof value === "object" &&
        value !== null &&
        "role" in (value as Record<string, unknown>)
      ) {
        return true
      }

      if (key === "role" && typeof value === "object") {
        return true
      }

      if (search(value, currentScope)) {
        return true
      }
    }

    return false
  }

  return search(data, false)
}

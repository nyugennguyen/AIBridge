import type { PlatformInspector, ProcessRunner } from "../host/types.js"
import { resolveProfilePaths, type ProfilePaths } from "../host/paths.js"
import { readConfig } from "../host/profile-store.js"
import { planPreflight } from "../host/preflight.js"
import { bridgeConfigSchema } from "../config/schemas.js"
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
}

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

  // ── 4. Check Config File & Schema ───────────────────────────────────
  const fileOps: VerifyFileOps = deps?.fileOps ?? {
    readConfig: (p) => readConfig(p),
    stat: defaultStat,
    readFile: (p, enc) => readFile(p, enc),
    pathExists: defaultPathExists,
  }

  let configData: Record<string, unknown> | null = null
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

  // ── Build summary ──────────────────────────────────────────────────
  const ok = checks.every((c) => c.status === "pass")
  const failCount = checks.filter((c) => c.status === "fail").length
  const passCount = checks.filter((c) => c.status === "pass").length

  const lines = [
    `AIBridge Verification Report for profile "${profileName}":`,
    ...checks.map((c) => {
      const icon = c.status === "pass" ? "[✓]" : c.status === "warn" ? "[!]" : "[✗]"
      const detail = c.detail ? `\n      ${c.detail}` : ""
      return `  ${icon} ${c.message}${detail}`
    }),
    "",
    ok
      ? `Status: PASSED (${passCount}/${checks.length} checks passed)`
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

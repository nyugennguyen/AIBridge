/**
 * Interactive setup orchestration.
 *
 * Runs preflight checks, gates on Tailscale connectivity, prompts for
 * profile name, secrets, and config values, builds a bridgeConfigSchema-
 * valid configuration, and persists config + secrets via profile-store.
 *
 * Safety invariants:
 * - Never starts services.
 * - Never outputs secrets in return values or summary text.
 * - Blocks immediately when preflight fails or Tailscale is unhealthy.
 * - Redacts bearer token and passwords in the confirmation summary.
 * - Checks for existing profiles before overwriting.
 */

import type {
  PlatformInspector,
  ProcessRunner,
  Prompter,
} from "./types.js"
import {
  runPreflight,
  type PreflightResult,
} from "./preflight.js"
import {
  resolveProfilePaths,
  type ProfilePaths,
} from "./paths.js"

// ── Outcome types ──────────────────────────────────────────────────────

export interface SetupPersisted {
  readonly kind: "persisted"
  readonly profileName: string
  readonly configPath: string
  readonly preflight: PreflightResult
  readonly launchTui?: boolean
  /**
   * What happened to the platform supervisor unit, if one was written.
   *
   * Reported rather than logged and dropped: a `KeepAlive` unit that was never
   * activated looks identical to one that is running until an operator goes
   * looking for a process.
   */
  readonly daemon?: DaemonOutcome
}

/** Why the wizard wrote a supervisor unit and why it did or did not start it. */
export interface DaemonOutcome {
  readonly installed: boolean
  readonly unitPath: string | null
  /** The exact command that activates it, for an operator running it by hand. */
  readonly command: string | null
  readonly started: boolean
  /** Populated when writing or starting failed; the setup itself still succeeded. */
  readonly error: string | null
}

export interface SetupBlocked {
  readonly kind: "blocked"
  readonly reason: string
  readonly preflight: PreflightResult
}

export interface SetupDeclined {
  readonly kind: "declined"
  readonly preflight: PreflightResult
}

export type SetupOutcome = SetupPersisted | SetupBlocked | SetupDeclined

export * from "./daemonizer.js"

// ── File operations interface ──────────────────────────────────────────

export interface SetupFileOps {
  readonly writeConfig: (configPath: string, data: Record<string, unknown>) => Promise<void>
  readonly writeSecret: (secretPath: string, value: string) => Promise<void>
  readonly ensureProfileDirs: (paths: ProfilePaths) => Promise<void>
  readonly readConfig: (configPath: string) => Promise<Record<string, unknown> | null>
}

// ── Dependencies ───────────────────────────────────────────────────────

export interface SetupDeps {
  readonly platformInspector: PlatformInspector
  readonly processRunner: ProcessRunner
  readonly prompter: Prompter
  readonly env: Record<string, string | undefined>
  readonly fileOps: SetupFileOps
}

// ── Helpers ────────────────────────────────────────────────────────────

function parsePort(value: string, defaultValue: number): number {
  const trimmed = value.trim()
  if (trimmed === "") return defaultValue
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isNaN(parsed) ? defaultValue : parsed
}

/**
 * Build a human-readable config summary with all secrets redacted.
 */
function buildRedactedSummary(config: Record<string, unknown>): string {
  const agentId = config.agent_id as string
  const bridge = config.bridge as Record<string, unknown>
  const opencode = config.opencode as Record<string, unknown>
  const security = config.security as Record<string, unknown>
  const permissions = config.permissions as Record<string, unknown>
  const projects = config.projects as Array<Record<string, unknown>>
  const agents = config.agents as Array<Record<string, unknown>>
  const timeouts = config.timeouts as Record<string, unknown>
  const planning = config.planning as Record<string, unknown>

  const sources = (security.allowed_sources as Array<Record<string, unknown>>)
    .map((s) => s.source_agent_id as string)
    .join(", ")
  const projectLines = projects
    .map((p) => `${p.id as string} -> ${p.path as string}`)
    .join(", ")
  const agentLines = agents
    .map((a) => `${a.id as string} @ ${a.url as string}`)
    .join(", ")

  const lines = [
    `  Agent ID:       ${agentId}`,
    `  Bridge:         ${bridge.host as string}:${bridge.port as number}`,
    `  Public URL:     ${bridge.public_url as string}`,
    `  OpenCode URL:   ${opencode.base_url as string}`,
    `  OC Port:        ${opencode.server_port as number}`,
    `  Auth Mode:      ${security.auth_mode as string}`,
    `  Bearer Token:   [REDACTED]`,
    `  Sources:        ${sources}`,
    `  Projects:       ${projectLines}`,
    `  Peers:          ${agentLines}`,
    `  Default:        ${permissions.default_response as string}`,
    `  Allow:          ${(permissions.allow_tools as string[]).join(", ")}`,
    `  Plan-gated:     ${(permissions.require_plan_approval_for_tools as string[]).join(", ")}`,
    `  Job timeout:    ${timeouts.default_job_seconds as number}s`,
    `  Planning:       ${(planning.plan_annotator_enabled as boolean) ? "enabled" : "disabled"}`,
  ]
  return lines.join("\n")
}

// ── runSetup ───────────────────────────────────────────────────────────

/**
 * Orchestrate interactive host setup.
 *
 * Flow:
 * 1. Run preflight — block if prereqs missing or platform unsupported.
 * 2. Gate on Tailscale — block if no IP or backend state is not Running.
 * 3. Prompt for profile name + initial confirmation.
 * 4. Prompt for bearer token (secret) and OpenCode password (secret).
 * 5. Prompt for agent ID, project path, peer ID, peer URL, bridge port, OC port.
 * 6. Build a bridgeConfigSchema-valid config object.
 * 7. Check for existing profile — prompt overwrite confirmation if found.
 * 8. Show redacted summary — prompt final confirmation.
 * 9. Persist config and secrets via fileOps.
 * 10. Return persisted outcome.
 */
export async function runSetup(deps: SetupDeps): Promise<SetupOutcome> {
  // ── Phase 1: Preflight checks ─────────────────────────────────────
  const preflight = await runPreflight({
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

  // ── Phase 2: Tailscale gating ─────────────────────────────────────
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

  // ── Phase 3: Profile name + initial confirmation ──────────────────
  const profileName = await deps.prompter.promptInput("Enter profile name:")

  const initialConfirm = await deps.prompter.promptConfirm(
    `Create profile "${profileName}"?`,
  )
  if (initialConfirm !== "y") {
    return { kind: "declined", preflight }
  }

  // ── Phase 4: Collect secrets ───────────────────────────────────────
  const bearerToken = await deps.prompter.promptSecret("Enter bearer token:")
  const ocPassword = await deps.prompter.promptSecret("Enter OpenCode server password:")

  // ── Phase 5: Collect config values ────────────────────────────────
  const agentId = await deps.prompter.promptInput("Enter agent ID:")
  const projectPath = await deps.prompter.promptInput("Enter project path:")
  const peerId = await deps.prompter.promptInput("Enter peer agent ID:")
  const peerUrl = await deps.prompter.promptInput("Enter peer agent URL:")
  const bridgePortStr = await deps.prompter.promptInput("Enter bridge port [8787]:")
  const ocPortStr = await deps.prompter.promptInput("Enter OpenCode server port [4096]:")

  const bridgePort = parsePort(bridgePortStr, 8787)
  const ocPort = parsePort(ocPortStr, 4096)

  // ── Phase 6: Build config ─────────────────────────────────────────
  const tailscaleIp = preflight.tailscale.ip
  const tailscaleHostname = preflight.tailscale.hostname

  const publicUrl = tailscaleHostname !== null
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
      auth_mode: "bearer-token",
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

  // ── Phase 7: No-overwrite check ───────────────────────────────────
  const paths = resolveProfilePaths(profileName, deps.env)
  const configPath = `${paths.configDir}/config.json`

  const existing = await deps.fileOps.readConfig(configPath)
  if (existing !== null) {
    const overwriteConfirm = await deps.prompter.promptConfirm(
      `Profile "${profileName}" already exists. Overwrite?`,
    )
    if (overwriteConfirm !== "y") {
      return { kind: "declined", preflight }
    }
  }

  // ── Phase 8: Redacted summary + final confirmation ────────────────
  const summary = buildRedactedSummary(config)
  const finalConfirm = await deps.prompter.promptConfirm(
    `Review configuration:\n${summary}\n\nProceed with setup?`,
  )
  if (finalConfirm !== "y") {
    return { kind: "declined", preflight }
  }

  // ── Phase 9: Persist ──────────────────────────────────────────────
  await deps.fileOps.ensureProfileDirs(paths)
  await deps.fileOps.writeConfig(configPath, config)
  await deps.fileOps.writeSecret(`${paths.secretsDir}/bearer_token`, bearerToken)
  await deps.fileOps.writeSecret(`${paths.secretsDir}/opencode_password`, ocPassword)

  // ── Phase 10: Return persisted ────────────────────────────────────
  return {
    kind: "persisted",
    profileName,
    configPath,
    preflight,
  }
}

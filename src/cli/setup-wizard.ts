import { randomBytes } from "node:crypto"
import type { PlatformInspector, ProcessRunner, Prompter } from "../host/types.js"
import { resolveProfilePaths, type ProfilePaths } from "../host/paths.js"
import { runPreflight, type PreflightResult } from "../host/preflight.js"
import type { SetupFileOps, SetupOutcome } from "../host/setup.js"

export interface SetupWizardDeps {
  readonly platformInspector: PlatformInspector
  readonly processRunner: ProcessRunner
  readonly prompter: Prompter
  readonly fileOps: SetupFileOps
  readonly env?: Record<string, string | undefined>
  readonly initialProfile?: string
}

export function generateBearerToken(): string {
  return randomBytes(32).toString("hex")
}

function parsePort(value: string, defaultValue: number): number {
  const trimmed = value.trim()
  if (trimmed === "") return defaultValue
  const n = parseInt(trimmed, 10)
  return Number.isNaN(n) ? defaultValue : n
}

export async function runSetupWizard(deps: SetupWizardDeps): Promise<SetupOutcome> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>)

  // ── 1. Dependency checks ───────────────────────────────────────────
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

  // ── 2. Tailscale active check ──────────────────────────────────────
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

  // ── 3. Profile Name selection ──────────────────────────────────────
  let profileName: string
  if (deps.initialProfile && deps.initialProfile.trim() !== "") {
    profileName = deps.initialProfile.trim()
  } else {
    const rawProfile = await deps.prompter.promptInput("Enter profile name [default]:")
    profileName = rawProfile.trim() === "" ? "default" : rawProfile.trim()
  }

  const paths: ProfilePaths = resolveProfilePaths(profileName, env)

  // ── 4. Config file path selection (prompt or default) ──────────────
  const defaultConfigFile = `${paths.configDir}/config.json`
  const rawConfigPath = await deps.prompter.promptInput(
    `Enter config file path [${defaultConfigFile}]:`,
  )
  const configPath = rawConfigPath.trim() === "" ? defaultConfigFile : rawConfigPath.trim()

  // ── 5. Check if profile already exists ─────────────────────────────
  const existing = await deps.fileOps.readConfig(configPath)
  if (existing !== null) {
    const overwriteConfirm = await deps.prompter.promptConfirm(
      `Profile "${profileName}" already exists at ${configPath}. Overwrite?`,
    )
    if (overwriteConfirm !== "y") {
      return { kind: "declined", preflight }
    }
  }

  // ── 6. SSL / Bearer Token generation or prompt ─────────────────────
  let bearerToken: string
  const tokenChoice = await deps.prompter.promptInput(
    "Generate a new shared bearer token? (recommended for 1st-time setup) [Y/n]:",
  )

  if (tokenChoice.trim().toLowerCase() === "n" || tokenChoice.trim().toLowerCase() === "no") {
    bearerToken = await deps.prompter.promptSecret("Enter shared bearer token:")
  } else {
    bearerToken = generateBearerToken()
    await deps.prompter.promptInput(
      `Generated shared token: ${bearerToken}\n(IMPORTANT: Copy this token to use on your peer machine. Press Enter to continue)`,
    )
  }

  // ── 7. OpenCode password prompt ────────────────────────────────────
  const ocPassword = await deps.prompter.promptSecret("Enter OpenCode server password:")

  // ── 8. Collect agent configuration ─────────────────────────────────
  const rawAgentId = await deps.prompter.promptInput(`Enter agent ID [${profileName}]:`)
  const agentId = rawAgentId.trim() === "" ? profileName : rawAgentId.trim()

  const defaultProjectPath = process.cwd()
  const rawProjectPath = await deps.prompter.promptInput(`Enter project path [${defaultProjectPath}]:`)
  const projectPath = rawProjectPath.trim() === "" ? defaultProjectPath : rawProjectPath.trim()

  const rawPeerId = await deps.prompter.promptInput("Enter peer agent ID [peer]:")
  const peerId = rawPeerId.trim() === "" ? "peer" : rawPeerId.trim()

  const rawPeerUrl = await deps.prompter.promptInput("Enter peer agent URL [http://100.64.0.2:8787]:")
  const peerUrl = rawPeerUrl.trim() === "" ? "http://100.64.0.2:8787" : rawPeerUrl.trim()

  const bridgePortStr = await deps.prompter.promptInput("Enter bridge port [8787]:")
  const ocPortStr = await deps.prompter.promptInput("Enter OpenCode server port [4096]:")

  const bridgePort = parsePort(bridgePortStr, 8787)
  const ocPort = parsePort(ocPortStr, 4096)

  // ── 9. Build configuration object ──────────────────────────────────
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

  // ── 10. Confirmation & Persistence ─────────────────────────────────
  const finalConfirm = await deps.prompter.promptConfirm(
    `Save configuration to "${configPath}"?`,
  )
  if (finalConfirm !== "y") {
    return { kind: "declined", preflight }
  }

  await deps.fileOps.ensureProfileDirs(paths)
  await deps.fileOps.writeConfig(configPath, config)
  await deps.fileOps.writeSecret(`${paths.secretsDir}/bearer_token`, bearerToken)
  await deps.fileOps.writeSecret(`${paths.secretsDir}/opencode_password`, ocPassword)

  return {
    kind: "persisted",
    profileName,
    configPath,
    preflight,
  }
}

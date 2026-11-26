import type { ProcessRunner, HttpProbe } from "./types.js"

// ── Types ──────────────────────────────────────────────────────────────

export interface TmuxProfile {
  readonly name: string
  readonly bridgePort: number
  /**
   * The address the bridge binds (`bridge.host`, normally the Tailscale IP).
   * `aibr status` must probe THIS address: the bridge deliberately does not
   * listen on loopback, so probing 127.0.0.1 reported every correctly configured
   * node as `bridge_unavailable`. Absent → 127.0.0.1 (legacy behaviour).
   */
  readonly bridgeHost?: string
  /** Required for the OpenCode runtime; ignored (and usually absent) for Claude. */
  readonly opencodePort?: number
  readonly sessionName: string
  /**
   * The profile's `runtime.kind`. Absent means `opencode`, the released
   * behaviour. A Claude profile starts only the bridge window: there is no
   * `opencode serve` to supervise.
   */
  readonly runtimeKind?: "opencode" | "claude"
}

/** Provider credentials the Claude Code child needs; forwarded to the bridge window via env, never argv. */
const CLAUDE_PROVIDER_ENV_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const

export interface TmuxDeps {
  readonly processRunner: ProcessRunner
  readonly httpProbe: HttpProbe
  readonly env: Record<string, string | undefined>
}

export type StartProfileResult =
  | { readonly kind: "started"; readonly sessionName: string }
  | { readonly kind: "already_running"; readonly sessionName: string }
  | { readonly kind: "tmux_error"; readonly sessionName: string; readonly stderr: string }
  | { readonly kind: "tmux_missing"; readonly sessionName: string; readonly installHint: string }

export type StatusProfileResult =
  | { readonly kind: "healthy"; readonly sessionName: string; readonly body: string }
  | { readonly kind: "session_missing"; readonly sessionName: string }
  | { readonly kind: "bridge_unavailable"; readonly sessionName: string; readonly probeStatus: number }

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Appended to the tmux command that creates a window, in the same command list
 * so it applies before the window's process can exit: a crashed bridge leaves
 * its window (and its error) on screen instead of vanishing with it.
 */
function remainOnExit(target: string): readonly string[] {
  return [";", "set-option", "-w", "-t", target, "remain-on-exit", "on"]
}

async function sessionExists(
  runner: ProcessRunner,
  sessionName: string,
): Promise<boolean> {
  const result = await runner.exec(["tmux", "has-session", "-t", sessionName])
  return result.exitCode === 0
}

/** Secrets and bind address via env — never in argv. */
function buildOpencodeEnv(
  env: Record<string, string | undefined>,
  opencodePort: number,
): Record<string, string> {
  const result: Record<string, string> = {
    OPENCODE_HOSTNAME: "127.0.0.1",
    OPENCODE_PORT: String(opencodePort),
  }

  const password = env.OPENCODE_SERVER_PASSWORD
  if (password !== undefined) {
    result.OPENCODE_SERVER_PASSWORD = password
  }

  const opencodeBin = env.OPENCODE_BIN
  if (opencodeBin !== undefined) {
    result.OPENCODE_BIN = opencodeBin
  }

  return result
}

function buildBridgeEnv(
  env: Record<string, string | undefined>,
  runtimeKind: "opencode" | "claude" = "opencode",
): Record<string, string> {
  const result: Record<string, string> = {}

  if (runtimeKind === "claude") {
    for (const key of CLAUDE_PROVIDER_ENV_KEYS) {
      const value = env[key]
      if (value !== undefined) result[key] = value
    }
  }

  const config = env.AIBRIDGE_CONFIG
  if (config !== undefined) {
    result.AIBRIDGE_CONFIG = config
  }

  const agentId = env.AIBRIDGE_AGENT_ID
  if (agentId !== undefined) {
    result.AIBRIDGE_AGENT_ID = agentId
  }

  const password = env.OPENCODE_SERVER_PASSWORD
  if (password !== undefined) {
    result.OPENCODE_SERVER_PASSWORD = password
  }

  return result
}

/** The install command for tmux on this platform. */
export function tmuxInstallHint(platform: string): string {
  return platform === "darwin" ? "brew install tmux" : "sudo apt-get install -y tmux"
}

// ── startProfile ────────────────────────────────────────────────────────

/** Secrets via env only — never in argv. OpenCode binds 127.0.0.1. */
export async function startProfile(
  deps: TmuxDeps,
  profile: TmuxProfile,
): Promise<StartProfileResult> {
  if (await sessionExists(deps.processRunner, profile.sessionName)) {
    return { kind: "already_running", sessionName: profile.sessionName }
  }

  // tmux is optional for the product (the bridge normally runs as a user
  // service); only this path needs it. Spawn nothing when it is absent.
  if ((await deps.processRunner.exec(["which", "tmux"])).exitCode !== 0) {
    return {
      kind: "tmux_missing",
      sessionName: profile.sessionName,
      installHint: tmuxInstallHint(process.platform),
    }
  }

  if (profile.runtimeKind === "claude") {
    // No `opencode` window: the bridge is the session's only window, and it
    // spawns Claude Code per job.
    const bridgeResult = await deps.processRunner.exec(
      ["tmux", "new-session", "-d", "-s", profile.sessionName, "-n", "bridge",
        "aibr", "serve", "--profile", profile.name, ...remainOnExit(`${profile.sessionName}:bridge`)],
      { env: buildBridgeEnv(deps.env, "claude") },
    )
    if (bridgeResult.exitCode !== 0) {
      return { kind: "tmux_error", sessionName: profile.sessionName, stderr: bridgeResult.stderr }
    }
    return { kind: "started", sessionName: profile.sessionName }
  }

  if (profile.opencodePort === undefined) {
    return {
      kind: "tmux_error",
      sessionName: profile.sessionName,
      stderr: "OpenCode runtime profile has no opencode.server_port",
    }
  }

  const ocEnv = buildOpencodeEnv(deps.env, profile.opencodePort)
  const ocResult = await deps.processRunner.exec(
    ["tmux", "new-session", "-d", "-s", profile.sessionName, "-n", "opencode",
      "aibr", "_opencode", "--profile", profile.name, ...remainOnExit(`${profile.sessionName}:opencode`)],
    { env: ocEnv },
  )

  if (ocResult.exitCode !== 0) {
    return {
      kind: "tmux_error",
      sessionName: profile.sessionName,
      stderr: ocResult.stderr,
    }
  }

  const bridgeEnv = buildBridgeEnv(deps.env)
  const bridgeResult = await deps.processRunner.exec(
    ["tmux", "new-window", "-t", profile.sessionName, "-n", "bridge",
      "aibr", "serve", "--profile", profile.name, ...remainOnExit(`${profile.sessionName}:bridge`)],
    { env: bridgeEnv },
  )

  if (bridgeResult.exitCode !== 0) {
    return {
      kind: "tmux_error",
      sessionName: profile.sessionName,
      stderr: bridgeResult.stderr,
    }
  }

  return { kind: "started", sessionName: profile.sessionName }
}

// ── statusProfile ───────────────────────────────────────────────────────

export async function statusProfile(
  deps: TmuxDeps,
  profile: TmuxProfile,
): Promise<StatusProfileResult> {
  if (!(await sessionExists(deps.processRunner, profile.sessionName))) {
    return { kind: "session_missing", sessionName: profile.sessionName }
  }

  const host = profile.bridgeHost ?? "127.0.0.1"
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${profile.bridgePort}/health`
  const probe = await deps.httpProbe.probe(url)

  if (probe.ok) {
    return {
      kind: "healthy",
      sessionName: profile.sessionName,
      body: probe.body,
    }
  }

  return {
    kind: "bridge_unavailable",
    sessionName: profile.sessionName,
    probeStatus: probe.status,
  }
}

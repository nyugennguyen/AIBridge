import type { ProcessRunner, HttpProbe } from "./types.js"

// ── Types ──────────────────────────────────────────────────────────────

export interface TmuxProfile {
  readonly name: string
  readonly bridgePort: number
  readonly opencodePort: number
  readonly sessionName: string
}

export interface TmuxDeps {
  readonly processRunner: ProcessRunner
  readonly httpProbe: HttpProbe
  readonly env: Record<string, string | undefined>
}

export type StartProfileResult =
  | { readonly kind: "started"; readonly sessionName: string }
  | { readonly kind: "already_running"; readonly sessionName: string }
  | { readonly kind: "tmux_error"; readonly sessionName: string; readonly stderr: string }

export type StatusProfileResult =
  | { readonly kind: "healthy"; readonly sessionName: string; readonly body: string }
  | { readonly kind: "session_missing"; readonly sessionName: string }
  | { readonly kind: "bridge_unavailable"; readonly sessionName: string; readonly probeStatus: number }

// ── Helpers ─────────────────────────────────────────────────────────────

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

  return result
}

function buildBridgeEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {}

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

// ── startProfile ────────────────────────────────────────────────────────

/** Secrets via env only — never in argv. OpenCode binds 127.0.0.1. */
export async function startProfile(
  deps: TmuxDeps,
  profile: TmuxProfile,
): Promise<StartProfileResult> {
  if (await sessionExists(deps.processRunner, profile.sessionName)) {
    return { kind: "already_running", sessionName: profile.sessionName }
  }

  const ocEnv = buildOpencodeEnv(deps.env, profile.opencodePort)
  const ocResult = await deps.processRunner.exec(
    ["tmux", "new-session", "-d", "-s", profile.sessionName, "-n", "opencode",
      "aibr", "_opencode", "--profile", profile.name],
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
      "aibr", "serve", "--profile", profile.name],
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

  const url = `http://127.0.0.1:${profile.bridgePort}/health`
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

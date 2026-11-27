/**
 * `aibr start` / `aibr status` on top of the per-profile user service
 * (src/host/daemonizer.ts) and the tmux session (`--foreground`).
 *
 * One run model per platform: `aibr start` installs and loads a launchd agent
 * (macOS) or a systemd user unit (Linux) that runs `aibr serve`; `aibr start
 * --foreground` runs the same bridge in the tmux session `aibridge-<profile>`
 * for development. `aibr status` reports whichever of the two is running, then
 * probes `/health` on the address the bridge binds.
 */
import { resolveProfilePaths } from "../host/paths.js"
import { readConfig } from "../host/profile-store.js"
import { bridgeLogPath, fsLogFileReader, tailLines, type LogFileReader } from "../host/logs.js"
import {
  startUserService,
  userServiceState,
  type DaemonIngressMode,
  type UserServiceDeps,
  type UserServiceState,
} from "../host/daemonizer.js"
import type { HttpProbe, ProcessRunner } from "../host/types.js"

/** What a profile's config says about how it runs. */
export interface ProfileRunInfo {
  readonly profile: string
  readonly role: "worker" | "orchestrator" | "both"
  readonly runtimeKind: "opencode" | "claude"
  readonly ingressMode: DaemonIngressMode
  readonly bridgeHost: string
  readonly bridgePort: number
  readonly opencodePort?: number
  readonly agentId: string
  readonly publicUrl: string
  readonly stateDir: string
  readonly logPath: string
}

export class ProfileNotFoundError extends Error {}

export async function loadProfileRunInfo(
  profile: string,
  env: Readonly<Record<string, string | undefined>>,
  read: (path: string) => Promise<Record<string, unknown> | null> = async (path) =>
    (await readConfig(path)) as Record<string, unknown> | null,
): Promise<ProfileRunInfo> {
  const paths = resolveProfilePaths(profile, { ...env })
  let config: Record<string, unknown> | null = null
  try {
    config = await read(`${paths.configDir}/config.json`)
  } catch {
    config = null
  }
  if (config === null) {
    throw new ProfileNotFoundError(`Profile "${profile}" not found. Run "aibr init --profile ${profile}" first.`)
  }
  const bridge = (config.bridge ?? {}) as Record<string, unknown>
  const opencode = config.opencode as Record<string, unknown> | undefined
  const role = config.role === "orchestrator" || config.role === "both" ? config.role : "worker"
  const runtimeKind = (config.runtime as { kind?: unknown } | undefined)?.kind === "claude" ? "claude" : "opencode"
  const host = typeof bridge.host === "string" && bridge.host !== "" ? bridge.host : "127.0.0.1"
  const port = typeof bridge.port === "number" ? bridge.port : 8787
  return {
    profile,
    role,
    runtimeKind,
    ingressMode: bridge.ingress_mode === "router" ? "router" : "engine",
    bridgeHost: host,
    bridgePort: port,
    ...(runtimeKind === "opencode" && typeof opencode?.server_port === "number" ? { opencodePort: opencode.server_port } : {}),
    agentId: typeof config.agent_id === "string" ? config.agent_id : profile,
    publicUrl: typeof bridge.public_url === "string" ? bridge.public_url : `http://${host}:${port}`,
    stateDir: paths.stateDir,
    logPath: bridgeLogPath(paths.stateDir),
  }
}

export function healthUrl(info: Pick<ProfileRunInfo, "bridgeHost" | "bridgePort">): string {
  const host = info.bridgeHost.includes(":") ? `[${info.bridgeHost}]` : info.bridgeHost
  return `http://${host}:${info.bridgePort}/health`
}

export function tmuxSessionName(profile: string): string {
  return `aibridge-${profile}`
}

export async function tmuxSessionExists(runner: ProcessRunner, session: string): Promise<boolean> {
  try {
    return (await runner.exec(["tmux", "has-session", "-t", session])).exitCode === 0
  } catch {
    return false
  }
}

export interface ServiceCommandDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly runner: ProcessRunner
  readonly probe: HttpProbe
  readonly service: UserServiceDeps
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  readonly logReader?: LogFileReader
  readonly loadInfo?: (profile: string) => Promise<ProfileRunInfo>
}

/** How long `aibr start` waits for `/health` after loading the unit. */
export const START_HEALTH_TIMEOUT_MS = 20_000

/** The `agent_id` a `/health` body names, or `null` when it names none. */
export function healthAgentId(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { agent_id?: unknown }
    return typeof parsed.agent_id === "string" ? parsed.agent_id : null
  } catch {
    return null
  }
}

/**
 * The agent answering on this profile's address when it is not this profile's
 * own bridge: another profile, or another user's bridge, bound to the same
 * host and port. `null` when it is this profile's bridge or cannot be told.
 */
export function foreignAgent(body: string, agentId: string): string | null {
  const answered = healthAgentId(body)
  return answered !== null && answered !== agentId ? answered : null
}

function foreignBridgeHint(info: ProfileRunInfo, foreign: string): string {
  return (
    `${healthUrl(info)} answers as agent "${foreign}", not "${info.agentId}": another AIBridge bridge ` +
    `(another profile, or another user on this machine) holds that address, so this profile's bridge cannot listen. ` +
    `Stop that bridge, or give this profile another bridge.port (aibr setup --profile ${info.profile})`
  )
}

export async function waitForHealth(
  deps: Pick<ServiceCommandDeps, "probe" | "sleep" | "now">,
  url: string,
  timeoutMs: number,
  agentId?: string,
): Promise<{ readonly ok: boolean; readonly body: string; readonly status: number; readonly foreign?: string }> {
  const deadline = deps.now() + timeoutMs
  let last = { ok: false, body: "", status: 0 }
  for (;;) {
    last = await deps.probe.probe(url, { timeoutMs: 2000 })
    if (last.ok) {
      const foreign = agentId === undefined ? null : foreignAgent(last.body, agentId)
      // Waiting longer cannot help: the other bridge keeps the port.
      return foreign === null ? last : { ...last, ok: false, foreign }
    }
    if (deps.now() >= deadline) return last
    await deps.sleep(500)
  }
}

function logTail(deps: ServiceCommandDeps, path: string, lines = 15): string {
  const tail = tailLines(deps.logReader ?? fsLogFileReader, path, lines)
  if (tail === null || tail.text === "") return `  (no log at ${path} yet)\n`
  return tail.text.replace(/^/gm, "  ")
}

/** `aibr start --profile <p>` (service). Returns the exit code. */
export async function runStartService(profile: string, deps: ServiceCommandDeps, write: (text: string) => void): Promise<number> {
  let info: ProfileRunInfo
  try {
    info = await (deps.loadInfo ?? ((p) => loadProfileRunInfo(p, deps.env)))(profile)
  } catch (error) {
    write(`Error: ${error instanceof Error ? error.message : "cannot read the profile"}\n`)
    return 1
  }
  if (info.role === "orchestrator") {
    write(
      `Nothing to start: profile "${profile}" is an orchestrator. It runs no bridge; Claude Code dispatches ` +
        `from here through the AIBridge plugin (aibr plugin install claude).\n`,
    )
    return 0
  }
  const session = tmuxSessionName(profile)
  if (await tmuxSessionExists(deps.runner, session)) {
    write(
      `Profile "${profile}" is already running in the tmux session ${session} (aibr start --foreground). ` +
        `Stop it first (aibr stop --profile ${profile}); the service would listen on the same port.\n`,
    )
    return 1
  }

  const result = await startUserService(deps.service, {
    profile,
    ingressMode: info.ingressMode,
    withOpencode: info.runtimeKind === "opencode" && info.ingressMode === "engine",
    logPath: info.logPath,
  })
  if (result.kind === "unsupported") {
    write(`${result.message}\n`)
    return 1
  }
  if (result.kind === "failed") {
    write(
      `Error: could not load the ${result.manager ?? "user"} service: ${result.message}\n` +
        `Run the bridge in tmux instead: aibr start --foreground --profile ${profile}\n`,
    )
    return 1
  }
  for (const note of result.notes) write(`${note}\n`)
  const url = healthUrl(info)
  const health = await waitForHealth(deps, url, START_HEALTH_TIMEOUT_MS, info.agentId)
  if (health.foreign !== undefined) {
    write(`Error: ${foreignBridgeHint(info, health.foreign)}.\n`)
    return 1
  }
  if (!health.ok) {
    write(
      `The ${result.manager} service for "${profile}" is loaded (${result.unitPath}), but ${url} did not answer ` +
        `within ${START_HEALTH_TIMEOUT_MS / 1000}s. Last log lines (${info.logPath}):\n` +
        logTail(deps, info.logPath) +
        `More: aibr logs --profile ${profile}    Stop: aibr stop --profile ${profile}\n`,
    )
    return 1
  }
  write(
    `Started the ${result.manager} service for "${profile}" (${result.unitPath}); it restarts on failure and at login.\n` +
      `Bridge healthy at ${info.publicUrl} (agent ${info.agentId}).\n` +
      `Logs: aibr logs --profile ${profile}    Stop: aibr stop --profile ${profile}    Check: aibr doctor --profile ${profile}\n`,
  )
  return 0
}

export type StatusRunner = "launchd" | "systemd" | "tmux" | "unmanaged"

export type ProfileStatus =
  | { readonly kind: "healthy"; readonly sessionName: string; readonly runner: StatusRunner; readonly body: string; readonly hint?: string }
  | { readonly kind: "bridge_unavailable"; readonly sessionName: string; readonly runner: StatusRunner; readonly probeStatus: number; readonly hint?: string }
  | { readonly kind: "not_running"; readonly sessionName: string; readonly hint?: string }
  | { readonly kind: "no_bridge"; readonly sessionName: string; readonly hint?: string }

export interface StatusFacts {
  readonly info: ProfileRunInfo
  readonly service: UserServiceState
  readonly tmux: boolean
  readonly health: { readonly ok: boolean; readonly status: number; readonly body: string }
}

/** Gathers the three facts `status` and `doctor` reason about. */
export async function gatherStatusFacts(profile: string, deps: ServiceCommandDeps): Promise<StatusFacts> {
  const info = await (deps.loadInfo ?? ((p) => loadProfileRunInfo(p, deps.env)))(profile)
  const [service, tmux, health] = await Promise.all([
    userServiceState(deps.service, profile),
    tmuxSessionExists(deps.runner, tmuxSessionName(profile)),
    info.role === "orchestrator" ? Promise.resolve({ ok: false, status: 0, body: "" }) : deps.probe.probe(healthUrl(info), { timeoutMs: 3000 }),
  ])
  return { info, service, tmux, health }
}

/** Decides what `aibr status` reports from the facts. Pure. */
export function decideStatus(facts: StatusFacts): ProfileStatus {
  const { info, service, tmux, health } = facts
  const profile = info.profile
  const sessionName = service.running && service.manager !== null ? `${service.manager}:${profile}` : tmuxSessionName(profile)
  if (info.role === "orchestrator") {
    return {
      kind: "no_bridge",
      sessionName,
      hint: `profile "${profile}" is an orchestrator and runs no bridge; check its peers with: aibr doctor --profile ${profile}`,
    }
  }
  const runner: StatusRunner | null = service.running ? service.manager : tmux ? "tmux" : null
  const legacyHint =
    service.legacyUnitPath !== undefined
      ? `it runs from the shared unit ${service.legacyUnitPath}; "aibr start --profile ${profile}" replaces it with a per-profile one`
      : undefined
  const foreign = health.ok ? foreignAgent(health.body, info.agentId) : null
  if (foreign !== null) {
    return { kind: "bridge_unavailable", sessionName, runner: runner ?? "unmanaged", probeStatus: health.status, hint: foreignBridgeHint(info, foreign) }
  }
  if (health.ok) {
    const both = service.running && tmux ? `both the ${service.manager} service and tmux session ${tmuxSessionName(profile)} exist; stop one (aibr stop --profile ${profile})` : undefined
    return {
      kind: "healthy",
      sessionName,
      runner: runner ?? "unmanaged",
      body: health.body,
      ...(both !== undefined || legacyHint !== undefined
        ? { hint: both ?? legacyHint! }
        : runner === null
          ? { hint: "the bridge answers but neither the user service nor the tmux session runs it (a manual aibr serve?)" }
          : {}),
    }
  }
  if (runner === null) {
    return { kind: "not_running", sessionName, hint: `start it with: aibr start --profile ${profile}` }
  }
  return {
    kind: "bridge_unavailable",
    sessionName,
    runner,
    probeStatus: health.status,
    hint: `the ${runner === "tmux" ? "tmux session" : `${runner} service`} is up but ${healthUrl(info)} does not answer; see: aibr logs --profile ${profile}`,
  }
}

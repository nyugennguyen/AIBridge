/**
 * The per-profile user service: the one way `aibr start` runs a node.
 *
 * - macOS: a launchd LaunchAgent, `~/Library/LaunchAgents/com.aibridge.<profile>.plist`,
 *   loaded with `launchctl bootstrap gui/<uid>` (falling back to `user/<uid>` on
 *   a Mac with no GUI session, e.g. over SSH) and unloaded with `bootout`.
 * - Linux: a systemd user unit, `~/.config/systemd/user/aibridge-<profile>.service`,
 *   started with `systemctl --user enable --now` and stopped with `disable --now`.
 *
 * One unit per profile, so two profiles on one machine (a CI smoke test, a
 * worker and an orchestrator side by side) never fight over a label.
 *
 * ## What the unit runs
 *
 * Exactly what `aibr start --foreground` (tmux) runs, for the profile's
 * `bridge.ingress_mode`:
 * - `engine` (the default) → `aibr serve --profile <p>`; for an OpenCode
 *   worker `--with-opencode` as well, so the bridge supervises `opencode serve`
 *   as its child (the tmux path gives it its own window instead).
 * - `router` → `aibr worker --profile <p>`, the drain loop behind
 *   the Rust `aibr-router`, which is an advanced, opt-in mode.
 *
 * `aibr` is invoked by absolute path (the Bun binary plus the CLI script, or
 * the compiled binary), and the unit carries the installing shell's `PATH` and
 * XDG directories: launchd starts agents with a bare `PATH`, and a service that
 * resolves a different profile directory than the shell that installed it is a
 * service that runs a profile nobody configured. No secret is ever written into
 * a unit: the bridge reads its secrets from the profile at startup.
 *
 * stdout and stderr go to the profile's log file (`<stateDir>/logs/aibridge.log`,
 * see src/host/logs.ts), which is what `aibr logs` prints.
 *
 * No memory cap: a systemd `MemoryMax` applies to the whole cgroup, and every
 * Claude Code job is a child of the bridge.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not create the router's ingress outbox database (`aibr-router
 * --init-store` owns that table; ADR 0008 §2.2).
 */

import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ProcessRunner } from "./types.js"
const execFileAsync = promisify(execFile)

/** Which ingress path the profile uses; decides the unit's command. */
export type DaemonIngressMode = "engine" | "router"

export interface DaemonUnitResult {
  readonly platform: "darwin" | "linux" | "unsupported"
  readonly installed: boolean
  readonly unitPath: string | null
  /** The exact command that activates the unit, for an operator running it by hand. */
  readonly command: string | null
  /** The exact command that stops and unloads it again. */
  readonly stopCommand: string | null
  readonly message: string
}

export interface DaemonLoadResult {
  readonly platform: "darwin" | "linux" | "unsupported"
  readonly loaded: boolean
  readonly message: string
}

/** argv runner for `launchctl` / `systemctl`; injectable so tests never touch the real supervisor. */
export type SupervisorExec = (file: string, args: readonly string[]) => Promise<unknown>

const defaultSupervisorExec: SupervisorExec = (file, args) => execFileAsync(file, [...args])

/** The label every profile shared before units were per profile. Migrated away by `aibr start`. */
export const LEGACY_LAUNCHD_LABEL = "com.aibridge.daemon"
/** The systemd unit every profile shared before units were per profile. */
export const LEGACY_SYSTEMD_UNIT = "aibridge.service"

/**
 * Profile names are operator input that lands unescaped in a plist and a systemd
 * unit, so they are constrained to the character set both formats accept
 * verbatim. A name that cannot be represented safely is a name that is refused,
 * not one that is silently rewritten.
 */
const SAFE_PROFILE = /^[A-Za-z0-9._-]{1,64}$/

function assertSafeProfile(profile: string): string {
  if (!SAFE_PROFILE.test(profile)) {
    throw new Error(
      `Unsafe profile name ${JSON.stringify(profile)}: expected 1-64 characters of [A-Za-z0-9._-]`,
    )
  }
  return profile
}

/** launchd label of a profile's unit. */
export function launchdLabel(profile: string): string {
  return `com.aibridge.${assertSafeProfile(profile)}`
}

/** systemd unit name of a profile's unit. */
export function systemdUnitName(profile: string): string {
  return `aibridge-${assertSafeProfile(profile)}.service`
}

/** Where a profile's unit file lives. */
export function unitPathFor(platform: string, profile: string, home: string = homedir()): string | null {
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${launchdLabel(profile)}.plist`)
  if (platform === "linux") return join(home, ".config", "systemd", "user", systemdUnitName(profile))
  return null
}

/**
 * Escapes a string for an XML text node or attribute value.
 *
 * The plist writer interpolates a binary path and a profile name into XML, and
 * an unescaped `&` or `<` produces a file launchd refuses to parse.
 */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/**
 * One word of a systemd `ExecStart=` / `Environment=` line: double-quoted, with
 * `\` and `"` escaped, `%` doubled (unit specifiers) and `$` doubled (variable
 * expansion). Newlines are refused: they would end the directive.
 */
function systemdWord(value: string): string {
  if (/[\n\r]/.test(value)) throw new Error("A systemd unit value must not contain a newline")
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`
}

/** A path for `StandardOutput=append:` (not quoted; specifiers escaped). */
function systemdPath(value: string): string {
  if (/[\n\r]/.test(value)) throw new Error("A systemd unit path must not contain a newline")
  return value.replace(/%/g, "%%")
}

export interface DaemonCommandOptions {
  /** OpenCode worker: the bridge also supervises `opencode serve` (`--with-opencode`). */
  readonly withOpencode?: boolean
}

/**
 * The `aibr` arguments the unit runs for a given ingress mode.
 *
 * Exported so the wizard, the docs, and the tests all read the same answer.
 */
export function daemonCommandArgs(
  profile: string,
  ingressMode: DaemonIngressMode = "engine",
  options: DaemonCommandOptions = {},
): readonly string[] {
  const safe = assertSafeProfile(profile)
  if (ingressMode === "router") return ["worker", "--profile", safe]
  return options.withOpencode === true ? ["serve", "--profile", safe, "--with-opencode"] : ["serve", "--profile", safe]
}

/**
 * How to invoke this very `aibr` by absolute path: the runtime plus the CLI
 * script (`bun /…/dist/cli.js`), or just the executable for a compiled binary.
 */
export function currentAibrEntry(
  execPath: string = process.execPath,
  argv: readonly string[] = process.argv,
  exists: (path: string) => boolean = existsSync,
): readonly string[] {
  const script = argv[1]
  if (script !== undefined && /\.(?:[cm]?js|ts)$/.test(script) && !script.startsWith("/$bunfs/") && exists(script)) {
    return [execPath, script]
  }
  return [execPath]
}

/** The current user's uid, for `launchctl bootstrap gui/<uid>`. */
function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 501
}

/** `launchctl bootstrap gui/<uid> <plist>` -- the supported replacement for `load -w`. */
export function launchdStartCommand(unitPath: string, uid: number = currentUid()): string {
  return `launchctl bootstrap gui/${uid} ${unitPath}`
}

/** `launchctl bootout gui/<uid> <plist>` -- the supported replacement for `unload`. */
export function launchdStopCommand(unitPath: string, uid: number = currentUid()): string {
  return `launchctl bootout gui/${uid} ${unitPath}`
}

/** Environment keys copied from the installing shell into the unit (never a secret). */
export const SERVICE_ENV_KEYS = ["PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "OPENCODE_BIN"] as const

/** The unit's environment: the allow-listed keys that are set, plus `HOME` and `AIBR_SERVICE=1`. */
export function serviceEnvironment(env: Readonly<Record<string, string | undefined>>, home: string): Record<string, string> {
  const out: Record<string, string> = { HOME: home }
  for (const key of SERVICE_ENV_KEYS) {
    const value = env[key]
    if (value !== undefined && value !== "") out[key] = value
  }
  out.AIBR_SERVICE = "1"
  return out
}

export interface UnitOptions {
  /** Absolute argv that runs `aibr` (see {@link currentAibrEntry}); default `["aibr"]`. */
  readonly entry?: readonly string[]
  /** @deprecated use `entry`. A single executable path. */
  readonly aibrPath?: string
  readonly profile?: string
  readonly configPath?: string
  readonly ingressMode?: DaemonIngressMode
  readonly withOpencode?: boolean
  readonly homeDir?: string
  /** Where stdout/stderr go; default `<home>/Library/Logs/aibridge-<profile>.log` / journal. */
  readonly logPath?: string
  readonly environment?: Readonly<Record<string, string>>
  /** Ignored; kept so older callers compile. */
  readonly nodePath?: string
}

function unitEntry(options: UnitOptions): readonly string[] {
  if (options.entry !== undefined && options.entry.length > 0) return options.entry
  return [options.aibrPath ?? "aibr"]
}

/**
 * Generates the macOS launchd plist for a profile.
 */
export function generateLaunchdPlist(options: UnitOptions): string {
  const profile = options.profile ?? "default"
  const args = daemonCommandArgs(profile, options.ingressMode ?? "engine", { withOpencode: options.withOpencode === true })
  const home = options.homeDir ?? homedir()
  const logPath = options.logPath ?? join(home, "Library", "Logs", `aibridge-${profile}.log`)
  const programArguments = [...unitEntry(options), ...args]
    .map((arg) => `        <string>${xmlEscape(arg)}</string>`)
    .join("\n")
  const env = options.environment ?? {}
  const envBlock =
    Object.keys(env).length === 0
      ? ""
      : `    <key>EnvironmentVariables</key>
    <dict>
${Object.entries(env)
  .map(([key, value]) => `        <key>${xmlEscape(key)}</key>\n        <string>${xmlEscape(value)}</string>`)
  .join("\n")}
    </dict>
`

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(launchdLabel(profile))}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
${envBlock}    <key>WorkingDirectory</key>
    <string>${xmlEscape(home)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xmlEscape(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`
}

/**
 * Generates the Linux systemd user unit for a profile.
 */
export function generateSystemdUnit(options: UnitOptions): string {
  const ingressMode = options.ingressMode ?? "engine"
  const profile = options.profile ?? "default"
  const args = daemonCommandArgs(profile, ingressMode, { withOpencode: options.withOpencode === true })
  const description =
    ingressMode === "router"
      ? `AIBridge Ingress Drain Worker (${args[2]!})`
      : `AIBridge Bridge Server (${args[2]!})`
  const entry = unitEntry(options)
  // A bare `aibr` stays a bare word so systemd resolves it on its own PATH.
  const execStart = [...entry.map((word) => (word === "aibr" ? word : systemdWord(word))), ...args].join(" ")
  const env = options.environment ?? {}
  const envLines = Object.entries(env)
    .map(([key, value]) => `Environment=${systemdWord(`${key}=${value}`)}`)
    .join("\n")
  const logLines =
    options.logPath !== undefined
      ? `StandardOutput=append:${systemdPath(options.logPath)}\nStandardError=append:${systemdPath(options.logPath)}\n`
      : ""

  return `[Unit]
Description=${description}
After=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
${envLines !== "" ? `${envLines}\n` : ""}Restart=on-failure
RestartSec=5
${logLines}
[Install]
WantedBy=default.target
`
}

/**
 * Writes the profile's supervisor unit (launchd on macOS, systemd on Linux)
 * without activating it unless `skipLoad === false`.
 */
export async function installDaemonUnit(options?: {
  platform?: string
  profile?: string
  homeDir?: string
  skipLoad?: boolean
  ingressMode?: DaemonIngressMode
  withOpencode?: boolean
  entry?: readonly string[]
  logPath?: string
  environment?: Readonly<Record<string, string>>
  uid?: number
  exec?: SupervisorExec
}): Promise<DaemonUnitResult> {
  const platform = options?.platform ?? process.platform
  const profile = options?.profile ?? "default"
  const home = options?.homeDir ?? homedir()
  const ingressMode = options?.ingressMode ?? "engine"
  const uid = options?.uid ?? currentUid()
  const unitOptions: UnitOptions = {
    profile,
    ingressMode,
    homeDir: home,
    ...(options?.withOpencode === true ? { withOpencode: true } : {}),
    ...(options?.entry !== undefined ? { entry: options.entry } : {}),
    ...(options?.logPath !== undefined ? { logPath: options.logPath } : {}),
    ...(options?.environment !== undefined ? { environment: options.environment } : {}),
  }

  if (platform === "darwin") {
    const unitPath = unitPathFor("darwin", profile, home)!
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true, mode: 0o700 })
    if (options?.logPath !== undefined) await mkdir(options.logPath.slice(0, options.logPath.lastIndexOf("/")), { recursive: true, mode: 0o700 })
    await writeFile(unitPath, generateLaunchdPlist(unitOptions), { mode: 0o600 })

    if (options?.skipLoad === false) {
      await loadDaemonUnit({ platform, unitPath, uid, exec: options?.exec })
    }

    return {
      platform: "darwin",
      installed: true,
      unitPath,
      command: launchdStartCommand(unitPath, uid),
      stopCommand: launchdStopCommand(unitPath, uid),
      message: `Installed macOS launchd agent at ${unitPath}`,
    }
  }

  if (platform === "linux") {
    const unitPath = unitPathFor("linux", profile, home)!
    await mkdir(join(home, ".config", "systemd", "user"), { recursive: true, mode: 0o700 })
    if (options?.logPath !== undefined) await mkdir(options.logPath.slice(0, options.logPath.lastIndexOf("/")), { recursive: true, mode: 0o700 })
    await writeFile(unitPath, generateSystemdUnit(unitOptions), { mode: 0o600 })

    if (options?.skipLoad === false) {
      await loadDaemonUnit({ platform, unitPath, exec: options?.exec })
    }

    const unit = systemdUnitName(profile)
    return {
      platform: "linux",
      installed: true,
      unitPath,
      command: `systemctl --user enable --now ${unit}`,
      stopCommand: `systemctl --user disable --now ${unit}`,
      message: `Installed Linux systemd user service at ${unitPath}`,
    }
  }

  return {
    platform: "unsupported",
    installed: false,
    unitPath: null,
    command: null,
    stopCommand: null,
    message: `Unsupported platform for a user service: ${platform}`,
  }
}

/**
 * Activates a previously written supervisor unit.
 *
 * On macOS this is `launchctl bootstrap gui/<uid>`, not the deprecated
 * `launchctl load -w`. `bootstrap` refuses a label that is already loaded, so a
 * best-effort `bootout` runs first: re-running replaces the unit rather than
 * failing on the one the previous run left behind.
 */
export async function loadDaemonUnit(options: {
  platform?: string
  unitPath?: string | null
  uid?: number
  exec?: SupervisorExec
}): Promise<DaemonLoadResult> {
  const platform = options.platform ?? process.platform
  const unitPath = options.unitPath ?? null
  const exec = options.exec ?? defaultSupervisorExec

  if (platform === "darwin") {
    if (unitPath === null) {
      return { platform, loaded: false, message: "No launchd unit path to load" }
    }
    const domain = `gui/${options.uid ?? currentUid()}`
    try {
      await exec("launchctl", ["bootout", domain, unitPath])
    } catch {
      // Not loaded yet -- the ordinary first-run case.
    }
    await exec("launchctl", ["bootstrap", domain, unitPath])
    return {
      platform,
      loaded: true,
      message: `Loaded launchd agent at ${unitPath}`,
    }
  }

  if (platform === "linux") {
    const unit = unitPath !== null ? (unitPath.split("/").pop() ?? LEGACY_SYSTEMD_UNIT) : LEGACY_SYSTEMD_UNIT
    // `enable --now` is idempotent; `daemon-reload` is what a freshly written
    // unit needs before the manager will accept a start request for it.
    await exec("systemctl", ["--user", "daemon-reload"])
    await exec("systemctl", ["--user", "enable", "--now", unit])
    return {
      platform,
      loaded: true,
      message: `Enabled and started systemd user service ${unit}`,
    }
  }

  return {
    platform: "unsupported",
    loaded: false,
    message: `Cannot activate a supervisor unit on ${platform}`,
  }
}

// ── service lifecycle (aibr start / stop / status) ─────────────────────

export interface UserServiceDeps {
  readonly platform: string
  readonly uid: number
  readonly home: string
  readonly runner: ProcessRunner
  readonly env: Readonly<Record<string, string | undefined>>
  /** Absolute argv that runs this `aibr`. */
  readonly entry: readonly string[]
  readonly writeFile: (path: string, data: string) => Promise<void>
  readonly readFile: (path: string) => Promise<string | null>
  readonly removeFile: (path: string) => Promise<void>
  readonly fileExists: (path: string) => boolean
  /** Waits between supervisor polls (launchd tears a job down asynchronously). Default: setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>
}

export function defaultUserServiceDeps(runner: ProcessRunner, env: Readonly<Record<string, string | undefined>> = process.env): UserServiceDeps {
  const home = env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir()
  return {
    platform: process.platform,
    uid: currentUid(),
    home,
    runner,
    env,
    entry: currentAibrEntry(),
    writeFile: async (path, data) => {
      await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true, mode: 0o700 })
      await writeFile(path, data, { mode: 0o600 })
    },
    readFile: async (path) => {
      try {
        return await readFile(path, "utf8")
      } catch {
        return null
      }
    },
    removeFile: async (path) => {
      await rm(path, { force: true })
    },
    fileExists: (path) => existsSync(path),
  }
}

export interface UserServiceSpec {
  readonly profile: string
  readonly ingressMode: DaemonIngressMode
  readonly withOpencode: boolean
  /** `<stateDir>/logs/aibridge.log`. */
  readonly logPath: string
}

export type ServiceManager = "launchd" | "systemd"

export interface UserServiceState {
  readonly supported: boolean
  readonly manager: ServiceManager | null
  readonly unitPath: string | null
  /** The unit file exists. */
  readonly installed: boolean
  /** The supervisor has it loaded / active. */
  readonly running: boolean
  readonly pid?: number
  /** A pre-0.x shared unit (`com.aibridge.daemon` / `aibridge.service`) running this profile. */
  readonly legacyUnitPath?: string
  readonly detail?: string
}

export type StartServiceResult =
  | { readonly kind: "started"; readonly manager: ServiceManager; readonly unitPath: string; readonly notes: readonly string[] }
  | { readonly kind: "unsupported"; readonly message: string }
  | { readonly kind: "failed"; readonly manager: ServiceManager | null; readonly message: string; readonly unitPath?: string }

export type StopServiceResult =
  | { readonly kind: "stopped"; readonly manager: ServiceManager; readonly notes: readonly string[] }
  | { readonly kind: "not_installed" }
  | { readonly kind: "unsupported"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string }

function managerFor(platform: string): ServiceManager | null {
  return platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : null
}

/** A legacy shared unit file that runs exactly this profile, or `null`. */
async function legacyUnitFor(deps: UserServiceDeps, profile: string): Promise<string | null> {
  const path =
    deps.platform === "darwin"
      ? join(deps.home, "Library", "LaunchAgents", `${LEGACY_LAUNCHD_LABEL}.plist`)
      : deps.platform === "linux"
        ? join(deps.home, ".config", "systemd", "user", LEGACY_SYSTEMD_UNIT)
        : null
  if (path === null) return null
  const text = await deps.readFile(path)
  if (text === null) return null
  const runsProfile =
    deps.platform === "darwin"
      ? new RegExp(`<string>--profile</string>\\s*<string>${escapeRegExp(profile)}</string>`).test(text)
      : new RegExp(`--profile ${escapeRegExp(profile)}(?:\\s|$)`, "m").test(text)
  return runsProfile ? path : null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** The gui domain first; `user/<uid>` on a Mac with no GUI login (SSH-only). */
function launchdDomains(uid: number): readonly string[] {
  return [`gui/${uid}`, `user/${uid}`]
}

function trimDetail(text: string): string {
  return text.trim().split("\n").slice(-3).join(" ").slice(0, 300)
}

/** Is the profile's unit installed and running? Never throws. */
export async function userServiceState(deps: UserServiceDeps, profile: string): Promise<UserServiceState> {
  const manager = managerFor(deps.platform)
  if (manager === null) {
    return { supported: false, manager: null, unitPath: null, installed: false, running: false, detail: `no user service manager on ${deps.platform}` }
  }
  const unitPath = unitPathFor(deps.platform, profile, deps.home)!
  const installed = deps.fileExists(unitPath)
  const legacy = await legacyUnitFor(deps, profile)
  const legacyField = legacy !== null ? { legacyUnitPath: legacy } : {}

  if (manager === "launchd") {
    for (const label of legacy !== null ? [launchdLabel(profile), LEGACY_LAUNCHD_LABEL] : [launchdLabel(profile)]) {
      for (const domain of launchdDomains(deps.uid)) {
        const result = await deps.runner.exec(["launchctl", "print", `${domain}/${label}`])
        if (result.exitCode === 0) {
          const pid = /\bpid = (\d+)/.exec(result.stdout)?.[1]
          const state = /\bstate = (\w+)/.exec(result.stdout)?.[1]
          return {
            supported: true,
            manager,
            unitPath: label === LEGACY_LAUNCHD_LABEL ? legacy : unitPath,
            installed: true,
            running: state === undefined ? pid !== undefined : state === "running",
            ...(pid !== undefined ? { pid: Number(pid) } : {}),
            ...legacyField,
            ...(state !== undefined && state !== "running" ? { detail: `launchd state: ${state}` } : {}),
          }
        }
      }
    }
    return { supported: true, manager, unitPath, installed, running: false, ...legacyField }
  }

  const units = legacy !== null ? [systemdUnitName(profile), LEGACY_SYSTEMD_UNIT] : [systemdUnitName(profile)]
  for (const unit of units) {
    const result = await deps.runner.exec(["systemctl", "--user", "is-active", unit])
    const state = result.stdout.trim()
    if (state === "active" || state === "activating" || state === "reloading") {
      return { supported: true, manager, unitPath: unit === LEGACY_SYSTEMD_UNIT ? legacy : unitPath, installed: true, running: true, ...legacyField }
    }
    if (/Failed to connect to bus|No medium found/i.test(result.stderr)) {
      return {
        supported: false,
        manager,
        unitPath,
        installed,
        running: false,
        ...legacyField,
        detail: "systemd --user is not available in this session (no user bus)",
      }
    }
  }
  return { supported: true, manager, unitPath, installed, running: false, ...legacyField }
}

/**
 * `aibr start`: write the profile's unit and load it (replacing a loaded copy,
 * and migrating a legacy shared unit that ran this profile).
 */
export async function startUserService(deps: UserServiceDeps, spec: UserServiceSpec): Promise<StartServiceResult> {
  const manager = managerFor(deps.platform)
  if (manager === null) {
    return { kind: "unsupported", message: `No user service manager on ${deps.platform}. Use "aibr start --foreground".` }
  }
  const unitPath = unitPathFor(deps.platform, spec.profile, deps.home)!
  const notes: string[] = []
  const environment = serviceEnvironment(deps.env, deps.home)
  const unitOptions: UnitOptions = {
    profile: spec.profile,
    ingressMode: spec.ingressMode,
    withOpencode: spec.withOpencode,
    homeDir: deps.home,
    entry: deps.entry,
    logPath: spec.logPath,
    environment,
  }

  const legacy = await legacyUnitFor(deps, spec.profile)

  if (manager === "launchd") {
    if (legacy !== null) {
      for (const domain of launchdDomains(deps.uid)) await bootoutAndWait(deps, `${domain}/${LEGACY_LAUNCHD_LABEL}`)
      await deps.removeFile(legacy)
      notes.push(`Replaced the shared unit ${legacy} with a per-profile one.`)
    }
    await deps.writeFile(unitPath, generateLaunchdPlist(unitOptions))
    const label = launchdLabel(spec.profile)
    let lastError = ""
    for (const domain of launchdDomains(deps.uid)) {
      await bootoutAndWait(deps, `${domain}/${label}`)
      // `bootstrap` right after a `bootout` can still see the old job and
      // answers "5: Input/output error"; it succeeds once launchd has let go.
      for (let attempt = 0; attempt < LAUNCHD_BOOTSTRAP_ATTEMPTS; attempt += 1) {
        const result = await deps.runner.exec(["launchctl", "bootstrap", domain, unitPath])
        if (result.exitCode === 0) return { kind: "started", manager, unitPath, notes }
        lastError = trimDetail(result.stderr || result.stdout || `launchctl bootstrap ${domain} failed`)
        if (!/Input\/output error|\b5:/.test(lastError)) break
        await (deps.sleep ?? defaultSleep)(LAUNCHD_POLL_MS * 2)
      }
    }
    return { kind: "failed", manager, unitPath, message: lastError }
  }

  const unit = systemdUnitName(spec.profile)
  if (legacy !== null) {
    await deps.runner.exec(["systemctl", "--user", "disable", "--now", LEGACY_SYSTEMD_UNIT])
    await deps.removeFile(legacy)
    notes.push(`Replaced the shared unit ${legacy} with ${unit}.`)
  }
  await deps.writeFile(unitPath, generateSystemdUnit(unitOptions))
  const reload = await deps.runner.exec(["systemctl", "--user", "daemon-reload"])
  if (reload.exitCode !== 0) {
    return { kind: "failed", manager, unitPath, message: trimDetail(reload.stderr || "systemctl --user daemon-reload failed") }
  }
  const enable = await deps.runner.exec(["systemctl", "--user", "enable", unit])
  if (enable.exitCode !== 0) {
    return { kind: "failed", manager, unitPath, message: trimDetail(enable.stderr || `systemctl --user enable ${unit} failed`) }
  }
  // `restart`, not `start`: a re-run after a config change must pick it up.
  const restart = await deps.runner.exec(["systemctl", "--user", "restart", unit])
  if (restart.exitCode !== 0) {
    return { kind: "failed", manager, unitPath, message: trimDetail(restart.stderr || `systemctl --user restart ${unit} failed`) }
  }
  const linger = await lingerEnabled(deps)
  if (linger === false) {
    const user = deps.env.USER ?? deps.env.LOGNAME ?? "$USER"
    notes.push(
      `systemd stops user services when you log out. To keep the bridge running: sudo loginctl enable-linger ${user}`,
    )
  }
  return { kind: "started", manager, unitPath, notes }
}

const LAUNCHD_POLL_MS = 250
const LAUNCHD_BOOTOUT_WAIT_MS = 10_000
const LAUNCHD_BOOTSTRAP_ATTEMPTS = 4

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `launchctl bootout <service>` and wait until `print` no longer finds it (bounded). */
async function bootoutAndWait(deps: UserServiceDeps, service: string): Promise<void> {
  if ((await deps.runner.exec(["launchctl", "print", service])).exitCode !== 0) return
  await deps.runner.exec(["launchctl", "bootout", service])
  for (let waited = 0; waited < LAUNCHD_BOOTOUT_WAIT_MS; waited += LAUNCHD_POLL_MS) {
    if ((await deps.runner.exec(["launchctl", "print", service])).exitCode !== 0) return
    await (deps.sleep ?? defaultSleep)(LAUNCHD_POLL_MS)
  }
}

/** `loginctl show-user` Linger=yes|no; `null` when it cannot be told. */
export async function lingerEnabled(deps: Pick<UserServiceDeps, "runner" | "env">): Promise<boolean | null> {
  const user = deps.env.USER ?? deps.env.LOGNAME
  if (user === undefined || user === "") return null
  const result = await deps.runner.exec(["loginctl", "show-user", user, "--property=Linger"])
  if (result.exitCode !== 0) return null
  const value = /Linger=(\w+)/.exec(result.stdout)?.[1]
  return value === undefined ? null : value === "yes"
}

/** `aibr stop`: unload the profile's unit and remove it (and a legacy unit that ran it). */
export async function stopUserService(deps: UserServiceDeps, profile: string): Promise<StopServiceResult> {
  const manager = managerFor(deps.platform)
  if (manager === null) return { kind: "unsupported", message: `No user service manager on ${deps.platform}.` }
  const unitPath = unitPathFor(deps.platform, profile, deps.home)!
  const legacy = await legacyUnitFor(deps, profile)
  const installed = deps.fileExists(unitPath)
  if (!installed && legacy === null) return { kind: "not_installed" }
  const notes: string[] = []

  if (manager === "launchd") {
    const labels = [...(installed ? [launchdLabel(profile)] : []), ...(legacy !== null ? [LEGACY_LAUNCHD_LABEL] : [])]
    for (const label of labels) {
      for (const domain of launchdDomains(deps.uid)) await deps.runner.exec(["launchctl", "bootout", `${domain}/${label}`])
    }
  } else {
    const units = [...(installed ? [systemdUnitName(profile)] : []), ...(legacy !== null ? [LEGACY_SYSTEMD_UNIT] : [])]
    for (const unit of units) {
      const result = await deps.runner.exec(["systemctl", "--user", "disable", "--now", unit])
      if (result.exitCode !== 0 && !/not loaded|does not exist|No such file/i.test(result.stderr)) {
        return { kind: "failed", message: trimDetail(result.stderr || `systemctl --user disable --now ${unit} failed`) }
      }
    }
  }
  if (installed) await deps.removeFile(unitPath)
  if (legacy !== null) {
    await deps.removeFile(legacy)
    notes.push(`Also removed the shared unit ${legacy}.`)
  }
  if (manager === "systemd") await deps.runner.exec(["systemctl", "--user", "daemon-reload"])
  return { kind: "stopped", manager, notes }
}

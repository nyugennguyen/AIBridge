/**
 * Service Daemonizer & Platform Supervisor Integration
 *
 * Implements Step 5 system service installation:
 * - macOS launchd: ~/Library/LaunchAgents/com.aibridge.daemon.plist
 * - Linux systemd: ~/.config/systemd/user/aibridge.service
 *
 * ## What the unit runs
 *
 * The unit runs what matches the profile's `bridge.ingress_mode`:
 * - `engine` (the default) → `aibr serve --profile <p>`, the same bridge the
 *   tmux path (`aibr start`) runs in its `aibridge` window. One node, one way of
 *   serving, whichever supervisor is used.
 * - `router` → `aibr worker --profile <p> --ipc-publish`, the drain loop behind
 *   the Rust `aibr-router`. Only meaningful once the router and its store exist.
 *
 * The unit supervises the bridge only. On an OpenCode worker, `opencode serve`
 * still has to run beside it (the tmux path starts both).
 *
 * ## What this module deliberately does NOT do
 *
 * It does not create the ingress outbox database. That table is owned by the
 * Rust router (`router/src/outbox.rs`, `CREATE TABLE ingress_outbox ... STRICT`)
 * and is provisioned by an explicit operator step, `aibr-router --init-store`.
 * Provisioning it from here would create a table whose columns are not the
 * router's, at a path the router does not read, and `aibr worker` documents at
 * length why an implicitly-created store is worse than none: the router would
 * refuse to serve against it, the worker would drain an empty one, and both
 * would look healthy.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
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

/** launchd label of the unit this module writes. */
export const LAUNCHD_LABEL = "com.aibridge.daemon"

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
 * The `aibr` arguments the unit runs for a given ingress mode.
 *
 * Exported so the wizard, the docs, and the tests all read the same answer.
 */
export function daemonCommandArgs(profile: string, ingressMode: DaemonIngressMode = "engine"): readonly string[] {
  const safe = assertSafeProfile(profile)
  return ingressMode === "router"
    ? ["worker", "--profile", safe, "--ipc-publish"]
    : ["serve", "--profile", safe]
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

/**
 * Generates macOS launchd plist content for AIBridge daemon.
 */
export function generateLaunchdPlist(options: {
  nodePath?: string
  aibrPath?: string
  profile?: string
  configPath?: string
  ingressMode?: DaemonIngressMode
  homeDir?: string
}): string {
  const args = daemonCommandArgs(options.profile ?? "default", options.ingressMode ?? "engine")
  const aibrBin = options.aibrPath ?? "aibr"
  const logs = join(options.homeDir ?? homedir(), "Library", "Logs")
  const programArguments = [aibrBin, ...args]
    .map((arg) => `        <string>${xmlEscape(arg)}</string>`)
    .join("\n")

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>HardResourceLimits</key>
    <dict>
        <key>ResidentSetSize</key>
        <integer>67108864</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${xmlEscape(join(logs, "aibridge-daemon.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(logs, "aibridge-daemon.err"))}</string>
</dict>
</plist>
`
}

/**
 * Generates Linux systemd user service unit content for AIBridge daemon.
 */
export function generateSystemdUnit(options: {
  aibrPath?: string
  profile?: string
  configPath?: string
  ingressMode?: DaemonIngressMode
}): string {
  const ingressMode = options.ingressMode ?? "engine"
  const args = daemonCommandArgs(options.profile ?? "default", ingressMode)
  const profile = args[2]!
  const aibrBin = options.aibrPath ?? "aibr"
  const description =
    ingressMode === "router"
      ? `AIBridge Ingress Drain Worker (${profile})`
      : `AIBridge Bridge Server (${profile})`

  return `[Unit]
Description=${description}
After=network.target tailscaled.service
Wants=tailscaled.service

[Service]
Type=simple
ExecStart=${aibrBin} ${args.join(" ")}
Restart=always
RestartSec=2
MemoryMax=64M
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`
}

/**
 * Writes the platform background supervisor unit (launchd on macOS, systemd on
 * Linux) without activating it.
 *
 * Writing and activating are separate because both units are `KeepAlive` /
 * `enable --now`: loading a unit whose config does not match the profile
 * produces a restart loop that is hard to read back out of a terminal. The
 * wizard writes first and asks before it activates.
 */
export async function installDaemonUnit(options?: {
  platform?: string
  profile?: string
  homeDir?: string
  skipLoad?: boolean
  ingressMode?: DaemonIngressMode
  uid?: number
  exec?: SupervisorExec
}): Promise<DaemonUnitResult> {
  const platform = options?.platform ?? process.platform
  const profile = options?.profile ?? "default"
  const home = options?.homeDir ?? homedir()
  const ingressMode = options?.ingressMode ?? "engine"
  const uid = options?.uid ?? currentUid()

  if (platform === "darwin") {
    const launchAgentsDir = join(home, "Library", "LaunchAgents")
    await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 })
    const unitPath = join(launchAgentsDir, `${LAUNCHD_LABEL}.plist`)
    const plistContent = generateLaunchdPlist({ profile, ingressMode, homeDir: home })
    await writeFile(unitPath, plistContent, { mode: 0o600 })

    if (options?.skipLoad === false) {
      await loadDaemonUnit({ platform, unitPath, uid, exec: options?.exec })
    }

    return {
      platform: "darwin",
      installed: true,
      unitPath,
      command: launchdStartCommand(unitPath, uid),
      stopCommand: launchdStopCommand(unitPath, uid),
      message: `Installed macOS launchd daemon at ${unitPath}`,
    }
  }

  if (platform === "linux") {
    const systemdUserDir = join(home, ".config", "systemd", "user")
    await mkdir(systemdUserDir, { recursive: true, mode: 0o700 })
    const unitPath = join(systemdUserDir, "aibridge.service")
    const unitContent = generateSystemdUnit({ profile, ingressMode })
    await writeFile(unitPath, unitContent, { mode: 0o600 })

    if (options?.skipLoad === false) {
      await loadDaemonUnit({ platform, unitPath, exec: options?.exec })
    }

    return {
      platform: "linux",
      installed: true,
      unitPath,
      command: "systemctl --user enable --now aibridge.service",
      stopCommand: "systemctl --user disable --now aibridge.service",
      message: `Installed Linux systemd user service at ${unitPath}`,
    }
  }

  return {
    platform: "unsupported",
    installed: false,
    unitPath: null,
    command: null,
    stopCommand: null,
    message: `Unsupported platform for automated service daemonization: ${platform}`,
  }
}

/**
 * Activates a previously written supervisor unit.
 *
 * Separate from `installDaemonUnit` so an operator can inspect the unit before
 * a `KeepAlive` service starts restarting. Failures are reported rather than
 * swallowed: an unloaded daemon is a thing an operator needs to be told about,
 * not a silent no-op.
 *
 * On macOS this is `launchctl bootstrap gui/<uid>`, not the deprecated
 * `launchctl load -w`. `bootstrap` refuses a label that is already loaded, so a
 * best-effort `bootout` runs first: re-running setup replaces the unit rather
 * than failing on the one the previous run left behind.
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
      message: `Loaded launchd daemon at ${unitPath}`,
    }
  }

  if (platform === "linux") {
    // `enable --now` is idempotent; `daemon-reload` is what a freshly written
    // unit needs before the manager will accept a start request for it.
    await exec("systemctl", ["--user", "daemon-reload"])
    await exec("systemctl", ["--user", "enable", "--now", "aibridge.service"])
    return {
      platform,
      loaded: true,
      message: "Enabled and started systemd user service aibridge.service",
    }
  }

  return {
    platform: "unsupported",
    loaded: false,
    message: `Cannot activate a supervisor unit on ${platform}`,
  }
}

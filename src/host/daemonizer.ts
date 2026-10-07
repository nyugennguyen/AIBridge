/**
 * Service Daemonizer & Platform Supervisor Integration
 *
 * Implements Step 5 system service installation:
 * - macOS launchd: ~/Library/LaunchAgents/com.aibridge.daemon.plist
 * - Linux systemd: ~/.config/systemd/user/aibridge.service
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

export interface DaemonUnitResult {
  readonly platform: "darwin" | "linux" | "unsupported"
  readonly installed: boolean
  readonly unitPath: string | null
  readonly command: string | null
  readonly message: string
}

export interface DaemonLoadResult {
  readonly platform: "darwin" | "linux" | "unsupported"
  readonly loaded: boolean
  readonly message: string
}

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
 * Generates macOS launchd plist content for AIBridge daemon.
 */
export function generateLaunchdPlist(options: {
  nodePath?: string
  aibrPath?: string
  profile?: string
  configPath?: string
}): string {
  const profile = assertSafeProfile(options.profile ?? "default")
  const aibrBin = options.aibrPath ?? "aibr"
  const logs = join(homedir(), "Library", "Logs")

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aibridge.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(aibrBin)}</string>
        <string>worker</string>
        <string>--profile</string>
        <string>${xmlEscape(profile)}</string>
        <string>--ipc-publish</string>
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
  configPath?: string;
}): string {
  const profile = assertSafeProfile(options.profile ?? "default")
  const aibrBin = options.aibrPath ?? "aibr"

  return `[Unit]
Description=AIBridge Distributed Mesh Agent Worker Daemon (${profile})
After=network.target tailscaled.service
Wants=tailscaled.service

[Service]
Type=simple
ExecStart=${aibrBin} worker --profile ${profile} --ipc-publish
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
 * `enable --now`: loading a unit whose config does not match the router's store
 * produces a restart loop that is hard to read back out of a terminal. The
 * wizard writes first and asks before it activates.
 */
export async function installDaemonUnit(options?: {
  platform?: string;
  profile?: string;
  homeDir?: string;
  skipLoad?: boolean;
}): Promise<DaemonUnitResult> {
  const platform = options?.platform ?? process.platform
  const profile = options?.profile ?? "default"
  const home = options?.homeDir ?? homedir()

  if (platform === "darwin") {
    const launchAgentsDir = join(home, "Library", "LaunchAgents")
    await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 })
    const unitPath = join(launchAgentsDir, "com.aibridge.daemon.plist")
    const plistContent = generateLaunchdPlist({ profile })
    await writeFile(unitPath, plistContent, { mode: 0o600 })

    if (options?.skipLoad === false) {
      await loadDaemonUnit({ platform, unitPath })
    }

    return {
      platform: "darwin",
      installed: true,
      unitPath,
      command: `launchctl load -w ${unitPath}`,
      message: `Installed macOS launchd daemon at ${unitPath}`,
    }
  }

  if (platform === "linux") {
    const systemdUserDir = join(home, ".config", "systemd", "user")
    await mkdir(systemdUserDir, { recursive: true, mode: 0o700 })
    const unitPath = join(systemdUserDir, "aibridge.service")
    const unitContent = generateSystemdUnit({ profile })
    await writeFile(unitPath, unitContent, { mode: 0o600 })

    if (options?.skipLoad === false) {
      await loadDaemonUnit({ platform, unitPath })
    }

    return {
      platform: "linux",
      installed: true,
      unitPath,
      command: "systemctl --user enable --now aibridge.service",
      message: `Installed Linux systemd user service at ${unitPath}`,
    }
  }

  return {
    platform: "unsupported",
    installed: false,
    unitPath: null,
    command: null,
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
 */
export async function loadDaemonUnit(options: {
  platform?: string;
  unitPath?: string | null;
}): Promise<DaemonLoadResult> {
  const platform = options.platform ?? process.platform
  const unitPath = options.unitPath ?? null

  if (platform === "darwin") {
    if (unitPath === null) {
      return { platform, loaded: false, message: "No launchd unit path to load" }
    }
    await execFileAsync("launchctl", ["load", "-w", unitPath])
    return {
      platform,
      loaded: true,
      message: `Loaded launchd daemon at ${unitPath}`,
    }
  }

  if (platform === "linux") {
    // `enable --now` is idempotent; `daemon-reload` is what a freshly written
    // unit needs before the manager will accept a start request for it.
    await execFileAsync("systemctl", ["--user", "daemon-reload"])
    await execFileAsync("systemctl", ["--user", "enable", "--now", "aibridge.service"])
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

/**
 * CLI cutover for `aibr tui`: link and launch the AIBridge Manager Herdr plugin.
 *
 * WHY THIS COMMAND EXISTS (Phase 6, Decision 1):
 * AIBridge has retired the in-repo OpenTUI shell and the legacy native Rust ratatui
 * client. Multi-agent terminal and workspace orchestration is now
 * managed by the `aibr-manager` plugin running inside Herdr.
 *
 * This command ensures Herdr is present and discovers/links the `aibr-manager`
 * plugin, providing clear operator instructions on how to interact with the
 * manager inside Herdr.
 *
 * INVARIANTS:
 * 1. Herdr Absent -> Clear actionable error (never a stack trace, never a silent no-op).
 * 2. Herdr Present -> Discovers and links `aibr-manager`, outputs clear instructions.
 */

import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { CliExitCode } from "../cli.js"
import { checkHerdrStatus } from "../host/preflight.js"
import type { ProcessRunner } from "../host/types.js"

export interface RunTuiOptions {
  readonly profile: string
  readonly runner: ProcessRunner
  readonly writer: (data: string) => void
  readonly env?: Record<string, string | undefined>
  readonly managerPath?: string
}

/**
 * Locate the `aibr-manager` plugin directory.
 */
export function resolveManagerPluginPath(
  customPath?: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (customPath && existsSync(customPath)) {
    return resolve(customPath)
  }

  const envPath = env.AIBRIDGE_MANAGER_PLUGIN_PATH ?? env.AIBR_MANAGER_PATH
  if (envPath && existsSync(envPath)) {
    return resolve(envPath)
  }

  // Check sibling directory `../aibr-manager` relative to cwd
  const cwdSibling = resolve(process.cwd(), "..", "aibr-manager")
  if (existsSync(cwdSibling)) {
    return cwdSibling
  }

  // Check sibling relative to AIBridge repository root
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url))
    const repoRoot = resolve(currentDir, "..", "..")
    const repoSibling = resolve(repoRoot, "..", "aibr-manager")
    if (existsSync(repoSibling)) {
      return repoSibling
    }
  } catch {
    // Ignore resolution errors
  }

  // Well-known default workstation location
  const workstationPath = "/Users/mac/Projects/aibr-manager"
  if (existsSync(workstationPath)) {
    return workstationPath
  }

  return null
}

/**
 * Execute `aibr tui`: verify Herdr presence, link the `aibr-manager` plugin,
 * and display actionable operator instructions.
 */
export async function runTuiCommand(options: RunTuiOptions): Promise<CliExitCode> {
  const env = options.env ?? process.env
  const writer = options.writer
  const runner = options.runner

  // 1. Probe Herdr availability
  const herdrStatus = await checkHerdrStatus(runner)
  if (!herdrStatus.installed) {
    writer(
      [
        "Error: Herdr is not installed or not found on PATH.",
        "",
        "AIBridge requires Herdr for its operator UI (aibr-manager plugin).",
        "To install Herdr:",
        "  - Via Homebrew: brew install herdr",
        "  - From source: git clone https://github.com/nyugennguyen/herdr && cd herdr && cargo build --release",
        "",
        "Ensure the 'herdr' executable is located in your system PATH.",
        "",
      ].join("\n"),
    )
    return 1
  }

  // 2. Discover aibr-manager plugin directory
  const pluginDir = resolveManagerPluginPath(options.managerPath, env)
  if (pluginDir === null) {
    writer(
      [
        "Error: 'aibr-manager' plugin directory not found.",
        "",
        "AIBridge could not locate the 'aibr-manager' plugin repository.",
        "Expected at ../aibr-manager or via AIBR_MANAGER_PATH.",
        "To specify the plugin directory, set:",
        "  export AIBR_MANAGER_PATH=/path/to/aibr-manager",
        "",
      ].join("\n"),
    )
    return 1
  }

  // 3. Link the plugin in Herdr
  const linkResult = await runner.exec(["herdr", "plugin", "link", pluginDir])
  if (linkResult.exitCode !== 0) {
    const errMsg = (linkResult.stderr || linkResult.stdout || "").trim()
    writer(
      [
        `Error: Failed to link 'aibr-manager' plugin in Herdr (exit code ${linkResult.exitCode}):`,
        errMsg ? `  ${errMsg}` : "  (no error output from herdr)",
        "",
      ].join("\n"),
    )
    return 1
  }

  // 4. Output actionable instructions for the operator
  writer(
    [
      `AIBridge Manager plugin linked successfully: ${pluginDir}`,
      "",
      "To open the manager inside Herdr:",
      "  1. Start or focus your Herdr workspace.",
      "  2. Open the command palette (Ctrl+Shift+P or Cmd+Shift+P) and select 'Open AIBridge Manager',",
      "     or invoke the action from CLI:",
      "       herdr plugin action invoke --action aibr-manager.open",
      "",
    ].join("\n"),
  )

  return 0
}

/**
 * `aibr plugin install|uninstall|status claude [--scope user|project|local]
 * [--marketplace bundled|github] [--deny-secrets]`
 *
 * Drives the `claude plugin ...` CLI through an injectable ProcessRunner. It
 * never reads or writes ~/.claude* files itself.
 *
 * Registration in src/cli.ts (done by the coordinator):
 *   aibr plugin <install|uninstall|status> claude [flags]
 *     -> process.exitCode = await runPluginCommand(args)   // args after "plugin"
 */
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BunProcessRunner } from "../host/runtime.js"
import type { ProcessRunner } from "../host/types.js"
import { CLI_VERSION } from "../version.js"

export const PLUGIN_NAME = "aibridge"
export const MARKETPLACE_NAME = "aibridge"
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`
export const GITHUB_MARKETPLACE_SOURCE = "nyugennguyen/AIBridge"

export const EXIT_OK = 0
export const EXIT_FAILURE = 1
export const EXIT_CLAUDE_MISSING = 2
export const EXIT_CLAUDE_TOO_OLD = 3
export const EXIT_USAGE = 64

export interface PluginCommandDeps {
  readonly runner: ProcessRunner
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  /** Root of the installed package (the bundled marketplace directory). */
  readonly packageRoot: string
  readonly version: string
  /** Interactive yes/no; only used by --deny-secrets. Absent means "no". */
  readonly confirm?: (message: string) => Promise<boolean>
}

/** Package root: the first ancestor of this module that has a package.json. */
export function resolvePackageRoot(fromUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(fromUrl))
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(resolve(dir, "package.json"))) return dir
    dir = dirname(dir)
  }
  return resolve(dirname(fileURLToPath(fromUrl)), "../..")
}

export function defaultPluginDeps(): PluginCommandDeps {
  return {
    runner: new BunProcessRunner(),
    stdout: (text) => {
      process.stdout.write(text)
    },
    stderr: (text) => {
      process.stderr.write(text)
    },
    packageRoot: resolvePackageRoot(),
    version: CLI_VERSION,
    confirm: async (message) => {
      if (!process.stdin.isTTY) return false
      const { createInterface } = await import("node:readline/promises")
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        return /^y(es)?$/i.test((await rl.question(`${message} [y/N] `)).trim())
      } finally {
        rl.close()
      }
    },
  }
}

type Scope = "user" | "project" | "local"
type MarketplaceKind = "bundled" | "github"

interface ParsedArgs {
  readonly action: "install" | "uninstall" | "status"
  readonly scope: Scope
  readonly marketplace: MarketplaceKind
  readonly denySecrets: boolean
}

function parseArgs(args: readonly string[]): ParsedArgs | string {
  const [action, target, ...rest] = args
  if (action !== "install" && action !== "uninstall" && action !== "status") {
    return "Usage: aibr plugin <install|uninstall|status> claude [--scope user|project|local] [--marketplace bundled|github] [--deny-secrets]"
  }
  if (target !== "claude") return `Unsupported plugin target "${target ?? ""}". Only "claude" is supported.`
  let scope: Scope = "user"
  let marketplace: MarketplaceKind = "bundled"
  let denySecrets = false
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined]
    const value = () => inline ?? rest[++i]
    if (flag === "--scope" || flag === "-s") {
      const v = value()
      if (v !== "user" && v !== "project" && v !== "local") return `Invalid --scope "${v ?? ""}": use user, project or local.`
      scope = v
    } else if (flag === "--marketplace") {
      const v = value()
      if (v !== "bundled" && v !== "github") return `Invalid --marketplace "${v ?? ""}": use bundled or github.`
      marketplace = v
    } else if (flag === "--deny-secrets") {
      denySecrets = true
    } else {
      return `Unknown option: ${arg}`
    }
  }
  return { action, scope, marketplace, denySecrets }
}

function manualSteps(source: string, scope: Scope): string {
  return [
    "Your Claude Code is too old for the `claude plugin` command. Install the plugin manually from inside Claude Code:",
    `  /plugin marketplace add ${source}`,
    `  /plugin install ${PLUGIN_ID}`,
    `(scope: ${scope}; update Claude Code to automate this)`,
    "",
  ].join("\n")
}

export interface PluginStatus {
  readonly installed: boolean
  readonly version?: string
  readonly scope?: string
  readonly status?: string
}

/** Parse the human `claude plugin list` output for the aibridge entry. */
export function parsePluginList(output: string): PluginStatus {
  const lines = output.split(/\r?\n/)
  const start = lines.findIndex((l) => l.includes(PLUGIN_ID))
  if (start < 0) return { installed: false }
  const block: string[] = [lines[start] as string]
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] as string
    if (line.trim() === "" || line.includes("❯") || /@[\w.-]+\s*$/.test(line.trim())) break
    block.push(line)
  }
  const text = block.join("\n")
  const pick = (label: string) => new RegExp(`${label}:\\s*([^\\n]+)`, "i").exec(text)?.[1]?.trim()
  const version = pick("Version") ?? /@[\w.-]+\s+v?(\d+\.\d+\.\d+[\w.-]*)/.exec(text)?.[1]
  return { installed: true, version, scope: pick("Scope"), status: pick("Status") }
}

export async function runPluginCommand(args: readonly string[], deps: PluginCommandDeps = defaultPluginDeps()): Promise<number> {
  const parsed = parseArgs(args)
  if (typeof parsed === "string") {
    deps.stderr(parsed + "\n")
    return EXIT_USAGE
  }
  const { action, scope, marketplace } = parsed
  const source = marketplace === "bundled" ? deps.packageRoot : `${GITHUB_MARKETPLACE_SOURCE}#v${deps.version}`

  const claudeVersion = await deps.runner.exec(["claude", "--version"], { timeoutMs: 15_000 })
  if (claudeVersion.exitCode !== 0) {
    deps.stderr("Claude Code (`claude`) was not found on PATH. Install it first: https://docs.claude.com/en/docs/claude-code/setup\n")
    return EXIT_CLAUDE_MISSING
  }
  const pluginHelp = await deps.runner.exec(["claude", "plugin", "--help"], { timeoutMs: 15_000 })
  if (pluginHelp.exitCode !== 0 || /unknown command/i.test(pluginHelp.stderr)) {
    deps.stderr(manualSteps(source, scope))
    return EXIT_CLAUDE_TOO_OLD
  }

  if (action === "status") return status(deps)
  if (action === "uninstall") return uninstall(deps, scope)
  return install(deps, scope, source, parsed.denySecrets)
}

function failure(deps: PluginCommandDeps, what: string, result: { stdout: string; stderr: string }): number {
  deps.stderr(`${what} failed:\n${(result.stderr || result.stdout).trim()}\n`)
  return EXIT_FAILURE
}

async function install(deps: PluginCommandDeps, scope: Scope, source: string, denySecrets: boolean): Promise<number> {
  const add = await deps.runner.exec(["claude", "plugin", "marketplace", "add", source, "--scope", scope], { timeoutMs: 120_000 })
  if (add.exitCode === 0) {
    deps.stdout(`Marketplace "${MARKETPLACE_NAME}" added (${scope} scope).\n`)
  } else if (/already/i.test(`${add.stderr}\n${add.stdout}`)) {
    deps.stdout(`Marketplace "${MARKETPLACE_NAME}" already added; refreshing it.\n`)
    const update = await deps.runner.exec(["claude", "plugin", "marketplace", "update", MARKETPLACE_NAME], { timeoutMs: 120_000 })
    if (update.exitCode !== 0) return failure(deps, "claude plugin marketplace update", update)
  } else {
    return failure(deps, "claude plugin marketplace add", add)
  }

  const installed = await deps.runner.exec(["claude", "plugin", "install", PLUGIN_ID, "--scope", scope, "-y"], { timeoutMs: 120_000 })
  if (installed.exitCode === 0) {
    deps.stdout(`Installed ${PLUGIN_ID} (${scope} scope). Restart Claude Code or run /reload-plugins.\n`)
  } else if (/already/i.test(`${installed.stderr}\n${installed.stdout}`)) {
    deps.stdout(`${PLUGIN_ID} is already installed; checking for an update.\n`)
    const update = await deps.runner.exec(["claude", "plugin", "update", PLUGIN_ID, "--scope", scope], { timeoutMs: 120_000 })
    if (update.exitCode !== 0) deps.stdout("No update applied (already current or update unavailable).\n")
  } else {
    return failure(deps, "claude plugin install", installed)
  }

  if (denySecrets) await printDenyRules(deps)
  return EXIT_OK
}

async function uninstall(deps: PluginCommandDeps, scope: Scope): Promise<number> {
  const result = await deps.runner.exec(["claude", "plugin", "uninstall", PLUGIN_ID, "--scope", scope, "-y"], { timeoutMs: 120_000 })
  if (result.exitCode === 0) {
    deps.stdout(`Uninstalled ${PLUGIN_ID} (${scope} scope).\n`)
    return EXIT_OK
  }
  if (/not (installed|found)/i.test(`${result.stderr}\n${result.stdout}`)) {
    deps.stdout(`${PLUGIN_ID} is not installed in ${scope} scope; nothing to do.\n`)
    return EXIT_OK
  }
  return failure(deps, "claude plugin uninstall", result)
}

async function status(deps: PluginCommandDeps): Promise<number> {
  const list = await deps.runner.exec(["claude", "plugin", "list"], { timeoutMs: 30_000 })
  if (list.exitCode !== 0) return failure(deps, "claude plugin list", list)
  const parsed = parsePluginList(list.stdout)
  if (!parsed.installed) {
    deps.stdout(`${PLUGIN_ID}: not installed\n`)
    return EXIT_OK
  }
  deps.stdout(
    `${PLUGIN_ID}: installed` +
      `${parsed.version ? ` version ${parsed.version}` : ""}` +
      `${parsed.scope ? `, scope ${parsed.scope}` : ""}` +
      `${parsed.status ? `, ${parsed.status}` : ""}\n`,
  )
  return EXIT_OK
}

/** Print (never write) deny rules, only after explicit confirmation. */
async function printDenyRules(deps: PluginCommandDeps): Promise<void> {
  const ok = (await deps.confirm?.("Print suggested deny rules that keep Claude's file tools away from AIBridge secrets?")) ?? false
  if (!ok) {
    deps.stdout("Skipped deny rules (not confirmed).\n")
    return
  }
  const rules = {
    permissions: {
      deny: ["Read(~/.local/share/aibridge/**/secrets/**)", "Read(~/.config/aibridge/**/node.key)", "Read(~/.config/aibridge/**/operator*)"],
    },
  }
  deps.stdout(
    "Add this to ~/.claude/settings.json yourself (AIBridge does not edit it). The MCP server reads the bearer token as its own process, so these rules do not break it:\n" +
      JSON.stringify(rules, null, 2) +
      "\n",
  )
}

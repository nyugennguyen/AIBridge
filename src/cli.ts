#!/usr/bin/env bun

/**
 * AIBridge CLI — `aibr`.
 *
 * Zero-dependency argument parser that dispatches to existing host modules
 * (setup, tmux, bridge) via injectable dependencies.
 *
 * Design constraints:
 * - `_opencode` is hidden from `--help` output.
 * - `--profile` is required for `start`, `serve`, `status`, `tui`, `_opencode`;
 *   optional for `setup`.
 * - Help and version output are deterministic (no timestamps, no random).
 * - Error messages never leak internal paths, stack traces, or env values.
 * - `setup` rejects non-TTY environments.
 */

import { validateProfileName } from "./host/paths.js"
import { readSecret } from "./host/profile-store.js"

// ── Types ──────────────────────────────────────────────────────────────

export type CliExitCode = 0 | 1

/**
 * Injectable CLI dependencies.
 *
 * Every side-effect-producing function is a dependency so tests can supply
 * fakes without touching the real filesystem, tmux, or network.
 */
export interface CliDeps {
  /** Write a string to stdout (or a fake writer in tests). */
  readonly writer: (data: string) => void
  /** Whether the current process stdout is a TTY. */
  readonly isTTY: boolean
  /** Whether the current process stdin is a TTY (needed by the full-screen UI). */
  readonly isInputTTY?: boolean
  /** Run interactive setup. Profile is undefined when not passed. */
  readonly runSetup: (profile?: string) => Promise<{
    readonly kind: "persisted" | "blocked" | "declined"
    readonly profileName?: string
    readonly configPath?: string
    readonly reason?: string
    readonly preflight?: unknown
  }>
  /** Start a tmux profile (opencode + bridge windows). */
  readonly startProfile: (profile: string) => Promise<{
    readonly kind: "started" | "already_running" | "tmux_error"
    readonly sessionName: string
    readonly stderr?: string
  }>
  /** Serve the bridge for a given profile. */
  readonly serveBridge: (profile: string, options?: { readonly shadowMode?: boolean }) => Promise<void>
  /**
   * Run the Tier 2 ingress drain loop for a profile until a signal arrives.
   *
   * Resolves on `SIGINT`/`SIGTERM`. Binds no socket: ingress belongs to the
   * router once cut over, and a worker that could accept requests would be a
   * second authority (ADR 0008 §2.2).
   */
  readonly runWorker: (profile: string) => Promise<void>
  /** Query status of a tmux profile. */
  readonly statusProfile: (profile: string) => Promise<{
    readonly kind: "healthy" | "session_missing" | "bridge_unavailable"
    readonly sessionName: string
    readonly body?: string
    readonly probeStatus?: number
  }>
  /** Run `opencode serve` for a given profile. */
  readonly runOpencode: (profile: string) => Promise<void>
  /** Run the separately-composed interactive TUI for a validated profile. */
  readonly runTui?: (profile: string) => Promise<CliExitCode>
  /** Generate diagnostic support bundle. */
  readonly runBundle?: (profile: string, options?: { readonly preview?: boolean }) => Promise<CliExitCode>
  /** Package version string. */
  readonly version: string
}

// ── Constants ──────────────────────────────────────────────────────────

const PROG = "aibr"

const COMMANDS = ["setup", "start", "serve", "worker", "status", "tui", "bundle"] as const
const ALL_COMMANDS = [...COMMANDS, "_opencode"] as const

// ── Argv parsing ───────────────────────────────────────────────────────

interface ParsedArgs {
  readonly command: string | null
  readonly profile: string | null
  readonly unknownFlags: readonly string[]
  readonly hasFlag: (name: string) => boolean
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: string | null = null
  let profile: string | null = null
  const knownFlags: string[] = []
  const unknownFlags: string[] = []

  let i = 0

  while (i < argv.length) {
    const arg = argv[i]!

    if (arg === "--profile" || arg === "-p") {
      i++
      profile = i < argv.length ? argv[i]! : ""
    } else if (arg === "--help" || arg === "-h") {
      knownFlags.push("--help")
    } else if (arg === "--version" || arg === "-v") {
      knownFlags.push("--version")
    } else if (arg === "--shadow-mode") {
      knownFlags.push("--shadow-mode")
    } else if (arg === "--preview") {
      knownFlags.push("--preview")
      unknownFlags.push(arg)
    } else if (command === null) {
      command = arg
    } else {
      unknownFlags.push(arg)
    }

    i++
  }

  return {
    command,
    profile,
    unknownFlags,
    hasFlag: (name: string) => knownFlags.includes(name),
  }
}

// ── Help text ──────────────────────────────────────────────────────────

function helpText(): string {
  return [
    `${PROG} — AIBridge CLI`,
    "",
    "Usage:",
    `  ${PROG} <command> [options]`,
    "",
    "Commands:",
    "  setup    Interactive host setup (profile optional)",
    "  start    Start opencode + bridge in tmux",
    "  serve    Run the bridge server",
    "  worker   Drain the router's admission queue (no listener)",
    "  status   Check tmux session and bridge health",
    "  tui      Open the interactive local UI",
    "  bundle   Generate diagnostic support bundle",
    "",
    "Options:",
    "  --profile, -p <name>   Profile name (required for start/serve/worker/status/tui)",
    "  --help, -h             Show this help",
    "  --version, -v          Show version",
    "  --shadow-mode          Run in shadow mode (mirroring ingress to router)",
    "",
  ].join("\n")
}

// ── Profile validation ─────────────────────────────────────────────────

/**
 * Validate a profile name argument.
 *
 * Returns `null` on success, or a user-facing error string on failure.
 * Error strings NEVER echo the raw input (prevents leaking traversal chars).
 */
function validateProfileArg(value: string | null): string | null {
  if (value === null || value.length === 0) {
    return "--profile is required"
  }

  try {
    validateProfileName(value)
    return null
  } catch {
    return "Invalid profile name (use alphanumeric and hyphens, 1-64 chars)"
  }
}

// ── Main entry ─────────────────────────────────────────────────────────

/**
 * Run the CLI with the given argv and dependencies.
 *
 * @returns 0 on success, 1 on any error.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<CliExitCode> {
  const args = parseArgs(argv)

  // ── Global flags (synchronous, no deps needed) ─────────────────────
  if (args.hasFlag("--help")) {
    deps.writer(helpText())
    return 0
  }

  if (args.hasFlag("--version")) {
    deps.writer(`${deps.version}\n`)
    return 0
  }

  // ── Unknown flags ──────────────────────────────────────────────────
  if (args.unknownFlags.length > 0) {
    deps.writer(`Error: unknown flag ${args.unknownFlags[0]}\n`)
    return 1
  }

  // ── No command ─────────────────────────────────────────────────────
  if (args.command === null) {
    deps.writer(helpText())
    return 1
  }

  // ── Unknown command ────────────────────────────────────────────────
  if (!(ALL_COMMANDS as readonly string[]).includes(args.command)) {
    deps.writer(`Error: unknown command "${args.command}"\n`)
    return 1
  }

  const command = args.command

  // ── setup ──────────────────────────────────────────────────────────
  if (command === "setup") {
    if (!deps.isTTY) {
      deps.writer("Error: setup requires an interactive TTY\n")
      return 1
    }
    try {
      const outcome = await deps.runSetup(args.profile ?? undefined)
      switch (outcome.kind) {
        case "persisted":
          deps.writer(`Profile "${outcome.profileName}" created. Config: ${outcome.configPath}\n`)
          return 0
        case "blocked":
          deps.writer(`Setup blocked: ${outcome.reason ?? "unknown reason"}\n`)
          return 1
        case "declined":
          deps.writer("Setup declined.\n")
          return 1
      }
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "setup failed"}\n`)
      return 1
    }
  }

  // ── Commands that require --profile ────────────────────────────────
  const profileErr = validateProfileArg(args.profile)
  if (profileErr !== null) {
    deps.writer(`Error: ${profileErr}\n`)
    return 1
  }

  const profile = args.profile!

  // ── tui ────────────────────────────────────────────────────────────
  if (command === "tui") {
    if (!deps.isTTY || deps.isInputTTY === false) {
      deps.writer("Error: tui requires interactive stdin and stdout TTYs\n")
      return 1
    }
    if (deps.runTui === undefined) {
      deps.writer("Error: TUI application service is unavailable\n")
      return 1
    }
    try {
      return await deps.runTui(profile)
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "tui failed"}\n`)
      return 1
    }
  }

  // ── start ──────────────────────────────────────────────────────────
  if (command === "start") {
    try {
      const result = await deps.startProfile(profile)
      switch (result.kind) {
        case "started":
          deps.writer(`Started tmux session: ${result.sessionName}\n`)
          return 0
        case "already_running":
          deps.writer(`Already running: ${result.sessionName}\n`)
          return 0
        case "tmux_error":
          deps.writer(`tmux_error: ${result.stderr ?? "unknown error"}\n`)
          return 1
      }
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "start failed"}\n`)
      return 1
    }
  }

  // ── serve ──────────────────────────────────────────────────────────
  if (command === "serve") {
    try {
      await deps.serveBridge(profile, { shadowMode: args.hasFlag("--shadow-mode") })
      return 0
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "serve failed"}\n`)
      return 1
    }
  }

  // ── worker ─────────────────────────────────────────────────────────
  if (command === "worker") {
    try {
      await deps.runWorker(profile)
      return 0
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "worker failed"}\n`)
      return 1
    }
  }

  // ── status ─────────────────────────────────────────────────────────
  if (command === "status") {
    try {
      const result = await deps.statusProfile(profile)
      switch (result.kind) {
        case "healthy":
          deps.writer(`healthy: ${result.sessionName}\n${result.body ?? ""}\n`)
          return 0
        case "session_missing":
          deps.writer(`session_missing: ${result.sessionName}\n`)
          return 1
        case "bridge_unavailable":
          deps.writer(`bridge_unavailable: ${result.sessionName} (status ${result.probeStatus ?? "?"})\n`)
          return 1
      }
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "status failed"}\n`)
      return 1
    }
  }

  // ── bundle ─────────────────────────────────────────────────────────
  if (command === "bundle") {
    if (deps.runBundle) {
      try {
        return await deps.runBundle(profile, { preview: args.hasFlag("--preview") })
      } catch (err) {
        deps.writer(`Error: ${err instanceof Error ? err.message : "bundle failed"}\n`)
        return 1
      }
    }
    try {
      const { generateSupportBundle, previewSupportBundle } = await import("./diagnostics/bundle.js")
      const { resolveProfilePaths } = await import("./host/paths.js")
      const paths = resolveProfilePaths(profile)
      const configPath = `${paths.configDir}/config.json`
      const stateDir = paths.stateDir
      const bundle = generateSupportBundle({
        profile,
        configPath,
        stateDir,
      })
      if (args.hasFlag("--preview")) {
        deps.writer(previewSupportBundle(bundle) + "\n")
      } else {
        deps.writer(JSON.stringify(bundle, null, 2) + "\n")
      }
      return 0
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "bundle failed"}\n`)
      return 1
    }
  }

  // ── _opencode (hidden) ─────────────────────────────────────────────
  if (command === "_opencode") {
    try {
      await deps.runOpencode(profile)
      return 0
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "opencode failed"}\n`)
      return 1
    }
  }

  // Unreachable
  return 1
}

async function createRealDeps(): Promise<CliDeps> {
  const { resolve } = await import("node:path")
  const { startBridge } = await import("./bridge.js")
  const { startProfile, statusProfile } = await import("./host/tmux.js")
  const { runSetup } = await import("./host/setup.js")
  const { BunProcessRunner, BunPlatformInspector, BunPrompter, createStreamLineReader } = await import("./host/runtime.js")
  const { ensureProfileDirs, readConfig, writeConfig, writeSecret } = await import("./host/profile-store.js")
  const { resolveProfilePaths } = await import("./host/paths.js")
  const { readFile } = await import("node:fs/promises")

  const processRunner = new BunProcessRunner()
  const platformInspector = new BunPlatformInspector()

  return {
    writer: (s: string) => process.stdout.write(s),
    isTTY: Boolean(process.stdout?.isTTY),
    isInputTTY: Boolean(process.stdin?.isTTY),
    runTui: async (profile: string) => {
      const { runLocalTui } = await import("./tui/bootstrap.js")
      return runLocalTui(profile)
    },

    runSetup: async (profile?: string) => {
      const reader = createStreamLineReader(Bun.stdin.stream())
      const prompter = new BunPrompter({
        reader,
        writer: { write: (d: Uint8Array) => { void process.stdout.write(d) } },
        isTTY: Boolean(process.stdin?.isTTY),
      })

      return runSetup({
        platformInspector,
        processRunner,
        prompter,
        env: process.env as Record<string, string | undefined>,
        fileOps: {
          writeConfig: async (path, data) => writeConfig(path, data),
          writeSecret: async (path, value) => writeSecret(path, value),
          ensureProfileDirs: async (paths) => ensureProfileDirs(paths),
          readConfig: async (path) => readConfig(path),
        },
      })
    },

    startProfile: async (profile: string) => {
      const paths = resolveProfilePaths(profile)
      const configPath = `${paths.configDir}/config.json`
      let config: Record<string, unknown>
      try {
        config = await readConfig(configPath) as Record<string, unknown>
      } catch {
        throw new Error(`Profile "${profile}" not found. Run "aibr setup --profile ${profile}" first.`)
      }
      const bridge = config.bridge as Record<string, unknown>
      const opencode = config.opencode as Record<string, unknown>
      return startProfile(
        { processRunner, httpProbe: { probe: async () => ({ status: 0, ok: false, body: "" }) }, env: process.env as Record<string, string | undefined> },
        {
          name: profile,
          bridgePort: bridge.port as number,
          opencodePort: opencode.server_port as number,
          sessionName: `aibridge-${profile}`,
        },
      )
    },

    serveBridge: async (profile: string, serveOptions?: { readonly shadowMode?: boolean }) => {
      const paths = resolveProfilePaths(profile)
      const configPath = `${paths.configDir}/config.json`
      const bridge = await startBridge({
        configPath,
        stateDir: paths.stateDir,
        bearerToken: await readSecret(`${paths.secretsDir}/bearer_token`),
        environment: process.env as Record<string, string>,
        shadowMode: serveOptions?.shadowMode,
      })
      await bridge.app.listen({ host: bridge.config.bridge.host, port: bridge.config.bridge.port })
    },

    runWorker: async (profile: string) => {
      const { startIngressWorker } = await import("./ingress/worker.js")
      const paths = resolveProfilePaths(profile)
      const worker = await startIngressWorker({
        configPath: `${paths.configDir}/config.json`,
        stateDir: paths.stateDir,
        bearerToken: await readSecret(`${paths.secretsDir}/bearer_token`),
        environment: process.env as Record<string, string>,
      })

      // `Restart=always` sends SIGTERM; a drain loop that ignored it would be
      // killed mid-claim on every deploy, and the row would sit in 'sending'
      // until `recoverStale` noticed the lease had expired.
      await new Promise<void>((resolve) => {
        const onSignal = (): void => {
          worker.stop()
          resolve()
        }
        process.once("SIGINT", onSignal)
        process.once("SIGTERM", onSignal)
      })
    },

    statusProfile: async (profile: string) => {
      const paths = resolveProfilePaths(profile)
      const configPath = `${paths.configDir}/config.json`
      let config: Record<string, unknown>
      try {
        config = await readConfig(configPath) as Record<string, unknown>
      } catch {
        throw new Error(`Profile "${profile}" not found. Run "aibr setup --profile ${profile}" first.`)
      }
      const bridge = config.bridge as Record<string, unknown>
      const opencode = config.opencode as Record<string, unknown>
      return statusProfile(
        { processRunner, httpProbe: { probe: async (url: string) => {
          try {
            const resp = await fetch(url)
            const body = await resp.text()
            return { status: resp.status, ok: resp.ok, body }
          } catch {
            return { status: 0, ok: false, body: "" }
          }
        }}, env: process.env as Record<string, string | undefined> },
        {
          name: profile,
          bridgePort: bridge.port as number,
          opencodePort: opencode.server_port as number,
          sessionName: `aibridge-${profile}`,
        },
      )
    },

    runOpencode: async (_profile: string) => {
      const opencodePort = process.env.OPENCODE_PORT ?? "4096"
      const result = await processRunner.exec(
        ["opencode", "serve", "--port", opencodePort, "--hostname", "127.0.0.1"],
        { env: process.env as Record<string, string> },
      )
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || "opencode serve failed")
      }
    },

    version: "1.0.1",
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/cli.js") ||
  process.argv[1]?.endsWith("/cli.ts")

if (isMain) {
  const deps = await createRealDeps()
  const exitCode = await runCli(process.argv.slice(2), deps)
  process.exit(exitCode)
}

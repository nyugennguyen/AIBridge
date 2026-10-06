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
   *
   * `publishIpc` adds ONE socket, for local clients only, and it is opt-in. That
   * socket is the local bus and not ingress: its listener cannot admit a trigger,
   * and it lives in a `0700` user-scoped directory for the same reason the Rust
   * listener's does.
   */
  readonly runWorker: (profile: string, options?: { readonly publishIpc?: boolean }) => Promise<void>
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
  /** Validate dependencies, SSL token, and config format for a profile. */
  readonly verifyProfile?: (profile: string) => Promise<{
    readonly ok: boolean
    readonly summary: string
  }>
  /** Check and update AIBridge to the latest version. */
  readonly runUpdate?: (options?: { readonly checkOnly?: boolean; readonly yes?: boolean }) => Promise<{
    readonly ok: boolean
    readonly message: string
  }>
  /** Package version string. */
  readonly version: string
}

// ── Constants ──────────────────────────────────────────────────────────

const PROG = "aibr"

const COMMANDS = ["setup", "start", "serve", "worker", "status", "verify", "update", "tui", "bundle"] as const
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
    } else if (arg === "--ipc-publish") {
      knownFlags.push("--ipc-publish")
    } else if (arg === "--preview") {
      knownFlags.push("--preview")
      unknownFlags.push(arg)
    } else if (arg === "--yes" || arg === "-y") {
      knownFlags.push("--yes")
    } else if (arg === "--check" || arg === "-c") {
      knownFlags.push("--check")
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
    "  verify   Validate dependencies, SSL token, and config format",
    "  update   Check and update to the latest version",
    "  tui      Open the interactive local UI",
    "  bundle   Generate diagnostic support bundle",
    "",
    "Options:",
    "  --profile, -p <name>   Profile name (required for start/serve/worker/status/tui)",
    "  --check, -c            Check for updates without installing (for update)",
    "  --yes, -y              Automatic yes to prompts (for update)",
    "  --help, -h             Show this help",
    "  --version, -v          Show version",
    "  --shadow-mode          Run in shadow mode (mirroring ingress to router)",
    "  --ipc-publish          Serve the local IPC bus for the TUI (worker only)",
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

  // ── verify ─────────────────────────────────────────────────────────
  if (command === "verify") {
    let profile = "default"
    if (args.profile !== null) {
      const err = validateProfileArg(args.profile)
      if (err !== null) {
        deps.writer(`Error: ${err}\n`)
        return 1
      }
      profile = args.profile
    }

    try {
      if (deps.verifyProfile) {
        const result = await deps.verifyProfile(profile)
        deps.writer(result.summary + "\n")
        return result.ok ? 0 : 1
      }
      const { runVerify } = await import("./cli/verify.js")
      const result = await runVerify(profile)
      deps.writer(result.summary + "\n")
      return result.ok ? 0 : 1
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "verify failed"}\n`)
      return 1
    }
  }

  // ── update ─────────────────────────────────────────────────────────
  if (command === "update") {
    const checkOnly = args.hasFlag("--check")
    const yes = args.hasFlag("--yes")

    try {
      if (deps.runUpdate) {
        const result = await deps.runUpdate({ checkOnly, yes })
        deps.writer(result.message + "\n")
        return result.ok ? 0 : 1
      }
      const { runUpdate } = await import("./cli/update.js")
      const result = await runUpdate(
        { checkOnly, yes },
        { currentVersion: deps.version, isTTY: deps.isTTY },
      )
      deps.writer(result.message + "\n")
      return result.ok ? 0 : 1
    } catch (err) {
      deps.writer(`Error: ${err instanceof Error ? err.message : "update failed"}\n`)
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
      await deps.runWorker(profile, { publishIpc: args.hasFlag("--ipc-publish") })
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
  const writer = (s: string): void => {
    process.stdout.write(s)
  }

  return {
    writer,
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

      const { runSetupWizard } = await import("./cli/setup-wizard.js")
      return runSetupWizard({
        platformInspector,
        processRunner,
        prompter,
        initialProfile: profile,
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
      let config: Record<string, unknown> | null = null
      try {
        config = await readConfig(configPath) as Record<string, unknown> | null
      } catch {
        // unreadable
      }
      if (!config) {
        throw new Error(`Profile "${profile}" not found. Run "aibr setup --profile ${profile}" first.`)
      }
      const bridge = config.bridge as Record<string, unknown>
      const opencode = config.opencode as Record<string, unknown>
      let ocPassword = process.env.OPENCODE_SERVER_PASSWORD
      if (!ocPassword) {
        try {
          ocPassword = await readSecret(`${paths.secretsDir}/opencode_password`)
        } catch {
          // unreadable or missing
        }
      }
      const env = {
        ...process.env,
        ...(ocPassword ? { OPENCODE_SERVER_PASSWORD: ocPassword } : {}),
      }
      return startProfile(
        { processRunner, httpProbe: { probe: async () => ({ status: 0, ok: false, body: "" }) }, env },
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
      let ocPassword = process.env.OPENCODE_SERVER_PASSWORD
      if (!ocPassword) {
        try {
          ocPassword = await readSecret(`${paths.secretsDir}/opencode_password`)
        } catch {
          // unreadable or missing
        }
      }
      const bridge = await startBridge({
        configPath,
        stateDir: paths.stateDir,
        bearerToken: await readSecret(`${paths.secretsDir}/bearer_token`),
        environment: {
          ...process.env as Record<string, string>,
          ...(ocPassword ? { OPENCODE_SERVER_PASSWORD: ocPassword } : {}),
        },
        shadowMode: serveOptions?.shadowMode,
      })
      await bridge.app.listen({ host: bridge.config.bridge.host, port: bridge.config.bridge.port })
      await new Promise<void>((resolve) => {
        const onSignal = (): void => {
          void bridge.app.close().then(() => resolve(), () => resolve())
        }
        process.once("SIGINT", onSignal)
        process.once("SIGTERM", onSignal)
      })
    },

    runWorker: async (profile: string, workerOptions?: { readonly publishIpc?: boolean }) => {
      const { startIngressWorker } = await import("./ingress/worker.js")
      const paths = resolveProfilePaths(profile)
      const bearerToken = await readSecret(`${paths.secretsDir}/bearer_token`)
      const publishIpc = workerOptions?.publishIpc === true

      // Created before the worker and attached after, because the drainer needs its
      // observer at construction and the publisher needs the drainer to exist. See
      // `QueueBridge`'s header in src/ipc/bridge.ts.
      const { QueueBridge, startIpcBus } = await import("./ipc/bridge.js")
      const bridge = new QueueBridge()

      const worker = await startIngressWorker({
        configPath: `${paths.configDir}/config.json`,
        stateDir: paths.stateDir,
        bearerToken,
        environment: process.env as Record<string, string>,
        // Supplied here rather than inside `startIngressWorker` so that module keeps
        // no dependency on the IPC surface, and so this flag is the single place
        // that decides whether a socket exists at all.
        ingressObserver: publishIpc ? bridge : undefined,
      })

      let bus: Awaited<ReturnType<typeof startIpcBus>> | undefined
      if (publishIpc) {
        bus = await startIpcBus({
          config: worker.config,
          jobManager: worker.jobManager,
          bridge,
          // Read through the drainer's own connection, as a `COUNT` against the
          // table rather than a maintained counter: a counter and the table disagree
          // the moment a drainer is killed mid-cycle, and the number a client is
          // shown must not be the optimistic one.
          outboxPendingCount: () => worker.pendingIngressCount(),
          // The node's own bearer token, so a token an agent echoed into a job detail
          // is scrubbed on the way to a client rather than merely on the way to a log.
          customSecrets: [bearerToken],
        })
      }

      // Announced rather than silent: a socket that appears without a word about it
      // is a socket an operator cannot account for, and this one is reachable by
      // anything running as this user.
      writer(`IPC bus: ${bus === undefined ? "off" : `serving on ${bus.publisher.socketPath}`}\n`)

      // `Restart=always` sends SIGTERM; a drain loop that ignored it would be killed
      // mid-claim on every deploy, and the row would sit in 'sending' until
      // `recoverStale` noticed the lease had expired.
      await new Promise<void>((resolve) => {
        const onSignal = (): void => {
          worker.stop()
          // Closing the LISTENER is the whole shutdown path: it closes client
          // connections and nothing else. No pane is signalled and no job is
          // cancelled, which is the same rule `ControlCommand::detach` follows for
          // one client -- a socket dying is never a signal.
          if (bus === undefined) {
            resolve()
            return
          }
          void bus.stop().then(() => resolve(), () => resolve())
        }
        process.once("SIGINT", onSignal)
        process.once("SIGTERM", onSignal)
      })
    },

    statusProfile: async (profile: string) => {
      const paths = resolveProfilePaths(profile)
      const configPath = `${paths.configDir}/config.json`
      let config: Record<string, unknown> | null = null
      try {
        config = await readConfig(configPath) as Record<string, unknown> | null
      } catch {
        // unreadable
      }
      if (!config) {
        throw new Error(`Profile "${profile}" not found. Run "aibr setup --profile ${profile}" first.`)
      }
      const bridge = config.bridge as Record<string, unknown>
      const opencode = config.opencode as Record<string, unknown>
      const res = await statusProfile(
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
      if (res.kind === "healthy") {
        const summary = [
          "Configuration summary:",
          `  Agent ID: ${config.agent_id}`,
          `  Bridge: ${bridge.public_url ?? `http://${bridge.host}:${bridge.port}`}`,
          `  OpenCode: ${opencode.base_url}`,
          "Readiness state: healthy",
          res.body ? `Probe response: ${res.body}` : "",
        ].filter(Boolean).join("\n")
        return {
          ...res,
          body: summary,
        }
      }
      return res
    },
    verifyProfile: async (profile: string) => {
      const { runVerify } = await import("./cli/verify.js")
      const result = await runVerify(profile, {
        processRunner,
        platformInspector,
        env: process.env as Record<string, string | undefined>,
      })
      return {
        ok: result.ok,
        summary: result.summary,
      }
    },
    runUpdate: async (options) => {
      const { runUpdate } = await import("./cli/update.js")
      const { BunPrompter, createStreamLineReader } = await import("./host/runtime.js")
      const reader = createStreamLineReader(Bun.stdin.stream())
      const prompter = new BunPrompter({
        reader,
        writer: { write: (d: Uint8Array) => { void process.stdout.write(d) } },
        isTTY: Boolean(process.stdin?.isTTY),
      })
      const result = await runUpdate(options, {
        currentVersion: "2.0.0",
        processRunner,
        prompter,
        isTTY: Boolean(process.stdout?.isTTY),
      })
      return {
        ok: result.ok,
        message: result.message,
      }
    },

    runOpencode: async (profile: string) => {
      const paths = resolveProfilePaths(profile)
      let ocPassword = process.env.OPENCODE_SERVER_PASSWORD
      if (!ocPassword) {
        try {
          ocPassword = await readSecret(`${paths.secretsDir}/opencode_password`)
        } catch {
          // unreadable or missing
        }
      }
      const opencodePort = process.env.OPENCODE_PORT ?? "4096"
      const result = await processRunner.exec(
        ["opencode", "serve", "--port", opencodePort, "--hostname", "127.0.0.1"],
        {
          env: {
            ...process.env as Record<string, string>,
            ...(ocPassword ? { OPENCODE_SERVER_PASSWORD: ocPassword } : {}),
          },
        },
      )
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || "opencode serve failed")
      }
    },

    version: "2.0.0",
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

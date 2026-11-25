/**
 * `aibr init` — the quickstart: at most four questions, then a running node.
 *
 *   1. role        worker / orchestrator / both                    (--role)
 *   2. runtime     opencode / claude, asked only when both or
 *                  neither is installed                            (--runtime)
 *   3. project     default: the git root of this directory;
 *                  $HOME, / and ancestors of $HOME are refused     (--project)
 *   4. network     Enter = new network (this machine prints a
 *                  pairing code), or paste a code to join one      (--new / --join <code>)
 *
 * Everything else takes a safe default without asking: the bearer token and
 * OpenCode password are generated and never shown, the agent id is the
 * profile name (or this machine's name for the "default" profile), ports are
 * 8787/4096, new profiles require signed requests. Questions 1–3 are the
 * setup wizard's own (src/cli/setup-wizard.ts, quickstart mode); question 4
 * runs the `aibr enroll` code paths (src/cli/enroll.ts). A worker's bridge is
 * then started as the user service (`aibr start`), unless --no-start.
 *
 * `aibr setup --advanced` remains the full wizard. Re-running `aibr init` on an
 * existing profile asks nothing about it again; it only (re)starts the bridge
 * and offers the network step.
 */
import type { Prompter } from "../host/types.js"
import type { NodeRole, RuntimeKind } from "../host/node-role.js"
import { parseNodeRole, parseRuntimeKind } from "../host/node-role.js"
import type { SetupOutcome } from "../host/setup.js"
import type { QuickstartAnswers } from "./setup-wizard.js"

export const INIT_HELP = [
  "aibr init — set up this machine in at most four questions",
  "",
  "Usage:",
  "  aibr init [--profile <name>] [--role worker|orchestrator|both] [--runtime opencode|claude]",
  "            [--project <dir>] [--new | --join <code>] [--capabilities a,b] [--port <n>] [--no-start]",
  "",
  "Asks: the node role; the runtime (only when both or neither of opencode and",
  "claude is installed); the project directory (default: this directory's git",
  "root; your home directory is refused); and whether to create a new network",
  "(this machine prints a one-time pairing code) or join one (paste the code).",
  "Each flag answers its question. Secrets are generated and never shown. A",
  "worker's bridge is started as a user service (aibr start) unless --no-start.",
  "--capabilities: what the printed code grants (default: the worker's",
  "capabilities that need no operator approval). Use \"aibr setup --advanced\"",
  "for every option. Then run: aibr doctor",
  "",
].join("\n")

export interface InitCliDeps {
  readonly write: (text: string) => void
  readonly env: Readonly<Record<string, string | undefined>>
  /** stdin and stdout are a terminal: questions may be asked. */
  readonly interactive: boolean
  /** Asks one question (one line). Only called when `interactive`. */
  readonly prompter: Prompter
  readonly readConfig: (profile: string) => Promise<Record<string, unknown> | null>
  readonly runSetup: (profile: string, options: { readonly quickstart: QuickstartAnswers; readonly prompter: Prompter }) => Promise<SetupOutcome>
  readonly join: (profile: string, code: string, options: { readonly adoptBearerToken: boolean }) => Promise<{ readonly lines: readonly string[]; readonly peerId: string }>
  readonly issue: (profile: string, capabilities: readonly string[] | undefined) => Promise<{ readonly code: string; readonly capabilities: readonly string[]; readonly minutes: number }>
  /** `aibr start --profile <p>` (service); writes its own output, returns its exit code. */
  readonly start: (profile: string) => Promise<number>
}

interface InitArgs {
  readonly profile?: string
  readonly role?: NodeRole
  readonly runtime?: RuntimeKind
  readonly project?: string
  readonly port?: number
  readonly join?: string
  readonly newNetwork: boolean
  readonly noStart: boolean
  readonly capabilities?: readonly string[]
  readonly help: boolean
}

export function parseInitArgs(argv: readonly string[]): InitArgs | string {
  const out: { -readonly [K in keyof InitArgs]?: InitArgs[K] } = { newNetwork: false, noStart: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1
    const name = eq > 0 ? arg.slice(0, eq) : arg
    const value = (): string | undefined => (eq > 0 ? arg.slice(eq + 1) : argv[++i])
    switch (name) {
      case "--profile":
      case "-p": {
        const v = value()
        if (v === undefined || v === "") return `${name} needs a value`
        out.profile = v
        break
      }
      case "--role": {
        const role = parseNodeRole(value())
        if (role === null) return "--role must be worker, orchestrator or both"
        out.role = role
        break
      }
      case "--runtime": {
        const runtime = parseRuntimeKind(value())
        if (runtime === null) return "--runtime must be opencode or claude"
        out.runtime = runtime
        break
      }
      case "--project": {
        const v = value()
        if (v === undefined || v === "") return "--project needs a directory"
        out.project = v
        break
      }
      case "--port": {
        const v = Number(value())
        if (!Number.isInteger(v) || v < 1 || v > 65535) return "--port needs a port number"
        out.port = v
        break
      }
      case "--join": {
        const v = value()
        if (v === undefined || v.trim() === "") return "--join needs a pairing code"
        out.join = v.trim()
        break
      }
      case "--capabilities": {
        const v = value()
        const list = (v ?? "").split(",").map((c) => c.trim()).filter((c) => c !== "")
        if (list.length === 0) return "--capabilities needs a comma-separated list"
        out.capabilities = list
        break
      }
      case "--new":
        out.newNetwork = true
        break
      case "--no-start":
        out.noStart = true
        break
      case "--help":
      case "-h":
        out.help = true
        break
      default:
        return `unknown argument ${arg}`
    }
  }
  if (out.newNetwork === true && out.join !== undefined) return "--new and --join are exclusive"
  return out as InitArgs
}

/** A prompter for a non-interactive run: any question it would ask is an error naming the flag. */
export function nonInteractivePrompter(): Prompter {
  const refuse = (message: string): never => {
    throw new Error(`no terminal to ask "${message.slice(0, 80)}"; pass the answer as a flag (aibr init --help)`)
  }
  return {
    prompt: async (o) => refuse(o.message),
    promptInput: async (m) => refuse(m),
    promptSecret: async (m) => refuse(m),
    promptConfirm: async (m) => refuse(m),
    promptSelect: async (m) => refuse(m),
  }
}

function roleOf(config: Record<string, unknown>): NodeRole {
  return parseNodeRole(config.role) ?? "worker"
}

/** What the code `init` prints grants by default: capabilities that need no operator approval. */
export function defaultGrant(config: Record<string, unknown>): readonly string[] | undefined {
  const profiles = config.capability_profiles
  if (profiles !== null && typeof profiles === "object") {
    const names = Object.entries(profiles as Record<string, { requires_approval?: unknown }>)
      .filter(([, profile]) => profile?.requires_approval !== true)
      .map(([name]) => name)
    if (names.length > 0) return names
  }
  const projects = Array.isArray(config.projects) ? (config.projects as { capabilities?: unknown }[]) : []
  const caps = Array.isArray(projects[0]?.capabilities) ? (projects[0]!.capabilities as unknown[]).filter((c): c is string => typeof c === "string") : []
  return caps.length > 0 ? caps : undefined
}

function blockedFix(outcome: Extract<SetupOutcome, { kind: "blocked" }>): string[] {
  const lines: string[] = []
  for (const check of outcome.preflight.checks ?? []) {
    if (check.status !== "installed" && check.installCmd !== null) lines.push(`  ${check.installCmd.join(" ")}`)
  }
  if (/Tailscale/i.test(outcome.reason)) lines.push("  tailscale up   (sign this machine in to your tailnet)")
  return lines
}

export async function runInitCommand(argv: readonly string[], deps: InitCliDeps): Promise<number> {
  const args = parseInitArgs(argv)
  if (typeof args === "string") {
    deps.write(`Error: ${args}\n`)
    return 64
  }
  if (args.help) {
    deps.write(INIT_HELP)
    return 0
  }
  const profile = args.profile ?? (deps.env.AIBR_PROFILE || "default")
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(profile) || profile.length > 64) {
    deps.write("Error: Invalid profile name (use alphanumeric and hyphens, 1-64 chars)\n")
    return 64
  }
  const prompter = deps.interactive ? deps.prompter : nonInteractivePrompter()
  let failed = false

  // ── questions 1–3: the wizard in quickstart mode ──────────────────────
  let config = await deps.readConfig(profile)
  const createdNow = config === null
  if (config !== null) {
    deps.write(
      `Profile "${profile}" already exists (${roleOf(config)}, agent ${String(config.agent_id)}); its answers are kept. ` +
        `Change them with: aibr setup --profile ${profile}\n`,
    )
  } else {
    let outcome: SetupOutcome
    try {
      outcome = await deps.runSetup(profile, {
        prompter,
        quickstart: {
          ...(args.role !== undefined ? { role: args.role } : {}),
          ...(args.runtime !== undefined ? { runtime: args.runtime } : {}),
          ...(args.project !== undefined ? { projectPath: args.project } : {}),
          ...(args.port !== undefined ? { bridgePort: args.port } : {}),
        },
      })
    } catch (error) {
      deps.write(`Error: ${error instanceof Error ? error.message : "setup failed"}\n`)
      return 1
    }
    if (outcome.kind === "blocked") {
      const fixes = blockedFix(outcome)
      deps.write(`Cannot set up this machine yet: ${outcome.reason}\n${fixes.length > 0 ? `Fix:\n${fixes.join("\n")}\n` : ""}Then run aibr init again.\n`)
      return 1
    }
    if (outcome.kind === "declined") {
      deps.write("Nothing was saved.\n")
      return 1
    }
    deps.write(`Profile "${profile}" created (${outcome.role ?? "worker"}${outcome.runtime ? `, ${outcome.runtime} runtime` : ""}). Config: ${outcome.configPath}\n`)
    config = await deps.readConfig(profile)
    if (config === null) {
      deps.write("Error: the profile was saved but cannot be read back.\n")
      return 1
    }
  }
  const role = roleOf(config)
  const runsBridge = role !== "orchestrator"

  // ── question 4: network ───────────────────────────────────────────────
  let code = args.join
  let newNetwork = args.newNetwork
  if (code === undefined && !newNetwork) {
    if (!deps.interactive) {
      // Nothing to ask with: a re-run or a scripted worker just starts.
      newNetwork = false
    } else if (role === "orchestrator") {
      const answer = (await prompter.promptInput(
        "Pairing code from the worker (printed by \"aibr init\" or \"aibr enroll issue\" there; Enter to pair later):",
      )).trim()
      if (answer !== "") code = answer
    } else {
      const answer = (await prompter.promptInput(
        "Network — press Enter to create a new one (this machine prints a pairing code for the next), " +
          "or paste a pairing code from a machine already set up to join it:",
      )).trim()
      if (answer === "") newNetwork = true
      else code = answer
    }
  }

  let peerId: string | null = null
  if (code !== undefined) {
    try {
      const joined = await deps.join(profile, code, { adoptBearerToken: createdNow && runsBridge })
      peerId = joined.peerId
      for (const line of joined.lines) deps.write(`${line}\n`)
    } catch (error) {
      failed = true
      deps.write(
        `Pairing failed: ${error instanceof Error ? error.message : String(error)}\n` +
          `Try again with a fresh code: aibr enroll join <code> --profile ${profile}\n`,
      )
    }
  }

  // ── start the bridge (workers) ────────────────────────────────────────
  let started = false
  if (runsBridge) {
    if (args.noStart) {
      deps.write(`Not started (--no-start). Start the bridge with: aibr start --profile ${profile}\n`)
    } else {
      const exitCode = await deps.start(profile)
      started = exitCode === 0
      if (!started) failed = true
    }
  }

  // ── new network: a code for the next machine ──────────────────────────
  if (newNetwork) {
    if (!runsBridge) {
      deps.write("An orchestrator joins a worker's network: run aibr init on the worker first, then paste its code here (aibr enroll join <code>).\n")
    } else {
      try {
        const issued = await deps.issue(profile, args.capabilities ?? defaultGrant(config))
        deps.write(
          [
            "",
            `Pairing code (one use, valid ${issued.minutes} min, grants ${issued.capabilities.join(", ")}):`,
            "",
            `  ${issued.code}`,
            "",
            "On the other machine run \"aibr init\" and paste it when asked, or:",
            `  aibr enroll join ${issued.code}`,
            ...(started ? [] : [`This machine's bridge must be running when they do: aibr start --profile ${profile}`]),
            "",
          ].join("\n"),
        )
      } catch (error) {
        failed = true
        deps.write(`Could not issue a pairing code: ${error instanceof Error ? error.message : String(error)}\nIssue one later with: aibr enroll issue --profile ${profile}\n`)
      }
    }
  }

  // ── next steps ────────────────────────────────────────────────────────
  const next = ["", "Next:", `  aibr doctor --profile ${profile}        # checks everything, with the fix for each problem`]
  if (peerId !== null) {
    next.push(`  aibr ping ${peerId} --profile ${profile}`)
    next.push(`  aibr send ${peerId} "summarise the last commit" --profile ${profile}`)
  }
  if (role !== "worker") next.push("  aibr plugin install claude      # lets Claude Code dispatch to your workers")
  deps.write(`${next.join("\n")}\n`)
  return failed ? 1 : 0
}

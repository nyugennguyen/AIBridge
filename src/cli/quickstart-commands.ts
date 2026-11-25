/**
 * Real wiring for the quickstart commands (`init`, `doctor`, `ping`, `send`,
 * `logs`, and `start`/`status` on the user service). `src/cli.ts` only routes
 * to these; tests replace them through `CliDeps`.
 */
import { existsSync, readdirSync } from "node:fs"
import { dirname } from "node:path"
import type { HttpProbe, ProcessRunner, Prompter } from "../host/types.js"
import { resolveProfilePaths, validateProfileName } from "../host/paths.js"
import { readConfig } from "../host/profile-store.js"
import { defaultUserServiceDeps, lingerEnabled } from "../host/daemonizer.js"
import { bridgeConfigSchema } from "../config/schemas.js"
import type { SetupOutcome } from "../host/setup.js"
import type { QuickstartAnswers } from "./setup-wizard.js"
import {
  decideStatus,
  gatherStatusFacts,
  runStartService,
  type ProfileStatus,
  type ServiceCommandDeps,
} from "./service.js"

export interface QuickstartHost {
  readonly writer: (text: string) => void
  readonly isTTY: boolean
  readonly isInputTTY?: boolean
  readonly processRunner?: ProcessRunner
  readonly runSetup: (
    profile?: string,
    options?: { readonly quickstart?: QuickstartAnswers; readonly prompter?: Prompter },
  ) => Promise<unknown>
  readonly startService?: (profile: string) => Promise<number>
}

async function runner(host: QuickstartHost): Promise<ProcessRunner> {
  return host.processRunner ?? new (await import("../host/runtime.js")).BunProcessRunner()
}

export const fetchProbe: HttpProbe = {
  async probe(url, options) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 3000)
    try {
      const response = await fetch(url, { method: options?.method ?? "GET", signal: controller.signal })
      return { status: response.status, ok: response.ok, body: await response.text() }
    } catch {
      return { status: 0, ok: false, body: "" }
    } finally {
      clearTimeout(timer)
    }
  },
}

export async function serviceCommandDeps(host: QuickstartHost): Promise<ServiceCommandDeps> {
  const run = await runner(host)
  return {
    env: process.env,
    runner: run,
    probe: fetchProbe,
    service: defaultUserServiceDeps(run, process.env),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }
}

export async function defaultStartService(profile: string, host: QuickstartHost): Promise<number> {
  return runStartService(profile, await serviceCommandDeps(host), host.writer)
}

export async function defaultStatus(profile: string, host: QuickstartHost): Promise<ProfileStatus> {
  return decideStatus(await gatherStatusFacts(profile, await serviceCommandDeps(host)))
}

/** `--profile`, else AIBR_PROFILE, else the only profile on this machine, else "default". */
export function resolveDefaultProfile(explicit: string | undefined, env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (explicit !== undefined && explicit !== "") return validateProfileName(explicit)
  if (env.AIBR_PROFILE !== undefined && env.AIBR_PROFILE !== "") return validateProfileName(env.AIBR_PROFILE)
  try {
    const root = dirname(resolveProfilePaths("default", { ...env }).configDir)
    const names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          validateProfileName(name)
        } catch {
          return false
        }
        return existsSync(`${root}/${name}/config.json`)
      })
    if (names.length === 1) return names[0]!
  } catch {
    // no config root yet
  }
  return "default"
}

// ── init ────────────────────────────────────────────────────────────────

export async function defaultInit(argv: readonly string[], host: QuickstartHost): Promise<number> {
  const { runInitCommand } = await import("./init.js")
  const interactive = host.isTTY && host.isInputTTY !== false
  let prompter: Prompter | null = null
  const getPrompter = async (): Promise<Prompter> => {
    if (prompter !== null) return prompter
    const { BunPrompter, createStreamLineReader } = await import("../host/runtime.js")
    const stdin = process.stdin as NodeJS.ReadStream | undefined
    prompter = new BunPrompter({
      reader: createStreamLineReader(Bun.stdin.stream()),
      writer: { write: (d: Uint8Array) => { void process.stdout.write(d) } },
      isTTY: Boolean(stdin?.isTTY),
      ...(stdin?.isTTY === true && typeof stdin.setRawMode === "function"
        ? { setRawMode: (enabled: boolean) => { stdin.setRawMode(enabled) } }
        : {}),
    })
    return prompter
  }
  const lazyPrompter: Prompter = {
    prompt: async (o) => (await getPrompter()).prompt(o),
    promptInput: async (m) => (await getPrompter()).promptInput(m),
    promptSecret: async (m) => (await getPrompter()).promptSecret(m),
    promptConfirm: async (m, o) => (await getPrompter()).promptConfirm(m, o),
    promptSelect: async (m, o) => (await getPrompter()).promptSelect(m, o),
  }
  const readProfileConfig = async (profile: string): Promise<Record<string, unknown> | null> => {
    try {
      return (await readConfig(`${resolveProfilePaths(profile).configDir}/config.json`)) as Record<string, unknown> | null
    } catch {
      return null
    }
  }
  return runInitCommand(argv, {
    write: host.writer,
    env: process.env,
    interactive,
    prompter: lazyPrompter,
    readConfig: readProfileConfig,
    runSetup: async (profile, options) => (await host.runSetup(profile, options)) as SetupOutcome,
    join: async (profile, code, options) => {
      const { joinProfileWithCode } = await import("./enroll.js")
      const paths = resolveProfilePaths(profile)
      const { joined, notes } = await joinProfileWithCode(
        paths,
        `${paths.configDir}/config.json`,
        code,
        { fetch: (url, init) => fetch(url, init), now: () => Date.now() },
        options,
      )
      return {
        peerId: joined.agent.id,
        lines: [
          `Paired with ${joined.agent.id} at ${joined.agent.url}; it accepts [${joined.agent.capabilities.join(", ")}] from this node.`,
          `Keys pinned on both sides; its bearer token is stored (0600, not shown).`,
          ...notes.filter((note) => !/already had its own bearer token/.test(note) || !options.adoptBearerToken),
        ],
      }
    },
    issue: async (profile, capabilities) => {
      const { issueCodeForProfile } = await import("./enroll.js")
      const paths = resolveProfilePaths(profile)
      const now = (): number => Date.now()
      const { issued } = await issueCodeForProfile(paths, `${paths.configDir}/config.json`, {
        ...(capabilities !== undefined ? { capabilities } : {}),
        ttlMs: 30 * 60_000,
        now,
      })
      return { code: issued.code, capabilities: issued.capabilities, minutes: Math.max(1, Math.round((issued.expiresAt - now()) / 60_000)) }
    },
    start: (profile) => (host.startService ?? ((p: string) => defaultStartService(p, host)))(profile),
  })
}

// ── doctor ──────────────────────────────────────────────────────────────

export async function defaultDoctor(argv: readonly string[], host: QuickstartHost): Promise<number> {
  const { DOCTOR_HELP, buildDoctorReport, renderDoctorReport } = await import("./doctor.js")
  let profileArg: string | undefined
  let ping = true
  let json = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === "--profile" || arg === "-p") {
      profileArg = argv[++i]
      if (profileArg === undefined || profileArg === "") {
        host.writer("Error: --profile needs a value\n")
        return 64
      }
    } else if (arg === "--no-ping") ping = false
    else if (arg === "--json") json = true
    else if (arg === "--help" || arg === "-h") {
      host.writer(DOCTOR_HELP)
      return 0
    } else {
      host.writer(`Error: unexpected argument ${arg}\n`)
      return 64
    }
  }
  let profile: string
  try {
    profile = resolveDefaultProfile(profileArg)
  } catch {
    host.writer("Error: Invalid profile name (use alphanumeric and hyphens, 1-64 chars)\n")
    return 64
  }
  const run = await runner(host)
  const service = await serviceCommandDeps(host)
  const { BunPlatformInspector } = await import("../host/runtime.js")
  const { BridgeTools, defaultBridgeToolDeps } = await import("../mcp/bridge-tools.js")
  const report = await buildDoctorReport(
    profile,
    {
      platform: process.platform,
      env: process.env,
      verify: async (p) => (await import("./verify.js")).runVerify(p, { processRunner: run, platformInspector: new BunPlatformInspector(), env: process.env }),
      config: async (p) => {
        try {
          const raw = await readConfig(`${resolveProfilePaths(p).configDir}/config.json`)
          const parsed = bridgeConfigSchema.safeParse(raw)
          if (!parsed.success) return null
          return {
            role: parsed.data.role,
            runtime: parsed.data.role === "orchestrator" ? null : parsed.data.runtime.kind,
            agentId: parsed.data.agent_id,
            agents: parsed.data.agents.map((a) => ({ id: a.id, url: a.url })),
            allowedSources: parsed.data.security.allowed_sources.map((s) => s.source_agent_id),
          }
        } catch {
          return null
        }
      },
      statusFacts: (p) => gatherStatusFacts(p, service),
      ping: (p, target) => new BridgeTools(defaultBridgeToolDeps(), p).ping(target),
      linger: () => lingerEnabled({ runner: run, env: process.env }),
    },
    { ping },
  )
  if (json) {
    host.writer(`${JSON.stringify(report)}\n`)
  } else {
    host.writer(renderDoctorReport(report, `AIBridge doctor — profile "${profile}"`))
  }
  return report.ok ? 0 : 1
}

// ── ping / send / logs ──────────────────────────────────────────────────

export async function defaultPing(argv: readonly string[], host: QuickstartHost): Promise<number> {
  const { runPingCommand } = await import("./dispatch.js")
  return runPingCommand(argv, { write: host.writer })
}

export async function defaultSend(argv: readonly string[], host: QuickstartHost): Promise<number> {
  const { runSendCommand } = await import("./dispatch.js")
  return runSendCommand(argv, { write: host.writer })
}

export async function defaultLogs(argv: readonly string[], host: QuickstartHost): Promise<number> {
  const { runLogsCommand } = await import("./logs.js")
  return runLogsCommand(argv, { env: process.env, write: host.writer })
}

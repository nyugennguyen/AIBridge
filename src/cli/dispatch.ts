/**
 * `aibr ping <peer>` and `aibr send <peer> "<prompt>"` — the end-to-end check
 * and the first job, without a hand-written curl.
 *
 * Both go through `BridgeTools` (src/mcp/bridge-tools.ts), the same client the
 * Claude Code plugin uses: per-peer bearer token from pairing, ed25519 request
 * signature, and redaction of every secret it touched. Nothing here builds an
 * Authorization header itself.
 */
import { basename } from "node:path"
import {
  BridgeTools,
  DEFAULT_PING_TIMEOUT_MS,
  defaultBridgeToolDeps,
  type BridgeToolDeps,
  type PingOutcome,
} from "../mcp/bridge-tools.js"
import type { PongInfo } from "../jobs/types.js"

export const PING_HELP = [
  "aibr ping — send a signed no-op job to a peer and wait for its result",
  "",
  "Usage:",
  "  aibr ping [<peer>] [--profile <name>] [--timeout <seconds>] [--json]",
  "",
  "Proves the whole path a job takes: this node signs a /trigger, the peer",
  "authenticates and authorizes it, completes it without running anything, and",
  "reports back. When this node runs a bridge (worker/both), the ping also waits",
  "for that /report callback to arrive here. <peer> is an agents[] id; it may be",
  "omitted when the profile has exactly one. Default timeout 20s.",
  "",
].join("\n")

export const SEND_HELP = [
  "aibr send — dispatch a job to a peer and wait for its result",
  "",
  "Usage:",
  "  aibr send <peer> \"<prompt>\" [--capability <name>] [--project <dir|id>]",
  "            [--timeout-seconds <n>] [--no-wait] [--profile <name>] [--json]",
  "",
  "Fills in source_agent_id, target_agent_id, callback_url, job_id and the",
  "signature. --capability defaults to the peer's \"investigate\" (read-only), or",
  "its only capability. --project is a directory the PEER allowlists, or that",
  "project's id; it defaults to the peer's only project, or the one named like",
  "this directory's git root. A ping fetches both when they are not given.",
  "Waits for the result unless --no-wait (Ctrl-C stops waiting, not the job).",
  "",
].join("\n")

export interface DispatchCliDeps {
  readonly write: (text: string) => void
  readonly tools?: (profile: string | undefined) => BridgeTools
  readonly toolDeps?: BridgeToolDeps
  /** The local directory used to pick a peer project by name. */
  readonly cwd?: string
  readonly gitRoot?: (cwd: string) => Promise<string | null>
  /** Pause between polls while a job awaits approval (bridge_await returns at once then). */
  readonly sleep?: (ms: number) => Promise<void>
}

interface ParsedFlags {
  readonly positional: readonly string[]
  readonly flags: ReadonlyMap<string, string>
  readonly bools: ReadonlySet<string>
}

const VALUE_FLAGS = new Set(["--profile", "-p", "--timeout", "--capability", "--project", "--timeout-seconds"])
const BOOL_FLAGS = new Set(["--json", "--no-wait", "--help", "-h"])

export function parseFlags(argv: readonly string[]): ParsedFlags | string {
  const positional: string[] = []
  const flags = new Map<string, string>()
  const bools = new Set<string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const eq = arg.indexOf("=")
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg
    if (VALUE_FLAGS.has(name)) {
      const value = arg.startsWith("--") && eq > 0 ? arg.slice(eq + 1) : argv[++i]
      if (value === undefined || value === "") return `${name} needs a value`
      flags.set(name === "-p" ? "--profile" : name, value)
    } else if (BOOL_FLAGS.has(arg)) {
      bools.add(arg === "-h" ? "--help" : arg)
    } else if (arg.startsWith("-") && arg !== "-") {
      return `unknown flag ${arg}`
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags, bools }
}

function makeTools(deps: DispatchCliDeps, profile: string | undefined): BridgeTools {
  return deps.tools?.(profile) ?? new BridgeTools(deps.toolDeps ?? defaultBridgeToolDeps(), profile)
}

function positiveInt(raw: string | undefined, name: string): number | string | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : `${name} needs a positive whole number`
}

/** The peer to use when none was named: the profile's only agent. */
async function defaultPeer(tools: BridgeTools): Promise<string> {
  const profile = await tools.loadProfile()
  const ids = profile.config.agents.map((a) => a.id)
  if (ids.length === 1) return ids[0]!
  if (ids.length === 0) {
    throw new Error(
      `Profile "${profile.name}" has no peers yet. Pair one: "aibr enroll issue" on the worker, then "aibr enroll join <code>" here.`,
    )
  }
  throw new Error(`Name a peer: ${ids.join(", ")}.`)
}

// ── ping ────────────────────────────────────────────────────────────────

export function renderPing(outcome: PingOutcome): string {
  const where = outcome.url !== null ? ` (${outcome.url})` : ""
  if (!outcome.ok) {
    const lines = [`✗ ping ${outcome.target}${where}: ${outcome.error ?? "failed"}`]
    if (outcome.stage === "callback") lines.push(`  request:  accepted and completed (job ${outcome.jobId ?? "?"})`)
    if (outcome.hint !== undefined) lines.push(`  fix:      ${outcome.hint}`)
    return `${lines.join("\n")}\n`
  }
  const lines = [`✓ ping ${outcome.target}${where}: ${outcome.rttMs} ms`]
  lines.push(`  request:  signed /trigger accepted; job ${outcome.jobId ?? "?"} completed`)
  lines.push(
    outcome.callback.status === "delivered"
      ? "  callback: delivered to this node's /report"
      : "  callback: not checked (this node runs no bridge to receive it)",
  )
  if (outcome.pong !== undefined) lines.push(...pongLines(outcome.pong))
  return `${lines.join("\n")}\n`
}

function pongLines(pong: PongInfo): string[] {
  const lines = [`  peer:     ${pong.agent_id}, ${pong.role}, ${pong.runtime} runtime, aibr ${pong.version}`]
  lines.push(`  accepts:  ${pong.capabilities.length > 0 ? pong.capabilities.join(", ") : "(nothing from this node beyond ping)"}`)
  if (pong.projects.length === 0) lines.push("  projects: (none allowlisted)")
  for (const [index, project] of pong.projects.entries()) {
    lines.push(`  ${index === 0 ? "projects:" : "         "} ${project.id} ${project.path}`)
  }
  return lines
}

export async function runPingCommand(argv: readonly string[], deps: DispatchCliDeps): Promise<number> {
  const parsed = parseFlags(argv)
  if (typeof parsed === "string") {
    deps.write(`Error: ${parsed}\n`)
    return 64
  }
  if (parsed.bools.has("--help")) {
    deps.write(PING_HELP)
    return 0
  }
  if (parsed.positional.length > 1) {
    deps.write(`Error: unexpected argument ${parsed.positional[1]}\n`)
    return 64
  }
  const timeout = positiveInt(parsed.flags.get("--timeout"), "--timeout")
  if (typeof timeout === "string") {
    deps.write(`Error: ${timeout}\n`)
    return 64
  }
  const tools = makeTools(deps, parsed.flags.get("--profile"))
  let target: string
  try {
    target = parsed.positional[0] ?? (await defaultPeer(tools))
  } catch (error) {
    deps.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  const outcome = await tools.ping(target, { timeoutMs: timeout !== undefined ? timeout * 1000 : DEFAULT_PING_TIMEOUT_MS })
  deps.write(parsed.bools.has("--json") ? `${JSON.stringify(outcome)}\n` : renderPing(outcome))
  return outcome.ok ? 0 : 1
}

// ── send ────────────────────────────────────────────────────────────────

/** Picks the capability when none was given. Returns an error string when it cannot. */
export function chooseCapability(accepted: readonly string[], peer: string): string | { readonly error: string } {
  if (accepted.includes("investigate")) return "investigate"
  if (accepted.length === 1) return accepted[0]!
  if (accepted.length === 0) {
    return { error: `${peer} accepts no capability from this node. Ask its operator: aibr enroll issue --capabilities <list>.` }
  }
  return { error: `Choose one with --capability: ${peer} accepts ${accepted.join(", ")}.` }
}

/** Picks the project directory on the peer. Returns an error string when it cannot. */
export function chooseProject(
  requested: string | undefined,
  projects: readonly { readonly id: string; readonly path: string }[] | null,
  localRoot: string | null,
  peer: string,
): string | { readonly error: string } {
  if (requested !== undefined) {
    const byId = projects?.find((p) => p.id === requested)
    if (byId !== undefined) return byId.path
    if (requested.startsWith("/")) return requested
    return {
      error: `--project must be an absolute directory on ${peer}${projects !== null && projects.length > 0 ? ` or one of its project ids: ${projects.map((p) => p.id).join(", ")}` : ""}.`,
    }
  }
  if (projects === null) return { error: `Pass --project <dir on ${peer}>.` }
  if (projects.length === 1) return projects[0]!.path
  if (projects.length === 0) return { error: `${peer} allowlists no project directory; its operator must add one (aibr setup there).` }
  if (localRoot !== null) {
    const name = basename(localRoot)
    const match = projects.filter((p) => basename(p.path) === name || p.id === name)
    if (match.length === 1) return match[0]!.path
  }
  return { error: `Choose one with --project: ${projects.map((p) => `${p.id} (${p.path})`).join(", ")}.` }
}

const FINAL = new Set(["completed", "failed", "timed_out", "callback_failed"])

interface ToolCallResult {
  readonly ok: boolean
  readonly data: Record<string, unknown>
}

async function callTool(tools: BridgeTools, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const result = await tools.call(name, args)
  const text = result.content[0]?.text ?? "{}"
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    data = { error: text }
  }
  return { ok: result.isError !== true, data }
}

function errorLine(data: Record<string, unknown>): string {
  const error = typeof data.error === "string" ? data.error : "failed"
  const hint = typeof data.hint === "string" ? `\n  fix: ${data.hint.replace(/^Do not retry\. /, "")}` : ""
  return `Error: ${error}${hint}\n`
}

function renderResult(data: Record<string, unknown>): string {
  const lines = [`Job ${String(data.job_id)} on ${String(data.target)}: ${String(data.status)}`]
  if (typeof data.summary === "string") lines.push("", data.summary)
  if (Array.isArray(data.findings) && data.findings.length > 0) {
    lines.push("", "Findings:")
    for (const finding of data.findings as { severity?: unknown; title?: unknown; details?: unknown }[]) {
      lines.push(`  [${String(finding.severity ?? "?")}] ${String(finding.title ?? "")}`)
      if (typeof finding.details === "string" && finding.details !== "") lines.push(`      ${finding.details.split("\n").join("\n      ")}`)
    }
  }
  if (typeof data.error === "string" && data.status !== "completed") lines.push(`Error: ${data.error}`)
  return `${lines.join("\n")}\n`
}

export async function runSendCommand(argv: readonly string[], deps: DispatchCliDeps): Promise<number> {
  const parsed = parseFlags(argv)
  if (typeof parsed === "string") {
    deps.write(`Error: ${parsed}\n`)
    return 64
  }
  if (parsed.bools.has("--help")) {
    deps.write(SEND_HELP)
    return 0
  }
  if (parsed.positional.length !== 2) {
    deps.write(`Error: expected a peer and a prompt\n\n${SEND_HELP}`)
    return 64
  }
  const [target, prompt] = parsed.positional as [string, string]
  if (prompt.trim() === "") {
    deps.write("Error: the prompt is empty\n")
    return 64
  }
  const timeoutSeconds = positiveInt(parsed.flags.get("--timeout-seconds"), "--timeout-seconds")
  if (typeof timeoutSeconds === "string") {
    deps.write(`Error: ${timeoutSeconds}\n`)
    return 64
  }
  const json = parsed.bools.has("--json")
  const tools = makeTools(deps, parsed.flags.get("--profile"))

  let capability = parsed.flags.get("--capability")
  const requestedProject = parsed.flags.get("--project")
  let pong: PongInfo | null = null
  const needsPong = capability === undefined || requestedProject === undefined || !requestedProject.startsWith("/")
  if (needsPong) {
    const outcome = await tools.ping(target, { waitForCallback: false })
    if (!outcome.ok || outcome.pong === undefined) {
      deps.write(
        outcome.ok
          ? `Error: ${target} did not describe itself (older aibr?). Pass --capability and --project.\n`
          : `Error: could not reach ${target} to look up its capabilities and projects: ${outcome.error ?? "ping failed"}\n` +
              (outcome.hint !== undefined ? `  fix: ${outcome.hint}\n` : ""),
      )
      return 1
    }
    pong = outcome.pong
  }
  if (capability === undefined) {
    const chosen = chooseCapability(pong!.capabilities, target)
    if (typeof chosen !== "string") {
      deps.write(`Error: ${chosen.error}\n`)
      return 1
    }
    capability = chosen
  }
  const cwd = deps.cwd ?? process.cwd()
  const localRoot = requestedProject === undefined ? await (deps.gitRoot ?? defaultGitRoot)(cwd) : null
  const project = chooseProject(requestedProject, pong?.projects ?? null, localRoot, target)
  if (typeof project !== "string") {
    deps.write(`Error: ${project.error}\n`)
    return 1
  }

  const dispatched = await callTool(tools, "bridge_dispatch", {
    target,
    capability,
    project_dir: project,
    prompt,
    ...(timeoutSeconds !== undefined ? { timeout_seconds: timeoutSeconds } : {}),
  })
  if (!dispatched.ok) {
    deps.write(json ? `${JSON.stringify(dispatched.data)}\n` : errorLine(dispatched.data))
    return 1
  }
  const jobId = String(dispatched.data.job_id)
  if (!json) deps.write(`Dispatched job ${jobId} to ${target} (capability ${capability}, project ${project}).\n`)
  if (dispatched.data.status === "awaiting_approval") {
    if (!json) deps.write(`${String(dispatched.data.message ?? "Awaiting operator approval on the worker.")}\n`)
  }
  if (parsed.bools.has("--no-wait")) {
    if (json) deps.write(`${JSON.stringify(dispatched.data)}\n`)
    else deps.write(`Not waiting. Status: ${String(dispatched.data.status_url ?? "")}\n`)
    return 0
  }

  if (!json) deps.write("Waiting for the result (Ctrl-C stops waiting; the job keeps running)...\n")
  let announcedApproval = dispatched.data.status === "awaiting_approval"
  for (;;) {
    const awaited = await callTool(tools, "bridge_await", { job_id: jobId, target, timeout_s: 60 })
    if (!awaited.ok) {
      deps.write(json ? `${JSON.stringify(awaited.data)}\n` : errorLine(awaited.data))
      return 1
    }
    const status = String(awaited.data.status)
    if (FINAL.has(status)) {
      const result = await callTool(tools, "bridge_result", { job_id: jobId, target })
      const data = result.ok ? result.data : awaited.data
      deps.write(json ? `${JSON.stringify(data)}\n` : renderResult(data))
      return status === "completed" ? 0 : 1
    }
    if (status === "awaiting_approval") {
      if (!announcedApproval && !json) deps.write(`${String(awaited.data.message ?? "Awaiting operator approval on the worker.")}\n`)
      announcedApproval = true
      await (deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(5000)
    }
  }
}

async function defaultGitRoot(cwd: string): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const { stdout } = await promisify(execFile)("git", ["-C", cwd, "rev-parse", "--show-toplevel"])
    const top = stdout.trim()
    return top === "" ? null : top
  } catch {
    return null
  }
}

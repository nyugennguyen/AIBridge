/**
 * `aibr approve <job>`, `aibr reject <job>` and `aibr jobs pending` — the
 * operator's side of Phase 4 approval, run ON the worker node.
 *
 * The operator credential comes from `AIBRIDGE_OPERATOR_TOKEN` or the
 * profile's `secrets/operator_token` (mode 0600). It is sent only to this
 * node's own bridge and is never printed. Every decision shows what is being
 * approved (capability, source, project, repo@sha, prompt) and asks first,
 * defaulting to No; `--yes` skips the question.
 *
 * Text shown here (the prompt above all) was written by a PEER, so control
 * characters are stripped before it reaches the terminal.
 */
import { resolveProfilePaths, validateProfileName } from "../host/paths.js"
import { readConfig, readSecret } from "../host/profile-store.js"
import { needsValue, unknownFlag } from "./arg-errors.js"

export interface OperatorEndpoint {
  /** e.g. `http://127.0.0.1:8787` */
  readonly baseUrl: string
  /** `null` when neither the env var nor the secret file supplies one. */
  readonly token: string | null
}

export interface OperatorCliDeps {
  readonly writer: (text: string) => void
  readonly fetch: typeof fetch
  /** Yes/no question, default No. Must resolve false when it cannot ask. */
  readonly confirm: (question: string) => Promise<boolean>
  /** Resolves the profile's local bridge URL and operator token. */
  readonly loadEndpoint: (profile: string) => Promise<OperatorEndpoint>
}

export interface ParsedOperatorArgs {
  readonly positional: readonly string[]
  readonly profile: string
  readonly yes: boolean
  readonly json: boolean
  readonly allJobs: boolean
  readonly reason?: string
  readonly help: boolean
}

/** Parses the flags these commands share. Returns an error string for anything unknown. */
export function parseOperatorArgs(argv: readonly string[], allowed: ReadonlySet<string>, command?: string): ParsedOperatorArgs | string {
  const positional: string[] = []
  let profile = "default"
  let yes = false
  let json = false
  let allJobs = false
  let help = false
  let reason: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const flag = arg === "-p" ? "--profile" : arg === "-y" ? "--yes" : arg === "-h" ? "--help" : arg
    if (flag.startsWith("-") && flag !== "--help" && !allowed.has(flag)) return unknownFlag(arg, command)
    switch (flag) {
      case "--profile": {
        const value = argv[++index]
        if (value === undefined || value.length === 0) return needsValue("--profile", command)
        try {
          validateProfileName(value)
        } catch {
          return "Invalid profile name (use alphanumeric and hyphens, 1-64 chars)"
        }
        profile = value
        break
      }
      case "--reason": {
        const value = argv[++index]
        if (value === undefined || value.trim().length === 0) return needsValue("--reason", command)
        if (value.length > 500) return "--reason must be at most 500 characters"
        reason = value
        break
      }
      case "--yes":
        yes = true
        break
      case "--json":
        json = true
        break
      case "--all-jobs":
        allJobs = true
        break
      case "--help":
        help = true
        break
      default:
        positional.push(arg)
    }
  }
  return { positional, profile, yes, json, allJobs, help, ...(reason !== undefined ? { reason } : {}) }
}

/** Removes terminal control sequences from text a peer wrote, keeping newlines and tabs. */
export function sanitizeForTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
}

const MAX_PROMPT_CHARS = 4_000

/** The human-readable view of a job an operator is about to decide on. */
export function describeJob(job: Record<string, unknown>): string {
  const text = (value: unknown): string => sanitizeForTerminal(typeof value === "string" ? value : String(value ?? "?"))
  const trigger = (job.trigger ?? {}) as Record<string, unknown>
  const prompt = text(trigger.prompt ?? job.prompt)
  const lines = [
    `Job ${text(job.id ?? job.job_id)} (${text(job.status)})`,
    `  capability: ${text(trigger.capability ?? job.capability)}`,
    `  source:     ${text(trigger.source_agent_id ?? job.source_agent_id)}`,
    `  project:    ${text(trigger.project_dir ?? job.project_dir)}`,
  ]
  if (typeof job.sha === "string") lines.push(`  repo:       ${text(job.repo)} @ ${text(job.ref)} -> ${text(job.sha)}`)
  else lines.push("  repo:       (none: runs in the project directory as it is)")
  if (typeof job.expires_at === "string") lines.push(`  expires:    ${text(job.expires_at)}`)
  lines.push("  prompt:")
  const shown = prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS)}\n… (${prompt.length - MAX_PROMPT_CHARS} more characters)` : prompt
  for (const line of shown.split("\n")) lines.push(`    ${line}`)
  return `${lines.join("\n")}\n`
}

/** The default `loadEndpoint`: the profile config's bridge address, the token from env or the 0600 secret file. */
export async function loadOperatorEndpoint(profile: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<OperatorEndpoint> {
  const paths = resolveProfilePaths(profile, env)
  const config = (await readConfig(`${paths.configDir}/config.json`).catch(() => null)) as { bridge?: { host?: unknown; port?: unknown } } | null
  if (config === null || typeof config.bridge?.port !== "number") {
    throw new Error(`Profile "${profile}" not found. Run "aibr setup --profile ${profile}" first.`)
  }
  const host = typeof config.bridge.host === "string" ? config.bridge.host : "127.0.0.1"
  // A wildcard bind is reachable on loopback; anything else is dialled as bound.
  const dial = host === "0.0.0.0" || host === "::" || host.length === 0 ? "127.0.0.1" : host
  const baseUrl = `http://${dial.includes(":") ? `[${dial}]` : dial}:${config.bridge.port}`
  const fromEnv = env.AIBRIDGE_OPERATOR_TOKEN
  if (fromEnv !== undefined && fromEnv.length > 0) return { baseUrl, token: fromEnv }
  try {
    const token = (await readSecret(`${paths.secretsDir}/operator_token`)).trim()
    return { baseUrl, token: token.length > 0 ? token : null }
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (/mode|permission|symlink/i.test(message)) throw new Error("The operator token file must be a regular file with mode 0600.")
    return { baseUrl, token: null }
  }
}

export class OperatorRequestError extends Error {}

/** One authenticated request to this node's bridge. Never includes the token in an error. */
export async function operatorRequest(
  deps: OperatorCliDeps,
  endpoint: OperatorEndpoint,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (endpoint.token === null) {
    throw new OperatorRequestError(
      "No operator token: set AIBRIDGE_OPERATOR_TOKEN or create the profile's secrets/operator_token (mode 0600).",
    )
  }
  let response: Response
  try {
    response = await deps.fetch(`${endpoint.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    })
  } catch {
    throw new OperatorRequestError(`The local bridge at ${endpoint.baseUrl} is not reachable. Is it running?`)
  }
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = await response.json()
    if (value !== null && typeof value === "object") parsed = value as Record<string, unknown>
  } catch {
    /* non-JSON body */
  }
  return { status: response.status, body: parsed }
}

function failure(response: { status: number; body: Record<string, unknown> }): string {
  const error = typeof response.body.error === "string" ? sanitizeForTerminal(response.body.error) : `HTTP ${response.status}`
  const code = typeof response.body.code === "string" ? ` [${sanitizeForTerminal(response.body.code)}]` : ""
  return `${error}${code}`
}

const APPROVE_FLAGS = new Set(["--profile", "--yes"])
const REJECT_FLAGS = new Set(["--profile", "--yes", "--reason"])
const PENDING_FLAGS = new Set(["--profile", "--json"])

export const APPROVE_HELP = [
  "aibr approve — approve a job held for operator approval on this node",
  "",
  "Usage:",
  "  aibr approve <job_id> [--profile <name>] [--yes]",
  "  aibr reject  <job_id> [--reason <text>] [--profile <name>] [--yes]",
  "  aibr jobs pending [--profile <name>] [--json]",
  "",
  "Shows the job (capability, source, project, repo@sha, prompt) and asks",
  "before deciding (default No). Run on the worker node: the bridge accepts",
  "operator decisions only from the node itself. The operator token is read",
  "from AIBRIDGE_OPERATOR_TOKEN or <data>/aibridge/<profile>/secrets/operator_token.",
  "The profile defaults to \"default\".",
  "",
  "To list all jobs, or to follow or cancel one, see aibr jobs, aibr job and aibr cancel.",
  "",
].join("\n")

/** `aibr approve` / `aibr reject`. */
export async function runDecisionCommand(decision: "approve" | "reject", argv: readonly string[], deps: OperatorCliDeps): Promise<number> {
  const parsed = parseOperatorArgs(argv, decision === "approve" ? APPROVE_FLAGS : REJECT_FLAGS, decision)
  if (typeof parsed === "string") {
    deps.writer(`Error: ${parsed}\n`)
    return 64
  }
  if (parsed.help) {
    deps.writer(APPROVE_HELP)
    return 0
  }
  const [jobId, extra] = parsed.positional
  if (jobId === undefined || extra !== undefined) {
    deps.writer(`Error: usage: aibr ${decision} <job_id> [--profile <name>]${decision === "reject" ? " [--reason <text>]" : ""} [--yes]\n`)
    return 64
  }
  try {
    const endpoint = await deps.loadEndpoint(parsed.profile)
    const encoded = encodeURIComponent(jobId)
    const current = await operatorRequest(deps, endpoint, "GET", `/jobs/${encoded}`)
    if (current.status === 404) {
      deps.writer(`Error: job ${sanitizeForTerminal(jobId)} not found on this node\n`)
      return 1
    }
    if (current.status !== 200) {
      deps.writer(`Error: ${failure(current)}\n`)
      return 1
    }
    deps.writer(describeJob(current.body))
    if (current.body.status !== "awaiting_approval") {
      deps.writer(`Error: job is not awaiting approval (status ${sanitizeForTerminal(String(current.body.status))})\n`)
      return 1
    }
    const question = decision === "approve" ? "Approve and run this job?" : "Reject this job?"
    if (!parsed.yes && !(await deps.confirm(question))) {
      deps.writer("Nothing changed.\n")
      return 1
    }
    const result = await operatorRequest(
      deps,
      endpoint,
      "POST",
      `/jobs/${encoded}/${decision}`,
      decision === "reject" && parsed.reason !== undefined ? { reason: parsed.reason } : {},
    )
    if (result.status !== 200) {
      deps.writer(`Error: ${failure(result)}\n`)
      return 1
    }
    if (decision === "approve") {
      const sha = typeof result.body.sha === "string" ? ` at ${result.body.sha}` : ""
      deps.writer(`Approved ${sanitizeForTerminal(jobId)}: ${sanitizeForTerminal(String(result.body.status))}${sha}\n`)
    } else {
      deps.writer(`Rejected ${sanitizeForTerminal(jobId)}; the requester was sent a failed report.\n`)
    }
    return 0
  } catch (error) {
    deps.writer(`Error: ${error instanceof Error ? error.message : `${decision} failed`}\n`)
    return 1
  }
}

/** `aibr jobs pending`. */
export async function runJobsCommand(argv: readonly string[], deps: OperatorCliDeps): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === undefined || sub === "--help" || sub === "-h") {
    deps.writer(APPROVE_HELP)
    return sub === undefined ? 64 : 0
  }
  if (sub !== "pending") {
    deps.writer(`Error: unknown jobs subcommand "${sanitizeForTerminal(sub)}" (expected pending)\n`)
    return 64
  }
  const parsed = parseOperatorArgs(rest, PENDING_FLAGS, "jobs pending")
  if (typeof parsed === "string") {
    deps.writer(`Error: ${parsed}\n`)
    return 64
  }
  if (parsed.help) {
    deps.writer(APPROVE_HELP)
    return 0
  }
  if (parsed.positional.length > 0) {
    deps.writer("Error: usage: aibr jobs pending [--profile <name>] [--json]\n")
    return 64
  }
  try {
    const endpoint = await deps.loadEndpoint(parsed.profile)
    const result = await operatorRequest(deps, endpoint, "GET", "/operator/pending-jobs")
    if (result.status !== 200) {
      deps.writer(`Error: ${failure(result)}\n`)
      return 1
    }
    const jobs = Array.isArray(result.body.jobs) ? (result.body.jobs as Record<string, unknown>[]) : []
    if (parsed.json) {
      deps.writer(`${JSON.stringify({ jobs })}\n`)
      return 0
    }
    if (jobs.length === 0) {
      deps.writer("No jobs are awaiting approval.\n")
      return 0
    }
    for (const job of jobs) deps.writer(`${describeJob(job)}\n`)
    deps.writer(`${jobs.length} job(s) awaiting approval. Decide with: aibr approve <job_id> / aibr reject <job_id>\n`)
    return 0
  } catch (error) {
    deps.writer(`Error: ${error instanceof Error ? error.message : "jobs pending failed"}\n`)
    return 1
  }
}

/** A yes/no question on the controlling terminal; false (No) without one. */
export async function confirmOnTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const { createInterface } = await import("node:readline/promises")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
    return answer === "y" || answer === "yes"
  } finally {
    rl.close()
  }
}

/** Dependencies for the real CLI. */
export function realOperatorDeps(writer: (text: string) => void): OperatorCliDeps {
  return {
    writer,
    fetch: (input, init) => fetch(input, init),
    confirm: confirmOnTerminal,
    loadEndpoint: (profile) => loadOperatorEndpoint(profile),
  }
}

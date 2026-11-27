/**
 * `aibr jobs`, `aibr job <id>`, `aibr cancel <id>` and `aibr attach <id>`:
 * list, inspect, follow and cancel jobs (v3.2.0 block C). They are clients of
 * the job API (`src/server/routes/job-api.ts`, `GET /jobs/:id`).
 *
 * Which credential goes where:
 * - Against THIS node (the default) they use the OPERATOR credential, the way
 *   `aibr approve` and `aibr jobs pending` do (`src/cli/approve.ts`): the
 *   operator token from `AIBRIDGE_OPERATOR_TOKEN` or the profile's
 *   `secrets/operator_token`, sent to the profile's own bridge. It sees and
 *   cancels every job on the node.
 * - Against a PEER (`--node <peer>`, `jobs --all-nodes`) they send the peer's
 *   bearer token and a node signature (ADR 0012), through the same
 *   `prepareSignedRequest` that `aibr ping` and the MCP tools use. A peer
 *   shows and cancels only the jobs this node requested (unless it has
 *   `request_signing: off`, where signatures are not verified).
 *
 * `aibr jobs pending` is a different command (operator approvals,
 * `src/cli/approve.ts`); `src/cli.ts` sends it there. Text from a job (prompt,
 * error, event text) was written by a peer or a model, so control characters
 * are stripped before it reaches the terminal.
 */
import { join } from "node:path"
import { BridgeTools, defaultBridgeToolDeps, type BridgeToolDeps, type LoadedProfile } from "../mcp/bridge-tools.js"
import { prepareSignedRequest } from "../mcp/signed-http.js"
import { confirmOnTerminal, describeJob, loadOperatorEndpoint, operatorRequest, realOperatorDeps, sanitizeForTerminal } from "./approve.js"
import { needsValue, unknownFlag } from "./arg-errors.js"

export type JobCommandName = "jobs" | "job" | "cancel" | "attach"

export interface JobResponse {
  readonly status: number
  readonly body: Record<string, unknown>
}

/** One node a command can talk to: this node (operator credential) or a peer (signed). */
export interface JobTarget {
  /** `local`, or the peer's agent id. */
  readonly label: string
  readonly kind: "operator" | "peer"
  /** Rejects with a message fit for the terminal when the node cannot be reached. `signal` (Ctrl-C) cuts a request in flight. */
  request(method: "GET" | "POST", path: string, signal?: AbortSignal): Promise<JobResponse>
}

export interface JobCliDeps {
  readonly writer: (text: string) => void
  /** Yes/no question, default No. */
  readonly confirm: (question: string) => Promise<boolean>
  readonly isInputTTY: boolean
  readonly isOutputTTY: boolean
  readonly now: () => Date
  /** Resolves after `ms`, or at once when the interrupt fires. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  /** Ctrl-C for the long-running modes (`--watch`, `-f`); `dispose` removes the handler. */
  readonly interrupt: () => { readonly signal: AbortSignal; readonly dispose: () => void }
  /** This node, with the operator credential. */
  readonly local: (profile: string) => Promise<JobTarget>
  /** One peer of the profile, signed. */
  readonly peer: (profile: string, node: string) => Promise<JobTarget>
  /** Every peer of the profile, signed. */
  readonly peers: (profile: string) => Promise<readonly JobTarget[]>
}

export const WATCH_INTERVAL_MS = 2_000
export const FOLLOW_INTERVAL_MS = 1_000
const EVENTS_PAGE = 500
const MAX_LIST_LIMIT = 200
const PEER_TIMEOUT_MS = 15_000
const CLEAR_SCREEN = "\x1b[H\x1b[J"

// ── help ────────────────────────────────────────────────────────────────

export const JOBS_HELP = [
  "aibr jobs — list jobs on this node, or on your peers",
  "",
  "Usage:",
  "  aibr jobs [--status <status>] [--limit <n>] [--json] [--profile <name>]",
  "  aibr jobs --all-nodes [--status <status>] [--limit <n>] [--json] [--profile <name>]",
  "  aibr jobs --node <peer> [...]",
  "  aibr jobs --watch [--all-nodes | --node <peer>] [...]",
  "  aibr jobs pending [--json] [--profile <name>]",
  "",
  "Without --node or --all-nodes this lists every job on THIS node, newest first,",
  "with the operator token (AIBRIDGE_OPERATOR_TOKEN or the profile's",
  "secrets/operator_token); run it on the node that runs the bridge.",
  "--all-nodes and --node ask the peers in agents[] with signed requests, so a",
  "peer lists only the jobs THIS node dispatched to it (unless the peer has",
  "request_signing \"off\": it does not verify signatures, so the bearer lists",
  "every job there). --all-nodes merges them by",
  "time with a node column; a peer that cannot be reached gets one line and does",
  "not fail the command (exit 1 only when no peer answered). It needs no local",
  "bridge.",
  "--status filters by job status; --limit is at most 200 (default 50) and is a total, also with --all-nodes.",
  "--json prints one JSON document. --watch polls every 2 seconds until Ctrl-C:",
  "on a terminal it redraws the list, otherwise it prints one line per change.",
  "",
  "aibr jobs pending lists the jobs held for operator approval on this node",
  "(see aibr approve). aibr job <id> shows one job; aibr cancel <id> ends one.",
  "",
].join("\n")

export const JOB_HELP = [
  "aibr job — show one job, its events, or follow it until it ends",
  "",
  "Usage:",
  "  aibr job <job_id> [--events] [-f] [--json] [--node <peer>] [--profile <name>]",
  "",
  "Prints the job's status, capability, source, project, timestamps and result.",
  "--events prints what the job did, in order (status changes, messages, tool",
  "use, the result). -f (--follow) keeps reading until the job ends and implies",
  "--events; Ctrl-C stops following, not the job (aibr cancel stops it). --json",
  "prints the job as JSON, or one JSON event per line.",
  "",
  "Without --node the job is looked up on THIS node with the operator token. With",
  "--node <peer> the request is signed and the peer shows only a job this node",
  "dispatched to it (unless the peer has request_signing \"off\": signatures are",
  "not verified there and the bearer reads any job).",
  "",
  "An id that starts with a dash goes after --: aibr job -- -id.",
  "This is not aibr logs, which prints the bridge's own log.",
  "",
].join("\n")

export const CANCEL_HELP = [
  "aibr cancel — end one job",
  "",
  "Usage:",
  "  aibr cancel <job_id> [--yes] [--node <peer>] [--profile <name>]",
  "",
  "The job ends as failed (\"cancelled by operator\" or \"by requester\") and its",
  "requester is sent the report. A running Claude Code job's process is",
  "terminated. Asks first (default No); --yes skips the question. Without a",
  "terminal it asks nothing and changes nothing (exit 1) unless --yes is given. A job awaiting operator approval cannot",
  "be cancelled: reject it with aibr reject <job_id>. A finished job answers",
  "\"already ended\".",
  "",
  "Without --node it cancels a job on THIS node with the operator token. With",
  "--node <peer> the request is signed and the peer cancels only a job this node",
  "dispatched to it (unless the peer has request_signing \"off\": signatures are",
  "not verified there and the bearer cancels any job).",
  "",
  "An id that starts with a dash goes after --: aibr cancel -- -id.",
  "aibr cancel stops ONE job. aibr stop stops the service, or with --all-jobs",
  "every running job on the node.",
  "",
].join("\n")

export const ATTACH_HELP = [
  "aibr attach — watch a job until it ends (read-only)",
  "",
  "Usage:",
  "  aibr attach <job_id> [--json] [--node <peer>] [--profile <name>]",
  "",
  "The same as aibr job <job_id> --events -f. It does NOT attach a terminal:",
  "Claude Code jobs run as child processes without a terminal session, so this",
  "only prints the job's events as they happen and returns when the job ends.",
  "An id that starts with a dash goes after --: aibr cancel -- -id.",
  "Ctrl-C stops watching, not the job. See aibr cancel to stop it.",
  "",
].join("\n")

const HELP: Readonly<Record<JobCommandName, string>> = { jobs: JOBS_HELP, job: JOB_HELP, cancel: CANCEL_HELP, attach: ATTACH_HELP }

// ── arguments ───────────────────────────────────────────────────────────

interface JobArgs {
  readonly positional: readonly string[]
  readonly profile: string | undefined
  readonly node: string | undefined
  readonly status: string | undefined
  readonly limit: number | undefined
  readonly json: boolean
  readonly allNodes: boolean
  readonly watch: boolean
  readonly events: boolean
  readonly follow: boolean
  readonly yes: boolean
  readonly help: boolean
}

const VALUE_FLAGS: Readonly<Record<JobCommandName, ReadonlySet<string>>> = {
  jobs: new Set(["--profile", "--node", "--status", "--limit"]),
  job: new Set(["--profile", "--node"]),
  cancel: new Set(["--profile", "--node"]),
  attach: new Set(["--profile", "--node"]),
}
const BOOL_FLAGS: Readonly<Record<JobCommandName, ReadonlySet<string>>> = {
  jobs: new Set(["--json", "--all-nodes", "--watch"]),
  job: new Set(["--json", "--events", "--follow"]),
  cancel: new Set(["--yes"]),
  attach: new Set(["--json"]),
}
const ALIASES: Readonly<Record<string, string>> = { "-p": "--profile", "-f": "--follow", "-y": "--yes", "-h": "--help" }

function parseJobArgs(command: JobCommandName, argv: readonly string[]): JobArgs | string {
  const positional: string[] = []
  const values = new Map<string, string>()
  const bools = new Set<string>()
  let optionsEnded = false
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!
    if (optionsEnded) {
      positional.push(raw)
      continue
    }
    if (raw === "--") {
      optionsEnded = true
      continue
    }
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1
    const given = eq > 0 ? raw.slice(0, eq) : raw
    const name = ALIASES[given] ?? given
    if (name === "--help") {
      bools.add("--help")
    } else if (VALUE_FLAGS[command].has(name)) {
      const value = eq > 0 ? raw.slice(eq + 1) : argv[++index]
      if (value === undefined || value === "") return needsValue(name, command)
      values.set(name, value)
    } else if (BOOL_FLAGS[command].has(name) && eq < 0) {
      bools.add(name)
    } else if (raw.startsWith("-") && raw !== "-") {
      return unknownFlag(sanitizeForTerminal(raw), command)
    } else {
      positional.push(raw)
    }
  }
  let limit: number | undefined
  const rawLimit = values.get("--limit")
  if (rawLimit !== undefined) {
    limit = Number(rawLimit)
    if (!/^\d+$/.test(rawLimit) || limit < 1 || limit > MAX_LIST_LIMIT) return `--limit needs a whole number from 1 to ${MAX_LIST_LIMIT}: aibr ${command} --limit <count>`
  }
  const profile = values.get("--profile")
  if (profile !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(profile)) {
    return "Invalid profile name (use alphanumeric and hyphens, 1-64 chars)"
  }
  const parsed: JobArgs = {
    positional,
    profile,
    node: values.get("--node"),
    status: values.get("--status"),
    limit,
    json: bools.has("--json"),
    allNodes: bools.has("--all-nodes"),
    watch: bools.has("--watch"),
    events: bools.has("--events") || bools.has("--follow") || command === "attach",
    follow: bools.has("--follow") || command === "attach",
    yes: bools.has("--yes"),
    help: bools.has("--help"),
  }
  if (parsed.allNodes && parsed.node !== undefined) return "--all-nodes and --node cannot be combined"
  return parsed
}

// ── talking to a node ───────────────────────────────────────────────────

class JobCliError extends Error {}

/** The profile every mode uses: `--profile`, else "default", as `aibr approve` does. */
function profileOf(args: JobArgs): string {
  return args.profile ?? "default"
}

async function call(target: JobTarget, method: "GET" | "POST", path: string, signal?: AbortSignal): Promise<JobResponse> {
  try {
    return await target.request(method, path, signal)
  } catch (error) {
    throw new JobCliError(error instanceof Error ? error.message : `request to ${target.label} failed`)
  }
}

function text(value: unknown, fallback = "?"): string {
  return sanitizeForTerminal(typeof value === "string" ? value : typeof value === "number" ? String(value) : fallback)
}

/** What a non-success answer of the job API means to the person at the terminal. */
function explain(response: JobResponse, target: JobTarget, action: "list" | "show" | "events" | "cancel", jobId?: string): string {
  const { status, body } = response
  const code = typeof body.code === "string" ? body.code : undefined
  const message = typeof body.error === "string" ? sanitizeForTerminal(body.error) : `HTTP ${status}`
  const where = target.kind === "peer" ? ` on ${target.label}` : ""
  const subject = jobId === undefined ? "jobs" : `job ${sanitizeForTerminal(jobId)}`
  if (status === 404) {
    return `${subject === "jobs" ? "The job API" : `Job ${sanitizeForTerminal(jobId ?? "")}`} was not found${where || " on this node"}.${
      jobId === undefined && target.kind === "peer" ? " The peer may run an older aibr without GET /jobs." : ""
    }`
  }
  if (status === 403) {
    if (code === "requester_identity_required") {
      return `${target.label} cannot tell which jobs are yours: this request carried no node signature it accepts. Pair this node with ${target.label} (aibr enroll) and have its operator set security.request_signing to "optional" or "required". (${message})`
    }
    if (code === "not_job_requester") {
      return `Job ${text(jobId)} was not dispatched by this node, so ${target.label} will not ${action === "cancel" ? "cancel" : "show"} it. Only the node that dispatched a job, or that node's operator, can.`
    }
    if (target.kind === "operator") {
      return `The bridge refused the operator credential (403): ${message}. Run this on the node that runs the bridge, with its operator token.`
    }
    return `Denied by ${target.label} (403): ${message}`
  }
  if (status === 401) {
    if (target.kind === "operator") {
      return "The bridge rejected the operator token (401). Check AIBRIDGE_OPERATOR_TOKEN or the profile's secrets/operator_token."
    }
    return /sign|pair|enrol/i.test(message)
      ? `${target.label} requires a signed request from a paired node (401): ${message} Pair with: aibr enroll join <code>`
      : `${target.label} rejected this node's bearer token (401). The shared token may be out of date; pair again with aibr enroll.`
  }
  if (status === 429) return `${message}. Try again shortly.`
  return `${action} failed${where} (HTTP ${status}): ${message}`
}

// ── list ────────────────────────────────────────────────────────────────

interface JobRow {
  readonly node: string
  readonly job_id: string
  readonly status: string
  readonly capability: string
  readonly source_agent_id: string
  readonly created_at: string
  readonly updated_at: string
  readonly error?: string
  readonly final: boolean
}

function rowsOf(node: string, body: Record<string, unknown>): JobRow[] {
  const jobs = Array.isArray(body.jobs) ? body.jobs : []
  const rows: JobRow[] = []
  for (const raw of jobs) {
    if (raw === null || typeof raw !== "object") continue
    const job = raw as Record<string, unknown>
    if (typeof job.job_id !== "string") continue
    rows.push({
      node,
      job_id: job.job_id,
      status: typeof job.status === "string" ? job.status : "unknown",
      capability: typeof job.capability === "string" ? job.capability : "",
      source_agent_id: typeof job.source_agent_id === "string" ? job.source_agent_id : "",
      created_at: typeof job.created_at === "string" ? job.created_at : "",
      updated_at: typeof job.updated_at === "string" ? job.updated_at : "",
      ...(typeof job.error === "string" ? { error: job.error } : {}),
      final: job.final === true,
    })
  }
  return rows
}

function shortTime(iso: string): string {
  return iso === "" ? "-" : iso.replace("T", " ").replace(/\.\d+Z$/, "Z")
}

function newestFirst(left: JobRow, right: JobRow): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1
  return left.job_id < right.job_id ? 1 : left.job_id > right.job_id ? -1 : 0
}

function renderTable(rows: readonly JobRow[], showNode: boolean): string {
  const header = [...(showNode ? ["NODE"] : []), "JOB", "STATUS", "CAPABILITY", "SOURCE", "UPDATED"]
  const body = rows.map((row) => [
    ...(showNode ? [text(row.node)] : []),
    text(row.job_id),
    text(row.status),
    text(row.capability, "-"),
    text(row.source_agent_id, "-"),
    text(shortTime(row.updated_at)),
  ])
  const widths = header.map((title, column) => Math.max(title.length, ...body.map((line) => line[column]!.length)))
  const format = (cells: readonly string[]): string => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()
  return `${[format(header), ...body.map(format)].join("\n")}\n`
}

interface Listing {
  readonly rows: readonly JobRow[]
  /** Peers that did not answer: `[node, why]`. */
  readonly failures: readonly (readonly [string, string])[]
}

async function listFrom(target: JobTarget, args: JobArgs, signal?: AbortSignal): Promise<JobRow[]> {
  const query = new URLSearchParams()
  if (args.status !== undefined) query.set("status", args.status)
  if (args.limit !== undefined) query.set("limit", String(args.limit))
  const response = await call(target, "GET", `/jobs${query.toString() !== "" ? `?${query}` : ""}`, signal)
  if (response.status !== 200) throw new JobCliError(explain(response, target, "list"))
  return rowsOf(target.label, response.body)
}

/** One listing of this node, one peer, or every peer. Throws when nothing could be listed. */
async function listing(args: JobArgs, deps: JobCliDeps, signal?: AbortSignal): Promise<Listing> {
  if (!args.allNodes) {
    const target = args.node !== undefined ? await deps.peer(profileOf(args), args.node) : await deps.local(profileOf(args))
    return { rows: await listFrom(target, args, signal), failures: [] }
  }
  const peers = await deps.peers(profileOf(args))
  if (peers.length === 0) throw new JobCliError("This profile has no peers in agents[]. Pair one with: aibr enroll join <code>")
  const answers = await Promise.all(
    peers.map(async (peer): Promise<{ rows: JobRow[] } | { failure: readonly [string, string] }> => {
      try {
        return { rows: await listFrom(peer, args, signal) }
      } catch (error) {
        return { failure: [peer.label, error instanceof Error ? error.message : "failed"] }
      }
    }),
  )
  const rows: JobRow[] = []
  const failures: Array<readonly [string, string]> = []
  for (const answer of answers) {
    if ("rows" in answer) rows.push(...answer.rows)
    else failures.push(answer.failure)
  }
  if (peers.length > 0 && failures.length === peers.length) {
    throw new JobCliError(failures.map(([node, why]) => `${text(node)}: ${why}`).join("\n"))
  }
  return { rows: rows.sort(newestFirst).slice(0, args.limit ?? 50), failures }
}

const failureLine = ([node, why]: readonly [string, string]): string => `${text(node)}: ${sanitizeForTerminal(why)}`

async function runList(args: JobArgs, deps: JobCliDeps): Promise<number> {
  if (args.positional.length > 0) {
    deps.writer(`Error: unexpected argument ${sanitizeForTerminal(args.positional[0]!)} (aibr jobs pending lists jobs awaiting approval)\n`)
    return 64
  }
  if (args.watch) return runWatch(args, deps)
  let result: Listing
  try {
    result = await listing(args, deps)
  } catch (error) {
    deps.writer(`Error: ${error instanceof Error ? error.message : "jobs failed"}\n`)
    return 1
  }
  if (args.json) {
    deps.writer(
      `${JSON.stringify({
        jobs: result.rows,
        ...(args.allNodes ? { errors: result.failures.map(([node, error]) => ({ node, error })) } : {}),
      })}\n`,
    )
    return 0
  }
  for (const failure of result.failures) deps.writer(`${failureLine(failure)}\n`)
  if (result.rows.length === 0) {
    deps.writer(`No jobs${args.status !== undefined ? ` with status ${text(args.status)}` : ""}.\n`)
    return 0
  }
  deps.writer(renderTable(result.rows, args.allNodes))
  return 0
}

async function runWatch(args: JobArgs, deps: JobCliDeps): Promise<number> {
  const interrupt = deps.interrupt()
  const { signal } = interrupt
  const redraw = deps.isOutputTTY && !args.json
  const seen = new Map<string, string>()
  const reportedFailures = new Map<string, string>()
  let lastError: string | undefined
  let first = true
  const stamp = (): string => deps.now().toISOString()
  try {
    while (!signal.aborted) {
      let result: Listing | undefined
      try {
        result = await listing(args, deps, signal)
        lastError = undefined
      } catch (error) {
        if (signal.aborted) return 0
        const message = error instanceof Error ? error.message : "poll failed"
        if (first) {
          deps.writer(`Error: ${message}\n`)
          return 1
        }
        if (message !== lastError) deps.writer(`${stamp()} poll failed: ${message}\n`)
        lastError = message
      }
      if (result !== undefined) {
        if (redraw) {
          deps.writer(
            `${CLEAR_SCREEN}${result.failures.map((failure) => `${failureLine(failure)}\n`).join("")}${
              result.rows.length === 0 ? "No jobs.\n" : renderTable(result.rows, args.allNodes)
            }(every ${WATCH_INTERVAL_MS / 1000}s; Ctrl-C to stop)\n`,
          )
        } else {
          for (const failure of result.failures) {
            if (reportedFailures.get(failure[0]) === failure[1]) continue
            reportedFailures.set(failure[0], failure[1])
            deps.writer(args.json ? `${JSON.stringify({ at: stamp(), node: failure[0], error: failure[1] })}\n` : `${stamp()} ${failureLine(failure)}\n`)
          }
          for (const peer of [...reportedFailures.keys()]) {
            if (!result.failures.some(([node]) => node === peer)) reportedFailures.delete(peer)
          }
          for (const row of [...result.rows].reverse()) {
            const key = `${row.node}\u0000${row.job_id}`
            if (seen.get(key) === row.status) continue
            seen.set(key, row.status)
            deps.writer(
              args.json
                ? `${JSON.stringify({ at: stamp(), ...row })}\n`
                : `${stamp()} ${args.allNodes ? `${text(row.node)} ` : ""}${text(row.job_id)} ${text(row.status)} ${text(row.capability, "-")}\n`,
            )
          }
        }
        first = false
      }
      await deps.sleep(WATCH_INTERVAL_MS, signal)
    }
    return 0
  } finally {
    interrupt.dispose()
  }
}

// ── job, events, attach ─────────────────────────────────────────────────

async function targetFor(args: JobArgs, deps: JobCliDeps): Promise<JobTarget> {
  return args.node !== undefined ? deps.peer(profileOf(args), args.node) : deps.local(profileOf(args))
}

function eventLine(event: Record<string, unknown>): string {
  const data = event.data !== null && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {}
  const parts: string[] = []
  for (const key of ["status", "outcome", "detail", "summary", "error"]) {
    const value = data[key]
    if (typeof value === "string" && value !== "") parts.push(key === "error" ? `error: ${value}` : value)
  }
  const shown = parts.length > 0 ? parts.join(" — ") : JSON.stringify(data)
  const clipped = shown.length > 600 ? `${shown.slice(0, 600)}… (${shown.length - 600} more characters)` : shown
  return `${text(event.at, "")} ${text(event.type, "event").padEnd(7)} ${sanitizeForTerminal(clipped).replace(/\n/g, "\n    ")}\n`
}

async function runEvents(target: JobTarget, jobId: string, args: JobArgs, deps: JobCliDeps): Promise<number> {
  const encoded = encodeURIComponent(jobId)
  const interrupt = args.follow ? deps.interrupt() : undefined
  let after = 0
  let failures = 0
  let noted = false
  try {
    for (;;) {
      let response: JobResponse
      try {
        response = await call(target, "GET", `/jobs/${encoded}/events?after=${after}&limit=${EVENTS_PAGE}`, interrupt?.signal)
        failures = 0
      } catch (error) {
        if (interrupt?.signal.aborted === true) return 0
        failures += 1
        if (!args.follow || failures >= 3) {
          deps.writer(`Error: ${error instanceof Error ? error.message : "events failed"}${after > 0 ? ` (read up to event ${after})` : ""}\n`)
          return 1
        }
        await deps.sleep(FOLLOW_INTERVAL_MS, interrupt!.signal)
        if (interrupt!.signal.aborted) return 0
        continue
      }
      if (response.status !== 200) {
        deps.writer(`Error: ${explain(response, target, "events", jobId)}\n`)
        return 1
      }
      const page = Array.isArray(response.body.events) ? (response.body.events as Record<string, unknown>[]) : []
      for (const event of page) deps.writer(args.json ? `${JSON.stringify(event)}\n` : eventLine(event))
      const next = typeof response.body.next === "number" ? response.body.next : after
      if (page.length > 0 && next <= after) {
        deps.writer(`Error: ${text(target.label)} returned events without advancing its position (next ${next}, after ${after}); stopping.\n`)
        return 1
      }
      after = next
      if (page.length >= EVENTS_PAGE) continue
      if (!args.follow) return 0
      if (response.body.final === true) {
        if (!args.json) deps.writer(`Job ${text(jobId)} ended: ${text(response.body.status)}\n`)
        return 0
      }
      if (response.body.status === "awaiting_approval" && !noted && !args.json) {
        noted = true
        deps.writer(`Job ${text(jobId)} is awaiting operator approval${target.kind === "peer" ? ` on ${text(target.label)}` : ""}; nothing runs until aibr approve or aibr reject.\n`)
      }
      await deps.sleep(FOLLOW_INTERVAL_MS, interrupt!.signal)
      if (interrupt!.signal.aborted) return 0
    }
  } finally {
    interrupt?.dispose()
  }
}

function renderJob(job: Record<string, unknown>): string {
  const extras: string[] = []
  if (typeof job.createdAt === "string") extras.push(`  created:    ${text(job.createdAt)}`)
  if (typeof job.updatedAt === "string") extras.push(`  updated:    ${text(job.updatedAt)}`)
  if (typeof job.error === "string") extras.push(`  error:      ${text(job.error)}`)
  if (typeof job.summary === "string") {
    const summary = text(job.summary)
    extras.push(`  summary:    ${summary.length > 2_000 ? `${summary.slice(0, 2_000)}… (${summary.length - 2_000} more characters)` : summary}`)
  }
  return `${[describeJob(job).trimEnd(), ...extras].join("\n")}\n`
}

async function runJob(command: "job" | "attach", args: JobArgs, deps: JobCliDeps): Promise<number> {
  const [jobId, extra] = args.positional
  if (jobId === undefined || extra !== undefined) {
    deps.writer(`Error: usage: aibr ${command} <job_id>${command === "job" ? " [--events] [-f]" : ""} [--node <peer>] [--profile <name>]\n`)
    return 64
  }
  let target: JobTarget
  try {
    target = await targetFor(args, deps)
    if (args.events) return await runEvents(target, jobId, args, deps)
    const response = await call(target, "GET", `/jobs/${encodeURIComponent(jobId)}`)
    if (response.status !== 200) {
      deps.writer(`Error: ${explain(response, target, "show", jobId)}\n`)
      return 1
    }
    deps.writer(args.json ? `${JSON.stringify(response.body)}\n` : renderJob(response.body))
    return 0
  } catch (error) {
    deps.writer(`Error: ${error instanceof Error ? error.message : `${command} failed`}\n`)
    return 1
  }
}

// ── cancel ──────────────────────────────────────────────────────────────

async function runCancel(args: JobArgs, deps: JobCliDeps): Promise<number> {
  const [jobId, extra] = args.positional
  if (jobId === undefined || extra !== undefined) {
    deps.writer("Error: usage: aibr cancel <job_id> [--yes] [--node <peer>] [--profile <name>]\n")
    return 64
  }
  const shown = sanitizeForTerminal(jobId)
  if (!args.yes && !deps.isInputTTY) {
    deps.writer("Nothing changed: aibr cancel asks first and there is no terminal to ask on; pass --yes to cancel without asking.\n")
    return 1
  }
  try {
    const target = await targetFor(args, deps)
    const where = target.kind === "peer" ? ` on ${text(target.label)}` : ""
    if (!args.yes && !(await deps.confirm(`Cancel job ${shown}${where}? It ends as failed and its requester is notified.`))) {
      deps.writer("Nothing changed.\n")
      return 1
    }
    const response = await call(target, "POST", `/jobs/${encodeURIComponent(jobId)}/cancel`)
    const { status, body } = response
    const code = typeof body.code === "string" ? body.code : undefined
    if (status === 200) {
      deps.writer(`Cancelled ${shown}${where}: ${text(body.status, "failed")}${typeof body.error === "string" ? ` (${text(body.error)})` : ""}\n`)
      return 0
    }
    if (status === 202) {
      deps.writer(`Stopping ${shown}${where}: the job is being stopped (status ${text(body.status)}). Follow it with: aibr job ${shown} -f${target.kind === "peer" ? ` --node ${text(target.label)}` : ""}\n`)
      return 0
    }
    if (status === 409) {
      if (code === "awaiting_approval") {
        deps.writer(
          target.kind === "peer"
            ? `Error: job ${shown} is awaiting operator approval${where} and has not started, so there is nothing to cancel. The operator there rejects it with: aibr reject ${shown}\n`
            : `Error: job ${shown} is awaiting operator approval and has not started, so there is nothing to cancel. Reject it with: aibr reject ${shown}\n`,
        )
      } else if (code === "cancel_in_progress") {
        deps.writer(`Error: a cancel of job ${shown} is already in progress. Wait for it with: aibr job ${shown} -f\n`)
      } else {
        deps.writer(
          `Error: job ${shown} has already ended${where} (status ${text(body.status)}${typeof body.job_error === "string" ? `: ${text(body.job_error)}` : ""}); nothing to cancel.\n`,
        )
      }
      return 1
    }
    deps.writer(`Error: ${explain(response, target, "cancel", jobId)}\n`)
    return 1
  } catch (error) {
    deps.writer(`Error: ${error instanceof Error ? error.message : "cancel failed"}\n`)
    return 1
  }
}

// ── entry point ─────────────────────────────────────────────────────────

/** `aibr jobs` (not `jobs pending`), `aibr job`, `aibr cancel`, `aibr attach`. */
export async function runJobCommand(command: JobCommandName, argv: readonly string[], deps: JobCliDeps): Promise<number> {
  const parsed = parseJobArgs(command, argv)
  if (typeof parsed === "string") {
    deps.writer(`Error: ${parsed}\n`)
    return 64
  }
  if (parsed.help) {
    deps.writer(HELP[command])
    return 0
  }
  switch (command) {
    case "jobs":
      return runList(parsed, deps)
    case "job":
    case "attach":
      return runJob(command, parsed, deps)
    case "cancel":
      return runCancel(parsed, deps)
  }
}

// ── real dependencies ───────────────────────────────────────────────────

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

/** A peer of the profile as a target: the peer's bearer token plus this node's signature. */
export function signedPeerTarget(loaded: LoadedProfile, peer: { readonly id: string; readonly url: string }, toolDeps: BridgeToolDeps): JobTarget {
  return {
    label: peer.id,
    kind: "peer",
    request: async (method, path, signal) => {
      const url = `${peer.url.replace(/\/+$/, "")}${path}`
      const headers: Record<string, string> = { accept: "application/json" }
      const secrets: string[] = []
      const redact = (message: string): string => {
        let out = message
        for (const secret of secrets) out = out.split(secret).join("[redacted]")
        return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      }
      if (loaded.config.security.auth_mode !== "none") {
        try {
          const token = (await toolDeps.readFile(join(loaded.paths.secretsDir, "bearer_token"))).trim()
          if (token !== "") {
            headers.authorization = `Bearer ${token}`
            secrets.push(token)
          }
        } catch {
          // a per-peer token from `aibr enroll join` replaces it below; without either the peer answers 401
        }
      }
      const prepared = await prepareSignedRequest(loaded, url, { method, headers }, toolDeps)
      secrets.push(...prepared.secrets)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PEER_TIMEOUT_MS)
      try {
        const response = await toolDeps.fetch(url, {
          ...prepared.init,
          signal: signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]),
        })
        let body: Record<string, unknown> = {}
        try {
          const value: unknown = await response.json()
          if (value !== null && typeof value === "object") body = value as Record<string, unknown>
        } catch {
          // non-JSON body
        }
        return { status: response.status, body }
      } catch (error) {
        const why = controller.signal.aborted ? "timed out" : signal?.aborted === true ? "interrupted" : error instanceof Error ? redact(error.message) : "request failed"
        throw new Error(`${peer.id} is not reachable: ${why}`)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export function realJobDeps(
  writer: (text: string) => void,
  toolDeps: BridgeToolDeps = defaultBridgeToolDeps(),
  /** Overridable for tests: the environment the operator token is read from, and the fetch that reaches the local bridge. */
  local: { readonly env?: Readonly<Record<string, string | undefined>>; readonly fetch?: typeof fetch } = {},
): JobCliDeps {
  const operator = realOperatorDeps(writer)
  const localFetch = local.fetch ?? ((input, init) => fetch(input, init))
  const load = (profile: string | undefined): Promise<LoadedProfile> => new BridgeTools(toolDeps, profile).loadProfile()
  return {
    writer,
    confirm: confirmOnTerminal,
    isInputTTY: process.stdin.isTTY === true,
    isOutputTTY: process.stdout.isTTY === true,
    now: () => new Date(),
    sleep: abortableSleep,
    interrupt: () => {
      const controller = new AbortController()
      // The first Ctrl-C stops the loop and any request in flight; a second one exits at once.
      const onSigint = (): void => {
        if (controller.signal.aborted) process.exit(130)
        controller.abort()
      }
      process.on("SIGINT", onSigint)
      return { signal: controller.signal, dispose: () => process.off("SIGINT", onSigint) }
    },
    local: async (profile) => {
      const endpoint = await loadOperatorEndpoint(profile, local.env)
      return {
        label: "local",
        kind: "operator",
        request: async (method, path, signal) => {
          const timeout = AbortSignal.timeout(PEER_TIMEOUT_MS)
          const bounded = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
          const response = await operatorRequest({ ...operator, fetch: (input, init) => localFetch(input, { ...init, signal: bounded }) }, endpoint, method, path)
          return { status: response.status, body: response.body }
        },
      }
    },
    peer: async (profile, node) => {
      const loaded = await load(profile)
      const peer = loaded.config.agents.find((agent) => agent.id === node)
      if (peer === undefined) {
        const known = loaded.config.agents.map((agent) => agent.id).join(", ") || "none"
        throw new Error(`Unknown peer "${sanitizeForTerminal(node)}". Peers of profile "${loaded.name}": ${known}.`)
      }
      return signedPeerTarget(loaded, peer, toolDeps)
    },
    peers: async (profile) => {
      const loaded = await load(profile)
      return loaded.config.agents.map((peer) => signedPeerTarget(loaded, peer, toolDeps))
    },
  }
}

/** Registration seam for `src/cli.ts`, like `runOperatorCommand`. */
export function runRealJobCommand(writer: (text: string) => void): (command: JobCommandName, args: readonly string[]) => Promise<number> {
  return (command, args) => runJobCommand(command, args, realJobDeps(writer))
}

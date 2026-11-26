/**
 * The job API for requesters and the operator (v3.2.0 block B):
 *
 *   GET  /jobs               the caller's jobs, newest first (compact: no prompt, no result)
 *   GET  /jobs/:id/events    what a job did, in order: JSON pages, or SSE with Last-Event-ID
 *   POST /jobs/:id/cancel    ends one job: `failed`, "cancelled by requester" (or "by operator"), reported once
 *
 * Open SSE streams are capped (`jobEventStreamLimits`); one more answers 429.
 *
 * Who may call (`resolveJobCaller`):
 * - the OPERATOR credential, under the same rules as `aibr approve`
 *   (`authorizeOperatorRequest`, including `approval_from_loopback_only`):
 *   every job on this node;
 * - a PEER holding the bearer AND a verified node signature (ADR 0012): only
 *   the jobs whose `trigger.source_agent_id` is the verified agent id. The
 *   shared bearer names no caller, and an unsigned request names whoever it
 *   claims to be, so without a signature there is nothing to scope by and
 *   the request is refused (403 `requester_identity_required`), including on
 *   a node with `security.request_signing: "off"`.
 *
 * Cancel is not an approval action (ADR 0015): it only ever ends work, writes
 * nothing to the approval ledger, and is logged to the bridge log with the
 * caller. `approve`/`reject` and the node-wide kill switch stay operator-only
 * (`routes/operator.ts`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import { CANCELLED_BY_OPERATOR, CANCELLED_BY_REQUESTER, cancelJob, isTerminalStatus, type CancelOutcome } from "../../jobs/cancel.js"
import { InMemoryJobEventLog, type JobEvent, type JobEventLog, type JobEventPage } from "../../jobs/events.js"
import type { JobRecord, JobStatus } from "../../jobs/types.js"
import { requireIdentityGuard } from "../../pairing/verifier.js"
import { bearerTokenMatches, createAuthProvider } from "../../security/auth-provider.js"
import { authorizeOperatorRequest } from "../../security/operator-auth.js"
import type { AppDependencies } from "../app.js"
import { terminalReporter } from "./claude-dispatch.js"

export type JobCaller = { readonly kind: "operator" } | { readonly kind: "requester"; readonly agentId: string }

type CallerResolution =
  | { readonly ok: true; readonly caller: JobCaller }
  | { readonly ok: false; readonly status: number; readonly body: Record<string, unknown> }

const JOB_STATUSES = [
  "received",
  "accepted",
  "awaiting_approval",
  "blocked",
  "session_created",
  "running",
  "reporting",
  "completed",
  "failed",
  "timed_out",
  "callback_failed",
] as const satisfies readonly JobStatus[]

export const DEFAULT_JOB_LIST_LIMIT = 50
export const MAX_JOB_LIST_LIMIT = 200
export const DEFAULT_JOB_EVENTS_LIMIT = 100
export const MAX_JOB_EVENTS_LIMIT = 500
const DEFAULT_EVENT_POLL_MS = 1_000
const SSE_HEARTBEAT_MS = 15_000

const listQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_JOB_LIST_LIMIT).optional(),
  before: z.string().min(1).max(512).optional(),
})

const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_JOB_EVENTS_LIMIT).optional(),
})

/** One line of `GET /jobs`: what a list needs, never the prompt or the runtime result. */
export function jobListView(job: JobRecord): Record<string, unknown> {
  return {
    job_id: job.id,
    status: job.status,
    capability: job.trigger.capability,
    source_agent_id: job.trigger.source_agent_id,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    ...(job.launchStartedAt !== undefined ? { launch_started_at: job.launchStartedAt } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
    awaiting_approval: job.status === "awaiting_approval",
    final: isTerminalStatus(job.status),
  }
}

interface ListCursor {
  readonly createdAt: string
  /** Absent for a bare timestamp: every job created strictly before it. */
  readonly id?: string
}

/** The opaque `before` for the job after `job` in newest-first order. */
export function encodeJobCursor(job: Pick<JobRecord, "createdAt" | "id">): string {
  return Buffer.from(JSON.stringify([job.createdAt, job.id]), "utf8").toString("base64url")
}

/** Accepts a cursor from `next_before`, or a plain ISO timestamp. */
export function decodeJobCursor(raw: string): ListCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { createdAt: parsed[0], id: parsed[1] }
    }
  } catch {
    // not a cursor; maybe a timestamp
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return undefined
  const time = Date.parse(raw)
  return Number.isNaN(time) ? undefined : { createdAt: new Date(time).toISOString() }
}

/** Newest first; ties on `createdAt` broken by id, so a page boundary is stable. */
function newestFirst(left: JobRecord, right: JobRecord): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
}

function isBefore(job: JobRecord, cursor: ListCursor): boolean {
  if (job.createdAt !== cursor.createdAt) return job.createdAt < cursor.createdAt
  return cursor.id !== undefined && job.id < cursor.id
}

/**
 * Pages a job list: `status` filter, newest first, `limit` jobs strictly
 * after the `before` cursor. `next_before` is set when more jobs follow.
 */
export function pageJobs(
  jobs: readonly JobRecord[],
  query: { readonly status?: JobStatus; readonly limit?: number; readonly before?: ListCursor },
): { readonly jobs: JobRecord[]; readonly nextBefore: string | null } {
  const limit = query.limit ?? DEFAULT_JOB_LIST_LIMIT
  const candidates = jobs
    .filter((job) => query.status === undefined || job.status === query.status)
    .filter((job) => query.before === undefined || isBefore(job, query.before))
    .sort(newestFirst)
  const page = candidates.slice(0, limit)
  const last = page.at(-1)
  return { jobs: page, nextBefore: candidates.length > limit && last !== undefined ? encodeJobCursor(last) : null }
}

export function registerJobApiRoutes(app: FastifyInstance, dependencies: AppDependencies): void {
  // Built at registration, as on `/trigger`: a misconfigured profile fails when the app is built.
  const auth = createAuthProvider(dependencies.config.security.auth_mode, dependencies.bearerToken)
  const identity = requireIdentityGuard(dependencies.config.security.request_signing, dependencies.requestIdentity)
  const events: JobEventLog = dependencies.jobEvents ?? dependencies.jobManager.eventLog ?? new InMemoryJobEventLog()
  const pollMs = dependencies.jobEventPollMs ?? DEFAULT_EVENT_POLL_MS
  const report = terminalReporter(dependencies)
  /** Job ids with a cancel in flight: a second concurrent cancel answers 409 instead of waiting. */
  const cancelling = new Set<string>()
  /** Open SSE streams, ended before the server closes so a follower never holds up `aibr stop`. */
  const streams = new Set<() => void>()
  app.addHook("preClose", async () => {
    for (const end of streams) end()
  })
  const streamSlots = new StreamSlots({ ...DEFAULT_STREAM_LIMITS, ...dependencies.jobEventStreamLimits })

  const resolveJobCaller = async (request: FastifyRequest): Promise<CallerResolution> => {
    const authorization = request.headers.authorization
    const operatorToken = dependencies.operatorToken ?? null
    if (operatorToken !== null && operatorToken.length > 0 && bearerTokenMatches(authorization, operatorToken)) {
      const decision = authorizeOperatorRequest(
        {
          config: dependencies.config,
          operatorToken,
          ...(dependencies.localAddresses !== undefined ? { localAddresses: dependencies.localAddresses } : {}),
        },
        request,
      )
      return decision.ok ? { ok: true, caller: { kind: "operator" } } : { ok: false, status: decision.statusCode, body: decision.body }
    }
    if (!auth.validate(authorization)) return { ok: false, status: 401, body: { error: "Unauthorized" } }
    if (identity !== undefined) {
      const verified = await identity.check(request, undefined)
      if (!verified.ok) return { ok: false, status: verified.status, body: verified.body }
      if (verified.agentId !== null) return { ok: true, caller: { kind: "requester", agentId: verified.agentId } }
    }
    return {
      ok: false,
      status: 403,
      body: {
        error:
          "Listing, following or cancelling jobs needs a verified node signature (security.request_signing \"optional\" or \"required\", ADR 0012) " +
          "so this node can tell which jobs are the caller's; this request carried none. Pair with `aibr enroll`, or use the operator credential on this node.",
        code: "requester_identity_required",
      },
    }
  }

  /** The job, if the caller may see it; otherwise the reply already sent. */
  const loadOwnJob = async (
    caller: JobCaller,
    jobId: string,
    reply: FastifyReply,
  ): Promise<{ readonly job: JobRecord } | { readonly sent: FastifyReply }> => {
    let job: JobRecord
    try {
      job = await dependencies.jobManager.getJob(jobId)
    } catch {
      return { sent: reply.code(404).send({ error: "Job not found" }) }
    }
    if (caller.kind === "requester" && job.trigger.source_agent_id !== caller.agentId) {
      return { sent: reply.code(403).send({ error: "This job was not dispatched by the caller", code: "not_job_requester" }) }
    }
    return { job }
  }

  app.get("/jobs", async (request, reply) => {
    const resolved = await resolveJobCaller(request)
    if (!resolved.ok) return reply.code(resolved.status).send(resolved.body)
    const query = listQuerySchema.safeParse(request.query ?? {})
    if (!query.success) return reply.code(400).send({ error: "Invalid query", details: query.error.issues })
    let before: ListCursor | undefined
    if (query.data.before !== undefined) {
      before = decodeJobCursor(query.data.before)
      if (before === undefined) return reply.code(400).send({ error: "Invalid before cursor", code: "invalid_cursor" })
    }
    const caller = resolved.caller
    const visible = (await dependencies.jobManager.listJobs()).filter(
      (job) => caller.kind === "operator" || job.trigger.source_agent_id === caller.agentId,
    )
    const page = pageJobs(visible, {
      ...(query.data.status !== undefined ? { status: query.data.status } : {}),
      ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
      ...(before !== undefined ? { before } : {}),
    })
    return { jobs: page.jobs.map(jobListView), next_before: page.nextBefore }
  })

  app.get<{ Params: { id: string } }>("/jobs/:id/events", async (request, reply) => {
    const resolved = await resolveJobCaller(request)
    if (!resolved.ok) return reply.code(resolved.status).send(resolved.body)
    const query = eventsQuerySchema.safeParse(request.query ?? {})
    if (!query.success) return reply.code(400).send({ error: "Invalid query", details: query.error.issues })
    const loaded = await loadOwnJob(resolved.caller, request.params.id, reply)
    if ("sent" in loaded) return loaded.sent
    const jobId = loaded.job.id
    const limit = query.data.limit ?? DEFAULT_JOB_EVENTS_LIMIT
    let after = query.data.after ?? 0

    if (!acceptsEventStream(request)) {
      // The job first: if it ends between the two reads, its terminal event
      // is in the page or `final` stays false; never `final` on a page that
      // misses the job's last events.
      const job = await dependencies.jobManager.getJob(jobId).catch(() => loaded.job)
      const page = await events.read(jobId, after, limit)
      const final = isTerminalStatus(job.status) && (await pageIsFinal(events, jobId, page, limit))
      return { job_id: jobId, status: job.status, final, events: page.events, next: page.next }
    }

    // SSE: resumes after `Last-Event-ID` (the `seq` of the last event seen).
    const lastEventId = Number.parseInt(String(request.headers["last-event-id"] ?? ""), 10)
    if (Number.isInteger(lastEventId) && lastEventId >= 0) after = lastEventId
    const callerKey = resolved.caller.kind === "operator" ? "operator" : `requester:${resolved.caller.agentId}`
    const refusal = streamSlots.acquire(callerKey, jobId)
    if (refusal !== undefined) return reply.code(429).send({ error: refusal, code: "too_many_streams" })
    try {
      await streamJobEvents({ jobId, after, events, dependencies, reply, pollMs, streams })
    } finally {
      streamSlots.release(callerKey, jobId)
    }
    return reply
  })

  app.post<{ Params: { id: string } }>("/jobs/:id/cancel", async (request, reply) => {
    const resolved = await resolveJobCaller(request)
    if (!resolved.ok) return reply.code(resolved.status).send(resolved.body)
    const caller = resolved.caller
    const loaded = await loadOwnJob(caller, request.params.id, reply)
    if ("sent" in loaded) return loaded.sent
    const jobId = loaded.job.id
    if (cancelling.has(jobId)) {
      return reply.code(409).send({ error: "A cancel of this job is already in progress", code: "cancel_in_progress", status: loaded.job.status })
    }
    cancelling.add(jobId)
    let outcome: CancelOutcome
    try {
      outcome = await cancelJob(jobId, {
        jobManager: dependencies.jobManager,
        ...(dependencies.claudeJobRunner !== undefined ? { runner: dependencies.claudeJobRunner } : {}),
        abortOpencodeSession: (sessionId) => dependencies.opencodeClient.abortSession(sessionId),
        reportTerminalJob: report,
        reason: caller.kind === "operator" ? CANCELLED_BY_OPERATOR : CANCELLED_BY_REQUESTER,
        syncFailedTask: (job) => dependencies.taskGraphSyncer.syncJobToTask(job.trigger.task_id ?? `#${job.id}`, "failed"),
        ...(dependencies.cancelStopWaitMs !== undefined ? { stopWaitMs: dependencies.cancelStopWaitMs } : {}),
      })
    } finally {
      cancelling.delete(jobId)
    }
    // The bridge log, not the approval ledger: cancel is not an approval action.
    const who = caller.kind === "operator" ? "operator" : `requester ${caller.agentId}`
    dependencies.log?.("info", `job ${jobId} cancel by ${who}: ${outcome.kind}${"job" in outcome ? ` (status ${outcome.job.status})` : ""}`)

    switch (outcome.kind) {
      case "cancelled":
        return reply.code(200).send({ job_id: jobId, status: outcome.job.status, error: outcome.job.error ?? CANCELLED_BY_REQUESTER, cancelled: true })
      case "stopping":
        return reply.code(202).send({ job_id: jobId, status: outcome.job.status, cancelling: true })
      case "finished":
        return reply.code(409).send({
          error: `Job has already ended (status ${outcome.job.status})`,
          code: "job_finished",
          status: outcome.job.status,
          ...(outcome.job.error !== undefined ? { job_error: outcome.job.error } : {}),
        })
      case "awaiting_approval":
        return reply.code(409).send({
          error: `Job is awaiting operator approval and has not started; it cannot be cancelled. The operator on this node rejects it (aibr reject ${jobId}).`,
          code: "awaiting_approval",
          status: outcome.job.status,
        })
      case "not_found":
        return reply.code(404).send({ error: "Job not found" })
    }
  })
}

export interface JobEventStreamLimits {
  /** Open SSE streams on this bridge. */
  readonly global: number
  /** Open SSE streams per caller (the operator, or one requester). */
  readonly perCaller: number
  /** Open SSE streams per job. */
  readonly perJob: number
}

export const DEFAULT_STREAM_LIMITS: JobEventStreamLimits = { global: 64, perCaller: 8, perJob: 16 }

/** Counts open SSE streams; a stream past any limit is refused (429) before it opens. */
class StreamSlots {
  #total = 0
  readonly #byCaller = new Map<string, number>()
  readonly #byJob = new Map<string, number>()

  constructor(private readonly limits: JobEventStreamLimits) {}

  /** Takes a slot, or returns why not. */
  acquire(caller: string, jobId: string): string | undefined {
    if (this.#total >= this.limits.global) return `This node already serves ${this.limits.global} event streams; retry later or read pages instead.`
    if ((this.#byCaller.get(caller) ?? 0) >= this.limits.perCaller) {
      return `The caller already has ${this.limits.perCaller} open event streams; close one or read pages instead.`
    }
    if ((this.#byJob.get(jobId) ?? 0) >= this.limits.perJob) return `This job already has ${this.limits.perJob} open event streams.`
    this.#total += 1
    this.#byCaller.set(caller, (this.#byCaller.get(caller) ?? 0) + 1)
    this.#byJob.set(jobId, (this.#byJob.get(jobId) ?? 0) + 1)
    return undefined
  }

  release(caller: string, jobId: string): void {
    this.#total -= 1
    decrement(this.#byCaller, caller)
    decrement(this.#byJob, jobId)
  }
}

function decrement(counts: Map<string, number>, key: string): void {
  const next = (counts.get(key) ?? 1) - 1
  if (next <= 0) counts.delete(key)
  else counts.set(key, next)
}

function endsLog(event: JobEvent): boolean {
  return event.type === "truncated" || (event.type === "status" && typeof event.data.status === "string" && isTerminalStatus(event.data.status as JobStatus))
}

/**
 * Whether a page of a job already known to be terminal holds its last
 * events: the page is the tail of the log, and the log's terminal event (its
 * terminal `status`, or `truncated`) is in the page or before it. A log with
 * no status event at all (records older than the log) is final at its tail.
 */
async function pageIsFinal(events: JobEventLog, jobId: string, page: JobEventPage, limit: number): Promise<boolean> {
  if (page.events.length >= limit) return false
  if (page.events.some(endsLog)) return true
  const whole = await events.read(jobId, 0, Number.MAX_SAFE_INTEGER)
  if (whole.events.some((event) => endsLog(event) && event.seq <= page.next)) return true
  return !whole.events.some((event) => event.type === "status")
}

function acceptsEventStream(request: FastifyRequest): boolean {
  const accept = request.headers.accept
  return typeof accept === "string" && accept.toLowerCase().includes("text/event-stream")
}

/**
 * Writes the job's events as SSE (`id: <seq>`, `event: <type>`), pushes new
 * ones as they are stored (or within `pollMs`, for events written by another
 * process), and ends with `event: end` once the job is terminal and every
 * event is out: at its terminal `status` event, at a `truncated` event, or
 * after one quiet poll when the job ended without one (records older than
 * the event log).
 */
async function streamJobEvents(options: {
  readonly jobId: string
  readonly after: number
  readonly events: JobEventLog
  readonly dependencies: AppDependencies
  readonly reply: FastifyReply
  readonly pollMs: number
  /** Registry of open streams; this one adds its own `end` while it runs. */
  readonly streams: Set<() => void>
}): Promise<void> {
  const { jobId, events, dependencies, reply, pollMs } = options
  let after = options.after
  reply.hijack()
  const raw = reply.raw
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  raw.write("retry: 2000\n\n")

  let closed = false
  let wake: (() => void) | undefined
  /** An event arrived while no wait was pending: read again before waiting. */
  let pending = false
  const notify = (): void => {
    const current = wake
    wake = undefined
    if (current === undefined) pending = true
    else current()
  }
  const end = (): void => {
    closed = true
    notify()
  }
  raw.on("close", end)
  options.streams.add(end)
  const unsubscribe = events.subscribe(jobId, notify)
  const heartbeat = setInterval(() => {
    if (!closed) raw.write(": keep-alive\n\n")
  }, SSE_HEARTBEAT_MS)
  heartbeat.unref?.()

  const send = (event: JobEvent): void => {
    raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }

  try {
    let quietAfterTerminal = 0
    while (!closed) {
      pending = false
      let ended = false
      // Drain everything stored so far.
      for (;;) {
        const page = await events.read(jobId, after, MAX_JOB_EVENTS_LIMIT)
        for (const event of page.events) {
          send(event)
          if (event.type === "truncated") ended = true
          if (event.type === "status" && typeof event.data.status === "string" && isTerminalStatus(event.data.status as JobStatus)) ended = true
        }
        after = page.next
        if (page.events.length < MAX_JOB_EVENTS_LIMIT) break
      }
      if (closed) break
      const job = await dependencies.jobManager.getJob(jobId).catch(() => undefined)
      if (job === undefined || isTerminalStatus(job.status)) {
        if (ended || quietAfterTerminal >= 1 || job === undefined) {
          raw.write(`event: end\ndata: ${JSON.stringify({ job_id: jobId, status: job?.status ?? null, next: after })}\n\n`)
          break
        }
        quietAfterTerminal += 1
      }
      if (pending) continue
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined
          resolve()
        }, pollMs)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  } finally {
    clearInterval(heartbeat)
    unsubscribe()
    options.streams.delete(end)
    if (!raw.writableEnded) raw.end()
  }
}

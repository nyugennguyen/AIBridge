/**
 * The per-job event log behind `GET /jobs/:id/events` (v3.2.0 block B).
 *
 * `JobEventLog` is the seam: routes, the MCP tools and the CLI read through
 * it, and 3.3.0 replaces the file implementation with the event store
 * (ADR 0003, plan §7.4) without changing the route. The contract every
 * implementation keeps (tests in `tests/unit/jobs/job-event-log-contract.ts`):
 *
 * - `seq` starts at 1 and grows by one per stored event, per job, across
 *   restarts of the bridge;
 * - jobs are told apart by their exact id: ids that differ only in case are
 *   different jobs and never see each other's events;
 * - `read(jobId, after, limit)` returns the stored events with `seq > after`,
 *   oldest first, at most `limit`, and `next` is the `after` to pass next time
 *   (the last returned `seq`, or `after` itself when nothing was returned);
 * - every string in `data` has gone through the log's redaction before it is
 *   stored, so a reader never sees a secret the redaction recognises;
 * - a job's log is bounded: once the next event would pass the line or byte
 *   cap, one `truncated` event is stored and every later append is dropped;
 * - `subscribe` is told about each stored event, in order, in this process.
 *
 * The 3.2.0 implementation is `FileJobEventLog`: one append-only JSON-lines
 * file per job, `<jobsDir>/<sha256(id)>.events.jsonl`, next to the job
 * records. `JsonFileJobStore` loads only `*.json`, so it never mistakes it for
 * a job.
 */
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { appendFile, mkdir, open } from "node:fs/promises"
import { join } from "node:path"

export type JobEventType = "status" | "message" | "tool" | "result" | "truncated"

export interface JobEvent {
  /** The exact job id the event belongs to. */
  readonly job_id: string
  readonly seq: number
  /** ISO timestamp of the append. */
  readonly at: string
  readonly type: JobEventType
  readonly data: Readonly<Record<string, unknown>>
}

export interface JobEventInput {
  readonly type: Exclude<JobEventType, "truncated">
  readonly data: Readonly<Record<string, unknown>>
}

export interface JobEventPage {
  readonly events: readonly JobEvent[]
  /** Pass as `after` to read on. */
  readonly next: number
}

export interface JobEventLog {
  /** Stores the event (redacted) and returns it, or `undefined` when the job's log is full. Never throws for a full log. */
  append(jobId: string, event: JobEventInput): Promise<JobEvent | undefined>
  read(jobId: string, after: number, limit: number): Promise<JobEventPage>
  /** Calls `listener` for each event stored from now on; returns the unsubscribe function. */
  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void
}

/** Lines per job, the `truncated` event included. */
export const DEFAULT_MAX_EVENTS_PER_JOB = 2_000
/** Bytes per job file, the `truncated` event included. */
export const DEFAULT_MAX_BYTES_PER_JOB = 1_048_576
/** Longest string kept in an event's data, cut AFTER redaction so a cut secret leaves no prefix. */
export const MAX_EVENT_STRING_LENGTH = 4_000
/** Room kept free for the `truncated` line itself. */
const TRUNCATED_RESERVE_BYTES = 512

export interface BoundedJobEventLogOptions {
  /** Applied to every string in `data` before it is stored (`redactSecretsFromText` in production). */
  readonly redact?: (text: string) => string
  readonly maxEvents?: number
  readonly maxBytes?: number
  readonly now?: () => string
}

interface JobLogState {
  seq: number
  bytes: number
  closed: boolean
}

/** What a storage returns for one job: its events (in `seq` order) and the bytes they take. */
export interface StoredJobEvents {
  readonly events: readonly JobEvent[]
  readonly bytes: number
}

/**
 * The bounds, numbering, redaction and notification shared by every
 * implementation; subclasses store lines and load events.
 */
abstract class BoundedJobEventLog implements JobEventLog {
  readonly #redact: (text: string) => string
  readonly #maxEvents: number
  readonly #maxBytes: number
  readonly #now: () => string
  readonly #states = new Map<string, Promise<JobLogState>>()
  /** Per-job append queue: lines are numbered and written one at a time. */
  readonly #queues = new Map<string, Promise<unknown>>()
  readonly #emitter = new EventEmitter()

  constructor(options: BoundedJobEventLogOptions = {}) {
    this.#redact = options.redact ?? ((text) => text)
    this.#maxEvents = Math.max(2, options.maxEvents ?? DEFAULT_MAX_EVENTS_PER_JOB)
    this.#maxBytes = Math.max(TRUNCATED_RESERVE_BYTES * 2, options.maxBytes ?? DEFAULT_MAX_BYTES_PER_JOB)
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#emitter.setMaxListeners(0)
  }

  /** The job's stored events, only those whose `job_id` is exactly `jobId`. */
  protected abstract loadEvents(jobId: string): Promise<StoredJobEvents>
  protected abstract storeLine(jobId: string, line: string): Promise<void>

  append(jobId: string, input: JobEventInput): Promise<JobEvent | undefined> {
    const previous = this.#queues.get(jobId) ?? Promise.resolve()
    const run = previous.then(
      () => this.#append(jobId, input),
      () => this.#append(jobId, input),
    )
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    this.#queues.set(jobId, settled)
    void settled.then(() => {
      if (this.#queues.get(jobId) === settled) this.#queues.delete(jobId)
    })
    return run
  }

  async read(jobId: string, after: number, limit: number): Promise<JobEventPage> {
    const from = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0
    const count = Math.max(0, Math.floor(limit))
    const { events: all } = await this.loadEvents(jobId)
    const start = firstAfter(all, from)
    const events = all.slice(start, start + count)
    return { events, next: events.at(-1)?.seq ?? from }
  }

  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
    const channel = channelOf(jobId)
    this.#emitter.on(channel, listener)
    return () => this.#emitter.off(channel, listener)
  }

  /** How many subscribers the job has right now (diagnostics and tests). */
  subscriberCount(jobId: string): number {
    return this.#emitter.listenerCount(channelOf(jobId))
  }

  async #append(jobId: string, input: JobEventInput): Promise<JobEvent | undefined> {
    const state = await this.#state(jobId)
    if (state.closed) return undefined
    const event: JobEvent = { job_id: jobId, seq: state.seq + 1, at: this.#now(), type: input.type, data: this.#clean(input.data) }
    const line = `${JSON.stringify(event)}\n`
    const size = Buffer.byteLength(line, "utf8")
    // The last line of a full log is always the `truncated` marker.
    if (event.seq >= this.#maxEvents || state.bytes + size > this.#maxBytes - TRUNCATED_RESERVE_BYTES) {
      const marker: JobEvent = {
        job_id: jobId,
        seq: state.seq + 1,
        at: event.at,
        type: "truncated",
        data: { reason: event.seq >= this.#maxEvents ? "max_events" : "max_bytes", max_events: this.#maxEvents, max_bytes: this.#maxBytes },
      }
      const markerLine = `${JSON.stringify(marker)}\n`
      await this.storeLine(jobId, markerLine)
      state.seq = marker.seq
      state.bytes += Buffer.byteLength(markerLine, "utf8")
      state.closed = true
      this.#emitter.emit(channelOf(jobId), marker)
      return undefined
    }
    await this.storeLine(jobId, line)
    state.seq = event.seq
    state.bytes += size
    this.#emitter.emit(channelOf(jobId), event)
    return event
  }

  /** The job's numbering and size, read from storage once per process. */
  #state(jobId: string): Promise<JobLogState> {
    let state = this.#states.get(jobId)
    if (state === undefined) {
      state = this.loadEvents(jobId).then(({ events, bytes }) => ({
        seq: events.reduce((max, event) => Math.max(max, event.seq), 0),
        bytes,
        closed: events.some((event) => event.type === "truncated"),
      }))
      this.#states.set(jobId, state)
      // A failed load is retried on the next append rather than cached.
      state.catch(() => this.#states.delete(jobId))
    }
    return state
  }

  #clean(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const cleaned = cleanValue(data, this.#redact, 0)
    return cleaned !== null && typeof cleaned === "object" && !Array.isArray(cleaned) ? (cleaned as Record<string, unknown>) : {}
  }
}

function channelOf(jobId: string): string {
  return `job:${jobId}`
}

/** Index of the first event with `seq > after` (events are in `seq` order). */
function firstAfter(events: readonly JobEvent[], after: number): number {
  let low = 0
  let high = events.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (events[middle]!.seq <= after) low = middle + 1
    else high = middle
  }
  return low
}

/** Redacts, then bounds, every string; drops what JSON cannot carry. */
function cleanValue(value: unknown, redact: (text: string) => string, depth: number): unknown {
  if (typeof value === "string") {
    const redacted = redact(value)
    return redacted.length > MAX_EVENT_STRING_LENGTH ? `${redacted.slice(0, MAX_EVENT_STRING_LENGTH - 1)}…` : redacted
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "boolean" || value === null) return value
  if (depth >= 6) return null
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => cleanValue(item, redact, depth + 1))
  if (typeof value === "object" && value !== undefined) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue
      out[redact(key)] = cleanValue(item, redact, depth + 1)
    }
    return out
  }
  return null
}

const EVENT_TYPES: ReadonlySet<string> = new Set(["status", "message", "tool", "result", "truncated"])

/**
 * Parses one stored line: a whole event of `jobId`, or `undefined` (a line
 * cut by a crash, or a line of another job, which is dropped as a defence in
 * depth against two ids sharing a file).
 */
function parseLine(line: string, jobId: string): JobEvent | undefined {
  if (line.trim() === "") return undefined
  try {
    const parsed = JSON.parse(line) as Partial<JobEvent>
    if (
      parsed.job_id === jobId &&
      typeof parsed.seq === "number" &&
      typeof parsed.at === "string" &&
      typeof parsed.type === "string" &&
      EVENT_TYPES.has(parsed.type) &&
      parsed.data !== null &&
      typeof parsed.data === "object"
    ) {
      return parsed as JobEvent
    }
  } catch {
    // a partial line: skipped
  }
  return undefined
}

/**
 * The events file name of a job: always the SHA-256 of the exact id, so that
 * ids differing only in case never share a file on a case-insensitive
 * filesystem (macOS by default), and a caller-chosen id can never name a path
 * outside the jobs directory.
 */
export function jobEventsFileName(jobId: string): string {
  return `${createHash("sha256").update(jobId, "utf8").digest("hex")}.events.jsonl`
}

/** Jobs whose parsed events a `FileJobEventLog` keeps in memory (least recently read dropped first). */
const DEFAULT_CACHED_JOBS = 128

interface FileTail {
  /** Bytes of the file consumed so far (the remainder included). */
  offset: number
  /** Trailing bytes after the last newline: a line still being written, or cut by a crash. */
  remainder: Buffer
  readonly events: JobEvent[]
  /** Bytes of the whole lines read. */
  bytes: number
}

/**
 * `<directory>/<sha256(id)>.events.jsonl`, appended to; never loaded by
 * `JsonFileJobStore` (it reads `*.json` only).
 *
 * Reads are incremental: the parsed events of recently read jobs are kept
 * with the file offset they reach, and a read parses only the bytes appended
 * since (by this process or another one), so following a job costs the new
 * lines, not the whole file, on every wake.
 */
export class FileJobEventLog extends BoundedJobEventLog {
  /** Jobs whose file ended in a partial line when first loaded: the next line starts on a fresh one. */
  readonly #unterminated = new Set<string>()
  readonly #tails = new Map<string, FileTail>()
  readonly #cachedJobs: number
  /** Per-job read queue, so two readers never consume the same bytes twice. */
  readonly #reads = new Map<string, Promise<unknown>>()
  /** Jobs this instance has appended to: a remainder seen after that is a line in flight, not a crash. */
  readonly #everAppended = new Set<string>()
  #bytesRead = 0

  constructor(
    private readonly directory: string,
    options: BoundedJobEventLogOptions & { readonly cachedJobs?: number } = {},
  ) {
    super(options)
    this.#cachedJobs = Math.max(1, options.cachedJobs ?? DEFAULT_CACHED_JOBS)
  }

  pathFor(jobId: string): string {
    return join(this.directory, jobEventsFileName(jobId))
  }

  /** Total bytes read from events files by this instance (diagnostics and tests). */
  get bytesRead(): number {
    return this.#bytesRead
  }

  protected loadEvents(jobId: string): Promise<StoredJobEvents> {
    const previous = this.#reads.get(jobId) ?? Promise.resolve()
    const run = previous.then(
      () => this.#loadEvents(jobId),
      () => this.#loadEvents(jobId),
    )
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    this.#reads.set(jobId, settled)
    void settled.then(() => {
      if (this.#reads.get(jobId) === settled) this.#reads.delete(jobId)
    })
    return run
  }

  async #loadEvents(jobId: string): Promise<StoredJobEvents> {
    let tail = this.#tails.get(jobId)
    let handle
    try {
      handle = await open(this.pathFor(jobId), "r")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], bytes: 0 }
      throw error
    }
    try {
      const { size } = await handle.stat()
      // A file that shrank was replaced: start over.
      if (tail === undefined || size < tail.offset) tail = { offset: 0, remainder: Buffer.alloc(0), events: [], bytes: 0 }
      this.#remember(jobId, tail)
      if (size > tail.offset) {
        const fresh = Buffer.alloc(size - tail.offset)
        const { bytesRead } = await handle.read(fresh, 0, fresh.length, tail.offset)
        this.#bytesRead += bytesRead
        tail.offset += bytesRead
        let buffer = Buffer.concat([tail.remainder, fresh.subarray(0, bytesRead)])
        for (let newline = buffer.indexOf(0x0a); newline !== -1; newline = buffer.indexOf(0x0a)) {
          const line = buffer.subarray(0, newline)
          tail.bytes += line.length + 1
          const event = parseLine(line.toString("utf8"), jobId)
          if (event !== undefined && (tail.events.at(-1)?.seq ?? 0) < event.seq) tail.events.push(event)
          buffer = buffer.subarray(newline + 1)
        }
        tail.remainder = Buffer.from(buffer)
      }
      if (tail.remainder.length > 0 && !this.#everAppended.has(jobId)) this.#unterminated.add(jobId)
      return { events: tail.events, bytes: tail.bytes + tail.remainder.length }
    } finally {
      await handle.close()
    }
  }

  protected async storeLine(jobId: string, line: string): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const prefix = this.#unterminated.delete(jobId) ? "\n" : ""
    this.#everAppended.add(jobId)
    await appendFile(this.pathFor(jobId), `${prefix}${line}`, { encoding: "utf8", mode: 0o600 })
  }

  /** Keeps `tail` as the most recently used; drops the least recently used beyond the cap. */
  #remember(jobId: string, tail: FileTail): void {
    this.#tails.delete(jobId)
    this.#tails.set(jobId, tail)
    while (this.#tails.size > this.#cachedJobs) {
      const oldest = this.#tails.keys().next().value
      if (oldest === undefined) break
      this.#tails.delete(oldest)
    }
  }
}

/** The same contract in memory: the default when an app is built without a log (tests, embedders). */
export class InMemoryJobEventLog extends BoundedJobEventLog {
  readonly #events = new Map<string, { events: JobEvent[]; bytes: number }>()

  protected async loadEvents(jobId: string): Promise<StoredJobEvents> {
    const stored = this.#events.get(jobId)
    return stored === undefined ? { events: [], bytes: 0 } : { events: [...stored.events], bytes: stored.bytes }
  }

  protected async storeLine(jobId: string, line: string): Promise<void> {
    const stored = this.#events.get(jobId) ?? { events: [], bytes: 0 }
    const event = parseLine(line.replace(/\n$/, ""), jobId)
    if (event !== undefined) stored.events.push(event)
    stored.bytes += Buffer.byteLength(line, "utf8")
    this.#events.set(jobId, stored)
  }
}

/** Appends without letting a failure reach the caller: the event log is advisory, never a reason to fail a job. */
export async function appendJobEvent(log: JobEventLog | undefined, jobId: string, event: JobEventInput): Promise<void> {
  if (log === undefined) return
  try {
    await log.append(jobId, event)
  } catch {
    /* a lost event must not fail the job */
  }
}

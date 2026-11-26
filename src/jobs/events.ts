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
 * file per job, `<jobsDir>/<id>.events.jsonl`, next to the job records.
 * `JsonFileJobStore` loads only `*.json`, so it never mistakes it for a job.
 */
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"

export type JobEventType = "status" | "message" | "tool" | "result" | "truncated"

export interface JobEvent {
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
const TRUNCATED_RESERVE_BYTES = 256

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

/**
 * The bounds, numbering, redaction and notification shared by every
 * implementation; subclasses store and load lines.
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

  protected abstract loadLines(jobId: string): Promise<string[]>
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
    const events = parseLines(await this.loadLines(jobId))
      .filter((event) => event.seq > from)
      .slice(0, count)
    return { events, next: events.at(-1)?.seq ?? from }
  }

  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
    const channel = `job:${jobId}`
    this.#emitter.on(channel, listener)
    return () => this.#emitter.off(channel, listener)
  }

  async #append(jobId: string, input: JobEventInput): Promise<JobEvent | undefined> {
    const state = await this.#state(jobId)
    if (state.closed) return undefined
    const event: JobEvent = { seq: state.seq + 1, at: this.#now(), type: input.type, data: this.#clean(input.data) }
    const line = `${JSON.stringify(event)}\n`
    const size = Buffer.byteLength(line, "utf8")
    // The last line of a full log is always the `truncated` marker.
    if (event.seq >= this.#maxEvents || state.bytes + size > this.#maxBytes - TRUNCATED_RESERVE_BYTES) {
      const marker: JobEvent = {
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
      this.#emitter.emit(`job:${jobId}`, marker)
      return undefined
    }
    await this.storeLine(jobId, line)
    state.seq = event.seq
    state.bytes += size
    this.#emitter.emit(`job:${jobId}`, event)
    return event
  }

  /** The job's numbering and size, read from storage once per process. */
  #state(jobId: string): Promise<JobLogState> {
    let state = this.#states.get(jobId)
    if (state === undefined) {
      state = this.loadLines(jobId).then((lines) => {
        const events = parseLines(lines)
        return {
          seq: events.reduce((max, event) => Math.max(max, event.seq), 0),
          bytes: lines.reduce((sum, line) => sum + Buffer.byteLength(`${line}\n`, "utf8"), 0),
          closed: events.some((event) => event.type === "truncated"),
        }
      })
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

/** Parses stored lines, skipping any that are not whole events (a line cut by a crash). */
function parseLines(lines: readonly string[]): JobEvent[] {
  const events: JobEvent[] = []
  for (const line of lines) {
    if (line.trim() === "") continue
    try {
      const parsed = JSON.parse(line) as Partial<JobEvent>
      if (
        typeof parsed.seq === "number" &&
        typeof parsed.at === "string" &&
        typeof parsed.type === "string" &&
        EVENT_TYPES.has(parsed.type) &&
        parsed.data !== null &&
        typeof parsed.data === "object"
      ) {
        events.push(parsed as JobEvent)
      }
    } catch {
      // a partial line: skipped
    }
  }
  return events
}

/**
 * The events file name of a job. Job ids are chosen by the caller and are not
 * restricted to file-name characters, so an id that is not a plain name
 * (letters, digits, `.`, `_`, `:`, `-`, not starting with `.` or `_`) is
 * replaced by its digest: the file always lands inside the jobs directory.
 */
export function jobEventsFileName(jobId: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(jobId)) return `${jobId}.events.jsonl`
  return `_sha256-${createHash("sha256").update(jobId, "utf8").digest("hex")}.events.jsonl`
}

/** `<directory>/<id>.events.jsonl`, appended to; never loaded by `JsonFileJobStore` (it reads `*.json` only). */
export class FileJobEventLog extends BoundedJobEventLog {
  /** Jobs whose file ends in a partial line (a crash mid-append): the next line starts on a fresh one. */
  readonly #unterminated = new Set<string>()

  constructor(
    private readonly directory: string,
    options: BoundedJobEventLogOptions = {},
  ) {
    super(options)
  }

  pathFor(jobId: string): string {
    return join(this.directory, jobEventsFileName(jobId))
  }

  protected async loadLines(jobId: string): Promise<string[]> {
    let raw: string
    try {
      raw = await readFile(this.pathFor(jobId), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const lines = raw.split("\n")
    // The last element is "" after a complete final line, or a partial line.
    if (lines.at(-1) === "") lines.pop()
    else this.#unterminated.add(jobId)
    return lines
  }

  protected async storeLine(jobId: string, line: string): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const prefix = this.#unterminated.delete(jobId) ? "\n" : ""
    await appendFile(this.pathFor(jobId), `${prefix}${line}`, { encoding: "utf8", mode: 0o600 })
  }
}

/** The same contract in memory: the default when an app is built without a log (tests, embedders). */
export class InMemoryJobEventLog extends BoundedJobEventLog {
  readonly #lines = new Map<string, string[]>()

  protected async loadLines(jobId: string): Promise<string[]> {
    return [...(this.#lines.get(jobId) ?? [])]
  }

  protected async storeLine(jobId: string, line: string): Promise<void> {
    const lines = this.#lines.get(jobId) ?? []
    lines.push(line.replace(/\n$/, ""))
    this.#lines.set(jobId, lines)
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

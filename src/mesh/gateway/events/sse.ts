import { createContractError, type ContractError, type Result } from "../../../orchestration/errors.js"
import { canonicalJson } from "../../../orchestration/digest.js"
import type { EventStreamCursor, StreamedEvent } from "./types.js"
import { MESH_EVENT_RESUME_LIMIT } from "./types.js"

/**
 * SSE framing, as two pure functions.
 *
 * Encoded and decoded here rather than assembled inline at the route, for a
 * reason that is about the TEST rather than the code: a frame is the only place
 * the M4-S contract becomes visible to a client, so the property "a client can
 * detect it received a snapshot rather than a continuation" is a property of
 * these two functions and of nothing else. Keeping them pure means that
 * property is asserted without a socket.
 */

/** The `event:` name of an ordinary streamed `mesh.event`. */
export const SSE_EVENT_NAME = "mesh.event"

/**
 * The `event:` name of a re-base.
 *
 * A DISTINCT name, and it is the entire mechanism by which a client can tell a
 * continuation from a snapshot. If the fallback rode in on `mesh.event` — as an
 * extra field, or as a synthetic entry — then a client that ignores unknown
 * fields would apply a snapshot over its own state and produce a projection
 * derived from a stream it never saw. The name is the only thing a conforming
 * client is required to branch on, so it has to be a name.
 */
export const SSE_SNAPSHOT_EVENT_NAME = "mesh.reconciliation"

/** The `retry:` interval, in milliseconds. A hint, not a contract. */
export const SSE_RETRY_MS = 3_000

export interface SseFrame {
  readonly event: string
  /** The gateway position. Absent only on a frame that is not a stream position. */
  readonly id: string | null
  readonly data: unknown
}

/**
 * A frame, as bytes.
 *
 * `id` is the gateway's TOTAL-ORDER POSITION, not the kernel's run sequence and
 * not the mesh's per-source `localSequence`. That is what makes `Last-Event-ID`
 * a resumable cursor: a run sequence is not comparable across runs and a
 * per-source sequence is not comparable across sources, and a client reading one
 * stream reads both.
 */
export function encodeEventFrame(entry: StreamedEvent): string {
  return frame({ event: SSE_EVENT_NAME, id: String(entry.position), data: entry.payload })
}

/**
 * A re-base frame.
 *
 * No `id:` field, and the absence is deliberate. A snapshot is not a position in
 * this stream — it is the state at a position — so giving it an `id` would tell
 * a client that it had consumed up to there, which is exactly the false
 * "everything after this point is accounted for" claim the fallback exists to
 * avoid. A client that has just re-based must ask for the head explicitly, by
 * reconnecting with no cursor.
 */
export function encodeSnapshotFrame(snapshot: unknown): string {
  return frame({ event: SSE_SNAPSHOT_EVENT_NAME, id: null, data: snapshot })
}

/** The preamble, so a client learns the retry interval before anything is missed. */
export function encodePreamble(retryMs: number = SSE_RETRY_MS): string {
  return `retry: ${retryMs}\n\n`
}

function frame({ event, id, data }: { event: string; id: string | null; data: unknown }): string {
  const idLine = id === null ? "" : `id: ${id}\n`
  // `canonicalJson`, not `JSON.stringify`: the digest in a `snapshotFallback`
  // covers a canonical encoding, and a snapshot that a client recomputes a digest
  // over must hash the same bytes this frame carries.
  return `${idLine}event: ${event}\ndata: ${canonicalJson(data)}\n\n`
}

/**
 * The frames a response body carries, in order.
 *
 * A tolerant parser: it splits on the blank line that terminates a frame and
 * reads `event:`/`id:`/`data:` out of each. It does NOT validate the data
 * against a family schema — a test that wants to prove a client can DETECT a
 * snapshot must be able to look at the bytes without the reader having already
 * made the decision for it.
 */
export function decodeFrames(body: string): SseFrame[] {
  const frames: SseFrame[] = []
  for (const chunk of body.split("\n\n")) {
    if (chunk.trim() === "") continue
    let event: string | null = null
    let id: string | null = null
    const dataLines: string[] = []
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length)
      else if (line.startsWith("id: ")) id = line.slice("id: ".length)
      else if (line.startsWith("data: ")) dataLines.push(line.slice("data: ".length))
    }
    // A frame with no `event:` is a comment or a malformed write; skipped rather
    // than surfaced as a frame with a null name, because a caller branching on
    // `frame.event` would then have a member it cannot compare.
    if (event === null) continue
    const raw = dataLines.join("\n")
    frames.push({ event, id, data: safeJson(raw) })
  }
  return frames
}

/**
 * The two frame names a conforming client branches on, and the ONLY two.
 *
 * Exported as a set so the detectability test asserts against the same two names
 * the encoder writes rather than against strings typed into a test: a test that
 * hard-codes `"mesh.reconciliation"` proves the test agrees with itself, and the
 * property M4-S rests on is that the name the CLIENT switches on is the name the
 * SERVER writes.
 */
export const SSE_FRAME_NAMES: ReadonlySet<string> = Object.freeze(
  new Set<string>([SSE_EVENT_NAME, SSE_SNAPSHOT_EVENT_NAME]),
) as ReadonlySet<string>

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * The cursor a request is asking to resume from, or `null` for "from wherever
 * you are".
 *
 * `last-event-id` is the header a conforming SSE client sends automatically, and
 * `?cursor=` is the explicit form a node that builds its own HTTP request can
 * use. Both are READ, and neither is AUTHORITY: a cursor selects where in a
 * stream the client starts reading, and every position at or after it is a
 * position the client was already entitled to. The two things a cursor must
 * never be able to do — read another run's events, or read events the retention
 * policy has dropped — are decided from the seam's own scope and from
 * `MeshEventGateway.resume`, not from this value.
 */
export function cursorFromRequest(request: {
  headers: Record<string, unknown>
  query?: unknown
}): Result<EventStreamCursor | null> {
  const raw = headerValue(request.headers["last-event-id"]) ?? queryCursor(request.query)
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null }
  if (!/^[0-9]{1,19}$/.test(raw)) return { ok: false, error: malformedCursor(raw) }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return { ok: false, error: malformedCursor(raw) }
  return { ok: true, value: parsed }
}

function malformedCursor(raw: string): ContractError {
  return createContractError(
    "validation",
    "mesh.stream_cursor_malformed",
    `A resume cursor of ${JSON.stringify(raw)} is not a non-negative integer gateway position. It is REFUSED rather than treated as "start from the head": a client that cannot state where it was must be told, because the alternative is a client that silently believes it is continuous when it is not.`,
  )
}

function headerValue(value: unknown): string | undefined {
  if (typeof value === "string") return value
  // A repeated header is ambiguous — two cursors, no way to know which the client
  // meant — so it is treated as absent and the explicit `?cursor=` decides.
  // `array-join` would silently pick one, which is the guess this exists to avoid.
  //
  // There is deliberately no branch for any other type: `undefined` is the answer
  // for a repeated header, a `string[]`, and a value Fastify did not recognise,
  // because all three mean "this request did not state a cursor here" and the
  // caller's `?cursor=` fallback is the only thing that may supply one.
  return undefined
}

function queryCursor(query: unknown): string | undefined {
  if (typeof query !== "object" || query === null) return undefined
  const value = (query as { cursor?: unknown }).cursor
  if (typeof value === "string") return value
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value)
  return undefined
}

export { MESH_EVENT_RESUME_LIMIT }

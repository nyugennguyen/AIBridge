import { canonicalJson } from "../../orchestration/digest.js"
import { createContractError, type Result } from "../../orchestration/errors.js"
import {
  eventIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  timestampSchema,
  type EventId,
} from "../../orchestration/identifiers.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../protocol/negotiation.js"
import { nextLocalSequence, type LocalSequenceVerdict, type MeshEvent } from "../protocol/event.js"
import type { OutboxRecord } from "../../orchestration/event-store/types.js"
import { eventDigestOf, malformedEnqueue } from "./sqlite-outbox-store.js"
import type {
  EventOutbox,
  EventOutboxEnqueueInput,
  EventOutboxStore,
  MeshOutboxEntry,
  OutboxEnqueueOutcome,
} from "./types.js"

/**
 * The durable outbox WRITE seam.
 *
 * `enqueue` is the method the plan's "an event enters a durable outbox BEFORE
 * transmission" is enforced by, and it is separated from the deliverer for the
 * reason the inbox separates `CommandInbox` from `CommandInboxStore`: the
 * ordering guarantee is a property of the ORDER OF TWO CALLS, and the only way
 * to make that property inspectable is to have both halves as named methods.
 *
 * The `localSequence` is assigned HERE, from the store, rather than by the
 * caller. That is the whole reason this class owns enqueue: a sequence handed in
 * by a caller is a sequence two concurrent emitters can both compute, and a
 * `localSequence` the controller sees with a hole in it is a gap it must refuse
 * to continue across. The verdict is returned so the caller can surface a
 * violation instead of persisting a record that will be rejected downstream.
 *
 * It is NOT reset by a restart. A worker that restarts and begins again at 1
 * would make every sequence the controller already accepted look like a
 * duplicate, and the controller's `rebaseAfterRestart` is a decision it makes
 * from a `mesh.reconciliation`, not something a sender can do unilaterally.
 */

/**
 * The durable outbox id for an event.
 *
 * `mevt-<eventId>` and nothing else. It is a pure function of the event id
 * because the event id is the only identity that survives a restart: deriving
 * the storage key from anything clock- or sequence-based would produce a
 * different row for the same event after a restart, which is precisely the
 * "re-emitted under a new id" failure the protocol's event family forbids.
 */
export function defaultOutboxIdFor(eventId: EventId): string {
  return `mevt-${eventId}`
}

/** The last local sequence this store has durably assigned, or `null`. */
export function lastAssignedSequence(records: readonly OutboxRecord[]): number | null {
  let highest: number | null = null
  for (const record of records) {
    const sequence = record.sequenceStart
    if (typeof sequence !== "number") continue
    if (highest === null || sequence > highest) highest = sequence
  }
  return highest
}

export interface DurableEventOutboxDependencies {
  readonly store: EventOutboxStore
  readonly now: () => number
  readonly outboxIdFor?: (eventId: EventId) => string
}

export class DurableEventOutbox implements EventOutbox {
  readonly #store: EventOutboxStore
  readonly #now: () => number
  readonly #outboxIdFor: (eventId: EventId) => string

  constructor(dependencies: DurableEventOutboxDependencies) {
    this.#store = dependencies.store
    this.#now = dependencies.now
    this.#outboxIdFor = dependencies.outboxIdFor ?? ((eventId) => defaultOutboxIdFor(eventId))
  }

  async enqueue(input: EventOutboxEnqueueInput): Promise<Result<OutboxEnqueueOutcome>> {
    // The protocol version is checked HERE rather than trusted, because an event
    // minted at a version this build cannot speak must not become durable: a
    // stored event nobody can parse is an outbox row that blocks its own
    // reconciliation forever.
    if (input.event.meshProtocolVersion !== CURRENT_MESH_PROTOCOL_VERSION) {
      return malformedEnqueue(
        `the event was minted at mesh protocol version ${input.event.meshProtocolVersion} and this build speaks ${CURRENT_MESH_PROTOCOL_VERSION}`,
      )
    }

    const outboxId = this.#outboxIdFor(input.event.eventId)
    const already = this.#store.find(outboxId)
    if (already !== undefined) {
      // Convergence, decided BEFORE the sequence is assigned. An event already
      // in the outbox has already consumed its sequence; a redelivery or a
      // double-enqueue must not advance the counter, or a caller that retries
      // after a crash burns a sequence the controller will then see as a gap.
      //
      // The entry is recovered best-effort rather than derived: the caller's own
      // `MeshEvent` is the better answer, and reconstructing one from a stored
      // row is only here for a caller that needs a complete entry back. A row
      // whose stored bytes are unreadable therefore still converges, and the
      // refusal about THAT belongs to the deliverer, which is the code that has to
      // transmit it.
      return {
        ok: true,
        value: {
          written: false,
          entry: entryOf(already, outboxId) ?? entryFor(input.event, input.destination, outboxId, this.#now()),
        },
      }
    }

    // The verdict is computed, not merely hoped for. `nextLocalSequence` is the
    // protocol's own classification and it refuses a first event above 1 — a
    // store that started at 7 would make 1..6 permanently unrecoverable while
    // looking like a clean start.
    // Read over EVERY row, not just the pending ones: a record already
    // acknowledged has still consumed its sequence, and a store that forgot
    // that would re-issue a position the controller has already applied.
    const verdict: LocalSequenceVerdict = nextLocalSequence(
      lastAssignedSequence(this.#store.list({})),
      input.event.localSequence,
    )
    if (verdict.status === "duplicate") {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "mesh.outbox_sequence_replay",
          `Event '${input.event.eventId}' carries local sequence ${input.event.localSequence}, which this store has already assigned (highest is ${verdict.highestAccepted}). A sequence is consumed once, so a replayed position is refused rather than stored as a second event at a sequence the controller has already accepted.`,
        ),
      }
    }
    if (verdict.status === "gap") {
      // A hole in the SENDER's own sequence is a DIFFERENT defect from a replay,
      // and it is refused here rather than stored. A replay is a duplicate
      // emission; a gap is a position this node never emitted, and storing it would
      // turn a sender-side bug into a controller-side hole that cannot be closed —
      // the missing range is absent HERE, so asking this node to resend it would
      // produce nothing. Enqueue is the last point at which the sender can act.
      const highest = lastAssignedSequence(this.#store.list({})) ?? 0
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "mesh.outbox_sequence_gap",
          `Event '${input.event.eventId}' carries local sequence ${input.event.localSequence} but this node has only emitted through ${highest}. Sequences ${verdict.missingFrom}-${verdict.missingTo} were never enqueued, so the event is REFUSED rather than stored: a row that skips a position becomes a controller-side hole the controller cannot ask this node to fill.`,
        ),
      }
    }

    const createdAt = timestampSchema.parse(new Date(this.#now()).toISOString())
    const entry: MeshOutboxEntry = {
      outboxId,
      destination: input.destination,
      eventId: input.event.eventId,
      projectId: input.event.runProjectScope.projectId,
      runId: input.event.runProjectScope.runId,
      localSequence: input.event.localSequence,
      eventJson: canonicalJson(input.event),
      payloadDigest: eventDigestOf(input.event),
      createdAt,
    }

    try {
      return { ok: true, value: this.#store.enqueue(entry) }
    } catch (cause) {
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "mesh.outbox_enqueue_failed",
          `Event '${input.event.eventId}' could not be written to the durable outbox: ${cause instanceof Error ? cause.name : "an unknown error"}. It is NOT transmitted, because an event that left this node without a durable row is exactly the loss the outbox exists to prevent.`,
        ),
      }
    }
  }

  async find(eventId: EventId): Promise<Result<OutboxRecord | null>> {
    const direct = this.#store.find(this.#outboxIdFor(eventId))
    if (direct !== undefined) return { ok: true, value: direct }
    // Scanned as a fallback because a record written by a build with a different
    // `outboxIdFor` is still THIS event, and reporting "not found" for it would
    // make the controller's cumulative ack unable to retire it. A substring test
    // rather than a parse, because a row whose stored bytes are damaged is
    // precisely the row this fallback exists to find.
    for (const record of this.#store.list({})) {
      if (record.payloadJson.includes(eventId)) return { ok: true, value: record }
    }
    return { ok: true, value: null }
  }

  async listPending(limit?: number): Promise<Result<readonly OutboxRecord[]>> {
    return { ok: true, value: this.#store.list({ status: "pending", ...(limit === undefined ? {} : { limit }) }) }
  }

  /**
   * EVERY record, terminal ones included.
   *
   * `listPending` exists for a TUI that wants the work in flight; this exists
   * because the plan calls the outbox evidence, and a read that filters failures
   * out is a read that cannot answer "did this node ever try to report this?".
   */
  async listAll(limit?: number): Promise<Result<readonly OutboxRecord[]>> {
    return { ok: true, value: this.#store.list({ ...(limit === undefined ? {} : { limit }) }) }
  }
}

/**
 * The entry a stored row describes, or `null` when the row names no usable ids.
 *
 * Every id goes back through its kernel schema rather than being cast. A cast
 * would put the type on without the check, and the checks are the point: a
 * destination this build cannot address, or a scope it cannot compare, is a row
 * the deliverer must refuse rather than transmit. `null` is the honest answer,
 * and the caller falls back to the caller's own event.
 */
function entryOf(record: OutboxRecord, outboxId: string): MeshOutboxEntry | null {
  const destination = nodeIdSchema.safeParse(record.destination)
  const eventId = readEventId(record.payloadJson) ?? readEventId(`{"eventId":"${outboxId.replace(/^mevt-/, "")}"}`)
  const projectId = projectIdSchema.safeParse(record.projectId)
  const runId = runIdSchema.safeParse(record.runId)
  const createdAt = timestampSchema.safeParse(record.createdAt)
  if (!destination.success || eventId === null || !projectId.success || !runId.success || !createdAt.success) return null
  return {
    outboxId,
    destination: destination.data,
    eventId,
    projectId: projectId.data,
    runId: runId.data,
    localSequence: record.sequenceStart ?? 0,
    eventJson: record.payloadJson,
    payloadDigest: record.payloadDigest,
    createdAt: createdAt.data,
  }
}

/** The entry a caller's own event describes, which needs no recovery. */
function entryFor(event: MeshEvent, destination: MeshOutboxEntry["destination"], outboxId: string, nowMs: number): MeshOutboxEntry {
  return {
    outboxId,
    destination,
    eventId: event.eventId,
    projectId: event.runProjectScope.projectId,
    runId: event.runProjectScope.runId,
    localSequence: event.localSequence,
    eventJson: canonicalJson(event),
    payloadDigest: eventDigestOf(event),
    createdAt: timestampSchema.parse(new Date(nowMs).toISOString()),
  }
}

/**
 * The event id of a stored record, or `null`.
 *
 * Read back out of the canonical JSON rather than kept in its own column,
 * because `outbox_records` is a table the kernel's coordinator, the dispatch
 * seam and this mesh seam all write, and adding an event column to it would mean
 * a schema migration to move a fact that is already in the payload. Re-validated
 * through the kernel's `eventIdSchema`, so a row whose JSON is damaged yields
 * `null` rather than an arbitrary string a caller might use as a lookup key.
 */
function readEventId(payloadJson: string): EventId | null {
  try {
    const parsed: unknown = JSON.parse(payloadJson)
    if (typeof parsed !== "object" || parsed === null) return null
    const candidate = (parsed as { readonly eventId?: unknown }).eventId
    const validated = eventIdSchema.safeParse(candidate)
    return validated.success ? validated.data : null
  } catch {
    return null
  }
}

export { lastAssignedSequence as lastAssignedLocalSequence }

import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { eventIdSchema, type EventId, type NodeId } from "../../orchestration/identifiers.js"
import { EventSequenceTracker, nextLocalSequence, type LocalSequenceVerdict } from "../protocol/event.js"
import type { MeshEvent } from "../protocol/event.js"

/**
 * Controller-side ingestion of a `mesh.event`. Idempotent on `eventId`.
 *
 * The plan states two separate requirements and they are answered by two
 * separate mechanisms, which is worth being explicit about because collapsing
 * them is the obvious mistake:
 *
 *   - "controller ingestion is idempotent" — a REDELIVERY of an event already
 *     applied is not an error and must not apply it twice. Answered here by
 *     `eventId`, which is stable across a worker restart.
 *   - "a gap in `localSequence` is reported, not silently skipped" — a MISSING
 *     event is a hole, and a controller that continued across it would build a
 *     projection that invents the missing state. Answered by
 *     `EventSequenceTracker`, which refuses to advance the watermark over a
 *     hole.
 *
 * Idempotency alone does not imply sequencing: the same event id arriving twice
 * is a duplicate, but a DIFFERENT event id at a lower sequence is a hole, and
 * neither is distinguishable from the other by digest alone. Both keys are
 * therefore required, which is also what the protocol's event family says.
 *
 * ### Why the gap is a refusal and not a warning
 *
 * A `dispatch.started` is the event whose absence makes a running session look
 * un-run, and an operator who sees that presses retry — which is the duplicate
 * the whole mesh exists to prevent. So a gap returns a `ContractError` naming
 * the exact range to request, and the tracker does NOT advance. The next
 * arrival at the missing position then fits, and the hole closes with no
 * operator action beyond the reconciliation pass M4.6 drives.
 */
export interface EventIngestStore {
  /** The events already applied from this source, in ingest order. */
  seen(eventId: EventId): Promise<Result<boolean>>
  /** Applies the event. Called at most once per `eventId`. */
  apply(event: MeshEvent): Promise<Result<void>>
}

export type EventIngestOutcome =
  | { readonly status: "applied"; readonly eventId: EventId; readonly localSequence: number }
  | { readonly status: "duplicate"; readonly eventId: EventId; readonly localSequence: number }
  | {
      readonly status: "gap"
      readonly eventId: EventId
      readonly localSequence: number
      readonly missingFrom: number
      readonly missingTo: number
      readonly error: ContractError
    }

export interface EventIngestorDependencies {
  readonly store: EventIngestStore
  /** Injected so a restart can be modelled, and so nothing here reads a clock. */
  readonly trackers?: Map<string, EventSequenceTracker>
}

export class MeshEventIngestor {
  readonly #store: EventIngestStore
  readonly #trackers: Map<string, EventSequenceTracker>

  constructor(dependencies: EventIngestorDependencies) {
    this.#store = dependencies.store
    this.#trackers = dependencies.trackers ?? new Map()
  }

  /**
   * The tracker for a source node, created on first sight.
   *
   * Created rather than required as a dependency because "the first event I have
   * ever received from this node" is a state a controller genuinely has, and
   * forcing a caller to pre-register a tracker for a node it has never heard of
   * would make the common case a wiring error.
   */
  trackerFor(sourceNodeId: NodeId): EventSequenceTracker {
    const existing = this.#trackers.get(sourceNodeId)
    if (existing !== undefined) return existing
    const created = new EventSequenceTracker(sourceNodeId)
    this.#trackers.set(sourceNodeId, created)
    return created
  }

  /**
   * Ingests one `mesh.event`, idempotently on `eventId` and gap-aware on
   * `localSequence`.
   *
   * The ORDER of the two checks is load-bearing: the `eventId` check comes
   * first because a duplicate must be answered WITHOUT touching the tracker, and
   * evaluating a duplicate through the sequence check would classify a resent
   * event as a gap whenever the watermark had moved past it — which is exactly
   * what happens after the very redelivery the spec requires to be harmless.
   */
  async ingest(event: MeshEvent): Promise<Result<EventIngestOutcome>> {
    const eventId = eventIdSchema.parse(event.eventId)

    const already = await this.#store.seen(eventId)
    if (!already.ok) return already
    if (already.value) {
      return {
        ok: true,
        value: { status: "duplicate", eventId, localSequence: event.localSequence },
      }
    }

    const tracker = this.trackerFor(event.sourceNodeId)
    const verdict: LocalSequenceVerdict = nextLocalSequence(tracker.highestAccepted, event.localSequence)
    if (verdict.status === "gap") {
      // NOT applied and NOT advancing. A controller that applied event 7 while
      // 4..6 were missing would hold a projection derived from a stream with a
      // hole, and the hole is invisible afterwards.
      return {
        ok: true,
        value: {
          status: "gap",
          eventId,
          localSequence: event.localSequence,
          missingFrom: verdict.missingFrom,
          missingTo: verdict.missingTo,
          error: verdict.error,
        },
      }
    }
    if (verdict.status === "duplicate") {
      // A sequence the tracker has already passed, carrying an id it has not
      // seen. Treated as a duplicate rather than applied, because the watermark
      // is the record of what this node has been through, and re-applying would
      // put the stream backwards. Reported rather than folded into a boolean, so
      // a caller can tell "resent" from "a second event claiming an old slot".
      return {
        ok: true,
        value: { status: "duplicate", eventId, localSequence: event.localSequence },
      }
    }

    const applied = await this.#store.apply(event)
    if (!applied.ok) return applied
    // The tracker advances ONLY after the apply succeeded. A failed apply that
    // still advanced would turn a retryable storage fault into a permanent hole
    // the controller would then refuse to continue across.
    tracker.evaluate(event.localSequence)
    return { ok: true, value: { status: "applied", eventId, localSequence: event.localSequence } }
  }

  /**
   * Records that a source node RESTARTED, so its sequence is expected to begin
   * at 1 again.
   *
   * Explicit rather than automatic, and the reason is in
   * `EventSequenceTracker.rebaseAfterRestart`: a node that did not restart is
   * still sending high sequences, and rebasing on every "hello" would lower the
   * watermark under them and make a genuinely lost sequence look still-expected.
   * The call belongs to M4.6's reconciliation, which is the point that knows a
   * restart happened.
   */
  recordRestart(sourceNodeId: NodeId): void {
    this.trackerFor(sourceNodeId).rebaseAfterRestart()
  }
}

/**
 * The cumulative position an ack retires through.
 *
 * A `mesh.ack` for an event carries `acknowledgedThroughLocalSequence`, which is
 * CUMULATIVE: acknowledging through N retires every event up to N, so a
 * partition that lost four acks costs one ack on heal rather than four. This is
 * what converts that field into the set of outbox ids a worker may retire, and
 * it is the reason a worker keeps the local sequence beside its outbox row: the
 * position is only computable if the row still knows which position it holds.
 */
export function idsRetiredThrough(
  records: ReadonlyArray<{ readonly outboxId: string; readonly localSequence: number | null }>,
  through: number,
): readonly string[] {
  return records.filter((record) => record.localSequence !== null && record.localSequence <= through).map((r) => r.outboxId)
}

/** The error a controller answers a gap with, built independently of a verdict. */
export function gapRefusal(sourceNodeId: NodeId, from: number, to: number): ContractError {
  return createContractError(
    "conflict",
    "mesh.event_sequence_gap",
    `Events ${from}-${to} from node '${sourceNodeId}' were never seen. The stream is not continued across the hole: a projection built over a missing 'dispatch.started' reports a running session as un-run, and the remedy an operator reaches for — retry — is the duplicate this mesh exists to prevent. Request the missing range.`,
  )
}

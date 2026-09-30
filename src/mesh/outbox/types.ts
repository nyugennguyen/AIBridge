import type { ContractError, Result } from "../../orchestration/errors.js"
import type { EventId, NodeId, ProjectId, RunId, Timestamp } from "../../orchestration/identifiers.js"
import type {
  ClaimOutboxOptions,
  OutboxClaim,
  OutboxRecord,
  OutboxRecoveryResult,
  OutboxWriteResult,
} from "../../orchestration/event-store/types.js"
import type { EffectBoundary } from "../../orchestration/coordinator/types.js"
import type { MeshAck } from "../protocol/ack.js"
import type { MeshEvent } from "../protocol/event.js"

/**
 * M4.5's outbox ports. M4.6 (reconciliation), M4.8 (TUI) and M4.9 (the two-node
 * fault harness) consume ONLY these, so none of them learns whether the pump
 * runs on SQLite, a `Map`, or a test double.
 *
 * Four ports, and the split is the design:
 *
 *   - {@link EventOutboxStore} — the storage surface, STRUCTURALLY a subset of
 *     the kernel's `OutboxStore`. Declared structurally so the pump can be
 *     driven against a fake while production wires the real store, and so a
 *     kernel change that drops a primitive the pump depends on is a compile
 *     error here rather than a `not a function` at three in the morning.
 *   - {@link EventOutboxTransport} — where an event goes. The pump does not
 *     know what an HTTP client is.
 *   - {@link EventOutbox} — the WRITE seam, so "an event entered the outbox
 *     before transmission" is a statement about a method rather than about the
 *     order a caller's code happens to be written in.
 *   - {@link EventOutboxDeliverer} — the pump, separated from the store for the
 *     reason the inbox's `CommandInbox` is separated from its own.
 */

/** Re-exported so a consumer wires one import for the storage surface. */
export type {
  ClaimOutboxOptions,
  OutboxClaim,
  OutboxRecord,
  OutboxRecoveryResult,
  OutboxWriteResult,
}

/**
 * A `mesh.event` as the outbox holds it.
 *
 * The two identities that must survive a restart are the ROW key and the EVENT
 * id, and they are kept distinct on purpose:
 *
 *   - `outboxId` is the storage primary key and the claim identity. It is
 *     derived from `eventId`, so re-enqueueing the same event converges instead
 *     of appending.
 *   - `eventId` is the controller's ingestion key. A redelivery carrying the
 *     same id is deduped by the receiver; a redelivery under a NEW id would be
 *     ingested as a second thing that happened, which is how a retried effect
 *     becomes a duplicated one four steps later.
 *
 * `localSequence` is carried because the controller's gap check needs it and
 * because the outbox is the only place a restart can still learn what sequence
 * the last emitted event held. It is not derivable from the event alone in a
 * useful way: `meshEventSchema` nests it, and reading it back out of canonical
 * JSON on every claim would make the storage layout a function of the wire
 * shape.
 */
export interface MeshOutboxEntry {
  readonly outboxId: string
  /** The controller node this event is destined for. */
  readonly destination: NodeId
  readonly eventId: EventId
  readonly projectId: ProjectId
  readonly runId: RunId
  /** Per source node, monotonic from the controller's point of view. */
  readonly localSequence: number
  /** The wire record, canonical JSON. What is actually transmitted. */
  readonly eventJson: string
  /** The event's payload digest, for the controller to compare on receipt. */
  readonly payloadDigest: string
  readonly createdAt: Timestamp
}

/** What `enqueue` did. `written: false` is convergence, not an error. */
export type OutboxEnqueueOutcome =
  | { readonly written: true; readonly entry: MeshOutboxEntry }
  | { readonly written: false; readonly entry: MeshOutboxEntry }

/**
 * The storage surface the pump needs, and nothing more.
 *
 * Every method mirrors one `OutboxStore` primitive by NAME and SIGNATURE, so
 * production can pass the real store directly and a test can pass a fake. The
 * pump is not allowed to reach past this interface for anything: a method that
 * appeared here without a kernel counterpart would be a second outbox.
 */
export interface EventOutboxStore {
  claimPending(options: ClaimOutboxOptions): OutboxClaim
  markAcknowledged(outboxId: string, now: Timestamp): OutboxWriteResult
  markFailed(
    outboxId: string,
    error: unknown,
    options: { readonly claimToken?: string; readonly nextAttemptAt?: Timestamp; readonly now: Timestamp },
  ): OutboxWriteResult
  /** Terminal, retained. The outbox is evidence, not a cache. */
  exhaust(outboxId: string, error: unknown, options: { readonly now: Timestamp }): OutboxWriteResult
  recoverStale(options: { readonly now: Timestamp; readonly destination?: NodeId }): OutboxRecoveryResult
  find(outboxId: string): OutboxRecord | undefined
  list(filter?: { readonly status?: string; readonly destination?: string; readonly readyAt?: Timestamp; readonly limit?: number }): OutboxRecord[]
  count(filter?: { readonly status?: string; readonly destination?: string }): number
  enqueue(entry: MeshOutboxEntry): OutboxEnqueueOutcome
}

/**
 * The transport seam.
 *
 * Returns the controller's `mesh.ack`, or throws. The ack is the ONLY thing that
 * retires a record, so the pump cannot treat a successful socket write as
 * delivery — the plan says the event "remains until controller acknowledgement
 * is persisted", and a write that succeeded against a socket whose reader died
 * is exactly the case that sentence exists for.
 */
export interface EventOutboxTransport {
  send(entry: MeshOutboxEntry): Promise<MeshAck>
}

export interface EventOutboxDependencies {
  readonly store: EventOutboxStore
  readonly transport: EventOutboxTransport
  readonly now: () => number
  /**
   * M4-B hooks 5 and 6, and ONLY those two.
   *
   * The type is the coordinator's own `EffectBoundary` so a fault harness that
   * already builds one for hooks 1–4 gets 5 and 6 by passing the same object;
   * the other six members are simply never called by this class, and
   * `deliverer.test.ts` asserts that structurally rather than trusting it.
   */
  readonly boundary?: Pick<EffectBoundary, "beforeDeliver" | "afterRuntimeAccept">
  /** Claim lease. Defaults to `MESH_OUTBOX_CLAIM_LEASE_MS`. */
  readonly claimLeaseMs?: number
  /** Per-cycle claim batch. Defaults to 100, matching the kernel store's own. */
  readonly claimLimit?: number
}

/** The per-record verdict, so a test can assert on the DECISION and not just a count. */
export type DeliveryDisposition = "acknowledged" | "requeued" | "terminal" | "skipped"

export interface DeliveryOutcome {
  readonly outboxId: string
  readonly disposition: DeliveryDisposition
  /** The record's `attempts` AFTER this delivery. Never reset by any path. */
  readonly attempts: number
  /** The ack the controller returned, when it returned one. */
  readonly ack: MeshAck | null
  /** Present when the record went terminal, so a caller can surface it. */
  readonly error: ContractError | null
}

export interface PumpReport {
  readonly reclaimed: readonly string[]
  readonly claimed: number
  readonly outcomes: readonly DeliveryOutcome[]
  readonly acknowledged: number
  readonly requeued: number
  readonly terminal: number
  readonly skipped: number
  /** The cycle's `now`, so a caller can compute the next deadline without a clock read. */
  readonly at: Timestamp
}

/**
 * The pump. One method, `pumpOnce`, and the loop is the caller's.
 *
 * Deliberately not a `setInterval` inside this class: the plan's restart,
 * partition and stale-lease scenarios are decided by an INJECTED clock, and a
 * pump that owns a timer cannot be tested across a restart without either
 * faking timers or sleeping. `nextWakeAtMs` is what a scheduler needs to avoid
 * polling faster than the backoff allows, and it reads the same store the pump
 * reads, so a caller cannot compute a wake time from a different definition of
 * "ready".
 */
export interface EventOutboxDeliverer {
  pumpOnce(): Promise<PumpReport>
  /**
   * Milliseconds from now until the earliest record is claimable.
   *
   * `0` when something is ready now, `null` when nothing is pending. Not a
   * negative number and not a `NaN` from a malformed `nextAttemptAt`: a
   * scheduler that receives either busy-loops, which against a poison record is
   * the one failure mode the threshold exists to prevent.
   */
  nextWakeAtMs(): Promise<number | null>
  /** Records stranded in `sending` are requeued. Call once at startup. */
  recoverOnStartup(): Promise<OutboxRecoveryResult>
  find(outboxId: string): OutboxRecord | undefined
}

/**
 * The write seam.
 *
 * `enqueue` is a separate port from the deliverer so that "an event entered the
 * durable outbox BEFORE transmission" is enforced by the order of two calls in
 * code that says so, rather than by a caller's discipline. M4.6's gateway calls
 * `enqueue`; the deliverer never creates a record, only retires one.
 */
export interface EventOutbox {
  enqueue(input: EventOutboxEnqueueInput): Promise<Result<OutboxEnqueueOutcome>>
  find(eventId: EventId): Promise<Result<OutboxRecord | null>>
  /** Pending and stranded rows, for a TUI and for the restart diagram's assertions. */
  listPending(limit?: number): Promise<Result<readonly OutboxRecord[]>>
  /** Every record, INCLUDING terminal ones. The outbox is the evidence. */
  listAll(limit?: number): Promise<Result<readonly OutboxRecord[]>>
}

export interface EventOutboxEnqueueInput {
  readonly event: MeshEvent
  readonly destination: NodeId
}

export type { Timestamp, EventId, NodeId, ProjectId, RunId }

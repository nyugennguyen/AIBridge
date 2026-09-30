/**
 * M4.5 — the durable worker outbox and its deliverer (M4-O).
 *
 * The seam M4.6 (SSE gateway and reconciliation), M4.8 (TUI) and M4.9 (the
 * two-node fault harness) consume. Six things a consumer must know before
 * importing anything from here:
 *
 *   1. **`DurableEventOutbox` is the write seam; `OutboxDeliverer` is the pump;
 *     `EventOutboxStore` is the storage port underneath both.** Three pieces
 *     rather than one, for the reason the inbox separates its own: "an event
 *     entered the durable outbox before transmission" is a statement about the
 *     ORDER of two named calls, and "the record is terminal but still visible"
 *     is a statement about a control flow a reader needs to be able to drive.
 *   2. **The pump is `pumpOnce`, not a loop with a timer.** The plan's restart,
 *     partition and stale-lease scenarios are all decided by an INJECTED clock,
 *     and a deliverer that owns a `setInterval` cannot be tested across any of
 *     them without either faking timers or sleeping. `nextWakeAtMs` is what a
 *     scheduler polls so a fast poll cannot bypass the backoff.
 *   3. **The retry policy is in `./policy.js` and is pinned by tests.** The exact
 *     schedule is 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s with a 300s ceiling, and
 *     the threshold is 8 attempts. A record past the threshold goes TERMINAL and
 *     is RETAINED: the outbox is evidence, not a cache, and deleting it would
 *     leave the reconciliation pass with an unexplained divergence and nothing
 *     to point at.
 *   4. **`attempts` is never reset by any path** — not by a failure, not by
 *     `recoverStaleOutbox`, not by a redelivery. That is what makes the
 *     threshold reachable for a message that crashes the process every time.
 *   5. **M4-B hooks 5 and 6 are invoked from the deliverer**, both injectable,
 *     both at the points the plan's failure matrix names. Hook 6 is the
 *     dangerous one: a crash between the peer accepting and the ack commit
 *     leaves a `sending` row, the restart requeues it, and the redelivery
 *     converges because `MeshEventIngestor` dedupes on `eventId`.
 *   6. **A `localSequence` gap is SURFACED, never skipped.** See `./ingest.js`.
 *     The tracker does not advance across a hole, so a missing `dispatch.started`
 *     cannot make a running session read as un-run.
 *
 * Purity: only `./sqlite-outbox-store.ts` touches storage, and it takes a
 * `SqliteDriver` by injection. It is a thin adapter over the kernel's own
 * `OutboxStore` — the claim transaction, the compare-and-set, the `attempts`
 * increment and the stale reclamation are all the kernel's, because a second
 * implementation would be a second definition of what it means to claim a record.
 */

export {
  DELIVERY_BACKOFF_MS,
  MAX_DELIVERY_BACKOFF_MS,
  MESH_OUTBOX_CLAIM_LEASE_MS,
  MESH_OUTBOX_MAX_ATTEMPTS,
  backoffDelayMs,
  describeDeliveryFailure,
  exceedsMaxAttempts,
  nextAttemptAt,
  terminalDeliveryError,
  totalBackoffMs,
} from "./policy.js"

export {
  OutboxDeliverer,
  DEFAULT_CLAIM_LIMIT,
} from "./deliverer.js"

export {
  DurableEventOutbox,
  defaultOutboxIdFor,
  lastAssignedLocalSequence,
  type DurableEventOutboxDependencies,
} from "./outbox.js"

export {
  ENQUEUE_OUTBOX_ROW_SQL,
  SELECT_OUTBOX_ROW_SQL,
  SELECT_READY_OUTBOX_ROWS_SQL,
  SqliteEventOutboxStore,
  correlationOf,
  eventDigestOf,
  malformedEnqueue,
  nextAttemptAtOf,
} from "./sqlite-outbox-store.js"

export {
  MeshEventIngestor,
  gapRefusal,
  idsRetiredThrough,
  type EventIngestorDependencies,
  type EventIngestOutcome,
  type EventIngestStore,
} from "./ingest.js"

export {
  type ClaimOutboxOptions,
  type DeliveryDisposition,
  type DeliveryOutcome,
  type EventOutbox,
  type EventOutboxDeliverer,
  type EventOutboxDependencies,
  type EventOutboxEnqueueInput,
  type EventOutboxStore,
  type MeshOutboxEntry,
  type OutboxClaim,
  type OutboxEnqueueOutcome,
  type OutboxRecord,
  type OutboxRecoveryResult,
  type OutboxWriteResult,
  type PumpReport,
} from "./types.js"

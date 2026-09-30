import { digestJson } from "../../orchestration/digest.js"
import { createContractError, type ContractError } from "../../orchestration/errors.js"
import { timestampSchema, type EventId, type NodeId, type Timestamp } from "../../orchestration/identifiers.js"
import { OutboxStore } from "../../orchestration/event-store/outbox-store.js"
import type { OutboxRecord, OutboxWriteResult } from "../../orchestration/event-store/types.js"
import type { SqliteDriver } from "../../orchestration/event-store/sqlite-driver.js"
import type {
  EventOutboxStore,
  MeshOutboxEntry,
  OutboxEnqueueOutcome,
} from "./types.js"

/**
 * THIS MODULE IS THE ONLY ONE ALLOWED TO TOUCH STORAGE, and it is a thin
 * adapter: every method forwards to a kernel `OutboxStore` on an injected
 * driver. It does not open a database, and it does not re-implement a single
 * storage rule.
 *
 * That is the whole design and it is not a shortcut. The claim transaction, the
 * compare-and-set on `status = 'pending'`, the `attempts` increment, the
 * `ON CONFLICT` convergence and the stale-claim reclamation are all already
 * written, already tested against both SQLite backends, and already reasoned
 * about. A second implementation here would be a second set of answers to
 * "what does it mean to claim a record", and the failure mode of that is a
 * deliverer that works against one store and not the other.
 *
 * The one thing the kernel store does NOT do is accept a NEW record without a
 * coordinator append, so `enqueue` is here. It is a plain `INSERT ... ON
 * CONFLICT DO NOTHING` — the same convergence rule as the inbox's insert, for
 * the same reason, and the `attempts` default of 0 is the kernel's own column
 * default rather than a second statement of it.
 */

/**
 * The insert, with convergence in the statement.
 *
 * `ON CONFLICT (outbox_id) DO NOTHING` rather than a `SELECT` followed by an
 * `INSERT`: a check and a write that are not one statement have a gap between
 * them, and the gap is exactly where a redelivered event gets two rows. The
 * re-read in `enqueue` decides `written`, so the caller learns whether it
 * created the record or found it, which is the difference between "this event
 * was never transmitted" and "it is in flight".
 *
 * `local_sequence` is stored in the kernel's `sequence_start` column, which the
 * migration introduced for exactly this: a range of local sequence positions
 * belonging to one record. A `mesh.event` is always a single position, so the
 * start is the value and the end is left null.
 */
export const ENQUEUE_OUTBOX_ROW_SQL = `
INSERT INTO outbox_records (
  outbox_id, destination, payload_json, payload_digest, status, attempts,
  created_at, project_id, run_id, command_id, sequence_start
)
VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)
ON CONFLICT (outbox_id) DO NOTHING
`

/** The `outbox_records` columns this module reads and writes, in one place. */
export const SELECT_OUTBOX_ROW_SQL = `
SELECT * FROM outbox_records WHERE outbox_id = ?
`

export const SELECT_READY_OUTBOX_ROWS_SQL = `
SELECT * FROM outbox_records
WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
ORDER BY created_at ASC, outbox_id ASC
`

export class SqliteEventOutboxStore implements EventOutboxStore {
  readonly #outbox: OutboxStore
  readonly #driver: SqliteDriver

  constructor(driver: SqliteDriver) {
    this.#driver = driver
    this.#outbox = new OutboxStore(driver)
  }

  /** Exposed so a structural test can read the physical columns. */
  get driver(): SqliteDriver {
    return this.#driver
  }

  /** The kernel store, for a caller that needs a primitive this port omits. */
  get kernelOutbox(): OutboxStore {
    return this.#outbox
  }

  enqueue(entry: MeshOutboxEntry): OutboxEnqueueOutcome {
    // The insert and the read are ONE transaction, so `written` is decided by a
    // `changes` count and a row that is either this call's or already there —
    // never by a torn middle where the count says written and the read finds
    // nothing.
    const written = this.#driver.transaction(() => {
      const changes = this.#driver.run(
        ENQUEUE_OUTBOX_ROW_SQL,
        entry.outboxId,
        entry.destination,
        entry.eventJson,
        entry.payloadDigest,
        entry.createdAt,
        entry.projectId,
        entry.runId,
        // `command_id` is the event's correlation, not a claim that this record
        // IS a command delivery. It is populated so the kernel's partial unique
        // index on `(command_id, destination, payload_digest)` can refuse a
        // genuine double-send of the same bytes, which is the one place that
        // index protects the mesh as well as the kernel.
        correlationOf(entry),
        entry.localSequence,
      ).changes
      return changes > 0
    })

    if (this.#outbox.getOutboxRecord(entry.outboxId) === undefined) {
      // Unreachable through SQLite's own semantics, and treated as a store fault
      // rather than as "converged onto nothing": an `enqueue` that reported
      // convergence without a row would leave the sender believing its event is
      // in flight when nothing holds it.
      throw new Error(
        `enqueue wrote or converged onto '${entry.outboxId}' but the row is not readable in the same transaction`,
      )
    }
    return { written, entry }
  }

  claimPending(options: Parameters<OutboxStore["claimPendingOutbox"]>[0]): ReturnType<OutboxStore["claimPendingOutbox"]> {
    return this.#outbox.claimPendingOutbox(options)
  }

  markAcknowledged(outboxId: string, now: Timestamp): OutboxWriteResult {
    return this.#outbox.markOutboxAcknowledged(outboxId, now)
  }

  markFailed(
    outboxId: string,
    error: unknown,
    options: { readonly claimToken?: string; readonly nextAttemptAt?: Timestamp; readonly now: Timestamp },
  ): OutboxWriteResult {
    return this.#outbox.markOutboxFailed(outboxId, error, options)
  }

  /**
   * Terminal, and RETAINED.
   *
   * Forwarded as-is. This method used to follow the kernel's `exhaustOutbox` with
   * a second statement clearing `next_attempt_at`, because the kernel left a
   * terminal row still carrying the last failure's retry deadline. A row that
   * reads as "scheduled" on a store whose other half is EVIDENCE is a lie to an
   * operator, and it makes any scheduler that computes a wake time from that
   * column wake for a record that will never be delivered — so the kernel store
   * now clears the deadline in the same UPDATE that sets `status = 'failed'`.
   *
   * Noted as removed rather than left silent: the patch was written here because
   * the mesh outbox is the one consumer that retains terminal rows, and patching
   * it here made a property of the retention contract invisible to the next caller
   * of the same column. `tests/unit/event-store/outbox.test.ts` asserts it at the
   * kernel now.
   */
  exhaust(outboxId: string, error: unknown, options: { readonly now: Timestamp }): OutboxWriteResult {
    return this.#outbox.exhaustOutbox(outboxId, error, options)
  }

  recoverStale(options: { readonly now: Timestamp; readonly destination?: NodeId }): ReturnType<OutboxStore["recoverStaleOutbox"]> {
    return this.#outbox.recoverStaleOutbox(options)
  }

  find(outboxId: string): OutboxRecord | undefined {
    return this.#outbox.getOutboxRecord(outboxId)
  }

  list(
    filter: { readonly status?: string; readonly destination?: string; readonly readyAt?: Timestamp; readonly limit?: number } = {},
  ): OutboxRecord[] {
    return this.#outbox.listOutbox(filter as Parameters<OutboxStore["listOutbox"]>[0])
  }

  count(filter: { readonly status?: string; readonly destination?: string } = {}): number {
    return this.#outbox.countOutbox(filter as Parameters<OutboxStore["countOutbox"]>[0])
  }
}

/**
 * The digest the controller compares the received event against.
 *
 * Computed from the CANONICAL event rather than carried in by the caller, so a
 * bug in the minting seam cannot enqueue an event whose stored digest does not
 * match its own bytes. The kernel's `digestJson` is the same function the
 * protocol's `mintMeshEvent` path uses for `payloadDigest`, so the two agree by
 * construction.
 */
export function eventDigestOf(event: { readonly event: unknown }): string {
  return digestJson(event)
}

/** The refusal a malformed enqueue produces. `validation`, so nothing is retried. */
export function malformedEnqueue(detail: string): { ok: false; error: ContractError } {
  return {
    ok: false,
    error: createContractError(
      "validation",
      "mesh.outbox_entry_malformed",
      `A mesh event was refused before it reached the durable outbox: ${detail}. An event that cannot be stored durably cannot be claimed, retried or recovered after a restart, so enqueueing it would be a promise nothing keeps.`,
    ),
  }
}

/**
 * Reads the next claim deadline out of a stored record, or `null`.
 *
 * `null` covers all three cases that mean "claimable now": a record with no
 * deadline, a record whose deadline is absent because the column predates
 * migration 2, and a record whose deadline this build cannot parse. The
 * alternative — treating an unparseable deadline as "not ready" — would park a
 * record forever behind a stamp nothing can read, and the plan's completion
 * criterion is that resend happens until the ack does.
 */
export function nextAttemptAtOf(record: OutboxRecord | undefined): Timestamp | null {
  if (record === undefined || record.nextAttemptAt === undefined) return null
  const parsed = timestampSchema.safeParse(record.nextAttemptAt)
  return parsed.success ? parsed.data : null
}

/**
 * The `command_id` a stored event row carries.
 *
 * Read back out of the canonical JSON rather than kept in a column, because the
 * wire record is the only copy and duplicating the correlation would be two
 * sources for one fact. `null` on anything unparseable, which makes the
 * convergence check fall back to the primary key rather than fail — a row whose
 * JSON is damaged is still a row, and refusing to converge onto it would be a
 * worse outcome than converging with a missing correlation.
 */
export function correlationOf(entry: MeshOutboxEntry): string | null {
  try {
    const parsed: unknown = JSON.parse(entry.eventJson)
    if (typeof parsed !== "object" || parsed === null) return null
    const correlation = (parsed as { readonly commandCorrelation?: unknown }).commandCorrelation
    return typeof correlation === "string" ? correlation : null
  } catch {
    return null
  }
}

export type { EventId }

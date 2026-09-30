/**
 * M4-O: the delivery POLICY. Storage primitives existed (`claimPendingOutbox`,
 * `markOutboxAcknowledged`, `markOutboxFailed`, `recoverStaleOutbox`) and
 * nothing decided WHEN to try again or WHEN to stop.
 *
 * The policy lives in its own module, separate from the pump, for the reason the
 * lease's `evaluateLease` is separate from `MeshControllerLease`: the numbers are
 * the thing a reviewer argues with, and burying them in a loop body makes them
 * arguable only by rewriting the loop. A test asserts this schedule exactly
 * rather than asserting "it backs off".
 *
 * ### The schedule, and why these numbers
 *
 * `DELIVERY_BACKOFF_MS` is 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, then a 300s
 * ceiling. Doubling, capped.
 *
 *   - **1s base, doubling.** The commonest failure on a Tailscale link is a
 *     dropped TCP connection that the peer's `keepalive` re-establishes in well
 *     under a second, so the first redelivery should not wait long enough for the
 *     sender to have given up. Doubling then bounds a PARTITION's cost: a
 *     ten-minute cut costs roughly 2^10 transmissions rather than 600 000, and
 *     exponential backoff is the only schedule whose total is proportional to
 *     the outage rather than to its square.
 *   - **300s ceiling.** The controller lease in force for M4 is 30s and
 *     `takeover` is user-initiated, so a redelivery that is more than five
 *     minutes late is not racing anything — the run has moved on, and the right
 *     answer is the reconciliation pass in §6 of the plan, not a hot loop that
 *     keeps an old epoch's event alive. 300s also keeps the pending set small
 *     enough that `recoverStaleOutbox` on restart is a bounded scan.
 *   - **Not jittered.** Jitter is the right answer for a fleet of senders
 *     thundering one shared peer, and this codebase has exactly one controller
 *     per run by construction (ADR 0004: no election, no gossip). Two
 *     independent jitter sources would make the schedule untestable without a
 *     random seam the codebase otherwise forbids, which is a bad trade for
 *     synchronisation this deployment cannot produce. Recorded here because a
 *     future multi-controller change must revisit it, not because it was
 *     considered and forgotten.
 *
 * ### The threshold, and why 8
 *
 * `MESH_OUTBOX_MAX_ATTEMPTS` is 8. Eight attempts at the schedule above spans
 * 1+2+4+8+16+32+64 = **127 seconds** of waiting, and the eighth attempt itself is
 * the last one before the record goes terminal.
 *
 *   - **Long enough to outlast a real transient.** A worker restart with a
 *     reclaim in progress, a controller process replacement, and a Tailscale
 *     path change are each single-digit-second events. Seven backoffs clear all
 *     of them with room to spare.
 *   - **Short enough that the record is still interesting when it dies.** At
 *     127s a poison record is terminal inside a single lease window of the
 *     failure that caused it, so an operator looking at a stuck run is looking
 *     at a `failed` row rather than a `pending` one that has been "retrying"
 *     for twenty minutes. A threshold high enough to be invisible in the UI is a
 *     threshold nobody ever investigates, and the outbox is the only place the
 *     evidence survives.
 *   - **Not reset by recovery.** `recoverStaleOutbox` requeues with `attempts`
 *         preserved, so a record that crashes the process on every attempt reaches
 *         the threshold in eight restarts rather than living forever. That is the
 *         property `tests/unit/mesh/outbox/deliverer.test.ts` asserts directly,
 *         because a pump that reclaims without checking the threshold is a pump
 *         that never stops retrying a message it cannot deliver.
 */

import { createContractError, type ContractError } from "../../orchestration/errors.js"
import { timestampSchema, type Timestamp } from "../../orchestration/identifiers.js"

/** Delay after the Nth failed attempt, in milliseconds. Index 0 is after attempt 1. */
export const DELIVERY_BACKOFF_MS: readonly number[] = Object.freeze([
  1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 300_000,
])

/** The ceiling on any single backoff, in milliseconds. */
export const MAX_DELIVERY_BACKOFF_MS = 300_000

/**
 * Attempts allowed per record, including the first.
 *
 * A record whose `attempts` has reached this on a FAILED delivery goes terminal.
 * The claim itself increments `attempts`, so the eighth claim is the eighth
 * delivery and the record is terminal when that one fails.
 */
export const MESH_OUTBOX_MAX_ATTEMPTS = 8

/**
 * How long a claim stays valid before `recoverStaleOutbox` may requeue it.
 *
 * 30s, and deliberately equal to M4.4's lease duration rather than chosen for
 * the delivery: a claim is held across one network round trip to a peer, and the
 * longest legitimate round trip on a Tailscale link is orders of magnitude below
 * 30s, so a longer lease only delays the reclamation that a crash needs. A
 * SHORTER one would reclaim a record whose delivery is merely slow, which is the
 * duplicate the whole mesh at-least-once discipline is trying to keep rare.
 */
export const MESH_OUTBOX_CLAIM_LEASE_MS = 30_000

/**
 * The delay before attempt number `failedAttempts + 1`.
 *
 * `failedAttempts` is the record's post-increment `attempts`, so it is the
 * attempt that just FAILED. Beyond the table the ceiling applies, and the table
 * is longer than {@link MESH_OUTBOX_MAX_ATTEMPTS} on purpose: the two numbers
 * answer different questions, and a test that pins the schedule to the threshold
 * would be asserting that they can never be changed independently. They are
 * changed independently — raising the threshold to survive a longer partition is
 * a reasonable thing to want without re-tuning the first backoff.
 */
export function backoffDelayMs(failedAttempts: number): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) {
    throw new Error(`backoffDelayMs requires a positive attempt count, got ${failedAttempts}`)
  }
  const index = Math.min(failedAttempts - 1, DELIVERY_BACKOFF_MS.length - 1)
  return Math.min(DELIVERY_BACKOFF_MS[index] ?? MAX_DELIVERY_BACKOFF_MS, MAX_DELIVERY_BACKOFF_MS)
}

/** Whether a record that has now failed `attempts` times must go terminal. */
export function exceedsMaxAttempts(attempts: number): boolean {
  return attempts >= MESH_OUTBOX_MAX_ATTEMPTS
}

/**
 * The instant a record becomes claimable again.
 *
 * `nowMs + delay`, formatted through the kernel's `timestampSchema` rather than
 * `new Date(ms).toISOString()` alone, because `nextAttemptAt` is read by a
 * comparison in `claimPendingOutbox` AND is a value an operator reads: a stamp
 * this build cannot parse back is a stamp that reads as malformed in exactly the
 * place someone would be looking during an incident.
 */
export function nextAttemptAt(nowMs: number, failedAttempts: number): Timestamp {
  return timestampSchema.parse(new Date(nowMs + backoffDelayMs(failedAttempts)).toISOString())
}

/** The total time a record spends backing off before its last attempt. */
export function totalBackoffMs(): number {
  return DELIVERY_BACKOFF_MS.slice(0, MESH_OUTBOX_MAX_ATTEMPTS - 1).reduce((sum, ms) => sum + ms, 0)
}

/**
 * Why a record went terminal, as a `ContractError`.
 *
 * Carries a code rather than a bare string so a caller can distinguish "this
 * message is undeliverable" from "this message was undeliverable 8 times and we
 * stopped" — the first may be fixed by a peer upgrading, the second only by a
 * human. `retryable: false` on both, because an automatic retry of a terminal
 * poison record is how a delivery loop becomes a denial-of-service generator.
 */
export function terminalDeliveryError(outboxId: string, attempts: number, lastError: unknown): ContractError {
  return createContractError(
    "conflict",
    "mesh.outbox_poison_record",
    `Outbox record '${outboxId}' failed ${attempts} deliveries and is terminal. It is RETAINED rather than deleted: the outbox is the evidence that this node believed it had reported something and did not, and a deleted record would leave an unexplained divergence for the reconciliation pass to find with nothing to point at. Last error: ${describeDeliveryFailure(lastError)}.`,
  )
}

/**
 * A failure in one word, for a `last_error` column and a log line.
 *
 * The CODE, never the message: an outbox payload is a `mesh.event`, and the
 * payload text belongs in the event log rather than in a column an operator
 * greps. This mirrors `describeInboxStoreError` in the inbox store, which exists
 * for the same reason.
 */
export function describeDeliveryFailure(error: unknown): string {
  if (error instanceof Error) {
    if ("code" in error && typeof (error as { code?: unknown }).code === "string") {
      return (error as { code: string }).code
    }
    return error.name
  }
  if (typeof error === "string") return error.slice(0, 128)
  return "an unknown error"
}

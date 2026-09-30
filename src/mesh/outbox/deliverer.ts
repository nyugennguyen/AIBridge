import { createContractError } from "../../orchestration/errors.js"
import {
  eventIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  timestampSchema,
  type EventId,
} from "../../orchestration/identifiers.js"
import type { OutboxRecord } from "../../orchestration/event-store/types.js"
import {
  MESH_OUTBOX_CLAIM_LEASE_MS,
  exceedsMaxAttempts,
  nextAttemptAt,
  terminalDeliveryError,
} from "./policy.js"
import { nextAttemptAtOf } from "./sqlite-outbox-store.js"
import type {
  DeliveryOutcome,
  EventOutboxDeliverer,
  EventOutboxDependencies,
  MeshOutboxEntry,
  PumpReport,
} from "./types.js"

/**
 * M4-O: the outbox DELIVERER.
 *
 * `claimPendingOutbox`, `markOutboxAcknowledged`, `markOutboxFailed` and
 * `recoverStaleOutbox` were storage primitives with no pump above them. This is
 * that pump, and the whole milestone item turns on three properties it has and
 * the primitives do not:
 *
 *   1. **A record is never deleted.** A record past the attempt threshold goes
 *      TERMINAL and stays readable. The outbox is the evidence that this node
 *      believed it had reported something; a pump that dropped the record would
 *      leave the reconciliation pass with an unexplained divergence and nothing
 *      to point at.
 *   2. **`attempts` is never reset by any path** — not by a failure, not by
 *      `recoverStaleOutbox`, not by a redelivery after a crash. That is what
 *      makes the threshold reachable for a message that crashes the process on
 *      every attempt, and it is enforced here rather than in the store because a
 *      pump that could reset a counter is a pump whose terminal state is
 *      unreachable.
 *   3. **Both M4-B hooks fire from here.** `beforeDeliver` runs after the claim
 *      and before the socket; `afterRuntimeAccept` runs after the peer accepted
 *      and before the ack commit. Hook 6 is the dangerous one: a crash in that
 *      window leaves the record in `sending`, and the restart requeues it, and
 *      the redelivery has to be harmless. It is, because the controller's
 *      ingestion dedupes on `eventId` — see `./ingest.ts`.
 *
 * ### Why the ordering inside `#deliverOne` is this ordering
 *
 *   claim → `beforeDeliver` → send → `afterRuntimeAccept` → ack commit
 *
 * The claim comes first so there is a lease to reclaim if any later step dies.
 * The two hooks are placed at the two points the plan's failure matrix names, not
 * where they would be convenient. The ack commit is LAST and is a separate
 * durable write from the claim, because a crash between them is the
 * redelivery case and a pump that collapsed them would make that case
 * unrepresentable.
 *
 * ### What this class does NOT do
 *
 * It does not decide whether an event SHOULD be sent — there is no filter here
 * beyond destination and backoff, because a mesh event is a report of something
 * that already happened. It does not read a clock: every instant comes from
 * `deps.now`, which is what makes the whole retry matrix a set of numbers. And it
 * does not own a timer; `nextWakeAtMs` is what a scheduler polls so the backoff
 * policy is not bypassed by a fast poll.
 */
/** Per-cycle claim batch when the caller states none. Matches the kernel store's own. */
export const DEFAULT_CLAIM_LIMIT = 100

export class OutboxDeliverer implements EventOutboxDeliverer {
  readonly #deps: EventOutboxDependencies
  readonly #leaseMs: number
  readonly #limit: number

  constructor(dependencies: EventOutboxDependencies) {
    this.#deps = dependencies
    this.#leaseMs = dependencies.claimLeaseMs ?? MESH_OUTBOX_CLAIM_LEASE_MS
    this.#limit = dependencies.claimLimit ?? DEFAULT_CLAIM_LIMIT
  }

  /**
   * One cycle: reclaim, claim, deliver.
   *
   * Recovery is inside the cycle rather than only in `recoverOnStartup` because
   * a process that does not die also strands claims: a delivery that hangs past
   * its lease is reclaimed by whichever cycle notices first, and a pump that
   * only reclaimed at startup would leave it `sending` until the next restart —
   * which, for a healthy long-running worker, is never.
   */
  async pumpOnce(): Promise<PumpReport> {
    const nowMs = this.#deps.now()
    const now = timestampSchema.parse(new Date(nowMs).toISOString())

    const recovery = this.#deps.store.recoverStale({ now })
    const claim = this.#deps.store.claimPending({
      now,
      leaseMs: this.#leaseMs,
      limit: this.#limit,
      // The SAME `now` the recovery used. Two clock reads in one cycle would
      // mean a record could be requeued at T and claimed at T-1, which is a
      // record delivered before it was reclaimed.
      readyAt: now,
    })

    const outcomes: DeliveryOutcome[] = []
    for (const record of claim.records) {
      outcomes.push(await this.#deliverOne(record, claim.token, now))
    }

    return {
      reclaimed: recovery.recovered,
      claimed: claim.records.length,
      outcomes,
      acknowledged: outcomes.filter((o) => o.disposition === "acknowledged").length,
      requeued: outcomes.filter((o) => o.disposition === "requeued").length,
      terminal: outcomes.filter((o) => o.disposition === "terminal").length,
      skipped: outcomes.filter((o) => o.disposition === "skipped").length,
      at: now,
    }
  }

  async recoverOnStartup(): Promise<ReturnType<EventOutboxDependencies["store"]["recoverStale"]>> {
    return this.#deps.store.recoverStale({ now: timestampSchema.parse(new Date(this.#deps.now()).toISOString()) })
  }

  find(outboxId: string): OutboxRecord | undefined {
    return this.#deps.store.find(outboxId)
  }

  /**
   * Milliseconds until the earliest pending record is claimable.
   *
   * `0` when something is ready now, `null` when nothing is pending. A record
   * stranded in `sending` is NOT counted as ready: it will become claimable when
   * its lease expires, and a wake time that ignored that would either wake too
   * early forever or never wake at all. The stranded lease deadline is therefore
   * folded in, so the returned instant is the earliest moment ANY work becomes
   * deliverable.
   */
  async nextWakeAtMs(): Promise<number | null> {
    const nowMs = this.#deps.now()
    const earliest: number[] = []

    for (const record of this.#deps.store.list({ status: "pending" })) {
      const deadline = nextAttemptAtOf(record)
      // A record with no deadline is claimable immediately. Malformed or absent
      // both read as "now" rather than as "never", because the alternative is a
      // pending record no scheduler ever wakes for.
      if (deadline === null) return 0
      const at = Date.parse(deadline)
      if (!Number.isFinite(at)) return 0
      earliest.push(at)
    }

    for (const record of this.#deps.store.list({ status: "sending" })) {
      const leaseDeadline = record.leaseExpiresAt
      if (leaseDeadline === undefined) continue
      const at = Date.parse(leaseDeadline)
      if (!Number.isFinite(at)) continue
      earliest.push(at)
    }

    if (earliest.length === 0) return null
    const soonest = Math.min(...earliest)
    return Math.max(0, soonest - nowMs)
  }

  async #deliverOne(record: OutboxRecord, claimToken: string, now: string): Promise<DeliveryOutcome> {
    const outboxId = record.outboxId
    // `attempts` was already incremented by the claim, so this is the number of
    // DELIVERIES, and it is the value the threshold is judged against.
    const attempts = record.attempts

    // M4-B hook 5. Fires after the claim and before the socket, so a crash here
    // leaves a `sending` row whose lease expires and is reclaimed — the
    // redelivery is the first attempt that ever reached the wire.
    this.#deps.boundary?.beforeDeliver?.(outboxId)

    const entry = toEntry(record)
    if (entry === null) {
      // The payload is not something this build can name. Refusing to transmit
      // it is the only safe direction, and it is TERMINAL rather than requeued:
      // a row this build cannot read is a row no attempt will ever succeed on.
      const error = createContractError(
        "internal_failure",
        "mesh.outbox_payload_unreadable",
        `Outbox record '${outboxId}' does not carry a mesh.event this build can read, so it was not transmitted. It is retained and terminal: retransmitting an unreadable record would put the same bytes on the wire indefinitely without ever producing an acknowledgement.`,
      )
      this.#deps.store.exhaust(outboxId, error, { now })
      return { outboxId, disposition: "terminal", attempts, ack: null, error }
    }

    let ack: Awaited<ReturnType<EventOutboxDependencies["transport"]["send"]>>
    try {
      ack = await this.#deps.transport.send(entry)
    } catch (cause) {
      return this.#fail(record, claimToken, now, attempts, cause)
    }

    // M4-B hook 6. The peer took the effect and the acknowledgement is not yet
    // committed. A crash here is the ambiguous-launch case: the record stays
    // `sending`, the restart requeues it, and the redelivery converges because
    // the controller dedupes on `eventId`.
    this.#deps.boundary?.afterRuntimeAccept?.(outboxId)

    if (ack.outcome === "rejected") {
      // A REJECTION is not an acknowledgement and does not retire the record. It
      // is a delivery failure like any other: the controller answered, so the
      // bytes are believed to have arrived, and the record is retried on the
      // ordinary schedule. Whether a rejection is permanent is a question about
      // the controller's reasons, not about the transport, and this class does
      // not get to guess — the threshold is the backstop.
      return this.#fail(record, claimToken, now, attempts, ack.rejectionCode ?? "rejected_by_controller")
    }

    const acknowledged = this.#deps.store.markAcknowledged(outboxId, now)
    if (!acknowledged.changed) {
      // Somebody else retired it. Not an error — the record is not in flight, so
      // this cycle has nothing left to do with it, and reporting an
      // acknowledgement for a row this claim did not win would be a lie about
      // which claim committed it.
      return { outboxId, disposition: "skipped", attempts, ack, error: null }
    }
    return { outboxId, disposition: "acknowledged", attempts, ack, error: null }
  }

  /**
   * The failure path, and the whole of the retry policy.
   *
   * The threshold is checked BEFORE the record is requeued rather than after,
   * so the terminal write is a single decision at the point the attempt count
   * crossed it. Checking after would mean a record briefly sitting in `pending`
   * with `attempts` at the threshold, which a concurrent claim could pick up and
   * deliver an (N+1)th time — the pump racing itself past its own backstop.
   */
  #fail(
    record: OutboxRecord,
    claimToken: string,
    now: string,
    attempts: number,
    cause: unknown,
  ): DeliveryOutcome {
    const outboxId = record.outboxId

    if (exceedsMaxAttempts(attempts)) {
      const error = terminalDeliveryError(outboxId, attempts, cause)
      this.#deps.store.exhaust(outboxId, error, { now })
      return { outboxId, disposition: "terminal", attempts, ack: null, error }
    }

    const deadline = nextAttemptAt(Date.parse(now), attempts)
    const result = this.#deps.store.markFailed(outboxId, cause, {
      claimToken,
      nextAttemptAt: deadline,
      now,
    })
    if (!result.changed) {
      // The claim was lost — recovered or acknowledged elsewhere. Same reasoning
      // as the acknowledged branch: this cycle does not get to write a decision
      // about a row it no longer holds.
      return { outboxId, disposition: "skipped", attempts, ack: null, error: null }
    }
    return { outboxId, disposition: "requeued", attempts, ack: null, error: null }
  }
}

/**
 * The wire record for a claimed row.
 *
 * `null` when the stored row does not name ids this build can address, and the
 * caller then makes the record TERMINAL rather than transmitting it. The check is
 * over the ids rather than a full `meshEventSchema` parse on purpose: the
 * deliverer's job is to transmit bytes the controller will parse, and re-parsing
 * here would mean a second parse site for a record family the protocol spec says
 * has exactly one.
 */
function toEntry(record: OutboxRecord): MeshOutboxEntry | null {
  const destination = nodeIdSchema.safeParse(record.destination)
  const projectId = projectIdSchema.safeParse(record.projectId)
  const runId = runIdSchema.safeParse(record.runId)
  const createdAt = timestampSchema.safeParse(record.createdAt)
  const eventId = eventIdOf(record)
  if (!destination.success || !projectId.success || !runId.success || !createdAt.success || eventId === null) return null
  return {
    outboxId: record.outboxId,
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

/**
 * The event id of a claimed row, or `null`.
 *
 * Read out of the stored payload and validated through the kernel's
 * `eventIdSchema`. Falling back to the derived `outbox_id` is deliberate and is
 * the same string the write path put there, so a row whose payload is damaged
 * still has an identity to report in a terminal error — but the fallback is
 * validated too, and a row with neither is refused rather than transmitted under
 * an invented id.
 */
function eventIdOf(record: OutboxRecord): EventId | null {
  try {
    const parsed: unknown = JSON.parse(record.payloadJson)
    if (typeof parsed === "object" && parsed !== null) {
      const candidate = eventIdSchema.safeParse((parsed as { readonly eventId?: unknown }).eventId)
      if (candidate.success) return candidate.data
    }
  } catch {
    // fall through to the derived id
  }
  return eventIdSchema.safeParse(record.outboxId.replace(/^mevt-/, "")).data ?? null
}

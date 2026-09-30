import { randomUUID } from "node:crypto"
import type { SqliteDriver } from "./sqlite-driver.js"
import type { OutboxRecordRow } from "./schema.js"
import type { Timestamp } from "../identifiers.js"
import type {
  ClaimOutboxOptions,
  OutboxClaim,
  OutboxFilter,
  OutboxRecord,
  OutboxRecordStatus,
  OutboxRecoveryResult,
  OutboxWriteResult,
} from "./types.js"

const DEFAULT_LEASE_MS = 30_000
const DEFAULT_CLAIM_LIMIT = 100
const MAX_ERROR_LENGTH = 2000

function truncateError(error: unknown): string {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error)
            } catch {
              return String(error)
            }
          })()
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message
}

export function mapOutboxRow(row: OutboxRecordRow): OutboxRecord {
  return {
    outboxId: row.outbox_id,
    destination: row.destination,
    payloadJson: row.payload_json,
    payloadDigest: row.payload_digest as OutboxRecord["payloadDigest"],
    status: row.status as OutboxRecordStatus,
    attempts: row.attempts,
    createdAt: row.created_at as Timestamp,
    lastAttemptedAt: row.last_attempted_at ? (row.last_attempted_at as Timestamp) : undefined,
    acknowledgedAt: row.acknowledged_at ? (row.acknowledged_at as Timestamp) : undefined,
    projectId: (row.project_id ?? undefined) as OutboxRecord["projectId"],
    runId: (row.run_id ?? undefined) as OutboxRecord["runId"],
    commandId: (row.command_id ?? undefined) as OutboxRecord["commandId"],
    sequenceStart: row.sequence_start ?? undefined,
    sequenceEnd: row.sequence_end ?? undefined,
    claimToken: row.claim_token ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    lastError: row.last_error ?? undefined,
    failedAt: row.failed_at ?? undefined,
  }
}

function buildFilterSql(filter: OutboxFilter | undefined): { sql: string, params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter?.projectId !== undefined) {
    clauses.push("project_id = ?")
    params.push(filter.projectId)
  }
  if (filter?.runId !== undefined) {
    clauses.push("run_id = ?")
    params.push(filter.runId)
  }
  if (filter?.destination !== undefined) {
    clauses.push("destination = ?")
    params.push(filter.destination)
  }
  if (filter?.status !== undefined) {
    clauses.push("status = ?")
    params.push(filter.status)
  }
  if (filter?.readyAt !== undefined) {
    clauses.push("(next_attempt_at IS NULL OR next_attempt_at <= ?)")
    params.push(filter.readyAt)
  }
  return { sql: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "", params }
}

/**
 * Outbox delivery primitives.
 *
 * This module deliberately provides *storage* only. It does not open sockets,
 * call runtimes, or schedule retries; the delivery loop and its backoff policy
 * belong to the M3.7 dispatch coordinator, which injects its own clock and
 * transport.
 *
 * Delivery contract, stated honestly: **at-least-once**. A claim only records
 * intent to deliver; it cannot make a remote effect happen exactly once. A
 * crash after the remote accepted the payload but before the local
 * acknowledgement commits will cause the record to be redelivered after its
 * lease expires. Exactly-once *accepted intent* is provided by the event
 * transaction (unique command receipt + unique outbox delivery key), not here.
 *
 * **There is no ambient clock in this module.** Every method that stamps a time
 * takes it: `now` is REQUIRED rather than optional, and the module exports no
 * `nowIso` for a caller to fall back on. That is the deliberate choice over the
 * two easier ones. An optional `now` with a `new Date()` behind it is a default
 * that defeats the rule it appears to honour — a caller who forgets it gets a
 * row stamped with a real instant, and nothing fails, so the omission is
 * invisible until a test that moves a clock by hand quietly asserts against
 * whatever the wall clock said. And a helper exported "just in case" is one more
 * thing for the next caller to reach for. Every call site already passed `now`
 * explicitly, so requiring it removes a path nothing used and makes the
 * compiler the thing that catches the next mistake.
 */
export class OutboxStore {
  readonly driver: SqliteDriver

  constructor(driver: SqliteDriver) {
    this.driver = driver
  }

  getOutboxRecord(outboxId: string): OutboxRecord | undefined {
    const row = this.driver.get<OutboxRecordRow>(
      "SELECT * FROM outbox_records WHERE outbox_id = ?",
      outboxId
    )
    return row ? mapOutboxRow(row) : undefined
  }

  listOutbox(filter?: OutboxFilter & { limit?: number }): OutboxRecord[] {
    const { sql: filterSql, params } = buildFilterSql(filter)
    let sql = `SELECT * FROM outbox_records WHERE 1 = 1${filterSql} ORDER BY created_at ASC, outbox_id ASC`
    if (filter?.limit !== undefined) {
      sql += " LIMIT ?"
      params.push(filter.limit)
    }
    return this.driver.all<OutboxRecordRow>(sql, ...params).map(mapOutboxRow)
  }

  listPendingOutbox(limit = DEFAULT_CLAIM_LIMIT, filter?: OutboxFilter): OutboxRecord[] {
    return this.listOutbox({ ...filter, status: "pending", limit })
  }

  /**
   * Atomically claim up to `limit` deliverable records for a lease of `leaseMs`.
   *
   * Concurrency safety: the whole claim runs inside a single `BEGIN IMMEDIATE`
   * write transaction, and SQLite serialises writers. Two controllers racing on
   * the same store therefore execute their SELECT and UPDATE one after the
   * other; the second one re-reads the already-updated rows and its
   * `status = 'pending'` predicate matches nothing, so it cannot double-claim.
   * A controller on a *different* store (a non-authoritative replica) has no
   * claim authority at all — ADR 0004 forbids building one.
   */
  claimPendingOutbox(options: ClaimOutboxOptions): OutboxClaim {
    const limit = options.limit ?? DEFAULT_CLAIM_LIMIT
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    const claimedAt = options.now
    const token = options.claimToken ?? randomUUID()
    const leaseExpiresAt = new Date(Date.parse(claimedAt) + leaseMs).toISOString() as Timestamp

    const records = this.driver.transaction(() => {
      const { sql: filterSql, params: filterParams } = buildFilterSql({
        ...options,
        status: "pending",
        readyAt: options.now ?? options.readyAt,
      })

      const candidates = this.driver.all<{ outbox_id: string }>(
        `SELECT outbox_id FROM outbox_records
          WHERE status = 'pending'${filterSql}
          ORDER BY created_at ASC, outbox_id ASC
          LIMIT ?`,
        ...filterParams,
        limit
      )

      if (candidates.length === 0) return []

      const placeholders = candidates.map(() => "?").join(", ")
      // `status = 'pending'` is repeated in the UPDATE on purpose: it is the
      // compare-and-set that makes a double claim impossible even if the
      // isolation of the surrounding transaction were ever weakened.
      this.driver.run(
        `UPDATE outbox_records
            SET status = 'sending',
                claim_token = ?,
                lease_expires_at = ?,
                attempts = attempts + 1,
                last_attempted_at = ?,
                last_error = NULL,
                failed_at = NULL
          WHERE status = 'pending' AND outbox_id IN (${placeholders})`,
        token,
        leaseExpiresAt,
        claimedAt,
        ...candidates.map((c) => c.outbox_id)
      )

      return this.driver
        .all<OutboxRecordRow>(
          `SELECT * FROM outbox_records WHERE claim_token = ? AND status = 'sending' ORDER BY created_at ASC, outbox_id ASC`,
          token
        )
        .map(mapOutboxRow)
    })

    return { token, claimedAt, leaseExpiresAt, records }
  }

  /**
   * Extend a claim this caller still owns. Used to keep the lease alive while a
   * slow delivery is in flight. Returns `changed: false` when the record is no
   * longer held by `claimToken` (it was recovered or acknowledged elsewhere),
   * which tells the caller to stop before it performs any further effect.
   */
  markOutboxSending(
    outboxId: string,
    claimToken: string | undefined,
    options: { leaseMs?: number, now: Timestamp }
  ): OutboxWriteResult {
    const now = options.now
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString() as Timestamp

    const changes = this.driver.run(
      `UPDATE outbox_records
          SET lease_expires_at = ?, last_attempted_at = ?
        WHERE outbox_id = ? AND status = 'sending'${claimToken ? " AND claim_token = ?" : ""}`,
      leaseExpiresAt,
      now,
      outboxId,
      ...(claimToken ? [claimToken] : [])
    ).changes

    return {
      outboxId,
      changed: changes > 0,
      record: this.getOutboxRecord(outboxId),
    }
  }

  markOutboxAcknowledged(outboxId: string, now: Timestamp): OutboxWriteResult {
    const changes = this.driver.run(
      `UPDATE outbox_records
          SET status = 'acknowledged', acknowledged_at = ?, claim_token = NULL, lease_expires_at = NULL
        WHERE outbox_id = ? AND status != 'acknowledged'`,
      now,
      outboxId
    ).changes

    return {
      outboxId,
      changed: changes > 0,
      record: this.getOutboxRecord(outboxId),
    }
  }

  /**
   * Record a delivery failure. The record returns to `pending` when a
   * `nextAttemptAt` backoff is supplied (normal retryable failure), and to the
   * terminal `failed` state when it is omitted (poison message requiring
   * operator action). `attempts` is never reset, so poison detection in the
   * coordinator can key off it.
   */
  markOutboxFailed(
    outboxId: string,
    error: unknown,
    options: { claimToken?: string, nextAttemptAt?: Timestamp, now: Timestamp }
  ): OutboxWriteResult {
    const now = options.now
    const message = truncateError(error)
    const retrying = options.nextAttemptAt !== undefined

    const changes = this.driver.run(
      `UPDATE outbox_records
          SET status = ?,
              last_error = ?,
              next_attempt_at = ?,
              failed_at = ?,
              claim_token = NULL,
              lease_expires_at = NULL
        WHERE outbox_id = ? AND status = 'sending'${options.claimToken ? " AND claim_token = ?" : ""}`,
      retrying ? "pending" : "failed",
      message,
      retrying ? options.nextAttemptAt! : null,
      retrying ? null : now,
      outboxId,
      ...(options.claimToken ? [options.claimToken] : [])
    ).changes

    return {
      outboxId,
      changed: changes > 0,
      record: this.getOutboxRecord(outboxId),
    }
  }

  /**
   * Requeue records stranded in `sending` because the claiming process died
   * mid-delivery. This is the restart-recovery path for plan failure boundary 5
   * and 6.
   *
   * Safe to call unconditionally at startup and repeatedly: a record whose
   * lease has not yet expired is left alone, and a record that was claimed
   * while this call was running is only touched once its lease lapses.
   */
  recoverStaleOutbox(
    options: { now: Timestamp, runId?: string, projectId?: string, destination?: string }
  ): OutboxRecoveryResult {
    const now = options.now
    const { sql: filterSql, params: filterParams } = buildFilterSql({
      projectId: options.projectId,
      runId: options.runId,
      destination: options.destination,
    })

    return this.driver.transaction(() => {
      const stale = this.driver.all<{ outbox_id: string }>(
        `SELECT outbox_id FROM outbox_records
          WHERE status = 'sending'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?${filterSql}
          ORDER BY created_at ASC, outbox_id ASC`,
        now,
        ...filterParams
      )

      if (stale.length === 0) {
        return { recovered: [], exhausted: [], requeuedCount: 0, failedCount: 0 }
      }

      const ids = stale.map((s) => s.outbox_id)
      const placeholders = ids.map(() => "?").join(", ")

      this.driver.run(
        `UPDATE outbox_records
            SET status = 'pending',
                claim_token = NULL,
                lease_expires_at = NULL,
                last_error = COALESCE(last_error, 'claim lease expired before acknowledgement')
          WHERE status = 'sending' AND lease_expires_at <= ? AND outbox_id IN (${placeholders})`,
        now,
        ...ids
      )

      const recovered = this.driver
        .all<{ outbox_id: string }>(
          `SELECT outbox_id FROM outbox_records WHERE status = 'pending' AND outbox_id IN (${placeholders})`,
          ...ids
        )
        .map((r) => r.outbox_id)

      return {
        recovered,
        exhausted: [],
        requeuedCount: recovered.length,
        failedCount: 0,
      }
    })
  }

  /**
   * Terminal poison-message handling. Records that exceeded `maxAttempts` are
   * moved to `failed` and stop being claimable, but they are never deleted —
   * the outbox is evidence, not a cache.
   *
   * `next_attempt_at` is cleared in the SAME statement that sets `status`. The
   * claim predicate filters on `status = 'pending'`, so a terminal row carrying a
   * future deadline is not claimable and nothing functional depends on it — which
   * is exactly why it is the kind of lie that survives: an operator reading the
   * row sees a retry time, and any scheduler that computes a wake time from that
   * column wakes for a record that will never be delivered again. A retained row
   * must say it is terminal in every column that means anything.
   */
  exhaustOutbox(
    outboxId: string,
    error: unknown,
    options: { now: Timestamp }
  ): OutboxWriteResult {
    const now = options.now
    const changes = this.driver.run(
      `UPDATE outbox_records
          SET status = 'failed', last_error = ?, failed_at = ?,
              next_attempt_at = NULL, claim_token = NULL, lease_expires_at = NULL
        WHERE outbox_id = ? AND status IN ('pending', 'sending')`,
      truncateError(error),
      now,
      outboxId
    ).changes
    return { outboxId, changed: changes > 0, record: this.getOutboxRecord(outboxId) }
  }

  countOutbox(filter?: OutboxFilter): number {
    const { sql: filterSql, params } = buildFilterSql(filter)
    const row = this.driver.get<{ total: number }>(
      `SELECT COUNT(*) as total FROM outbox_records WHERE 1 = 1${filterSql}`,
      ...params
    )
    return row?.total ?? 0
  }
}

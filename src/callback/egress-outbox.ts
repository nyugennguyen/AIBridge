/**
 * M7.8 / ADR 0008 §2.6: Durable egress outbox for callback report delivery.
 *
 * ## Invariants
 *
 * 1. Destination origin resolves against `config.agents[].url` BEFORE any
 *    `Authorization` header is constructed (closes F-02).
 * 2. Unlisted origins are rejected at enqueue; no credential constructed.
 * 3. Two durable writes: claim and acknowledge are separate commits (SF-08).
 * 4. Terminal records are RETAINED with `terminal_error`, never deleted.
 * 5. Attempts are preserved across `recoverStale`.
 * 6. Peer-offline retries use `DELIVERY_BACKOFF_MS` up to 300s ceiling (survives 10m).
 */

import { randomBytes } from "node:crypto"
import {
  createSqliteDriver,
  type SqliteDriver,
} from "../orchestration/event-store/sqlite-driver.js"
import {
  assertDestinationOriginAllowed,
  safeEgressFetch,
  type AgentOriginConfig,
} from "./origin.js"
import type { ReportCallback } from "./types.js"
import {
  backoffDelayMs,
  exceedsMaxAttempts,
  MESH_OUTBOX_CLAIM_LEASE_MS,
} from "../mesh/outbox/policy.js"

export interface EgressOutboxRow {
  readonly outbox_id: string
  readonly job_id: string
  readonly destination_url: string
  readonly destination_origin: string
  readonly payload_json: string
  readonly created_at_ms: number
  readonly next_attempt_at_ms: number | null
  readonly attempts: number
  readonly claim_token: string | null
  readonly claimed_at_ms: number | null
  readonly status: "pending" | "sending" | "delivered" | "failed"
  readonly last_error: string | null
  readonly terminal_error: string | null
}

export class EgressOutboxStore {
  readonly #driver: SqliteDriver

  constructor(pathOrDriver: string | SqliteDriver) {
    if (typeof pathOrDriver === "string") {
      this.#driver = createSqliteDriver({ path: pathOrDriver, create: true })
      this.#driver.exec("PRAGMA journal_mode = WAL")
      this.#driver.exec("PRAGMA synchronous = FULL")
      this.#driver.exec("PRAGMA busy_timeout = 5000")
      this.#driver.exec("PRAGMA foreign_keys = ON")
    } else {
      this.#driver = pathOrDriver
    }
    this.ensureSchema()
  }

  private ensureSchema(): void {
    this.#driver.exec(`
      CREATE TABLE IF NOT EXISTS egress_outbox (
        outbox_id          TEXT PRIMARY KEY,
        job_id             TEXT NOT NULL,
        destination_url    TEXT NOT NULL,
        destination_origin TEXT NOT NULL,
        payload_json       TEXT NOT NULL,
        created_at_ms      INTEGER NOT NULL,
        next_attempt_at_ms INTEGER,
        attempts           INTEGER NOT NULL DEFAULT 0,
        claim_token        TEXT,
        claimed_at_ms      INTEGER,
        status             TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
        last_error         TEXT,
        terminal_error     TEXT,
        CHECK (attempts >= 0)
      );
      CREATE INDEX IF NOT EXISTS egress_outbox_claimable
        ON egress_outbox (status, next_attempt_at_ms);
    `)
  }

  /**
   * Enqueues a report callback after validating the destination origin.
   *
   * Rejects BEFORE ANY header is constructed if origin is unlisted.
   */
  enqueue(params: {
    readonly outboxId?: string
    readonly jobId: string
    readonly callbackUrl: string
    readonly report: ReportCallback
    readonly agents: readonly AgentOriginConfig[]
    readonly nowMs?: number
  }): EgressOutboxRow {
    // 1. Resolve and validate destination origin BEFORE anything else
    const { origin } = assertDestinationOriginAllowed(params.callbackUrl, params.agents)

    const outboxId = params.outboxId ?? `egress_${randomBytes(12).toString("hex")}`
    const nowMs = params.nowMs ?? Date.now()
    const payloadJson = JSON.stringify(params.report)

    this.#driver.run(
      `INSERT INTO egress_outbox (
        outbox_id, job_id, destination_url, destination_origin, payload_json,
        created_at_ms, next_attempt_at_ms, attempts, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending')
      ON CONFLICT(outbox_id) DO NOTHING`,
      outboxId,
      params.jobId,
      params.callbackUrl,
      origin,
      payloadJson,
      nowMs,
      nowMs,
    )

    return this.get(outboxId)!
  }

  get(outboxId: string): EgressOutboxRow | null {
    const row = this.#driver.get<EgressOutboxRow>(
      "SELECT * FROM egress_outbox WHERE outbox_id = ?",
      outboxId,
    )
    return row ?? null
  }

  getByJobId(jobId: string): readonly EgressOutboxRow[] {
    return this.#driver.all<EgressOutboxRow>(
      "SELECT * FROM egress_outbox WHERE job_id = ? ORDER BY created_at_ms ASC",
      jobId,
    )
  }

  /**
   * Claims ready records for transmission. Claim token is minted per batch.
   */
  claim(nowMs: number, limit = 10): { readonly token: string; readonly rows: readonly EgressOutboxRow[] } {
    const token = randomBytes(16).toString("hex")

    this.#driver.transaction(() => {
      this.#driver.run(
        `UPDATE egress_outbox
         SET status = 'sending',
             claim_token = ?,
             claimed_at_ms = ?,
             attempts = attempts + 1
         WHERE outbox_id IN (
           SELECT outbox_id FROM egress_outbox
           WHERE status = 'pending' AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
           ORDER BY created_at_ms ASC
           LIMIT ?
         )`,
        token,
        nowMs,
        nowMs,
        limit,
      )
    })

    const rows = this.#driver.all<EgressOutboxRow>(
      "SELECT * FROM egress_outbox WHERE claim_token = ? AND status = 'sending'",
      token,
    )

    return { token, rows }
  }

  /**
   * Acknowledges successful delivery.
   */
  acknowledge(outboxId: string, claimToken: string): void {
    const result = this.#driver.run(
      `UPDATE egress_outbox
       SET status = 'delivered',
           claim_token = NULL,
           claimed_at_ms = NULL,
           next_attempt_at_ms = NULL
       WHERE outbox_id = ? AND claim_token = ? AND status = 'sending'`,
      outboxId,
      claimToken,
    )

    if (result.changes === 0) {
      throw new Error(`Cannot acknowledge egress record '${outboxId}': not in 'sending' status with matching token`)
    }
  }

  /**
   * Records a delivery failure, scheduling retry or marking terminal.
   *
   * Terminal records are RETAINED with `terminal_error`, never deleted.
   */
  fail(outboxId: string, claimToken: string, errorCode: string, nowMs: number): "requeued" | "terminal" {
    const row = this.#driver.get<{ attempts: number }>(
      "SELECT attempts FROM egress_outbox WHERE outbox_id = ? AND claim_token = ? AND status = 'sending'",
      outboxId,
      claimToken,
    )

    if (!row) return "requeued"

    const code = errorCode.slice(0, 128)
    if (exceedsMaxAttempts(row.attempts)) {
      this.#driver.run(
        `UPDATE egress_outbox
         SET status = 'failed',
             claim_token = NULL,
             claimed_at_ms = NULL,
             next_attempt_at_ms = NULL,
             last_error = ?,
             terminal_error = ?
         WHERE outbox_id = ? AND claim_token = ? AND status = 'sending'`,
        code,
        code,
        outboxId,
        claimToken,
      )
      return "terminal"
    }

    const delayMs = backoffDelayMs(row.attempts)
    const nextAttemptAtMs = nowMs + delayMs

    this.#driver.run(
      `UPDATE egress_outbox
       SET status = 'pending',
           claim_token = NULL,
           claimed_at_ms = NULL,
           next_attempt_at_ms = ?,
           last_error = ?
       WHERE outbox_id = ? AND claim_token = ? AND status = 'sending'`,
      nextAttemptAtMs,
      code,
      outboxId,
      claimToken,
    )

    return "requeued"
  }

  /**
   * Reclaims stale claims whose lease has expired, PRESERVING attempt count.
   */
  recoverStale(nowMs: number, leaseMs = MESH_OUTBOX_CLAIM_LEASE_MS): number {
    const threshold = nowMs - leaseMs
    const result = this.#driver.run(
      `UPDATE egress_outbox
       SET status = 'pending',
           claim_token = NULL,
           claimed_at_ms = NULL,
           next_attempt_at_ms = ?
       WHERE status = 'sending' AND claimed_at_ms IS NOT NULL AND claimed_at_ms < ?`,
      nowMs,
      threshold,
    )

    return result.changes
  }

  /**
   * Delivers a single claimed row with safety checks.
   */
  async deliverClaimedRow(
    row: EgressOutboxRow,
    claimToken: string,
    bearerToken: string,
    options?: {
      readonly fetcher?: (url: string, init?: RequestInit) => Promise<Response>
      readonly nowMs?: number
    },
  ): Promise<void> {
    const fetcher = options?.fetcher ?? fetch
    const nowMs = options?.nowMs ?? Date.now()

    try {
      const response = await safeEgressFetch(
        fetcher,
        row.destination_url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            "Content-Type": "application/json",
          },
          body: row.payload_json,
        },
        row.destination_origin,
      )

      if (response.ok) {
        this.acknowledge(row.outbox_id, claimToken)
      } else {
        this.fail(row.outbox_id, claimToken, `HTTP_${response.status}`, nowMs)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.fail(row.outbox_id, claimToken, message, nowMs)
    }
  }

  close(): void {
    this.#driver.close()
  }
}

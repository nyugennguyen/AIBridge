/**
 * Outbox repair tooling for mesh outbox, ingress outbox, and egress outbox (M8.2, M7-C1).
 *
 * Invariant: Terminal outbox rows are forensic EVIDENCE and must NEVER be deleted
 * to "fix" a backlog. Repair tooling reclaims stale/orphaned in-flight claims,
 * preserves attempt counters, reindexes corrupted indices, and exports evidence.
 */

import {
  createSqliteDriver,
  type SqliteDriver,
} from "../orchestration/event-store/sqlite-driver.js"
import { createDatabaseBackup } from "./backup.js"
import { checkDatabaseIntegrity } from "./integrity.js"
import type {
  OutboxKind,
  OutboxRepairOptions,
  OutboxRepairReport,
  OutboxRowEvidence,
  OutboxStats,
} from "./types.js"

export function repairOutboxStore(
  pathOrDriver: string | SqliteDriver,
  storeType?: OutboxKind | "auto",
  options?: OutboxRepairOptions,
): OutboxRepairReport {
  let driver: SqliteDriver
  let shouldClose = false
  if (typeof pathOrDriver === "string") {
    // If backup requested (default true when path exists), perform backup first
    if (options?.backup !== false) {
      const backupPath =
        options?.backupPath ?? `${pathOrDriver}.pre-repair.${Date.now()}.bak`
      createDatabaseBackup(pathOrDriver, backupPath)
    }
    driver = createSqliteDriver({ path: pathOrDriver, create: false })
    shouldClose = true
  } else {
    driver = pathOrDriver
  }

  try {
    const tableRows = driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    const tables = tableRows.map((r) => r.name)

    // Determine target kind
    let resolvedKind: OutboxKind
    if (!storeType || storeType === "auto") {
      if (tables.includes("ingress_outbox")) {
        resolvedKind = "ingress"
      } else if (tables.includes("egress_outbox") && !tables.includes("outbox_records")) {
        resolvedKind = "egress"
      } else if (tables.includes("outbox_records")) {
        resolvedKind = "mesh"
      } else {
        throw new Error(
          `Cannot determine outbox kind from tables: ${tables.join(", ")}`,
        )
      }
    } else {
      resolvedKind = storeType
    }

    let reclaimedStaleClaims = 0
    let terminalEvidenceRows: OutboxRowEvidence[] = []

    if (resolvedKind === "ingress") {
      // 1. Gather terminal evidence rows — NEVER DELETED!
      const terminalRows = driver.all<{
        job_id: string
        status: string
        attempts: number
        created_at_ms: number
        last_error: string | null
        terminal_error: string | null
      }>(
        "SELECT job_id, status, attempts, created_at_ms, last_error, terminal_error FROM ingress_outbox WHERE status = 'failed' OR terminal_error IS NOT NULL",
      )
      terminalEvidenceRows = terminalRows.map((r) => ({
        id: r.job_id,
        status: r.status,
        attempts: r.attempts,
        terminalError: r.terminal_error,
        lastError: r.last_error,
        createdAt: r.created_at_ms,
      }))

      // 2. Reclaim stale/orphaned claims (status = 'sending') -> reset to 'pending'
      // Preserves attempts count!
      const result = driver.run(
        `UPDATE ingress_outbox
         SET status = 'pending',
             claim_token = NULL,
             claimed_at_ms = NULL
         WHERE status = 'sending'`,
      )
      reclaimedStaleClaims = result.changes

      // 3. Reindex
      driver.exec("REINDEX ingress_outbox")
    } else if (resolvedKind === "egress") {
      // 1. Gather terminal evidence rows — NEVER DELETED!
      const terminalRows = driver.all<{
        outbox_id: string
        status: string
        attempts: number
        created_at_ms: number
        last_error: string | null
        terminal_error: string | null
      }>(
        "SELECT outbox_id, status, attempts, created_at_ms, last_error, terminal_error FROM egress_outbox WHERE status = 'failed' OR terminal_error IS NOT NULL",
      )
      terminalEvidenceRows = terminalRows.map((r) => ({
        id: r.outbox_id,
        status: r.status,
        attempts: r.attempts,
        terminalError: r.terminal_error,
        lastError: r.last_error,
        createdAt: r.created_at_ms,
      }))

      // 2. Reclaim stale claims
      const result = driver.run(
        `UPDATE egress_outbox
         SET status = 'pending',
             claim_token = NULL,
             claimed_at_ms = NULL
         WHERE status = 'sending'`,
      )
      reclaimedStaleClaims = result.changes

      // 3. Reindex
      driver.exec("REINDEX egress_outbox")
    } else {
      // Mesh outbox (outbox_records)
      const terminalRows = driver.all<{
        outbox_id: string
        status: string
        attempts: number
        created_at: string
      }>(
        "SELECT outbox_id, status, attempts, created_at FROM outbox_records WHERE status = 'failed' OR attempts >= 8",
      )
      terminalEvidenceRows = terminalRows.map((r) => ({
        id: r.outbox_id,
        status: r.status,
        attempts: r.attempts,
        terminalError: r.attempts >= 8 ? "MAX_ATTEMPTS_EXCEEDED" : null,
        lastError: null,
        createdAt: r.created_at,
      }))

      // Reclaim stale claims, preserving attempts
      const result = driver.run(
        `UPDATE outbox_records
         SET status = 'pending',
             claim_token = NULL,
             claimed_at = NULL
         WHERE status = 'sending'`,
      )
      reclaimedStaleClaims = result.changes

      driver.exec("REINDEX outbox_records")
    }

    const postCheck = checkDatabaseIntegrity(driver)
    const postRepairStats: OutboxStats = postCheck.outboxStats ?? {
      total: 0,
      pending: 0,
      sending: 0,
      delivered: 0,
      failed: 0,
      terminalEvidenceRows: terminalEvidenceRows.length,
    }

    return {
      storeType: resolvedKind,
      reclaimedStaleClaims,
      reindexed: true,
      terminalEvidenceRows,
      postRepairStats,
      ...(typeof pathOrDriver === "string" && options?.backup !== false
        ? { backupPath: options?.backupPath }
        : {}),
    }
  } finally {
    if (shouldClose) {
      driver.close()
    }
  }
}

/**
 * Storage integrity, backup, restore, projection rebuild, and outbox repair types.
 * Milestone 8: Hardening and Ecosystem (M8.2, M7-C1, M7-C7).
 */

export type DatabaseStatus = "healthy" | "corrupt" | "unsupported_version"

export interface OutboxRowEvidence {
  readonly id: string
  readonly status: string
  readonly attempts: number
  readonly terminalError: string | null
  readonly lastError: string | null
  readonly createdAt: number | string
}

export interface OutboxStats {
  readonly total: number
  readonly pending: number
  readonly sending: number
  readonly delivered: number
  readonly failed: number
  readonly terminalEvidenceRows: number
}

export interface IntegrityCheckReport {
  readonly ok: boolean
  readonly status: DatabaseStatus
  readonly dbPath: string
  readonly userVersion: number
  readonly supportedVersion: number
  readonly pragmaResult: string
  readonly errors: readonly string[]
  readonly tables: readonly string[]
  readonly outboxStats?: OutboxStats
}

export interface BackupOptions {
  readonly checkpoint?: boolean
  readonly verify?: boolean
}

export interface BackupResult {
  readonly sourcePath: string
  readonly backupPath: string
  readonly bytes: number
  readonly verified: boolean
  readonly timestampMs: number
}

export interface RestoreOptions {
  readonly preRestoreBackupPath?: string
  readonly verify?: boolean
}

export interface RestoreResult {
  readonly backupPath: string
  readonly destinationPath: string
  readonly preRestoreBackupPath?: string
  readonly restored: boolean
  readonly verified: boolean
}

export interface ProjectionRebuildRunResult {
  readonly runId: string
  readonly eventsCount: number
  readonly verified: boolean
}

export interface RebuildProjectionsResult {
  readonly rebuiltRuns: number
  readonly runs: readonly ProjectionRebuildRunResult[]
}

export type OutboxKind = "mesh" | "ingress" | "egress"

export interface OutboxRepairOptions {
  readonly backup?: boolean
  readonly backupPath?: string
  readonly nowMs?: number
  readonly leaseMs?: number
}

export interface OutboxRepairReport {
  readonly storeType: OutboxKind
  readonly reclaimedStaleClaims: number
  readonly reindexed: boolean
  readonly terminalEvidenceRows: readonly OutboxRowEvidence[]
  readonly backupPath?: string
  readonly postRepairStats: OutboxStats
}

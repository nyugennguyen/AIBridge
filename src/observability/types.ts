/**
 * Structured observability and operational telemetry types (M8.3, M7-C2).
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

export type LogEventName =
  | "ingress.admitted"
  | "ingress.rejected"
  | "ingress.rate_limited"
  | "inbox.received"
  | "inbox.persisted"
  | "inbox.duplicate"
  | "outbox.enqueued"
  | "outbox.claimed"
  | "outbox.delivered"
  | "outbox.failed"
  | "outbox.terminal"
  | "outbox.reclaimed"
  | "lease.acquired"
  | "lease.renewed"
  | "lease.expired"
  | "lease.refused"
  | "projection.updated"
  | "projection.rebuilt"
  | "terminal.attached"
  | "terminal.detached"
  | "terminal.frame_dropped"
  | "terminal.buffer_pressure"
  | "rule.evaluated"
  | "rule.denied"
  | "storage.checked"
  | "storage.backup_created"
  | "storage.restored"
  | "storage.repaired"
  | "node.heartbeat"
  | "node.health_changed"

export interface CorrelationFields {
  readonly correlationId?: string
  readonly jobId?: string
  readonly projectId?: string
  readonly runId?: string
  readonly taskId?: string
  readonly dispatchId?: string
  readonly sessionId?: string
  readonly nodeId?: string
  readonly controllerEpoch?: number
  readonly adapterKind?: string
  readonly backendKind?: string
}

export interface StructuredLogEntry extends CorrelationFields {
  readonly timestamp: string
  readonly level: LogLevel
  readonly event: LogEventName | string
  readonly durationMs?: number
  readonly result?: "success" | "failure" | "denied" | "timeout"
  readonly errorCode?: string
  readonly attributes?: Readonly<Record<string, unknown>>
}

export interface SessionStateCounts {
  readonly received: number
  readonly accepted: number
  readonly running: number
  readonly completed: number
  readonly failed: number
  readonly timed_out: number
  readonly orphaned: number
}

export interface OperationalSignals {
  readonly timestamp: string
  readonly node: {
    readonly nodeId: string
    readonly health: "healthy" | "degraded" | "unhealthy"
    readonly leaseTimeRemainingMs: number
    readonly epoch: number
  }
  readonly sessions: {
    readonly activeCount: number
    readonly byState: SessionStateCounts
  }
  readonly queues: {
    readonly commandInboxDepth: number
    readonly eventOutboxDepth: number
    readonly eventOutboxOldestAgeMs: number | null
    readonly terminalRowCount: number
  }
  readonly performance: {
    readonly eventAppendLatencyMsP95: number
    readonly projectionLatencyMsP95: number
    readonly eventLoopLagMs: number
  }
  readonly terminal: {
    readonly activeViewers: number
    readonly inputOwnerId: string | null
    readonly droppedFramesTotal: number
    readonly bufferPressure: "normal" | "warning" | "critical"
  }
  readonly rules: {
    readonly denialsTotal: number
    readonly approvalBacklogCount: number
  }
  readonly storage: {
    readonly sizeBytes: number
    readonly artifactUsageBytes: number
    readonly retentionBacklogCount: number
    readonly integrityStatus: "healthy" | "corrupt" | "unsupported_version"
  }
  readonly ingress: {
    readonly admissionRatePerSec: number
    readonly admissionsTotal: number
    readonly rejectionsTotal: number
    readonly rejectionReasons: Readonly<Record<string, number>>
    readonly ingressOutboxDepth: number
    readonly ingressOldestAgeMs: number | null
    readonly egressOutboxDepth: number
    readonly terminalRowCount: number
    readonly bindHealth: "healthy" | "degraded" | "unhealthy"
  }
}

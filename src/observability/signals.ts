/**
 * Operational signals collector (M8.3, M7-C2).
 */

import type { JobManager } from "../jobs/manager.js"
import type { MetricsRegistry } from "./metrics.js"
import type {
  OperationalSignals,
  SessionStateCounts,
} from "./types.js"

export interface SignalDependencies {
  readonly nodeId: string
  readonly nodeHealth?: "healthy" | "degraded" | "unhealthy"
  readonly leaseTimeRemainingMs?: number
  readonly epoch?: number
  readonly jobManager?: JobManager
  readonly metrics?: MetricsRegistry
  readonly ingressStats?: {
    readonly admissionsTotal?: number
    readonly rejectionsTotal?: number
    readonly rejectionReasons?: Record<string, number>
    readonly depth?: number
    readonly oldestAgeMs?: number | null
    readonly bindHealth?: "healthy" | "degraded" | "unhealthy"
  }
  readonly egressStats?: {
    readonly depth?: number
    readonly terminalRows?: number
  }
  readonly storageIntegrity?: "healthy" | "corrupt" | "unsupported_version"
  readonly storageSizeBytes?: number
  readonly artifactUsageBytes?: number
  readonly terminalViewers?: number
  readonly terminalInputOwnerId?: string | null
  readonly droppedFrames?: number
  readonly bufferPressure?: "normal" | "warning" | "critical"
  readonly ruleDenials?: number
  readonly approvalBacklog?: number
}

export async function collectOperationalSignals(
  deps: SignalDependencies,
): Promise<OperationalSignals> {
  const counts: Record<string, number> = {
    received: 0,
    accepted: 0,
    running: 0,
    completed: 0,
    failed: 0,
    timed_out: 0,
    orphaned: 0,
  }

  let activeCount = 0
  if (deps.jobManager) {
    try {
      const allJobs = await deps.jobManager.listJobs()
      for (const job of allJobs) {
        if (job.status in counts) {
          counts[job.status] = (counts[job.status] ?? 0) + 1
        }
        if (job.status === "running" || job.status === "accepted" || job.status === "received") {
          activeCount++
        }
      }
    } catch {
      // Ignored if job store temporarily busy
    }
  }

  const byState: SessionStateCounts = {
    received: counts["received"] ?? 0,
    accepted: counts["accepted"] ?? 0,
    running: counts["running"] ?? 0,
    completed: counts["completed"] ?? 0,
    failed: counts["failed"] ?? 0,
    timed_out: counts["timed_out"] ?? 0,
    orphaned: counts["orphaned"] ?? 0,
  }

  const p95Append = deps.metrics?.getTimingStats("event_append_latency_ms").p95 ?? 0
  const p95Projection = deps.metrics?.getTimingStats("projection_latency_ms").p95 ?? 0

  return {
    timestamp: new Date().toISOString(),
    node: {
      nodeId: deps.nodeId,
      health: deps.nodeHealth ?? "healthy",
      leaseTimeRemainingMs: deps.leaseTimeRemainingMs ?? 30000,
      epoch: deps.epoch ?? 1,
    },
    sessions: {
      activeCount,
      byState,
    },
    queues: {
      commandInboxDepth: deps.metrics?.getGauge("command_inbox_depth") ?? 0,
      eventOutboxDepth: deps.metrics?.getGauge("event_outbox_depth") ?? 0,
      eventOutboxOldestAgeMs: deps.metrics?.getGauge("event_outbox_oldest_age_ms") ?? null,
      terminalRowCount: deps.egressStats?.terminalRows ?? 0,
    },
    performance: {
      eventAppendLatencyMsP95: p95Append,
      projectionLatencyMsP95: p95Projection,
      eventLoopLagMs: 0,
    },
    terminal: {
      activeViewers: deps.terminalViewers ?? 0,
      inputOwnerId: deps.terminalInputOwnerId ?? null,
      droppedFramesTotal: deps.droppedFrames ?? 0,
      bufferPressure: deps.bufferPressure ?? "normal",
    },
    rules: {
      denialsTotal: deps.ruleDenials ?? 0,
      approvalBacklogCount: deps.approvalBacklog ?? 0,
    },
    storage: {
      sizeBytes: deps.storageSizeBytes ?? 0,
      artifactUsageBytes: deps.artifactUsageBytes ?? 0,
      retentionBacklogCount: 0,
      integrityStatus: deps.storageIntegrity ?? "healthy",
    },
    ingress: {
      admissionRatePerSec: deps.metrics?.getGauge("ingress_admission_rate") ?? 0,
      admissionsTotal: deps.ingressStats?.admissionsTotal ?? 0,
      rejectionsTotal: deps.ingressStats?.rejectionsTotal ?? 0,
      rejectionReasons: deps.ingressStats?.rejectionReasons ?? {},
      ingressOutboxDepth: deps.ingressStats?.depth ?? 0,
      ingressOldestAgeMs: deps.ingressStats?.oldestAgeMs ?? null,
      egressOutboxDepth: deps.egressStats?.depth ?? 0,
      terminalRowCount: deps.egressStats?.terminalRows ?? 0,
      bindHealth: deps.ingressStats?.bindHealth ?? "healthy",
    },
  }
}

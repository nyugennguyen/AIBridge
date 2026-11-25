import type { RemoteDependency, ReportFinding, TriggerRequest } from "../config/types.js"

export type JobStatus =
  | "received"
  | "accepted"
  | "blocked"        // waiting for dependencies
  | "session_created"
  | "running"
  | "reporting"
  | "completed"
  | "failed"
  | "timed_out"
  | "callback_failed"

export interface JobRecord {
  id: string
  trigger: TriggerRequest
  status: JobStatus
  opencodeSessionId?: string
  /** Runtime that executes this job; absent on records written before runtimes were selectable (OpenCode). */
  runtime?: "opencode" | "claude"
  /** The runtime's own session id for non-OpenCode runtimes (Claude Code's session UUID). */
  runtimeSessionId?: string
  /** What the runtime reported when the job reached a terminal state; carried into the report callback. */
  runtimeResult?: RuntimeJobResult
  error?: string
  depends_on?: string[]      // dependency job IDs
  remoteDependencies?: RemoteDependencyState[]
  callbackDelivery?: CallbackDeliveryState
  blockedAt?: string         // when entered blocked state
  createdAt: string
  updatedAt: string
}

export type RemoteDependencyStatus = "completed" | "failed" | "timed_out" | "callback_failed"

export interface RemoteDependencyState extends RemoteDependency {
  status?: RemoteDependencyStatus
  reportedAt?: string
}

export interface RemoteDependencyReport {
  source_agent_id: string
  job_id: string
  status: RemoteDependencyStatus
}

export interface CallbackDeliveryState {
  status: "pending" | "delivered" | "failed"
  attemptedAt: string
  error?: string
}

/**
 * The outcome a runtime reported for a job, persisted so a report re-delivered
 * after a restart (`listCallbackRetries`) carries the same summary and findings
 * as the first attempt.
 */
export interface RuntimeJobResult {
  summary: string
  findings: ReportFinding[]
  usage?: RuntimeJobUsage
}

export interface RuntimeJobUsage {
  providerSessionId?: string
  model?: string
  resultSubtype?: string
  totalCostUsd?: number
  numTurns?: number
  durationMs?: number
  permissionDenials?: number
}

import type { RemoteDependency, ReportFinding, ScriptResult, TriggerRequest } from "../config/types.js"

export type JobStatus =
  | "received"
  | "accepted"
  | "awaiting_approval" // held until an operator approves it on this node (Claude runtime)
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
  /** The operator decision for an approval-gated job. Written only by the operator endpoints. */
  approval?: JobApproval
  /** The commit the job is pinned to, resolved when the trigger was accepted (`repo` + `ref`). */
  checkout?: JobCheckout
  /** Set on `aibr ping` jobs only: what this node says about itself to an enrolled caller. */
  pong?: PongInfo
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
  /** Deterministic steps (`pre`, `script`, `post`) the job ran, in order. */
  scriptResults?: ScriptResult[]
}

/**
 * The answer to an `aibr ping` (capability `aibr.ping`): a no-op job that proves
 * a signed, authorized `/trigger` and the `/report` callback both work.
 * `projects` are the directories this node allowlists, so a caller can address
 * work (`aibr send`) without guessing a path on another machine.
 */
export interface PongInfo {
  agent_id: string
  role: string
  runtime: string
  version: string
  /** Capabilities this node accepts from the caller (its `allowed_sources` entry). */
  capabilities: string[]
  projects: { id: string; path: string; capabilities: string[] }[]
}

export interface JobApproval {
  status: "pending" | "approved" | "rejected"
  requestedAt: string
  decidedAt?: string
  /** Who decided: always the operator credential on this node, never a caller claim. */
  decidedBy?: "operator"
  reason?: string
}

export interface JobCheckout {
  /** Key of the worker's `repositories` map. */
  repo: string
  /** The ref the trigger asked for (or the repository's default). */
  ref: string
  /** The full commit sha `ref` resolved to; the job runs at exactly this commit. */
  sha: string
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

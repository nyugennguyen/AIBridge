import type { RemoteDependency, TriggerRequest } from "../config/types.js"

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

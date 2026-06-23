import type { TriggerRequest } from "../config/types.js"

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
  blockedAt?: string         // when entered blocked state
  createdAt: string
  updatedAt: string
}

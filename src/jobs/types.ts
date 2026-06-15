import type { TriggerRequest } from "../config/types.js"

export type JobStatus =
  | "received"
  | "accepted"
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
  createdAt: string
  updatedAt: string
}

// src/tasks/types.ts
export type TaskStatus = "pending" | "blocked" | "running" | "done" | "failed"

export interface TaskEntry {
  id: string           // #1, #2, etc.
  title: string
  agent?: string
  status: TaskStatus
  depends_on: string[] // task IDs (#1, #2)
  job_id?: string      // correlated JobRecord ID
  metadata: Record<string, string>
}

export interface TaskGraphSyncer {
  getTasks(): Promise<TaskEntry[]>
  syncJobToTask(jobId: string, status: string, metadata?: Record<string, string>): Promise<void>
  parseTaskDependencies(): Promise<Map<string, string[]>>
  startWatching(): void
  stopWatching(): void
}

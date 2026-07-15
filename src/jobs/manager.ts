import { randomUUID } from "node:crypto"
import type { TriggerRequest } from "../config/types.js"
import type { JobRecord, JobStatus } from "./types.js"
import type { JobStore } from "./store.js"

const TERMINAL_STATUSES: JobStatus[] = ["completed", "failed", "timed_out", "callback_failed"]

export class JobManager {
  constructor(private readonly store: JobStore) {}

  async createJob(trigger: TriggerRequest, now = new Date().toISOString()): Promise<JobRecord> {
    const id = trigger.job_id ?? `job_${randomUUID()}`
    if (await this.store.get(id)) throw new Error(`Job already exists: ${id}`)
    const job: JobRecord = { id, trigger, status: "accepted", createdAt: now, updatedAt: now }
    await this.store.save(job)
    return job
  }

  async attachSession(id: string, opencodeSessionId: string, now = new Date().toISOString()): Promise<JobRecord> {
    return this.transition(id, "session_created", now, { opencodeSessionId })
  }

  async markRunning(id: string, now = new Date().toISOString()): Promise<JobRecord> {
    return this.transition(id, "running", now)
  }

  async markCompleted(id: string, now = new Date().toISOString()): Promise<JobRecord> {
    return this.transition(id, "completed", now)
  }

  async markFailed(id: string, error: string, now = new Date().toISOString()): Promise<JobRecord> {
    return this.transition(id, "failed", now, { error })
  }

  async markTimedOut(id: string, now = new Date().toISOString()): Promise<JobRecord> {
    return this.transition(id, "timed_out", now, { error: "Job timed out" })
  }

  async markBlocked(id: string, depends_on: string[], now = new Date().toISOString()): Promise<JobRecord> {
    return this.transition(id, "blocked", now, { depends_on, blockedAt: now })
  }

  async unblockDependents(completedJobId: string, now = new Date().toISOString()): Promise<JobRecord[]> {
    const allJobs = await this.store.list()
    const unblocked: JobRecord[] = []

    const dependents = allJobs.filter(
      (j) => j.status === "blocked" && j.depends_on?.includes(completedJobId),
    )

    for (const job of dependents) {
      const deps = job.depends_on ?? []

      const depStatuses = await Promise.all(
        deps.map(async (depId) => {
          const dep = await this.store.get(depId)
          return { id: depId, status: dep?.status ?? "missing" }
        }),
      )

      const failedDep = depStatuses.find(
        (d) => d.status === "failed" || d.status === "timed_out",
      )
      if (failedDep) {
        await this.markFailed(job.id, `Dependency ${failedDep.id} ${failedDep.status}`, now)
        continue
      }

      const allCompleted = depStatuses.every((d) => d.status === "completed")
      if (allCompleted) {
        const record = await this.transition(job.id, "accepted", now)
        unblocked.push(record)
      }
    }

    return unblocked
  }

  async getJob(id: string): Promise<JobRecord> {
    const job = await this.store.get(id)
    if (!job) throw new Error(`Unknown job: ${id}`)
    return job
  }

  async sweepExpiredJobs(now = new Date().toISOString()): Promise<JobRecord[]> {
    const currentTime = new Date(now).getTime()
    const expired: JobRecord[] = []
    for (const job of await this.store.list()) {
      if (TERMINAL_STATUSES.includes(job.status)) continue
      const deadline = new Date(job.createdAt).getTime() + job.trigger.timeout_seconds * 1000
      if (currentTime <= deadline) continue
      expired.push(await this.markTimedOut(job.id, now))
    }
    return expired
  }

  private async transition(id: string, status: JobStatus, now: string, patch: Partial<JobRecord> = {}): Promise<JobRecord> {
    const current = await this.getJob(id)
    if (TERMINAL_STATUSES.includes(current.status) && current.status !== status) {
      throw new Error(`Cannot transition terminal job ${id} from ${current.status} to ${status}`)
    }
    const next: JobRecord = { ...current, ...patch, status, updatedAt: now }
    await this.store.save(next)
    return next
  }
}

import { randomUUID } from "node:crypto"
import type { RemoteDependency, TriggerRequest } from "../config/types.js"
import type { JobRecord, JobStatus, RemoteDependencyReport } from "./types.js"
import type { JobStore } from "./store.js"

const TERMINAL_STATUSES: JobStatus[] = ["completed", "failed", "timed_out", "callback_failed"]

/**
 * Grace period after `blockedAt` (or `createdAt` if `blockedAt` is unset)
 * for a local dependency record to appear in the job store.
 *
 * Admission already verifies local dependency existence, so a "missing"
 * reading afterwards can only stem from a store-convergence gap or race.
 * A missing dependency within this window is treated as still waiting;
 * past this window, it is unresolvable and marked terminally failed.
 */
export const DEPENDENCY_RESOLUTION_WINDOW_MS = 30_000

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

  async markCallbackDelivery(
    id: string,
    status: "pending" | "delivered" | "failed",
    error?: string,
    now = new Date().toISOString(),
  ): Promise<JobRecord> {
    const current = await this.getJob(id)
    const callbackDelivery = error ? { status, attemptedAt: now, error } : { status, attemptedAt: now }
    const next: JobRecord = { ...current, callbackDelivery, updatedAt: now }
    await this.store.save(next)
    return next
  }

  async markBlocked(id: string, dependencies: readonly (string | RemoteDependency)[], now = new Date().toISOString()): Promise<JobRecord> {
    const depends_on = dependencies.filter((dependency): dependency is string => typeof dependency === "string")
    const remoteDependencies = dependencies
      .filter((dependency): dependency is RemoteDependency => typeof dependency !== "string")
      .map((dependency) => ({ ...dependency }))
    return this.transition(id, "blocked", now, { depends_on, remoteDependencies, blockedAt: now })
  }

  async recordRemoteReport(report: RemoteDependencyReport, now = new Date().toISOString()): Promise<JobRecord[]> {
    const unblocked: JobRecord[] = []
    for (const job of await this.store.list()) {
      if (job.status !== "blocked") continue
      const remoteDependencies = job.remoteDependencies ?? []
      const matches = remoteDependencies.some(
        (dependency) => dependency.agent_id === report.source_agent_id && dependency.job_id === report.job_id,
      )
      if (!matches) continue

      const updatedDependencies = remoteDependencies.map((dependency) => {
        if (dependency.agent_id !== report.source_agent_id || dependency.job_id !== report.job_id || dependency.status) return dependency
        return { ...dependency, status: report.status, reportedAt: now }
      })
      const updated = await this.transition(job.id, "blocked", now, { remoteDependencies: updatedDependencies })
      const outcome = await this.dependencyOutcome(updated, now)
      if (outcome.kind === "failed") await this.markFailed(updated.id, outcome.error, now)
      if (outcome.kind === "ready") unblocked.push(await this.transition(updated.id, "accepted", now))
    }
    return unblocked
  }

  async unblockDependents(completedJobId: string, now = new Date().toISOString()): Promise<JobRecord[]> {
    const allJobs = await this.store.list()
    const unblocked: JobRecord[] = []

    const dependents = allJobs.filter(
      (j) => j.status === "blocked" && j.depends_on?.includes(completedJobId),
    )

    for (const job of dependents) {
      const outcome = await this.dependencyOutcome(job, now)
      if (outcome.kind === "failed") await this.markFailed(job.id, outcome.error, now)
      if (outcome.kind === "ready") unblocked.push(await this.transition(job.id, "accepted", now))
    }

    return unblocked
  }

  async getJob(id: string): Promise<JobRecord> {
    const job = await this.store.get(id)
    if (!job) throw new Error(`Unknown job: ${id}`)
    return job
  }

  async listJobs(): Promise<JobRecord[]> {
    return this.store.list()
  }
  async listCallbackRetries(): Promise<JobRecord[]> {
    return (await this.store.list()).filter(
      (job) => job.callbackDelivery?.status === "pending" || job.callbackDelivery?.status === "failed",
    )
  }

  /**
   * Sweeps jobs to terminal states:
   * 1. Blocked jobs with missing local dependencies past the resolution window
   *    are marked failed (with specific diagnosis before generic timeout).
   * 2. Non-terminal jobs past their configured timeout are marked timed_out.
   *
   * Returns all jobs transitioned to a terminal state during this sweep.
   */
  async sweepExpiredJobs(now = new Date().toISOString()): Promise<JobRecord[]> {
    const currentTime = new Date(now).getTime()
    const expired: JobRecord[] = []

    while (true) {
      let transitionedInPass = 0
      for (const job of await this.store.list()) {
        if (TERMINAL_STATUSES.includes(job.status)) continue

        if (job.status === "blocked") {
          const outcome = await this.dependencyOutcome(job, now)
          if (outcome.kind === "failed") {
            expired.push(await this.markFailed(job.id, outcome.error, now))
            transitionedInPass++
            continue
          }
        }

        const deadline = new Date(job.createdAt).getTime() + job.trigger.timeout_seconds * 1000
        if (currentTime <= deadline) continue
        expired.push(await this.markTimedOut(job.id, now))
        transitionedInPass++
      }

      if (transitionedInPass === 0) break
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

  private async dependencyOutcome(
    job: JobRecord,
    now: string,
  ): Promise<{ kind: "waiting" } | { kind: "ready" } | { kind: "failed"; error: string }> {
    const localDependencies = await Promise.all(
      (job.depends_on ?? []).map(async (id) => ({ id, status: (await this.store.get(id))?.status ?? "missing" })),
    )
    const failedLocal = localDependencies.find((dependency) => dependency.status === "failed" || dependency.status === "timed_out")
    if (failedLocal) return { kind: "failed", error: `Dependency ${failedLocal.id} ${failedLocal.status}` }

    const failedRemote = (job.remoteDependencies ?? []).find(
      (dependency) => dependency.status === "failed" || dependency.status === "timed_out" || dependency.status === "callback_failed",
    )
    if (failedRemote?.status) return { kind: "failed", error: `Remote dependency ${failedRemote.agent_id}/${failedRemote.job_id} ${failedRemote.status}` }

    const missingLocal = localDependencies.find((dependency) => dependency.status === "missing")
    if (missingLocal) {
      const anchorTime = Date.parse(job.blockedAt ?? job.createdAt)
      const currentTime = Date.parse(now)
      if (currentTime < anchorTime + DEPENDENCY_RESOLUTION_WINDOW_MS) {
        return { kind: "waiting" }
      }
      return { kind: "failed", error: `Dependency ${missingLocal.id} missing` }
    }

    const localReady = localDependencies.every((dependency) => dependency.status === "completed")
    const remoteReady = (job.remoteDependencies ?? []).every((dependency) => dependency.status === "completed")
    return localReady && remoteReady ? { kind: "ready" } : { kind: "waiting" }
  }
}

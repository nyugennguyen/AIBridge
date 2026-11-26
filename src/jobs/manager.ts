import { randomUUID } from "node:crypto"
import type { RemoteDependency, TriggerRequest } from "../config/types.js"
import type { JobCheckout, JobRecord, JobStatus, PongInfo, RemoteDependencyReport, RuntimeJobResult } from "./types.js"
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

/**
 * When a job's `timeout_seconds` starts counting:
 * - a job waiting for an operator: from creation (the approval window);
 * - a job that began launching: from `launchStartedAt`;
 * - an approved job that has not launched yet: from the operator's decision;
 * - anything else: from creation.
 *
 * Time spent waiting for approval is therefore never charged to the run.
 */
export function jobTimeoutAnchor(job: JobRecord): string {
  if (job.status === "awaiting_approval") return job.createdAt
  if (job.launchStartedAt !== undefined) return job.launchStartedAt
  if (job.approval?.status === "approved" && job.approval.decidedAt !== undefined) return job.approval.decidedAt
  return job.createdAt
}

/** The instant (ms since epoch) after which `sweepExpiredJobs` times the job out. */
export function jobDeadlineMs(job: JobRecord): number {
  return Date.parse(jobTimeoutAnchor(job)) + job.trigger.timeout_seconds * 1000
}

export interface SweepOptions {
  /**
   * Jobs a live monitor in this process is driving. Their runner enforces its
   * own deadline (and terminates the process), so the sweep leaves them alone
   * rather than marking a job terminal while its process keeps running.
   */
  readonly isActive?: (jobId: string) => boolean
}

/**
 * Thrown by `markLaunchStarted` (and the runner) when a job may not be
 * launched: it is not `accepted`, it was launched before, or another launch
 * of it is in progress. Callers leave the job untouched and report nothing.
 */
export class LaunchRefusedError extends Error {
  readonly code = "launch_refused"
}

export interface JobManagerOptions {
  /**
   * Applied to every error string before it is stored on a job. A job's
   * `error` is served by `GET /jobs/:id` and becomes the `/report` summary
   * when no runtime result exists (OpenCode jobs), and it may carry text from
   * a runtime or a library: `createRuntime` passes `redactSecretsFromText`
   * over this node's secrets.
   */
  readonly redactError?: (text: string) => string
}

type TransitionGuard = (current: JobRecord) => boolean

export class JobManager {
  /**
   * Per-job queue: every read-modify-write of a job runs alone, so two paths
   * (a monitor and the sweep, two launches) cannot both read the same state
   * and both write over it.
   */
  private readonly jobLocks = new Map<string, Promise<unknown>>()
  private readonly redactError: (text: string) => string

  constructor(
    private readonly store: JobStore,
    options: JobManagerOptions = {},
  ) {
    this.redactError = options.redactError ?? ((text) => text)
  }

  /**
   * Creates a job. `init.awaitingApproval` creates it held (`awaiting_approval`
   * with a pending approval record) instead of `accepted`; `init.checkout` pins
   * it to a resolved commit.
   */
  async createJob(
    trigger: TriggerRequest,
    now = new Date().toISOString(),
    init: { readonly awaitingApproval?: boolean; readonly checkout?: JobCheckout } = {},
  ): Promise<JobRecord> {
    const id = trigger.job_id ?? `job_${randomUUID()}`
    if (await this.store.get(id)) throw new Error(`Job already exists: ${id}`)
    const job: JobRecord = {
      id,
      trigger,
      status: init.awaitingApproval === true ? "awaiting_approval" : "accepted",
      ...(init.awaitingApproval === true ? { approval: { status: "pending" as const, requestedAt: now } } : {}),
      ...(init.checkout !== undefined ? { checkout: { ...init.checkout } } : {}),
      createdAt: now,
      updatedAt: now,
    }
    await this.store.save(job)
    return job
  }

  /**
   * Operator approval: `awaiting_approval` -> `accepted`. Throws unless the job
   * is awaiting approval, so a second approval of the same job cannot succeed.
   */
  async approve(id: string, now = new Date().toISOString()): Promise<JobRecord> {
    return this.withJobLock(id, async () => {
      const current = await this.getJob(id)
      if (current.status !== "awaiting_approval") throw new Error(`Job ${id} is not awaiting approval (status ${current.status})`)
      const approval = {
        ...(current.approval ?? { requestedAt: current.createdAt }),
        status: "approved" as const,
        decidedAt: now,
        decidedBy: "operator" as const,
      }
      return this.write(current, "accepted", now, { approval })
    })
  }

  /** Operator rejection: `awaiting_approval` -> `failed`, recording the operator's reason as the error. */
  async reject(id: string, reason: string, now = new Date().toISOString()): Promise<JobRecord> {
    return this.withJobLock(id, async () => {
      const current = await this.getJob(id)
      if (current.status !== "awaiting_approval") throw new Error(`Job ${id} is not awaiting approval (status ${current.status})`)
      const approval = {
        ...(current.approval ?? { requestedAt: current.createdAt }),
        status: "rejected" as const,
        decidedAt: now,
        decidedBy: "operator" as const,
        reason,
      }
      return this.write(current, "failed", now, { approval, error: reason })
    })
  }

  async attachSession(id: string, opencodeSessionId: string, now = new Date().toISOString()): Promise<JobRecord> {
    return this.transition(id, "session_created", now, { opencodeSessionId })
  }

  /**
   * Binds a job to a non-OpenCode runtime session. Same lifecycle step as
   * `attachSession` (`session_created`), but the id lives in its own field so
   * `opencodeSessionId` keeps meaning exactly what it says.
   */
  async attachRuntimeSession(
    id: string,
    runtime: "claude",
    runtimeSessionId: string,
    now = new Date().toISOString(),
  ): Promise<JobRecord> {
    return this.transition(id, "session_created", now, { runtime, runtimeSessionId })
  }

  /**
   * Records what the runtime reported, without changing the job's status. Call
   * it before the terminal `mark*` so the terminal record already carries the
   * summary and findings the report callback is built from.
   */
  async recordRuntimeResult(id: string, runtimeResult: RuntimeJobResult, now = new Date().toISOString()): Promise<JobRecord> {
    return this.withJobLock(id, async () => {
      const current = await this.getJob(id)
      if (TERMINAL_STATUSES.includes(current.status)) throw new Error(`Job ${id} is already ${current.status}`)
      const next: JobRecord = { ...current, runtimeResult, updatedAt: now }
      await this.store.save(next)
      return next
    })
  }

  /**
   * Records that this node is about to launch the job on its runtime. Every
   * launch path calls it BEFORE any runtime contact (worktree, spawn, OpenCode
   * session or prompt), so after a restart an `accepted` job without the
   * marker provably never ran. Refuses anything but an `accepted` job that
   * was not launched before: a job awaiting approval, a terminal job or a
   * second launch of the same job never gets past this point.
   */
  async markLaunchStarted(id: string, now = new Date().toISOString()): Promise<JobRecord> {
    // Checked and written under the job's lock: two launch paths racing on
    // the same job in this process cannot both read "not launched yet".
    return this.withJobLock(id, async () => {
      const current = await this.getJob(id)
      if (current.status !== "accepted") throw new LaunchRefusedError(`Job ${id} cannot be launched from status ${current.status}`)
      if (current.launchStartedAt !== undefined) {
        throw new LaunchRefusedError(`Job ${id} was already launched at ${current.launchStartedAt}`)
      }
      return this.write(current, "accepted", now, { launchStartedAt: now })
    })
  }

  async markRunning(id: string, now = new Date().toISOString()): Promise<JobRecord> {
    return this.transition(id, "running", now)
  }

  async markCompleted(id: string, now = new Date().toISOString()): Promise<JobRecord> {
    return this.transition(id, "completed", now)
  }

  /** `aibr ping`: `accepted` -> `completed` at once, carrying the pong. No runtime is involved. */
  async completePing(id: string, pong: PongInfo, now = new Date().toISOString()): Promise<JobRecord> {
    return this.transition(id, "completed", now, {
      pong,
      runtimeResult: { summary: `pong from ${pong.agent_id}`, findings: [] },
    })
  }

  /**
   * Fails the job. `options.maxLength` truncates the error AFTER redaction,
   * so a secret cut by the limit cannot leave its prefix behind.
   */
  async markFailed(
    id: string,
    error: string,
    now = new Date().toISOString(),
    options: { readonly maxLength?: number } = {},
  ): Promise<JobRecord> {
    const redacted = this.redactError(error)
    const stored =
      options.maxLength !== undefined && redacted.length > options.maxLength
        ? `${redacted.slice(0, Math.max(0, options.maxLength - 1))}…`
        : redacted
    return this.transition(id, "failed", now, { error: stored })
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
    return this.withJobLock(id, async () => {
      const current = await this.getJob(id)
      const callbackDelivery = error ? { status, attemptedAt: now, error } : { status, attemptedAt: now }
      const next: JobRecord = { ...current, callbackDelivery, updatedAt: now }
      await this.store.save(next)
      return next
    })
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
   * 2. Non-terminal jobs past their deadline (`jobDeadlineMs`) are marked
   *    timed_out.
   *
   * Runs at startup and periodically while the bridge lives. Jobs for which
   * `options.isActive` answers true are skipped. A job that another path made
   * terminal while the sweep ran is skipped, not an error.
   *
   * Returns all jobs transitioned to a terminal state during this sweep.
   */
  async sweepExpiredJobs(now = new Date().toISOString(), options: SweepOptions = {}): Promise<JobRecord[]> {
    const currentTime = new Date(now).getTime()
    const expired: JobRecord[] = []

    while (true) {
      let transitionedInPass = 0
      for (const job of await this.store.list()) {
        if (TERMINAL_STATUSES.includes(job.status)) continue
        if (options.isActive?.(job.id) === true) continue
        // Re-checked under the job's lock right before the write: the job may
        // have ended, or a monitor may have picked it up, since the list.
        const stillSweepable = (current: JobRecord): boolean => options.isActive?.(current.id) !== true

        if (job.status === "blocked") {
          const outcome = await this.dependencyOutcome(job, now)
          if (outcome.kind === "failed") {
            const failed = await this.transitionIf(
              job.id,
              "failed",
              now,
              { error: this.redactError(outcome.error) },
              (current) => stillSweepable(current) && current.status === "blocked",
            ).catch(() => undefined)
            if (failed !== undefined) {
              expired.push(failed)
              transitionedInPass++
            }
            continue
          }
        }

        if (currentTime <= jobDeadlineMs(job)) continue
        const timedOut = await this.transitionIf(
          job.id,
          "timed_out",
          now,
          { error: "Job timed out" },
          (current) => stillSweepable(current) && currentTime > jobDeadlineMs(current),
        ).catch(() => undefined)
        if (timedOut === undefined) continue
        expired.push(timedOut)
        transitionedInPass++
      }

      if (transitionedInPass === 0) break
    }

    return expired
  }

  private async transition(id: string, status: JobStatus, now: string, patch: Partial<JobRecord> = {}): Promise<JobRecord> {
    return this.withJobLock(id, async () => this.write(await this.getJob(id), status, now, patch))
  }

  /** `transition` when `guard` accepts the fresh record (read under the lock); `undefined` otherwise. */
  private async transitionIf(
    id: string,
    status: JobStatus,
    now: string,
    patch: Partial<JobRecord>,
    guard: TransitionGuard,
  ): Promise<JobRecord | undefined> {
    return this.withJobLock(id, async () => {
      const current = await this.getJob(id)
      if (TERMINAL_STATUSES.includes(current.status) || !guard(current)) return undefined
      return this.write(current, status, now, patch)
    })
  }

  /**
   * Writes `current` moved to `status`. Call under the job's lock. A terminal
   * job is never written again, not even with the same status: whoever ended
   * it owns its report, so a second ending must fail loudly.
   */
  private async write(current: JobRecord, status: JobStatus, now: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    if (TERMINAL_STATUSES.includes(current.status)) {
      throw new Error(`Cannot transition terminal job ${current.id} from ${current.status} to ${status}`)
    }
    const next: JobRecord = { ...current, ...patch, status, updatedAt: now }
    await this.store.save(next)
    return next
  }

  private async withJobLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.jobLocks.get(id) ?? Promise.resolve()
    const run = previous.then(work, work)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    this.jobLocks.set(id, settled)
    void settled.then(() => {
      if (this.jobLocks.get(id) === settled) this.jobLocks.delete(id)
    })
    return run
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

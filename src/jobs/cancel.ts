/**
 * A requester's cancel of one job (`POST /jobs/:id/cancel`, v3.2.0 block B).
 *
 * Cancel only ever ENDS work, so it is not an approval action (ADR 0015): it
 * writes nothing to the approval ledger. It goes through the same end-once
 * path as everything else that ends a job (ADR 0013, block K): the job is
 * ended by exactly one terminal write, under the job's lock, and only the
 * path that made that write delivers the report. So a cancel, the periodic
 * sweep, the runner's own completion and the kill switch (`stopAll`) can race
 * freely: whoever writes first ends and reports the job, the others find it
 * terminal and do nothing.
 *
 * | job                                               | what cancel does                                        |
 * |---------------------------------------------------|---------------------------------------------------------|
 * | terminal                                          | nothing; `finished` with the current status (409)       |
 * | `awaiting_approval`                               | nothing; `awaiting_approval` (409: the operator rejects) |
 * | never launched (`accepted`/`blocked`/`received`, no `launchStartedAt`) | fails it here and reports it; a launch racing it is refused by `markLaunchStarted` |
 * | driven by the Claude runner (launching or running) | `runner.stop`: the process is terminated, the job's own monitor fails it and reports it, as the kill switch does |
 * | launched on OpenCode                              | fails it here, then aborts its OpenCode session, then reports it |
 *
 * The OpenCode order matters: the job is ended BEFORE the session is aborted,
 * so the session monitor (which sees the aborted session go idle) finds the
 * job terminal and cannot report it as completed. Because that monitor then
 * stops, a job this module ends also fails (and reports) its local
 * dependents itself (`settleDependents`).
 *
 * The job's error is the cancel reason: `cancelled by requester`, or
 * `cancelled by operator` when the operator credential cancelled it.
 */
import { settleDependents } from "./dependents.js"
import type { JobManager } from "./manager.js"
import type { JobRecord, JobStatus } from "./types.js"

/** The error a job cancelled by its requester ends with, and its report summary. */
export const CANCELLED_BY_REQUESTER = "cancelled by requester"
/** The error a job cancelled with the operator credential ends with. */
export const CANCELLED_BY_OPERATOR = "cancelled by operator"

const TERMINAL: ReadonlySet<JobStatus> = new Set(["completed", "failed", "timed_out", "callback_failed"])
/** States in which the job provably has not reached a runtime (with no `launchStartedAt`). */
const NOT_LAUNCHED: ReadonlySet<JobStatus> = new Set(["received", "accepted", "blocked"])

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL.has(status)
}

export interface CancelDependencies {
  readonly jobManager: Pick<JobManager, "getJob" | "markFailedIf"> & Partial<Pick<JobManager, "resolveDependents">>
  /** The error the job ends with: `CANCELLED_BY_REQUESTER` (default) or `CANCELLED_BY_OPERATOR`. */
  readonly reason?: string
  /** The Claude runner, when this node runs one. */
  readonly runner?: {
    readonly isActive?: (jobId: string) => boolean
    readonly stop?: (jobId: string, reason: string, waitMs?: number) => Promise<"stopping" | "already_stopping" | "not_active">
  }
  /** Best-effort abort of the job's OpenCode session (block K's `abortSession`). */
  readonly abortOpencodeSession?: (sessionId: string) => Promise<void>
  /** Delivers the report of a job THIS cancel ended. Never called for a job ended elsewhere. */
  readonly reportTerminalJob: (job: JobRecord) => Promise<void>
  /** Marks the job's task failed in the task graph (advisory). */
  readonly syncFailedTask?: (job: JobRecord) => Promise<void>
  /** How long to wait for the runner to end the job before answering `stopping`. */
  readonly stopWaitMs?: number
}

export type CancelOutcome =
  /** The job is now `failed` with the cancel reason and its report was handed to the reporter. */
  | { readonly kind: "cancelled"; readonly job: JobRecord }
  /** The stop was requested but the job had not ended within `stopWaitMs`; it ends (and reports) on its own. */
  | { readonly kind: "stopping"; readonly job: JobRecord }
  /** The job had already ended (possibly by another path while this cancel ran). */
  | { readonly kind: "finished"; readonly job: JobRecord }
  | { readonly kind: "awaiting_approval"; readonly job: JobRecord }
  | { readonly kind: "not_found" }

export async function cancelJob(jobId: string, dependencies: CancelDependencies): Promise<CancelOutcome> {
  const reason = dependencies.reason ?? CANCELLED_BY_REQUESTER
  let job = await read(dependencies, jobId)
  if (job === undefined) return { kind: "not_found" }
  if (TERMINAL.has(job.status)) return { kind: "finished", job }
  if (job.status === "awaiting_approval") return { kind: "awaiting_approval", job }

  // 1. Never launched: end it here. The guard runs under the job's lock, and
  // `markLaunchStarted` takes the same lock, so either this write wins (the
  // launch is then refused) or the launch does (we fall through to stop it).
  if (job.launchStartedAt === undefined && NOT_LAUNCHED.has(job.status)) {
    const ended = await dependencies.jobManager.markFailedIf(
      jobId,
      reason,
      (current) => current.launchStartedAt === undefined && NOT_LAUNCHED.has(current.status),
    )
    if (ended !== undefined) return await finish(ended, dependencies)
    job = await read(dependencies, jobId)
    if (job === undefined) return { kind: "not_found" }
    if (TERMINAL.has(job.status)) return { kind: "finished", job }
    if (job.status === "awaiting_approval") return { kind: "awaiting_approval", job }
  }

  // 2. The Claude runner drives it: stop it like the kill switch does. A
  // launched Claude job that is not terminal is always in the runner (the
  // slot is claimed before `launchStartedAt` and freed after the terminal
  // write), so this covers launching and running jobs alike.
  const runner = dependencies.runner
  if (runner?.stop !== undefined && runner.isActive?.(jobId) === true) {
    const stop = await runner.stop(jobId, reason, dependencies.stopWaitMs)
    const after = await read(dependencies, jobId)
    if (after === undefined) return { kind: "not_found" }
    if (!TERMINAL.has(after.status)) {
      // Still ending (this stop, or an earlier cancel or kill switch, asked): not finished yet.
      return { kind: "stopping", job: after }
    }
    return stop === "stopping" && after.error === reason ? { kind: "cancelled", job: after } : { kind: "finished", job: after }
  }

  // 3. Launched elsewhere (OpenCode), or a launched job no runner in this
  // process drives: end it, then stop its session.
  const ended = await dependencies.jobManager.markFailedIf(jobId, reason, (current) => current.status !== "awaiting_approval")
  if (ended === undefined) {
    const current = await read(dependencies, jobId)
    if (current === undefined) return { kind: "not_found" }
    return current.status === "awaiting_approval" ? { kind: "awaiting_approval", job: current } : { kind: "finished", job: current }
  }
  if (ended.opencodeSessionId !== undefined && dependencies.abortOpencodeSession !== undefined) {
    await dependencies.abortOpencodeSession(ended.opencodeSessionId).catch(() => undefined)
  }
  return await finish(ended, dependencies)
}

async function finish(ended: JobRecord, dependencies: CancelDependencies): Promise<CancelOutcome> {
  await dependencies.syncFailedTask?.(ended).catch(() => undefined)
  await dependencies.reportTerminalJob(ended).catch(() => undefined)
  // Same outcome as any other failure of a dependency: local dependents
  // waiting on this job fail now (not at the sweep's grace window), and the
  // ones this call failed are reported by it (`settleDependents`).
  const resolveDependents = dependencies.jobManager.resolveDependents
  if (resolveDependents !== undefined) {
    await settleDependents(ended.id, {
      jobManager: { resolveDependents: (id) => resolveDependents.call(dependencies.jobManager, id) },
      reportTerminalJob: dependencies.reportTerminalJob,
      ...(dependencies.syncFailedTask !== undefined ? { syncFailedTask: dependencies.syncFailedTask } : {}),
    })
  }
  return { kind: "cancelled", job: ended }
}

async function read(dependencies: CancelDependencies, jobId: string): Promise<JobRecord | undefined> {
  try {
    return await dependencies.jobManager.getJob(jobId)
  } catch {
    return undefined
  }
}

/**
 * What happens to a job's local dependents when the job ends, shared by every
 * path that ends a job and owns its report: the OpenCode session monitor and
 * a requester's cancel (the `/report` route and the router drainer use
 * `JobManager.applyRemoteReport` the same way).
 *
 * The single-writer rule of block K applies to dependents too: a dependent is
 * failed or unblocked by a guarded write under its own lock, and only the
 * call that made the write reports (or launches) it. Nothing here throws, so
 * settling dependents can never stop the ended job's own report.
 */
import type { DependentsOutcome, JobManager } from "./manager.js"
import type { JobRecord } from "./types.js"

export interface SettleDependentsDependencies {
  readonly jobManager: Pick<JobManager, "resolveDependents">
  readonly reportTerminalJob: (job: JobRecord) => Promise<void>
  /** Marks a failed dependent's task failed (advisory). */
  readonly syncFailedTask?: (job: JobRecord) => Promise<void>
  /** Launches a dependent this call unblocked. Absent: unblocked jobs stay `accepted` for another launcher. */
  readonly launch?: (job: JobRecord) => Promise<void>
}

/** Settles `endedJobId`'s dependents: reports the ones this call failed, launches the ones it unblocked. Never throws. */
export async function settleDependents(endedJobId: string, dependencies: SettleDependentsDependencies): Promise<DependentsOutcome> {
  let outcome: DependentsOutcome
  try {
    outcome = await dependencies.jobManager.resolveDependents(endedJobId)
  } catch {
    return { unblocked: [], failed: [] }
  }
  for (const failed of outcome.failed) {
    await dependencies.syncFailedTask?.(failed).catch(() => undefined)
    await dependencies.reportTerminalJob(failed).catch(() => undefined)
  }
  for (const unblocked of outcome.unblocked) {
    await dependencies.launch?.(unblocked).catch(() => undefined)
  }
  return outcome
}

/**
 * The end of a job whose terminal write THIS caller made: settle its
 * dependents, then deliver its own report, which nothing before it can
 * prevent.
 */
export async function finishEndedJob(ended: JobRecord, dependencies: SettleDependentsDependencies): Promise<void> {
  await settleDependents(ended.id, dependencies)
  await dependencies.reportTerminalJob(ended).catch(() => undefined)
}

/**
 * Starting an accepted OpenCode-runtime job, shared by `/trigger` (jobs that
 * need no approval) and `POST /jobs/:id/approve` (jobs an operator approved).
 */
import type { JobRecord } from "../../jobs/types.js"
import { notRelaunchedError, relaunchJobs, waitUntil } from "../../jobs/reconcile.js"
import { LaunchRefusedError } from "../../jobs/manager.js"
import { OpencodeLaunchError, startOpencodeSession } from "../../opencode/launch.js"
import type { AppDependencies } from "../app.js"
import { terminalReporter } from "./claude-dispatch.js"

/** What dispatching needs; `aibr worker` (no HTTP app) supplies the same objects. */
export type OpencodeDispatchDependencies = Pick<
  AppDependencies,
  | "jobManager"
  | "opencodeClient"
  | "taskGraphSyncer"
  | "monitorSession"
  | "orchestration"
  | "reportTerminalJob"
  | "callbackReporter"
  | "config"
  | "bearerToken"
>

export type OpencodeDispatchOutcome =
  | {
      readonly ok: true
      readonly job: JobRecord
      readonly status: "accepted" | "blocked"
      readonly sessionId?: string
    }
  | {
      readonly ok: false
      readonly statusCode: 400 | 409 | 500
      readonly body: { readonly error: string; readonly code?: string }
      /**
       * What dispatching already did to the job:
       * - `reported`: OpenCode refused the launch; the job is failed and reported. Do neither again.
       * - `refused`: the launch marker was refused; the job belongs to another path. Do not touch it.
       * - `failed`: dispatching failed the job before launching it, without reporting it. Report `job`.
       * Absent: the job was not touched; the caller fails and reports it.
       */
      readonly settled?:
        | { readonly kind: "reported" }
        | { readonly kind: "refused" }
        | { readonly kind: "failed"; readonly job: JobRecord }
    }

/**
 * Applies a failed dispatch's `settled` to the job: fails and reports it,
 * reports it, or leaves it alone. Never reports a job twice: only a failure
 * written here, or one dispatching wrote and did not report, is reported.
 */
export async function settleFailedDispatch(
  job: JobRecord,
  outcome: Extract<OpencodeDispatchOutcome, { ok: false }> | { readonly body: { readonly error: string }; readonly settled?: undefined },
  dependencies: OpencodeDispatchDependencies,
): Promise<void> {
  const settled = outcome.settled
  if (settled?.kind === "reported" || settled?.kind === "refused") return
  if (settled?.kind === "failed") return await terminalReporter(dependencies)(settled.job)
  const failed = await dependencies.jobManager.markFailed(job.id, outcome.body.error).catch(() => undefined)
  if (failed !== undefined) await terminalReporter(dependencies)(failed)
}

/**
 * Holds the job as `blocked` while its dependencies are unfinished, otherwise
 * opens an OpenCode session, sends the prompt and hands the job to the session
 * monitor.
 *
 * `recordInKernel` asks the kernel translation to record the accepted intent
 * first (fail closed). The approve path passes false: the held job was already
 * recorded when it was triggered.
 *
 * Errors from the OpenCode client propagate; the caller decides how to fail.
 */
export async function dispatchOpencodeJob(
  job: JobRecord,
  dependencies: OpencodeDispatchDependencies,
  options: { readonly recordInKernel: boolean },
): Promise<OpencodeDispatchOutcome> {
  const taskId = job.trigger.task_id ?? `#${job.id}`
  const dependencyReferences = job.trigger.depends_on ?? []
  const localDependencyIds = dependencyReferences.filter((dependency): dependency is string => typeof dependency === "string")
  const hasRemoteDependencies = localDependencyIds.length !== dependencyReferences.length

  let localDependenciesDone = true
  for (const dependencyId of localDependencyIds) {
    let dependency: JobRecord
    try {
      dependency = await dependencies.jobManager.getJob(dependencyId)
    } catch {
      // The job already exists: fail it so it is not left `accepted` forever.
      const error = `Dependency job not found: ${dependencyId}`
      const failed = await dependencies.jobManager.markFailed(job.id, error).catch(() => undefined)
      return {
        ok: false,
        statusCode: 400,
        body: { error },
        settled: failed !== undefined ? { kind: "failed", job: failed } : { kind: "refused" },
      }
    }
    if (dependency.status !== "completed") localDependenciesDone = false
  }

  if (dependencyReferences.length > 0 && (hasRemoteDependencies || !localDependenciesDone)) {
    const blocked = await dependencies.jobManager.markBlocked(job.id, dependencyReferences)
    // A blocked job is still ACCEPTED work, so the kernel records it. It maps
    // to a paused draft run and names no launch effect: the job must not reach
    // a runtime until its dependencies are satisfied.
    if (options.recordInKernel) {
      const acceptance = dependencies.orchestration?.translation?.acceptTrigger(blocked)
      if (acceptance !== undefined && !acceptance.ok) {
        const failed = await dependencies.jobManager.markFailed(job.id, acceptance.error.message)
        return {
          ok: false,
          statusCode: 500,
          body: { error: acceptance.error.message, code: acceptance.error.code },
          settled: { kind: "failed", job: failed },
        }
      }
    }
    await dependencies.taskGraphSyncer.syncJobToTask(taskId, "blocked", { Job: job.id })
    return { ok: true, job: blocked, status: "blocked" }
  }

  // M4-A. The kernel is asked to record the accepted intent FIRST, and that is
  // all it is asked to do. It returns no launch effect: the
  // `createSession`/`sendPromptAsync` pair below is the RELEASED legacy
  // behaviour, authorized by the route's own bearer, source/capability,
  // allowlist and approval checks. Fail closed: a job the kernel cannot
  // account for is failed rather than reported as started.
  if (options.recordInKernel) {
    const acceptance = dependencies.orchestration?.translation?.acceptTrigger(job)
    if (acceptance !== undefined && !acceptance.ok) {
      const failed = await dependencies.jobManager.markFailed(job.id, acceptance.error.message)
      return {
        ok: false,
        statusCode: 500,
        body: { error: acceptance.error.message, code: acceptance.error.code },
        settled: { kind: "failed", job: failed },
      }
    }
  }

  let launched: Awaited<ReturnType<typeof startOpencodeSession>>
  try {
    launched = await startOpencodeSession(job, { ...dependencies, reportTerminalJob: terminalReporter(dependencies) })
  } catch (error) {
    if (error instanceof LaunchRefusedError) {
      return { ok: false, statusCode: 409, body: { error: error.message, code: error.code }, settled: { kind: "refused" } }
    }
    if (!(error instanceof OpencodeLaunchError)) throw error
    return { ok: false, statusCode: 500, body: { error: error.message, code: error.code }, settled: { kind: "reported" } }
  }
  const { sessionId, running } = launched

  await dependencies.taskGraphSyncer.syncJobToTask(taskId, "running", { Job: job.id, Session: sessionId })

  void dependencies.monitorSession(running).catch(async (error: unknown) => {
    const failed = await dependencies.jobManager
      .markFailed(job.id, error instanceof Error ? error.message : "Session monitor failed")
      .catch(() => undefined)
    if (failed !== undefined) await terminalReporter(dependencies)(failed)
  })

  return { ok: true, job: running, status: "accepted", sessionId }
}

/**
 * Launches the `accepted` jobs a restart found never launched
 * (`reconcileJobsAfterRestart`), oldest first. OpenCode's health is checked
 * ONCE for the whole batch, waiting at most `healthWaitMs` (default 15 s:
 * `aibr serve --with-opencode` starts it alongside the bridge). If it does
 * not answer, every job of the batch is declined at once
 * (`not relaunched after restart: OpenCode unavailable (never started)`) and
 * reported, so startup is never held up per job.
 */
export async function relaunchOpencodeJobs(
  jobs: readonly JobRecord[],
  dependencies: OpencodeDispatchDependencies,
  options: { readonly healthWaitMs?: number; readonly healthPollMs?: number } = {},
): Promise<void> {
  if (jobs.length === 0) return
  const healthy = await waitUntil(() => dependencies.opencodeClient.health(), {
    timeoutMs: options.healthWaitMs ?? 15_000,
    intervalMs: options.healthPollMs ?? 500,
  })
  await relaunchJobs(jobs, (job) =>
    healthy
      ? relaunchOpencodeJob(job, dependencies)
      : settleFailedDispatch(job, { body: { error: notRelaunchedError("OpenCode unavailable") } }, dependencies),
  )
}

/**
 * Launches one never-launched job as `aibr approve` does (the kernel already
 * recorded it when it was triggered). No health check: `relaunchOpencodeJobs`
 * did it for the batch. On failure the job is failed and reported at most once.
 */
export async function relaunchOpencodeJob(job: JobRecord, dependencies: OpencodeDispatchDependencies): Promise<void> {
  // Reports only a failure written here: a job another path already ended
  // (and reported) makes `markFailed` throw.
  const fail = async (error: string): Promise<void> => settleFailedDispatch(job, { body: { error } }, dependencies)
  try {
    const dispatched = await dispatchOpencodeJob(job, dependencies, { recordInKernel: false })
    if (!dispatched.ok) await settleFailedDispatch(job, dispatched, dependencies)
  } catch (error) {
    await fail(error instanceof Error ? error.message : "OpenCode launch failed")
  }
}

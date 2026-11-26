/**
 * Starting an accepted OpenCode-runtime job, shared by `/trigger` (jobs that
 * need no approval) and `POST /jobs/:id/approve` (jobs an operator approved).
 */
import type { JobRecord } from "../../jobs/types.js"
import { waitUntil } from "../../jobs/reconcile.js"
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
      readonly statusCode: 400 | 500
      readonly body: { readonly error: string; readonly code?: string }
      /** The job is already failed and its report delivered: do neither again. */
      readonly reported?: true
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
      await dependencies.jobManager.markFailed(job.id, error).catch(() => undefined)
      return { ok: false, statusCode: 400, body: { error } }
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
        await dependencies.jobManager.markFailed(job.id, acceptance.error.message)
        return { ok: false, statusCode: 500, body: { error: acceptance.error.message, code: acceptance.error.code } }
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
      await dependencies.jobManager.markFailed(job.id, acceptance.error.message)
      return { ok: false, statusCode: 500, body: { error: acceptance.error.message, code: acceptance.error.code } }
    }
  }

  let launched: Awaited<ReturnType<typeof startOpencodeSession>>
  try {
    launched = await startOpencodeSession(job, { ...dependencies, reportTerminalJob: terminalReporter(dependencies) })
  } catch (error) {
    if (!(error instanceof OpencodeLaunchError)) throw error
    return { ok: false, statusCode: 500, body: { error: error.message, code: error.code }, reported: true }
  }
  const { sessionId, running } = launched

  await dependencies.taskGraphSyncer.syncJobToTask(taskId, "running", { Job: job.id, Session: sessionId })

  void dependencies.monitorSession(running).catch(async (error: unknown) => {
    await dependencies.jobManager.markFailed(job.id, error instanceof Error ? error.message : "Session monitor failed")
  })

  return { ok: true, job: running, status: "accepted", sessionId }
}

/**
 * Launches an `accepted` job that a restart found never launched
 * (`reconcileJobsAfterRestart`). Waits up to `healthWaitMs` for OpenCode to
 * answer (`aibr serve --with-opencode` starts it alongside the bridge), then
 * dispatches it as `aibr approve` does: the kernel already recorded it when
 * it was triggered. On any failure the job is failed and its report delivered.
 */
export async function relaunchOpencodeJob(
  job: JobRecord,
  dependencies: OpencodeDispatchDependencies,
  options: { readonly healthWaitMs?: number; readonly healthPollMs?: number } = {},
): Promise<void> {
  const fail = async (error: string): Promise<void> => {
    await dependencies.jobManager.markFailed(job.id, error).catch(() => undefined)
    const failed = await dependencies.jobManager.getJob(job.id).catch(() => undefined)
    if (failed?.status === "failed") await terminalReporter(dependencies)(failed)
  }
  const healthy = await waitUntil(() => dependencies.opencodeClient.health(), {
    timeoutMs: options.healthWaitMs ?? 60_000,
    intervalMs: options.healthPollMs ?? 2_000,
  })
  if (!healthy) return await fail("OpenCode server unhealthy: the job could not be relaunched after a bridge restart")
  try {
    const dispatched = await dispatchOpencodeJob(job, dependencies, { recordInKernel: false })
    if (!dispatched.ok && dispatched.reported !== true) await fail(dispatched.body.error)
  } catch (error) {
    await fail(error instanceof Error ? error.message : "OpenCode launch failed")
  }
}

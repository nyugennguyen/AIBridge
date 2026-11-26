import type { JobManager } from "../jobs/manager.js"
import type { JobRecord } from "../jobs/types.js"
import type { OpencodeClient } from "./types.js"

export interface OpencodeLaunchDependencies {
  readonly jobManager: Pick<JobManager, "markLaunchStarted" | "attachSession" | "markRunning" | "markFailed">
  readonly opencodeClient: Pick<OpencodeClient, "createSession" | "sendPromptAsync"> & Partial<Pick<OpencodeClient, "abortSession">>
  /**
   * Delivers the report of a job this launch failed. Absent only where no
   * reporter exists (a drainer built without one): the job is still failed.
   */
  readonly reportTerminalJob?: (job: JobRecord) => Promise<void>
}

/**
 * Thrown by `startOpencodeSession` when OpenCode refused the launch after the
 * marker was written. The job is already `failed` (with the redacted error,
 * which is also this error's message) and its report delivered, so callers
 * must not fail or report it again.
 */
export class OpencodeLaunchError extends Error {
  readonly code = "opencode_launch_failed"
  constructor(
    message: string,
    readonly job: JobRecord | undefined,
  ) {
    super(message)
  }
}

/**
 * Starts an `accepted` job on OpenCode: records `launchStartedAt`, opens a
 * session, binds it to the job, sends the prompt and moves the job to
 * `running`. Every OpenCode launch path (`/trigger`, `aibr approve`, `/report`
 * unblocking, the session monitor's unblocking and the router drainer) goes
 * through here, so the marker is always written before OpenCode is contacted:
 * after a restart, an `accepted` job without it provably never ran.
 *
 * If OpenCode fails after the marker, the job is failed at once with the
 * launch error and reported, then `OpencodeLaunchError` is thrown. If the
 * marker itself is refused (the job is not `accepted`, or was launched
 * already), that error propagates and the job is left as it is.
 */
export async function startOpencodeSession(
  job: JobRecord,
  dependencies: OpencodeLaunchDependencies,
): Promise<{ readonly sessionId: string; readonly running: JobRecord }> {
  await dependencies.jobManager.markLaunchStarted(job.id)
  let sessionId: string | undefined
  try {
    const session = await dependencies.opencodeClient.createSession(`AIBridge ${job.id}`, job.trigger.project_dir)
    sessionId = session.id
    await dependencies.jobManager.attachSession(job.id, session.id)
    await dependencies.opencodeClient.sendPromptAsync(session.id, job.trigger.prompt, job.trigger.project_dir)
    const running = await dependencies.jobManager.markRunning(job.id)
    return { sessionId: session.id, running }
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenCode launch failed"
    const failed = await dependencies.jobManager.markFailed(job.id, message).catch(() => undefined)
    if (failed !== undefined) await dependencies.reportTerminalJob?.(failed).catch(() => undefined)
    // Another path (a requester's cancel, the sweep) ended the job while it
    // launched: whatever session was opened must not keep working for it.
    if (failed === undefined && sessionId !== undefined) {
      await dependencies.opencodeClient.abortSession?.(sessionId).catch(() => undefined)
    }
    throw new OpencodeLaunchError(failed?.error ?? "OpenCode launch failed", failed)
  }
}

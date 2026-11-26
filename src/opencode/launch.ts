import type { JobManager } from "../jobs/manager.js"
import type { JobRecord } from "../jobs/types.js"
import type { OpencodeClient } from "./types.js"

export interface OpencodeLaunchDependencies {
  readonly jobManager: Pick<JobManager, "markLaunchStarted" | "attachSession" | "markRunning">
  readonly opencodeClient: Pick<OpencodeClient, "createSession" | "sendPromptAsync">
}

/**
 * Starts an `accepted` job on OpenCode: records `launchStartedAt`, opens a
 * session, binds it to the job, sends the prompt and moves the job to
 * `running`. Every OpenCode launch path (`/trigger`, `aibr approve`, `/report`
 * unblocking, the session monitor's unblocking and the router drainer) goes
 * through here, so the marker is always written before OpenCode is contacted:
 * after a restart, an `accepted` job without it provably never ran.
 *
 * Errors propagate; the caller decides how to fail the job.
 */
export async function startOpencodeSession(
  job: JobRecord,
  dependencies: OpencodeLaunchDependencies,
): Promise<{ readonly sessionId: string; readonly running: JobRecord }> {
  await dependencies.jobManager.markLaunchStarted(job.id)
  const session = await dependencies.opencodeClient.createSession(`AIBridge ${job.id}`, job.trigger.project_dir)
  await dependencies.jobManager.attachSession(job.id, session.id)
  await dependencies.opencodeClient.sendPromptAsync(session.id, job.trigger.prompt, job.trigger.project_dir)
  const running = await dependencies.jobManager.markRunning(job.id)
  return { sessionId: session.id, running }
}

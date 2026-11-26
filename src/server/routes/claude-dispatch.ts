/**
 * Launching an accepted Claude-runtime job, shared by `/trigger` (jobs that
 * need no approval) and `POST /jobs/:id/approve` (jobs an operator approved).
 */
import { jobDeadlineMs } from "../../jobs/manager.js"
import { waitUntil } from "../../jobs/reconcile.js"
import { createTerminalJobReporter } from "../../jobs/report.js"
import type { JobRecord } from "../../jobs/types.js"
import { ClaudeLaunchError, RunnerAtCapacityError, type ClaudeJobLaunch } from "../../runtime/claude-job-runner.js"
import type { AppDependencies } from "../app.js"

export type ClaudeLaunchOutcome =
  | { readonly ok: true; readonly launch: ClaudeJobLaunch }
  | { readonly ok: false; readonly statusCode: 429 | 500 | 503; readonly body: { readonly error: string; readonly code?: string } }

/**
 * Starts the job on the Claude runner, syncs the task graph and hands it to
 * the runner's monitor. On failure the job is marked failed; `reportFailure`
 * also delivers its report (the approve path: the original caller is waiting
 * for a callback, not for this HTTP response). A failure after the launch
 * marker is always reported, by the runner (`ClaudeLaunchError`).
 */
export async function launchClaudeJob(
  job: JobRecord,
  dependencies: AppDependencies,
  options: { readonly reportFailure: boolean },
): Promise<ClaudeLaunchOutcome> {
  const runner = dependencies.claudeJobRunner
  if (runner === undefined) {
    return { ok: false, statusCode: 503, body: { error: "Claude Code runtime is not available", code: "runtime_unavailable" } }
  }
  let launch: ClaudeJobLaunch
  try {
    launch = await runner.start(job)
  } catch (error) {
    // Past the marker the runner already failed and reported the job.
    if (error instanceof ClaudeLaunchError) {
      return { ok: false, statusCode: 500, body: { error: error.message, code: error.code } }
    }
    const atCapacity = error instanceof RunnerAtCapacityError
    const message = error instanceof Error ? error.message : "Claude Code launch failed"
    const failed = await dependencies.jobManager.markFailed(job.id, message).catch(() => undefined)
    if (failed !== undefined && options.reportFailure) await terminalReporter(dependencies)(failed)
    return atCapacity
      ? { ok: false, statusCode: 429, body: { error: message, code: "node_at_capacity" } }
      : { ok: false, statusCode: 500, body: { error: message } }
  }

  await dependencies.taskGraphSyncer.syncJobToTask(job.trigger.task_id ?? `#${job.id}`, "running", {
    Job: job.id,
    ...(launch.runtimeSessionId !== undefined ? { Session: launch.runtimeSessionId } : {}),
  })
  // `monitor` never rejects: it records the outcome and delivers the report itself.
  void runner.monitor(launch)
  return { ok: true, launch }
}

/**
 * Launches an `accepted` job that a restart found never launched
 * (`reconcileJobsAfterRestart`). Waits for a free slot rather than failing at
 * capacity, but not past the job's deadline; then launches it as `aibr
 * approve` does, failing and reporting it on error.
 */
export async function relaunchClaudeJob(
  job: JobRecord,
  dependencies: AppDependencies,
  options: { readonly capacityPollMs?: number } = {},
): Promise<void> {
  const runner = dependencies.claudeJobRunner
  if (runner?.hasCapacity !== undefined) {
    await waitUntil(() => runner.hasCapacity?.() ?? true, {
      timeoutMs: Math.max(0, jobDeadlineMs(job) - Date.now()),
      intervalMs: options.capacityPollMs ?? 1_000,
    })
  }
  await launchClaudeJob(job, dependencies, { reportFailure: true })
}

/** The answer when the node is already running its limit of jobs. */
export function atCapacityBody(dependencies: AppDependencies): { error: string; code: string } {
  const limit = dependencies.config.limits?.max_concurrent_jobs ?? 2
  return {
    error: `This node is already running its limit of ${limit} concurrent job(s) (limits.max_concurrent_jobs). Retry later.`,
    code: "node_at_capacity",
  }
}

export function terminalReporter(
  dependencies: Pick<AppDependencies, "reportTerminalJob" | "jobManager" | "callbackReporter" | "config" | "bearerToken">,
): (job: JobRecord) => Promise<void> {
  return (
    dependencies.reportTerminalJob ??
    createTerminalJobReporter({
      jobManager: dependencies.jobManager,
      callbackReporter: dependencies.callbackReporter,
      agentId: dependencies.config.agent_id,
      bearerToken: dependencies.bearerToken,
    })
  )
}

/** Quotes a value for a POSIX shell when it is not already a plain word. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9._:@%+=,/-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * What the operator runs on this node to approve the job. The job id can be
 * caller-chosen, so it is shell-quoted: a hint a human pastes into a terminal
 * must never be a way to run a peer's command.
 */
export function approveHint(jobId: string, profileName: string | undefined): string {
  return `aibr approve ${shellWord(jobId)}${profileName !== undefined ? ` --profile ${shellWord(profileName)}` : ""}`
}

import type { ReportCallback } from "../config/types.js"
import { CallbackQueuedError, type CallbackReporter } from "../callback/reporter.js"
import type { JobManager } from "./manager.js"
import type { JobRecord, JobStatus } from "./types.js"

function terminalReportStatus(status: JobStatus): ReportCallback["status"] {
  switch (status) {
    case "completed":
    case "failed":
    case "timed_out":
    case "callback_failed":
      return status
    case "received":
    case "accepted":
    case "awaiting_approval":
    case "blocked":
    case "session_created":
    case "running":
    case "reporting":
      throw new Error(`Cannot report non-terminal job status ${status}`)
  }
}

/**
 * The report callback body for a terminal job.
 *
 * A runtime that recorded a `runtimeResult` (Claude Code) supplies the summary
 * and findings; every other job keeps the released shape (`error` or a status
 * line, no findings), so the OpenCode path reports exactly what it always did.
 */
export function buildTerminalReport(job: JobRecord, sourceAgentId: string): ReportCallback {
  return {
    job_id: job.id,
    source_agent_id: sourceAgentId,
    target_agent_id: job.trigger.source_agent_id,
    ...(job.opencodeSessionId ? { opencode_session_id: job.opencodeSessionId } : {}),
    status: terminalReportStatus(job.status),
    summary: job.runtimeResult?.summary ? job.runtimeResult.summary : (job.error ?? `Job ${job.id} ${job.status}`),
    findings: job.runtimeResult?.findings ?? [],
    artifacts: [],
    started_at: job.createdAt,
    completed_at: job.updatedAt,
    ...(job.checkout !== undefined ? { sha: job.checkout.sha } : {}),
    ...(job.runtimeResult?.scriptResults !== undefined && job.runtimeResult.scriptResults.length > 0
      ? { script_results: job.runtimeResult.scriptResults }
      : {}),
  }
}

export interface TerminalJobReporterOptions {
  readonly jobManager: JobManager
  readonly callbackReporter: CallbackReporter
  /** This node's agent id: the report's `source_agent_id`. */
  readonly agentId: string
  readonly bearerToken: string | null
}

/**
 * Delivers the report of a job already known to be terminal, recording the
 * delivery state on the job so a failed delivery is retried at startup
 * (`JobManager.listCallbackRetries`). Never throws.
 */
export function createTerminalJobReporter(options: TerminalJobReporterOptions): (job: JobRecord) => Promise<void> {
  return async (job) => {
    try {
      await options.jobManager.markCallbackDelivery(job.id, "pending")
      const report = buildTerminalReport(job, options.agentId)
      await options.callbackReporter.send(job.trigger.callback_url, report, options.bearerToken, { jobId: job.id })
      await options.jobManager.markCallbackDelivery(job.id, "delivered")
    } catch (error) {
      if (error instanceof CallbackQueuedError) {
        await options.jobManager.markCallbackDelivery(job.id, "pending", error.message)
        return
      }
      await options.jobManager.markCallbackDelivery(
        job.id,
        "failed",
        error instanceof Error ? error.message : "Callback delivery failed",
      )
    }
  }
}

/**
 * The Tier 2 runtime: every dependency the engine needs to decide whether an
 * admitted request is allowed, and to carry an allowed one out.
 *
 * ## Why this is one factory and not two
 *
 * `aibr serve` (ingress owner, pre-M7.14) and `aibr worker` (Tier 2 drain loop)
 * reach the same decisions through the same objects: the same `JobManager` over
 * the same job store, the same `CallbackReporter` with the same origin binding,
 * the same session monitor. Building that graph twice — once per command — is how
 * a plan review, a source allowlist, or a callback policy ends up enforced in the
 * process that admits work and quietly absent from the process that executes it.
 * ADR 0008 §2.2 makes the worker the SOLE authority for authorization, so there
 * must be exactly one construction of that authority.
 *
 * What differs between the two commands is only whether an HTTP listener is
 * attached: `createApp` in [`src/server/app.ts`](../server/app.ts) for `serve`,
 * nothing at all for `worker`. Neither difference touches a decision.
 */

import { join } from "node:path"
import { loadConfig } from "../config/loader.js"
import type { BridgeConfig } from "../config/types.js"
import type { JobRecord } from "../jobs/types.js"
import { JobManager } from "../jobs/manager.js"
import { JsonFileJobStore } from "../jobs/store.js"
import { SdkOpencodeClientAdapter } from "../opencode/client.js"
import type { OpencodeClient } from "../opencode/types.js"
import { StaticPermissionPolicy } from "../opencode/permissions.js"
import { waitForIdle } from "../opencode/monitor.js"
import { CallbackReporter } from "../callback/reporter.js"
import { EgressOutboxStore } from "../callback/egress-outbox.js"
import { FileTaskGraphSyncer } from "../tasks/syncer.js"
export interface RuntimeOptions {
  readonly configPath: string
  readonly stateDir: string
  readonly bearerToken: string
  readonly environment: Record<string, string>
  readonly deps?: {
    readonly opencodeClient?: OpencodeClient
    readonly monitorSession?: (job: JobRecord) => Promise<void>
    readonly egressOutboxStore?: EgressOutboxStore
  }
}

export interface Runtime {
  readonly config: BridgeConfig
  readonly opencodeClient: OpencodeClient
  readonly jobManager: JobManager
  readonly taskGraphSyncer: FileTaskGraphSyncer
  readonly callbackReporter: CallbackReporter
  readonly egressOutboxStore?: EgressOutboxStore
  /** Drives one job to a terminal state and delivers its report. */
  readonly monitorSession: (job: JobRecord) => Promise<void>
  /** Re-delivers the report of a job already known to be terminal. */
  readonly reportTerminalJob: (job: JobRecord) => Promise<void>
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const config = await loadConfig(options.configPath)

  const opencodeClient =
    options.deps?.opencodeClient ??
    new SdkOpencodeClientAdapter({
      baseUrl: config.opencode.base_url,
      username: config.opencode.username,
      password: options.environment[config.opencode.password_env],
    })

  const jobManager = new JobManager(new JsonFileJobStore(join(options.stateDir, "jobs")))
  const taskGraphSyncer = new FileTaskGraphSyncer(join(options.stateDir, "tasks.md"))
  const egressOutboxStore =
    options.deps?.egressOutboxStore ??
    new EgressOutboxStore(join(options.stateDir, "egress_outbox.db"))
  const callbackReporter = new CallbackReporter({
    attempts: config.timeouts.callback_retry_attempts,
    baseDelayMs: 250,
    agents: config.agents,
    outboxStore: egressOutboxStore,
  })
  function terminalReportStatus(
    status: Awaited<ReturnType<typeof jobManager.getJob>>["status"],
  ): "completed" | "failed" | "timed_out" | "callback_failed" {
    switch (status) {
      case "completed":
      case "failed":
      case "timed_out":
      case "callback_failed":
        return status
      case "received":
      case "accepted":
      case "blocked":
      case "session_created":
      case "running":
      case "reporting":
        throw new Error(`Cannot report non-terminal job status ${status}`)
    }
  }

  async function reportTerminalJob(job: Awaited<ReturnType<typeof jobManager.getJob>>): Promise<void> {
    try {
      await jobManager.markCallbackDelivery(job.id, "pending")
      const report = {
        job_id: job.id,
        source_agent_id: config.agent_id,
        target_agent_id: job.trigger.source_agent_id,
        ...(job.opencodeSessionId ? { opencode_session_id: job.opencodeSessionId } : {}),
        status: terminalReportStatus(job.status),
        summary: job.error ?? `Job ${job.id} ${job.status}`,
        findings: [],
        artifacts: [],
        started_at: job.createdAt,
        completed_at: job.updatedAt,
      }
      await callbackReporter.send(job.trigger.callback_url, report, options.bearerToken, {
        jobId: job.id,
      })
      await jobManager.markCallbackDelivery(job.id, "delivered")
    } catch (error) {
      await jobManager.markCallbackDelivery(
        job.id,
        "failed",
        error instanceof Error ? error.message : "Callback delivery failed",
      )
    }
  }

  const monitorSession =
    options.deps?.monitorSession ??
    (async (job) => {
      if (!job.opencodeSessionId) throw new Error(`Job ${job.id} has no opencode session`)
      let terminalJob: Awaited<ReturnType<typeof jobManager.getJob>>
      try {
        await waitForIdle(opencodeClient, job.opencodeSessionId, {
          directory: job.trigger.project_dir,
          timeoutMs: job.trigger.timeout_seconds * 1000,
          pollIntervalMs: 1000,
          permissionPolicy: new StaticPermissionPolicy(config.permissions),
          planMetadata: job.trigger.metadata,
        })
        // Idle is not success. `getSessionStatus` maps an unknown session to
        // `idle`, so a turn that died before storing anything -- a provider error,
        // a plugin crashing the loop -- looks exactly like a finished one. Proving
        // the turn produced an assistant message is the only thing that
        // distinguishes them, and without it a job reports `completed` with an
        // empty answer and a `delivered` callback.
        if ((await opencodeClient.countAssistantMessages(job.opencodeSessionId)) === 0) {
          throw new Error(
            `OpenCode session ${job.opencodeSessionId} went idle without producing an assistant message. ` +
              `The turn failed before any output was stored; check the opencode log for this session.`,
          )
        }
        terminalJob = await jobManager.markCompleted(job.id)
        await taskGraphSyncer.syncJobToTask(job.trigger.task_id ?? `#${job.id}`, "done")
      } catch (error) {
        terminalJob = await jobManager.markFailed(
          job.id,
          error instanceof Error ? error.message : "Session failed",
        )
        await taskGraphSyncer.syncJobToTask(job.trigger.task_id ?? `#${job.id}`, "failed")
      }

      const unblockedJobs = await jobManager.unblockDependents(job.id)
      for (const unblocked of unblockedJobs) {
        try {
          const session = await opencodeClient.createSession(
            `AIBridge ${unblocked.id}`,
            unblocked.trigger.project_dir,
          )
          await jobManager.attachSession(unblocked.id, session.id)
          await opencodeClient.sendPromptAsync(
            session.id,
            unblocked.trigger.prompt,
            unblocked.trigger.project_dir,
          )
          const running = await jobManager.markRunning(unblocked.id)
          void monitorSession(running).catch(async (err: unknown) => {
            await jobManager.markFailed(
              unblocked.id,
              err instanceof Error ? err.message : "Session monitor failed",
            )
          })
        } catch (error) {
          await jobManager.markFailed(
            unblocked.id,
            error instanceof Error ? error.message : "Execution failed",
          )
        }
      }
      await reportTerminalJob(terminalJob)
    })

  return {
    config,
    opencodeClient,
    jobManager,
    taskGraphSyncer,
    callbackReporter,
    egressOutboxStore,
    monitorSession,
    reportTerminalJob,
  }
}

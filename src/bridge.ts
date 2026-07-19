import { join } from "node:path"
import { loadConfig } from "./config/loader.js"
import type { BridgeConfig } from "./config/types.js"
import type { JobRecord } from "./jobs/types.js"
import { JobManager } from "./jobs/manager.js"
import { JsonFileJobStore } from "./jobs/store.js"
import { SdkOpencodeClientAdapter } from "./opencode/client.js"
import type { OpencodeClient } from "./opencode/types.js"
import { StaticPermissionPolicy } from "./opencode/permissions.js"
import { waitForIdle } from "./opencode/monitor.js"
import { CallbackReporter } from "./callback/reporter.js"
import { FileTaskGraphSyncer } from "./tasks/syncer.js"
import { createApp, type AppDependencies } from "./server/app.js"
import type { FastifyInstance } from "fastify"

export interface BridgeOptions {
  configPath: string
  stateDir: string
  bearerToken: string
  environment: Record<string, string>
  deps?: {
    opencodeClient?: OpencodeClient
    monitorSession?: AppDependencies["monitorSession"]
  }
}

export interface BridgeInstance {
  app: FastifyInstance
  config: BridgeConfig
  jobManager: JobManager
}

export async function startBridge(options: BridgeOptions): Promise<BridgeInstance> {
  const config = await loadConfig(options.configPath)

  const opencodeClient = options.deps?.opencodeClient ?? new SdkOpencodeClientAdapter({
    baseUrl: config.opencode.base_url,
    username: config.opencode.username,
    password: options.environment[config.opencode.password_env],
  })

  const jobManager = new JobManager(new JsonFileJobStore(join(options.stateDir, "jobs")))
  const taskGraphSyncer = new FileTaskGraphSyncer(join(options.stateDir, "tasks.md"))
  const callbackReporter = new CallbackReporter({
    attempts: config.timeouts.callback_retry_attempts,
    baseDelayMs: 250,
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
      await callbackReporter.send(job.trigger.callback_url, report, options.bearerToken)
      await jobManager.markCallbackDelivery(job.id, "delivered")
    } catch (error) {
      await jobManager.markCallbackDelivery(
        job.id,
        "failed",
        error instanceof Error ? error.message : "Callback delivery failed",
      )
    }
  }

  const monitorSession: AppDependencies["monitorSession"] =
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
        } catch (err) {
          await jobManager.markFailed(
            unblocked.id,
            err instanceof Error ? err.message : "Execution failed",
          )
        }
      }
      await reportTerminalJob(terminalJob)
    })

  const app = createApp({
    config,
    bearerToken: options.bearerToken,
    jobManager,
    opencodeClient,
    callbackReporter,
    taskGraphSyncer,
    monitorSession,
  })

  for (const job of await jobManager.sweepExpiredJobs()) void reportTerminalJob(job)
  for (const job of await jobManager.listCallbackRetries()) void reportTerminalJob(job)

  return { app, config, jobManager }
}

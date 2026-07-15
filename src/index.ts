import { CallbackReporter } from "./callback/reporter.js"
import { loadConfig } from "./config/loader.js"
import { JobManager } from "./jobs/manager.js"
import { JsonFileJobStore } from "./jobs/store.js"
import { SdkOpencodeClientAdapter, passwordFromEnv } from "./opencode/client.js"
import { StaticPermissionPolicy } from "./opencode/permissions.js"
import { waitForIdle } from "./opencode/monitor.js"
import { FileTaskGraphSyncer } from "./tasks/syncer.js"
import { createApp, type AppDependencies } from "./server/app.js"

const configPath = process.env.AIBRIDGE_CONFIG
if (!configPath) throw new Error("AIBRIDGE_CONFIG is required")

const config = await loadConfig(configPath)
const opencodeClient = new SdkOpencodeClientAdapter({
  baseUrl: config.opencode.base_url,
  username: config.opencode.username,
  password: passwordFromEnv(config.opencode.password_env),
})
const jobManager = new JobManager(new JsonFileJobStore(".aibridge/jobs"))
const taskGraphSyncer = new FileTaskGraphSyncer(".aibridge/tasks.md")
const callbackReporter = new CallbackReporter({ attempts: config.timeouts.callback_retry_attempts, baseDelayMs: 250 })

function terminalReportStatus(status: Awaited<ReturnType<typeof jobManager.getJob>>["status"]): "completed" | "failed" | "timed_out" | "callback_failed" {
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
    await callbackReporter.send(job.trigger.callback_url, report, config.security.bearer_token)
    await jobManager.markCallbackDelivery(job.id, "delivered")
  } catch (error) {
    await jobManager.markCallbackDelivery(job.id, "failed", error instanceof Error ? error.message : "Callback delivery failed")
  }
}

const monitorSession: AppDependencies["monitorSession"] = async (job) => {
  if (!job.opencodeSessionId) throw new Error(`Job ${job.id} has no opencode session`)
  let terminalJob
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
    terminalJob = await jobManager.markFailed(job.id, error instanceof Error ? error.message : "Session failed")
    await taskGraphSyncer.syncJobToTask(job.trigger.task_id ?? `#${job.id}`, "failed")
  }

  const unblockedJobs = await jobManager.unblockDependents(job.id)
  for (const unblocked of unblockedJobs) {
    try {
      const session = await opencodeClient.createSession(`AIBridge ${unblocked.id}`, unblocked.trigger.project_dir)
      await jobManager.attachSession(unblocked.id, session.id)
      await opencodeClient.sendPromptAsync(session.id, unblocked.trigger.prompt, unblocked.trigger.project_dir)
      const running = await jobManager.markRunning(unblocked.id)
      void monitorSession(running).catch(async (err: unknown) => {
        await jobManager.markFailed(unblocked.id, err instanceof Error ? err.message : "Session monitor failed")
      })
    } catch (err) {
      await jobManager.markFailed(unblocked.id, err instanceof Error ? err.message : "Execution failed")
    }
  }
  await reportTerminalJob(terminalJob)
}

const app = createApp({
  config,
  jobManager,
  opencodeClient,
  callbackReporter,
  taskGraphSyncer,
  monitorSession,
})

for (const job of await jobManager.sweepExpiredJobs()) void reportTerminalJob(job)
for (const job of await jobManager.listCallbackRetries()) void reportTerminalJob(job)

await app.listen({ host: config.bridge.host, port: config.bridge.port })

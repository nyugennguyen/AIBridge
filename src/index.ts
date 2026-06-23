import { CallbackReporter } from "./callback/reporter.js"
import { loadConfig } from "./config/loader.js"
import { JobManager } from "./jobs/manager.js"
import { JsonFileJobStore } from "./jobs/store.js"
import { SdkOpencodeClientAdapter, passwordFromEnv } from "./opencode/client.js"
import { StaticPermissionPolicy } from "./opencode/permissions.js"
import { waitForIdle } from "./opencode/monitor.js"
import { FileTaskGraphSyncer } from "./tasks/syncer.js"
import { createApp } from "./server/app.js"

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
const app = createApp({
  config,
  jobManager,
  opencodeClient,
  callbackReporter: new CallbackReporter({ attempts: config.timeouts.callback_retry_attempts, baseDelayMs: 250 }),
  reports: [],
  taskGraphSyncer,
  monitorSession: async (job) => {
    if (!job.opencodeSessionId) throw new Error(`Job ${job.id} has no opencode session`)
    await waitForIdle(opencodeClient, job.opencodeSessionId, {
      directory: job.trigger.project_dir,
      timeoutMs: job.trigger.timeout_seconds * 1000,
      pollIntervalMs: 1000,
      permissionPolicy: new StaticPermissionPolicy(config.permissions),
      planMetadata: job.trigger.metadata,
    })
    await jobManager.markCompleted(job.id)
  },
})

await app.listen({ host: config.bridge.host, port: config.bridge.port })

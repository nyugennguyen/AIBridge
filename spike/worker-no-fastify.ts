// SPIKE CODE -- NOT PRODUCTION. Throwaway measurement artefact for M7.1.
//
// Topology B/C entrypoint: the "aibr worker" ADR 0008 §2.1 projects at ~43 MiB.
//
// THE MEASUREMENT THIS FILE EXISTS TO MAKE. ADR 0008 §2.1's 43.3 MiB worker and
// the whole −39% claim are a PROJECTION: §1's component breakdown minus
// Fastify's 31.2 MiB. Nothing has ever built the engine without its Fastify
// import and read the level off the kernel. This file is that build.
//
// NO FASTIFY, NO LISTENER. The import closure below deliberately excludes
// src/bridge.ts and src/server/**, because src/bridge.ts:13 imports createApp
// from src/server/app.js, which imports Fastify at src/server/app.ts:1.
// Constructing the same graph by hand from the leaf modules is the only way to
// obtain the worker without the HTTP layer. spike/check-no-fastify.sh walks the
// transitive closure of this file and fails if `fastify` or `src/server/` appears
// anywhere in it.
//
// This is a composition COPY of src/bridge.ts, not an edit to it: the constraint
// is that src/ must not be modified in anything this task commits. The copy
// diverges from src/bridge.ts only by (a) the absent createApp call and (b) the
// added load loop. If src/bridge.ts changes, this file is stale and its number
// is stale with it -- that is a spike limitation, not a result.

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { loadConfig } from "../src/config/loader.js"
import { JobManager } from "../src/jobs/manager.js"
import { JsonFileJobStore } from "../src/jobs/store.js"
import { SdkOpencodeClientAdapter } from "../src/opencode/client.js"
import type { JobRecord } from "../src/jobs/types.js"
import { StaticPermissionPolicy } from "../src/opencode/permissions.js"
import { waitForIdle } from "../src/opencode/monitor.js"
import { CallbackReporter } from "../src/callback/reporter.js"
import { FileTaskGraphSyncer } from "../src/tasks/syncer.js"
import { startLoadLoop } from "./load-loop.js"

const configPath = process.env.AIBRIDGE_CONFIG
if (!configPath) throw new Error("AIBRIDGE_CONFIG is required")
const bearerTokenEnv = process.env.AIBRIDGE_BEARER_TOKEN
if (!bearerTokenEnv) throw new Error("AIBRIDGE_BEARER_TOKEN is required")
const bearerToken: string = bearerTokenEnv
const stateDir = process.env.SPIKE_STATE_DIR ?? ".aibridge"

const config = await loadConfig(configPath)

const opencodeClient = new SdkOpencodeClientAdapter({
  baseUrl: config.opencode.base_url,
  username: config.opencode.username,
  password: process.env[config.opencode.password_env] ?? "",
})

const jobManager = new JobManager(new JsonFileJobStore(join(stateDir, "jobs")))
const taskGraphSyncer = new FileTaskGraphSyncer(join(stateDir, "tasks.md"))
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
    default:
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
    await callbackReporter.send(job.trigger.callback_url, report, bearerToken)
    await jobManager.markCallbackDelivery(job.id, "delivered")
  } catch (error) {
    await jobManager.markCallbackDelivery(
      job.id,
      "failed",
      error instanceof Error ? error.message : "Callback delivery failed",
    )
  }
}

// Same body as src/bridge.ts's monitorSession. It is unreachable in this spike
// (no opencode serve, and the load loop never creates a session) and is present
// only so the module graph is the worker's, not a subset of it.
async function monitorSession(job: JobRecord): Promise<void> {
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
      void monitorSession(running).catch(() => undefined)
    } catch (error) {
      await jobManager.markFailed(
        unblocked.id,
        error instanceof Error ? error.message : "Execution failed",
      )
    }
  }
  await reportTerminalJob(terminalJob)
}

for (const job of await jobManager.sweepExpiredJobs()) void reportTerminalJob(job)
for (const job of await jobManager.listCallbackRetries()) void reportTerminalJob(job)

const profile = JSON.parse(
  await readFile(process.env.SPIKE_LOAD_PROFILE ?? "spike/load-profile.json", "utf8"),
)
await startLoadLoop({
  inProcessRatePerSecond: profile.inProcessRatePerSecond,
  payload: profile.payload,
  stateDir,
})

// No listener and no server framework in this process. If a socket were opened
// here, the measurement would no longer be of the worker.
process.stdout.write("spike topology B/C ready: worker up, no fastify, no listener\n")
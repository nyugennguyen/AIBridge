import { createRuntime, type RuntimeOptions } from "./ingress/runtime.js"
import { createApp } from "./server/app.js"
import type { FastifyInstance } from "fastify"
import { ShadowIngressMirror } from "./server/shadow.js"
import type { BridgeConfig } from "./config/types.js"
import type { JobManager } from "./jobs/manager.js"

export interface BridgeOptions extends RuntimeOptions {
  /** Force shadow mirroring on regardless of `bridge.ingress_mode`. */
  readonly shadowMode?: boolean
}

export interface BridgeInstance {
  app: FastifyInstance
  config: BridgeConfig
  jobManager: JobManager
  shadowMirror?: ShadowIngressMirror
  /** Which process owns ingress: the engine listener, or the Rust router. */
  ingressMode: "engine" | "router"
}

export async function startBridge(options: BridgeOptions): Promise<BridgeInstance> {
  const runtime = await createRuntime(options)

  // `ingress_mode` decides who owns the socket, so it also decides whether this
  // process must mirror what it admits. Setting it to "router" is the operator
  // declaring an intent to cut over, and cutting over without a measured
  // divergence record is how a two-tier validation contract quietly becomes a
  // one-tier one: `--shadow-mode` stays available for measuring "engine" too.
  const ingressMode = runtime.config.bridge.ingress_mode
  const shadowMirror =
    options.shadowMode || ingressMode === "router"
      ? new ShadowIngressMirror(runtime.config)
      : undefined

  const app = createApp({
    config: runtime.config,
    bearerToken: options.bearerToken,
    jobManager: runtime.jobManager,
    opencodeClient: runtime.opencodeClient,
    callbackReporter: runtime.callbackReporter,
    taskGraphSyncer: runtime.taskGraphSyncer,
    monitorSession: runtime.monitorSession,
    shadowMirror,
  })

  for (const job of await runtime.jobManager.sweepExpiredJobs()) {
    void runtime.reportTerminalJob(job)
  }
  for (const job of await runtime.jobManager.listCallbackRetries()) {
    void runtime.reportTerminalJob(job)
  }

  return {
    app,
    config: runtime.config,
    jobManager: runtime.jobManager,
    shadowMirror,
    ingressMode,
  }
}

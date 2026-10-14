import { createRuntime, type RuntimeOptions } from "./ingress/runtime.js"
import { createApp, type AppDependencies } from "./server/app.js"
import type { FastifyInstance } from "fastify"
import { ShadowIngressMirror } from "./server/shadow.js"
import type { BridgeConfig } from "./config/types.js"
import type { JobManager } from "./jobs/manager.js"
import {
  createNotificationBus,
  createNotificationStore,
  createOrchestrationNotificationConsumer,
  notificationTimestampSchema,
  type NotificationBus,
  type NotificationStore,
  type OrchestrationEventLike,
  type OrchestrationNotificationConsumer,
} from "./notifications/index.js"
import type { CommandLog } from "./orchestration/coordinator/types.js"

export interface BridgeOptions extends RuntimeOptions {
  /** Force shadow mirroring on regardless of `bridge.ingress_mode`. */
  readonly shadowMode?: boolean
  readonly orchestration?: AppDependencies["orchestration"]
  readonly notificationStore?: NotificationStore
  readonly notificationBus?: NotificationBus
  readonly notificationConsumer?: OrchestrationNotificationConsumer
}

export interface BridgeInstance {
  app: FastifyInstance
  config: BridgeConfig
  jobManager: JobManager
  shadowMirror?: ShadowIngressMirror
  /** Which process owns ingress: the engine listener, or the Rust router. */
  ingressMode: "engine" | "router"
  notificationStore: NotificationStore
  notificationBus: NotificationBus
  notificationConsumer: OrchestrationNotificationConsumer
}

/**
 * Subscribes the advisory notification consumer to the post-append event path of a CommandLog.
 * Events durably committed to the log immediately feed the notification consumer.
 * Purely event-driven; zero polling loops.
 */
export function attachNotificationConsumerToCommandLog(
  log: CommandLog,
  consumer: OrchestrationNotificationConsumer
): CommandLog {
  return {
    append(options) {
      const result = log.append(options)
      if (!result.duplicate) {
        for (const rawEvent of result.events) {
          const event = (rawEvent && typeof rawEvent === "object" && "event" in rawEvent && rawEvent.event)
            ? rawEvent.event
            : rawEvent
          void consumer.handleEvent(event as OrchestrationEventLike)
        }
      }
      return result
    },
  }
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
  const notificationClock = { now: () => notificationTimestampSchema.parse(new Date().toISOString()) }
  const notificationStore = options.notificationStore ?? createNotificationStore({ clock: notificationClock })
  const notificationBus =
    options.notificationBus ??
    createNotificationBus({
      store: notificationStore,
      adapters: [],
      clock: notificationClock,
    })
  const notificationConsumer =
    options.notificationConsumer ??
    createOrchestrationNotificationConsumer(notificationBus)

  const app = createApp({
    config: runtime.config,
    bearerToken: options.bearerToken,
    // The operator credential authorizes user-kind `actor` claims (charter
    // approval/direct revision authority); peer bearer credentials do not.
    // Sourced from options first so tests can inject it, env second (the same
    // channel as the other runtime secrets). Absent -> authority fail-closed.
    operatorToken: options.operatorToken ?? process.env.AIBRIDGE_OPERATOR_TOKEN ?? null,
    jobManager: runtime.jobManager,
    opencodeClient: runtime.opencodeClient,
    callbackReporter: runtime.callbackReporter,
    taskGraphSyncer: runtime.taskGraphSyncer,
    monitorSession: runtime.monitorSession,
    shadowMirror,
    orchestration: options.orchestration,
    notificationStore,
    notificationBus,
    notificationConsumer,
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
    notificationStore,
    notificationBus,
    notificationConsumer,
  }
}

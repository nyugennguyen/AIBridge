import { join } from "node:path"
import { createRuntime, type RuntimeOptions } from "./ingress/runtime.js"
import { FileApprovalLedger } from "./jobs/approval-ledger.js"
import { createApp, type AppDependencies } from "./server/app.js"
import type { FastifyInstance } from "fastify"
import { ShadowIngressMirror } from "./server/shadow.js"
import type { BridgeConfig } from "./config/types.js"
import type { JobManager } from "./jobs/manager.js"
import { reconcileJobsAfterRestart, relaunchJobs, startPeriodicSweep, type RestartReconcileResult } from "./jobs/reconcile.js"
import { relaunchClaudeJob } from "./server/routes/claude-dispatch.js"
import { relaunchOpencodeJob } from "./server/routes/opencode-dispatch.js"
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
import { FilePeerStore } from "./pairing/peer-store.js"
import { createRequestIdentityGuard } from "./pairing/verifier.js"
import { createPairingAcceptor } from "./pairing/service.js"

export interface BridgeOptions extends RuntimeOptions {
  /** Force shadow mirroring on regardless of `bridge.ingress_mode`. */
  readonly shadowMode?: boolean
  readonly orchestration?: AppDependencies["orchestration"]
  readonly notificationStore?: NotificationStore
  readonly notificationBus?: NotificationBus
  readonly notificationConsumer?: OrchestrationNotificationConsumer
  /** The profile being served; only used to print an exact `aibr approve` hint. */
  readonly profileName?: string
  /** Period of the deadline sweep while the bridge runs. Default 60 s; tests shorten it. */
  readonly sweepIntervalMs?: number
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
  /**
   * What the startup pass did with the job store it found (engine ingress
   * only; absent in router mode, where `aibr worker` executes jobs). Resolves
   * once every relaunched job has been handed to its runtime.
   */
  restartReconcile?: Promise<RestartReconcileResult>
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

  // Phase 3 (ADR 0012): node identity for /trigger and /report, and the
  // worker side of pairing. Both read `<stateDir>/identity/` per request, so a
  // pairing or revocation made by `aibr enroll` takes effect without a restart.
  // No /enroll in router mode (the router owns the listener) or on an
  // orchestrator (it is the joining side).
  const requestIdentity = createRequestIdentityGuard({
    mode: runtime.config.security.request_signing ?? "off",
    peers: new FilePeerStore(options.stateDir),
  })
  const pairing =
    ingressMode === "engine" && runtime.config.role !== "orchestrator"
      ? createPairingAcceptor({
          config: runtime.config,
          configPath: options.configPath,
          stateDir: options.stateDir,
          bearerToken: options.bearerToken,
        })
      : undefined

  const appDependencies: AppDependencies = {
    requestIdentity,
    ...(pairing !== undefined ? { pairing } : {}),
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
    // Present only when `runtime.kind` is `claude`; the OpenCode client above
    // is then an inert stand-in that is never contacted.
    ...(runtime.claudeJobRunner ? { claudeJobRunner: runtime.claudeJobRunner } : {}),
    ...(runtime.repoWorkspaces ? { repoWorkspaces: runtime.repoWorkspaces } : {}),
    // Approval requests, operator decisions and kill-switch use (ADR 0013).
    approvalLedger: new FileApprovalLedger(join(options.stateDir, "approvals.jsonl")),
    reportTerminalJob: runtime.reportTerminalJob,
    ...(options.profileName !== undefined ? { profileName: options.profileName } : {}),
    shadowMirror,
    orchestration: options.orchestration,
    notificationStore,
    notificationBus,
    notificationConsumer,
  }
  const app = createApp(appDependencies)

  // Taken before this pass ends any job, so a job it reports is not reported twice.
  const callbackRetries = await runtime.jobManager.listCallbackRetries()

  let restartReconcile: Promise<RestartReconcileResult> | undefined
  if (ingressMode === "engine") {
    // This process executes the jobs, so whatever the store says is in flight
    // was left by a previous process (block K): interrupt what may have run,
    // relaunch what provably never did, before serving any request.
    const reconciled = await reconcileJobsAfterRestart({
      jobManager: runtime.jobManager,
      config: runtime.config,
      taskGraphSyncer: runtime.taskGraphSyncer,
      ...(runtime.config.runtime.kind === "opencode"
        ? { abortOpencodeSession: (sessionId: string) => runtime.opencodeClient.abortSession(sessionId) }
        : {}),
    })
    for (const job of [...reconciled.swept, ...reconciled.interrupted]) void runtime.reportTerminalJob(job)
    const relaunch =
      runtime.config.runtime.kind === "claude"
        ? (job: Parameters<typeof relaunchClaudeJob>[0]) => relaunchClaudeJob(job, appDependencies)
        : (job: Parameters<typeof relaunchOpencodeJob>[0]) =>
            relaunchOpencodeJob(job, { ...appDependencies, reportTerminalJob: runtime.reportTerminalJob })
    restartReconcile = relaunchJobs(reconciled.relaunch, relaunch).then(() => reconciled)

    const stopSweep = startPeriodicSweep({
      jobManager: runtime.jobManager,
      reportTerminalJob: runtime.reportTerminalJob,
      isActive: runtime.isJobActive,
      ...(options.sweepIntervalMs !== undefined ? { intervalMs: options.sweepIntervalMs } : {}),
    })
    app.addHook("onClose", async () => stopSweep())
  } else {
    // Router ingress: `aibr worker` executes jobs and reconciles them itself.
    for (const job of await runtime.jobManager.sweepExpiredJobs()) {
      void runtime.reportTerminalJob(job)
    }
  }
  for (const job of callbackRetries) {
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
    ...(restartReconcile !== undefined ? { restartReconcile } : {}),
  }
}

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
import { acquireStateLock } from "./host/state-lock.js"
import { relaunchOpencodeJobs } from "./server/routes/opencode-dispatch.js"
import { FilePeerStore } from "./pairing/peer-store.js"
import { createRequestIdentityGuard } from "./pairing/verifier.js"
import { createPairingAcceptor } from "./pairing/service.js"
import { STOPPED_BY_BRIDGE_SHUTDOWN } from "./runtime/claude-job-runner.js"

/**
 * How long closing the bridge waits for its running jobs to stop and be
 * reported. Above the adapter's SIGTERM-to-SIGKILL grace (3 s) and below
 * launchd's default exit timeout (20 s).
 */
const SHUTDOWN_STOP_WAIT_MS = 10_000

export interface BridgeOptions extends RuntimeOptions {
  /** Force shadow mirroring on regardless of `bridge.ingress_mode`. */
  readonly shadowMode?: boolean
  /** The profile being served; only used to print an exact `aibr approve` hint. */
  readonly profileName?: string
  /** Period of the deadline sweep while the bridge runs. Default 60 s; tests shorten it. */
  readonly sweepIntervalMs?: number
  /** The bridge log (`aibr serve` passes its file logger): job cancels are recorded here with the caller. */
  readonly log?: AppDependencies["log"]
}

export interface BridgeInstance {
  app: FastifyInstance
  config: BridgeConfig
  jobManager: JobManager
  shadowMirror?: ShadowIngressMirror
  /** Which process owns ingress: the engine listener, or the Rust router. */
  ingressMode: "engine" | "router"
  /**
   * What the startup pass did with the job store it found (engine ingress
   * only; absent in router mode, where `aibr worker` executes jobs). Every
   * relaunched job had been handed to its runtime before `startBridge` returned.
   */
  restartReconcile?: RestartReconcileResult
}

/**
 * Builds the bridge. Takes the profile's state lock first (`acquireStateLock`)
 * and holds it until `app.close()`: a second bridge or worker on the same
 * profile refuses to start instead of reconciling (and interrupting) the live
 * one's jobs. Throws `StateLockHeldError` without touching any job.
 */
export async function startBridge(options: BridgeOptions): Promise<BridgeInstance> {
  const lock = acquireStateLock(options.stateDir)
  try {
    const bridge = await startBridgeHoldingLock(options)
    bridge.app.addHook("onClose", async () => lock.release())
    return bridge
  } catch (error) {
    lock.release()
    throw error
  }
}

async function startBridgeHoldingLock(options: BridgeOptions): Promise<BridgeInstance> {
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
          ...(options.log !== undefined ? { log: options.log } : {}),
        })
      : undefined

  const appDependencies: AppDependencies = {
    requestIdentity,
    ...(pairing !== undefined ? { pairing } : {}),
    config: runtime.config,
    bearerToken: options.bearerToken,
    // The operator credential authorizes the operator routes (`aibr approve`,
    // reject, kill switch) and reading any job; peer bearer credentials do not.
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
    ...(options.log !== undefined ? { log: options.log } : {}),
    shadowMirror,
  }
  const app = createApp(appDependencies)

  // Claude Code and script steps lead their own process groups, so a Ctrl-C
  // in `aibr start --foreground` or the service manager's stop signal no
  // longer reaches them: on close the bridge stops them (whole groups), and
  // each job is failed and reported by its own monitor.
  const claudeJobRunner = runtime.claudeJobRunner
  if (claudeJobRunner !== undefined) {
    app.addHook("preClose", async () => {
      await claudeJobRunner.stopAll(STOPPED_BY_BRIDGE_SHUTDOWN, SHUTDOWN_STOP_WAIT_MS)
    })
  }

  // Taken before this pass ends any job, so a job it reports is not reported twice.
  const callbackRetries = await runtime.jobManager.listCallbackRetries()

  let restartReconcile: RestartReconcileResult | undefined
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
    for (const job of [...reconciled.swept, ...reconciled.interrupted, ...reconciled.declined]) {
      void runtime.reportTerminalJob(job)
    }
    // Awaited: every cleared job is launched (or failed and reported) before
    // the bridge serves, so a new trigger never races a relaunch for a slot.
    if (runtime.config.runtime.kind === "claude") {
      await relaunchJobs(reconciled.relaunch, (job) => relaunchClaudeJob(job, appDependencies))
    } else {
      await relaunchOpencodeJobs(reconciled.relaunch, { ...appDependencies, reportTerminalJob: runtime.reportTerminalJob })
    }
    restartReconcile = reconciled

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
    ...(restartReconcile !== undefined ? { restartReconcile } : {}),
  }
}

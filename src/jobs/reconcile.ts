/**
 * What a bridge does with the job store it finds when it starts, and the
 * periodic deadline sweep while it runs (v3.2.0 block K).
 *
 * A bridge that stops (crash, `aibr stop`, reboot) takes its runtime monitors
 * with it. Without this pass a `running` job stays `running` forever (its
 * requester polls `still_running` forever), and an approved job that never
 * launched is never launched.
 *
 * The rules, decided by `restartDecision`:
 *
 * | status                                  | `launchStartedAt` | outcome                                   |
 * |-----------------------------------------|-------------------|-------------------------------------------|
 * | terminal                                | any               | kept                                      |
 * | `awaiting_approval`                     | any               | kept (still needs `aibr approve`)         |
 * | `blocked`                               | any               | kept (dependencies re-evaluated as usual) |
 * | `accepted`                              | absent            | relaunched if still allowed (below), else failed `not relaunched after restart: <reason> (never started)` |
 * | `accepted`                              | present           | failed `interrupted: bridge restarted`    |
 * | `session_created`, `running`, `reporting`, `received` | any | failed `interrupted: bridge restarted`  |
 *
 * A job is never relaunched once it may have started: it can already have
 * changed a repository or run a command, and only the requester can decide
 * whether doing it again is safe. An `accepted` job without the marker is
 * relaunched only if this node would accept it again now (source and project
 * still allowlisted, capability still configured) AND it does not bypass the
 * approval boundary: a job that carries an approval record must be
 * `approved`; a job without one must not need approval under the CURRENT
 * config (`approvalRequired`). Otherwise it is declined: failed with
 * `not relaunched after restart: <reason> (never started)`, which tells the
 * requester that, unlike an interrupted job, it did nothing.
 *
 * Every job this pass ends is returned so the caller delivers its report
 * (`reportTerminalJob`) like any other terminal job.
 *
 * The runtime processes (Claude Code, script steps) a killed bridge left
 * running for these jobs are stopped before this pass, when the runtime is
 * built (`createRuntime` -> `terminateOrphanedRuntimeProcesses`), so that
 * they are gone before their worktrees are swept and before any job is
 * interrupted, relaunched or reported.
 */
import type { BridgeConfig } from "../config/types.js"
import { approvalRequired } from "../planning/approval.js"
import { authorizeClaudeCapability } from "../runtime/claude-job-runner.js"
import { assertProjectAllowed } from "../security/allowlist.js"
import { assertSourceAuthorized } from "../security/source-authorization.js"
import type { TaskGraphSyncer } from "../tasks/types.js"
import type { JobManager } from "./manager.js"
import { PING_CAPABILITY } from "./ping.js"
import type { JobRecord } from "./types.js"

/** The error of a job a restart ended. Requesters decide whether to dispatch it again. */
export const INTERRUPTED_BY_RESTART = "interrupted: bridge restarted"

/** Prefix of the error of a job a restart found never started and did not launch. */
export const NOT_RELAUNCHED_AFTER_RESTART = "not relaunched after restart"

/** The error of a never-started job a restart declined to launch. */
export function notRelaunchedError(reason: string): string {
  return `${NOT_RELAUNCHED_AFTER_RESTART}: ${reason} (never started)`
}

/** How often a running bridge sweeps for expired jobs. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000

export type RestartDecision =
  | { readonly action: "keep" }
  | { readonly action: "relaunch" }
  | { readonly action: "interrupt"; readonly error: string }
  | { readonly action: "decline"; readonly error: string }

/**
 * Why this node must not launch `job` again, or `undefined` when it may.
 * Re-checks the job against the CURRENT config, as `/trigger` would.
 */
export function relaunchRefusal(job: JobRecord, config: BridgeConfig): string | undefined {
  const trigger = job.trigger
  if (trigger.capability === PING_CAPABILITY) return "a ping is never relaunched"
  try {
    assertSourceAuthorized(trigger.source_agent_id, trigger.capability, config.security.allowed_sources)
    assertProjectAllowed(trigger.project_dir, config.projects)
  } catch (error) {
    return error instanceof Error ? error.message : "no longer authorized on this node"
  }

  let needsApproval: boolean
  // Optional chaining: a hand-built config object (tests, embedders) may predate the field.
  if ((config.runtime?.kind ?? "opencode") === "claude") {
    const decision = authorizeClaudeCapability(config, trigger)
    if (!decision.ok) return decision.body.error
    needsApproval = decision.approvalRequired
  } else {
    needsApproval = approvalRequired(config, trigger)
  }

  // A job that was ever held for approval runs only on an operator's approval.
  if (job.approval !== undefined) {
    return job.approval.status === "approved" ? undefined : `operator approval is ${job.approval.status}`
  }
  return needsApproval ? "this node now requires operator approval for it" : undefined
}

/** What a starting bridge does with one stored job. Pure: reads the job and the config only. */
export function restartDecision(job: JobRecord, config: BridgeConfig): RestartDecision {
  switch (job.status) {
    case "completed":
    case "failed":
    case "timed_out":
    case "callback_failed":
    case "awaiting_approval":
    case "blocked":
      return { action: "keep" }
    case "received":
    case "session_created":
    case "running":
    case "reporting":
      return { action: "interrupt", error: INTERRUPTED_BY_RESTART }
    case "accepted": {
      if (job.launchStartedAt !== undefined) return { action: "interrupt", error: INTERRUPTED_BY_RESTART }
      const refusal = relaunchRefusal(job, config)
      return refusal === undefined
        ? { action: "relaunch" }
        : { action: "decline", error: notRelaunchedError(refusal) }
    }
  }
}

export interface RestartReconcileOptions {
  readonly jobManager: JobManager
  readonly config: BridgeConfig
  readonly taskGraphSyncer?: Pick<TaskGraphSyncer, "syncJobToTask">
  /**
   * Best-effort stop of an OpenCode session an interrupted job left behind in
   * `opencode serve` (a separate process that may outlive the bridge), so it
   * does not keep working while its requester is told it was interrupted.
   */
  readonly abortOpencodeSession?: (sessionId: string) => Promise<void>
  readonly now?: string
}

export interface RestartReconcileResult {
  /**
   * Jobs the deadline sweep ended: `timed_out`, or `failed` because a
   * dependency failed (including a dependency this pass interrupted). Report them.
   */
  readonly swept: JobRecord[]
  /** Jobs that may have run, now `failed` with `INTERRUPTED_BY_RESTART`. Report them. */
  readonly interrupted: JobRecord[]
  /** Never-started jobs this node may no longer launch, now `failed` (`notRelaunchedError`). Report them. */
  readonly declined: JobRecord[]
  /** `accepted` jobs that never launched and may launch now. Launch them. */
  readonly relaunch: JobRecord[]
}

/**
 * Applies the restart rules to the whole store. Call it once, when the bridge
 * starts and before it serves requests: nothing in this process is running
 * yet, so every non-terminal job was left by a previous process.
 *
 * Expired jobs are timed out first (deadline from `jobDeadlineMs`); after
 * the interruptions, the sweep runs again so a `blocked` job whose dependency
 * was just interrupted fails now rather than at its deadline. Delivers no
 * report and launches nothing: the caller does both.
 */
export async function reconcileJobsAfterRestart(options: RestartReconcileOptions): Promise<RestartReconcileResult> {
  const { jobManager, config } = options
  const now = options.now ?? new Date().toISOString()
  const swept = await jobManager.sweepExpiredJobs(now)
  const interrupted: JobRecord[] = []
  const declined: JobRecord[] = []
  const relaunch: JobRecord[] = []

  for (const job of await jobManager.listJobs()) {
    const decision = restartDecision(job, config)
    if (decision.action === "keep") continue
    if (decision.action === "relaunch") {
      relaunch.push(job)
      continue
    }
    const failed = await jobManager.markFailed(job.id, decision.error, now).catch(() => undefined)
    if (failed === undefined) continue
    ;(decision.action === "interrupt" ? interrupted : declined).push(failed)
    await options.taskGraphSyncer?.syncJobToTask(job.trigger.task_id ?? `#${job.id}`, "failed").catch(() => undefined)
    if (job.opencodeSessionId !== undefined && options.abortOpencodeSession !== undefined) {
      void options.abortOpencodeSession(job.opencodeSessionId).catch(() => undefined)
    }
  }

  if (interrupted.length + declined.length > 0) swept.push(...(await jobManager.sweepExpiredJobs(now)))
  relaunch.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  return { swept, interrupted, declined, relaunch }
}

/**
 * Launches the jobs `reconcileJobsAfterRestart` cleared, one after another,
 * oldest first. `launch` owns failure handling (fail the job and report it);
 * a throw from it is swallowed so one job cannot stop the others.
 */
export async function relaunchJobs(
  jobs: readonly JobRecord[],
  launch: (job: JobRecord) => Promise<void>,
): Promise<void> {
  for (const job of jobs) {
    try {
      await launch(job)
    } catch {
      /* `launch` records and reports its own failures */
    }
  }
}

export interface PeriodicSweepOptions {
  readonly jobManager: JobManager
  readonly reportTerminalJob: (job: JobRecord) => Promise<void>
  /** Jobs a monitor in this process drives; they enforce their own deadline. */
  readonly isActive?: (jobId: string) => boolean
  readonly intervalMs?: number
}

/**
 * Runs `sweepExpiredJobs` every `intervalMs` (default 60 s) and reports every
 * job it ends. Never overlaps itself; never keeps the process alive. Returns
 * the stop function.
 */
export function startPeriodicSweep(options: PeriodicSweepOptions): () => void {
  let sweeping = false
  const timer = setInterval(() => {
    if (sweeping) return
    sweeping = true
    void (async () => {
      try {
        const expired = await options.jobManager.sweepExpiredJobs(undefined, {
          ...(options.isActive !== undefined ? { isActive: options.isActive } : {}),
        })
        for (const job of expired) void options.reportTerminalJob(job)
      } catch {
        /* a failed sweep is retried on the next tick */
      } finally {
        sweeping = false
      }
    })()
  }, options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * Polls `ready` every `intervalMs` until it answers true or `timeoutMs`
 * passes. Resolves to the last answer.
 */
export async function waitUntil(
  ready: () => boolean | Promise<boolean>,
  options: { readonly timeoutMs: number; readonly intervalMs: number },
): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs
  while (true) {
    const answer = await Promise.resolve()
      .then(ready)
      .catch(() => false)
    if (answer || Date.now() >= deadline) return answer
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs))
  }
}

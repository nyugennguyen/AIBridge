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
import { createTerminalJobReporter } from "../jobs/report.js"
import { ClaudeJobRunner, type ClaudeJobRunnerOptions } from "../runtime/claude-job-runner.js"
import { RepoWorkspaceManager } from "../runtime/repo-workspace.js"

/**
 * The OpenCode client of a node whose runtime is not OpenCode. Health is
 * `false` and every session operation throws, so a path that still reaches
 * for OpenCode (the router drain loop, `/report` unblocking) fails loudly
 * instead of contacting a server that was never configured.
 */
class UnconfiguredOpencodeClient implements OpencodeClient {
  async health(): Promise<boolean> {
    return false
  }
  async createSession(): Promise<never> {
    throw new Error("OpenCode is not configured on this node (runtime.kind is not \"opencode\")")
  }
  async sendPromptAsync(): Promise<never> {
    return this.createSession()
  }
  async subscribeEvents(): Promise<never> {
    return this.createSession()
  }
  async getSessionStatus(): Promise<never> {
    return this.createSession()
  }
  async replyPermission(): Promise<never> {
    return this.createSession()
  }
  async abortSession(): Promise<never> {
    return this.createSession()
  }
}

export interface RuntimeOptions {
  readonly configPath: string
  readonly stateDir: string
  /**
   * The shared bearer secret, or `null` for a profile in `none` mode. The callback
   * reporter omits the `Authorization` header entirely when this is null, rather
   * than sending a malformed one -- a peer that requires a token answers 401
   * either way, but only one of those looks like a bug in the log.
   */
  readonly bearerToken: string | null
  /**
   * The operator credential, or `null` when none is configured. Unlike the
   * shared bearer secret (which admits peers and carries no per-caller identity),
   * this secret is the sole basis for user-kind `actor` claims — charter approval
   * and direct revision authority (ADR 0008 §4). `null` fail-closes that
   * authority: no caller may claim `kind: "user"`.
   */
  readonly operatorToken?: string | null
  readonly environment: Record<string, string>
  readonly deps?: {
    readonly opencodeClient?: OpencodeClient
    readonly monitorSession?: (job: JobRecord) => Promise<void>
    readonly egressOutboxStore?: EgressOutboxStore
    /** Adapter overrides for the Claude runner (tests inject a fake `spawn`). */
    readonly claudeAdapterOptions?: ClaudeJobRunnerOptions["adapterOptions"]
    /** Worktree manager override (tests inject one over a fake git runner). */
    readonly repoWorkspaces?: RepoWorkspaceManager
  }
}

export interface Runtime {
  readonly config: BridgeConfig
  readonly opencodeClient: OpencodeClient
  readonly jobManager: JobManager
  readonly taskGraphSyncer: FileTaskGraphSyncer
  readonly callbackReporter: CallbackReporter
  readonly egressOutboxStore?: EgressOutboxStore
  /** Present when `runtime.kind` is `claude`: executes `/trigger` jobs on Claude Code. */
  readonly claudeJobRunner?: ClaudeJobRunner
  /** Present when `runtime.kind` is `claude`: resolves and checks out `repo`@`ref` for jobs. */
  readonly repoWorkspaces?: RepoWorkspaceManager
  /** Drives one job to a terminal state and delivers its report. */
  readonly monitorSession: (job: JobRecord) => Promise<void>
  /** Re-delivers the report of a job already known to be terminal. */
  readonly reportTerminalJob: (job: JobRecord) => Promise<void>
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const config = await loadConfig(options.configPath)

  // A Claude node never constructs (or contacts) an OpenCode client: the
  // `opencode` block is optional for it and usually absent.
  const opencodeConfig = config.runtime.kind === "opencode" ? config.opencode : undefined
  const opencodeClient: OpencodeClient =
    options.deps?.opencodeClient ??
    (opencodeConfig
      ? new SdkOpencodeClientAdapter({
          baseUrl: opencodeConfig.base_url,
          username: opencodeConfig.username,
          password: options.environment[opencodeConfig.password_env],
        })
      : new UnconfiguredOpencodeClient())

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
  const reportTerminalJob = createTerminalJobReporter({
    jobManager,
    callbackReporter,
    agentId: config.agent_id,
    bearerToken: options.bearerToken,
  })

  // Per-job worktrees under `<state>/repos` and `<state>/worktrees` (Phase 5).
  // Nothing runs yet, so every worktree on disk was left by a previous process.
  const repoWorkspaces =
    config.runtime.kind === "claude"
      ? (options.deps?.repoWorkspaces ?? new RepoWorkspaceManager({ stateDir: options.stateDir }))
      : undefined
  if (repoWorkspaces !== undefined) await repoWorkspaces.sweepStale().catch(() => undefined)

  const claudeJobRunner =
    config.runtime.kind === "claude"
      ? new ClaudeJobRunner({
          config,
          jobManager,
          taskGraphSyncer,
          reportTerminalJob,
          ...(repoWorkspaces !== undefined ? { workspaces: repoWorkspaces } : {}),
          // Redacted from script output tails, should a script echo them.
          knownSecrets: [options.bearerToken, options.operatorToken].filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          ),
          adapterOptions: {
            // The adapter's sanitizer forwards PATH, HOME and the Claude
            // provider credentials (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN)
            // from this environment and strips other secrets.
            env: options.environment,
            ...options.deps?.claudeAdapterOptions,
          },
        })
      : undefined

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
    ...(claudeJobRunner ? { claudeJobRunner } : {}),
    ...(repoWorkspaces ? { repoWorkspaces } : {}),
    monitorSession,
    reportTerminalJob,
  }
}

/**
 * Runs `/trigger` jobs on Claude Code under capability profiles (Phase 2 of
 * `Docs/implementation-plans/claude-adapter-and-plugin.md`).
 *
 * The route authorizes (bearer, source, project allowlist, capability
 * profile); this module turns an authorized job into a digest-stamped launch
 * request for `ClaudeCodeRuntimeAdapter`, derives the launch profile from the
 * capability profile plus the safety floor, polls the adapter (its `observe()`
 * is a snapshot, not a stream) until the run is terminal or times out, records
 * the result on the job and delivers the report callback.
 *
 * Phase 5 widens a job into a pipeline: optional `pre` scripts, then Claude
 * Code or the profile's deterministic `script`, then optional `post` scripts,
 * all in the job's working directory — a fresh worktree at the pinned sha when
 * the trigger named a `repo`. The runner also enforces
 * `limits.max_concurrent_jobs` and is the kill switch (`stopAll`).
 */
import { createHash } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import type {
  BridgeConfig,
  CapabilityProfile,
  ClaudeConfig,
  ProjectConfig,
  ReportFinding,
  ScriptResult,
  TriggerRequest,
} from "../config/types.js"
import { claudeConfigSchema } from "../config/schemas.js"
import type { JobManager } from "../jobs/manager.js"
import type { JobRecord, RuntimeJobResult, RuntimeJobUsage } from "../jobs/types.js"
import type { RepoWorkspaceManager } from "./repo-workspace.js"
import { CLAUDE_PROVIDER_ENV_KEYS } from "./sanitizer.js"
import { ScriptRunner, type RunningScript } from "./script-runner.js"
import { digestDispatchEnvelope, digestJson } from "../orchestration/digest.js"
import { contractErrorSchema, type Result } from "../orchestration/errors.js"
import type { TaskGraphSyncer } from "../tasks/types.js"
import {
  ClaudeCodeRuntimeAdapter,
  DEFAULT_CLAUDE_PERMISSION_MODE,
  type ClaudeCodeRuntimeAdapterOptions,
  type ClaudeLaunchProfile,
  type ClaudePermissionDenial,
  type ClaudeRunUsage,
} from "./claude-adapter.js"
import { launchAgentRequestSchema, type LaunchAgentRequest, type RuntimeOperationContext, type RuntimeSession } from "./schemas.js"

/**
 * Deny rules every Claude Code launch gets, whatever its capability profile
 * says. Applied in code, not config: a profile's `deny` is UNIONED with this
 * list, and Claude Code evaluates deny before allow, so no `allow` entry (not
 * even a bare `Bash` or `Read`) can re-open what the floor closes.
 *
 * Kept deliberately small and defensible — it is defence in depth for the
 * obvious exfiltration paths, not a sandbox (a shell can still reach a secret
 * by a route a prefix rule does not match; the worker's OS user is the real
 * boundary, plan Phase 2):
 *
 * - environment files in the project tree;
 * - the operator's SSH/cloud/GPG credentials and Claude Code's own credential file;
 * - AIBridge's profile config, secrets (bearer/operator tokens, node keys) and
 *   state, at their default XDG locations (`src/host/paths.ts`);
 * - edits to `~/.claude/**`, so a run cannot widen the permissions of the next
 *   one through the user settings this worker loads (`--setting-sources user`);
 * - shell network egress and privilege escalation.
 */
export const CLAUDE_SAFETY_FLOOR_DENY: readonly string[] = Object.freeze([
  "Read(./.env*)",
  "Read(**/.env*)",
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Read(~/.gnupg/**)",
  "Read(~/.netrc)",
  "Read(~/.claude/.credentials.json)",
  "Read(~/.config/aibridge/**)",
  "Read(~/.local/share/aibridge/**)",
  "Read(~/.local/state/aibridge/**)",
  "Edit(~/.claude/**)",
  "Edit(~/.config/aibridge/**)",
  "Edit(~/.local/share/aibridge/**)",
  "Edit(~/.local/state/aibridge/**)",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(ssh *)",
  "Bash(scp *)",
  "Bash(sudo *)",
])

/** Installation id the runner stamps into every envelope; the adapter must be built with the same one. */
export const CLAUDE_INSTALLATION_ID = "installation-claude"

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_DISPATCH_TIMEOUT_SECONDS = 86_400
const MAX_FINDINGS = 50
const MAX_ERROR_LENGTH = 2_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_MAX_CONCURRENT_JOBS = 2

/**
 * An id the kernel schemas accept. A value that already is one is kept, so ids
 * stay readable; anything else (a caller-chosen `job_id` with a slash, an
 * over-long project id) becomes a stable digest-derived id instead.
 */
export function toOpaqueId(raw: string, prefix: string): string {
  if (OPAQUE_ID_PATTERN.test(raw)) return raw
  return `${prefix}-${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 40)}`
}

/** The `claude` block with its defaults applied (the block itself is optional). */
export function resolveClaudeConfig(config: BridgeConfig): ClaudeConfig {
  return config.claude ?? claudeConfigSchema.parse({})
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** A configured profile by name: own properties only, so `toString` is not a profile. */
function capabilityProfile(config: BridgeConfig, name: string): CapabilityProfile | undefined {
  const profiles = config.capability_profiles ?? {}
  return Object.hasOwn(profiles, name) ? profiles[name] : undefined
}

/**
 * The launch profile for a capability profile: permission mode `dontAsk`, the
 * profile's allow rules, its deny rules unioned with the safety floor, its
 * budget/turn caps, and the node-wide `claude` isolation block.
 */
export function buildClaudeLaunchProfile(config: BridgeConfig, profileName: string): ClaudeLaunchProfile {
  const profile = capabilityProfile(config, profileName)
  if (profile === undefined) throw new Error(`Unknown capability profile: ${profileName}`)
  const claude = resolveClaudeConfig(config)
  const floor = new Set(CLAUDE_SAFETY_FLOOR_DENY)
  return {
    permissionMode: DEFAULT_CLAUDE_PERMISSION_MODE,
    // An allow rule identical to a floor rule would lose to the deny anyway;
    // dropping it keeps argv honest about what the run may do.
    allowedTools: unique((profile.allow ?? []).filter((rule) => !floor.has(rule))),
    disallowedTools: unique([...CLAUDE_SAFETY_FLOOR_DENY, ...(profile.deny ?? [])]),
    ...(profile.max_budget_usd !== undefined ? { maxBudgetUsd: profile.max_budget_usd } : {}),
    ...(profile.max_turns !== undefined ? { maxTurns: profile.max_turns } : {}),
    settingSources: [...claude.setting_sources],
    ...(claude.settings_path !== undefined ? { settingsPath: claude.settings_path } : {}),
    strictMcpConfig: claude.strict_mcp_config,
    ...(profile.append_system_prompt !== undefined ? { appendSystemPrompt: profile.append_system_prompt } : {}),
  }
}

export type ClaudeCapabilityDecision =
  | {
      readonly ok: true
      readonly name: string
      readonly profile: CapabilityProfile
      /** The job must be held as `awaiting_approval` until an operator approves it on this node. */
      readonly approvalRequired: boolean
    }
  | { readonly ok: false; readonly statusCode: 403; readonly body: { readonly error: string; readonly code: string } }

/**
 * Whether a capability may run on Claude Code here, and whether it needs an
 * operator's approval first. Runs AFTER the route's source and project
 * allowlist checks.
 *
 * Approval is decided from THIS node's config only: the profile's
 * `requires_approval`, `planning.require_approval_for` and the source's
 * `requires_plan_approval`. `metadata.plan_status` is written by the caller,
 * so it is never consulted for this runtime — a peer cannot approve itself.
 */
export function authorizeClaudeCapability(config: BridgeConfig, trigger: TriggerRequest): ClaudeCapabilityDecision {
  const profile = capabilityProfile(config, trigger.capability)
  if (profile === undefined) {
    return { ok: false, statusCode: 403, body: { error: "Unknown capability profile", code: "unknown_capability_profile" } }
  }
  const source = config.security.allowed_sources.find((candidate) => candidate.source_agent_id === trigger.source_agent_id)
  const approvalRequired =
    profile.requires_approval ||
    config.planning.require_approval_for.includes(trigger.capability) ||
    (source?.requires_plan_approval.includes(trigger.capability) ?? false)
  return { ok: true, name: trigger.capability, profile, approvalRequired }
}

/** Concurrent Claude/script jobs this node runs: `limits.max_concurrent_jobs`, default 2. */
export function maxConcurrentJobs(config: BridgeConfig): number {
  return config.limits?.max_concurrent_jobs ?? DEFAULT_MAX_CONCURRENT_JOBS
}

function findProject(projects: readonly ProjectConfig[], projectDir: string): ProjectConfig | undefined {
  const requested = resolve(projectDir)
  return projects.find((candidate) => resolve(candidate.path) === requested)
}

/** The envelope `projectPathId` of a job that runs in its own worktree. */
export function worktreePathId(jobId: string): string {
  return toOpaqueId(`worktree-${jobId}`, "worktree")
}

/**
 * Maps the envelope's opaque `projectPathId` back to an allowlisted directory,
 * or to a per-job worktree this runner created (`worktrees`), and nothing else.
 */
export function createConfigProjectResolver(
  projects: readonly ProjectConfig[],
  worktrees: ReadonlyMap<string, string> = new Map(),
): NonNullable<ClaudeCodeRuntimeAdapterOptions["projects"]> {
  return {
    async resolve(scope): Promise<Result<string>> {
      const worktree = worktrees.get(scope.projectPathId)
      if (worktree !== undefined) return { ok: true, value: worktree }
      const project = projects.find((candidate) => toOpaqueId(candidate.id, "project") === scope.projectPathId)
      if (project === undefined || !isAbsolute(project.path)) {
        return {
          ok: false,
          error: contractErrorSchema.parse({
            schemaVersion: 1,
            category: "policy_denied",
            code: "runtime.launch.project_scope",
            message: "The project is not allowlisted on this node.",
            retryable: false,
          }),
        }
      }
      return { ok: true, value: resolve(project.path) }
    },
  }
}

export interface ClaudeLaunchRequestInput {
  readonly config: BridgeConfig
  readonly job: JobRecord
  readonly nodeId: string
  readonly installationId: string
  readonly now: string
  /** The job runs in its own worktree (`worktreePathId`), not the project directory. */
  readonly inWorktree?: boolean
  /** Seconds left for this step; defaults to `claudeTimeoutSeconds`. */
  readonly timeoutSeconds?: number
}

/** Seconds a Claude run may take: the profile's `timeout_s`, else the trigger's. */
export function claudeTimeoutSeconds(config: BridgeConfig, trigger: TriggerRequest): number {
  const profile = capabilityProfile(config, trigger.capability)
  return Math.min(profile?.timeout_s ?? trigger.timeout_seconds, MAX_DISPATCH_TIMEOUT_SECONDS)
}

/**
 * The production dispatch envelope for a legacy `/trigger` job, with its digest.
 *
 * The capability profile name is the only requested capability, so the
 * adapter's launch-profile callback derives argv from the digest-stamped
 * envelope rather than from side state. The `approvalId` names the route's own
 * authorization of a legacy trigger, or (`approval-<job>`) the operator's
 * approval recorded on the job and in the approval ledger (ADR 0013); it is
 * not a kernel `approval.decided`.
 */
export function buildClaudeLaunchRequest(input: ClaudeLaunchRequestInput): LaunchAgentRequest {
  const { config, job, nodeId, installationId, now } = input
  const trigger = job.trigger
  const project = findProject(config.projects, trigger.project_dir)
  if (project === undefined) throw new Error(`Project directory is not allowlisted: ${trigger.project_dir}`)

  const projectId = toOpaqueId(project.id, "project")
  const capability = toOpaqueId(trigger.capability, "capability")
  const runId = toOpaqueId(`run-${job.id}`, "run")
  const dispatchId = toOpaqueId(`dispatch-${job.id}`, "dispatch")
  const taskId = toOpaqueId(`task-${job.id}`, "task")
  const profile = capabilityProfile(config, trigger.capability)
  const model = profile?.model ?? config.runtime.model
  const permission = {
    allowedCapabilities: [capability],
    deniedCapabilities: [],
    approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
  }

  const envelope = {
    schemaVersion: 1,
    dispatchId,
    attempt: 1,
    projectId,
    runId,
    taskId,
    targetNodeId: nodeId,
    installationId,
    runtimeKind: "claude",
    projectPathId: input.inWorktree === true ? worktreePathId(job.id) : projectId,
    prompt: trigger.prompt,
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "aibridge-claude-worker",
      templateVersion: 1,
      projectId,
      name: "AIBridge Claude worker",
      purpose: "Execute one job delegated to this node through /trigger.",
      instructions: [
        `You are running as an AIBridge worker on node "${config.agent_id}", executing job "${job.id}" delegated by "${trigger.source_agent_id}" under capability profile "${trigger.capability}".`,
        "Work only inside the current project directory.",
        ...(job.checkout !== undefined
          ? [`The directory is a detached checkout of repository "${job.checkout.repo}" at commit ${job.checkout.sha} (requested ref "${job.checkout.ref}").`]
          : []),
        "Tool permissions were fixed before launch. A denied tool call will not be approved later, so do not retry it: say what you could not do and why.",
        "Finish with a concise summary of what you found or changed.",
      ].join("\n"),
      requiredCapabilities: [capability],
      preferredRuntimeKinds: ["claude"],
      contextSelectionPolicyReference: { namespace: "policy", id: "none" },
      permissionRestrictions: permission,
      author: { kind: "system", name: "aibridge-trigger" },
      createdAt: now,
    },
    ruleSnapshots: [],
    contextManifest: { references: [], manifestDigest: digestJson({ references: [] }) },
    requestedCapabilities: [capability],
    permissionEnvelope: permission,
    dependencies: [],
    timeoutSeconds: Math.max(1, Math.min(input.timeoutSeconds ?? claudeTimeoutSeconds(config, trigger), MAX_DISPATCH_TIMEOUT_SECONDS)),
    controllerEpoch: 1,
    ...(model !== undefined ? { model } : {}),
  }

  return launchAgentRequestSchema.parse({
    schemaVersion: 1,
    operation: {
      schemaVersion: 1,
      commandId: toOpaqueId(`launch-${job.id}`, "launch"),
      correlationId: toOpaqueId(job.id, "job"),
      projectId,
      runId,
      dispatchId,
      nodeId,
      controllerNodeId: nodeId,
      controllerEpoch: 1,
      leaseId: "lease-legacy-trigger",
    },
    dispatchEnvelope: envelope,
    dispatchEnvelopeDigest: digestDispatchEnvelope(envelope),
    approvalId:
      job.approval?.status === "approved"
        ? toOpaqueId(`approval-${job.id}`, "approval")
        : toOpaqueId(`trigger-${job.id}`, "trigger"),
  })
}

/** Tool denials as report findings, so the orchestrator sees why the agent got stuck. */
export function permissionDenialFindings(denials: readonly ClaudePermissionDenial[], profileName: string): ReportFinding[] {
  const seen = new Set<string>()
  const findings: ReportFinding[] = []
  let omitted = 0
  for (const denial of denials) {
    const key = `${denial.toolName}\u0000${denial.inputPreview ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    if (findings.length >= MAX_FINDINGS) {
      omitted += 1
      continue
    }
    findings.push({
      severity: "medium",
      title: `Tool denied: ${denial.toolName}`,
      details: [
        `Denied by capability profile "${profileName}".`,
        denial.reason ? `Reason: ${denial.reason}` : undefined,
        denial.inputPreview ? `Input: ${denial.inputPreview}` : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" "),
    })
  }
  if (omitted > 0) {
    findings.push({ severity: "low", title: "Further tool denials omitted", details: `${omitted} more distinct denials were not listed.` })
  }
  return findings
}

/** One line of run accounting, in the adapter's own footer format. */
export function formatClaudeUsageLine(usage: ClaudeRunUsage | undefined): string {
  if (usage === undefined) return "[claude] no usage recorded"
  const denials = usage.permissionDenials
  return `[claude] ${[
    `subtype=${usage.resultSubtype ?? "none"}`,
    usage.numTurns !== undefined ? `turns=${usage.numTurns}` : undefined,
    usage.totalCostUsd !== undefined ? `cost_usd=${usage.totalCostUsd}` : undefined,
    usage.durationMs !== undefined ? `duration_ms=${usage.durationMs}` : undefined,
    `session=${usage.providerSessionId}`,
    `permission_denials=${denials.length}`,
  ]
    .filter(Boolean)
    .join(" ")}`
}

/** The slice of the adapter the runner drives. */
export type ClaudeRuntimeAdapterPort = Pick<
  ClaudeCodeRuntimeAdapter,
  "launch" | "observe" | "terminate" | "collectResult" | "usageFor"
>

/** The slice of `RepoWorkspaceManager` the runner drives. */
export type RepoWorkspacePort = Pick<RepoWorkspaceManager, "createWorktree" | "removeWorktree">

/** The slice of `ScriptRunner` the runner drives. */
export type ScriptRunnerPort = Pick<ScriptRunner, "start">

export interface ClaudeJobRunnerOptions {
  readonly config: BridgeConfig
  readonly jobManager: JobManager
  /** Delivers the report of a terminal job (`createTerminalJobReporter`). */
  readonly reportTerminalJob: (job: JobRecord) => Promise<void>
  readonly taskGraphSyncer?: TaskGraphSyncer
  /** A prebuilt adapter. Must use `runner.nodeId`, `CLAUDE_INSTALLATION_ID` and `runner.launchProfileFor`. */
  readonly adapter?: ClaudeRuntimeAdapterPort
  /** Options for the adapter the runner builds when `adapter` is absent (spawn, env, executable…). */
  readonly adapterOptions?: Omit<ClaudeCodeRuntimeAdapterOptions, "nodeId" | "installationId" | "projects" | "launchProfile">
  /** Per-job worktrees for triggers that name a `repo`. Absent: such jobs fail at start. */
  readonly workspaces?: RepoWorkspacePort
  /** Runs profile `script` / `pre` / `post` steps. Defaults to a `ScriptRunner` over `adapterOptions.env`. */
  readonly scripts?: ScriptRunnerPort
  /** Values redacted from script output tails (bearer/operator tokens). */
  readonly knownSecrets?: readonly string[]
  readonly pollIntervalMs?: number
  /** Milliseconds clock, for timeouts. */
  readonly clock?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/** A started Claude Code process of one job. */
export interface ClaudeStepLaunch {
  readonly session: RuntimeSession
  readonly operation: RuntimeOperationContext
  /** Claude Code's own session UUID. */
  readonly runtimeSessionId: string
  readonly timeoutSeconds: number
}

/** A started job, returned by `start` and handed to `monitor`. */
export interface ClaudeJobLaunch {
  readonly job: JobRecord
  /** Working directory of every step: the job's worktree, or the allowlisted project directory. */
  readonly cwd: string
  /** Whole-job budget in seconds (profile `timeout_s`, else the trigger's). */
  readonly timeoutSeconds: number
  /** Present when `start` launched Claude Code as the job's first step (no `pre`, no `script`). */
  readonly claude?: ClaudeStepLaunch
  /** Claude Code's session UUID, when `start` launched it. */
  readonly runtimeSessionId?: string
  /** Clock reading when `start` began; the job's deadline is measured from it. */
  readonly startedAtMs?: number
}

/** Thrown by `start` when `limits.max_concurrent_jobs` jobs are already running. */
export class RunnerAtCapacityError extends Error {
  readonly code = "node_at_capacity"
}

/** The reason `stopAll` records on every job it stops. */
export const STOPPED_BY_OPERATOR = "stopped by operator"

type TerminalState = "completed" | "failed" | "unknown" | "timed_out"

interface StepOutcome {
  readonly state: TerminalState
  readonly summary: string
  readonly findings: ReportFinding[]
  readonly usage?: RuntimeJobUsage
  /** Overrides the job's `error` (defaults to the summary). */
  readonly error?: string
}

/** One job between `start` and the end of `monitor`. */
interface ActiveJob {
  readonly jobId: string
  stopReason?: string
  claude?: { readonly session: RuntimeSession; readonly operation: RuntimeOperationContext }
  script?: RunningScript
  /** Settles when `monitor` has recorded and reported the job. */
  done?: Promise<unknown>
  /** Set by `start` when it created a worktree, so cleanup knows what to remove. */
  worktreeRepo?: string
}

export class ClaudeJobRunner {
  readonly nodeId: string
  readonly #config: BridgeConfig
  readonly #jobManager: JobManager
  readonly #reportTerminalJob: (job: JobRecord) => Promise<void>
  readonly #taskGraphSyncer?: TaskGraphSyncer
  readonly #adapter: ClaudeRuntimeAdapterPort
  readonly #workspaces?: RepoWorkspacePort
  readonly #scripts: ScriptRunnerPort
  readonly #pollIntervalMs: number
  readonly #clock: () => number
  readonly #sleep: (ms: number) => Promise<void>
  /** projectPathId -> worktree path, consulted by the adapter's project resolver. */
  readonly #worktrees = new Map<string, string>()
  readonly #active = new Map<string, ActiveJob>()

  constructor(options: ClaudeJobRunnerOptions) {
    this.#config = options.config
    this.nodeId = toOpaqueId(options.config.agent_id, "node")
    this.#jobManager = options.jobManager
    this.#reportTerminalJob = options.reportTerminalJob
    this.#taskGraphSyncer = options.taskGraphSyncer
    this.#workspaces = options.workspaces
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.#clock = options.clock ?? Date.now
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)))
    const sourceEnv = options.adapterOptions?.env ?? process.env
    this.#scripts =
      options.scripts ??
      new ScriptRunner({
        env: sourceEnv,
        knownSecrets: [
          ...(options.knownSecrets ?? []),
          ...CLAUDE_PROVIDER_ENV_KEYS.map((key) => sourceEnv[key]).filter((value): value is string => typeof value === "string"),
        ],
      })
    this.#adapter =
      options.adapter ??
      new ClaudeCodeRuntimeAdapter({
        executablePath: options.config.runtime.executable ?? "claude",
        ...options.adapterOptions,
        nodeId: this.nodeId,
        installationId: CLAUDE_INSTALLATION_ID,
        projects: createConfigProjectResolver(options.config.projects, this.#worktrees),
        allowedProjectRoots: options.config.projects.map((project) => resolve(project.path)),
        launchProfile: (request) => this.launchProfileFor(request),
      })
  }

  /** Launch-profile callback: derived from the envelope's (digest-stamped) requested capability. */
  launchProfileFor(request: LaunchAgentRequest): ClaudeLaunchProfile {
    const capability = request.dispatchEnvelope.requestedCapabilities[0]
    const name = Object.keys(this.#config.capability_profiles ?? {}).find(
      (candidate) => toOpaqueId(candidate, "capability") === capability,
    )
    if (name === undefined) throw new Error("The dispatch names no configured capability profile.")
    return buildClaudeLaunchProfile(this.#config, name)
  }

  /** Whether another job may start now (`limits.max_concurrent_jobs`). */
  hasCapacity(): boolean {
    return this.#active.size < maxConcurrentJobs(this.#config)
  }

  /** Ids of the jobs currently between `start` and the end of `monitor`. */
  activeJobIds(): string[] {
    return [...this.#active.keys()]
  }

  /**
   * Claims a concurrency slot, prepares the job's working directory (its own
   * worktree at the pinned sha when the job has a `checkout`) and, when the
   * profile's first step is Claude Code, launches it. Moves the job to
   * `running`. Throws `RunnerAtCapacityError` when the node is full, or the
   * launch error; on a throw the slot and any worktree are released and the
   * job is left for the caller to fail.
   */
  async start(job: JobRecord): Promise<ClaudeJobLaunch> {
    if (this.#active.has(job.id)) throw new Error(`Job ${job.id} is already running`)
    if (!this.hasCapacity()) {
      throw new RunnerAtCapacityError(
        `This node is already running ${this.#active.size} job(s), its limit (limits.max_concurrent_jobs = ${maxConcurrentJobs(this.#config)}). Retry later.`,
      )
    }
    const active: ActiveJob = { jobId: job.id }
    this.#active.set(job.id, active)
    const startedAt = this.#clock()
    const timeoutSeconds = claudeTimeoutSeconds(this.#config, job.trigger)
    try {
      const cwd = await this.#prepareWorkingDirectory(job, active)
      const profile = capabilityProfile(this.#config, job.trigger.capability)
      if (profile === undefined) throw new Error(`Unknown capability profile: ${job.trigger.capability}`)

      let claude: ClaudeStepLaunch | undefined
      if (profile.script === undefined && (profile.pre ?? []).length === 0) {
        claude = await this.#launchClaude(job, active, timeoutSeconds)
      }
      const running = await this.#jobManager.markRunning(job.id)
      return {
        job: running,
        cwd,
        timeoutSeconds,
        ...(claude !== undefined ? { claude, runtimeSessionId: claude.runtimeSessionId } : {}),
        startedAtMs: startedAt,
      }
    } catch (error) {
      await this.#releaseJob(job, active)
      throw error
    }
  }

  /**
   * Runs the job's remaining steps (`pre` scripts, Claude Code or the profile
   * `script`, `post` scripts) to a terminal state within the job's timeout,
   * records the result, marks the job terminal, removes its worktree, frees
   * its slot, syncs the task graph and delivers the report. Never rejects;
   * resolves to the terminal job, or `undefined` when the job was already
   * terminal by another path.
   */
  monitor(launch: ClaudeJobLaunch): Promise<JobRecord | undefined> {
    const active = this.#active.get(launch.job.id) ?? { jobId: launch.job.id }
    this.#active.set(launch.job.id, active)
    const done = this.#monitor(launch, active)
    active.done = done
    return done
  }

  /**
   * The kill switch: asks every running job to stop (terminating its Claude
   * Code process or killing its script's process group). Each job is then
   * failed with `reason` and reported by its own monitor. Resolves with the
   * stopped job ids once those monitors settle, or after `waitMs`.
   */
  async stopAll(reason: string = STOPPED_BY_OPERATOR, waitMs = 15_000): Promise<string[]> {
    const stopped: ActiveJob[] = []
    for (const active of this.#active.values()) {
      if (active.stopReason !== undefined) continue
      active.stopReason = reason
      stopped.push(active)
      if (active.claude !== undefined) {
        await this.#adapter.terminate(active.claude.session, active.claude.operation).catch(() => undefined)
      }
      active.script?.kill()
    }
    const settled = Promise.all(stopped.map((active) => active.done ?? Promise.resolve()))
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([settled, new Promise((done) => (timer = setTimeout(done, waitMs)))])
    if (timer !== undefined) clearTimeout(timer)
    return stopped.map((active) => active.jobId)
  }

  async #monitor(launch: ClaudeJobLaunch, active: ActiveJob): Promise<JobRecord | undefined> {
    const jobId = launch.job.id
    const scriptResults: ScriptResult[] = []
    let outcome: StepOutcome
    try {
      outcome = await this.#runPipeline(launch, active, scriptResults)
    } catch (error) {
      outcome = { state: "failed", summary: error instanceof Error ? error.message : "Job failed", findings: [] }
    }
    const stopReason = active.stopReason
    if (stopReason !== undefined && outcome.state !== "completed") {
      const prefix = capitalize(stopReason)
      outcome = {
        ...outcome,
        state: "failed",
        summary: outcome.summary.startsWith(prefix) ? outcome.summary : `${prefix}.\n\n${outcome.summary}`,
        error: stopReason,
      }
    }
    await this.#releaseJob(launch.job, active)

    const result: RuntimeJobResult = {
      summary: outcome.summary,
      findings: outcome.findings,
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
      ...(scriptResults.length > 0 ? { scriptResults } : {}),
    }

    let terminal: JobRecord
    try {
      await this.#jobManager.recordRuntimeResult(jobId, result)
      terminal =
        outcome.state === "completed"
          ? await this.#jobManager.markCompleted(jobId)
          : outcome.state === "timed_out"
            ? await this.#jobManager.markTimedOut(jobId)
            : await this.#jobManager.markFailed(jobId, truncate(outcome.error ?? outcome.summary, MAX_ERROR_LENGTH))
    } catch {
      // Already terminal (e.g. swept at startup): its report is owned elsewhere.
      return undefined
    }

    try {
      await this.#taskGraphSyncer?.syncJobToTask(
        launch.job.trigger.task_id ?? `#${jobId}`,
        outcome.state === "completed" ? "done" : "failed",
      )
    } catch {
      /* the task graph is advisory; never block the report on it */
    }
    await this.#reportTerminalJob(terminal)
    return terminal
  }

  async #runPipeline(launch: ClaudeJobLaunch, active: ActiveJob, scriptResults: ScriptResult[]): Promise<StepOutcome> {
    const job = launch.job
    const profile = capabilityProfile(this.#config, job.trigger.capability)
    if (profile === undefined) throw new Error(`Unknown capability profile: ${job.trigger.capability}`)
    const deadline = (launch.startedAtMs ?? this.#clock()) + launch.timeoutSeconds * 1000
    const stopped = (): StepOutcome | undefined =>
      active.stopReason !== undefined ? { state: "failed", summary: capitalize(active.stopReason), findings: [], error: active.stopReason } : undefined

    if (launch.claude === undefined) {
      for (const script of profile.pre ?? []) {
        const failure = await this.#runScriptStep("pre", script, launch, active, deadline, scriptResults)
        if (failure !== undefined) return failure
      }
    }
    const beforeMain = stopped()
    if (beforeMain !== undefined) return beforeMain

    let main: StepOutcome
    if (profile.script !== undefined) {
      const failure = await this.#runScriptStep("main", profile.script, launch, active, deadline, scriptResults)
      if (failure !== undefined) return failure
      const last = scriptResults.at(-1)
      main = {
        state: "completed",
        summary: `Script ${profile.script} exited 0 in ${last?.duration_ms ?? 0} ms.${last?.stdout_tail ? `\n\n${last.stdout_tail}` : ""}`,
        findings: [],
      }
    } else {
      const remainingSeconds = Math.max(1, Math.ceil((deadline - this.#clock()) / 1000))
      const claude = launch.claude ?? (await this.#launchClaude(job, active, remainingSeconds, true))
      main = await this.#awaitClaude(job, claude, active, deadline)
    }
    if (main.state !== "completed") return main

    for (const script of profile.post ?? []) {
      const failure = await this.#runScriptStep("post", script, launch, active, deadline, scriptResults)
      if (failure !== undefined) return { ...failure, summary: `${main.summary}\n\n${failure.summary}`, findings: [...main.findings, ...failure.findings] }
    }
    return main
  }

  /** Runs one script step; `undefined` when it exited 0, else the outcome that ends the job. */
  async #runScriptStep(
    phase: ScriptResult["phase"],
    script: string,
    launch: ClaudeJobLaunch,
    active: ActiveJob,
    deadline: number,
    scriptResults: ScriptResult[],
  ): Promise<StepOutcome | undefined> {
    if (active.stopReason !== undefined) {
      return { state: "failed", summary: capitalize(active.stopReason), findings: [], error: active.stopReason }
    }
    const remaining = deadline - this.#clock()
    if (remaining <= 0) {
      return { state: "timed_out", summary: `Job exceeded its ${launch.timeoutSeconds}s timeout before ${phase} script ${script}.`, findings: [] }
    }
    const running = this.#scripts.start({
      phase,
      script,
      cwd: launch.cwd,
      timeoutMs: remaining,
      extraEnv: {
        AIBR_JOB_ID: launch.job.id,
        AIBR_CAPABILITY: launch.job.trigger.capability,
        AIBR_SCRIPT_PHASE: phase,
        ...(launch.job.checkout !== undefined ? { AIBR_SHA: launch.job.checkout.sha } : {}),
      },
    })
    active.script = running
    let result: ScriptResult
    try {
      result = await running.result
    } finally {
      active.script = undefined
    }
    scriptResults.push(result)
    if (active.stopReason !== undefined) {
      return { state: "failed", summary: capitalize(active.stopReason), findings: [], error: active.stopReason }
    }
    if (result.timed_out) {
      return {
        state: "timed_out",
        summary: `${capitalize(phase)} script ${script} exceeded the job's ${launch.timeoutSeconds}s timeout and was killed.`,
        findings: [scriptFinding(result)],
      }
    }
    if (result.exit_code === 0) return undefined
    return {
      state: "failed",
      summary: `${capitalize(phase)} script ${script} failed (${describeScriptExit(result)}).`,
      findings: [scriptFinding(result)],
    }
  }

  async #prepareWorkingDirectory(job: JobRecord, active: ActiveJob): Promise<string> {
    if (job.checkout === undefined) {
      const project = findProject(this.#config.projects, job.trigger.project_dir)
      if (project === undefined) throw new Error(`Project directory is not allowlisted: ${job.trigger.project_dir}`)
      return resolve(project.path)
    }
    if (this.#workspaces === undefined) throw new Error("Repository checkouts are not available on this node.")
    const path = await this.#workspaces.createWorktree(job.checkout.repo, job.id, job.checkout.sha)
    active.worktreeRepo = job.checkout.repo
    this.#worktrees.set(worktreePathId(job.id), path)
    return path
  }

  async #releaseJob(job: JobRecord, active: ActiveJob): Promise<void> {
    if (active.worktreeRepo !== undefined) {
      this.#worktrees.delete(worktreePathId(job.id))
      await this.#workspaces?.removeWorktree(active.worktreeRepo, job.id)
      active.worktreeRepo = undefined
    }
    if (this.#active.get(job.id) === active) this.#active.delete(job.id)
  }

  /**
   * Launches Claude Code for the job and records its session. `markRunning`
   * re-marks the job running when the launch follows `pre` steps (recording
   * the session moves the job to `session_created`).
   */
  async #launchClaude(job: JobRecord, active: ActiveJob, timeoutSeconds: number, markRunning = false): Promise<ClaudeStepLaunch> {
    const request = buildClaudeLaunchRequest({
      config: this.#config,
      job,
      nodeId: this.nodeId,
      installationId: CLAUDE_INSTALLATION_ID,
      now: new Date(this.#clock()).toISOString(),
      inWorktree: job.checkout !== undefined,
      timeoutSeconds,
    })
    const launched = await this.#adapter.launch(request)
    if (!launched.ok) throw new Error(`Claude Code launch failed: ${launched.error.message}`)
    const session = launched.value
    active.claude = { session, operation: request.operation }
    const runtimeSessionId = this.#adapter.usageFor(session.sessionId)?.providerSessionId ?? session.sessionId
    await this.#jobManager.attachRuntimeSession(job.id, "claude", runtimeSessionId)
    if (markRunning) await this.#jobManager.markRunning(job.id)
    if (active.stopReason !== undefined) await this.#adapter.terminate(session, request.operation)
    return { session, operation: request.operation, runtimeSessionId, timeoutSeconds: request.dispatchEnvelope.timeoutSeconds }
  }

  async #awaitClaude(job: JobRecord, claude: ClaudeStepLaunch, active: ActiveJob, deadline: number): Promise<StepOutcome> {
    let state: TerminalState
    let detail: string | undefined
    try {
      ;({ state, detail } = await this.#waitForTerminal(claude, active, deadline))
    } catch (error) {
      state = "failed"
      detail = error instanceof Error ? error.message : "Claude Code monitor failed"
    }
    try {
      return await this.#buildResult(job, claude, state, detail)
    } catch (error) {
      return { state, summary: error instanceof Error ? error.message : "Claude Code result could not be collected", findings: [] }
    } finally {
      active.claude = undefined
    }
  }

  async #waitForTerminal(
    claude: ClaudeStepLaunch,
    active: ActiveJob,
    deadline: number,
  ): Promise<{ state: TerminalState; detail?: string }> {
    while (true) {
      let latest: "starting" | "idle" | "working" | "blocked" | "completed" | "failed" | "unknown" | undefined
      for await (const observed of this.#adapter.observe(claude.session, claude.operation)) {
        if (!observed.ok) return { state: "failed", detail: observed.error.message }
        if (observed.value.type === "lifecycle") latest = observed.value.state
      }
      if (active.stopReason !== undefined) {
        await this.#adapter.terminate(claude.session, claude.operation)
        return { state: "failed", detail: active.stopReason }
      }
      if (latest === "completed" || latest === "failed" || latest === "unknown") return { state: latest }

      const remaining = deadline - this.#clock()
      if (remaining <= 0) {
        await this.#adapter.terminate(claude.session, claude.operation)
        return { state: "timed_out" }
      }
      await this.#sleep(Math.min(this.#pollIntervalMs, remaining))
    }
  }

  async #buildResult(job: JobRecord, claude: ClaudeStepLaunch, state: TerminalState, detail: string | undefined): Promise<StepOutcome> {
    const usage = this.#adapter.usageFor(claude.session.sessionId)
    const collected = await this.#adapter.collectResult(claude.session, claude.operation)
    const collectedSummary = collected.ok ? collected.value.summary : collected.error.message
    const usageLine = formatClaudeUsageLine(usage)

    let summary: string
    switch (state) {
      case "completed":
      case "failed":
        summary = detail ? `Claude Code run failed: ${detail}` : collectedSummary
        break
      case "unknown":
        summary = `Claude Code exited without a verified result. ${collectedSummary}`
        break
      case "timed_out":
        summary = `Claude Code run exceeded its ${claude.timeoutSeconds}s timeout and was terminated.`
        break
    }
    if (!summary.includes("[claude]")) summary = `${summary}\n\n${usageLine}`

    return {
      state,
      summary,
      findings: permissionDenialFindings(usage?.permissionDenials ?? [], job.trigger.capability),
      usage: {
        ...(usage?.providerSessionId !== undefined ? { providerSessionId: usage.providerSessionId } : {}),
        ...(usage?.model !== undefined ? { model: usage.model } : {}),
        ...(usage?.resultSubtype !== undefined ? { resultSubtype: usage.resultSubtype } : {}),
        ...(usage?.totalCostUsd !== undefined ? { totalCostUsd: usage.totalCostUsd } : {}),
        ...(usage?.numTurns !== undefined ? { numTurns: usage.numTurns } : {}),
        ...(usage?.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
        permissionDenials: usage?.permissionDenials.length ?? 0,
      },
    }
  }
}

function describeScriptExit(result: ScriptResult): string {
  if (result.exit_code !== null) return `exit ${result.exit_code}`
  if (result.signal !== undefined) return `signal ${result.signal}`
  return result.stderr_tail.length > 0 ? truncate(result.stderr_tail, 300) : "did not run"
}

function scriptFinding(result: ScriptResult): ReportFinding {
  const stderr = result.stderr_tail.trim()
  return {
    severity: "high",
    title: `Script ${result.timed_out ? "timed out" : "failed"}: ${result.script}`,
    details: [`Phase ${result.phase}, ${result.timed_out ? "timed out" : describeScriptExit(result)}.`, stderr ? `stderr: ${truncate(stderr, 1_000)}` : undefined]
      .filter((part): part is string => part !== undefined)
      .join(" "),
  }
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

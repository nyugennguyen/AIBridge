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
 */
import { createHash } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import type { BridgeConfig, CapabilityProfile, ClaudeConfig, ProjectConfig, ReportFinding, TriggerRequest } from "../config/types.js"
import { claudeConfigSchema } from "../config/schemas.js"
import type { JobManager } from "../jobs/manager.js"
import type { JobRecord, RuntimeJobResult } from "../jobs/types.js"
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
  | { readonly ok: true; readonly name: string; readonly profile: CapabilityProfile }
  | { readonly ok: false; readonly statusCode: 403 | 501; readonly body: { readonly error: string; readonly code: string } }

/**
 * Whether a capability may run on Claude Code here. Runs AFTER the route's
 * source and project allowlist checks.
 *
 * Approval is refused outright in Phase 2: `metadata.plan_status` is a field
 * the caller writes, so it is not trusted for this runtime.
 * TODO(Phase 4): route approval-gated profiles through
 * `dispatch.propose -> dispatch.approve -> dispatch.execute` with an operator
 * actor instead of refusing them.
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
  if (approvalRequired) {
    return { ok: false, statusCode: 403, body: { error: "Approval required", code: "approval_required" } }
  }
  if (profile.script !== undefined) {
    return {
      ok: false,
      statusCode: 501,
      body: { error: "Capability profile scripts are not implemented until Phase 5", code: "not_implemented" },
    }
  }
  return { ok: true, name: trigger.capability, profile }
}

function findProject(projects: readonly ProjectConfig[], projectDir: string): ProjectConfig | undefined {
  const requested = resolve(projectDir)
  return projects.find((candidate) => resolve(candidate.path) === requested)
}

/** Maps the envelope's opaque `projectPathId` back to an allowlisted directory, and nothing else. */
export function createConfigProjectResolver(
  projects: readonly ProjectConfig[],
): NonNullable<ClaudeCodeRuntimeAdapterOptions["projects"]> {
  return {
    async resolve(scope): Promise<Result<string>> {
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
 * authorization of a legacy trigger; it is not a kernel approval.
 * TODO(Phase 4): carry the real `dispatch.approve` id.
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
    projectPathId: projectId,
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
    timeoutSeconds: claudeTimeoutSeconds(config, trigger),
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
    approvalId: toOpaqueId(`trigger-${job.id}`, "trigger"),
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
  readonly pollIntervalMs?: number
  /** Milliseconds clock, for timeouts. */
  readonly clock?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/** A launched job, returned by `start` and handed to `monitor`. */
export interface ClaudeJobLaunch {
  readonly job: JobRecord
  readonly session: RuntimeSession
  readonly operation: RuntimeOperationContext
  /** Claude Code's own session UUID. */
  readonly runtimeSessionId: string
  readonly timeoutSeconds: number
}

type TerminalState = "completed" | "failed" | "unknown" | "timed_out"

export class ClaudeJobRunner {
  readonly nodeId: string
  readonly #config: BridgeConfig
  readonly #jobManager: JobManager
  readonly #reportTerminalJob: (job: JobRecord) => Promise<void>
  readonly #taskGraphSyncer?: TaskGraphSyncer
  readonly #adapter: ClaudeRuntimeAdapterPort
  readonly #pollIntervalMs: number
  readonly #clock: () => number
  readonly #sleep: (ms: number) => Promise<void>

  constructor(options: ClaudeJobRunnerOptions) {
    this.#config = options.config
    this.nodeId = toOpaqueId(options.config.agent_id, "node")
    this.#jobManager = options.jobManager
    this.#reportTerminalJob = options.reportTerminalJob
    this.#taskGraphSyncer = options.taskGraphSyncer
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.#clock = options.clock ?? Date.now
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)))
    this.#adapter =
      options.adapter ??
      new ClaudeCodeRuntimeAdapter({
        executablePath: options.config.runtime.executable ?? "claude",
        ...options.adapterOptions,
        nodeId: this.nodeId,
        installationId: CLAUDE_INSTALLATION_ID,
        projects: createConfigProjectResolver(options.config.projects),
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

  /**
   * Launches the Claude Code process for an accepted job and moves the job to
   * `running`. Throws when the adapter refuses or fails the launch; the job is
   * left for the caller to fail.
   */
  async start(job: JobRecord): Promise<ClaudeJobLaunch> {
    const request = buildClaudeLaunchRequest({
      config: this.#config,
      job,
      nodeId: this.nodeId,
      installationId: CLAUDE_INSTALLATION_ID,
      now: new Date(this.#clock()).toISOString(),
    })
    const launched = await this.#adapter.launch(request)
    if (!launched.ok) throw new Error(`Claude Code launch failed: ${launched.error.message}`)
    const session = launched.value
    const runtimeSessionId = this.#adapter.usageFor(session.sessionId)?.providerSessionId ?? session.sessionId
    await this.#jobManager.attachRuntimeSession(job.id, "claude", runtimeSessionId)
    const running = await this.#jobManager.markRunning(job.id)
    return {
      job: running,
      session,
      operation: request.operation,
      runtimeSessionId,
      timeoutSeconds: request.dispatchEnvelope.timeoutSeconds,
    }
  }

  /**
   * Polls the run to a terminal state (terminating it on timeout), records the
   * result on the job, marks it terminal, syncs the task graph and delivers
   * the report. Never rejects; resolves to the terminal job, or `undefined`
   * when the job was already terminal by another path.
   */
  async monitor(launch: ClaudeJobLaunch): Promise<JobRecord | undefined> {
    const jobId = launch.job.id
    let state: TerminalState
    let detail: string | undefined
    try {
      ;({ state, detail } = await this.#waitForTerminal(launch))
    } catch (error) {
      state = "failed"
      detail = error instanceof Error ? error.message : "Claude Code monitor failed"
    }

    let result: RuntimeJobResult
    try {
      result = await this.#buildResult(launch, state, detail)
    } catch (error) {
      result = { summary: error instanceof Error ? error.message : "Claude Code result could not be collected", findings: [] }
    }

    let terminal: JobRecord
    try {
      await this.#jobManager.recordRuntimeResult(jobId, result)
      terminal =
        state === "completed"
          ? await this.#jobManager.markCompleted(jobId)
          : state === "timed_out"
            ? await this.#jobManager.markTimedOut(jobId)
            : await this.#jobManager.markFailed(jobId, truncate(result.summary, MAX_ERROR_LENGTH))
    } catch {
      // Already terminal (e.g. swept at startup): its report is owned elsewhere.
      return undefined
    }

    try {
      await this.#taskGraphSyncer?.syncJobToTask(launch.job.trigger.task_id ?? `#${jobId}`, state === "completed" ? "done" : "failed")
    } catch {
      /* the task graph is advisory; never block the report on it */
    }
    await this.#reportTerminalJob(terminal)
    return terminal
  }

  async #waitForTerminal(launch: ClaudeJobLaunch): Promise<{ state: TerminalState; detail?: string }> {
    const deadline = this.#clock() + launch.timeoutSeconds * 1000
    while (true) {
      let latest: "starting" | "idle" | "working" | "blocked" | "completed" | "failed" | "unknown" | undefined
      for await (const observed of this.#adapter.observe(launch.session, launch.operation)) {
        if (!observed.ok) return { state: "failed", detail: observed.error.message }
        if (observed.value.type === "lifecycle") latest = observed.value.state
      }
      if (latest === "completed" || latest === "failed" || latest === "unknown") return { state: latest }

      const remaining = deadline - this.#clock()
      if (remaining <= 0) {
        await this.#adapter.terminate(launch.session, launch.operation)
        return { state: "timed_out" }
      }
      await this.#sleep(Math.min(this.#pollIntervalMs, remaining))
    }
  }

  async #buildResult(launch: ClaudeJobLaunch, state: TerminalState, detail: string | undefined): Promise<RuntimeJobResult> {
    const usage = this.#adapter.usageFor(launch.session.sessionId)
    const collected = await this.#adapter.collectResult(launch.session, launch.operation)
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
        summary = `Claude Code run exceeded its ${launch.timeoutSeconds}s timeout and was terminated.`
        break
    }
    if (!summary.includes("[claude]")) summary = `${summary}\n\n${usageLine}`

    return {
      summary,
      findings: permissionDenialFindings(usage?.permissionDenials ?? [], launch.job.trigger.capability),
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

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

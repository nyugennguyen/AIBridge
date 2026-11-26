import { spawn as defaultSpawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { digestDispatchEnvelope, digestJson } from "../orchestration/digest.js"
import { contractErrorSchema, type ContractError, type Result } from "../orchestration/errors.js"
import { DEFAULT_RUNTIME_PROBE_TIMEOUT_MS, DEFAULT_TERMINATION_GRACE_PERIOD_MS } from "./constants.js"
import { CLAUDE_PROVIDER_ENV_KEYS, isPathContained, redactSecretsFromText, sanitizeChildProcessEnv } from "./sanitizer.js"
import {
  adapterCapabilityReportSchema,
  agentInstallationSchema,
  agentResultSchema,
  agentRuntimeEventSchema,
  capabilityReportToRuntimeCapabilities,
  launchAgentRequestSchema,
  nodeContextSchema,
  promptRequestSchema,
  runtimeOperationContextSchema,
  runtimeSessionReferenceSchema,
  runtimeSessionSchema,
  type AgentInstallation,
  type AgentResponse,
  type AgentResult,
  type AgentRuntimeEvent,
  type LaunchAgentRequest,
  type NodeContext,
  type PromptRequest,
  type RuntimeOperationContext,
  type RuntimeSession,
  type RuntimeSessionReference,
} from "./schemas.js"
import type { Readable, Writable } from "node:stream"
import { LineStreamSplitter, safeParseJsonLine } from "./stream-parser.js"
import type { AgentRuntimeAdapter } from "./types.js"
import { RoleBinder } from "./binder.js"

export interface ProcessHandle {
  readonly pid?: number
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: "error", listener: (err: Error) => void): this
}

export type SpawnFunction = (
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: Record<string, string>
    stdio?: ("pipe" | "ignore" | "inherit")[]
    /** Leader of a new process group (and session) on POSIX. */
    detached?: boolean
  },
) => ProcessHandle

/** Values accepted by `claude --permission-mode` (CLI 2.1.x). */
export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions"

export const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
]

/** Values accepted by `claude --setting-sources`. */
export const CLAUDE_SETTING_SOURCES: readonly string[] = ["user", "project", "local"]

/**
 * Permission mode used when a launch does not name one. Claude Code print mode
 * has no way to ask the operator mid-run, so anything not pre-approved by an
 * allow rule must be denied rather than left to a version-dependent default.
 */
export const DEFAULT_CLAUDE_PERMISSION_MODE: ClaudePermissionMode = "dontAsk"

/**
 * Launch-time permission and isolation profile. Claude Code has no
 * permission request/response protocol on stdin, so everything the agent may
 * do is decided here, before the process starts, and translated into argv.
 */
export interface ClaudeLaunchProfile {
  /** `--permission-mode`. Defaults to `dontAsk`. `bypassPermissions` is refused. */
  readonly permissionMode?: ClaudePermissionMode
  /** `--allowedTools` rules, e.g. `"Read"`, `"Bash(git log *)"`. */
  readonly allowedTools?: readonly string[]
  /** `--disallowedTools` rules. A bare tool name removes the tool from context. */
  readonly disallowedTools?: readonly string[]
  /** `--max-budget-usd` (client-side estimate, includes subagents). */
  readonly maxBudgetUsd?: number
  /** `--max-turns`. */
  readonly maxTurns?: number
  /** `--setting-sources` (subset of user, project, local). */
  readonly settingSources?: readonly string[]
  /** `--settings <file>`. */
  readonly settingsPath?: string
  /** `--strict-mcp-config`: ignore every MCP config except `mcpConfigPath`. */
  readonly strictMcpConfig?: boolean
  /** `--mcp-config <file>`. */
  readonly mcpConfigPath?: string
  /** Appended after the RoleBinder-compiled prompt via `--append-system-prompt`. */
  readonly appendSystemPrompt?: string
}

/** A tool call Claude Code refused under the launch profile. */
export interface ClaudePermissionDenial {
  readonly toolName: string
  readonly toolUseId?: string
  readonly reason?: string
  /** Redacted, truncated JSON of the attempted tool input. */
  readonly inputPreview?: string
  /** `stream` = `system/permission_denied` event; `result` = `result.permission_denials`. */
  readonly source: "stream" | "result"
}

/** Structured run data taken from the stream; `agentResultSchema` only carries a summary. */
export interface ClaudeRunUsage {
  /** Claude Code's own session UUID (from `--session-id`, confirmed by `system/init`). */
  readonly providerSessionId: string
  readonly initialized: boolean
  readonly model?: string
  readonly resultSubtype?: string
  readonly isError?: boolean
  readonly totalCostUsd?: number
  readonly usage?: Record<string, unknown>
  readonly numTurns?: number
  readonly durationMs?: number
  readonly errors: readonly string[]
  readonly permissionDenials: readonly ClaudePermissionDenial[]
  readonly exitCode?: number | null
  readonly signal?: string | null
}

export interface ClaudeCodeRuntimeAdapterOptions {
  executablePath?: string
  nodeId?: string
  installationId?: string
  displayName?: string
  projects?: {
    resolve(scope: { projectId: string; projectPathId: string; nodeId: string }): Promise<Result<string>>
  }
  allowedProjectRoots?: string[]
  now?: () => string
  nextId?: (kind: "session" | "event") => string
  probeTimeoutMs?: number
  spawn?: SpawnFunction
  env?: Record<string, string | undefined>
  /**
   * Resolves the permission/isolation profile for a launch. Returning
   * `undefined` launches with only the default permission mode (`dontAsk`).
   */
  launchProfile?: (request: LaunchAgentRequest) => ClaudeLaunchProfile | undefined
  /**
   * Keep stdin open after a turn's `result` so `prompt()` can start further
   * turns. Off by default: single-shot jobs close stdin once every submitted
   * turn has produced a `result`, which is what makes the CLI exit.
   */
  keepStdinOpen?: boolean
  /** How long to wait for buffered stdout after `exit` before finalising. */
  exitDrainGraceMs?: number
  /**
   * Spawn Claude Code as the leader of its own process group (`detached`), so
   * `terminate` stops the tools and shells it started with it, and a bridge
   * restart can stop the whole group. Default: on with the real `spawn` on
   * POSIX; off on Windows and with an injected `spawn` (whose PIDs are not
   * real processes), unless set explicitly.
   */
  processGroup?: boolean
  /**
   * Told synchronously right after each Claude Code process is spawned;
   * returns the function called once the process has exited. The runner
   * records the process durably here (`FileRuntimeProcessRegistry`).
   */
  trackProcess?: (spawned: { readonly dispatchId: string; readonly pid: number; readonly processGroup: boolean }) => (() => void) | undefined
}

interface MutableRunUsage {
  providerSessionId: string
  initialized: boolean
  model?: string
  resultSubtype?: string
  isError?: boolean
  totalCostUsd?: number
  usage?: Record<string, unknown>
  numTurns?: number
  durationMs?: number
  errors: string[]
  permissionDenials: ClaudePermissionDenial[]
  exitCode?: number | null
  signal?: string | null
}

interface ClaudeActiveSession {
  readonly session: RuntimeSession
  readonly reference: RuntimeSessionReference
  readonly directory: string
  readonly process: ProcessHandle
  /** The process leads its own process group (pgid = pid). */
  readonly processGroup: boolean
  readonly splitter: LineStreamSplitter
  readonly bufferedEvents: AgentRuntimeEvent[]
  readonly usage: MutableRunUsage
  readonly keepStdinOpen: boolean
  collectedResult?: AgentResult
  /** Turns written to stdin that have not yet produced a `result`. */
  pendingTurns: number
  stdinClosed: boolean
  /** True once the process has exited and its stdout has been drained. */
  isExited: boolean
  exitRecorded: boolean
  stdoutEnded: boolean
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  spawnError?: string
  stderrTail: string
}

interface RecordedLaunch {
  readonly fingerprint: string
  readonly result: Promise<Result<RuntimeSession>>
}

interface RecordedPrompt {
  readonly fingerprint: string
  readonly result: Promise<Result<void>>
}

const MAX_DETAIL_LENGTH = 4000
const MAX_SUMMARY_LENGTH = 16_000
const MAX_STDERR_TAIL = 2048
const MAX_INPUT_PREVIEW = 240
const MAX_TOOL_RULE_LENGTH = 512
const DEFAULT_EXIT_DRAIN_GRACE_MS = 250

const CLAUDE_CAPABILITY_REPORT = adapterCapabilityReportSchema.parse({
  structuredPermissions: {
    status: "unsupported",
    evidenceSource: "user_config",
    detail:
      "Claude Code print mode has no permission request/response protocol. Permissions are fixed before launch by the launch profile (--permission-mode, --allowedTools, --disallowedTools); refused calls are reported via system/permission_denied and result.permission_denials.",
  },
  nativeSessionRestore: {
    status: "conditional",
    evidenceSource: "process_state",
    detail:
      "Only sessions still held by this adapter process can be restored. The provider UUID is kept in adapterMetadata.handle, but resuming with claude -r after a bridge restart is not implemented because the launch profile cannot be re-derived from a session reference.",
  },
  reliableCompletion: {
    status: "supported",
    evidenceSource: "hook",
    detail: "Final stream-json result event; succeeded only when subtype is success and is_error is false.",
  },
  modelSelection: { status: "supported", evidenceSource: "user_config", detail: "Configured via --model." },
  usageData: {
    status: "supported",
    evidenceSource: "hook",
    detail: "result event carries total_cost_usd, usage, num_turns and duration_ms; exposed via usageFor().",
  },
  hooks: { status: "supported", evidenceSource: "hook", detail: "Hook lifecycle events streamed via --include-hook-events." },
  transcriptExport: { status: "unsupported", evidenceSource: "terminal_manifest" },
})

export class ClaudeCodeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly kind = "claude"
  readonly capabilityReport = CLAUDE_CAPABILITY_REPORT
  readonly capabilities = capabilityReportToRuntimeCapabilities(CLAUDE_CAPABILITY_REPORT)

  readonly #executablePath: string
  readonly #nodeId: string
  readonly #installationId: string
  readonly #displayName: string
  readonly #projects?: {
    resolve(scope: { projectId: string; projectPathId: string; nodeId: string }): Promise<Result<string>>
  }
  readonly #allowedProjectRoots?: string[]
  readonly #now: () => string
  readonly #nextId: (kind: "session" | "event") => string
  readonly #spawn: SpawnFunction
  readonly #env: Record<string, string | undefined>
  readonly #probeTimeoutMs: number
  readonly #launchProfile?: (request: LaunchAgentRequest) => ClaudeLaunchProfile | undefined
  readonly #keepStdinOpen: boolean
  readonly #exitDrainGraceMs: number
  readonly #processGroup: boolean
  readonly #trackProcess?: ClaudeCodeRuntimeAdapterOptions["trackProcess"]

  readonly #sessions = new Map<string, ClaudeActiveSession>()
  readonly #launches = new Map<string, RecordedLaunch>()
  readonly #dispatches = new Map<string, string>()
  readonly #prompts = new Map<string, RecordedPrompt>()

  constructor(options: ClaudeCodeRuntimeAdapterOptions = {}) {
    this.#executablePath = options.executablePath ?? "claude"
    this.#nodeId = options.nodeId ?? "node-contract"
    this.#installationId = options.installationId ?? "installation-claude"
    this.#displayName = options.displayName ?? "Claude Code (CLI)"
    this.#projects = options.projects
    this.#allowedProjectRoots = options.allowedProjectRoots
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#nextId = options.nextId ?? ((kind) => `${kind}-${randomUUID()}`)
    this.#spawn = options.spawn ?? ((cmd, args, opts) => defaultSpawn(cmd, args, opts) as unknown as ProcessHandle)
    this.#env = options.env ?? process.env
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_RUNTIME_PROBE_TIMEOUT_MS
    this.#launchProfile = options.launchProfile
    this.#keepStdinOpen = options.keepStdinOpen ?? false
    this.#exitDrainGraceMs = options.exitDrainGraceMs ?? DEFAULT_EXIT_DRAIN_GRACE_MS
    this.#processGroup = options.processGroup ?? (options.spawn === undefined && process.platform !== "win32")
    this.#trackProcess = options.trackProcess
  }

  /**
   * Sends `signal` to the session's process group when it leads one (Claude
   * Code and every tool or shell it started), else to the process. Never
   * throws.
   */
  #signal(active: ClaudeActiveSession, signal: NodeJS.Signals, groupAfterExit = false): void {
    const pid = active.process.pid
    // Once the leader has exited, its group is signalled only by the
    // escalation `terminate` armed while the leader lived (a few seconds
    // later): the group id may otherwise be free, or reused, by now.
    if (active.processGroup && pid !== undefined && pid > 1 && (!active.exitRecorded || groupAfterExit)) {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // The group is gone (ESRCH), or this platform has none: the process alone.
      }
    }
    try {
      active.process.kill(signal)
    } catch {
      /* already gone */
    }
  }

  sessionReference(sessionId: string): RuntimeSessionReference | undefined {
    return this.#sessions.get(sessionId)?.reference
  }

  /** Cost, usage, turn count, provider session id and permission denials for a session. */
  usageFor(sessionId: string): ClaudeRunUsage | undefined {
    const active = this.#sessions.get(sessionId)
    if (!active) return undefined
    return {
      ...active.usage,
      errors: [...active.usage.errors],
      permissionDenials: [...active.usage.permissionDenials],
      ...(active.usage.usage ? { usage: { ...active.usage.usage } } : {}),
    }
  }

  /** Tool calls refused so far (available before the run finishes). */
  permissionDenialsFor(sessionId: string): readonly ClaudePermissionDenial[] {
    return [...(this.#sessions.get(sessionId)?.usage.permissionDenials ?? [])]
  }

  async detect(nodeContext: NodeContext): Promise<Result<AgentInstallation[]>> {
    const checked = nodeContextSchema.safeParse(nodeContext)
    if (!checked.success) {
      return failure("validation", "runtime.detect.invalid_node", "The node context is not valid.")
    }
    if (checked.data.nodeId !== this.#nodeId) {
      return failure("policy_denied", "runtime.detect.node_scope", "This runtime is not installed on the requested node.")
    }

    try {
      const probeResult = await this.#probeVersion()
      if (!probeResult.ok) {
        return success([])
      }
      return success([
        agentInstallationSchema.parse({
          schemaVersion: 1,
          installationId: this.#installationId,
          nodeId: this.#nodeId,
          runtimeKind: this.kind,
          displayName: this.#displayName,
          version: probeResult.version,
          executable: this.#executablePath,
          capabilities: this.capabilities,
          capabilityReport: this.capabilityReport,
        }),
      ])
    } catch {
      return success([])
    }
  }

  async launch(request: LaunchAgentRequest): Promise<Result<RuntimeSession>> {
    const checked = launchAgentRequestSchema.safeParse(request)
    if (!checked.success) {
      return failure("validation", "runtime.launch.invalid_request", "The launch request is not valid.", request.operation?.correlationId)
    }

    const scopeFailure = await this.#validateLaunchScope(checked.data)
    if (scopeFailure) return scopeFailure

    const fingerprint = digestJson(checked.data)
    const existing = this.#launches.get(checked.data.operation.commandId)
    if (existing) {
      return existing.fingerprint === fingerprint
        ? await existing.result
        : failure("conflict", "runtime.launch.command_conflict", "A command ID cannot be reused with different launch content.", checked.data.operation.correlationId)
    }

    const dispatchKey = this.#dispatchKey(checked.data)
    if (this.#dispatches.has(dispatchKey)) {
      return failure("conflict", "runtime.launch.dispatch_already_bound", "This dispatch already has a recorded launch attempt.", checked.data.operation.correlationId)
    }

    const result = this.#launchOnce(checked.data)
    this.#launches.set(checked.data.operation.commandId, { fingerprint, result })
    this.#dispatches.set(dispatchKey, checked.data.operation.commandId)
    return await result
  }

  /**
   * Restores a session that this adapter instance still holds in memory. It does
   * not resume via `claude -r <uuid>`: the launch profile that constrained the
   * original run cannot be re-derived from a reference, and resuming without it
   * would widen permissions. See `capabilityReport.nativeSessionRestore`.
   */
  async restore(
    reference: RuntimeSessionReference,
    operation: RuntimeOperationContext,
  ): Promise<Result<RuntimeSession>> {
    const parsedRef = runtimeSessionReferenceSchema.safeParse(reference)
    const parsedOp = runtimeOperationContextSchema.safeParse(operation)
    if (!parsedRef.success || !parsedOp.success) {
      return failure("validation", "runtime.restore.invalid_reference", "Invalid session reference or operation context.", operation?.correlationId)
    }

    const active = this.#sessions.get(parsedRef.data.sessionId)
    if (!active) {
      return failure("policy_denied", "runtime.restore.unknown_session", "Session not known to this adapter.", parsedOp.data.correlationId)
    }

    if (digestJson(parsedRef.data) !== digestJson(active.reference)) {
      return failure("policy_denied", "runtime.restore.reference_mismatch", "Reference does not match recorded session.", parsedOp.data.correlationId)
    }

    if (parsedOp.data.projectId !== active.session.projectId || parsedOp.data.nodeId !== this.#nodeId) {
      return failure("policy_denied", "runtime.restore.project_scope", "Operation scope does not match session.", parsedOp.data.correlationId)
    }

    return success(active.session)
  }

  async prompt(session: RuntimeSession, request: PromptRequest): Promise<Result<void>> {
    const parsedSession = runtimeSessionSchema.safeParse(session)
    const parsedRequest = promptRequestSchema.safeParse(request)
    if (!parsedSession.success || !parsedRequest.success) {
      return failure("validation", "runtime.prompt.invalid_request", "Invalid prompt request.", request.operation?.correlationId)
    }

    const active = this.#sessions.get(parsedSession.data.sessionId)
    if (!active) {
      return failure("policy_denied", "runtime.prompt.unknown_session", "Session not known to this adapter.", parsedRequest.data.operation.correlationId)
    }

    if (parsedRequest.data.operation.projectId !== active.session.projectId) {
      return failure("policy_denied", "runtime.prompt.project_scope", "Project scope mismatch.", parsedRequest.data.operation.correlationId)
    }

    const fingerprint = digestJson(parsedRequest.data)
    const existing = this.#prompts.get(parsedRequest.data.operation.commandId)
    if (existing) {
      return existing.fingerprint === fingerprint
        ? await existing.result
        : failure("conflict", "runtime.prompt.command_conflict", "Command ID reused with different prompt content.", parsedRequest.data.operation.correlationId)
    }

    const result = this.#deliverPrompt(active, parsedRequest.data.prompt, parsedRequest.data.operation.correlationId)
    this.#prompts.set(parsedRequest.data.operation.commandId, { fingerprint, result })
    return await result
  }

  /**
   * Snapshot observation, not a live stream. Each call drains the events
   * buffered since the previous call, then yields exactly one lifecycle event
   * describing the current state and returns:
   *
   * - process still running → `working`
   * - process exited (stdout drained) with a succeeded `result` → `completed`
   * - exited with a failed `result`, a non-zero exit code, a signal, or a spawn error → `failed`
   * - exited with code 0 but no `result` → `unknown`
   *
   * Callers (job monitors) are expected to poll until they see a terminal
   * state (`completed` / `failed` / `unknown`); repeated polls after exit keep
   * yielding that same terminal state.
   */
  async *observe(
    session: RuntimeSession,
    operation: RuntimeOperationContext,
  ): AsyncIterable<Result<AgentRuntimeEvent>> {
    const parsedSession = runtimeSessionSchema.safeParse(session)
    const parsedOp = runtimeOperationContextSchema.safeParse(operation)
    if (!parsedSession.success || !parsedOp.success) {
      yield failure("validation", "runtime.observe.invalid_request", "Invalid observation request.", operation?.correlationId)
      return
    }

    const active = this.#sessions.get(parsedSession.data.sessionId)
    if (!active) {
      yield failure("policy_denied", "runtime.observe.unknown_session", "Session not known to this adapter.", parsedOp.data.correlationId)
      return
    }

    while (active.bufferedEvents.length > 0) {
      const event = active.bufferedEvents.shift()
      if (event) yield success(event)
    }

    if (!active.isExited) {
      yield success(this.#createLifecycleEvent(active, "working", "Claude Code executing", "process_state", "observed"))
      return
    }

    const exitDescription = describeExit(active)
    const result = active.collectedResult
    if (result?.outcome === "succeeded") {
      yield success(this.#createLifecycleEvent(active, "completed", `Task completed (${exitDescription})`, "hook", "authoritative"))
    } else if (result?.outcome === "failed") {
      yield success(
        this.#createLifecycleEvent(active, "failed", `Claude Code reported ${active.usage.resultSubtype ?? "an error"} (${exitDescription})`, "hook", "authoritative"),
      )
    } else if (isCleanExit(active)) {
      yield success(this.#createLifecycleEvent(active, "unknown", "Process exited zero without verified completion result", "process_state", "observed"))
    } else {
      yield success(this.#createLifecycleEvent(active, "failed", this.#abnormalExitText(active), "process_state", "observed"))
    }
  }

  /**
   * Claude Code print mode has no permission request/response message; tool
   * permissions are fixed at launch by the profile. Always fails closed.
   */
  async respond(_session: RuntimeSession, response: AgentResponse): Promise<Result<void>> {
    return failure(
      "unsupported_capability",
      "runtime.claude.permissions_unsupported",
      "Claude Code print mode does not accept permission responses; permissions are decided by the launch profile.",
      response.operation?.correlationId,
    )
  }

  async interrupt(session: RuntimeSession, _operation: RuntimeOperationContext): Promise<Result<void>> {
    const active = this.#sessions.get(session.sessionId)
    if (!active) return success(undefined)
    try {
      active.process.kill("SIGINT")
      return success(undefined)
    } catch {
      return success(undefined)
    }
  }

  async terminate(session: RuntimeSession, _operation: RuntimeOperationContext): Promise<Result<void>> {
    const active = this.#sessions.get(session.sessionId)
    if (!active) return success(undefined)
    this.#closeStdin(active)
    const leaderAlive = !active.exitRecorded
    this.#signal(active, "SIGTERM")
    const timer = setTimeout(() => {
      // The group may outlive its leader by a few seconds (a tool ignoring
      // SIGTERM): it is killed as the script runner kills a script's group.
      if (!active.exitRecorded) this.#signal(active, "SIGKILL")
      else if (leaderAlive && active.processGroup) this.#signal(active, "SIGKILL", true)
    }, DEFAULT_TERMINATION_GRACE_PERIOD_MS)
    timer.unref?.()
    return success(undefined)
  }

  async collectResult(session: RuntimeSession, _operation: RuntimeOperationContext): Promise<Result<AgentResult>> {
    const active = this.#sessions.get(session.sessionId)
    if (!active) {
      return success({
        schemaVersion: 1,
        outcome: "unknown",
        summary: "Unknown session result",
      })
    }

    if (active.collectedResult) {
      return success(active.collectedResult)
    }

    if (!active.isExited) {
      return success({
        schemaVersion: 1,
        outcome: "unknown",
        summary: "Task is still working or result is undetermined",
      })
    }

    if (isCleanExit(active)) {
      return success({
        schemaVersion: 1,
        outcome: "unknown",
        summary: "Process exited zero without structured completion result",
      })
    }

    return success({
      schemaVersion: 1,
      outcome: "failed",
      summary: this.#abnormalExitText(active),
    })
  }

  async #probeVersion(): Promise<{ ok: boolean; version?: string }> {
    return new Promise((resolvePromise) => {
      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          try {
            child.kill("SIGKILL")
          } catch {
            /* ignore */
          }
          resolvePromise({ ok: false })
        }
      }, this.#probeTimeoutMs)

      let stdout = ""
      const child = this.#spawn(this.#executablePath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] })

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8")
      })

      child.on("exit", (code) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          if (code === 0 && stdout.trim().length > 0) {
            resolvePromise({ ok: true, version: stdout.trim() })
          } else {
            resolvePromise({ ok: false })
          }
        }
      })

      child.on("error", () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          resolvePromise({ ok: false })
        }
      })
    })
  }

  async #launchOnce(request: LaunchAgentRequest): Promise<Result<RuntimeSession>> {
    const correlationId = request.operation.correlationId

    let profile: ClaudeLaunchProfile | undefined
    try {
      profile = this.#launchProfile?.(request)
    } catch {
      return failure("internal_failure", "runtime.launch.profile_failed", "The launch profile could not be resolved.", correlationId)
    }
    if (profile) {
      const problem = validateClaudeLaunchProfile(profile)
      if (problem) {
        return failure(problem.category, problem.code, problem.message, correlationId)
      }
    }

    const dirResult = await this.#resolveDirectory(request)
    if (!dirResult.ok) return dirResult

    const directory = dirResult.value
    const providerSessionId = randomUUID()
    const session = runtimeSessionSchema.parse({
      schemaVersion: 1,
      sessionId: this.#nextId("session"),
      projectId: request.dispatchEnvelope.projectId,
      runId: request.dispatchEnvelope.runId,
      taskId: request.dispatchEnvelope.taskId,
      dispatchId: request.dispatchEnvelope.dispatchId,
      nodeId: this.#nodeId,
      installationId: this.#installationId,
      runtimeKind: this.kind,
      lifecycleState: "launching",
      observedState: "starting",
    })

    const reference = runtimeSessionReferenceSchema.parse({
      ...session,
      adapterMetadata: {
        handle: providerSessionId,
        projectPathId: request.dispatchEnvelope.projectPathId,
      },
    })

    const { systemPrompt } = RoleBinder.compileForClaude(request)
    const args = buildClaudeLaunchArgs({
      providerSessionId,
      ...(request.dispatchEnvelope.model ? { model: request.dispatchEnvelope.model } : {}),
      ...(systemPrompt ? { compiledSystemPrompt: systemPrompt } : {}),
      ...(profile ? { profile } : {}),
    })

    const sanitizedEnv = sanitizeChildProcessEnv(this.#env, CLAUDE_PROVIDER_ENV_KEYS)

    let child: ProcessHandle
    try {
      child = this.#spawn(this.#executablePath, args, {
        cwd: directory,
        env: sanitizedEnv,
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group: `terminate` (and a restart after a crash)
        // stops the tools and shells it started with it. Not `unref`ed: the
        // bridge stays alive while it runs.
        ...(this.#processGroup ? { detached: true } : {}),
      })
    } catch (err) {
      return failure("runtime_failure", "runtime.launch.spawn_failed", `Failed to spawn Claude process: ${this.#redact(String(err))}`, correlationId)
    }

    // Recorded in the same synchronous step as the spawn, before anything
    // else of this process runs, so a bridge killed from here on leaves a
    // record its successor can act on.
    let untrack: (() => void) | undefined
    if (child.pid !== undefined && this.#trackProcess !== undefined) {
      try {
        untrack = this.#trackProcess({ dispatchId: request.dispatchEnvelope.dispatchId, pid: child.pid, processGroup: this.#processGroup })
      } catch {
        untrack = undefined
      }
    }

    const splitter = new LineStreamSplitter({ stripAnsi: true })
    const active: ClaudeActiveSession = {
      session,
      reference,
      directory,
      process: child,
      processGroup: this.#processGroup,
      splitter,
      bufferedEvents: [],
      usage: { providerSessionId, initialized: false, errors: [], permissionDenials: [] },
      keepStdinOpen: this.#keepStdinOpen,
      pendingTurns: 0,
      stdinClosed: false,
      isExited: false,
      exitRecorded: false,
      stdoutEnded: child.stdout === null,
      stderrTail: "",
    }

    this.#sessions.set(session.sessionId, active)

    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of splitter.push(chunk.toString("utf8"))) {
        this.#handleStdoutLine(active, line)
      }
    })
    const onStdoutEnd = () => {
      active.stdoutEnded = true
      if (active.exitRecorded) this.#finalizeExit(active)
    }
    child.stdout?.on("end", onStdoutEnd)
    child.stdout?.on("close", onStdoutEnd)

    // Drain stderr so a chatty CLI cannot block on a full pipe; keep a short tail for diagnostics.
    child.stderr?.on("data", (chunk: Buffer) => {
      active.stderrTail = (active.stderrTail + chunk.toString("utf8")).slice(-MAX_STDERR_TAIL)
    })

    child.on("exit", (code, signal) => {
      untrack?.()
      if (active.exitRecorded) return
      active.exitRecorded = true
      active.exitCode = code
      active.signal = signal
      active.usage.exitCode = code
      active.usage.signal = signal
      if (active.stdoutEnded) {
        this.#finalizeExit(active)
      } else {
        // `exit` can fire before the final stdout chunk (the `result` line) is read.
        const timer = setTimeout(() => this.#finalizeExit(active), this.#exitDrainGraceMs)
        timer.unref?.()
      }
    })

    child.on("error", (err) => {
      active.spawnError = this.#redact(String(err))
      active.exitRecorded = true
      // observe() reports the terminal `failed` state (with this error) once finalised.
      this.#finalizeExit(active)
    })

    // A child that dies early turns stdin writes into EPIPE `error` events; never let them go unhandled.
    child.stdin?.on("error", () => {
      active.stdinClosed = true
    })

    // Initial turn. stdin stays open until that turn's `result` arrives; a write
    // failure surfaces through the process `error`/`exit` events.
    this.#writeUserTurn(active, request.dispatchEnvelope.prompt)

    return success(session)
  }

  #finalizeExit(active: ClaudeActiveSession): void {
    if (active.isExited) return
    for (const line of active.splitter.flush()) {
      this.#handleStdoutLine(active, line)
    }
    active.isExited = true
    active.stdinClosed = true
  }

  #handleStdoutLine(active: ClaudeActiveSession, line: string): void {
    const parsed = safeParseJsonLine<Record<string, unknown>>(line)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return

    switch (parsed.type) {
      case "system":
        this.#handleSystemEvent(active, parsed)
        return
      case "assistant":
      case "user":
        this.#handleMessageEvent(active, parsed)
        return
      case "result":
        this.#handleResultEvent(active, parsed)
        return
      default:
        return
    }
  }

  #handleSystemEvent(active: ClaudeActiveSession, event: Record<string, unknown>): void {
    const subtype = asString(event.subtype)
    if (subtype === "init") {
      active.usage.initialized = true
      const providerSessionId = asString(event.session_id)
      if (providerSessionId) active.usage.providerSessionId = providerSessionId
      const model = asString(event.model)
      if (model) active.usage.model = model
      const toolCount = Array.isArray(event.tools) ? event.tools.length : undefined
      const detail = [
        "Claude Code session initialised",
        model ? `model ${model}` : undefined,
        toolCount !== undefined ? `${toolCount} tools` : undefined,
      ]
        .filter(Boolean)
        .join(", ")
      active.bufferedEvents.push(this.#createLifecycleEvent(active, "working", detail, "hook", "authoritative"))
      return
    }

    if (subtype === "permission_denied") {
      const denial = this.#denialFrom(event, "stream")
      this.#recordDenial(active, denial)
      active.bufferedEvents.push(
        this.#createLifecycleEvent(
          active,
          "working",
          `Permission denied by launch profile: ${denial.toolName}${denial.reason ? ` (${denial.reason})` : ""}`,
          "hook",
          "authoritative",
        ),
      )
      return
    }

    active.bufferedEvents.push(
      this.#createLifecycleEvent(active, "working", subtype ? `Claude Code system event: ${subtype}` : undefined, "hook", "authoritative"),
    )
  }

  #handleMessageEvent(active: ClaudeActiveSession, event: Record<string, unknown>): void {
    const message = asRecord(event.message)
    const blocks = Array.isArray(message?.content) ? message.content.map(asRecord).filter((b) => b !== undefined) : []
    let detail: string
    if (event.type === "assistant") {
      const toolNames = blocks.filter((b) => b.type === "tool_use").map((b) => asString(b.name) ?? "unknown")
      detail = toolNames.length > 0 ? `Tool call: ${toolNames.join(", ")}` : "Assistant message"
    } else {
      const results = blocks.filter((b) => b.type === "tool_result")
      const errored = results.filter((b) => b.is_error === true).length
      detail = results.length > 0 ? `Tool result${results.length > 1 ? "s" : ""}: ${results.length}${errored ? ` (${errored} error)` : ""}` : "User message"
    }
    active.bufferedEvents.push(this.#createLifecycleEvent(active, "working", detail, "hook", "authoritative"))
  }

  #handleResultEvent(active: ClaudeActiveSession, event: Record<string, unknown>): void {
    const usage = active.usage
    const subtype = asString(event.subtype) ?? "unknown"
    const isError = event.is_error === true
    const succeeded = subtype === "success" && !isError

    usage.resultSubtype = subtype
    usage.isError = isError
    const cost = asFiniteNumber(event.total_cost_usd)
    if (cost !== undefined) usage.totalCostUsd = cost
    const numTurns = asFiniteNumber(event.num_turns)
    if (numTurns !== undefined) usage.numTurns = numTurns
    const durationMs = asFiniteNumber(event.duration_ms)
    if (durationMs !== undefined) usage.durationMs = durationMs
    const tokenUsage = asRecord(event.usage)
    if (tokenUsage) usage.usage = tokenUsage
    const providerSessionId = asString(event.session_id)
    if (providerSessionId) usage.providerSessionId = providerSessionId
    usage.errors = Array.isArray(event.errors)
      ? event.errors.map((e) => this.#redact(typeof e === "string" ? e : JSON.stringify(e))).filter((e) => e.trim().length > 0)
      : []
    if (Array.isArray(event.permission_denials)) {
      for (const raw of event.permission_denials) {
        const record = asRecord(raw)
        if (record) this.#recordDenial(active, this.#denialFrom(record, "result"))
      }
    }

    const resultText = typeof event.result === "string" ? event.result.trim() : ""
    const footer = this.#usageFooter(active)
    let body: string
    if (succeeded) {
      body = resultText.length > 0 ? resultText : "Claude Code completed without result text."
    } else {
      const reason = usage.errors.length > 0 ? usage.errors.join("; ") : resultText
      body = `Claude Code run failed (${subtype}${isError ? ", is_error" : ""})${reason ? `: ${reason}` : ""}`
    }
    const summary = truncate(this.#redact(body), MAX_SUMMARY_LENGTH - footer.length - 2) + "\n\n" + footer

    active.collectedResult = succeeded
      ? agentResultSchema.parse({
          schemaVersion: 1,
          outcome: "succeeded",
          summary,
          completionEvidence: { kind: "reliable_provider", mechanism: "claude_stream_result" },
        })
      : agentResultSchema.parse({ schemaVersion: 1, outcome: "failed", summary })

    active.bufferedEvents.push(
      agentRuntimeEventSchema.parse({
        ...this.#eventScope(active),
        type: "result_available",
        result: active.collectedResult,
      }),
    )

    active.pendingTurns = Math.max(0, active.pendingTurns - 1)
    if (active.pendingTurns === 0 && !active.keepStdinOpen) {
      this.#closeStdin(active)
    }
  }

  #usageFooter(active: ClaudeActiveSession): string {
    const u = active.usage
    const denials = u.permissionDenials
    const parts = [
      `subtype=${u.resultSubtype ?? "unknown"}`,
      u.numTurns !== undefined ? `turns=${u.numTurns}` : undefined,
      u.totalCostUsd !== undefined ? `cost_usd=${u.totalCostUsd}` : undefined,
      u.durationMs !== undefined ? `duration_ms=${u.durationMs}` : undefined,
      `session=${u.providerSessionId}`,
      `permission_denials=${denials.length}${denials.length > 0 ? ` (${[...new Set(denials.map((d) => d.toolName))].join(", ")})` : ""}`,
    ]
    return `[claude] ${parts.filter(Boolean).join(" ")}`
  }

  #denialFrom(record: Record<string, unknown>, source: "stream" | "result"): ClaudePermissionDenial {
    const toolName = asString(record.tool_name) ?? asString(record.toolName) ?? asString(record.tool) ?? "unknown"
    const toolUseId = asString(record.tool_use_id) ?? asString(record.toolUseId)
    const reason = asString(record.reason) ?? asString(record.message) ?? asString(record.decision_reason)
    const input = record.tool_input ?? record.input
    let inputPreview: string | undefined
    if (input !== undefined) {
      try {
        inputPreview = truncate(this.#redact(JSON.stringify(input)), MAX_INPUT_PREVIEW)
      } catch {
        inputPreview = undefined
      }
    }
    return {
      toolName,
      ...(toolUseId ? { toolUseId } : {}),
      ...(reason ? { reason: truncate(this.#redact(reason), MAX_INPUT_PREVIEW) } : {}),
      ...(inputPreview ? { inputPreview } : {}),
      source,
    }
  }

  #recordDenial(active: ClaudeActiveSession, denial: ClaudePermissionDenial): void {
    const denials = active.usage.permissionDenials
    if (denial.toolUseId) {
      const index = denials.findIndex((d) => d.toolUseId === denial.toolUseId)
      if (index !== -1) {
        // Keep the first sighting, filling in fields the later one adds.
        denials[index] = { ...denial, ...denials[index] }
        return
      }
    }
    denials.push(denial)
  }

  async #deliverPrompt(active: ClaudeActiveSession, promptText: string, correlationId?: string): Promise<Result<void>> {
    if (active.stdinClosed || active.isExited) {
      return failure(
        "runtime_failure",
        "runtime.prompt.closed",
        "Process stdin is closed; single-shot Claude sessions close stdin after the result (set keepStdinOpen for multi-turn).",
        correlationId,
      )
    }
    return this.#writeUserTurn(active, promptText)
      ? success(undefined)
      : failure("runtime_failure", "runtime.prompt.failed", "Failed to deliver prompt to Claude process.", correlationId)
  }

  #writeUserTurn(active: ClaudeActiveSession, text: string): boolean {
    const stdin = active.process.stdin
    if (!stdin || stdin.destroyed || active.stdinClosed) return false
    try {
      stdin.write(encodeClaudeUserTurn(text))
      active.pendingTurns += 1
      return true
    } catch {
      return false
    }
  }

  #closeStdin(active: ClaudeActiveSession): void {
    if (active.stdinClosed) return
    active.stdinClosed = true
    const stdin = active.process.stdin
    if (!stdin || stdin.destroyed) return
    try {
      stdin.end()
    } catch {
      /* ignore */
    }
  }

  #abnormalExitText(active: ClaudeActiveSession): string {
    const stderr = active.stderrTail.trim()
    const base = active.spawnError ? `Claude process failed: ${active.spawnError}` : `Process ${describeExit(active)}`
    return truncate(this.#redact(stderr ? `${base}; stderr: ${stderr}` : base), MAX_DETAIL_LENGTH)
  }

  #redact(text: string): string {
    const known = CLAUDE_PROVIDER_ENV_KEYS.map((key) => this.#env[key]).filter((v): v is string => typeof v === "string")
    return redactSecretsFromText(text, known)
  }

  async #resolveDirectory(request: LaunchAgentRequest): Promise<Result<string>> {
    if (this.#projects) {
      const resolved = await this.#projects.resolve({
        projectId: request.dispatchEnvelope.projectId,
        projectPathId: request.dispatchEnvelope.projectPathId,
        nodeId: this.#nodeId,
      })
      if (!resolved.ok) return resolved
      return resolved
    }

    if (this.#allowedProjectRoots && this.#allowedProjectRoots.length > 0) {
      const target = request.dispatchEnvelope.projectPathId
      const isContained = this.#allowedProjectRoots.some((root) => isPathContained(target, root))
      if (!isContained) {
        return failure("policy_denied", "runtime.launch.project_scope", "Directory is outside allowed project roots.")
      }
      return success(target)
    }

    return success("/workspace/contract")
  }

  async #validateLaunchScope(request: LaunchAgentRequest): Promise<Result<never> | undefined> {
    const { dispatchEnvelope: envelope, operation } = request

    if (operation.nodeId !== this.#nodeId || envelope.targetNodeId !== this.#nodeId) {
      return failure("policy_denied", "runtime.launch.node_scope", "The launch request is outside this runtime's node scope.", operation.correlationId)
    }

    if (envelope.installationId !== this.#installationId || envelope.runtimeKind !== this.kind) {
      return failure("unsupported_capability", "runtime.launch.installation", "The requested installation is not available.", operation.correlationId)
    }

    if (request.dispatchEnvelopeDigest !== digestDispatchEnvelope(envelope)) {
      return failure("validation", "runtime.launch.envelope_digest", "The dispatch envelope digest does not match its canonical content.", operation.correlationId)
    }

    return undefined
  }

  #createLifecycleEvent(
    active: ClaudeActiveSession,
    state: "starting" | "idle" | "working" | "blocked" | "completed" | "failed" | "unknown",
    detail?: string,
    source: "hook" | "process_state" | "polling" = "hook",
    confidence: "authoritative" | "observed" | "inferred" | "tentative" = "authoritative",
  ): AgentRuntimeEvent {
    const boundedDetail = detail?.trim() ? truncate(detail, MAX_DETAIL_LENGTH) : undefined
    return agentRuntimeEventSchema.parse({
      ...this.#eventScope(active),
      type: "lifecycle",
      state,
      source,
      confidence,
      ...(boundedDetail ? { detail: boundedDetail } : {}),
    })
  }

  #eventScope(active: ClaudeActiveSession) {
    return {
      schemaVersion: 1 as const,
      eventId: this.#nextId("event"),
      projectId: active.session.projectId,
      runId: active.session.runId,
      taskId: active.session.taskId,
      dispatchId: active.session.dispatchId,
      sessionId: active.session.sessionId,
      nodeId: active.session.nodeId,
      occurredAt: this.#now(),
    }
  }

  #dispatchKey(request: LaunchAgentRequest): string {
    const { projectId, runId, dispatchId } = request.dispatchEnvelope
    return digestJson({ projectId, runId, dispatchId })
  }
}

/** One stream-json user turn, newline-terminated, as Claude Code reads it on stdin. */
export function encodeClaudeUserTurn(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }) + "\n"
}

export interface ClaudeLaunchArgsInput {
  readonly providerSessionId: string
  readonly model?: string
  /** RoleBinder output; appended to Claude Code's default system prompt. */
  readonly compiledSystemPrompt?: string
  readonly profile?: ClaudeLaunchProfile
}

/**
 * Pure argv builder. Assumes the profile already passed
 * `validateClaudeLaunchProfile`. Variadic tool-rule flags are always followed
 * by another `--flag` or end of argv, so the rules cannot swallow later values.
 */
export function buildClaudeLaunchArgs(input: ClaudeLaunchArgsInput): string[] {
  const profile = input.profile ?? {}
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--include-hook-events",
    "--session-id",
    input.providerSessionId,
  ]

  if (input.model) args.push("--model", input.model)

  args.push("--permission-mode", profile.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE)
  if (profile.allowedTools && profile.allowedTools.length > 0) args.push("--allowedTools", ...profile.allowedTools)
  if (profile.disallowedTools && profile.disallowedTools.length > 0) args.push("--disallowedTools", ...profile.disallowedTools)
  if (profile.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(profile.maxBudgetUsd))
  if (profile.maxTurns !== undefined) args.push("--max-turns", String(profile.maxTurns))
  if (profile.settingSources !== undefined) args.push("--setting-sources", profile.settingSources.join(","))
  if (profile.settingsPath) args.push("--settings", profile.settingsPath)
  if (profile.strictMcpConfig) args.push("--strict-mcp-config")
  if (profile.mcpConfigPath) args.push("--mcp-config", profile.mcpConfigPath)

  const appended = [input.compiledSystemPrompt, profile.appendSystemPrompt]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n\n")
  if (appended) args.push("--append-system-prompt", appended)

  return args
}

export interface ClaudeLaunchProfileProblem {
  readonly category: "validation" | "policy_denied"
  readonly code: string
  readonly message: string
}

/** Returns the first problem with a launch profile, or `undefined` when it is usable. */
export function validateClaudeLaunchProfile(profile: ClaudeLaunchProfile): ClaudeLaunchProfileProblem | undefined {
  const invalid = (message: string): ClaudeLaunchProfileProblem => ({ category: "validation", code: "runtime.launch.invalid_profile", message })

  if (profile.permissionMode !== undefined) {
    if (!CLAUDE_PERMISSION_MODES.includes(profile.permissionMode)) {
      return invalid(`Unknown Claude permission mode: ${String(profile.permissionMode)}.`)
    }
    if (profile.permissionMode === "bypassPermissions") {
      return {
        category: "policy_denied",
        code: "runtime.launch.permission_bypass_denied",
        message: "Launch profiles may not use bypassPermissions; it disables every permission check.",
      }
    }
  }

  for (const [name, rules] of [
    ["allowedTools", profile.allowedTools],
    ["disallowedTools", profile.disallowedTools],
  ] as const) {
    if (rules === undefined) continue
    if (!Array.isArray(rules)) return invalid(`${name} must be an array of tool rules.`)
    for (const rule of rules) {
      if (typeof rule !== "string" || rule.trim().length === 0 || rule !== rule.trim()) {
        return invalid(`${name} contains an empty or padded rule.`)
      }
      if (rule.startsWith("-")) return invalid(`${name} rule must not start with '-': ${rule}`)
      if (rule.length > MAX_TOOL_RULE_LENGTH || hasControlCharacters(rule)) {
        return invalid(`${name} rule is too long or contains control characters.`)
      }
    }
  }

  if (profile.maxBudgetUsd !== undefined && !(Number.isFinite(profile.maxBudgetUsd) && profile.maxBudgetUsd > 0)) {
    return invalid("maxBudgetUsd must be a positive finite number.")
  }
  if (profile.maxTurns !== undefined && !(Number.isInteger(profile.maxTurns) && profile.maxTurns >= 1)) {
    return invalid("maxTurns must be a positive integer.")
  }
  if (profile.settingSources !== undefined) {
    if (!Array.isArray(profile.settingSources)) return invalid("settingSources must be an array.")
    for (const source of profile.settingSources) {
      if (!CLAUDE_SETTING_SOURCES.includes(source)) return invalid(`Unknown setting source: ${String(source)}.`)
    }
  }
  for (const [name, value] of [
    ["settingsPath", profile.settingsPath],
    ["mcpConfigPath", profile.mcpConfigPath],
  ] as const) {
    if (value === undefined) continue
    if (typeof value !== "string" || value.trim().length === 0 || value.startsWith("-") || hasControlCharacters(value)) {
      return invalid(`${name} must be a non-empty path.`)
    }
  }
  if (profile.strictMcpConfig !== undefined && typeof profile.strictMcpConfig !== "boolean") {
    return invalid("strictMcpConfig must be a boolean.")
  }
  if (profile.appendSystemPrompt !== undefined && typeof profile.appendSystemPrompt !== "string") {
    return invalid("appendSystemPrompt must be a string.")
  }
  return undefined
}

function isCleanExit(active: ClaudeActiveSession): boolean {
  return !active.spawnError && active.exitCode === 0 && !active.signal
}

function describeExit(active: ClaudeActiveSession): string {
  if (active.spawnError) return "failed to start"
  if (active.signal) return `terminated by signal ${active.signal}`
  if (active.exitCode === null || active.exitCode === undefined) return "exited without an exit code"
  return `exited with code ${active.exitCode}`
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)) + "…"
}

function failure(category: ContractError["category"], code: string, message: string, correlationId?: string): Result<never> {
  return {
    ok: false,
    error: contractErrorSchema.parse({
      schemaVersion: 1,
      category,
      code,
      message,
      retryable: category === "transient_transport" || category === "timeout" || category === "runtime_failure" || category === "internal_failure",
      ...(correlationId ? { correlationId } : {}),
    }),
  }
}

function success<T>(value: T): Result<T> {
  return { ok: true, value }
}

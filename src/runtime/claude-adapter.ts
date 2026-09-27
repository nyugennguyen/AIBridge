import { spawn as defaultSpawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { digestDispatchEnvelope, digestJson } from "../orchestration/digest.js"
import { contractErrorSchema, type ContractError, type Result } from "../orchestration/errors.js"
import { DEFAULT_RUNTIME_PROBE_TIMEOUT_MS, DEFAULT_TERMINATION_GRACE_PERIOD_MS } from "./constants.js"
import { isPathContained, redactSecretsFromText, sanitizeChildProcessEnv } from "./sanitizer.js"
import {
  adapterCapabilityReportSchema,
  agentInstallationSchema,
  agentResultSchema,
  agentRuntimeEventSchema,
  launchAgentRequestSchema,
  nodeContextSchema,
  promptRequestSchema,
  runtimeCapabilitiesSchema,
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
  },
) => ProcessHandle

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
}

interface ClaudeActiveSession {
  readonly session: RuntimeSession
  readonly reference: RuntimeSessionReference
  readonly directory: string
  readonly process: ProcessHandle
  readonly splitter: LineStreamSplitter
  readonly bufferedEvents: AgentRuntimeEvent[]
  collectedResult?: AgentResult
  isExited: boolean
  exitCode?: number
}

interface RecordedLaunch {
  readonly fingerprint: string
  readonly result: Promise<Result<RuntimeSession>>
}

interface RecordedPrompt {
  readonly fingerprint: string
  readonly result: Promise<Result<void>>
}

export class ClaudeCodeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly kind = "claude"
  readonly capabilities = runtimeCapabilitiesSchema.parse({
    structuredPermissions: false,
    nativeSessionRestore: true,
    reliableCompletion: true,
    modelSelection: true,
    usageData: true,
    hooks: true,
    transcriptExport: false,
  })
  readonly capabilityReport = adapterCapabilityReportSchema.parse({
    structuredPermissions: { status: "conditional", evidenceSource: "hook", detail: "Supported via bidirectional stdin in print mode" },
    nativeSessionRestore: { status: "supported", evidenceSource: "process_state" },
    reliableCompletion: { status: "supported", evidenceSource: "hook" },
    modelSelection: { status: "supported", evidenceSource: "user_config" },
    usageData: { status: "supported", evidenceSource: "hook" },
    hooks: { status: "supported", evidenceSource: "hook" },
    transcriptExport: { status: "unsupported", evidenceSource: "terminal_manifest" },
  })

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
  }

  sessionReference(sessionId: string): RuntimeSessionReference | undefined {
    return this.#sessions.get(sessionId)?.reference
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

    const result = this.#deliverPrompt(active, parsedRequest.data.prompt)
    this.#prompts.set(parsedRequest.data.operation.commandId, { fingerprint, result })
    return await result
  }

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

    if (active.isExited) {
      if (active.exitCode === 0 && active.collectedResult) {
        yield success(this.#createLifecycleEvent(active, "completed", "Task completed cleanly", "hook", "authoritative"))
      } else if (active.exitCode === 0) {
        yield success(this.#createLifecycleEvent(active, "unknown", "Process exited zero without verified completion result", "process_state", "observed"))
      } else {
        yield success(this.#createLifecycleEvent(active, "failed", `Process exited with code ${active.exitCode}`, "process_state", "observed"))
      }
    } else {
      yield success(this.#createLifecycleEvent(active, "working", "Claude Code executing", "hook", "authoritative"))
    }
  }

  async respond(session: RuntimeSession, response: AgentResponse): Promise<Result<void>> {
    const active = this.#sessions.get(session.sessionId)
    if (!active) {
      return failure("policy_denied", "runtime.respond.unknown_session", "Session not known to this adapter.", response.operation.correlationId)
    }

    if (active.process.stdin && !active.process.stdin.destroyed) {
      try {
        const payload = JSON.stringify({
          type: "permission_response",
          request_id: response.responseId,
          decision: response.value,
        }) + "\n"
        active.process.stdin.write(payload)
        return success(undefined)
      } catch {
        return failure("runtime_failure", "runtime.respond.failed", "Failed to write permission response to stdin.", response.operation.correlationId)
      }
    }
    return failure("runtime_failure", "runtime.respond.closed", "Process stdin is closed.", response.operation.correlationId)
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
    try {
      active.process.kill("SIGTERM")
      setTimeout(() => {
        if (!active.isExited) {
          try {
            active.process.kill("SIGKILL")
          } catch {
            /* ignore */
          }
        }
      }, DEFAULT_TERMINATION_GRACE_PERIOD_MS)
      return success(undefined)
    } catch {
      return success(undefined)
    }
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

    if (active.isExited && active.exitCode === 0) {
      return success({
        schemaVersion: 1,
        outcome: "unknown",
        summary: "Process exited zero without structured completion result",
      })
    }

    if (active.isExited && active.exitCode !== 0) {
      return success({
        schemaVersion: 1,
        outcome: "failed",
        summary: `Process terminated with exit code ${active.exitCode}`,
      })
    }

    return success({
      schemaVersion: 1,
      outcome: "unknown",
      summary: "Task is still working or result is undetermined",
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
      state: "starting",
    })

    const reference = runtimeSessionReferenceSchema.parse({
      ...session,
      adapterMetadata: {
        handle: providerSessionId,
        projectPathId: request.dispatchEnvelope.projectPathId,
      },
    })

    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-hook-events",
      "--session-id",
      providerSessionId,
    ]

    if (request.dispatchEnvelope.model) {
      args.push("--model", request.dispatchEnvelope.model)
    }

    if (request.dispatchEnvelope.roleSnapshot.instructions) {
      args.push("--system-prompt", request.dispatchEnvelope.roleSnapshot.instructions)
    }

    const sanitizedEnv = sanitizeChildProcessEnv(this.#env, ["ANTHROPIC_API_KEY"])

    let child: ProcessHandle
    try {
      child = this.#spawn(this.#executablePath, args, {
        cwd: directory,
        env: sanitizedEnv,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (err) {
      return failure("runtime_failure", "runtime.launch.spawn_failed", `Failed to spawn Claude process: ${String(err)}`, request.operation.correlationId)
    }

    const splitter = new LineStreamSplitter({ stripAnsi: true })
    const active: ClaudeActiveSession = {
      session,
      reference,
      directory,
      process: child,
      splitter,
      bufferedEvents: [],
      isExited: false,
    }

    this.#sessions.set(session.sessionId, active)

    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = splitter.push(chunk.toString("utf8"))
      for (const line of lines) {
        this.#handleStdoutLine(active, line)
      }
    })

    child.on("exit", (code) => {
      active.isExited = true
      active.exitCode = code ?? 0
    })

    child.on("error", (err) => {
      active.isExited = true
      active.exitCode = 1
      active.bufferedEvents.push(
        this.#createLifecycleEvent(active, "failed", redactSecretsFromText(String(err)), "process_state", "observed"),
      )
    })

    // Write initial prompt to stdin
    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(JSON.stringify({ type: "user_message", message: request.dispatchEnvelope.prompt }) + "\n")
      }
    } catch {
      // stdin failure will be captured on error
    }

    return success(session)
  }

  #handleStdoutLine(active: ClaudeActiveSession, line: string): void {
    const parsed = safeParseJsonLine<Record<string, unknown>>(line)
    if (!parsed) return

    const type = parsed.type
    if (type === "system" || type === "progress") {
      active.bufferedEvents.push(
        this.#createLifecycleEvent(active, "working", typeof parsed.message === "string" ? parsed.message : undefined, "hook", "authoritative"),
      )
    } else if (type === "permission_request") {
      const requestId = typeof parsed.request_id === "string" ? parsed.request_id : randomUUID()
      active.bufferedEvents.push(
        agentRuntimeEventSchema.parse({
          ...this.#eventScope(active),
          type: "permission_requested",
          permission: typeof parsed.permission === "string" ? parsed.permission : "Claude requests permission",
          requestId,
        }),
      )
    } else if (type === "result") {
      const outcome = parsed.outcome === "success" ? "succeeded" : "failed"
      const summary = typeof parsed.summary === "string" ? parsed.summary : "Claude Code completed"
      active.collectedResult = agentResultSchema.parse({
        schemaVersion: 1,
        outcome,
        summary,
        ...(outcome === "succeeded"
          ? { completionEvidence: { kind: "reliable_provider", mechanism: "claude_stream_result" } }
          : {}),
      })
      active.bufferedEvents.push(
        agentRuntimeEventSchema.parse({
          ...this.#eventScope(active),
          type: "result_available",
          result: active.collectedResult,
        }),
      )
    }
  }

  async #deliverPrompt(active: ClaudeActiveSession, promptText: string): Promise<Result<void>> {
    if (active.process.stdin && !active.process.stdin.destroyed) {
      try {
        active.process.stdin.write(JSON.stringify({ type: "user_message", message: promptText }) + "\n")
        return success(undefined)
      } catch {
        return failure("runtime_failure", "runtime.prompt.failed", "Failed to deliver prompt to Claude process.")
      }
    }
    return failure("runtime_failure", "runtime.prompt.closed", "Process stdin is closed.")
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
    return agentRuntimeEventSchema.parse({
      ...this.#eventScope(active),
      type: "lifecycle",
      state,
      source,
      confidence,
      ...(detail ? { detail } : {}),
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

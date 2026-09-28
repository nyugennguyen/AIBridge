import { spawn as defaultSpawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"
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
  type AdapterCapabilityReport,
  type AgentInstallation,
  type AgentResponse,
  type AgentResult,
  type AgentRuntimeEvent,
  type LaunchAgentRequest,
  type NodeContext,
  type PromptRequest,
  type RuntimeCapabilities,
  type RuntimeOperationContext,
  type RuntimeSession,
  type RuntimeSessionReference,
} from "./schemas.js"
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

export interface CodexRuntimeAdapterOptions {
  executablePath?: string
  nodeId: string
  installationId: string
  displayName?: string
  probeTimeoutMs?: number
  env?: NodeJS.ProcessEnv
  projects: {
    resolve(scope: { projectId: string; projectPathId: string; nodeId: string }): Promise<Result<string>>
  }
  spawn?: SpawnFunction
  now?: () => string
  nextId?: (kind: string) => string
}

interface CodexActiveSession {
  session: RuntimeSession
  reference: RuntimeSessionReference
  process: ProcessHandle
  directory: string
  bufferedEvents: AgentRuntimeEvent[]
  collectedResult?: AgentResult
  isExited: boolean
  exitCode: number | null
}

export class CodexRuntimeAdapter implements AgentRuntimeAdapter {
  readonly kind = "codex" as const
  readonly displayName: string
  readonly capabilities: RuntimeCapabilities = runtimeCapabilitiesSchema.parse({
    structuredPermissions: false,
    nativeSessionRestore: true,
    reliableCompletion: true,
    modelSelection: true,
    usageData: true,
    hooks: false,
    transcriptExport: false,
  })

  readonly capabilityReport: AdapterCapabilityReport = adapterCapabilityReportSchema.parse({
    structuredPermissions: {
      status: "unsupported",
      evidenceSource: "user_config",
      detail: "Interactive bidirectional permissions not supported in headless exec mode.",
    },
    nativeSessionRestore: {
      status: "supported",
      evidenceSource: "process_state",
      detail: "Resumed via codex exec resume <handle>.",
    },
    reliableCompletion: {
      status: "supported",
      evidenceSource: "hook",
      detail: "Emits structured JSONL event stream.",
    },
    modelSelection: {
      status: "supported",
      evidenceSource: "user_config",
      detail: "Configured via -m, --model <MODEL>.",
    },
    usageData: {
      status: "supported",
      evidenceSource: "hook",
      detail: "Emitted in execution event stream.",
    },
    hooks: {
      status: "unsupported",
      evidenceSource: "process_state",
      detail: "Uses stdout JSONL streaming rather than external hooks.",
    },
    transcriptExport: {
      status: "unsupported",
      evidenceSource: "terminal_manifest",
      detail: "Fallback to bounded terminal capture.",
    },
  })

  readonly #executablePath: string
  readonly #nodeId: string
  readonly #installationId: string
  readonly #probeTimeoutMs: number
  readonly #env: NodeJS.ProcessEnv
  readonly #projects: CodexRuntimeAdapterOptions["projects"]
  readonly #spawn: SpawnFunction
  readonly #now: () => string
  readonly #nextId: (kind: string) => string

  readonly #sessions = new Map<string, CodexActiveSession>()
  readonly #launches = new Map<string, { fingerprint: string; result: Promise<Result<RuntimeSession>> }>()
  readonly #prompts = new Map<string, { fingerprint: string; result: Promise<Result<void>> }>()
  readonly #dispatches = new Map<string, string>()

  constructor(options: CodexRuntimeAdapterOptions) {
    this.#executablePath = options.executablePath ?? "codex"
    this.#nodeId = options.nodeId
    this.#installationId = options.installationId
    this.displayName = options.displayName ?? "Codex CLI"
    this.#projects = options.projects
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
          displayName: this.displayName,
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
      yield success(this.#createLifecycleEvent(active, "working", "Codex CLI executing", "hook", "authoritative"))
    }
  }

  async respond(_session: RuntimeSession, response: AgentResponse): Promise<Result<void>> {
    return failure(
      "unsupported_capability",
      "runtime.codex.permissions_unsupported",
      "Codex CLI exec mode does not support interactive permission responses.",
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
      const child = this.#spawn(this.#executablePath, ["-V"], { stdio: ["ignore", "pipe", "pipe"] })

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

    const args = ["exec", "--json", "-C", directory]

    if (!existsSync(join(directory, ".git"))) {
      args.push("--skip-git-repo-check")
    }

    const canWrite = request.dispatchEnvelope.permissionEnvelope.allowedCapabilities.includes("filesystem.write")
    args.push("-s", canWrite ? "workspace-write" : "read-only")

    if (request.dispatchEnvelope.model) {
      args.push("-m", request.dispatchEnvelope.model)
    }

    args.push(request.dispatchEnvelope.prompt)

    const sanitizedEnv = sanitizeChildProcessEnv(this.#env, ["OPENAI_API_KEY"])

    let child: ProcessHandle
    try {
      child = this.#spawn(this.#executablePath, args, {
        cwd: directory,
        env: sanitizedEnv,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (err) {
      return failure("runtime_failure", "runtime.launch.spawn_failed", `Failed to spawn Codex CLI: ${String(err)}`, request.operation.correlationId)
    }

    const active: CodexActiveSession = {
      session,
      reference,
      process: child,
      directory,
      bufferedEvents: [],
      isExited: false,
      exitCode: null,
    }

    this.#sessions.set(session.sessionId, active)

    active.bufferedEvents.push(this.#createLifecycleEvent(active, "starting", "Codex CLI process spawned", "hook", "authoritative"))

    this.#wireProcessStreams(active)

    return success(session)
  }

  #wireProcessStreams(active: CodexActiveSession): void {
    const splitter = new LineStreamSplitter({ stripAnsi: true })

    active.process.stdout?.on("data", (chunk: Buffer) => {
      const lines = splitter.push(chunk.toString("utf8"))
      for (const line of lines) {
        this.#handleOutputLine(active, line)
      }
    })

    active.process.stdout?.on("end", () => {
      const lines = splitter.flush()
      for (const line of lines) {
        this.#handleOutputLine(active, line)
      }
    })

    active.process.stderr?.on("data", (_chunk: Buffer) => {
      // Stderr is captured if process diagnostic logging is active
    })

    active.process.on("exit", (code) => {
      active.isExited = true
      active.exitCode = code
    })
  }

  #handleOutputLine(active: CodexActiveSession, line: string): void {
    const event = safeParseJsonLine<Record<string, unknown>>(line)
    if (!event) {
      return
    }

    const eventType = typeof event.type === "string" ? event.type : ""

    if (eventType === "thread.created" || eventType === "session.created") {
      const handle = typeof event.thread_id === "string" ? event.thread_id : typeof event.session_id === "string" ? event.session_id : undefined
      if (handle) {
        active.reference = runtimeSessionReferenceSchema.parse({
          ...active.reference,
          adapterMetadata: {
            ...active.reference.adapterMetadata,
            handle,
          },
        })
      }
      active.bufferedEvents.push(
        this.#createLifecycleEvent(active, "working", "Codex thread initialized", "hook", "authoritative"),
      )
      return
    }

    if (eventType === "turn.completed" || eventType === "result") {
      const isSuccess = event.status !== "failed" && event.outcome !== "failed"
      const outcome = isSuccess ? "succeeded" : "failed"
      const summary = typeof event.summary === "string" ? event.summary : typeof event.message === "string" ? event.message : "Task execution completed"
      active.collectedResult = agentResultSchema.parse({
        schemaVersion: 1,
        outcome,
        summary,
        ...(outcome === "succeeded"
          ? { completionEvidence: { kind: "reliable_provider", mechanism: "codex_stream_result" } }
          : {}),
      })
      active.bufferedEvents.push(
        agentRuntimeEventSchema.parse({
          ...this.#eventScope(active),
          type: "result_available",
          result: active.collectedResult,
        }),
      )
      return
    }

    active.bufferedEvents.push(
      this.#createLifecycleEvent(active, "working", `Codex event: ${eventType || "processing"}`, "hook", "authoritative"),
    )
  }

  async #deliverPrompt(active: CodexActiveSession, promptText: string): Promise<Result<void>> {
    if (active.process.stdin && !active.process.stdin.destroyed && !active.isExited) {
      try {
        active.process.stdin.write(promptText + "\n")
        return success(undefined)
      } catch {
        return failure("runtime_failure", "runtime.prompt.failed", "Failed to write prompt to Codex stdin.")
      }
    }

    const args = ["exec", "resume", "--json"]
    if (!existsSync(join(active.directory, ".git"))) {
      args.push("--skip-git-repo-check")
    }
    args.push(active.reference.adapterMetadata.handle, promptText)

    try {
      const resumedChild = this.#spawn(this.#executablePath, args, {
        cwd: active.directory,
        env: sanitizeChildProcessEnv(this.#env, ["OPENAI_API_KEY"]),
        stdio: ["pipe", "pipe", "pipe"],
      })
      active.process = resumedChild
      active.isExited = false
      active.exitCode = null
      this.#wireProcessStreams(active)
      return success(undefined)
    } catch (err) {
      return failure("runtime_failure", "runtime.prompt.resume_failed", `Failed to resume Codex session: ${String(err)}`)
    }
  }

  async #validateLaunchScope(request: LaunchAgentRequest): Promise<Result<never> | undefined> {
    if (request.operation.nodeId !== this.#nodeId) {
      return failure("policy_denied", "runtime.launch.foreign_node", `Launch request target node does not match adapter node ${this.#nodeId}.`, request.operation.correlationId)
    }

    if (request.dispatchEnvelope.targetNodeId !== this.#nodeId) {
      return failure("policy_denied", "runtime.launch.foreign_node", `Dispatch envelope target node does not match adapter node ${this.#nodeId}.`, request.operation.correlationId)
    }

    if (request.dispatchEnvelope.installationId !== this.#installationId || request.dispatchEnvelope.runtimeKind !== this.kind) {
      return failure("unsupported_capability", "runtime.launch.installation", "The requested installation is not available.", request.operation.correlationId)
    }

    if (request.operation.projectId !== request.dispatchEnvelope.projectId) {
      return failure("policy_denied", "runtime.launch.project_scope", "Operation projectId does not match dispatch envelope projectId.", request.operation.correlationId)
    }

    const computedDigest = digestDispatchEnvelope(request.dispatchEnvelope)
    if (request.dispatchEnvelopeDigest !== computedDigest) {
      return failure("validation", "runtime.launch.invalid_digest", "Dispatch envelope digest does not match the actual envelope content.", request.operation.correlationId)
    }

    return undefined
  }

  async #resolveDirectory(request: LaunchAgentRequest): Promise<Result<string>> {
    try {
      const resolved = await this.#projects.resolve({
        projectId: request.dispatchEnvelope.projectId,
        projectPathId: request.dispatchEnvelope.projectPathId,
        nodeId: request.operation.nodeId,
      })
      if (!resolved.ok) return resolved

      if (!isPathContained(resolved.value, resolved.value)) {
        return failure("policy_denied", "runtime.launch.project_directory", "The project directory failed containment verification.", request.operation.correlationId)
      }

      return success(resolved.value)
    } catch {
      return failure("transient_transport", "runtime.launch.project_resolution", "Project path could not be resolved.", request.operation.correlationId)
    }
  }

  #createLifecycleEvent(
    active: CodexActiveSession,
    state: "starting" | "working" | "blocked" | "result_available" | "completed" | "failed" | "unknown",
    detail?: string,
    source: "hook" | "process_state" | "user_config" = "hook",
    confidence: "authoritative" | "observed" | "inferred" = "authoritative",
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

  #eventScope(active: CodexActiveSession) {
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

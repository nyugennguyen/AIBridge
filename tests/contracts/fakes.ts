import { digestDispatchEnvelope, digestJson } from "../../src/orchestration/digest.js"
import type { Result } from "../../src/orchestration/errors.js"
import {
  agentInstallationSchema,
  agentRuntimeEventSchema,
  runtimeCapabilitiesSchema,
  runtimeSessionReferenceSchema,
  runtimeSessionSchema,
} from "../../src/runtime/schemas.js"
import type {
  AgentInstallation,
  AgentResponse,
  AgentResult,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  LaunchAgentRequest,
  NodeContext,
  PromptRequest,
  RuntimeOperationContext,
  RuntimeSession,
  RuntimeSessionReference,
} from "../../src/runtime/types.js"
import { DeterministicClock, DeterministicIdSource, success, typedFailure } from "./helpers.js"

export interface FakeRuntimeAdapterOptions {
  projectId?: string
  nodeId?: string
  installationId?: string
  runtimeKind?: string
  clock?: DeterministicClock
  ids?: DeterministicIdSource
}

interface RecordedLaunch {
  fingerprint: string
  result: Result<RuntimeSession>
}

/**
 * A deterministic, in-process adapter for contract tests. It models only the
 * adapter boundary: scope checks, command/dispatch deduplication, and known
 * session-reference validation, never a provider process, persistence engine,
 * network, or scheduler.
 */
export class FakeAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly kind: string
  readonly capabilities = runtimeCapabilitiesSchema.parse({
    structuredPermissions: true,
    nativeSessionRestore: true,
    reliableCompletion: false,
    modelSelection: true,
    usageData: false,
    hooks: false,
    transcriptExport: false,
  })
  readonly projectId: string
  readonly nodeId: string
  readonly installationId: string
  readonly clock: DeterministicClock
  readonly ids: DeterministicIdSource
  #launches = new Map<string, RecordedLaunch>()
  #sessions = new Map<string, RuntimeSession>()
  #sessionReferences = new Map<string, RuntimeSessionReference>()
  #dispatchSessions = new Map<string, string>()
  #prompts = new Map<string, { fingerprint: string; result: Result<void> }>()
  #launchSideEffectCount = 0

  constructor(options: FakeRuntimeAdapterOptions = {}) {
    this.projectId = options.projectId ?? "project-contract"
    this.nodeId = options.nodeId ?? "node-contract"
    this.installationId = options.installationId ?? "installation-contract"
    this.kind = options.runtimeKind ?? "contract-fake"
    this.clock = options.clock ?? new DeterministicClock()
    this.ids = options.ids ?? new DeterministicIdSource()
  }

  get launchSideEffectCount(): number {
    return this.#launchSideEffectCount
  }

  async detect(nodeContext: NodeContext): Promise<Result<AgentInstallation[]>> {
    if (nodeContext.nodeId !== this.nodeId) {
      return typedFailure("policy_denied", "runtime.detect.node_scope", "The adapter is not installed on this node.")
    }
    return success([
      agentInstallationSchema.parse({
        schemaVersion: 1,
        installationId: this.installationId,
        nodeId: this.nodeId,
        runtimeKind: this.kind,
        displayName: "Contract fake runtime",
        capabilities: this.capabilities,
      }),
    ])
  }

  async launch(request: LaunchAgentRequest): Promise<Result<RuntimeSession>> {
    const scopeFailure = this.validateLaunchScope(request)
    if (scopeFailure) return scopeFailure

    const fingerprint = digestJson(request)
    const previous = this.#launches.get(request.operation.commandId)
    if (previous) {
      return previous.fingerprint === fingerprint
        ? previous.result
        : typedFailure("conflict", "runtime.launch.command_conflict", "A command ID cannot be reused with different content.", request.operation.correlationId)
    }
    if (this.#dispatchSessions.has(this.dispatchKey(request))) {
      return typedFailure(
        "conflict",
        "runtime.launch.dispatch_already_bound",
        "A dispatch is already bound to a session and cannot be launched by a new command.",
        request.operation.correlationId,
      )
    }

    this.#launchSideEffectCount += 1
    const session = runtimeSessionSchema.parse({
      schemaVersion: 1,
      sessionId: this.ids.next("session"),
      projectId: request.dispatchEnvelope.projectId,
      runId: request.dispatchEnvelope.runId,
      taskId: request.dispatchEnvelope.taskId,
      dispatchId: request.dispatchEnvelope.dispatchId,
      nodeId: this.nodeId,
      installationId: this.installationId,
      runtimeKind: this.kind,
      lifecycleState: "launching",
      observedState: "starting",
    })
    const result = success(session)
    const reference = runtimeSessionReferenceSchema.parse({
      ...session,
      adapterMetadata: { handle: session.sessionId },
    })
    this.#sessions.set(session.sessionId, session)
    this.#sessionReferences.set(session.sessionId, reference)
    this.#dispatchSessions.set(this.dispatchKey(request), session.sessionId)
    this.#launches.set(request.operation.commandId, { fingerprint, result })
    return result
  }

  async restore(reference: RuntimeSessionReference, operation: RuntimeOperationContext): Promise<Result<RuntimeSession>> {
    const checked = runtimeSessionReferenceSchema.safeParse(reference)
    if (!checked.success) return typedFailure("validation", "runtime.restore.invalid_reference", "Runtime session reference is not valid.", operation.correlationId)
    const session = this.#sessions.get(checked.data.sessionId)
    const expectedReference = this.#sessionReferences.get(checked.data.sessionId)
    if (!session || !expectedReference) {
      return typedFailure("policy_denied", "runtime.restore.unknown_session", "The runtime session is not known to this adapter.", operation.correlationId)
    }
    if (digestJson(checked.data) !== digestJson(expectedReference)) {
      return typedFailure("policy_denied", "runtime.restore.reference_mismatch", "The runtime session reference does not match the recorded session.", operation.correlationId)
    }
    const scopeFailure = this.validateSessionScope(session, operation)
    if (scopeFailure) return scopeFailure
    return success(session)
  }

  async prompt(session: RuntimeSession, request: PromptRequest): Promise<Result<void>> {
    const scopeFailure = this.validateSessionScope(session, request.operation)
    if (scopeFailure) return scopeFailure

    const fingerprint = digestJson(request)
    const previous = this.#prompts.get(request.operation.commandId)
    if (previous) {
      return previous.fingerprint === fingerprint
        ? previous.result
        : typedFailure(
            "conflict",
            "runtime.prompt.command_conflict",
            "A command ID cannot be reused with different prompt content.",
            request.operation.correlationId,
          )
    }
    const result = success(undefined)
    this.#prompts.set(request.operation.commandId, { fingerprint, result })
    return result
  }

  async *observe(session: RuntimeSession, operation: RuntimeOperationContext): AsyncIterable<Result<AgentRuntimeEvent>> {
    const scopeFailure = this.validateSessionScope(session, operation)
    if (scopeFailure) {
      yield scopeFailure
      return
    }
    yield success(agentRuntimeEventSchema.parse({
      schemaVersion: 1,
      eventId: this.ids.next("event"),
      projectId: session.projectId,
      runId: session.runId,
      taskId: session.taskId,
      dispatchId: session.dispatchId,
      sessionId: session.sessionId,
      nodeId: session.nodeId,
      occurredAt: this.clock.now(),
      type: "lifecycle",
      state: session.observedState,
    }))
  }

  async respond(session: RuntimeSession, response: AgentResponse): Promise<Result<void>> {
    return this.validateSessionScope(session, response.operation) ?? success(undefined)
  }

  async interrupt(session: RuntimeSession, operation: RuntimeOperationContext): Promise<Result<void>> {
    return this.validateSessionScope(session, operation) ?? success(undefined)
  }

  async terminate(session: RuntimeSession, operation: RuntimeOperationContext): Promise<Result<void>> {
    return this.validateSessionScope(session, operation) ?? success(undefined)
  }

  async collectResult(session: RuntimeSession, operation: RuntimeOperationContext): Promise<Result<AgentResult>> {
    const scopeFailure = this.validateSessionScope(session, operation)
    if (scopeFailure) return scopeFailure
    return success({ schemaVersion: 1, outcome: "unknown", summary: "The contract fake does not infer completion." })
  }

  private validateLaunchScope(request: LaunchAgentRequest): Result<never> | undefined {
    const { dispatchEnvelope: envelope, dispatchEnvelopeDigest, operation } = request
    if (envelope.projectId !== this.projectId || operation.projectId !== this.projectId) {
      return typedFailure("policy_denied", "runtime.launch.project_scope", "The requested project is outside this adapter scope.", operation.correlationId)
    }
    if (envelope.targetNodeId !== this.nodeId || operation.nodeId !== this.nodeId) {
      return typedFailure("policy_denied", "runtime.launch.node_scope", "The requested node is outside this adapter scope.", operation.correlationId)
    }
    if (envelope.installationId !== this.installationId || envelope.runtimeKind !== this.kind) {
      return typedFailure("unsupported_capability", "runtime.launch.installation", "The requested installation is not provided by this adapter.", operation.correlationId)
    }
    if (dispatchEnvelopeDigest !== digestDispatchEnvelope(envelope)) {
      return typedFailure("validation", "runtime.launch.envelope_digest", "The dispatch envelope digest does not match its canonical content.", operation.correlationId)
    }
    return undefined
  }

  private validateSessionScope(session: RuntimeSession, operation: RuntimeOperationContext): Result<never> | undefined {
    if (session.projectId !== this.projectId || operation.projectId !== this.projectId) {
      return typedFailure("policy_denied", "runtime.session.project_scope", "The requested project is outside this adapter scope.", operation.correlationId)
    }
    if (session.nodeId !== this.nodeId || operation.nodeId !== this.nodeId) {
      return typedFailure("policy_denied", "runtime.session.node_scope", "The requested node is outside this adapter scope.", operation.correlationId)
    }
    if (session.installationId !== this.installationId || session.runtimeKind !== this.kind) {
      return typedFailure("unsupported_capability", "runtime.session.installation", "The session belongs to another installation.", operation.correlationId)
    }
    if (operation.runId !== session.runId || operation.dispatchId !== session.dispatchId) {
      return typedFailure("policy_denied", "runtime.session.operation_scope", "The operation does not belong to this session.", operation.correlationId)
    }
    return undefined
  }

  private dispatchKey(request: LaunchAgentRequest): string {
    const { projectId, runId, dispatchId } = request.dispatchEnvelope
    return digestJson({ projectId, runId, dispatchId })
  }
}

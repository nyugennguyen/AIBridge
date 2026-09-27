import { randomUUID } from "node:crypto"
import { digestDispatchEnvelope, digestJson } from "../orchestration/digest.js"
import { contractErrorSchema, type ContractError, type Result } from "../orchestration/errors.js"
import {
  adapterCapabilityReportSchema,
  agentInstallationSchema,
  agentResponseSchema,
  agentRuntimeEventSchema,
  agentResultSchema,
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
  type ObservationConfidence,
  type ObservationSource,
  type PromptRequest,
  type RuntimeOperationContext,
  type RuntimeSession,
  type RuntimeSessionReference,
} from "./schemas.js"
import type { AgentRuntimeAdapter } from "./types.js"
import type { OpencodeClient, OpencodeEvent, OpencodePromptPolicy, PermissionAskedEvent, PermissionDecision, SessionStatus, SessionStatusEvent } from "../opencode/types.js"

/**
 * Resolves an already-authorized local project binding to its working
 * directory. This is deliberately a narrow adapter boundary: path
 * authorization remains the application service's responsibility.
 */
export interface OpencodeProjectDirectoryResolver {
  resolve(scope: {
    readonly projectId: string
    readonly projectPathId: string
    readonly nodeId: string
  }): Promise<Result<string>>
}

export interface OpencodeRuntimeAdapterOptions {
  /** Existing loopback SDK client. Credentials remain encapsulated there. */
  readonly client: OpencodeClient
  /** Literal loopback server URL used to construct the injected client. */
  readonly baseUrl: string
  readonly nodeId: string
  readonly installationId: string
  readonly projects: OpencodeProjectDirectoryResolver
  readonly displayName?: string
  readonly now?: () => string
  readonly nextId?: (kind: "session" | "event") => string
}

interface KnownSession {
  session: RuntimeSession
  readonly reference: RuntimeSessionReference
  readonly directory: string
  readonly providerSessionId: string
  readonly outstandingPermissions: Map<string, string>
  readonly pendingEvents: AgentRuntimeEvent[]
  observationStarted: boolean
  readonly promptPolicy: OpencodePromptPolicy
  readonly timeoutSeconds: number
}

interface RecordedLaunch {
  readonly fingerprint: string
  readonly result: Promise<Result<RuntimeSession>>
}

interface RecordedEffect {
  readonly fingerprint: string
  readonly result: Promise<Result<void>>
}

export interface OpencodeTerminalBinding {
  readonly providerSessionId: string
  readonly directory: string
  readonly timeoutSeconds: number
}

/**
 * M1 implementation of the provider-neutral runtime contract over the
 * existing local OpenCode SDK client. It owns only in-memory provider handles;
 * an absent exact binding fails closed rather than discovering arbitrary SDK
 * sessions after a restart.
 */
export class OpencodeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly kind = "opencode"
  readonly capabilities = runtimeCapabilitiesSchema.parse({
    structuredPermissions: true,
    nativeSessionRestore: false,
    reliableCompletion: false,
    modelSelection: false,
    usageData: false,
    hooks: false,
    transcriptExport: false,
  })
  readonly capabilityReport = adapterCapabilityReportSchema.parse({
    structuredPermissions: { status: "supported", evidenceSource: "api" },
    nativeSessionRestore: { status: "unsupported", evidenceSource: "process_state" },
    reliableCompletion: { status: "unsupported", evidenceSource: "api" },
    modelSelection: { status: "unsupported", evidenceSource: "user_config" },
    usageData: { status: "unsupported", evidenceSource: "api" },
    hooks: { status: "unsupported", evidenceSource: "hook" },
    transcriptExport: { status: "unsupported", evidenceSource: "terminal_manifest" },
  })

  readonly #client: OpencodeClient
  readonly #baseUrl: string
  readonly #nodeId: string
  readonly #installationId: string
  readonly #projects: OpencodeProjectDirectoryResolver
  readonly #displayName: string
  readonly #now: () => string
  readonly #nextId: (kind: "session" | "event") => string
  readonly #sessions = new Map<string, KnownSession>()
  readonly #launches = new Map<string, RecordedLaunch>()
  readonly #dispatches = new Map<string, string>()
  readonly #effects = new Map<string, RecordedEffect>()

  constructor(options: OpencodeRuntimeAdapterOptions) {
    this.#client = options.client
    this.#baseUrl = options.baseUrl
    this.#nodeId = options.nodeId
    this.#installationId = options.installationId
    this.#projects = options.projects
    this.#displayName = options.displayName ?? "OpenCode (loopback SDK)"
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#nextId = options.nextId ?? ((kind) => `${kind}-${randomUUID()}`)
  }

  /** Returns only an adapter-owned exact binding; arbitrary provider sessions cannot be attached. */
  terminalBinding(sessionId: string): Result<OpencodeTerminalBinding> {
    const known = this.#sessions.get(sessionId)
    return known
      ? success({ providerSessionId: known.providerSessionId, directory: known.directory, timeoutSeconds: known.timeoutSeconds })
      : failure("policy_denied", "runtime.terminal.unknown_session", "The terminal session is not known to this runtime adapter.")
  }

  async detect(nodeContext: NodeContext): Promise<Result<AgentInstallation[]>> {
    const checked = nodeContextSchema.safeParse(nodeContext)
    if (!checked.success) return failure("validation", "runtime.detect.invalid_node", "The node context is not valid.")
    if (checked.data.nodeId !== this.#nodeId) return failure("policy_denied", "runtime.detect.node_scope", "This runtime is not installed on the requested node.")
    if (!isLiteralLoopbackUrl(this.#baseUrl)) return success([])
    try {
      if (!await this.#client.health()) return success([])
    } catch {
      return failure("transient_transport", "runtime.detect.unavailable", "OpenCode installation detection could not reach the local server.")
    }
    try {
      return success([agentInstallationSchema.parse({
        schemaVersion: 1,
        installationId: this.#installationId,
        nodeId: this.#nodeId,
        runtimeKind: this.kind,
        displayName: this.#displayName,
        capabilities: this.capabilities,
        capabilityReport: this.capabilityReport,
      })])
    } catch {
      return failure("internal_failure", "runtime.detect.configuration", "OpenCode runtime configuration is invalid.")
    }
  }

  async launch(request: LaunchAgentRequest): Promise<Result<RuntimeSession>> {
    const checked = launchAgentRequestSchema.safeParse(request)
    if (!checked.success) return failure("validation", "runtime.launch.invalid_request", "The launch request is not valid.", request.operation?.correlationId)
    const scopeFailure = this.#validateLaunchScope(checked.data)
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

  async restore(reference: RuntimeSessionReference, operation: RuntimeOperationContext): Promise<Result<RuntimeSession>> {
    const parsedReference = runtimeSessionReferenceSchema.safeParse(reference)
    const parsedOperation = runtimeOperationContextSchema.safeParse(operation)
    if (!parsedReference.success || !parsedOperation.success) {
      return failure("validation", "runtime.restore.invalid_reference", "The runtime session reference or operation is not valid.", operation?.correlationId)
    }
    const known = this.#sessions.get(parsedReference.data.sessionId)
    if (!known) return failure("policy_denied", "runtime.restore.unknown_session", "The runtime session is not known to this adapter.", parsedOperation.data.correlationId)
    if (digestJson(parsedReference.data) !== digestJson(known.reference)) {
      return failure("policy_denied", "runtime.restore.reference_mismatch", "The runtime session reference does not match the recorded provider binding.", parsedOperation.data.correlationId)
    }
    const scopeFailure = this.#validateKnownSession(known, parsedReference.data, parsedOperation.data)
    return scopeFailure ?? success(known.session)
  }

  async prompt(session: RuntimeSession, request: PromptRequest): Promise<Result<void>> {
    const parsedSession = runtimeSessionSchema.safeParse(session)
    const parsedRequest = promptRequestSchema.safeParse(request)
    if (!parsedSession.success || !parsedRequest.success) return failure("validation", "runtime.prompt.invalid_request", "The prompt request is not valid.", request.operation?.correlationId)
    const known = this.#sessions.get(parsedSession.data.sessionId)
    if (!known) return failure("policy_denied", "runtime.prompt.unknown_session", "The runtime session is not known to this adapter.", parsedRequest.data.operation.correlationId)
    const scopeFailure = this.#validateKnownSession(known, parsedSession.data, parsedRequest.data.operation)
    if (scopeFailure) return scopeFailure
    return await this.#recordEffect(
      "prompt",
      parsedRequest.data.operation.commandId,
      { sessionId: known.session.sessionId, request: parsedRequest.data },
      parsedRequest.data.operation.correlationId,
      async () => {
        try {
          await this.#client.sendPromptAsync(known.providerSessionId, parsedRequest.data.prompt, known.directory, known.promptPolicy)
          return success(undefined)
        } catch {
          return failure("transient_transport", "runtime.prompt.outcome_unknown", "Prompt delivery outcome is unknown; reconcile without replaying it.", parsedRequest.data.operation.correlationId)
        }
      },
    )
  }

  async *observe(session: RuntimeSession, operation: RuntimeOperationContext): AsyncIterable<Result<AgentRuntimeEvent>> {
    const parsedSession = runtimeSessionSchema.safeParse(session)
    const parsedOperation = runtimeOperationContextSchema.safeParse(operation)
    if (!parsedSession.success || !parsedOperation.success) {
      yield failure("validation", "runtime.observe.invalid_request", "The session observation request is not valid.", operation?.correlationId)
      return
    }
    const known = this.#sessions.get(parsedSession.data.sessionId)
    if (!known) {
      yield failure("policy_denied", "runtime.observe.unknown_session", "The runtime session is not known to this adapter.", parsedOperation.data.correlationId)
      return
    }
    const scopeFailure = this.#validateKnownSession(known, parsedSession.data, parsedOperation.data)
    if (scopeFailure) {
      yield scopeFailure
      return
    }

    const permissionIndex = known.pendingEvents.findIndex((event) => event.type === "permission_requested")
    const pending = permissionIndex >= 0 ? known.pendingEvents.splice(permissionIndex, 1)[0] : known.pendingEvents.shift()
    if (pending) {
      yield success(pending)
      return
    }
    try {
      yield success(this.#lifecycle(known, await this.#client.getSessionStatus(known.providerSessionId), undefined, "polling", "inferred"))
    } catch {
      yield failure("transient_transport", "runtime.observe.status_unavailable", "OpenCode session status could not be read safely.", parsedOperation.data.correlationId)
    }
  }

  async respond(session: RuntimeSession, response: AgentResponse): Promise<Result<void>> {
    const parsedSession = runtimeSessionSchema.safeParse(session)
    const parsedResponse = agentResponseSchema.safeParse(response)
    if (!parsedSession.success || !parsedResponse.success) return failure("validation", "runtime.respond.invalid_request", "The runtime response is not valid.", response.operation?.correlationId)
    const known = this.#sessions.get(parsedSession.data.sessionId)
    if (!known) return failure("policy_denied", "runtime.respond.unknown_session", "The runtime session is not known to this adapter.", parsedResponse.data.operation.correlationId)
    const scopeFailure = this.#validateKnownSession(known, parsedSession.data, parsedResponse.data.operation)
    if (scopeFailure) return scopeFailure
    if (parsedResponse.data.kind !== "permission") {
      return failure("unsupported_capability", "runtime.respond.kind_unsupported", "OpenCode supports only structured permission responses.", parsedResponse.data.operation.correlationId)
    }
    const requestedPermission = known.outstandingPermissions.get(parsedResponse.data.responseId)
    if (requestedPermission === undefined) {
      return failure("conflict", "runtime.respond.request_unknown", "The permission request is not outstanding for this session.", parsedResponse.data.operation.correlationId)
    }
    const decision = permissionDecision(parsedResponse.data.value)
    if (!decision) return failure("validation", "runtime.respond.decision_invalid", "The permission response is not supported.", parsedResponse.data.operation.correlationId)
    if (decision === "always") {
      return failure("policy_denied", "runtime.respond.persistent_approval_denied", "Persistent permission approval is not allowed for an individual dispatch.", parsedResponse.data.operation.correlationId)
    }
    if (decision !== "reject" && !this.#permissionAllowed(known.promptPolicy, requestedPermission)) {
      return failure("policy_denied", "runtime.respond.permission_denied", "The requested permission is outside the approved dispatch envelope.", parsedResponse.data.operation.correlationId)
    }
    return await this.#recordEffect(
      "respond",
      parsedResponse.data.operation.commandId,
      { sessionId: known.session.sessionId, response: parsedResponse.data },
      parsedResponse.data.operation.correlationId,
      async () => {
        try {
          await this.#client.replyPermission(known.providerSessionId, parsedResponse.data.responseId, decision)
          known.outstandingPermissions.delete(parsedResponse.data.responseId)
          return success(undefined)
        } catch {
          return failure("transient_transport", "runtime.respond.outcome_unknown", "Permission response outcome is unknown; reconcile without replaying it.", parsedResponse.data.operation.correlationId)
        }
      },
    )
  }

  async interrupt(session: RuntimeSession, operation: RuntimeOperationContext): Promise<Result<void>> {
    return await this.#abort("interrupt", session, operation)
  }

  async terminate(session: RuntimeSession, operation: RuntimeOperationContext): Promise<Result<void>> {
    return await this.#abort("terminate", session, operation)
  }

  async collectResult(session: RuntimeSession, operation: RuntimeOperationContext): Promise<Result<AgentResult>> {
    const parsedSession = runtimeSessionSchema.safeParse(session)
    const parsedOperation = runtimeOperationContextSchema.safeParse(operation)
    if (!parsedSession.success || !parsedOperation.success) return failure("validation", "runtime.result.invalid_request", "The result request is not valid.", operation?.correlationId)
    const known = this.#sessions.get(parsedSession.data.sessionId)
    if (!known) return failure("policy_denied", "runtime.result.unknown_session", "The runtime session is not known to this adapter.", parsedOperation.data.correlationId)
    const scopeFailure = this.#validateKnownSession(known, parsedSession.data, parsedOperation.data)
    if (scopeFailure) return scopeFailure
    try {
      const status = await this.#client.getSessionStatus(known.providerSessionId)
      return success(agentResultSchema.parse({
        schemaVersion: 1,
        outcome: "unknown",
        summary: status === "idle"
          ? "OpenCode reports the session is idle, but this provider does not supply reliable completion evidence."
          : "OpenCode does not currently provide reliable completion evidence for this session.",
      }))
    } catch {
      return failure("transient_transport", "runtime.result.unavailable", "OpenCode result inspection failed; the outcome remains unknown.", parsedOperation.data.correlationId)
    }
  }

  async #launchOnce(request: LaunchAgentRequest): Promise<Result<RuntimeSession>> {
    const directory = await this.#resolveDirectory(request)
    if (!directory.ok) return directory
    let providerSessionId: string
    try {
      const created = await this.#client.createSession(`AIBridge ${request.dispatchEnvelope.dispatchId}`, directory.value)
      if (!isOpaqueId(created.id)) {
        return failure("transient_transport", "runtime.launch.provider_session_invalid", "OpenCode returned an unusable session handle; launch outcome is unknown.", request.operation.correlationId)
      }
      providerSessionId = created.id
    } catch {
      return failure("transient_transport", "runtime.launch.outcome_unknown", "OpenCode launch outcome is unknown; reconcile without replaying the command.", request.operation.correlationId)
    }
    let session: RuntimeSession
    try {
      session = runtimeSessionSchema.parse({
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
    } catch {
      return failure("internal_failure", "runtime.launch.session_identity", "A canonical runtime session identity could not be created safely.", request.operation.correlationId)
    }
    const reference = runtimeSessionReferenceSchema.parse({
      ...session,
      adapterMetadata: { handle: providerSessionId, projectPathId: request.dispatchEnvelope.projectPathId },
    })
    const promptPolicy = this.#promptPolicy(request)
    const known: KnownSession = {
      session,
      reference,
      directory: directory.value,
      providerSessionId,
      outstandingPermissions: new Map(),
      pendingEvents: [],
      observationStarted: false,
      promptPolicy,
      timeoutSeconds: request.dispatchEnvelope.timeoutSeconds,
    }
    this.#sessions.set(session.sessionId, known)
    this.#startObservation(known)
    try {
      await this.#client.sendPromptAsync(providerSessionId, request.dispatchEnvelope.prompt, directory.value, promptPolicy)
      return success(session)
    } catch {
      return failure("transient_transport", "runtime.launch.outcome_unknown", "OpenCode launch outcome is unknown; reconcile without replaying the command.", request.operation.correlationId)
    }
  }

  #promptPolicy(request: LaunchAgentRequest): OpencodePromptPolicy {
    const envelope = request.dispatchEnvelope
    const role = envelope.roleSnapshot.permissionRestrictions
    const requested = new Set(envelope.requestedCapabilities)
    const roleAllowed = new Set(role.allowedCapabilities)
    const denied = new Set([...envelope.permissionEnvelope.deniedCapabilities, ...role.deniedCapabilities])
    for (const rule of envelope.ruleSnapshots) {
      if (rule.enabled && rule.effect.kind === "restrict") for (const capability of rule.effect.deniedCapabilities) denied.add(capability)
    }
    const allowed = new Set(envelope.permissionEnvelope.allowedCapabilities.filter((capability) =>
      requested.has(capability) && roleAllowed.has(capability) && !denied.has(capability),
    ))
    const capabilityTools: Readonly<Record<string, readonly string[]>> = {
      "filesystem.read": ["read", "glob", "grep", "list"],
      "filesystem.write": ["write", "edit", "patch"],
      "process.exec": ["bash"],
      "network.external": ["webfetch", "websearch"],
    }
    const tools: Record<string, boolean> = {}
    for (const [capability, names] of Object.entries(capabilityTools)) {
      if (denied.has(capability) || !allowed.has(capability)) for (const name of names) tools[name] = false
    }
    const rules = envelope.ruleSnapshots.map((rule) => `${rule.ruleId}: ${JSON.stringify(rule.effect)}`).join("\n")
    return {
      system: [
        `Role: ${envelope.roleSnapshot.name}`,
        envelope.roleSnapshot.instructions,
        rules ? `Rules:\n${rules}` : "",
        `Approved capability envelope: ${[...allowed].join(", ") || "none"}. Denied: ${[...denied].join(", ") || "none"}.`,
        `This dispatch requests a timeout of ${envelope.timeoutSeconds} seconds.`,
      ].filter(Boolean).join("\n\n"),
      tools,
    }
  }

  #permissionAllowed(policy: OpencodePromptPolicy, permission: string): boolean {
    if (policy.tools?.[permission] === false) return false
    const capabilityTools: Readonly<Record<string, readonly string[]>> = {
      "filesystem.read": ["read", "glob", "grep", "list"],
      "filesystem.write": ["write", "edit", "patch"],
      "process.exec": ["bash"],
      "network.external": ["webfetch", "websearch"],
    }
    const names = capabilityTools[permission]
    if (names) return names.every((name) => policy.tools?.[name] !== false)
    return Object.values(capabilityTools).flat().includes(permission)
  }

  #startObservation(known: KnownSession): void {
    if (known.observationStarted) return
    known.observationStarted = true
    void (async () => {
      try {
        const events = await this.#client.subscribeEvents(known.directory)
        for await (const event of events) {
          let normalized: AgentRuntimeEvent | undefined
          if (isSessionStatusEvent(event) && event.properties.sessionID === known.providerSessionId) {
            normalized = this.#lifecycle(known, event.properties.status.type, undefined, "hook", "authoritative")
          } else if (isPermissionAskedEvent(event) && event.properties.sessionID === known.providerSessionId) {
            const requestId = event.properties.permissionID ?? event.properties.id
            if (!isOpaqueId(requestId)) {
              normalized = this.#lifecycle(known, "unknown", "OpenCode permission request could not be identified safely.", "hook", "tentative")
            } else {
              known.outstandingPermissions.set(requestId, event.properties.permission)
              normalized = agentRuntimeEventSchema.parse({
                ...this.#eventScope(known),
                type: "permission_requested",
                permission: this.#permissionLabel(event.properties.permission),
                requestId,
              })
            }
          }
          if (normalized) {
            known.pendingEvents.push(normalized)
            if (known.pendingEvents.length > 64) known.pendingEvents.splice(0, known.pendingEvents.length - 64)
          }
        }
      } catch {
        known.pendingEvents.push(this.#lifecycle(known, "unknown", "OpenCode event observation was interrupted; refresh to reconcile."))
      }
    })()
  }

  #permissionLabel(permission: string): string {
    const safe = new Set([
      "filesystem.read", "filesystem.write", "process.exec", "network.external",
      "read", "glob", "grep", "list", "write", "edit", "patch", "bash", "webfetch", "websearch",
    ])
    return safe.has(permission) ? `OpenCode requests ${permission}` : "OpenCode requests an unrecognized permission"
  }

  async #resolveDirectory(request: LaunchAgentRequest): Promise<Result<string>> {
    try {
      const resolved = await this.#projects.resolve({
        projectId: request.dispatchEnvelope.projectId,
        projectPathId: request.dispatchEnvelope.projectPathId,
        nodeId: request.operation.nodeId,
      })
      if (!resolved.ok) return resolved
      if (!isAbsoluteDirectory(resolved.value)) {
        return failure("policy_denied", "runtime.launch.project_directory", "The project directory is not a safe local binding.", request.operation.correlationId)
      }
      return success(resolved.value)
    } catch {
      return failure("transient_transport", "runtime.launch.project_resolution", "The authorized project directory could not be resolved.", request.operation.correlationId)
    }
  }

  async #abort(action: "interrupt" | "terminate", session: RuntimeSession, operation: RuntimeOperationContext): Promise<Result<void>> {
    const parsedSession = runtimeSessionSchema.safeParse(session)
    const parsedOperation = runtimeOperationContextSchema.safeParse(operation)
    if (!parsedSession.success || !parsedOperation.success) return failure("validation", `runtime.${action}.invalid_request`, "The runtime control request is not valid.", operation?.correlationId)
    const known = this.#sessions.get(parsedSession.data.sessionId)
    if (!known) return failure("policy_denied", `runtime.${action}.unknown_session`, "The runtime session is not known to this adapter.", parsedOperation.data.correlationId)
    const scopeFailure = this.#validateKnownSession(known, parsedSession.data, parsedOperation.data)
    if (scopeFailure) return scopeFailure
    return await this.#recordEffect(
      action,
      parsedOperation.data.commandId,
      { sessionId: known.session.sessionId, operation: parsedOperation.data },
      parsedOperation.data.correlationId,
      async () => {
        try {
          // The existing SDK exposes abort as its only documented stop control.
          // Its acknowledgement never implies a completed task/result.
          await this.#client.abortSession(known.providerSessionId)
          return success(undefined)
        } catch {
          return failure("transient_transport", `runtime.${action}.outcome_unknown`, `OpenCode ${action} outcome is unknown; reconcile without replaying it.`, parsedOperation.data.correlationId)
        }
      },
    )
  }

  async #recordEffect(
    kind: string,
    commandId: string,
    content: unknown,
    correlationId: string,
    invoke: () => Promise<Result<void>>,
  ): Promise<Result<void>> {
    const fingerprint = digestJson({ kind, content })
    const existing = this.#effects.get(commandId)
    if (existing) {
      return existing.fingerprint === fingerprint
        ? await existing.result
        : failure("conflict", "runtime.command.conflict", "A command ID cannot be reused with different runtime control content.", correlationId)
    }
    const result = invoke()
    this.#effects.set(commandId, { fingerprint, result })
    return await result
  }

  #validateLaunchScope(request: LaunchAgentRequest): Result<never> | undefined {
    const { dispatchEnvelope: envelope, operation } = request
    if (!isLiteralLoopbackUrl(this.#baseUrl)) {
      return failure("policy_denied", "runtime.launch.non_loopback", "OpenCode launch requires a literal loopback endpoint.", operation.correlationId)
    }
    if (operation.nodeId !== this.#nodeId || envelope.targetNodeId !== this.#nodeId) {
      return failure("policy_denied", "runtime.launch.node_scope", "The launch request is outside this runtime's node scope.", operation.correlationId)
    }
    if (envelope.installationId !== this.#installationId || envelope.runtimeKind !== this.kind) {
      return failure("unsupported_capability", "runtime.launch.installation", "The requested OpenCode installation is not available.", operation.correlationId)
    }
    if (request.dispatchEnvelopeDigest !== digestDispatchEnvelope(envelope)) {
      return failure("validation", "runtime.launch.envelope_digest", "The dispatch envelope digest does not match its canonical content.", operation.correlationId)
    }
    if (envelope.model !== undefined) {
      return failure("unsupported_capability", "runtime.launch.model_selection", "This OpenCode adapter does not support model selection through the current SDK boundary.", operation.correlationId)
    }
    return undefined
  }

  #validateKnownSession(known: KnownSession, supplied: RuntimeSession, operation: RuntimeOperationContext): Result<never> | undefined {
    const expected = known.session
    if (
      supplied.projectId !== expected.projectId || supplied.runId !== expected.runId || supplied.taskId !== expected.taskId ||
      supplied.dispatchId !== expected.dispatchId || supplied.nodeId !== expected.nodeId || supplied.installationId !== expected.installationId ||
      supplied.runtimeKind !== expected.runtimeKind ||
      (expected.terminalId !== undefined && supplied.terminalId !== expected.terminalId)
    ) {
      return failure("policy_denied", "runtime.session.binding_mismatch", "The runtime session does not match its recorded provider binding.", operation.correlationId)
    }
    if (operation.projectId !== expected.projectId || operation.runId !== expected.runId || operation.dispatchId !== expected.dispatchId || operation.nodeId !== this.#nodeId) {
      return failure("policy_denied", "runtime.session.operation_scope", "The operation does not belong to this runtime session.", operation.correlationId)
    }
    return undefined
  }

  #lifecycle(
    known: KnownSession,
    status: SessionStatus,
    detail?: string,
    source: ObservationSource = "api",
    confidence: ObservationConfidence = "authoritative",
  ): AgentRuntimeEvent {
    const state = status === "busy" || status === "retry" ? "working" : status === "idle" ? "idle" : "unknown"
    known.session = runtimeSessionSchema.parse({ ...known.session, state })
    return agentRuntimeEventSchema.parse({
      ...this.#eventScope(known),
      type: "lifecycle",
      state,
      source,
      confidence,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  #eventScope(known: KnownSession) {
    return {
      schemaVersion: 1 as const,
      eventId: this.#nextId("event"),
      projectId: known.session.projectId,
      runId: known.session.runId,
      taskId: known.session.taskId,
      dispatchId: known.session.dispatchId,
      sessionId: known.session.sessionId,
      nodeId: known.session.nodeId,
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
      ...(correlationId === undefined ? {} : { correlationId }),
    }),
  }
}

function success<T>(value: T): Result<T> {
  return { ok: true, value }
}

function isLiteralLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1") &&
      !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

function isAbsoluteDirectory(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && value.startsWith("/") && !value.includes("\0")
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function permissionDecision(value: string): PermissionDecision | undefined {
  switch (value) {
    case "allow_once": return "once"
    case "allow_always": return "always"
    case "deny": return "reject"
    default: return undefined
  }
}

function isSessionStatusEvent(event: OpencodeEvent): event is SessionStatusEvent {
  return event.type === "session.status"
}

function isPermissionAskedEvent(event: OpencodeEvent): event is PermissionAskedEvent {
  return event.type === "permission.asked"
}

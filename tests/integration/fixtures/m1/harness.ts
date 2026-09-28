import type { KeyEvent, MouseEvent, PasteEvent } from "@opentui/core"
import { InMemoryLocalApplicationService } from "../../../../src/application/service.js"
import type {
  ApplicationIdSource,
  LaunchPathAuthorizationRequest,
  LocalApplicationDependencies,
  LocalApplicationService,
  LocalProjectDefinition,
  LocalProjectRegistry,
} from "../../../../src/application/types.js"
import { digestJson } from "../../../../src/orchestration/digest.js"
import type { ContractError, ErrorCategory, Result } from "../../../../src/orchestration/errors.js"
import {
  commandIdSchema,
  correlationIdSchema,
  projectIdSchema,
  terminalClientIdSchema,
  userIdSchema,
  type CommandId,
  type TerminalClientId,
} from "../../../../src/orchestration/identifiers.js"
import {
  agentResultSchema,
  agentRuntimeEventSchema,
  runtimeCapabilitiesSchema,
  runtimeSessionSchema,
  type AgentResponse,
  type AgentResult,
  type AgentRuntimeEvent,
  type LaunchAgentRequest,
  type PromptRequest,
  type RuntimeOperationContext,
  type RuntimeSession,
  type RuntimeSessionReference,
} from "../../../../src/runtime/schemas.js"
import type { AgentRuntimeAdapter } from "../../../../src/runtime/types.js"
import {
  terminalInputOwnershipSchema,
  terminalReferenceSchema,
  terminalSnapshotSchema,
  type CreateTerminalRequest,
  type InputTakeoverRequest,
  type TerminalControlOperationContext,
  type TerminalDimensions,
  type TerminalInputOwnership,
  type TerminalOperationContext,
  type TerminalReference,
  type TerminalSnapshot,
} from "../../../../src/terminal/schemas.js"
import type { TerminalBackend, TerminalChannel } from "../../../../src/terminal/types.js"
import type {
  TerminalControllerScheduler,
  TerminalViewModel,
  TerminalViewPort,
  TuiDimensions,
  TuiRenderer,
} from "../../../../src/tui/index.js"

export const correlationId = correlationIdSchema.parse("correlation-m1-e2e")
export const userId = userIdSchema.parse("user-m1-e2e")
export const primaryClientId = terminalClientIdSchema.parse("client-m1-primary")
export const secondaryClientId = terminalClientIdSchema.parse("client-m1-secondary")

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function fail(
  category: ErrorCategory,
  code: string,
  message: string,
): Result<never> {
  return {
    ok: false,
    error: {
      schemaVersion: 1,
      category,
      code,
      message,
      retryable: ["transient_transport", "timeout", "runtime_failure", "internal_failure"].includes(category),
      correlationId,
    },
  }
}

export function valueOf<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.category}:${result.error.code}:${result.error.message}`)
  return result.value
}

export class DeterministicClock {
  readonly reads: string[] = []
  private tick = 0

  now(): string {
    const value = `2026-09-17T00:00:${String(this.tick++).padStart(2, "0")}.000Z`
    this.reads.push(value)
    return value
  }

  timestamp(): string {
    return "2026-09-17T00:10:00.000Z"
  }
}

export class DeterministicIds implements ApplicationIdSource {
  private sequence = 0
  readonly issued: string[] = []

  next(kind: string): string {
    const id = `${kind}-m1-${++this.sequence}`
    this.issued.push(id)
    return id
  }
}

export function projectDefinition(): LocalProjectDefinition {
  const permissionEnvelope = {
    allowedCapabilities: ["filesystem.read", "filesystem.write"],
    deniedCapabilities: ["network.external"],
    approvalRequirements: {
      destructiveEffects: true,
      externalEffects: true,
      capabilities: ["filesystem.write"],
    },
  }
  return {
    project: {
      schemaVersion: 1,
      projectId: projectIdSchema.parse("project-m1"),
      meshId: "mesh-m1" as never,
      name: "M1 fixture project",
      pathBindings: [{
        schemaVersion: 1,
        projectPathId: "path-m1" as never,
        projectId: "project-m1" as never,
        nodeId: "node-m1" as never,
        configuredPath: "/workspace/m1-fixture",
        allowedCapabilities: ["filesystem.read", "filesystem.write"],
      }],
    },
    projectPathId: "path-m1" as never,
    nodeContext: {
      schemaVersion: 1,
      nodeId: "node-m1" as never,
      meshId: "mesh-m1" as never,
      platform: "fixture",
      architecture: "fixture",
    },
    installation: {
      schemaVersion: 1,
      installationId: "installation-m1" as never,
      nodeId: "node-m1" as never,
      runtimeKind: "scripted-opencode",
      displayName: "Scripted OpenCode",
      version: "fixture-1",
      capabilities: runtimeCapabilitiesSchema.parse({
        structuredPermissions: true,
        nativeSessionRestore: true,
        reliableCompletion: true,
        modelSelection: true,
        usageData: false,
        hooks: false,
        transcriptExport: false,
      }),
    },
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "role-m1" as never,
      templateVersion: 1,
      projectId: "project-m1" as never,
      name: "M1 test engineer",
      purpose: "Exercise the approved local vertical slice.",
      instructions: "Use only the deterministic fixture project.",
      requiredCapabilities: ["filesystem.read"],
      preferredRuntimeKinds: ["scripted-opencode"],
      contextSelectionPolicyReference: { namespace: "fixture", id: "m1" },
      permissionRestrictions: permissionEnvelope,
      author: { kind: "system", name: "m1-fixture" },
      createdAt: "2026-09-17T00:00:00.000Z",
    },
    ruleSnapshots: [],
    contextManifest: { references: [], manifestDigest: digestJson({ references: [] }) },
    requestedCapabilities: ["filesystem.read", "filesystem.write"],
    permissionEnvelope,
    availableModels: ["fixture-model"],
    controller: {
      controllerNodeId: "node-m1" as never,
      controllerEpoch: 1,
      leaseId: "lease-m1" as never,
    },
  }
}

export class ScriptedProjectRegistry implements LocalProjectRegistry {
  current = projectDefinition()
  launchAuthorized = true
  readonly authorizationRequests: LaunchPathAuthorizationRequest[] = []

  async listAuthorizedProjects(): Promise<Result<readonly LocalProjectDefinition[]>> {
    return ok([structuredClone(this.current)])
  }

  async getAuthorizedProject(projectId: typeof this.current.project.projectId): Promise<Result<LocalProjectDefinition>> {
    return projectId === this.current.project.projectId
      ? ok(structuredClone(this.current))
      : fail("policy_denied", "fixture.project_denied", "Project is not authorized.")
  }

  async authorizeLaunchPath(request: LaunchPathAuthorizationRequest) {
    this.authorizationRequests.push(structuredClone(request))
    return this.launchAuthorized
      ? ok({ ...request, realPath: request.configuredPath })
      : fail("policy_denied", "fixture.path_denied", "Project path authorization was revoked.")
  }
}

export class Deferred<T = void> {
  readonly promise: Promise<T>
  resolve!: (value: T) => void

  constructor() {
    this.promise = new Promise<T>((resolve) => { this.resolve = resolve })
  }
}

class ScriptedTerminalChannel implements TerminalChannel {
  constructor(
    private readonly backend: ScriptedTerminalBackend,
    readonly reference: TerminalReference,
    readonly clientId: TerminalClientId,
  ) {}

  async read(maxBytes: number): Promise<Result<Uint8Array>> {
    this.backend.readLimits.push(maxBytes)
    const chunk = this.backend.output.shift() ?? new Uint8Array()
    return ok(Uint8Array.from(chunk.subarray(0, maxBytes)))
  }

  async write(data: Uint8Array): Promise<Result<void>> {
    if (this.backend.owner !== this.clientId) {
      return fail("policy_denied", "terminal.input_not_owned", "Terminal input belongs to another client.")
    }
    this.backend.writeAttempts.push({ clientId: this.clientId, data: Uint8Array.from(data) })
    const gate = this.backend.writeGate
    if (gate) await gate.promise
    if (this.backend.owner !== this.clientId) {
      return fail("policy_denied", "terminal.input_not_owned", "Terminal input ownership was lost.")
    }
    if (this.backend.failNextWrite) {
      this.backend.failNextWrite = false
      return fail("transient_transport", "terminal.write_failed", "Terminal channel write failed.")
    }
    this.backend.acceptedWrites.push({ clientId: this.clientId, data: Uint8Array.from(data) })
    return ok(undefined)
  }

  async requestInputOwnership(): Promise<Result<TerminalInputOwnership>> {
    if (this.backend.owner !== null && this.backend.owner !== this.clientId) {
      return fail("conflict", "terminal.input_owned", "Terminal input is owned by another client.")
    }
    this.backend.owner = this.clientId
    return ok(this.backend.ownership())
  }

  async releaseInputOwnership(): Promise<Result<TerminalInputOwnership>> {
    this.backend.releaseCount += 1
    if (this.backend.owner === this.clientId) this.backend.owner = null
    return ok(this.backend.ownership())
  }

  async takeOverInput(request: InputTakeoverRequest): Promise<Result<TerminalInputOwnership>> {
    this.backend.takeoverReasons.push(request.reason)
    this.backend.owner = this.clientId
    return ok(this.backend.ownership())
  }
}

export class ScriptedTerminalBackend implements TerminalBackend {
  readonly kind = "scripted-terminal"
  reference: TerminalReference | null = null
  owner: TerminalClientId | null = null
  readonly output: Uint8Array[] = []
  readonly readLimits: number[] = []
  readonly writeAttempts: Array<{ clientId: TerminalClientId; data: Uint8Array }> = []
  readonly acceptedWrites: Array<{ clientId: TerminalClientId; data: Uint8Array }> = []
  readonly resizeCalls: Array<{ clientId: TerminalClientId; dimensions: TerminalDimensions }> = []
  readonly detachCalls: TerminalClientId[] = []
  readonly takeoverReasons: string[] = []
  releaseCount = 0
  terminateCount = 0
  createCount = 0
  recoverCount = 0
  failNextWrite = false
  writeGate: Deferred<void> | null = null

  provision(request: LaunchAgentRequest): TerminalReference {
    this.reference = terminalReferenceSchema.parse({
      schemaVersion: 1,
      terminalId: "terminal-m1",
      nodeId: request.operation.nodeId,
      projectId: request.operation.projectId,
      sessionId: "session-m1",
      backendKind: this.kind,
      adapterMetadata: { recoveryVersion: "1", fixture: "m1" },
    })
    return this.reference
  }

  ownership(): TerminalInputOwnership {
    if (!this.reference) throw new Error("fixture terminal has not been provisioned")
    return terminalInputOwnershipSchema.parse({
      schemaVersion: 1,
      terminalId: this.reference.terminalId,
      ownerClientId: this.owner,
      changedAt: "2026-09-17T00:10:00.000Z",
    })
  }

  async create(request: CreateTerminalRequest): Promise<Result<TerminalReference>> {
    this.createCount += 1
    this.reference = terminalReferenceSchema.parse({
      schemaVersion: 1,
      terminalId: request.terminalId,
      nodeId: request.operation.nodeId,
      projectId: request.operation.projectId,
      sessionId: request.sessionId,
      backendKind: this.kind,
      adapterMetadata: { recoveryVersion: "1", fixture: "m1" },
    })
    return ok(this.reference)
  }

  async attach(reference: TerminalReference, operation: TerminalOperationContext): Promise<Result<TerminalChannel>> {
    if (!this.reference || JSON.stringify(reference) !== JSON.stringify(this.reference)) {
      return fail("validation", "terminal.target_unavailable", "Terminal binding is unavailable.")
    }
    if (operation.projectId !== reference.projectId || operation.nodeId !== reference.nodeId) {
      return fail("policy_denied", "terminal.binding_mismatch", "Terminal binding is outside the authorized project.")
    }
    return ok(new ScriptedTerminalChannel(this, reference, operation.clientId))
  }

  async resize(reference: TerminalReference, dimensions: TerminalDimensions, operation: TerminalOperationContext): Promise<Result<void>> {
    if (reference.terminalId !== this.reference?.terminalId || this.owner !== operation.clientId) {
      return fail("policy_denied", "terminal.input_not_owned", "Only the current owner may resize the process terminal.")
    }
    this.resizeCalls.push({ clientId: operation.clientId, dimensions: structuredClone(dimensions) })
    return ok(undefined)
  }

  async snapshot(reference: TerminalReference): Promise<Result<TerminalSnapshot>> {
    const data = Uint8Array.from(this.output.at(-1) ?? [])
    return ok(terminalSnapshotSchema.parse({
      schemaVersion: 1,
      terminalId: reference.terminalId,
      nodeId: reference.nodeId,
      projectId: reference.projectId,
      sessionId: reference.sessionId,
      capturedAt: "2026-09-17T00:10:00.000Z",
      byteCount: data.byteLength,
      truncated: false,
      data,
    }))
  }

  async detach(_reference: TerminalReference, operation: TerminalOperationContext): Promise<Result<void>> {
    this.detachCalls.push(operation.clientId)
    if (this.owner === operation.clientId) this.owner = null
    return ok(undefined)
  }

  async terminate(): Promise<Result<void>> {
    this.terminateCount += 1
    return ok(undefined)
  }

  async recover(operation: TerminalOperationContext): Promise<Result<TerminalReference[]>> {
    this.recoverCount += 1
    if (!this.reference) return ok([])
    return this.reference.projectId === operation.projectId && this.reference.nodeId === operation.nodeId
      ? ok([structuredClone(this.reference)])
      : ok([])
  }
}

export class ScriptedRuntime implements AgentRuntimeAdapter {
  readonly kind = "scripted-opencode"
  readonly capabilities = runtimeCapabilitiesSchema.parse({
    structuredPermissions: true,
    nativeSessionRestore: true,
    reliableCompletion: true,
    modelSelection: true,
    usageData: false,
    hooks: false,
    transcriptExport: false,
  })
  launchMode: "started" | "timeout" | "throw" | "failed" = "started"
  readonly launches: LaunchAgentRequest[] = []
  readonly responses: AgentResponse[] = []
  readonly observations: AgentRuntimeEvent[] = []
  readonly restored: RuntimeSessionReference[] = []
  interruptCount = 0
  terminateCount = 0
  private eventSequence = 0
  private session: RuntimeSession | null = null
  private collected: AgentResult = agentResultSchema.parse({
    schemaVersion: 1,
    outcome: "unknown",
    summary: "No verified completion evidence is available.",
  })

  constructor(private readonly terminal: ScriptedTerminalBackend) {}

  async detect() { return ok([]) }

  async launch(request: LaunchAgentRequest): Promise<Result<RuntimeSession>> {
    this.launches.push(structuredClone(request))
    if (this.launchMode === "throw") throw new Error("fixture provider transport details")
    if (this.launchMode === "timeout") return fail("timeout", "fixture.launch_timeout", "Launch acknowledgement timed out.")
    if (this.launchMode === "failed") return fail("runtime_failure", "fixture.launch_failed", "Launch was rejected before admission.")
    const reference = this.terminal.provision(request)
    this.session = runtimeSessionSchema.parse({
      schemaVersion: 1,
      sessionId: reference.sessionId,
      projectId: request.operation.projectId,
      runId: request.operation.runId,
      taskId: request.dispatchEnvelope.taskId,
      dispatchId: request.operation.dispatchId,
      nodeId: request.operation.nodeId,
      installationId: request.dispatchEnvelope.installationId,
      runtimeKind: request.dispatchEnvelope.runtimeKind,
      lifecycleState: "launching",
      observedState: "starting",
      terminalId: reference.terminalId,
    })
    return ok(this.session)
  }

  async restore(reference: RuntimeSessionReference): Promise<Result<RuntimeSession>> {
    this.restored.push(structuredClone(reference))
    return this.session ? ok(structuredClone(this.session)) : fail("runtime_failure", "fixture.restore_missing", "Session is unavailable.")
  }

  async prompt(_session: RuntimeSession, _request: PromptRequest): Promise<Result<void>> { return ok(undefined) }

  async *observe(): AsyncIterable<Result<AgentRuntimeEvent>> {
    const event = this.observations.shift()
    if (event) yield ok(event)
  }

  async respond(_session: RuntimeSession, response: AgentResponse): Promise<Result<void>> {
    this.responses.push(structuredClone(response))
    return ok(undefined)
  }

  async interrupt(): Promise<Result<void>> {
    this.interruptCount += 1
    return ok(undefined)
  }

  async terminate(): Promise<Result<void>> {
    this.terminateCount += 1
    return ok(undefined)
  }

  async collectResult(): Promise<Result<AgentResult>> { return ok(structuredClone(this.collected)) }

  queueLifecycle(state: RuntimeSession["observedState"]): void {
    this.observations.push(this.event({ type: "lifecycle", state, detail: `fixture ${state}` }))
  }

  queuePermission(requestId = "permission-m1"): string {
    this.observations.push(this.event({ type: "permission_requested", permission: "filesystem.write", requestId }))
    return requestId
  }

  queueResult(result: AgentResult): void {
    this.collected = agentResultSchema.parse(result)
    this.observations.push(this.event({ type: "result_available", result: this.collected }))
  }

  private event(payload: { type: "lifecycle"; state: RuntimeSession["observedState"]; detail: string } | { type: "permission_requested"; permission: string; requestId: string } | { type: "result_available"; result: AgentResult }): AgentRuntimeEvent {
    if (!this.session) throw new Error("launch a fixture session before queuing observations")
    const base = {
      schemaVersion: 1 as const,
      eventId: `runtime-event-m1-${++this.eventSequence}`,
      projectId: this.session.projectId,
      runId: this.session.runId,
      taskId: this.session.taskId,
      dispatchId: this.session.dispatchId,
      sessionId: this.session.sessionId,
      nodeId: this.session.nodeId,
      occurredAt: "2026-09-17T00:10:00.000Z",
    }
    return agentRuntimeEventSchema.parse({ ...base, ...payload })
  }
}

export class ManualScheduler implements TerminalControllerScheduler {
  private readonly tasks: Array<() => void> = []
  schedule(task: () => void): void { this.tasks.push(task) }
  get size(): number { return this.tasks.length }
  flush(): void { for (const task of this.tasks.splice(0)) task() }
}

export class RecordingTerminalView implements TerminalViewPort {
  readonly models: TerminalViewModel[] = []
  render(model: TerminalViewModel): void { this.models.push(structuredClone(model)) }
}

export class ScriptedRenderer implements TuiRenderer {
  readonly renders: string[] = []
  destroyCount = 0
  private keyListener?: (key: KeyEvent) => void
  private resizeListener?: (dimensions: TuiDimensions) => void
  private pasteListener?: (event: PasteEvent) => void
  private mouseListener?: (event: MouseEvent) => void
  private errorListener?: (error: Error) => void

  constructor(readonly dimensions: TuiDimensions = { columns: 120, rows: 40 }) {}

  render(content: string): void { this.renders.push(content) }
  onKey(listener: (key: KeyEvent) => void): () => void {
    this.keyListener = listener
    return () => { this.keyListener = undefined }
  }
  onPaste(listener: (event: PasteEvent) => void): () => void {
    this.pasteListener = listener
    return () => { this.pasteListener = undefined }
  }
  onMouseUp(listener: (event: MouseEvent) => void): () => void {
    this.mouseListener = listener
    return () => { this.mouseListener = undefined }
  }
  onResize(listener: (dimensions: TuiDimensions) => void): () => void {
    this.resizeListener = listener
    return () => { this.resizeListener = undefined }
  }
  onRenderError(listener: (error: Error) => void): () => void {
    this.errorListener = listener
    return () => { this.errorListener = undefined }
  }
  destroy(): void { this.destroyCount += 1 }

  key(name: string, options: { ctrl?: boolean; shift?: boolean; sequence?: string } = {}): void {
    this.keyListener?.({ name, ...options } as KeyEvent)
  }
  type(text: string): void {
    for (const character of text) this.key(character, { sequence: character })
  }
  paste(text: string): void { this.pasteListener?.({ bytes: new TextEncoder().encode(text) } as PasteEvent) }
  click(x: number, y: number): void { this.mouseListener?.({ x, y, type: "up", button: 0 } as MouseEvent) }
  resize(dimensions: TuiDimensions): void { this.resizeListener?.(dimensions) }
  fail(message: string): void { this.errorListener?.(new Error(message)) }
}

export class M1Harness {
  readonly clock = new DeterministicClock()
  readonly ids = new DeterministicIds()
  readonly projects = new ScriptedProjectRegistry()
  readonly terminal = new ScriptedTerminalBackend()
  readonly runtime = new ScriptedRuntime(this.terminal)
  readonly service: InMemoryLocalApplicationService
  private operationSequence = 0

  constructor() {
    this.service = this.newService()
  }

  newService(): InMemoryLocalApplicationService {
    const dependencies: LocalApplicationDependencies = {
      runtime: this.runtime,
      terminal: this.terminal,
      clock: this.clock,
      ids: this.ids,
      projects: this.projects,
    }
    return new InMemoryLocalApplicationService(dependencies)
  }

  operationId(): CommandId {
    return commandIdSchema.parse(`operation-m1-${++this.operationSequence}`)
  }

  terminalOperation(clientId: TerminalClientId = primaryClientId): TerminalOperationContext {
    return {
      schemaVersion: 1,
      commandId: this.operationId(),
      correlationId,
      projectId: this.projects.current.project.projectId,
      nodeId: this.projects.current.nodeContext.nodeId,
      clientId,
    }
  }
}

export function text(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value)
}

export async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

export async function waitForShell(service: LocalApplicationService, predicate: () => boolean): Promise<void> {
  void service
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await settle()
  }
  throw new Error("scripted shell did not reach the expected state")
}

export function errorOf(result: Result<unknown>): ContractError {
  if (result.ok) throw new Error("expected fixture operation to fail")
  return result.error
}

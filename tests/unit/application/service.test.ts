import { describe, expect, it } from "vitest"
import { InMemoryLocalApplicationService } from "../../../src/application/service.js"
import type {
  ApplicationIdSource,
  LaunchPathAuthorizationRequest,
  LocalApplicationDependencies,
  LocalProjectDefinition,
  LocalProjectRegistry,
} from "../../../src/application/types.js"
import { digestDispatchEnvelope, digestJson } from "../../../src/orchestration/digest.js"
import { contractErrorSchema, type Result } from "../../../src/orchestration/errors.js"
import {
  commandIdSchema,
  correlationIdSchema,
  projectIdSchema,
  terminalClientIdSchema,
  userIdSchema,
} from "../../../src/orchestration/identifiers.js"
import {
  agentResultSchema,
  agentRuntimeEventSchema,
  runtimeCapabilitiesSchema,
  runtimeSessionSchema,
  type AgentResult,
  type AgentRuntimeEvent,
  type LaunchAgentRequest,
  type RuntimeSession,
} from "../../../src/runtime/schemas.js"
import type { AgentRuntimeAdapter } from "../../../src/runtime/types.js"
import {
  terminalInputOwnershipSchema,
  terminalReferenceSchema,
  terminalSnapshotSchema,
  type CreateTerminalRequest,
  type InputTakeoverRequest,
  type TerminalControlOperationContext,
  type TerminalDimensions,
  type TerminalOperationContext,
  type TerminalReference,
} from "../../../src/terminal/schemas.js"
import type { TerminalBackend, TerminalChannel } from "../../../src/terminal/types.js"

const correlationId = correlationIdSchema.parse("correlation-app-test")
const userId = userIdSchema.parse("user-app-test")
const clientId = terminalClientIdSchema.parse("client-app-test")

function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

function err(
  category: "policy_denied" | "runtime_failure" | "timeout" | "conflict",
  code: string,
  message: string,
): Result<never> {
  return {
    ok: false,
    error: contractErrorSchema.parse({
      schemaVersion: 1,
      category,
      code,
      message,
      retryable: category === "runtime_failure" || category === "timeout",
      correlationId,
    }),
  }
}

function requireOk<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.category}:${result.error.code}`)
  return result.value
}

class IDs implements ApplicationIdSource {
  count = 0
  next(kind: string): string {
    this.count += 1
    return `${kind}-${this.count}`
  }
}

class FakeRuntime implements AgentRuntimeAdapter {
  readonly kind = "fake-runtime"
  readonly capabilities = runtimeCapabilitiesSchema.parse({
    structuredPermissions: true,
    nativeSessionRestore: false,
    reliableCompletion: true,
    modelSelection: true,
    usageData: false,
    hooks: false,
    transcriptExport: false,
  })
  launches: LaunchAgentRequest[] = []
  interruptCount = 0
  terminateCount = 0
  respondCount = 0
  launchMode: "success" | "throw" | "timeout" | "failure" = "success"
  controlMode: "success" | "timeout" = "success"
  observed: AgentRuntimeEvent[] = []
  result: AgentResult = agentResultSchema.parse({ schemaVersion: 1, outcome: "unknown", summary: "No verified result." })
  includeTerminal = true

  async detect() { return ok([]) }

  async launch(request: LaunchAgentRequest): Promise<Result<RuntimeSession>> {
    this.launches.push(structuredClone(request))
    if (this.launchMode === "throw") throw new Error("provider detail must not escape")
    if (this.launchMode === "timeout") return err("timeout", "fake.timeout", "Launch response timed out.")
    if (this.launchMode === "failure") return err("runtime_failure", "fake.failed", "Launch was rejected before process creation.")
    return ok(runtimeSessionSchema.parse({
      schemaVersion: 1,
      sessionId: "session-runtime-1",
      projectId: request.operation.projectId,
      runId: request.operation.runId,
      taskId: request.dispatchEnvelope.taskId,
      dispatchId: request.operation.dispatchId,
      nodeId: request.operation.nodeId,
      installationId: request.dispatchEnvelope.installationId,
      runtimeKind: request.dispatchEnvelope.runtimeKind,
      state: "starting",
      ...(this.includeTerminal ? { terminalId: "terminal-runtime-1" } : {}),
    }))
  }

  async restore(): Promise<Result<RuntimeSession>> { return err("policy_denied", "fake.restore", "Restore unavailable.") }
  async prompt(): Promise<Result<void>> { return ok(undefined) }

  async *observe(): AsyncIterable<Result<AgentRuntimeEvent>> {
    const next = this.observed.shift()
    if (next) yield ok(next)
  }

  async respond(): Promise<Result<void>> {
    this.respondCount += 1
    return this.controlMode === "success" ? ok(undefined) : err("timeout", "fake.control_timeout", "Control timed out.")
  }

  async interrupt(): Promise<Result<void>> {
    this.interruptCount += 1
    return this.controlMode === "success" ? ok(undefined) : err("timeout", "fake.control_timeout", "Control timed out.")
  }

  async terminate(): Promise<Result<void>> {
    this.terminateCount += 1
    return this.controlMode === "success" ? ok(undefined) : err("timeout", "fake.control_timeout", "Control timed out.")
  }

  async collectResult(): Promise<Result<AgentResult>> { return ok(this.result) }
}

class FakeChannel implements TerminalChannel {
  readonly clientId = clientId
  constructor(readonly reference: TerminalReference) {}
  async read() { return ok(new Uint8Array()) }
  async write() { return ok(undefined) }
  async requestInputOwnership(_operation?: TerminalOperationContext) { return ok(terminalInputOwnershipSchema.parse({ schemaVersion: 1, terminalId: this.reference.terminalId, ownerClientId: clientId, changedAt: "2026-09-17T00:00:00.000Z" })) }
  async releaseInputOwnership() { return ok(terminalInputOwnershipSchema.parse({ schemaVersion: 1, terminalId: this.reference.terminalId, ownerClientId: null, changedAt: "2026-09-17T00:00:00.000Z" })) }
  async takeOverInput(_request: InputTakeoverRequest) { return this.requestInputOwnership({} as TerminalOperationContext) }
}

class FakeTerminal implements TerminalBackend {
  readonly kind = "fake-terminal"
  recovered: TerminalReference[] = []
  createCalls: CreateTerminalRequest[] = []
  async create(request: CreateTerminalRequest) {
    this.createCalls.push(structuredClone(request))
    return ok(terminalReferenceSchema.parse({
      schemaVersion: 1,
      terminalId: request.terminalId,
      nodeId: request.operation.nodeId,
      projectId: request.operation.projectId,
      sessionId: request.sessionId,
      backendKind: this.kind,
      adapterMetadata: { fixture: "application" },
    }))
  }
  async attach(reference: TerminalReference) { return ok(new FakeChannel(reference)) }
  async resize(_reference: TerminalReference, _dimensions: TerminalDimensions, _operation: TerminalOperationContext) { return ok(undefined) }
  async snapshot(reference: TerminalReference) { return ok(terminalSnapshotSchema.parse({ schemaVersion: 1, terminalId: reference.terminalId, nodeId: reference.nodeId, projectId: reference.projectId, sessionId: reference.sessionId, capturedAt: "2026-09-17T00:00:00.000Z", byteCount: 0, truncated: false, data: new Uint8Array() })) }
  async detach() { return ok(undefined) }
  async terminate(_reference: TerminalReference, _operation: TerminalControlOperationContext) { return ok(undefined) }
  async recover() { return ok(this.recovered) }
}

function definition(): LocalProjectDefinition {
  const emptyDigest = digestJson({ references: [] })
  const permissionEnvelope = {
    allowedCapabilities: ["filesystem.read"],
    deniedCapabilities: ["network.external"],
    approvalRequirements: { destructiveEffects: true, externalEffects: true, capabilities: [] },
  }
  return {
    project: {
      schemaVersion: 1,
      projectId: projectIdSchema.parse("project-local"),
      meshId: "mesh-local" as never,
      name: "Local project",
      pathBindings: [{
        schemaVersion: 1,
        projectPathId: "path-local" as never,
        projectId: "project-local" as never,
        nodeId: "node-local" as never,
        configuredPath: "/workspace/local",
        allowedCapabilities: ["filesystem.read"],
      }],
    },
    projectPathId: "path-local" as never,
    nodeContext: { schemaVersion: 1, nodeId: "node-local" as never, meshId: "mesh-local" as never, platform: "test", architecture: "test" },
    installation: {
      schemaVersion: 1,
      installationId: "installation-local" as never,
      nodeId: "node-local" as never,
      runtimeKind: "fake-runtime",
      displayName: "Fake runtime",
      capabilities: runtimeCapabilitiesSchema.parse({
        structuredPermissions: true,
        nativeSessionRestore: false,
        reliableCompletion: true,
        modelSelection: true,
        usageData: false,
        hooks: false,
        transcriptExport: false,
      }),
    },
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "role-local" as never,
      templateVersion: 1,
      projectId: "project-local" as never,
      name: "Local role",
      purpose: "Complete one local task.",
      instructions: "Work only in the authorized project.",
      requiredCapabilities: ["filesystem.read"],
      preferredRuntimeKinds: ["fake-runtime"],
      contextSelectionPolicyReference: { namespace: "test", id: "none" },
      permissionRestrictions: permissionEnvelope,
      author: { kind: "system", name: "test" },
      createdAt: "2026-09-17T00:00:00.000Z",
    },
    ruleSnapshots: [],
    contextManifest: { references: [], manifestDigest: emptyDigest },
    requestedCapabilities: ["filesystem.read"],
    permissionEnvelope,
    availableModels: ["model-a", "model-b"],
    controller: { controllerNodeId: "node-local" as never, controllerEpoch: 1, leaseId: "lease-local" as never },
  }
}

class FakeProjects implements LocalProjectRegistry {
  current = definition()
  authorizeCalls: LaunchPathAuthorizationRequest[] = []
  denyLaunch = false
  async listAuthorizedProjects() { return ok([this.current]) }
  async getAuthorizedProject(projectId: typeof this.current.project.projectId) {
    return projectId === this.current.project.projectId ? ok(this.current) : err("policy_denied", "fake.project", "Project denied.")
  }
  async authorizeLaunchPath(request: LaunchPathAuthorizationRequest) {
    this.authorizeCalls.push(structuredClone(request))
    if (this.denyLaunch) return err("policy_denied", "fake.path_denied", "Project path authorization changed.")
    return ok({ ...request, realPath: request.configuredPath })
  }
}

function setup() {
  const runtime = new FakeRuntime()
  const terminal = new FakeTerminal()
  const projects = new FakeProjects()
  const deps: LocalApplicationDependencies = {
    runtime,
    terminal,
    projects,
    ids: new IDs(),
    clock: { now: () => "2026-09-17T00:00:00.000Z" },
  }
  return { service: new InMemoryLocalApplicationService(deps), runtime, terminal, projects }
}

let operation = 0
function op() {
  operation += 1
  return commandIdSchema.parse(`operation-${operation}`)
}

async function drafted(service: InMemoryLocalApplicationService) {
  const projectId = projectIdSchema.parse("project-local")
  requireOk(await service.execute({ type: "projects.select", projectId, correlationId }))
  const draft = requireOk(await service.execute({ type: "draft.create", operationId: op(), correlationId, projectId }))
  return requireOk(await service.execute({
    type: "draft.edit",
    operationId: op(),
    correlationId,
    runId: draft.runId,
    expectedRevision: draft.revision,
    patch: {
      goal: "Verify the local application service",
      taskTitle: "Run one task",
      taskDescription: "Exercise the local vertical slice.",
      prompt: "Inspect the project and report a verified result.",
      model: "model-a",
      timeoutSeconds: 900,
    },
  }))
}

async function proposed(service: InMemoryLocalApplicationService) {
  const draft = await drafted(service)
  return requireOk(await service.execute({ type: "proposal.create", operationId: op(), correlationId, runId: draft.runId, expectedRevision: draft.revision }))
}

async function approved(service: InMemoryLocalApplicationService) {
  const snapshot = await proposed(service)
  const proposal = snapshot.currentProposal!
  return requireOk(await service.execute({
    type: "proposal.decide",
    operationId: op(),
    correlationId,
    runId: snapshot.draft.runId,
    dispatchId: proposal.dispatch.envelope.dispatchId,
    attempt: proposal.dispatch.envelope.attempt,
    envelopeDigest: proposal.dispatch.envelopeDigest,
    decision: "approved",
    userId,
  }))
}

async function launched(service: InMemoryLocalApplicationService) {
  const snapshot = await approved(service)
  const proposal = snapshot.currentProposal!
  return requireOk(await service.execute({
    type: "dispatch.launch",
    operationId: op(),
    correlationId,
    runId: snapshot.draft.runId,
    dispatchId: proposal.dispatch.envelope.dispatchId,
    envelopeDigest: proposal.dispatch.envelopeDigest,
    approvalId: proposal.approval!.approvalId,
  }))
}

describe("InMemoryLocalApplicationService", () => {
  it("lists only validated project summaries and creates a canonical immutable proposal", async () => {
    const { service } = setup()
    const listed = requireOk(await service.execute({ type: "projects.list", correlationId }))
    expect(listed).toEqual([expect.objectContaining({ name: "Local project", pathLabel: "/workspace/local", runtimeKind: "fake-runtime" })])

    const snapshot = await proposed(service)
    const proposal = snapshot.currentProposal!
    expect(proposal.dispatch.envelope.attempt).toBe(1)
    expect(proposal.dispatch.envelopeDigest).toBe(digestDispatchEnvelope(proposal.dispatch.envelope))
    expect(proposal.dispatch.envelope.prompt).toContain("Inspect the project")
    expect(service.events(snapshot.draft.runId).map((event) => event.type)).toEqual([
      "run.created", "task.created", "dispatch.proposed",
    ])
  })

  it("binds approval to the exact dispatch and admits an idempotent launch only once", async () => {
    const { service, runtime, projects } = setup()
    const snapshot = await approved(service)
    const proposal = snapshot.currentProposal!
    const launchOperation = op()
    const command = {
      type: "dispatch.launch" as const,
      operationId: launchOperation,
      correlationId,
      runId: snapshot.draft.runId,
      dispatchId: proposal.dispatch.envelope.dispatchId,
      envelopeDigest: proposal.dispatch.envelopeDigest,
      approvalId: proposal.approval!.approvalId,
    }
    const first = requireOk(await service.execute(command))
    const duplicate = requireOk(await service.execute(structuredClone(command)))

    expect(first.outcome).toBe("started")
    expect(duplicate).toEqual(first)
    expect(runtime.launches).toHaveLength(1)
    expect(projects.authorizeCalls).toHaveLength(1)

    const replay = await service.execute({ ...command, operationId: op() })
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.error.code).toBe("application.launch.already_attempted")
    expect(runtime.launches).toHaveLength(1)
  })

  it("provisions and binds a terminal when the runtime does not supply one", async () => {
    const { service, runtime, terminal } = setup()
    runtime.includeTerminal = false
    const result = await launched(service)
    expect(result.outcome).toBe("started")
    expect(terminal.createCalls).toHaveLength(1)
    expect(result.snapshot.session?.terminalId).toBe(terminal.createCalls[0]!.terminalId)
    expect(terminal.createCalls[0]).toMatchObject({
      sessionId: result.snapshot.session?.sessionId,
      operation: { projectId: result.snapshot.draft.projectId, controllerAuthority: { controllerEpoch: 1 } },
    })
  })

  it("invalidates approval and allocates a new dispatch/attempt when a proposal is revised", async () => {
    const { service } = setup()
    const first = await approved(service)
    const original = first.currentProposal!
    const revised = requireOk(await service.execute({
      type: "proposal.revise",
      operationId: op(),
      correlationId,
      runId: first.draft.runId,
      dispatchId: original.dispatch.envelope.dispatchId,
      envelopeDigest: original.dispatch.envelopeDigest,
      patch: { prompt: "Use the revised, materially different prompt." },
    }))

    expect(revised.proposalHistory[0].approval?.decision).toBe("approved")
    expect(revised.currentProposal!.approval).toBeUndefined()
    expect(revised.currentProposal!.dispatch.envelope.attempt).toBe(2)
    expect(revised.currentProposal!.dispatch.envelope.dispatchId).not.toBe(original.dispatch.envelope.dispatchId)
    expect(revised.currentProposal!.dispatch.envelopeDigest).not.toBe(original.dispatch.envelopeDigest)

    const stale = await service.execute({
      type: "dispatch.launch",
      operationId: op(),
      correlationId,
      runId: first.draft.runId,
      dispatchId: original.dispatch.envelope.dispatchId,
      envelopeDigest: original.dispatch.envelopeDigest,
      approvalId: original.approval!.approvalId,
    })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.category).toBe("conflict")
  })

  it("invalidates launch authority as soon as proposal revision begins", async () => {
    const { service, runtime } = setup()
    const snapshot = await approved(service)
    const proposal = snapshot.currentProposal!

    const editing = requireOk(await service.execute({
      type: "proposal.begin-revision",
      operationId: op(),
      correlationId,
      runId: snapshot.draft.runId,
      dispatchId: proposal.dispatch.envelope.dispatchId,
      envelopeDigest: proposal.dispatch.envelopeDigest,
    }))
    expect(editing.draft.proposalRequired).toBe(true)
    expect(editing.currentProposal!.approval).toEqual(proposal.approval)

    const staleLaunch = await service.execute({
      type: "dispatch.launch",
      operationId: op(),
      correlationId,
      runId: snapshot.draft.runId,
      dispatchId: proposal.dispatch.envelope.dispatchId,
      envelopeDigest: proposal.dispatch.envelopeDigest,
      approvalId: proposal.approval!.approvalId,
    })
    expect(staleLaunch.ok).toBe(false)
    if (!staleLaunch.ok) expect(staleLaunch.error.code).toBe("application.launch.revision_pending")
    expect(runtime.launches).toHaveLength(0)
  })

  it("keeps rejected history auditable and requires a fresh decision after revision", async () => {
    const { service, runtime } = setup()
    const pending = await proposed(service)
    const proposal = pending.currentProposal!
    const rejected = requireOk(await service.execute({
      type: "proposal.decide",
      operationId: op(), correlationId, runId: pending.draft.runId,
      dispatchId: proposal.dispatch.envelope.dispatchId,
      attempt: 1,
      envelopeDigest: proposal.dispatch.envelopeDigest,
      decision: "rejected",
      userId,
    }))
    const revised = requireOk(await service.execute({
      type: "proposal.revise",
      operationId: op(), correlationId, runId: pending.draft.runId,
      dispatchId: proposal.dispatch.envelope.dispatchId,
      envelopeDigest: proposal.dispatch.envelopeDigest,
      patch: { goal: "A revised goal" },
    }))
    expect(rejected.currentProposal!.dispatch.state).toBe("rejected")
    expect(revised.proposalHistory[0].approval?.decision).toBe("rejected")
    expect(revised.currentProposal!.dispatch.state).toBe("proposed")
    expect(runtime.launches).toHaveLength(0)
  })

  it("rechecks realpath authorization immediately before launch and fails closed", async () => {
    const { service, runtime, projects } = setup()
    const snapshot = await approved(service)
    projects.denyLaunch = true
    const proposal = snapshot.currentProposal!
    const result = await service.execute({
      type: "dispatch.launch", operationId: op(), correlationId, runId: snapshot.draft.runId,
      dispatchId: proposal.dispatch.envelope.dispatchId,
      envelopeDigest: proposal.dispatch.envelopeDigest,
      approvalId: proposal.approval!.approvalId,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ category: "policy_denied", code: "fake.path_denied" })
    expect(projects.authorizeCalls).toHaveLength(1)
    expect(runtime.launches).toHaveLength(0)
  })

  it("invalidates launch admission when material project policy changes after approval", async () => {
    const { service, runtime, projects } = setup()
    const snapshot = await approved(service)
    const proposal = snapshot.currentProposal!
    projects.current = {
      ...projects.current,
      roleSnapshot: {
        ...projects.current.roleSnapshot,
        templateVersion: 2,
        instructions: "Updated instructions require a fresh proposal and approval.",
      },
    }
    const result = await service.execute({
      type: "dispatch.launch", operationId: op(), correlationId, runId: snapshot.draft.runId,
      dispatchId: proposal.dispatch.envelope.dispatchId,
      envelopeDigest: proposal.dispatch.envelopeDigest,
      approvalId: proposal.approval!.approvalId,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({
      category: "approval_required",
      code: "application.proposal.configuration_changed",
    })
    expect(runtime.launches).toHaveLength(0)
    const current = requireOk(await service.execute({ type: "run.get", runId: snapshot.draft.runId, correlationId }))
    expect(current.draft.proposalRequired).toBe(true)
  })

  it("records an uncertain launch and never replays it after a thrown or timed-out effect", async () => {
    for (const mode of ["throw", "timeout"] as const) {
      const { service, runtime } = setup()
      runtime.launchMode = mode
      const snapshot = await approved(service)
      const proposal = snapshot.currentProposal!
      const first = requireOk(await service.execute({
        type: "dispatch.launch", operationId: op(), correlationId, runId: snapshot.draft.runId,
        dispatchId: proposal.dispatch.envelope.dispatchId,
        envelopeDigest: proposal.dispatch.envelopeDigest,
        approvalId: proposal.approval!.approvalId,
      }))
      expect(first.outcome).toBe("unknown")
      const replay = await service.execute({
        type: "dispatch.launch", operationId: op(), correlationId, runId: snapshot.draft.runId,
        dispatchId: proposal.dispatch.envelope.dispatchId,
        envelopeDigest: proposal.dispatch.envelopeDigest,
        approvalId: proposal.approval!.approvalId,
      })
      expect(replay.ok).toBe(false)
      expect(runtime.launches).toHaveLength(1)
    }
  })

  it("retries a definite failed attempt only through a fresh proposal and approval", async () => {
    const { service, runtime } = setup()
    runtime.launchMode = "failure"
    const snapshot = await approved(service)
    const proposal = snapshot.currentProposal!
    const failed = requireOk(await service.execute({
      type: "dispatch.launch", operationId: op(), correlationId, runId: snapshot.draft.runId,
      dispatchId: proposal.dispatch.envelope.dispatchId,
      envelopeDigest: proposal.dispatch.envelopeDigest,
      approvalId: proposal.approval!.approvalId,
    }))
    expect(failed.outcome).toBe("failed")
    expect(failed.snapshot.run?.state).toBe("failed")

    const retry = requireOk(await service.execute({
      type: "proposal.revise", operationId: op(), correlationId, runId: snapshot.draft.runId,
      dispatchId: proposal.dispatch.envelope.dispatchId,
      envelopeDigest: proposal.dispatch.envelopeDigest,
      patch: { prompt: "Retry through a new reviewed proposal." },
    }))
    expect(retry.currentProposal!.dispatch.envelope.attempt).toBe(2)
    expect(retry.currentProposal!.approval).toBeUndefined()
    expect(retry.run?.state).toBe("draft")
    expect(runtime.launches).toHaveLength(1)
  })

  it("does not treat a completed-looking lifecycle event as success without result evidence", async () => {
    const { service, runtime } = setup()
    const launch = await launched(service)
    if (launch.outcome !== "started") throw new Error("expected launch")
    const snapshot = launch.snapshot
    const session = snapshot.session!
    runtime.observed.push(agentRuntimeEventSchema.parse({
      schemaVersion: 1,
      eventId: "runtime-event-completed",
      projectId: session.projectId,
      runId: session.runId,
      taskId: session.taskId,
      dispatchId: session.dispatchId,
      sessionId: session.sessionId,
      nodeId: session.nodeId,
      occurredAt: "2026-09-17T00:00:00.000Z",
      type: "lifecycle",
      state: "completed",
    }))
    const refreshed = requireOk(await service.execute({ type: "session.refresh", operationId: op(), correlationId, runId: snapshot.draft.runId }))
    expect(refreshed.session?.state).toBe("unknown")
    expect(refreshed.run?.state).toBe("active")

    runtime.result = agentResultSchema.parse({
      schemaVersion: 1,
      outcome: "succeeded",
      summary: "Verified provider completion.",
      completionEvidence: { kind: "reliable_provider", mechanism: "fake completion event" },
    })
    const result = requireOk(await service.execute({ type: "result.get", operationId: op(), correlationId, runId: snapshot.draft.runId }))
    expect(result.snapshot.session?.state).toBe("completed")
    expect(result.snapshot.run?.state).toBe("completed")
    expect(result.result.outcome).toBe("succeeded")
  })

  it("exposes and clears a bounded permission request through the typed response command", async () => {
    const { service, runtime } = setup()
    const launch = await launched(service)
    if (launch.outcome !== "started") throw new Error("expected launch")
    const session = launch.snapshot.session!
    runtime.observed.push(agentRuntimeEventSchema.parse({
      schemaVersion: 1,
      eventId: "runtime-event-permission",
      projectId: session.projectId,
      runId: session.runId,
      taskId: session.taskId,
      dispatchId: session.dispatchId,
      sessionId: session.sessionId,
      nodeId: session.nodeId,
      occurredAt: "2026-09-17T00:00:00.000Z",
      type: "permission_requested",
      permission: "OpenCode permission request",
      requestId: "permission-request-1",
    }))
    const blocked = requireOk(await service.execute({ type: "session.refresh", operationId: op(), correlationId, runId: launch.snapshot.draft.runId }))
    expect(blocked).toMatchObject({ session: { state: "blocked" }, pendingRequest: { requestId: "permission-request-1" } })
    const response = requireOk(await service.execute({
      type: "session.respond",
      operationId: op(),
      correlationId,
      runId: launch.snapshot.draft.runId,
      requestId: "permission-request-1",
      decision: "allow_once",
    }))
    expect(response.outcome).toBe("confirmed")
    expect(response.snapshot.pendingRequest).toBeUndefined()
  })

  it("cancels unlaunched work without runtime effects and keeps uncertain live cancellation visible", async () => {
    const first = setup()
    const pending = await proposed(first.service)
    const cancelled = requireOk(await first.service.execute({ type: "run.cancel", operationId: op(), correlationId, runId: pending.draft.runId, reason: "User cancelled." }))
    expect(cancelled.outcome).toBe("confirmed")
    expect(cancelled.snapshot.run?.state).toBe("cancelled")
    expect(first.runtime.interruptCount).toBe(0)

    const approvedRun = setup()
    const approvedSnapshot = await approved(approvedRun.service)
    const approvedProposal = approvedSnapshot.currentProposal!
    requireOk(await approvedRun.service.execute({ type: "run.cancel", operationId: op(), correlationId, runId: approvedSnapshot.draft.runId, reason: "Cancel before launch." }))
    const blockedLaunch = await approvedRun.service.execute({
      type: "dispatch.launch",
      operationId: op(),
      correlationId,
      runId: approvedSnapshot.draft.runId,
      dispatchId: approvedProposal.dispatch.envelope.dispatchId,
      envelopeDigest: approvedProposal.dispatch.envelopeDigest,
      approvalId: approvedProposal.approval!.approvalId,
    })
    expect(blockedLaunch).toMatchObject({ ok: false, error: { code: "application.launch.cancelled" } })
    expect(approvedRun.runtime.launches).toHaveLength(0)

    const second = setup()
    const active = await launched(second.service)
    if (active.outcome !== "started") throw new Error("expected launch")
    second.runtime.controlMode = "timeout"
    const uncertain = requireOk(await second.service.execute({ type: "run.cancel", operationId: op(), correlationId, runId: active.snapshot.draft.runId, reason: "Stop work." }))
    expect(uncertain.outcome).toBe("unknown")
    expect(uncertain.snapshot.cancellation.state).toBe("unknown")
    expect(uncertain.snapshot.run?.state).toBe("active")
    expect(uncertain.snapshot.session?.state).toBe("unknown")
  })

  it("returns bounded recovery summaries and quarantines cross-project references", async () => {
    const { service, terminal } = setup()
    terminal.recovered = [
      terminalReferenceSchema.parse({
        schemaVersion: 1,
        terminalId: "terminal-recovered",
        nodeId: "node-local",
        projectId: "project-local",
        sessionId: "session-recovered",
        backendKind: "fake-terminal",
        adapterMetadata: { pane: "safe-internal-value" },
      }),
      terminalReferenceSchema.parse({
        schemaVersion: 1,
        terminalId: "terminal-foreign",
        nodeId: "node-foreign",
        projectId: "project-local",
        sessionId: "session-foreign",
        backendKind: "fake-terminal",
        adapterMetadata: { pane: "foreign" },
      }),
    ]
    const recovered = requireOk(await service.execute({ type: "sessions.recover", operationId: op(), correlationId, clientId }))
    expect(recovered.quarantinedCount).toBe(1)
    expect(recovered.sessions).toEqual([expect.objectContaining({
      sessionId: "session-recovered",
      runtimeState: "unknown",
      historyAvailable: false,
      mutationAllowed: false,
      attachmentMode: "read-only",
    })])
    expect(JSON.stringify(recovered)).not.toContain("safe-internal-value")
  })

  it("rejects reuse of an operation ID with changed command content", async () => {
    const { service } = setup()
    const projectId = projectIdSchema.parse("project-local")
    requireOk(await service.execute({ type: "projects.select", projectId, correlationId }))
    const operationId = op()
    const first = await service.execute({ type: "draft.create", operationId, correlationId, projectId, timeoutSeconds: 10 })
    expect(first.ok).toBe(true)
    const changed = await service.execute({ type: "draft.create", operationId, correlationId, projectId, timeoutSeconds: 20 })
    expect(changed.ok).toBe(false)
    if (!changed.ok) expect(changed.error.code).toBe("application.command.id_reused")
  })
})

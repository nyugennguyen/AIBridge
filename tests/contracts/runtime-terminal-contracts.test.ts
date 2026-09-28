import { describe, expect, it } from "vitest"
import { contractErrorSchema, type Result } from "../../src/orchestration/errors.js"
import {
  agentResultSchema,
  agentRuntimeEventSchema,
  runtimeCapabilitiesSchema,
  runtimeOperationContextSchema,
  runtimeSessionSchema,
} from "../../src/runtime/schemas.js"
import type { AgentRuntimeAdapter } from "../../src/runtime/types.js"
import {
  inputTakeoverRequestSchema,
  createTerminalRequestSchema,
  terminalControlOperationContextSchema,
  terminalOperationContextSchema,
  terminalReferenceSchema,
  terminalSnapshotSchema,
  type TerminalControlOperationContext,
  type TerminalInputOwnership,
  type TerminalOperationContext,
  type TerminalReference,
} from "../../src/terminal/schemas.js"
import type { TerminalBackend, TerminalChannel } from "../../src/terminal/types.js"

const unsupported = (code: string): Result<never> => ({
  ok: false,
  error: contractErrorSchema.parse({
    schemaVersion: 1,
    category: "unsupported_capability",
    code,
    message: "The fake intentionally does not support this optional operation.",
    retryable: false,
    correlationId: "correlation-1",
  }),
})

const policyDenied = (code: string): Result<never> => ({
  ok: false,
  error: contractErrorSchema.parse({
    schemaVersion: 1,
    category: "policy_denied",
    code,
    message: "This terminal client does not own input.",
    retryable: false,
    correlationId: "correlation-1",
  }),
})

const runtimeSession = runtimeSessionSchema.parse({
  schemaVersion: 1,
  sessionId: "session-1",
  projectId: "project-1",
  runId: "run-1",
  taskId: "task-1",
  dispatchId: "dispatch-1",
  nodeId: "node-1",
  installationId: "installation-1",
  runtimeKind: "fake-runtime",
  lifecycleState: "launching",
  observedState: "unknown",
})

const fakeRuntime: AgentRuntimeAdapter = {
  kind: "fake-runtime",
  capabilities: runtimeCapabilitiesSchema.parse({
    structuredPermissions: false,
    nativeSessionRestore: false,
    reliableCompletion: false,
    modelSelection: false,
    usageData: false,
    hooks: false,
    transcriptExport: false,
  }),
  async detect() {
    return { ok: true, value: [] }
  },
  async launch() {
    return { ok: true, value: runtimeSession }
  },
  async restore() {
    return unsupported("runtime.restore.unsupported")
  },
  async prompt() {
    return unsupported("runtime.prompt.unsupported")
  },
  async *observe() {
    yield {
      ok: true,
      value: agentRuntimeEventSchema.parse({
        schemaVersion: 1,
        eventId: "event-1",
        projectId: "project-1",
        runId: "run-1",
        taskId: "task-1",
        dispatchId: "dispatch-1",
        sessionId: "session-1",
        nodeId: "node-1",
        occurredAt: "2026-09-16T00:00:00Z",
        type: "lifecycle",
        state: "unknown",
      }),
    }
  },
  async respond() {
    return unsupported("runtime.respond.unsupported")
  },
  async interrupt() {
    return unsupported("runtime.interrupt.unsupported")
  },
  async terminate() {
    return unsupported("runtime.terminate.unsupported")
  },
  async collectResult() {
    return unsupported("runtime.collect-result.unsupported")
  },
}

const reference = terminalReferenceSchema.parse({
  schemaVersion: 1,
  terminalId: "terminal-1",
  nodeId: "node-1",
  projectId: "project-1",
  sessionId: "session-1",
  backendKind: "memory",
  adapterMetadata: { handle: "local-1" },
})

const operation = (clientId: string): TerminalOperationContext =>
  terminalOperationContextSchema.parse({
    schemaVersion: 1,
    commandId: `command-${clientId}`,
    correlationId: "correlation-1",
    projectId: "project-1",
    nodeId: "node-1",
    clientId,
  })

const controlOperation = (clientId: string): TerminalControlOperationContext =>
  terminalControlOperationContextSchema.parse({
    ...operation(clientId),
    controllerAuthority: {
      controllerNodeId: "node-1",
      controllerEpoch: 1,
      leaseId: "lease-1",
    },
  })

const runtimeOperation = (commandId: string) =>
  runtimeOperationContextSchema.parse({
    schemaVersion: 1,
    commandId: `runtime-${commandId}`,
    correlationId: "correlation-1",
    projectId: "project-1",
    runId: "run-1",
    dispatchId: "dispatch-1",
    nodeId: "node-1",
    controllerNodeId: "node-1",
    controllerEpoch: 1,
    leaseId: "lease-1",
  })

function failureCategory(result: Result<unknown>): string {
  if (result.ok) throw new Error("Expected a typed contract failure")
  return result.error.category
}

class InMemoryTerminalBackend implements TerminalBackend {
  readonly kind = "memory"
  private owner: TerminalOperationContext["clientId"] | null = null
  private attached = new Map<TerminalOperationContext["clientId"], symbol>()
  private terminated = false

  private ownership(): TerminalInputOwnership {
    return {
      schemaVersion: 1,
      terminalId: reference.terminalId,
      ownerClientId: this.owner,
      changedAt: "2026-09-16T00:00:00Z",
    }
  }

  async create() {
    return { ok: true as const, value: reference }
  }

  async attach(terminal: TerminalReference, context: TerminalOperationContext) {
    if (terminal.terminalId !== reference.terminalId || context.projectId !== reference.projectId || context.nodeId !== reference.nodeId) {
      return policyDenied("terminal.attach.scope")
    }
    if (this.terminated) return policyDenied("terminal.attach.terminated")
    const attachment = Symbol(context.clientId)
    this.attached.set(context.clientId, attachment)
    return { ok: true as const, value: this.channel(context.clientId, attachment) }
  }

  async resize() {
    return { ok: true as const, value: undefined }
  }

  async snapshot(terminal: TerminalReference, context: TerminalOperationContext) {
    if (terminal.projectId !== context.projectId || terminal.nodeId !== context.nodeId || this.terminated) {
      return policyDenied("terminal.snapshot.scope")
    }
    return {
      ok: true as const,
      value: terminalSnapshotSchema.parse({
        schemaVersion: 1,
        terminalId: terminal.terminalId,
        nodeId: terminal.nodeId,
        projectId: terminal.projectId,
        sessionId: terminal.sessionId,
        capturedAt: "2026-09-16T00:00:00Z",
        byteCount: 0,
        truncated: false,
        data: new Uint8Array(),
      }),
    }
  }

  async detach(terminal: TerminalReference, context: TerminalOperationContext) {
    if (terminal.terminalId !== reference.terminalId) return policyDenied("terminal.detach.scope")
    this.attached.delete(context.clientId)
    if (this.owner === context.clientId) this.owner = null
    return { ok: true as const, value: undefined }
  }

  async terminate(_terminal: TerminalReference, _context: TerminalControlOperationContext) {
    this.terminated = true
    this.owner = null
    this.attached.clear()
    return { ok: true as const, value: undefined }
  }

  async recover(context: TerminalOperationContext) {
    if (context.projectId !== reference.projectId || context.nodeId !== reference.nodeId) {
      return policyDenied("terminal.recover.scope")
    }
    return { ok: true as const, value: this.terminated ? [] : [reference] }
  }

  private channel(clientId: TerminalOperationContext["clientId"], attachment: symbol): TerminalChannel {
    const isActive = () => !this.terminated && this.attached.get(clientId) === attachment
    return {
      reference,
      clientId,
      read: async () => ({ ok: true, value: new Uint8Array() }),
      write: async () =>
        isActive() && this.owner === clientId
          ? { ok: true, value: undefined }
          : policyDenied(isActive() ? "terminal.write.read-only" : "terminal.write.detached"),
      requestInputOwnership: async (context) => {
        if (!isActive()) return policyDenied("terminal.input.detached")
        if (context.clientId !== clientId) return policyDenied("terminal.input.client-mismatch")
        if (this.owner && this.owner !== clientId) {
          return {
            ok: false,
            error: contractErrorSchema.parse({
              schemaVersion: 1,
              category: "conflict",
              code: "terminal.input.already-owned",
              message: "Another terminal client owns input.",
              retryable: false,
              correlationId: context.correlationId,
            }),
          }
        }
        this.owner = clientId
        return { ok: true, value: this.ownership() }
      },
      releaseInputOwnership: async (context) => {
        if (!isActive()) return policyDenied("terminal.input.detached")
        if (context.clientId !== clientId || this.owner !== clientId) return policyDenied("terminal.input.not-owner")
        this.owner = null
        return { ok: true, value: this.ownership() }
      },
      takeOverInput: async (request) => {
        if (!isActive()) return policyDenied("terminal.takeover.detached")
        if (request.operation.clientId !== clientId) return policyDenied("terminal.takeover.client-mismatch")
        this.owner = clientId
        return { ok: true, value: this.ownership() }
      },
    }
  }
}

describe("runtime and terminal contracts", () => {
  it("keeps ambiguous lifecycle observations unknown and requires evidence for success", async () => {
    for await (const observed of fakeRuntime.observe(runtimeSession, runtimeOperation("observer"))) {
      expect(observed).toMatchObject({ ok: true, value: { type: "lifecycle", state: "unknown" } })
    }
    expect(
      agentResultSchema.safeParse({ schemaVersion: 1, outcome: "succeeded", summary: "No evidence supplied" }).success,
    ).toBe(false)
    expect(failureCategory(await fakeRuntime.collectResult(runtimeSession, runtimeOperation("reader")))).toBe("unsupported_capability")
  })

  it("defaults attachments to read-only and requires explicit, single-owner takeover", async () => {
    const backend = new InMemoryTerminalBackend()
    const owner = await backend.attach(reference, operation("owner"))
    const viewer = await backend.attach(reference, operation("viewer"))
    if (!owner.ok || !viewer.ok) throw new Error("Test setup failed")

    expect(failureCategory(await viewer.value.write(new Uint8Array([1])))).toBe("policy_denied")
    const claimed = await owner.value.requestInputOwnership(operation("owner"))
    if (!claimed.ok) throw new Error("Owner should be able to claim input")
    expect(claimed.value.ownerClientId).toBe("owner")
    expect(failureCategory(await viewer.value.requestInputOwnership(operation("viewer")))).toBe("conflict")
    const taken = await viewer.value.takeOverInput(
      inputTakeoverRequestSchema.parse({ schemaVersion: 1, operation: operation("viewer"), reason: "User requested control" }),
    )
    if (!taken.ok) throw new Error("Explicit takeover should succeed")
    expect(taken.value.ownerClientId).toBe("viewer")
    expect(failureCategory(await owner.value.write(new Uint8Array([1])))).toBe("policy_denied")

    await backend.detach(reference, operation("viewer"))
    expect(failureCategory(await viewer.value.requestInputOwnership(operation("viewer")))).toBe("policy_denied")
    const reattachedViewer = await backend.attach(reference, operation("viewer"))
    if (!reattachedViewer.ok) throw new Error("Viewer should be able to reattach")
    expect(
      failureCategory(
        await viewer.value.takeOverInput(
          inputTakeoverRequestSchema.parse({
            schemaVersion: 1,
            operation: operation("viewer"),
            reason: "Stale channel must not regain control",
          }),
        ),
      ),
    ).toBe("policy_denied")
    const reclaimed = await reattachedViewer.value.requestInputOwnership(operation("viewer"))
    if (!reclaimed.ok) throw new Error("Current attachment should be able to claim input")
    await backend.terminate(reference, controlOperation("owner"))
    expect(failureCategory(await reattachedViewer.value.write(new Uint8Array([1])))).toBe("policy_denied")
    expect(failureCategory(await reattachedViewer.value.releaseInputOwnership(operation("viewer")))).toBe("policy_denied")
    expect((await backend.snapshot(reference, operation("owner"))).ok).toBe(false)
    expect(
      createTerminalRequestSchema.safeParse({
        schemaVersion: 1,
        operation: operation("owner"),
        terminalId: "terminal-2",
        sessionId: "session-1",
        backendKind: "memory",
        columns: 80,
        rows: 24,
        bufferByteLimit: 1024,
      }).success,
    ).toBe(false)
    const foreignProject = terminalOperationContextSchema.parse({
      schemaVersion: 1,
      commandId: "command-foreign",
      correlationId: "correlation-1",
      projectId: "project-2",
      nodeId: "node-1",
      clientId: "viewer",
    })
    expect(failureCategory(await backend.recover(foreignProject))).toBe("policy_denied")
  })
})

/**
 * Sample third-party coding-agent runtime adapter (M8.7).
 *
 * INVARIANT: This adapter uses ONLY public SDK imports and contracts.
 * It contains ZERO imports from internal AIBridge engine subsystems.
 */

import {
  sdkOk,
  type SdkResult,
} from "./errors.js"
import type {
  AgentInstallation,
  AgentResponse,
  AgentResult,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  LaunchAgentRequest,
  NodeContext,
  PromptRequest,
  RuntimeCapabilities,
  RuntimeOperationContext,
  RuntimeSession,
  RuntimeSessionReference,
  InstallationId,
  EventId,
  SessionId,
} from "./types.js"

export class SampleEchoAdapter implements AgentRuntimeAdapter {
  readonly kind = "sample-echo"

  readonly capabilities: RuntimeCapabilities = {
    structuredPermissions: false,
    nativeSessionRestore: false,
    reliableCompletion: true,
    modelSelection: false,
    usageData: false,
    hooks: false,
    transcriptExport: false,
  }

  private readonly sessions = new Map<string, { prompt?: string; terminated: boolean }>()

  async detect(nodeContext: NodeContext): Promise<SdkResult<AgentInstallation[]>> {
    const installation: AgentInstallation = {
      schemaVersion: 1,
      installationId: `inst-${nodeContext.nodeId}-sample-echo` as unknown as InstallationId,
      nodeId: nodeContext.nodeId,
      runtimeKind: this.kind,
      displayName: "Sample Echo Adapter (SDK Reference)",
      capabilities: this.capabilities,
    }
    return sdkOk([installation])
  }

  async launch(request: LaunchAgentRequest): Promise<SdkResult<RuntimeSession>> {
    const sessionId = `ses-${request.operation.commandId}` as unknown as SessionId
    this.sessions.set(sessionId, { prompt: undefined, terminated: false })

    const session: RuntimeSession = {
      schemaVersion: 1,
      sessionId,
      projectId: request.operation.projectId,
      runId: request.operation.runId,
      taskId: request.dispatchEnvelope.taskId,
      dispatchId: request.operation.dispatchId,
      nodeId: request.operation.nodeId,
      installationId: request.dispatchEnvelope.installationId,
      runtimeKind: this.kind,
      lifecycleState: "running",
      observedState: "idle",
    }
    return sdkOk(session)
  }

  async restore(
    reference: RuntimeSessionReference,
    _operation: RuntimeOperationContext,
  ): Promise<SdkResult<RuntimeSession>> {
    const session: RuntimeSession = {
      ...reference,
      lifecycleState: "running",
      observedState: "idle",
    }
    this.sessions.set(session.sessionId, { prompt: undefined, terminated: false })
    return sdkOk(session)
  }

  async prompt(session: RuntimeSession, request: PromptRequest): Promise<SdkResult<void>> {
    const existing = this.sessions.get(session.sessionId)
    if (existing) {
      existing.prompt = request.prompt
    }
    return sdkOk(undefined)
  }

  async *observe(
    session: RuntimeSession,
    _operation: RuntimeOperationContext,
  ): AsyncIterable<SdkResult<AgentRuntimeEvent>> {
    const event: AgentRuntimeEvent = {
      schemaVersion: 1,
      eventId: `event-echo-${session.sessionId}` as unknown as EventId,
      projectId: session.projectId,
      runId: session.runId,
      taskId: session.taskId,
      dispatchId: session.dispatchId,
      sessionId: session.sessionId,
      nodeId: session.nodeId,
      occurredAt: new Date().toISOString(),
      type: "lifecycle",
      state: "working",
    }
    yield sdkOk(event)
  }

  async respond(_session: RuntimeSession, _response: AgentResponse): Promise<SdkResult<void>> {
    return sdkOk(undefined)
  }

  async interrupt(_session: RuntimeSession, _operation: RuntimeOperationContext): Promise<SdkResult<void>> {
    return sdkOk(undefined)
  }

  async terminate(session: RuntimeSession, _operation: RuntimeOperationContext): Promise<SdkResult<void>> {
    const existing = this.sessions.get(session.sessionId)
    if (existing) {
      existing.terminated = true
    }
    return sdkOk(undefined)
  }

  async collectResult(
    session: RuntimeSession,
    _operation: RuntimeOperationContext,
  ): Promise<SdkResult<AgentResult>> {
    const existing = this.sessions.get(session.sessionId)
    const result: AgentResult = {
      schemaVersion: 1,
      outcome: "succeeded",
      summary: `Echo summary for: ${existing?.prompt ?? "none"}`,
      completionEvidence: {
        kind: "reliable_provider",
        mechanism: "sample-echo",
      },
    }
    return sdkOk(result)
  }
}

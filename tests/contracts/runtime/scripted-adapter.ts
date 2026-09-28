import type { Result } from "../../../src/orchestration/errors.js"
import {
  agentInstallationSchema,
  agentRuntimeEventSchema,
  runtimeCapabilitiesSchema,
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
} from "../../../src/runtime/schemas.js"
import type { AgentRuntimeAdapter } from "../../../src/runtime/types.js"
import type { LifecycleScript } from "./lifecycle-dsl.js"

export interface ScriptedAdapterOptions {
  script: LifecycleScript
  nodeId?: string
  projectId?: string
  installationId?: string
  runtimeKind?: string
}

export class ScriptedAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly kind: string
  readonly capabilities = runtimeCapabilitiesSchema.parse({
    structuredPermissions: true,
    nativeSessionRestore: true,
    reliableCompletion: true,
    modelSelection: false,
    usageData: true,
    hooks: true,
    transcriptExport: false,
  })

  private readonly script: LifecycleScript
  private readonly nodeId: string
  private readonly projectId: string
  private readonly installationId: string
  private activeSession?: RuntimeSession
  private result?: AgentResult
  private promptsDelivered = 0
  private responsesReceived: AgentResponse[] = []

  constructor(options: ScriptedAdapterOptions) {
    this.script = options.script
    this.kind = options.runtimeKind ?? "scripted-runtime"
    this.nodeId = options.nodeId ?? "node-contract"
    this.projectId = options.projectId ?? "project-contract"
    this.installationId = options.installationId ?? "installation-contract"
  }

  get promptsCount(): number {
    return this.promptsDelivered
  }

  get responses(): AgentResponse[] {
    return [...this.responsesReceived]
  }

  async detect(nodeContext: NodeContext): Promise<Result<AgentInstallation[]>> {
    if (nodeContext.nodeId !== this.nodeId) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "policy_denied",
          code: "runtime.detect.node_scope",
          message: "Node scope mismatch",
          retryable: false,
        },
      }
    }
    return {
      ok: true,
      value: [
        agentInstallationSchema.parse({
          schemaVersion: 1,
          installationId: this.installationId,
          nodeId: this.nodeId,
          runtimeKind: this.kind,
          displayName: `Scripted Adapter (${this.script.name})`,
          capabilities: this.capabilities,
        }),
      ],
    }
  }

  async launch(request: LaunchAgentRequest): Promise<Result<RuntimeSession>> {
    if (request.dispatchEnvelope.projectId !== this.projectId) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "policy_denied",
          code: "runtime.launch.project_scope",
          message: "Project scope mismatch",
          retryable: false,
        },
      }
    }

    const session = runtimeSessionSchema.parse({
      schemaVersion: 1,
      sessionId: `session-scripted-001`,
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

    this.activeSession = session
    return { ok: true, value: session }
  }

  async restore(
    reference: RuntimeSessionReference,
    _operation: RuntimeOperationContext,
  ): Promise<Result<RuntimeSession>> {
    if (!this.activeSession || reference.sessionId !== this.activeSession.sessionId) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "policy_denied",
          code: "runtime.restore.unknown_session",
          message: "Unknown session",
          retryable: false,
        },
      }
    }
    return { ok: true, value: this.activeSession }
  }

  async prompt(_session: RuntimeSession, _request: PromptRequest): Promise<Result<void>> {
    this.promptsDelivered++
    return { ok: true, value: undefined }
  }

  async *observe(
    session: RuntimeSession,
    _operation: RuntimeOperationContext,
  ): AsyncIterable<Result<AgentRuntimeEvent>> {
    let eventSeq = 0

    for (const step of this.script.steps) {
      if (step.type === "delay") {
        await new Promise((resolve) => setTimeout(resolve, step.ms))
        continue
      }
      if (step.type === "disconnect") {
        yield {
          ok: true,
          value: agentRuntimeEventSchema.parse({
            schemaVersion: 1,
            eventId: `event-script-${++eventSeq}`,
            projectId: session.projectId,
            runId: session.runId,
            taskId: session.taskId,
            dispatchId: session.dispatchId,
            sessionId: session.sessionId,
            nodeId: session.nodeId,
            occurredAt: new Date().toISOString(),
            type: "lifecycle",
            state: "unknown",
            detail: "Script simulated disconnect",
            source: "hook",
            confidence: "tentative",
          }),
        }
        break
      }
      if (step.type === "state") {
        yield {
          ok: true,
          value: agentRuntimeEventSchema.parse({
            schemaVersion: 1,
            eventId: `event-script-${++eventSeq}`,
            projectId: session.projectId,
            runId: session.runId,
            taskId: session.taskId,
            dispatchId: session.dispatchId,
            sessionId: session.sessionId,
            nodeId: session.nodeId,
            occurredAt: new Date().toISOString(),
            type: "lifecycle",
            state: step.state,
            detail: step.detail,
            source: step.source ?? "hook",
            confidence: step.confidence ?? "authoritative",
          }),
        }
      }
      if (step.type === "permission_request") {
        yield {
          ok: true,
          value: agentRuntimeEventSchema.parse({
            schemaVersion: 1,
            eventId: `event-script-${++eventSeq}`,
            projectId: session.projectId,
            runId: session.runId,
            taskId: session.taskId,
            dispatchId: session.dispatchId,
            sessionId: session.sessionId,
            nodeId: session.nodeId,
            occurredAt: new Date().toISOString(),
            type: "permission_requested",
            permission: step.permission,
            requestId: step.requestId,
          }),
        }
      }
      if (step.type === "result") {
        this.result = step.result
        yield {
          ok: true,
          value: agentRuntimeEventSchema.parse({
            schemaVersion: 1,
            eventId: `event-script-${++eventSeq}`,
            projectId: session.projectId,
            runId: session.runId,
            taskId: session.taskId,
            dispatchId: session.dispatchId,
            sessionId: session.sessionId,
            nodeId: session.nodeId,
            occurredAt: new Date().toISOString(),
            type: "result_available",
            result: step.result,
          }),
        }
      }
    }
  }

  async respond(_session: RuntimeSession, response: AgentResponse): Promise<Result<void>> {
    this.responsesReceived.push(response)
    return { ok: true, value: undefined }
  }

  async interrupt(_session: RuntimeSession, _operation: RuntimeOperationContext): Promise<Result<void>> {
    return { ok: true, value: undefined }
  }

  async terminate(_session: RuntimeSession, _operation: RuntimeOperationContext): Promise<Result<void>> {
    return { ok: true, value: undefined }
  }

  async collectResult(_session: RuntimeSession, _operation: RuntimeOperationContext): Promise<Result<AgentResult>> {
    if (this.result) {
      return { ok: true, value: this.result }
    }
    return {
      ok: true,
      value: {
        schemaVersion: 1,
        outcome: "unknown",
        summary: "No completion result was produced by the scripted timeline",
      },
    }
  }
}

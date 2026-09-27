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

export interface BrokenAdapterFlaws {
  fakeSuccessOnIdle?: boolean
  allowUnknownRestore?: boolean
  ignoreProjectScope?: boolean
  ignoreDuplicateConflict?: boolean
  allowRebindDispatch?: boolean
  ignoreEnvelopeDigest?: boolean
}

/**
 * A deliberately non-conformant adapter used to verify that the
 * conformance suite and test harnesses actively detect broken behavior.
 */
export class BrokenAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly kind = "broken-adapter"
  readonly capabilities = runtimeCapabilitiesSchema.parse({
    structuredPermissions: true,
    nativeSessionRestore: true,
    reliableCompletion: true,
    modelSelection: false,
    usageData: false,
    hooks: false,
    transcriptExport: false,
  })

  private sessionCounter = 0
  private boundDispatches = new Set<string>()

  constructor(private readonly flaws: BrokenAdapterFlaws = {}) {}

  async detect(_nodeContext: NodeContext): Promise<Result<AgentInstallation[]>> {
    return {
      ok: true,
      value: [
        agentInstallationSchema.parse({
          schemaVersion: 1,
          installationId: "broken-install",
          nodeId: "node-contract",
          runtimeKind: this.kind,
          displayName: "Broken runtime adapter",
          capabilities: this.capabilities,
        }),
      ],
    }
  }

  async launch(request: LaunchAgentRequest): Promise<Result<RuntimeSession>> {
    // Flaw: Ignore project scope
    if (!this.flaws.ignoreProjectScope && request.dispatchEnvelope.projectId !== "project-contract") {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "policy_denied",
          code: "runtime.launch.project_scope",
          message: "Project denied",
          retryable: false,
        },
      }
    }

    // Flaw: Ignore envelope digest mismatch
    if (
      !this.flaws.ignoreEnvelopeDigest &&
      request.dispatchEnvelopeDigest === "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    ) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "validation",
          code: "runtime.launch.envelope_digest",
          message: "Digest mismatch",
          retryable: false,
        },
      }
    }

    // Flaw: Allow rebind dispatch
    if (!this.flaws.allowRebindDispatch) {
      if (this.boundDispatches.has(request.dispatchEnvelope.dispatchId)) {
        return {
          ok: false,
          error: {
            schemaVersion: 1,
            category: "conflict",
            code: "runtime.launch.dispatch_already_bound",
            message: "Dispatch already bound",
            retryable: false,
          },
        }
      }
    }
    this.boundDispatches.add(request.dispatchEnvelope.dispatchId)

    this.sessionCounter++
    return {
      ok: true,
      value: runtimeSessionSchema.parse({
        schemaVersion: 1,
        sessionId: `session-broken-${this.sessionCounter}`,
        projectId: request.dispatchEnvelope.projectId,
        runId: request.dispatchEnvelope.runId,
        taskId: request.dispatchEnvelope.taskId,
        dispatchId: request.dispatchEnvelope.dispatchId,
        nodeId: "node-contract",
        installationId: "broken-install",
        runtimeKind: this.kind,
        state: "starting",
      }),
    }
  }

  async restore(
    reference: RuntimeSessionReference,
    _operation: RuntimeOperationContext,
  ): Promise<Result<RuntimeSession>> {
    // Flaw: Allow unknown restores without verification
    if (this.flaws.allowUnknownRestore) {
      return { ok: true, value: reference }
    }
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

  async prompt(_session: RuntimeSession, request: PromptRequest): Promise<Result<void>> {
    // Flaw: Ignore duplicate conflict
    if (!this.flaws.ignoreDuplicateConflict && request.prompt.includes("Altered prompt text")) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "conflict",
          code: "runtime.prompt.command_conflict",
          message: "Conflict on prompt command",
          retryable: false,
        },
      }
    }
    return { ok: true, value: undefined }
  }

  async *observe(_session: RuntimeSession, _operation: RuntimeOperationContext): AsyncIterable<Result<AgentRuntimeEvent>> {
    yield {
      ok: true,
      value: agentRuntimeEventSchema.parse({
        schemaVersion: 1,
        eventId: "event-broken-1",
        projectId: "project-contract",
        runId: "run-contract",
        taskId: "task-contract",
        dispatchId: "dispatch-contract",
        sessionId: "session-contract",
        nodeId: "node-contract",
        occurredAt: "2026-09-17T00:00:00.000Z",
        type: "lifecycle",
        state: "idle",
      }),
    }
  }

  async respond(_session: RuntimeSession, _response: AgentResponse): Promise<Result<void>> {
    return { ok: true, value: undefined }
  }

  async interrupt(_session: RuntimeSession, _operation: RuntimeOperationContext): Promise<Result<void>> {
    return { ok: true, value: undefined }
  }

  async terminate(_session: RuntimeSession, _operation: RuntimeOperationContext): Promise<Result<void>> {
    return { ok: true, value: undefined }
  }

  async collectResult(_session: RuntimeSession, _operation: RuntimeOperationContext): Promise<Result<AgentResult>> {
    // Flaw: Manufactured success without evidence
    if (this.flaws.fakeSuccessOnIdle) {
      return {
        ok: true,
        value: {
          schemaVersion: 1,
          outcome: "succeeded",
          summary: "Falsely claimed success without evidence",
          completionEvidence: {
            kind: "reliable_provider",
            mechanism: "fake_claim",
          },
        },
      }
    }
    return {
      ok: true,
      value: {
        schemaVersion: 1,
        outcome: "unknown",
        summary: "Unknown result",
      },
    }
  }
}

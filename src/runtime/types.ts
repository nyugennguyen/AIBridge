import type { Result } from "../orchestration/errors.js"
import type {
  AgentInstallation,
  AgentResponse,
  AgentResult,
  AgentRuntimeEvent,
  LaunchAgentRequest,
  NodeContext,
  PromptRequest,
  RuntimeCapabilities,
  RuntimeOperationContext,
  RuntimeSession,
  RuntimeSessionReference,
} from "./schemas.js"

export type {
  AgentInstallation,
  AgentResponse,
  AgentResult,
  AgentRuntimeEvent,
  LaunchAgentRequest,
  NodeContext,
  PromptRequest,
  RuntimeCapabilities,
  RuntimeOperationContext,
  RuntimeSession,
  RuntimeSessionReference,
} from "./schemas.js"

/**
 * Provider-neutral boundary for a locally installed coding-agent runtime.
 * Expected runtime failures are returned as Result errors; implementations may
 * throw only for contract violations or internal programmer failures.
 */
export interface AgentRuntimeAdapter {
  readonly kind: string
  readonly capabilities: RuntimeCapabilities

  detect(nodeContext: NodeContext): Promise<Result<AgentInstallation[]>>
  launch(request: LaunchAgentRequest): Promise<Result<RuntimeSession>>
  restore(
    reference: RuntimeSessionReference,
    operation: RuntimeOperationContext,
  ): Promise<Result<RuntimeSession>>
  prompt(session: RuntimeSession, request: PromptRequest): Promise<Result<void>>
  observe(
    session: RuntimeSession,
    operation: RuntimeOperationContext,
  ): AsyncIterable<Result<AgentRuntimeEvent>>
  respond(session: RuntimeSession, response: AgentResponse): Promise<Result<void>>
  interrupt(session: RuntimeSession, operation: RuntimeOperationContext): Promise<Result<void>>
  terminate(session: RuntimeSession, operation: RuntimeOperationContext): Promise<Result<void>>
  collectResult(
    session: RuntimeSession,
    operation: RuntimeOperationContext,
  ): Promise<Result<AgentResult>>
}

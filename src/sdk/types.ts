/**
 * AIBridge Extension SDK — Public types and contracts (M8.7).
 */

import type { AgentRuntimeAdapter } from "../runtime/types.js"
import type { TerminalBackend, TerminalChannel } from "../terminal/types.js"
import type { SdkContractError, SdkResult } from "./errors.js"

export const AIBRIDGE_SDK_VERSION = "1.0.0"

export type {
  AgentRuntimeAdapter,
  TerminalBackend,
  TerminalChannel,
  SdkContractError,
  SdkResult,
}

export type {
  AdapterCapabilityReport,
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
} from "../runtime/schemas.js"

export type {
  CreateTerminalRequest,
  InputTakeoverRequest,
  TerminalDimensions,
  TerminalInputOwnership,
  TerminalControlOperationContext,
  TerminalOperationContext,
  TerminalReference,
  TerminalSnapshot,
} from "../terminal/schemas.js"

export type {
  InstallationId,
  EventId,
  SessionId,
  NodeId,
  TaskId,
  RunId,
  CommandId,
  CorrelationId,
  ProjectId,
  LeaseId,
  ApprovalId,
  MeshId,
  TerminalClientId,
} from "../orchestration/identifiers.js"

export interface ExtensionMetadata {
  readonly name: string
  readonly version: string
  readonly aibridgeSdkVersion: string
  readonly description?: string
  readonly author?: string
}

export interface AdapterRegistration {
  readonly metadata: ExtensionMetadata
  readonly adapter: AgentRuntimeAdapter
}

export interface TerminalBackendRegistration {
  readonly metadata: ExtensionMetadata
  readonly backend: TerminalBackend
}

export function assertSdkVersionCompatible(extensionSdkVersion: string): void {
  const [extMajor] = extensionSdkVersion.split(".")
  const [sdkMajor] = AIBRIDGE_SDK_VERSION.split(".")
  if (extMajor !== sdkMajor) {
    throw new Error(
      `Incompatible AIBridge SDK version: extension targets ${extensionSdkVersion}, host provides ${AIBRIDGE_SDK_VERSION}. Major version mismatch.`,
    )
  }
}

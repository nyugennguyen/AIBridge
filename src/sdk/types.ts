/**
 * AIBridge Extension SDK — Public types and contracts (M8.7).
 */

import type { AgentRuntimeAdapter } from "../runtime/types.js"
import type { SdkContractError, SdkResult } from "./errors.js"

export const AIBRIDGE_SDK_VERSION = "1.0.0"

export type {
  AgentRuntimeAdapter,
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

export function assertSdkVersionCompatible(extensionSdkVersion: string): void {
  const [extMajor] = extensionSdkVersion.split(".")
  const [sdkMajor] = AIBRIDGE_SDK_VERSION.split(".")
  if (extMajor !== sdkMajor) {
    throw new Error(
      `Incompatible AIBridge SDK version: extension targets ${extensionSdkVersion}, host provides ${AIBRIDGE_SDK_VERSION}. Major version mismatch.`,
    )
  }
}

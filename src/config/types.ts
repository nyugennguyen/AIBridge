import type { z } from "zod"
import type {
  authModeSchema,
  agentConfigSchema,
  allowedSourceSchema,
  bridgeConfigSchema,
  bridgeRuntimeKindSchema,
  capabilityProfileSchema,
  claudeConfigSchema,
  claudeSettingSourceSchema,
  nodeRoleSchema,
  planMetadataSchema,
  projectConfigSchema,
  remoteDependencySchema,
  repositoryConfigSchema,
  scriptResultSchema,
  reportCallbackSchema,
  runtimeConfigSchema,
  triggerRequestSchema,
  terminalBackendSchema,
  terminalConfigSchema,
  triggerResponseSchema,
} from "./schemas.js"

export type AgentConfig = z.infer<typeof agentConfigSchema>
export type AllowedSource = z.infer<typeof allowedSourceSchema>
export type AuthMode = z.infer<typeof authModeSchema>
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>
export type BridgeRuntimeKind = z.infer<typeof bridgeRuntimeKindSchema>
export type CapabilityProfile = z.infer<typeof capabilityProfileSchema>
export type ClaudeConfig = z.infer<typeof claudeConfigSchema>
export type ClaudeSettingSource = z.infer<typeof claudeSettingSourceSchema>
export type NodeRole = z.infer<typeof nodeRoleSchema>
export type PlanMetadata = z.infer<typeof planMetadataSchema>
export type ProjectConfig = z.infer<typeof projectConfigSchema>
export type RemoteDependency = z.infer<typeof remoteDependencySchema>
export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>
export type ScriptResult = z.infer<typeof scriptResultSchema>
export type ReportCallback = z.infer<typeof reportCallbackSchema>
export type ReportFinding = ReportCallback["findings"][number]
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>
export type TriggerRequest = z.infer<typeof triggerRequestSchema>
export type TriggerResponse = z.infer<typeof triggerResponseSchema>
export type TerminalBackendKind = z.infer<typeof terminalBackendSchema>
export type TerminalConfig = z.infer<typeof terminalConfigSchema>

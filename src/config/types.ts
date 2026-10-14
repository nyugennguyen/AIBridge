import type { z } from "zod"
import type {
  authModeSchema,
  agentConfigSchema,
  allowedSourceSchema,
  bridgeConfigSchema,
  planMetadataSchema,
  projectConfigSchema,
  remoteDependencySchema,
  triggerRequestSchema,
  terminalBackendSchema,
  terminalConfigSchema,
  triggerResponseSchema,
} from "./schemas.js"

export type AgentConfig = z.infer<typeof agentConfigSchema>
export type AllowedSource = z.infer<typeof allowedSourceSchema>
export type AuthMode = z.infer<typeof authModeSchema>
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>
export type PlanMetadata = z.infer<typeof planMetadataSchema>
export type ProjectConfig = z.infer<typeof projectConfigSchema>
export type RemoteDependency = z.infer<typeof remoteDependencySchema>
export type TriggerRequest = z.infer<typeof triggerRequestSchema>
export type TriggerResponse = z.infer<typeof triggerResponseSchema>
export type TerminalBackendKind = z.infer<typeof terminalBackendSchema>
export type TerminalConfig = z.infer<typeof terminalConfigSchema>

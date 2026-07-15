import type { z } from "zod"
import type {
  agentConfigSchema,
  allowedSourceSchema,
  bridgeConfigSchema,
  planMetadataSchema,
  projectConfigSchema,
  remoteDependencySchema,
  triggerRequestSchema,
  triggerResponseSchema,
} from "./schemas.js"

export type AgentConfig = z.infer<typeof agentConfigSchema>
export type AllowedSource = z.infer<typeof allowedSourceSchema>
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>
export type PlanMetadata = z.infer<typeof planMetadataSchema>
export type ProjectConfig = z.infer<typeof projectConfigSchema>
export type RemoteDependency = z.infer<typeof remoteDependencySchema>
export type TriggerRequest = z.infer<typeof triggerRequestSchema>
export type TriggerResponse = z.infer<typeof triggerResponseSchema>

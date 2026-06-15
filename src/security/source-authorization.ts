import type { AllowedSource } from "../config/types.js"

export function assertSourceAuthorized(sourceAgentId: string, capability: string, allowedSources: AllowedSource[]): AllowedSource {
  const source = allowedSources.find((candidate) => candidate.source_agent_id === sourceAgentId)
  if (!source || !source.capabilities.includes(capability)) {
    throw new Error(`Source ${sourceAgentId} is not authorized for capability ${capability}`)
  }
  return source
}

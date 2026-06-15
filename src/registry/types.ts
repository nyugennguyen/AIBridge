import type { AgentConfig } from "../config/types.js"

export interface AgentRegistry {
  getAgent(id: string): AgentConfig
  listAgents(): AgentConfig[]
  findByCapability(capability: string): AgentConfig[]
}

import type { AgentConfig } from "../config/types.js"
import type { AgentRegistry } from "./types.js"

export class ConfigAgentRegistry implements AgentRegistry {
  constructor(private readonly agents: AgentConfig[]) {}

  getAgent(id: string): AgentConfig {
    const agent = this.agents.find((candidate) => candidate.id === id)
    if (!agent) throw new Error(`Unknown agent: ${id}`)
    return agent
  }

  listAgents(): AgentConfig[] {
    return [...this.agents]
  }

  findByCapability(capability: string): AgentConfig[] {
    return this.agents.filter((agent) => agent.capabilities.includes(capability))
  }
}

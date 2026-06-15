import type { AgentConfig } from "../config/types.js"
import type { AgentRegistry } from "./types.js"

export class CapabilityRouter {
  constructor(private readonly registry: AgentRegistry) {}

  resolve(targetAgentId: string, capability: string): AgentConfig {
    const agent = this.registry.getAgent(targetAgentId)
    if (!agent.capabilities.includes(capability)) {
      throw new Error(`Agent ${targetAgentId} does not provide capability ${capability}`)
    }
    return agent
  }

  routeByCapability(capability: string): AgentConfig {
    const [agent] = this.registry.findByCapability(capability)
    if (!agent) throw new Error(`No agent provides capability ${capability}`)
    return agent
  }
}

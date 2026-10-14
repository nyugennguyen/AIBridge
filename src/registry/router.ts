import type { AgentConfig } from "../config/types.js"
import { resolveLiveCandidates } from "./config-registry.js"
import type { AgentRegistry, MeshNodeProvider } from "./types.js"

/**
 * Capability-based agent router.
 *
 * Routes requests to agents by matching required capabilities against live mesh nodes
 * intersected with configured agent definitions.
 *
 * Dependency injection: `CapabilityRouter` receives an `AgentRegistry` and an optional
 * `MeshNodeProvider`. Routing resolves candidates against the mesh provider to ensure
 * candidates are actively online and advertising the capability.
 *
 * Failing closed: if the mesh registry is empty or the provider throws/fails, routing
 * returns no candidates and throws rather than falling back to stale static config.
 */
export class CapabilityRouter {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly meshNodeProvider?: MeshNodeProvider,
  ) {}

  /**
   * Resolves an explicit target agent by id and verifies that it provides the capability.
   */
  resolve(targetAgentId: string, capability: string): AgentConfig {
    const agent = this.registry.getAgent(targetAgentId)
    if (!agent.capabilities.includes(capability)) {
      throw new Error(`Agent ${targetAgentId} does not provide capability ${capability}`)
    }
    return agent
  }

  /**
   * Routes by capability, resolving against live mesh nodes intersected with configured agents.
   *
   * Fails closed (throws `No agent provides capability`) when:
   * - The mesh registry is empty.
   * - The mesh node provider throws or fails.
   * - A configured agent is not present in the live mesh.
   * - No matching agent satisfies both config and live advertisement.
   */
  routeByCapability(capability: string, meshNodeProvider?: MeshNodeProvider): AgentConfig {
    const provider = meshNodeProvider ?? this.meshNodeProvider
    const candidates = provider
      ? resolveLiveCandidates(this.registry.listAgents(), provider, capability)
      : this.registry.findByCapability(capability)

    const [agent] = candidates
    if (!agent) throw new Error(`No agent provides capability ${capability}`)
    return agent
  }
}

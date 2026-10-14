import type { AgentConfig } from "../config/types.js"
import { isNodeLive, type AgentRegistry, type LiveMeshNode, type MeshNodeProvider } from "./types.js"

/**
 * # Why Capability Routing Fails Closed on Empty or Failing Mesh Providers
 *
 * ConfigAgentRegistry holds static `AgentConfig` records loaded from configuration files.
 * These records represent declared capability expectations — what an operator intends for
 * an agent to provide when running.
 *
 * However, static configuration is entirely blind to real-world operational facts:
 * - A configured machine may be offline, suspended, or partitioned from the mesh.
 * - An agent's runtime process may have crashed or failed heartbeat renewal.
 * - A node key may have been revoked due to compromise or decommissioning.
 * - A dynamically updated node may have altered its active capability advertisement.
 *
 * If capability routing fell back to static configuration when the mesh registry is empty
 * or when the `MeshNodeProvider` fails/throws, the router would dispatch work to dead or
 * non-existent nodes. This would result in message drops, silent job stalls, or routing loops.
 *
 * Therefore, routing MUST fail closed:
 * 1. If no mesh provider is supplied, or the provider fails/throws, or returns an empty list,
 *    `findByCapability` returns NO candidates (`[]`).
 * 2. Candidates are strictly drawn from the intersection of configured capability expectations
 *    AND live, reachable mesh nodes currently advertising the required capability.
 * 3. A candidate absent from the live mesh is NEVER routed to, even if present in static config.
 */

/**
 * Resolves candidate agents by intersecting configured agent expectations
 * with currently live/reachable mesh nodes advertising the capability.
 *
 * Fails closed (returns `[]`) if the provider throws, returns no nodes, or if
 * no live mesh node matching the configured expectations is found.
 */
export function resolveLiveCandidates(
  agents: readonly AgentConfig[],
  meshNodeProvider: MeshNodeProvider,
  capability: string,
): AgentConfig[] {
  let liveNodes: readonly LiveMeshNode[]
  try {
    liveNodes = meshNodeProvider.getLiveNodes()
  } catch {
    // Failing mesh provider: fail closed and return no candidates rather than
    // falling back to stale config-only candidates. A provider failure means
    // mesh reachability cannot be confirmed. Dispatching to unverified nodes
    // could result in silent job failure or partitioned execution.
    return []
  }

  if (!Array.isArray(liveNodes) || liveNodes.length === 0) {
    // Empty mesh registry: fail closed. No live nodes exist on the mesh.
    return []
  }

  // Collect live/reachable nodes that advertise the requested capability
  const liveCandidateMap = new Map<string, LiveMeshNode>()
  for (const node of liveNodes) {
    if (isNodeLive(node) && node.capabilities.includes(capability)) {
      liveCandidateMap.set(node.nodeId, node)
    }
  }

  if (liveCandidateMap.size === 0) {
    return []
  }

  // Intersect with configured agents: an agent must exist in config with the
  // capability AND be currently live on the mesh advertising that capability.
  return agents.filter(
    (agent) => liveCandidateMap.has(agent.id) && agent.capabilities.includes(capability),
  )
}

export class ConfigAgentRegistry implements AgentRegistry {
  constructor(
    private readonly agents: AgentConfig[],
    private readonly meshNodeProvider?: MeshNodeProvider,
  ) {}

  getAgent(id: string): AgentConfig {
    const agent = this.agents.find((candidate) => candidate.id === id)
    if (!agent) throw new Error(`Unknown agent: ${id}`)
    return agent
  }

  listAgents(): AgentConfig[] {
    return [...this.agents]
  }

  /**
   * Finds agents providing the requested capability, intersected with live mesh nodes.
   *
   * Fails closed (returns `[]`) when:
   * - No mesh node provider is available.
   * - The mesh provider fails or throws.
   * - The mesh provider returns an empty node list.
   * - Configured agents are absent from the live mesh registry.
   */
  findByCapability(capability: string, meshNodeProvider?: MeshNodeProvider): AgentConfig[] {
    const provider = meshNodeProvider ?? this.meshNodeProvider
    if (!provider) {
      // Fail closed: without a mesh provider, live node presence cannot be confirmed.
      return []
    }
    return resolveLiveCandidates(this.agents, provider, capability)
  }
}

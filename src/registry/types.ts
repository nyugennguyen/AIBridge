import { z } from "zod"
import type { AgentConfig } from "../config/types.js"

/**
 * Schema for a node observed in the live mesh registry.
 *
 * Inferred as `LiveMeshNode`. Captures node identity, capabilities advertised to
 * the mesh, and reachability. Routing resolves against this live view rather than
 * relying solely on static configuration.
 */
export const liveMeshNodeSchema = z.object({
  nodeId: z.string().min(1),
  capabilities: z.array(z.string()).readonly(),
  reachability: z.union([z.string(), z.boolean()]).optional(),
  livenessState: z.string().optional(),
  liveness: z.string().optional(),
  healthy: z.boolean().optional(),
})

export type LiveMeshNode = z.infer<typeof liveMeshNodeSchema>

/**
 * Injected provider of current mesh nodes.
 *
 * Upholds dependency injection: AgentRegistry and CapabilityRouter receive mesh
 * state through this port rather than reaching into any global singleton.
 */
export interface MeshNodeProvider {
  /**
   * Returns current nodes known to the mesh.
   * Throws if the registry read fails or store is unreachable.
   */
  getLiveNodes(): readonly LiveMeshNode[]
}

/**
 * Determines whether a LiveMeshNode is currently online/reachable.
 *
 * Respects explicit reachability, livenessState, liveness, and healthy flags.
 * If none are provided, node presence in the live provider implies reachability.
 */
export function isNodeLive(node: LiveMeshNode): boolean {
  if (node.reachability !== undefined) {
    if (typeof node.reachability === "string") {
      const state = node.reachability.toLowerCase()
      return state === "live" || state === "reachable"
    }
    return Boolean(node.reachability)
  }
  if (node.livenessState !== undefined) {
    return node.livenessState === "live"
  }
  if (node.liveness !== undefined) {
    return node.liveness === "live"
  }
  if (node.healthy !== undefined) {
    return Boolean(node.healthy)
  }
  return true
}

export interface AgentRegistry {
  getAgent(id: string): AgentConfig
  listAgents(): AgentConfig[]
  findByCapability(capability: string, meshNodeProvider?: MeshNodeProvider): AgentConfig[]
}

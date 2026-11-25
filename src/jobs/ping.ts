/**
 * `aibr ping`: a no-op job that exercises the real path a job takes.
 *
 * The caller sends a normal, signed `/trigger` with the reserved capability
 * {@link PING_CAPABILITY}. The worker runs the same checks every trigger gets
 * (bearer, node signature, target id, the caller is an `allowed_sources` entry),
 * then completes the job at once — no runtime, no project directory, no kernel
 * run — and delivers the `/report` callback like any finished job. The caller
 * polls `GET /jobs/:id` and sees both halves: the job completed (request path
 * works) and `callbackDelivery` (the report reached it, or why not).
 *
 * The capability is reserved: it is not a capability profile and not something
 * `allowed_sources[].capabilities` must list. Any enrolled source may ping.
 */
import type { BridgeConfig } from "../config/types.js"
import type { PongInfo } from "./types.js"

export const PING_CAPABILITY = "aibr.ping"

/** What the worker tells an enrolled caller about itself. */
export function buildPong(config: BridgeConfig, sourceAgentId: string, version: string): PongInfo {
  const source = config.security.allowed_sources.find((s) => s.source_agent_id === sourceAgentId)
  return {
    agent_id: config.agent_id,
    role: config.role ?? "worker",
    runtime: config.runtime?.kind ?? "opencode",
    version,
    capabilities: [...(source?.capabilities ?? [])],
    projects: config.projects.map((project) => ({ id: project.id, path: project.path, capabilities: [...project.capabilities] })),
  }
}

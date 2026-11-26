/**
 * Node role and worker runtime: what this machine does on the mesh.
 *
 * - `worker`       receives jobs and runs them with a local agent runtime
 *                  (`opencode` or `claude`). The released behaviour.
 * - `orchestrator` dispatches work from Claude Code; it runs no runtime of its
 *                  own, so it needs neither opencode nor a supervisor unit.
 * - `both`         the union of the two.
 *
 * Written into the profile as top-level `role` and `runtime: { kind }` keys.
 * `bridgeConfigSchema` is a non-strict object, so these keys survive a parse of
 * the current schema; a profile written before they existed reads back as
 * worker + opencode, which is exactly what it was.
 */

export const NODE_ROLES = ["worker", "orchestrator", "both"] as const
export type NodeRole = (typeof NODE_ROLES)[number]

export const RUNTIME_KINDS = ["opencode", "claude"] as const
export type RuntimeKind = (typeof RUNTIME_KINDS)[number]

export const DEFAULT_NODE_ROLE: NodeRole = "worker"
export const DEFAULT_RUNTIME_KIND: RuntimeKind = "opencode"

/** Parse an operator's answer or a config value; `null` when it is neither. */
export function parseNodeRole(raw: unknown): NodeRole | null {
  if (typeof raw !== "string") return null
  const value = raw.trim().toLowerCase()
  if (value === "w") return "worker"
  if (value === "o") return "orchestrator"
  if (value === "b") return "both"
  return (NODE_ROLES as readonly string[]).includes(value) ? (value as NodeRole) : null
}

/** Parse an operator's answer or a config value; `null` when it is neither. */
export function parseRuntimeKind(raw: unknown): RuntimeKind | null {
  if (typeof raw !== "string") return null
  const value = raw.trim().toLowerCase()
  if (value === "claude-code") return "claude"
  return (RUNTIME_KINDS as readonly string[]).includes(value) ? (value as RuntimeKind) : null
}

/** True when the role runs jobs locally and therefore has a runtime. */
export function roleRunsJobs(role: NodeRole): boolean {
  return role === "worker" || role === "both"
}

/**
 * The role and runtime a profile declares, defaulting the way an old profile
 * must be read: no `role` key means worker, no `runtime.kind` means opencode.
 * `runtime` is `null` for an orchestrator, which runs no jobs.
 */
export function nodeRoleFromConfig(config: Record<string, unknown> | null | undefined): {
  readonly role: NodeRole
  readonly runtime: RuntimeKind | null
} {
  const role = parseNodeRole(config?.role) ?? DEFAULT_NODE_ROLE
  if (!roleRunsJobs(role)) return { role, runtime: null }
  const runtimeBlock = config?.runtime
  const kind =
    typeof runtimeBlock === "object" && runtimeBlock !== null
      ? parseRuntimeKind((runtimeBlock as { kind?: unknown }).kind)
      : null
  return { role, runtime: kind ?? DEFAULT_RUNTIME_KIND }
}

/**
 * Host binaries a node of this role needs, in check order.
 *
 * tmux is not here: the bridge runs as a launchd/systemd user service, and only
 * `aibr start --foreground` uses tmux (see `optionalPrereqsFor`).
 *
 * worker + opencode → opencode, tailscale
 * worker + claude   → claude, tailscale
 * orchestrator      → claude, tailscale
 * both              → runtime, claude, tailscale (de-duplicated)
 */
export function prereqsFor(role: NodeRole, runtime: RuntimeKind | null): readonly string[] {
  const worker = [runtime ?? DEFAULT_RUNTIME_KIND, "tailscale"]
  if (role === "worker") return worker
  if (role === "orchestrator") return ["claude", "tailscale"]
  return [...new Set([runtime ?? DEFAULT_RUNTIME_KIND, "claude", "tailscale"])]
}

/**
 * Host binaries that are useful but never required: reported as a warning when
 * absent. `tmux` only backs `aibr start --foreground`, so only a role that runs
 * jobs (and so has a bridge to start that way) lists it.
 */
export function optionalPrereqsFor(role: NodeRole): readonly string[] {
  return roleRunsJobs(role) ? ["tmux"] : []
}

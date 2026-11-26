import type { BridgeConfig, TriggerRequest } from "../config/types.js"

/**
 * Whether this node requires an operator's approval before a trigger runs.
 *
 * Decided from THIS node's config only: `planning.require_approval_for`, the
 * source's `allowed_sources[].requires_plan_approval`, and, for runtimes with
 * capability profiles, the profile's `requires_approval` (passed in by the
 * caller, which owns the profile lookup).
 *
 * The trigger's `metadata.plan_status` is deliberately NOT an input. It is
 * written by the caller, so trusting it would let a peer approve its own work
 * (ADR 0013). Approval is granted only by an operator on this node, through
 * `aibr approve` and the approval ledger.
 */
export function approvalRequired(
  config: Pick<BridgeConfig, "planning" | "security">,
  trigger: Pick<TriggerRequest, "capability" | "source_agent_id">,
  options: { readonly profileRequiresApproval?: boolean } = {},
): boolean {
  if (options.profileRequiresApproval === true) return true
  if (config.planning.require_approval_for.includes(trigger.capability)) return true
  const source = config.security.allowed_sources.find((candidate) => candidate.source_agent_id === trigger.source_agent_id)
  return source?.requires_plan_approval.includes(trigger.capability) ?? false
}

/**
 * Whether the caller sent `metadata.plan_status: "approved"`. Only used to warn:
 * before 3.1.2 the OpenCode runtime accepted this as an approval.
 */
export function callerClaimsPlanApproval(trigger: Pick<TriggerRequest, "metadata">): boolean {
  return trigger.metadata?.plan_status === "approved"
}

import type { PermissionDecision, PermissionPolicy, PermissionPolicyConfig } from "./types.js"

export class StaticPermissionPolicy implements PermissionPolicy {
  constructor(private readonly config: PermissionPolicyConfig) {}

  decide(tool: string, operatorApproved: boolean): PermissionDecision {
    if (this.config.allow_tools.includes(tool)) return "always"
    // Gated tools need an operator's approval of the job on this node. The
    // caller's `metadata.plan_status` is not an approval (ADR 0013).
    if (this.config.require_plan_approval_for_tools.includes(tool)) {
      return operatorApproved ? "always" : "reject"
    }
    return this.config.default_response
  }
}

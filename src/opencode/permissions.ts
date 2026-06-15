import type { PlanMetadata } from "../config/types.js"
import type { PermissionDecision, PermissionPolicy, PermissionPolicyConfig } from "./types.js"

export class StaticPermissionPolicy implements PermissionPolicy {
  constructor(private readonly config: PermissionPolicyConfig) {}

  decide(tool: string, metadata: PlanMetadata): PermissionDecision {
    if (this.config.allow_tools.includes(tool)) return "always"
    if (this.config.require_plan_approval_for_tools.includes(tool)) {
      return metadata?.plan_status === "approved" ? "always" : "reject"
    }
    return this.config.default_response
  }
}

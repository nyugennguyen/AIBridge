import type { PlanMetadata } from "../config/types.js"

export interface PlanReviewProvider {
  isApproved(capability: string, metadata: PlanMetadata): boolean
}

export class ConfigPlanReviewProvider implements PlanReviewProvider {
  constructor(private readonly capabilitiesRequiringApproval: string[]) {}

  isApproved(capability: string, metadata: PlanMetadata): boolean {
    if (!this.capabilitiesRequiringApproval.includes(capability)) return true
    return metadata?.plan_status === "approved"
  }
}

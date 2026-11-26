import { describe, expect, it } from "vitest"
import { approvalRequired, callerClaimsPlanApproval } from "../../../src/planning/approval.js"

const config = {
  planning: { plan_annotator_enabled: true, require_approval_for: ["deployment"] },
  security: {
    auth_mode: "bearer-token" as const,
    allowed_sources: [
      { source_agent_id: "dev-main", capabilities: ["testing", "migrate"], requires_plan_approval: ["migrate"] },
      { source_agent_id: "ci", capabilities: ["migrate"], requires_plan_approval: [] },
    ],
  },
}

describe("approvalRequired", () => {
  it("does not hold capabilities the node does not gate", () => {
    expect(approvalRequired(config, { capability: "testing", source_agent_id: "dev-main" })).toBe(false)
  })

  it("holds capabilities in planning.require_approval_for for every source", () => {
    expect(approvalRequired(config, { capability: "deployment", source_agent_id: "dev-main" })).toBe(true)
    expect(approvalRequired(config, { capability: "deployment", source_agent_id: "ci" })).toBe(true)
  })

  it("holds a capability the source itself must have approved", () => {
    expect(approvalRequired(config, { capability: "migrate", source_agent_id: "dev-main" })).toBe(true)
    expect(approvalRequired(config, { capability: "migrate", source_agent_id: "ci" })).toBe(false)
  })

  it("holds when the capability profile requires approval", () => {
    expect(approvalRequired(config, { capability: "testing", source_agent_id: "dev-main" }, { profileRequiresApproval: true })).toBe(true)
  })

  it("has no input for the caller's plan_status: a trigger cannot approve itself", () => {
    const trigger = { capability: "deployment", source_agent_id: "dev-main", metadata: { plan_status: "approved" as const } }
    expect(approvalRequired(config, trigger)).toBe(true)
  })
})

describe("callerClaimsPlanApproval", () => {
  it("detects only an explicit approved claim", () => {
    expect(callerClaimsPlanApproval({ metadata: { plan_status: "approved" } })).toBe(true)
    expect(callerClaimsPlanApproval({ metadata: { plan_status: "submitted" } })).toBe(false)
    expect(callerClaimsPlanApproval({ metadata: undefined })).toBe(false)
  })
})

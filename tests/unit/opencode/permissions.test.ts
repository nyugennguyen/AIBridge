import { describe, expect, it } from "vitest"
import { StaticPermissionPolicy } from "../../../src/opencode/permissions.js"

const policy = new StaticPermissionPolicy({
  default_response: "reject",
  allow_tools: ["read", "grep", "glob"],
  require_plan_approval_for_tools: ["bash", "edit", "write"],
})

describe("StaticPermissionPolicy", () => {
  it("always allows configured safe tools", () => {
    expect(policy.decide("read", undefined)).toBe("always")
  })

  it("allows plan-gated tools only with approved metadata", () => {
    expect(policy.decide("bash", undefined)).toBe("reject")
    expect(policy.decide("bash", { plan_status: "rejected" })).toBe("reject")
    expect(policy.decide("bash", { plan_status: "approved", plan_reference: ".omo/plans/job.md" })).toBe("always")
  })

  it("uses the default response for unknown tools", () => {
    expect(policy.decide("unknown-tool", undefined)).toBe("reject")
  })
})

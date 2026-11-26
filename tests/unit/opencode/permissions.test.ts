import { describe, expect, it } from "vitest"
import { StaticPermissionPolicy } from "../../../src/opencode/permissions.js"

const policy = new StaticPermissionPolicy({
  default_response: "reject",
  allow_tools: ["read", "grep", "glob"],
  require_plan_approval_for_tools: ["bash", "edit", "write"],
})

describe("StaticPermissionPolicy", () => {
  it("always allows configured safe tools", () => {
    expect(policy.decide("read", false)).toBe("always")
  })

  it("allows gated tools only for a job an operator approved on this node", () => {
    expect(policy.decide("bash", false)).toBe("reject")
    expect(policy.decide("edit", false)).toBe("reject")
    expect(policy.decide("bash", true)).toBe("always")
  })

  it("uses the default response for unknown tools", () => {
    expect(policy.decide("unknown-tool", false)).toBe("reject")
    expect(policy.decide("unknown-tool", true)).toBe("reject")
  })
})

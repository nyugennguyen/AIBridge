import { describe, expect, it } from "vitest"
import { ConfigPlanReviewProvider } from "../../../src/planning/provider.js"

describe("ConfigPlanReviewProvider", () => {
  it("allows capabilities that do not require approval", () => {
    const provider = new ConfigPlanReviewProvider(["deployment"])

    expect(provider.isApproved("testing", undefined)).toBe(true)
  })

  it("requires approved metadata for gated capabilities", () => {
    const provider = new ConfigPlanReviewProvider(["deployment"])

    expect(provider.isApproved("deployment", undefined)).toBe(false)
    expect(provider.isApproved("deployment", { plan_status: "rejected" })).toBe(false)
    expect(provider.isApproved("deployment", { plan_status: "approved", plan_reference: ".omo/plans/deploy.md" })).toBe(true)
  })
})

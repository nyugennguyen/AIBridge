import { describe, expect, it } from "vitest"
import { assertSourceAuthorized } from "../../../src/security/source-authorization.js"
import type { AllowedSource } from "../../../src/config/types.js"

const allowedSources: AllowedSource[] = [
  { source_agent_id: "dev-main", capabilities: ["testing", "qa"], requires_plan_approval: ["deployment"] },
]

describe("assertSourceAuthorized", () => {
  it("allows an authorized source capability pair", () => {
    expect(assertSourceAuthorized("dev-main", "testing", allowedSources).source_agent_id).toBe("dev-main")
  })

  it("rejects unauthorized source capability pairs", () => {
    expect(() => assertSourceAuthorized("dev-main", "deployment", allowedSources)).toThrow("not authorized")
    expect(() => assertSourceAuthorized("unknown", "testing", allowedSources)).toThrow("not authorized")
  })
})

import { describe, expect, it } from "vitest"
import { assertProjectAllowed } from "../../../src/security/allowlist.js"
import type { ProjectConfig } from "../../../src/config/types.js"

const projects: ProjectConfig[] = [{ id: "app", path: "/srv/apps/app", capabilities: ["testing"] }]

describe("assertProjectAllowed", () => {
  it("accepts an allowlisted project directory", () => {
    expect(assertProjectAllowed("/srv/apps/app", projects).id).toBe("app")
  })

  it("rejects a project directory outside the allowlist", () => {
    expect(() => assertProjectAllowed("/etc", projects)).toThrow("not allowlisted")
  })
})

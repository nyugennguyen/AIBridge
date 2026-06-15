import { describe, expect, it } from "vitest"
import { ConfigAgentRegistry } from "../../../src/registry/config-registry.js"
import { CapabilityRouter } from "../../../src/registry/router.js"

const agents = [
  { id: "dev-main", url: "http://dev-main.tailnet:8787", capabilities: ["development", "orchestration"] },
  { id: "test-vps", url: "http://test-vps.tailnet:8787", capabilities: ["testing", "qa"] },
]

describe("CapabilityRouter", () => {
  it("routes to an explicit target with the requested capability", () => {
    const router = new CapabilityRouter(new ConfigAgentRegistry(agents))

    expect(router.resolve("test-vps", "testing").id).toBe("test-vps")
  })

  it("rejects an explicit target without the requested capability", () => {
    const router = new CapabilityRouter(new ConfigAgentRegistry(agents))

    expect(() => router.resolve("dev-main", "testing")).toThrow("does not provide capability")
  })

  it("routes by capability for future mesh dispatch", () => {
    const router = new CapabilityRouter(new ConfigAgentRegistry(agents))

    expect(router.routeByCapability("qa").id).toBe("test-vps")
  })
})

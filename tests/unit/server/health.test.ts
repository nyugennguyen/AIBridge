/**
 * The discovery contract of `GET /health`.
 *
 * `/health` is the one route a peer can reach without a shared secret, so it is
 * the route where adding a field is a disclosure decision rather than a
 * convenience. These tests pin both halves: the identity fields are present and
 * correctly derived, and nothing else came along with them.
 */

import { describe, expect, it } from "vitest"
import type { BridgeConfig } from "../../../src/config/types.js"
import { buildTestApp, FakeOpencodeClient, testConfig } from "../../integration/fixtures.js"

/** A peer that answers to `probe-target` and accepts three overlapping capabilities. */
function discoveryConfig(): BridgeConfig {
  return {
    ...testConfig(),
    agent_id: "probe-target",
    security: {
      auth_mode: "bearer-token",
      allowed_sources: [
        { source_agent_id: "peer-a", capabilities: ["testing", "deployment"], requires_plan_approval: ["deployment"] },
        { source_agent_id: "peer-b", capabilities: ["deployment", "analysis"], requires_plan_approval: [] },
      ],
    },
  }
}

describe("GET /health discovery identity", () => {
  it("reports the node's own agent id and the capabilities it accepts, with no authentication", async () => {
    const { app } = await buildTestApp({ config: discoveryConfig() })

    const response = await app.inject({ method: "GET", url: "/health" })

    expect(response.statusCode).toBe(200)
    // `toEqual`, not `toMatchObject`: the point of this route is that a probe
    // sees a BOUNDED body, so an accidental extra field is a failure here.
    expect(response.json()).toEqual({
      ok: true,
      opencode: true,
      agent_id: "probe-target",
      capabilities: ["analysis", "deployment", "testing"],
    })
  })

  it("flattens capabilities across every allowed source and de-duplicates them", async () => {
    const config = testConfig()
    const { app } = await buildTestApp({ config })

    const response = await app.inject({ method: "GET", url: "/health" })

    expect(response.json().capabilities).toEqual(["testing"])
  })

  it("sorts capabilities, so two allowlists that name the same set in a different order answer identically", async () => {
    const config = discoveryConfig()
    const reordered: BridgeConfig = { ...config, security: { ...config.security, allowed_sources: [...config.security.allowed_sources].reverse() } }

    const forward = await (await buildTestApp({ config })).app.inject({ method: "GET", url: "/health" })
    const shuffled = await (await buildTestApp({ config: reordered })).app.inject({ method: "GET", url: "/health" })

    expect(forward.json().capabilities).toEqual(["analysis", "deployment", "testing"])
    expect(shuffled.json().capabilities).toEqual(forward.json().capabilities)
  })

  it("answers with an empty capability list when nothing is allowed, rather than omitting the field", async () => {
    const config = testConfig()
    const { app } = await buildTestApp({
      config: { ...config, security: { auth_mode: "bearer-token", allowed_sources: [] } },
    })

    const response = await app.inject({ method: "GET", url: "/health" })

    expect(response.json().capabilities).toEqual([])
  })

  it("still reports identity when the opencode backend is down", async () => {
    // `opencode` is the daemon's dependency, not the discovery contract's: a peer
    // probing a node whose runtime is unhealthy still needs to know WHICH node
    // proved unreachable-in-part, or the failure is unattributable.
    class UnhealthyOpencodeClient extends FakeOpencodeClient {
      override async health(): Promise<boolean> {
        return false
      }
    }

    const { app } = await buildTestApp({ config: discoveryConfig(), opencodeClient: new UnhealthyOpencodeClient() })

    const response = await app.inject({ method: "GET", url: "/health" })

    expect(response.json()).toEqual({
      ok: true,
      opencode: false,
      agent_id: "probe-target",
      capabilities: ["analysis", "deployment", "testing"],
    })
  })

  it("does not disclose the authorized peers, their approval policy, or the mesh registry", async () => {
    // `allowed_sources[].source_agent_id` is the set of tailnet peers this node
    // has authorized, and `agents[]` is the mesh registry. Both are topology a
    // discovery probe has no need for, and the route below proves they stayed out.
    const { app } = await buildTestApp({ config: discoveryConfig() })

    const body = (await app.inject({ method: "GET", url: "/health" })).body

    expect(body).not.toContain("peer-a")
    expect(body).not.toContain("peer-b")
    expect(body).not.toContain("source_agent_id")
    expect(body).not.toContain("requires_plan_approval")
    // `agents[]` in `testConfig()` grants "development"; the accepted vocabulary
    // is inbound, so a capability this node can CALL must not appear.
    expect(body).not.toContain("development")
  })
})

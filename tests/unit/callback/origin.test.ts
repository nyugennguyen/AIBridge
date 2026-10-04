/**
 * M7.8 / F-02 closure test: destination origin resolution, CGNAT pinning,
 * and cross-origin redirect prevention.
 */

import { describe, expect, it } from "vitest"
import {
  assertDestinationOriginAllowed,
  isAllowedIp,
  safeEgressFetch,
  CrossOriginRedirectError,
  NonCgnatAddressError,
  UnlistedOriginError,
  type AgentOriginConfig,
} from "../../../src/callback/origin.js"

const configuredAgents: readonly AgentOriginConfig[] = [
  { id: "peer-worker", url: "http://100.64.1.2:8787" },
  { id: "dev-main", url: "http://dev-main.tailnet:8787" },
  { id: "local-node", url: "http://127.0.0.1:8787" },
]

describe("M7.8 / F-02 destination origin resolution", () => {
  it("rejects an unlisted origin BEFORE any authorization header is constructed", () => {
    expect(() =>
      assertDestinationOriginAllowed("http://attacker.com/callback", configuredAgents),
    ).toThrow(UnlistedOriginError)

    expect(() =>
      assertDestinationOriginAllowed("http://192.168.1.50:8787/report", configuredAgents),
    ).toThrow(UnlistedOriginError)
  })

  it("accepts a destination whose origin matches a configured agent", () => {
    const result = assertDestinationOriginAllowed(
      "http://dev-main.tailnet:8787/report?job=123",
      configuredAgents,
    )
    expect(result.origin).toBe("http://dev-main.tailnet:8787")
    expect(result.agent.id).toBe("dev-main")
  })

  it("pins IP destinations to Tailscale CGNAT (100.64.0.0/10) or loopback", () => {
    // 100.64.0.0/10 range check
    expect(isAllowedIp("100.64.0.1")).toBe(true)
    expect(isAllowedIp("100.127.255.254")).toBe(true)
    expect(isAllowedIp("127.0.0.1")).toBe(true)

    // Outside CGNAT
    expect(isAllowedIp("100.63.255.255")).toBe(false)
    expect(isAllowedIp("100.128.0.0")).toBe(false)
    expect(isAllowedIp("8.8.8.8")).toBe(false)
    expect(isAllowedIp("192.168.1.1")).toBe(false)
  })

  it("rejects an IP address outside CGNAT even if listed in config", () => {
    const agentsWithPublicIp: readonly AgentOriginConfig[] = [
      { id: "bad-peer", url: "http://93.184.216.34:8787" },
    ]
    expect(() =>
      assertDestinationOriginAllowed("http://93.184.216.34:8787/report", agentsWithPublicIp),
    ).toThrow(NonCgnatAddressError)
  })

  it("prevents cross-origin redirects from leaking credentials", async () => {
    const fetcher = async (_url: string, _init?: RequestInit): Promise<Response> => {
      return new Response(null, {
        status: 302,
        headers: { location: "http://evil-tracker.com/steal" },
      })
    }

    await expect(
      safeEgressFetch(
        fetcher,
        "http://dev-main.tailnet:8787/report",
        { headers: { Authorization: "Bearer secret-token" } },
        "http://dev-main.tailnet:8787",
      ),
    ).rejects.toThrow(CrossOriginRedirectError)
  })

  it("allows same-origin redirect", async () => {
    const fetcher = async (_url: string, _init?: RequestInit): Promise<Response> => {
      return new Response(null, {
        status: 307,
        headers: { location: "http://dev-main.tailnet:8787/report/v2" },
      })
    }

    const response = await safeEgressFetch(
      fetcher,
      "http://dev-main.tailnet:8787/report",
      {},
      "http://dev-main.tailnet:8787",
    )
    expect(response.status).toBe(307)
  })
})

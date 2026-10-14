import { describe, expect, it } from "vitest"
import { ConfigAgentRegistry } from "../../../src/registry/config-registry.js"
import { CapabilityRouter } from "../../../src/registry/router.js"
import type { LiveMeshNode, MeshNodeProvider } from "../../../src/registry/types.js"
import {
  createSnapshotMeshNodeProvider,
  routingNodeSnapshotSchema,
  type RoutingNodeSnapshot,
} from "../../../src/routing/index.js"

const agents = [
  { id: "dev-main", url: "http://dev-main.tailnet:8787", capabilities: ["development", "orchestration"] },
  { id: "test-vps", url: "http://test-vps.tailnet:8787", capabilities: ["testing", "qa"] },
  { id: "gpu-worker", url: "http://gpu-worker.tailnet:8787", capabilities: ["ml-inference"] },
]

function fakeMeshProvider(nodes: readonly LiveMeshNode[]): MeshNodeProvider {
  return {
    getLiveNodes: () => nodes,
  }
}

function failingMeshProvider(errorMessage = "Mesh registry connection refused"): MeshNodeProvider {
  return {
    getLiveNodes: () => {
      throw new Error(errorMessage)
    },
  }
}

describe("CapabilityRouter explicit resolution", () => {
  it("routes to an explicit target with the requested capability", () => {
    const router = new CapabilityRouter(new ConfigAgentRegistry(agents))

    expect(router.resolve("test-vps", "testing").id).toBe("test-vps")
  })

  it("rejects an explicit target without the requested capability", () => {
    const router = new CapabilityRouter(new ConfigAgentRegistry(agents))

    expect(() => router.resolve("dev-main", "testing")).toThrow("does not provide capability")
  })

  it("rejects an unknown agent id", () => {
    const router = new CapabilityRouter(new ConfigAgentRegistry(agents))

    expect(() => router.resolve("unknown-agent", "testing")).toThrow("Unknown agent: unknown-agent")
  })
})

describe("CapabilityRouter live capability routing", () => {
  it("(a) resolves a live mesh node that advertises the requested capability when injected into ConfigAgentRegistry", () => {
    const meshProvider = fakeMeshProvider([
      { nodeId: "test-vps", capabilities: ["testing", "qa"], reachability: "live", healthy: true },
      { nodeId: "dev-main", capabilities: ["development"], reachability: "live", healthy: true },
    ])
    const registry = new ConfigAgentRegistry(agents, meshProvider)
    const router = new CapabilityRouter(registry)

    const routed = router.routeByCapability("qa")
    expect(routed.id).toBe("test-vps")
    expect(routed.url).toBe("http://test-vps.tailnet:8787")
  })

  it("(a) resolves a live mesh node when injected into CapabilityRouter directly", () => {
    const meshProvider = fakeMeshProvider([
      { nodeId: "test-vps", capabilities: ["testing", "qa"], reachability: "live", healthy: true },
    ])
    const registry = new ConfigAgentRegistry(agents)
    const router = new CapabilityRouter(registry, meshProvider)

    expect(router.routeByCapability("qa").id).toBe("test-vps")
  })

  it("(b) a node that exists in config but is absent from the live mesh registry is NOT a candidate", () => {
    // test-vps is in `agents` with "qa", but mesh provider only reports dev-main
    const meshProvider = fakeMeshProvider([
      { nodeId: "dev-main", capabilities: ["development", "orchestration"], reachability: "live", healthy: true },
    ])
    const registry = new ConfigAgentRegistry(agents, meshProvider)
    const router = new CapabilityRouter(registry)

    expect(() => router.routeByCapability("qa")).toThrow("No agent provides capability qa")
  })

  it("(c) an empty mesh provider yields no candidates (fail closed)", () => {
    const emptyProvider = fakeMeshProvider([])
    const registry = new ConfigAgentRegistry(agents, emptyProvider)
    const router = new CapabilityRouter(registry)

    expect(() => router.routeByCapability("qa")).toThrow("No agent provides capability qa")
  })

  it("(c) a failing mesh provider yields no candidates (fail closed)", () => {
    const failingProvider = failingMeshProvider("Storage partition / SQLite disk I/O failure")
    const registry = new ConfigAgentRegistry(agents, failingProvider)
    const router = new CapabilityRouter(registry)

    expect(() => router.routeByCapability("qa")).toThrow("No agent provides capability qa")
  })

  it("fails closed when no mesh provider is supplied", () => {
    const registry = new ConfigAgentRegistry(agents)
    const router = new CapabilityRouter(registry)

    expect(() => router.routeByCapability("qa")).toThrow("No agent provides capability qa")
  })

  it("excludes a node if it is in config and mesh, but the mesh node does not advertise the capability", () => {
    // test-vps has "qa" in config, but its live heartbeat only advertises "testing"
    const meshProvider = fakeMeshProvider([
      { nodeId: "test-vps", capabilities: ["testing"], reachability: "live", healthy: true },
    ])
    const router = new CapabilityRouter(new ConfigAgentRegistry(agents, meshProvider))

    expect(() => router.routeByCapability("qa")).toThrow("No agent provides capability qa")
  })

  it("excludes a node if it advertises the capability in mesh, but config does not expect it", () => {
    // dev-main has only "development", "orchestration" in config, but claims "qa" on mesh
    const meshProvider = fakeMeshProvider([
      { nodeId: "dev-main", capabilities: ["development", "qa"], reachability: "live", healthy: true },
    ])
    const router = new CapabilityRouter(new ConfigAgentRegistry(agents, meshProvider))

    expect(() => router.routeByCapability("qa")).toThrow("No agent provides capability qa")
  })

  it("excludes an unconfigured node that advertises the capability on the mesh", () => {
    // rogue-worker is not in `agents`
    const meshProvider = fakeMeshProvider([
      { nodeId: "rogue-worker", capabilities: ["qa"], reachability: "live", healthy: true },
    ])
    const router = new CapabilityRouter(new ConfigAgentRegistry(agents, meshProvider))

    expect(() => router.routeByCapability("qa")).toThrow("No agent provides capability qa")
  })

  it("excludes a node with stale reachability", () => {
    const meshProvider = fakeMeshProvider([
      { nodeId: "test-vps", capabilities: ["qa"], reachability: "stale" },
    ])
    const router = new CapabilityRouter(new ConfigAgentRegistry(agents, meshProvider))

    expect(() => router.routeByCapability("qa")).toThrow("No agent provides capability qa")
  })

  it("excludes a node with revoked reachability", () => {
    const meshProvider = fakeMeshProvider([
      { nodeId: "test-vps", capabilities: ["qa"], reachability: "revoked" },
    ])
    const router = new CapabilityRouter(new ConfigAgentRegistry(agents, meshProvider))

    expect(() => router.routeByCapability("qa")).toThrow("No agent provides capability qa")
  })

  it("excludes a node with healthy: false", () => {
    const meshProvider = fakeMeshProvider([
      { nodeId: "test-vps", capabilities: ["qa"], healthy: false },
    ])
    const router = new CapabilityRouter(new ConfigAgentRegistry(agents, meshProvider))

    expect(() => router.routeByCapability("qa")).toThrow("No agent provides capability qa")
  })

  it("works with createSnapshotMeshNodeProvider from routing snapshots", () => {
    const snapshots: RoutingNodeSnapshot[] = [
      routingNodeSnapshotSchema.parse({
        nodeId: "test-vps",
        displayName: "test-vps",
        revoked: false,
        projectIds: ["prj-1"],
        projectPathIds: ["pth-1"],
        runtimeKinds: ["opencode"],
        capabilities: ["testing", "qa"],
        maxConcurrentSessions: 4,
        activeSessions: 0,
        healthy: true,
        healthReason: "liveness_live",
        livenessState: "live",
        sequence: 1,
        observedAt: "2026-01-01T00:00:00.000Z",
        verdictEligible: true,
        verdictReason: "advertised",
      }),
      routingNodeSnapshotSchema.parse({
        nodeId: "dev-main",
        displayName: "dev-main",
        revoked: false,
        projectIds: ["prj-1"],
        projectPathIds: ["pth-1"],
        runtimeKinds: ["opencode"],
        capabilities: ["development"],
        maxConcurrentSessions: 4,
        activeSessions: 0,
        healthy: false,
        healthReason: "liveness_stale",
        livenessState: "stale",
        sequence: 2,
        observedAt: "2026-01-01T00:00:00.000Z",
        verdictEligible: false,
        verdictReason: "node_stale",
      }),
    ]

    const provider = createSnapshotMeshNodeProvider(snapshots)
    const router = new CapabilityRouter(new ConfigAgentRegistry(agents, provider))

    expect(router.routeByCapability("qa").id).toBe("test-vps")
    expect(() => router.routeByCapability("development")).toThrow("No agent provides capability development")
  })
})

describe("ConfigAgentRegistry findByCapability", () => {
  it("returns matching agent configs when present in live mesh", () => {
    const provider = fakeMeshProvider([
      { nodeId: "test-vps", capabilities: ["qa"], reachability: "live" },
    ])
    const registry = new ConfigAgentRegistry(agents, provider)

    const found = registry.findByCapability("qa")
    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe("test-vps")
  })

  it("returns empty array when node is absent from mesh", () => {
    const provider = fakeMeshProvider([
      { nodeId: "dev-main", capabilities: ["development"] },
    ])
    const registry = new ConfigAgentRegistry(agents, provider)

    expect(registry.findByCapability("qa")).toEqual([])
  })

  it("returns empty array when mesh provider throws (fails closed)", () => {
    const provider = failingMeshProvider()
    const registry = new ConfigAgentRegistry(agents, provider)

    expect(registry.findByCapability("qa")).toEqual([])
  })

  it("returns empty array when mesh provider is empty (fails closed)", () => {
    const provider = fakeMeshProvider([])
    const registry = new ConfigAgentRegistry(agents, provider)

    expect(registry.findByCapability("qa")).toEqual([])
  })

  it("returns empty array when no provider is supplied (fails closed)", () => {
    const registry = new ConfigAgentRegistry(agents)

    expect(registry.findByCapability("qa")).toEqual([])
  })
})

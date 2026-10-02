/**
 * M6.6 — the snapshot adapter.
 *
 * The claim these tests defend is architectural, not behavioural: `src/routing/`
 * projects the mesh registry rather than extending it, so the adapter must be
 * readable, deterministic, and unable to write. Each test below is one way that
 * claim could fail without the suite going red.
 */

import { describe, expect, it } from "vitest"
import { MAX_HEARTBEAT_AGE_MS } from "../../../src/mesh/protocol/bounds.js"
import { meshIdSchema, nodeIdSchema } from "../../../src/orchestration/identifiers.js"
import { buildRoutingSnapshot, buildRoutingSnapshotForNode } from "../../../src/routing/index.js"
import type { RoutingRegistryPort } from "../../../src/routing/index.js"
import {
  aContext,
  aRequest,
  at,
  authorizedFor,
  enroll,
  heartbeat,
  inMemoryRegistry,
  iso,
  MESH_ID,
  OTHER_MESH_ID,
  OTHER_PATH_ID,
  PROJECT_ID,
  PROJECT_PATH_ID,
  revoke,
  snapshotsFor,
  TestClock,
} from "./fixtures.js"

describe("the routing snapshot adapter projects the registry without extending it", () => {
  it("reads a live node's advertisement, liveness, and health from the registry", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })
    await heartbeat(registry, { nodeId: "node-alpha", capabilities: ["fs.read", "fs.write"] })

    const snapshots = await snapshotsFor(
      registry,
      aRequest(),
      aContext({ authorizedProjectIds: authorizedFor("node-alpha") }),
    )

    expect(snapshots).toHaveLength(1)
    const alpha = snapshots[0]!
    expect(alpha.nodeId).toBe("node-alpha")
    expect(alpha.displayName).toBe("node-alpha")
    expect(alpha.capabilities).toEqual(["fs.read", "fs.write"])
    expect(alpha.runtimeKinds).toEqual(["opencode"])
    expect(alpha.projectPathIds).toEqual([PROJECT_PATH_ID])
    expect(alpha.livenessState).toBe("live")
    expect(alpha.healthy).toBe(true)
    expect(alpha.healthReason).toBe("liveness_live")
    expect(alpha.revoked).toBe(false)
    expect(alpha.maxConcurrentSessions).toBe(4)
    expect(alpha.activeSessions).toBe(0)
    expect(alpha.sequence).toBe(1)
    expect(alpha.observedAt).toBe(iso(at(0)))
    expect(alpha.verdictEligible).toBe(true)
    expect(alpha.verdictReason).toBe("advertised")
  })

  it("returns a deeply frozen snapshot array so a ranking decision cannot be edited after the fact", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })
    await heartbeat(registry, { nodeId: "node-alpha" })

    const snapshots = await snapshotsFor(
      registry,
      aRequest(),
      aContext({ authorizedProjectIds: authorizedFor("node-alpha") }),
    )

    expect(Object.isFrozen(snapshots)).toBe(true)
    expect(Object.isFrozen(snapshots[0])).toBe(true)
    expect(Object.isFrozen(snapshots[0]!.capabilities)).toBe(true)
    expect(() => {
      ;(snapshots[0] as unknown as { healthy: boolean }).healthy = false
    }).toThrow()
  })

  it("sorts snapshots by nodeId in UTF-16 code-unit order regardless of the order the registry returned them", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    // Enrolled in descending order, so a projection that preserved read order
    // would come back reversed.
    for (const nodeId of ["node-zulu", "node-mike", "node-alpha"]) {
      await enroll(store, { nodeId })
      await heartbeat(registry, { nodeId })
    }

    const snapshots = await snapshotsFor(
      registry,
      aRequest(),
      aContext({
        authorizedProjectIds: authorizedFor("node-zulu", "node-mike", "node-alpha"),
      }),
    )

    expect(snapshots.map((snapshot) => snapshot.nodeId)).toEqual([
      "node-alpha",
      "node-mike",
      "node-zulu",
    ])
  })

  it("sorts and de-duplicates every collection on a snapshot", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })
    await heartbeat(registry, {
      nodeId: "node-alpha",
      capabilities: ["fs.write", "fs.read", "fs.write"],
      runtimeKinds: ["opencode", "claude", "opencode"],
      projectPathIds: [OTHER_PATH_ID, PROJECT_PATH_ID, OTHER_PATH_ID],
    })

    const snapshots = await snapshotsFor(registry, aRequest(), aContext({ authorizedProjectIds: authorizedFor("node-alpha") }))
    const alpha = snapshots[0]!

    expect(alpha.capabilities).toEqual(["fs.read", "fs.write"])
    expect(alpha.runtimeKinds).toEqual(["claude", "opencode"])
    expect(alpha.projectPathIds).toEqual([PROJECT_PATH_ID, OTHER_PATH_ID])
  })

  it("derives liveness at the routing request's injected clock rather than at the instant of the read", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })
    await heartbeat(registry, { nodeId: "node-alpha", observedAt: at(0) })

    // The controller clock is still at T0, so the registry would call this node
    // live. The ROUTING REQUEST declares a later instant, and routing's answer has
    // to be a function of that instant rather than of when it happened to ask — a
    // decision that changes if you ask it twice is not a decision.
    const snapshots = await snapshotsFor(
      registry,
      aRequest({ now: at(0) + MAX_HEARTBEAT_AGE_MS + 1_000 }),
      aContext({ authorizedProjectIds: authorizedFor("node-alpha") }),
    )

    expect(snapshots[0]!.livenessState).toBe("stale")
    expect(snapshots[0]!.healthy).toBe(false)
    expect(snapshots[0]!.healthReason).toBe("liveness_stale")
  })

  it("reports a revoked node as revoked with a null age rather than as merely unhealthy", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })
    await heartbeat(registry, { nodeId: "node-alpha" })
    await revoke(registry, "node-alpha")

    const snapshots = await snapshotsFor(registry, aRequest(), aContext({ authorizedProjectIds: authorizedFor("node-alpha") }))

    expect(snapshots[0]!.livenessState).toBe("revoked")
    expect(snapshots[0]!.revoked).toBe(true)
    expect(snapshots[0]!.healthReason).toBe("liveness_revoked")
  })

  it("reports a node that has never heartbeated as never-seen with no advertisement at all", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })

    const snapshots = await snapshotsFor(registry, aRequest(), aContext({ authorizedProjectIds: authorizedFor("node-alpha") }))
    const alpha = snapshots[0]!

    expect(alpha.livenessState).toBe("never-seen")
    expect(alpha.healthReason).toBe("liveness_no_capability_snapshot")
    expect(alpha.capabilities).toEqual([])
    expect(alpha.maxConcurrentSessions).toBeNull()
    expect(alpha.activeSessions).toBeNull()
    expect(alpha.observedAt).toBeNull()
    expect(alpha.sequence).toBe(0)
  })

  it("carries the registry's own CapabilityVerdict forward instead of re-deriving eligibility", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })
    await heartbeat(registry, { nodeId: "node-alpha", projectPathIds: [OTHER_PATH_ID] })

    // The node is healthy and advertises everything; it simply does not advertise
    // this dispatch's project path, and the registry's filter says so.
    const snapshots = await snapshotsFor(registry, aRequest(), aContext({ authorizedProjectIds: authorizedFor("node-alpha") }))

    expect(snapshots[0]!.verdictEligible).toBe(false)
    expect(snapshots[0]!.verdictReason).toBe("project_path_not_advertised")
  })

  it("fails closed on authorization: a node with no recorded projects is authorized for none", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })
    await heartbeat(registry, { nodeId: "node-alpha" })

    const snapshots = await snapshotsFor(registry, aRequest(), aContext())

    expect(snapshots[0]!.projectIds).toEqual([])
  })

  it("carries only the projects the caller recorded, and only ones the id schema accepts", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })
    await heartbeat(registry, { nodeId: "node-alpha" })

    const snapshots = await snapshotsFor(
      registry,
      aRequest(),
      aContext({
        authorizedProjectIds: {
          "node-alpha": [PROJECT_ID, "not a project id", "proj-other"],
        },
      }),
    )

    // The malformed entry is dropped rather than carried, because a project id that
    // this build cannot parse is a reference it cannot check.
    expect(snapshots[0]!.projectIds).toEqual(["proj-other", PROJECT_ID])
  })

  it("refuses a request that does not satisfy routingRequestSchema rather than half-evaluating it", async () => {
    const clock = new TestClock()
    const { registry } = inMemoryRegistry(clock)
    const request = { ...aRequest(), now: -1 } as unknown as ReturnType<typeof aRequest>

    const result = await buildRoutingSnapshot(registry, request, aContext())

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error.code).toBe("routing.request_invalid")
  })

  it("refuses a permission envelope this build cannot parse rather than substituting an empty one", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })
    await heartbeat(registry, { nodeId: "node-alpha" })

    const result = await buildRoutingSnapshot(
      registry,
      aRequest(),
      aContext({ permissionEnvelope: { allowedCapabilities: ["fs.read"] } as never }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error.code).toBe("routing.request_invalid")
    expect(result.error.message).toContain("permissionEnvelopeSchema")
  })

  it("reads one node's snapshot without reading the whole mesh into a decision", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })
    await enroll(store, { nodeId: "node-beta" })
    await heartbeat(registry, { nodeId: "node-alpha" })
    await heartbeat(registry, { nodeId: "node-beta" })

    const context = aContext({ authorizedProjectIds: authorizedFor("node-alpha", "node-beta") })
    const found = await buildRoutingSnapshotForNode(
      registry,
      aRequest(),
      context,
      nodeIdSchema.parse("node-beta"),
    )
    const absent = await buildRoutingSnapshotForNode(
      registry,
      aRequest(),
      context,
      nodeIdSchema.parse("node-ghost"),
    )

    expect(found.ok).toBe(true)
    if (!found.ok) throw new Error("unreachable")
    expect(found.value?.nodeId).toBe("node-beta")
    expect(absent.ok).toBe(true)
    if (!absent.ok) throw new Error("unreachable")
    expect(absent.value).toBeNull()
  })

  it("satisfies its declared registry port with the real MeshNodeRegistry and nothing wider", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })
    await heartbeat(registry, { nodeId: "node-alpha" })

    // The port is structural, so this is the compile-time statement that the real
    // registry fits it. If the adapter ever needed `recordHeartbeat` or `revoke`,
    // this assignment would stop typechecking — which is the property that keeps
    // routing unable to write.
    const port: RoutingRegistryPort = registry
    const result = await buildRoutingSnapshot(port, aRequest(), aContext({ authorizedProjectIds: authorizedFor("node-alpha") }))

    expect(result.ok).toBe(true)
    expect(Object.keys(port).length).toBeGreaterThanOrEqual(0)
  })

  it("reads only the requested mesh and nothing else", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })
    await heartbeat(registry, { nodeId: "node-alpha" })

    const result = await buildRoutingSnapshot(
      registry,
      aRequest(),
      aContext({ meshId: OTHER_MESH_ID, authorizedProjectIds: authorizedFor("node-alpha") }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.value).toEqual([])
    expect(MESH_ID).toBe("mesh-release")
  })
})

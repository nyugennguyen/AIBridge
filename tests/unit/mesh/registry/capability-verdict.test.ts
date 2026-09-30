import { describe, expect, it } from "vitest"
import { permissionEnvelopeSchema } from "../../../../src/orchestration/schemas.js"
import type { PermissionEnvelope } from "../../../../src/orchestration/types.js"
import { nodeKeyIdSchema } from "../../../../src/mesh/identity/wire-ids.js"
import { capabilityRequestSchema, canScheduleOn, selectCandidates } from "../../../../src/mesh/registry/capability.js"
import type { RegisteredNode } from "../../../../src/mesh/registry/schemas.js"
import { CURRENT_SCHEMA_VERSION } from "../../../../src/orchestration/identifiers.js"
import {
  MESH_ID,
  OTHER_PATH_ID,
  PROJECT_PATH_ID,
  SECOND_KEY_ID,
  SECOND_WORKER_ID,
  WORKER_ID,
  WORKER_KEY_ID,
  TestClock,
  at,
  enroll,
  heartbeatEnvelope,
  inMemoryRegistry,
  iso,
} from "./fixtures.js"

/**
 * `canScheduleOn` is a CANDIDATE FILTER. Every test here is about the boundary
 * between "what the node says it can do" and "what the dispatch is permitted to do",
 * and the one that matters most is the fourth group: a node that advertises
 * something it may not use.
 */
function envelope(allowed: string[], denied: string[] = []): PermissionEnvelope {
  return permissionEnvelopeSchema.parse({
    allowedCapabilities: allowed,
    deniedCapabilities: denied,
    approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
  })
}

async function aLiveNode(overrides: {
  readonly nodeId?: typeof WORKER_ID
  readonly capabilities?: string[]
  readonly runtimeKinds?: string[]
  readonly projectPathIds?: string[]
  readonly maxConcurrentSessions?: number
  readonly activeSessions?: number
  readonly protocolVersions?: number[]
} = {}): Promise<RegisteredNode> {
  const clock = new TestClock(at(0))
  const { registry, store } = inMemoryRegistry(clock)
  const nodeId = overrides.nodeId ?? WORKER_ID
  await enroll(store, { nodeId, nodeKeyId: nodeId === WORKER_ID ? WORKER_KEY_ID : nodeKeyIdSchema.parse(`key-${nodeId}`) })
  await registry.recordHeartbeat(
    heartbeatEnvelope({
      nodeId,
      sequence: 1,
      observedAt: iso(at(0)),
      capabilities: overrides.capabilities,
      runtimeKinds: overrides.runtimeKinds,
      projectPathIds: overrides.projectPathIds,
      maxConcurrentSessions: overrides.maxConcurrentSessions,
      activeSessions: overrides.activeSessions,
      protocolVersions: overrides.protocolVersions,
    }),
  )
  const found = await registry.node(nodeId)
  if (!found.ok || found.value === null) throw new Error("fixture node was not registered")
  return found.value
}

const baseRequest = capabilityRequestSchema.parse({
  runtimeKind: "opencode",
  requestedCapabilities: ["fs.read", "fs.write"],
  projectPathId: PROJECT_PATH_ID,
  permissionEnvelope: envelope(["fs.read", "fs.write"]),
  projectPathAllowedCapabilities: null,
})

describe("M4.3 the capability verdict is a filter, never an authorization", () => {
  it("a node advertising everything the envelope permits is a candidate, and still authorizes nothing", async () => {
    const node = await aLiveNode()
    const verdict = canScheduleOn(node, baseRequest)

    expect(verdict.eligible).toBe(true)
    expect(verdict.reason).toBe("advertised")
    // The single most important field on the type. A positive verdict is a filter
    // saying "look here first"; `authorizes` is false on BOTH shapes so a caller
    // that wrote `if (verdict.authorizes)` gets an obviously dead branch rather than
    // a silent grant.
    expect(verdict.authorizes).toBe(false)
    // Named even on a pass, because a pass is the moment a reader is most likely to
    // mistake the filter for the decision.
    expect(verdict.authoritative).toEqual(["permission_envelope"])
    expect(verdict.error).toBeNull()
  })

  it("a node advertising a capability the envelope DENIES is refused — the envelope is the grant", async () => {
    // The full attack shape, and the one the plan is about. A node advertises
    // `fs.delete`. A scheduler that treats the advertisement as authority builds a
    // request that asks for it. The recorded `permissionEnvelope` denies it, and the
    // registry refuses — because a peer-supplied claim does not get to widen what
    // the dispatch was approved to do.
    const node = await aLiveNode({ capabilities: ["fs.read", "fs.write", "fs.delete", "net.egress"] })
    const request = capabilityRequestSchema.parse({
      ...baseRequest,
      requestedCapabilities: ["fs.read", "fs.write", "fs.delete"],
      permissionEnvelope: envelope(["fs.read", "fs.write"], ["fs.delete"]),
    })

    const verdict = canScheduleOn(node, request)
    expect(verdict.eligible).toBe(false)
    // Not "capability_not_advertised": the node DID advertise fs.delete. The
    // advertisement is what made this dispatch ask for it, and the envelope is what
    // refuses it. Collapsing the two would point an operator at the wrong system.
    expect(verdict.reason).toBe("denied_by_permission_envelope")
    expect(verdict.shortfall.capabilities).toEqual(["fs.delete"])
    expect(verdict.error?.code).toBe("registry.capability_denied_by_envelope")
    expect(verdict.authorizes).toBe(false)
  })

  it("a capability a node advertises but the dispatch never asked for changes nothing", async () => {
    // The other direction, and without it the test above is only half a claim. A node
    // may advertise more than this dispatch uses; the filter reads the REQUEST, not
    // the advertisement's size. If extra advertised capabilities disqualified a node,
    // any peer could make itself unschedulable-by-overselling, and a mesh would
    // slowly starve itself of capacity with nobody able to say why.
    const node = await aLiveNode({ capabilities: ["fs.read", "fs.write", "fs.delete", "net.egress"] })
    const verdict = canScheduleOn(node, baseRequest)
    expect(verdict.eligible).toBe(true)
    expect(verdict.reason).toBe("advertised")
    expect(verdict.authorizes).toBe(false)
  })

  it("a node advertising a capability the project allowlist excludes is refused", async () => {
    const node = await aLiveNode({ capabilities: ["fs.read", "fs.write"] })
    const request = capabilityRequestSchema.parse({
      ...baseRequest,
      // The envelope allows it and the node advertises it; the project path binding
      // is narrower. Two authorities saying yes and one saying no means no.
      projectPathAllowedCapabilities: ["fs.read"],
    })

    const verdict = canScheduleOn(node, request)
    expect(verdict.eligible).toBe(false)
    expect(verdict.reason).toBe("not_permitted_by_project_allowlist")
    expect(verdict.shortfall.capabilities).toEqual(["fs.write"])
  })

  it("a request that under-uses its envelope is refused rather than widened", async () => {
    const node = await aLiveNode()
    const request = capabilityRequestSchema.parse({
      runtimeKind: "opencode",
      requestedCapabilities: ["fs.read"],
      projectPathId: PROJECT_PATH_ID,
      permissionEnvelope: envelope(["fs.read", "fs.write"]),
      projectPathAllowedCapabilities: null,
    })

    const verdict = canScheduleOn(node, request)
    expect(verdict.eligible).toBe(false)
    // The envelope is a CEILING. Treating "permitted but unrequested" as "requested"
    // is how a dispatch acquires capabilities nobody proposed it with, and the fix
    // belongs in the caller that built the request — not in the filter.
    expect(verdict.reason).toBe("denied_by_permission_envelope")
    expect(verdict.shortfall.capabilities).toEqual(["fs.write"])
  })

  it("a node that does not advertise the capability is refused as UNADVERTISED, not as forbidden", async () => {
    const node = await aLiveNode({ capabilities: ["fs.read"] })
    const verdict = canScheduleOn(node, baseRequest)

    expect(verdict.eligible).toBe(false)
    expect(verdict.reason).toBe("capability_not_advertised")
    expect(verdict.shortfall.capabilities).toEqual(["fs.write"])
    // The distinction is load-bearing: "it says it cannot" and "it is forbidden"
    // have different owners and different fixes, and a TUI that merged them would
    // send an operator to edit a policy when the node just needs an upgrade.
    expect(verdict.detail).toContain("claim")
  })

  it("an unadvertised runtime kind and an unadvertised project path each get their own refusal", async () => {
    const node = await aLiveNode({ runtimeKinds: ["claude"], projectPathIds: [OTHER_PATH_ID] })

    const runtime = canScheduleOn(node, baseRequest)
    expect(runtime.reason).toBe("runtime_kind_not_advertised")
    expect(runtime.shortfall.runtimeKind).toBe("opencode")

    // Runtime kind matched so the PATH check is the one that decides — otherwise the
    // earlier refusal would short-circuit it and the test would prove nothing about
    // project paths at all.
    const path = canScheduleOn(node, capabilityRequestSchema.parse({ ...baseRequest, runtimeKind: "claude" }))
    expect(path.reason).toBe("project_path_not_advertised")
    expect(path.shortfall.projectPathId).toBe(PROJECT_PATH_ID)
  })

  it("revoked, never-seen, stale and incompatible nodes are all refused, each with its own reason", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)

    // never-seen
    await enroll(store, {})
    const unseen = await registry.node(WORKER_ID)
    expect(unseen.ok && canScheduleOn(unseen.value!, baseRequest).reason).toBe("node_never_seen")

    // live, then stale
    await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }))
    clock.set(at(200))
    const stale = await registry.node(WORKER_ID)
    expect(stale.ok && canScheduleOn(stale.value!, baseRequest).reason).toBe("node_stale")

    // incompatible: the node speaks, just not a dialect this build implements
    clock.set(at(201))
    await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 2, observedAt: iso(at(201)), protocolVersions: [4] }))
    const incompatible = await registry.node(WORKER_ID)
    expect(incompatible.ok && incompatible.value?.liveness).toBe("live")
    expect(incompatible.ok && canScheduleOn(incompatible.value!, baseRequest).reason).toBe("no_common_protocol_version")

    // revoked outranks all of it
    await registry.revoke({ nodeId: WORKER_ID, meshId: MESH_ID, reason: "stolen", revokedBy: "op", revokedAt: at(202) })
    const revoked = await registry.node(WORKER_ID)
    expect(revoked.ok && canScheduleOn(revoked.value!, baseRequest).reason).toBe("node_revoked")
  })

  it("a node at its advertised ceiling is refused with the one reason that resolves by waiting", async () => {
    const node = await aLiveNode({ maxConcurrentSessions: 2, activeSessions: 2 })
    const verdict = canScheduleOn(node, baseRequest)
    expect(verdict.eligible).toBe(false)
    expect(verdict.reason).toBe("at_capacity")
    expect(verdict.observed.activeSessions).toBe(2)
  })

  it("a malformed request is refused rather than half-evaluated", async () => {
    const node = await aLiveNode()
    // A filter that cannot read its own request has not run, and "has not run" is
    // not a pass. The alternative — returning `eligible: true` on an unparseable
    // request — is the shape of a fail-open gate.
    const verdict = canScheduleOn(node, { runtimeKind: "opencode" } as never)
    expect(verdict.eligible).toBe(false)
    expect(verdict.reason).toBe("capability_not_advertised")
    expect(verdict.error?.code).toBe("registry.capability_request_invalid")
  })

  it("candidates() returns every node with the verdict that decided it, not only the winners", async () => {
    const clock = new TestClock(at(0))
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, {})
    await enroll(store, { nodeId: SECOND_WORKER_ID, nodeKeyId: SECOND_KEY_ID, displayName: "worker-2" })

    await registry.recordHeartbeat(heartbeatEnvelope({ sequence: 1, observedAt: iso(at(0)) }))
    await registry.recordHeartbeat(
      heartbeatEnvelope({ nodeId: SECOND_WORKER_ID, sequence: 1, observedAt: iso(at(0)), capabilities: ["fs.read"] }),
    )

    const candidates = await registry.candidates(MESH_ID, baseRequest)
    expect(candidates.ok).toBe(true)
    if (!candidates.ok) return
    expect(candidates.value).toHaveLength(2)
    // A TUI (M4.8) that wants to render "2 nodes, 1 eligible" cannot get that from a
    // list of winners, and an operator debugging an idle mesh cannot see WHY the
    // other node was excluded if the losers are not in the answer.
    const byNode = new Map(candidates.value.map((c) => [c.node.node.nodeId, c.verdict]))
    expect(byNode.get(WORKER_ID)?.eligible).toBe(true)
    expect(byNode.get(SECOND_WORKER_ID)?.reason).toBe("capability_not_advertised")
  })

  it("selectCandidates is pure and does not mutate the nodes it is given", async () => {
    const node = await aLiveNode()
    const before = JSON.stringify(node)
    const selected = selectCandidates([node], baseRequest)
    expect(selected).toHaveLength(1)
    expect(selected[0].verdict.eligible).toBe(true)
    expect(JSON.stringify(node)).toBe(before)
  })

  it("a stored node record round-trips with no scheduling edge attached", async () => {
    // The shape-level counterpart to `no-scheduling-edges.test.ts`: a `RegisteredNode`
    // read back from storage holds exactly the advertisement and nothing that could
    // be read as a grant, a dependency or a retry decision.
    const node = await aLiveNode()
    expect(Object.keys(node).sort()).toEqual(["ageMs", "lastHeartbeatAt", "liveness", "negotiatedProtocolVersion", "node"])
    expect(Object.keys(node.node).sort()).toEqual([
      "capability",
      "displayName",
      "enrolledAt",
      "meshId",
      "nodeId",
      "nodeKeyId",
      "revocation",
      "schemaVersion",
    ])
    expect(node.node.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })
})

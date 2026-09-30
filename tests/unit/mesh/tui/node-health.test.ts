import { describe, expect, it } from "vitest"
import { MAX_HEARTBEAT_AGE_MS } from "../../../../src/mesh/protocol/bounds.js"
import { MESH_TUI_STATES, buildMeshTuiView, initialMeshTuiState, reduceMeshTui, type MeshNodeHealthView, type MeshTuiUiState } from "../../../../src/mesh/tui/index.js"
import {
  LOCAL,
  WORKER_1,
  WORKER_2,
  WORKER_3,
  aHealthyNode,
  aNeverSeenNode,
  aRegisteredNode,
  aRevokedNode,
  aSnapshot,
  aStaleNode,
  anIncompatibleNode,
} from "./fixtures.js"

/**
 * Node health, and the three things a node row must never collapse.
 *
 *   1. **A revoked node reads as revoked.** Not dimmed, not stale, not "offline".
 *      `revoked` is a member the renderer cannot forget, and `nodeBadge` checks it
 *      BEFORE liveness — because a revoked node that somehow heartbeats again must
 *      still read as revoked, since revocation is the only one of the four states
 *      that survives a fresh heartbeat.
 *   2. **A stale node shows its heartbeat age.** The age is M4.3's, at the
 *      registry's clock, and it is rendered rather than summarised: "STALE" on its
 *      own does not tell an operator whether to wait ten seconds or ten minutes.
 *   3. **An incompatible node is not an unreachable one.** A node that heartbeats
 *      on with no version in common is TALKING. Reporting it as offline sends the
 *      operator to fix a network problem they do not have; the remedy is an
 *      upgrade, and the view says so.
 */

function view(...nodes: ReturnType<typeof aRegisteredNode>[]): readonly MeshNodeHealthView[] {
  const state: MeshTuiUiState = reduceMeshTui(initialMeshTuiState(), {
    type: "snapshot-loaded",
    snapshot: aSnapshot({ nodes }),
  }).state
  return buildMeshTuiView(state)!.nodes
}

function node(nodeId: string, nodes: readonly MeshNodeHealthView[]): MeshNodeHealthView {
  const found = nodes.find((candidate) => candidate.nodeId === nodeId)
  if (found === undefined) throw new Error(`no node row for ${nodeId}`)
  return found
}

describe("M4.8 a revoked node reads as revoked", () => {
  it("is not merely dimmed, and never reads as stale or live", () => {
    const rows = view(aRevokedNode({ nodeId: WORKER_3 }))
    const row = node(WORKER_3, rows)
    expect(row.revoked).toBe(true)
    expect(row.badge).toBe("REVOKED")
    // The point of the separate member: a renderer can only dim a row it can see,
    // and this one is addressed by a boolean that is TRUE regardless of liveness.
    expect(row.revocationReason).toBe("compromised laptop")
  })

  it("stays revoked even while its heartbeat looks fresh", () => {
    // Revocation is checked before liveness, and this is the case that proves it:
    // a revoked node whose liveness says `live` and whose age is one second must
    // still read REVOKED, or a heartbeat from a revoked key would quietly restore
    // its row.
    const rows = view(aRegisteredNode({ nodeId: WORKER_3, liveness: "live", revocation: { nodeId: WORKER_3, meshId: "mesh-release" as never, revokedKeyId: "key-worker-3" as never, reason: "compromised laptop", revokedBy: "operator-1", revokedAt: 0 }, ageMs: 1_000 }))
    const row = node(WORKER_3, rows)
    expect(row.liveness).toBe("live")
    expect(row.revoked).toBe(true)
    expect(row.badge).toBe("REVOKED")
  })

  it("carries the reason through to the rendered row", () => {
    const state = reduceMeshTui(initialMeshTuiState(), {
      type: "snapshot-loaded",
      snapshot: aSnapshot({ nodes: [aRevokedNode({ nodeId: WORKER_3, revocation: { nodeId: WORKER_3, meshId: "mesh-release" as never, revokedKeyId: "key-worker-3" as never, reason: "stolen signing key", revokedBy: "operator-1", revokedAt: 0 } })] }),
    }).state
    const text = buildMeshTuiView(state)!.lines.join("\n")
    expect(text).toMatch(/\[REVOKED\]/)
    expect(text).toContain("stolen signing key")
  })

  it("is counted as revoked and NOT as stale, so the summary does not call a decision a fault", () => {
    const state = reduceMeshTui(initialMeshTuiState(), {
      type: "snapshot-loaded",
      snapshot: aSnapshot({ nodes: [aHealthyNode({ nodeId: LOCAL }), aRevokedNode({ nodeId: WORKER_3 })] }),
    }).state
    const summary = buildMeshTuiView(state)!.nodeSummary
    expect(summary).toMatchObject({ total: 2, revoked: 1, stale: 0, live: 1, neverSeen: 0 })
  })

  it("is never reported as a degraded condition, in any mesh cell", () => {
    // Revocation is a decision already taken, not something to repair, and a view
    // that listed it among the conditions would teach an operator to read their
    // own decision as a fault.
    for (const cell of MESH_TUI_STATES) {
      const lease = cell.startsWith("absent") ? "absent" : cell.startsWith("expired") ? "expired" : cell.startsWith("superseded") ? "superseded" : "held"
      const conditions = buildMeshTuiView(
        reduceMeshTui(initialMeshTuiState(), { type: "snapshot-loaded", snapshot: aSnapshot({ leaseKind: lease, nodes: [aRevokedNode({ nodeId: WORKER_3 })] }) }).state,
      )!.degraded.map((condition) => condition.condition)
      expect(conditions, cell).not.toContain("stale-peer")
    }
  })
})

describe("M4.8 a stale node shows its heartbeat age", () => {
  it("carries M4.3's own age rather than a bucket of its own", () => {
    const row = node(WORKER_1, view(aStaleNode({ nodeId: WORKER_1, ageMs: 91_000 })))
    expect(row.heartbeatAgeMs).toBe(91_000)
    expect(row.lastHeartbeatAt).not.toBeNull()
    expect(row.liveness).toBe("stale")
    expect(row.badge).toBe("STALE")
  })

  it("renders the age in the unit an operator can act on", () => {
    // "STALE" alone does not say whether to wait ten seconds or ten minutes, and
    // the whole question about a stale peer is whether it is coming back.
    const cases: readonly [number, RegExp][] = [
      [500, /just now/],
      [45_000, /45s ago/],
      [91_000, /1m 31s ago/],
      [3_600_000, /1h 0m ago/],
    ]
    for (const [ageMs, expected] of cases) {
      const row = node(WORKER_1, view(aStaleNode({ nodeId: WORKER_1, ageMs })))
      const text = buildMeshTuiView(
        reduceMeshTui(initialMeshTuiState(), { type: "snapshot-loaded", snapshot: aSnapshot({ nodes: [aStaleNode({ nodeId: WORKER_1, ageMs })] }) }).state,
      )!.lines.join("\n")
      expect(text, String(ageMs)).toMatch(expected)
      expect(row.heartbeatAgeMs).toBe(ageMs)
    }
  })

  it("says 'never seen' rather than an age of zero for a node that never reported", () => {
    // A never-seen node has no age at all, and rendering "0s ago" would say it
    // just spoke — the opposite of the fact, and the reason `ageMs` is nullable
    // all the way from M4.3 rather than defaulted to zero here.
    const state = reduceMeshTui(initialMeshTuiState(), {
      type: "snapshot-loaded",
      snapshot: aSnapshot({ nodes: [aNeverSeenNode({ nodeId: WORKER_2 })] }),
    }).state
    const row = buildMeshTuiView(state)!.nodes[0]!
    expect(row.heartbeatAgeMs).toBeNull()
    expect(row.lastHeartbeatAt).toBeNull()
    expect(row.badge).toBe("NEVER-SEEN")
    expect(buildMeshTuiView(state)!.lines.join("\n")).toMatch(/never seen/)
  })

  it("a stale node is past M4.3's own bound, and the fixture's age says so", () => {
    // Ties the fixture to the registry's constant rather than to a number written
    // here: a node 91 seconds quiet is stale because `MAX_HEARTBEAT_AGE_MS` is
    // 90 000, not because this directory says so.
    expect(MAX_HEARTBEAT_AGE_MS).toBe(90_000)
    const row = node(WORKER_1, view(aStaleNode({ nodeId: WORKER_1 })))
    expect(row.heartbeatAgeMs!).toBeGreaterThan(MAX_HEARTBEAT_AGE_MS)
    expect(row.liveness).toBe("stale")
  })

  it("a fresh node is not stale, and the difference is visible without the badge", () => {
    const fresh = node(WORKER_1, view(aHealthyNode({ nodeId: WORKER_1, ageMs: 1_000 })))
    expect(fresh.liveness).toBe("live")
    expect(fresh.badge).toBe("LIVE")
    expect(fresh.heartbeatAgeMs).toBe(1_000)
  })
})

describe("M4.8 an incompatible node is distinguishable from an unreachable one", () => {
  it("is REACHABLE, and says the problem is a version", () => {
    const row = node(WORKER_2, view(anIncompatibleNode({ nodeId: WORKER_2 })))
    // The three members that separate the two cases, asserted together. A view
    // with only `liveness` could not tell these apart, and reporting this as
    // "offline" would send the operator to fix a network problem they do not have.
    expect(row.liveness).toBe("live")
    expect(row.reachable).toBe(true)
    expect(row.protocolCompatible).toBe(false)
    expect(row.negotiatedProtocolVersion).toBeNull()
    expect(row.badge).toBe("INCOMPATIBLE")
  })

  it("differs from a STALE node on every member an operator reads", () => {
    const incompatible = node(WORKER_2, view(anIncompatibleNode({ nodeId: WORKER_2 })))
    const stale = node(WORKER_1, view(aStaleNode({ nodeId: WORKER_1 })))
    expect(incompatible.reachable).toBe(true)
    expect(stale.reachable).toBe(true) // it has spoken; it is just quiet
    expect(incompatible.badge).not.toBe(stale.badge)
    expect(incompatible.protocolCompatible).toBe(false)
    expect(stale.protocolCompatible).toBe(true)
    expect(stale.negotiatedProtocolVersion).not.toBeNull()
  })

  it("differs from a NEVER-SEEN node, which is the third kind of 'not answering'", () => {
    const incompatible = node(WORKER_2, view(anIncompatibleNode({ nodeId: WORKER_2 })))
    const neverSeen = node(WORKER_1, view(aNeverSeenNode({ nodeId: WORKER_1 })))
    expect(incompatible.reachable).toBe(true)
    expect(neverSeen.reachable).toBe(false)
    expect(incompatible.badge).not.toBe(neverSeen.badge)
    // Both have no negotiated version, and only one of them is a version problem.
    expect(incompatible.negotiatedProtocolVersion).toBeNull()
    expect(neverSeen.negotiatedProtocolVersion).toBeNull()
  })

  it("counts the two incompatibilities separately in the summary", () => {
    // "3 nodes, 1 eligible, 2 stale" cannot be read off a list of winners, which is
    // the reason M4.3's `selectCandidates` returns every node. The summary here is
    // the same idea applied to the display.
    const state = reduceMeshTui(initialMeshTuiState(), {
      type: "snapshot-loaded",
      snapshot: aSnapshot({
        nodes: [aHealthyNode({ nodeId: LOCAL }), anIncompatibleNode({ nodeId: WORKER_1 }), aNeverSeenNode({ nodeId: WORKER_2 })],
      }),
    }).state
    expect(buildMeshTuiView(state)!.nodeSummary).toMatchObject({
      total: 3,
      live: 2,
      neverSeen: 1,
      protocolIncompatible: 1,
    })
  })

  it("renders the incompatibility rather than showing an empty version field", () => {
    const state = reduceMeshTui(initialMeshTuiState(), {
      type: "snapshot-loaded",
      snapshot: aSnapshot({ nodes: [anIncompatibleNode({ nodeId: WORKER_2 })] }),
    }).state
    const text = buildMeshTuiView(state)!.lines.join("\n")
    expect(text).toMatch(/\[INCOMPATIBLE\]/)
    expect(text).toMatch(/protocol incompatible/)
  })
})

describe("M4.8 a node row carries what an operator needs and nothing that is a claim", () => {
  it("shows the advertised runtime kinds, capabilities, paths and load", () => {
    const row = node(WORKER_1, view(aHealthyNode({ nodeId: WORKER_1 })))
    expect(row.displayName).toBe("worker-1")
    expect(row.runtimeKinds).toEqual(["opencode"])
    expect(row.capabilities).toEqual(["session.execute"])
    expect(row.projectPathIds).toEqual(["path-release-1"])
    expect(row.load).toEqual({ activeSessions: 0, queuedSessions: 0 })
    expect(row.maxConcurrentSessions).toBe(4)
  })

  it("shows nothing rather than a guess for a node that has never advertised", () => {
    // Empty ARRAYS, not nulls and not placeholders: the node advertised nothing,
    // and rendering an empty capabilities list is the honest statement of that.
    // `null` would read as "the record could not be read", which is a different
    // fault with a different remedy.
    const row = node(WORKER_1, view(aNeverSeenNode({ nodeId: WORKER_1 })))
    expect(row.runtimeKinds).toEqual([])
    expect(row.capabilities).toEqual([])
    expect(row.projectPathIds).toEqual([])
    expect(row.load).toBeNull()
    expect(row.maxConcurrentSessions).toBeNull()
  })

  it("marks this node as local, so 'is this my machine' has an answer", () => {
    const rows = view(aHealthyNode({ nodeId: LOCAL }), aHealthyNode({ nodeId: WORKER_1 }))
    expect(node(LOCAL, rows).isLocal).toBe(true)
    expect(node(WORKER_1, rows).isLocal).toBe(false)
    // And the rendered list uses a marker for it, rather than an operator having
    // to remember which id is theirs.
    const state = reduceMeshTui(initialMeshTuiState(), {
      type: "snapshot-loaded",
      snapshot: aSnapshot({ nodes: [aHealthyNode({ nodeId: LOCAL }), aHealthyNode({ nodeId: WORKER_1 })] }),
    }).state
    const lines = buildMeshTuiView(state)!.lines
    expect(lines.some((line) => line.startsWith("  * controller-a"))).toBe(true)
    expect(lines.some((line) => line.startsWith("    worker-1"))).toBe(true)
  })

  it("carries no authorization member, because a heartbeat is a claim", () => {
    // M4.3 is explicit that a capability advertisement is not a grant. A row with
    // an `authorizes` or `eligible` member would invite a caller to read a
    // positive answer as an authorization, and `canScheduleOn`'s own type carries
    // `authorizes: false` on every member for exactly that reason.
    const row = node(WORKER_1, view(aHealthyNode({ nodeId: WORKER_1 })))
    expect(Object.keys(row).sort()).toEqual(
      [
        "badge",
        "capabilities",
        "displayName",
        "heartbeatAgeMs",
        "isLocal",
        "lastHeartbeatAt",
        "liveness",
        "load",
        "maxConcurrentSessions",
        "negotiatedProtocolVersion",
        "nodeId",
        "projectPathIds",
        "protocolCompatible",
        "reachable",
        "revocationReason",
        "revoked",
        "runtimeKinds",
      ].sort(),
    )
  })
})

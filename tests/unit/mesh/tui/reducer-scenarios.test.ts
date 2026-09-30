import { describe, expect, it } from "vitest"
import {
  MESH_TUI_ACTIONS_BY_STATE,
  MESH_TUI_LEASE_STANDINGS,
  MESH_TUI_NETWORK_STATES,
  MESH_TUI_STATES,
  availableMeshTuiActions,
  buildMeshTuiView,
  initialMeshTuiState,
  leaseStandingOf,
  meshStateOf,
  networkStateOf,
  reduceMeshTui,
  type MeshTuiActionControl,
  type MeshTuiState,
  type MeshTuiUiState,
} from "../../../../src/mesh/tui/index.js"
import {
  LOCAL,
  WORKER_1,
  WORKER_2,
  aHealthyNode,
  aRevokedNode,
  aSessionSnapshot,
  aSnapshot,
  aStaleNode,
  type SnapshotOverrides,
} from "./fixtures.js"

/**
 * M4.8's verification line: "reducer scenarios for EVERY lease/network state".
 *
 * The matrix is enumerated from the code's OWN tables rather than from a list
 * written here, so it cannot drift from the state union: a thirteenth cell, a
 * fifth lease standing or a fourth network state is a row the `it` block below
 * did not anticipate, and the length assertion turns that into a failure rather
 * than into quiet under-coverage.
 *
 * Every row asserts three things, because each is a different claim:
 *
 *   - the CELL, as the union member rather than as the pair it came from. A
 *     `MESH_TUI_STATE_BY_LEASE_AND_NETWORK` that returned `"held-up"` for all
 *     four held rows would still satisfy an expectation written in terms of the
 *     pair, so the assertion is against the cell itself.
 *   - the VIEW STATE — the status line and whether new work is permitted. Four of
 *     the twelve permit new work, and the three readings of a HELD lease are the
 *     hardest case for a collapse, because all three look the same if the network
 *     axis is not read.
 *   - the ACTIONS, written out per row with the protocol reason attached, rather
 *     than derived from the same table the reducer reads.
 */

const NAVIGATION: readonly MeshTuiActionControl[] = ["back", "refresh", "view-degraded", "view-nodes", "view-sessions"]

type Standing = (typeof MESH_TUI_LEASE_STANDINGS)[number]
type Network = (typeof MESH_TUI_NETWORK_STATES)[number]

interface Row {
  readonly lease: Standing
  readonly network: Network
  readonly status: string
  readonly permitsNewWork: boolean
  /** The mesh-level controls, over and above navigation. */
  readonly controls: readonly MeshTuiActionControl[]
  /** Why, in a sentence a reader can check against the protocol. */
  readonly why: string
}

const ROWS: readonly Row[] = [
  {
    lease: "held",
    network: "up",
    status: "CONTROLLING",
    permitsNewWork: true,
    controls: ["reconcile", "renew-lease", "request-takeover"],
    why: "This node holds a current lease on a connected mesh. Renewal extends what this node has and takeover fences it for a successor, so both are meaningful.",
  },
  {
    lease: "held",
    network: "partitioned",
    status: "CONTROLLING (UNCORROBORATED)",
    permitsNewWork: true,
    controls: ["reconcile", "renew-lease"],
    why: "The lease is still current, so new work is permitted — which is exactly why the partition matters. A renewal cannot be delivered and a takeover cannot be corroborated, so reconciliation leads and the takeover is withdrawn. The summary says the copy is uncorroborated rather than presenting it as comfortable.",
  },
  {
    lease: "held",
    network: "healing",
    status: "CONTROLLING (RECONNECTING)",
    permitsNewWork: true,
    controls: ["reconcile", "renew-lease", "request-takeover"],
    why: "Healing is not a partition: the link is coming back, so the takeover is offerable again. Still behind the confirmation, still needing the unreconciled nodes acknowledged.",
  },
  {
    lease: "expired",
    network: "up",
    status: "PAUSED — LEASE EXPIRED",
    permitsNewWork: false,
    controls: ["reconcile", "claim-lease", "request-takeover"],
    why: "New work is refused and NOTHING running is stopped. A claim re-establishes authority at the same epoch — no fence, no successor to reason about.",
  },
  {
    lease: "expired",
    network: "partitioned",
    status: "PAUSED — LEASE EXPIRED",
    permitsNewWork: false,
    controls: ["reconcile", "claim-lease", "request-takeover"],
    why: "Expiry is the dominant fact and the partition does not change it. A claim is riskier over a partition, so the confirmation is where the risk is made visible rather than the control being withheld.",
  },
  {
    lease: "expired",
    network: "healing",
    status: "PAUSED — LEASE EXPIRED",
    permitsNewWork: false,
    controls: ["reconcile", "claim-lease", "request-takeover"],
    why: "A run whose lease lapsed during a partition is the ordinary case this milestone exists for, and every recovery is one click deeper than the fence.",
  },
  {
    lease: "absent",
    network: "up",
    status: "UNCLAIMED",
    permitsNewWork: false,
    controls: ["reconcile", "claim-lease"],
    why: "Nothing to fence, so `request-takeover` is ABSENT from the action set. `evaluateLease` refuses `no_lease_to_fence` there, and offering the control would be offering an operation whose only outcome is that refusal. A claim is the operation that means 'I am starting'.",
  },
  {
    lease: "absent",
    network: "partitioned",
    status: "UNCLAIMED",
    permitsNewWork: false,
    controls: ["reconcile", "claim-lease"],
    why: "Same as `absent-up`, and the partition removes any chance of learning that someone else already claimed it — the condition under which a claim is most dangerous and least verifiable.",
  },
  {
    lease: "absent",
    network: "healing",
    status: "UNCLAIMED",
    permitsNewWork: false,
    controls: ["reconcile", "claim-lease"],
    why: "Same as the other two absent rows. The lease axis decides the actions, not the network axis, and keeping them orthogonal is what makes that visible.",
  },
  {
    lease: "superseded",
    network: "up",
    status: "SUPERSEDED",
    permitsNewWork: false,
    controls: ["reconcile", "request-takeover"],
    why: "This node has been fenced. No claim (`held_by_another_controller`) and no renewal (`no_lease_to_renew`) — offering either would be offering a refusal. A takeover IS offered: a fenced node's operator is exactly the person who may legitimately want control back.",
  },
  {
    lease: "superseded",
    network: "partitioned",
    status: "SUPERSEDED",
    permitsNewWork: false,
    controls: ["reconcile", "request-takeover"],
    why: "Being superseded over a partition is the routine aftermath of one. The fence is a fact here rather than a suspicion, and a takeover is the only way to move the epoch again.",
  },
  {
    lease: "superseded",
    network: "healing",
    status: "SUPERSEDED",
    permitsNewWork: false,
    controls: ["reconcile", "request-takeover"],
    why: "Identical to the other two superseded rows. A successor is a successor whatever the transport is doing.",
  },
]

function ready(overrides: SnapshotOverrides = {}): MeshTuiUiState {
  return reduceMeshTui(initialMeshTuiState(), { type: "snapshot-loaded", snapshot: aSnapshot(overrides) }).state
}

describe("M4.8 the lease/network cross product is total and every cell is reachable", () => {
  it("enumerates all twelve cells from the code's own tables", () => {
    // The multiplication, not a list. A fifth standing or a fourth network state
    // makes this 20 while `ROWS` stays 12, and the length assertion turns that
    // into a failure naming the gap rather than into a suite that quietly covers
    // eleven of twenty.
    expect(MESH_TUI_LEASE_STANDINGS.length * MESH_TUI_NETWORK_STATES.length).toBe(12)
    expect(MESH_TUI_STATES).toHaveLength(12)
    expect(new Set(MESH_TUI_STATES).size).toBe(12)
    expect(ROWS).toHaveLength(MESH_TUI_STATES.length)
    expect(new Set(ROWS.map((row) => meshStateOf(row.lease, row.network))).size).toBe(MESH_TUI_STATES.length)
  })

  it("fills the cell table in both directions without gaps", () => {
    const reached = new Set<MeshTuiState>()
    for (const lease of MESH_TUI_LEASE_STANDINGS) {
      for (const network of MESH_TUI_NETWORK_STATES) {
        const cell = meshStateOf(lease, network)
        reached.add(cell)
        // Both axes read back out of the cell NAME, because the state union is
        // what a caller switches on: a cell that did not decompose would mean the
        // axes could not be recovered from the thing they selected.
        expect(leaseStandingOf(cell), cell).toBe(lease)
        expect(networkStateOf(cell), cell).toBe(network)
      }
    }
    expect([...reached].sort()).toEqual([...MESH_TUI_STATES].sort())
  })

  it("gives the twelve cells twelve different statuses", () => {
    // The strongest non-vacuity claim available: if two cells shared a status, an
    // operator could not tell them apart from the screen at all, and the whole
    // cross product would be presentational rather than real.
    const statuses = ROWS.map((row) => buildMeshTuiView(ready({ leaseKind: row.lease, network: row.network }))!.status)
    // Six distinct readings across the twelve cells: one per lease standing, plus
    // two extra for the three network readings of a HELD lease. The twelve are not
    // twelve spellings of "fine".
    expect(new Set(statuses).size).toBe(6)
    // Three distinct readings of a held lease, which is the axis pair a collapse
    // would be most likely to lose.
    const held = ["up", "partitioned", "healing"].map((network) => buildMeshTuiView(ready({ leaseKind: "held", network: network as Network }))!.status)
    expect(new Set(held).size).toBe(3)
  })
})

describe("M4.8 reducer scenarios for every lease/network state", () => {
  for (const row of ROWS) {
    const cell = meshStateOf(row.lease, row.network)
    it(`${row.lease} + ${row.network} → [${cell}]`, () => {
      const state = ready({ leaseKind: row.lease, network: row.network })
      const view = buildMeshTuiView(state)

      // THE CELL, against the union member rather than the pair.
      expect(state.mesh, row.why).toBe(cell)
      expect(view?.mesh).toBe(cell)
      expect(MESH_TUI_ACTIONS_BY_STATE[cell], row.why).toBeDefined()

      // THE VIEW STATE.
      expect(view?.status, row.why).toBe(row.status)
      expect(view?.lease?.permitsNewWork, row.why).toBe(row.permitsNewWork)
      expect(view?.network).toBe(row.network)

      // THE ACTIONS. Both sides sorted lexicographically rather than compared in
      // the reducer's own `CONTROL_ORDER`, because that order is a PRESENTATION
      // decision and asserting it here would make a reordering of the footer fail
      // a test about which controls exist. The set is the claim; the order is not.
      const actions = availableMeshTuiActions(state)
      expect([...actions].sort(), row.why).toEqual([...NAVIGATION, ...row.controls].sort())
      expect(view?.availableActions).toEqual(actions)
    })
  }
})

describe("M4.8 the twelve cells are twelve different operator situations", () => {
  it("reads a held lease three ways, and withdraws the takeover only over a partition", () => {
    const up = buildMeshTuiView(ready({ leaseKind: "held", network: "up" }))
    const partitioned = buildMeshTuiView(ready({ leaseKind: "held", network: "partitioned" }))
    const healing = buildMeshTuiView(ready({ leaseKind: "held", network: "healing" }))

    expect(new Set([up?.status, partitioned?.status, healing?.status]).size).toBe(3)
    expect(partitioned?.lease?.uncorroborated).toBe(true)
    expect(healing?.lease?.uncorroborated).toBe(true)
    expect(up?.lease?.uncorroborated).toBe(false)
    // A takeover that cannot be corroborated is the operation most likely to
    // produce two controllers for one run, so it is the one that goes.
    expect(availableMeshTuiActions(ready({ leaseKind: "held", network: "partitioned" }))).not.toContain("request-takeover")
    expect(availableMeshTuiActions(ready({ leaseKind: "held", network: "healing" }))).toContain("request-takeover")
  })

  it("distinguishes expired, absent and superseded by their ACTIONS and not only their words", () => {
    const expired = ready({ leaseKind: "expired" })
    const absent = ready({ leaseKind: "absent" })
    const superseded = ready({ leaseKind: "superseded" })

    expect(buildMeshTuiView(absent)?.lease?.controllerNodeId).toBeNull()
    expect(buildMeshTuiView(expired)?.lease?.controllerNodeId).toBe(LOCAL)
    expect(buildMeshTuiView(superseded)?.lease?.controllerNodeId).not.toBe(LOCAL)

    // Renewal is offered only where this node holds the lease: M4.4 refuses a
    // renewal of somebody else's with `no_lease_to_renew`.
    expect(availableMeshTuiActions(ready({ leaseKind: "held" }))).toContain("renew-lease")
    expect(availableMeshTuiActions(expired)).not.toContain("renew-lease")
    // A claim is offered only where one would be accepted.
    expect(availableMeshTuiActions(absent)).toContain("claim-lease")
    expect(availableMeshTuiActions(superseded)).not.toContain("claim-lease")
    // A takeover needs something to fence.
    expect(availableMeshTuiActions(absent)).not.toContain("request-takeover")
    expect(availableMeshTuiActions(superseded)).toContain("request-takeover")
  })

  it("never offers a claim against a CURRENT lease held by another controller", () => {
    // The one combination where a claim would be refused with
    // `held_by_another_controller` rather than merely pointless.
    const rows = MESH_TUI_STATES.filter((cell) => leaseStandingOf(cell) === "superseded")
    for (const cell of rows) {
      expect(MESH_TUI_ACTIONS_BY_STATE[cell], cell).not.toContain("claim-lease")
    }
  })
})

describe("M4.8 unreconciled nodes add controls and never remove the diagnosis", () => {
  const entry = { nodeId: WORKER_2, reason: "session_not_in_projection" as const, detail: "no recorded dispatch" }

  it("offers inspection and acknowledgement only while entries are outstanding", () => {
    const clean = ready({ leaseKind: "held" })
    expect(availableMeshTuiActions(clean)).not.toContain("inspect-unreconciled")
    expect(availableMeshTuiActions(clean)).not.toContain("acknowledge-unreconciled")
    const dirty = ready({ leaseKind: "held", unreconciled: [entry] })
    expect(availableMeshTuiActions(dirty)).toContain("inspect-unreconciled")
    expect(availableMeshTuiActions(dirty)).toContain("acknowledge-unreconciled")
  })

  it("keeps them per node until every one is done, and never in bulk", () => {
    const entries = [
      { nodeId: WORKER_1, reason: "session_not_in_projection" as const, detail: "a" },
      { nodeId: WORKER_2, reason: "projection_without_session" as const, detail: "b" },
    ]
    let state = ready({ leaseKind: "held", unreconciled: entries })
    expect(availableMeshTuiActions(state)).toContain("inspect-unreconciled")

    state = reduceMeshTui(state, { type: "select-node", nodeId: WORKER_1 }).state
    state = reduceMeshTui(state, { type: "inspect-unreconciled" }).state
    // One of two inspected does not remove the control. A bulk "acknowledge all"
    // would let one click satisfy the precondition for a list nobody read.
    expect(availableMeshTuiActions(state)).toContain("inspect-unreconciled")

    state = reduceMeshTui(state, { type: "select-node", nodeId: WORKER_2 }).state
    state = reduceMeshTui(state, { type: "inspect-unreconciled" }).state
    expect(availableMeshTuiActions(state)).not.toContain("inspect-unreconciled")
    // Acknowledgement is a separate list, so it is still owed after inspecting.
    expect(availableMeshTuiActions(state)).toContain("acknowledge-unreconciled")
    expect(state.inspectedUnreconciledNodeIds).toEqual([WORKER_1, WORKER_2])
    expect(state.acknowledgedUnreconciledNodeIds).toEqual([])
  })

  it("shows an entry as something to ACT on and never as resolved", () => {
    const view = buildMeshTuiView(ready({ leaseKind: "held", unreconciled: [entry] }))
    expect(view?.unreconciled).toHaveLength(1)
    expect(view!.unreconciled[0]).toMatchObject({
      nodeId: WORKER_2,
      reason: "session_not_in_projection",
      inspected: false,
      acknowledged: false,
    })
    expect(view!.lines.join("\n")).toMatch(/NOT INSPECTED/)
    expect(view!.lines.join("\n")).toMatch(/Nothing here is adopted or terminated/)
  })

  it("keeps the entry after a reconciliation is requested, and the row has no verb member", () => {
    // Asserted against the keys of the BUILT row, so a `resolved`/`adopted`/
    // `terminated` member added later fails here rather than being rendered as
    // settled by a view nobody re-reads.
    let state = ready({ leaseKind: "held", unreconciled: [entry] })
    state = reduceMeshTui(state, { type: "activate", control: "reconcile" }).state
    const view = buildMeshTuiView(state)
    expect(view?.unreconciled).toHaveLength(1)
    expect(Object.keys(view!.unreconciled[0]!).sort()).toEqual(
      ["acknowledged", "detail", "inspected", "nodeId", "reason"].sort(),
    )
  })
})

describe("M4.8 the degraded list is a list, not a boolean", () => {
  it("accumulates independently rather than collapsing to one row", () => {
    // Three at once. A view with a `healthy: boolean` could report one of these
    // facts or all of them, and all of them is what the operator needs.
    const state = ready({
      leaseKind: "expired",
      unreconciled: [{ nodeId: WORKER_2, reason: "session_not_in_projection" as const, detail: "no recorded dispatch" }],
      nodes: [aHealthyNode({ nodeId: LOCAL }), aStaleNode({ nodeId: WORKER_1 })],
    })
    expect(buildMeshTuiView(state)!.degraded.map((condition) => condition.condition)).toEqual([
      "expired-lease",
      "unreconciled-node",
      "stale-peer",
    ])
  })

  it("reports a mesh with nothing wrong as an empty list, not a healthy flag", () => {
    const view = buildMeshTuiView(ready({ leaseKind: "held" }))
    expect(view?.degraded).toEqual([])
    // The summary still counts nodes, so "nothing degraded" stays distinguishable
    // from "nothing was looked at".
    expect(view?.nodeSummary.total).toBe(2)
  })
})

describe("M4.8 a revoked node is a decision, not a fault", () => {
  it("keeps revocation out of the condition list and in the node summary", () => {
    // A view that listed revocation among the degraded conditions would teach an
    // operator to read their own decision as something to repair.
    const state = ready({ leaseKind: "held", nodes: [aHealthyNode({ nodeId: LOCAL }), aRevokedNode()] })
    const view = buildMeshTuiView(state)
    expect(view!.degraded.map((condition) => condition.condition)).not.toContain("stale-peer")
    expect(view!.nodeSummary.revoked).toBe(1)
    expect(view!.nodeSummary.stale).toBe(0)
  })
})

describe("M4.8 the four screens differ, and none of them hides the lease", () => {
  const withEverything = () => ({
    leaseKind: "expired" as const,
    nodes: [aHealthyNode({ nodeId: LOCAL }), aStaleNode({ nodeId: WORKER_1 })],
    sessions: [aSessionSnapshot()],
    unreconciled: [{ nodeId: WORKER_2, reason: "session_not_in_projection" as const, detail: "no recorded dispatch" }],
  })

  it("shows the lease and the network on every screen, because they change what every row means", () => {
    for (const screen of ["nodes", "sessions", "degraded", "reconciliation"] as const) {
      const state = reduceMeshTui(ready(withEverything()), { type: "navigate", screen }).state
      const text = buildMeshTuiView(state)!.lines.join("\n")
      expect(text, screen).toMatch(/New work: REFUSED/)
      expect(text, screen).toMatch(/Mesh: up/)
    }
  })

  it("shows the unreconciled list on every screen, so its absence is never its absence from the mesh", () => {
    for (const screen of ["nodes", "sessions", "degraded", "reconciliation"] as const) {
      const state = reduceMeshTui(ready(withEverything()), { type: "navigate", screen }).state
      expect(buildMeshTuiView(state)!.lines.join("\n"), screen).toMatch(/UNRECONCILED/)
    }
  })

  it("keeps the node table off the session screen, so a node's health is not read as a session's state", () => {
    const onSessions = buildMeshTuiView(reduceMeshTui(ready(withEverything()), { type: "navigate", screen: "sessions" }).state)!.lines.join("\n")
    expect(onSessions).toMatch(/Sessions:/)
    expect(onSessions).not.toMatch(/Nodes: \d+ total/)
    for (const screen of ["nodes", "reconciliation"] as const) {
      expect(buildMeshTuiView(reduceMeshTui(ready(withEverything()), { type: "navigate", screen }).state)!.lines.join("\n"), screen).toMatch(/Nodes: \d+ total/)
    }
  })

  it("'Back' lands on reconciliation, never on a screen of healthy-looking machines", () => {
    // The screen the operator came from is not tracked, so a Back that returned to
    // the node list would put a partition behind a page of nodes that look fine.
    const state = reduceMeshTui(
      reduceMeshTui(ready({ leaseKind: "held", network: "partitioned" }), { type: "navigate", screen: "nodes" }).state,
      { type: "activate", control: "back" },
    ).state
    expect(state.screen).toBe("reconciliation")
    expect(buildMeshTuiView(state)!.lines.join("\n")).toMatch(/uncorroborated/)
  })
})

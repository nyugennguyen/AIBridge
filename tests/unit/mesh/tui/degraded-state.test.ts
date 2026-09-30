import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { MESH_OUTBOX_MAX_ATTEMPTS, exceedsMaxAttempts } from "../../../../src/mesh/outbox/policy.js"
import { MAX_HEARTBEAT_AGE_MS } from "../../../../src/mesh/protocol/bounds.js"
import {
  MESH_TUI_DEGRADED_CONDITIONS,
  MESH_TUI_OPERATOR_ACTIONS,
  MESH_TUI_ACTION_LABELS_BY_REMEDY,
  MESH_TUI_CONDITION_ACTIONS,
  MESH_TUI_STATES,
  buildMeshTuiView,
  deriveDegradedConditions,
  initialMeshTuiState,
  reduceMeshTui,
  type MeshTuiDegradedCondition,
  type MeshTuiDegradedConditionView,
  type MeshTuiOperatorAction,
  type MeshTuiSnapshot,
  type MeshTuiUiState,
  type MeshTuiViewModel,
} from "../../../../src/mesh/tui/index.js"
import {
  LOCAL,
  WORKER_1,
  WORKER_2,
  WORKER_3,
  aHealthyNode,
  aNeverSeenNode,
  aPoisonedOutboxRow,
  aRetryingOutboxRow,
  aSnapshot,
  aStaleNode,
  anIncompatibleNode,
} from "./fixtures.js"

const TUI_DIRECTORY = join(import.meta.dirname, "../../../../src/mesh/tui")

/**
 * The five degraded conditions, and the claim that makes them five.
 *
 * The milestone says the mesh is not binary healthy/unhealthy, and this file is
 * what makes that checkable rather than asserted. Three properties, each covering
 * a different way the claim could be quietly false:
 *
 *   1. **Five conditions, five DISTINCT remedies.** If two conditions named the
 *      same remedy, this view had decided they are the same problem — which is the
 *      collapse the list exists to prevent. The mapping is read off the built rows
 *      rather than from a list written here, so a condition added without a remedy
 *      fails.
 *   2. **All five at once, and no two of them mask each other.** A summary line
 *      that reported only the first would be indistinguishable from a view that
 *      only found the first.
 *   3. **Each is derived from a DIFFERENT fact in a DIFFERENT owner's record.** An
 *      expired lease comes from M4.4, a stale peer from M4.3's liveness, a poisoned
 *      row from M4.5's attempt count. If two conditions read the same field, one of
 *      them is a restatement.
 *
 * The two negative bounds are as load-bearing as the five: a node that has merely
 * gone quiet is NOT an unreachable node, and a node that heartbeats on an
 * unnegotiable version is NOT offline. Collapsing either would send an operator to
 * fix a problem they do not have.
 */

function degraded(snapshot: MeshTuiSnapshot): readonly MeshTuiDegradedConditionView[] {
  const state: MeshTuiUiState = reduceMeshTui(initialMeshTuiState(), { type: "snapshot-loaded", snapshot }).state
  return deriveDegradedConditions(state)
}

function view(snapshot: MeshTuiSnapshot): MeshTuiViewModel {
  return buildMeshTuiView(reduceMeshTui(initialMeshTuiState(), { type: "snapshot-loaded", snapshot }).state)!
}

const STALE = aStaleNode({ nodeId: WORKER_1 })
const INCOMPATIBLE = anIncompatibleNode({ nodeId: WORKER_2 })
const POISON = aPoisonedOutboxRow()
const ENTRY = { nodeId: WORKER_3, reason: "session_not_in_projection" as const, detail: "the controller's log records no dispatch for the session the peer reports" }

describe("M4.8 there are five conditions and five distinct remedies", () => {
  it("the vocabulary is five long, stated against the code's own array", () => {
    expect(MESH_TUI_DEGRADED_CONDITIONS).toHaveLength(5)
    expect(new Set(MESH_TUI_DEGRADED_CONDITIONS).size).toBe(5)
    expect([...MESH_TUI_DEGRADED_CONDITIONS].sort()).toEqual(
      ["expired-lease", "poisoned-outbox-row", "protocol-mismatch", "stale-peer", "unreconciled-node"].sort(),
    )
    expect(MESH_TUI_OPERATOR_ACTIONS).toHaveLength(5)
  })

  it("each condition names a remedy, and the remedies are pairwise distinct", () => {
    // One snapshot with all five present, and the mapping read off the BUILT rows.
    const rows = degraded(
      aSnapshot({
        leaseKind: "expired",
        unreconciled: [ENTRY],
        nodes: [aHealthyNode({ nodeId: LOCAL }), STALE, INCOMPATIBLE],
        outbox: [POISON],
      }),
    )
    expect(rows.map((row) => row.condition)).toHaveLength(5)
    const actions = rows.map((row) => row.action)
    expect(new Set(actions).size).toBe(5)
    expect([...actions].sort()).toEqual([...MESH_TUI_OPERATOR_ACTIONS].sort())
    // And the LABEL is distinct too: a label is what an operator reads, and two
    // conditions sharing a sentence would be as collapsed as sharing a key.
    const labels = rows.map((row) => row.actionLabel)
    expect(new Set(labels).size).toBe(5)
    for (const row of rows) {
      expect(row.actionLabel.length, row.condition).toBeGreaterThan(30)
    }
  })

  it("states the mapping against the source, so a condition added without one fails", () => {
    // Read out of the built rows for every condition, then compared to the
    // declared vocabulary. A condition the reducer can produce and the action
    // vocabulary cannot name is a condition whose remedy no caller can resolve.
    const produced = new Map<MeshTuiDegradedCondition, MeshTuiOperatorAction>()
    for (const snapshot of [
      aSnapshot({ leaseKind: "expired" }),
      aSnapshot({ unreconciled: [ENTRY] }),
      aSnapshot({ nodes: [aHealthyNode({ nodeId: LOCAL }), STALE] }),
      aSnapshot({ nodes: [aHealthyNode({ nodeId: LOCAL }), INCOMPATIBLE] }),
      aSnapshot({ outbox: [POISON] }),
    ]) {
      for (const row of degraded(snapshot)) produced.set(row.condition, row.action)
    }
    expect([...produced.keys()].sort()).toEqual([...MESH_TUI_DEGRADED_CONDITIONS].sort())
    expect(new Set(produced.values()).size).toBe(MESH_TUI_DEGRADED_CONDITIONS.length)
  })
})

describe("M4.8 each condition names the operator action it implies", () => {
  it("a stale peer: wait, and do NOT stop its sessions", () => {
    const [condition] = degraded(aSnapshot({ nodes: [aHealthyNode({ nodeId: LOCAL }), STALE] }))
    expect(condition).toMatchObject({ condition: "stale-peer", subject: { kind: "node", nodeId: WORKER_1 }, action: "wait-for-heartbeat" })
    expect(condition!.detail).toMatch(/past the heartbeat bound/)
    // The guardrail the plan states as a prohibition, restated as the remedy's
    // own text: a node going quiet is a node coming back, and stopping it would
    // be a termination the mesh never authorised.
    expect(condition!.actionLabel).toMatch(/Its sessions are not stopped and must not be/)
  })

  it("an unreconciled node: inspect, then accept it as degraded or wait", () => {
    const [condition] = degraded(aSnapshot({ unreconciled: [ENTRY] }))
    expect(condition).toMatchObject({ condition: "unreconciled-node", subject: { kind: "node", nodeId: WORKER_3 }, action: "inspect-and-acknowledge" })
    expect(condition!.detail).toContain("Nothing has been adopted and nothing has been terminated")
    expect(condition!.actionLabel).toMatch(/Accept each unreconciled node|Inspect each unreconciled node/)
  })

  it("an expired lease: claim or take over, and nothing running stops either way", () => {
    const [condition] = degraded(aSnapshot({ leaseKind: "expired" }))
    expect(condition).toMatchObject({ condition: "expired-lease", subject: { kind: "run", runId: "run-release-1" }, action: "claim-or-take-over" })
    // The plan's "does not kill running agents", stated on the row rather than in
    // a comment. A view that let an operator read an expiry as a stoppage would be
    // the mechanism by which that guardrail got violated in practice.
    expect(condition!.detail).toMatch(/Running agents are untouched/)
    expect(condition!.actionLabel).toMatch(/Nothing already running is stopped either way/)
  })

  it("a protocol mismatch: upgrade the peer, and it is never schedulable", () => {
    const [condition] = degraded(aSnapshot({ nodes: [aHealthyNode({ nodeId: LOCAL }), INCOMPATIBLE] }))
    expect(condition).toMatchObject({ condition: "protocol-mismatch", subject: { kind: "node", nodeId: WORKER_2 }, action: "upgrade-peer" })
    expect(condition!.detail).toMatch(/never a scheduling candidate/)
    // The distinction this condition exists to keep: the node ANSWERED.
    expect(condition!.detail).toMatch(/This is a version problem, not a reachability one — the node answered/)
  })

  it("a poisoned outbox row: read it, and never delete it", () => {
    const [condition] = degraded(aSnapshot({ outbox: [POISON] }))
    expect(condition).toMatchObject({ condition: "poisoned-outbox-row", subject: { kind: "outbox-row", outboxId: POISON.outboxId }, action: "inspect-outbox-row" })
    expect(condition!.detail).toContain(`after ${MESH_OUTBOX_MAX_ATTEMPTS} attempt(s)`)
    // M4.5's own reason for retaining a terminal row, restated where an operator
    // is about to decide what to do with it: the outbox is evidence.
    expect(condition!.detail).toMatch(/retained on purpose/)
    expect(condition!.actionLabel).toMatch(/never deleted and never retried past the threshold/)
  })
})

describe("M4.8 all five coexist and none masks another", () => {
  const allFive = () =>
    aSnapshot({
      leaseKind: "expired",
      unreconciled: [ENTRY],
      nodes: [aHealthyNode({ nodeId: LOCAL }), STALE, INCOMPATIBLE],
      outbox: [POISON],
    })

  it("lists all five, in the order the operator needs them", () => {
    const rows = degraded(allFive())
    expect(rows.map((row) => row.condition)).toEqual([
      // The two that gate a takeover lead, because an operator reading top-down
      // should learn what is blocking them before what is merely worth knowing.
      "expired-lease",
      "unreconciled-node",
      "stale-peer",
      "protocol-mismatch",
      "poisoned-outbox-row",
    ])
  })

  it("renders every one of them with its own remedy line", () => {
    const text = view(allFive()).lines.join("\n")
    for (const condition of MESH_TUI_DEGRADED_CONDITIONS) expect(text, condition).toContain(`[${condition}]`)
    // Five `→` remedy lines, so none of them collapsed into a shared footer.
    expect(text.split("\n").filter((line) => line.trimStart().startsWith("→"))).toHaveLength(5)
  })

  it("is NOT a boolean, and a row carries a subject rather than a bare string", () => {
    const rows = degraded(allFive())
    for (const row of rows) {
      expect(["node", "run", "outbox-row"], row.condition).toContain(row.subject.kind)
      expect(row.detail.length, row.condition).toBeGreaterThan(40)
    }
    // And a snapshot with nothing wrong is an EMPTY list rather than a flag: "no
    // conditions" and "not looked at" have to stay distinguishable, which is why
    // `nodeSummary` exists alongside.
    expect(degraded(aSnapshot({ leaseKind: "held" }))).toEqual([])
    expect(view(aSnapshot({ leaseKind: "held" })).nodeSummary.total).toBe(2)
  })
})

describe("M4.8 each condition is derived from a different owner's record", () => {
  it("reads M4.4 for the lease, M4.3 for liveness, M4.5 for the attempt count, M4.6 for the difference", () => {
    // A mesh with all four owners disagreeing about the SAME node, so the only
    // thing separating the four rows is which record each was read from.
    const rows = degraded(
      aSnapshot({
        leaseKind: "expired",
        unreconciled: [{ nodeId: WORKER_1, reason: "sequence_gap" as const, detail: "the peer's local sequence skipped 7" }],
        nodes: [aHealthyNode({ nodeId: LOCAL }), aStaleNode({ nodeId: WORKER_1, ageMs: MAX_HEARTBEAT_AGE_MS + 1_000 })],
        outbox: [{ outboxId: "outbox-1", status: "failed", attempts: MESH_OUTBOX_MAX_ATTEMPTS, destination: WORKER_1 }],
      }),
    )
    expect(rows.map((row) => row.condition).sort()).toEqual(["expired-lease", "poisoned-outbox-row", "stale-peer", "unreconciled-node"])
  })

  it("decides 'poisoned' with M4.5's own threshold, not a number restated here", () => {
    // The boundary either side of M4.5's constant. A second threshold in this
    // directory would be a second number that could be raised independently of the
    // pump's, and a row that stopped being terminal would quietly stop being
    // shown.
    const below = aRetryingOutboxRow({ attempts: MESH_OUTBOX_MAX_ATTEMPTS - 1 })
    const at = aPoisonedOutboxRow({ attempts: MESH_OUTBOX_MAX_ATTEMPTS })
    expect(exceedsMaxAttempts(below.attempts)).toBe(false)
    expect(exceedsMaxAttempts(at.attempts)).toBe(true)
    expect(degraded(aSnapshot({ outbox: [below] })).map((row) => row.condition)).not.toContain("poisoned-outbox-row")
    expect(degraded(aSnapshot({ outbox: [at] })).map((row) => row.condition)).toContain("poisoned-outbox-row")
  })

  it("does not report a row that has merely not been claimed", () => {
    // A fresh `pending` row is ordinary work in flight, and calling it poison
    // would train an operator to ignore the condition entirely.
    expect(degraded(aSnapshot({ outbox: [{ outboxId: "outbox-fresh", status: "pending", attempts: 0, destination: LOCAL }] }))).toEqual([])
  })
})

describe("M4.8 two negative bounds the conditions must not cross", () => {
  it("does not report a stale node as unreachable, and a never-seen node is not stale", () => {
    // "Stale" is `past MAX_HEARTBEAT_AGE_MS`, and "never seen" is `capability ===
    // null`. A view that reported the second as the first would tell an operator
    // to wait for a heartbeat from a machine that has never spoken.
    expect(degraded(aSnapshot({ nodes: [aHealthyNode({ nodeId: LOCAL }), aStaleNode({ nodeId: WORKER_1 })] })).map((row) => row.condition)).toEqual(["stale-peer"])
    expect(degraded(aSnapshot({ nodes: [aHealthyNode({ nodeId: LOCAL }), aNeverSeenNode({ nodeId: WORKER_1 })] }))).toEqual([])
  })

  it("does not report a protocol mismatch for a node that never spoke", () => {
    // A never-seen node has no version to mismatch, and reporting one would send
    // the operator to upgrade a machine nobody has heard from.
    expect(degraded(aSnapshot({ nodes: [aHealthyNode({ nodeId: LOCAL }), aNeverSeenNode({ nodeId: WORKER_1 })] }))).toEqual([])
  })

  it("reports all four of the node-shaped conditions as DISTINCT rows, not one 'offline'", () => {
    // The four ways a peer is not doing what it should, side by side. Only two of
    // them are conditions — a stale node and an incompatible one — and the point
    // is that a mesh with both shows BOTH rather than one "not healthy" row.
    const rows = degraded(
      aSnapshot({
        nodes: [aHealthyNode({ nodeId: LOCAL }), aStaleNode({ nodeId: WORKER_1 }), anIncompatibleNode({ nodeId: WORKER_2 }), aNeverSeenNode({ nodeId: WORKER_3 })],
      }),
    )
    expect(rows.map((row) => row.condition).sort()).toEqual(["protocol-mismatch", "stale-peer"])
    expect(new Set(rows.map((row) => row.action)).size).toBe(2)
  })
})

describe("M4.8 the conditions hold in every mesh cell", () => {
  it("a stale peer and a poisoned row are reported whatever the lease is doing", () => {
    // These two are about a PEER and a ROW, not about the run's authority. If the
    // lease standing gated them, a partitioned controller — the situation where a
    // stale peer matters most — would show the least.
    for (const cell of MESH_TUI_STATES) {
      const lease = cell.startsWith("absent") ? "absent" : cell.startsWith("expired") ? "expired" : cell.startsWith("superseded") ? "superseded" : "held"
      const rows = degraded(
        aSnapshot({ leaseKind: lease, network: cell.slice(cell.lastIndexOf("-") + 1) as "up", nodes: [aHealthyNode({ nodeId: LOCAL }), STALE], outbox: [POISON] }),
      )
      // Filtered to the two this test is about, because the expired cells also
      // carry `expired-lease` and the next test asserts that separately. The
      // assertion is that both are PRESENT in every cell, which is the claim.
      expect(rows.map((row) => row.condition), cell).toEqual(
        expect.arrayContaining(["stale-peer", "poisoned-outbox-row"]),
      )
    }
  })

  it("an expired lease is reported in every cell, and only the expired cells", () => {
    for (const cell of MESH_TUI_STATES) {
      const lease = cell.startsWith("absent") ? "absent" : cell.startsWith("expired") ? "expired" : cell.startsWith("superseded") ? "superseded" : "held"
      const rows = degraded(aSnapshot({ leaseKind: lease, network: cell.slice(cell.lastIndexOf("-") + 1) as "up" }))
      expect(rows.map((row) => row.condition).includes("expired-lease"), cell).toBe(lease === "expired")
    }
  })
})

describe("M4.8 the vocabulary is closed in code, not only in a test", () => {
  it("the condition-to-remedy mapping is a total `Record` over the declared condition vocabulary", () => {
    // A `switch` over a locally-invented union would make the two arrays in
    // `./types.ts` decorative. The mapping is a `Record<MeshTuiDegradedCondition,
    // MeshTuiOperatorAction>`, so a sixth condition is a COMPILE error until someone
    // names its remedy — which is the property this asserts, against the exported
    // object rather than against the source text.
    expect(Object.keys(MESH_TUI_CONDITION_ACTIONS).sort()).toEqual([...MESH_TUI_DEGRADED_CONDITIONS].sort())
    expect(Object.keys(MESH_TUI_ACTION_LABELS_BY_REMEDY).sort()).toEqual([...MESH_TUI_OPERATOR_ACTIONS].sort())
    expect(new Set(Object.values(MESH_TUI_CONDITION_ACTIONS)).size).toBe(MESH_TUI_DEGRADED_CONDITIONS.length)
  })

  it("decides staleness with M4.3's liveness and poison with M4.5's threshold, re-deriving neither", () => {
    // Both bounds live in the OWNING directories, and the TUI reads them rather
    // than restating them. A second staleness rule here would disagree with the
    // registry about which node is quiet at the exact moment the operator needs
    // them to agree.
    expect(MESH_TUI_CONDITION_ACTIONS["stale-peer"]).toBe("wait-for-heartbeat")
    const source = readFileSync(join(TUI_DIRECTORY, "view-model.ts"), "utf8")
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    expect(code).toMatch(/exceedsMaxAttempts/)
    expect(code).not.toMatch(/MAX_HEARTBEAT_AGE_MS|90000|90_000/)
  })

  it("every file in the directory is part of the pure layer, with no hidden effect", () => {
    // A belt-and-braces check on the "presentation layer, no mesh operations" rule
    // that `takeover-confirmation.test.ts` states as an import check. This one is
    // about the directory as a whole: no file may open a connection, and none may
    // declare a function that a caller could mistake for a mesh operation.
    for (const file of readdirSync(TUI_DIRECTORY).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(TUI_DIRECTORY, file), "utf8")
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      expect(code, file).not.toMatch(/\bawait\b/)
      expect(code, file).not.toMatch(/\bfetch\(|createInMemoryDriver|new Sqlite/)
    }
  })
})

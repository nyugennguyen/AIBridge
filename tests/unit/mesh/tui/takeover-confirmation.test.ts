import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  MESH_TUI_ACTION_CONTROLS,
  MESH_TUI_ACTION_TYPES,
  MESH_TUI_STATES,
  MESH_TUI_TAKEOVER_BLOCKERS,
  availableMeshTuiActions,
  buildMeshTuiView,
  initialMeshTuiState,
  meshStateOf,
  reduceMeshTui,
  takeoverBlockers,
  type MeshTuiAction,
  type MeshTuiIntent,
  type MeshTuiSnapshot,
  type MeshTuiState,
  type MeshTuiUiState,
} from "../../../../src/mesh/tui/index.js"
import { LEASE_1, LEASE_2, LOCAL, OTHER_RUN, PROJECT, RUN, SCOPE, WORKER_1, WORKER_2, WORKER_3, aHealthyNode, aSnapshot } from "./fixtures.js"

const TUI_DIRECTORY = join(import.meta.dirname, "../../../../src/mesh/tui")

/**
 * The takeover, which the plan fences hardest.
 *
 * Four properties, each a different failure the others do not cover:
 *
 *   1. **A confirmation is required.** Reaching the operation is two explicit
 *      actions — open the dialog, then arm it — and the dialog opens ON BACK, so
 *      a stray Enter dismisses it. The same rule `src/tui` applies to every
 *      destructive dialog, and for the same reason: a confirmation that is armed
 *      by default is a confirmation that is one Enter away from a fence.
 *   2. **The unreconciled nodes must be INSPECTED and then ACCEPTED, separately.**
 *      M4.4 refuses a takeover that does not name every unreconciled node, and
 *      the view adds the step before it: the nodes have to be opened, not merely
 *      counted. One boolean for "seen" would collapse the two and reduce M4.4's
 *      guard to a formality.
 *   3. **A takeover for the wrong run is REFUSED, not retargeted.** Retargeting
 *      would produce a fence against a lease the operator never read a
 *      confirmation for, which is the whole class of thing the dialog prevents.
 *   4. **No other path exists.** Every action type, driven in every mesh cell,
 *      from a state that is as close to a takeover as the machine can get: only
 *      the confirmed, armed, unblocked `confirm-takeover` produces the intent.
 *      This is the plan's "do not implement auto-election" stated against this
 *      directory's own surface rather than asserted in a comment.
 */

function ready(overrides: Parameters<typeof aSnapshot>[0] = {}): MeshTuiUiState {
  return reduceMeshTui(initialMeshTuiState(), { type: "snapshot-loaded", snapshot: aSnapshot(overrides) }).state
}

/** The state a takeover WOULD be confirmed from, if every precondition held. */
function readyToConfirm(overrides: Parameters<typeof aSnapshot>[0] = {}): MeshTuiUiState {
  let state = ready(overrides)
  state = reduceMeshTui(state, { type: "request-takeover" }).state
  state = reduceMeshTui(state, { type: "takeover-reason", reason: REASON }).state
  state = reduceMeshTui(state, { type: "set-confirmation-armed", armed: true }).state
  return state
}

const ENTRY_A = { nodeId: WORKER_2, reason: "session_not_in_projection" as const, detail: "no recorded dispatch" }
const ENTRY_B = { nodeId: WORKER_3, reason: "projection_without_session" as const, detail: "the controller believes a session this node does not have" }

const REASON = "controller A partitioned; operator moved control after inspecting the degraded nodes"

/** A scope this view is not showing, for the wrong-run refusals. */
const OTHER_SCOPE = { projectId: PROJECT, runId: OTHER_RUN }

/**
 * One representative action per type, plus variants of the dangerous ones.
 *
 * The variants matter: a hand-built `confirm-takeover` naming a different run is
 * the shape a confused caller would send, and a `takeover-reason` set directly is
 * how a shell would pre-fill the field. Both are driven below from a state that is
 * otherwise ready, so a refusal cannot be attributed to some other unmet
 * precondition.
 *
 * Module scope rather than inside the `describe` that uses it, because the blocker
 * -vocabulary test below needs the same list and a `const` declared inside one
 * `describe` is invisible to its sibling.
 */
const ACTIONS: readonly MeshTuiAction[] = [
  { type: "snapshot-loaded", snapshot: aSnapshot({ leaseKind: "expired", unreconciled: [ENTRY_A] }) },
  { type: "shell-unavailable", reason: "the mesh store is unreadable" },
  { type: "select-node", nodeId: WORKER_2 },
  { type: "select-session", sessionId: "session-1" as never },
  { type: "navigate", screen: "degraded" },
  { type: "activate", control: "request-takeover" },
  { type: "activate", control: "confirm-takeover" },
  { type: "activate", control: "acknowledge-unreconciled" },
  { type: "set-overlay", overlay: "takeover-confirmation" },
  { type: "dismiss-overlay" },
  { type: "set-confirmation-armed", armed: true },
  { type: "takeover-reason", reason: "typed straight into the reducer" },
  { type: "inspect-unreconciled" },
  { type: "acknowledge-unreconciled" },
  { type: "request-takeover" },
  { type: "confirm-takeover", scope: { projectId: PROJECT, runId: OTHER_RUN } },
  { type: "set-notice", notice: "the mesh looks fine to me" },
  { type: "set-pending", pending: null },
]

/** The lease standing a mesh cell names, for the loops that iterate the twelve. */
function standingOfCell(cell: MeshTuiState): "held" | "expired" | "absent" | "superseded" {
  if (cell.startsWith("absent")) return "absent"
  if (cell.startsWith("expired")) return "expired"
  if (cell.startsWith("superseded")) return "superseded"
  return "held"
}

describe("M4.8 a takeover is offered only as an explicit user action", () => {
  it("is not offered as a control at all — only a REQUEST for it is", () => {
    // The vocabulary split is the guard's first half. `request-takeover` opens a
    // dialog; the operation is an intent with one producer. A control named
    // `takeover` would be a control whose activation a future caller could wire
    // straight to the lease seam.
    expect(MESH_TUI_ACTION_CONTROLS).toContain("request-takeover")
    expect(MESH_TUI_ACTION_CONTROLS).not.toContain("takeover")
  })

  it("is not reachable by activating anything but the request, and the request opens nothing else", () => {
    const state = ready({ leaseKind: "expired" })
    for (const control of MESH_TUI_ACTION_CONTROLS) {
      const transition = reduceMeshTui(state, { type: "activate", control })
      expect(transition.intents.map((intent) => intent.type), control).not.toContain("request-takeover")
      // `request-takeover` is the only control that changes the overlay, and what
      // it changes it to is the confirmation and nothing else.
      if (transition.state.overlay !== state.overlay) {
        expect(transition.state.overlay, control).toBe("takeover-confirmation")
      }
    }
  })

  it("is refused with a reason where there is nothing to fence", () => {
    const state = ready({ leaseKind: "absent" })
    const transition = reduceMeshTui(state, { type: "request-takeover" })
    expect(transition.state.overlay).toBe("none")
    expect(transition.state.notice).toMatch(/no lease to take over/i)
    expect(transition.state.notice).toMatch(/claim/i)
  })

  it("is withdrawn over a partition even where the lease is held", () => {
    // A takeover that cannot be corroborated is the operation most likely to
    // produce two controllers for one run, so the control is not merely disabled
    // — it is not in the action set at all.
    const partitioned = ready({ leaseKind: "held", network: "partitioned" })
    expect(availableMeshTuiActions(partitioned)).not.toContain("request-takeover")
    const transition = reduceMeshTui(partitioned, { type: "request-takeover" })
    expect(transition.state.overlay).toBe("none")
    expect(transition.intents).toHaveLength(0)
  })

  it("cannot be reached by opening the dialog directly, which would bypass the cell's action set", () => {
    // `set-overlay` is generic, so it is the obvious back door: force the dialog
    // up, arm it, confirm. The `request-takeover` availability check is what stops
    // a PARTITIONED node from doing that, and a bypass of it would restore exactly
    // the uncorroborated fence the control set withholds.
    for (const overrides of [
      { leaseKind: "held", network: "partitioned" } as const,
      { leaseKind: "absent" } as const,
    ]) {
      let state = ready(overrides)
      state = reduceMeshTui(state, { type: "set-overlay", overlay: "takeover-confirmation" }).state
      expect(state.overlay, JSON.stringify(overrides)).toBe("none")
      state = reduceMeshTui(state, { type: "set-confirmation-armed", armed: true }).state
      state = reduceMeshTui(state, { type: "takeover-reason", reason: REASON }).state
      expect(reduceMeshTui(state, { type: "confirm-takeover", scope: SCOPE }).intents, JSON.stringify(overrides)).toHaveLength(0)
    }
    // And where it IS offered, `set-overlay` still lands on an unarmed dialog.
    const opened = reduceMeshTui(ready({ leaseKind: "expired" }), { type: "set-overlay", overlay: "takeover-confirmation" }).state
    expect(opened.overlay).toBe("takeover-confirmation")
    expect(opened.confirmationArmed).toBe(false)
  })
})

describe("M4.8 the confirmation is required and opens on Back", () => {
  it("requires the dialog before anything else", () => {
    const state = ready({ leaseKind: "expired" })
    const summary = buildMeshTuiView(state)!.takeover!
    expect(summary.confirmable).toBe(false)
    expect(summary.blockers.map((blocker) => blocker.blocker)).toContain("confirmation-required")
  })

  it("opens unarmed, so Enter dismisses rather than fences", () => {
    const opened = reduceMeshTui(ready({ leaseKind: "expired" }), { type: "request-takeover" }).state
    expect(opened.overlay).toBe("takeover-confirmation")
    expect(opened.confirmationArmed).toBe(false)
    // And the rendered line puts the operator on Back, with the destructive
    // control named but not selected.
    expect(buildMeshTuiView(opened)!.lines.join("\n")).toMatch(
      /Back  \[Confirm the takeover\] — Tab selects it; Enter goes Back/,
    )
  })

  it("refuses to arm outside a dialog, so a stray Tab cannot pre-arm the next one", () => {
    const state = ready({ leaseKind: "expired" })
    const armed = reduceMeshTui(state, { type: "set-confirmation-armed", armed: true }).state
    expect(armed.confirmationArmed).toBe(false)
  })

  it("needs an explicit focus move even with the dialog open, a reason, and nothing outstanding", () => {
    // Everything except the arm. Each of the three is satisfied on purpose so
    // that the refusal names the arm and not something else.
    let state = ready({ leaseKind: "expired" })
    state = reduceMeshTui(state, { type: "request-takeover" }).state
    state = reduceMeshTui(state, { type: "takeover-reason", reason: "operator moved control after inspection" }).state
    const transition = reduceMeshTui(state, { type: "confirm-takeover", scope: SCOPE })
    expect(transition.intents).toHaveLength(0)
    expect(transition.state.notice).toMatch(/Move focus onto 'Confirm the takeover'/)
  })
})

describe("M4.8 the unreconciled nodes must be inspected AND accepted, and the refusal says which", () => {
  it("refuses while a node is uninspected, and names it", () => {
    const state = readyToConfirm({ leaseKind: "expired", unreconciled: [ENTRY_A, ENTRY_B] })
    const transition = reduceMeshTui(state, { type: "confirm-takeover", scope: SCOPE })
    expect(transition.intents).toHaveLength(0)
    expect(transition.state.notice).toContain(WORKER_2)
    expect(transition.state.notice).toContain(WORKER_3)
    expect(transition.state.notice).toMatch(/Inspect the unreconciled node/)
    // The two blockers are SEPARATE, and inspecting is reported before accepting
    // so the operator is told the first thing still owed.
    const blockers = takeoverBlockers(state, SCOPE)
    expect(blockers.map((blocker) => blocker.blocker)).toContain("unreconciled-not-inspected")
    expect(blockers.map((blocker) => blocker.blocker)).toContain("unreconciled-not-acknowledged")
  })

  it("still refuses after inspection alone, because acceptance is a separate act", () => {
    let state = ready({ leaseKind: "expired", unreconciled: [ENTRY_A] })
    state = reduceMeshTui(state, { type: "request-takeover" }).state
    state = reduceMeshTui(state, { type: "select-node", nodeId: WORKER_2 }).state
    state = reduceMeshTui(state, { type: "inspect-unreconciled" }).state
    state = reduceMeshTui(state, { type: "takeover-reason", reason: "operator moved control" }).state
    state = reduceMeshTui(state, { type: "set-confirmation-armed", armed: true }).state

    const inspected = reduceMeshTui(state, { type: "confirm-takeover", scope: SCOPE })
    expect(inspected.state.inspectedUnreconciledNodeIds).toEqual([WORKER_2])
    expect(inspected.state.acknowledgedUnreconciledNodeIds).toEqual([])
    expect(inspected.intents).toHaveLength(0)
    expect(inspected.state.notice).toMatch(/Accept the unreconciled node/)
    expect(inspected.state.notice).toContain(WORKER_2)
  })

  it("refuses a PARTIAL acceptance, naming only what is left", () => {
    // The same shape M4.4's own refusal has: the operator's next action is what
    // is still missing, and repeating the accepted node would put noise in the one
    // sentence they read.
    let state = ready({ leaseKind: "expired", unreconciled: [ENTRY_A, ENTRY_B] })
    state = reduceMeshTui(state, { type: "request-takeover" }).state
    for (const nodeId of [WORKER_2, WORKER_3]) {
      state = reduceMeshTui(state, { type: "select-node", nodeId }).state
      state = reduceMeshTui(state, { type: "inspect-unreconciled" }).state
      state = reduceMeshTui(state, { type: "acknowledge-unreconciled" }).state
    }
    state = reduceMeshTui(state, { type: "takeover-reason", reason: "operator moved control" }).state
    state = reduceMeshTui(state, { type: "set-confirmation-armed", armed: true }).state

    // A fresh reconciliation marks a THIRD node. The two acceptances above no
    // longer cover the set, and the confirmation must notice.
    const withNew = reduceMeshTui(state, {
      type: "snapshot-loaded",
      snapshot: aSnapshot({
        leaseKind: "expired",
        unreconciled: [ENTRY_A, ENTRY_B, { nodeId: WORKER_1, reason: "epoch_divergence" as const, detail: "this node reports epoch 1 while the run is at 2" }],
      }),
    }).state
    const transition = reduceMeshTui(withNew, { type: "confirm-takeover", scope: SCOPE })
    expect(transition.intents).toHaveLength(0)
    expect(transition.state.notice).toContain(WORKER_1)
    expect(transition.state.notice).toMatch(/Inspect the unreconciled node/)
    expect(transition.state.notice).not.toMatch(new RegExp(`Inspect[^.]*${WORKER_2}`))
  })

  it("permits the takeover once every node is inspected and accepted", () => {
    let state = ready({ leaseKind: "expired", unreconciled: [ENTRY_A, ENTRY_B] })
    state = reduceMeshTui(state, { type: "request-takeover" }).state
    for (const nodeId of [WORKER_2, WORKER_3]) {
      state = reduceMeshTui(state, { type: "select-node", nodeId }).state
      state = reduceMeshTui(state, { type: "inspect-unreconciled" }).state
      state = reduceMeshTui(state, { type: "acknowledge-unreconciled" }).state
    }
    state = reduceMeshTui(state, { type: "takeover-reason", reason: "controller A partitioned; operator moved control after inspecting the degraded nodes" }).state
    state = reduceMeshTui(state, { type: "set-confirmation-armed", armed: true }).state

    expect(takeoverBlockers(state, SCOPE)).toHaveLength(0)
    expect(buildMeshTuiView(state)!.takeover!.confirmable).toBe(true)

    const transition = reduceMeshTui(state, { type: "confirm-takeover", scope: SCOPE })
    expect(transition.intents).toEqual([
      {
        type: "request-takeover",
        scope: SCOPE,
        predecessorLeaseId: LEASE_1,
        predecessorEpoch: 1,
        acknowledgedUnreconciledNodeIds: [WORKER_2, WORKER_3],
        reason: "controller A partitioned; operator moved control after inspecting the degraded nodes",
      },
    ])
    // The intent is a VALUE. Nothing moved: the overlay closed and a `pending`
    // label appeared, but the epoch is not displayed and no lease is written.
    expect(transition.state.pending).toMatch(/Taking over/)
    expect(buildMeshTuiView(transition.state)!.lease?.epoch).toBe(1)
  })

  it("permits a takeover on a clean mesh, because the precondition is about NODES", () => {
    // A rule demanding a non-empty acknowledgement would push an operator to
    // accept a node that does not exist, and would make a healthy mesh
    // untakeable.
    const transition = reduceMeshTui(readyToConfirm({ leaseKind: "held" }), { type: "confirm-takeover", scope: SCOPE })
    expect(transition.intents).toHaveLength(1)
    expect(transition.intents[0]).toMatchObject({ type: "request-takeover", acknowledgedUnreconciledNodeIds: [] })
  })
})

describe("M4.8 a takeover is refused for the wrong run", () => {
  it("names the run the view is showing and the run the confirmation asked for", () => {
    const state = readyToConfirm({ leaseKind: "expired" })
    const transition = reduceMeshTui(state, { type: "confirm-takeover", scope: { projectId: PROJECT, runId: OTHER_RUN } })
    expect(transition.intents).toHaveLength(0)
    expect(transition.state.notice).toContain(RUN)
    expect(transition.state.notice).toContain(OTHER_RUN)
    expect(transition.state.notice).toMatch(/A takeover fences one specific lease/)
  })

  it("refuses a scope-mismatched confirmation even when nothing else is wrong", () => {
    // Everything else satisfied, so the ONLY thing that can be refusing is the
    // scope. That is what makes the guard testable: a refusal here cannot be
    // explained by an unexamined node.
    expect(takeoverBlockers(readyToConfirm({ leaseKind: "expired" }), SCOPE)).toHaveLength(0)
    const mismatched = takeoverBlockers(readyToConfirm({ leaseKind: "expired" }), { projectId: "project-other" as typeof PROJECT, runId: RUN })
    expect(mismatched[0]!.blocker).toBe("scope-mismatch")
  })

  it("does not retarget, which is the failure the refusal exists to prevent", () => {
    const state = readyToConfirm({ leaseKind: "expired" })
    const transition = reduceMeshTui(state, { type: "confirm-takeover", scope: { projectId: PROJECT, runId: OTHER_RUN } })
    // No intent at all, rather than an intent for the view's own run. Retargeting
    // would fence a lease the operator never read a confirmation for.
    expect(transition.intents).toEqual([])
    expect(transition.state.notice).toContain(OTHER_RUN)
    // The refusal DISARMS rather than consuming the state: the dialog stays open,
    // the predecessor is still named, and a second press for the right run works.
    // A refusal that left it armed would mean the next Enter — with no dialog
    // between it and the operator — confirmed something they had just been told
    // was wrong.
    expect(transition.state.overlay).toBe("takeover-confirmation")
    expect(transition.state.confirmationArmed).toBe(false)
    const rearmed = reduceMeshTui(transition.state, { type: "set-confirmation-armed", armed: true }).state
    expect(reduceMeshTui(rearmed, { type: "confirm-takeover", scope: SCOPE }).intents).toHaveLength(1)
  })
})

describe("M4.8 no path reaches a takeover without the explicit action", () => {
  it("the action vocabulary is the one the loop below drives", () => {
    // Stated against the code's own array so the loop cannot silently skip a
    // newly added action. A new action type that is not represented here fails
    // this rather than passing the "no path" assertion vacuously.
    expect([...new Set(ACTIONS.map((action) => action.type))].sort()).toEqual([...MESH_TUI_ACTION_TYPES].sort())
  })

  it("reaches a takeover ONLY through an armed, unblocked confirmation", () => {
    // Driven from four starting points per cell — a clean lease, a clean lease
    // with an unreconciled node outstanding, and the two of those already opened
    // and armed — from every action in the vocabulary, in every cell. The
    // ready-and-clean start is the dangerous one: it is the only state where no
    // blocker stands, so anything that reached a takeover from it did so with
    // nothing in the way.
    //
    // `activate: "confirm-takeover"` counts as the one path because it is the
    // CONTROL for the same guarded branch, not a second route: it re-reads the
    // view's own scope and runs the identical `takeoverBlockers` check, which the
    // two assertions below prove by driving it from a blocked state.
    const unreachable: string[] = []
    for (const cell of MESH_TUI_STATES) {
      const lease = standingOfCell(cell)
      const network = cell.slice(cell.lastIndexOf("-") + 1) as "up" | "partitioned" | "healing"
      for (const start of [
        ready({ leaseKind: lease, network }),
        ready({ leaseKind: lease, network, unreconciled: [ENTRY_A] }),
        readyToConfirm({ leaseKind: lease, network }),
        readyToConfirm({ leaseKind: lease, network, unreconciled: [ENTRY_A] }),
      ]) {
        for (const action of ACTIONS) {
          const produced = reduceMeshTui(start, action).intents.filter((intent) => intent.type === "request-takeover")
          if (produced.length === 0) continue
          const isTheGuardedPath =
            (action.type === "confirm-takeover" || (action.type === "activate" && action.control === "confirm-takeover")) &&
            takeoverBlockers(start, SCOPE).length === 0
          if (!isTheGuardedPath) unreachable.push(`${cell} from ${action.type}`)
        }
      }
    }
    expect(unreachable).toEqual([])
  })

  it("the confirm CONTROL is guarded identically to the confirm ACTION", () => {
    // The two look like a second route and must not be one. Each is driven from a
    // state with a blocker standing, and each must refuse.
    for (const entry of [ENTRY_A]) {
      const blocked = readyToConfirm({ leaseKind: "expired", unreconciled: [entry] })
      expect(takeoverBlockers(blocked, SCOPE).length).toBeGreaterThan(0)
      expect(reduceMeshTui(blocked, { type: "confirm-takeover", scope: SCOPE }).intents).toHaveLength(0)
      expect(reduceMeshTui(blocked, { type: "activate", control: "confirm-takeover" }).intents).toHaveLength(0)
    }
    // And from a clear state both produce exactly one intent, with the same shape.
    const clear = readyToConfirm({ leaseKind: "expired" })
    const viaAction = reduceMeshTui(clear, { type: "confirm-takeover", scope: SCOPE }).intents
    const viaControl = reduceMeshTui(clear, { type: "activate", control: "confirm-takeover" }).intents
    expect(viaAction).toHaveLength(1)
    expect(viaControl).toEqual(viaAction)
  })

  it("never produces a takeover from a SEQUENCE that skips the dialog, even with every list filled", () => {
    // The composite version of the same property. A caller that fills the reason,
    // the inspection list, the acknowledgement list and the arm flag WITHOUT ever
    // opening the confirmation must still be refused, because
    // `confirmation-required` is checked on the overlay and not on any list.
    let state = ready({ leaseKind: "expired", unreconciled: [ENTRY_A] })
    state = reduceMeshTui(state, { type: "select-node", nodeId: WORKER_2 }).state
    state = reduceMeshTui(state, { type: "inspect-unreconciled" }).state
    state = reduceMeshTui(state, { type: "acknowledge-unreconciled" }).state
    state = reduceMeshTui(state, { type: "takeover-reason", reason: "everything but the dialog" }).state
    // Armed by hand rather than through the dialog. `set-confirmation-armed`
    // refuses outside an overlay, so this stays false — which is the point.
    state = reduceMeshTui(state, { type: "set-confirmation-armed", armed: true }).state
    expect(state.confirmationArmed).toBe(false)
    expect(reduceMeshTui(state, { type: "confirm-takeover", scope: SCOPE }).intents).toHaveLength(0)
    expect(takeoverBlockers(state, SCOPE).map((blocker) => blocker.blocker)).toEqual(
      expect.arrayContaining(["confirmation-required", "not-armed"]),
    )
  })

  it("a fresh snapshot cannot smuggle a takeover through, even one that arrives after a confirmation", () => {
    // The window a caller could exploit: confirm, and then feed the view a
    // snapshot. The state after a confirmation has no overlay and no arm, so the
    // new snapshot's `snapshot-loaded` lands on a state that is not confirming.
    const confirmed = reduceMeshTui(readyToConfirm({ leaseKind: "expired" }), { type: "confirm-takeover", scope: SCOPE })
    expect(confirmed.intents).toHaveLength(1)
    const afterSnapshot = reduceMeshTui(confirmed.state, {
      type: "snapshot-loaded",
      snapshot: aSnapshot({ leaseKind: "expired", unreconciled: [ENTRY_A] }),
    })
    expect(afterSnapshot.intents).toHaveLength(0)
    expect(afterSnapshot.state.overlay).toBe("none")
    expect(afterSnapshot.state.confirmationArmed).toBe(false)
  })

  it("the only intents in the vocabulary that can move authority are the claim, the renewal and the takeover", () => {
    // Enumerated from the code's own types is not possible at run time, so this
    // asserts the SHAPE instead: every intent carries an explicit type, and the
    // three authority-bearing ones all name a scope, so none of them can be
    // addressed at a run the view is not showing.
    const produced = ACTIONS.flatMap((action) => reduceMeshTui(readyToConfirm({ leaseKind: "expired" }), action).intents)
    for (const intent of produced) {
      if (intent.type === "refresh") continue
      expect("scope" in intent, intent.type).toBe(true)
    }
  })
})

describe("M4.8 the view model exposes no way to take over implicitly", () => {
  it("puts the intent only behind `confirmable`, and names what is missing otherwise", () => {
    const blocked = buildMeshTuiView(ready({ leaseKind: "expired", unreconciled: [ENTRY_A] }))!.takeover!
    expect(blocked.confirmable).toBe(false)
    expect(blocked.offered).toBe(true)
    expect(blocked.blockers.length).toBeGreaterThan(0)

    const clear = buildMeshTuiView(readyToConfirm({ leaseKind: "expired" }))!.takeover!
    expect(clear.confirmable).toBe(true)
    expect(clear.blockers).toEqual([])
  })

  it("states the predecessor the takeover would fence, and no new epoch", () => {
    // No `newEpoch` member, deliberately: choosing one is the LEASE SEAM's job
    // (`evaluateLease` refuses a takeover that does not strictly increase), and a
    // view that displayed a proposed epoch would be showing a number it has no
    // standing to compute.
    const summary = buildMeshTuiView(readyToConfirm({ leaseKind: "expired" }))!.takeover!
    expect(summary.predecessorLeaseId).toBe(LEASE_1)
    expect(summary.predecessorEpoch).toBe(1)
    expect(Object.keys(summary).sort()).toEqual(
      [
        "acknowledgedUnreconciledNodeIds",
        "blockers",
        "confirmable",
        "offered",
        "predecessorEpoch",
        "predecessorLeaseId",
        "reason",
      ].sort(),
    )
    expect(buildMeshTuiView(readyToConfirm({ leaseKind: "expired" }))!.lines.join("\n")).toMatch(
      /new epoch must be strictly higher/,
    )
  })

  it("offers nothing at all when the mesh cannot be read", () => {
    const unavailable = reduceMeshTui(ready(), { type: "shell-unavailable", reason: "the mesh store is unreadable" })
    expect(unavailable.state.shell).toBe("unavailable")
    expect(availableMeshTuiActions(unavailable.state)).toEqual([])
    expect(buildMeshTuiView(unavailable.state)).toBeNull()
  })

  it("names the fenced lease and the nodes still owed, in the rendered confirmation", () => {
    const state = readyToConfirm({ leaseKind: "expired", unreconciled: [ENTRY_A] })
    const text = buildMeshTuiView(state)!.lines.join("\n")
    expect(text).toMatch(/CONFIRM CONTROLLER TAKEOVER/)
    expect(text).toContain(LEASE_1)
    expect(text).toMatch(/Reason: controller A partitioned; operator moved control/)
    expect(text).toMatch(/BLOCKED/)
    expect(text).toContain(WORKER_2)
  })
})

describe("M4.8 the blocker vocabulary is closed and every blocker is reachable", () => {
  it("the confirmation's own summary lists exactly the blockers the reducer can report", () => {
    // Read off the built summary rather than a list written here, so a blocker
    // added to the reducer without a declared name — or declared and never
    // produced — fails this.
    const observed = new Set<string>()
    for (const cell of MESH_TUI_STATES) {
      const lease = standingOfCell(cell)
      for (const action of ACTIONS) {
        for (const state of [ready({ leaseKind: lease }), readyToConfirm({ leaseKind: lease, unreconciled: [ENTRY_A] })]) {
          // `shell-unavailable` makes the whole view `null`, which is the point of
          // that action; there is no confirmation to inspect in that state.
          const summary = buildMeshTuiView(reduceMeshTui(state, action).state)?.takeover
          for (const blocker of summary?.blockers ?? []) observed.add(blocker.blocker)
          // The summary is always asked about the view's OWN scope, so
          // `scope-mismatch` is only ever reported when a caller asks about a
          // different one. Probing both scopes is what makes the vocabulary's
          // closure checkable rather than merely declared.
          for (const blocker of takeoverBlockers(state, OTHER_SCOPE)) observed.add(blocker.blocker)
        }
      }
    }
    expect([...observed].sort()).toEqual([...MESH_TUI_TAKEOVER_BLOCKERS].sort())
  })

  it("every blocker names a message, so no refusal is ever silent", () => {
    for (const cell of MESH_TUI_STATES) {
      const lease = standingOfCell(cell)
      for (const state of [ready({ leaseKind: lease, unreconciled: [ENTRY_A] }), readyToConfirm({ leaseKind: lease })]) {
        for (const blocker of takeoverBlockers(state, SCOPE)) {
          expect(blocker.message.length, `${cell} ${blocker.blocker}`).toBeGreaterThan(20)
        }
      }
    }
  })
})

describe("M4.8 the directory performs no mesh operation and elects nobody", () => {
  it("imports nothing that could perform one", () => {
    // The structural claim, checked against the IMPORTS rather than against a
    // list of forbidden method names: a TUI that cannot reach a lease seam cannot
    // be edited into one by adding a call, because there is nothing to call.
    const seams = [
      "../lease/lease.js",
      "../lease/index.js",
      "../registry/index.js",
      "../gateway/events/index.js",
      "../gateway/terminal/index.js",
      "../inbox/index.js",
      "../outbox/index.js",
      "node:fs",
      "node:net",
      "node:http",
      "node:crypto",
      "fastify",
    ]
    for (const file of readdirSync(TUI_DIRECTORY).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(TUI_DIRECTORY, file), "utf8")
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!)
      for (const seam of seams) {
        expect(imports, `${file} imports ${seam}`).not.toContain(seam)
      }
    }
  })

  it("mentions no election, quorum, gossip or consensus in code", () => {
    // The lease directory's own negative, applied here. Comments are stripped
    // because this codebase's comments DISCUSS the guardrail, and a naive scan
    // would flag the discussion as the thing it forbids.
    const forbidden = /auto-?elect|quorum|gossip|consensus|leader-?election|raft|paxos/i
    for (const file of readdirSync(TUI_DIRECTORY).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(TUI_DIRECTORY, file), "utf8")
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      expect(code, file).not.toMatch(forbidden)
    }
  })

  it("reads no clock, so the same snapshot always produces the same view", () => {
    // A presentation layer with its own clock is a layer whose output depends on
    // when it was asked. Every age it shows arrives from M4.3's `ageMs`, and
    // every lease verdict arrives from M4.4 — the TUI compares neither against
    // the wall.
    for (const file of readdirSync(TUI_DIRECTORY).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(TUI_DIRECTORY, file), "utf8")
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      expect(code, file).not.toMatch(/Date\.now|new Date\(|performance\.now/)
    }
    // And the observable consequence: two builds of the view from one snapshot
    // are identical, whatever the wall clock says.
    const snapshot: MeshTuiSnapshot = aSnapshot({ leaseKind: "expired", nodes: [aHealthyNode({ nodeId: LOCAL })] })
    const first = buildMeshTuiView(reduceMeshTui(initialMeshTuiState(), { type: "snapshot-loaded", snapshot }).state)
    const second = buildMeshTuiView(reduceMeshTui(initialMeshTuiState(), { type: "snapshot-loaded", snapshot }).state)
    expect(second).toEqual(first)
  })
})

/** Keeps the two lease ids distinct in this file's imports, which the intents assert. */
it("the fixture chain has two links, so a takeover names a real predecessor", () => {
  expect(LEASE_1).not.toBe(LEASE_2)
  const intent: MeshTuiIntent = {
    type: "request-takeover",
    scope: SCOPE,
    predecessorLeaseId: LEASE_1,
    predecessorEpoch: 1,
    acknowledgedUnreconciledNodeIds: [],
    reason: "operator moved control",
  }
  expect(intent.predecessorLeaseId).toBe(LEASE_1)
})

/** The cell a mesh state names, re-exported so a reader of this file can see the twelve. */
export const CELLS: readonly MeshTuiState[] = MESH_TUI_STATES.map((cell) => cell)
export { meshStateOf }

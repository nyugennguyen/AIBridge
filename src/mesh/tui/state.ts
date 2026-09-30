/**
 * M4.8 — the mesh TUI's reducer, and the ONLY place a mesh cell is decided.
 *
 * ### The shape it follows
 *
 * `src/tui/state.ts` is the model: one pure `reduce`, an exhaustive `switch` over
 * a `TuiAction` union, and no effect of any kind. This is the same shape with one
 * addition, and the addition is the deliverable rather than a convenience — the
 * reducer returns `{ state, intents }` instead of `state` alone, because a takeover
 * that this layer could merely *perform* would be a takeover a future caller could
 * reach by forgetting to gate something. Returning the operation as a VALUE means
 * the gate is the thing being tested, and `tests/unit/mesh/tui/takeover-confirmation.test.ts`
 * drives every action type in every mesh cell to prove there is exactly one path
 * to it.
 *
 * ### The two tables, and why they are `Record`s
 *
 * {@link MESH_TUI_STATE_BY_LEASE_AND_NETWORK} and
 * {@link MESH_TUI_ACTIONS_BY_STATE} are total functions written as `Record`s. A
 * `Record<MeshTuiState, ...>` cannot be written without every member present, so
 * a fifth lease standing or a fourth network state is a compile error in BOTH
 * tables simultaneously — which is the property the plan's verification line
 * ("reducer scenarios for every lease/network state") actually needs. A union with
 * a derived label would compile happily and quietly leave two cells unreachable.
 *
 * ### What the available actions are FOR
 *
 * They are what an operator can do, and every one of them is a decision this layer
 * is entitled to make because it is a decision about PRESENTATION:
 *
 *   - `claim-lease` is offered only where `evaluateLease` would accept a claim.
 *     A claim against a live lease held by another controller is refused with
 *     `held_by_another_controller`, and offering a control whose only outcome is
 *     a refusal teaches an operator that the mesh is broken.
 *   - `renew-lease` is offered only for a lease this node HOLDS. M4.4 refuses a
 *     renewal of somebody else's lease with `no_lease_to_renew`, and it refuses a
 *     renewal that arrives after expiry with `renewal_after_expiry`; offering it in
 *     either case would be offering the two refusals as if they were actions.
 *   - `request-takeover` is offered whenever there is a lease to fence, and NOT
 *     for an `absent` lease — `no_lease_to_fence` means a takeover there cannot
 *     succeed, and the operation that means "I am starting" is a claim.
 *   - `reconcile` is offered whenever the mesh is not simply up with nothing
 *     outstanding. It is the only action that can CHANGE the unreconciled set,
 *     and it changes it in exactly one direction: a pass that finds no difference
 *     removes an entry, and a pass that finds one ADDS to it. Nothing here adopts
 *     or terminates a session, and no control in this vocabulary can.
 *
 * None of these is an authority decision. Every one of them is re-decided by the
 * seam that owns it; this list only avoids offering an operation that the owner
 * will refuse.
 */

import {
  MESH_TUI_ACTION_TYPES,
  MESH_TUI_DEGRADED_CONDITIONS,
  MESH_TUI_LEASE_STANDINGS,
  MESH_TUI_NETWORK_STATES,
  MESH_TUI_STATES,
  MESH_TUI_TAKEOVER_BLOCKERS,
  type MeshTakeoverBlockerView,
  type MeshTuiAction,
  type MeshTuiActionControl,
  type MeshTuiActionType,
  type MeshTuiDegradedCondition,
  type MeshTuiIntent,
  type MeshTuiLeaseSnapshot,
  type MeshTuiLeaseStanding,
  type MeshTuiNetworkState,
  type MeshTuiOverlay,
  type MeshTuiScreen,
  type MeshTuiSnapshot,
  type MeshTuiState,
  type MeshTuiTransition,
  type MeshTuiUiState,
} from "./types.js"
import { projectIdSchema, runIdSchema, type NodeId } from "../../orchestration/identifiers.js"
import type { LeaseScope } from "../lease/schemas.js"
import type { UnreconciledEntry } from "../protocol/reconciliation.js"

/**
 * The cross product, filled in all twelve cells.
 *
 * Written out rather than computed from a template string because a computed
 * `\`${lease}-${network}\`` would make `MESH_TUI_STATES` and this table
 * independently maintained, and the failure mode of that is a state in the union
 * that no cell can ever produce. Here the compiler holds both to the same twelve.
 */
export const MESH_TUI_STATE_BY_LEASE_AND_NETWORK: Readonly<
  Record<MeshTuiLeaseStanding, Readonly<Record<MeshTuiNetworkState, MeshTuiState>>>
> = Object.freeze({
  held: Object.freeze({ up: "held-up", partitioned: "held-partitioned", healing: "held-healing" }),
  expired: Object.freeze({ up: "expired-up", partitioned: "expired-partitioned", healing: "expired-healing" }),
  absent: Object.freeze({ up: "absent-up", partitioned: "absent-partitioned", healing: "absent-healing" }),
  superseded: Object.freeze({
    up: "superseded-up",
    partitioned: "superseded-partitioned",
    healing: "superseded-healing",
  }),
})

/**
 * The two axes a cell decomposes back into.
 *
 * Built from the cell table rather than by slicing the name, and the reason is
 * that a slice needs a CAST: `mesh.slice(0, i) as MeshTuiLeaseStanding` asserts
 * that the prefix is one of four values without checking, and a fifth cell whose
 * prefix were not a standing would then be reported as a standing it is not. The
 * lookup cannot do that — a cell missing from the map yields `undefined`, which
 * fails the equality rather than answering wrongly.
 */
const STANDING_BY_CELL: Readonly<Record<MeshTuiState, MeshTuiLeaseStanding>> = Object.freeze(
  Object.fromEntries(
    MESH_TUI_STATES.map((cell) => [cell, leaseStandingOfName(cell)]),
  ) as Record<MeshTuiState, MeshTuiLeaseStanding>,
)

const NETWORK_BY_CELL: Readonly<Record<MeshTuiState, MeshTuiNetworkState>> = Object.freeze(
  Object.fromEntries(
    MESH_TUI_STATES.map((cell) => [cell, networkStateOfName(cell)]),
  ) as Record<MeshTuiState, MeshTuiNetworkState>,
)

/** The single place a cell NAME is split, and it throws rather than guessing. */
function leaseStandingOfName(cell: string): MeshTuiLeaseStanding {
  for (const standing of MESH_TUI_LEASE_STANDINGS) {
    if (cell.startsWith(`${standing}-`)) return standing
  }
  throw new Error(`'${cell}' does not name a mesh cell this build knows: expected one of [${MESH_TUI_STATES.join(", ")}]`)
}

function networkStateOfName(cell: string): MeshTuiNetworkState {
  for (const network of MESH_TUI_NETWORK_STATES) {
    if (cell.endsWith(`-${network}`)) return network
  }
  throw new Error(`'${cell}' does not name a mesh cell this build knows: expected one of [${MESH_TUI_STATES.join(", ")}]`)
}

/** The lease standing a mesh cell names. Read off the cell, never the reverse. */
export function leaseStandingOf(mesh: MeshTuiState): MeshTuiLeaseStanding {
  return STANDING_BY_CELL[mesh]
}

/** The network reachability a mesh cell names. */
export function networkStateOf(mesh: MeshTuiState): MeshTuiNetworkState {
  return NETWORK_BY_CELL[mesh]
}

/** The one cell for a pair of axes. Pure lookup, because the table is total. */
export function meshStateOf(lease: MeshTuiLeaseStanding, network: MeshTuiNetworkState): MeshTuiState {
  return MESH_TUI_STATE_BY_LEASE_AND_NETWORK[lease][network]
}

/**
 * Every control, in every cell.
 *
 * The common tail is the navigation set, and it is identical in all twelve cells
 * on purpose: an operator whose lease expired can still look at the mesh, and a
 * control that vanished because the run is in trouble is a control that hides the
 * evidence of the trouble.
 */
const ALWAYS: readonly MeshTuiActionControl[] = Object.freeze([
  "refresh",
  "view-nodes",
  "view-sessions",
  "view-degraded",
  "back",
])

/**
 * One row of {@link MESH_TUI_ACTIONS_BY_STATE}: the common tail plus this cell's
 * own controls.
 *
 * A function rather than a `[...ALWAYS, ...]` spread repeated twelve times,
 * because a spread inside an object literal widens to `string[]` and the table's
 * declared type would then be rejected for every row. Naming the widening point
 * once means a typo in a control name is still a compile error AND the table
 * still reads as "the common set plus what is different here", which is the thing
 * a reader wants from it.
 */
function row(...own: MeshTuiActionControl[]): readonly MeshTuiActionControl[] {
  return Object.freeze([...ALWAYS, ...own])
}

/**
 * What may be done, per cell.
 *
 * Read each row as a sentence about the OPERATOR, not about the machine: "the
 * controller you were using is gone and you may re-claim or fence it" is a
 * different sentence from "another node holds this run and you may only observe".
 */
export const MESH_TUI_ACTIONS_BY_STATE: Readonly<Record<MeshTuiState, readonly MeshTuiActionControl[]>> =
  Object.freeze({
    // New work may be created here. Reconciliation is still offered, because a
    // clean reconciliation on a live lease is how an operator CONFIRMS the mesh
    // is clean rather than merely quiet.
    "held-up": row("reconcile", "renew-lease", "request-takeover"),
    // A held lease over a partition is the dangerous-looking-but-unchanged case:
    // this node may still create work, and the partition means it cannot learn
    // that it should not. Reconciliation is the only way to find out, so it leads.
    "held-partitioned": row("reconcile", "renew-lease"),
    // Healing is the same, plus the takeover, because a node that is reconnecting
    // is the node whose controller most often needs replacing. The takeover is
    // still behind a confirmation.
    "held-healing": row("reconcile", "renew-lease", "request-takeover"),
    // Expired: no new work, nothing stopped. A claim re-establishes authority
    // without an epoch bump, which is the whole point of leaving the epoch alone.
    "expired-up": row("reconcile", "claim-lease", "request-takeover"),
    "expired-partitioned": row("reconcile", "claim-lease", "request-takeover"),
    "expired-healing": row("reconcile", "claim-lease", "request-takeover"),
    // Absent: nothing to fence, so `request-takeover` is ABSENT from these rows
    // and a claim is the only epoch-raising path that is not a takeover. A
    // takeover here is refused with `no_lease_to_fence` and offering it would be
    // offering a control whose only outcome is that refusal.
    "absent-up": row("reconcile", "claim-lease"),
    "absent-partitioned": row("reconcile", "claim-lease"),
    "absent-healing": row("reconcile", "claim-lease"),
    // Superseded: this node has been fenced. No claim (`held_by_another_controller`
    // or `no_lease_to_fence`), no renewal (`no_lease_to_renew`). A takeover IS
    // offered, because a node that has been fenced is precisely the node whose
    // operator may legitimately want to take control back — through the same
    // confirmation, the same inspection precondition, and a strictly higher epoch.
    "superseded-up": row("reconcile", "request-takeover"),
    "superseded-partitioned": row("reconcile", "request-takeover"),
    "superseded-healing": row("reconcile", "request-takeover"),
  })

/**
 * What a control means, as a noun an operator acts on rather than a verb.
 *
 * Used by the degraded view, where the plan's requirement is that each condition
 * "names its operator action" — a label, not a key, because the label is what
 * ends up in front of a person.
 */
export const MESH_TUI_ACTION_LABELS: Readonly<Record<MeshTuiActionControl, string>> = Object.freeze({
  refresh: "Refresh from the mesh",
  reconcile: "Reconcile with peers",
  "claim-lease": "Claim this run",
  "renew-lease": "Renew this lease",
  "request-takeover": "Take over the controller lease",
  "inspect-unreconciled": "Inspect unreconciled nodes",
  "acknowledge-unreconciled": "Accept degraded nodes as they are",
  "view-nodes": "Node health",
  "view-sessions": "Remote sessions",
  "view-degraded": "Degraded conditions",
  back: "Back",
  "confirm-takeover": "Confirm the takeover",
  "cancel-takeover": "Back to the mesh",
})

export function initialMeshTuiState(): MeshTuiUiState {
  return {
    shell: "booting",
    snapshot: null,
    mesh: null,
    screen: "nodes",
    overlay: "none",
    selectedNodeId: null,
    selectedSessionId: null,
    inspectedUnreconciledNodeIds: [],
    acknowledgedUnreconciledNodeIds: [],
    takeoverReason: "",
    confirmationArmed: false,
    notice: null,
    pending: null,
  }
}

export function availableMeshTuiActions(state: MeshTuiUiState): readonly MeshTuiActionControl[] {
  if (state.shell === "unavailable") return []
  if (state.overlay === "takeover-confirmation") {
    // The confirmation offers exactly two things, and the destructive one is
    // reachable by name even while a blocker stands: the view's job is to let the
    // operator press it and be told why it is refused, not to hide the button and
    // leave them wondering whether the feature is wired up.
    return ["cancel-takeover", "confirm-takeover"]
  }
  if (state.mesh === null) return ["refresh"]
  const controls = new Set<MeshTuiActionControl>(MESH_TUI_ACTIONS_BY_STATE[state.mesh])
  if (state.snapshot !== null && state.snapshot.unreconciled.length > 0) {
    controls.add("reconcile")
    if (state.snapshot.unreconciled.some((entry) => !state.inspectedUnreconciledNodeIds.includes(entry.nodeId))) {
      controls.add("inspect-unreconciled")
    }
    if (state.snapshot.unreconciled.some((entry) => !state.acknowledgedUnreconciledNodeIds.includes(entry.nodeId))) {
      controls.add("acknowledge-unreconciled")
    }
  }
  return Object.freeze([...controls].sort(byControlOrder))
}

/**
 * A total order over the controls.
 *
 * Present because the action set is a `Set` and a `Set` iterates in insertion
 * order, which would make the rendered footer depend on which cell added a
 * control first — a view whose control order changes between releases is a view
 * whose muscle memory does not survive the upgrade.
 */
const CONTROL_ORDER: readonly MeshTuiActionControl[] = [
  "refresh",
  "reconcile",
  "claim-lease",
  "renew-lease",
  "request-takeover",
  "inspect-unreconciled",
  "acknowledge-unreconciled",
  "view-nodes",
  "view-sessions",
  "view-degraded",
  "back",
]

function byControlOrder(a: MeshTuiActionControl, b: MeshTuiActionControl): number {
  return CONTROL_ORDER.indexOf(a) - CONTROL_ORDER.indexOf(b)
}

/**
 * Every precondition a takeover confirmation has not met, in the order the reducer
 * asks about them.
 *
 * A LIST and not a boolean, for the reason the fields are split: the plan asks for
 * inspection AND explicit acceptance, and a boolean that went true when either was
 * satisfied would make the guard M4.4 enforces a formality. The order is the
 * reading order — a wrong run, then not being in the dialog, then not having armed
 * it, then nothing to fence, then the nodes, then the reason — because the first
 * entry is the sentence the operator reads, and that sentence should name the
 * first thing standing between them and a fence rather than the last.
 */
export function takeoverBlockers(state: MeshTuiUiState, scope: LeaseScope): readonly MeshTakeoverBlockerView[] {
  const snapshot = state.snapshot
  if (snapshot === null) return [{ blocker: "no-predecessor", message: "No mesh snapshot has been read yet.", nodeIds: [] }]
  const blockers: MeshTakeoverBlockerView[] = []
  if (snapshot.scope.projectId !== scope.projectId || snapshot.scope.runId !== scope.runId) {
    blockers.push({
      blocker: "scope-mismatch",
      message: `This view is showing run ${snapshot.scope.runId}, and the confirmation names run ${scope.runId}. A takeover fences one specific lease, and the dialog you read was not the dialog for that one.`,
      nodeIds: [],
    })
  }
  if (state.overlay !== "takeover-confirmation") {
    blockers.push({ blocker: "confirmation-required", message: "Open the takeover confirmation first.", nodeIds: [] })
  }
  if (!state.confirmationArmed) {
    blockers.push({
      blocker: "not-armed",
      message: "Move focus onto 'Confirm the takeover'. The dialog opens on Back so a stray Enter cannot fence a run.",
      nodeIds: [],
    })
  }
  if (snapshot.lease.kind === "absent") {
    blockers.push({
      blocker: "no-predecessor",
      message:
        "This run has no lease, so there is nothing to take over. 'Claim this run' is the operation that means 'I am starting'.",
      nodeIds: [],
    })
  }
  const uninspected = unreconciledNodeIds(snapshot.unreconciled).filter((id) => !state.inspectedUnreconciledNodeIds.includes(id))
  if (uninspected.length > 0) {
    blockers.push({
      blocker: "unreconciled-not-inspected",
      message: `Inspect the unreconciled node(s) [${uninspected.join(", ")}] before taking over. Reconciling marks differences for a human; the human has to be one.`,
      nodeIds: uninspected,
    })
  }
  const unacknowledged = unreconciledNodeIds(snapshot.unreconciled).filter(
    (id) => !state.acknowledgedUnreconciledNodeIds.includes(id),
  )
  if (unacknowledged.length > 0) {
    blockers.push({
      blocker: "unreconciled-not-acknowledged",
      message: `Accept the unreconciled node(s) [${unacknowledged.join(", ")}] as degraded, or wait for them. A takeover that does not name them is refused by the lease seam.`,
      nodeIds: unacknowledged,
    })
  }
  if (state.takeoverReason.trim().length === 0) {
    blockers.push({
      blocker: "reason-required",
      message: "Give a reason. It is recorded on the takeover and is the only thing an audit has six months later.",
      nodeIds: [],
    })
  }
  return blockers
}

/**
 * The distinct node ids in the unreconciled set.
 *
 * Deduplicated because the set is what the LEASE SEAM checks the acknowledgement
 * against, and M4.4 stores `unreconciledNodeIds` as the deduplicated node ids of
 * the differences. Presenting duplicates here would make the operator's list
 * longer than the list they are being compared to, and a partial acknowledgement
 * would then look further along than it is.
 */
function unreconciledNodeIds(entries: readonly UnreconciledEntry[]): readonly NodeId[] {
  return [...new Set(entries.map((entry) => entry.nodeId))]
}

const NO_INTENTS: readonly MeshTuiIntent[] = Object.freeze([])

/** The one intent, frozen. A single-element list is the shape every caller reads. */
function intent(one: MeshTuiIntent): readonly MeshTuiIntent[] {
  return Object.freeze([one])
}

/**
 * A transition that says "working on it".
 *
 * `pending` is set and nothing is displayed as done. Every mesh operation is a
 * round trip to a durable store, and a view that showed the result before the
 * write would be displaying a fence, a claim or a renewal that may be lost — the
 * next `snapshot-loaded` decides, and until then the operator is told work is in
 * flight.
 */
function pending(state: MeshTuiUiState, label: string, intents: readonly MeshTuiIntent[]): MeshTuiTransition {
  return { state: { ...state, pending: label, notice: null }, intents }
}

/** A refusal, for a control whose action cannot be addressed because nothing was read. */
function unavailable(state: MeshTuiUiState, reason: string): MeshTuiTransition {
  return { state: { ...state, notice: reason }, intents: NO_INTENTS }
}

/**
 * The whole state machine.
 *
 * Exhaustive over `MeshTuiAction` with no `default`, so an action added to the
 * union without a branch here is a compile error rather than a silently ignored
 * keystroke.
 */
export function reduceMeshTui(state: MeshTuiUiState, action: MeshTuiAction): MeshTuiTransition {
  switch (action.type) {
    case "snapshot-loaded": {
      const mesh = meshStateOf(standingOfSnapshot(action.snapshot.lease.kind), action.snapshot.network)
      return {
        state: {
          ...state,
          shell: "ready",
          snapshot: action.snapshot,
          mesh,
          notice: null,
          // Selection is by node id, and a node that has left the mesh must not
          // stay selected: a detail pane describing a node the view no longer
          // lists is a pane whose contents cannot be acted on.
          selectedNodeId:
            state.selectedNodeId !== null && action.snapshot.nodes.some((node) => node.node.nodeId === state.selectedNodeId)
              ? state.selectedNodeId
              : (action.snapshot.nodes[0]?.node.nodeId ?? null),
          selectedSessionId:
            state.selectedSessionId !== null &&
            action.snapshot.sessions.some((entry) => entry.session.sessionId === state.selectedSessionId)
              ? state.selectedSessionId
              : (action.snapshot.sessions[0]?.session.sessionId ?? null),
        },
        intents: NO_INTENTS,
      }
    }
    case "shell-unavailable":
      // The mesh is unobservable. Every control goes with it, because a control
      // whose effect cannot be delivered is worse than no control: the operator
      // presses it and learns the answer from a refusal.
      return {
        state: { ...state, shell: "unavailable", overlay: "none", confirmationArmed: false, notice: action.reason },
        intents: NO_INTENTS,
      }
    case "select-node":
      return { state: { ...state, selectedNodeId: action.nodeId, selectedSessionId: state.selectedSessionId }, intents: NO_INTENTS }
    case "select-session":
      return { state: { ...state, selectedSessionId: action.sessionId, selectedNodeId: state.selectedNodeId }, intents: NO_INTENTS }
    case "navigate":
      // Navigating closes any dialog. A dialog that survived a screen change would
      // be a confirmation about a run the operator is no longer looking at, and
      // `Enter` on it would fence that run.
      return { state: { ...state, screen: action.screen, overlay: "none", confirmationArmed: false }, intents: NO_INTENTS }
    case "activate":
      return activate(state, action.control)
    case "set-overlay":
      // The takeover confirmation may not be OPENED directly. `set-overlay` is
      // generic, so allowing it here would be a bypass of the availability check
      // `request-takeover` performs — a partitioned node could force the dialog up
      // and then arm it, and a fence that is offerable over a partition is the one
      // most likely to produce two controllers. The dialog is reached through
      // `request-takeover`, which asks the cell's action set first.
      if (action.overlay === "takeover-confirmation") {
        return state.mesh === null || !MESH_TUI_ACTIONS_BY_STATE[state.mesh].includes("request-takeover")
          ? { state: { ...state, notice: "Taking over is not available from this state. Reconcile first." }, intents: NO_INTENTS }
          : { state: { ...state, overlay: "takeover-confirmation", confirmationArmed: false }, intents: NO_INTENTS }
      }
      return { state: { ...state, overlay: action.overlay, confirmationArmed: false }, intents: NO_INTENTS }
    case "dismiss-overlay":
      return { state: { ...state, overlay: "none", confirmationArmed: false, notice: null }, intents: NO_INTENTS }
    case "set-confirmation-armed":
      // Arming is refused outside a dialog, so a stray Tab cannot arm something
      // that is not on screen and leave it armed for the next overlay.
      return {
        state: state.overlay === "none" ? state : { ...state, confirmationArmed: action.armed },
        intents: NO_INTENTS,
      }
    case "takeover-reason":
      return { state: { ...state, takeoverReason: action.reason }, intents: NO_INTENTS }
    case "inspect-unreconciled":
      return {
        state: { ...state, inspectedUnreconciledNodeIds: withSelectedNode(state.inspectedUnreconciledNodeIds, state.snapshot, state.selectedNodeId) },
        intents: NO_INTENTS,
      }
    case "acknowledge-unreconciled":
      return {
        state: {
          ...state,
          acknowledgedUnreconciledNodeIds: withSelectedNode(state.acknowledgedUnreconciledNodeIds, state.snapshot, state.selectedNodeId),
        },
        intents: NO_INTENTS,
      }
    case "request-takeover":
      return openTakeoverConfirmation(state)
    case "confirm-takeover":
      return confirmTakeover(state, action.scope)
    case "set-notice":
      return { state: { ...state, notice: action.notice }, intents: NO_INTENTS }
    case "set-pending":
      return { state: { ...state, pending: action.pending }, intents: NO_INTENTS }
  }
}

/**
 * The lease standing a snapshot kind names.
 *
 * An identity function, and it is here rather than a cast at the call site for
 * the reason `MeshCommandEpochGate.withRecordedArm` is a function: a cast at the
 * call site would let a fourth kind be added to `MeshTuiLeaseSnapshot` without
 * this directory having to say what it means, and the mesh cell it selects would
 * then be whatever the cast claimed. Narrowing the union here means a new kind is
 * a compile error until someone decides which cell it belongs to.
 */
function standingOfSnapshot(kind: MeshTuiLeaseSnapshot["kind"]): MeshTuiLeaseStanding {
  switch (kind) {
    case "held":
      return "held"
    case "expired":
      return "expired"
    case "absent":
      return "absent"
    case "superseded":
      return "superseded"
  }
}

/**
 * Adds the selected node to one of the two acknowledgement lists.
 *
 * Per node rather than bulk, and the two lists are separate arguments rather than
 * one `acknowledged: boolean` per node, for the reason the plan asks for
 * inspection AND explicit acceptance: a single "acknowledge all" would let one
 * click satisfy the precondition for a list the operator has not read, and a
 * single flag would let inspecting BE the acceptance. Both are the same defect —
 * the guard M4.4 enforces reduced to a formality.
 *
 * A selected node that is not in the unreconciled set is a no-op rather than an
 * error: the selection is on a node, and the fact that this node has no
 * outstanding difference is not something the operator did wrong.
 */
function withSelectedNode(list: readonly NodeId[], snapshot: MeshTuiSnapshot | null, nodeId: NodeId | null): readonly NodeId[] {
  if (snapshot === null || nodeId === null) return list
  if (!unreconciledNodeIds(snapshot.unreconciled).includes(nodeId)) return list
  if (list.includes(nodeId)) return list
  return Object.freeze([...list, nodeId])
}

/**
 * Opens the confirmation, or explains why not.
 *
 * The availability question is asked of `MESH_TUI_ACTIONS_BY_STATE` — the CELL's
 * table — rather than of `availableMeshTuiActions`, and the reason is that the
 * latter is a function of the CURRENT control set, which while a dialog is open is
 * the dialog's two controls. Asking the cell's table is what makes this and the
 * `set-overlay` guard the SAME question, and two answers to one question is how a
 * bypass gets in.
 */
function openTakeoverConfirmation(state: MeshTuiUiState): MeshTuiTransition {
  const offered = state.mesh !== null && MESH_TUI_ACTIONS_BY_STATE[state.mesh].includes("request-takeover")
  if (!offered) {
    return {
      state: {
        ...state,
        notice:
          state.snapshot?.lease.kind === "absent"
            ? "This run has no lease to take over. Claim it instead — a takeover needs something to fence."
            : "Taking over is not available from this state. Reconcile first.",
      },
      intents: NO_INTENTS,
    }
  }
  return {
    state: { ...state, overlay: "takeover-confirmation", confirmationArmed: false, takeoverReason: state.takeoverReason, notice: null },
    intents: NO_INTENTS,
  }
}

/**
 * The ONE branch in this directory that can raise an epoch.
 *
 * Three refusals, each for a different reason, and none of them is a formality:
 *
 *   1. **A blocker stands.** The list comes from {@link takeoverBlockers}, which is
 *      the same function the view model renders, so what the operator is told and
 *      what the reducer decided are the same sentence by construction. A second
 *      decision here would be a second place for the two to disagree, and the
 *      disagreement would always be in the direction of permitting.
 *   2. **The scope does not match.** A confirmation pressed for a run this view is
 *      not showing is refused rather than retargeted. Retargeting would produce a
 *      takeover against a lease the operator never read a confirmation for, which
 *      is the failure the whole confirmation exists to prevent.
 *   3. **There is nothing to fence.** Belt and braces against `no_lease_to_fence`:
 *      the intent carries a `predecessorLeaseId`, and an intent without one could
 *      not be built honestly anyway.
 *
 * On success the state is NOT advanced optimistically. A takeover is a round trip
 * to a durable store under a compare-and-set, and a reducer that showed the new
 * epoch before the write would be displaying a fence that may be lost. `pending` is
 * set and the next `snapshot-loaded` decides.
 */
function confirmTakeover(state: MeshTuiUiState, scope: LeaseScope): MeshTuiTransition {
  const blockers = takeoverBlockers(state, scope)
  if (blockers.length > 0) {
    return { state: { ...state, confirmationArmed: false, notice: blockers[0]?.message ?? "The takeover is not confirmed." }, intents: NO_INTENTS }
  }
  const snapshot = state.snapshot
  if (snapshot === null || snapshot.lease.kind === "absent") {
    return { state: { ...state, notice: "There is no lease to fence." }, intents: NO_INTENTS }
  }
  const intent: MeshTuiIntent = {
    type: "request-takeover",
    scope: snapshot.scope,
    predecessorLeaseId: snapshot.lease.record.leaseId,
    predecessorEpoch: snapshot.lease.record.epoch,
    // The nodes the operator ACCEPTED, not the nodes that exist. A snapshot whose
    // unreconciled set changed between inspection and confirmation would otherwise
    // be acknowledged by an inspection that no longer covers it, and the lease
    // seam checks the list against its own set — so an extra id here is refused
    // rather than a fence nobody authorised.
    acknowledgedUnreconciledNodeIds: [...state.acknowledgedUnreconciledNodeIds],
    reason: state.takeoverReason.trim(),
  }
  return {
    state: { ...state, overlay: "none", confirmationArmed: false, pending: "Taking over the controller lease…", notice: null },
    intents: Object.freeze([intent]),
  }
}

/**
 * A scope that names nothing, for the "no snapshot yet" case.
 *
 * Ids are PARSED rather than cast wherever they can be branded, and this is the
 * one place where a sentinel has to exist: `confirm-takeover` pressed before any
 * snapshot has been read needs some scope to compare against, and the comparison
 * is against a real one, so this can never match. Inventing it by cast would put
 * a value in the codebase that looks like a real scope and is not.
 */
function absentScope(): LeaseScope {
  return { projectId: projectIdSchema.parse("tui-unloaded-project"), runId: runIdSchema.parse("tui-unloaded-run") }
}

function activate(state: MeshTuiUiState, control: MeshTuiActionControl): MeshTuiTransition {
  const offered = availableMeshTuiActions(state)
  if (!offered.includes(control)) {
    return { state: { ...state, notice: `That action is not available: ${MESH_TUI_ACTION_LABELS[control]}.` }, intents: NO_INTENTS }
  }
  // Every remaining branch addresses a run, so the scope comes from the snapshot
  // rather than from the control. Read ONCE here rather than non-null-asserted at
  // each site: an intent whose `scope` were invented would be an intent aimed at a
  // run nobody is looking at, and `scope-mismatch` cannot catch a scope this
  // directory made up.
  const scope = state.snapshot?.scope
  switch (control) {
    case "refresh":
      return pending(state, "Refreshing the mesh…", intent({ type: "refresh" }))
    case "reconcile":
      return scope === undefined
        ? unavailable(state, "There is no run to reconcile.")
        : pending(state, "Reconciling with peers…", intent({ type: "reconcile", scope }))
    case "claim-lease":
      return scope === undefined
        ? unavailable(state, "There is no run to claim.")
        : pending(state, "Claiming this run…", intent({ type: "claim-lease", scope }))
    case "renew-lease": {
      const lease = state.snapshot?.lease
      if (scope === undefined || lease === undefined || lease.kind === "absent") {
        return unavailable(state, "There is no lease to renew.")
      }
      return pending(state, "Renewing the lease…", intent({ type: "renew-lease", scope, leaseId: lease.record.leaseId }))
    }
    case "request-takeover":
      return openTakeoverConfirmation(state)
    case "confirm-takeover":
      // The CONTROL for the same guarded branch as the `confirm-takeover` ACTION,
      // so a shell that drives controls and a caller that drives actions get the
      // same answer. It reuses the identical `takeoverBlockers` check, and asks
      // about the view's OWN scope — which is the case `scope-mismatch` exists
      // for, since a hand-built action could name any run at all.
      return confirmTakeover(state, scope ?? absentScope())
    case "cancel-takeover":
      return { state: { ...state, overlay: "none", confirmationArmed: false, notice: null }, intents: NO_INTENTS }
    case "inspect-unreconciled":
      return {
        state: { ...state, inspectedUnreconciledNodeIds: withSelectedNode(state.inspectedUnreconciledNodeIds, state.snapshot, state.selectedNodeId) },
        intents: NO_INTENTS,
      }
    case "acknowledge-unreconciled":
      return {
        state: { ...state, acknowledgedUnreconciledNodeIds: withSelectedNode(state.acknowledgedUnreconciledNodeIds, state.snapshot, state.selectedNodeId) },
        intents: NO_INTENTS,
      }
    case "view-nodes":
      return { state: { ...state, screen: "nodes", overlay: "none" }, intents: NO_INTENTS }
    case "view-sessions":
      return { state: { ...state, screen: "sessions", overlay: "none" }, intents: NO_INTENTS }
    case "view-degraded":
      return { state: { ...state, screen: "degraded", overlay: "none" }, intents: NO_INTENTS }
    case "back":
      // "Back" lands on the reconciliation screen, not on `nodes`. The screen the
      // operator came from is not tracked, and a mesh view that returned to the
      // node list on Back would put a partition behind a page of healthy-looking
      // machines — which is the one thing a partition must not do. Reconciliation
      // is the screen where the mesh's own account of itself is.
      return { state: { ...state, screen: "reconciliation", overlay: "none", confirmationArmed: false }, intents: NO_INTENTS }
  }
}

export type { MeshTuiActionType, MeshTuiDegradedCondition, MeshTuiIntent, MeshTuiOverlay, MeshTuiScreen, MeshTuiState, MeshTuiTransition, MeshTuiUiState }

export { MESH_TUI_ACTION_TYPES, MESH_TUI_DEGRADED_CONDITIONS, MESH_TUI_NETWORK_STATES, MESH_TUI_STATES, MESH_TUI_TAKEOVER_BLOCKERS }

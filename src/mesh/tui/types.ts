/**
 * M4.8 — the mesh TUI's vocabulary.
 *
 * A PURE presentation layer, and the single most important thing about it is what
 * it is not: it holds no registry, no lease, no gateway and no transport. It reads
 * a {@link MeshTuiSnapshot} that somebody else assembled from M4.3's registry,
 * M4.4's lease, M4.5's outbox, M4.6's reconciliation and M4.7's terminal gateway,
 * and it answers two questions — "what does the operator see" and "what did the
 * operator ask for". The second is an {@link MeshTuiIntent}, which is a VALUE.
 * Nothing in this directory performs a mesh operation, and the absence is the
 * design: a view layer that could reach a lease seam is a view layer whose
 * rendering path can be made to move an epoch.
 *
 * Four decisions in this file are the ones a later reader needs, and each is
 * stated on the member it constrains:
 *
 *   1. **The mesh state is a CROSS PRODUCT of two independent axes**, lease
 *      standing and network reachability, and all twelve cells are NAMED
 *      ({@link MESH_TUI_STATES}). Not because twelve is a nice number but because
 *      the plan's verification line for this task is "reducer scenarios for every
 *      lease/network state", and a union of two axes with a derived label would
 *      make that phrase mean "the interesting ones". The cross product is filled
 *      from a `Record` in `./state.js`, so a fifth lease standing is a compile
 *      error until every cell of it is written.
 *   2. **A degraded mesh is a LIST, not a boolean.** See
 *      {@link MESH_TUI_DEGRADED_CONDITIONS}: the five conditions have different
 *      remedies, and a single `healthy: false` would force the view to either
 *      drop the distinction or invent one flag per condition somewhere else.
 *   3. **`lifecycleState` and `observedState` travel together and are never
 *      merged.** The kernel keeps them apart because they are different axes; a
 *      remote-session row that collapsed them would be the first place the
 *      separation was lost.
 *   4. **A takeover is an intent with exactly one producer.** See
 *      {@link MeshTuiIntent} and `./state.js`: the plan forbids auto-election, and
 *      a guardrail against something ABSENT is only checkable against a surface a
 *      reader can enumerate. `MESH_TUI_ACTION_TYPES` is that surface.
 */

import type { Epoch, LeaseId, MeshId, NodeId, RunId, SessionId, TerminalClientId, TerminalId } from "../../orchestration/identifiers.js"
import type { Session } from "../../orchestration/types.js"
import type { LeaseRecord, LeaseScope } from "../lease/schemas.js"
import type { UnreconciledEntry } from "../protocol/reconciliation.js"
import type { RegisteredNode } from "../registry/schemas.js"
import type { MeshLaunchOutcome } from "../inbox/launch-outcome.js"

// --- The two axes -----------------------------------------------------------

/**
 * Who may create new work for the run this view is about.
 *
 * Four states, and the ORDER they are derived in is the order
 * `deriveLeaseSnapshot` applies, because the order is a decision:
 *
 *   - `absent` — no lease record. Nobody is driving this run and nothing has ever.
 *   - `expired` — a record whose window has closed. Checked BEFORE `superseded`
 *     because expiry is the more urgent and more actionable fact: a dead lease
 *     naming another controller is still a run nobody is driving, and the remedy
 *     (claim, or take over) does not depend on who held it.
 *   - `superseded` — a CURRENT lease naming a different node. This node was
 *     fenced. The remedy is to wait or to observe, emphatically not to claim, and
 *     reporting it as `held` would be the single most consequential misreading
 *     available to this view.
 *   - `held` — a current lease naming THIS node. The only state in which new work
 *     may be created.
 */
export const MESH_TUI_LEASE_STANDINGS = ["held", "expired", "absent", "superseded"] as const

export type MeshTuiLeaseStanding = (typeof MESH_TUI_LEASE_STANDINGS)[number]

/**
 * What the composing shell last observed about transport reachability.
 *
 * An INPUT and not something this layer infers, and the reason is that no seam in
 * M4.3–M4.7 reports reachability as a fact. A view that derived "partitioned"
 * from "no heartbeat arrived lately" would be inventing a network model out of a
 * liveness TTL, and the two disagree exactly when it matters — a node that is
 * `stale` because its CLOCK stepped is not behind a partition. The
 * reconciliation outcome is the honest source, and whoever composes the snapshot
 * is the only thing that knows it.
 */
export const MESH_TUI_NETWORK_STATES = ["up", "partitioned", "healing"] as const

export type MeshTuiNetworkState = (typeof MESH_TUI_NETWORK_STATES)[number]

/**
 * All twelve cells, named.
 *
 * `standing-network`, so a test row reads as the state it is rather than as an
 * index into a table. The `Record` in `./state.js` that fills this cross product
 * is what makes it exhaustive at COMPILE time; the array here is what makes it
 * enumerable at RUN time, which is the difference between a test that covers every
 * state and a test that covers the ones its author remembered.
 */
export const MESH_TUI_STATES = [
  "held-up",
  "held-partitioned",
  "held-healing",
  "expired-up",
  "expired-partitioned",
  "expired-healing",
  "absent-up",
  "absent-partitioned",
  "absent-healing",
  "superseded-up",
  "superseded-partitioned",
  "superseded-healing",
] as const

export type MeshTuiState = (typeof MESH_TUI_STATES)[number]

/** The lease in force, as the LEASE SEAM decided it. Never re-derived here. */
export type MeshTuiLeaseSnapshot =
  | { readonly kind: "held"; readonly record: LeaseRecord; readonly permitsNewWork: true }
  | { readonly kind: "expired"; readonly record: LeaseRecord; readonly permitsNewWork: false }
  /** Nothing to fence. A takeover is refused here, so the view must not offer one. */
  | { readonly kind: "absent" }
  /** A current lease held by another node: this node has been fenced. */
  | { readonly kind: "superseded"; readonly record: LeaseRecord; readonly permitsNewWork: false }

/**
 * M4.7's terminal attachment, narrowed to what this view renders.
 *
 * A SUBSET of `TerminalView` and not the type itself, because the view's job is to
 * show who is watching and who owns the keyboard, and the gateway's `droppedFrames`
 * counter and `binding` object are its own bookkeeping. The four members here are
 * the ones an operator reading a session row needs, and a projection that omitted
 * `lossy` would render a client that has silently lost frames as though it had not.
 */
export interface MeshTuiTerminalSnapshot {
  readonly terminalId: TerminalId
  readonly sessionId: SessionId
  readonly nodeId: NodeId
  readonly viewerCount: number
  readonly inputOwnerClientId: TerminalClientId | null
  readonly lossy: boolean
}

/** One session running somewhere, and what the mesh knows about it. */
export interface MeshRemoteSessionSnapshot {
  /** The kernel's own session, so the two axes arrive already separated. */
  readonly session: Session
  /**
   * M4.5's durable launch verdict, or `null` when this node holds no inbox row.
   *
   * Carried because M4.5 is where the ambiguous launch became representable
   * (Milestone 3 R4), and a remote-session view that omitted it would show a
   * session the controller has no evidence for as if it were ordinary.
   */
  readonly launchOutcome: MeshLaunchOutcome | null
  /** M4.7's live read of the terminal, or `null` when nothing is attached. */
  readonly terminal: MeshTuiTerminalSnapshot | null
}

/** M4.5's durable outbox row, narrowed to the four fields the degraded view reads. */
export interface MeshTuiOutboxRow {
  readonly outboxId: string
  readonly status: string
  readonly attempts: number
  readonly destination: string
  readonly lastError?: string
}

// --- Degraded conditions ---------------------------------------------------

/**
 * The five degraded conditions, which are five DIFFERENT PROBLEMS.
 *
 * The plan requires reconciliation step 6 to "mark unexplained differences for
 * user review", requires a lease expiry to pause new work without stopping
 * anything, and requires a node on an unnegotiable protocol version to be visible
 * as such. Collapsing those into one `offline` row is what a TUI does when it
 * treats "the mesh is not healthy" as a fact rather than as five facts with five
 * remedies, and the operator's next action is different in every one of them.
 *
 * Revocation is deliberately NOT here. A revoked node is not degraded, it is
 * excluded, and it is reported in `MeshNodeHealthSummary.revoked`. Adding it to
 * this list would teach an operator to read a decision they already made as a
 * fault they should fix.
 */
export const MESH_TUI_DEGRADED_CONDITIONS = [
  /** A peer that heartbeated and then went quiet. It will come back. */
  "stale-peer",
  /** An unexplained difference, marked for review. Never resolved from here. */
  "unreconciled-node",
  /** A lease whose window closed. New work is paused; running agents are NOT stopped. */
  "expired-lease",
  /** A node that speaks no protocol version in common with this build. */
  "protocol-mismatch",
  /** A durable outbox row past the attempt threshold. Retained, never deleted. */
  "poisoned-outbox-row",
] as const

export type MeshTuiDegradedCondition = (typeof MESH_TUI_DEGRADED_CONDITIONS)[number]

/**
 * The remedy each condition names.
 *
 * Five distinct values, and distinctness is a TEST rather than a convention: two
 * conditions sharing an action would mean the view had decided they are the same
 * problem, which is the collapse this list exists to prevent.
 */
export const MESH_TUI_OPERATOR_ACTIONS = [
  "wait-for-heartbeat",
  "inspect-and-acknowledge",
  "claim-or-take-over",
  "upgrade-peer",
  "inspect-outbox-row",
] as const

export type MeshTuiOperatorAction = (typeof MESH_TUI_OPERATOR_ACTIONS)[number]

/** What a condition is about. Node, run, or durable row — never a bare string. */
export type MeshTuiDegradedSubject =
  | { readonly kind: "node"; readonly nodeId: NodeId }
  | { readonly kind: "run"; readonly runId: RunId }
  | { readonly kind: "outbox-row"; readonly outboxId: string }

export interface MeshTuiDegradedConditionView {
  readonly condition: MeshTuiDegradedCondition
  readonly subject: MeshTuiDegradedSubject
  /** What is true, in one sentence an operator can act on. */
  readonly detail: string
  readonly action: MeshTuiOperatorAction
  /** The action, as a thing to do rather than as a verb. */
  readonly actionLabel: string
}

// --- The snapshot ----------------------------------------------------------

/**
 * Everything this view displays, already read by the layer that owns it.
 *
 * The `nowMs` is absent and that is deliberate: nothing here is computed against
 * a wall clock. Heartbeat ages arrive as `RegisteredNode.ageMs`, which M4.3
 * derived with ITS injected clock, and lease standing arrives as a decision rather
 * than as a pair of timestamps for this layer to compare. A presentation layer
 * with its own clock is a layer whose output depends on when it was asked, and
 * "a stale node shows its heartbeat age" would become a sleep.
 */
export interface MeshTuiSnapshot {
  readonly meshId: MeshId
  /** This node, so "am I the controller" and "is this session mine" have answers. */
  readonly localNodeId: NodeId
  readonly scope: LeaseScope
  readonly lease: MeshTuiLeaseSnapshot
  readonly network: MeshTuiNetworkState
  readonly nodes: readonly RegisteredNode[]
  readonly sessions: readonly MeshRemoteSessionSnapshot[]
  /** Step 6's output. Differences, never actions. */
  readonly unreconciled: readonly UnreconciledEntry[]
  readonly outbox: readonly MeshTuiOutboxRow[]
}

// --- State -----------------------------------------------------------------

export type MeshTuiScreen = "nodes" | "sessions" | "degraded" | "reconciliation"
export type MeshTuiOverlay = "none" | "help" | "takeover-confirmation"

/**
 * The controls the view offers.
 *
 * `request-takeover` is in this vocabulary and `takeover` is NOT, and the absence
 * is the whole guard. What the control opens is a confirmation overlay; the
 * operation itself is behind {@link MeshTuiIntent}, whose only producer is the
 * confirmed-and-unblocked path in `./state.js`.
 */
export const MESH_TUI_ACTION_CONTROLS = [
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
  "confirm-takeover",
  "cancel-takeover",
] as const

export type MeshTuiActionControl = (typeof MESH_TUI_ACTION_CONTROLS)[number]

export interface MeshTuiUiState {
  readonly shell: "booting" | "ready" | "unavailable"
  readonly snapshot: MeshTuiSnapshot | null
  /** The cross-product cell. `null` until a snapshot has been read. */
  readonly mesh: MeshTuiState | null
  readonly screen: MeshTuiScreen
  readonly overlay: MeshTuiOverlay
  readonly selectedNodeId: NodeId | null
  readonly selectedSessionId: SessionId | null
  /**
   * The unreconciled nodes the operator has actually opened.
   *
   * Distinct from `acknowledgedUnreconciledNodeIds` on purpose. The plan asks for
   * inspection AND explicit acceptance, and a view that collapsed the two would
   * let a single click satisfy both — at which point the guard M4.4 enforces
   * becomes a formality.
   */
  readonly inspectedUnreconciledNodeIds: readonly NodeId[]
  readonly acknowledgedUnreconciledNodeIds: readonly NodeId[]
  readonly takeoverReason: string
  /** Dialogs open on Back; the destructive control needs an explicit focus move. */
  readonly confirmationArmed: boolean
  readonly notice: string | null
  readonly pending: string | null
}

/**
 * The action vocabulary, enumerated at RUN time.
 *
 * The lease directory does the same thing for `LEASE_OPERATIONS`, and for the same
 * reason: "no automatic path may reach a takeover" is a claim about a set, and a
 * set written as a TypeScript union cannot be iterated by the test that has to
 * prove it. Adding an action here forces the reducer to handle it, and forces the
 * takeover-safety test to drive it.
 */
export const MESH_TUI_ACTION_TYPES = [
  "snapshot-loaded",
  "shell-unavailable",
  "select-node",
  "select-session",
  "navigate",
  "activate",
  "set-overlay",
  "dismiss-overlay",
  "set-confirmation-armed",
  "takeover-reason",
  "inspect-unreconciled",
  "acknowledge-unreconciled",
  "request-takeover",
  "confirm-takeover",
  "set-notice",
  "set-pending",
] as const

export type MeshTuiActionType = (typeof MESH_TUI_ACTION_TYPES)[number]

export type MeshTuiAction =
  | { readonly type: "snapshot-loaded"; readonly snapshot: MeshTuiSnapshot }
  | { readonly type: "shell-unavailable"; readonly reason: string }
  | { readonly type: "select-node"; readonly nodeId: NodeId | null }
  | { readonly type: "select-session"; readonly sessionId: SessionId | null }
  | { readonly type: "navigate"; readonly screen: MeshTuiScreen }
  | { readonly type: "activate"; readonly control: MeshTuiActionControl }
  | { readonly type: "set-overlay"; readonly overlay: MeshTuiOverlay }
  | { readonly type: "dismiss-overlay" }
  | { readonly type: "set-confirmation-armed"; readonly armed: boolean }
  | { readonly type: "takeover-reason"; readonly reason: string }
  | { readonly type: "inspect-unreconciled" }
  | { readonly type: "acknowledge-unreconciled" }
  | { readonly type: "request-takeover" }
  /**
   * The one action that can raise an epoch, and it carries the scope it believes
   * it is taking over. A confirmation for a run this view is not showing is
   * refused with a message rather than quietly retargeted, because retargeting it
   * would be a takeover the operator did not read the confirmation for.
   */
  | { readonly type: "confirm-takeover"; readonly scope: LeaseScope }
  | { readonly type: "set-notice"; readonly notice: string | null }
  | { readonly type: "set-pending"; readonly pending: string | null }

/**
 * What the operator asked for, as a VALUE.
 *
 * The reducer returns these; it never performs them. `request-takeover` is the
 * only member that raises an epoch and it is produced by exactly one branch of
 * exactly one case in `./state.js`, which is the structural form of the plan's
 * "do not implement auto-election".
 */
export type MeshTuiIntent =
  | { readonly type: "refresh" }
  | { readonly type: "reconcile"; readonly scope: LeaseScope }
  | { readonly type: "claim-lease"; readonly scope: LeaseScope }
  | { readonly type: "renew-lease"; readonly scope: LeaseScope; readonly leaseId: LeaseId }
  | {
      readonly type: "request-takeover"
      readonly scope: LeaseScope
      readonly predecessorLeaseId: LeaseId
      readonly predecessorEpoch: Epoch
      readonly acknowledgedUnreconciledNodeIds: readonly NodeId[]
      readonly reason: string
    }

/** The reducer's whole output. Effects are the caller's; this layer has none. */
export interface MeshTuiTransition {
  readonly state: MeshTuiUiState
  readonly intents: readonly MeshTuiIntent[]
}

// --- View model ------------------------------------------------------------

export interface MeshNodeHealthView {
  readonly nodeId: NodeId
  readonly displayName: string
  readonly isLocal: boolean
  readonly liveness: RegisteredNode["liveness"]
  /**
   * Whether this node is OFF THE MESH, as its own field.
   *
   * Not derived from `liveness` for display and not implied by dimming: a revoked
   * node that also happens to be stale must read as revoked, and the only way to
   * guarantee that is to make revocation a member the renderer cannot forget.
   */
  readonly revoked: boolean
  readonly revocationReason: string | null
  readonly runtimeKinds: readonly string[]
  readonly capabilities: readonly string[]
  readonly projectPathIds: readonly string[]
  readonly load: { readonly activeSessions: number; readonly queuedSessions: number } | null
  readonly maxConcurrentSessions: number | null
  /** `null` when there is no version in common, which is never schedulable. */
  readonly negotiatedProtocolVersion: number | null
  readonly protocolCompatible: boolean
  /** Whether the node has demonstrably spoken. Never inferred from liveness. */
  readonly reachable: boolean
  readonly lastHeartbeatAt: string | null
  /** M4.3's own derivation, at the registry's clock. `null` when never seen. */
  readonly heartbeatAgeMs: number | null
  /** The one word an operator reads first. `REVOKED` is never a dimmed `STALE`. */
  readonly badge: string
}

export interface MeshNodeHealthSummary {
  readonly total: number
  readonly live: number
  readonly stale: number
  readonly neverSeen: number
  readonly revoked: number
  readonly protocolIncompatible: number
}

export interface MeshRemoteSessionView {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly dispatchId: string
  readonly nodeId: NodeId
  readonly nodeDisplayName: string
  /**
   * Whether the session runs on a node OTHER than this one.
   *
   * Its own member rather than something a caller filters on, because "remote" is
   * the whole point of this screen: an operator looking at a local session and an
   * operator looking at a partitioned one are reading the same row shape, and a
   * filter applied by the caller would make the difference invisible in the view
   * model a fault harness asserts against.
   */
  readonly remote: boolean
  /** The kernel's lifecycle axis. Authoritative, and outranks the observation. */
  readonly lifecycleState: Session["lifecycleState"]
  /**
   * The provider's observation. A DIFFERENT axis, and never a substitute.
   *
   * `unknown` here beside a `running` lifecycle is the ordinary shape of a lost
   * status event, and collapsing the two — or letting the badge fall back to the
   * observation when the lifecycle is terminal — is how a finished session comes
   * to read as a live one.
   */
  readonly observedState: Session["observedState"]
  readonly runtimeKind: string
  readonly terminalId: TerminalId | null
  readonly terminalViewers: number | null
  readonly terminalInputOwner: TerminalClientId | null
  readonly terminalLossy: boolean | null
  readonly launchOutcome: MeshLaunchOutcome | null
}

export interface MeshUnreconciledView {
  readonly nodeId: NodeId
  readonly reason: UnreconciledEntry["reason"]
  readonly detail: string
  readonly inspected: boolean
  readonly acknowledged: boolean
}

/**
 * Why a takeover confirmation is not yet confirmable.
 *
 * An ORDERED list rather than a boolean, and the order is the order the reducer
 * asks in. The first entry is the sentence the operator reads, and it names the
 * single thing still standing between them and a fence — a refusal that listed
 * every unmet precondition at once would be the one-sentence answer replaced by a
 * paragraph.
 */
export const MESH_TUI_TAKEOVER_BLOCKERS = [
  "scope-mismatch",
  "confirmation-required",
  "not-armed",
  "no-predecessor",
  "unreconciled-not-inspected",
  "unreconciled-not-acknowledged",
  "reason-required",
] as const

export type MeshTuiTakeoverBlocker = (typeof MESH_TUI_TAKEOVER_BLOCKERS)[number]

export interface MeshTakeoverBlockerView {
  readonly blocker: MeshTuiTakeoverBlocker
  readonly message: string
  /** The nodes still owed an inspection or an acknowledgement, when the blocker is about nodes. */
  readonly nodeIds: readonly NodeId[]
}

export interface MeshTakeoverSummary {
  /**
   * Whether the "take over this run" control is offered at all.
   *
   * False for an `absent` lease, and that is a PROTOCOL fact rather than a UX
   * preference: `evaluateLease` refuses `no_lease_to_fence`, so a control that
   * offered it would be offering an operation that cannot succeed.
   */
  readonly offered: boolean
  /** Whether confirming RIGHT NOW would produce a takeover intent. */
  readonly confirmable: boolean
  /** Every unmet precondition, in the order the reducer asks about them. */
  readonly blockers: readonly MeshTakeoverBlockerView[]
  readonly predecessorLeaseId: LeaseId | null
  readonly predecessorEpoch: Epoch | null
  readonly reason: string
  readonly acknowledgedUnreconciledNodeIds: readonly NodeId[]
}

export interface MeshLeaseSummary {
  readonly standing: MeshTuiLeaseStanding
  readonly kind: MeshTuiLeaseSnapshot["kind"]
  readonly controllerNodeId: NodeId | null
  readonly epoch: Epoch | null
  readonly expiresAt: string | null
  readonly permitsNewWork: boolean
  /** True when the lease in force is this node's own unverified copy. */
  readonly uncorroborated: boolean
}

export interface MeshTuiViewModel {
  readonly status: string
  readonly title: string
  readonly mesh: MeshTuiState | null
  readonly lease: MeshLeaseSummary | null
  readonly network: MeshTuiNetworkState | null
  readonly nodes: readonly MeshNodeHealthView[]
  readonly nodeSummary: MeshNodeHealthSummary
  readonly sessions: readonly MeshRemoteSessionView[]
  readonly degraded: readonly MeshTuiDegradedConditionView[]
  readonly unreconciled: readonly MeshUnreconciledView[]
  readonly takeover: MeshTakeoverSummary | null
  readonly availableActions: readonly MeshTuiActionControl[]
  readonly notice: string | null
  readonly pending: string | null
  readonly lines: readonly string[]
}

export type { Epoch, LeaseId, LeaseRecord, LeaseScope, MeshId, NodeId, RegisteredNode, RunId, Session, SessionId, UnreconciledEntry }

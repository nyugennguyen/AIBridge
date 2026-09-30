/**
 * M4.8 — the mesh view model.
 *
 * Pure, like the reducer, and for the same reason: a view model that could be
 * built without a state is a view model a fault harness can assert against, which
 * is what M4.9 needs and what makes "the degraded view names five different
 * remedies" a testable claim rather than a screenshot.
 *
 * Four things in here are decisions rather than formatting, and each says so:
 *
 *   1. **`badge` is a WORD, and `REVOKED` is not a dimmed `STALE`.** A renderer
 *      that greys a row cannot distinguish "this machine is off the mesh" from
 *      "this machine went quiet and will be back", and those two have opposite
 *      remedies. The badge is computed from `liveness` with `revoked` checked
 *      FIRST, because a revoked node that also went stale is still revoked.
 *   2. **`reachable` and `protocolCompatible` are separate members.** A node that
 *      is `live` and speaks no version in common is neither unreachable nor
 *      compatible, and a view that reported "offline" for it would send the
 *      operator to fix a network problem they do not have.
 *   3. **The session badge prefers `lifecycleState`.** The same rule
 *      `src/tui/view-model.ts` applies to a local session, and for the same
 *      reason: a terminal lifecycle is authoritative, and an observation is a
 *      report about a process.
 *   4. **`unreconciled[]` has no member that could resolve it.** There is no
 *      `resolved`, no `adopted`, no `terminated` — the same structural absence
 *      `meshReconciliationResponseSchema` enforces, restated in a type a renderer
 *      reads. The row carries `inspected` and `acknowledged`, which are facts
 *      about the operator, and nothing about the difference itself.
 */

import { exceedsMaxAttempts } from "../outbox/policy.js"
import type {
  MeshLeaseSummary,
  MeshNodeHealthSummary,
  MeshNodeHealthView,
  MeshRemoteSessionView,
  MeshTakeoverSummary,
  MeshTuiDegradedCondition,
  MeshTuiDegradedConditionView,
  MeshTuiOperatorAction,
  MeshTuiState,
  MeshTuiUiState,
  MeshTuiViewModel,
  MeshUnreconciledView,
} from "./types.js"
import { MESH_TUI_ACTIONS_BY_STATE, MESH_TUI_ACTION_LABELS, availableMeshTuiActions, takeoverBlockers } from "./state.js"

/**
 * The one word an operator reads first for a node.
 *
 * Order is the design: revocation is checked before liveness because it is the
 * only one of the four that survives a fresh heartbeat, and a revoked node that
 * somehow heartbeats again must still read as revoked.
 */
export function nodeBadge(node: MeshNodeHealthView): string {
  if (node.revoked) return "REVOKED"
  switch (node.liveness) {
    case "live":
      return node.protocolCompatible ? "LIVE" : "INCOMPATIBLE"
    case "stale":
      return "STALE"
    case "never-seen":
      return "NEVER-SEEN"
    case "revoked":
      return "REVOKED"
  }
}

/** Formats a heartbeat age for a row, or the words to use when there is none. */
export function heartbeatAgeLabel(node: MeshNodeHealthView): string {
  if (node.heartbeatAgeMs === null) return "never seen"
  const seconds = Math.floor(node.heartbeatAgeMs / 1000)
  if (seconds < 1) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m ago`
}

function buildNodeViews(state: MeshTuiUiState): readonly MeshNodeHealthView[] {
  const snapshot = state.snapshot
  if (snapshot === null) return []
  return snapshot.nodes.map((registered) => {
    const node = registered.node
    const capability = node.capability
    // `reachable` is a statement about whether the node has DEMONSTRABLY SPOKEN,
    // and it is not `liveness === "live"`: a node at capacity is reachable and
    // busy, and a node heartbeating on an unnegotiable version is reachable and
    // incompatible. Both are cases where "offline" would be a lie.
    const reachable = node.capability !== null
    const compatible = registered.negotiatedProtocolVersion !== null
    const view: MeshNodeHealthView = {
      nodeId: node.nodeId,
      displayName: node.displayName,
      isLocal: node.nodeId === snapshot.localNodeId,
      liveness: registered.liveness,
      revoked: node.revocation !== null,
      revocationReason: node.revocation?.reason ?? null,
      runtimeKinds: capability?.runtimeKinds ?? [],
      capabilities: capability?.capabilities ?? [],
      projectPathIds: capability?.projectPathIds ?? [],
      load: capability?.load ?? null,
      maxConcurrentSessions: capability?.maxConcurrentSessions ?? null,
      negotiatedProtocolVersion: registered.negotiatedProtocolVersion,
      protocolCompatible: compatible,
      reachable,
      lastHeartbeatAt: registered.lastHeartbeatAt,
      heartbeatAgeMs: registered.ageMs,
      badge: "LIVE",
    }
    return { ...view, badge: nodeBadge(view) }
  })
}

function summariseNodes(nodes: readonly MeshNodeHealthView[]): MeshNodeHealthSummary {
  return {
    total: nodes.length,
    live: nodes.filter((node) => node.liveness === "live").length,
    stale: nodes.filter((node) => node.liveness === "stale").length,
    neverSeen: nodes.filter((node) => node.liveness === "never-seen").length,
    revoked: nodes.filter((node) => node.revoked).length,
    protocolIncompatible: nodes.filter((node) => node.reachable && !node.protocolCompatible).length,
  }
}

function buildSessionViews(state: MeshTuiUiState, nodes: readonly MeshNodeHealthView[]): readonly MeshRemoteSessionView[] {
  const snapshot = state.snapshot
  if (snapshot === null) return []
  return snapshot.sessions.map((entry) => {
    const session = entry.session
    const node = nodes.find((candidate) => candidate.nodeId === session.nodeId)
    return {
      sessionId: session.sessionId,
      runId: session.runId,
      dispatchId: session.dispatchId,
      nodeId: session.nodeId,
      nodeDisplayName: node?.displayName ?? "unknown node",
      remote: session.nodeId !== snapshot.localNodeId,
      lifecycleState: session.lifecycleState,
      observedState: session.observedState,
      runtimeKind: session.runtimeKind,
      terminalId: session.terminalId ?? null,
      terminalViewers: entry.terminal?.viewerCount ?? null,
      terminalInputOwner: entry.terminal?.inputOwnerClientId ?? null,
      terminalLossy: entry.terminal?.lossy ?? null,
      launchOutcome: entry.launchOutcome,
    }
  })
}

/**
 * The five conditions, in the order they are most likely to need an operator.
 *
 * ORDER matters more than it looks. `expired-lease` and `unreconciled-node` come
 * first because they are the two that gate a takeover, and an operator reading
 * top-down learns what is blocking them before what is merely worth knowing. The
 * rest follow in the order the plan mentions them.
 */
const DEGRADED_ORDER: readonly MeshTuiDegradedCondition[] = [
  "expired-lease",
  "unreconciled-node",
  "stale-peer",
  "protocol-mismatch",
  "poisoned-outbox-row",
]

/**
 * The remedy each condition names, and the label that goes with it.
 *
 * A `Record` rather than a `switch` inside the builder, so the distinctness test
 * can read the mapping itself: two conditions sharing a remedy would mean this
 * layer had decided they are the same problem, which is the collapse the list
 * exists to prevent.
 */
export const MESH_TUI_CONDITION_ACTIONS: Readonly<Record<MeshTuiDegradedCondition, MeshTuiOperatorAction>> = Object.freeze({
  "stale-peer": "wait-for-heartbeat",
  "unreconciled-node": "inspect-and-acknowledge",
  "expired-lease": "claim-or-take-over",
  "protocol-mismatch": "upgrade-peer",
  "poisoned-outbox-row": "inspect-outbox-row",
})

/** The remedy texts, exported so a caller can render one without the view model. */
export const MESH_TUI_ACTION_LABELS_BY_REMEDY: Readonly<Record<MeshTuiOperatorAction, string>> = Object.freeze({
  "wait-for-heartbeat": "Wait for its next heartbeat, or reconcile it. Its sessions are not stopped and must not be.",
  "inspect-and-acknowledge": "Inspect each unreconciled node, then accept it as degraded or wait for it.",
  "claim-or-take-over": "Claim this run, or take the lease over explicitly. Nothing already running is stopped either way.",
  "upgrade-peer": "Upgrade that node, or re-enroll it. It is never schedulable until it speaks a version in common.",
  "inspect-outbox-row": "Read the retained row. The outbox is evidence, not a cache: the record is never deleted and never retried past the threshold.",
})

/**
 * Every degraded condition that holds, with the remedy it names.
 *
 * The five are independent predicates rather than one `if`, and each is a
 * different SUBJECT: a lease, a node, a peer, a node, a durable row. Deriving
 * them separately is what makes a mesh with four of the five at once show four
 * rows instead of one summary line.
 */
export function deriveDegradedConditions(state: MeshTuiUiState): readonly MeshTuiDegradedConditionView[] {
  const snapshot = state.snapshot
  if (snapshot === null) return []
  const nodes = buildNodeViews(state)
  const found = new Map<MeshTuiDegradedCondition, MeshTuiDegradedConditionView>()

  if (snapshot.lease.kind === "expired") {
    found.set("expired-lease", {
      condition: "expired-lease",
      subject: { kind: "run", runId: snapshot.scope.runId },
      detail:
        `The controller lease for this run expired at ${snapshot.lease.record.expiresAt} (epoch ${snapshot.lease.record.epoch}, controller ${snapshot.lease.record.controllerNodeId}). ` +
        "No new dispatch, retry or policy mutation is permitted while it is expired. Running agents are untouched: an expiry pauses new work, it never terminates existing work.",
      action: MESH_TUI_CONDITION_ACTIONS["expired-lease"],
      actionLabel: MESH_TUI_ACTION_LABELS_BY_REMEDY["claim-or-take-over"],
    })
  }

  for (const entry of snapshot.unreconciled) {
    found.set("unreconciled-node", {
      condition: "unreconciled-node",
      subject: { kind: "node", nodeId: entry.nodeId },
      detail:
        `Reconciliation marked a difference on ${entry.nodeId} (${entry.reason}): ${entry.detail} ` +
        "This is a difference for a human to decide. Nothing has been adopted and nothing has been terminated, and nothing in this view can do either.",
      action: MESH_TUI_CONDITION_ACTIONS["unreconciled-node"],
      actionLabel: MESH_TUI_ACTION_LABELS_BY_REMEDY["inspect-and-acknowledge"],
    })
  }

  for (const node of nodes) {
    if (node.revoked) continue
    if (node.liveness === "stale") {
      found.set("stale-peer", {
        condition: "stale-peer",
        subject: { kind: "node", nodeId: node.nodeId },
        detail:
          `${node.displayName} last reported ${heartbeatAgeLabel(node)} and is past the heartbeat bound, so its capabilities are not honoured. ` +
          "It went quiet, not hostile: a node that stops talking is a node that comes back, and its sessions are not stopped.",
        action: MESH_TUI_CONDITION_ACTIONS["stale-peer"],
        actionLabel: MESH_TUI_ACTION_LABELS_BY_REMEDY["wait-for-heartbeat"],
      })
    }
  }

  for (const node of nodes) {
    if (node.revoked) continue
    if (node.reachable && !node.protocolCompatible) {
      found.set("protocol-mismatch", {
        condition: "protocol-mismatch",
        subject: { kind: "node", nodeId: node.nodeId },
        detail:
          `${node.displayName} is talking but offers no protocol version in common with this build. ` +
          "Reconciliation refuses at step 1 against it and it is never a scheduling candidate. This is a version problem, not a reachability one — the node answered.",
        action: MESH_TUI_CONDITION_ACTIONS["protocol-mismatch"],
        actionLabel: MESH_TUI_ACTION_LABELS_BY_REMEDY["upgrade-peer"],
      })
    }
  }

  for (const row of snapshot.outbox) {
    if (!exceedsMaxAttempts(row.attempts)) continue
    found.set("poisoned-outbox-row", {
      condition: "poisoned-outbox-row",
      subject: { kind: "outbox-row", outboxId: row.outboxId },
      detail:
        `Outbox row ${row.outboxId} to ${row.destination} is terminal after ${row.attempts} attempt(s)` +
        (row.lastError === undefined ? "." : `: ${row.lastError}`) +
        " The row is retained on purpose — the outbox is evidence, not a cache — so deleting it would leave a reconciliation pass with an unexplained divergence and nothing to point at.",
      action: MESH_TUI_CONDITION_ACTIONS["poisoned-outbox-row"],
      actionLabel: MESH_TUI_ACTION_LABELS_BY_REMEDY["inspect-outbox-row"],
    })
  }

  return DEGRADED_ORDER.filter((condition) => found.has(condition)).map((condition) => found.get(condition)!)
}

function buildUnreconciledViews(state: MeshTuiUiState): readonly MeshUnreconciledView[] {
  const snapshot = state.snapshot
  if (snapshot === null) return []
  // No `resolved`/`adopted`/`terminated` member exists here, and that absence is
  // the point: this list is the only channel a difference takes to a human, and a
  // view that could mark one settled would be a second, silent resolution path
  // beside the one the plan forbids.
  return snapshot.unreconciled.map((entry) => ({
    nodeId: entry.nodeId,
    reason: entry.reason,
    detail: entry.detail,
    inspected: state.inspectedUnreconciledNodeIds.includes(entry.nodeId),
    acknowledged: state.acknowledgedUnreconciledNodeIds.includes(entry.nodeId),
  }))
}

function buildTakeoverSummary(state: MeshTuiUiState): MeshTakeoverSummary | null {
  const snapshot = state.snapshot
  if (snapshot === null) return null
  // `offered` is asked of the CELL, not of the current control set. While the
  // confirmation is open the action set is the dialog's two controls, so asking
  // `availableActions` here would report a takeover the operator is in the middle
  // of as un-offered — and `confirmable` is the conjunction of "offered" and "no
  // blocker", so the whole summary would read as blocked in the one state where
  // it is not.
  const offered = state.mesh !== null && MESH_TUI_ACTIONS_BY_STATE[state.mesh].includes("request-takeover")
  const scope = snapshot.scope
  const blockers = takeoverBlockers(state, scope)
  const lease = snapshot.lease
  return {
    offered,
    // `confirmable` is the conjunction of "no blocker" and "the control is on
    // screen", so a caller can ask one question instead of reproducing the list.
    confirmable: blockers.length === 0 && offered,
    blockers,
    predecessorLeaseId: lease.kind === "absent" ? null : lease.record.leaseId,
    predecessorEpoch: lease.kind === "absent" ? null : lease.record.epoch,
    reason: state.takeoverReason,
    acknowledgedUnreconciledNodeIds: [...state.acknowledgedUnreconciledNodeIds],
  }
}

function buildLeaseSummary(state: MeshTuiUiState): MeshLeaseSummary | null {
  const snapshot = state.snapshot
  if (snapshot === null) return null
  const lease = snapshot.lease
  if (lease.kind === "absent") {
    return {
      standing: "absent",
      kind: "absent",
      controllerNodeId: null,
      epoch: null,
      expiresAt: null,
      permitsNewWork: false,
      uncorroborated: false,
    }
  }
  return {
    standing: lease.kind,
    kind: lease.kind,
    controllerNodeId: lease.record.controllerNodeId,
    epoch: lease.record.epoch,
    expiresAt: lease.record.expiresAt,
    permitsNewWork: lease.permitsNewWork,
    // A lease this node holds while partitioned is this node's own UNVERIFIED
    // copy: nothing has told it that a successor exists. The view says so rather
    // than reporting a comfortable current lease, because the whole hazard of a
    // partition is that the local view is the last thing to learn.
    uncorroborated: snapshot.network !== "up" && lease.record.controllerNodeId === snapshot.localNodeId,
  }
}

/**
 * The whole view model, or `null` for a shell that cannot read the mesh.
 *
 * Not a string. A renderer is one consumer of this and a fault harness is
 * another; handing both a structure means M4.9 can assert on "the degraded view
 * names five different remedies" without capturing output.
 */
export function buildMeshTuiView(state: MeshTuiUiState): MeshTuiViewModel | null {
  if (state.shell === "unavailable") return null
  const nodes = buildNodeViews(state)
  const sessions = buildSessionViews(state, nodes)
  const degraded = deriveDegradedConditions(state)
  const unreconciled = buildUnreconciledViews(state)
  const availableActions = availableMeshTuiActions(state)
  const takeover = buildTakeoverSummary(state)
  const mesh: MeshTuiState | null = state.mesh
  const view: MeshTuiViewModel = {
    status: statusOf(state),
    title: titleOf(state),
    mesh,
    lease: buildLeaseSummary(state),
    network: state.snapshot?.network ?? null,
    nodes,
    nodeSummary: summariseNodes(nodes),
    sessions,
    degraded,
    unreconciled,
    takeover,
    availableActions,
    notice: state.notice,
    pending: state.pending,
    lines: [],
  }
  return { ...view, lines: renderLines(view, state) }
}

function statusOf(state: MeshTuiUiState): string {
  if (state.shell === "booting") return "LOADING"
  if (state.mesh === null) return "UNKNOWN"
  switch (state.mesh) {
    case "held-up":
      return "CONTROLLING"
    case "held-partitioned":
      return "CONTROLLING (UNCORROBORATED)"
    case "held-healing":
      return "CONTROLLING (RECONNECTING)"
    case "expired-up":
    case "expired-partitioned":
    case "expired-healing":
      return "PAUSED — LEASE EXPIRED"
    case "absent-up":
    case "absent-partitioned":
    case "absent-healing":
      return "UNCLAIMED"
    case "superseded-up":
    case "superseded-partitioned":
    case "superseded-healing":
      return "SUPERSEDED"
  }
}

function titleOf(state: MeshTuiUiState): string {
  const scope = state.snapshot?.scope
  switch (state.screen) {
    case "nodes":
      return scope === undefined ? "Mesh" : `Mesh — ${scope.runId}`
    case "sessions":
      return scope === undefined ? "Remote sessions" : `Remote sessions — ${scope.runId}`
    case "degraded":
      return scope === undefined ? "Degraded conditions" : `Degraded conditions — ${scope.runId}`
    case "reconciliation":
      return scope === undefined ? "Reconciliation" : `Reconciliation — ${scope.runId}`
  }
}

function renderLines(view: MeshTuiViewModel, state: MeshTuiUiState): readonly string[] {
  const lines: string[] = [view.title, `[${view.status}]`, ""]
  // LEASE AND NETWORK on every screen, because they are the two facts that change
  // what every other row MEANS: a session list read under an expired lease and a
  // session list read under a current one are the same sessions and a different
  // situation.
  if (view.lease !== null) {
    const lease = view.lease
    lines.push(
      lease.kind === "absent"
        ? "Lease: none — nobody has ever driven this run."
        : `Lease: epoch ${lease.epoch ?? "?"} held by ${lease.controllerNodeId ?? "?"}${lease.expiresAt === null ? "" : `, expires ${lease.expiresAt}`}${lease.uncorroborated ? " (uncorroborated: this copy has not been confirmed by a peer)" : ""}`,
    )
    lines.push(`New work: ${lease.permitsNewWork ? "permitted" : "REFUSED"}`)
  }
  if (view.network !== null) {
    lines.push(
      `Mesh: ${view.network}` +
        (view.network === "partitioned" ? " — this node's lease is its own unverified copy; nobody has confirmed a successor does not exist." : ""),
    )
  }
  // The node table belongs to the node screen and the reconciliation screen, and
  // not to the sessions screen: a session list with a node table above it invites
  // the reader to treat a node's health as the session's state, which is the merge
  // this whole directory exists to avoid.
  if (state.screen === "nodes" || state.screen === "reconciliation") {
    lines.push(
      "",
      `Nodes: ${view.nodeSummary.total} total, ${view.nodeSummary.live} live, ${view.nodeSummary.stale} stale, ${view.nodeSummary.neverSeen} never seen, ${view.nodeSummary.revoked} revoked, ${view.nodeSummary.protocolIncompatible} incompatible`,
    )
    for (const node of view.nodes) {
      lines.push(
        `  ${node.isLocal ? "*" : " "} ${node.displayName} [${node.badge}] — ${heartbeatAgeLabel(node)}` +
          `${node.revocationReason === null ? "" : ` (${node.revocationReason})`}` +
          `${node.protocolCompatible ? "" : ` — protocol ${node.negotiatedProtocolVersion === null ? "incompatible" : node.negotiatedProtocolVersion}`}` +
          `${node.load === null ? "" : ` — ${node.load.activeSessions}/${node.maxConcurrentSessions ?? "?"} sessions`}`,
      )
    }
  }
  if (state.screen !== "degraded" && view.sessions.length > 0) {
    lines.push("", "Sessions:")
    for (const session of view.sessions) {
      lines.push(
        `  ${session.remote ? "remote" : "local "} ${session.sessionId} on ${session.nodeDisplayName} — lifecycle ${session.lifecycleState}, observed ${session.observedState}` +
          `${session.launchOutcome === null ? "" : `, launch ${session.launchOutcome}`}` +
          `${session.terminalId === null ? "" : `, terminal ${session.terminalId} (${session.terminalViewers ?? 0} viewer(s)${session.terminalInputOwner === null ? "" : `, input ${session.terminalInputOwner}`}${session.terminalLossy === true ? ", LOSSY" : ""})`}`,
      )
    }
  }
  // The unreconciled list is on EVERY screen, and not because it is short. It is
  // the one list whose absence from a screen would be read as its absence from
  // the mesh, and an operator on the session list is exactly the person who needs
  // to know a session on another node is unreconciled.
  if (view.unreconciled.length > 0) {
    lines.push("", "UNRECONCILED — differences a human must decide. Nothing here is adopted or terminated:")
    for (const entry of view.unreconciled) {
      lines.push(
        `  ${entry.nodeId} [${entry.reason}]${entry.inspected ? " inspected" : " NOT INSPECTED"}${entry.acknowledged ? ", accepted as degraded" : ", NOT ACCEPTED"}`,
      )
      lines.push(`    ${entry.detail}`)
    }
  }
  if (view.degraded.length > 0) {
    lines.push("", "Degraded:")
    for (const condition of view.degraded) {
      lines.push(`  [${condition.condition}] ${condition.detail}`)
      lines.push(`    → ${condition.actionLabel}`)
    }
  }
  if (state.overlay === "takeover-confirmation") {
    lines.push("", "CONFIRM CONTROLLER TAKEOVER")
    const takeover = view.takeover
    lines.push(
      takeover?.predecessorLeaseId === null || takeover === null
        ? "There is no lease to fence."
        : `Fences lease ${takeover.predecessorLeaseId} at epoch ${takeover.predecessorEpoch ?? "?"}. The new epoch must be strictly higher; a takeover that does not raise it fences nothing.`,
    )
    lines.push(`Reason: ${state.takeoverReason || "(required)"}`)
    for (const blocker of takeover?.blockers ?? []) lines.push(`  BLOCKED — ${blocker.message}`)
    lines.push(
      state.confirmationArmed
        ? "[Back]  Confirm the takeover — Tab arms it; Enter goes Back"
        : "Back  [Confirm the takeover] — Tab selects it; Enter goes Back",
    )
  }
  if (view.notice !== null) lines.push("", `Notice: ${view.notice}`)
  if (view.pending !== null) lines.push(`Working: ${view.pending}`)
  lines.push("", `${state.screen}: ${view.availableActions.map((action) => MESH_TUI_ACTION_LABELS[action]).join("  |  ")}`)
  return lines
}

/**
 * `src/mesh/tui/` — the mesh and takeover UX, as a pure presentation layer.
 *
 * It exists because the milestone's M4.8 deliverable is not a screen: it is the
 * set of DECISIONS an operator-facing view has to be able to make and refuse, and
 * those decisions are only testable if nothing in the directory can perform a mesh
 * operation. So the whole directory is three pure modules —
 *
 *   - `./types.js`   — the vocabulary, and the four decisions stated on the members
 *                     that carry them.
 *   - `./schemas.js` — ONE parse site, composing the owners' schemas rather than
 *                     restating them.
 *   - `./state.js`   — the reducer, the twelve-cell cross product, and the one
 *                     branch that can raise an epoch.
 *   - `./view-model.js` — the view, including the five degraded conditions and the
 *                     reason each names a different remedy.
 *
 * A caller wires it to M4.3's registry, M4.4's lease, M4.5's outbox, M4.6's
 * reconciliation and M4.7's terminal gateway; this directory reads their answers
 * and hands back {@link MeshTuiIntent} VALUES. Which is why
 * `tests/unit/mesh/tui/takeover-confirmation.test.ts` can assert, exhaustively,
 * that no action but a confirmed, unblocked one ever produces a takeover.
 *
 * M4.9 consumes this as an observation point — every state and every intent is
 * inspectable without a terminal — and M4.10 audits it for the same reason the
 * lease directory is audited: a guardrail against something ABSENT is only
 * checkable against a surface a reader can enumerate.
 */

export {
  MESH_TUI_ACTION_CONTROLS,
  MESH_TUI_ACTION_TYPES,
  MESH_TUI_DEGRADED_CONDITIONS,
  MESH_TUI_LEASE_STANDINGS,
  MESH_TUI_NETWORK_STATES,
  MESH_TUI_OPERATOR_ACTIONS,
  MESH_TUI_STATES,
  MESH_TUI_TAKEOVER_BLOCKERS,
  type MeshNodeHealthSummary,
  type MeshNodeHealthView,
  type MeshRemoteSessionSnapshot,
  type MeshRemoteSessionView,
  type MeshTuiAction,
  type MeshTuiActionControl,
  type MeshTuiActionType,
  type MeshTuiDegradedCondition,
  type MeshTuiDegradedConditionView,
  type MeshTuiDegradedSubject,
  type MeshTuiIntent,
  type MeshTuiLeaseSnapshot,
  type MeshTuiLeaseStanding,
  type MeshTuiNetworkState,
  type MeshTuiOperatorAction,
  type MeshTuiOutboxRow,
  type MeshTuiOverlay,
  type MeshTuiScreen,
  type MeshTuiSnapshot,
  type MeshTuiState,
  type MeshTuiTakeoverBlocker,
  type MeshTuiTerminalSnapshot,
  type MeshTuiTransition,
  type MeshTuiUiState,
  type MeshTuiViewModel,
  type MeshTakeoverBlockerView,
  type MeshTakeoverSummary,
  type MeshUnreconciledView,
} from "./types.js"

export {
  meshTuiSnapshotSchema,
  parseMeshTuiSnapshot,
  unreadableMeshTuiSnapshot,
} from "./schemas.js"

export {
  MESH_TUI_ACTION_LABELS,
  MESH_TUI_ACTIONS_BY_STATE,
  MESH_TUI_STATE_BY_LEASE_AND_NETWORK,
  availableMeshTuiActions,
  initialMeshTuiState,
  leaseStandingOf,
  meshStateOf,
  networkStateOf,
  reduceMeshTui,
  takeoverBlockers,
} from "./state.js"

export {
  MESH_TUI_ACTION_LABELS_BY_REMEDY,
  MESH_TUI_CONDITION_ACTIONS,
  buildMeshTuiView,
  deriveDegradedConditions,
  heartbeatAgeLabel,
  nodeBadge,
} from "./view-model.js"

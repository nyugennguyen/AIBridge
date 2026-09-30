import type { ContractError, Result } from "../../../orchestration/errors.js"
import type {
  Epoch,
  NodeId,
  ProjectId,
  RunId,
  SessionId,
  TerminalClientId,
  TerminalId,
} from "../../../orchestration/identifiers.js"
import type { TerminalDimensions } from "../../../terminal/types.js"
import type { LeaseScope } from "../../lease/types.js"
import type { MeshTerminalControl, MeshTerminalControlEnvelope, MeshTerminalData, MeshTerminalDataEnvelope } from "../../protocol/terminal.js"

/**
 * M4.7 — the ports the terminal WebSocket gateway is built on.
 *
 * Four of them, and each exists because the alternative put a thing in two places:
 *
 *   - {@link TerminalSocket} — the ONE seam between the gateway and a transport.
 *     Four members, no events, no timers: the gateway pushes a frame, asks how
 *     many bytes the transport is still holding, and closes. Everything about a
 *     WebSocket that is genuinely a WebSocket — the upgrade, the frame opcodes,
 *     the TCP close handshake — lives in `./route.ts` behind this interface, and
 *     `Docs/implementation-plans/websocket-test-harness.md` §1 records why the
 *     gateway's own tests do not use one. The reason it is only four members is
 *     not minimalism: every member here is a decision the gateway must be able to
 *     make WITHOUT a socket, and a fifth would be a decision that can only be
 *     made with one.
 *   - {@link TerminalAccessPort} — the revalidation seam. Requirement 2 of the
 *     milestone is "revalidate project/session access and controller epoch when
 *     granting input ownership", and the reason this is a PORT and not a lookup
 *     the gateway does is the plan's own rule: authorization resolves against
 *     RECORDED state, and the recorded state lives in M4.3's registry, M4.4's
 *     lease and the kernel's projections — three stores, none of which this
 *     directory may read directly. A gateway that resolved authority itself
 *     would be a fourth copy of the rule, and the copy is the one that gets
 *     edited.
 *   - {@link TerminalRuntimePort} — where terminal bytes actually come from and
 *     go to. It is a PORT and not `src/terminal/types.ts`'s `TerminalBackend`
 *     because the two answer different questions: the local backend owns a
 *     process's pty, and this port has to be satisfiable by a node that holds no
 *     pty at all and reaches one over the mesh. The two-node smoke test in
 *     `tests/integration/terminal-websocket.test.ts` is the case that forces the
 *     distinction: node B's gateway serves a terminal whose bytes never pass
 *     through node B's machine.
 *   - {@link TerminalTelemetry} — the ONLY way anything leaves this directory as
 *     a structured record. It exists as a port so the leak sweep has somewhere to
 *     look: a gateway that logged directly would be unobservable, and the
 *     milestone's stop condition is "stop if terminal output can enter logs,
 *     events, or another project stream" — a guardrail with no observation point
 *     is a comment.
 */

/**
 * The window a per-client frame rate is measured over.
 *
 * A second, and named, rather than reusing `MAX_TERMINAL_FRAMES_PER_SECOND` as
 * if it were a window: §6 of the protocol spec bounds the RATE at 512 frames per
 * second per client, and a rate is meaningless without the interval it is a rate
 * over. One second is the interval the constant names, and a gateway that chose
 * a different one would be reporting a different limit under the same number.
 */
export const TERMINAL_FRAME_RATE_WINDOW_MS = 1_000

/**
 * The transport seam.
 *
 * Deliberately the four operations a gateway must be able to perform, and
 * nothing else. There is no `onMessage` here: inbound frames are pushed INTO
 * the gateway by whoever owns the transport, so the gateway never holds a
 * listener, never has to unsubscribe, and cannot leak one when a client goes
 * away without a close frame. `websocket-test-harness.md` §3 measured that a
 * graceful close on this transport never completes, which is exactly the
 * condition under which a listener registered on the socket outlives the thing it
 * was listening to.
 *
 * `close()` is ABRUPT and the interface says so. It maps to `terminate()` on the
 * server side, never to `close()`, for a reason that is about the milestone
 * rather than about tests: a revoked node, a terminated session and an expiring
 * lease all have to disconnect a peer that may be exactly the reason for the
 * disconnect. A close frame asks that peer for a handshake, and a peer that is
 * gone, wedged or hostile answers never.
 */
export interface TerminalSocket {
  /** A control frame, as a text payload. */
  sendText(payload: string): void
  /** A data frame, as bytes. */
  sendBinary(payload: Uint8Array): void
  /** Abrupt close. No handshake, no wait. */
  close(): void
  /**
   * Bytes the transport has accepted but not yet written to the wire.
   *
   * The peer-visible half of the backpressure bound. The gateway's own outbox is
   * the other half, and a gateway that counted only its outbox would report no
   * pressure on a client that had stopped reading — because the transport would
   * have taken every frame the gateway handed it and buffered them internally,
   * which is the memory exhaustion the bound exists to prevent, moved one layer
   * down.
   */
  pendingBytes(): number
}

/** A frame as the gateway hands it to a transport, before any wire encoding. */
export type TerminalEncodedFrame =
  | { readonly kind: "control"; readonly text: string; readonly byteLength: number }
  | { readonly kind: "data"; readonly bytes: Uint8Array; readonly byteLength: number }

/**
 * A frame as the gateway RECEIVES it.
 *
 * The `kind` is the WebSocket OPCODE, not an application-level discriminator, and
 * that is the whole of requirement 3's first half: a control frame arrives as
 * text and a data frame as binary, so the two are physically unable to arrive
 * through each other's door. The second half is that the JSON each opcode
 * carries is still checked against its OWN family schema — an opcode is a
 * transport fact and a client chooses it, so the record type inside is the thing
 * that is verified rather than trusted.
 */
export type TerminalInboundFrame =
  | { readonly opcode: "text"; readonly payload: string }
  | { readonly opcode: "binary"; readonly payload: Uint8Array }

/** The `(projectId, sessionId, terminalId, nodeId)` an attach is for. */
export interface TerminalBinding {
  readonly terminalId: TerminalId
  readonly projectId: ProjectId
  readonly sessionId: SessionId
  /** The node holding the runtime. Which node that is is NOT the caller's claim. */
  readonly nodeId: NodeId
  /**
   * The run this terminal belongs to.
   *
   * Resolved from RECORDED state by {@link TerminalAccessPort}, never read from
   * the attaching request. It is here because `leaseExpired` is addressed in
   * `(projectId, runId)` — that is the scope M4.4 fences on — and a gateway that
   * could not name the run would have to close ownership on every terminal in a
   * project when any one run's lease expired.
   */
  readonly runId: RunId
}

/** What the caller wants, which is what the recorded state is asked about. */
export type TerminalAccessIntent =
  /**
   * Read-only viewing.
   *
   * Distinct from `input` on the access port's own type because "may this node
   * stream this terminal" and "may this node type into it" are different
   * questions with different answers, and a port that took one boolean would
   * force a caller to answer the second whenever it meant the first.
   */
  | "view"
  | "input"

/**
 * What the gateway asks about.
 *
 * NOT {@link TerminalBinding}: `runId` is absent from the request on purpose. The
 * gateway does not know which run a terminal belongs to — the attaching client
 * does not either, and a request that carried one would be a client's CLAIM about
 * a run, which is exactly the thing the plan forbids being authorized against.
 * The run comes back on the GRANT, resolved from recorded state, and a port that
 * returned a run the caller had not asked about is a port whose answer the
 * gateway checks rather than trusts.
 */
export interface TerminalAccessRequest {
  readonly terminalId: TerminalId
  readonly projectId: ProjectId
  readonly sessionId: SessionId
  /** The node the requester CLAIMS holds the runtime. A claim, not a fact. */
  readonly claimedNodeId: NodeId
  /** The node ASKING. The authenticated node, not a header a peer chose. */
  readonly requesterNodeId: NodeId
  readonly clientId: TerminalClientId
  readonly intent: TerminalAccessIntent
  /** The controller epoch the requester claims to be acting under. */
  readonly claimedEpoch: Epoch
}

export type TerminalAccessRefusal =
  | "terminal_unknown"
  | "project_mismatch"
  | "session_mismatch"
  | "node_not_holder"
  | "node_revoked"
  | "session_terminated"
  | "lease_expired"
  | "epoch_stale"
  | "input_not_permitted"

export type TerminalAccessOutcome =
  | { readonly granted: true; readonly binding: TerminalBinding; readonly epoch: Epoch }
  | { readonly granted: false; readonly reason: TerminalAccessRefusal; readonly error: ContractError }

/**
 * The revalidation seam.
 *
 * Two calls and no state, and the call count is load-bearing: the milestone
 * requires revalidation at attach AND at ownership time, which means a gateway
 * that asked once and cached the answer would be asking once and caching. A port
 * with no `remember` method and no cache parameter is the structural form of
 * that requirement — the gateway cannot memoize a decision it has no place to
 * put.
 *
 * Production implementations resolve against M4.3's registry (is the node
 * enrolled, is it revoked), the kernel's recorded session projection (does the
 * session exist, is it terminated) and M4.4's lease (is the epoch current, has
 * it expired). The gateway checks the RESULT against the request — a grant for a
 * different project, session or terminal, or at a different epoch, is refused
 * even when the port said yes — because a port that returned a grant for
 * something the caller did not ask about is a bug, and a gateway that trusted it
 * would be a cross-project stream.
 *
 * `epoch` on the GRANT rather than on the request is the same rule as the plan's
 * "a command is authorized against the recorded log, never against its own
 * payload", applied to a terminal: the epoch ON THE FRAME is a pointer, and the
 * grant is the record.
 */
export interface TerminalAccessPort {
  authorize(request: TerminalAccessRequest): Promise<TerminalAccessOutcome>
}

// --- The runtime seam ------------------------------------------------------

/** Where a terminal's bytes come from, whoever holds the pty. */
export type TerminalOutputSink = (bytes: Uint8Array) => void

export interface TerminalOutputSubscription {
  close(): void
}

export interface TerminalInputRequest extends TerminalBinding {
  readonly clientId: TerminalClientId
  /** The caller's own per-client sequence, so a runtime can dedupe a redelivery. */
  readonly sequence: number
  readonly bytes: Uint8Array
}

export interface TerminalResizeRequest extends TerminalBinding {
  readonly clientId: TerminalClientId
  readonly dimensions: TerminalDimensions
}

export interface TerminalSnapshotRequest extends TerminalBinding {
  readonly clientId: TerminalClientId
  readonly maxBytes: number
}

/**
 * The pty seam.
 *
 * `subscribe` is a PULL-BACK-shaped push: the gateway hands the runtime a sink
 * and the runtime calls it with bytes as they appear, which is what lets a
 * terminal on ANOTHER node satisfy the same interface a local pty does. A
 * gateway that called `read()` on a timer would have to be the thing that
 * decides how often to ask, and a remote runtime behind a Tailscale link makes
 * that question unanswerable without either holding a request open (which is
 * what the integration harness does over a chunked response) or polling faster
 * than the link can answer.
 */
export interface TerminalRuntimePort {
  subscribe(binding: TerminalBinding, sink: TerminalOutputSink): Promise<Result<TerminalOutputSubscription>>
  writeInput(request: TerminalInputRequest): Promise<Result<void>>
  resize(request: TerminalResizeRequest): Promise<Result<void>>
  snapshot(request: TerminalSnapshotRequest): Promise<Result<Uint8Array>>
}

// --- Telemetry -------------------------------------------------------------

/**
 * The kinds of record this directory can produce.
 *
 * An exhaustive union rather than a free string so that adding a kind is a
 * compile error at every switch that must handle it — in particular at the leak
 * sweep, which is the test that proves none of these can carry terminal content.
 *
 * It is also EXACT: every member is emitted by `MeshTerminalGatewayImpl`, and
 * `tests/unit/mesh/gateway/terminal/no-content-leak.test.ts` asserts the two sets
 * agree. A vocabulary with unreachable members is a vocabulary a reader has to
 * reason about twice — once for what can happen and once for what is declared —
 * and the second list is the one that goes stale.
 */
export const TERMINAL_TELEMETRY_KINDS = [
  /** An attach was admitted before the upgrade and completed after it. */
  "attached",
  /** An attach was refused, before the upgrade. */
  "attach_refused",
  /** Input ownership was granted. */
  "ownership_granted",
  /** Input ownership was released by the client that held it. */
  "ownership_released",
  /** Input ownership moved, and the previous owner was notified. */
  "ownership_displaced",
  /** A control frame was refused. */
  "control_refused",
  /** A data frame was refused. */
  "data_refused",
  /** A frame was dropped to keep a slow client's buffer inside its bound. */
  "frame_dropped",
  /** The runtime refused a write, a resize, a snapshot or a subscription. */
  "runtime_refused",
  /** An attachment was closed by one of the lifecycle causes. */
  "lifecycle_closed",
] as const

export type TerminalTelemetryKind = (typeof TERMINAL_TELEMETRY_KINDS)[number]

/**
 * One structured record.
 *
 * The binding is a {@link TerminalBinding} rather than four loose id fields, and
 * that is the shape doing the work: a binding is five branded ids, so it has
 * nowhere to put a field, and this event has no member that could hold a
 * `string` of arbitrary length or a `Uint8Array`. A terminal chunk therefore
 * cannot reach a log by being passed where a field was expected.
 *
 * `detail` is authored inside this directory and is the one member a careless
 * edit could turn into a channel. It exists for the operator-facing text, and
 * `tests/unit/mesh/gateway/terminal/no-content-leak.test.ts` drives every path
 * that produces one with a recognisable marker in the terminal bytes and asserts
 * the marker appears in no record, no event and no error message. The takeover
 * `reason` is not copied into it, even though it is a string a user typed on the
 * same socket.
 *
 * `byteCount` rather than the bytes. A size is what an operator needs to
 * diagnose a slow client, and a size cannot be replayed into another stream.
 */
export interface TerminalTelemetryEvent {
  readonly kind: TerminalTelemetryKind
  readonly binding: TerminalBinding
  readonly clientId: TerminalClientId | null
  /** The refusal's `ContractError.code`, or `null` on an acceptance. */
  readonly code: string | null
  readonly byteCount: number
  readonly detail: string
}

export interface TerminalTelemetry {
  record(event: TerminalTelemetryEvent): void
}

// --- The gateway's own answers --------------------------------------------

/** Why an attach was refused. Every case has a different next action. */
export type TerminalAttachRefusal =
  | "scope_malformed"
  | "access_denied"
  | "viewer_limit"
  | "not_authenticated"
  | "already_attached"

/**
 * The result of asking whether an attach may proceed — asked BEFORE the upgrade,
 * because requirement 1 is that an unauthenticated or unauthorized client never
 * reaches the handler, and a question asked after the upgrade has already
 * answered it.
 */
export type TerminalAttachDecision =
  | {
      readonly admitted: true
      readonly clientId: TerminalClientId
      readonly binding: TerminalBinding
      /** The authenticated node, carried through so `attach` never re-reads a claim. */
      readonly requesterNodeId: NodeId
      readonly claimedEpoch: Epoch
    }
  | { readonly admitted: false; readonly reason: TerminalAttachRefusal; readonly error: ContractError }

/** An attach that has been admitted before the upgrade and then completed. */
export interface TerminalAttachment {
  readonly clientId: TerminalClientId
  readonly binding: TerminalBinding
  /** The AUTHENTICATED node, which is what `revokeNode` matches on. */
  readonly requesterNodeId: NodeId
  readonly epoch: Epoch
  /** The transport, installed at the handler. The gateway never sees a socket earlier. */
  readonly socket: TerminalSocket
}

/**
 * A refusal, in one shape for both families.
 *
 * `family` is the OPCODE the frame arrived on, not the family the gateway
 * decided it was: a data frame that arrived as text and was refused is
 * `family: "control"`, because the opcode is the fact the transport reported and
 * the mismatch is the diagnosis. `operation` is `null` when the frame was
 * refused before it parsed far enough to have one, which is the case an operator
 * needs to recognise: there is no operation to blame, so the sender is.
 */
export interface TerminalRefusalOutcome {
  readonly kind: "refused"
  readonly family: "control" | "data"
  readonly operation: MeshTerminalControl["operation"] | null
  readonly code: string
  readonly error: ContractError
}

export type TerminalControlOutcome =
  | { readonly kind: "accepted"; readonly operation: MeshTerminalControl["operation"] }
  | TerminalRefusalOutcome

export type TerminalDataOutcome =
  | { readonly kind: "accepted"; readonly sequence: number; readonly byteCount: number }
  | TerminalRefusalOutcome

/** What one runtime output write did to the viewers it was fanned out to. */
export interface TerminalFanoutResult {
  readonly terminalId: TerminalId
  readonly byteCount: number
  /** Clients the frame was written to. */
  readonly delivered: number
  /** Clients whose outbox was over its bound and lost frames to make room. */
  readonly droppedClients: number
  /** Frames lost in total, across every client. */
  readonly droppedFrames: number
}

/** The four causes that close input ownership, plus the wire's own `detach`. */
export const OWNERSHIP_CLOSE_CAUSES = ["detach", "disconnect", "revocation", "lease_expiry", "session_terminated"] as const

export type OwnershipCloseCause = (typeof OWNERSHIP_CLOSE_CAUSES)[number]

export interface OwnershipCloseResult {
  readonly cause: OwnershipCloseCause
  readonly terminalId: TerminalId
  /** The client that held input ownership, or `null` if nobody did. */
  readonly displacedClientId: TerminalClientId | null
  /** Clients whose sockets were closed, as opposed to merely demoted. */
  readonly closedClientIds: readonly TerminalClientId[]
  /**
   * Whether the clients that stayed connected are still able to VIEW.
   *
   * `false` only for revocation and session termination, and the difference is
   * the plan's own guardrail: "do not terminate agents because a controller or
   * network disappeared" means a lease expiry releases the keyboard and leaves
   * the screen, while a revoked node loses the whole connection because it is
   * no longer on the mesh.
   */
  readonly viewersRemain: boolean
}

/** A view of one terminal's state, for M4.8's TUI and for the tests. */
export interface TerminalView {
  readonly binding: TerminalBinding
  readonly viewerCount: number
  readonly inputOwnerClientId: TerminalClientId | null
  readonly droppedFrames: number
  /** Whether any client on this terminal has lost frames to backpressure. */
  readonly lossy: boolean
}

/**
 * The gateway.
 *
 * `authorizeAttach` is separate from `attach` on purpose. Authorization is asked
 * BEFORE the upgrade, where a refusal can still be an HTTP status; `attach` then
 * takes the decision and a socket, and refuses to do anything without one. A
 * single `attach(socket)` method would have to be called after the upgrade and
 * would make requirement 1 untestable, because "the handler did not run" is the
 * half of it that is only observable in the transport.
 */
export interface MeshTerminalGateway {
  /** Pre-upgrade: may this request attach, and to what? */
  authorizeAttach(request: {
    readonly terminalId: string
    readonly projectId: string
    readonly sessionId: string
    readonly clientId: string
    readonly nodeId: string
    readonly epoch: number
    /**
     * The AUTHENTICATED node, or `null` when the identity hook did not run.
     *
     * Distinct from `nodeId`, which is the client's CLAIM about which node holds
     * the runtime. Collapsing the two would be the single most consequential
     * mistake available here: `revokeNode` matches on the authenticated node, so
     * a gateway that stored the claimed one would leave a revoked node's sockets
     * open while closing a peer's that had merely named the same node.
     */
    readonly requesterNodeId: NodeId | null
  }): Promise<TerminalAttachDecision>

  /** Post-upgrade: complete an attach. Refuses without a prior decision. */
  attach(decision: TerminalAttachDecision, socket: TerminalSocket): Promise<Result<TerminalAttachment>>

  /** One inbound frame, in wire form. The single entry point. */
  receive(clientId: TerminalClientId, frame: TerminalInboundFrame): Promise<TerminalControlOutcome | TerminalDataOutcome>

  /** Runtime output for a terminal, fanned out to every attached client. */
  publish(binding: TerminalBinding, bytes: Uint8Array): TerminalFanoutResult

  /** A bounded snapshot, for a client that lost frames and wants to re-base. */
  snapshot(binding: TerminalBinding, maxBytes: number): Promise<Result<Uint8Array>>

  /** A client's socket went away. Releases ownership. */
  disconnect(clientId: TerminalClientId, detail: string): OwnershipCloseResult | null

  /** The client asked to leave. Releases ownership. */
  detach(clientId: TerminalClientId): OwnershipCloseResult | null

  /** A node was revoked. Releases ownership AND closes its sockets. */
  revokeNode(nodeId: NodeId, detail: string): readonly OwnershipCloseResult[]

  /** A controller lease expired. Releases ownership; viewers keep watching. */
  leaseExpired(scope: LeaseScope): readonly OwnershipCloseResult[]

  /** A session reached a terminal lifecycle state. Closes every attachment. */
  sessionTerminated(projectId: ProjectId, sessionId: SessionId): readonly OwnershipCloseResult[]

  view(terminalId: TerminalId): TerminalView | null
  attachedClientIds(terminalId: TerminalId): readonly TerminalClientId[]
}

export type { MeshTerminalControl, MeshTerminalControlEnvelope, MeshTerminalData, MeshTerminalDataEnvelope, LeaseScope, TerminalDimensions }

import { createContractError, type ContractError, type Result } from "../../../orchestration/errors.js"
import {
  epochSchema,
  nodeIdSchema,
  projectIdSchema,
  sessionIdSchema,
  terminalClientIdSchema,
  terminalIdSchema,
  type Epoch,
  type NodeId,
  type ProjectId,
  type SessionId,
  type TerminalClientId,
  type TerminalId,
} from "../../../orchestration/identifiers.js"
import type { LeaseScope } from "../../lease/types.js"
import { decodedBase64Bytes } from "../../protocol/identifiers.js"
import { MAX_TERMINAL_BUFFER_BYTES } from "../../protocol/bounds.js"
import {
  evaluateBufferPressure,
  evaluateFrameRate,
  evaluateFrameSize,
  evaluateViewerCount,
  framesToDrop,
  type MeshTerminalControl,
  type MeshTerminalData,
  type TerminalAdmission,
} from "../../protocol/terminal.js"
import { decodeTerminalFrame, encodeControlFrame, encodeDataFrame, encodeTerminalChunk, TERMINAL_FRAME_REPLAY_WINDOW_MS } from "./frames.js"
import { TERMINAL_FRAME_RATE_WINDOW_MS } from "./types.js"
import type {
  MeshTerminalGateway,
  OwnershipCloseCause,
  OwnershipCloseResult,
  TerminalAccessPort,
  TerminalAccessRequest,
  TerminalAttachDecision,
  TerminalAttachment,
  TerminalBinding,
  TerminalControlOutcome,
  TerminalDataOutcome,
  TerminalEncodedFrame,
  TerminalFanoutResult,
  TerminalInboundFrame,
  TerminalRefusalOutcome,
  TerminalRuntimePort,
  TerminalSocket,
  TerminalTelemetry,
  TerminalTelemetryEvent,
  TerminalView,
} from "./types.js"

/**
 * M4.7 — the terminal WebSocket gateway's session logic.
 *
 * Everything here is pure with respect to the outside world: it reads a clock
 * through an injected `now`, talks to a pty through {@link TerminalRuntimePort},
 * and writes bytes through {@link TerminalSocket}. It never opens a connection,
 * never registers a listener, never reads `Date.now` and never reads
 * `Math.random`. That is what makes the plan's "`injectWS` tests" achievable in
 * substance against this class even though `app.injectWS` does not work in this
 * repository — see `Docs/implementation-plans/websocket-test-harness.md` §1 for
 * the measurement. The transport is proven separately, over a real loopback
 * listener with the `ws` client, in `tests/integration/terminal-websocket.test.ts`.
 *
 * ### The ten requirements, and where each one lives
 *
 *   1. **Authenticate before the upgrade** — `authorizeAttach`, called by the
 *      route's `preValidation`/`preHandler` before `handleUpgrade` runs.
 *   2. **Revalidate at attach and at ownership** — the access port is asked in
 *      `authorizeAttach` and again in `#requestInput`/`#takeoverInput`, and it
 *      has no cache to be memoized into.
 *   3. **Control and data are different shapes** — `decodeTerminalFrame` in
 *      `./frames.ts`, which refuses a family that does not match the opcode.
 *   4. **Binary frames, base64, per-client monotonic sequence** — `publish` and
 *      `#receiveData`.
 *   5. **Resize on the control frame** — `#resize`.
 *   6. **Many viewers, one owner** — `AttachedTerminal.inputOwner` is a single
 *      nullable field, and `#receiveData` refuses a write from a non-owner.
 *   7. **Explicit takeover, displaced client notified** — `#takeoverInput`.
 *   8. **Bounded; a slow client loses frames** — `#enqueue`, which asks
 *      `framesToDrop` rather than growing the outbox.
 *   9. **Terminal content never leaves as a record** — every log line goes
 *      through `TerminalTelemetry`, whose members are all scalars.
 *  10. **Ownership closes on four causes** — `disconnect`, `revokeNode`,
 *      `leaseExpired`, `sessionTerminated`.
 */

/** One attached client, as the gateway holds it. */
interface AttachedClient {
  readonly clientId: TerminalClientId
  /** The node that AUTHENTICATED this socket, not the node holding the runtime. */
  readonly requesterNodeId: NodeId
  readonly binding: TerminalBinding
  /** The controller epoch this client last proved. Advanced on every grant. */
  epoch: Epoch
  readonly socket: TerminalSocket
  readonly attachedAtMs: number
  /** Whether this client currently holds input ownership. */
  owner: boolean
  /** The next sequence number this gateway will SEND on this client's stream. */
  nextOutboundSequence: number
  /** The highest sequence accepted FROM this client, for replay and ordering. */
  lastInboundSequence: number
  /** Frames waiting in the gateway's own outbox. */
  outbox: TerminalEncodedFrame[]
  outboxBytes: number
  droppedFrames: number
  /**
   * The frame-rate window, as a COUNT and a start instant.
   *
   * Not a list of timestamps. Keeping timestamps would mean keeping terminal
   * traffic in an array in order to rate-limit it, which is the memory bound
   * this whole mechanism exists to hold — so the window keeps a number and
   * `evaluateFrameRate` is handed the number, which is exactly why that function
   * takes a count.
   */
  windowStartMs: number
  framesInWindow: number
  /** Whether this client has lost frames. M4.8's TUI reads this to offer a re-base. */
  lossy: boolean
}

/** One terminal, as the gateway holds it. */
interface AttachedTerminal {
  readonly binding: TerminalBinding
  readonly clients: Map<TerminalClientId, AttachedClient>
  /**
   * THE input owner.
   *
   * A single nullable field rather than a count or a set, and that is the whole
   * of requirement 6: "exactly one input owner" is unrepresentable as two. A
   * `Set` would turn the invariant into a runtime check some future path could
   * forget, and a count would turn "one" into a number that can be two.
   */
  inputOwner: TerminalClientId | null
  subscription: { close(): void } | null
}

export interface MeshTerminalGatewayDependencies {
  readonly now: () => number
  /** This node's own id. It is what an outbound envelope's `senderNodeId` is. */
  readonly nodeId: NodeId
  readonly access: TerminalAccessPort
  readonly runtime: TerminalRuntimePort
  readonly telemetry: TerminalTelemetry
  /**
   * Overrides the replay window a control frame is held to.
   *
   * Present so a test can make a control frame stale without waiting five
   * minutes. It defaults to {@link TERMINAL_FRAME_REPLAY_WINDOW_MS} rather than
   * to `undefined`-means-default inside the check, so a production caller cannot
   * widen the window by passing `undefined` explicitly and reading the type as
   * permission.
   */
  readonly replayWindowMs?: number
}

export class MeshTerminalGatewayImpl implements MeshTerminalGateway {
  readonly #now: () => number
  readonly #nodeId: NodeId
  readonly #access: TerminalAccessPort
  readonly #runtime: TerminalRuntimePort
  readonly #telemetry: TerminalTelemetry
  readonly #replayWindowMs: number
  readonly #terminals = new Map<TerminalId, AttachedTerminal>()
  /** Client id -> terminal, so a lookup is not a scan of every terminal. */
  readonly #index = new Map<TerminalClientId, TerminalId>()
  /**
   * Per-client inbound frame chains. See {@link receive} for why the order a
   * client sent its frames in has to be the order they are decided in.
   *
   * Deleted on removal, because a chain is keyed by a client that has gone and
   * leaving it would be one entry per client this process has ever seen — which
   * is an unbounded map keyed by a value a peer chose, on the same gateway whose
   * whole purpose is bounded resources.
   */
  readonly #chains = new Map<TerminalClientId, Promise<void>>()
  /**
   * Monotonic, so two frames minted in the same millisecond still differ.
   *
   * A counter rather than a random id because `Math.random` is not available to
   * pure logic in this codebase, and because a predictable `messageId` makes a
   * duplicate a reproducible failure rather than a flake.
   */
  #frameCounter = 0

  constructor(dependencies: MeshTerminalGatewayDependencies) {
    this.#now = dependencies.now
    this.#nodeId = dependencies.nodeId
    this.#access = dependencies.access
    this.#runtime = dependencies.runtime
    this.#telemetry = dependencies.telemetry
    this.#replayWindowMs = dependencies.replayWindowMs ?? TERMINAL_FRAME_REPLAY_WINDOW_MS
  }

  /**
   * Requirement 1, and the reason this is a separate method from `attach`.
   *
   * Called by the route BEFORE Fastify hands the socket to the WebSocket handler,
   * and therefore before any byte of terminal output can exist. A refusal here is
   * an HTTP status; a refusal after the upgrade is a WebSocket close frame, which
   * a client that has already been told it is connected has to be told a second
   * time — and the second telling is the one it is most likely to ignore.
   *
   * The order inside is load-bearing, and it is the order the plan's guardrails
   * imply:
   *
   *   1. **Shape.** Every id is parsed through the kernel's own schemas. A cast
   *      here would launder an attacker-chosen string into a `ProjectId` and the
   *      access port would then be asked about a project no record has carried.
   *   2. **Identity.** `requesterNodeId === null` means the identity hook did not
   *      run, and that is a REFUSAL rather than an anonymous attach. M4.2's rule
   *      is that a node's identity is decided on the way in, inside
   *      `authenticate`, so a request arriving with no decision in scope is a
   *      route wired without the hook rather than a peer to be admitted.
   *   3. **Access.** Through the port, against recorded state. Never against the
   *      request's own claims.
   *   4. **The grant is checked against the request.** A port that returned a
   *      grant for a DIFFERENT project, session or terminal is refused even
   *      though it said yes — a cross-project stream produced by a bug in the
   *      port must not become a cross-project stream in the gateway.
   *   5. **Viewer count.** Last, because it is the only check about RESOURCE
   *      rather than about right, and a client with no right to a terminal should
   *      be told THAT rather than that it is the seventeenth viewer of a terminal
   *      it may not watch.
   */
  async authorizeAttach(request: {
    readonly terminalId: string
    readonly projectId: string
    readonly sessionId: string
    readonly clientId: string
    readonly nodeId: string
    readonly epoch: number
    readonly requesterNodeId: NodeId | null
  }): Promise<TerminalAttachDecision> {
    const terminalId = terminalIdSchema.safeParse(request.terminalId)
    if (!terminalId.success) return refuseAttach("scope_malformed", scopeError("terminalId", request.terminalId))
    const projectId = projectIdSchema.safeParse(request.projectId)
    if (!projectId.success) return refuseAttach("scope_malformed", scopeError("projectId", request.projectId))
    const sessionId = sessionIdSchema.safeParse(request.sessionId)
    if (!sessionId.success) return refuseAttach("scope_malformed", scopeError("sessionId", request.sessionId))
    const clientId = terminalClientIdSchema.safeParse(request.clientId)
    if (!clientId.success) return refuseAttach("scope_malformed", scopeError("clientId", request.clientId))
    const nodeId = nodeIdSchema.safeParse(request.nodeId)
    if (!nodeId.success) return refuseAttach("scope_malformed", scopeError("nodeId", request.nodeId))
    const epoch = epochSchema.safeParse(request.epoch)
    if (!epoch.success) return refuseAttach("scope_malformed", scopeError("epoch", String(request.epoch)))

    if (request.requesterNodeId === null) {
      return refuseAttach(
        "not_authenticated",
        createContractError(
          "validation",
          "terminal.attach_unauthenticated",
          "A terminal attach reached the gateway with no authenticated node in scope. It is refused rather than treated as anonymous: M4.2's rule is that a node's identity is decided on the way IN, inside `authenticate`, so a request arriving with no decision in scope is a route wired without the identity hook — not a peer to be admitted.",
        ),
      )
    }

    // `claimedNodeId` is a CLAIM about which node holds the runtime, and it is
    // the only thing the port is told about the holder. The port resolves it
    // against recorded state, so a client that names a node it likes gets a
    // grant for that node only if the record says that node holds the terminal.
    const asked: TerminalAccessRequest = {
      terminalId: terminalId.data,
      projectId: projectId.data,
      sessionId: sessionId.data,
      claimedNodeId: nodeId.data,
      requesterNodeId: request.requesterNodeId,
      clientId: clientId.data,
      intent: "view",
      claimedEpoch: epoch.data,
    }
    const access = await this.#access.authorize(asked)
    if (!access.granted) return refuseAttach("access_denied", access.error)
    const mismatch = bindingMismatch(access.binding, asked)
    if (mismatch !== null) return refuseAttach("access_denied", mismatch)

    // The epoch on an ATTACH is deliberately not compared with the grant's. The
    // plan requires the epoch to be revalidated when input OWNERSHIP is granted,
    // and checking it here as well would refuse a read-only viewer for a stale
    // epoch — telling someone they may not WATCH because a controller they are
    // not talking to is stale, which is an error that sends an operator to the
    // wrong system entirely.
    const binding = access.binding
    const existing = this.#terminals.get(binding.terminalId)
    const admission = evaluateViewerCount(existing === undefined ? 0 : existing.clients.size)
    if (!admission.admitted) {
      this.#record({ kind: "attach_refused", binding, clientId: clientId.data, code: admission.error.code, byteCount: 0, detail: admission.error.message })
      return refuseAttach("viewer_limit", admission.error)
    }
    // The AUTHENTICATED node, and not `nodeId.data` (the client's claim about the
    // runtime's holder). `revokeNode` matches on this one, so a gateway that
    // stored the claim would leave a revoked node streaming and close an innocent
    // peer that had merely named the same node in its query.
    return { admitted: true, clientId: clientId.data, binding, requesterNodeId: request.requesterNodeId, claimedEpoch: access.epoch }
  }

  /**
   * Requirement 1's other half: no socket without a decision.
   *
   * The decision is a REQUIRED parameter with no overload that omits it, so a
   * caller that forgot to authorize cannot compile rather than merely misbehave.
   * The viewer bound is re-checked here, because between the pre-upgrade decision
   * and the handler a second client may have attached, and the count that was
   * admissible at decision time is not the count now.
   */
  async attach(decision: TerminalAttachDecision, socket: TerminalSocket): Promise<Result<TerminalAttachment>> {
    if (!decision.admitted) {
      return {
        ok: false,
        error: createContractError(
          "validation",
          "terminal.attach_without_decision",
          "A terminal attach reached the handler carrying a refusal. The gateway does not re-derive the decision: an unauthenticated client must never reach a handler at all, and a handler that ran anyway has already lost the property the pre-upgrade check existed to give.",
        ),
      }
    }
    const terminal = this.#terminalFor(decision.binding)
    // A second client presenting a DIFFERENT binding for an already-attached
    // terminal is refused rather than quietly downgraded onto the first client's
    // binding.
    //
    // Both behaviours keep the terminal in one project — the alternative is a
    // client that moves it — but "downgrade onto the first binding" is the worse
    // of the two, because the port granted the client project B and the gateway
    // would have given it project A's bytes. That is a cross-project stream
    // produced by an ordering accident, and the plan's stop condition is that
    // terminal output never reaches one. Refusing sends the disagreement back to
    // the port that produced it, which is where it can be diagnosed.
    const moved = bindingMismatch(decision.binding, terminal.binding)
    if (moved !== null) return { ok: false, error: moved }
    if (terminal.clients.has(decision.clientId)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "terminal.client_already_attached",
          `Client '${decision.clientId}' is already attached to terminal '${decision.binding.terminalId}'. A second socket for one client id would give that client two independent sequence streams, and the protocol's 'sequence' is per CLIENT precisely so a viewer can detect a gap — with two streams every gap becomes undetectable.`,
        ),
      }
    }
    const admission = evaluateViewerCount(terminal.clients.size)
    if (!admission.admitted) {
      this.#record({ kind: "attach_refused", binding: decision.binding, clientId: decision.clientId, code: admission.error.code, byteCount: 0, detail: admission.error.message })
      return { ok: false, error: admission.error }
    }
    const now = this.#now()
    const client: AttachedClient = {
      clientId: decision.clientId,
      requesterNodeId: decision.requesterNodeId,
      binding: decision.binding,
      epoch: decision.claimedEpoch,
      socket,
      attachedAtMs: now,
      owner: false,
      nextOutboundSequence: 1,
      lastInboundSequence: 0,
      outbox: [],
      outboxBytes: 0,
      droppedFrames: 0,
      windowStartMs: now,
      framesInWindow: 0,
      lossy: false,
    }
    terminal.clients.set(decision.clientId, client)
    this.#index.set(decision.clientId, decision.binding.terminalId)
    await this.#ensureSubscription(terminal)
    this.#record({ kind: "attached", binding: decision.binding, clientId: decision.clientId, code: null, byteCount: 0, detail: `Attached; ${admission.detail}` })
    return {
      ok: true,
      value: {
        clientId: decision.clientId,
        binding: decision.binding,
        requesterNodeId: decision.requesterNodeId,
        epoch: decision.claimedEpoch,
        socket,
      },
    }
  }

  /**
   * The single inbound entry point.
   *
   * ONE method for both families, and the dispatch is on the DECODED family
   * rather than on a caller-supplied tag. A caller that passed "this is a control
   * frame" could pass the tag for a data frame, and the whole of requirement 3 is
   * that the reader does not get to choose.
   *
   * The frame-rate bound is charged BEFORE the decode. A client already over its
   * rate should not be able to make the gateway allocate a parsed object per
   * frame in order to discover that it is over.
   *
   * ### SERIALIZED PER CLIENT, and the two races that is the fix for
   *
   * Every frame from one client is processed on that client's own promise chain,
   * so a client observes ITS OWN frames in the order it sent them. M4.10 found
   * both halves of what was wrong with that, and they are separate defects:
   *
   *   1. **Within one client, order was not preserved.** A `request_input`
   *      immediately followed by a `resize` — two `socket.send` calls back to
   *      back, which is exactly what a real TUI does when a user hits a key and
   *      drags the window edge — was processed CONCURRENTLY, so the `resize`
   *      reached `#resize` before the ownership grant landed and was refused with
   *      `terminal.not_input_owner`. M4.10 reproduced it 6/6 under `vitest`:
   *      `expected [] to deeply equal [ { rows: 50, columns: 132 } ]`. Under
   *      `bun test` the interleaving happened not to occur, which is precisely
   *      why a defect this shape survives a test suite that runs on one runtime.
   *
   *   2. **Across two clients, ownership was not exclusive.** `#requestInput`
   *      reads `terminal.inputOwner`, finds it `null`, and then `await`s the
   *      access port before writing the grant. Two clients doing that
   *      concurrently both read `null`, both awaited, and both wrote — so
   *      `inputOwner` ended up naming one of them while BOTH held
   *      `client.owner === true`, and BOTH could type into the pty. M4.10
   *      demonstrated it: `A: accepted B: accepted` and then
   *      `DATA A: accepted DATA B: accepted`. That is the plan's
   *      "allow multiple viewers but one input owner" violated under concurrency,
   *      and it is fixed below rather than only serialized, because serialization
   *      is per CLIENT and this race is ACROSS clients.
   *
   * The chain resolves with THIS call's own outcome and the tail carries only
   * the ordering, so a caller awaiting its own frame never learns another
   * frame's result. A rejection is swallowed into the tail for the same reason
   * as in `MeshCommandInbox`: one failed frame must not poison the stream for
   * every later one, and the failure is still delivered to this caller.
   */
  receive(clientId: TerminalClientId, frame: TerminalInboundFrame): Promise<TerminalControlOutcome | TerminalDataOutcome> {
    const previous = this.#chains.get(clientId) ?? Promise.resolve()
    const run = previous.then(
      () => this.#process(clientId, frame),
      () => this.#process(clientId, frame),
    )
    this.#chains.set(clientId, run.then(
      () => undefined,
      () => undefined,
    ))
    return run
  }

  async #process(clientId: TerminalClientId, frame: TerminalInboundFrame): Promise<TerminalControlOutcome | TerminalDataOutcome> {
    const family: "control" | "data" = frame.opcode === "text" ? "control" : "data"
    const client = this.#find(clientId)
    if (client === null) {
      // No attachment means no binding to check a frame against, and therefore no
      // `detail` that is safe to record — so the refusal is returned WITHOUT a
      // telemetry record. That is the only refusal in this class that is silent,
      // and it is silent for the reason the stop condition demands: a frame from
      // an unknown client has no binding, and inventing one to fill in a log
      // line is how a log line starts describing terminal content.
      const error = clientNotAttached(clientId)
      return { kind: "refused", family, operation: null, code: error.code, error }
    }
    const rate = this.#chargeFrameRate(client)
    if (!rate.admitted) {
      return this.#refuse(client, null, family, rate.error.code, rate.error)
    }
    const decoded = decodeTerminalFrame(frame)
    if (!decoded.ok) {
      return this.#refuse(client, null, family, decoded.error.code, decoded.error)
    }
    if (decoded.value.family === "control") {
      return await this.#receiveControl(client, decoded.value.payload, decoded.value.envelope.issuedAt, decoded.value.envelope.expiresAt)
    }
    return await this.#receiveData(client, decoded.value.payload)
  }

  // --- Control ------------------------------------------------------------

  async #receiveControl(client: AttachedClient, payload: MeshTerminalControl, issuedAt: string, expiresAt: string): Promise<TerminalControlOutcome> {
    // Binding first, for EVERY operation, and before the operation is looked at.
    // A control frame naming a terminal, project, session, client or node other
    // than the ones this connection is attached with is refused on the binding
    // alone: otherwise a `request_input` that named another terminal would grant
    // the keyboard of a terminal the client is not attached to, and two clients
    // on one mesh could address each other's terminals by id alone.
    const mismatch = this.#bindingMismatch(client, payload)
    if (mismatch !== null) return this.#refuse(client, payload.operation, "control", mismatch.code, mismatch)

    // The replay window, and only for control. See the note on
    // `TERMINAL_FRAME_REPLAY_WINDOW_MS`: a control frame is an INSTRUCTION, so
    // replaying one acts twice. Data frames are not windowed, because a dropped
    // data frame is a hole the client recovers from by re-basing on a snapshot
    // rather than a hole in an instruction stream.
    if (Date.parse(expiresAt) <= this.#now() || Date.parse(issuedAt) - this.#replayWindowMs > this.#now()) {
      return this.#refuse(
        client,
        payload.operation,
        "control",
        "protocol.record_expired",
        createContractError(
          "validation",
          "protocol.record_expired",
          `A control frame for client '${payload.clientId}' is outside its replay window (issued ${issuedAt}, expires ${expiresAt}, read at ${new Date(this.#now()).toISOString()}). A control frame is an INSTRUCTION, so replaying one acts twice; the window exists so a captured instruction cannot be resurrected.`,
        ),
      )
    }

    switch (payload.operation) {
      case "attach":
        return { kind: "accepted", operation: "attach" }
      case "detach":
        this.detach(client.clientId)
        return { kind: "accepted", operation: "detach" }
      case "resize":
        return await this.#resize(client, payload)
      case "request_input":
        return await this.#requestInput(client, payload)
      case "release_input":
        return this.#releaseInput(client, payload, "release_input")
      case "takeover_input":
        return await this.#takeoverInput(client, payload)
    }
  }

  async #resize(client: AttachedClient, payload: MeshTerminalControl): Promise<TerminalControlOutcome> {
    // Unreachable through `receive` — the family schema already refuses a
    // half-resize — and present because `#resize` is the only place a payload
    // becomes a `TerminalDimensions`. A pty size built from two optionals checked
    // in a different module is a `NaN`-shaped `TIOCSWINSZ` waiting to happen.
    if (payload.rows === undefined || payload.cols === undefined) {
      return this.#refuse(
        client,
        "resize",
        "control",
        "terminal.resize_incomplete",
        createContractError(
          "validation",
          "terminal.resize_incomplete",
          "A resize must carry both rows and cols. A half-resize is a corrupt pty size, and the runtime would be asked to honour one.",
        ),
      )
    }
    // A resize is an ACT ON the pty, so it requires input ownership for the same
    // reason a data frame does. A read-only viewer that could resize would be
    // re-shaping the terminal it is watching, which is the same capability as
    // typing as far as the operator is concerned and a different one as far as
    // the plan is concerned.
    if (!client.owner) {
      return this.#refuse(
        client,
        "resize",
        "control",
        "terminal.not_input_owner",
        createContractError(
          "policy_denied",
          "terminal.not_input_owner",
          `Client '${client.clientId}' asked to resize terminal '${client.binding.terminalId}' and does not hold input ownership. A resize is a 'TIOCSWINSZ' on the runtime's pty — an act on the terminal, not a view of it — so it rides with input ownership rather than with attachment.`,
        ),
      )
    }
    const written = await this.#runtime.resize({ ...client.binding, clientId: client.clientId, dimensions: { rows: payload.rows, columns: payload.cols } })
    if (!written.ok) {
      this.#record({ kind: "runtime_refused", binding: client.binding, clientId: client.clientId, code: written.error.code, byteCount: 0, detail: written.error.message })
      return this.#refuse(client, "resize", "control", written.error.code, written.error)
    }
    return { kind: "accepted", operation: "resize" }
  }

  /**
   * Requirement 2's second half.
   *
   * The access port is asked AGAIN, with `intent: "input"`, and its granted epoch
   * is compared with the epoch ON THE FRAME. Both halves are load-bearing:
   *
   *   - **The frame's epoch is a claim; the grant is the record.** This is the
   *     plan's "a payload is a claim, not a grant" rule applied to a terminal.
   *   - **The re-ask is what makes requirement 2 mean anything.** An attach is
   *     authorized at time T. A lease can expire, a session can terminate and a
   *     node can be revoked between T and the keystroke, and a gateway that
   *     cached the attach decision would hand the keyboard to a client whose
   *     right to it had lapsed. The port has no cache and no `remember`, so there
   *     is nowhere to put the answer.
   */
  async #requestInput(client: AttachedClient, payload: MeshTerminalControl): Promise<TerminalControlOutcome> {
    const terminal = this.#terminals.get(client.binding.terminalId)
    if (terminal === undefined) return this.#refuse(client, "request_input", "control", "terminal.client_not_attached", clientNotAttached(client.clientId))

    // Already the owner: idempotent. A client that re-sent its request after a
    // lost reply must not be told it lost a keyboard it already holds.
    if (terminal.inputOwner === client.clientId) return { kind: "accepted", operation: "request_input" }

    // Somebody else holds it, and a `request_input` is NOT a takeover. The plan
    // requires an explicit takeover; honouring a bare request by displacing the
    // owner would make the explicit operation optional, which is the same defect
    // as an automatic election wearing a smaller hat.
    if (terminal.inputOwner !== null) {
      return this.#refuseInputHeld(client, "request_input", terminal.inputOwner)
    }

    const access = await this.#authorize(client, payload.epoch)
    if (!access.ok) return this.#refuse(client, "request_input", "control", access.error.code, access.error)
    if (access.value !== payload.epoch) {
      return this.#refuse(
        client,
        "request_input",
        "control",
        "terminal.epoch_stale",
        createContractError(
          "stale_epoch",
          "terminal.epoch_stale",
          `Client '${client.clientId}' requested input at epoch ${payload.epoch} but the recorded grant is at epoch ${access.value}. The recorded epoch is the grant; the frame's epoch is a pointer to it. A superseded controller reaching the keyboard is what the plan's "do not accept a higher controller epoch without the explicit takeover flow" guardrail exists to prevent, and this is the same shape with the sign flipped.`,
        ),
      )
    }

    // THE COMPARE-AND-SET, and it is the second half of the exclusivity defence.
    //
    // The `inputOwner === null` check above and this write are separated by an
    // `await` on the access port, which is a real await against a real store. Two
    // clients whose `request_input` frames are in flight together therefore both
    // read `null`, both awaited, and both arrived here — and the second write
    // silently displaced the first, leaving `inputOwner` naming one of them while
    // BOTH held `client.owner === true`. M4.10 demonstrated exactly that: two
    // accepted grants, then two accepted data frames, so two clients typed into one
    // pty. The plan's rule is "allow multiple viewers but ONE input owner", and a
    // field that is checked and then written across an await is not a lock.
    //
    // So the grant is RE-READ and the loser is refused. This is the same discipline
    // the lease store's `expectedEpoch` performs, on the same principle: a
    // decision made against a fact that has since moved has to be re-decided, and
    // the direction to fail is the one that does not grant a second keyboard.
    //
    // A client that already holds it is NOT displaced here — that is the idempotent
    // retry at the top of this method, and re-asserting it after the await would
    // make a lost reply look like a lost keyboard.
    if (terminal.inputOwner !== null && terminal.inputOwner !== client.clientId) {
      return this.#refuseInputHeld(client, "request_input", terminal.inputOwner)
    }

    terminal.inputOwner = client.clientId
    client.owner = true
    client.epoch = access.value
    this.#record({ kind: "ownership_granted", binding: client.binding, clientId: client.clientId, code: null, byteCount: 0, detail: `Input granted at epoch ${access.value}` })
    return { kind: "accepted", operation: "request_input" }
  }

  /**
   * "Somebody else holds the keyboard", as one refusal.
   *
   * Shared by the pre-await check and the post-await compare-and-set, because the
   * two are the same fact observed at two instants and a reader that saw two
   * different messages for them would be reading two different rules. The
   * post-await caller is a client that was told the terminal was free a moment ago
   * and is now being told it is not, and the message says the holder's id so an
   * operator can see WHO — which is also what tells the loser that a `request_input`
   * is not a takeover and a `takeover_input` is.
   */
  #refuseInputHeld(
    client: AttachedClient,
    operation: "request_input" | "takeover_input",
    holder: TerminalClientId,
  ): TerminalControlOutcome {
    return this.#refuse(
      client,
      operation,
      "control",
      "terminal.input_owned",
      createContractError(
        "policy_denied",
        "terminal.input_owned",
        `Client '${client.clientId}' asked for input on terminal '${client.binding.terminalId}' and client '${holder}' holds it. A 'request_input' is NOT a takeover: the milestone requires an explicit 'takeover_input', because a client that could displace the owner by asking would make the owner's position revocable at will. The displaced client is notified when a takeover is actually granted.`,
      ),
    )
  }

  #releaseInput(client: AttachedClient, payload: MeshTerminalControl, cause: string): TerminalControlOutcome {
    const terminal = this.#terminals.get(client.binding.terminalId)
    if (terminal === undefined) return this.#refuse(client, payload.operation, "control", "terminal.client_not_attached", clientNotAttached(client.clientId))
    if (terminal.inputOwner !== client.clientId) {
      return this.#refuse(
        client,
        payload.operation,
        "control",
        "terminal.not_input_owner",
        createContractError(
          "policy_denied",
          "terminal.not_input_owner",
          `Client '${client.clientId}' tried to release input on terminal '${client.binding.terminalId}' and does not hold it${
            terminal.inputOwner === null ? " — nobody does" : `; '${terminal.inputOwner}' does`
          }. A release from a non-owner is refused rather than treated as a no-op, because a client whose release silently succeeded would believe it had given up a keyboard it never had.`,
        ),
      )
    }
    terminal.inputOwner = null
    client.owner = false
    this.#record({ kind: "ownership_released", binding: client.binding, clientId: client.clientId, code: null, byteCount: 0, detail: `Input released by '${cause}'` })
    return { kind: "accepted", operation: payload.operation }
  }

  /**
   * Requirement 7: an EXPLICIT operation, and the displaced client is told.
   *
   * The notification is not optional and it carries the takeover's `reason`,
   * which is why the family requires one. A takeover that displaced an owner
   * silently would leave that owner typing into a terminal that had stopped
   * echoing it, and the first symptom an operator would see is a TUI that
   * appears frozen — with nothing to indicate the reason was somebody else
   * holding the keyboard.
   *
   * The notification is a `takeover_input` frame rather than a `release_input`
   * one, and that is forced by the protocol rather than chosen: the schema
   * permits `reason` on `takeover_input` and on nothing else, and the displaced
   * client is the one person on the mesh who can act on the reason. The frame
   * names the NEW owner's `clientId`, so "a takeover happened, here is who and
   * here is why" is exactly what the displaced client receives — and the frame it
   * would receive for its own sake is a frame it can recognise by comparing
   * `clientId` with its own.
   */
  async #takeoverInput(client: AttachedClient, payload: MeshTerminalControl): Promise<TerminalControlOutcome> {
    const terminal = this.#terminals.get(client.binding.terminalId)
    if (terminal === undefined) return this.#refuse(client, "takeover_input", "control", "terminal.client_not_attached", clientNotAttached(client.clientId))
    if (terminal.inputOwner === client.clientId) {
      return this.#refuse(
        client,
        "takeover_input",
        "control",
        "terminal.already_input_owner",
        createContractError(
          "conflict",
          "terminal.already_input_owner",
          `Client '${client.clientId}' asked to take over input on terminal '${client.binding.terminalId}' and already holds it. A self-takeover is refused rather than silently accepted: the notification it would send is the notification that tells the CURRENT owner it was displaced, and sending that to the client that just displaced itself is how a client learns to ignore displacement notices.`,
        ),
      )
    }
    const access = await this.#authorize(client, payload.epoch)
    if (!access.ok) return this.#refuse(client, "takeover_input", "control", access.error.code, access.error)
    if (access.value !== payload.epoch) {
      return this.#refuse(
        client,
        "takeover_input",
        "control",
        "terminal.epoch_stale",
        createContractError(
          "stale_epoch",
          "terminal.epoch_stale",
          `Client '${client.clientId}' asked to take over input at epoch ${payload.epoch} but the recorded grant is at epoch ${access.value}. The recorded epoch is the grant; the frame's epoch is a pointer to it.`,
        ),
      )
    }

    const displacedId = terminal.inputOwner
    // A takeover is an explicit displacement, so unlike `request_input` it does
    // not need the exclusivity check — displacing a named holder is the operation.
    // It does need the read to be AFTER the access port's await, which it is: the
    // `displacedId` below is the holder as of now, and the notification names the
    // client that actually loses the keyboard rather than the one that held it when
    // the frame was written.
    terminal.inputOwner = client.clientId
    client.owner = true
    client.epoch = access.value
    // The takeover's REASON is a client-supplied string and is NOT copied into
    // the log record. `detail` is the one member of a telemetry event a careless
    // edit could turn into a channel for terminal content, and a reason typed by
    // a user at a keyboard is user input on the same socket. It reaches the
    // displaced client on the wire, which is the only place it is needed.
    this.#record({
      kind: "ownership_displaced",
      binding: client.binding,
      clientId: client.clientId,
      code: null,
      byteCount: 0,
      detail: `Input taken from ${displacedId === null ? "nobody" : "another client"} at epoch ${access.value}`,
    })
    if (displacedId !== null) {
      const displaced = terminal.clients.get(displacedId)
      if (displaced !== undefined) {
        displaced.owner = false
        this.#sendControl(displaced, {
          terminalId: client.binding.terminalId,
          projectId: client.binding.projectId,
          sessionId: client.binding.sessionId,
          nodeId: client.binding.nodeId,
          clientId: client.clientId,
          operation: "takeover_input",
          reason: payload.reason ?? "another client took over input",
          epoch: access.value,
        })
      }
    }
    return { kind: "accepted", operation: "takeover_input" }
  }

  // --- Data ---------------------------------------------------------------

  async #receiveData(client: AttachedClient, payload: MeshTerminalData): Promise<TerminalDataOutcome> {
    if (payload.direction !== "to_runtime") {
      // A `to_viewer` frame is the GATEWAY's own direction. Accepting one from a
      // client would let a client inject terminal output into another viewer's
      // stream, which is the "another project stream" half of the stop condition
      // in its most direct form: two clients on one terminal, one of them able
      // to write what the other sees.
      return this.#refuse(
        client,
        null,
        "data",
        "terminal.data_direction_refused",
        createContractError(
          "policy_denied",
          "terminal.data_direction_refused",
          `Client '${client.clientId}' sent a '${payload.direction}' data frame. Only 'to_runtime' is accepted from a client: a 'to_viewer' frame is the gateway's own direction, and a client able to emit one could write terminal content into another viewer's stream.`,
        ),
      )
    }
    if (payload.terminalId !== client.binding.terminalId || payload.clientId !== client.clientId) {
      return this.#refuse(
        client,
        null,
        "data",
        "terminal.data_binding_mismatch",
        createContractError(
          "policy_denied",
          "terminal.data_binding_mismatch",
          `A data frame from client '${client.clientId}' named terminal '${payload.terminalId}'. Data frames are bound to the client that sent them and to the terminal it is attached to; a frame naming another is refused rather than forwarded, because forwarding it would type one client's bytes into another client's terminal.`,
        ),
      )
    }
    // Sequence BEFORE size, and the reason is the same one the protocol's family
    // schema gives for checking size on the string: decide without allocating.
    // The ordering matters for a second reason too — a redelivery is the EXPECTED
    // shape of a reconnecting client, so a client that re-sent a large frame under
    // a used sequence would be refused for its size when the honest answer is "you
    // already sent that".
    if (payload.sequence <= client.lastInboundSequence) {
      return this.#refuse(
        client,
        null,
        "data",
        "terminal.sequence_not_monotonic",
        createContractError(
          "conflict",
          "terminal.sequence_not_monotonic",
          `Client '${client.clientId}' sent data frame sequence ${payload.sequence} behind the highest accepted (${client.lastInboundSequence}). Sequence is per client and monotonic, so a repeat or a regression is a redelivery or a reordering; it is refused rather than applied, because applying it would put the terminal's input stream backwards.`,
        ),
      )
    }
    const decodedBytes = decodedBase64Bytes(payload.chunk)
    const size = evaluateFrameSize(decodedBytes)
    if (!size.admitted) return this.#refuse(client, null, "data", size.error.code, size.error)
    // Only the OWNER may type. Without this, "one input owner" would be a label
    // on a field nothing consults and every attached viewer could write the pty.
    if (!client.owner) {
      return this.#refuse(
        client,
        null,
        "data",
        "terminal.not_input_owner",
        createContractError(
          "policy_denied",
          "terminal.not_input_owner",
          `Client '${client.clientId}' sent terminal input and does not hold input ownership. Viewing and typing are separate rights on one stream, and a gateway that let every viewer type would make the "one input owner" rule a decoration.`,
        ),
      )
    }
    const written = await this.#runtime.writeInput({ ...client.binding, clientId: client.clientId, sequence: payload.sequence, bytes: decodeChunk(payload.chunk) })
    if (!written.ok) {
      this.#record({ kind: "runtime_refused", binding: client.binding, clientId: client.clientId, code: written.error.code, byteCount: 0, detail: written.error.message })
      return this.#refuse(client, null, "data", written.error.code, written.error)
    }
    client.lastInboundSequence = payload.sequence
    return { kind: "accepted", sequence: payload.sequence, byteCount: decodedBytes }
  }

  // --- Fan-out ------------------------------------------------------------

  /**
   * Runtime output, fanned out to every attached client.
   *
   * The bound is applied PER CLIENT, not per terminal: sixteen viewers of which
   * one is slow is one slow client, and a terminal-wide bound would let that one
   * client cost frames to the other fifteen.
   *
   * Each client gets its OWN sequence number for the same bytes. That is what
   * §4.9 means by "per client, monotonic", and it is what makes a drop
   * DETECTABLE: a client that receives 4, 5, 9 knows it lost 6 to 8 and re-bases
   * on a snapshot, whereas a shared counter would make one slow viewer's loss
   * appear as a gap in a different viewer's stream — which is a gap nobody
   * reconnects for.
   */
  publish(binding: TerminalBinding, bytes: Uint8Array): TerminalFanoutResult {
    const byteCount = bytes.byteLength
    const terminal = this.#terminals.get(binding.terminalId)
    if (terminal === undefined) return { terminalId: binding.terminalId, byteCount, delivered: 0, droppedClients: 0, droppedFrames: 0 }
    // The size bound applies to what the gateway is about to SEND as well as to
    // what it accepts. A runtime producing a 4 MB write would otherwise be split
    // only by the transport's own limits, and those differ between a loopback
    // test and a Tailscale link — a bound enforced only inbound is a bound that
    // moves with the network.
    const admission = evaluateFrameSize(byteCount)
    if (!admission.admitted) {
      this.#record({ kind: "frame_dropped", binding, clientId: null, code: admission.error.code, byteCount, detail: admission.error.message })
      return { terminalId: binding.terminalId, byteCount, delivered: 0, droppedClients: 0, droppedFrames: 0 }
    }

    const chunk = encodeTerminalChunk(bytes)
    let delivered = 0
    let droppedClients = 0
    let droppedFrames = 0
    for (const client of terminal.clients.values()) {
      const outcome = this.#enqueue(client, this.#dataFrameFor(client, chunk))
      delivered += 1
      if (outcome.dropped > 0) {
        droppedClients += 1
        droppedFrames += outcome.dropped
      }
    }
    return { terminalId: binding.terminalId, byteCount, delivered, droppedClients, droppedFrames }
  }

  #dataFrameFor(client: AttachedClient, chunk: string): TerminalEncodedFrame {
    const payload: MeshTerminalData = {
      terminalId: client.binding.terminalId,
      clientId: client.clientId,
      direction: "to_viewer",
      encoding: "base64",
      chunk,
      sequence: client.nextOutboundSequence,
    }
    client.nextOutboundSequence += 1
    // `recipientNodeId` is null: a data frame is addressed to whoever is on the
    // other end of THAT socket, and the gateway — not the envelope — is what
    // knows that. See the note on `TerminalFrameOrigin`.
    return encodeDataFrame(payload, this.#origin(null))
  }

  /**
   * Puts a frame on a client's outbox, dropping from the FRONT if the bound is
   * exceeded.
   *
   * This is requirement 8's whole mechanism. Three facts make it work:
   *
   *   - **The bound counts the transport's bytes too.** A gateway that counted
   *     only its own outbox would report no pressure on a client that had stopped
   *     reading, because the transport had taken every frame the gateway handed it
   *     and was buffering them internally. That is the same memory exhaustion one
   *     layer down, and it is invisible to the gateway.
   *   - **`framesToDrop` decides, and the decision is to DROP.** The alternative
   *     — growing the outbox until the runtime is the thing that runs out of
   *     memory — turns a resource bound into a denial of service against every
   *     OTHER terminal on the node.
   *   - **The front, not the back.** The tail is what the user is looking at; a
   *     client that reconnects from a snapshot is better served by losing history
   *     it will re-fetch than by losing the last prompt it sent.
   */
  #enqueue(client: AttachedClient, frame: TerminalEncodedFrame): { dropped: number } {
    const pendingBytes = client.outboxBytes + client.socket.pendingBytes()
    const pressure = evaluateBufferPressure(pendingBytes)
    if (pressure.admitted) {
      client.outbox.push(frame)
      client.outboxBytes += frame.byteLength
      this.#flush(client)
      return { dropped: 0 }
    }
    const oldestBytes = client.outbox.length === 0 ? 0 : client.outbox[0]!.byteLength
    const toDrop = framesToDrop(pendingBytes, oldestBytes)
    let dropped = 0
    for (let index = 0; index < toDrop && client.outbox.length > 0; index += 1) {
      const removed = client.outbox.shift()
      if (removed === undefined) break
      client.outboxBytes -= removed.byteLength
      dropped += 1
    }
    client.droppedFrames += dropped
    client.lossy = client.lossy || dropped > 0
    // The frame still goes in, even when the outbox is now empty. The bound is on
    // BUFFERED bytes, and the frame the client is waiting for is the one whose
    // loss would be least recoverable; when the outbox is empty the pressure is
    // the transport's, and there is nothing left to drop but this.
    client.outbox.push(frame)
    client.outboxBytes += frame.byteLength
    this.#flush(client)
    this.#record({
      kind: "frame_dropped",
      binding: client.binding,
      clientId: client.clientId,
      code: pressure.error.code,
      byteCount: frame.byteLength,
      // The two NUMBERS an operator needs to diagnose a slow client, and neither
      // of them is content: what the client is holding, and the bound it is over.
      detail: `${dropped} frame(s) dropped from the front of a slow client's outbox; it was holding ${pendingBytes} bytes against the ${MAX_TERMINAL_BUFFER_BYTES} byte bound, so it loses frames and re-bases from a snapshot rather than this node growing its buffer`,
    })
    return { dropped }
  }

  /**
   * Writes as much of the outbox as the bound allows, and nothing beyond it.
   *
   * The check is the same {@link evaluateBufferPressure} the enqueue used, so
   * "under the bound" is one evaluation with one answer rather than two places
   * that each hold an idea of what the bound is.
   */
  #flush(client: AttachedClient): void {
    while (client.outbox.length > 0) {
      if (!evaluateBufferPressure(client.outboxBytes + client.socket.pendingBytes()).admitted) return
      const head = client.outbox.shift()
      if (head === undefined) return
      client.outboxBytes -= head.byteLength
      if (head.kind === "control") client.socket.sendText(head.text)
      else client.socket.sendBinary(head.bytes)
    }
  }

  /**
   * A control frame to exactly one client, bypassing the outbox.
   *
   * Bypassing is correct and not merely convenient: the frames sent this way are
   * the DISPLACEMENT NOTICE and the LEASE-EXPIRY RELEASE, and each of them is the
   * last thing a client needs to hear before its stream becomes misleading.
   * Queueing them behind terminal output would let the output they are correcting
   * arrive first. (Revocation and session termination send nothing at all — they
   * terminate the socket, which is the only answer a peer that may be the reason
   * for the disconnect can be given.)
   */
  #sendControl(client: AttachedClient, payload: MeshTerminalControl): void {
    const frame = encodeControlFrame(payload, this.#origin(payload.nodeId))
    if (frame.kind === "control") client.socket.sendText(frame.text)
  }

  // --- Lifecycle (requirement 10) ----------------------------------------

  /**
   * Cause 1 — the socket went away.
   *
   * The client is REMOVED and its ownership released. The socket is not closed:
   * there is nothing left to close. This is the path
   * `websocket-test-harness.md` §3 says must be driven by the socket's own
   * `close`/`error` events rather than by an assumption that the peer closes
   * politely, because a graceful close on that transport is measured never to
   * complete.
   */
  disconnect(clientId: TerminalClientId, detail: string): OwnershipCloseResult | null {
    return this.#removeClient(clientId, "disconnect", detail, false)
  }

  /** The client asked to leave. Deliberate, and the same effect as a drop. */
  detach(clientId: TerminalClientId): OwnershipCloseResult | null {
    return this.#removeClient(clientId, "detach", "the client detached", false)
  }

  /**
   * Cause 2 — a node was revoked. Sockets CLOSE, not merely demote.
   *
   * The plan's completion criterion is "a revoked node cannot reconnect or stream
   * a terminal", and a revoked node that kept a read-only stream would still be
   * streaming one. M4.2's rule settles where the DECISION belongs — revocation
   * is inside `authenticate`, and a later task must not add a post-authentication
   * check — so this method is not the check. It is the consequence: an
   * already-attached socket makes no further `authenticate` call, and this is the
   * only thing that closes it.
   */
  revokeNode(nodeId: NodeId, detail: string): readonly OwnershipCloseResult[] {
    const results: OwnershipCloseResult[] = []
    for (const terminal of this.#terminals.values()) {
      for (const client of [...terminal.clients.values()]) {
        if (client.requesterNodeId !== nodeId) continue
        const result = this.#removeClient(client.clientId, "revocation", detail, true)
        if (result !== null) results.push(result)
      }
    }
    return results
  }

  /**
   * Cause 3 — the controller lease expired. Ownership is released; the CLIENTS
   * STAY.
   *
   * This is the plan's guardrail — "lease expiry pauses new orchestration but
   * preserves existing processes" and "do not terminate agents because a
   * controller or network disappeared" — read for terminals. A lease that expired
   * thirty seconds ago says nobody is driving the run; it says nothing about
   * whether the user is still watching. Closing the socket would be the gateway
   * deciding, on its own authority, that a controller's silence is a user's
   * departure.
   */
  leaseExpired(scope: LeaseScope): readonly OwnershipCloseResult[] {
    const results: OwnershipCloseResult[] = []
    for (const terminal of [...this.#terminals.values()]) {
      if (terminal.binding.projectId !== scope.projectId || terminal.binding.runId !== scope.runId) continue
      const ownerId = terminal.inputOwner
      if (ownerId !== null) this.#releaseTo(terminal, ownerId, "the controller lease for this run expired")
      results.push({
        cause: "lease_expiry",
        terminalId: terminal.binding.terminalId,
        displacedClientId: ownerId,
        closedClientIds: [],
        viewersRemain: true,
      })
    }
    return results
  }

  /**
   * Cause 4 — the session terminated. Sockets CLOSE.
   *
   * A terminated session's pty is finished, and a viewer left attached to a
   * terminal whose session is over holds a frame-rate budget and an outbox for a
   * stream that can never produce anything again.
   */
  sessionTerminated(projectId: ProjectId, sessionId: SessionId): readonly OwnershipCloseResult[] {
    const results: OwnershipCloseResult[] = []
    for (const terminal of [...this.#terminals.values()]) {
      if (terminal.binding.projectId !== projectId || terminal.binding.sessionId !== sessionId) continue
      for (const client of [...terminal.clients.values()]) {
        const result = this.#removeClient(client.clientId, "session_terminated", `session ${sessionId} reached a terminal lifecycle state`, true)
        if (result !== null) results.push(result)
      }
    }
    return results
  }

  /** Releases the keyboard and tells the client it no longer has it. */
  #releaseTo(terminal: AttachedTerminal, clientId: TerminalClientId, why: string): void {
    terminal.inputOwner = null
    const client = terminal.clients.get(clientId)
    if (client === undefined) return
    client.owner = false
    this.#record({ kind: "lifecycle_closed", binding: client.binding, clientId, code: null, byteCount: 0, detail: `Input released: ${why}` })
    this.#sendControl(client, {
      terminalId: client.binding.terminalId,
      projectId: client.binding.projectId,
      sessionId: client.binding.sessionId,
      nodeId: client.binding.nodeId,
      clientId,
      operation: "release_input",
      epoch: client.epoch,
    })
  }

  #removeClient(clientId: TerminalClientId, cause: OwnershipCloseCause, detail: string, closeSocket: boolean): OwnershipCloseResult | null {
    const terminal = this.#terminal(clientId)
    if (terminal === undefined) return null
    const client = terminal.clients.get(clientId)
    if (client === undefined) return null
    const wasOwner = terminal.inputOwner === clientId
    if (wasOwner) terminal.inputOwner = null
    terminal.clients.delete(clientId)
    this.#index.delete(clientId)
    this.#chains.delete(clientId)
    if (closeSocket) client.socket.close()
    this.#record({ kind: "lifecycle_closed", binding: client.binding, clientId, code: null, byteCount: 0, detail: `Attachment closed: ${cause} (${bounded(detail)})` })
    if (terminal.clients.size === 0) this.#dropTerminal(terminal.binding.terminalId)
    return {
      cause,
      terminalId: client.binding.terminalId,
      displacedClientId: wasOwner ? clientId : null,
      closedClientIds: closeSocket ? [clientId] : [],
      viewersRemain: cause !== "session_terminated",
    }
  }

  #dropTerminal(terminalId: TerminalId): void {
    const terminal = this.#terminals.get(terminalId)
    if (terminal === undefined) return
    terminal.subscription?.close()
    terminal.subscription = null
    this.#terminals.delete(terminalId)
  }

  /**
   * A bounded snapshot, for a client that lost frames and wants to re-base.
   *
   * NOT encoded as a wire frame, and that is a deliberate refusal rather than an
   * omission. §4.9 defines two terminal families and neither carries a snapshot,
   * and the plan's guardrail "do not add a wire record family without a version"
   * means a gateway that invented a third would be making a protocol change
   * inside a transport task. The bytes go back to the CALLER, and M4.8's TUI
   * decides what to do with them — which is also the only arrangement in which
   * the re-base is a client decision, since only the client knows what its own
   * screen currently shows.
   */
  async snapshot(binding: TerminalBinding, maxBytes: number): Promise<Result<Uint8Array>> {
    const clientId = this.attachedClientIds(binding.terminalId)[0]
    if (clientId === undefined) return { ok: false, error: terminalNotAttached(binding.terminalId) }
    return await this.#runtime.snapshot({ ...binding, clientId, maxBytes })
  }

  // --- Reads --------------------------------------------------------------

  view(terminalId: TerminalId): TerminalView | null {
    const terminal = this.#terminals.get(terminalId)
    if (terminal === undefined) return null
    let droppedFrames = 0
    let lossy = false
    for (const client of terminal.clients.values()) {
      droppedFrames += client.droppedFrames
      lossy = lossy || client.lossy
    }
    return { binding: terminal.binding, viewerCount: terminal.clients.size, inputOwnerClientId: terminal.inputOwner, droppedFrames, lossy }
  }

  attachedClientIds(terminalId: TerminalId): readonly TerminalClientId[] {
    return [...(this.#terminals.get(terminalId)?.clients.keys() ?? [])]
  }

  // --- Internals ----------------------------------------------------------

  async #authorize(client: AttachedClient, claimedEpoch: Epoch): Promise<Result<Epoch>> {
    const access = await this.#access.authorize({
      terminalId: client.binding.terminalId,
      projectId: client.binding.projectId,
      sessionId: client.binding.sessionId,
      claimedNodeId: client.binding.nodeId,
      requesterNodeId: client.requesterNodeId,
      clientId: client.clientId,
      intent: "input",
      claimedEpoch,
    })
    if (!access.granted) return { ok: false, error: access.error }
    const mismatch = bindingMismatch(access.binding, client.binding)
    if (mismatch !== null) return { ok: false, error: mismatch }
    return { ok: true, value: access.epoch }
  }

  #chargeFrameRate(client: AttachedClient): TerminalAdmission {
    const now = this.#now()
    if (now - client.windowStartMs >= TERMINAL_FRAME_RATE_WINDOW_MS) {
      client.windowStartMs = now
      client.framesInWindow = 0
    }
    client.framesInWindow += 1
    return evaluateFrameRate(client.framesInWindow, TERMINAL_FRAME_RATE_WINDOW_MS)
  }

  #bindingMismatch(client: AttachedClient, payload: MeshTerminalControl): ContractError | null {
    const pairs: readonly (readonly [string, string, string])[] = [
      ["terminalId", payload.terminalId, client.binding.terminalId],
      ["projectId", payload.projectId, client.binding.projectId],
      ["sessionId", payload.sessionId, client.binding.sessionId],
      ["clientId", payload.clientId, client.clientId],
      ["nodeId", payload.nodeId, client.binding.nodeId],
    ]
    for (const [member, framed, attached] of pairs) {
      if (framed !== attached) return controlBindingError(member, framed, attached, client.clientId)
    }
    return null
  }

  #refuse(client: AttachedClient, operation: MeshTerminalControl["operation"] | null, family: "control" | "data", code: string, error: ContractError): TerminalRefusalOutcome {
    this.#record({
      kind: family === "control" ? "control_refused" : "data_refused",
      binding: client.binding,
      clientId: client.clientId,
      code,
      byteCount: 0,
      detail: error.message,
    })
    return { kind: "refused", family, operation, code, error }
  }

  #record(event: TerminalTelemetryEvent): void {
    this.#telemetry.record(event)
  }

  #origin(recipientNodeId: string | null): { senderNodeId: string; recipientNodeId: string | null; issuedAt: string; expiresAt: string; messageId: string } {
    this.#frameCounter += 1
    const nowMs = this.#now()
    return {
      senderNodeId: this.#nodeId,
      recipientNodeId,
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + this.#replayWindowMs).toISOString(),
      messageId: `msg-terminal-${this.#frameCounter}`,
    }
  }

  #find(clientId: TerminalClientId): AttachedClient | null {
    const terminalId = this.#index.get(clientId)
    if (terminalId === undefined) return null
    return this.#terminals.get(terminalId)?.clients.get(clientId) ?? null
  }

  #terminal(clientId: TerminalClientId): AttachedTerminal | undefined {
    const terminalId = this.#index.get(clientId)
    if (terminalId === undefined) return undefined
    return this.#terminals.get(terminalId)
  }

  /**
   * The terminal record for a binding, or a new one.
   *
   * When a terminal is ALREADY attached this returns the existing record and the
   * CALLER compares the binding against it. The first client's binding is what
   * stays on the record — the `runId` that `leaseExpired` is addressed in, the
   * `nodeId` every later access decision is taken against, and the `projectId` a
   * fan-out is scoped by. It is never overwritten, because a client that attached
   * under project A and then presented project B would otherwise MOVE the
   * terminal, and the cross-project stream that follows would be an ordering
   * accident rather than a decision anybody made.
   *
   * The disagreement is REFUSED rather than absorbed, and `attach` is where that
   * happens. Keeping the first binding is necessary but not sufficient: letting
   * the second client in anyway would hand a client the port granted project B
   * the bytes of project A's terminal. Refusing makes the rule safe, and it sends
   * the disagreement back to the port that produced it, which is the only place it
   * can be diagnosed. The access port IS still asked about the second client — it
   * is the BINDING the terminal is filed under that is immutable, not the
   * authorization.
   */
  #terminalFor(binding: TerminalBinding): AttachedTerminal {
    const existing = this.#terminals.get(binding.terminalId)
    if (existing !== undefined) return existing
    const created: AttachedTerminal = { binding, clients: new Map(), inputOwner: null, subscription: null }
    this.#terminals.set(binding.terminalId, created)
    return created
  }

  /**
   * One subscription per TERMINAL, not per client.
   *
   * Sixteen viewers of one terminal need one stream from the runtime, and sixteen
   * subscriptions would mean sixteen readers competing for the same pty's bytes —
   * each read taking a share the other fifteen do not get. A subscription that
   * fails is recorded and retried on the next attach rather than at every
   * publish, because a publish that has no terminal attached to deliver to would
   * otherwise subscribe to a terminal nobody is watching.
   */
  async #ensureSubscription(terminal: AttachedTerminal): Promise<void> {
    if (terminal.subscription !== null) return
    const binding = terminal.binding
    const subscribed = await this.#runtime.subscribe(binding, (bytes) => {
      this.publish(binding, bytes)
    })
    if (!subscribed.ok) {
      this.#record({ kind: "runtime_refused", binding, clientId: null, code: subscribed.error.code, byteCount: 0, detail: subscribed.error.message })
      return
    }
    terminal.subscription = subscribed.value
  }
}

// --- Module helpers --------------------------------------------------------

/**
 * The grant must be for what was asked.
 *
 * A cross-project stream is what happens if a port's answer is trusted verbatim,
 * and a port that resolved the wrong project is a bug in the port — but a gateway
 * that amplified that bug into a live stream is a bug in the gateway, and the two
 * are not equally consequential. So the check is here, at the seam, on three
 * members of the binding. `runId` is NOT checked, because the request did not
 * carry one: it is resolved by the port and there is nothing to compare it to.
 */
function bindingMismatch(
  grant: TerminalBinding,
  asked: { readonly terminalId: string; readonly projectId: string; readonly sessionId: string },
): ContractError | null {
  if (grant.projectId !== asked.projectId) return grantMismatch("projectId", grant.projectId, asked.projectId)
  if (grant.sessionId !== asked.sessionId) return grantMismatch("sessionId", grant.sessionId, asked.sessionId)
  if (grant.terminalId !== asked.terminalId) return grantMismatch("terminalId", grant.terminalId, asked.terminalId)
  return null
}

function grantMismatch(member: string, granted: string, asked: string): ContractError {
  return createContractError(
    "policy_denied",
    "terminal.access_grant_mismatch",
    `The access grant names ${member} '${granted}' but the request was for '${asked}'. A grant for something other than what was asked is refused even though the port answered yes: a port that resolved the wrong project would otherwise become a live cross-project terminal stream, and the milestone's stop condition is that terminal output never reaches another project's stream.`,
  )
}

function controlBindingError(member: string, framed: string, attached: string, clientId: TerminalClientId): ContractError {
  return createContractError(
    "policy_denied",
    "terminal.control_binding_mismatch",
    `A control frame from client '${clientId}' named ${member} '${framed}' but that client is attached with '${attached}'. Control frames are bound to the connection that sent them, and the binding is checked before the operation is even looked at — otherwise a 'request_input' naming another terminal would grant the keyboard of a terminal the client is not attached to.`,
  )
}

function scopeError(member: string, value: string): ContractError {
  return createContractError(
    "validation",
    "terminal.attach_scope_malformed",
    `A terminal attach supplied '${member}' as ${JSON.stringify(value)}, which is not a well-formed mesh id. The scope is parsed through the kernel's own schemas rather than cast, because a cast would let an attacker-chosen string reach the access port as a 'project id' that no record has ever carried.`,
  )
}

function clientNotAttached(clientId: TerminalClientId): ContractError {
  return createContractError(
    "conflict",
    "terminal.client_not_attached",
    `Client '${clientId}' sent a frame but is not attached. Attachments are removed on disconnect, revocation, session termination and the client's own detach, and a frame from a removed client is refused rather than treated as a fresh attach: re-attaching on a data frame would let a client whose node was revoked come back through the data path, and the data path has no identity check of its own.`,
  )
}

function terminalNotAttached(terminalId: TerminalId): ContractError {
  return createContractError(
    "conflict",
    "terminal.not_attached",
    `Terminal '${terminalId}' has no attached client. A snapshot is produced for a client that lost frames, so a terminal nobody is watching has no client to produce one for — and asking the runtime anyway would read a pty on behalf of nobody.`,
  )
}

function refuseAttach(reason: Extract<TerminalAttachDecision, { admitted: false }>["reason"], error: ContractError): TerminalAttachDecision {
  return { admitted: false, reason, error }
}

function decodeChunk(chunk: string): Uint8Array {
  return new Uint8Array(Buffer.from(chunk, "base64"))
}

/**
 * How much of a CALLER-SUPPLIED lifecycle detail reaches a structured record.
 *
 * `revokeNode` and `disconnect` are handed a `detail` by whatever noticed the
 * event, and those callers are outside this directory — M4.3's registry supplies
 * a revocation reason, the route supplies a fixed string. That makes the detail
 * the one member of a telemetry event whose bytes this module does not author,
 * and an unbounded one is an unbounded channel into a log line. So it is
 * truncated here rather than trusted, at the same 1 024 characters M4.2's
 * `registryRevocationSchema` bounds a revocation reason to — the two are the same
 * kind of operator-supplied text and they are bounded the same way.
 *
 * It is NOT terminal content and is not treated as such: an operator's reason
 * for revoking a node belongs in the audit log, which is where M4.2's own
 * middleware says revocation reasons stay. What is refused here is the
 * UNBOUNDED case, and the leak sweep in
 * `tests/unit/mesh/gateway/terminal/no-content-leak.test.ts` asserts the bound
 * rather than pretending a revocation reason is a terminal chunk.
 */
const MAX_LIFECYCLE_DETAIL = 1_024

function bounded(detail: string): string {
  return detail.length <= MAX_LIFECYCLE_DETAIL ? detail : `${detail.slice(0, MAX_LIFECYCLE_DETAIL)}… (truncated)`
}

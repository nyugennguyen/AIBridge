/**
 * M4.7 — the terminal WebSocket gateway.
 *
 * The seam M4.8 (TUI mesh and takeover UX), M4.9 (the two-node fault harness) and
 * M4.10 (the protocol/security audit) consume. Seven things a consumer must know
 * before importing anything from here:
 *
 *   1. **`MeshTerminalGatewayImpl` is the only entry point, and it has NO socket
 *      in its constructor.** It is handed a {@link TerminalSocket} per client, at
 *      `attach` time, and it never opens a connection or registers a listener.
 *      That is deliberate rather than convenient:
 *      `Docs/implementation-plans/websocket-test-harness.md` §1 records that
 *      `app.injectWS` does not work in this repository — it throws under `bun
 *      test` and hangs under vitest — and §3 records that a graceful close makes
 *      `app.close()` hang forever. A gateway whose logic could only be exercised
 *      through a socket would have had exactly those two problems as its test
 *      strategy. So the plan's "`injectWS` tests" are met by testing the session
 *      logic against the injected socket interface with no socket at all
 *      (`tests/unit/mesh/gateway/terminal/`), and the transport is proven
 *      separately over a real loopback listener with the `ws` client
 *      (`tests/integration/terminal-websocket.test.ts`). The deviation is
 *      recorded in the M4 gate report.
 *   2. **Authorization is asked, never remembered.**
 *      {@link TerminalAccessPort} is called at attach AND again at every input
 *      grant, and it has no cache and no `remember` — there is nowhere to put an
 *      answer. That is requirement 2 rendered as a type rather than as a
 *      convention, and it is why the port returns the RECORDED epoch: the epoch on
 *      a control frame is a pointer and the grant is the record, which is the
 *      plan's "authorize against the recorded log, never against its own payload"
 *      rule applied to a terminal.
 *   3. **Control and data are separate schemas AND separate opcodes.**
 *      {@link decodeTerminalFrame} refuses a `mesh.terminal.data` that arrived as
 *      text and a `mesh.terminal.control` that arrived as binary, with distinct
 *      codes. The opcode is the cheap half; the `recordType` check inside is the
 *      half that survives a proxy, and it is the one that keeps terminal content
 *      out of a control handler's `ContractError` message and log record.
 *   4. **A slow client loses FRAMES.** {@link MeshTerminalGatewayImpl.publish}
 *      measures each client's outbox against `MAX_TERMINAL_BUFFER_BYTES` PLUS
 *      what the transport is still holding, and applies the protocol's own
 *      `framesToDrop` from the FRONT. Nothing in this directory grows a buffer
 *      because a peer stopped reading. `lossy` and `droppedFrames` on
 *      {@link TerminalView} are how M4.8's TUI learns to offer a re-base.
 *   5. **There is NO snapshot frame on the wire.** `snapshot` goes through
 *      {@link TerminalRuntimePort} and returns bytes to the CALLER; it is not
 *      encoded as a `mesh.terminal.*` record. §4.9 defines two families and
 *      neither carries a snapshot, and the plan's guardrail "do not add a wire
 *      record family without a version" means inventing a third here would be a
 *      protocol change made by a gateway. A client that lost frames re-attaches
 *      and re-bases, which is the behaviour the protocol's own comment describes
 *      ("a slow client loses frames and reconnects from a snapshot").
 *   6. **Ownership closes on four causes, and they do NOT all close the socket.**
 *      `disconnect`, `revokeNode`, `leaseExpired` and `sessionTerminated` are
 *      four methods, tested separately. Lease expiry releases the keyboard and
 *      leaves the screen, because the plan's guardrail is "do not terminate agents
 *      because a controller or network disappeared" and a gateway that read a
 *      controller's silence as a user's departure would be inventing a decision.
 *      Revocation and session termination DO close, because a revoked node must
 *      not stream a terminal and a finished session's pty has nothing left to
 *      produce.
 *   7. **Nothing here can log terminal content, by construction.**
 *      {@link TerminalTelemetryEvent} has no member that can hold arbitrary bytes
 *      and no member that can hold a `chunk`; `byteCount` is a size. The takeover
 *      `reason` is deliberately NOT copied into a telemetry record even though it
 *      is a user-typed string on the same socket. `chunk` is never passed to the
 *      telemetry port, to an error message, or to an event, and
 *      `tests/unit/mesh/gateway/terminal/no-content-leak.test.ts` drives every
 *      path that produces a record with a recognisable marker in the terminal
 *      bytes and asserts the marker appears nowhere.
 *
 * Purity: only `./route.ts` touches Fastify and a WebSocket. Everything else is
 * pure and clock-injected, so "a thousand frames in one second", "a client that
 * stopped reading" and "a lease that expired ten minutes ago" are numbers rather
 * than waits.
 */

export {
  MESH_TERMINAL_PATH,
  registerTerminalRoute,
  statusForAttachRefusal,
  terminalAttachScopeFromQuery,
  type TerminalAttachScope,
  type TerminalRouteDependencies,
} from "./route.js"

export {
  MeshTerminalGatewayImpl,
  type MeshTerminalGatewayDependencies,
} from "./gateway.js"

export {
  TERMINAL_FRAME_REPLAY_WINDOW_MS,
  decodeTerminalChunk,
  decodeTerminalFrame,
  decodedChunkBytes,
  encodeControlFrame,
  encodeDataFrame,
  encodeTerminalChunk,
  type TerminalDecodedFrame,
  type TerminalFrameOrigin,
} from "./frames.js"

export {
  OWNERSHIP_CLOSE_CAUSES,
  TERMINAL_FRAME_RATE_WINDOW_MS,
  TERMINAL_TELEMETRY_KINDS,
  type MeshTerminalGateway,
  type OwnershipCloseCause,
  type OwnershipCloseResult,
  type TerminalAccessIntent,
  type TerminalAccessOutcome,
  type TerminalAccessPort,
  type TerminalAccessRefusal,
  type TerminalAccessRequest,
  type TerminalAttachDecision,
  type TerminalAttachRefusal,
  type TerminalAttachment,
  type TerminalBinding,
  type TerminalControlOutcome,
  type TerminalDataOutcome,
  type TerminalEncodedFrame,
  type TerminalFanoutResult,
  type TerminalInboundFrame,
  type TerminalInputRequest,
  type TerminalOutputSink,
  type TerminalOutputSubscription,
  type TerminalRefusalOutcome,
  type TerminalResizeRequest,
  type TerminalRuntimePort,
  type TerminalSnapshotRequest,
  type TerminalSocket,
  type TerminalTelemetry,
  type TerminalTelemetryEvent,
  type TerminalTelemetryKind,
  type TerminalView,
} from "./types.js"

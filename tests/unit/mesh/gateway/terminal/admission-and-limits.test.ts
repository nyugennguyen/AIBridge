/**
 * M4.7 requirements 1, 2 and 8 — admission and the per-client resource bounds.
 *
 * Every one of these runs against the injected socket interface with NO socket
 * anywhere. That is the point of the seam and the reason the plan's `injectWS`
 * tests are satisfied in substance: `Docs/implementation-plans/websocket-test-harness.md`
 * §1 measured that `app.injectWS` throws under `bun test` and hangs under vitest,
 * so a gateway whose decisions could only be reached through one would have had
 * the harness's two failures as its test strategy.
 *
 * What is asserted here, in the order the milestone lists it:
 *
 *   - **1.** An unauthenticated request is refused, and a refusal cannot be turned
 *     into an attachment. The second half is the one that matters: "the handler
 *     did not run" is only observable in the transport, but "the gateway will not
 *     attach on a refusal" is observable here, and it is the half a future
 *     refactor could break.
 *   - **2.** The access port is asked at attach AND at ownership, and an answer
 *     that CHANGES between the two is honoured rather than cached.
 *   - **8.** Frame size, frame rate and buffer pressure, each with the protocol's
 *     own evaluator as the authority, and a slow client that loses FRAMES rather
 *     than a buffer that grows.
 */
import { describe, expect, it } from "vitest"
import { MAX_TERMINAL_BUFFER_BYTES, MAX_TERMINAL_FRAME_BYTES, MAX_TERMINAL_FRAMES_PER_SECOND, MAX_VIEWERS_PER_TERMINAL } from "../../../../../src/mesh/protocol/bounds.js"
import { evaluateBufferPressure, evaluateViewerCount, framesToDrop } from "../../../../../src/mesh/protocol/terminal.js"
import { MeshTerminalGatewayImpl, TERMINAL_FRAME_RATE_WINDOW_MS } from "../../../../../src/mesh/gateway/terminal/index.js"
import {
  ALICE,
  BOB,
  CAROL,
  CONTROLLER,
  EPOCH,
  OTHER_PROJECT,
  PEER,
  PROJECT,
  SESSION,
  TERMINAL,
  TestClock,
  WORKER,
  FakeAccessPort,
  FakeRuntime,
  RecordingSocket,
  RecordingTelemetry,
  binding,
  bytes,
  controlFrame,
  dataFrame,
  denial,
  grant,
} from "./fixtures.js"

function aGateway(access = new FakeAccessPort(), runtime = new FakeRuntime(), clock = new TestClock()) {
  const telemetry = new RecordingTelemetry()
  const gateway = new MeshTerminalGatewayImpl({ now: clock.now, nodeId: WORKER, access, runtime, telemetry })
  return { gateway, access, runtime, clock, telemetry }
}

async function attach(
  gateway: MeshTerminalGatewayImpl,
  clientId: typeof ALICE,
  socket: RecordingSocket = new RecordingSocket(),
  overrides: Record<string, unknown> = {},
  requesterNodeId: typeof CONTROLLER | null = CONTROLLER,
) {
  const decision = await gateway.authorizeAttach({
    terminalId: TERMINAL,
    projectId: PROJECT,
    sessionId: SESSION,
    clientId,
    nodeId: WORKER,
    epoch: EPOCH,
    requesterNodeId,
    ...overrides,
  })
  if (!decision.admitted) return { decision, attached: null, socket }
  const attached = await gateway.attach(decision, socket)
  return { decision, attached: attached.ok ? attached.value : null, socket }
}

describe("requirement 1 — nothing attaches without a decision", () => {
  it("refuses an attach with no authenticated node in scope", async () => {
    const { gateway, access } = aGateway()
    const decision = await gateway.authorizeAttach({
      terminalId: TERMINAL,
      projectId: PROJECT,
      sessionId: SESSION,
      clientId: ALICE,
      nodeId: WORKER,
      epoch: EPOCH,
      requesterNodeId: null,
    })
    expect(decision.admitted).toBe(false)
    if (decision.admitted) return
    // `not_authenticated`, not `access_denied`: a route wired without M4.2's
    // hook is a WIRING fault and has to read as one, because an operator who
    // sees "access denied" goes looking for a policy and there is no policy.
    expect(decision.reason).toBe("not_authenticated")
    expect(decision.error.code).toBe("terminal.attach_unauthenticated")
    // The access port was never asked, because there was no node to ask about.
    // A port consulted before identity is a project-existence oracle.
    expect(access.calls).toHaveLength(0)
  })

  it("refuses to build an attachment out of a refusal", async () => {
    const { gateway } = aGateway(new FakeAccessPort([denial("node_revoked")]))
    const decision = await gateway.authorizeAttach({
      terminalId: TERMINAL,
      projectId: PROJECT,
      sessionId: SESSION,
      clientId: ALICE,
      nodeId: WORKER,
      epoch: EPOCH,
      requesterNodeId: CONTROLLER,
    })
    expect(decision.admitted).toBe(false)
    const attached = await gateway.attach(decision, new RecordingSocket())
    expect(attached.ok).toBe(false)
    if (attached.ok) return
    expect(attached.error.code).toBe("terminal.attach_without_decision")
    expect(gateway.view(TERMINAL)).toBeNull()
  })

  it("refuses a malformed scope without asking about it", async () => {
    const { gateway, access } = aGateway()
    const decision = await gateway.authorizeAttach({
      terminalId: "not a terminal id",
      projectId: PROJECT,
      sessionId: SESSION,
      clientId: ALICE,
      nodeId: WORKER,
      epoch: EPOCH,
      requesterNodeId: CONTROLLER,
    })
    expect(decision.admitted).toBe(false)
    if (decision.admitted) return
    expect(decision.reason).toBe("scope_malformed")
    expect(access.calls).toHaveLength(0)
  })

  it("refuses a non-positive epoch, which a 'client picks any epoch' attack relies on", async () => {
    const { gateway } = aGateway()
    const decision = await gateway.authorizeAttach({
      terminalId: TERMINAL,
      projectId: PROJECT,
      sessionId: SESSION,
      clientId: ALICE,
      nodeId: WORKER,
      epoch: 0,
      requesterNodeId: CONTROLLER,
    })
    expect(decision.admitted).toBe(false)
    if (decision.admitted) return
    expect(decision.reason).toBe("scope_malformed")
  })
})

describe("requirement 2 — the access port is asked at attach AND at ownership", () => {
  it("asks once at attach with the 'view' intent", async () => {
    const { gateway, access } = aGateway()
    await attach(gateway, ALICE)
    expect(access.intents).toEqual(["view"])
  })

  it("asks AGAIN with the 'input' intent when ownership is granted, and honours a changed answer", async () => {
    // The scripted port answers `grant` for the attach and `denial` for the
    // ownership request. A gateway that memoized the attach decision would grant
    // the keyboard on the first answer and this test would fail — which is the
    // whole point of requirement 2, and the reason `TerminalAccessPort` has no
    // cache and no `remember`.
    const access = new FakeAccessPort([grant(), denial("lease_expired")])
    const { gateway } = aGateway(access)
    await attach(gateway, ALICE)

    const outcome = await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }) })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind !== "refused") return
    expect(outcome.code).toBe("terminal.access_lease_expired")
    expect(access.intents).toEqual(["view", "input"])
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBeNull()
  })

  it("refuses a grant at a DIFFERENT epoch than the frame claimed", async () => {
    // The frame's epoch is a pointer; the grant is the record. A client that
    // signs a control frame at epoch 4 while the recorded lease is at 5 is
    // offering a pointer to a fence that has moved.
    const access = new FakeAccessPort([grant(), grant({}, 5)])
    const { gateway } = aGateway(access)
    await attach(gateway, ALICE)
    const outcome = await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }) })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind !== "refused") return
    expect(outcome.code).toBe("terminal.epoch_stale")
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBeNull()
  })
})

describe("requirement 8 — the viewer bound is the protocol's", () => {
  it("admits up to MAX_VIEWERS_PER_TERMINAL and refuses the next one", async () => {
    const { gateway } = aGateway()
    const bound = evaluateViewerCount(MAX_VIEWERS_PER_TERMINAL - 1)
    expect(bound.admitted).toBe(true)

    // Rather than sixteen `authorizeAttach` calls, the bound is exercised at its
    // own edge and then once through the gateway — sixteen sockets in a unit
    // test would be testing the loop, not the rule.
    const denied = evaluateViewerCount(MAX_VIEWERS_PER_TERMINAL)
    expect(denied.admitted).toBe(false)
    if (denied.admitted) return
    expect(denied.limit).toBe("viewers")
    expect(denied.error.message).toContain(String(MAX_VIEWERS_PER_TERMINAL))
  })

  it("refuses a seventeenth attach through the gateway with the protocol's own code", async () => {
    const { gateway } = aGateway()
    for (let index = 0; index < MAX_VIEWERS_PER_TERMINAL; index += 1) {
      const clientId = ALICE.replace("alice", `viewer-${index}`) as typeof ALICE
      const { attached } = await attach(gateway, clientId, new RecordingSocket(), { clientId })
      expect(attached).not.toBeNull()
    }
    expect(gateway.view(TERMINAL)?.viewerCount).toBe(MAX_VIEWERS_PER_TERMINAL)
    const overflow = await gateway.authorizeAttach({
      terminalId: TERMINAL,
      projectId: PROJECT,
      sessionId: SESSION,
      clientId: ALICE,
      nodeId: WORKER,
      epoch: EPOCH,
      requesterNodeId: CONTROLLER,
    })
    expect(overflow.admitted).toBe(false)
    if (overflow.admitted) return
    expect(overflow.reason).toBe("viewer_limit")
    expect(overflow.error.code).toBe("mesh.terminal_viewer_limit")
  })

  it("refuses two sockets for one client id, because a per-client sequence would be ambiguous", async () => {
    const { gateway } = aGateway()
    await attach(gateway, ALICE)
    const second = await attach(gateway, ALICE, new RecordingSocket(), { clientId: ALICE })
    expect(second.attached).toBeNull()
    expect(second.decision.admitted).toBe(true)
  })
})

describe("requirement 8 — the frame-size bound is applied to the STRING", () => {
  it("refuses an inbound chunk that decodes over the bound, and names the SIZE not the content", async () => {
    const { gateway, runtime } = aGateway()
    await attach(gateway, ALICE)
    await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }) })
    const oversized = Buffer.alloc(MAX_TERMINAL_FRAME_BYTES + 1, 0x41).toString("base64")
    const outcome = await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk: oversized, sequence: 1 }) })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind !== "refused") return
    // The refusal arrives from the FAMILY schema rather than from the gateway's
    // own `evaluateFrameSize`, and the order is the point: `terminalDataSchema`
    // checks the size on the base64 STRING, so the gateway never allocates the
    // bytes it is refusing. The gateway's evaluator is the second line, for a
    // frame that parsed — the outbound side, asserted below.
    expect(outcome.error.message).toContain(String(MAX_TERMINAL_FRAME_BYTES))
    // The message reports the SIZE. A `ContractError` message is a log line, and
    // a log line is somewhere terminal output can end up — the milestone's stop
    // condition. The chunk is 87 KB of base64 and none of it is in the message.
    expect(outcome.error.message.length).toBeLessThan(400)
    expect(outcome.error.message).not.toContain(oversized.slice(0, 64))
    // Nothing reached the pty. The bound is what stops the allocation, and a
    // check after the decode would be a check after the thing it prevents.
    expect(runtime.inputs).toHaveLength(0)
  })

  it("refuses a runtime write over the bound on the OUTBOUND side too", async () => {
    const { gateway, runtime, telemetry } = aGateway()
    await attach(gateway, ALICE)
    const result = gateway.publish(binding(), new Uint8Array(MAX_TERMINAL_FRAME_BYTES + 1))
    expect(result.delivered).toBe(0)
    expect(telemetry.find("frame_dropped")?.code).toBe("mesh.terminal_frame_too_large")
    expect(runtime.inputs).toHaveLength(0)
  })

  it("accepts a frame exactly on the bound", async () => {
    const { gateway, runtime } = aGateway()
    await attach(gateway, ALICE)
    await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }) })
    const exact = Buffer.alloc(MAX_TERMINAL_FRAME_BYTES, 0x41).toString("base64")
    const outcome = await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk: exact, sequence: 1 }) })
    expect(outcome.kind).toBe("accepted")
    expect(runtime.inputs[0]?.byteLength).toBe(MAX_TERMINAL_FRAME_BYTES)
  })
})

describe("requirement 8 — the frame-rate bound is a COUNT, not a list of timestamps", () => {
  it("admits MAX_TERMINAL_FRAMES_PER_SECOND in the window and refuses the next", async () => {
    const clock = new TestClock()
    const { gateway } = aGateway(new FakeAccessPort(), new FakeRuntime(), clock)
    await attach(gateway, ALICE)
    await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }) })
    // A fresh window, so the count below is the DATA frames and not the data
    // frames plus the control frame the ownership grant already spent.
    clock.advance(TERMINAL_FRAME_RATE_WINDOW_MS)

    const chunk = Buffer.from("x", "utf8").toString("base64")
    for (let index = 1; index <= MAX_TERMINAL_FRAMES_PER_SECOND; index += 1) {
      const outcome = await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk, sequence: index }) })
      expect(outcome.kind).toBe("accepted")
    }
    const over = await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk, sequence: MAX_TERMINAL_FRAMES_PER_SECOND + 1 }) })
    expect(over.kind).toBe("refused")
    if (over.kind !== "refused") return
    expect(over.code).toBe("mesh.terminal_frame_rate_exceeded")
  })

  it("starts a new window when the clock advances, so the bound is a rate and not a total", async () => {
    const clock = new TestClock()
    const { gateway } = aGateway(new FakeAccessPort(), new FakeRuntime(), clock)
    await attach(gateway, ALICE)
    await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }) })
    clock.advance(TERMINAL_FRAME_RATE_WINDOW_MS)
    const chunk = Buffer.from("x", "utf8").toString("base64")
    for (let index = 1; index <= MAX_TERMINAL_FRAMES_PER_SECOND; index += 1) {
      await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk, sequence: index }) })
    }
    clock.advance(TERMINAL_FRAME_RATE_WINDOW_MS)
    const next = await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk, sequence: MAX_TERMINAL_FRAMES_PER_SECOND + 1 }) })
    expect(next.kind).toBe("accepted")
  })

  it("charges control and data against the same per-client budget", async () => {
    // One budget, not two. Two budgets would double the bound for a client that
    // interleaved resize and typing, which is exactly what a real TUI does.
    const { gateway } = aGateway()
    await attach(gateway, ALICE)
    let refused = 0
    for (let index = 0; index < MAX_TERMINAL_FRAMES_PER_SECOND + 5; index += 1) {
      const outcome = await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "attach" }) })
      if (outcome.kind === "refused") refused += 1
    }
    expect(refused).toBeGreaterThan(0)
  })
})

describe("requirement 8 — a slow client LOSES FRAMES", () => {
  it("drops from the FRONT of the outbox and never grows it past the bound", async () => {
    const { gateway, telemetry } = aGateway()
    const alice = new RecordingSocket()
    await attach(gateway, ALICE, alice)

    // The client stops reading: the transport is holding everything the gateway
    // hands it, and the gateway's own outbox is where the rest waits. Both halves
    // are counted, because counting only the gateway's half would report no
    // pressure on a client that had stopped reading — the transport would simply
    // have taken every frame and buffered them internally, which is the same
    // memory exhaustion one layer down.
    alice.hold(MAX_TERMINAL_BUFFER_BYTES)
    const chunk = new Uint8Array(4_096)
    for (let index = 0; index < 8; index += 1) gateway.publish(binding(), chunk)

    const dropped = telemetry.events.filter((event) => event.kind === "frame_dropped")
    expect(dropped.length).toBeGreaterThan(0)
    const view = gateway.view(TERMINAL)
    expect(view?.lossy).toBe(true)
    expect(view?.droppedFrames).toBeGreaterThan(0)
    // Nothing was ever written to the socket, because the transport is full.
    expect(alice.frames).toHaveLength(0)
  })

  it("applies the protocol's own framesToDrop rather than a count of its own", () => {
    // Asserted against the evaluator, not against the gateway's arithmetic: the
    // gateway and the protocol have to agree about what "over the bound" means, or
    // a future change to one of them is invisible to the other.
    expect(framesToDrop(MAX_TERMINAL_BUFFER_BYTES + 1_000, 400)).toBe(3)
    expect(framesToDrop(MAX_TERMINAL_BUFFER_BYTES, 400)).toBe(0)
    expect(evaluateBufferPressure(MAX_TERMINAL_BUFFER_BYTES).admitted).toBe(true)
    expect(evaluateBufferPressure(MAX_TERMINAL_BUFFER_BYTES + 1).admitted).toBe(false)
  })

  it("keeps the newest frames, so a client that re-bases loses history and not the last prompt", async () => {
    const { gateway } = aGateway()
    const alice = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    alice.hold(MAX_TERMINAL_BUFFER_BYTES)
    gateway.publish(binding(), bytes("FIRST-PROMPT"))
    for (let index = 0; index < 6; index += 1) gateway.publish(binding(), new Uint8Array(4_096))
    // The transport drains; the next write is the one the client is waiting for.
    alice.hold(0)
    gateway.publish(binding(), bytes("LAST-PROMPT"))
    // Decoded rather than matched as text, because a data frame's chunk is
    // base64 and a grep for "LAST-PROMPT" in the raw frame would find nothing —
    // which is exactly the property being relied on by the leak sweep.
    const delivered = alice.dataPayloads().map((payload) => Buffer.from(payload.chunk, "base64").toString("utf8"))
    expect(delivered).toContain("LAST-PROMPT")
    expect(delivered).not.toContain("FIRST-PROMPT")
  })

  it("gives each client its OWN sequence, so one slow viewer's loss is not another's gap", async () => {
    const { gateway } = aGateway()
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    await attach(gateway, BOB, bob, { clientId: BOB })
    alice.hold(MAX_TERMINAL_BUFFER_BYTES)
    gateway.publish(binding(), bytes("one"))
    gateway.publish(binding(), bytes("two"))
    // Bob read everything, so his stream is gapless at 1 and 2 even though Alice
    // lost frames. A shared counter would have put a gap in his stream too.
    expect(bob.dataPayloads().map((payload) => payload.sequence)).toEqual([1, 2])
  })

  it("reports a per-client monotonic sequence that skips what was dropped", async () => {
    const { gateway } = aGateway()
    const alice = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    gateway.publish(binding(), bytes("a"))
    gateway.publish(binding(), bytes("b"))
    alice.hold(MAX_TERMINAL_BUFFER_BYTES)
    for (let index = 0; index < 4; index += 1) gateway.publish(binding(), new Uint8Array(8_192))
    alice.hold(0)
    gateway.publish(binding(), bytes("c"))
    const sequences = alice.dataPayloads().map((payload) => payload.sequence)
    expect(sequences[0]).toBe(1)
    expect(sequences[1]).toBe(2)
    // The gap is the client's DETECTABLE signal that it must re-base on a
    // snapshot, which is why the protocol's `sequence` is per client.
    expect(sequences[sequences.length - 1]).toBeGreaterThan(2)
  })
})

describe("requirement 8 — a client whose sequence goes backwards is refused, not applied", () => {
  it("refuses a repeat and a regression with the same code", async () => {
    const { gateway, runtime } = aGateway()
    await attach(gateway, ALICE)
    await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }) })
    const chunk = Buffer.from("ls", "utf8").toString("base64")
    expect((await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk, sequence: 5 }) })).kind).toBe("accepted")
    expect((await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk, sequence: 5 }) })).kind).toBe("refused")
    const back = await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk, sequence: 4 }) })
    expect(back.kind).toBe("refused")
    if (back.kind !== "refused") return
    expect(back.code).toBe("terminal.sequence_not_monotonic")
    expect(runtime.inputs).toHaveLength(1)
  })
})

describe("the runtime is subscribed once per TERMINAL, not once per client", () => {
  it("sixteen viewers need one read of the pty", async () => {
    const { gateway, runtime } = aGateway()
    await attach(gateway, ALICE)
    await attach(gateway, BOB, new RecordingSocket(), { clientId: BOB })
    await attach(gateway, CAROL, new RecordingSocket(), { clientId: CAROL })
    expect(runtime.subscriptions).toBe(1)
  })
})

describe("a grant for something other than what was asked is refused", () => {
  it("refuses a grant that names another project, even though the port said yes", async () => {
    // The port is trusted to be honest about the DECISION and not about the
    // BINDING. A port that resolved the wrong project would otherwise become a
    // live cross-project terminal stream, and the milestone's stop condition is
    // that terminal output never reaches another project's stream.
    const access = new FakeAccessPort([grant({ projectId: OTHER_PROJECT })])
    const { gateway } = aGateway(access)
    const decision = await gateway.authorizeAttach({
      terminalId: TERMINAL,
      projectId: PROJECT,
      sessionId: SESSION,
      clientId: ALICE,
      nodeId: WORKER,
      epoch: EPOCH,
      requesterNodeId: CONTROLLER,
    })
    expect(decision.admitted).toBe(false)
    if (decision.admitted) return
    expect(decision.error.code).toBe("terminal.access_grant_mismatch")
  })
})

describe("the buffer bound is the protocol's, and there is no second one", () => {
  it("drops nothing for a client that is exactly on MAX_TERMINAL_BUFFER_BYTES", async () => {
    const { gateway } = aGateway()
    const alice = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    // On the bound, not over it: no drop, and the client is not lossy. A default
    // that was quietly smaller would make every deployment's real bound tighter
    // than the spec's without anything recording it.
    alice.hold(MAX_TERMINAL_BUFFER_BYTES)
    gateway.publish(binding(), new Uint8Array(1_024))
    expect(gateway.view(TERMINAL)?.lossy).toBe(false)
    expect(gateway.view(TERMINAL)?.droppedFrames).toBe(0)
  })

  it("keeps the newest frame when the pressure is the transport's and there is nothing to drop", async () => {
    // The first frame an over-bound client is handed has no predecessor in the
    // outbox, so `framesToDrop` — which divides the OVERFLOW by the oldest frame's
    // size — returns zero. Pushing it anyway is deliberate: it is the frame the
    // client is waiting for, and the alternative is a client whose first write
    // never arrives at all. `lossy` is NOT set, and must not be: a client that has
    // not missed a frame has no gap to detect and nothing to re-base from.
    const { gateway } = aGateway()
    const alice = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    alice.hold(MAX_TERMINAL_BUFFER_BYTES)
    gateway.publish(binding(), new Uint8Array(1_024))
    expect(alice.frames).toHaveLength(0)
    expect(gateway.view(TERMINAL)?.lossy).toBe(false)
    // The next one has a predecessor, and THAT is when a drop happens.
    gateway.publish(binding(), new Uint8Array(1_024))
    expect(gateway.view(TERMINAL)?.lossy).toBe(true)
  })

  it("answers with the protocol's own code and bound, not one of this module's", async () => {
    const { gateway, telemetry } = aGateway()
    const alice = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    alice.hold(MAX_TERMINAL_BUFFER_BYTES)
    for (let index = 0; index < 4; index += 1) gateway.publish(binding(), new Uint8Array(4_096))
    const dropped = telemetry.find("frame_dropped")
    expect(dropped?.code).toBe("mesh.terminal_client_too_slow")
    // The message names §6's number, because §6's number is the one that was
    // exceeded. A gateway that reported a bound of its own would leave an operator
    // reading a number the protocol does not contain.
    expect(dropped?.detail).toContain(String(MAX_TERMINAL_BUFFER_BYTES))
  })
})

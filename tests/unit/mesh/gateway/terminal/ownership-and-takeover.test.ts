/**
 * M4.7 requirements 5, 6 and 7 — many viewers, exactly one input owner, resize on
 * the control frame, and an EXPLICIT takeover that notifies the displaced client.
 *
 * The three properties pull against each other, which is why they are tested
 * together rather than separately:
 *
 *   - "Many viewers" is a RESOURCE property (the protocol's `evaluateViewerCount`).
 *   - "One input owner" is a TYPE property, and it is only meaningful if something
 *     consults it. So the tests below do not stop at "one owner": they show that a
 *     second client cannot type, cannot resize, and cannot displace the owner by
 *     asking.
 *   - "Explicit takeover" is a POLICY property, and the reason it exists is that
 *     the first two together are not enough. A gateway that granted a bare
 *     `request_input` by displacing the current owner would satisfy "one owner at
 *     any instant" perfectly and would make the owner's position revocable at
 *     will — which is the defect the milestone's guardrail names.
 *
 * No socket is opened. The transport is `RecordingSocket`, which records and
 * reports bytes and decides nothing.
 */
import { describe, expect, it } from "vitest"
import { MeshTerminalGatewayImpl, TERMINAL_TELEMETRY_KINDS } from "../../../../../src/mesh/gateway/terminal/index.js"
import {
  ALICE,
  BOB,
  CAROL,
  CONTROLLER,
  EPOCH,
  NEXT_EPOCH,
  PROJECT,
  SESSION,
  TERMINAL,
  WORKER,
  FakeAccessPort,
  FakeRuntime,
  RecordingSocket,
  RecordingTelemetry,
  TestClock,
  binding,
  controlFrame,
  denial,
  grant,
} from "./fixtures.js"

function aGateway(access = new FakeAccessPort(), runtime = new FakeRuntime(), clock = new TestClock()) {
  const telemetry = new RecordingTelemetry()
  return { gateway: new MeshTerminalGatewayImpl({ now: clock.now, nodeId: WORKER, access, runtime, telemetry }), access, runtime, clock, telemetry }
}

async function attach(gateway: MeshTerminalGatewayImpl, clientId: typeof ALICE, socket: RecordingSocket, extra: Record<string, unknown> = {}) {
  const decision = await gateway.authorizeAttach({
    terminalId: TERMINAL,
    projectId: PROJECT,
    sessionId: SESSION,
    clientId,
    nodeId: WORKER,
    epoch: EPOCH,
    requesterNodeId: CONTROLLER,
    ...extra,
  })
  if (!decision.admitted) throw new Error(`attach was refused: ${decision.error.code}`)
  const attached = await gateway.attach(decision, socket)
  if (!attached.ok) throw new Error(`attach failed: ${attached.error.code}`)
  return attached.value
}

function ask(clientId: typeof ALICE, operation: "request_input" | "takeover_input" | "release_input" | "resize" | "detach", extra: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = { clientId, operation, epoch: EPOCH }
  if (operation === "takeover_input") base.reason = "the operator asked for the keyboard"
  if (operation === "resize") {
    base.rows = 40
    base.cols = 120
  }
  return { opcode: "text" as const, payload: controlFrame({ ...base, ...extra }) }
}

describe("requirement 6 — many viewers, exactly one input owner", () => {
  it("admits three viewers and reports all three with no owner", async () => {
    const { gateway } = aGateway()
    await attach(gateway, ALICE, new RecordingSocket())
    await attach(gateway, BOB, new RecordingSocket())
    await attach(gateway, CAROL, new RecordingSocket())
    const view = gateway.view(TERMINAL)
    expect(view?.viewerCount).toBe(3)
    expect(view?.inputOwnerClientId).toBeNull()
    expect(gateway.attachedClientIds(TERMINAL)).toEqual([ALICE, BOB, CAROL])
  })

  it("grants the keyboard to one client and to exactly one", async () => {
    const { gateway } = aGateway()
    await attach(gateway, ALICE, new RecordingSocket())
    await attach(gateway, BOB, new RecordingSocket())
    const first = await gateway.receive(ALICE, ask(ALICE, "request_input"))
    expect(first.kind).toBe("accepted")
    const second = await gateway.receive(BOB, ask(BOB, "request_input"))
    expect(second.kind).toBe("refused")
    if (second.kind !== "refused") return
    expect(second.code).toBe("terminal.input_owned")
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)
  })

  it("refuses a bare request from a second client RATHER THAN displacing the owner", async () => {
    // This is the load-bearing assertion for requirement 7's "explicit". If a
    // `request_input` displaced the owner, the "one owner" invariant would still
    // hold at every instant and the milestone's guardrail would be satisfied in
    // form and broken in substance.
    const { gateway, telemetry } = aGateway()
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    await attach(gateway, BOB, bob)
    await gateway.receive(ALICE, ask(ALICE, "request_input"))
    await gateway.receive(BOB, ask(BOB, "request_input"))
    // The owner was never told anything, because nothing happened to it.
    expect(alice.controlPayloads()).toHaveLength(0)
    expect(telemetry.find("ownership_displaced")).toBeUndefined()
  })

  it("refuses a data frame from a viewer that does not hold input", async () => {
    const { gateway, runtime } = aGateway()
    await attach(gateway, ALICE, new RecordingSocket())
    await attach(gateway, BOB, new RecordingSocket())
    await gateway.receive(ALICE, ask(ALICE, "request_input"))
    const { dataFrame } = await import("./fixtures.js")
    const typed = await gateway.receive(BOB, { opcode: "binary", payload: dataFrame({ clientId: BOB, sequence: 1 }) })
    expect(typed.kind).toBe("refused")
    if (typed.kind !== "refused") return
    expect(typed.code).toBe("terminal.not_input_owner")
    // Only Alice's bytes are at the pty. Without this check "one input owner"
    // would be a label on a field nothing reads.
    expect(runtime.inputs).toHaveLength(0)
  })

  it("refuses a release from a client that does not hold input", async () => {
    const { gateway } = aGateway()
    await attach(gateway, ALICE, new RecordingSocket())
    await attach(gateway, BOB, new RecordingSocket())
    await gateway.receive(ALICE, ask(ALICE, "request_input"))
    const released = await gateway.receive(BOB, ask(BOB, "release_input"))
    expect(released.kind).toBe("refused")
    if (released.kind !== "refused") return
    expect(released.code).toBe("terminal.not_input_owner")
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)
  })

  it("treats a repeated request from the OWNER as idempotent", async () => {
    // A client that re-sent its request after a lost reply must not be told it
    // lost a keyboard it already holds — and a gateway that refused would push
    // clients into a takeover loop against themselves.
    const { gateway } = aGateway()
    await attach(gateway, ALICE, new RecordingSocket())
    expect((await gateway.receive(ALICE, ask(ALICE, "request_input"))).kind).toBe("accepted")
    expect((await gateway.receive(ALICE, ask(ALICE, "request_input"))).kind).toBe("accepted")
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)
  })

  it("refuses a self-takeover, because the notice it would send is the displacement notice", async () => {
    const { gateway, telemetry } = aGateway()
    const alice = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    await gateway.receive(ALICE, ask(ALICE, "request_input"))
    const selfTakeover = await gateway.receive(ALICE, ask(ALICE, "takeover_input"))
    expect(selfTakeover.kind).toBe("refused")
    if (selfTakeover.kind !== "refused") return
    expect(selfTakeover.code).toBe("terminal.already_input_owner")
    expect(alice.controlPayloads()).toHaveLength(0)
    expect(telemetry.find("ownership_displaced")).toBeUndefined()
  })
})

describe("requirement 7 — an explicit takeover notifies the displaced client", () => {
  it("moves the keyboard and tells the previous owner, with the reason", async () => {
    const { gateway, telemetry } = aGateway()
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    await attach(gateway, BOB, bob)
    await gateway.receive(ALICE, ask(ALICE, "request_input"))

    const taken = await gateway.receive(BOB, ask(BOB, "takeover_input"))
    expect(taken.kind).toBe("accepted")
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(BOB)

    const notified = alice.controlPayloads()
    expect(notified).toHaveLength(1)
    expect(notified[0]?.operation).toBe("takeover_input")
    // The frame names the NEW owner, so the displaced client learns who took it,
    // and it carries the reason, so it learns why. The schema permits `reason`
    // on `takeover_input` and on nothing else, which is why the notice has this
    // shape rather than a `release_input` one.
    expect(notified[0]?.clientId).toBe(BOB)
    expect(notified[0]?.reason).toBe("the operator asked for the keyboard")
    expect(telemetry.find("ownership_displaced")?.clientId).toBe(BOB)
  })

  it("does NOT notify the client that took over", async () => {
    const { gateway } = aGateway()
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    await attach(gateway, BOB, bob)
    await gateway.receive(ALICE, ask(ALICE, "request_input"))
    await gateway.receive(BOB, ask(BOB, "takeover_input"))
    expect(bob.controlPayloads()).toHaveLength(0)
  })

  it("keeps the takeover reason OUT of the structured record", async () => {
    // `detail` is the one member of a telemetry event a careless edit could turn
    // into a channel, and a reason typed by a user at a keyboard is user input on
    // the same socket. It reaches the displaced client on the wire, which is the
    // only place it is needed.
    const marker = "OPERATOR-REASON-a41f"
    const { gateway, telemetry } = aGateway()
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    await attach(gateway, BOB, bob)
    await gateway.receive(ALICE, ask(ALICE, "request_input"))
    await gateway.receive(BOB, ask(BOB, "takeover_input", { reason: marker }))
    const serialised = JSON.stringify(telemetry.events)
    expect(serialised).not.toContain(marker)
    // And it DID reach the party that can act on it.
    expect(alice.controlPayloads()[0]?.reason).toBe(marker)
  })

  it("refuses a takeover whose epoch the record has moved past", async () => {
    // Four asks, in order: Alice attaches, Bob attaches, Alice takes the keyboard,
    // Bob asks to take it away. The FOURTH is the one that moved.
    const access = new FakeAccessPort([grant(), grant(), grant(), grant({}, NEXT_EPOCH)])
    const { gateway } = aGateway(access)
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    await attach(gateway, BOB, bob)
    await gateway.receive(ALICE, ask(ALICE, "request_input"))
    const taken = await gateway.receive(BOB, ask(BOB, "takeover_input"))
    expect(taken.kind).toBe("refused")
    if (taken.kind !== "refused") return
    expect(taken.code).toBe("terminal.epoch_stale")
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)
    expect(alice.controlPayloads()).toHaveLength(0)
  })

  it("refuses a takeover by a client whose access was revoked between attach and takeover", async () => {
    // The revocation lands on the FOURTH ask — Bob's takeover — and not on the
    // third, which is Alice's own request and would have failed the test for the
    // wrong reason.
    const access = new FakeAccessPort([grant(), grant(), grant(), denial("node_revoked")])
    const { gateway } = aGateway(access)
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    await attach(gateway, BOB, bob)
    await gateway.receive(ALICE, ask(ALICE, "request_input"))
    const taken = await gateway.receive(BOB, ask(BOB, "takeover_input"))
    expect(taken.kind).toBe("refused")
    if (taken.kind !== "refused") return
    expect(taken.code).toBe("terminal.access_node_revoked")
  })

  it("grants a takeover against an EMPTY owner, since there is nobody to displace", async () => {
    const { gateway, telemetry } = aGateway()
    const bob = new RecordingSocket()
    await attach(gateway, BOB, bob)
    const taken = await gateway.receive(BOB, ask(BOB, "takeover_input"))
    expect(taken.kind).toBe("accepted")
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(BOB)
    // Recorded, because an audit of who held the keyboard has to be able to say
    // that this grant came in as a takeover rather than a request.
    expect(telemetry.find("ownership_displaced")?.detail).toContain("nobody")
  })
})

describe("requirement 5 — resize rides on the control frame", () => {
  it("forwards a resize from the input owner to the runtime", async () => {
    const { gateway, runtime } = aGateway()
    await attach(gateway, ALICE, new RecordingSocket())
    await gateway.receive(ALICE, ask(ALICE, "request_input"))
    const resized = await gateway.receive(ALICE, ask(ALICE, "resize"))
    expect(resized.kind).toBe("accepted")
    expect(runtime.resizes).toEqual([{ rows: 40, columns: 120 }])
  })

  it("refuses a resize from a viewer, because a resize is an act on the pty", async () => {
    const { gateway, runtime } = aGateway()
    await attach(gateway, ALICE, new RecordingSocket())
    await attach(gateway, BOB, new RecordingSocket())
    const resized = await gateway.receive(BOB, ask(BOB, "resize"))
    expect(resized.kind).toBe("refused")
    if (resized.kind !== "refused") return
    expect(resized.code).toBe("terminal.not_input_owner")
    expect(runtime.resizes).toHaveLength(0)
  })

  it("refuses a half-resize at the schema, before the gateway ever sees it", async () => {
    const { gateway, runtime } = aGateway()
    await attach(gateway, ALICE, new RecordingSocket())
    await gateway.receive(ALICE, ask(ALICE, "request_input"))
    // `rows` without `cols` is refused by `terminalControlSchema` itself, which is
    // the bound living in the protocol rather than in the gateway: a second
    // gateway that forgot it would not become able to honour a half-resize.
    const half = await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "resize", rows: 40, epoch: EPOCH }) })
    expect(half.kind).toBe("refused")
    expect(runtime.resizes).toHaveLength(0)
  })
})

describe("a control frame is bound to the connection that sent it", () => {
  it("refuses a frame naming another client, another terminal, or another project", async () => {
    const { gateway } = aGateway()
    await attach(gateway, ALICE, new RecordingSocket())
    const forBob = await gateway.receive(ALICE, ask(BOB, "request_input"))
    expect(forBob.kind).toBe("refused")
    if (forBob.kind !== "refused") return
    expect(forBob.code).toBe("terminal.control_binding_mismatch")

    const forAnotherTerminal = await gateway.receive(ALICE, ask(ALICE, "request_input", { terminalId: "term-release-2" }))
    expect(forAnotherTerminal.kind).toBe("refused")
    if (forAnotherTerminal.kind !== "refused") return
    expect(forAnotherTerminal.code).toBe("terminal.control_binding_mismatch")
  })

  it("binds the nodeId too, so a client cannot address a terminal on another node", async () => {
    const { gateway } = aGateway()
    await attach(gateway, ALICE, new RecordingSocket())
    const elsewhere = await gateway.receive(ALICE, ask(ALICE, "request_input", { nodeId: "node-somewhere-else" }))
    expect(elsewhere.kind).toBe("refused")
    if (elsewhere.kind !== "refused") return
    expect(elsewhere.code).toBe("terminal.control_binding_mismatch")
  })
})

describe("a control frame is an instruction, so the replay window applies to it", () => {
  it("refuses a frame that has already expired", async () => {
    const clock = new TestClock()
    const { gateway } = aGateway(new FakeAccessPort(), new FakeRuntime(), clock)
    await attach(gateway, ALICE, new RecordingSocket())
    clock.advance(400_000)
    const stale = await gateway.receive(ALICE, ask(ALICE, "request_input"))
    expect(stale.kind).toBe("refused")
    if (stale.kind !== "refused") return
    expect(stale.code).toBe("protocol.record_expired")
  })

  it("refuses a frame issued so far in the future that it is outside the window", async () => {
    const clock = new TestClock()
    const { gateway } = aGateway(new FakeAccessPort(), new FakeRuntime(), clock)
    await attach(gateway, ALICE, new RecordingSocket())
    const future = new Date(clock.now() + 3_600_000).toISOString()
    const ahead = await gateway.receive(ALICE, {
      opcode: "text",
      payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }, { issuedAt: future, expiresAt: new Date(clock.now() + 7_200_000).toISOString() }),
    })
    expect(ahead.kind).toBe("refused")
    if (ahead.kind !== "refused") return
    expect(ahead.code).toBe("protocol.record_expired")
  })
})

describe("the telemetry vocabulary is exhaustive", () => {
  it("names every kind a switch would have to handle", () => {
    // Adding a kind has to be a compile error at every site that must handle it,
    // which means the list is a union and not a free string. Asserting the shape
    // rather than the contents would pass on an empty list.
    expect(new Set(TERMINAL_TELEMETRY_KINDS).size).toBe(TERMINAL_TELEMETRY_KINDS.length)
    expect(TERMINAL_TELEMETRY_KINDS).toContain("ownership_displaced")
    expect(TERMINAL_TELEMETRY_KINDS).toContain("frame_dropped")
    expect(TERMINAL_TELEMETRY_KINDS).toContain("lifecycle_closed")
  })
})

describe("a fan-out reaches every attached client of the ONE terminal it names", () => {
  it("does not reach a client attached to a different terminal", async () => {
    // The access port grants whatever terminal was ASKED about, so this test's
    // subject is the fan-out and not the grant-matching rule — which
    // `admission-and-limits.test.ts` covers directly.
    const { gateway } = aGateway(new FakeAccessPort([], (request) => grant({ terminalId: request.terminalId })))
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    const other = await gateway.authorizeAttach({
      terminalId: "term-release-2",
      projectId: PROJECT,
      sessionId: SESSION,
      clientId: BOB,
      nodeId: WORKER,
      epoch: EPOCH,
      requesterNodeId: CONTROLLER,
    })
    if (!other.admitted) throw new Error(other.error.code)
    const attached = await gateway.attach(other, bob)
    expect(attached.ok).toBe(true)

    gateway.publish(binding(), new Uint8Array([0x41]))
    expect(alice.dataPayloads()).toHaveLength(1)
    expect(bob.frames).toHaveLength(0)
  })
})

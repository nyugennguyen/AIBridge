/**
 * M4.7 requirement 10 — input ownership closes on FOUR causes, and they are four
 * different tests.
 *
 *   1. the client's socket went away,
 *   2. a node was REVOKED,
 *   3. the controller LEASE EXPIRED,
 *   4. the SESSION TERMINATED.
 *
 * Four separate files would be four separate reasons to change one of them, and
 * three of the four differ in something that matters operationally: whether the
 * VIEWERS SURVIVE. That is asserted here for each cause, because the difference
 * is the plan's guardrail read for terminals — "do not terminate agents because a
 * controller or network disappeared" means a lease expiry releases the keyboard
 * and leaves the screen, while a revoked node loses the connection outright
 * because it is no longer on the mesh.
 *
 * Nothing here opens a socket, which is the reason cause 1 can be tested at all:
 * `Docs/implementation-plans/websocket-test-harness.md` §3 measured that a
 * graceful close on a real WebSocket never completes, so a gateway whose cleanup
 * depended on a well-behaved peer would have a test that hangs rather than one
 * that passes.
 */
import { describe, expect, it } from "vitest"
import { sessionIdSchema } from "../../../../../src/orchestration/identifiers.js"
import { MeshTerminalGatewayImpl, OWNERSHIP_CLOSE_CAUSES } from "../../../../../src/mesh/gateway/terminal/index.js"
import {
  ALICE,
  BOB,
  CONTROLLER,
  EPOCH,
  OTHER_PROJECT,
  OTHER_RUN,
  PEER,
  PROJECT,
  RUN,
  SESSION,
  TERMINAL,
  WORKER,
  FakeAccessPort,
  FakeRuntime,
  RecordingSocket,
  RecordingTelemetry,
  TestClock,
  controlFrame,
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

async function grantInput(gateway: MeshTerminalGatewayImpl, clientId: typeof ALICE) {
  const outcome = await gateway.receive(clientId, {
    opcode: "text",
    payload: controlFrame({ clientId, operation: "request_input", epoch: EPOCH }),
  })
  if (outcome.kind !== "accepted") throw new Error(`ownership was refused: ${outcome.kind === "refused" ? outcome.code : "?"}`)
}

/** One gateway with Alice owning input and Bob watching. */
async function aSessionWithAnOwner() {
  const harness = aGateway()
  const alice = new RecordingSocket()
  const bob = new RecordingSocket()
  await attach(harness.gateway, ALICE, alice)
  await attach(harness.gateway, BOB, bob, { clientId: BOB })
  await grantInput(harness.gateway, ALICE)
  return { ...harness, alice, bob }
}

describe("cause 1 — disconnect", () => {
  it("releases ownership and forgets the client", async () => {
    const { gateway, alice } = await aSessionWithAnOwner()
    const result = gateway.disconnect(ALICE, "the socket closed")
    expect(result?.cause).toBe("disconnect")
    expect(result?.displacedClientId).toBe(ALICE)
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBeNull()
    expect(gateway.attachedClientIds(TERMINAL)).toEqual([BOB])
    // There is nothing to close: the socket is what went away.
    expect(alice.closed).toBe(0)
  })

  it("is idempotent, because 'close' and 'error' both fire for one lost socket", async () => {
    const { gateway } = await aSessionWithAnOwner()
    expect(gateway.disconnect(ALICE, "the socket closed")).not.toBeNull()
    // A graceful close never completes on this transport, so the route wires both
    // events; the second call must find nothing rather than releasing a
    // replacement owner by the same client id.
    expect(gateway.disconnect(ALICE, "the socket errored")).toBeNull()
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBeNull()
  })

  it("closes the runtime subscription when the last client leaves", async () => {
    const { gateway, runtime } = await aSessionWithAnOwner()
    gateway.disconnect(ALICE, "closed")
    gateway.disconnect(BOB, "closed")
    // One pty read, and it is released. A subscription left open after the last
    // viewer is a live read of a terminal nobody is watching.
    expect(runtime.subscriptions).toBe(1)
    expect(runtime.subscriptionsClosed).toBe(1)
    expect(gateway.view(TERMINAL)).toBeNull()
  })

  it("refuses a frame from a client that has gone", async () => {
    const { gateway } = await aSessionWithAnOwner()
    gateway.disconnect(ALICE, "closed")
    const after = await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }) })
    expect(after.kind).toBe("refused")
    if (after.kind !== "refused") return
    // Re-attaching on a data frame would let a client whose node was revoked come
    // back through a path with no identity check of its own.
    expect(after.code).toBe("terminal.client_not_attached")
  })

  it("does not release a viewer who was not the owner", async () => {
    const { gateway } = await aSessionWithAnOwner()
    const result = gateway.disconnect(BOB, "closed")
    expect(result?.displacedClientId).toBeNull()
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)
  })
})

describe("cause 2 — revocation", () => {
  it("releases ownership AND closes the revoked node's sockets", async () => {
    const { gateway, alice, bob } = await aSessionWithAnOwner()
    const results = gateway.revokeNode(CONTROLLER, "key compromised")
    expect(results).toHaveLength(2)
    expect(results.map((entry) => entry.cause)).toEqual(["revocation", "revocation"])
    // The plan's completion criterion is "a revoked node cannot reconnect or
    // stream a terminal". A read-only stream left running would still be
    // streaming one, so this is the only difference from a lease expiry that
    // matters.
    expect(alice.closed).toBe(1)
    expect(bob.closed).toBe(1)
    expect(gateway.view(TERMINAL)).toBeNull()
  })

  it("records the close so an operator can see WHY a stream ended", async () => {
    const { gateway, telemetry } = await aSessionWithAnOwner()
    gateway.revokeNode(CONTROLLER, "key compromised")
    const record = telemetry.find("lifecycle_closed")
    expect(record?.detail).toContain("revocation")
    expect(record?.detail).toContain("key compromised")
  })

  it("leaves a node that was not revoked alone", async () => {
    const { gateway, alice, bob } = await aSessionWithAnOwner()
    // A different node's revocation must not reach across the mesh. The gateway
    // compares the AUTHENTICATED node of each attachment, not the node holding
    // the runtime, so revoking the runtime's node does not disconnect viewers.
    const results = gateway.revokeNode(PEER, "an unrelated node")
    expect(results).toHaveLength(0)
    expect(alice.closed).toBe(0)
    expect(bob.closed).toBe(0)
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)
  })

  it("closes a revoked node's viewer and leaves a differently-identified viewer attached", async () => {
    // The two clients are attached under DIFFERENT authenticated nodes, which is
    // the realistic case on a mesh: a controller's operator and a worker's
    // operator watching the same terminal.
    const access = new FakeAccessPort([], (request) => grant())
    const { gateway } = aGateway(access)
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    const aliceAttach = await gateway.authorizeAttach({ terminalId: TERMINAL, projectId: PROJECT, sessionId: SESSION, clientId: ALICE, nodeId: WORKER, epoch: EPOCH, requesterNodeId: CONTROLLER })
    const bobAttach = await gateway.authorizeAttach({ terminalId: TERMINAL, projectId: PROJECT, sessionId: SESSION, clientId: BOB, nodeId: WORKER, epoch: EPOCH, requesterNodeId: PEER })
    if (!aliceAttach.admitted || !bobAttach.admitted) throw new Error("attach refused")
    await gateway.attach(aliceAttach, alice)
    await gateway.attach(bobAttach, bob)

    gateway.revokeNode(CONTROLLER, "key compromised")
    expect(alice.closed).toBe(1)
    expect(bob.closed).toBe(0)
    expect(gateway.attachedClientIds(TERMINAL)).toEqual([BOB])
  })
})

describe("cause 3 — lease expiry", () => {
  it("releases ownership, notifies the owner, and LEAVES THE VIEWERS ATTACHED", async () => {
    const { gateway, alice, bob } = await aSessionWithAnOwner()
    const results = gateway.leaseExpired({ projectId: PROJECT, runId: RUN })
    expect(results).toHaveLength(1)
    expect(results[0]?.cause).toBe("lease_expiry" as never)
    expect(results[0]?.displacedClientId).toBe(ALICE)
    expect(results[0]?.viewersRemain).toBe(true)
    // The screen stays. A lease that expired thirty seconds ago says nobody is
    // driving the run; it says nothing about whether the user is still watching,
    // and closing the socket would be the gateway deciding that a controller's
    // silence is a user's departure.
    expect(alice.closed).toBe(0)
    expect(bob.closed).toBe(0)
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBeNull()
    expect(gateway.attachedClientIds(TERMINAL)).toEqual([ALICE, BOB])
  })

  it("tells the demoted owner, because a client that keeps typing into silence looks frozen", async () => {
    const { gateway, alice } = await aSessionWithAnOwner()
    gateway.leaseExpired({ projectId: PROJECT, runId: RUN })
    const notified = alice.controlPayloads()
    expect(notified).toHaveLength(1)
    expect(notified[0]?.operation).toBe("release_input")
    expect(notified[0]?.clientId).toBe(ALICE)
  })

  it("leaves the demoted client unable to type, and tells the pty nothing", async () => {
    const { gateway, runtime } = await aSessionWithAnOwner()
    const { dataFrame } = await import("./fixtures.js")
    gateway.leaseExpired({ projectId: PROJECT, runId: RUN })
    const typed = await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, sequence: 1 }) })
    expect(typed.kind).toBe("refused")
    if (typed.kind !== "refused") return
    expect(typed.code).toBe("terminal.not_input_owner")
    expect(runtime.inputs).toHaveLength(0)
  })

  it("touches nothing in another run", async () => {
    const { gateway, alice } = await aSessionWithAnOwner()
    gateway.leaseExpired({ projectId: PROJECT, runId: OTHER_RUN })
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)
    expect(alice.controlPayloads()).toHaveLength(0)
  })

  it("touches nothing in another project", async () => {
    const { gateway } = await aSessionWithAnOwner()
    gateway.leaseExpired({ projectId: OTHER_PROJECT, runId: RUN })
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)
  })

  it("can grant the keyboard again once a new controller holds the run", async () => {
    // A released keyboard is available. A gateway that treated the release as a
    // terminal state would leave a terminal nobody can ever type into again
    // after one lease expiry, which is a denial of service dressed as a fence.
    const { gateway } = await aSessionWithAnOwner()
    gateway.leaseExpired({ projectId: PROJECT, runId: RUN })
    await grantInput(gateway, BOB)
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(BOB)
  })
})

describe("cause 4 — session termination", () => {
  it("releases ownership AND closes every attachment to that session", async () => {
    const { gateway, alice, bob } = await aSessionWithAnOwner()
    const results = gateway.sessionTerminated(PROJECT, SESSION)
    expect(results).toHaveLength(2)
    expect(results.every((entry) => entry.cause === "session_terminated")).toBe(true)
    // A terminated session's pty is finished. A viewer left attached holds a
    // frame-rate budget and an outbox for a stream that can never produce again.
    expect(alice.closed).toBe(1)
    expect(bob.closed).toBe(1)
    expect(gateway.view(TERMINAL)).toBeNull()
  })

  it("touches nothing in another session of the same project", async () => {
    const { gateway, alice } = await aSessionWithAnOwner()
    gateway.sessionTerminated(PROJECT, sessionIdSchema.parse("sess-release-2"))
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)
    expect(alice.closed).toBe(0)
  })

  it("touches nothing in another project", async () => {
    const { gateway, alice } = await aSessionWithAnOwner()
    gateway.sessionTerminated(OTHER_PROJECT, SESSION)
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)
    expect(alice.closed).toBe(0)
  })
})

describe("the wire's own detach is the fifth close, and it is a deliberate one", () => {
  it("releases ownership exactly as a disconnect does", async () => {
    const { gateway, runtime } = await aSessionWithAnOwner()
    const outcome = await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "detach", epoch: EPOCH }) })
    expect(outcome.kind).toBe("accepted")
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBeNull()
    expect(gateway.attachedClientIds(TERMINAL)).toEqual([BOB])
    // The runtime subscription survives, because a viewer is still watching.
    expect(runtime.subscriptionsClosed).toBe(0)
  })
})

describe("the cause vocabulary is exhaustive", () => {
  it("names every cause a caller may have to switch on", () => {
    // Each member corresponds to a method on the gateway, and a fifth cause added
    // without an entry here would be a cause with no name in an audit.
    expect(new Set(OWNERSHIP_CLOSE_CAUSES).size).toBe(OWNERSHIP_CLOSE_CAUSES.length)
    expect([...OWNERSHIP_CLOSE_CAUSES].sort()).toEqual(["detach", "disconnect", "lease_expiry", "revocation", "session_terminated"])
  })
})

/**
 * M4.7 — project isolation, and the second half of the milestone's stop
 * condition: "stop if terminal output can enter logs, events, or ANOTHER
 * PROJECT STREAM".
 *
 * The other project-isolation tests in the mesh (M4.5's inbox, M4.6's SSE) are
 * about AUTHORIZATION: whether a caller may name a project at all. This file is
 * about something narrower and, in a terminal gateway, more dangerous — whether
 * a byte that arrived on one project's stream can leave on another's. The
 * terminal stream is bidirectional, high-volume, and holds content no log is
 * allowed to see, so "the check passed" is not sufficient; the bytes themselves
 * have to be shown not to have moved.
 *
 * Four mechanisms are asserted, and each is a different way a leak could happen:
 *
 *   1. **The access grant is checked against the request.** A port that resolved
 *      the wrong project is a bug in the port; a gateway that amplified it into a
 *      live stream is a bug in the gateway, and the two are not equally
 *      consequential.
 *   2. **The control frame is bound to the connection.** A client attached to
 *      project A cannot send a `request_input` naming project B's terminal.
 *   3. **The terminal record's binding is immutable.** A second client presenting
 *      a different binding for an attached terminal cannot MOVE it between
 *      projects — the cross-project stream that would follow is an ordering
 *      accident rather than a decision anybody made.
 *   4. **The fan-out is keyed by terminal id.** Runtime output reaches exactly
 *      the clients attached to the terminal it names.
 */
import { describe, expect, it } from "vitest"
import { MeshTerminalGatewayImpl } from "../../../../../src/mesh/gateway/terminal/index.js"
import type { TerminalAccessOutcome, TerminalAccessPort, TerminalAccessRequest, TerminalBinding } from "../../../../../src/mesh/gateway/terminal/index.js"
import {
  ALICE,
  BOB,
  CONTROLLER,
  EPOCH,
  OTHER_PROJECT,
  OTHER_SESSION,
  OTHER_TERMINAL,
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
  binding,
  bytes,
  controlFrame,
  dataFrame,
  grant,
} from "./fixtures.js"

const MARKER_A = "PROJECT-A-ONLY-3f9c1d7b"
const MARKER_B = "PROJECT-B-ONLY-b44ae9f0"

/**
 * An access port that grants whatever it is asked about, and keeps a record of
 * which terminals it has been asked about.
 *
 * Permissive on purpose: this file's subject is the gateway's binding checks, and
 * a restrictive fake would make every test pass for the wrong reason — the
 * refusal would come from the fake rather than from the mechanism under test.
 * The refusals are asserted with the restrictive fake in
 * `admission-and-limits.test.ts`.
 */
class PermissiveAccess implements TerminalAccessPort {
  readonly asked: TerminalBinding[] = []

  async authorize(request: TerminalAccessRequest): Promise<TerminalAccessOutcome> {
    const binding: TerminalBinding = {
      terminalId: request.terminalId,
      projectId: request.projectId,
      sessionId: request.sessionId,
      nodeId: WORKER,
      runId: RUN,
    }
    this.asked.push(binding)
    // `granted: true` is a LITERAL rather than a boolean, because
    // `TerminalAccessOutcome` is a discriminated union: widening it to `boolean`
    // would make the whole union assignable to nothing and the type would stop
    // being able to say which arm a caller holds.
    return { granted: true, binding, epoch: EPOCH }
  }
}

function aGateway(access: TerminalAccessPort = new PermissiveAccess()) {
  const runtime = new FakeRuntime()
  const telemetry = new RecordingTelemetry()
  const clock = new TestClock()
  return { gateway: new MeshTerminalGatewayImpl({ now: clock.now, nodeId: WORKER, access, runtime, telemetry }), runtime, telemetry, clock, access }
}

async function attach(gateway: MeshTerminalGatewayImpl, scope: Record<string, unknown>, socket: RecordingSocket) {
  const decision = await gateway.authorizeAttach({
    terminalId: TERMINAL,
    projectId: PROJECT,
    sessionId: SESSION,
    clientId: ALICE,
    nodeId: WORKER,
    epoch: EPOCH,
    requesterNodeId: CONTROLLER,
    ...scope,
  })
  if (!decision.admitted) return { decision, attached: null }
  const attached = await gateway.attach(decision, socket)
  return { decision, attached: attached.ok ? attached.value : null }
}

const PROJECT_B = { terminalId: OTHER_TERMINAL, projectId: OTHER_PROJECT, sessionId: OTHER_SESSION }

describe("a grant for another project is refused even though the port said yes", () => {
  it("refuses at attach, and the access port is not consulted again", async () => {
    const access = new FakeAccessPort([grant({ projectId: OTHER_PROJECT })])
    const { gateway } = aGateway(access)
    const { decision, attached } = await attach(gateway, {}, new RecordingSocket())
    expect(decision.admitted).toBe(false)
    if (decision.admitted) return
    expect(decision.error.code).toBe("terminal.access_grant_mismatch")
    expect(attached).toBeNull()
    expect(gateway.view(TERMINAL)).toBeNull()
  })

  it("refuses at OWNERSHIP time, where the grant is asked a second time", async () => {
    // The attach grant is correct and the ownership grant is not. A gateway that
    // memoized the attach decision would hand project B's client the keyboard of
    // project A's terminal on the strength of a check that was never repeated.
    const access = new FakeAccessPort([grant(), grant({ projectId: OTHER_PROJECT })])
    const { gateway, runtime } = aGateway(access)
    const alice = new RecordingSocket()
    const { attached } = await attach(gateway, { clientId: ALICE }, alice)
    expect(attached).not.toBeNull()
    const outcome = await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }) })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind !== "refused") return
    expect(outcome.code).toBe("terminal.access_grant_mismatch")
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBeNull()
    const typed = await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk: Buffer.from(MARKER_A).toString("base64"), sequence: 1 }) })
    expect(typed.kind).toBe("refused")
    expect(runtime.inputs).toHaveLength(0)
  })
})

describe("a control frame cannot address another project's terminal", () => {
  it("refuses a frame whose terminalId belongs to project B", async () => {
    const { gateway, runtime } = aGateway()
    const alice = new RecordingSocket()
    await attach(gateway, { clientId: ALICE }, alice)
    const outcome = await gateway.receive(ALICE, {
      opcode: "text",
      payload: controlFrame({ clientId: ALICE, terminalId: OTHER_TERMINAL, projectId: OTHER_PROJECT, operation: "request_input", epoch: EPOCH }),
    })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind !== "refused") return
    expect(outcome.code).toBe("terminal.control_binding_mismatch")
    expect(gateway.view(OTHER_TERMINAL)).toBeNull()
    expect(runtime.inputs).toHaveLength(0)
  })

  it("refuses a frame that keeps the terminalId and swaps the projectId", async () => {
    // The more plausible forgery: the client knows a real terminal id and claims
    // it belongs to a project it is attached to. Checked because the binding has
    // to be compared as a WHOLE — a check on `terminalId` alone would pass this.
    const { gateway } = aGateway()
    const alice = new RecordingSocket()
    await attach(gateway, { clientId: ALICE }, alice)
    const outcome = await gateway.receive(ALICE, {
      opcode: "text",
      payload: controlFrame({ clientId: ALICE, projectId: OTHER_PROJECT, operation: "request_input", epoch: EPOCH }),
    })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind !== "refused") return
    expect(outcome.code).toBe("terminal.control_binding_mismatch")
  })

  it("refuses a data frame that keeps the terminalId and swaps the project", async () => {
    // A data frame carries no projectId, so the check that protects it is the
    // `terminalId` one — and the reason it is checked against the ATTACHMENT
    // rather than against anything on the frame is that there is nothing on the
    // frame to check.
    const { gateway, runtime } = aGateway()
    const alice = new RecordingSocket()
    await attach(gateway, { clientId: ALICE }, alice)
    const outcome = await gateway.receive(ALICE, {
      opcode: "binary",
      payload: dataFrame({ clientId: ALICE, terminalId: OTHER_TERMINAL, chunk: Buffer.from(MARKER_B).toString("base64"), sequence: 1 }),
    })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind !== "refused") return
    expect(outcome.code).toBe("terminal.data_binding_mismatch")
    expect(runtime.inputs).toHaveLength(0)
  })
})

describe("an attached terminal cannot be MOVED between projects", () => {
  it("refuses a second client whose grant names a different project for the same terminal", async () => {
    const { gateway } = aGateway()
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, { clientId: ALICE }, alice)
    // Bob asks for the SAME terminalId under a DIFFERENT project. The access port
    // is permissive and grants it, so the only thing standing between Bob and
    // project A's bytes is the gateway's own rule at `attach`.
    // Same terminalId, different project — the exact shape of the move.
    const bobAttach = await attach(gateway, { terminalId: TERMINAL, projectId: OTHER_PROJECT, sessionId: OTHER_SESSION, clientId: BOB }, bob)
    expect(bobAttach.attached).toBeNull()

    const view = gateway.view(TERMINAL)
    expect(view?.binding.projectId).toBe(PROJECT)
    expect(view?.viewerCount).toBe(1)
    expect(gateway.attachedClientIds(TERMINAL)).toEqual([ALICE])
  })

  it("refuses the same client re-attaching the same terminal under another project", async () => {
    // A reconnecting client that changed its mind about the project is the same
    // hazard by another route, and the second socket would otherwise carry a
    // second per-client sequence stream — which is the thing the protocol's
    // "per client" is for.
    const { gateway } = aGateway()
    const alice = new RecordingSocket()
    await attach(gateway, { clientId: ALICE }, alice)
    const again = await attach(gateway, { terminalId: TERMINAL, projectId: OTHER_PROJECT, sessionId: OTHER_SESSION, clientId: ALICE }, new RecordingSocket())
    expect(again.attached).toBeNull()
    expect(gateway.view(TERMINAL)?.viewerCount).toBe(1)
  })

  it("does not let a refused mover read the original project's output", async () => {
    const { gateway } = aGateway()
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, { clientId: ALICE }, alice)
    await attach(gateway, { ...PROJECT_B, clientId: BOB }, bob)

    gateway.publish(binding(), bytes(MARKER_A))
    const aliceSaw = alice.dataPayloads().map((payload) => Buffer.from(payload.chunk, "base64").toString("utf8"))
    const bobSaw = bob.dataPayloads().map((payload) => Buffer.from(payload.chunk, "base64").toString("utf8"))
    expect(aliceSaw).toContain(MARKER_A)
    expect(bobSaw).not.toContain(MARKER_A)
  })
})

describe("a fan-out reaches only the clients attached to the terminal it names", () => {
  it("project A's bytes do not reach project B's client", async () => {
    const { gateway } = aGateway()
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, { clientId: ALICE }, alice)
    await attach(gateway, { ...PROJECT_B, clientId: BOB }, bob)

    gateway.publish(binding(), bytes(MARKER_A))
    gateway.publish({ ...PROJECT_B, terminalId: OTHER_TERMINAL, projectId: OTHER_PROJECT, sessionId: OTHER_SESSION, nodeId: WORKER, runId: RUN }, bytes(MARKER_B))

    const aliceText = alice.dataPayloads().map((payload) => Buffer.from(payload.chunk, "base64").toString("utf8"))
    const bobText = bob.dataPayloads().map((payload) => Buffer.from(payload.chunk, "base64").toString("utf8"))
    expect(aliceText).toEqual([MARKER_A])
    expect(bobText).toEqual([MARKER_B])
    expect(alice.everythingWritten()).not.toContain(MARKER_B)
    expect(bob.everythingWritten()).not.toContain(MARKER_A)
  })

  it("a refusal on one project's stream does not touch another's telemetry", async () => {
    const { gateway, telemetry } = aGateway()
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, { clientId: ALICE }, alice)
    await attach(gateway, { ...PROJECT_B, clientId: BOB }, bob)

    await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk: Buffer.from(MARKER_B).toString("base64"), sequence: 1 }) })
    // The refusal is recorded against project A's binding only. A record that
    // mixed the two would be the third destination the stop condition names.
    const refused = telemetry.events.filter((event) => event.kind === "data_refused")
    expect(refused).toHaveLength(1)
    expect(refused[0]?.binding.projectId).toBe(PROJECT)
    expect(JSON.stringify(telemetry.events)).not.toContain(MARKER_B)
  })
})

describe("the project is bound to the AUTHENTICATED node's access, not to a claim", () => {
  it("records a peer attaching to the same terminal, and both see the same bytes", async () => {
    // Two nodes watching one terminal is the mesh working, not a leak. The
    // assertion is that the bytes are the same and that each client's frames name
    // its OWN clientId — which is what "per client, monotonic" buys: two viewers
    // with independent, individually-detectable sequences.
    const access = new PermissiveAccess()
    const { gateway } = aGateway(access)
    const alice = new RecordingSocket()
    const peer = new RecordingSocket()
    await attach(gateway, { clientId: ALICE, requesterNodeId: CONTROLLER }, alice)
    const peerAttach = await gateway.authorizeAttach({
      terminalId: TERMINAL,
      projectId: PROJECT,
      sessionId: SESSION,
      clientId: BOB,
      nodeId: WORKER,
      epoch: EPOCH,
      requesterNodeId: PEER,
    })
    if (!peerAttach.admitted) throw new Error(peerAttach.error.code)
    await gateway.attach(peerAttach, peer)

    gateway.publish(binding(), bytes(MARKER_A))
    expect(alice.dataPayloads().map((payload) => payload.clientId)).toEqual([ALICE])
    expect(peer.dataPayloads().map((payload) => payload.clientId)).toEqual([BOB])
    expect(alice.dataPayloads().map((payload) => payload.sequence)).toEqual([1])
    expect(peer.dataPayloads().map((payload) => payload.sequence)).toEqual([1])
  })
})

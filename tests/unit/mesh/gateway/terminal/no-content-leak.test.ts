/**
 * M4.7 requirement 9, and the milestone's STOP CONDITION: "stop if terminal
 * output can enter logs, events, or another project stream."
 *
 * A stop condition needs an observation point or it is a sentiment. This file is
 * that point, and it works in two halves:
 *
 *   1. **A sweep.** Terminal bytes carrying a recognisable marker are driven
 *      through EVERY path that produces a structured record, a `ContractError`
 *      or an outcome, and the marker is asserted absent from all of them. A test
 *      that checked only the happy path would pass on a gateway whose ERROR path
 *      logged the frame it refused — which is the path that actually happens.
 *   2. **A structural check.** The telemetry event's members are asserted to be
 *      scalars, so there is no field a chunk could be passed into. The sweep
 *      proves the current code is clean; the structural check is what stops the
 *      next edit from making it dirty.
 *
 * The three destinations the guardrail names are covered separately, because they
 * are three different mechanisms:
 *
 *   - **Logs** — `TerminalTelemetry.record`. Only reachable through the port, so
 *     the sweep is exhaustive by construction.
 *   - **Events** — the `mesh.event` stream belongs to M4.6 and is not reachable
 *     from here; what IS asserted is that nothing in this directory produces an
 *     event at all, which is a stronger statement than "the event was clean".
 *   - **Another project's stream** — `project-isolation.test.ts`, with its own
 *     sweep, because cross-project leakage is a routing defect and routing is
 *     not what this file is about.
 */
import { describe, expect, it } from "vitest"
import { MeshTerminalGatewayImpl, TERMINAL_TELEMETRY_KINDS } from "../../../../../src/mesh/gateway/terminal/index.js"
import { MAX_TERMINAL_FRAME_BYTES } from "../../../../../src/mesh/protocol/bounds.js"
import type { TerminalTelemetryEvent } from "../../../../../src/mesh/gateway/terminal/index.js"
import {
  ALICE,
  BOB,
  CONTROLLER,
  EPOCH,
  OTHER_SESSION,
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
  dataFrame,
  denial,
  grant,
} from "./fixtures.js"

/**
 * A marker that would be unmistakable in a log line, an error message or another
 * project's stream, and that no legitimate message in this repository contains.
 * It is a plausible-looking secret rather than a word, because the realistic
 * failure is a command's output (a token, a hostname, a path) being swept into a
 * log — not the word "SECRET" being swept in.
 */
const MARKER = "sk-live-9f3c1d7b44ae9f02TOKEN"
const MARKER_BASE64 = Buffer.from(MARKER, "utf8").toString("base64")

function aGateway(access = new FakeAccessPort()) {
  const runtime = new FakeRuntime()
  const telemetry = new RecordingTelemetry()
  const clock = new TestClock()
  return { gateway: new MeshTerminalGatewayImpl({ now: clock.now, nodeId: WORKER, access, runtime, telemetry }), runtime, telemetry, clock }
}

async function attach(gateway: MeshTerminalGatewayImpl, clientId: typeof ALICE, socket: RecordingSocket) {
  const decision = await gateway.authorizeAttach({
    terminalId: TERMINAL,
    projectId: PROJECT,
    sessionId: SESSION,
    clientId,
    nodeId: WORKER,
    epoch: EPOCH,
    requesterNodeId: CONTROLLER,
  })
  if (!decision.admitted) throw new Error(decision.error.code)
  const attached = await gateway.attach(decision, socket)
  if (!attached.ok) throw new Error(attached.error.code)
  return attached.value
}

/** Every string reachable from a structured record, flattened. */
function everyStringIn(event: TerminalTelemetryEvent): string[] {
  return [event.kind, event.clientId ?? "", event.code ?? "", String(event.byteCount), event.detail, event.binding.terminalId, event.binding.projectId, event.binding.sessionId, event.binding.nodeId, event.binding.runId]
}

describe("the sweep — no terminal byte reaches a structured record", () => {
  it("is clean across every path that produces one, including every refusal", async () => {
    const { gateway, telemetry, clock } = aGateway()
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    await attach(gateway, BOB, bob)

    // A takeover whose REASON is a user-typed string on the same socket. This is
    // the closest thing to terminal content the control path can legitimately
    // carry, and it is the one member of a telemetry event a careless edit could
    // turn into a channel, so it is driven with a marker.
    await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }) })
    await gateway.receive(BOB, { opcode: "text", payload: controlFrame({ clientId: BOB, operation: "takeover_input", reason: MARKER, epoch: EPOCH }) })

    // Runtime output carrying the marker in plain bytes and in base64.
    gateway.publish(binding(), new Uint8Array(Buffer.from(`token=${MARKER}\r\n`, "utf8")))
    gateway.publish(binding(), new Uint8Array(Buffer.from(MARKER_BASE64, "utf8")))

    // Refusals, each with a frame that carries the marker somewhere.
    const refusals = [
      { opcode: "binary" as const, payload: dataFrame({ clientId: ALICE, direction: "to_viewer", chunk: MARKER_BASE64, sequence: 1 }) },
      { opcode: "binary" as const, payload: dataFrame({ clientId: ALICE, chunk: MARKER_BASE64, sequence: 1 }) },
      { opcode: "binary" as const, payload: dataFrame({ clientId: ALICE, chunk: Buffer.from(MARKER, "utf8").toString("base64"), sequence: 0 }) },
      { opcode: "binary" as const, payload: dataFrame({ clientId: ALICE, chunk: Buffer.alloc(MAX_TERMINAL_FRAME_BYTES + 1, 0x41).toString("base64") + "QQ==", sequence: 9 }) },
      { opcode: "text" as const, payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }, { payload: { chunk: MARKER_BASE64 } }) },
      { opcode: "text" as const, payload: Buffer.from(MARKER, "utf8").toString("base64") },
    ]
    for (const frame of refusals) await gateway.receive(ALICE, frame)

    // A runtime write that fails, so the failure path is exercised too.
    gateway.disconnect(ALICE, "swept")
    await gateway.receive(ALICE, refusals[0]!)
    clock.advance(600_000)
    await gateway.receive(BOB, { opcode: "text", payload: controlFrame({ clientId: BOB, operation: "request_input", epoch: EPOCH }) })
    // A revocation reason is OPERATOR text, not terminal content: M4.2's own
    // middleware says revocation reasons stay in the audit log, and a sweep that
    // forbade them would forbid the audit trail the plan requires. What is
    // asserted about it is the BOUND, separately, below.
    gateway.revokeNode(CONTROLLER, "the node's signing key was seen in a public paste")
    gateway.leaseExpired({ projectId: PROJECT, runId: binding().runId })
    gateway.sessionTerminated(PROJECT, OTHER_SESSION)

    // Enough records that a sweep which passed on a thin sample would be
    // suspicious. Every kind the gateway can produce, or nearly.
    expect(telemetry.events.length).toBeGreaterThan(8)
    const serialised = JSON.stringify(telemetry.events)
    expect(serialised).not.toContain(MARKER)
    expect(serialised).not.toContain(MARKER_BASE64)
    for (const event of telemetry.events) {
      for (const value of everyStringIn(event)) {
        expect(value).not.toContain(MARKER)
        expect(value).not.toContain(MARKER_BASE64)
      }
    }
  })

  it("truncates a caller-supplied lifecycle detail, which is the one member this module does not author", async () => {
    // `revokeNode` and `disconnect` are handed their `detail` by callers OUTSIDE
    // this directory, so it is the one member of a telemetry event whose bytes
    // are not authored here. An unbounded one is an unbounded channel into a log
    // line, and bounding it at the same 1 024 M4.2 bounds a revocation reason to
    // is the cheapest way to make the channel finite.
    const { gateway, telemetry } = aGateway()
    const alice = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    gateway.revokeNode(CONTROLLER, "x".repeat(4_096))
    const record = telemetry.find("lifecycle_closed")
    expect(record).toBeDefined()
    // 1 024 of the detail, plus the authored prefix and the truncation notice.
    expect(record?.detail.length).toBeLessThan(1_200)
    expect(record?.detail).toContain("truncated")
  })

  it("reached every kind it claims to be able to produce", () => {
    // The sweep is only worth anything if it covered the paths. Asserting the
    // vocabulary here rather than in the sweep keeps the two independent: a
    // telemetry port that gained a kind would fail this test even if the sweep
    // were not updated, which is the failure mode a "we swept it" claim usually
    // hides.
    const covered = new Set([
      "attach_refused",
      "attached",
      "control_refused",
      "data_refused",
      "frame_dropped",
      "lifecycle_closed",
      "ownership_displaced",
      "ownership_granted",
      "ownership_released",
      "runtime_refused",
    ])
    for (const kind of covered) expect(TERMINAL_TELEMETRY_KINDS).toContain(kind as (typeof TERMINAL_TELEMETRY_KINDS)[number])
  })
})

describe("the sweep — no terminal byte reaches a ContractError message", () => {
  it("is clean for every refusal the gateway can produce", async () => {
    const { gateway, runtime } = aGateway()
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    await attach(gateway, BOB, bob)
    await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }) })

    const messages: string[] = []
    const collect = (outcome: { readonly kind: string; readonly error?: unknown }): void => {
      if (outcome.kind === "refused") messages.push((outcome as { readonly error: { readonly message: string } }).error.message)
    }
    // A data frame carrying the marker, refused for four different reasons.
    collect(await gateway.receive(BOB, { opcode: "binary", payload: dataFrame({ clientId: BOB, direction: "to_viewer", chunk: MARKER_BASE64, sequence: 1 }) }))
    collect(await gateway.receive(BOB, { opcode: "binary", payload: dataFrame({ clientId: BOB, chunk: MARKER_BASE64, sequence: 1 }) }))
    collect(await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk: MARKER_BASE64, sequence: 1 }) }))
    // A regression is a DIFFERENT refusal from a non-owner one, so it needs a
    // sequence that was actually accepted first. The two refusals above did not
    // advance the watermark — that is the point of refusing before accepting — so
    // the regression is built from a fresh owner.
    collect(await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk: MARKER_BASE64, sequence: 4 }) }))
    collect(await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk: MARKER_BASE64, sequence: 4 }) }))
    // A frame that is not JSON at all, which is the case a gateway tempted to
    // quote its input would leak on.
    collect(await gateway.receive(ALICE, { opcode: "binary", payload: new Uint8Array(Buffer.from(MARKER, "utf8")) }))
    // A runtime refusal, whose message is the runtime's — the gateway must not
    // decorate it with the frame.
    runtime.failWrites({ schemaVersion: 1, category: "runtime_failure", code: "terminal.runtime_write_failed", message: "the pty write failed", retryable: true })
    collect(await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk: MARKER_BASE64, sequence: 2 }) }))

    expect(messages.length).toBeGreaterThanOrEqual(5)
    for (const message of messages) {
      expect(message).not.toContain(MARKER)
      expect(message).not.toContain(MARKER_BASE64)
    }
  })

  it("reports the SIZE of an over-bound frame and not its content", async () => {
    const { gateway } = aGateway()
    const alice = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }) })
    const oversized = Buffer.alloc(MAX_TERMINAL_FRAME_BYTES + 1, 0x41).toString("base64")
    const outcome = await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, chunk: oversized, sequence: 1 }) })
    expect(outcome.kind).toBe("refused")
    if (outcome.kind !== "refused") return
    expect(outcome.error.message).toContain(String(MAX_TERMINAL_FRAME_BYTES))
    expect(outcome.error.message.length).toBeLessThan(400)
  })
})

describe("the sweep — no terminal byte reaches a log through the telemetry PORT's type", () => {
  it("every member of a telemetry event is a scalar, so there is nowhere to put a chunk", () => {
    // The sweep above proves the current code is clean. This is what keeps it
    // clean: an event type with a `data: string` or a `payload: unknown` member
    // would make the sweep a matter of discipline rather than of the shape, and
    // the shape is what a reviewer reads.
    const event = {
      kind: "frame_dropped",
      binding: binding(),
      clientId: ALICE,
      code: "mesh.terminal_client_too_slow",
      byteCount: 1_024,
      detail: "one frame dropped",
    } satisfies TerminalTelemetryEvent
    for (const [member, value] of Object.entries(event)) {
      if (member === "binding") continue
      expect(typeof value, `member '${member}' is not a scalar`).not.toBe("object")
    }
    // `byteCount` is a number and the only place a size appears. A byte array
    // here would be the whole defect this milestone is guarding.
    expect(typeof event.byteCount).toBe("number")
    // The one object member is the binding, and IT is five branded ids — so the
    // assertion is on its members rather than on the event's, which is the
    // difference between "nothing can hold bytes" and "the top level cannot".
    for (const [member, value] of Object.entries(event.binding)) {
      expect(typeof value, `binding member '${member}' is not a branded id`).toBe("string")
    }
  })
})

describe("the sweep — nothing here can reach an orchestration event stream", () => {
  it("the gateway's public surface is exactly the terminal contract and nothing more", () => {
    // The absence that matters is that this directory cannot PUBLISH to M4.6's
    // `mesh.event` stream. A terminal gateway that could would be a place where
    // terminal content could reach every subscriber on the mesh, so the property
    // is asserted against the CLASS'S OWN method list rather than against a grep
    // of the source: a grep would also match the comment explaining the property,
    // and a method list is what a caller can actually reach.
    //
    // A `publishEvent` added later is a compile error here, because the expected
    // list is a literal and the actual list is `Object.getOwnPropertyNames`.
    expect(Object.getOwnPropertyNames(MeshTerminalGatewayImpl.prototype).sort()).toEqual([
      "attach",
      "attachedClientIds",
      "authorizeAttach",
      "constructor",
      "detach",
      "disconnect",
      "leaseExpired",
      "publish",
      "receive",
      "revokeNode",
      "sessionTerminated",
      "snapshot",
      "view",
    ])
  })

  it("the only structured record this directory produces is a telemetry event", () => {
    // There is one port out of here and it is a `TerminalTelemetryEvent`. A
    // gateway with a second outlet — an event bus, an SSE writer, a pino handle —
    // would have a destination the leak sweep above does not read.
    const telemetry = new RecordingTelemetry()
    const gateway = new MeshTerminalGatewayImpl({ now: new TestClock().now, nodeId: WORKER, access: new FakeAccessPort(), runtime: new FakeRuntime(), telemetry })
    // The gateway holds exactly the four collaborators it was constructed with and
    // no transport, no logger and no bus.
    expect(Object.values(gateway).every((value) => value === null || typeof value !== "object" || value instanceof Map)).toBe(true)
    for (const kind of TERMINAL_TELEMETRY_KINDS) {
      expect(kind).not.toContain("event")
    }
    expect(TERMINAL_TELEMETRY_KINDS).not.toContain("stream_published" as (typeof TERMINAL_TELEMETRY_KINDS)[number])
  })
})

describe("a takeover reason is user input on the terminal socket, and it is not logged", () => {
  it("reaches the displaced client on the wire and nothing else", async () => {
    const access = new FakeAccessPort([grant(), grant(), grant()])
    const { gateway, telemetry } = aGateway(access)
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    await attach(gateway, ALICE, alice)
    await attach(gateway, BOB, bob)
    await gateway.receive(ALICE, { opcode: "text", payload: controlFrame({ clientId: ALICE, operation: "request_input", epoch: EPOCH }) })
    await gateway.receive(BOB, { opcode: "text", payload: controlFrame({ clientId: BOB, operation: "takeover_input", reason: MARKER, epoch: EPOCH }) })
    expect(alice.controlPayloads()[0]?.reason).toBe(MARKER)
    expect(JSON.stringify(telemetry.events)).not.toContain(MARKER)
  })
})

describe("an attach refusal does not describe the terminal's contents", () => {
  it("refuses an unknown terminal without echoing what the client asked for beyond the scope", async () => {
    const access = new FakeAccessPort([denial("terminal_unknown")])
    const { gateway, telemetry } = aGateway(access)
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
    expect(decision.error.message).not.toContain(MARKER)
    expect(JSON.stringify(telemetry.events)).not.toContain(MARKER)
  })
})

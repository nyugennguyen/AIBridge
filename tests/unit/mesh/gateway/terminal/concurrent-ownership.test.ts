/**
 * M4.10 findings M4.10-T1 and M4.10-T2 — two concurrency defects in the terminal
 * gateway that the existing suite could not see.
 *
 * Both were found by the M4.10 audit and both are demonstrated here rather than
 * argued. Neither reproduces under `bun test`, which is the point: a defect that
 * only appears on one runtime is still a defect, and the existing "one input
 * owner" tests missed both because they `await` each frame in turn, which is
 * exactly the discipline the gateway cannot rely on a real socket to supply.
 *
 * **M4.10-T1 — frames from one client were not processed in order.**
 * `request_input` immediately followed by `resize` — two `socket.send` calls back
 * to back, which is what a TUI does when a user types and then drags the window
 * edge — were processed CONCURRENTLY, because `receive` was an `async` method the
 * route called with `void`. The `resize` reached `#resize` before the ownership
 * grant landed and was refused `terminal.not_input_owner`. Reproduced 6/6 under
 * `vitest` in `tests/integration/terminal-websocket.test.ts`:
 * `expected [] to deeply equal [ { rows: 50, columns: 132 } ]`.
 *
 * **M4.10-T2 — two clients could BOTH hold input ownership.**
 * `#requestInput` read `terminal.inputOwner`, found it `null`, and then `await`ed
 * the access port before writing the grant. Two clients doing that concurrently
 * both read `null`, both awaited, both wrote. `inputOwner` ended up naming one of
 * them while BOTH held `client.owner === true`, so BOTH could type into the pty —
 * which is the plan's "allow multiple viewers but one input owner" violated, and
 * the milestone's stop condition ("terminal output can enter … another project
 * stream" has a sibling here: one pty, two typists, no record of which).
 *
 * Note that T2 is NOT closed by the per-client serialization T1 needed. The two
 * clients are different clients, so their frames are on different chains by
 * design; the exclusivity has to come from a compare-and-set on the grant.
 */
import { describe, expect, it } from "vitest"
import { MeshTerminalGatewayImpl } from "../../../../../src/mesh/gateway/terminal/index.js"
import type { TerminalAccessOutcome, TerminalAccessPort } from "../../../../../src/mesh/gateway/terminal/index.js"
import type { MeshTerminalControl } from "../../../../../src/mesh/protocol/terminal.js"
import {
  ALICE,
  BOB,
  CONTROLLER,
  EPOCH,
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
  grant,
} from "./fixtures.js"

function aGateway(access: TerminalAccessPort, runtime = new FakeRuntime(), clock = new TestClock()) {
  const telemetry = new RecordingTelemetry()
  return { gateway: new MeshTerminalGatewayImpl({ now: clock.now, nodeId: WORKER, access, runtime, telemetry }), runtime, telemetry }
}

async function attach(gateway: MeshTerminalGatewayImpl, clientId: typeof ALICE) {
  const decision = await gateway.authorizeAttach({
    terminalId: TERMINAL,
    projectId: PROJECT,
    sessionId: SESSION,
    clientId,
    nodeId: WORKER,
    epoch: EPOCH,
    requesterNodeId: CONTROLLER,
  })
  if (!decision.admitted) throw new Error(`attach refused: ${decision.error.code}`)
  const attached = await gateway.attach(decision, new RecordingSocket())
  if (!attached.ok) throw new Error(`attach failed: ${attached.error.code}`)
}

/**
 * A control request from `clientId`.
 *
 * `operation` is typed as the protocol's own union rather than `string`, so a test
 * cannot name an operation the wire does not have. Typed loosely it would compile
 * and fail at runtime inside `controlFrame` — which is the shape of a test that
 * passes for the wrong reason: the assertion it fails on is the one about
 * ownership, not the one about the operation being real.
 */
const ask = (
  clientId: typeof ALICE,
  operation: MeshTerminalControl["operation"],
  extra: Record<string, unknown> = {},
) => ({
  opcode: "text" as const,
  payload: controlFrame({ clientId, operation, epoch: EPOCH, ...extra }),
})

/**
 * An access port whose answer arrives a turn LATER.
 *
 * This is not a contrived shape: the production port resolves the registry, the
 * recorded session projection and the lease, and every one of those is an
 * `await`. A port that answered synchronously would make both defects invisible,
 * which is why the existing `FakeAccessPort` — which is synchronous behind its
 * `async` signature — could not see them.
 */
class SlowAccessPort extends FakeAccessPort {
  constructor(private readonly ms = 5) {
    super()
  }

  override async authorize(): Promise<TerminalAccessOutcome> {
    await new Promise((resolve) => setTimeout(resolve, this.ms))
    return grant({ ...binding(), terminalId: TERMINAL })
  }
}

describe("M4.10-T1: one client's frames are decided in the order it sent them", () => {
  it("a request_input followed immediately by a resize grants then resizes", async () => {
    // The attack as a real TUI performs it: two `socket.send` calls with no gap.
    // Neither is awaited by the route (`void gateway.receive(...)`), so the
    // gateway is responsible for the ordering.
    const { gateway, runtime } = aGateway(new SlowAccessPort())
    await attach(gateway, ALICE)

    const requested = gateway.receive(ALICE, ask(ALICE, "request_input"))
    const resized = gateway.receive(ALICE, ask(ALICE, "resize", { rows: 50, cols: 132 }))
    const [grantOutcome, resizeOutcome] = await Promise.all([requested, resized])

    expect(grantOutcome.kind).toBe("accepted")
    // WITHOUT the fix this is `refused` / `terminal.not_input_owner`: the resize
    // was decided before the grant it depends on.
    expect(resizeOutcome.kind).toBe("accepted")
    expect(runtime.resizes).toEqual([{ rows: 50, columns: 132 }])
  })

  it("a displaced client's keystrokes are refused, and the new owner's land in order", async () => {
    // The mirror of the resize case, and the direction that matters for
    // correctness: a displaced client must not slip keystrokes in behind its own
    // displacement, and the client that did the taking must be able to type
    // immediately afterwards.
    const { gateway, runtime } = aGateway(new SlowAccessPort())
    await attach(gateway, ALICE)
    await attach(gateway, BOB)
    expect((await gateway.receive(ALICE, ask(ALICE, "request_input"))).kind).toBe("accepted")

    // BOB takes the keyboard and types, with no gap between the two calls. The
    // per-client chain is what makes the keystroke land AFTER the grant it
    // depends on; without it the data frame is decided while `inputOwner` is
    // still ALICE and is refused.
    const took = gateway.receive(BOB, ask(BOB, "takeover_input", { reason: "operator" }))
    const typed = gateway.receive(BOB, { opcode: "binary", payload: dataFrame({ clientId: BOB, sequence: 1 }) })
    const [takeover, bobTyping] = await Promise.all([took, typed])

    expect(takeover.kind).toBe("accepted")
    expect(bobTyping.kind).toBe("accepted")

    // And the client that WAS displaced cannot type at all.
    const aliceTyping = await gateway.receive(ALICE, { opcode: "binary", payload: dataFrame({ clientId: ALICE, sequence: 1 }) })
    expect(aliceTyping.kind).toBe("refused")
    if (aliceTyping.kind !== "refused") return
    expect(aliceTyping.code).toBe("terminal.not_input_owner")
    // Exactly BOB's keystroke reached the pty, and ALICE's did not.
    expect(runtime.inputs).toHaveLength(1)
    expect(runtime.writes.filter((write) => write.kind === "input")[0]?.request.clientId).toBe(BOB)
  })
})

describe("M4.10-T2: two clients cannot both hold input ownership", () => {
  it("two concurrent request_input frames grant the keyboard to exactly one", async () => {
    const { gateway, runtime } = aGateway(new SlowAccessPort())
    await attach(gateway, ALICE)
    await attach(gateway, BOB)

    const [a, b] = await Promise.all([
      gateway.receive(ALICE, ask(ALICE, "request_input")),
      gateway.receive(BOB, ask(BOB, "request_input")),
    ])

    // The invariant is one grant, one refusal. WITHOUT the compare-and-set both
    // are `accepted` and `inputOwner` names whichever wrote last.
    const outcomes = [a.kind, b.kind].sort()
    expect(outcomes).toEqual(["accepted", "refused"])
    const refused = a.kind === "refused" ? a : b
    if (refused.kind !== "refused") return
    expect(refused.code).toBe("terminal.input_owned")
  })

  it("and only the winner can type — the loser's bytes never reach the pty", async () => {
    // The consequence the first test exists to prevent, asserted directly: with
    // two accepted grants, BOTH clients type and the pty receives two writers.
    const { gateway, runtime } = aGateway(new SlowAccessPort())
    await attach(gateway, ALICE)
    await attach(gateway, BOB)

    const [a, b] = await Promise.all([
      gateway.receive(ALICE, ask(ALICE, "request_input")),
      gateway.receive(BOB, ask(BOB, "request_input")),
    ])
    const winner = a.kind === "accepted" ? ALICE : BOB
    const loser = winner === ALICE ? BOB : ALICE

    // `view` names exactly one owner, and it is the one whose request was
    // accepted.
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(winner)

    const [winning, losing] = await Promise.all([
      gateway.receive(winner, { opcode: "binary", payload: dataFrame({ clientId: winner, sequence: 1 }) }),
      gateway.receive(loser, { opcode: "binary", payload: dataFrame({ clientId: loser, sequence: 1 }) }),
    ])
    expect(winning.kind).toBe("accepted")
    expect(losing.kind).toBe("refused")
    if (losing.kind !== "refused") return
    expect(losing.code).toBe("terminal.not_input_owner")
    // ONE writer at the pty, which is the whole of the plan's rule.
    // ONE writer at the pty, which is the whole of the plan's rule. The
    // `writes` log is the observable half: it records the client id of every
    // request that reached the runtime, so "exactly one typist" is a statement
    // about the pty rather than about a field.
    expect(runtime.inputs).toHaveLength(1)
    expect(runtime.writes.filter((write) => write.kind === "input")).toHaveLength(1)
    expect(runtime.writes.filter((write) => write.kind === "input")[0]?.request.clientId).toBe(winner)
  })

  it("the loser is told WHO holds it, so a client knows a takeover is the operation it needs", async () => {
    const { gateway } = aGateway(new SlowAccessPort())
    await attach(gateway, ALICE)
    await attach(gateway, BOB)
    const [a, b] = await Promise.all([
      gateway.receive(ALICE, ask(ALICE, "request_input")),
      gateway.receive(BOB, ask(BOB, "request_input")),
    ])
    const refused = a.kind === "refused" ? a : b
    if (refused.kind !== "refused") return
    const holder = gateway.view(TERMINAL)?.inputOwnerClientId
    expect(refused.error.message).toContain(String(holder))
  })

  it("a client that already holds the keyboard still re-asserts idempotently after an await", async () => {
    // The compare-and-set must not turn a lost reply into a lost keyboard. A
    // client whose retry arrives after its own first request is still the holder,
    // and telling it otherwise would push clients into takeover loops against
    // themselves.
    const { gateway } = aGateway(new SlowAccessPort())
    await attach(gateway, ALICE)
    expect((await gateway.receive(ALICE, ask(ALICE, "request_input"))).kind).toBe("accepted")
    const again = await gateway.receive(ALICE, ask(ALICE, "request_input"))
    expect(again.kind).toBe("accepted")
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)
  })

  it("an EXPLICIT takeover still displaces the holder, and notifies it", async () => {
    // The compare-and-set closes the race without closing the operation: two
    // clients racing for a FREE terminal, one wins; a client that means it can
    // still take the keyboard from the winner.
    const { gateway, telemetry } = aGateway(new SlowAccessPort())
    const alice = new RecordingSocket()
    const bob = new RecordingSocket()
    for (const [clientId, socket] of [[ALICE, alice], [BOB, bob]] as const) {
      const decision = await gateway.authorizeAttach({
        terminalId: TERMINAL, projectId: PROJECT, sessionId: SESSION, clientId,
        nodeId: WORKER, epoch: EPOCH, requesterNodeId: CONTROLLER,
      })
      if (!decision.admitted) throw new Error("attach refused")
      await gateway.attach(decision, socket)
    }
    const [a, b] = await Promise.all([
      gateway.receive(ALICE, ask(ALICE, "request_input")),
      gateway.receive(BOB, ask(BOB, "request_input")),
    ])
    const winner = a.kind === "accepted" ? ALICE : BOB
    const loser = winner === ALICE ? BOB : ALICE
    const took = await gateway.receive(loser, ask(loser, "takeover_input", { reason: "operator asked" }))
    expect(took.kind).toBe("accepted")
    expect(gateway.view(TERMINAL)?.inputOwnerClientId).toBe(loser)
    expect(telemetry.find("ownership_displaced")).toBeDefined()
  })
})

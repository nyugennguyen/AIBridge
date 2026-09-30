/**
 * M4.7 requirement 3 — control frames and terminal data are DISTINCT schemas,
 * and neither parser accepts the other.
 *
 * The protocol's own module states why (§4.9, and the note at the top of
 * `src/mesh/protocol/terminal.ts`): a union with an ambiguous discriminator means
 * every reader has to decide which arm it holds before it can read a field, and
 * a reader that guesses wrong either drops terminal bytes into a control
 * handler's log line or drops a resize into the byte path.
 *
 * Each direction of the confusion has a different consequence, and that is why
 * both are asserted rather than one:
 *
 *   - A DATA record arriving as TEXT is terminal CONTENT that has been put
 *     through a control handler. The handler has a `ContractError` message, a
 *     `detail` string and a structured log record, and the milestone's stop
 *     condition is exactly that terminal content reaching any of them.
 *   - A CONTROL record arriving as BINARY is an INSTRUCTION that reached a
 *     handler meant for bytes. It is the more dangerous of the two, because the
 *     handler is the one that acts.
 *
 * The opcode is the cheap half of the separation and `recordType` is the half
 * that survives a re-framing proxy, so both are tested. Nothing here opens a
 * socket: the codec is a pure function by construction, which is the reason the
 * plan's `injectWS` tests could be met in substance at all
 * (`Docs/implementation-plans/websocket-test-harness.md` §1).
 */
import { describe, expect, it } from "vitest"
import { decodeTerminalFrame } from "../../../../../src/mesh/gateway/terminal/index.js"
import { ALICE, BOB, TERMINAL, controlFrame, dataFrame, text } from "./fixtures.js"

describe("a control frame travels as text", () => {
  it("decodes a mesh.terminal.control envelope on the text opcode", () => {
    const decoded = decodeTerminalFrame({ opcode: "text", payload: controlFrame({ operation: "request_input" }) })
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || decoded.value.family !== "control") return
    // Narrowed to the control arm before the payload is read, which is the
    // discipline the gateway itself follows: a reader that has not chosen an arm
    // cannot read a field, and that is exactly the property requirement 3 buys.
    expect(decoded.value.payload.operation).toBe("request_input")
  })
})

describe("a data record in a text frame is refused before any control handler sees it", () => {
  it("reports the family mismatch rather than parsing the payload as a control frame", () => {
    // Built as a data record and then sent through the TEXT opcode, which is
    // exactly what a confused client does when it writes terminal bytes into a
    // control slot. The refusal is the property: nothing downstream ever holds
    // the `chunk`.
    const decoded = decodeTerminalFrame({ opcode: "text", payload: text(dataFrame()) })
    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.error.code).toBe("terminal.frame_family_mismatch")
    expect(decoded.error.message).toContain("mesh.terminal.data")
    expect(decoded.error.message).toContain("mesh.terminal.control")
  })

  it("never echoes the chunk it refused", () => {
    const marker = "TERMINAL-CONTENT-MARKER-3f9a"
    const decoded = decodeTerminalFrame({ opcode: "text", payload: text(dataFrame({ chunk: Buffer.from(marker).toString("base64") })) })
    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.error.message).not.toContain(marker)
    expect(decoded.error.message).not.toContain(Buffer.from(marker).toString("base64"))
  })
})

describe("a control record in a binary frame is refused", () => {
  it("reports the same code with the directions swapped", () => {
    const decoded = decodeTerminalFrame({ opcode: "binary", payload: new Uint8Array(Buffer.from(controlFrame({ operation: "takeover_input", reason: "operator asked" }), "utf8")) })
    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.error.code).toBe("terminal.frame_family_mismatch")
    expect(decoded.error.message).toContain("binary")
  })
})

describe("a data frame travels as binary", () => {
  it("decodes a mesh.terminal.data envelope and hands back the chunk untouched", () => {
    const chunk = Buffer.from("$ ls -la\r\n", "utf8").toString("base64")
    const decoded = decodeTerminalFrame({ opcode: "binary", payload: dataFrame({ chunk, sequence: 7 }) })
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.value.family).toBe("data")
    if (decoded.value.family !== "data") return
    expect(decoded.value.payload.chunk).toBe(chunk)
    expect(decoded.value.payload.sequence).toBe(7)
    expect(Buffer.from(decoded.value.payload.chunk, "base64").toString("utf8")).toBe("$ ls -la\r\n")
  })
})

describe("a frame that is not a mesh record at all is refused before any family is chosen", () => {
  it("refuses non-JSON without reporting the bytes", () => {
    const marker = "TERMINAL-CONTENT-MARKER-b71c"
    const decoded = decodeTerminalFrame({ opcode: "binary", payload: new Uint8Array(Buffer.from(marker, "utf8")) })
    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.error.code).toBe("terminal.frame_not_json")
    expect(decoded.error.message).not.toContain(marker)
  })
})

describe("a frame whose recordType was swapped is refused by the versioned parser, not by the opcode check", () => {
  it("refuses a control payload wearing the data family's recordType", () => {
    // The opcode check would call this "a data record on a text frame", and it
    // would be right about the mismatch. It never gets there: the ONE parse
    // entry point reads `recordType` first, chooses the DATA shape, and the
    // control payload fails it. That ordering is M4-V's whole mechanism — a node
    // must never partially read a record whose declared shape it does not hold —
    // and it is why the error is a parse failure rather than a family mismatch.
    const decoded = decodeTerminalFrame({
      opcode: "text",
      payload: controlFrame({ operation: "takeover_input", reason: "operator asked" }, { recordType: "mesh.terminal.data" }),
    })
    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.error.code).toBe("protocol.record_invalid")
    expect(decoded.error.message).not.toContain("operator asked")
  })
})

describe("the two families cannot be confused by an id that names the other", () => {
  it("a control frame for client B is still a control frame, and the gateway is what binds it", () => {
    // The codec's job ends at "this is a control frame". Whether it is a control
    // frame FOR THIS CLIENT is a decision the gateway makes against the
    // attachment, and a codec that tried to make it would need state it does not
    // have. This asserts the boundary rather than restating it: the frame parses,
    // and the clientId is whatever the sender said.
    const decoded = decodeTerminalFrame({ opcode: "text", payload: controlFrame({ clientId: BOB, operation: "request_input" }) })
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || decoded.value.family !== "control") return
    expect(decoded.value.payload.clientId).toBe(BOB)
    expect(decoded.value.payload.terminalId).toBe(TERMINAL)
  })
})

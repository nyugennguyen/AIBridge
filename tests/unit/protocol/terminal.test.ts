import { describe, expect, it } from "vitest"
import { safeParseMeshEnvelope } from "../../../src/mesh/protocol/registry.js"
import {
  MAX_TERMINAL_BUFFER_BYTES,
  MAX_TERMINAL_FRAME_BYTES,
  MAX_TERMINAL_FRAMES_PER_SECOND,
  MAX_VIEWERS_PER_TERMINAL,
} from "../../../src/mesh/protocol/bounds.js"
import {
  TERMINAL_OPERATIONS,
  checkTerminalAdmission,
  evaluateBufferPressure,
  evaluateFrameRate,
  evaluateFrameSize,
  evaluateViewerCount,
  framesToDrop,
  terminalControlSchema,
  terminalDataSchema,
} from "../../../src/mesh/protocol/terminal.js"
import { decodedBase64Bytes } from "../../../src/mesh/protocol/identifiers.js"
import {
  EPOCH,
  OTHER_WORKER_ID,
  rawEnvelope,
  sampleEnvelope,
  terminalControlPayload,
  terminalDataPayload,
  WORKER_ID,
} from "./fixtures.js"

/**
 * §4.9 of the spec, and the Terminal Stream Guardrails of the plan.
 *
 * Two things are being defended here, and the milestone calls the second of them
 * a STOP CONDITION rather than a bug:
 *
 *   1. control and data are SEPARATE SCHEMAS with separate `recordType` values.
 *      A union with an ambiguous discriminator makes every reader decide which
 *      arm it holds before it can read a field, and a reader that decides wrong
 *      either drops terminal bytes into a control handler's log line or drops a
 *      resize into the byte path. The two schemas are asserted to reject each
 *      other's payloads directly, which is the only way that property is more
 *      than a naming convention.
 *
 *   2. TERMINAL CONTENT APPEARS NOWHERE ELSE. Not in a `mesh.event`, not in a
 *      `ContractError` message, not in a log line. Every refusal below reports
 *      the SIZE of a frame and never its bytes, and the test file asserts that
 *      property of the messages themselves rather than trusting the comment.
 */

function base64Of(byteLength: number): string {
  return Buffer.alloc(byteLength, 0x61).toString("base64")
}

describe("control frames and data frames are separate types", () => {
  it("parses each through its own record type", () => {
    for (const recordType of ["mesh.terminal.control", "mesh.terminal.data"] as const) {
      const safe = safeParseMeshEnvelope(sampleEnvelope(recordType))
      expect(safe.ok, recordType).toBe(true)
      if (!safe.ok) continue
      expect(safe.value.schemaVersion).toBe(2)
      expect(safe.value.recordType).toBe(recordType)
    }
  })

  it("refuses a data frame in the control schema and a control frame in the data schema", () => {
    // The negative that a union cannot express. If either arm accepted the
    // other, a reader that dispatched on the wrong arm would parse a record and
    // then read the wrong fields out of it.
    expect(terminalControlSchema.safeParse(terminalDataPayload()).success).toBe(false)
    expect(terminalDataSchema.safeParse(terminalControlPayload()).success).toBe(false)
    // And at the registry, which is where a real misdispatch would land.
    expect(safeParseMeshEnvelope(rawEnvelope("mesh.terminal.control", terminalDataPayload(), { correlationId: "client-1" })).ok).toBe(false)
    expect(safeParseMeshEnvelope(rawEnvelope("mesh.terminal.data", terminalControlPayload(), { correlationId: "client-1" })).ok).toBe(false)
  })

  it("refuses a terminal record that claims a discriminator instead of a record type", () => {
    // A `kind: "control"` member on a data frame is the union shape arriving as
    // an object, and `.strict()` is what makes it a refusal rather than an
    // ignored extra.
    expect(safeParseMeshEnvelope(rawEnvelope("mesh.terminal.data", { ...terminalDataPayload(), kind: "control" }, { correlationId: "client-1" })).ok).toBe(false)
  })

  it("covers every operation the control vocabulary declares", () => {
    expect([...TERMINAL_OPERATIONS].sort()).toEqual([
      "attach",
      "detach",
      "release_input",
      "request_input",
      "resize",
      "takeover_input",
    ])
  })
})

describe("control frame invariants", () => {
  it("requires both dimensions on a resize and forbids them anywhere else", () => {
    // A half-resize is a corrupt pty size; a size on an `attach` is a field the
    // control path has no use for and a future reader could misread.
    expect(() => terminalControlSchema.parse(terminalControlPayload({ operation: "resize", rows: 40 }))).toThrow(/rows/)
    expect(terminalControlSchema.parse(terminalControlPayload({ operation: "resize", rows: 40, cols: 120 })).rows).toBe(40)
    expect(() => terminalControlSchema.parse(terminalControlPayload({ operation: "attach", rows: 40, cols: 120 }))).toThrow(/resize/)
  })

  it("bounds rows and cols, because a resize is an allocation request", () => {
    expect(() => terminalControlSchema.parse(terminalControlPayload({ operation: "resize", rows: 1_000_000, cols: 120 }))).toThrow()
    expect(() => terminalControlSchema.parse(terminalControlPayload({ operation: "resize", rows: 40, cols: 0 }))).toThrow()
  })

  it("requires a reason on an input takeover and forbids one elsewhere", () => {
    // The displaced client is notified with the reason, so a takeover without one
    // cannot be surfaced; a reason on any other operation is a field whose
    // meaning differs per operation, which is how one field becomes two.
    expect(() => terminalControlSchema.parse(terminalControlPayload({ operation: "takeover_input" }))).toThrow(/reason/)
    expect(terminalControlSchema.parse(terminalControlPayload({ operation: "takeover_input", reason: "operator asked" })).reason).toBe("operator asked")
    expect(() => terminalControlSchema.parse(terminalControlPayload({ operation: "attach", reason: "hello" }))).toThrow(/reason/)
  })

  it("carries the controller epoch on EVERY control frame, not only on the request", () => {
    // A `takeover_input` arriving after a lease expiry has to be refusable on the
    // same evidence as the request that preceded it, and a frame with no epoch
    // is a frame the gateway can only check against whatever it last saw.
    for (const operation of TERMINAL_OPERATIONS) {
      const frame = {
        operation,
        ...(operation === "takeover_input" ? { reason: "operator asked" } : {}),
        // A resize is the one operation with its own required members, so it
        // gets them; the assertion below is about the epoch, not the size.
        ...(operation === "resize" ? { rows: 40, cols: 120 } : {}),
      }
      expect(terminalControlSchema.parse(terminalControlPayload(frame)).epoch, operation).toBe(EPOCH)
      const { epoch: _omitted, ...withoutEpoch } = terminalControlPayload(frame)
      expect(terminalControlSchema.safeParse(withoutEpoch).success, operation).toBe(false)
    }
  })

  it("addresses a control frame to the node holding the runtime", () => {
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.terminal.control", { recipientNodeId: OTHER_WORKER_ID })).ok).toBe(false)
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.terminal.control", { recipientNodeId: null })).ok).toBe(true)
  })
})

describe("data frame invariants", () => {
  it("requires base64 with the single declared encoding", () => {
    // A single-member literal, so a second encoding is a version bump rather
    // than a second meaning on the same value.
    expect(() => terminalDataSchema.parse(terminalDataPayload({ encoding: "utf8" }))).toThrow()
    expect(terminalDataSchema.parse(terminalDataPayload({ encoding: "base64" })).encoding).toBe("base64")
    expect(() => terminalDataSchema.parse(terminalDataPayload({ chunk: "not base64!" }))).toThrow()
  })

  it("refuses an empty chunk, which only costs a sequence number", () => {
    expect(() => terminalDataSchema.parse(terminalDataPayload({ chunk: "" }))).toThrow(/empty/)
  })

  it("bounds the DECODED frame size, and decides it without decoding the bytes", () => {
    // Decoding first means allocating the attacker's bytes in order to discover
    // they are too large, which is the exhaustion the bound exists to prevent.
    const atBound = base64Of(MAX_TERMINAL_FRAME_BYTES)
    expect(decodedBase64Bytes(atBound)).toBe(MAX_TERMINAL_FRAME_BYTES)
    expect(terminalDataSchema.safeParse(terminalDataPayload({ chunk: atBound })).success).toBe(true)
    expect(() => terminalDataSchema.parse(terminalDataPayload({ chunk: base64Of(MAX_TERMINAL_FRAME_BYTES + 1) }))).toThrow(/65536 byte bound/)
  })

  it("measures the string, not the decoded buffer, when it refuses", () => {
    const chunk = base64Of(MAX_TERMINAL_FRAME_BYTES + 1)
    const parsed = terminalDataSchema.safeParse(terminalDataPayload({ chunk }))
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues[0]?.message).toContain(`${MAX_TERMINAL_FRAME_BYTES + 1} bytes`)
  })

  it("keeps a one-based per-client sequence", () => {
    expect(() => terminalDataSchema.parse(terminalDataPayload({ sequence: 0 }))).toThrow()
    expect(terminalDataSchema.parse(terminalDataPayload({ sequence: 2 })).sequence).toBe(2)
  })
})

describe("terminal content is confined to the data frame", () => {
  it("has no chunk, and no field that could hold one, on a control frame", () => {
    // The stop condition is a control record carrying bytes. A field named
    // `data` or `output` would be the same hole one rename away.
    const controlKeys = Object.keys(terminalControlSchema.shape)
    expect(controlKeys).not.toContain("chunk")
    expect(controlKeys).not.toContain("data")
    expect(controlKeys).not.toContain("output")
    expect(controlKeys).not.toContain("bytes")
    expect(controlKeys).toContain("reason")
  })

  it("reports the SIZE of an over-sized frame in its error, never the bytes", () => {
    // A `ContractError` message is a log line, and a log line is somewhere
    // terminal output ends up. This asserts the property of the produced
    // message, not the intent of the code that produced it.
    const secret = "c3VwZXItc2VjcmV0LXRlcm1pbmFsLWJ5dGVz"
    const parsed = terminalDataSchema.safeParse(terminalDataPayload({ chunk: base64Of(MAX_TERMINAL_FRAME_BYTES + 1) }))
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues[0]?.message).not.toContain(secret)
    expect(parsed.error.issues[0]?.message).toMatch(/\d+ bytes/)
  })

  it("never embeds a frame in any admission refusal either", () => {
    const refusals = [
      evaluateViewerCount(MAX_VIEWERS_PER_TERMINAL),
      evaluateFrameSize(MAX_TERMINAL_FRAME_BYTES + 1),
      evaluateFrameRate(MAX_TERMINAL_FRAMES_PER_SECOND + 1, 1_000),
      evaluateBufferPressure(MAX_TERMINAL_BUFFER_BYTES + 1),
    ]
    for (const refusal of refusals) {
      expect(refusal.admitted).toBe(false)
      if (refusal.admitted) continue
      expect(refusal.error.message).not.toMatch(/chunk|data|output/i)
      expect(refusal.error.retryable).toBe(false)
      expect(checkTerminalAdmission(refusal).ok).toBe(false)
    }
  })

  it("keeps terminal content out of the families that carry orchestration records", () => {
    // The other direction: a `mesh.event` or an ack has no field that could
    // carry a chunk, so a gateway that tried to smuggle one would be refused at
    // parse time rather than at review time.
    for (const recordType of ["mesh.event", "mesh.ack", "mesh.heartbeat"] as const) {
      const payload = sampleEnvelope(recordType).payload as Record<string, unknown>
      const keys = Object.keys(payload)
      expect(keys, recordType).not.toContain("chunk")
      expect(keys, recordType).not.toContain("terminalOutput")
      expect(safeParseMeshEnvelope({ ...sampleEnvelope(recordType), payload: { ...payload, chunk: "aGk=" } }).ok, recordType).toBe(false)
    }
  })
})

describe("per-client resource bounds", () => {
  it("admits many viewers and refuses the one past the bound", () => {
    // Many viewers, ONE input owner: the count is a viewer bound, not a
    // permission, and it is here so no gateway has to know the number.
    for (let viewers = 0; viewers < MAX_VIEWERS_PER_TERMINAL; viewers += 1) {
      expect(evaluateViewerCount(viewers).admitted, String(viewers)).toBe(true)
    }
    const refused = evaluateViewerCount(MAX_VIEWERS_PER_TERMINAL)
    expect(refused.admitted).toBe(false)
    expect(refused.admitted === false && refused.limit).toBe("viewers")
  })

  it("refuses a frame at the bound and admits one under it", () => {
    expect(evaluateFrameSize(MAX_TERMINAL_FRAME_BYTES).admitted).toBe(true)
    expect(evaluateFrameSize(MAX_TERMINAL_FRAME_BYTES + 1).admitted).toBe(false)
  })

  it("bounds the frame rate over a caller-supplied window, with no timer anywhere", () => {
    expect(MAX_TERMINAL_FRAMES_PER_SECOND).toBe(512)
    expect(evaluateFrameRate(512, 1_000).admitted).toBe(true)
    expect(evaluateFrameRate(513, 1_000).admitted).toBe(false)
    expect(evaluateFrameRate(25, 50).admitted).toBe(true)
    // A window is always at least one frame, so a sub-millisecond window cannot
    // be turned into a division by zero or a zero allowance.
    expect(evaluateFrameRate(1, 1).admitted).toBe(true)
    expect(evaluateFrameRate(1, 0).admitted).toBe(false)
  })

  it("drops frames rather than growing the buffer past its bound", () => {
    // Backpressure, and the decision is DROP: disconnecting everyone over one
    // slow consumer turns a resource bound into a denial of service against the
    // whole terminal.
    expect(evaluateBufferPressure(MAX_TERMINAL_BUFFER_BYTES).admitted).toBe(true)
    const over = evaluateBufferPressure(MAX_TERMINAL_BUFFER_BYTES + 1)
    expect(over.admitted).toBe(false)
    expect(over.admitted === false && over.limit).toBe("buffer")
    expect(over.admitted === false && over.error.message).toContain("dropped, not buffered")
  })

  it("drops from the FRONT, because the tail is what the user is looking at", () => {
    const overflow = MAX_TERMINAL_BUFFER_BYTES + 4_096
    expect(framesToDrop(MAX_TERMINAL_BUFFER_BYTES, 1_024)).toBe(0)
    expect(framesToDrop(overflow, 1_024)).toBe(4)
    expect(framesToDrop(overflow, 0)).toBe(0)
    expect(framesToDrop(overflow, 100_000)).toBe(1)
  })

  it("flavours an admission through the Result seam", () => {
    expect(checkTerminalAdmission(evaluateViewerCount(0))).toEqual({ ok: true, value: true })
  })
})

describe("the frame belongs to a client and a terminal", () => {
  it("correlates on the client, so a stream is per client and not per terminal", () => {
    // Two viewers of one terminal have independent byte streams; correlating on
    // the terminal would interleave them.
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.terminal.data", { correlationId: "terminal-1" })).ok).toBe(false)
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.terminal.data")).ok).toBe(true)
  })

  it("carries the runtime direction explicitly, so a frame cannot be fed back into the runtime", () => {
    for (const direction of ["to_runtime", "to_viewer"] as const) {
      expect(terminalDataSchema.parse(terminalDataPayload({ direction })).direction).toBe(direction)
    }
    expect(() => terminalDataSchema.parse(terminalDataPayload({ direction: "sideways" }))).toThrow()
  })

  it("keeps a control frame about node B off the stream addressed to node A", () => {
    const misaddressed = rawEnvelope(
      "mesh.terminal.data",
      terminalDataPayload({ chunk: "aGVsbG8=", sequence: 1 }),
      { correlationId: "client-1", senderNodeId: WORKER_ID },
    )
    expect(safeParseMeshEnvelope(misaddressed).ok).toBe(true)
    const borrowed = rawEnvelope(
      "mesh.terminal.control",
      terminalControlPayload({ clientId: "client-1", nodeId: OTHER_WORKER_ID, epoch: EPOCH }),
      { correlationId: "client-1" },
    )
    expect(safeParseMeshEnvelope(borrowed).ok).toBe(false)
  })
})

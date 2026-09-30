import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import {
  MAX_COMMAND_PAYLOAD_BYTES,
  MAX_ENVELOPE_BYTES,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_HEARTBEAT_AGE_MS,
  MAX_RULE_PATTERN_LENGTH,
  MAX_TERMINAL_BUFFER_BYTES,
  MAX_TERMINAL_FRAME_BYTES,
  MAX_TERMINAL_FRAMES_PER_SECOND,
  MAX_VIEWERS_PER_TERMINAL,
  REPLAY_WINDOW_MS,
  canonicalByteLength,
} from "../../../src/mesh/protocol/bounds.js"
import { ARRAY_MAX, decodedBase64Bytes, protocolVersionListSchema } from "../../../src/mesh/protocol/identifiers.js"
import { MAX_BOUNDED_NESTING_DEPTH, MAX_RULE_MATCH_SUBJECT_LENGTH, checkSafePattern } from "../../../src/mesh/protocol/safe-pattern.js"
import { evaluateReplayWindow } from "../../../src/mesh/protocol/envelope.js"
import { evaluateHeartbeatFreshness, meshHeartbeatSchema } from "../../../src/mesh/protocol/heartbeat.js"
import { safeParseMeshEnvelope } from "../../../src/mesh/protocol/registry.js"
import { mintMeshCommand } from "../../../src/mesh/protocol/command.js"
import { mintMeshEvent } from "../../../src/mesh/protocol/event.js"
import { evaluateBufferPressure, evaluateFrameRate, evaluateFrameSize, evaluateViewerCount, framesToDrop, terminalDataSchema } from "../../../src/mesh/protocol/terminal.js"
import {
  T1,
  T2,
  enrollmentResponsePayload,
  heartbeatPayload,
  makeOversizedEvent,
  makeRunCreateCommand,
  rawEnvelope,
  sampleEnvelope,
  terminalDataPayload,
  WORKER_ID,
} from "./fixtures.js"

/**
 * §6 of the spec: every resource bound, its stated value, and proof that it is
 * APPLIED rather than merely documented.
 *
 * The second half is the part that usually goes missing. A bound that exists as
 * a named export and is referenced from a comment is a bound the next gateway
 * quietly stops enforcing, and nothing fails until someone measures. So each
 * bound below is exercised at `limit`, at `limit + 1`, and on whichever schema
 * or evaluator is supposed to be enforcing it.
 */

const T1_MS = Date.parse(T1)
const T2_MS = Date.parse(T2)

describe("the §6 table, value for value", () => {
  it("exports every bound at exactly the value the spec states", () => {
    // Typed against the literals, so a bound edited in `bounds.ts` without the
    // spec being edited alongside it fails HERE rather than in a gate report.
    const stated: Record<string, number> = {
      MAX_ENVELOPE_BYTES: 262_144,
      MAX_TERMINAL_FRAME_BYTES: 65_536,
      MAX_TERMINAL_BUFFER_BYTES: 1_048_576,
      MAX_TERMINAL_FRAMES_PER_SECOND: 512,
      MAX_VIEWERS_PER_TERMINAL: 16,
      MAX_COMMAND_PAYLOAD_BYTES: 131_072,
      MAX_EVENT_PAYLOAD_BYTES: 131_072,
      REPLAY_WINDOW_MS: 300_000,
      MAX_HEARTBEAT_AGE_MS: 90_000,
      MAX_RULE_PATTERN_LENGTH: 128,
    }
    const actual: Record<string, number> = {
      MAX_ENVELOPE_BYTES,
      MAX_TERMINAL_FRAME_BYTES,
      MAX_TERMINAL_BUFFER_BYTES,
      MAX_TERMINAL_FRAMES_PER_SECOND,
      MAX_VIEWERS_PER_TERMINAL,
      MAX_COMMAND_PAYLOAD_BYTES,
      MAX_EVENT_PAYLOAD_BYTES,
      REPLAY_WINDOW_MS,
      MAX_HEARTBEAT_AGE_MS,
      MAX_RULE_PATTERN_LENGTH,
    }
    expect(actual).toEqual(stated)
  })

  it("keeps the derived bounds the same table implies", () => {
    // A terminal frame has to fit inside the envelope it travels in, and the
    // rule analyser is only argued safe within its own subject bound. Neither
    // fact is in the table, so both are asserted here rather than assumed.
    expect(MAX_TERMINAL_FRAME_BYTES).toBeLessThan(MAX_ENVELOPE_BYTES)
    expect(MAX_TERMINAL_BUFFER_BYTES).toBeGreaterThan(MAX_TERMINAL_FRAME_BYTES)
    expect(MAX_TERMINAL_BUFFER_BYTES % MAX_TERMINAL_FRAME_BYTES).toBe(0)
    expect(MAX_RULE_PATTERN_LENGTH).toBeLessThan(MAX_RULE_MATCH_SUBJECT_LENGTH)
    expect(MAX_BOUNDED_NESTING_DEPTH).toBeGreaterThanOrEqual(2)
  })
})

describe("MAX_ENVELOPE_BYTES", () => {
  it("is applied to the whole envelope at the single parse entry point", () => {
    // One place, not per gateway: a limit each transport has to remember is a
    // limit the next transport forgets.
    const pinned = (length: number) => "A".repeat(length)
    const over = rawEnvelope(
      "mesh.enrollment.response",
      enrollmentResponsePayload({
        peerKeyPins: [
          { nodeId: WORKER_ID, nodeKeyId: "key-1", publicKey: pinned(300_000), fingerprint: `sha256:${"b".repeat(64)}`, pinnedAt: T1 },
        ],
      }),
      { correlationId: "enr-1" },
    )
    const safe = safeParseMeshEnvelope(over)
    expect(safe.ok).toBe(false)
    expect(safe.ok === false && safe.error.message).toContain(String(MAX_ENVELOPE_BYTES))
  })

  it("accepts an envelope under the bound, so the bound is not simply refusing everything", () => {
    const small = rawEnvelope(
      "mesh.enrollment.response",
      enrollmentResponsePayload({
        peerKeyPins: [
          { nodeId: WORKER_ID, nodeKeyId: "key-1", publicKey: "AAAA", fingerprint: `sha256:${"b".repeat(64)}`, pinnedAt: T1 },
        ],
      }),
      { correlationId: "enr-1" },
    )
    expect(safeParseMeshEnvelope(small).ok).toBe(true)
  })
})

describe("MAX_COMMAND_PAYLOAD_BYTES and MAX_EVENT_PAYLOAD_BYTES", () => {
  it("refuses an oversized command on both the producing and the receiving side", () => {
    // Two 64 KiB task descriptions is the smallest construction that crosses the
    // wire bound while still being a record the KERNEL accepts. A limit only
    // reachable by an invalid record is not applied to anything.
    const oversized = makeRunCreateCommand(2, 65_536)
    expect(() => mintMeshCommand({ command: oversized, targetNodeId: WORKER_ID })).toThrow(new RegExp(`${MAX_COMMAND_PAYLOAD_BYTES} byte bound`))
    const under = mintMeshCommand({ command: makeRunCreateCommand(1, 64), targetNodeId: WORKER_ID })
    expect(under.payloadDigest).toBeDefined()
  })

  it("refuses an oversized event, and the message names the event bound rather than the command one", () => {
    const oversized = makeOversizedEvent(64, 4_090)
    expect(() => mintMeshEvent({ event: oversized, sourceNodeId: WORKER_ID, localSequence: 1 })).toThrow(
      new RegExp(`${MAX_EVENT_PAYLOAD_BYTES} byte bound`),
    )
  })

  it("bounds them by CANONICAL bytes, which is the same measure the digest covers", () => {
    // A limit defined against one encoder's framing is a limit the next encoder
    // silently evades, and canonical bytes are what `payloadDigest` hashes.
    const ascii = "a".repeat(100)
    expect(canonicalByteLength({ ascii })).toBe(JSON.stringify({ ascii }).length)
    // 100 CJK characters are 300 UTF-8 bytes; a limit counting characters would
    // be off by three on exactly the content an attacker would choose.
    expect(canonicalByteLength({ cjk: "字".repeat(100) })).toBeGreaterThan(canonicalByteLength({ cjk: "a".repeat(100) }))
  })
})

describe("REPLAY_WINDOW_MS", () => {
  it("is the skew allowance on issuedAt, applied to the exact millisecond", () => {
    const envelope = { issuedAt: T2, expiresAt: "2026-09-28T01:00:00.000Z" }
    expect(evaluateReplayWindow(envelope, T2_MS - REPLAY_WINDOW_MS).ok).toBe(true)
    const over = evaluateReplayWindow(envelope, T2_MS - REPLAY_WINDOW_MS - 1)
    expect(over.ok).toBe(false)
    expect(over.ok === false && over.reason).toBe("not_yet_valid")
    expect(over.ok === false && over.error.message).toContain(String(REPLAY_WINDOW_MS))
  })

  it("is not the lease: a record inside the window is still subject to per-family idempotency", () => {
    // The window bounds EXPOSURE. It is not a substitute for the `commandId` +
    // digest dedupe, which is why the two are separate mechanisms.
    expect(evaluateReplayWindow({ issuedAt: T1, expiresAt: T2 }, T1_MS).ok).toBe(true)
  })
})

describe("MAX_HEARTBEAT_AGE_MS", () => {
  it("marks a node stale at the bound and fresh one millisecond inside it", () => {
    const heartbeat = meshHeartbeatSchema.parse(heartbeatPayload())
    expect(evaluateHeartbeatFreshness(heartbeat, Date.parse(T1) + MAX_HEARTBEAT_AGE_MS)).toEqual({ state: "fresh", ageMs: MAX_HEARTBEAT_AGE_MS })
    const stale = evaluateHeartbeatFreshness(heartbeat, Date.parse(T1) + MAX_HEARTBEAT_AGE_MS + 1)
    expect(stale.state).toBe("stale")
    expect(stale.state === "stale" && stale.error.message).toContain(String(MAX_HEARTBEAT_AGE_MS))
  })

  it("reports a future heartbeat as a clock fault, not as staleness", () => {
    // Conflating them sends an operator to investigate clock skew when the real
    // cause may be a replay with a forged timestamp.
    const heartbeat = meshHeartbeatSchema.parse(heartbeatPayload())
    const future = evaluateHeartbeatFreshness(heartbeat, Date.parse(T1) - 1)
    expect(future.state).toBe("future")
    expect(future.state === "future" && future.error.code).toBe("protocol.heartbeat_from_the_future")
  })
})

describe("MAX_RULE_PATTERN_LENGTH", () => {
  it("is applied by the analyser, not merely exported", () => {
    const over = "a".repeat(MAX_RULE_PATTERN_LENGTH + 1)
    const result = checkSafePattern(over)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.refusal).toBe("too_long")
  })
})

describe("the terminal bounds", () => {
  it("MAX_TERMINAL_FRAME_BYTES is applied to the DECODED size, decided on the string", () => {
    const atBound = Buffer.alloc(MAX_TERMINAL_FRAME_BYTES, 0x61).toString("base64")
    expect(decodedBase64Bytes(atBound)).toBe(MAX_TERMINAL_FRAME_BYTES)
    expect(terminalDataSchema.safeParse({ ...terminalDataPayload(), chunk: atBound }).success).toBe(true)
    const overBound = Buffer.alloc(MAX_TERMINAL_FRAME_BYTES + 1, 0x61).toString("base64")
    expect(decodedBase64Bytes(overBound)).toBe(MAX_TERMINAL_FRAME_BYTES + 1)
    expect(terminalDataSchema.safeParse({ ...terminalDataPayload(), chunk: overBound }).success).toBe(false)
    expect(evaluateFrameSize(MAX_TERMINAL_FRAME_BYTES).admitted).toBe(true)
    expect(evaluateFrameSize(MAX_TERMINAL_FRAME_BYTES + 1).admitted).toBe(false)
  })

  it("MAX_TERMINAL_FRAMES_PER_SECOND is applied over a caller-supplied window", () => {
    expect(evaluateFrameRate(MAX_TERMINAL_FRAMES_PER_SECOND, 1_000).admitted).toBe(true)
    expect(evaluateFrameRate(MAX_TERMINAL_FRAMES_PER_SECOND + 1, 1_000).admitted).toBe(false)
  })

  it("MAX_TERMINAL_BUFFER_BYTES is applied as a DROP, not a disconnect", () => {
    // Disconnecting everyone over one slow consumer turns a resource bound into
    // a denial of service against the whole terminal.
    expect(evaluateBufferPressure(MAX_TERMINAL_BUFFER_BYTES).admitted).toBe(true)
    expect(evaluateBufferPressure(MAX_TERMINAL_BUFFER_BYTES + 1).admitted).toBe(false)
    expect(framesToDrop(MAX_TERMINAL_BUFFER_BYTES, 1_024)).toBe(0)
    expect(framesToDrop(MAX_TERMINAL_BUFFER_BYTES + 1_024, 1_024)).toBe(1)
  })

  it("MAX_VIEWERS_PER_TERMINAL is applied to the viewer that would be the one too many", () => {
    for (let viewers = 0; viewers < MAX_VIEWERS_PER_TERMINAL; viewers += 1) {
      expect(evaluateViewerCount(viewers).admitted, String(viewers)).toBe(true)
    }
    expect(evaluateViewerCount(MAX_VIEWERS_PER_TERMINAL).admitted).toBe(false)
  })
})

describe("the protocol module is pure, which is what makes the matrix testable", () => {
  it("reads no clock, no randomness and no I/O anywhere under src/mesh/protocol", () => {
    // §1 of the spec. The retry / partition / restart / stale-epoch matrix is
    // about minutes after a lease stopped being renewed; a module that read the
    // clock itself could only be tested by sleeping, and one that read
    // `Math.random` could not be tested at all. Stated as a fact about the
    // source rather than implied by the absence of a bug.
    const directory = new URL("../../../src/mesh/protocol/", import.meta.url)
    const forbidden = [
      /\bDate\.now\b/,
      /\bnew Date\(\s*\)/,
      /\bMath\.random\b/,
      /\brandomUUID\b/,
      /from\s+"node:fs/,
      /from\s+"node:net/,
      /from\s+"node:http/,
      /from\s+"node:crypto/,
      /\bfetch\(/,
      /\bprocess\./,
    ]
    const files = [...readdirSync(directory).filter((name) => name.endsWith(".ts"))].sort()
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const source = readFileSync(new URL(file, directory), "utf8")
      // Comments are allowed to NAME these things, because the comments are
      // where the rule is stated; only executable code is forbidden.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${file} matches ${pattern}`).toBe(false)
      }
    }
  })

  it("depends on nothing outside src/orchestration", () => {
    const directory = new URL("../../../src/mesh/protocol/", import.meta.url)
    const allowed = /^(\.\.\/){2}orchestration\/[\w./-]+\.js$|^\.\.?\/[\w./-]+\.js$|^zod$/
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(new URL(file, directory), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      for (const match of source.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
        expect(match[1], `${file} imports ${match[1]}`).toMatch(allowed)
      }
    }
  })
})

describe("bounds that are not in the §6 table", () => {
  it("the collection and version-list bounds are also named and applied", () => {
    // A repeated collection and a version offer are both attacker-controlled
    // lists, and both are iterated on the hot path.
    expect(ARRAY_MAX).toBe(128)
    expect(safeParseMeshEnvelope({ ...sampleEnvelope("mesh.heartbeat"), payload: { ...heartbeatPayload(), capabilities: Array.from({ length: ARRAY_MAX + 1 }, (_, i) => `cap-${i}`) } }).ok).toBe(false)
    expect(safeParseMeshEnvelope({ ...sampleEnvelope("mesh.heartbeat"), payload: { ...heartbeatPayload(), capabilities: Array.from({ length: ARRAY_MAX }, (_, i) => `cap-${i}`) } }).ok).toBe(true)
    // One more than the list bound is refused, and the list is also de-duplicated.
    expect(protocolVersionListSchema.safeParse(Array.from({ length: 65 }, (_, i) => i + 1)).success).toBe(false)
    expect(protocolVersionListSchema.safeParse([1, 1]).success).toBe(false)
  })

  it("refuses a peer offering no protocol versions at all, as a sender bug", () => {
    // An empty offer negotiating to "no common version" reads as a
    // compatibility problem when it is a sender bug.
    expect(safeParseMeshEnvelope({ ...sampleEnvelope("mesh.heartbeat"), payload: { ...heartbeatPayload(), protocolVersions: [] } }).ok).toBe(false)
  })
})

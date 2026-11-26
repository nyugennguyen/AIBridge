import { describe, expect, it } from "vitest"
import {
  MESH_RECORD_TYPES,
  assertEnvelopeInvariants,
  checkReplayWindow,
  evaluateReplayWindow,
  meshRecordTypeSchema,
  sameId,
} from "../../../src/mesh/protocol/envelope.js"
import { REPLAY_WINDOW_MS } from "../../../src/mesh/protocol/bounds.js"
import { protocolVersionListSchema, protocolVersionSchema } from "../../../src/mesh/protocol/identifiers.js"

/**
 * The parts of the mesh envelope module that are still used: the replay window
 * (request signing reads `REPLAY_WINDOW_MS`), the record-type enum (`wire-ids.ts`
 * validates against it) and the protocol-version schemas.
 *
 * The record families and their registry (`parseMeshEnvelope`) were removed in
 * 3.2.0 (D4), together with the cases that parsed whole envelopes through them.
 * The archive tag `archive/kernel-mesh-3.1.1` keeps the full suite.
 */

const T0 = "2026-09-28T00:00:00.000Z"
const T2 = "2026-09-28T00:00:20.000Z"
const T0_MS = Date.parse(T0)
const T2_MS = Date.parse(T2)
const at = (seconds: number): string => new Date(T0_MS + seconds * 1000).toISOString()

describe("envelope replay window", () => {
  it("accepts a record read at any instant inside its window", () => {
    const envelope = { issuedAt: T0, expiresAt: T2 }
    for (const nowMs of [T0_MS, T0_MS + 1, T0_MS + 5_000, T2_MS]) {
      const verdict = evaluateReplayWindow(envelope, nowMs)
      expect(verdict.ok, String(nowMs)).toBe(true)
    }
  })

  it("refuses an expired record with a non-retryable protocol.record_expired", () => {
    const verdict = evaluateReplayWindow({ issuedAt: T0, expiresAt: T2 }, T2_MS + 1)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toBe("expired")
    expect(verdict.ok === false && verdict.error.code).toBe("protocol.record_expired")
    expect(verdict.ok === false && verdict.error.retryable).toBe(false)
    expect(checkReplayWindow({ issuedAt: T0, expiresAt: T2 }, T2_MS + 1).ok).toBe(false)
  })

  it("refuses a record whose issuedAt is beyond the skew allowance, and allows one inside it", () => {
    const envelope = { issuedAt: T0, expiresAt: at(600) }
    const tooFarAhead = evaluateReplayWindow(envelope, T0_MS - REPLAY_WINDOW_MS - 1)
    expect(tooFarAhead.ok).toBe(false)
    // A FUTURE issue time is a different defect from an expired record, and
    // conflating them sends an operator to investigate clock skew when the real
    // cause may be a replay with a forged timestamp.
    expect(tooFarAhead.ok === false && tooFarAhead.reason).toBe("not_yet_valid")
    expect(tooFarAhead.ok === false && tooFarAhead.error.code).toBe("protocol.record_not_yet_valid")
    expect(tooFarAhead.ok === false && tooFarAhead.error.message).toContain(String(REPLAY_WINDOW_MS))

    expect(evaluateReplayWindow(envelope, T0_MS - REPLAY_WINDOW_MS).ok).toBe(true)
    expect(evaluateReplayWindow(envelope, T0_MS - 1).ok).toBe(true)
  })

  it("reads the clock only from its parameter", () => {
    const tenMinutesLate = T2_MS + 10 * 60 * 1000
    expect(evaluateReplayWindow({ issuedAt: T0, expiresAt: T2 }, tenMinutesLate).ok).toBe(false)
    expect(evaluateReplayWindow({ issuedAt: T0, expiresAt: at(20 * 60) }, tenMinutesLate).ok).toBe(true)
  })

  it("applies the expiresAt-after-issuedAt invariant through assertEnvelopeInvariants", () => {
    const issues: string[] = []
    const ctx = { addIssue: (issue: { message: string }) => issues.push(issue.message) } as never
    assertEnvelopeInvariants({ issuedAt: T2, expiresAt: T0 }, ctx)
    expect(issues.join(" ")).toContain("strictly later")
  })
})

describe("envelope ids and record types", () => {
  it("compares two branded ids by value", () => {
    expect(sameId("a" as never, "a" as never)).toBe(true)
    expect(sameId("a" as never, "b" as never)).toBe(false)
  })

  it("gives every record type a distinct name and refuses an unknown one", () => {
    expect(new Set(MESH_RECORD_TYPES).size).toBe(MESH_RECORD_TYPES.length)
    for (const recordType of MESH_RECORD_TYPES) expect(meshRecordTypeSchema.safeParse(recordType).success, recordType).toBe(true)
    expect(meshRecordTypeSchema.safeParse("mesh.unknown").success).toBe(false)
  })
})

describe("protocol version headers", () => {
  it("carries a positive safe integer protocol version", () => {
    expect(protocolVersionSchema.safeParse(0).success).toBe(false)
    expect(protocolVersionSchema.safeParse(-1).success).toBe(false)
    expect(protocolVersionSchema.safeParse(1.5).success).toBe(false)
    expect(protocolVersionSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false)
    expect(protocolVersionSchema.safeParse(2).success).toBe(true)
  })

  it("bounds and de-duplicates a protocol version list", () => {
    expect(protocolVersionListSchema.safeParse([1, 2, 3]).success).toBe(true)
    expect(protocolVersionListSchema.safeParse([]).success).toBe(false)
    expect(protocolVersionListSchema.safeParse([1, 1]).success).toBe(false)
    expect(protocolVersionListSchema.safeParse(Array.from({ length: 17 }, (_, i) => i + 1)).success).toBe(false)
  })
})

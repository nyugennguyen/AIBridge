import { describe, expect, it } from "vitest"
import { digestJson } from "../../../src/orchestration/digest.js"
import {
  MESH_RECORD_TYPES,
  assertEnvelopeInvariants,
  checkReplayWindow,
  evaluateReplayWindow,
  sameId,
  type MeshRecordType,
} from "../../../src/mesh/protocol/envelope.js"
import { MAX_ENVELOPE_BYTES, REPLAY_WINDOW_MS } from "../../../src/mesh/protocol/bounds.js"
import { MESH_RECORD_SHAPES, parseMeshEnvelope, safeParseMeshEnvelope } from "../../../src/mesh/protocol/registry.js"
import { protocolVersionListSchema, protocolVersionSchema } from "../../../src/mesh/protocol/identifiers.js"
import {
  ALL_RECORD_TYPES,
  OTHER_WORKER_ID,
  T0,
  T1,
  T2,
  WORKER_ID,
  ackPayload,
  at,
  enrollmentResponsePayload,
  heartbeatPayload,
  rawEnvelope,
  sampleEnvelope,
  terminalDataPayload,
} from "./fixtures.js"

/**
 * §2 of the spec: the envelope every record is wrapped in, and the two
 * invariants that make it safe to hand to a reader.
 *
 * `.strict()` is asserted per family rather than once, because strictness is a
 * property of the SCHEMA and the nine families each build their own. The reason
 * it matters is stated once here so the per-family tests can be terse: an unknown
 * field that is ignored rather than rejected is how a future field that changes
 * the meaning of an existing one gets silently dropped by an old reader — the
 * reader sees a complete record, acts on it, and the field that mattered was
 * never there.
 */

const T0_MS = Date.parse(T0)
const T2_MS = Date.parse(T2)

describe("envelope strictness", () => {
  for (const recordType of ALL_RECORD_TYPES) {
    it(`refuses an unknown envelope field on ${recordType}`, () => {
      const envelope = { ...rawEnvelope(recordType, samplePayload(recordType)), retiredInM5: true }
      const safe = safeParseMeshEnvelope(envelope)
      expect(safe.ok, recordType).toBe(false)
      expect(safe.ok === false && safe.error.message).toContain("retiredInM5")
    })
  }

  it("refuses an unknown field inside the payload as well", () => {
    // Strictness at both levels: a family payload is not a bag either, and a
    // payload that tolerates extras is a family whose future fields are already
    // being dropped by this build.
    const envelope = rawEnvelope("mesh.heartbeat", { ...heartbeatPayload(), newInM5: { tier: "gpu" } }, {
      senderNodeId: WORKER_ID,
      recipientNodeId: null,
    })
    expect(safeParseMeshEnvelope(envelope).ok).toBe(false)

    const payload = { ...terminalDataPayload(), kind: "control" }
    expect(safeParseMeshEnvelope(rawEnvelope("mesh.terminal.data", payload, { correlationId: "client-1" })).ok).toBe(false)
  })

  it("refuses an envelope that omits a required header", () => {
    for (const header of ["messageId", "correlationId", "senderNodeId", "protocolVersion", "issuedAt", "expiresAt"]) {
      const envelope = sampleEnvelope("mesh.heartbeat")
      delete (envelope as Record<string, unknown>)[header]
      expect(safeParseMeshEnvelope(envelope).ok, `missing ${header}`).toBe(false)
    }
  })
})

describe("envelope replay window", () => {
  it("requires expiresAt to be strictly later than issuedAt", () => {
    const equal = sampleEnvelope("mesh.lease", { issuedAt: T0, expiresAt: T0 })
    const reversed = sampleEnvelope("mesh.lease", { issuedAt: T2, expiresAt: T0 })
    for (const envelope of [equal, reversed]) {
      const safe = safeParseMeshEnvelope(envelope)
      expect(safe.ok).toBe(false)
      expect(safe.ok === false && safe.error.message).toContain("expiresAt")
    }
    // A zero-width window does not fail closed: it fails OPEN under any clock
    // disagreement, because both ends of it are the same instant.
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.lease", { issuedAt: T0, expiresAt: at(1) })).ok).toBe(true)
  })

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

    expect(evaluateReplayWindow(envelope, T0_MS - REPLAY_WINDOW_MS).ok).toBe(true)
    expect(evaluateReplayWindow(envelope, T0_MS - 1).ok).toBe(true)
  })

  it("reads the clock only from its parameter", () => {
    // The whole partition/restart matrix is untestable if a module reads the
    // clock itself, so the contract is stated as a fact rather than implied:
    // a record whose window closed 10 minutes ago is refused, and one whose
    // window is still open is accepted, with no sleeping anywhere.
    const tenMinutesLate = T2_MS + 10 * 60 * 1000
    expect(evaluateReplayWindow({ issuedAt: T0, expiresAt: T2 }, tenMinutesLate).ok).toBe(false)
    expect(evaluateReplayWindow({ issuedAt: T0, expiresAt: at(20 * 60) }, tenMinutesLate).ok).toBe(true)
  })

  it("applies the same two envelope invariants through assertEnvelopeInvariants", () => {
    const issues: string[] = []
    const ctx = { addIssue: (issue: { message: string }) => issues.push(issue.message) } as never
    assertEnvelopeInvariants({ issuedAt: T2, expiresAt: T0 }, ctx)
    expect(issues.join(" ")).toContain("strictly later")
  })
})

describe("envelope causation closure", () => {
  it("binds a command's correlation to its own command id", () => {
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.command", { correlationId: "cmd-8" })).ok).toBe(false)
  })

  it("binds an event's correlation to its own event id, not to the command it answers", () => {
    // The command is the CAUSATION. Conflating the two is how a controller ends
    // up unable to answer "which events came back for command X" without
    // walking the log.
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.event", { correlationId: "cmd-7" })).ok).toBe(false)
  })

  it("binds an ack's correlation to the thing it acknowledges", () => {
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.ack", { correlationId: "cmd-8" })).ok).toBe(false)
    expect(
      safeParseMeshEnvelope(rawEnvelope("mesh.ack", ackPayload({ acksCommandId: "cmd-8" }), { correlationId: "cmd-8" })).ok,
    ).toBe(true)
  })

  it("binds enrollment records to their enrollment id and refuses a foreign causation", () => {
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.enrollment.request", { correlationId: "enr-2" })).ok).toBe(false)
    const wrongCausation = sampleEnvelope("mesh.enrollment.response", { causation: { kind: "enrollment", enrollmentId: "enr-9" } })
    expect(safeParseMeshEnvelope(wrongCausation).ok).toBe(false)
    const eventCausation = sampleEnvelope("mesh.enrollment.response", { causation: { kind: "event", eventId: "evt-1" } })
    expect(safeParseMeshEnvelope(eventCausation).ok).toBe(false)
    const goodCausation = sampleEnvelope("mesh.enrollment.response", { causation: { kind: "enrollment", enrollmentId: "enr-1" } })
    expect(safeParseMeshEnvelope(goodCausation).ok).toBe(true)
  })

  it("accepts null causation for a head-of-conversation record and refuses an incoherent one", () => {
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.enrollment.request", { causation: null })).ok).toBe(true)
    for (const causation of [
      { kind: "command" },
      { kind: "event", eventId: "evt-1", commandId: "cmd-7" },
      { commandId: "cmd-7" },
      "command",
      7,
    ]) {
      expect(
        safeParseMeshEnvelope(sampleEnvelope("mesh.enrollment.request", { causation })).ok,
        JSON.stringify(causation),
      ).toBe(false)
    }
  })

  it("keeps a command causable only by a command, and only by itself", () => {
    const selfCaused = sampleEnvelope("mesh.command", { causation: { kind: "command", commandId: "cmd-7" } })
    expect(safeParseMeshEnvelope(selfCaused).ok).toBe(true)
    const otherCommand = sampleEnvelope("mesh.command", { causation: { kind: "command", commandId: "cmd-6" } })
    expect(safeParseMeshEnvelope(otherCommand).ok).toBe(false)
    const byEvent = sampleEnvelope("mesh.command", { causation: { kind: "event", eventId: "evt-1" } })
    expect(safeParseMeshEnvelope(byEvent).ok).toBe(false)
  })
})

describe("envelope addressing", () => {
  it("treats a null recipient as a broadcast and only as a broadcast", () => {
    // `null` is a genuine broadcast (a heartbeat fan-in). "Unspecified" would be
    // the confusion this column exists to prevent: a record that failed to name
    // its recipient and was silently delivered to everyone.
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.heartbeat", { recipientNodeId: null })).ok).toBe(true)
    const addressedHeartbeat = sampleEnvelope("mesh.heartbeat", { recipientNodeId: WORKER_ID })
    expect(safeParseMeshEnvelope(addressedHeartbeat).ok).toBe(true)
    const misaddressed = sampleEnvelope("mesh.heartbeat", { recipientNodeId: OTHER_WORKER_ID })
    expect(safeParseMeshEnvelope(misaddressed).ok).toBe(false)
  })

  it("refuses a record whose sender is not the node it speaks for", () => {
    // A worker event and a heartbeat are first-person. Third-person reporting is
    // how node B's state gets recorded as node C's.
    for (const recordType of ["mesh.heartbeat", "mesh.event"] as const) {
      const impersonated = sampleEnvelope(recordType, { senderNodeId: OTHER_WORKER_ID })
      const safe = safeParseMeshEnvelope(impersonated)
      expect(safe.ok, recordType).toBe(false)
      expect(safe.ok === false && safe.error.message).toContain("first-person")
    }
  })

  it("refuses a lease that a node other than the controller claims", () => {
    const safe = safeParseMeshEnvelope(sampleEnvelope("mesh.lease", { senderNodeId: OTHER_WORKER_ID }))
    expect(safe.ok).toBe(false)
    expect(safe.ok === false && safe.error.message).toContain("claim")
  })

  it("compares two branded ids by value", () => {
    // The brands exist to stop a ProjectId being passed where a RunId is
    // wanted; a COMPARISON between two ids of different brands is exactly what
    // the envelope closure checks need, so the widening happens once, here.
    expect(sameId("a" as never, "a" as never)).toBe(true)
    expect(sameId("a" as never, "b" as never)).toBe(false)
  })
})

describe("envelope version and protocol headers", () => {
  it("carries a positive integer protocol version that is not the schema version", () => {
    expect(protocolVersionSchema.safeParse(0).success).toBe(false)
    expect(protocolVersionSchema.safeParse(-1).success).toBe(false)
    expect(protocolVersionSchema.safeParse(1.5).success).toBe(false)
    expect(protocolVersionSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false)
    expect(protocolVersionSchema.safeParse(2).success).toBe(true)
    // The two axes are separate on purpose, and collapsing them would mean a
    // record shape change forced a whole-mesh incompatibility.
    const envelope = sampleEnvelope("mesh.heartbeat", { protocolVersion: 7, schemaVersion: 2 })
    expect(parseMeshEnvelope(envelope).protocolVersion).toBe(7)
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.heartbeat", { protocolVersion: 0 })).ok).toBe(false)
  })

  it("bounds and de-duplicates a protocol version list", () => {
    expect(protocolVersionListSchema.safeParse([1, 2, 3]).success).toBe(true)
    expect(protocolVersionListSchema.safeParse([]).success).toBe(false)
    expect(protocolVersionListSchema.safeParse([1, 1]).success).toBe(false)
    expect(protocolVersionListSchema.safeParse(Array.from({ length: 17 }, (_, i) => i + 1)).success).toBe(false)
  })
})

describe("envelope size bound", () => {
  it("refuses an envelope over MAX_ENVELOPE_BYTES and accepts one under it", () => {
    const pin = "A".repeat(300_000)
    const oversized = rawEnvelope(
      "mesh.enrollment.response",
      enrollmentResponsePayload({
        peerKeyPins: [
          { nodeId: WORKER_ID, nodeKeyId: "key-1", publicKey: pin, fingerprint: `sha256:${"b".repeat(64)}`, pinnedAt: T1 },
        ],
      }),
      { correlationId: "enr-1" },
    )
    const safe = safeParseMeshEnvelope(oversized)
    expect(safe.ok).toBe(false)
    expect(safe.ok === false && safe.error.message).toContain(String(MAX_ENVELOPE_BYTES))

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

describe("registry reachability", () => {
  it("reaches every family through parseMeshEnvelope and none through a side door", () => {
    for (const recordType of MESH_RECORD_TYPES) {
      const envelope = parseMeshEnvelope(sampleEnvelope(recordType))
      expect(envelope.recordType, recordType).toBe(recordType)
      // The same table the registry dispatches through, so a family that parsed
      // somehow other than through `parseVersioned` would be a hole in the
      // mechanism rather than a convenience.
      expect(MESH_RECORD_SHAPES[recordType][envelope.schemaVersion], recordType).toBeDefined()
    }
  })

  it("gives every family its own recordType so an inbound record cannot be read as an outbound one", () => {
    // Three families are inherently bidirectional. A `recordType` that does not
    // name a direction is what lets a receiver refuse an inbound `mesh.command`
    // where an outbound one was expected.
    expect(new Set(MESH_RECORD_TYPES).size).toBe(MESH_RECORD_TYPES.length)
    expect(MESH_RECORD_TYPES).toContain("mesh.terminal.control")
    expect(MESH_RECORD_TYPES).toContain("mesh.terminal.data")
    expect(MESH_RECORD_TYPES).toContain("mesh.reconciliation.request")
    expect(MESH_RECORD_TYPES).toContain("mesh.reconciliation.response")
  })
})

describe("digest-visible payloads", () => {
  it("canonicalises a payload the same way the digest is computed over it", () => {
    // The bound is measured in canonical bytes and the digest is a hash of
    // canonical bytes, so the number the limit checks and the number the
    // integrity check covers are the same number.
    const payload = heartbeatPayload()
    expect(digestJson(payload)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(digestJson({ ...payload })).toBe(digestJson(payload))
    expect(digestJson({ ...payload, nodeId: OTHER_WORKER_ID })).not.toBe(digestJson(payload))
  })
})

function samplePayload(recordType: MeshRecordType): unknown {
  const envelope = sampleEnvelope(recordType)
  return (envelope as { payload: unknown }).payload
}

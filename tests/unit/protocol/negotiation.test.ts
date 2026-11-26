import { describe, expect, it } from "vitest"
import {
  CURRENT_MESH_PROTOCOL_VERSION,
  MESH_PROTOCOL_VERSIONS,
  negotiationMismatch,
  negotiateProtocolVersion,
  selectProtocolVersion,
  supportedProtocolVersions,
  validateOfferedVersions,
} from "../../../src/mesh/protocol/negotiation.js"

/**
 * §5 of the spec, and scenario 5 of the diagrams.
 *
 * The two failures available here — "no common version" and "proceed on the
 * newest one I happen to parse" — are the same defect seen from two ends. A node
 * that silently downgrades sends a record the peer cannot read and the peer
 * refuses it; a node that proceeds on "the newest I can parse" interprets a
 * record whose field means something else. Both surface as an intermittent,
 * unreproducible failure on a version-skewed mesh, which is far worse than a
 * refusal at enrollment time.
 *
 * So the assertions below are mostly NEGATIVE: the interesting behaviour is the
 * refusal, and its `retryable: false`, because a node that keeps retrying a
 * version it will never understand is a resource-exhaustion vector on the peer.
 *
 * Since 3.2.0 (D4) the record families and their registry are gone; the only
 * consumer of `negotiation.ts` left is the unwired kernel coordinator, and both
 * are removed in D5. The cases that parsed a heartbeat envelope went with D4.
 */

describe("selectProtocolVersion", () => {
  it("picks the highest version both sides speak", () => {
    expect(selectProtocolVersion([1, 2, 3], [1, 2, 3])).toBe(3)
    expect(selectProtocolVersion([3, 2, 1], [1, 2])).toBe(2)
    expect(selectProtocolVersion([1], [1])).toBe(1)
  })

  it("returns null rather than falling back to the newest version it can parse", () => {
    // The whole point: there is no "close enough" here.
    expect(selectProtocolVersion([3, 4], [1, 2])).toBeNull()
    expect(selectProtocolVersion([], [1, 2])).toBeNull()
    expect(selectProtocolVersion([2], [1])).toBeNull()
  })

  it("takes the only common version even when it is the older one", () => {
    // A peer that speaks v1 and a node that speaks v1 and v2 must meet at v1.
    // This is not a downgrade path: the peer never offered anything else, so
    // there was no choice to make. What must never happen is the node picking
    // v2 for itself and reading a v1 record as though it were v2.
    expect(selectProtocolVersion([1], [1, 2])).toBe(1)
  })
})

describe("negotiationMismatch", () => {
  it("reports the negotiated version on success", () => {
    const outcome = negotiationMismatch([1, 2], [2, 3])
    expect(outcome.ok).toBe(true)
    expect(outcome.ok === true && outcome.version).toBe(2)
  })

  it("refuses with protocol.no_common_version, not retryable, naming both sides", () => {
    const outcome = negotiationMismatch([3, 4], [1, 2])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe("no_common_version")
    expect(outcome.offered).toEqual([3, 4])
    expect(outcome.supported).toEqual([1, 2])
    expect(outcome.error.code).toBe("protocol.no_common_version")
    expect(outcome.error.category).toBe("unsupported_capability")
    // Asserted, not assumed to follow from the category: a retry loop against a
    // version that will never parse is how one bad node exhausts a good one.
    expect(outcome.error.retryable).toBe(false)
    // The operator's next action is "upgrade the node that speaks only these",
    // so the error must say which versions each side speaks.
    expect(outcome.error.message).toContain("[3, 4]")
    expect(outcome.error.message).toContain("[1, 2]")
  })

  it("exposes the same answer through the Result flavour", () => {
    expect(negotiateProtocolVersion([1], [1])).toEqual({ ok: true, value: 1 })
    const refused = negotiateProtocolVersion([9], [1])
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.error.code).toBe("protocol.no_common_version")
  })
})

describe("this build's protocol version", () => {
  it("is a single version while M4.1-M4.9 are in flight, expressed as a list", () => {
    // Expressed as a list so adding a second version is a one-line change rather
    // than a discovery that two branches diverged. Frozen at M4.10.
    expect(supportedProtocolVersions()).toEqual([...MESH_PROTOCOL_VERSIONS])
    expect(CURRENT_MESH_PROTOCOL_VERSION).toBe(MESH_PROTOCOL_VERSIONS[MESH_PROTOCOL_VERSIONS.length - 1])
  })

  it("is not the record schema version", () => {
    // Three axes: shape (schemaVersion 2), dialect (protocolVersion 1), storage
    // (the database version). Collapsing any two of them turns a routine change
    // into a mesh-wide incompatibility.
    expect(CURRENT_MESH_PROTOCOL_VERSION).toBe(1)
  })
})

describe("validateOfferedVersions", () => {
  it("accepts a well-formed offer and de-duplicates it", () => {
    expect(validateOfferedVersions([1, 2])).toEqual({ ok: true, value: [1, 2] })
    expect(validateOfferedVersions([2, 2, 1])).toEqual({ ok: true, value: [2, 1] })
  })

  it("names the offending INDEX for a malformed version", () => {
    // A malformed element that negotiates to "no common version" reads as a
    // compatibility problem when it is actually a sender bug.
    const outcome = validateOfferedVersions([1, 0])
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.code).toBe("protocol.invalid_version_offer")
    expect(outcome.ok === false && outcome.error.message).toContain("index 1")
  })

  it("refuses an empty offer as a sender bug, not a compatibility problem", () => {
    const outcome = validateOfferedVersions([])
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error.code).toBe("protocol.empty_version_offer")
  })

  it("refuses non-integers and negatives", () => {
    for (const bad of [[1.5], [-1], ["1"], [null], [Number.MAX_SAFE_INTEGER + 2]]) {
      expect(validateOfferedVersions(bad as readonly unknown[]).ok, JSON.stringify(bad)).toBe(false)
    }
  })
})

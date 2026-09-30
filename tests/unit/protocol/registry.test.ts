import { describe, expect, it } from "vitest"
import { z } from "zod"
import { CURRENT_SCHEMA_VERSION, SCHEMA_VERSIONS } from "../../../src/orchestration/identifiers.js"
import { parseVersioned, safeParseVersioned } from "../../../src/orchestration/versioning.js"
import {
  MESH_RECORD_SHAPES,
  MESH_RECORD_TYPES,
  UnknownMeshRecordTypeError,
  UnversionedRecordError,
  UnsupportedSchemaVersionError,
  declaredFamilyVersions,
  isMeshRecordType,
  parseMeshEnvelope,
  readRecordType,
  safeParseMeshEnvelope,
} from "../../../src/mesh/protocol/registry.js"
import { defineFamily, meshEnvelopeHeadersSchema, meshRecordTypeSchema } from "../../../src/mesh/protocol/envelope.js"
import { ALL_RECORD_TYPES, sampleEnvelope } from "./fixtures.js"

/**
 * The registry IS the M4-V mechanism (§3 of the spec), so the properties below
 * are about the mechanism rather than about any one family.
 *
 * Four claims, each of which the previous state of this code did not actually
 * hold and each of which is therefore asserted negatively:
 *
 *   1. EVERY `recordType` is reachable through `parseMeshEnvelope`. A family
 *      that exists but is not in the table is a record that parses nowhere, and
 *      "unreachable" and "silently ignored" look identical from the peer.
 *   2. An unknown `recordType` is refused with `protocol.unknown_record_type`
 *      and NEVER parsed as a generic object. Parsing it "well enough" is how a
 *      record from the future gets partially read by a build that does not
 *      understand it.
 *   3. The table is EXHAUSTIVE against §4's nine families. The check is against
 *      the families themselves, not against a list in this test.
 *   4. A family that declares no shape for a SUPPORTED version is refused. This
 *      is the case a `z.literal`-era reader could not express, and it is the one
 *      that makes a versioned table worth having.
 */

/** §4 of the spec, as families rather than as record types. */
const SPEC_FAMILIES: readonly { family: string; recordTypes: readonly string[] }[] = [
  { family: "mesh.enrollment", recordTypes: ["mesh.enrollment.request", "mesh.enrollment.response"] },
  { family: "mesh.heartbeat", recordTypes: ["mesh.heartbeat"] },
  { family: "mesh.command", recordTypes: ["mesh.command"] },
  { family: "mesh.ack", recordTypes: ["mesh.ack"] },
  { family: "mesh.event", recordTypes: ["mesh.event"] },
  { family: "mesh.lease", recordTypes: ["mesh.lease"] },
  { family: "mesh.reconciliation", recordTypes: ["mesh.reconciliation.request", "mesh.reconciliation.response"] },
  { family: "mesh.terminal", recordTypes: ["mesh.terminal.control", "mesh.terminal.data"] },
]

describe("every record type is reachable", () => {
  it("has an entry in the shape table and a sample that parses", () => {
    for (const recordType of ALL_RECORD_TYPES) {
      expect(Object.keys(MESH_RECORD_SHAPES), recordType).toContain(recordType)
      expect(MESH_RECORD_SHAPES[recordType][CURRENT_SCHEMA_VERSION], recordType).toBeDefined()
      const parsed = parseMeshEnvelope(sampleEnvelope(recordType))
      expect(parsed.recordType, recordType).toBe(recordType)
      expect(parsed.schemaVersion, recordType).toBe(CURRENT_SCHEMA_VERSION)
    }
  })

  it("has no table entry that the recordType union does not name", () => {
    // The other direction, which is the one that leaks: a shape table entry for
    // a type nothing can send is a family that was started and abandoned, and it
    // widens the "known families" text in every refusal message.
    expect(Object.keys(MESH_RECORD_SHAPES).sort()).toEqual([...MESH_RECORD_TYPES].sort())
    expect(meshRecordTypeSchema.options.sort()).toEqual([...MESH_RECORD_TYPES].sort())
    expect(ALL_RECORD_TYPES).toEqual(MESH_RECORD_TYPES)
  })

  it("parses to a discriminated union, so a gateway can switch on the record type", () => {
    // `payload: unknown` would push a cast to every call site, and a cast at
    // every call site is a cast that will eventually be wrong at one.
    for (const recordType of ALL_RECORD_TYPES) {
      const parsed = parseMeshEnvelope(sampleEnvelope(recordType))
      expect(parsed.recordType).toBe(recordType)
      // DELIBERATE structural narrowing: the point of the assertion is that
      // TypeScript narrows `payload` from `recordType` alone, which can only be
      // observed by naming a member the chosen family has.
      if (parsed.recordType === "mesh.command") expect(parsed.payload.commandId).toBeDefined()
      if (parsed.recordType === "mesh.heartbeat") expect(parsed.payload.sequence).toBeDefined()
      if (parsed.recordType === "mesh.lease") expect(parsed.payload.operation).toBeDefined()
      if (parsed.recordType === "mesh.terminal.data") expect(parsed.payload.chunk).toBeDefined()
    }
  })
})

describe("an unknown record type is refused, never generically parsed", () => {
  it("refuses a record type this build has never heard of", () => {
    for (const recordType of ["mesh.telemetry.stream", "mesh.ack.v2", "MESH.HEARTBEAT", "", "mesh.command "]) {
      const alien = { ...sampleEnvelope("mesh.heartbeat"), recordType }
      expect(readRecordType(alien), recordType).toBeNull()
      expect(isMeshRecordType(recordType), recordType).toBe(false)
      expect(() => parseMeshEnvelope(alien), recordType).toThrow(UnknownMeshRecordTypeError)
    }
  })

  it("answers with protocol.unknown_record_type, which is NOT a version error", () => {
    // A gateway that answered "upgrade me" here would send an operator to
    // upgrade a node whose sender is emitting a family that does not exist.
    const alien = { ...sampleEnvelope("mesh.heartbeat"), recordType: "mesh.telemetry.stream" }
    const safe = safeParseMeshEnvelope(alien)
    expect(safe.ok).toBe(false)
    expect(safe.ok === false && safe.versionError).toBe(false)
    expect(safe.ok === false && safe.error.code).toBe("protocol.unknown_record_type")
    expect(safe.ok === false && safe.error.retryable).toBe(false)
    // The refusal names every family it DOES know, so the operator does not have
    // to read the source to find out what the mesh supports.
    for (const known of MESH_RECORD_TYPES) expect(safe.ok === false && safe.error.message).toContain(known)
  })

  it("does not reach the version dispatch at all for an unknown type", () => {
    // A record that is both an unknown type AND at an unknown version gets the
    // type answer, because a version question about a family that does not exist
    // is not a question.
    const alien = { ...sampleEnvelope("mesh.heartbeat"), recordType: "mesh.telemetry.stream", schemaVersion: 99 }
    const safe = safeParseMeshEnvelope(alien)
    expect(safe.ok === false && safe.error.code).toBe("protocol.unknown_record_type")
  })

  it("refuses a value that is not a record at all", () => {
    for (const value of [null, undefined, 42, "mesh.heartbeat", [], true, () => undefined]) {
      expect(readRecordType(value)).toBeNull()
      expect(safeParseMeshEnvelope(value).ok).toBe(false)
      expect(() => parseMeshEnvelope(value)).toThrow(UnknownMeshRecordTypeError)
    }
  })

  it("reads a recordType without validating anything else, because that is all it claims to do", () => {
    const declared = sampleEnvelope("mesh.lease", { schemaVersion: 99, issuedAt: "not-a-time" })
    expect(readRecordType(declared)).toBe("mesh.lease")
    expect(safeParseMeshEnvelope(declared).ok).toBe(false)
  })
})

describe("the table is exhaustive against the spec's nine families", () => {
  it("covers every family §4 names, in both directions where the family is bidirectional", () => {
    expect(SPEC_FAMILIES).toHaveLength(8)
    const declared = new Set(MESH_RECORD_TYPES)
    for (const { family, recordTypes } of SPEC_FAMILIES) {
      for (const recordType of recordTypes) {
        expect(declared.has(recordType as never), `${family} -> ${recordType}`).toBe(true)
      }
    }
  })

  it("declares no family §4 does not name", () => {
    const specTypes = new Set(SPEC_FAMILIES.flatMap(({ recordTypes }) => recordTypes))
    for (const recordType of MESH_RECORD_TYPES) expect(specTypes.has(recordType), recordType).toBe(true)
  })

  it("gives a bidirectional family a distinct record type in each direction", () => {
    // A `recordType` that does not name a direction is what lets a receiver
    // refuse an inbound `mesh.command` where an outbound one was expected.
    for (const pair of [
      ["mesh.enrollment.request", "mesh.enrollment.response"],
      ["mesh.reconciliation.request", "mesh.reconciliation.response"],
      ["mesh.terminal.control", "mesh.terminal.data"],
    ] as const) {
      for (const recordType of pair) expect(MESH_RECORD_TYPES).toContain(recordType)
      expect(pair[0]).not.toBe(pair[1])
    }
  })
})

describe("a family declaring no shape for a supported version is refused", () => {
  /** A minimal family, used to prove the version table is a real dispatch. */
  const minimalFamily = defineFamily({
    recordType: "mesh.lease",
    payloadSchema: z.object({ marker: z.literal("v1-only") }).strict(),
  })

  it("refuses a record at a supported version this family never declared", () => {
    // The case a `z.literal(1)`-era reader could not express: version 1 is
    // perfectly readable by this build in general and this family has no v2.
    expect(SCHEMA_VERSIONS).toContain(1)
    const record = { ...sampleEnvelope("mesh.lease"), schemaVersion: 1 }
    expect(() => parseMeshEnvelope(record)).toThrow(UnsupportedSchemaVersionError)
    const safe = safeParseMeshEnvelope(record)
    expect(safe.ok).toBe(false)
    expect(safe.ok === false && safe.versionError).toBe(true)
    expect(safe.ok === false && safe.error.code).toBe("protocol.unsupported_schema_version")
  })

  it("reports the versions the family DOES declare, so the message is actionable", () => {
    const safe = safeParseMeshEnvelope({ ...sampleEnvelope("mesh.lease"), schemaVersion: 1 })
    expect(safe.ok === false && safe.error.message).toContain(String(CURRENT_SCHEMA_VERSION))
    expect(safe.ok === false && safe.error.message).toContain("mesh.lease")
  })

  it("still parses the version the family does declare", () => {
    // The table is a dispatch, not a blanket refusal: a v1 reader must be able
    // to read a v1 family or the mechanism buys nothing.
    const shapes = { [CURRENT_SCHEMA_VERSION]: minimalFamily.envelopeSchema }
    const record = { ...sampleEnvelope("mesh.lease"), payload: { marker: "v1-only" } }
    const parsed = parseVersioned<{ readonly recordType: string; readonly payload: { readonly marker: string } }>(
      "mesh.lease",
      record,
      shapes,
    )
    expect(parsed.recordType).toBe("mesh.lease")
    expect(parsed.payload.marker).toBe("v1-only")
  })

  it("refuses a family whose table is empty, rather than falling back to a default", () => {
    const record = sampleEnvelope("mesh.lease")
    expect(() => parseVersioned("mesh.lease", record, {})).toThrow(UnsupportedSchemaVersionError)
    const safe = safeParseVersioned("mesh.lease", record, {})
    expect(safe.ok).toBe(false)
    expect(safe.ok === false && safe.versionError).toBe(true)
  })

  it("refuses an unversioned record before it ever consults a shape", () => {
    const record = sampleEnvelope("mesh.lease")
    delete (record as Record<string, unknown>).schemaVersion
    expect(() => parseVersioned("mesh.lease", record, MESH_RECORD_SHAPES["mesh.lease"])).toThrow(UnversionedRecordError)
    const safe = safeParseVersioned("mesh.lease", record, MESH_RECORD_SHAPES["mesh.lease"])
    expect(safe.ok === false && safe.error.code).toBe("protocol.unversioned_record")
    expect(safe.ok === false && safe.versionError).toBe(true)
  })
})

describe("what each family says about itself", () => {
  it("reports exactly one declared version, and it is the current one", () => {
    const declared = declaredFamilyVersions()
    for (const recordType of ALL_RECORD_TYPES) {
      expect(declared[recordType], recordType).toEqual([CURRENT_SCHEMA_VERSION])
    }
    expect(Object.keys(declared).sort()).toEqual([...MESH_RECORD_TYPES].sort())
  })

  it("gives a per-family answer, because a build can know one family and not another", () => {
    // "Which versions does this build understand" has a per-family answer, and a
    // single global answer is misleading: a build can read a `mesh.heartbeat` at
    // a version where it has never heard of `mesh.terminal`.
    const declared = declaredFamilyVersions()
    expect(declared["mesh.heartbeat"]).toBeDefined()
    expect(declared["mesh.terminal.data"]).toBeDefined()
    expect(declared["mesh.terminal.data"]).not.toBe(declared["mesh.heartbeat"])
  })

  it("reports versions in ascending order, whatever order the table was written in", () => {
    for (const versions of Object.values(declaredFamilyVersions())) {
      expect([...versions].sort((a, b) => a - b)).toEqual([...versions])
    }
  })
})

describe("the envelope headers are the same headers for every family", () => {
  it("carries exactly the members §2 names, on every parsed record", () => {
    // A family that quietly added a header would be a family whose records are
    // not interchangeable with the others, and `.strict()` at the payload level
    // would not catch it.
    const expected = [
      "schemaVersion",
      "messageId",
      "correlationId",
      "causation",
      "senderNodeId",
      "recipientNodeId",
      "protocolVersion",
      "issuedAt",
      "expiresAt",
      "recordType",
      "payload",
    ].sort()
    for (const recordType of ALL_RECORD_TYPES) {
      const parsed = parseMeshEnvelope(sampleEnvelope(recordType))
      expect(Object.keys(parsed).sort(), recordType).toEqual(expected)
    }
    expect(Object.keys(meshEnvelopeHeadersSchema.shape).sort()).toEqual(expected.filter((key) => key !== "recordType" && key !== "payload"))
  })

  it("carries the schema version through the parse, so a caller can tell which shape it received", () => {
    // The point of the whole mechanism. A parsed envelope that had dropped its
    // version would leave the caller unable to say what it was handed, and the
    // type would be pushing every consumer back onto the untyped input.
    for (const recordType of ALL_RECORD_TYPES) {
      const parsed = parseMeshEnvelope(sampleEnvelope(recordType))
      expect(parsed.schemaVersion, recordType).toBe(CURRENT_SCHEMA_VERSION)
      const safe = safeParseMeshEnvelope(sampleEnvelope(recordType))
      expect(safe.ok && safe.version, recordType).toBe(CURRENT_SCHEMA_VERSION)
    }
  })
})

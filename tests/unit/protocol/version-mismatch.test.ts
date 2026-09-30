import { describe, expect, it } from "vitest"
import {
  CURRENT_SCHEMA_VERSION,
  FROZEN_DOMAIN_SCHEMA_VERSION,
  SCHEMA_VERSIONS,
} from "../../../src/orchestration/identifiers.js"
import {
  UnversionedRecordError,
  UnsupportedSchemaVersionError,
} from "../../../src/orchestration/versioning.js"
import {
  MESH_RECORD_SHAPES,
  MESH_RECORD_TYPES,
  UnknownMeshRecordTypeError,
  declaredFamilyVersions,
  isMeshRecordType,
  parseMeshEnvelope,
  readRecordType,
  safeParseMeshEnvelope,
} from "../../../src/mesh/protocol/registry.js"
import type { MeshRecordType } from "../../../src/mesh/protocol/envelope.js"
import { commandFamily } from "../../../src/mesh/protocol/command.js"
import { ALL_RECORD_TYPES, sampleEnvelope } from "./fixtures.js"

/**
 * §5 of the sequence diagrams, and the M4-V carry-forward criterion, stated once
 * per record family.
 *
 * The three refusals the milestone names are distinct, and each of them is a
 * failure a node MUST make loudly:
 *
 *   - a version outside `SCHEMA_VERSIONS`            -> unsupported, upgrade
 *   - a version in `SCHEMA_VERSIONS` the family never declared -> unsupported, upgrade
 *   - no version at all                              -> the sender is not conforming
 *
 * What is forbidden in all three is COERCION: reading a v3 record with the v2
 * shape because "the fields I need are probably still there". The Milestone 3
 * shape break is what that produces — a record whose `session.state` became
 * `lifecycleState` + `observedState` with no version to name it with, so the older
 * binary claimed to understand a record it had silently misread. The tests below
 * are deliberately exhaustive over the families rather than sampling two of them:
 * a family with no version-mismatch test is a family nobody has ever tested
 * against a future.
 */

const UNKNOWN_VERSION = 3
/** In `SCHEMA_VERSIONS`, but no mesh family declares it: they are all v2. */
const SUPPORTED_BUT_UNDECLARED = FROZEN_DOMAIN_SCHEMA_VERSION

describe("mesh wire versioning", () => {
  it("writes every mesh family at CURRENT_SCHEMA_VERSION and none at anything else", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2)
    for (const recordType of ALL_RECORD_TYPES) {
      expect(declaredFamilyVersions()[recordType], recordType).toEqual([CURRENT_SCHEMA_VERSION])
    }
  })

  it("never lets the database version into a wire record", () => {
    // Two axes, and the confusion between them is silent: both happen to be 2
    // today, so writing the wrong one compiles, passes review, and only breaks
    // when a migration is added and every wire record suddenly looks "wrong".
    const declared = new Set(
      Object.values(MESH_RECORD_SHAPES).flatMap((shapes) => Object.keys(shapes).map(Number)),
    )
    expect([...declared].sort()).toEqual([CURRENT_SCHEMA_VERSION])
    expect(SCHEMA_VERSIONS).toEqual([FROZEN_DOMAIN_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION])
  })

  it("exposes a shape table for every record type and no extra ones", () => {
    expect(Object.keys(MESH_RECORD_SHAPES).sort()).toEqual([...ALL_RECORD_TYPES].sort())
    for (const recordType of ALL_RECORD_TYPES) {
      expect(MESH_RECORD_SHAPES[recordType][CURRENT_SCHEMA_VERSION], recordType).toBeDefined()
    }
  })

  for (const recordType of ALL_RECORD_TYPES) {
    describe(recordType, () => {
      it("parses a well-formed record at the version it declares", () => {
        const envelope = parseMeshEnvelope(sampleEnvelope(recordType))
        expect(envelope.recordType).toBe(recordType)
        expect(envelope.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
      })

      it("rejects a record at an UNKNOWN version loudly, naming the family and what it supports", () => {
        expect(() => parseMeshEnvelope(sampleEnvelope(recordType, { schemaVersion: UNKNOWN_VERSION }))).toThrow(
          UnsupportedSchemaVersionError,
        )
        try {
          parseMeshEnvelope(sampleEnvelope(recordType, { schemaVersion: UNKNOWN_VERSION }))
          expect.unreachable("an unknown version must not parse")
        } catch (error) {
          const failure = error as UnsupportedSchemaVersionError
          expect(failure.recordType).toBe(recordType)
          expect(failure.received).toBe(UNKNOWN_VERSION)
          // The message is the operator's only clue, and §5 of the diagrams
          // requires it to name the family and the readable versions so an
          // operator can act without reading the source.
          expect(failure.message).toContain(recordType)
          expect(failure.message).toContain(String(UNKNOWN_VERSION))
          expect(failure.message).toContain(CURRENT_SCHEMA_VERSION.toString())
        }
      })

      it("rejects a SUPPORTED but family-UNDECLARED version rather than falling back to the current shape", () => {
        // This is the case a `z.literal(1)`-era reader could not express: version
        // 1 is perfectly readable by this build in general, and this family has
        // no v1. Reading it with the v2 shape would be the coercion the whole
        // mechanism exists to prevent.
        expect(SUPPORTED_BUT_UNDECLARED).not.toBe(CURRENT_SCHEMA_VERSION)
        expect(() => parseMeshEnvelope(sampleEnvelope(recordType, { schemaVersion: SUPPORTED_BUT_UNDECLARED }))).toThrow(
          UnsupportedSchemaVersionError,
        )
        const safe = safeParseMeshEnvelope(sampleEnvelope(recordType, { schemaVersion: SUPPORTED_BUT_UNDECLARED }))
        expect(safe.ok).toBe(false)
        expect(safe.ok === false && safe.versionError).toBe(true)
        expect(safe.ok === false && safe.error.code).toBe("protocol.unsupported_schema_version")
      })

      it("rejects an UNVERSIONED record rather than assuming the current version", () => {
        const envelope = sampleEnvelope(recordType)
        delete (envelope as Record<string, unknown>).schemaVersion
        expect(() => parseMeshEnvelope(envelope)).toThrow(UnversionedRecordError)
        const safe = safeParseMeshEnvelope(envelope)
        expect(safe.ok).toBe(false)
        expect(safe.ok === false && safe.versionError).toBe(true)
        expect(safe.ok === false && safe.error.code).toBe("protocol.unversioned_record")
      })

      it("refuses a non-numeric version instead of coercing it to a number", () => {
        for (const bogus of ["2", true, null, [2], { version: 2 }]) {
          expect(
            safeParseMeshEnvelope(sampleEnvelope(recordType, { schemaVersion: bogus })).ok,
            `${recordType} @ ${JSON.stringify(bogus)}`,
          ).toBe(false)
        }
      })

      it("distinguishes a shape violation at a SUPPORTED version from a version problem", () => {
        // `versionError: false` is the field that tells an SSE/WS gateway to
        // answer "your sender is broken" instead of "upgrade the peer", so it
        // must not be set merely because parsing failed.
        const broken = sampleEnvelope(recordType)
        delete (broken as Record<string, unknown>).senderNodeId
        const safe = safeParseMeshEnvelope(broken)
        expect(safe.ok).toBe(false)
        expect(safe.ok === false && safe.versionError).toBe(false)
        expect(safe.ok === false && safe.error.code).toBe("protocol.record_invalid")
        expect(safe.ok === false && safe.error.retryable).toBe(false)
      })
    })
  }

  it("never answers a version mismatch with a retryable error", () => {
    // A node that keeps retrying a version it will never understand is a
    // resource-exhaustion vector against the peer, which is why `retryable:false`
    // is asserted rather than assumed to follow from the category.
    for (const recordType of ALL_RECORD_TYPES) {
      for (const schemaVersion of [UNKNOWN_VERSION, SUPPORTED_BUT_UNDECLARED]) {
        const safe = safeParseMeshEnvelope(sampleEnvelope(recordType, { schemaVersion }))
        expect(safe.ok, `${recordType}@${schemaVersion}`).toBe(false)
        expect(safe.ok === false && safe.error.retryable).toBe(false)
      }
    }
  })

  it("refuses an unknown record type and never parses it as a generic object", () => {
    const alien = { ...sampleEnvelope("mesh.heartbeat"), recordType: "mesh.telemetry.stream" }
    expect(readRecordType(alien)).toBeNull()
    expect(isMeshRecordType("mesh.telemetry.stream")).toBe(false)
    expect(() => parseMeshEnvelope(alien)).toThrow(UnknownMeshRecordTypeError)

    const safe = safeParseMeshEnvelope(alien)
    expect(safe.ok).toBe(false)
    // NOT one of the three version answers: a gateway that answered "upgrade me"
    // here would send an operator to upgrade a node whose sender is emitting a
    // family that does not exist, and the refusal must name the known families.
    expect(safe.ok === false && safe.error.code).toBe("protocol.unknown_record_type")
    expect(safe.ok === false && safe.error.retryable).toBe(false)
    for (const known of ALL_RECORD_TYPES) expect(safe.ok === false && safe.error.message).toContain(known)
  })

  it("refuses a record that is not an object at all", () => {
    for (const value of [null, undefined, 42, "mesh.heartbeat", [], true]) {
      expect(readRecordType(value)).toBeNull()
      expect(safeParseMeshEnvelope(value).ok).toBe(false)
      expect(() => parseMeshEnvelope(value)).toThrow(UnknownMeshRecordTypeError)
    }
  })

  it("reads a recordType without validating anything else", () => {
    // It is a recordType reader, not a record reader: the version and the shape
    // are the registry's business, and a value that merely LOOKS like a mesh
    // record must not be treated as one here.
    const declared = sampleEnvelope("mesh.lease", { schemaVersion: 99, issuedAt: "not-a-time" })
    expect(readRecordType(declared)).toBe("mesh.lease")
    expect(safeParseMeshEnvelope(declared).ok).toBe(false)
  })

  it("is the only handle a family exposes: no bare payload schema to parse directly", () => {
    // The M4-V mechanism is defeated the moment a caller can `parse` a family
    // object directly, because that path skips the version dispatch entirely.
    // Asserted on the SHAPE of what a family exports rather than on a comment
    // saying so, because the comment is exactly what goes stale. The cast is
    // deliberate and unavoidable: `Family<T>` is an interface, so TypeScript
    // refuses to widen it to `Record<string, unknown>` for a key lookup that is
    // the assertion itself.
    const exported = commandFamily as unknown as Record<string, unknown>
    expect(Object.keys(commandFamily).sort()).toEqual(["envelopeSchema", "recordType", "shapes"])
    expect(exported.payloadSchema).toBeUndefined()
    expect(exported.schema).toBeUndefined()
    expect(exported.payload).toBeUndefined()
  })

  it("keeps a v1 frozen domain payload inside a v2 wire record without restamping it", () => {
    // The command carried by a v2 `mesh.command` is an M0 domain record at the
    // FROZEN version. Restamping it to 2 would falsely claim its shape changed,
    // and the domain freeze is what the M0 sign-off script is digest-bound to.
    const envelope = parseMeshEnvelope(sampleEnvelope("mesh.command"))
    const payload = (envelope.payload as { command: { schemaVersion: number } }).command
    expect(envelope.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(payload.schemaVersion).toBe(FROZEN_DOMAIN_SCHEMA_VERSION)
  })
})

describe("registry type helpers", () => {
  it("narrows a known type and rejects an unknown one", () => {
    const known: MeshRecordType = "mesh.ack"
    expect(isMeshRecordType(known)).toBe(true)
    expect(isMeshRecordType("mesh.ack.v2")).toBe(false)
    expect(isMeshRecordType(undefined)).toBe(false)
  })

  it("keeps the recordType union and the registry table in step", () => {
    expect(new Set(MESH_RECORD_TYPES).size).toBe(MESH_RECORD_TYPES.length)
  })
})

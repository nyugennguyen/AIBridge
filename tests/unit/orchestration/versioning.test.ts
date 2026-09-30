import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  CURRENT_DATABASE_VERSION,
} from "../../../src/orchestration/event-store/schema.js"
import {
  CURRENT_SCHEMA_VERSION,
  FROZEN_DOMAIN_SCHEMA_VERSION,
  SCHEMA_VERSIONS,
  schemaVersionSchema,
  version,
} from "../../../src/orchestration/identifiers.js"
import {
  UnversionedRecordError,
  UnsupportedSchemaVersionError,
  assertSupportedSchemaVersion,
  isSupportedSchemaVersion,
  parseVersioned,
  readSchemaVersion,
  safeParseVersioned,
  supportedSchemaVersions,
} from "../../../src/orchestration/versioning.js"
import { meshSchema } from "../../../src/orchestration/schemas.js"

/**
 * M4-V — a record shape change must be *versionable*, and an unknown version
 * must be rejected loudly.
 *
 * Before M4.0 `schemaVersionSchema` was `z.literal(1)`. There was exactly one
 * writable version and exactly one readable version, so changing a persisted
 * shape was necessarily a silent in-place overwrite — which is exactly what
 * Milestone 3 did to `run`, `task` and `session`, and the break could not be
 * named, let alone migrated. These tests are the evidence that the mechanism
 * now exists, in both directions: a version bump is honoured, and an unknown
 * version is refused rather than coerced.
 */

const NOW = "2026-09-28T00:00:00Z"

function meshRecord(schemaVersion: unknown) {
  return { schemaVersion, meshId: "mesh-1", displayName: "Mesh", createdAt: NOW }
}

describe("M4-V supported record versions", () => {
  it("declares a reader set that is strictly larger than the single literal it replaced", () => {
    expect(SCHEMA_VERSIONS.length).toBeGreaterThan(1)
    expect(SCHEMA_VERSIONS).toContain(FROZEN_DOMAIN_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(SCHEMA_VERSIONS[SCHEMA_VERSIONS.length - 1])
  })

  it("keeps SCHEMA_VERSIONS and schemaVersionSchema in agreement in BOTH directions", () => {
    // A version listed as readable but refused by the schema would be a silent
    // hole; a version the schema accepts but the list omits would be a version
    // no `parseVersioned` call site can dispatch on.
    for (const version of SCHEMA_VERSIONS) {
      expect(schemaVersionSchema.safeParse(version).success, `v${version} must be readable`).toBe(true)
      expect(isSupportedSchemaVersion(version)).toBe(true)
    }
    for (const candidate of [0, 3, 4, 99, -1, 1.5, 2.0001]) {
      const listed = (SCHEMA_VERSIONS as readonly number[]).includes(candidate)
      expect(schemaVersionSchema.safeParse(candidate).success, `v${candidate}`).toBe(listed)
      expect(isSupportedSchemaVersion(candidate)).toBe(listed)
    }
  })

  it("refuses a non-numeric version rather than coercing it", () => {
    for (const bad of ["1", " 1 ", true, null, {}, [], 1n as unknown]) {
      expect(schemaVersionSchema.safeParse(bad).success, `${String(bad)} must be refused`).toBe(false)
      expect(isSupportedSchemaVersion(bad)).toBe(false)
    }
  })

  it("exposes the readable set for protocol negotiation", () => {
    expect(supportedSchemaVersions()).toEqual([...SCHEMA_VERSIONS])
  })

  it("keeps the DATABASE version a separate axis from the RECORD version", () => {
    // The Milestone 3 re-approval recorded that the documented rollback boundary
    // did not account for event-payload compatibility. A payload shape change is
    // answered by a record version bump; a migration answers a layout change.
    // Conflating the two constants is how the unversionable break happened.
    expect(CURRENT_DATABASE_VERSION).toBe(2)
    expect(FROZEN_DOMAIN_SCHEMA_VERSION).toBe(1)
    // Both are 2 today, which is exactly why the naming had to be made
    // explicit: they are different axes that happen to coincide numerically.
    expect(typeof CURRENT_DATABASE_VERSION).toBe("number")
  })
})

describe("M4-V versioned record parsing", () => {
  const v1Shape = z.object({ schemaVersion: version(1), meshId: z.string(), name: z.string() }).strict()
  const v2Shape = z
    .object({ schemaVersion: version(2), meshId: z.string(), name: z.string(), renamed: z.string() })
    .strict()
  const both = { 1: v1Shape, 2: v2Shape } as const
  const onlyV1 = { 1: v1Shape } as const

  it("reads the version from the record before it knows the shape", () => {
    expect(readSchemaVersion("synthetic", { schemaVersion: 1 })).toBe(1)
    expect(readSchemaVersion("synthetic", { schemaVersion: 2 })).toBe(2)
  })

  it("dispatches each version to its OWN shape — a v1 record is never read as v2", () => {
    const v1Record = parseVersioned<z.infer<typeof v1Shape>>("synthetic", { schemaVersion: 1, meshId: "m", name: "n" }, both)
    expect(v1Record).toEqual({ schemaVersion: 1, meshId: "m", name: "n" })
    // The v1 record has no `renamed`. Reading it with the v2 shape would either
    // fail or, worse, be "repaired" by a default — which is the coercion this
    // mechanism exists to forbid.
    expect(v2Shape.safeParse(v1Record).success).toBe(false)

    const v2Record = parseVersioned<z.infer<typeof v2Shape>>(
      "synthetic",
      { schemaVersion: 2, meshId: "m", name: "n", renamed: "r" },
      both,
    )
    expect(v2Record.renamed).toBe("r")
  })

  it("rejects an unknown version loudly, naming what IS supported", () => {
    for (const bad of [0, 3, 99, 1.5, "2", null, true]) {
      let thrown: unknown
      try {
        parseVersioned("synthetic", { schemaVersion: bad, meshId: "m", name: "n" }, both)
      } catch (error) {
        thrown = error
      }
      expect(thrown, `schemaVersion ${JSON.stringify(bad)} must throw`).toBeInstanceOf(UnsupportedSchemaVersionError)
      expect((thrown as UnsupportedSchemaVersionError).recordType).toBe("synthetic")
      expect((thrown as Error).message).toContain("cannot read")
      expect((thrown as Error).message).toContain("Supported: [1, 2]")
    }
  })

  it("rejects a supported version the family never declared a shape for", () => {
    // Version 2 is readable by this build, but `onlyV1` never defined a v2
    // shape. Falling back to the v1 shape here would be the node guessing at a
    // shape it does not understand.
    expect(() => parseVersioned("synthetic", { schemaVersion: 2, meshId: "m", name: "n" }, onlyV1)).toThrow(
      UnsupportedSchemaVersionError,
    )
  })

  it("rejects a record with no version at all rather than assuming the current one", () => {
    for (const unversioned of [{}, { meshId: "m", name: "n" }, null, undefined, 42, "record", []]) {
      expect(() => parseVersioned("synthetic", unversioned, both)).toThrow(UnversionedRecordError)
    }
  })

  it("rejects a record that satisfies its own version's support set but not its shape", () => {
    // The distinction matters operationally: a bad record is the sender's bug,
    // an unsupported version is a protocol skew the operator must resolve.
    const wrongShape = safeParseVersioned("synthetic", { schemaVersion: 1, meshId: "m" }, both)
    expect(wrongShape.ok).toBe(false)
    expect(wrongShape.ok === false && wrongShape.versionError).toBe(false)
    expect(wrongShape.ok === false && wrongShape.error.code).toBe("protocol.record_invalid")

    const wrongVersion = safeParseVersioned("synthetic", { schemaVersion: 3, meshId: "m", name: "n" }, both)
    expect(wrongVersion.ok).toBe(false)
    expect(wrongVersion.ok === false && wrongVersion.versionError).toBe(true)
    expect(wrongVersion.ok === false && wrongVersion.error.code).toBe("protocol.unsupported_schema_version")

    const unversioned = safeParseVersioned("synthetic", { meshId: "m", name: "n" }, both)
    expect(unversioned.ok === false && unversioned.error.code).toBe("protocol.unversioned_record")
  })

  it("never marks a version error retryable", () => {
    const result = safeParseVersioned("synthetic", { schemaVersion: 7 }, both)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.retryable).toBe(false)
  })

  it("carries the read version out of a successful parse", () => {
    const result = safeParseVersioned("synthetic", { schemaVersion: 2, meshId: "m", name: "n", renamed: "r" }, both)
    expect(result.ok).toBe(true)
    expect(result.ok && result.version).toBe(2)
  })

  it("asserts a version at a seam that already has a schema", () => {
    expect(assertSupportedSchemaVersion("synthetic", { schemaVersion: 2 })).toBe(2)
    expect(() => assertSupportedSchemaVersion("synthetic", { schemaVersion: 4 })).toThrow(UnsupportedSchemaVersionError)
  })

  it("converts a version failure into a contract error the mesh gateways can return", () => {
    const error = new UnsupportedSchemaVersionError("heartbeat", 3)
    const contract = error.toContractError()
    expect(contract.category).toBe("validation")
    expect(contract.code).toBe("protocol.unsupported_schema_version")
    expect(contract.retryable).toBe(false)
    expect(contract.message).toContain("heartbeat")
    expect(new UnversionedRecordError("heartbeat").toContractError().code).toBe("protocol.unversioned_record")
  })
})

describe("M4-V the frozen domain aggregates", () => {
  it("reads a mesh record at every supported version with identical shape constraints", () => {
    for (const supported of SCHEMA_VERSIONS) {
      expect(meshSchema.parse(meshRecord(supported)).meshId).toBe("mesh-1")
    }
  })

  it("still refuses a missing version and a version outside the set", () => {
    expect(meshSchema.safeParse(meshRecord(undefined)).success).toBe(false)
    for (const outside of [0, 3, 99, -1, "1", null]) {
      expect(meshSchema.safeParse(meshRecord(outside)).success, `${String(outside)} must be refused`).toBe(false)
    }
  })
})

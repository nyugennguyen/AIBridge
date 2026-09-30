import { z } from "zod"
import {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_VERSIONS,
  schemaVersionSchema,
  type SchemaVersion,
} from "./identifiers.js"
import { createContractError, type ContractError } from "./errors.js"

/**
 * Record versioning — the M4-V mechanism.
 *
 * A record family declares the shape of each version it can read, and every read
 * goes through {@link parseVersioned}. Three properties follow, and each is the
 * negation of a defect Milestone 3 actually had:
 *
 * 1. **A shape change is versionable.** A family adds `shapesByVersion[2]` and
 *    writes new records at version 2. A version-1 record is still read with the
 *    version-1 shape; it is never re-interpreted with the version-2 one.
 * 2. **An unknown version is rejected loudly.** `shapesByVersion[99]` is not
 *    consulted because 99 is not in `SCHEMA_VERSIONS`; the record is refused
 *    with {@link UnsupportedSchemaVersionError} and a message naming the version
 *    the reader does support. It is never coerced, defaulted, or partially read.
 * 3. **A missing version is rejected too.** An unversioned record is refused
 *    rather than assumed to be the current one, because "assume current" is
 *    precisely how a shape change becomes unrepresentable.
 *
 * The domain aggregates in `./schemas.js` are validated directly by Zod
 * (`schemaVersionSchema` is a `z.enum`, so an out-of-set version fails there);
 * they use {@link assertSupportedSchemaVersion} where a contextual error message
 * is more useful than a bare Zod issue.
 */

const SUPPORTED_VERSION_SET: ReadonlySet<number> = new Set<number>(SCHEMA_VERSIONS)

export function isSupportedSchemaVersion(value: unknown): value is SchemaVersion {
  return typeof value === "number" && SUPPORTED_VERSION_SET.has(value)
}

/** Every version this build can read, for protocol negotiation and error text. */
export function supportedSchemaVersions(): readonly SchemaVersion[] {
  return [...SCHEMA_VERSIONS]
}

/**
 * A record arrived carrying a version this build cannot read, or a version this
 * record family never defined.
 *
 * Thrown rather than returned, because every caller is a read path and there is
 * no correct fallback: a node must not guess at a shape it does not understand.
 * {@link toContractError} exists for the two seams that must return an error to
 * a peer instead of crashing (the mesh HTTP/WS gateways).
 */
export class UnsupportedSchemaVersionError extends Error {
  readonly recordType: string
  readonly received: unknown
  readonly supported: readonly SchemaVersion[]

  constructor(recordType: string, received: unknown, supported: readonly SchemaVersion[] = [...SCHEMA_VERSIONS]) {
    super(
      `Record '${recordType}' carries ${describeVersion(received)}, which this node cannot read. Supported: [${supported.join(", ")}]. The record is refused rather than coerced: a node must never guess at a shape it does not understand.`,
    )
    this.name = "UnsupportedSchemaVersionError"
    this.recordType = recordType
    this.received = received
    this.supported = supported
  }

  toContractError(): ContractError {
    return createContractError(
      "validation",
      "protocol.unsupported_schema_version",
      `${this.recordType}: ${this.message}`,
    )
  }
}

/** A record arrived with no `schemaVersion` at all. */
export class UnversionedRecordError extends Error {
  readonly recordType: string

  constructor(recordType: string) {
    super(
      `Record '${recordType}' carries no schemaVersion. Every wire and persisted record must declare the version of its shape; an unversioned record is refused rather than assumed to be the current one.`,
    )
    this.name = "UnversionedRecordError"
    this.recordType = recordType
  }

  toContractError(): ContractError {
    return createContractError("validation", "protocol.unversioned_record", `${this.recordType}: ${this.message}`)
  }
}

function describeVersion(value: unknown): string {
  if (value === undefined) return "no schemaVersion"
  if (typeof value === "number") return `schemaVersion ${value}`
  if (typeof value === "string") return `the non-numeric schemaVersion ${JSON.stringify(value)}`
  return `a non-numeric schemaVersion (${typeof value})`
}

/**
 * Reads `value.schemaVersion` and refuses anything this build cannot read.
 *
 * `value` is typed `unknown` on purpose: the whole point is that the reader
 * learns the version from the bytes before it learns the shape.
 */
export function readSchemaVersion(recordType: string, value: unknown): SchemaVersion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnversionedRecordError(recordType)
  }
  const raw = (value as { schemaVersion?: unknown }).schemaVersion
  if (raw === undefined) {
    throw new UnversionedRecordError(recordType)
  }
  if (!isSupportedSchemaVersion(raw)) {
    throw new UnsupportedSchemaVersionError(recordType, raw)
  }
  return raw
}

/**
 * Asserts that `value`'s version is readable. Use at a seam that already has a
 * Zod schema and only wants the loud, contextual failure.
 */
export function assertSupportedSchemaVersion(recordType: string, value: unknown): SchemaVersion {
  return readSchemaVersion(recordType, value)
}

/** The shape table a record family declares. */
export type VersionedShapes = { readonly [K in SchemaVersion]?: z.ZodType }

/**
 * Parses a versioned record with the shape its OWN declared version names.
 *
 * The version is read first and dispatched on second, so a record is never
 * validated against a shape belonging to a different version. A family that
 * declares no shape for a supported version still fails loudly, with
 * `UnsupportedSchemaVersionError`, rather than falling through to a default.
 */
export function parseVersioned<T>(
  recordType: string,
  value: unknown,
  shapesByVersion: VersionedShapes,
): T {
  const version = readSchemaVersion(recordType, value)
  const shape = shapesByVersion[version]
  if (shape === undefined) {
    const declared = Object.keys(shapesByVersion)
      .map((key) => Number(key))
      .filter((key) => Number.isInteger(key))
      .sort((a, b) => a - b)
    throw new UnsupportedSchemaVersionError(
      recordType,
      version,
      declared.filter(isSupportedSchemaVersion),
    )
  }
  // `schemaVersionSchema` is applied to the whole record first so a malformed
  // version is reported as a version problem rather than as a pile of unrelated
  // shape issues.
  schemaVersionSchema.parse((value as { schemaVersion: SchemaVersion }).schemaVersion)
  return shape.parse(value) as T
}

/**
 * A safe-parse flavour of {@link parseVersioned} for the read paths that must
 * answer a peer with an error instead of throwing. The `version` field of the
 * result distinguishes "shape I do not support" from "shape I support but this
 * record violates", because the two need different operator responses.
 */
export type VersionedParseResult<T> =
  | { readonly ok: true; readonly value: T; readonly version: SchemaVersion }
  | { readonly ok: false; readonly error: ContractError; readonly versionError: boolean }

export function safeParseVersioned<T>(
  recordType: string,
  value: unknown,
  shapesByVersion: VersionedShapes,
): VersionedParseResult<T> {
  let version: SchemaVersion
  try {
    version = readSchemaVersion(recordType, value)
  } catch (error) {
    if (error instanceof UnsupportedSchemaVersionError || error instanceof UnversionedRecordError) {
      return { ok: false, error: error.toContractError(), versionError: true }
    }
    throw error
  }
  const shape = shapesByVersion[version]
  if (shape === undefined) {
    const error = new UnsupportedSchemaVersionError(recordType, version, [])
    return { ok: false, error: error.toContractError(), versionError: true }
  }
  const parsed = shape.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "protocol.record_invalid",
        `${recordType} v${version} does not satisfy its declared shape: ${parsed.error.issues
          .slice(0, 8)
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("; ")}`,
      ),
      versionError: false,
    }
  }
  return { ok: true, value: parsed.data as T, version }
}

export { CURRENT_SCHEMA_VERSION, SCHEMA_VERSIONS, schemaVersionSchema }
export type { SchemaVersion }

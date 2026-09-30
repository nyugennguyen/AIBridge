import type { ContractError } from "../../orchestration/errors.js"
import { createContractError } from "../../orchestration/errors.js"
import type { SchemaVersion } from "../../orchestration/identifiers.js"
import {
  UnversionedRecordError,
  UnsupportedSchemaVersionError,
  isSupportedSchemaVersion,
  parseVersioned,
  readSchemaVersion,
  safeParseVersioned,
  type VersionedParseResult,
  type VersionedShapes,
} from "../../orchestration/versioning.js"
import { ackFamily } from "./ack.js"
import { commandFamily } from "./command.js"
import { enrollmentRequestFamily, enrollmentResponseFamily } from "./enrollment.js"
import { MESH_RECORD_TYPES, type MeshRecordType } from "./envelope.js"
import { eventFamily } from "./event.js"
import { heartbeatFamily } from "./heartbeat.js"
import { leaseFamily } from "./lease.js"
import {
  reconciliationRequestFamily,
  reconciliationResponseFamily,
} from "./reconciliation.js"
import { terminalControlFamily, terminalDataFamily } from "./terminal.js"
import type { MeshEnvelope } from "./types.js"

/**
 * The ONLY parse entry point for a mesh wire record.
 *
 * Every other module in this package deliberately exposes no schema a caller
 * could `parse` directly. This one reads `recordType` and dispatches to that
 * family's `VersionedShapes`, which is the whole M4-V mechanism in one place:
 * the version is read BEFORE the shape is chosen, a record whose version is
 * outside `SCHEMA_VERSIONS` is refused with `UnsupportedSchemaVersionError`, a
 * record with no version at all is refused with `UnversionedRecordError`, and a
 * record whose type is not in the table is refused with
 * `protocol.unknown_record_type` — never parsed as a generic object, which is
 * how a record from the future gets partially read by a build that does not
 * understand it.
 */

const FAMILIES: Readonly<Record<MeshRecordType, VersionedShapes>> = Object.freeze({
  "mesh.enrollment.request": enrollmentRequestFamily.shapes,
  "mesh.enrollment.response": enrollmentResponseFamily.shapes,
  "mesh.heartbeat": heartbeatFamily.shapes,
  "mesh.command": commandFamily.shapes,
  "mesh.ack": ackFamily.shapes,
  "mesh.event": eventFamily.shapes,
  "mesh.lease": leaseFamily.shapes,
  "mesh.reconciliation.request": reconciliationRequestFamily.shapes,
  "mesh.reconciliation.response": reconciliationResponseFamily.shapes,
  "mesh.terminal.control": terminalControlFamily.shapes,
  "mesh.terminal.data": terminalDataFamily.shapes,
})

/** The exhaustive `recordType` union. See `./envelope.js` for the 9/11 note. */
export { MESH_RECORD_TYPES }
export type { MeshRecordType }

/** `recordType` -> its version -> its shape. */
export const MESH_RECORD_SHAPES: Readonly<Record<MeshRecordType, VersionedShapes>> = FAMILIES

/**
 * Reads `recordType` without validating anything else.
 *
 * It is a `recordType` reader, not a record reader: a value that is not an
 * object, or whose type is not a known family, yields `null` and the caller
 * refuses. Returning the raw string for an unknown type would push the decision
 * to every call site, and the decision — "is this a family I implement?" — is
 * exactly the one that must not be re-made per gateway.
 */
export function readRecordType(value: unknown): MeshRecordType | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const raw = (value as { recordType?: unknown }).recordType
  return typeof raw === "string" && isMeshRecordType(raw) ? raw : null
}

const RECORD_TYPE_SET: ReadonlySet<string> = new Set<string>(MESH_RECORD_TYPES)

export function isMeshRecordType(value: unknown): value is MeshRecordType {
  return typeof value === "string" && RECORD_TYPE_SET.has(value)
}

function unknownRecordTypeError(value: unknown): ContractError {
  const described =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? JSON.stringify((value as { recordType?: unknown }).recordType ?? null)
      : JSON.stringify(value ?? null)
  return createContractError(
    "validation",
    "protocol.unknown_record_type",
    `Record type ${described} is not a mesh record family. Known families: [${MESH_RECORD_TYPES.join(", ")}]. An unrecognised family is refused rather than parsed as a generic object, because a node must never guess at a shape it does not understand.`,
  )
}

/**
 * Parses a wire record, dispatching on `recordType` and then on `schemaVersion`.
 *
 * THROWS on refusal, by design: every caller is a read path, and there is no
 * correct fallback for a record this build cannot understand. A gateway that must
 * answer a peer rather than crash uses {@link safeParseMeshEnvelope}.
 */
export function parseMeshEnvelope(value: unknown): MeshEnvelope {
  const recordType = readRecordType(value)
  if (recordType === null) throw new UnknownMeshRecordTypeError(value)
  return parseVersioned<MeshEnvelope>(recordType, value, FAMILIES[recordType])
}

export class UnknownMeshRecordTypeError extends Error {
  readonly received: unknown

  constructor(value: unknown) {
    const error = unknownRecordTypeError(value)
    super(error.message)
    this.name = "UnknownMeshRecordTypeError"
    this.received = value
  }

  toContractError(): ContractError {
    return unknownRecordTypeError(this.received)
  }
}

/**
 * The non-throwing flavour, for the SSE and WebSocket gateways.
 *
 * `versionError` is the field that matters operationally: `true` means "upgrade
 * the peer" and the record will never parse on this build no matter how long it
 * is retried, while `false` means "the sender has a bug" and the record is
 * malformed at a version this build does understand. Collapsing them into one
 * answer is how a version-skewed node ends up in a retry loop that can never
 * succeed.
 *
 * The "supported but undeclared" case is decided HERE rather than delegated,
 * because the kernel's `safeParseVersioned` reports that case with an EMPTY
 * supported list, and an operator who reads "Supported: []" reinstalls a node
 * whose problem is that its peer is sending a family at a version that family
 * has never had. The per-family answer is the whole point of the version table,
 * so it is the per-family answer that goes in the message.
 */
export function safeParseMeshEnvelope(value: unknown): VersionedParseResult<MeshEnvelope> {
  const recordType = readRecordType(value)
  if (recordType === null) {
    return { ok: false, error: unknownRecordTypeError(value), versionError: false }
  }
  const shapes = FAMILIES[recordType]
  try {
    const version = readSchemaVersion(recordType, value)
    if (shapes[version] === undefined) {
      const declared = declaredVersionsOf(shapes).filter(isSupportedSchemaVersion)
      return {
        ok: false,
        error: new UnsupportedSchemaVersionError(recordType, version, declared).toContractError(),
        versionError: true,
      }
    }
  } catch (error) {
    if (error instanceof UnsupportedSchemaVersionError || error instanceof UnversionedRecordError) {
      return { ok: false, error: error.toContractError(), versionError: true }
    }
    // A value that is not an object at all reaches `readSchemaVersion` as
    // "unversioned", which is the right answer for a non-record; anything else
    // escaping this function is a bug, not a peer problem, and must not be
    // dressed up as `protocol.record_invalid`.
    throw error
  }
  try {
    return safeParseVersioned<MeshEnvelope>(recordType, value, shapes)
  } catch (error) {
    // `safeParseVersioned` rethrows anything that is not a version problem, and
    // a family schema that throws during refinement is a bug rather than a peer
    // problem, so it must not be dressed up as `protocol.record_invalid`.
    throw error
  }
}

function declaredVersionsOf(shapes: VersionedShapes): readonly SchemaVersion[] {
  return Object.keys(shapes)
    .map(Number)
    .filter(isSupportedSchemaVersion)
    .sort((a, b) => a - b)
}

/**
 * Every version each family declares.
 *
 * Reported by a gateway on startup and by the M4.10 audit, because "which
 * versions does this build actually understand" is a question with a per-family
 * answer and a single global answer is misleading: a build can read a
 * `mesh.heartbeat` at a version where it has never heard of `mesh.terminal`.
 */
export function declaredFamilyVersions(): Readonly<Record<MeshRecordType, readonly number[]>> {
  const out = {} as Record<MeshRecordType, readonly number[]>
  for (const recordType of MESH_RECORD_TYPES) {
    out[recordType] = Object.freeze(declaredVersionsOf(FAMILIES[recordType]))
  }
  return Object.freeze(out)
}

export { UnversionedRecordError, UnsupportedSchemaVersionError }

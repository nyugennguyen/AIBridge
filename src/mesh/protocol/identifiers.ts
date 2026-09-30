import { z } from "zod"

/**
 * Wire-only identifiers and scalar vocabularies.
 *
 * Everything here is scoped to the MESH wire. The kernel's own identifiers live
 * in `src/orchestration/identifiers.ts` and are imported directly by the
 * families rather than re-exported from here, because a re-export would let a
 * reader believe the wire has its own, weaker notion of e.g. `NodeId` — and
 * "there are two `NodeId` types" is precisely the confusion that would let a
 * mesh record bind a run scope to a local projection.
 *
 * The id pattern is duplicated from `identifiers.ts` rather than imported
 * because the constant there is module-private. It is kept byte-identical on
 * purpose: two id grammars on one mesh would mean an id that one side emits is
 * unaddressable by the other, which reads as a transport fault.
 */
const wireIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const messageIdSchema = z.string().regex(wireIdPattern).brand<"MeshMessageId">()
export const enrollmentIdSchema = z.string().regex(wireIdPattern).brand<"EnrollmentId">()
export const nodeKeyIdSchema = z.string().regex(wireIdPattern).brand<"NodeKeyId">()
export const reconcileIdSchema = z.string().regex(wireIdPattern).brand<"ReconcileId">()

/** A single id used before the peer has been enrolled and therefore has no `NodeId` yet. */
export const provisionalNodeIdSchema = z.string().regex(wireIdPattern).brand<"ProvisionalNodeId">()

/**
 * The MESH protocol version, distinct from `schemaVersion`.
 *
 * `schemaVersion` answers "which shape is this record" and is what
 * `parseVersioned` dispatches on. `protocolVersion` answers "which dialect of the
 * mesh is this node speaking" and is what negotiation compares. Collapsing them
 * would mean a record shape change forced a whole-mesh incompatibility, and a
 * mesh incompatibility forced a record shape change — the two axes are separate
 * on purpose, and §3 of the spec calls the database version a third.
 */
export const protocolVersionSchema = z.number().int().positive().safe()

const PROTOCOL_VERSION_LIST_MAX = 16

export const protocolVersionListSchema = z
  .array(protocolVersionSchema)
  .max(PROTOCOL_VERSION_LIST_MAX)
  .min(1)
  .refine((versions) => new Set(versions).size === versions.length, "Protocol versions must be unique")

/**
 * A base64url blob without padding — the ed25519 public key encoding. Padding is
 * excluded so a key has exactly one spelling, which matters because the key is
 * what a pinning record compares by equality.
 */
export const base64UrlSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => decodedBase64Bytes(value) > 0, "Must decode to at least one byte")

/** Standard base64 WITH padding — the terminal data frame's encoding. */
export const base64Schema = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine((value) => value.length % 4 === 0, "Standard base64 must be a multiple of 4 characters")

export const keyFingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)

/** The sha256 of a one-time enrollment code, hex with the digest prefix. */
export const codeHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)

/**
 * Decoded byte length of base64, computed WITHOUT allocating the buffer.
 *
 * Used by the enrollment key bound and the terminal frame bound, both of which
 * must be decided on the STRING as it arrives: decoding a 40 MB chunk in order
 * to discover it is 30 MB is the resource exhaustion the bound exists to
 * prevent. Standard and URL-safe base64 differ only in the alphabet, so one
 * function answers both — two copies would be two numbers to keep in step.
 */
export function decodedBase64Bytes(value: string): number {
  let padding = 0
  if (value.endsWith("==")) padding = 2
  else if (value.endsWith("=")) padding = 1
  return Math.max(0, (value.length / 4) * 3 - padding)
}

/** Every wire id family, so a caller can build one without importing six modules. */
/**
 * The bound on every repeated wire collection that is not in §6 of the spec.
 *
 * One number rather than the five private copies that were in the families: a
 * per-family copy is a bound an author is free to edit, and a bound edited in one
 * family and not the next is a bound that exists on paper in one place only.
 * §6's own bounds stay in `./bounds.js` — they are operational limits with a
 * rationale, this one is just "how long is a list we have to iterate".
 */
export const ARRAY_MAX = 128

export const WIRE_ID_PATTERN = wireIdPattern

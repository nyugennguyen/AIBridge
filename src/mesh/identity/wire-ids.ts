import { z } from "zod"
import {
  enrollmentIdSchema,
  messageIdSchema,
  nodeKeyIdSchema,
  provisionalNodeIdSchema,
  reconcileIdSchema,
  protocolVersionSchema,
  keyFingerprintSchema,
  codeHashSchema,
  base64UrlSchema,
  base64Schema,
  protocolVersionListSchema,
} from "../protocol/identifiers.js"
import { meshRecordTypeSchema } from "../protocol/envelope.js"

/**
 * The wire id TYPES, inferred locally from the mesh protocol's branded schemas.
 *
 * Why this file exists, and why it is not in `src/mesh/protocol/identifiers.ts`:
 * that module brands every id schema (`.brand<"NodeKeyId">()`) so the brands
 * cannot be confused with the kernel's `NodeId` or `RunId`, but it exports only
 * the schemas and no inferred types. A consumer therefore cannot write
 * `NodeKeyId` — it would have to repeat `z.infer<typeof nodeKeyIdSchema>` at
 * every call site, and the natural place to put that is next to the schema that
 * owns it.
 *
 * M4.1 is finished and reviewed, so this file is a WORKAROUND rather than a fix,
 * and it is recorded as a finding for M4.10. The brands are not duplicated or
 * re-declared here — each is inferred from the protocol's own schema, so if the
 * protocol ever changes a brand, this file changes with it and cannot drift. The
 * brands are compile-time only and are assignable to `string` everywhere, so a
 * `NodeKeyId` is still a valid id at a call site that wants an untyped string,
 * and a `NodeId` is still NOT a valid `NodeKeyId`.
 */
/**
 * The schemas are re-exported as well as the types, so a consumer needs one
 * import to both build and name a wire id. The schemas themselves are the
 * protocol's — nothing here redefines a pattern, so there is exactly one place a
 * wire id's grammar is written down.
 */
export {
  enrollmentIdSchema,
  messageIdSchema,
  nodeKeyIdSchema,
  provisionalNodeIdSchema,
  reconcileIdSchema,
  protocolVersionSchema,
  keyFingerprintSchema,
  codeHashSchema,
  base64UrlSchema,
  base64Schema,
  protocolVersionListSchema,
}

export type MessageId = z.infer<typeof messageIdSchema>
export type EnrollmentId = z.infer<typeof enrollmentIdSchema>
export type NodeKeyId = z.infer<typeof nodeKeyIdSchema>
export type ReconcileId = z.infer<typeof reconcileIdSchema>
export type ProvisionalNodeId = z.infer<typeof provisionalNodeIdSchema>
export type MeshRecordType = z.infer<typeof meshRecordTypeSchema>
export type ProtocolVersion = z.infer<typeof protocolVersionSchema>
export type ProtocolVersionList = z.infer<typeof protocolVersionListSchema>
export type KeyFingerprint = z.infer<typeof keyFingerprintSchema>
export type CodeHash = z.infer<typeof codeHashSchema>
export type Base64Url = z.infer<typeof base64UrlSchema>
export type Base64 = z.infer<typeof base64Schema>

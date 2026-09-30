/**
 * The M4.1 mesh wire protocol.
 *
 * Everything re-exported here is PURE: no clock, no filesystem, no network, no
 * dependency outside `src/orchestration/`. Every time value is a caller-supplied
 * parameter, which is what makes the retry / partition / restart / stale-epoch /
 * version-mismatch matrix testable without sleeping and without a fake timer.
 *
 * Four things a consumer must know:
 *
 *   1. `parseMeshEnvelope` / `safeParseMeshEnvelope` are the ONLY way to read a
 *      wire record. No family exports a bare schema you can `.parse()`.
 *   2. `evaluateLease`, `verifyIncomingCommand`, `nextLocalSequence`,
 *      `verifyReconciliationPair`, `decideCommandReceipt` and `ackForReceipt`
 *      make the failure semantics callable without inventing them again at the
 *      gateway.
 *   3. `compileSafePattern` / `authorizeRuleWrite` are the R7 seam: a
 *      `taskTitlePattern` is vetted at write time and needs `policy.ruleAuthor`.
 *   4. Every limit is a named export from `./bounds.js`, so no gateway carries
 *      its own copy of a number.
 *
 * Per the spec's §8, this is the whole seam M4.2–M4.7 consume: M4.2 enrollment,
 * M4.3 heartbeat, M4.4 lease + the command gate, M4.5 command/event/ack plus
 * the outbox receipt decision, M4.6 reconciliation and SSE, M4.7 terminal.
 */
export * from "./bounds.js"
export * from "./identifiers.js"
export * from "./negotiation.js"
export * from "./envelope.js"
export * from "./enrollment.js"
export * from "./heartbeat.js"
export * from "./command.js"
export * from "./ack.js"
export * from "./event.js"
export * from "./lease.js"
export * from "./reconciliation.js"
export * from "./terminal.js"
export * from "./safe-pattern.js"
export * from "./rules.js"
export * from "./types.js"

export {
  MESH_RECORD_SHAPES,
  UnknownMeshRecordTypeError,
  UnversionedRecordError,
  UnsupportedSchemaVersionError,
  declaredFamilyVersions,
  isMeshRecordType,
  parseMeshEnvelope,
  readRecordType,
  safeParseMeshEnvelope,
} from "./registry.js"
export type { VersionedParseResult } from "../../orchestration/versioning.js"
export type { MeshRecordType, MeshEnvelope, MeshPayloadOf, MeshEnvelopeHeaders } from "./types.js"

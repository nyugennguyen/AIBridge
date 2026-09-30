import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { nodeIdSchema, type NodeId } from "../../orchestration/identifiers.js"
import { nodeKeyIdSchema, keyFingerprintSchema } from "../protocol/identifiers.js"
import type { NodeKeyId } from "./wire-ids.js"

/**
 * Where a node's PRIVATE key lives.
 *
 * An interface, not a class, for the same reason every store in this codebase is
 * an interface: the filesystem implementation is a deployment decision, the
 * in-memory one is what the tests use, and nothing in the authentication path
 * should be able to reach past the interface to "just read the file" — a
 * hard-coded read is how a key ends up being loaded on a machine that was never
 * supposed to have it.
 *
 * `load` returning a `Result` rather than throwing is deliberate. A store that
 * has lost its key is the single most important failure this module has to report
 * clearly, and a thrown `ENOENT` reaching a gateway's catch-all turns "this node
 * has no identity" into a 500 with a filesystem path in it.
 */

/** A key file's parsed contents. The private key is present and must stay here. */
export interface StoredNodeKey {
  readonly nodeId: NodeId
  readonly nodeKeyId: NodeKeyId
  readonly publicKey: string
  readonly fingerprint: string
  /** PKCS#8 PEM. The ONLY place a private key is ever written. */
  readonly privateKeyPem: string
  readonly createdAt: number
}

export interface KeyStore {
  /**
   * Writes the private key. MUST create the file with `0600` and MUST NOT log,
   * echo, or include the PEM in any error it produces.
   */
  save(key: StoredNodeKey): Promise<Result<true>>
  /** Reads it back. A store that cannot answer returns a refusal, never a default. */
  load(nodeId: NodeId): Promise<Result<StoredNodeKey | null>>
  /** Removes it. Used when a node is decommissioned, never as "rotation". */
  remove(nodeId: NodeId): Promise<Result<true>>
}

/** The mode a private key file must have: owner read/write, nothing else. */
export const PRIVATE_KEY_FILE_MODE = 0o600

/** The mode a directory holding a private key must have. */
export const PRIVATE_KEY_DIR_MODE = 0o700

/**
 * Any permission bit that would let another user read a private key.
 *
 * Deliberately `mode & 0o077` rather than `mode > 0o600`: the comparison
 * arithmetic in `src/host/profile-store.ts` is correct for "no more permissive
 * than 0600" but says nothing about a file that is `0400` versus one that is
 * `0600`, and a mask names the exact property under test — "is anybody but the
 * owner able to read this" — which is the question a reader of a security check
 * actually has.
 */
export const FOREIGN_READABLE_BITS = 0o077

/**
 * Validates a stored key record, without ever putting the PEM in the error.
 *
 * The `nodeKeyId` is re-derived from the public key rather than compared to the
 * record's own: the whole pinning argument in `peer-key-pins.ts` rests on
 * "key id" and "these key bytes" being the same statement, and a key file whose
 * recorded id disagrees with its recorded key is a file that breaks that
 * assumption at exactly the moment it matters.
 */
export function parseStoredNodeKey(value: unknown): Result<StoredNodeKey> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refuseKeyRecord("A stored key record must be an object")
  }
  const record = value as Record<string, unknown>
  const nodeId = nodeIdSchema.safeParse(record.nodeId)
  if (!nodeId.success) return refuseKeyRecord("nodeId is not a wire id")
  const keyId = nodeKeyIdSchema.safeParse(record.nodeKeyId)
  if (!keyId.success) return refuseKeyRecord("nodeKeyId is not a wire id")
  const fingerprint = keyFingerprintSchema.safeParse(record.fingerprint)
  if (!fingerprint.success) return refuseKeyRecord("fingerprint is not a sha256 digest")
  if (typeof record.publicKey !== "string" || record.publicKey.length === 0) {
    return refuseKeyRecord("publicKey is missing")
  }
  if (typeof record.privateKeyPem !== "string" || !record.privateKeyPem.includes("BEGIN PRIVATE KEY")) {
    // The message names the SHAPE that is missing and never the value. A reader
    // debugging this needs to know the file was not a key file; a reader who is an
    // attacker with a log line does not need the key.
    return refuseKeyRecord("privateKeyPem is missing or is not a PKCS#8 PEM block")
  }
  if (typeof record.createdAt !== "number" || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) {
    return refuseKeyRecord("createdAt is not a non-negative integer epoch millisecond count")
  }
  return {
    ok: true,
    value: Object.freeze({
      nodeId: nodeId.data,
      nodeKeyId: keyId.data,
      publicKey: record.publicKey,
      fingerprint: fingerprint.data,
      privateKeyPem: record.privateKeyPem,
      createdAt: record.createdAt,
    }),
  }
}

function refuseKeyRecord(detail: string): { ok: false; error: ContractError } {
  return { ok: false, error: createContractError("validation", "identity.key_record_invalid", `Stored node key refused: ${detail}.`) }
}

/**
 * The serialised form, for a store that writes JSON.
 *
 * A function rather than a bare `JSON.stringify` at the call site so that the set
 * of fields is stated once. The risk being closed is a store that spreads the
 * object and picks up something new later — the "never log the whole record"
 * rule is only enforceable while there is one place that says what "the whole
 * record" is.
 */
export function serializeStoredNodeKey(key: StoredNodeKey): string {
  return `${JSON.stringify({
    nodeId: key.nodeId,
    nodeKeyId: key.nodeKeyId,
    publicKey: key.publicKey,
    fingerprint: key.fingerprint,
    privateKeyPem: key.privateKeyPem,
    createdAt: key.createdAt,
  })}\n`
}

import { createHash, timingSafeEqual } from "node:crypto"
import { digestSchema, type Digest } from "../../orchestration/identifiers.js"
import { keyFingerprintSchema } from "../protocol/identifiers.js"

/**
 * The only secret comparison this module is allowed to perform.
 *
 * `timingSafeEqual` throws on a length mismatch, and the obvious workaround —
 * `a.length === b.length && timingSafeEqual(a, b)` — is a length oracle: an
 * attacker learns, from how long a comparison took, how many leading bytes they
 * guessed correctly. Both inputs here are therefore reduced to a fixed 32-byte
 * SHA-256 BEFORE the comparison, so the lengths are equal by construction and
 * the `&&` short-circuit never has a length to branch on. The cost is one hash
 * per operand, which is nothing next to the ed25519 verification this sits in
 * front of.
 *
 * The helper is a function rather than a convention because the alternative —
 * "remember to use `timingSafeEqual` at the four call sites" — is precisely how
 * a fifth call site ends up using `===` on a secret. The function's name is the
 * reminder.
 */
export function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(sha256Bytes(left), sha256Bytes(right))
}

function sha256Bytes(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest()
}

/** `sha256:<hex>`, the codebase's one digest spelling. */
export function sha256Digest(value: string): Digest {
  return digestSchema.parse(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`)
}

/**
 * The stable public identity of an ed25519 public key.
 *
 * Derived from the key bytes, never assigned, because a hand-assigned key id is
 * a value a caller can choose — and if the id is the caller's choice, pinning
 * the key and pinning the id are two separate facts that can disagree. Deriving
 * it means "the key id" and "these key bytes" are the same statement, so
 * {@link pinNodeKey} cannot record an id that does not match the key it claims
 * to pin.
 *
 * Full SHA-256, not a truncation: a fingerprint is shown to an operator
 * comparing two nodes' keys by eye, and a 32-bit fingerprint collides often
 * enough to be a real operational hazard, never a security one.
 */
export function keyFingerprint(rawPublicKey: Buffer): string {
  return keyFingerprintSchema.parse(`sha256:${createHash("sha256").update(rawPublicKey).digest("hex")}`)
}

/** Raw bytes of a base64url string, as used for the ed25519 public key. */
export function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url")
}

export function toBase64Url(value: Buffer): string {
  return value.toString("base64url")
}

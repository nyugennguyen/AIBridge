import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { base64UrlSchema, nodeKeyIdSchema } from "../protocol/identifiers.js"
import type { NodeKeyId } from "./wire-ids.js"
import { fromBase64Url, keyFingerprint, toBase64Url } from "./crypto.js"

/**
 * A node's ed25519 identity key.
 *
 * The private key lives in a `#private` ECMAScript field, which means it is not
 * reachable by `JSON.stringify`, not reachable by `console.log`/`util.inspect`,
 * and not reachable by a spread. Every one of those is a path a private key
 * takes into a log line, and the milestone's own rule ("no secret ever reaches
 * a log, an event, or a `ContractError` message") is only meaningful if the
 * default `Object` behaviour is incapable of producing the leak. The explicit
 * `toString`/`toJSON` below are belt-and-braces for a caller that reaches for
 * them on purpose.
 *
 * The public key is exposed freely: it is published on the wire in
 * `mesh.enrollment.request` and in every `peerKeyPins` entry, so treating it as
 * secret would buy nothing and cost a constant stream of bugs.
 */

/** How many hex characters of the fingerprint become the `nodeKeyId`. */
const KEY_ID_FINGERPRINT_CHARS = 16

/** An ed25519 public key is 32 raw bytes. Anything else is not one. */
const ED25519_PUBLIC_KEY_BYTES = 32

export class NodeKeyPair {
  readonly #privateKey: KeyObject
  readonly #publicKey: KeyObject
  readonly #publicKeyBytes: Buffer
  readonly #fingerprint: string
  readonly #keyId: NodeKeyId

  private constructor(privateKey: KeyObject, publicKey: KeyObject) {
    this.#privateKey = privateKey
    this.#publicKey = publicKey
    // `spki` DER for ed25519 is a fixed 12-byte header followed by the raw
    // 32-byte key, so the raw key is the tail. Using the tail rather than a
    // JWK export keeps the wire spelling base64url-of-raw-key, which is what
    // `base64UrlSchema` in the protocol already describes.
    this.#publicKeyBytes = publicKey.export({ type: "spki", format: "der" }).subarray(-ED25519_PUBLIC_KEY_BYTES)
    this.#fingerprint = keyFingerprint(this.#publicKeyBytes)
    this.#keyId = nodeKeyIdSchema.parse(`key-${this.#fingerprint.slice("sha256:".length, "sha256:".length + KEY_ID_FINGERPRINT_CHARS)}`)
  }

  /** Generates a fresh pair. The private key never leaves this process. */
  static generate(): NodeKeyPair {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    return new NodeKeyPair(privateKey, publicKey)
  }

  /**
   * Rebuilds a pair from a stored private key.
   *
   * The public key and fingerprint are RECOMPUTED from the private key rather
   * than read from the record. A stored record that disagrees with its own key
   * is a record that has been tampered with, and reconstructing from the
   * key is what makes that tampering impossible to act on: the node would sign
   * with one key and publish a pin for another, and the pin — not the key — is
   * what a peer would trust.
   */
  static fromPrivateKeyPem(pem: string): NodeKeyPair {
    const privateKey = createPrivateKey(pem)
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new TypeError("A node key must be ed25519; another curve is refused rather than accepted and pinned")
    }
    return new NodeKeyPair(privateKey, createPublicKey(privateKey))
  }

  /** The base64url raw public key, exactly as `mesh.enrollment.request` carries it. */
  get publicKey(): string {
    return toBase64Url(this.#publicKeyBytes)
  }

  get publicKeyBytes(): Buffer {
    return Buffer.from(this.#publicKeyBytes)
  }

  get fingerprint(): string {
    return this.#fingerprint
  }

  /**
   * Derived from the key, so a rotated key necessarily has a new id.
   *
   * That is the whole reason `rotateNodeKey` cannot leave the old key trusted:
   * there is no way to mint a new key that reuses the previous `nodeKeyId`, so
   * a trust store holding the old id is holding an id nothing can sign with.
   */
  get keyId(): NodeKeyId {
    return this.#keyId
  }

  sign(message: Uint8Array): Buffer {
    return edSign(null, Buffer.from(message), this.#privateKey)
  }

  verify(message: Uint8Array, signature: Uint8Array): boolean {
    return edVerify(null, Buffer.from(message), this.#publicKey, Buffer.from(signature))
  }

  /**
   * The PKCS#8 PEM, for a `KeyStore` to persist.
   *
   * Named as an export rather than a field because the only legitimate caller is
   * the store that durably writes it; a field would be available to every
   * reader of the object, including a logging middleware that does not know
   * what it is holding.
   */
  exportPrivateKeyPem(): string {
    return (this.#privateKey.export({ type: "pkcs8", format: "pem" }) as string).trim()
  }

  /** Public material only. There is no `toJSON` path to the private key. */
  toJSON(): { readonly keyId: string; readonly publicKey: string; readonly fingerprint: string } {
    return { keyId: this.#keyId, publicKey: this.publicKey, fingerprint: this.#fingerprint }
  }

  toString(): string {
    return `NodeKeyPair(keyId=${this.#keyId}, fingerprint=${this.#fingerprint})`
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString()
  }
}

/** The half of a key that is safe to persist in a trust store. */
export interface PublicNodeKey {
  readonly nodeKeyId: NodeKeyId
  readonly publicKey: string
  readonly fingerprint: string
}

/**
 * Derives a `PublicNodeKey` from base64url key bytes alone.
 *
 * The derivation, not a comparison: the `nodeKeyId` is a FUNCTION of the key, so
 * the controller naming an id for a key a peer has not met yet is not a value it
 * chose. This is what lets the enrollment response's `nodeKeyId` and the id the
 * joining node computes for itself after storing its key be the same string
 * without either side having been told the other's.
 */
export function publicNodeKeyFromBase64(publicKey: unknown): Result<PublicNodeKey> {
  if (typeof publicKey !== "string") return refusePublicKey("publicKey is not a string")
  const parsed = base64UrlSchema.safeParse(publicKey)
  if (!parsed.success) return refusePublicKey("publicKey is not unpadded base64url")
  const bytes = fromBase64Url(parsed.data)
  if (bytes.length !== ED25519_PUBLIC_KEY_BYTES) {
    return refusePublicKey(
      `publicKey decodes to ${bytes.length} bytes; an ed25519 public key is exactly ${ED25519_PUBLIC_KEY_BYTES}`,
    )
  }
  const fingerprint = keyFingerprint(bytes)
  return {
    ok: true,
    value: {
      nodeKeyId: nodeKeyIdSchema.parse(`key-${fingerprint.slice("sha256:".length, "sha256:".length + KEY_ID_FINGERPRINT_CHARS)}`),
      publicKey: parsed.data,
      fingerprint,
    },
  }
}

/**
 * Validates a `PublicNodeKey` from an untrusted source.
 *
 * A `Result`, not a `T | null`: this is a read path off the wire or off disk, and
 * a null here would have to be translated into a refusal by the caller, which is
 * exactly the place a future caller writes `if (key === null) return trust`
 * because the surrounding code is about something else. The refusal is built
 * here, where the reasons are known.
 *
 * The recorded `nodeKeyId` and `fingerprint` are RE-derived and COMPARED, never
 * read. A caller that supplied a fingerprint which does not match the key is
 * either buggy or hostile, and either way the value an operator reads to compare
 * two nodes by eye would be a value the sender chose. A record that disagrees
 * with itself is refused rather than reconciled.
 */
export function parsePublicNodeKey(value: unknown): Result<PublicNodeKey> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refusePublicKey("A node public key record must be an object")
  }
  const record = value as Record<string, unknown>
  const derived = publicNodeKeyFromBase64(record.publicKey)
  if (!derived.ok) return derived

  const keyId = nodeKeyIdSchema.safeParse(record.nodeKeyId)
  if (!keyId.success) return refusePublicKey("nodeKeyId is not a wire id")
  if (keyId.data !== derived.value.nodeKeyId) {
    return refusePublicKey(
      "the recorded nodeKeyId does not match the recorded public key. A key id is a function of the key, so a record that disagrees with itself is refused rather than reconciled — a caller that supplied a different id is either buggy or hostile.",
    )
  }
  if (record.fingerprint !== undefined && record.fingerprint !== derived.value.fingerprint) {
    return refusePublicKey(
      "the recorded fingerprint does not match the recorded public key; a pin whose fingerprint is chosen by its sender is not a pin",
    )
  }
  return { ok: true, value: derived.value }
}

function refusePublicKey(detail: string): { ok: false; error: ContractError } {
  return {
    ok: false,
    error: createContractError("validation", "identity.public_key_invalid", `Node public key refused: ${detail}.`),
  }
}

/** Builds a `PublicNodeKey` from a local keypair, for a trust store write. */
export function publicNodeKeyOf(keyPair: NodeKeyPair): PublicNodeKey {
  return { nodeKeyId: keyPair.keyId, publicKey: keyPair.publicKey, fingerprint: keyPair.fingerprint }
}

import { createPublicKey, verify as edVerify } from "node:crypto"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { digestSchema, nodeIdSchema, type NodeId } from "../../orchestration/identifiers.js"
import { REPLAY_WINDOW_MS } from "../protocol/bounds.js"
import { nodeKeyIdSchema } from "../protocol/identifiers.js"
import type { NodeKeyId } from "./wire-ids.js"
import { fromBase64Url, toBase64Url } from "./crypto.js"
import type { NodeKeyPair } from "./node-key.js"

/**
 * Per-request node signatures — the "identity middleware".
 *
 * The whole point of a node key is that a request is bound to a KEY rather than
 * to an address, and the binding is only as good as the string that was signed.
 * Concretely, {@link meshSigningString} binds six things and dropping any one of
 * them is a defect that has a name:
 *
 *   - `method`  — without it, a signature captured from a `GET` is replayable
 *                 against a `POST`, which turns a read capability into a write.
 *   - `path`    — without it, a signature from `/v1/mesh/heartbeat` authorises
 *                 `/v1/mesh/command`. The PATH IS THE REQUEST TARGET, query
 *                 string included: a normalising "pathname only" spelling leaves
 *                 `?project=` and `?session=` unbound, and those select what work
 *                 is done.
 *   - `bodyDigest` — without it, a signed envelope can be swapped for a different
 *                   body of the same shape. Binding the digest rather than the body
 *                   is what lets the signature be checked before the body is
 *                   parsed, and therefore before a megabyte of untrusted JSON is
 *                   interpreted.
 *   - `timestamp` — without it, a captured signature is valid forever.
 *   - `nonce`   — without it, a captured signature is valid until its timestamp
 *                 ages out, which for a 300-second window is 300 seconds of
 *                 unlimited replay.
 *   - `nodeId` + `keyId` — without them, the AUTHENTICATED IDENTITY is chosen
 *                 after the signature was made. That is the same "authorise the
 *                 payload" defect the milestone has closed twice inside the
 *                     kernel: a pointer that is not resolved against recorded
 *                     state.
 *
 * NOT bound: `meshId`. A key belongs to exactly one node, a node belongs to
 * exactly one mesh, so the key already determines the mesh. Adding a field that
 * a gateway could forget to supply creates a signature that verifies against
 * `meshId: ""` and a hole nobody notices, which is a worse outcome than the
 * redundancy is worth.
 *
 * Everything here is PURE and clock-injected. There is no `Date.now()`, no
 * filesystem, and no ambient state; the replay guard is passed in.
 */

/**
 * Domain separation, so a signature made here can never be replayed as a
 * signature made for something else that also uses ed25519.
 *
 * A git commit signature, an SSH signature, and a signature over an
 * `authenticatorData` blob are all 64 bytes of ed25519 over some bytes. Without a
 * domain prefix, a key reused across two of those — which is exactly what happens
 * when someone points an ssh-agent at a node key "because it was already there" —
 * produces signatures that are valid in the other protocol too.
 */
export const MESH_REQUEST_SIGNATURE_DOMAIN = "aibridge.mesh.request.v1"

/**
 * How far into the future a request timestamp may be.
 *
 * Thirty seconds, not the five minutes the envelope replay window allows. The two
 * are not the same question: the envelope window bounds the exposure of a
 * RECORD, while a future-dated request timestamp adds to how long a captured
 * signature stays usable, because `now - timestamp` is negative and the age check
 * passes trivially until the clock catches up. A node whose clock is five minutes
 * fast would therefore have ten-minute-old requests still authenticating. Thirty
 * seconds is far more than NTP needs and keeps that doubling to ten percent.
 */
export const MAX_FUTURE_SKEW_MS = 30_000

/**
 * How old a request may be.
 *
 * The protocol's own `REPLAY_WINDOW_MS`, reused rather than restated. Two numbers
 * that mean "how stale a signed thing may be" will drift, and the one that drifts
 * is the one nobody re-reads.
 */
export const MAX_REQUEST_AGE_MS = REPLAY_WINDOW_MS

/** The nonce grammar. Base64url, so 32 random bytes is 43 characters. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

/** A signed request target cannot be arbitrarily long; a bound is a bound. */
export const MAX_SIGNED_PATH_LENGTH = 2_048

/** An ed25519 signature is exactly 64 bytes. */
const SIGNATURE_BYTES = 64

/** The fields a node signs, and the fields a node's verifier reads. */
export interface MeshRequestSignature {
  readonly method: string
  /** The request target as it appeared on the wire, query string included. */
  readonly path: string
  /** `sha256:<hex>` over the canonical body. See the module comment. */
  readonly bodyDigest: string
  /** Epoch milliseconds. */
  readonly timestamp: number
  readonly nonce: string
  readonly signature: string
  readonly nodeId: NodeId
  readonly keyId: NodeKeyId
}

/** The subset a node needs to produce a signature. */
export type MeshSignatureInput = Omit<MeshRequestSignature, "signature">

/**
 * The exact bytes a node signs.
 *
 * Canonical JSON for the body of it, and not a hand-rolled concatenation of
 * `:` and `\n`. A delimiter-based string is ambiguous the moment a path contains
 * the delimiter — and a path is attacker-supplied. `canonicalJson` is already the
 * serializer the payload digests are computed over, so using it here means the
 * signed string and the digested string are produced by the same encoder, and
 * there is no second spelling of "the same request" to disagree with.
 *
 * The domain prefix is outside the JSON, on its own line, so it cannot be
 * confused with a field and cannot be moved.
 */
export function meshSigningString(input: MeshSignatureInput): Buffer {
  return Buffer.from(
    `${MESH_REQUEST_SIGNATURE_DOMAIN}\n${canonicalSigningJson({
      bodyDigest: input.bodyDigest,
      keyId: input.keyId,
      method: input.method,
      nonce: input.nonce,
      nodeId: input.nodeId,
      path: input.path,
      timestamp: input.timestamp,
    })}`,
    "utf8",
  )
}

/**
 * `canonicalJson` without the exception-heavy general machinery.
 *
 * Seven known strings, one number, and the risk of a different encoder is a
 * signature that verifies on one node and not another — the exact "works on my
 * machine" failure that would be read as a key problem. The keys are emitted in a
 * fixed order and every value is JSON-encoded, so there is no ambiguity for an
 * attacker-supplied path to exploit, and the domain prefix in
 * {@link meshSigningString} keeps the whole thing from being a valid object.
 */
function canonicalSigningJson(fields: Readonly<Record<string, string | number>>): string {
  return `{${Object.keys(fields)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(fields[key])}`)
    .join(",")}}`
}

/** Signs a request with a node key. The signing side of the same string. */
export function signMeshRequest(keyPair: NodeKeyPair, input: MeshSignatureInput): MeshRequestSignature {
  return { ...input, signature: toBase64Url(keyPair.sign(meshSigningString(input))) }
}

export type MeshRequestRefusal =
  | "signature_malformed"
  | "signature_unauthenticated"
  | "signature_expired"
  | "signature_not_yet_valid"
  | "signature_invalid"
  | "replay_detected"
  | "replay_guard_unavailable"
  | "node_mismatch"
  | "request_malformed"

export type VerifyMeshRequestResult =
  | { readonly ok: true; readonly value: VerifiedMeshRequest }
  | { readonly ok: false; readonly reason: MeshRequestRefusal; readonly error: ContractError }

export interface VerifiedMeshRequest {
  readonly nodeId: NodeId
  readonly keyId: NodeKeyId
  /** The signed fields, so a handler never re-derives them from the request object. */
  readonly signed: MeshSignatureInput
}

export interface ReplayGuard {
  /**
   * Atomically records `key`. `true` if it is new, `false` if it is a replay, and
   * a refusal if the guard cannot answer — which is a refusal of the REQUEST, not
   * an admission. A replay guard that fails open is a replay guard that has been
   * turned off by a disk-full.
   */
  consume(key: string, now: number): Result<"recorded" | "replay">
}

export interface VerifyMeshRequestOptions {
  /**
   * The pinned public key, resolved by the caller from the pin store.
   *
   * Passed in rather than looked up so that the PIN decision and the CRYPTO
   * decision are separable, and so that this function stays pure. The caller is
   * responsible for having consulted {@link verifyPinnedKey} and the revocation
   * check first; a caller that has not will have authenticated a key nobody
   * trusts, which is why {@link IdentityProvider} is the thing later tasks should
   * use.
   */
  readonly storedKey: Uint8Array
  /** The node this request is for. A mismatch is a refusal, never a re-binding. */
  readonly expectedNodeId: NodeId
  readonly now: number
  readonly replayGuard: ReplayGuard
  /** Overrides {@link MAX_REQUEST_AGE_MS} / {@link MAX_FUTURE_SKEW_MS}. Tests only. */
  readonly maxAgeMs?: number
  readonly maxFutureSkewMs?: number
}

/**
 * Verifies an inbound mesh request.
 *
 * The order of the checks is the security argument, so it is worth stating rather
 * than leaving to the code:
 *
 *   1. **Shape.** A request whose `path` is a megabyte, whose nonce is not a
 *      nonce, or whose body digest is not a `sha256:` digest is refused before any
 *      crypto. Cheap refusals first, because this is the first thing every inbound
 *      packet meets.
 *   2. **Identity binding.** `request.nodeId` must equal `expectedNodeId`. A
 *      mismatch is refused rather than used to look up a different key: the
 *      identity a request is evaluated as is decided by the SEAM (which socket, which
 *      route, which mesh), never by a header.
 *   3. **Clock window.** Future-beyond-skew and aged-out are SEPARATE refusals
 *      because they have different operator meanings: one is a node whose clock
 *      disagrees, the other is a capture.
 *   4. **Signature.** ed25519 over the bound string.
 *   5. **Replay.** The nonce is consumed LAST, and only after the signature has
 *      verified.
 *
 * That last ordering is the non-obvious one. Consuming first would let anyone
 * send garbage with a victim's node id and a victim's next nonce and burn it,
 * denying the victim a window of legitimate nonces. Verifying first costs one
 * ed25519 verification per replayed request and makes that denial impossible; the
 * residual cost is bounded by the rate limit the gateway applies, which is not
 * this function's job.
 */
export function verifyMeshRequest(
  request: MeshRequestSignature,
  options: VerifyMeshRequestOptions,
): VerifyMeshRequestResult {
  const shape = validateRequestShape(request)
  if (!shape.ok) return shape

  if (request.nodeId !== options.expectedNodeId) {
    return refuseRequest(
      "node_mismatch",
      createContractError(
        "policy_denied",
        "identity.node_mismatch",
        "The request names a different node than the one it was received for. The node a request is evaluated as is decided by the seam that received it, not by a header: letting the header choose is how a signature for node A becomes a request as node B.",
      ),
    )
  }

  const now = options.now
  if (!Number.isSafeInteger(now) || now < 0) {
    return refuseRequest(
      "request_malformed",
      createContractError("internal_failure", "identity.invalid_time", "The verifier was given a clock value that is not a non-negative integer epoch millisecond count."),
    )
  }
  const maxAge = options.maxAgeMs ?? MAX_REQUEST_AGE_MS
  const maxSkew = options.maxFutureSkewMs ?? MAX_FUTURE_SKEW_MS
  if (request.timestamp > now + maxSkew) {
    return refuseRequest(
      "signature_not_yet_valid",
      createContractError(
        "validation",
        "identity.request_not_yet_valid",
        `The request claims a timestamp ${request.timestamp - now}ms ahead of this node's clock; the allowance is ${maxSkew}ms. Either the sender's clock disagrees or the request was captured and re-dated.`,
      ),
    )
  }
  if (now - request.timestamp > maxAge) {
    return refuseRequest(
      "signature_expired",
      createContractError(
        "validation",
        "identity.request_expired",
        `The request is ${now - request.timestamp}ms old, over the ${maxAge}ms bound. An unbound signature is valid forever, and an old one is a capture rather than a live request.`,
      ),
    )
  }

  const signature = fromBase64Url(request.signature)
  if (signature.length !== SIGNATURE_BYTES) {
    return refuseRequest(
      "signature_malformed",
      createContractError(
        "validation",
        "identity.signature_malformed",
        `The signature decodes to ${signature.length} bytes; an ed25519 signature is exactly ${SIGNATURE_BYTES}.`,
      ),
    )
  }

  const signed = signedFieldsOf(request)
  if (!keyPairlessVerify(signed, signature, options.storedKey)) {
    return refuseRequest(
      "signature_invalid",
      createContractError(
        "policy_denied",
        "identity.signature_invalid",
        "The request signature does not verify against the node's pinned key. The signature covers the method, the request target, the body digest, the timestamp, the nonce, and the node and key ids, so a signature lifted from another request verifies against none of them.",
      ),
    )
  }

  const consumed = options.replayGuard.consume(replayKeyOf(request), now)
  if (!consumed.ok) {
    return refuseRequest("replay_guard_unavailable", consumed.error)
  }
  if (consumed.value === "replay") {
    return refuseRequest(
      "replay_detected",
      createContractError(
        "policy_denied",
        "identity.replay_detected",
        `Nonce ${request.nonce} from node ${request.nodeId} has already been used. A one-time nonce is what stops a captured request from being replayed inside the freshness window; without it, the window is the whole of the defence.`,
      ),
    )
  }

  return { ok: true, value: { nodeId: request.nodeId, keyId: request.keyId, signed } }
}

function validateRequestShape(request: MeshRequestSignature): VerifyMeshRequestResult {
  if (typeof request.method !== "string" || request.method.length === 0 || request.method.length > 16) {
    return refuseRequest("request_malformed", createContractError("validation", "identity.request_malformed", "The request method is missing or over-long."))
  }
  if (typeof request.path !== "string" || request.path.length === 0 || request.path.length > MAX_SIGNED_PATH_LENGTH) {
    return refuseRequest(
      "request_malformed",
      createContractError("validation", "identity.request_malformed", `The request target is missing or over ${MAX_SIGNED_PATH_LENGTH} characters.`),
    )
  }
  if (!NONCE_PATTERN.test(request.nonce)) {
    return refuseRequest(
      "request_malformed",
      createContractError(
        "validation",
        "identity.request_malformed",
        "The request nonce is not 16-128 characters of unpadded base64url. A short or absent nonce is refused rather than defaulted: the alternative is that a client which omits it reuses one, and the replay guard then refuses every subsequent request from a correct client instead.",
      ),
    )
  }
  if (!digestSchema.safeParse(request.bodyDigest).success) {
    return refuseRequest(
      "request_malformed",
      createContractError(
        "validation",
        "identity.request_malformed",
        "The body digest is not a sha256:<hex> digest. Refusing a differently spelled digest is what stops the two sides from signing different strings while each believes the signature is over the other's message.",
      ),
    )
  }
  if (!Number.isSafeInteger(request.timestamp) || request.timestamp < 0) {
    return refuseRequest("request_malformed", createContractError("validation", "identity.request_malformed", "The request timestamp is not a non-negative integer epoch millisecond count."))
  }
  if (!nodeIdSchema.safeParse(request.nodeId).success) {
    return refuseRequest("request_malformed", createContractError("validation", "identity.request_malformed", "The request node id is not a wire id."))
  }
  if (!nodeKeyIdSchema.safeParse(request.keyId).success) {
    return refuseRequest("request_malformed", createContractError("validation", "identity.request_malformed", "The request key id is not a wire id."))
  }
  return { ok: true, value: { nodeId: request.nodeId, keyId: request.keyId, signed: signedFieldsOf(request) } }
}

function signedFieldsOf(request: MeshRequestSignature): MeshSignatureInput {
  return {
    method: request.method,
    path: request.path,
    bodyDigest: request.bodyDigest,
    timestamp: request.timestamp,
    nonce: request.nonce,
    nodeId: request.nodeId,
    keyId: request.keyId,
  }
}

/**
 * ed25519 verification against a raw public key, without a `NodeKeyPair`.
 *
 * A `NodeKeyPair` is a PRIVATE-key holder, and the verifying side has no private
 * key. Building one from a peer's public key would make one type mean two
 * different things depending on which half is held, so the raw-key path is
 * separate and the two never share a signature method.
 *
 * The 12-byte prefix is the fixed `SubjectPublicKeyInfo` header for ed25519, so a
 * raw 32-byte key — which is exactly what the wire carries — can be framed without
 * asking the caller for a DER blob whose length it would have had to be told.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

function keyPairlessVerify(signed: MeshSignatureInput, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)])
    const key = createPublicKey({ key: spki, format: "der", type: "spki" })
    return edVerify(null, Buffer.from(meshSigningString(signed)), key, Buffer.from(signature))
  } catch {
    // A malformed key THROWS rather than returning false, and a throw here would
    // escape a function whose contract is a `Result`. A key that cannot be loaded
    // is a key that does not verify.
    return false
  }
}

function refuseRequest(reason: MeshRequestRefusal, error: ContractError): VerifyMeshRequestResult {
  return { ok: false, reason, error }
}

/** Nonces are scoped per node: one node's nonce space is not another's. */
function replayKeyOf(request: MeshRequestSignature): string {
  return `${request.nodeId}.${request.nonce}`
}

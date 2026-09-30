import { createContractError, type ContractError } from "../../orchestration/errors.js"
import { meshIdSchema, nodeIdSchema, type MeshId, type NodeId } from "../../orchestration/identifiers.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../protocol/negotiation.js"
import { parseMeshEnvelope } from "../protocol/registry.js"
import { type EnrollmentRejectionReason, type MeshEnrollmentRequest } from "../protocol/enrollment.js"
import { CURRENT_SCHEMA_VERSION } from "../../orchestration/versioning.js"
import {
  type EnrollmentCodeStore,
  type EnrollmentCodeRejection,
  nodeIdForCodeHash,
  verifyEnrollmentCode,
} from "./enrollment-code.js"
import { type PeerKeyPinStore, type PinViolation, type VerifyPinResult, verifyPinnedKey } from "./peer-key-pins.js"
import { type NodeKeyPair, publicNodeKeyFromBase64, publicNodeKeyOf, type PublicNodeKey } from "./node-key.js"
import { type NodeTrustStore, verifyKeyNotRevoked } from "./node-trust.js"

/**
 * The controller's side of enrollment: verify the code, then pin the key.
 *
 * This is where §4.1's invariant lives. Read the two halves together, because
 * either alone is a weaker thing:
 *
 *   - `verifyEnrollmentCode` answers "is this a live one-time code for this
 *     mesh". It is about the CREDENTIAL.
 *   - `pinNodeKey` answers "does this key become trusted". It is about the
 *     AUTHORITY.
 *
 * A module that conflated them would have two failure modes it could not tell
 * apart. A code that is live but whose key is already pinned for a different node
 * looks exactly like a valid code if the pin check is skipped. A code that has
 * been spent by the SAME node with the SAME key looks exactly like an attack if
 * the convergence check is skipped — and the response to that mistake is a node
 * that enrolls, loses its response, retries, and is refused forever.
 *
 * The order is verify-then-pin, and a converged retry MUST NOT re-pin. The pin
 * store refuses a second pin for a live node precisely so that a retry storm
 * cannot rewrite a pin, and this function is the only caller that has to know.
 */

export interface EnrollmentDecision {
  readonly outcome: "accepted" | "rejected"
  readonly nodeId: NodeId
  readonly meshId: MeshId
  readonly enrollmentId: string
  /**
   * The `nodeKeyId` the node must sign with from now on.
   *
   * Present on BOTH outcomes, for the reason the wire schema requires it: a node
   * that cannot learn the id it is expected to use cannot correct itself, and a
   * rejection that withholds it leaves the node guessing. It is DERIVED from the
   * submitted key, so on a rejection it is a fact about the bytes the peer sent
   * rather than a fact about anything trusted.
   */
  readonly nodeKeyId: string
  readonly rejectionReason?: EnrollmentRejectionReason
  /** True when this was a retry of an enrollment that already completed. */
  readonly converged?: boolean
}

export interface DecideEnrollmentInput {
  readonly request: MeshEnrollmentRequest
  readonly now: number
}

export interface EnrollmentServiceDependencies {
  readonly codes: EnrollmentCodeStore
  readonly pins: PeerKeyPinStore
  readonly trust: NodeTrustStore
}

/**
 * Decides one `mesh.enrollment.request`.
 *
 * The caller supplies an already-parsed request, and it MUST come from
 * `parseMeshEnvelope`. The code hash and the mesh id are the two fields the whole
 * decision turns on, and reading them off an unparsed body is how a future
 * gateway ends up deciding on a `meshId` from a different field than the one the
 * envelope was bound to — the "authorise the payload, not the record" defect,
 * one layer down from where it has been caught twice already.
 *
 * Every refusal returns a `ContractError` whose message is safe to send, and the
 * internal reason is available to the caller through `reasonFor`. The wire's
 * `rejectionReason` is applied by {@link wireRejectionReasonFor}, which collapses
 * everything an attacker could enumerate into one value.
 */
export async function decideEnrollment(
  input: DecideEnrollmentInput,
  deps: EnrollmentServiceDependencies,
): Promise<EnrollmentDecision> {
  const derived = publicNodeKeyFromBase64(input.request.nodePublicKey)
  if (!derived.ok) {
    return rejected(input, derived.error, "code_unknown")
  }

  // BEFORE the code is redeemed, and this ordering is the whole point. A revocation
  // is a statement about a KEY as much as about a node, and the node id derived from
  // a code is not stable across re-enrollment: a machine that was revoked for being
  // compromised can come back with a fresh code, be given a new id, and be re-pinned
  // while presenting the very key the operator revoked in order to remove it. Refusing
  // before `verifyEnrollmentCode` also means the code is NOT SPENT — the code belongs
  // to the operator, who can re-issue it for a node that brings a fresh key, rather
  // than having it burned by a submission that was always going to be refused.
  const revoked = await verifyKeyNotRevoked(deps.trust, derived.value.nodeKeyId)
  if (!revoked.ok) return rejected(input, revoked.error, "key_mismatch")

  const verified = await verifyEnrollmentCode(
    {
      meshId: input.request.meshId,
      codeHash: input.request.enrollmentCodeHash,
      nodePublicKey: input.request.nodePublicKey,
      provisionalNodeId: input.request.provisionalNodeId,
      now: input.now,
    },
    deps.codes,
  )
  if (!verified.ok) {
    return rejected(input, verified.error, wireRejectionReasonFor(verified.reason))
  }

  if (verified.value.converged) {
    // A retry of an enrollment that already completed. The pin is re-READ rather
    // than re-written: a second `pin` would be refused by the store, and a retry
    // that made the node's identity depend on a write it did not need is a retry
    // that can fail.
    const pinned = await verifyPinnedKey(deps.pins, {
      nodeId: verified.value.nodeId,
      meshId: verified.value.meshId,
      key: derived.value,
    })
    if (!pinned.ok) return rejected(input, pinned.error, "key_mismatch")
    return {
      outcome: "accepted",
      nodeId: verified.value.nodeId,
      meshId: verified.value.meshId,
      enrollmentId: verified.value.enrollmentId,
      nodeKeyId: pinned.value.nodeKeyId,
      converged: true,
    }
  }

  const pinned = await pinNodeKey(
    {
      nodeId: verified.value.nodeId,
      meshId: verified.value.meshId,
      key: derived.value,
      enrollmentId: verified.value.enrollmentId,
      // The display name comes from the REQUEST rather than from a caller-supplied
      // argument, so there is no second spelling of "what this node is called" for
      // the two to disagree about. It is already bounded to 256 characters by the
      // wire record, which is the bound that applies to it.
      displayName: input.request.nodeDisplayName,
      now: input.now,
    },
    deps,
  )
  if (!pinned.ok) return rejected(input, pinned.error, "key_mismatch")

  return {
    outcome: "accepted",
    nodeId: verified.value.nodeId,
    meshId: verified.value.meshId,
    enrollmentId: verified.value.enrollmentId,
    nodeKeyId: pinned.value.nodeKeyId,
    converged: false,
  }
}

/**
 * Pins the exact key a joining node submitted, and records its trust.
 *
 * §4.1: "the controller's response pins the exact key submitted; a later request
 * presenting the same code with a different key is refused."
 *
 * Two refusals live here, and they are the two ways a pin becomes a suggestion:
 *
 *   - `already pinned`. The store refuses a second `pin` for a live node. That IS
 *     the pinning violation, and it is a refusal rather than a replace so that a
 *     code intercepted in transit cannot re-point an enrolled node's pin at the
 *     attacker's key. A re-issued code for an enrolled node goes through
 *     `PeerKeyPinStore.rotate`, which requires a fresh code AND a named operator.
 *   - `enrollment incomplete`. The trust record is written SECOND. If the pin
 *     landed and the trust write did not, the node is pinned and not trusted, which
 *     fails closed (the trust check runs first at authentication) but is a
 *     half-finished enrollment an operator has to see, so it is reported rather
 *     than swallowed.
 */
async function pinNodeKey(
  input: {
    readonly nodeId: NodeId
    readonly meshId: MeshId
    readonly key: PublicNodeKey
    readonly enrollmentId: string
    readonly displayName: string
    readonly now: number
  },
  deps: EnrollmentServiceDependencies,
): Promise<VerifyPinResult> {
  const pinned = await deps.pins.pin({
    nodeId: input.nodeId,
    meshId: input.meshId,
    key: input.key,
    enrollmentId: input.enrollmentId,
    now: input.now,
  })
  if (!pinned.ok) {
    // The store's own `ContractError` is carried through unchanged — its code and
    // message are what an operator needs ("already pinned" versus "store
    // unavailable" is the whole diagnosis) and re-wrapping them would flatten it.
    // The `reason` is `pin_missing` because on this path the pin is absent,
    // whatever the store called the failure; the caller maps `reason` to a wire
    // rejection, and the LESS specific value is the one that reaches a peer.
    return { ok: false, reason: "pin_missing", error: pinned.error }
  }

  const enrolled = await deps.trust.enroll({
    nodeId: input.nodeId,
    meshId: input.meshId,
    nodeKeyId: input.key.nodeKeyId,
    enrolledAt: input.now,
    displayName: input.displayName,
  })
  if (!enrolled.ok) {
    // The pin landed and the trust record did not, so the node is PINNED and NOT
    // TRUSTED. That state fails closed — `verifyNodeTrust` runs before the pin
    // lookup — but it is a half-finished enrollment, and leaving it there would
    // brick the node id permanently: every future enrollment for it collides with
    // the orphan pin as `already_pinned`, and `rotate` refuses a node that was
    // never trusted. So the pin is rolled back and the code is retryable.
    await deps.pins.revoke(input.nodeId)
    return {
      ok: false,
      reason: "pin_missing",
      error: createContractError(
        "internal_failure",
        "identity.enrollment_incomplete",
        `Node ${input.nodeId} could not be enrolled and its partial pin was rolled back, so the enrollment code may be retried. Authentication checks trust before the pin, so the node was never half-trusted.`,
      ),
    }
  }
  return pinned
}

/**
 * The internal reason -> the wire's `rejectionReason`.
 *
 * The protocol's `ENROLLMENT_REJECTION_REASONS` distinguishes
 * `code_unknown`/`code_expired`/`code_already_used`, which is a finer vocabulary
 * than this function will emit, and the narrowing is deliberate. A peer that can
 * tell "expired" from "unknown" can enumerate which codes an operator has issued
 * and already spent — and code issuance is the operator's own bookkeeping, so
 * that is a record of the operator's security posture handed to a prober.
 *
 * `key_mismatch` IS emitted, and it is the one that is safe to disclose: the peer
 * has just demonstrated knowledge of a key already pinned for a node, so telling
 * it the key is not the one adds nothing it did not supply.
 *
 * The `default` narrows to the LEAST informative reason rather than passing an
 * internal string through. A new internal reason that a future author forgets to
 * map therefore leaks nothing — it under-reports, which is the direction that
 * costs a debugging session rather than a secret.
 */
export function wireRejectionReasonFor(reason: EnrollmentCodeRejection | PinViolation | string): EnrollmentRejectionReason {
  switch (reason) {
    case "code_expired":
    case "code_already_used":
    case "code_unknown":
    case "code_bound_to_another_mesh":
    case "code_provisional_mismatch":
      return "code_unknown"
    case "pin_missing":
    case "pin_key_id_unknown":
    case "pin_key_mismatch":
    case "pin_node_mismatch":
    case "pin_mesh_mismatch":
    case "pin_store_failure":
      return "key_mismatch"
    default:
      return "code_unknown"
  }
}

function rejected(
  input: DecideEnrollmentInput,
  error: ContractError,
  reason: EnrollmentRejectionReason,
): EnrollmentDecision {
  void error
  return {
    outcome: "rejected",
    // The id this request WOULD have had, derived from the code hash the same way
    // a redemption derives it, so a retrying peer correlates its own attempts and
    // a rejected id is never one that belongs to somebody else.
    nodeId: rejectedNodeIdFor(input),
    meshId: input.request.meshId,
    enrollmentId: input.request.enrollmentId,
    nodeKeyId: safeKeyIdFor(input.request.nodePublicKey),
    rejectionReason: reason,
  }
}

/**
 * The `nodeId` a rejection is answered under when the code hash is not a digest.
 *
 * Distinct from every id a real code derives, and constant, so a peer correlating its
 * own attempts can tell "this submission was malformed" from "this submission was
 * refused" without either of them being a guess.
 */
const UNPARSEABLE_CODE_HASH_NODE_ID = "node-enr-unenrollable"

/**
 * The `nodeId` a rejection is answered under.
 *
 * Derived from the code hash the request presented, which is the same derivation
 * {@link nodeIdForCodeHash} performs on redemption. The wire schema requires a
 * `nodeId` on both outcomes precisely so that "why did my second attempt behave
 * differently" is answerable from the wire; inventing a fresh random id for a
 * rejection would satisfy the schema and defeat the reason it is there.
 */
function rejectedNodeIdFor(input: DecideEnrollmentInput): NodeId {
  const derived = nodeIdForCodeHash(input.request.enrollmentCodeHash)
  if (derived !== null) return derived
  // The code hash was not a digest at all. There is no honest derivation to report, and
  // a rejection still owes the peer a `nodeId` it satisfies the wire grammar — so it
  // gets a fixed, obviously-synthetic one. Parsed through the schema rather than cast:
  // a cast would make this the one place in the module that produces an id no peer could
  // address without the compiler objecting.
  return nodeIdSchema.parse(UNPARSEABLE_CODE_HASH_NODE_ID)
}

/** A key id derived from submitted bytes, or a stable placeholder for garbage. */
function safeKeyIdFor(publicKeyBase64Url: string): string {
  const derived = publicNodeKeyFromBase64(publicKeyBase64Url)
  return derived.ok ? derived.value.nodeKeyId : "key-unparseable"
}

/**
 * Builds the `mesh.enrollment.request` a node sends, from its own key and a code
 * HASH.
 *
 * Takes the hash, never the raw code, so there is no path by which a caller of
 * this helper can put a redeemable credential into an envelope. The record is
 * built as a full envelope and read back through `parseMeshEnvelope` — the one
 * read path — rather than by reaching into the family's shape, so the version is
 * chosen by the registry and not by whoever called this.
 */
export function buildEnrollmentRequest(input: {
  readonly meshId: MeshId
  readonly enrollmentId: string
  readonly codeHash: string
  readonly keyPair: NodeKeyPair
  readonly nodeDisplayName: string
  readonly provisionalNodeId: string
  readonly requestedAt: string
  readonly codeExpiresAt: string
  readonly senderNodeId: NodeId
  readonly correlationId?: string
}): MeshEnrollmentRequest {
  const parsed = parseMeshEnvelope({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.enrollment.request",
    messageId: input.enrollmentId,
    correlationId: input.correlationId ?? input.enrollmentId,
    causation: null,
    senderNodeId: input.senderNodeId,
    // A joining node has no address on the mesh yet, which is what the `null`
    // recipient means for this one family.
    recipientNodeId: null,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: input.requestedAt,
    expiresAt: input.codeExpiresAt,
    payload: {
      meshId: input.meshId,
      enrollmentId: input.enrollmentId,
      enrollmentCodeHash: input.codeHash,
      nodePublicKey: publicNodeKeyOf(input.keyPair).publicKey,
      nodeDisplayName: input.nodeDisplayName,
      provisionalNodeId: input.provisionalNodeId,
      requestedAt: input.requestedAt,
      codeExpiresAt: input.codeExpiresAt,
    },
  })
  if (parsed.recordType !== "mesh.enrollment.request") {
    throw new Error("parseMeshEnvelope returned a different family than the one it was given")
  }
  return parsed.payload
}

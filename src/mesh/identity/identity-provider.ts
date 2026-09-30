import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { meshIdSchema, nodeIdSchema, type MeshId, type NodeId } from "../../orchestration/identifiers.js"
import type { NodeKeyId } from "./wire-ids.js"
import { fromBase64Url } from "./crypto.js"
import { verifyNodeTrust, type NodeTrustStore, type TrustRefusal } from "./node-trust.js"
import { resolvePinnedKey, type PeerKeyPinStore, type PinViolation } from "./peer-key-pins.js"
import { verifyMeshRequest, type MeshRequestRefusal, type MeshRequestSignature, type ReplayGuard } from "./request-signature.js"

/**
 * The seam M4.3, M4.4, M4.6 and M4.7 authenticate against.
 *
 * Those tasks need one thing — "is this request from a node this mesh trusts, and
 * which one" — and they must not each reach into a trust store, a pin store, a
 * revocation set, a clock and a replay guard to work it out. Each of those five
 * steps done slightly differently in four places is four chances for one of them
 * to skip the revocation check, and the skipped one is the one that lets a revoked
 * node keep working.
 *
 * So the whole identity decision is ONE interface with ONE method, and its
 * refusal carries the reason an operator needs (`node_revoked`, `node_not_
 * enrolled`, `signature_invalid`, `replay_detected`, …) alongside a
 * `ContractError` whose MESSAGE is safe to send to a peer.
 */

export interface AuthenticatedNode {
  readonly nodeId: NodeId
  readonly meshId: MeshId
  readonly nodeKeyId: NodeKeyId
  readonly fingerprint: string
  /**
   * When the node was enrolled, from the trust store.
   *
   * Carried because "how long has this node been on the mesh" is a question M4.4's
   * lease and M4.7's terminal both end up asking, and answering it from a field
   * the AUTHENTICATING node supplied would be answering it with the peer's claim.
   */
  readonly enrolledAt: number
}

export type AuthenticateRefusal =
  | MeshRequestRefusal
  | TrustRefusal
  | PinViolation
  | "identity_provider_unavailable"

export type AuthenticateResult =
  | { readonly ok: true; readonly value: AuthenticatedNode }
  | { readonly ok: false; readonly reason: AuthenticateRefusal; readonly error: ContractError }

export interface AuthenticateRequest {
  /** The node this seam is deciding FOR. Decided by the seam, never by a header. */
  readonly expectedNodeId: NodeId
  readonly expectedMeshId: MeshId
  readonly signature: MeshRequestSignature
}

export interface IdentityProvider {
  authenticate(request: AuthenticateRequest): Promise<AuthenticateResult>
}

export interface MeshIdentityDependencies {
  readonly trust: NodeTrustStore
  readonly pins: PeerKeyPinStore
  readonly replayGuard: ReplayGuard
  /**
   * The clock, injected.
   *
   * A function rather than a value so a test can advance time between two calls
   * without rebuilding the provider, and so nothing in this module can hold a
   * timestamp that quietly becomes stale while a request is in flight.
   */
  readonly now: () => number
}

/**
 * The reference `IdentityProvider`.
 *
 * Order is: trust (which includes revocation) -> pin -> signature. All three must
 * pass. The reasoning for that order is three separate fail-closed arguments:
 *
 *   1. **Trust first, so revocation is on the path in.** A revoked node is
 *      refused before its signature is verified, which means a revoked node
 *      cannot spend a verification, cannot burn a nonce, and cannot learn whether
 *      its key is still pinned. The information it gets back is "you are
 *      revoked", which it would learn anyway, and NOT the revocation's reason.
 *   2. **Pin second, so a rotated key is dead immediately.** A node whose key was
 *      rotated presents the old key; the pin no longer names it, so it is refused
 *      with `pin_key_id_unknown` rather than reaching a verification that would
 *      cost the same and answer less precisely.
 *   3. **Signature last, because it is the only expensive step and the only one
 *      that can fail for a well-formed, enrolled, pinned node.**
 *
 * The failure of any store is a refusal. There is no path through this class that
 * treats an unreadable store as an empty one, because the empty reading is the
 * permissive one and permissive defaults are what this milestone is about.
 */
export class MeshIdentityProvider implements IdentityProvider {
  readonly #deps: MeshIdentityDependencies

  constructor(dependencies: MeshIdentityDependencies) {
    this.#deps = dependencies
  }

  async authenticate(request: AuthenticateRequest): Promise<AuthenticateResult> {
    const meshId = meshIdSchema.safeParse(request.expectedMeshId)
    const nodeId = nodeIdSchema.safeParse(request.expectedNodeId)
    if (!meshId.success || !nodeId.success) {
      return {
        ok: false,
        reason: "request_malformed",
        error: createContractError(
          "internal_failure",
          "identity.seam_identity_invalid",
          "The seam was configured with a node or mesh id that is not a wire id, so no request can be attributed. This is a wiring fault, not a peer problem.",
        ),
      }
    }

    const trust = await verifyNodeTrust(this.#deps.trust, { nodeId: nodeId.data, meshId: meshId.data })
    if (!trust.ok) return trust

    // The `nodeKeyId` in the request is a POINTER, not a key. The bytes used to
    // verify come from the pin store, so a peer that sends a different public key
    // alongside its own claims is simply ignored — there is no field on this path
    // for it to arrive in.
    const pin = await resolvePinnedKey(this.#deps.pins, {
      nodeId: nodeId.data,
      meshId: meshId.data,
      nodeKeyId: request.signature.keyId,
    })
    if (!pin.ok) return pin

    const storedKey = fromBase64Url(pin.value.publicKey)

    const verified = verifyMeshRequest(request.signature, {
      storedKey,
      expectedNodeId: nodeId.data,
      now: this.#deps.now(),
      replayGuard: this.#deps.replayGuard,
    })
    if (!verified.ok) return verified

    return {
      ok: true,
      value: {
        nodeId: trust.value.nodeId,
        meshId: trust.value.meshId,
        nodeKeyId: pin.value.nodeKeyId,
        fingerprint: pin.value.fingerprint,
        enrolledAt: trust.value.enrolledAt,
      },
    }
  }
}

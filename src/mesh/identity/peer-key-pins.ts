import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { meshIdSchema, nodeIdSchema, type MeshId, type NodeId } from "../../orchestration/identifiers.js"
import { nodeKeyIdSchema } from "../protocol/identifiers.js"
import type { NodeKeyId } from "./wire-ids.js"
import { constantTimeEqual } from "./crypto.js"
import { parsePublicNodeKey, type PublicNodeKey } from "./node-key.js"

/**
 * Peer key pins.
 *
 * A pin is the statement "this `nodeId` signs with this exact key, as of this
 * moment". It exists because enrollment is a moment in time and the wire stays
 * open afterwards: a node that enrolls with key A and later signs with key B has
 * either rotated legitimately or had its key replaced, and only a pin can tell
 * those apart. Without a pin, possession of *any* key a node has ever used is
 * permanent authentication, and the only remedy for a compromised node is to
 * rename it — which is exactly what the milestone forbids, because it requires
 * revocation to be INDIVIDUAL.
 *
 * Four operations, and the interesting one is `rotate`:
 *
 *   - `pin`      first trust of a key, after an accepted enrollment.
 *   - `verify`   is this key the pinned one? A plain "is there a pin" check
 *                would let a second key through the moment two are stored.
 *   - `rotate`   replace the pinned key. REQUIRES the new key to arrive with a
 *                fresh enrollment code, because rotation is the one operation
 *                that hands a new party the ability to authenticate as a node,
 *                and doing it unauthenticated would make every pin a suggestion.
 *   - `revoke`   drop the pin entirely.
 *
 * `rotate` deletes rather than flags. A store that keeps the previous key in a
 * `previousKeys` array is a store where a rotation does not take effect until
 * something else expires, and "the old key stopped working immediately" is the
 * property an operator rotating a key off a possibly-compromised machine is
 * buying.
 */

/** A pin as it is recorded and as it travels in `peerKeyPins`. */
export interface PeerKeyPin extends PublicNodeKey {
  readonly nodeId: NodeId
  readonly meshId: MeshId
  readonly pinnedAt: number
  /** The enrollment that produced this pin, for the audit trail. */
  readonly enrollmentId: string
  /**
   * How many times this pin has been rotated.
   *
   * Recorded rather than inferred because a chain of rotations is how a
   * long-lived key ends up trusted by every node in the mesh, and an operator
   * asking "has this node's key changed since I enrolled it?" needs a number.
   */
  readonly generation: number
}

export interface PinNodeKeyInput {
  readonly nodeId: NodeId
  readonly meshId: MeshId
  readonly key: PublicNodeKey
  readonly enrollmentId: string
  readonly now: number
}

export interface RotateNodeKeyInput {
  readonly nodeId: NodeId
  readonly meshId: MeshId
  readonly key: PublicNodeKey
  readonly enrollmentId: string
  readonly now: number
  /** Who rotated it, for the audit log. Never a credential. */
  readonly by: string
  readonly reason: string
}

export type PinViolation =
  | "pin_missing"
  | "pin_key_id_unknown"
  | "pin_key_mismatch"
  | "pin_node_mismatch"
  | "pin_mesh_mismatch"
  | "pin_store_failure"

export type VerifyPinResult =
  | { readonly ok: true; readonly value: PeerKeyPin }
  | { readonly ok: false; readonly reason: PinViolation; readonly error: ContractError }

/**
 * Durable pin storage.
 *
 * A pin store that is not durable is not a weaker guarantee, it is a different
 * one: an ephemeral store forgets a node at restart, and a node that has to
 * re-enroll after every controller restart is a node whose enrollment is a
 * recurring operational event. That in turn trains operators to keep codes
 * around, which is the exact habit that turns a one-time credential into a
 * standing one.
 */
export interface PeerKeyPinStore {
  /** Records first trust. Refuses if a pin already exists — re-pinning is `rotate`. */
  pin(input: PinNodeKeyInput): Promise<Result<PeerKeyPin>>
  /**
   * The CURRENT pin for a node, or `null` if there is none.
   *
   * Single-key by construction: the interface has no method that returns a list
   * of keys for a node, so there is no way for a caller to "check whether any of
   * these is valid" and accidentally accept a superseded one.
   */
  current(nodeId: NodeId): Promise<Result<PeerKeyPin | null>>
  /** Replaces the pinned key. The previous key stops working immediately. */
  rotate(input: RotateNodeKeyInput): Promise<Result<PeerKeyPin>>
  /** Drops the pin. Idempotent: revoking an unpinned node is not an error. */
  revoke(nodeId: NodeId): Promise<Result<true>>
}

/**
 * Resolves the key a request is allowed to verify against, by `nodeKeyId`.
 *
 * This is the per-request path and it is deliberately a DIFFERENT function from
 * {@link verifyPinnedKey}. At enrollment the peer submits a full public key and
 * the question is "may this key be trusted, and is it the one already pinned". On
 * every later request the peer submits only a CLAIM of which key it is signing
 * with, and the key bytes come from the pin — the peer does not get to choose the
 * bytes that are used to check its own signature, because a signature check
 * against a caller-supplied public key verifies nothing at all.
 *
 * Which is the whole of "a payload is a claim, not a grant" applied to identity:
 * the `nodeKeyId` in a header is a pointer, and the grant is the pin.
 */
export async function resolvePinnedKey(
  store: PeerKeyPinStore,
  presented: { readonly nodeId: NodeId; readonly meshId: MeshId; readonly nodeKeyId: NodeKeyId },
): Promise<VerifyPinResult> {
  const pin = await store.current(presented.nodeId)
  if (!pin.ok) return pinRefusal("pin_store_failure", pin.error)
  const record = pin.value
  if (record === null) {
    return pinRefusal(
      "pin_missing",
      createContractError(
        "policy_denied",
        "identity.key_not_pinned",
        `Node ${presented.nodeId} has no pinned key, so nothing it presents can authenticate it. A node is addressable only through an accepted enrollment, and enrollment is the only thing that pins a key.`,
      ),
    )
  }
  if (record.meshId !== presented.meshId) {
    return pinRefusal(
      "pin_mesh_mismatch",
      createContractError(
        "policy_denied",
        "identity.key_wrong_mesh",
        `Node ${presented.nodeId} is pinned in mesh ${record.meshId}, not ${presented.meshId}. A key pinned in one mesh is not a credential in another: the pin is the whole authorisation, and re-using it across meshes would make every mesh's node list a single flat namespace.`,
      ),
    )
  }
  if (record.nodeKeyId !== presented.nodeKeyId) {
    return pinRefusal(
      "pin_key_id_unknown",
      createContractError(
        "policy_denied",
        "identity.key_id_not_pinned",
        `Node ${presented.nodeId} has key id ${record.nodeKeyId} pinned; ${presented.nodeKeyId} is not it. An unknown key id is refused rather than accepted as an alternative, because a store holding more than one key per node is how a rotated key stays trusted by accident.`,
      ),
    )
  }
  return { ok: true, value: record }
}

/**
 * Decides whether a presented key is the pinned one.
 *
 * Separate from the store on purpose. The store answers "what is pinned", which
 * is a read; this answers "may this key act as this node", which is a policy
 * decision, and keeping it out of the store means a durable store implementation
 * cannot accidentally get it wrong by having its own idea of the comparison.
 *
 * Order: mesh, node, key id, key bytes. The cheap identity checks come before
 * the key comparison so that a key presented for the wrong node is refused
 * without spending an ed25519 verification, and so that the refusal names the
 * mismatch precisely for the audit log.
 *
 * The key bytes are compared with `constantTimeEqual` even though a public key is
 * not a secret. The cost is two SHA-256s; the benefit is that the one place
 * where "am I the key I claim to be" is decided cannot be reimplemented with
 * `===` by a later edit, which is the actual failure mode being guarded.
 */
export async function verifyPinnedKey(
  store: PeerKeyPinStore,
  presented: { readonly nodeId: NodeId; readonly meshId: MeshId; readonly key: unknown },
): Promise<VerifyPinResult> {
  const parsedKey = parsePublicNodeKey(presented.key)
  if (!parsedKey.ok) {
    return pinRefusal("pin_key_mismatch", parsedKey.error)
  }

  const pin = await store.current(presented.nodeId)
  if (!pin.ok) return pinRefusal("pin_store_failure", pin.error)
  const record = pin.value
  if (record === null) {
    return pinRefusal(
      "pin_missing",
      createContractError(
        "policy_denied",
        "identity.key_not_pinned",
        `Node ${presented.nodeId} has no pinned key, so nothing it presents can authenticate it. A node is addressable only through an accepted enrollment, and enrollment is the only thing that pins a key.`,
      ),
    )
  }
  if (record.meshId !== presented.meshId) {
    return pinRefusal(
      "pin_mesh_mismatch",
      createContractError(
        "policy_denied",
        "identity.key_wrong_mesh",
        `Node ${presented.nodeId} is pinned in mesh ${record.meshId}, not ${presented.meshId}. A key pinned in one mesh is not a credential in another: the pin is the whole authorisation, and re-using it across meshes would make every mesh's node list a single flat namespace.`,
      ),
    )
  }
  if (record.nodeId !== presented.nodeId) {
    return pinRefusal(
      "pin_node_mismatch",
      createContractError(
        "policy_denied",
        "identity.key_wrong_node",
        `The pin presented belongs to ${record.nodeId}, not ${presented.nodeId}.`,
      ),
    )
  }
  if (record.nodeKeyId !== parsedKey.value.nodeKeyId) {
    return pinRefusal(
      "pin_key_id_unknown",
      createContractError(
        "policy_denied",
        "identity.key_id_not_pinned",
        `Node ${presented.nodeId} has key id ${record.nodeKeyId} pinned; ${parsedKey.value.nodeKeyId} is not it. An unknown key id is refused rather than accepted as an alternative, because a store holding more than one key per node is how a rotated key stays trusted by accident.`,
      ),
    )
  }
  if (!constantTimeEqual(record.publicKey, parsedKey.value.publicKey)) {
    return pinRefusal(
      "pin_key_mismatch",
      createContractError(
        "policy_denied",
        "identity.key_mismatch",
        `Node ${presented.nodeId} presented key id ${parsedKey.value.nodeKeyId} with key bytes that do not match the pinned bytes. The key id is derived from the key, so this means the pin and the key disagree, and the disagreement is resolved in favour of the pin.`,
      ),
    )
  }
  return { ok: true, value: record }
}

function pinRefusal(reason: PinViolation, error: ContractError): VerifyPinResult {
  return { ok: false, reason, error }
}

/** The in-memory pin store. The reference for what `pin`/`rotate` must guarantee. */
export class InMemoryPeerKeyPinStore implements PeerKeyPinStore {
  readonly #pins = new Map<string, PeerKeyPin>()

  async pin(input: PinNodeKeyInput): Promise<Result<PeerKeyPin>> {
    const existing = this.#pins.get(input.nodeId)
    if (existing !== undefined) {
      // Not a merge, not an overwrite. A second `pin` for a live node means two
      // enrollments both believed they were first, and picking either one is a
      // coin toss that decides who a compromised node can impersonate.
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "identity.already_pinned",
          `Node ${input.nodeId} already has key ${existing.nodeKeyId} pinned. A second pin is refused: choosing between two keys for one node is exactly the ambiguity a pin exists to remove. Use rotate() with a fresh enrollment code.`,
        ),
      }
    }
    const record = recordOf(input.nodeId, input.meshId, input.key, input.enrollmentId, input.now, 1)
    this.#pins.set(input.nodeId, record)
    return { ok: true, value: record }
  }

  async current(nodeId: NodeId): Promise<Result<PeerKeyPin | null>> {
    return { ok: true, value: this.#pins.get(nodeId) ?? null }
  }

  async rotate(input: RotateNodeKeyInput): Promise<Result<PeerKeyPin>> {
    if (input.by.length === 0 || input.by.length > 256) {
      return {
        ok: false,
        error: createContractError(
          "policy_denied",
          "identity.rotation_unattributed",
          "A key rotation must name who performed it. A rotation is the one operation that hands a new party the ability to authenticate as an existing node, and an unattributable one is how a key change becomes indistinguishable from a compromise.",
        ),
      }
    }
    if (input.reason.length === 0 || input.reason.length > 1024) {
      return {
        ok: false,
        error: createContractError(
          "policy_denied",
          "identity.rotation_unmotivated",
          "A key rotation must state why. 'Routine' is a reason; the empty string is not, and the difference is what the audit log is for.",
        ),
      }
    }
    const existing = this.#pins.get(input.nodeId)
    if (existing === undefined) {
      return {
        ok: false,
        error: createContractError(
          "policy_denied",
          "identity.rotate_unpinned",
          `Node ${input.nodeId} has no pinned key, so there is nothing to rotate. Rotating an unpinned node would create trust for a node that never enrolled, which is why rotate refuses where pin would succeed.`,
        ),
      }
    }
    if (existing.meshId !== input.meshId) {
      return {
        ok: false,
        error: createContractError(
          "policy_denied",
          "identity.rotate_wrong_mesh",
          `Node ${input.nodeId} is pinned in mesh ${existing.meshId}; it cannot be rotated from ${input.meshId}.`,
        ),
      }
    }
    if (existing.nodeKeyId === input.key.nodeKeyId && constantTimeEqual(existing.publicKey, input.key.publicKey)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "identity.rotate_same_key",
          "That is already the pinned key. A rotation that changes nothing still burns the enrollment code it was authorised with, so it is refused rather than accepted as a no-op that looks like a change.",
        ),
      }
    }
    // The record is REPLACED, not annotated. The superseded key leaves the store
    // here and is not reachable through any method on this interface, which is
    // what makes "rotation takes effect immediately" a property of the type
    // rather than a promise in a comment.
    const record = recordOf(input.nodeId, input.meshId, input.key, input.enrollmentId, input.now, existing.generation + 1)
    this.#pins.set(input.nodeId, record)
    return { ok: true, value: record }
  }

  async revoke(nodeId: NodeId): Promise<Result<true>> {
    this.#pins.delete(nodeId)
    return { ok: true, value: true }
  }

  get size(): number {
    return this.#pins.size
  }
}

function recordOf(
  nodeId: NodeId,
  meshId: MeshId,
  key: PublicNodeKey,
  enrollmentId: string,
  now: number,
  generation: number,
): PeerKeyPin {
  return Object.freeze({ nodeId, meshId, ...key, pinnedAt: now, enrollmentId, generation })
}

/** Validates an untrusted pin, for a durable store reading its own rows. */
export function parsePeerKeyPin(value: unknown): Result<PeerKeyPin> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refusePin("A pin record must be an object")
  }
  const record = value as Record<string, unknown>
  const nodeId = nodeIdSchema.safeParse(record.nodeId)
  if (!nodeId.success) return refusePin("pin nodeId is not a wire id")
  const key = parsePublicNodeKey(record)
  if (!key.ok) return { ok: false, error: key.error }
  if (typeof record.pinnedAt !== "number" || !Number.isSafeInteger(record.pinnedAt) || record.pinnedAt < 0) {
    return refusePin("pin pinnedAt is not a non-negative integer epoch millisecond count")
  }
  if (typeof record.generation !== "number" || !Number.isSafeInteger(record.generation) || record.generation < 1) {
    return refusePin("pin generation is not a positive integer")
  }
  if (typeof record.enrollmentId !== "string" || record.enrollmentId.length === 0 || record.enrollmentId.length > 128) {
    return refusePin("pin enrollmentId is missing or over-long")
  }
  const meshId = meshIdSchema.safeParse(record.meshId)
  if (!meshId.success) return refusePin("pin meshId is not a wire id")
  return {
    ok: true,
    value: Object.freeze({
      nodeId: nodeId.data,
      meshId: meshId.data,
      ...key.value,
      pinnedAt: record.pinnedAt,
      enrollmentId: record.enrollmentId,
      generation: record.generation,
    }),
  }
}

function refusePin(detail: string): { ok: false; error: ContractError } {
  return { ok: false, error: createContractError("validation", "identity.pin_invalid", `Peer key pin refused: ${detail}.`) }
}

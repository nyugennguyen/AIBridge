import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { meshIdSchema, nodeIdSchema, type MeshId, type NodeId } from "../../orchestration/identifiers.js"
import { nodeKeyIdSchema } from "../protocol/identifiers.js"
import type { NodeKeyId } from "./wire-ids.js"

/**
 * Node trust and revocation.
 *
 * A revocation record is a statement that a `nodeId` no longer has ANY standing,
 * and it is consulted at AUTHENTICATION — never at authorization, never at the
 * first command, never at the terminal attach. That placement is the whole
 * design, and it is a response to a specific shape of failure:
 *
 *   An authenticated node that is refused later is a node that has already had a
 *   session, a lease conversation, or a WebSocket. Between authentication and
 *   the later check it held a live connection and a valid key. A revocation that
 *   is checked "eventually" revokes a node that has already been told it is
 *   enrolled, has already been sent work, and has already been given a project
 *   path. The plan's completion criterion is that "a revoked node cannot
 *   reconnect or stream a terminal" — "reconnect" is the operative word, and it
 *   is only true if the check is on the way IN.
 *
 * So: revocation is part of `authenticate`, and the durable store is what makes
 * it survive a restart. An in-memory revocation set would make revocation a
 * promise that a controller restart silently withdraws, which is worse than not
 * offering it.
 */

/** Why a node was revoked. An operator reads this; an attacker never does. */
export interface NodeRevocation {
  readonly nodeId: NodeId
  readonly meshId: MeshId
  readonly reason: string
  /** Who revoked it. A user id, never a credential. */
  readonly by: string
  readonly at: number
  /**
   * The key that was pinned when the node was revoked.
   *
   * Recorded for the audit trail AND read back at enrollment, which is the part that
   * matters. A `nodeId` is derived from an enrollment code, so a revoked node can
   * return with a FRESH code, be minted a DIFFERENT `nodeId`, and be re-pinned — while
   * presenting the very key that was just revoked. Without a key-indexed lookup,
   * "revoke the compromised machine" reduces to "revoke one of its names", and the
   * compromised key walks straight back onto the mesh.
   * {@link NodeTrustStore.revocationByKeyId} is what closes that, and this field is
   * what it reads.
   */
  readonly revokedKeyId: NodeKeyId
}

/**
 * Durable node trust.
 *
 * `trusted` is the positive direction and `revocation` is the negative one, and
 * they are SEPARATE methods rather than one `status(nodeId)` returning a union.
 * A single status method has to be given a default, and every possible default
 * is wrong for someone: defaulting to "trusted" is fail-open, defaulting to
 * "revoked" makes every unauthenticated node a denial-of-service target against
 * the trusted set, and defaulting to "unknown" pushes a third state into the
 * type that every caller then has to handle. Two methods with no default means
 * "no record" is a value the caller must ask for, and a caller that forgets gets
 * `null`, which every implementation of this interface is required to treat as a
 * refusal.
 */
export interface NodeTrustStore {
  /**
   * The node's standing, or `null` if it is not enrolled. A `null` is a refusal
   * at the authentication seam and MUST NOT be read as "undecided, allow".
   */
  trusted(nodeId: NodeId): Promise<Result<TrustedNode | null>>
  /** The revocation record, or `null` if the node is not revoked. */
  revocation(nodeId: NodeId): Promise<Result<NodeRevocation | null>>
  /**
   * The revocation covering this KEY, or `null` if the key is not revoked.
   *
   * The second index, and the one that makes revocation mean what an operator
   * believes it means. Revoking a `nodeId` alone is revoking a NAME: because the id
   * is derived from an enrollment code, the same machine coming back with a fresh code
   * is a different `nodeId` and would be re-pinned while presenting the key that was
   * just revoked — which is the compromised credential, the one thing the operator
   * revoked in order to remove. So enrollment consults THIS before it pins, and a
   * `nodeKeyId` is a function of the key bytes, which makes the lookup exact rather
   * than a heuristic about "how similar is this key".
   *
   * Returning a `Result` rather than a bare `null` keeps the fail-closed property: an
   * implementation that cannot answer must return a refusal, and a caller that treated
   * an unreadable key-revocation index as "not revoked" would re-admit precisely the
   * key the index exists to keep out.
   */
  revocationByKeyId(nodeKeyId: NodeKeyId): Promise<Result<NodeRevocation | null>>
  revocation(nodeId: NodeId): Promise<Result<NodeRevocation | null>>
  /** Records the trust created by an accepted enrollment. */
  enroll(node: TrustedNode): Promise<Result<true>>
  /** Records a revocation. Overwrites an earlier one, keeping the first `at`. */
  revoke(revocation: NodeRevocation): Promise<Result<NodeRevocation>>
  /**
   * Every currently trusted node, for the enrollment response's `peerKeyPins`.
   * Excludes revoked nodes by CONSTRUCTION, so a caller cannot accidentally hand
   * a joining node a peer list containing a node that must not be contacted.
   */
  listTrusted(meshId: MeshId): Promise<Result<readonly TrustedNode[]>>
}

export interface TrustedNode {
  readonly nodeId: NodeId
  readonly meshId: MeshId
  readonly nodeKeyId: NodeKeyId
  readonly enrolledAt: number
  readonly displayName: string
}

export type TrustVerdict =
  | { readonly ok: true; readonly value: TrustedNode }
  | { readonly ok: false; readonly reason: TrustRefusal; readonly error: ContractError }

export type TrustRefusal =
  | "node_unknown"
  | "node_revoked"
  | "node_wrong_mesh"
  | "trust_store_failure"

/**
 * The authentication-time trust decision.
 *
 * Revocation FIRST, then enrolment, then mesh. The order is not a style choice:
 *
 *   - Revocation is checked before the store is asked for the node's pin, so a
 *     revoked node is refused on the strength of one durable read rather than
 *     after a pin lookup that a store outage could turn into "unknown" instead of
 *     "revoked". The operator then sees the real reason.
 *   - The refusal for a revoked node does not name the revocation's `reason` or
 *     `by`. Those are operator-facing. A revoked node reconnecting learns that it
 *     is revoked and nothing else; it does not learn whether the machine it was
 *     on was reported stolen, because that is the answer an attacker would use to
 *     decide whether to keep trying.
 */
export async function verifyNodeTrust(
  store: NodeTrustStore,
  input: { readonly nodeId: NodeId; readonly meshId: MeshId },
): Promise<TrustVerdict> {
  const revocation = await store.revocation(input.nodeId)
  if (!revocation.ok) {
    // A store that cannot answer is a refusal. The alternative — "no revocation
    // found, therefore trusted" — inverts the entire module: the safe state
    // becomes the one you get when the disk is full.
    return {
      ok: false,
      reason: "trust_store_failure",
      error: createContractError(
        "internal_failure",
        "identity.trust_store_unavailable",
        "Node trust could not be read, so the request is refused. Treating an unreadable revocation set as an empty one is how a storage failure becomes a mesh-wide authentication bypass.",
      ),
    }
  }
  if (revocation.value !== null) {
    return {
      ok: false,
      reason: "node_revoked",
      error: createContractError(
        "policy_denied",
        "identity.node_revoked",
        `Node ${input.nodeId} is revoked and cannot authenticate, reconnect, deliver a command, or stream a terminal. Revocation is permanent: a node that needs to come back must enroll again with a fresh one-time code.`,
      ),
    }
  }

  const trusted = await store.trusted(input.nodeId)
  if (!trusted.ok) {
    return {
      ok: false,
      reason: "trust_store_failure",
      error: createContractError(
        "internal_failure",
        "identity.trust_store_unavailable",
        "Node trust could not be read, so the request is refused.",
      ),
    }
  }
  if (trusted.value === null) {
    return {
      ok: false,
      reason: "node_unknown",
      error: createContractError(
        "policy_denied",
        "identity.node_not_enrolled",
        `Node ${input.nodeId} is not enrolled on this mesh. Enrollment is the only path to being addressable, and a node that has not enrolled presents no key any peer would trust.`,
      ),
    }
  }
  if (trusted.value.meshId !== input.meshId) {
    return {
      ok: false,
      reason: "node_wrong_mesh",
      error: createContractError(
        "policy_denied",
        "identity.node_wrong_mesh",
        `Node ${input.nodeId} is enrolled in mesh ${trusted.value.meshId}, not ${input.meshId}. Tailscale reachability is not a cross-mesh grant: a node that can open a socket to this controller has still presented no credential this mesh trusts.`,
      ),
    }
  }
  return { ok: true, value: trusted.value }
}

/**
 * Revokes a node and removes its pin.
 *
 * Both stores are written, and the pin removal is not optional bookkeeping. A
 * revocation flag with the pin still present is a node whose key is still
 * "trusted" by every read path that consults the pin store without the trust
 * store — and the milestone's own wording is that a revoked node's pinned key
 * "must be removed from the trusted set, not merely flagged". Removing the pin
 * means there is no longer any record anywhere that says this key belongs to a
 * node.
 *
 * Order is revoke-then-unpin, and the reason is the direction a failure is
 * recoverable in. If the unpin fails, the node is revoked and still pinned: every
 * authentication path checks revocation first, so the node is still refused, and
 * the audit log shows an incomplete revocation that an operator can finish. The
 * reverse order would leave a node unpinned and unrevoked — reachable as
 * "unknown" rather than "denied", which is a much quieter failure.
 */
export async function revokeNode(
  input: {
    readonly nodeId: NodeId
    readonly meshId: MeshId
    readonly reason: string
    readonly by: string
    readonly at: number
  },
  deps: { readonly trust: NodeTrustStore; readonly pins: PeerKeyPinRevoker },
): Promise<Result<NodeRevocation>> {
  if (input.reason.length === 0 || input.reason.length > 1024) {
    return {
      ok: false,
      error: createContractError(
        "policy_denied",
        "identity.revocation_unmotivated",
        "A revocation must state a reason. Revoking a node is how an operator says 'this machine is no longer part of the mesh', and an unexplained revocation is indistinguishable from a mistake — which is the state nobody wants to be in when a fleet goes dark.",
      ),
    }
  }
  if (input.by.length === 0 || input.by.length > 256) {
    return {
      ok: false,
      error: createContractError(
        "policy_denied",
        "identity.revocation_unattributed",
        "A revocation must name who performed it. An unattributable revocation is indistinguishable from a compromise of the controller itself.",
      ),
    }
  }

  const alreadyRevoked = await deps.trust.revocation(input.nodeId)
  if (!alreadyRevoked.ok) {
    return { ok: false, error: alreadyRevoked.error }
  }
  if (alreadyRevoked.value !== null) {
    // Revoking a revoked node is IDEMPOTENT and returns the FIRST record.
    //
    // It is not a conflict, and this is the reason: revocation is a terminal fact
    // that operators re-apply — a runbook that revokes a node, a retry after a
    // timeout, a second operator who did not see the first. Making any of those an
    // error means an operator has to know whether someone got there first, and the
    // natural response to that error is to look for a way to force it.
    //
    // Returning the original record also means the second caller's `reason` and `at`
    // are DISCARDED, which is the property the audit log needs: "was this node
    // trusted at the time of the incident" must not have an answer that depends on
    // when somebody happened to re-run the command.
    return { ok: true, value: alreadyRevoked.value }
  }

  const trusted = await deps.trust.trusted(input.nodeId)
  if (!trusted.ok) {
    return { ok: false, error: trusted.error }
  }
  if (trusted.value === null) {
    return {
      ok: false,
      error: createContractError(
        "policy_denied",
        "identity.revoke_unknown_node",
        `Node ${input.nodeId} is not enrolled, so there is nothing to revoke. Refusing is the point: a typo in a node id must not create a revocation record that an operator later reads as "this machine was removed from the mesh".`,
      ),
    }
  }
  if (trusted.value.meshId !== input.meshId) {
    return {
      ok: false,
      error: createContractError(
        "policy_denied",
        "identity.revoke_wrong_mesh",
        `Node ${input.nodeId} is enrolled in mesh ${trusted.value.meshId}; it cannot be revoked from ${input.meshId}.`,
      ),
    }
  }

  const revoked = await deps.trust.revoke({
    nodeId: input.nodeId,
    meshId: input.meshId,
    reason: input.reason,
    by: input.by,
    at: input.at,
    revokedKeyId: trusted.value.nodeKeyId,
  })
  if (!revoked.ok) return { ok: false, error: revoked.error }

  const unpinned = await deps.pins.revoke(input.nodeId)
  if (!unpinned.ok) {
    // The revocation stands. Returning an error here is honest about the
    // half-finished state, and the message says which half completed so an
    // operator knows the node is denied but its pin is still on disk.
    return {
      ok: false,
      error: createContractError(
        "internal_failure",
        "identity.revocation_pin_retained",
        `Node ${input.nodeId} is revoked and its trust record is durable, but its pinned key could not be removed. The node is still refused — revocation is checked before the pin — but the pin must be cleared before this node is ever trusted again.`,
      ),
    }
  }
  return { ok: true, value: revoked.value }
}

/**
 * Refuses a KEY that some revocation already covers.
 *
 * Separate from {@link verifyNodeTrust} because it answers a different question
 * about a different subject. `verifyNodeTrust` is "may this NODE act" and runs on
 * every request; this is "may this KEY be trusted at all" and runs once, at
 * enrollment, before anything is written.
 *
 * The failure direction is the load-bearing part. An unreadable key index returns a
 * refusal, not a `null`: a store outage must not be the mechanism by which a revoked
 * key re-enters the mesh, and "we could not check" and "it is fine" have to be
 * different code paths or someone will merge them.
 *
 * The message names the key id and the node it was revoked from — both of which the
 * requester already supplied or can already see in `peerKeyPins` — and withholds the
 * revocation's `reason` and `by`, which are operator-facing for the same reason
 * {@link verifyNodeTrust} withholds them.
 */
export async function verifyKeyNotRevoked(
  store: NodeTrustStore,
  nodeKeyId: NodeKeyId,
): Promise<Result<true>> {
  const revocation = await store.revocationByKeyId(nodeKeyId)
  if (!revocation.ok) {
    return {
      ok: false,
      error: createContractError(
        "internal_failure",
        "identity.key_revocation_unavailable",
        "The revoked-key index could not be read, so this key cannot be cleared for enrollment. Treating an unreadable index as an empty one is how a key revocation is silently withdrawn by a storage failure.",
      ),
    }
  }
  if (revocation.value !== null) {
    return {
      ok: false,
      error: createContractError(
        "policy_denied",
        "identity.key_revoked",
        `Key ${nodeKeyId} was revoked with node ${revocation.value.nodeId} and cannot be enrolled again. Revocation is permanent for a KEY as well as for a node id: a machine that needs to return must generate a new key, because the revoked one is the credential the revocation exists to remove.`,
      ),
    }
  }
  return { ok: true, value: true }
}

/** The slice of {@link PeerKeyPinStore} that revocation needs. */
export interface PeerKeyPinRevoker {
  revoke(nodeId: NodeId): Promise<Result<true>>
}

/** The in-memory trust store. The reference for durability semantics. */
export class InMemoryNodeTrustStore implements NodeTrustStore {
  readonly #trusted = new Map<string, TrustedNode>()
  readonly #revoked = new Map<string, NodeRevocation>()
  readonly #revokedByKey = new Map<string, NodeRevocation>()

  async trusted(nodeId: NodeId): Promise<Result<TrustedNode | null>> {
    return { ok: true, value: this.#trusted.get(nodeId) ?? null }
  }

  async revocation(nodeId: NodeId): Promise<Result<NodeRevocation | null>> {
    return { ok: true, value: this.#revoked.get(nodeId) ?? null }
  }

  /**
   * Indexed by key id as revocations are written rather than scanned on read.
   *
   * A linear scan would be correct and would also be a per-enrollment cost that grows
   * with the number of ever-revoked nodes, on a path a peer can drive. The index is
   * maintained in {@link revoke} and deleted from in {@link #unindexRevocation} so the
   * two cannot drift; a first-revocation-wins store therefore never has to remove one.
   */
  async revocationByKeyId(nodeKeyId: NodeKeyId): Promise<Result<NodeRevocation | null>> {
    return { ok: true, value: this.#revokedByKey.get(nodeKeyId) ?? null }
  }

  async enroll(node: TrustedNode): Promise<Result<true>> {
    if (this.#trusted.has(node.nodeId)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "identity.already_enrolled",
          `Node ${node.nodeId} is already enrolled. A second enrollment must be a ROTATION of the existing key, not a second trust record: two trust records for one node means every read path has to decide which one wins, and the one that loses is a pin an attacker controls.`,
        ),
      }
    }
    if (this.#revoked.has(node.nodeId)) {
      // Revocation is TERMINAL for a node id, and a revocation is not undone by
      // enrolling again. Without this, revocation and enrollment are two writes to
      // the same row and the second one silently wins — which means a node that was
      // revoked for a compromised machine comes back the moment anything calls
      // `enroll` with its id, and nothing in the audit log says it did.
      //
      // A node that legitimately needs to return is a NEW identity: a new
      // enrollment code derives a new `nodeId`, which is why the retry path in
      // `enrollment-code.ts` is safe.
      return {
        ok: false,
        error: createContractError(
          "policy_denied",
          "identity.enrollment_revoked",
          `Node ${node.nodeId} is revoked and cannot be enrolled again. Revocation is permanent for a node id; a machine that needs to come back enrolls with a fresh code, which mints a new node id. Clearing a revocation has to be a deliberate act, not a side effect of a retry.`,
        ),
      }
    }
    this.#trusted.set(node.nodeId, Object.freeze({ ...node }))
    return { ok: true, value: true }
  }

  /**
   * The FIRST revocation wins on `at`, and a repeat keeps the original.
   *
   * A revocation is a terminal fact. If a second call could overwrite the first,
   * then re-revoking a node whose revocation was cleared administratively would
   * move the `at` forward, and an audit reader asking "was this node trusted at
   * the time of the incident?" would get an answer that depends on when somebody
   * happened to re-run the command.
   */
  async revoke(revocation: NodeRevocation): Promise<Result<NodeRevocation>> {
    const existing = this.#revoked.get(revocation.nodeId)
    if (existing !== undefined) {
      return { ok: true, value: existing }
    }
    this.#trusted.delete(revocation.nodeId)
    const record = Object.freeze({ ...revocation })
    this.#revoked.set(revocation.nodeId, record)
    // The key index is written in the SAME transition as the node record, never
    // lazily on read. An enrollment that arrives between the two writes is exactly
    // the window where a revoked key gets pinned, and a lazily-populated index is the
    // kind of thing that is written correctly in the happy path and not in the one
    // that matters.
    this.#revokedByKey.set(record.revokedKeyId, record)
    return { ok: true, value: record }
  }

  async listTrusted(meshId: MeshId): Promise<Result<readonly TrustedNode[]>> {
    const out: TrustedNode[] = []
    for (const node of this.#trusted.values()) {
      // Revoked nodes are excluded HERE rather than at the call site, so no caller
      // can build a peer list containing a node that must not be contacted.
      if (node.meshId !== meshId) continue
      if (this.#revoked.has(node.nodeId)) continue
      out.push(node)
    }
    return { ok: true, value: Object.freeze(out) }
  }

  get trustedCount(): number {
    return this.#trusted.size
  }

  get revokedCount(): number {
    return this.#revoked.size
  }
}

/**
 * A store whose every read fails.
 *
 * Exists so the fail-closed path is reachable from a test without a subclass that
 * has to be believed. A "broken store" that a test fakes by throwing is a fake;
 * this is the shape the interface actually has when the disk is gone.
 */
export class UnavailableNodeTrustStore implements NodeTrustStore {
  readonly #detail: string

  constructor(detail = "the trust store is unavailable") {
    this.#detail = detail
  }

  async trusted(): Promise<Result<TrustedNode | null>> {
    return this.#fail()
  }

  async revocation(): Promise<Result<NodeRevocation | null>> {
    return this.#fail()
  }

  /**
   * Included precisely so that a store which cannot answer the KEY question is
   * reachable from a test. This is the method whose silent `null` would re-admit a
   * revoked key, so a caller that treats "unreadable" as "not revoked" is
   * demonstrably a bug rather than a hypothetical one.
   */
  async revocationByKeyId(): Promise<Result<NodeRevocation | null>> {
    return this.#fail()
  }

  async enroll(): Promise<Result<true>> {
    return this.#fail()
  }

  async revoke(): Promise<Result<NodeRevocation>> {
    return this.#fail()
  }

  async listTrusted(): Promise<Result<readonly TrustedNode[]>> {
    return this.#fail()
  }

  #fail(): { ok: false; error: ContractError } {
    return {
      ok: false,
      error: createContractError("internal_failure", "identity.trust_store_unavailable", this.#detail),
    }
  }
}

/** Validates an untrusted trust record, for a durable store reading its own rows. */
export function parseTrustedNode(value: unknown): Result<TrustedNode> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refuseTrust("A trust record must be an object")
  }
  const record = value as Record<string, unknown>
  const nodeId = nodeIdSchema.safeParse(record.nodeId)
  if (!nodeId.success) return refuseTrust("nodeId is not a wire id")
  const meshId = meshIdSchema.safeParse(record.meshId)
  if (!meshId.success) return refuseTrust("meshId is not a wire id")
  const nodeKeyId = nodeKeyIdSchema.safeParse(record.nodeKeyId)
  if (!nodeKeyId.success) return refuseTrust("nodeKeyId is not a wire id")
  if (typeof record.enrolledAt !== "number" || !Number.isSafeInteger(record.enrolledAt) || record.enrolledAt < 0) {
    return refuseTrust("enrolledAt is not a non-negative integer epoch millisecond count")
  }
  if (typeof record.displayName !== "string" || record.displayName.length === 0 || record.displayName.length > 256) {
    return refuseTrust("displayName is missing or over-long")
  }
  return {
    ok: true,
    value: Object.freeze({
      nodeId: nodeId.data,
      meshId: meshId.data,
      nodeKeyId: nodeKeyId.data,
      enrolledAt: record.enrolledAt,
      displayName: record.displayName,
    }),
  }
}

function refuseTrust(detail: string): { ok: false; error: ContractError } {
  return { ok: false, error: createContractError("validation", "identity.trust_record_invalid", `Node trust record refused: ${detail}.`) }
}

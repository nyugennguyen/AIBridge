import { randomBytes } from "node:crypto"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { meshIdSchema, nodeIdSchema, type MeshId, type NodeId } from "../../orchestration/identifiers.js"
import { codeHashSchema, enrollmentIdSchema, provisionalNodeIdSchema } from "../protocol/identifiers.js"
import type { EnrollmentId, ProvisionalNodeId } from "./wire-ids.js"
import { constantTimeEqual, sha256Digest } from "./crypto.js"

/**
 * One-time enrollment codes.
 *
 * A code is a bearer secret with a short life and exactly one use, minted over
 * an already-authenticated local/admin flow and presented to the controller as
 * its SHA-256. Three properties carry the whole design, and each one has a
 * defect it prevents:
 *
 *   1. **The raw code never crosses the mesh.** Only `enrollmentCodeHash` does,
 *      which is what the wire record in §4.1 already says. A code that appeared
 *      in cleartext on a mesh segment would be a credential for a credential
 *      store, and a captured enrollment request would be replayable forever
 *      against any mesh whose controller ever accepted it.
 *   2. **Comparison is constant-time and reason-free.** {@link verifyEnrollmentCode}
 *      returns ONE outcome, `codeRejected`, whatever failed. "Unknown",
 *      "expired" and "already used" are distinguished internally and reported to
 *      the audit sink, but they are not distinguishable on the wire. An
 *      enrollment endpoint that tells a prober "that code exists but is
 *      expired" is a code-existence oracle, and since codes are what a
 *      legitimate-but-stale node is holding, that oracle is exactly the one an
 *      attacker with a stolen code dump would use to learn which codes are still
 *      worth trying.
 *   3. **Single-use is a store-level atomic transition**, not a read followed by
 *      a write. See {@link EnrollmentCodeStore.consume}.
 *
 * The store is an interface rather than a class so the controller can put codes
 * in whatever it already uses for durable state, and so the test can substitute
 * one that demonstrates the race (two concurrent verifies of the same code) with
 * no timing dependency.
 */

/** How long a freshly issued code is valid, unless the caller overrides it. */
export const DEFAULT_ENROLLMENT_CODE_TTL_MS = 10 * 60_000

/**
 * Upper bound on a code's lifetime.
 *
 * A code is a standing credential for the whole of its life — anyone holding it
 * can enroll a node they control — so the question is not "is the code long
 * enough to be usable" but "how long does a code nobody has used stay
 * redeemable". A day is comfortably longer than an operator's enrolment window
 * and short enough that a code pasted into the wrong channel is dead before
 * anyone thinks to abuse it. A caller asking for more is refused rather than
 * granted, because the "temporarily" argument is how a permanent code happens.
 */
export const MAX_ENROLLMENT_CODE_TTL_MS = 24 * 60 * 60_000

/**
 * Bytes of entropy in a code.
 *
 * 32 bytes, not 8. A short numeric code is the shape humans are used to, and
 * humans are also the reason short codes are enumerable: the endpoint is on a
 * Tailscale mesh, not behind a rate limiter, so a 6-digit code is a
 * 10^6-search problem against a machine that does a million SHA-256 per second.
 * 32 random bytes of base64url is one line to copy and not a search.
 */
export const ENROLLMENT_CODE_BYTES = 32

/** How a code is spelled on the wire and in the audit log. Never the raw code. */
export type EnrollmentCodeHash = string

export interface IssuedEnrollmentCode {
  readonly enrollmentId: EnrollmentId
  readonly meshId: MeshId
  /**
   * The code itself, returned to the CALLER of `issueEnrollmentCode` and to
   * nobody else. It is deliberately not a member of the stored record: a store
   * that can read the code back can log it, and a store that cannot read it
   * cannot leak it. Only its digest is persisted.
   */
  readonly code: string
  readonly codeHash: EnrollmentCodeHash
  readonly issuedAt: number
  readonly expiresAt: number
  readonly issuedBy: string
  /**
   * When present, the code may only enroll a node claiming this provisional id.
   * Bound at issue time so an operator can name the machine they are enrolling,
   * which stops a code intercepted in transit from minting a differently-named
   * node.
   */
  readonly boundProvisionalNodeId?: ProvisionalNodeId
}

/** The persisted half. The raw code is not in it and cannot be recovered from it. */
export interface StoredEnrollmentCode {
  readonly enrollmentId: EnrollmentId
  readonly meshId: MeshId
  readonly codeHash: EnrollmentCodeHash
  readonly issuedAt: number
  readonly expiresAt: number
  readonly issuedBy: string
  readonly boundProvisionalNodeId?: ProvisionalNodeId
  /**
   * The `nodeId` this code redeemed, set by `consume` and never cleared.
   *
   * This is what makes a RETRY converge instead of erroring. At-least-once
   * delivery means the joining node will resend its enrollment request when the
   * response is lost; a code that had been consumed must answer that second
   * request with the SAME `nodeId` it answered the first, or the node ends up
   * enrolled twice under two identities and neither is the one it holds a key
   * for. The mesh has no reconciliation for enrollment (there is no session to
   * reconcile), so convergence has to live here.
   */
  readonly redeemedNodeId?: NodeId
  /** The key the code was redeemed WITH, for the same convergence reason. */
  readonly redeemedPublicKey?: string
}

export interface IssueEnrollmentCodeInput {
  readonly meshId: MeshId
  /** Who minted it, for the audit log: an operator id, never a credential. */
  readonly issuedBy: string
  readonly now: number
  readonly ttlMs?: number
  readonly boundProvisionalNodeId?: ProvisionalNodeId
  /** Injectable so a test can pin the code and the enrollment id. */
  readonly enrollmentId?: EnrollmentId
  readonly entropy?: () => string
}

export interface VerifyEnrollmentCodeInput {
  readonly meshId: MeshId
  readonly codeHash: EnrollmentCodeHash
  readonly nodePublicKey: string
  readonly provisionalNodeId: ProvisionalNodeId
  readonly now: number
}

/** What a verification failure was, for the audit log ONLY. Never on the wire. */
export type EnrollmentCodeRejection =
  | "code_unknown"
  | "code_expired"
  | "code_already_used"
  | "code_bound_to_another_mesh"
  | "code_bound_to_another_node"
  | "code_provisional_mismatch"

/**
 * The single success type, carrying the audit reason on failure.
 *
 * `Result<VerifiedEnrollmentCode>` on its own would force the failure path to
 * choose between an operator-readable error and an indistinguishable one. This
 * shape answers both: `error` is what crosses the wire, `reason` is what the
 * audit log records. The two are deliberately different fields rather than one
 * error code with a `detail`, because a single field is a single thing a future
 * gateway change starts sending.
 */
export type VerifyEnrollmentCodeResult =
  | { readonly ok: true; readonly value: VerifiedEnrollmentCode }
  | { readonly ok: false; readonly error: ContractError; readonly reason: EnrollmentCodeRejection }

export interface VerifiedEnrollmentCode {
  readonly enrollmentId: EnrollmentId
  readonly meshId: MeshId
  readonly nodeId: NodeId
  /**
   * True when this code had already been redeemed and the request carries the
   * SAME key. A retry, not an attack: the node is told it is enrolled and
   * answers with the identity it already has, instead of a node that cannot
   * tell a lost response from a rejected one and retries forever.
   */
  readonly converged: boolean
}

/** What one `consume` returned. See the interface for why `firstUse` exists. */
export interface EnrollmentCodeRedemption {
  readonly record: StoredEnrollmentCode
  /** True only for the call that actually marked the code spent. */
  readonly firstUse: boolean
}

/**
 * Durable code storage.
 *
 * {@link consume} MUST be a single atomic transition. Splitting it into
 * `get` + `markUsed` is the classic single-use-token race: two enrollments
 * presented concurrently both read "unused" and both succeed, and the second one
 * pins an attacker's key under a code the operator believes was redeemed by
 * their own node. The store owns that atomicity, not this module, because only
 * the store knows what its transaction primitive is.
 */
export interface EnrollmentCodeStore {
  /** Stores a freshly issued code. Overwrites nothing: an id collision is a bug. */
  save(code: StoredEnrollmentCode): Promise<Result<true>>
  /**
   * Atomically redeems the code for `nodeId`/`nodePublicKey`, and reports whether
   * THIS call performed the redemption.
   *
   * `firstUse` is what distinguishes a retry from an attack, and it cannot be
   * derived by the caller from the returned record: the record carries the
   * redemption either way, because on a retry that is exactly what the caller
   * needs in order to answer with the identity the first request got. Reading
   * "was `redeemedNodeId` already set?" instead would make the FIRST redemption
   * look like a retry, and every node would be refused on its first attempt.
   *
   * Returns `null` for a hash the store has never seen. Any other refusal
   * (expired, consumed by a different key, wrong mesh) is signalled by the returned
   * record plus this module's checks, so the store does not need its own error
   * vocabulary.
   */
  consume(input: {
    readonly codeHash: EnrollmentCodeHash
    /**
     * The mesh the code is being redeemed ON.
     *
     * Passed in so the store can refuse to mark a code spent for the wrong mesh
     * WITHOUT the caller having to read the record first. Reading first is how the
     * atomicity is lost again — the mesh check would be outside the transaction
     * and a code could be marked spent by a submission from a mesh it does not
     * belong to. Without this parameter, anyone who can observe a code hash could
     * burn a legitimate node's enrollment by presenting it at the wrong mesh,
     * which is a cross-mesh denial of service bought with a passive observation.
     */
    readonly meshId: MeshId
    readonly nodeId: NodeId
    readonly nodePublicKey: string
    /**
     * The provisional node id being enrolled, so the store can apply a
     * `boundProvisionalNodeId` check WITHOUT burning the code on a mismatch.
     *
     * Passed in for the same reason `meshId` is: a caller that checked the binding
     * after the write would have spent a code an operator deliberately bound to a
     * named machine, on the first submission that named the wrong one. The code is
     * the operator's to re-issue; the binding is the operator's to be obeyed.
     */
    readonly provisionalNodeId: ProvisionalNodeId
    readonly now: number
  }): Promise<Result<EnrollmentCodeRedemption | null>>
}

/**
 * Generates a code. base64url so it survives a copy-paste through any UI.
 *
 * `randomBytes` from `node:crypto`, never `Math.random`. The code is a standing bearer
 * credential for the whole of its life, and `Math.random` is a seeded PRNG whose
 * internal state is recoverable from a handful of outputs — a property an attacker does
 * not need if they are willing to guess.
 *
 * Injectable, because a test that needs to pin the code and the enrollment id has to be
 * able to, and because an injectable source is the only way a future hardware RNG can
 * replace this without the call sites changing.
 */
function generateCode(entropy?: () => string): string {
  return entropy ? entropy() : randomBytes(ENROLLMENT_CODE_BYTES).toString("base64url")
}

/**
 * Mints a code and records it.
 *
 * The caller is an already-authenticated local/admin flow, and that is the whole
 * authorisation story: the code is only as safe as the flow that issued it,
 * which is why there is no `issuedBy` credential here and why the mesh path
 * cannot reach this function.
 */
export async function issueEnrollmentCode(
  input: IssueEnrollmentCodeInput,
  store: EnrollmentCodeStore,
): Promise<Result<IssuedEnrollmentCode>> {
  // A code bound to a mesh id no peer could address is a code nobody can redeem,
  // so the grammar is checked at ISSUE time. Redemption is not the place to find
  // out: by then the operator has already typed the code into a node.
  if (!meshIdSchema.safeParse(input.meshId).success) {
    return refuse("validation", "identity.invalid_mesh_id", "An enrollment code must be bound to a mesh id that satisfies the wire id grammar")
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    return refuse("validation", "identity.invalid_time", `Enrollment code issue time ${input.now} is not a non-negative integer epoch millisecond count`)
  }
  if (input.issuedBy.length === 0 || input.issuedBy.length > 256) {
    return refuse("policy_denied", "identity.issuer_unnamed", "An enrollment code must name who issued it; an unattributable credential is not an admin decision")
  }
  const ttlMs = input.ttlMs ?? DEFAULT_ENROLLMENT_CODE_TTL_MS
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    return refuse("validation", "identity.invalid_ttl", `Enrollment code TTL ${ttlMs}ms must be a positive integer`)
  }
  if (ttlMs > MAX_ENROLLMENT_CODE_TTL_MS) {
    return refuse(
      "policy_denied",
      "identity.code_ttl_too_long",
      `An enrollment code was asked for ${ttlMs}ms of life, over the ${MAX_ENROLLMENT_CODE_TTL_MS}ms bound. A code is a standing credential for its whole life, so its lifetime is a security decision rather than a convenience.`,
    )
  }
  const expiresAt = input.now + ttlMs
  if (!Number.isSafeInteger(expiresAt)) {
    return refuse("validation", "identity.invalid_time", "Enrollment code expiry overflowed the safe integer range")
  }

  const code = generateCode(input.entropy)
  if (code.length === 0) {
    return refuse("internal_failure", "identity.empty_code", "The code generator returned an empty code")
  }
  const codeHash = sha256Digest(code)
  const parsedHash = codeHashSchema.safeParse(codeHash)
  if (!parsedHash.success) {
    return refuse("internal_failure", "identity.code_hash_invalid", "The generated code's digest did not satisfy the wire code-hash shape")
  }
  // Random, not sequential and not derived from the clock: the enrollment id travels
  // on the wire as the envelope's own message id, so a guessable one is a guessable
  // request identity. Injectable above so a test can pin it.
  const enrollmentId = input.enrollmentId ?? enrollmentIdSchema.parse(`enr-${randomBytes(12).toString("hex")}`)

  const saved = await store.save({
    enrollmentId,
    meshId: input.meshId,
    codeHash: parsedHash.data,
    issuedAt: input.now,
    expiresAt,
    issuedBy: input.issuedBy,
    ...(input.boundProvisionalNodeId === undefined ? {} : { boundProvisionalNodeId: input.boundProvisionalNodeId }),
  })
  if (!saved.ok) return saved

  return {
    ok: true,
    value: {
      enrollmentId,
      meshId: input.meshId,
      code,
      codeHash: parsedHash.data,
      issuedAt: input.now,
      expiresAt,
      issuedBy: input.issuedBy,
      ...(input.boundProvisionalNodeId === undefined ? {} : { boundProvisionalNodeId: input.boundProvisionalNodeId }),
    },
  }
}

/**
 * Verifies a code hash, atomically redeems it, and reports ONE outcome.
 *
 * Order is load-bearing and is: shape -> lookup -> mesh binding -> expiry ->
 * single use -> key binding. Each of the first two is a precondition the
 * comparison must not be spent on, and the rest are the checks themselves. The
 * mesh binding is checked BEFORE the expiry so that a code presented at the
 * wrong mesh reports the binding failure internally; externally it is the same
 * refusal either way, and internally the operator needs to be told "that code
 * belongs to another mesh" rather than "that code has expired".
 *
 * The raw code is never an input. A verifier that accepted a raw code would
 * invite a gateway to pass one through, and the raw code is precisely the thing
 * §4.1 says must not cross the mesh a second time.
 */
export async function verifyEnrollmentCode(
  input: VerifyEnrollmentCodeInput,
  store: EnrollmentCodeStore,
): Promise<VerifyEnrollmentCodeResult> {
  const hash = codeHashSchema.safeParse(input.codeHash)
  const provisional = provisionalNodeIdSchema.safeParse(input.provisionalNodeId)
  if (!hash.success || !provisional.success) {
    return rejected("code_unknown")
  }

  const nodeId = nodeIdFor(hash.data)
  const consumed = await store.consume({
    codeHash: hash.data,
    meshId: input.meshId,
    nodeId,
    nodePublicKey: input.nodePublicKey,
    provisionalNodeId: provisional.data,
    now: input.now,
  })
  if (!consumed.ok) {
    // A store that cannot answer is a refusal, not an admission. Treating an
    // unreachable store as "no code found" would be indistinguishable from a
    // legitimate rejection to the caller, and would let anyone who can stall the
    // store stall enrollment entirely. The store's own code is preserved because
    // it is a controller-side fault the operator has to see; it carries no
    // code state, because the store never learned one it did not already have.
    return { ok: false, reason: "code_unknown", error: consumed.error }
  }
  const redemption = consumed.value
  if (redemption === null) return rejected("code_unknown")
  const record = redemption.record

  // Mesh, then the provisional binding, then the ALREADY-REDEEMED case, and only then
  // expiry. All of these are re-checked here even though the store just applied them —
  // this module must not depend on a store's cooperation to make a decision it is the
  // one making — and the order among them IS the convergence argument.
  //
  //   - The mesh binding is checked before anything that can answer, because a code
  //     redeemed at another mesh must never be able to learn the node id it minted.
  //   - The provisional binding is next for the same reason: it is the operator's
  //     statement about which machine this code is for, and answering it to a
  //     submission from a differently-named machine is answering the wrong party.
  //   - A code that has ALREADY been redeemed converges on its own expiry. This is why
  //     expiry is not checked first, and it is the at-least-once case the milestone is
  //     built around: a node whose response was lost in flight retries whenever it
  //     reconnects, and a retry arriving after the TTL must still be told the identity
  //     it already has. Refusing it as "expired" leaves the node unable to tell a lost
  //     response from a rejection, and it retries against an already-spent code
  //     forever. The check is safe because it grants NOTHING NEW — the redemption is
  //     already a fact, the answer is the `nodeId` the first request already received,
  //     and it is given only to a submission presenting the identical key.
  //   - Expiry therefore governs only the FIRST redemption. A code that was never spent
  //     and is now dead is dead, which is what an operator expects of a TTL, and an
  //     expired code is left unspent so the audit log can still tell "expired" from
  //     "redeemed".
  if (record.meshId !== input.meshId) return rejected("code_bound_to_another_mesh")
  if (record.boundProvisionalNodeId !== undefined && record.boundProvisionalNodeId !== provisional.data) {
    return rejected("code_provisional_mismatch")
  }

  if (!redemption.firstUse && record.redeemedNodeId !== undefined) {
    // Already redeemed. A retry converges ONLY on the identical key: a different key on
    // a spent code is a pinning violation, not a retry, because something else already
    // answered with this code and §4.1 requires that the originally submitted key stay
    // pinned. The derived `nodeId` is re-checked alongside the key because this branch
    // hands back a `nodeId` straight from the record, and a store that reported a
    // redemption made against a different hash would otherwise be believed.
    //
    // `firstUse` is the discriminator rather than the presence of `redeemedNodeId`,
    // and the difference is not cosmetic: the store writes the redemption into the
    // record it RETURNS, so on the very first call the record already carries a
    // `redeemedNodeId`. Reading the record instead of the flag makes every node's
    // first enrollment look like a retry, and every node is refused on its first
    // attempt. That is why the flag exists, and why the store's own doc comment says
    // `firstUse` cannot be derived from the returned record.
    //
    // A plain `!==` rather than `constantTimeEqual`, and the difference is deliberate.
    // The KEY is published — it is in this very request and in every `peerKeyPins`
    // entry — so there is no secret left to learn from how long the comparison takes;
    // the secret (the code) was already compared inside the store's hash lookup.
    // Applying a constant-time comparison to a value the attacker supplied would be the
    // appearance of care, not the substance.
    if (record.redeemedNodeId !== nodeId || record.redeemedPublicKey !== input.nodePublicKey) {
      return rejected("code_already_used")
    }
    return {
      ok: true,
      value: {
        enrollmentId: record.enrollmentId,
        meshId: record.meshId,
        nodeId: record.redeemedNodeId,
        converged: true,
      },
    }
  }

  if (input.now >= record.expiresAt) return rejected("code_expired")
  if (!redemption.firstUse) {
    // Not marked spent by this call, yet the record says it was never redeemed. Only a
    // store declining to mark a spent code spent reaches here, and it is refused rather
    // than treated as a retry — a converged retry is the one path here that would let a
    // code be redeemed twice, and a store behaving unexpectedly is not a licence to
    // guess.
    return rejected("code_already_used")
  }

  return {
    ok: true,
    value: { enrollmentId: record.enrollmentId, meshId: record.meshId, nodeId, converged: false },
  }
}

/** How many hex characters of the code digest become the derived node id. */
const DERIVED_NODE_ID_CHARS = 24

/**
 * The `NodeId` a code hash redeems into, or `null` if the hash is not one.
 *
 * The digest contributes entropy, not secrecy — it is 24 hex characters of a
 * value the peer already holds. It is derived rather than random anyway, because
 * the property that matters is DETERMINISM, and a value an attacker cannot
 * influence cannot be raced.
 *
 * Parsed through `nodeIdSchema` rather than cast: the id has to satisfy the same
 * grammar every other node id on the mesh satisfies, and a cast would let a
 * badly-shaped code hash produce an id no peer could address.
 */
export function nodeIdForCodeHash(codeHash: string): NodeId | null {
  const parsed = codeHashSchema.safeParse(codeHash)
  if (!parsed.success) return null
  return nodeIdSchema.parse(`node-enr-${parsed.data.slice("sha256:".length, "sha256:".length + DERIVED_NODE_ID_CHARS)}`)
}

function nodeIdFor(codeHash: EnrollmentCodeHash): NodeId {
  const derived = nodeIdForCodeHash(codeHash)
  // Only reachable when the hash already passed `codeHashSchema` above, so this
  // is a wiring fault rather than a peer problem; it is still a refusal path
  // rather than a throw, because a verifier that can throw past its `Result` is a
  // verifier a gateway has to wrap.
  return derived ?? nodeIdSchema.parse("node-enr-unparseable")
}

/**
 * The one refusal shape.
 *
 * Every failure returns this, with the same `code`, the same `category`, and a
 * message that names no code state. `retryable` is false for all of them: a
 * rejected enrollment is a human decision (mint a new code) or a probe, and a
 * client that retries a refused code in a loop is a resource-exhaustion vector
 * on the controller — the same argument the protocol makes for every other
 * non-retryable refusal in its §5 table.
 */
function rejected(reason: EnrollmentCodeRejection): VerifyEnrollmentCodeResult {
  return {
    ok: false,
    reason,
    error: createContractError(
      "policy_denied",
      "identity.enrollment_code_rejected",
      "The enrollment code was refused. No further detail is returned: whether a code is unknown, expired, already used, or bound elsewhere is exactly the distinction an attacker enumerates for. The reason is recorded in the controller's audit log, which the requester cannot read.",
    ),
  }
}

function refuse(category: Parameters<typeof createContractError>[0], code: string, message: string): { ok: false; error: ContractError } {
  return { ok: false, error: createContractError(category, code, message) }
}

/**
 * The in-memory store, and the reference implementation of what {@link consume}
 * must guarantee.
 *
 * The lookup is a constant-time SCAN over the stored hashes rather than a `Map`
 * hit, and the cost of that choice is stated: enrollment runs a handful of times
 * in a node's life against a store holding a handful of live codes, so a linear
 * scan of a dozen `timingSafeEqual` calls is free, while a `Map` lookup leaks
 * through its access pattern which prefixes of a probe matched. The digest is
 * 256 bits of CSPRNG output, so the leak is not practically exploitable — which
 * is exactly why it is the wrong thing to leave in a module whose entire job is
 * not being the wrong thing.
 *
 * A durable store will use an indexed lookup. It is required to do the same
 * constant-time final comparison, and {@link EnrollmentCodeStore.consume}'s
 * doc comment says so.
 */
export class InMemoryEnrollmentCodeStore implements EnrollmentCodeStore {
  readonly #codes = new Map<EnrollmentCodeHash, StoredEnrollmentCode>()
  #redeemCount = 0
  #comparisonCount = 0

  async save(code: StoredEnrollmentCode): Promise<Result<true>> {
    if (this.find(code.codeHash) !== undefined) {
      return refuse("conflict", "identity.enrollment_code_collision", "An enrollment code with this hash already exists; a collision on 32 bytes of entropy is a bug, not a retry")
    }
    this.#codes.set(code.codeHash, { ...code })
    return { ok: true, value: true }
  }

  /** Constant-time lookup: every stored hash is compared, and the match is only decided at the end. */
  #findByHash(codeHash: EnrollmentCodeHash): StoredEnrollmentCode | undefined {
    let found: StoredEnrollmentCode | undefined
    for (const candidate of this.#codes.values()) {
      this.#comparisonCount += 1
      if (constantTimeEqual(candidate.codeHash, codeHash)) found = candidate
    }
    return found
  }

  find(codeHash: EnrollmentCodeHash): StoredEnrollmentCode | undefined {
    return this.#findByHash(codeHash)
  }

  /**
   * Synchronous body inside an async method ON PURPOSE: the single-use check and
   * the redemption write are the same turn of the event loop, so two concurrent
   * verifications of one code cannot interleave between them. An `await` between
   * the read and the write would reintroduce exactly the race this method is
   * written to close.
   *
   * Expiry is checked here and NOT by the caller, for the same reason the mesh
   * binding is: an expired code must not be MARKED SPENT by a submission that was
   * going to be refused anyway, and a caller that checked expiry after the write
   * would have already burned a record an operator is still trying to use. A code
   * that is refused for being expired is left exactly as it was — dead, but not
   * consumed, so the audit log can still tell "expired" from "redeemed".
   */
  async consume(input: {
    readonly codeHash: EnrollmentCodeHash
    readonly meshId: MeshId
    readonly nodeId: NodeId
    readonly nodePublicKey: string
    readonly provisionalNodeId: ProvisionalNodeId
    readonly now: number
  }): Promise<Result<EnrollmentCodeRedemption | null>> {
    this.#redeemCount += 1
    const existing = this.#findByHash(input.codeHash)
    if (existing === undefined) return { ok: true, value: null }
    // None of these three burns the code, and the record is returned so the caller
    // can report the SPECIFIC refusal to the audit log — which is the whole reason
    // they are inside the store rather than left to the caller.
    if (existing.meshId !== input.meshId) return { ok: true, value: { record: existing, firstUse: false } }
    if (input.now >= existing.expiresAt) return { ok: true, value: { record: existing, firstUse: false } }
    if (existing.boundProvisionalNodeId !== undefined && existing.boundProvisionalNodeId !== input.provisionalNodeId) {
      return { ok: true, value: { record: existing, firstUse: false } }
    }
    if (existing.redeemedNodeId !== undefined) return { ok: true, value: { record: existing, firstUse: false } }
    const redeemed: StoredEnrollmentCode = {
      ...existing,
      redeemedNodeId: input.nodeId,
      redeemedPublicKey: input.nodePublicKey,
    }
    this.#codes.set(input.codeHash, redeemed)
    return { ok: true, value: { record: redeemed, firstUse: true } }
  }

  /** How many times `consume` was entered, so a test can prove the check ran. */
  get redemptions(): number {
    return this.#redeemCount
  }

  /**
   * How many hash comparisons the store performed.
   *
   * A test asserts that an unknown hash costs the same NUMBER of comparisons as a
   * known one. That is the observable half of constant time, and it is the half
   * that a future "optimisation" to a `Map` would break.
   */
  get comparisons(): number {
    return this.#comparisonCount
  }

  get size(): number {
    return this.#codes.size
  }
}

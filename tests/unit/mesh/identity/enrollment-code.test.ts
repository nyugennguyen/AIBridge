import { describe, expect, it } from "vitest"
import {
  DEFAULT_ENROLLMENT_CODE_TTL_MS,
  ENROLLMENT_CODE_BYTES,
  InMemoryEnrollmentCodeStore,
  MAX_ENROLLMENT_CODE_TTL_MS,
  issueEnrollmentCode,
  nodeIdForCodeHash,
  verifyEnrollmentCode,
  type EnrollmentCodeStore,
} from "../../../../src/mesh/identity/enrollment-code.js"
import { wireRejectionReasonFor } from "../../../../src/mesh/identity/enrollment.js"
import { sha256Digest } from "../../../../src/mesh/identity/crypto.js"
import type { MeshId } from "../../../../src/orchestration/identifiers.js"
import type { ProvisionalNodeId } from "../../../../src/mesh/identity/wire-ids.js"
import { MESH_ID, OTHER_MESH_ID, PROVISIONAL_ID, at, provisional } from "./fixtures.js"

async function issue(overrides: Partial<Parameters<typeof issueEnrollmentCode>[0]> = {}, store = new InMemoryEnrollmentCodeStore()) {
  const result = await issueEnrollmentCode(
    { meshId: MESH_ID, issuedBy: "user-1", now: at(0), ...overrides },
    store,
  )
  if (!result.ok) throw new Error(result.error.message)
  return { issued: result.value, store }
}

describe("issueEnrollmentCode", () => {
  it("issues a code whose digest is what crosses the wire, and never the code itself", async () => {
    const { issued, store } = await issue()

    expect(issued.code).toHaveLength(43) // 32 bytes of base64url, unpadded
    expect(issued.codeHash).toBe(sha256Digest(issued.code).toString())
    // The stored record is the DIGEST. A store that could read the code back could
    // log it, and a store that cannot cannot leak it.
    expect(store.find(issued.codeHash)).toBeDefined()
    expect(JSON.stringify(store.find(issued.codeHash))).not.toContain(issued.code)
  })

  it("uses 32 bytes of entropy, so the code is not a short numeric PIN to search", async () => {
    expect(ENROLLMENT_CODE_BYTES).toBe(32)
    const codes = new Set<string>()
    for (let index = 0; index < 64; index += 1) codes.add((await issue()).issued.code)
    // A 6-digit code is a 10^6-search problem against a machine doing a million
    // SHA-256 a second, and this endpoint is not behind a rate limiter.
    expect(codes.size).toBe(64)
  })

  it("binds the code to exactly one mesh", async () => {
    const { issued } = await issue()

    const onOtherMesh = await verifyEnrollmentCode(
      { meshId: OTHER_MESH_ID, codeHash: issued.codeHash, nodePublicKey: "AAAA", provisionalNodeId: PROVISIONAL_ID, now: at(1) },
      new InMemoryEnrollmentCodeStore(),
    )
    expect(onOtherMesh.ok).toBe(false)
  })

  it("refuses a TTL over the bound rather than granting a standing credential", async () => {
    const over = await issueEnrollmentCode(
      { meshId: MESH_ID, issuedBy: "user-1", now: at(0), ttlMs: MAX_ENROLLMENT_CODE_TTL_MS + 1 },
      new InMemoryEnrollmentCodeStore(),
    )
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error.code).toBe("identity.code_ttl_too_long")
  })

  it("refuses an unattributable issue", async () => {
    const anonymous = await issueEnrollmentCode(
      { meshId: MESH_ID, issuedBy: "", now: at(0) },
      new InMemoryEnrollmentCodeStore(),
    )
    expect(anonymous.ok).toBe(false)
    if (!anonymous.ok) expect(anonymous.error.code).toBe("identity.issuer_unnamed")
  })

  it("refuses a mesh id that satisfies no wire grammar, at ISSUE time", async () => {
    // The cast IS the assertion: the input is well-typed at the call site and
    // grammatically wrong at runtime, which is exactly the state an unvalidated
    // `meshId` arrives in from a config file or a database row.
    const bad = await issueEnrollmentCode(
      { meshId: "not a wire id" as MeshId, issuedBy: "user-1", now: at(0) },
      new InMemoryEnrollmentCodeStore(),
    )
    // Redemption is the wrong place to find this out: by then an operator has
    // already typed a code into a node that can never use it.
    expect(bad.ok).toBe(false)
  })
})

describe("verifyEnrollmentCode", () => {
  it("accepts a live code once and marks it spent atomically", async () => {
    const { issued, store } = await issue()
    const before = store.redemptions

    const first = await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: issued.codeHash, nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(1) },
      store,
    )
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.value.converged).toBe(false)
      expect(first.value.enrollmentId).toBe(issued.enrollmentId)
    }
    expect(store.redemptions).toBeGreaterThan(before)
  })

  it("refuses a second redemption with a DIFFERENT key as a pinning violation", async () => {
    const { issued, store } = await issue()
    const request = (nodePublicKey: string) => ({
      meshId: MESH_ID,
      codeHash: issued.codeHash,
      nodePublicKey,
      provisionalNodeId: PROVISIONAL_ID,
      now: at(1),
    })

    expect((await verifyEnrollmentCode(request("key-1"), store)).ok).toBe(true)
    const second = await verifyEnrollmentCode(request("key-2"), store)

    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe("code_already_used")
  })

  it("CONVERGES on a retry of the same code and key rather than erroring", async () => {
    const { issued, store } = await issue()
    const request = { meshId: MESH_ID, codeHash: issued.codeHash, nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(1) }

    const first = await verifyEnrollmentCode(request, store)
    const retry = await verifyEnrollmentCode({ ...request, now: at(2) }, store)

    // This is the at-least-once case. A response lost in flight must not leave the
    // node unable to tell "my response was lost" from "I was rejected", because the
    // second reading makes it retry forever against a code it has already spent.
    expect(retry.ok).toBe(true)
    if (retry.ok && first.ok) {
      expect(retry.value.converged).toBe(true)
      expect(retry.value.nodeId).toBe(first.value.nodeId)
      expect(retry.value.enrollmentId).toBe(first.value.enrollmentId)
    }
  })

  it("CONVERGES on a retry that arrives AFTER the code expired, because the retry is the point", async () => {
    const store = new InMemoryEnrollmentCodeStore()
    const { issued } = await issue({ ttlMs: 60_000 }, store)
    const request = { meshId: MESH_ID, codeHash: issued.codeHash, nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(1) }

    const first = await verifyEnrollmentCode(request, store)
    // The response is lost in flight. The node reconnects an hour later, long past the
    // ten-minute window, and retries the only thing it has.
    const late = await verifyEnrollmentCode({ ...request, now: at(3_600) }, store)

    // Expiry governs the FIRST redemption, not the answer to a second one. Refusing
    // this as "expired" is the failure that matters: the node cannot tell a lost
    // response from a rejection, so it retries against a code it has already spent,
    // forever, and the at-least-once delivery the milestone is built around becomes the
    // thing that strands the node. Safe because it grants nothing new — the answer is
    // the identity the first request already produced, given only to a submission
    // carrying the identical key.
    expect(late.ok).toBe(true)
    if (late.ok && first.ok) {
      expect(late.value.converged).toBe(true)
      expect(late.value.nodeId).toBe(first.value.nodeId)
    }
  })

  it("still refuses a DIFFERENT key on an expired-and-spent code", async () => {
    const store = new InMemoryEnrollmentCodeStore()
    const { issued } = await issue({ ttlMs: 60_000 }, store)
    const base = { meshId: MESH_ID, codeHash: issued.codeHash, nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(1) }
    await verifyEnrollmentCode(base, store)

    // Convergence is scoped to the identical key. An attacker who intercepted the code
    // presents it after expiry with THEIR key and must not be handed the node id the
    // legitimate node already owns.
    const stolen = await verifyEnrollmentCode({ ...base, nodePublicKey: "key-2", now: at(3_600) }, store)
    expect(stolen.ok).toBe(false)
    if (!stolen.ok) expect(stolen.reason).toBe("code_already_used")
  })

  it("refuses a code past its expiry and does not burn it", async () => {
    const store = new InMemoryEnrollmentCodeStore()
    const { issued } = await issue({ ttlMs: 60_000 }, store)

    const expired = await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: issued.codeHash, nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(120) },
      store,
    )
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.reason).toBe("code_expired")

    // A refused-for-expiry code is left unspent so the audit log can still tell
    // "expired" from "redeemed" — an operator reading a spent code cannot tell
    // whether anyone got in.
    expect(store.find(issued.codeHash)?.redeemedNodeId).toBeUndefined()
  })

  it("refuses a code at the wrong mesh without burning it", async () => {
    const store = new InMemoryEnrollmentCodeStore()
    const { issued } = await issue({}, store)

    const wrongMesh = await verifyEnrollmentCode(
      { meshId: OTHER_MESH_ID, codeHash: issued.codeHash, nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(1) },
      store,
    )
    expect(wrongMesh.ok).toBe(false)

    // Anyone who can observe a code hash could otherwise permanently burn a
    // legitimate node's enrollment by presenting it at the wrong mesh.
    const legitimate = await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: issued.codeHash, nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(1) },
      store,
    )
    expect(legitimate.ok).toBe(true)
  })

  it("refuses a code bound to one provisional id when a different one claims it", async () => {
    const store = new InMemoryEnrollmentCodeStore()
    const { issued } = await issue({ boundProvisionalNodeId: provisional("worker-7") }, store)

    const wrong = await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: issued.codeHash, nodePublicKey: "key-1", provisionalNodeId: provisional("worker-9"), now: at(1) },
      store,
    )
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.reason).toBe("code_provisional_mismatch")

    const right = await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: issued.codeHash, nodePublicKey: "key-1", provisionalNodeId: provisional("worker-7"), now: at(1) },
      store,
    )
    expect(right.ok).toBe(true)
  })

  it("refuses an unknown code hash", async () => {
    const result = await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: sha256Digest("never issued").toString(), nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(1) },
      new InMemoryEnrollmentCodeStore(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("code_unknown")
  })

  it("refuses a malformed code hash and a malformed provisional id without consulting the store", async () => {
    const consulted: string[] = []
    const spy: EnrollmentCodeStore = {
      save: async () => ({ ok: true, value: true }),
      consume: async (input) => {
        consulted.push(input.codeHash)
        return { ok: true, value: null }
      },
    }

    const badHash = await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: "not-a-digest", nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(1) },
      spy,
    )
    const badProvisional = await verifyEnrollmentCode(
      // The cast IS the assertion: an empty string is a well-typed `ProvisionalNodeId`
      // that fails the wire grammar, which is the state a node sends when it has not
      // filled in a display name.
      { meshId: MESH_ID, codeHash: sha256Digest("x").toString(), nodePublicKey: "key-1", provisionalNodeId: "" as ProvisionalNodeId, now: at(1) },
      spy,
    )

    expect(badHash.ok).toBe(false)
    expect(badProvisional.ok).toBe(false)
    expect(consulted).toEqual([])
  })

  it("is INDISTINGUISHABLE: unknown, expired and already-used produce identical output", async () => {
    const unknownStore = new InMemoryEnrollmentCodeStore()
    const unknown = await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: sha256Digest("nope").toString(), nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(1) },
      unknownStore,
    )

    const expiring = new InMemoryEnrollmentCodeStore()
    const expiringIssued = await issue({ ttlMs: 60_000 }, expiring)
    const expired = await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: expiringIssued.issued.codeHash, nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(120) },
      expiring,
    )

    const spending = new InMemoryEnrollmentCodeStore()
    const spendingIssued = await issue({}, spending)
    await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: spendingIssued.issued.codeHash, nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(1) },
      spending,
    )
    const reused = await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: spendingIssued.issued.codeHash, nodePublicKey: "key-2", provisionalNodeId: PROVISIONAL_ID, now: at(1) },
      spending,
    )

    expect(unknown.ok && expired.ok && reused.ok).toBe(false)
    if (unknown.ok || expired.ok || reused.ok) return
    // The CONTRACT ERROR is byte-identical across all three. This is the property
    // that makes the endpoint non-enumerable: a prober that can tell "expired" from
    // "unknown" learns which codes an operator has issued and already spent.
    expect(unknown.error).toEqual(expired.error)
    expect(unknown.error).toEqual(reused.error)
    expect(unknown.error.code).toBe("identity.enrollment_code_rejected")
    // The internal reasons still differ, because the operator's audit log has to be
    // able to say which.
    expect(new Set([unknown.reason, expired.reason, reused.reason]).size).toBe(3)
  })

  it("maps every code-state reason onto one wire rejection, and keeps key_mismatch distinct", () => {
    // The protocol's ENROLLMENT_REJECTION_REASONS distinguishes code_expired and
    // code_already_used from code_unknown. This module does not, because a peer
    // that can tell them apart can enumerate the operator's code ledger.
    expect(wireRejectionReasonFor("code_unknown")).toBe("code_unknown")
    expect(wireRejectionReasonFor("code_expired")).toBe("code_unknown")
    expect(wireRejectionReasonFor("code_already_used")).toBe("code_unknown")
    expect(wireRejectionReasonFor("code_bound_to_another_mesh")).toBe("code_unknown")
    expect(wireRejectionReasonFor("code_provisional_mismatch")).toBe("code_unknown")
    // A pin violation is disclosed: the peer just supplied the key, so telling it
    // the key is not the pinned one adds nothing it did not already know.
    expect(wireRejectionReasonFor("pin_key_mismatch")).toBe("key_mismatch")
    expect(wireRejectionReasonFor("pin_key_id_unknown")).toBe("key_mismatch")
    // An unmapped internal reason narrows to the LEAST informative value.
    expect(wireRejectionReasonFor("some_future_reason")).toBe("code_unknown")
  })

  it("compares code hashes in constant time, and an unknown hash costs the same work as a known one", async () => {
    const store = new InMemoryEnrollmentCodeStore()
    const { issued } = await issue({}, store)

    const beforeKnown = store.comparisons
    await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: issued.codeHash, nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(1) },
      store,
    )
    const knownCost = store.comparisons - beforeKnown

    const beforeUnknown = store.comparisons
    await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: sha256Digest("not-a-real-code").toString(), nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(1) },
      store,
    )
    const unknownCost = store.comparisons - beforeUnknown

    // The observable half of constant time. The other half is `timingSafeEqual`
    // inside `constantTimeEqual`; a future "optimisation" to a Map lookup would
    // break exactly this, which is why the store keeps a comparison counter.
    expect(unknownCost).toBe(knownCost)
  })

  it("refuses when the store cannot answer, rather than reading that as no code found", async () => {
    const broken: EnrollmentCodeStore = {
      save: async () => ({ ok: true, value: true }),
      consume: async () => ({
        ok: false,
        error: {
          schemaVersion: 1,
          category: "internal_failure",
          code: "identity.code_store_down",
          message: "the code store is unavailable",
          retryable: false,
        },
      }),
    }

    const result = await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: sha256Digest("x").toString(), nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(1) },
      broken,
    )

    // "Unreachable" reading as "absent" would be indistinguishable from a
    // legitimate rejection, and would let anyone who can stall the store stall
    // enrollment entirely.
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("identity.code_store_down")
  })

  it("derives a nodeId from the code hash, so a retry resolves to the same identity", async () => {
    const { issued, store } = await issue()
    const request = { meshId: MESH_ID, codeHash: issued.codeHash, nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(1) }

    const first = await verifyEnrollmentCode(request, store)
    const retry = await verifyEnrollmentCode(request, store)

    if (first.ok && retry.ok) expect(retry.value.nodeId).toBe(first.value.nodeId)
    expect(nodeIdForCodeHash(issued.codeHash)).toBe(first.ok ? first.value.nodeId : null)
    expect(nodeIdForCodeHash("not-a-digest")).toBeNull()
  })

  it("never puts the raw code in a refusal, and never marks a refusal retryable", async () => {
    const { issued } = await issue({ ttlMs: 1_000 })
    const expired = await verifyEnrollmentCode(
      { meshId: MESH_ID, codeHash: issued.codeHash, nodePublicKey: "key-1", provisionalNodeId: PROVISIONAL_ID, now: at(60) },
      new InMemoryEnrollmentCodeStore(),
    )

    if (expired.ok) throw new Error("expected a refusal")
    expect(expired.error.message).not.toContain(issued.code)
    // A client that retries a refused code in a loop is a resource-exhaustion
    // vector on the controller.
    expect(expired.error.retryable).toBe(false)
  })

  it("defaults to a ten-minute lifetime", () => {
    expect(DEFAULT_ENROLLMENT_CODE_TTL_MS).toBe(10 * 60_000)
    expect(MAX_ENROLLMENT_CODE_TTL_MS).toBe(24 * 60 * 60_000)
  })
})

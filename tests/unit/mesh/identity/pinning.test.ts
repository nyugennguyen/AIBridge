import { describe, expect, it } from "vitest"
import { createContractError, type Result } from "../../../../src/orchestration/errors.js"
import {
  InMemoryPeerKeyPinStore,
  resolvePinnedKey,
  verifyPinnedKey,
  type PeerKeyPin,
  type PeerKeyPinStore,
  type PinNodeKeyInput,
  type RotateNodeKeyInput,
} from "../../../../src/mesh/identity/peer-key-pins.js"
import { InMemoryEnrollmentCodeStore, issueEnrollmentCode, verifyEnrollmentCode } from "../../../../src/mesh/identity/enrollment-code.js"
import { buildEnrollmentRequest, decideEnrollment } from "../../../../src/mesh/identity/enrollment.js"
import { InMemoryNodeTrustStore } from "../../../../src/mesh/identity/node-trust.js"
import { NodeKeyPair, publicNodeKeyOf } from "../../../../src/mesh/identity/node-key.js"
import { nodeKeyIdSchema } from "../../../../src/mesh/identity/wire-ids.js"
import { MESH_ID, OTHER_MESH_ID, PENDING_SENDER_ID, PROVISIONAL_ID, STRANGER_ID, WORKER_ID, at } from "./fixtures.js"

function pinInput(keyPair: NodeKeyPair, nodeId = WORKER_ID) {
  return {
    nodeId,
    meshId: MESH_ID,
    key: publicNodeKeyOf(keyPair),
    enrollmentId: "enr-1",
    now: at(1),
  }
}

describe("PeerKeyPinStore.pin", () => {
  it("pins the exact key submitted on an accepted enrollment", async () => {
    const store = new InMemoryPeerKeyPinStore()
    const keyPair = NodeKeyPair.generate()

    const pinned = await store.pin(pinInput(keyPair))
    expect(pinned.ok).toBe(true)
    if (!pinned.ok) return
    expect(pinned.value.publicKey).toBe(keyPair.publicKey)
    expect(pinned.value.nodeKeyId).toBe(keyPair.keyId)
    expect(pinned.value.fingerprint).toBe(keyPair.fingerprint)
    expect(pinned.value.generation).toBe(1)
  })

  it("refuses a second pin for a live node rather than choosing between the two", async () => {
    const store = new InMemoryPeerKeyPinStore()
    await store.pin(pinInput(NodeKeyPair.generate()))

    const second = await store.pin(pinInput(NodeKeyPair.generate()))

    // A second enrollment both believing they were first means every read path has
    // to decide which key wins, and the loser is a pin somebody controls. Refusing
    // is what keeps "one key per node" a property rather than a convention.
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe("identity.already_pinned")
  })

  it("refuses a pin for a different mesh without disturbing the existing one", async () => {
    const store = new InMemoryPeerKeyPinStore()
    const first = NodeKeyPair.generate()
    await store.pin(pinInput(first))

    const other = await store.pin({ ...pinInput(NodeKeyPair.generate()), meshId: OTHER_MESH_ID })
    expect(other.ok).toBe(false)
    const current = await store.current(WORKER_ID)
    expect(current.ok && current.value?.nodeKeyId).toBe(first.keyId)
  })
})

describe("resolvePinnedKey", () => {
  it("resolves the pinned key by nodeKeyId", async () => {
    const store = new InMemoryPeerKeyPinStore()
    const keyPair = NodeKeyPair.generate()
    await store.pin(pinInput(keyPair))

    const resolved = await resolvePinnedKey(store, { nodeId: WORKER_ID, meshId: MESH_ID, nodeKeyId: keyPair.keyId })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.value.publicKey).toBe(keyPair.publicKey)
  })

  it("refuses a node with no pin at all", async () => {
    const resolved = await resolvePinnedKey(new InMemoryPeerKeyPinStore(), {
      nodeId: WORKER_ID,
      meshId: MESH_ID,
      nodeKeyId: nodeKeyIdSchema.parse("key-0000000000000000"),
    })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) {
      expect(resolved.reason).toBe("pin_missing")
      expect(resolved.error.code).toBe("identity.key_not_pinned")
    }
  })

  it("refuses a keyId that is not the pinned one, and does not treat it as an alternative", async () => {
    const store = new InMemoryPeerKeyPinStore()
    await store.pin(pinInput(NodeKeyPair.generate()))

    const resolved = await resolvePinnedKey(store, {
      nodeId: WORKER_ID,
      meshId: MESH_ID,
      nodeKeyId: nodeKeyIdSchema.parse("key-0000000000000000"),
    })

    // Accepting an unknown key id as "also fine" is how a rotated key stays trusted
    // by accident: the node has two keys and only one of them was ever reviewed.
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.reason).toBe("pin_key_id_unknown")
  })

  it("refuses a pin presented from another mesh", async () => {
    const store = new InMemoryPeerKeyPinStore()
    const keyPair = NodeKeyPair.generate()
    await store.pin(pinInput(keyPair))

    const resolved = await resolvePinnedKey(store, { nodeId: WORKER_ID, meshId: OTHER_MESH_ID, nodeKeyId: keyPair.keyId })

    // A key pinned in one mesh is not a credential in another. Collapsing the two
    // would make every mesh's node list a single flat namespace, so one controller's
    // enrollment list would authenticate to another's.
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.reason).toBe("pin_mesh_mismatch")
  })

  it("refuses when the store cannot answer", async () => {
    // Typed against the interface, and every unreachable method carries an explicit
    // `Result<…>` return type. An unannotated arrow returns `{ ok: boolean }` rather
    // than a discriminated `Result`, which is precisely the widening that turns a
    // fail-closed `if (!x.ok)` into a check that cannot narrow.
    const broken: PeerKeyPinStore = {
      pin: async (): Promise<Result<PeerKeyPin>> => {
        throw new Error("the pin path is not exercised by this test")
      },
      current: async (): Promise<Result<PeerKeyPin | null>> => ({
        ok: false,
        error: createContractError("internal_failure", "identity.pin_store_down", "down"),
      }),
      rotate: async (): Promise<Result<PeerKeyPin>> => {
        throw new Error("the rotate path is not exercised by this test")
      },
      revoke: async (): Promise<Result<true>> => ({ ok: true, value: true }),
    }

    const resolved = await resolvePinnedKey(broken, { nodeId: WORKER_ID, meshId: MESH_ID, nodeKeyId: nodeKeyIdSchema.parse("key-1") })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.reason).toBe("pin_store_failure")
  })
})

describe("verifyPinnedKey", () => {
  it("refuses a key whose id does not match its bytes", async () => {
    const store = new InMemoryPeerKeyPinStore()
    const pinned = NodeKeyPair.generate()
    await store.pin(pinInput(pinned))
    const impostor = NodeKeyPair.generate()

    const result = await verifyPinnedKey(store, {
      nodeId: WORKER_ID,
      meshId: MESH_ID,
      key: { nodeKeyId: pinned.keyId, publicKey: impostor.publicKey, fingerprint: impostor.fingerprint },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("pin_key_mismatch")
  })

  it("refuses a key presented for a different node", async () => {
    const store = new InMemoryPeerKeyPinStore()
    const keyPair = NodeKeyPair.generate()
    await store.pin(pinInput(keyPair))

    const result = await verifyPinnedKey(store, {
      nodeId: STRANGER_ID,
      meshId: MESH_ID,
      key: publicNodeKeyOf(keyPair),
    })

    expect(result.ok).toBe(false)
  })
})

describe("PeerKeyPinStore.rotate", () => {
  it("produces a new keyId and invalidates the old key immediately", async () => {
    const store = new InMemoryPeerKeyPinStore()
    const old = NodeKeyPair.generate()
    await store.pin(pinInput(old))

    const fresh = NodeKeyPair.generate()
    const rotated = await store.rotate({
      nodeId: WORKER_ID,
      meshId: MESH_ID,
      key: publicNodeKeyOf(fresh),
      enrollmentId: "enr-2",
      now: at(10),
      by: "user-1",
      reason: "suspected compromise",
    })

    expect(rotated.ok).toBe(true)
    if (!rotated.ok) return
    expect(rotated.value.nodeKeyId).toBe(fresh.keyId)
    expect(rotated.value.generation).toBe(2)

    // The old key stops working NOW, with nothing to expire and nothing to clean up.
    const withOld = await resolvePinnedKey(store, { nodeId: WORKER_ID, meshId: MESH_ID, nodeKeyId: old.keyId })
    expect(withOld.ok).toBe(false)

    const withNew = await resolvePinnedKey(store, { nodeId: WORKER_ID, meshId: MESH_ID, nodeKeyId: fresh.keyId })
    expect(withNew.ok).toBe(true)
  })

  it("leaves no reachable trace of the superseded key", async () => {
    const store = new InMemoryPeerKeyPinStore()
    const old = NodeKeyPair.generate()
    await store.pin(pinInput(old))
    await store.rotate({
      nodeId: WORKER_ID,
      meshId: MESH_ID,
      key: publicNodeKeyOf(NodeKeyPair.generate()),
      enrollmentId: "enr-2",
      now: at(10),
      by: "user-1",
      reason: "routine",
    })

    const current = await store.current(WORKER_ID)
    expect(JSON.stringify(current)).not.toContain(old.publicKey)
  })

  it("requires a fresh key: rotating to the key already pinned is refused", async () => {
    const store = new InMemoryPeerKeyPinStore()
    const keyPair = NodeKeyPair.generate()
    await store.pin(pinInput(keyPair))

    const same = await store.rotate({
      nodeId: WORKER_ID,
      meshId: MESH_ID,
      key: publicNodeKeyOf(keyPair),
      enrollmentId: "enr-2",
      now: at(10),
      by: "user-1",
      reason: "routine",
    })

    // A rotation that changes nothing still consumes the authorization it was
    // performed under, so it is refused rather than accepted as a no-op that looks
    // like a change in the audit log.
    expect(same.ok).toBe(false)
    if (!same.ok) expect(same.error.code).toBe("identity.rotate_same_key")
  })

  it("refuses a rotation of an unpinned node, so rotation cannot create trust", async () => {
    const store = new InMemoryPeerKeyPinStore()
    const result = await store.rotate({
      nodeId: WORKER_ID,
      meshId: MESH_ID,
      key: publicNodeKeyOf(NodeKeyPair.generate()),
      enrollmentId: "enr-1",
      now: at(1),
      by: "user-1",
      reason: "first contact",
    })

    // `pin` succeeds where `rotate` refuses, deliberately: a key change that creates
    // a new trust record is enrollment, and it goes through enrollment.
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("identity.rotate_unpinned")
  })

  it("refuses an unattributed or unmotivated rotation", async () => {
    const store = new InMemoryPeerKeyPinStore()
    await store.pin(pinInput(NodeKeyPair.generate()))
    const key = publicNodeKeyOf(NodeKeyPair.generate())

    const anonymous = await store.rotate({ nodeId: WORKER_ID, meshId: MESH_ID, key, enrollmentId: "enr-2", now: at(10), by: "", reason: "x" })
    const unreasoned = await store.rotate({ nodeId: WORKER_ID, meshId: MESH_ID, key, enrollmentId: "enr-2", now: at(10), by: "user-1", reason: "" })

    expect(anonymous.ok).toBe(false)
    if (!anonymous.ok) expect(anonymous.error.code).toBe("identity.rotation_unattributed")
    expect(unreasoned.ok).toBe(false)
    if (!unreasoned.ok) expect(unreasoned.error.code).toBe("identity.rotation_unmotivated")
  })

  it("refuses a rotation from the wrong mesh", async () => {
    const store = new InMemoryPeerKeyPinStore()
    await store.pin(pinInput(NodeKeyPair.generate()))

    const result = await store.rotate({
      nodeId: WORKER_ID,
      meshId: OTHER_MESH_ID,
      key: publicNodeKeyOf(NodeKeyPair.generate()),
      enrollmentId: "enr-2",
      now: at(10),
      by: "user-1",
      reason: "x",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("identity.rotate_wrong_mesh")
  })
})

describe("decideEnrollment pinning", () => {
  it("pins on accept and refuses the same code presented with a different key", async () => {
    const codes = new InMemoryEnrollmentCodeStore()
    const pins = new InMemoryPeerKeyPinStore()
    const trust = new InMemoryNodeTrustStore()
    const issued = await issueEnrollmentCode({ meshId: MESH_ID, issuedBy: "user-1", now: at(0) }, codes)
    if (!issued.ok) throw new Error(issued.error.message)

    const honest = NodeKeyPair.generate()
    const request = buildEnrollmentRequest({
      meshId: MESH_ID,
      enrollmentId: issued.value.enrollmentId,
      codeHash: issued.value.codeHash,
      keyPair: honest,
      nodeDisplayName: "worker-1",
      provisionalNodeId: PROVISIONAL_ID,
      requestedAt: new Date(at(1)).toISOString(),
      codeExpiresAt: new Date(issued.value.expiresAt).toISOString(),
      senderNodeId: PENDING_SENDER_ID,
    })

    const accepted = await decideEnrollment({ request, now: at(1) }, { codes, pins, trust })
    expect(accepted.outcome).toBe("accepted")
    expect(accepted.nodeKeyId).toBe(honest.keyId)

    // The same code, a different key. §4.1: "a later request presenting the same code
    // with a different key is refused". The pin is not rewritten.
    const attacker = NodeKeyPair.generate()
    const replay = buildEnrollmentRequest({
      meshId: MESH_ID,
      enrollmentId: issued.value.enrollmentId,
      codeHash: issued.value.codeHash,
      keyPair: attacker,
      nodeDisplayName: "attacker",
      provisionalNodeId: PROVISIONAL_ID,
      requestedAt: new Date(at(2)).toISOString(),
      codeExpiresAt: new Date(issued.value.expiresAt).toISOString(),
      senderNodeId: PENDING_SENDER_ID,
    })
    const refused = await decideEnrollment({ request: replay, now: at(2) }, { codes, pins, trust })

    expect(refused.outcome).toBe("rejected")
    const current = await pins.current(accepted.nodeId)
    expect(current.ok && current.value?.nodeKeyId).toBe(honest.keyId)
  })

  it("converges a retry of the same code and key, without re-pinning", async () => {
    const codes = new InMemoryEnrollmentCodeStore()
    const pins = new InMemoryPeerKeyPinStore()
    const trust = new InMemoryNodeTrustStore()
    const issued = await issueEnrollmentCode({ meshId: MESH_ID, issuedBy: "user-1", now: at(0) }, codes)
    if (!issued.ok) throw new Error(issued.error.message)
    const keyPair = NodeKeyPair.generate()
    const request = buildEnrollmentRequest({
      meshId: MESH_ID,
      enrollmentId: issued.value.enrollmentId,
      codeHash: issued.value.codeHash,
      keyPair,
      nodeDisplayName: "worker-1",
      provisionalNodeId: PROVISIONAL_ID,
      requestedAt: new Date(at(1)).toISOString(),
      codeExpiresAt: new Date(issued.value.expiresAt).toISOString(),
      senderNodeId: PENDING_SENDER_ID,
    })

    const first = await decideEnrollment({ request, now: at(1) }, { codes, pins, trust })
    const retry = await decideEnrollment({ request, now: at(2) }, { codes, pins, trust })

    // The at-least-once case, end to end. A second `pin` would be refused by the
    // store, so a service that re-pinned on retry would report a failure for a
    // request that had already succeeded.
    expect(first.outcome).toBe("accepted")
    expect(retry.outcome).toBe("accepted")
    expect(retry.converged).toBe(true)
    expect(retry.nodeId).toBe(first.nodeId)
    expect(pins.size).toBe(1)
  })

  it("refuses a key that is not 32 bytes before it reaches the code store", async () => {
    const codes = new InMemoryEnrollmentCodeStore()
    const before = codes.redemptions
    const request = buildEnrollmentRequest({
      meshId: MESH_ID,
      enrollmentId: "enr-1",
      codeHash: `sha256:${"a".repeat(64)}`,
      keyPair: NodeKeyPair.generate(),
      nodeDisplayName: "worker-1",
      provisionalNodeId: PROVISIONAL_ID,
      requestedAt: new Date(at(1)).toISOString(),
      codeExpiresAt: new Date(at(600)).toISOString(),
      senderNodeId: PENDING_SENDER_ID,
    })
    const tampered = { ...request, nodePublicKey: "AAAA" }

    const decision = await decideEnrollment(
      { request: tampered, now: at(1) },
      { codes, pins: new InMemoryPeerKeyPinStore(), trust: new InMemoryNodeTrustStore() },
    )

    expect(decision.outcome).toBe("rejected")
    expect(codes.redemptions).toBe(before)
  })
})

describe("verifyEnrollmentCode + pins together", () => {
  it("keeps the code ledger and the pin ledger consistent across a rotation", async () => {
    const codes = new InMemoryEnrollmentCodeStore()
    const pins = new InMemoryPeerKeyPinStore()
    const first = NodeKeyPair.generate()
    const issued = await issueEnrollmentCode({ meshId: MESH_ID, issuedBy: "user-1", now: at(0) }, codes)
    if (!issued.ok) throw new Error(issued.error.message)

    const redeemed = await verifyEnrollmentCode(
      {
        meshId: MESH_ID,
        codeHash: issued.value.codeHash,
        nodePublicKey: first.publicKey,
        provisionalNodeId: PROVISIONAL_ID,
        now: at(1),
      },
      codes,
    )
    expect(redeemed.ok).toBe(true)
    if (!redeemed.ok) return

    await pins.pin({
      nodeId: redeemed.value.nodeId,
      meshId: MESH_ID,
      key: publicNodeKeyOf(first),
      enrollmentId: issued.value.enrollmentId,
      now: at(1),
    })

    const rotated = NodeKeyPair.generate()
    await pins.rotate({
      nodeId: redeemed.value.nodeId,
      meshId: MESH_ID,
      key: publicNodeKeyOf(rotated),
      enrollmentId: "enr-rotation",
      now: at(30),
      by: "user-1",
      reason: "scheduled rotation",
    })

    // The old code still converges to the same node, but only for the key it was
    // redeemed with — a rotated node's old key cannot re-pin through a spent code.
    const afterRotation = await verifyEnrollmentCode(
      {
        meshId: MESH_ID,
        codeHash: issued.value.codeHash,
        nodePublicKey: first.publicKey,
        provisionalNodeId: PROVISIONAL_ID,
        now: at(31),
      },
      codes,
    )
    expect(afterRotation.ok).toBe(true)

    const withRotatedKey = await verifyEnrollmentCode(
      {
        meshId: MESH_ID,
        codeHash: issued.value.codeHash,
        nodePublicKey: rotated.publicKey,
        provisionalNodeId: PROVISIONAL_ID,
        now: at(31),
      },
      codes,
    )
    expect(withRotatedKey.ok).toBe(false)
  })
})

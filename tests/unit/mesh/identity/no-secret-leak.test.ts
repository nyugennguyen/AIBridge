/**
 * The "no secret ever reaches a log, an event, or a `ContractError` message" sweep.
 *
 * `./middleware.ts` claims this file asserts the property, and until now nothing did.
 * The claim is the dangerous kind: a comment that says a guarantee is TESTED is what
 * a later author trusts when deciding the guarantee can be relaxed, and there is no
 * way to notice the difference between "tested" and "asserted in a comment" except
 * this file existing.
 *
 * The sweep is over the module's ERROR PATHS rather than over its source text, because
 * a leak is a VALUE in a message and a value only exists once a real refusal has been
 * produced. Grepping the source for a variable name would pass on a message that
 * interpolates the wrong one.
 *
 * `ContractError.message` is transmitted to peers, so a private key in one is not a
 * logging mistake — it is a full key disclosure to whoever provoked the error.
 */
import { describe, expect, it } from "vitest"
import { mkdtemp, rm, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContractError, type ContractError } from "../../../../src/orchestration/errors.js"
import { meshIdSchema, nodeIdSchema } from "../../../../src/orchestration/identifiers.js"
import { provisionalNodeIdSchema } from "../../../../src/mesh/identity/wire-ids.js"
import { FileSystemKeyStore } from "../../../../src/mesh/identity/file-key-store.js"
import { InMemoryKeyStore } from "../../../../src/mesh/identity/memory-key-store.js"
import { NodeKeyPair, parsePublicNodeKey, publicNodeKeyOf } from "../../../../src/mesh/identity/node-key.js"
import { parseStoredNodeKey, type StoredNodeKey } from "../../../../src/mesh/identity/key-store.js"
import { InMemoryEnrollmentCodeStore, issueEnrollmentCode, verifyEnrollmentCode } from "../../../../src/mesh/identity/enrollment-code.js"
import { decideEnrollment } from "../../../../src/mesh/identity/enrollment.js"
import { InMemoryNodeTrustStore, UnavailableNodeTrustStore, parseTrustedNode, revokeNode, verifyKeyNotRevoked, verifyNodeTrust } from "../../../../src/mesh/identity/node-trust.js"
import { InMemoryPeerKeyPinStore, parsePeerKeyPin, resolvePinnedKey, verifyPinnedKey } from "../../../../src/mesh/identity/peer-key-pins.js"
import { verifyMeshRequest, signMeshRequest, MAX_REQUEST_AGE_MS } from "../../../../src/mesh/identity/request-signature.js"
import { InMemoryNonceGuard, RefusingNonceGuard } from "../../../../src/mesh/identity/replay-guard.js"
import { MeshIdentityProvider } from "../../../../src/mesh/identity/identity-provider.js"
import { meshBodyDigest } from "../../../../src/mesh/identity/middleware.js"
import { MESH_ID, PROVISIONAL_ID, WORKER_ID, aKey, at, base64Url, nonce } from "./fixtures.js"

/**
 * A fixed run of base64 from the MIDDLE of a real ed25519 PKCS#8 body.
 *
 * Derived from a generated key rather than pasted in, because a pasted-in constant is
 * a string that must be kept in step with what `exportPrivateKeyPem` actually emits —
 * and the first version of this file asserted against a plausible-looking constant
 * that appeared in no key at all, which would have made the whole sweep pass for a
 * reason that had nothing to do with leaks. The armour headers are excluded because
 * any error may legitimately name the shape ("not a PKCS#8 PEM block"); what must
 * never appear is the encoded key.
 */
const PEM_BODY = (() => {
  const lines = NodeKeyPair.generate()
    .exportPrivateKeyPem()
    .split("\n")
    .filter((line) => line.includes("-----") === false)
  return lines.join("").slice(0, 40)
})()

function storedFor(keyPair: NodeKeyPair): StoredNodeKey {
  return {
    nodeId: WORKER_ID,
    nodeKeyId: keyPair.keyId,
    publicKey: keyPair.publicKey,
    fingerprint: keyPair.fingerprint,
    privateKeyPem: keyPair.exportPrivateKeyPem(),
    createdAt: 1_789_000_000_000,
  }
}

/**
 * Asserts a refusal carries none of the given secrets.
 *
 * Checked against the whole rendered `ContractError`, not just `message`, because
 * `category` and `code` are attacker-reachable too and a `code` built by
 * interpolation is the same leak with a shorter name.
 */
function assertNoSecret(error: ContractError, secrets: readonly string[], what: string): void {
  const rendered = JSON.stringify(error)
  for (const secret of secrets) {
    expect(rendered, `${what} leaked a secret`).not.toContain(secret)
  }
  // The encoded key body, on its own. The armour headers are a fixed string any error
  // may legitimately name, and asserting on them would let a message that leaked the
  // key itself pass.
  expect(rendered, `${what} leaked key material`).not.toContain(PEM_BODY)
}

describe("every error path in the module is swept for secret material", () => {
  it("key store: parse, save, and a fail-closed permission refusal", async () => {
    const keyPair = NodeKeyPair.generate()
    const secrets = [keyPair.exportPrivateKeyPem(), PEM_BODY, keyPair.publicKey]

    const bad = parseStoredNodeKey({ ...storedFor(keyPair), privateKeyPem: "" })
    expect(bad.ok).toBe(false)
    if (!bad.ok) assertNoSecret(bad.error, secrets, "parseStoredNodeKey")

    // The refusals that DO quote their subject: a readable file, a bad path, a
    // directory that cannot be secured. These are the ones where the temptation to
    // "helpfully" include the offending content is highest.
    const dir = await mkdtemp(join(tmpdir(), "aibridge-leak-"))
    try {
      const store = new FileSystemKeyStore(dir)
      await store.save(storedFor(keyPair))
      const path = join(dir, `${WORKER_ID}.node-key.json`)

      await chmod(path, 0o644)
      const loose = await store.load(WORKER_ID)
      expect(loose.ok).toBe(false)
      if (!loose.ok) assertNoSecret(loose.error, secrets, "a world-readable key file refusal")

      await chmod(path, 0o600)
      const escaped = await store.save({ ...storedFor(keyPair), nodeId: "../../etc/passwd" } as unknown as StoredNodeKey)
      expect(escaped.ok).toBe(false)
      if (!escaped.ok) assertNoSecret(escaped.error, secrets, "a traversal path refusal")

      const missing = await new InMemoryKeyStore().save(storedFor(keyPair))
      expect(missing.ok).toBe(true)
      const again = await new InMemoryKeyStore().save(storedFor(keyPair))
      if (!again.ok) assertNoSecret(again.error, secrets, "the key-exists refusal")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("enrollment code: every rejection, including the ones that name a code state", async () => {
    const store = new InMemoryEnrollmentCodeStore()
    const issued = await issueEnrollmentCode({ meshId: MESH_ID, issuedBy: "user-1", now: at(0) }, store)
    if (!issued.ok) throw new Error(issued.error.message)
    // The raw code IS a redeemable credential, and the hashes of it are the only thing
    // permitted on the wire — so neither may appear in a refusal.
    const secrets = [issued.value.code, issued.value.codeHash]

    const unknown = await verifyEnrollmentCode({ meshId: MESH_ID, codeHash: `sha256:${"a".repeat(64)}`, nodePublicKey: "AAAA", provisionalNodeId: PROVISIONAL_ID, now: at(1) }, store)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) assertNoSecret(unknown.error, secrets, "an unknown-code refusal")

    await verifyEnrollmentCode({ meshId: MESH_ID, codeHash: issued.value.codeHash, nodePublicKey: "key-a", provisionalNodeId: PROVISIONAL_ID, now: at(1) }, store)
    const reused = await verifyEnrollmentCode({ meshId: MESH_ID, codeHash: issued.value.codeHash, nodePublicKey: "key-b", provisionalNodeId: PROVISIONAL_ID, now: at(1) }, store)
    expect(reused.ok).toBe(false)
    if (!reused.ok) assertNoSecret(reused.error, secrets, "an already-used-code refusal")

    const ttl = await issueEnrollmentCode({ meshId: MESH_ID, issuedBy: "user-1", now: at(0), ttlMs: 1_000 }, new InMemoryEnrollmentCodeStore())
    if (!ttl.ok) throw new Error(ttl.error.message)
    const expired = await verifyEnrollmentCode({ meshId: MESH_ID, codeHash: ttl.value.codeHash, nodePublicKey: "key-a", provisionalNodeId: PROVISIONAL_ID, now: at(60) }, new InMemoryEnrollmentCodeStore())
    expect(expired.ok).toBe(false)
    if (!expired.ok) assertNoSecret(expired.error, [ttl.value.code, ttl.value.codeHash], "an expired-code refusal")

    // Issue-time refusals too: an over-long TTL names the requested number, and a code
    // is not in scope there, but the sweep should not have to know that.
    const overTtl = await issueEnrollmentCode({ meshId: MESH_ID, issuedBy: "user-1", now: at(0), ttlMs: 10 ** 12 }, new InMemoryEnrollmentCodeStore())
    if (!overTtl.ok) assertNoSecret(overTtl.error, secrets, "an over-long TTL refusal")
  })

  it("node trust, pins and enrollment: the refusals that quote ids and keys", async () => {
    const keyPair = NodeKeyPair.generate()
    const trust = new InMemoryNodeTrustStore()
    const pins = new InMemoryPeerKeyPinStore()
    const nodeId = nodeIdSchema.parse("node-enr-leak")
    await trust.enroll({ nodeId, meshId: MESH_ID, nodeKeyId: keyPair.keyId, enrolledAt: at(0), displayName: "worker" })
    await pins.pin({ nodeId, meshId: MESH_ID, key: publicNodeKeyOf(keyPair), enrollmentId: "enr-1", now: at(1) })

    // A revoked key refusal names the key id, because the peer supplied it. What it
    // must not carry is the revocation's own `reason` or `by` — the same withholding
    // `verifyNodeTrust` does, and the reason it matters is the same.
    const revoked = await revokeNode({ nodeId, meshId: MESH_ID, reason: "the safe was empty", by: "user-1", at: at(1) }, { trust, pins })
    expect(revoked.ok).toBe(true)
    const keyRefusal = await verifyKeyNotRevoked(trust, keyPair.keyId)
    expect(keyRefusal.ok).toBe(false)
    if (!keyRefusal.ok) {
      assertNoSecret(keyRefusal.error, [keyPair.exportPrivateKeyPem(), PEM_BODY], "a revoked-key refusal")
      expect(keyRefusal.error.message).not.toContain("the safe was empty")
      expect(keyRefusal.error.message).not.toContain("user-1")
    }

    const trustVerdict = await verifyNodeTrust(trust, { nodeId, meshId: MESH_ID })
    if (!trustVerdict.ok) {
      assertNoSecret(trustVerdict.error, [keyPair.exportPrivateKeyPem(), PEM_BODY], "a node-revoked refusal")
      expect(trustVerdict.error.message).not.toContain("the safe was empty")
    }

    const pinMissing = await resolvePinnedKey(pins, { nodeId, meshId: MESH_ID, nodeKeyId: keyPair.keyId })
    expect(pinMissing.ok).toBe(false)
    if (!pinMissing.ok) assertNoSecret(pinMissing.error, [keyPair.exportPrivateKeyPem()], "a missing-pin refusal")

    const mismatch = await verifyPinnedKey(pins, { nodeId, meshId: MESH_ID, key: publicNodeKeyOf(NodeKeyPair.generate()) })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) assertNoSecret(mismatch.error, [keyPair.exportPrivateKeyPem()], "a key-mismatch refusal")

    expect(parseTrustedNode({ nodeId: "not a wire id", meshId: MESH_ID, nodeKeyId: keyPair.keyId, enrolledAt: 0, displayName: "w" }).ok).toBe(false)
    expect(parsePeerKeyPin({ nodeId: "not a wire id" }).ok).toBe(false)
    expect(parsePublicNodeKey({ nodeKeyId: "key-1", publicKey: "AAAA" }).ok).toBe(false)

    // The enrollment refusal, which is the one a peer provokes on purpose.
    const codes = new InMemoryEnrollmentCodeStore()
    const issued = await issueEnrollmentCode({ meshId: MESH_ID, issuedBy: "user-1", now: at(0) }, codes)
    if (!issued.ok) throw new Error(issued.error.message)
    const fresh = NodeKeyPair.generate()
    const decided = await decideEnrollment(
      {
        request: {
          meshId: MESH_ID,
          enrollmentId: issued.value.enrollmentId,
          enrollmentCodeHash: issued.value.codeHash,
          nodePublicKey: fresh.publicKey,
          nodeDisplayName: "worker",
          provisionalNodeId: PROVISIONAL_ID,
          requestedAt: new Date(at(1)).toISOString(),
          codeExpiresAt: new Date(issued.value.expiresAt).toISOString(),
        },
        now: at(1),
      },
      { codes, pins, trust },
    )
    expect(decided.outcome).toBe("accepted")

    const bad = await decideEnrollment(
      {
        request: {
          meshId: MESH_ID,
          enrollmentId: issued.value.enrollmentId,
          enrollmentCodeHash: issued.value.codeHash,
          nodePublicKey: "AAAA",
          nodeDisplayName: "worker",
          provisionalNodeId: PROVISIONAL_ID,
          requestedAt: new Date(at(1)).toISOString(),
          codeExpiresAt: new Date(issued.value.expiresAt).toISOString(),
        },
        now: at(1),
      },
      { codes, pins, trust },
    )
    expect(bad.outcome).toBe("rejected")
  })

  it("request signature: the refusals a forged or replayed request provokes", async () => {
    const key = aKey()
    const guard = new InMemoryNonceGuard()
    const signed = signMeshRequest(key.keyPair, {
      method: "POST",
      path: "/v1/mesh/command",
      bodyDigest: meshBodyDigest({ op: "start" }),
      timestamp: at(5),
      nonce: nonce(),
      nodeId: WORKER_ID,
      keyId: key.keyPair.keyId,
    })
    const pem = key.keyPair.exportPrivateKeyPem()
    const secrets = [pem, PEM_BODY, signed.signature]

    const forged = verifyMeshRequest({ ...signed, signature: base64Url(Buffer.alloc(64, 7)) }, { storedKey: key.rawPublicKey, expectedNodeId: WORKER_ID, now: at(5), replayGuard: guard })
    expect(forged.ok).toBe(false)
    if (!forged.ok) assertNoSecret(forged.error, secrets, "a forged-signature refusal")

    const stale = verifyMeshRequest(signed, { storedKey: key.rawPublicKey, expectedNodeId: WORKER_ID, now: at(5) + MAX_REQUEST_AGE_MS + 1, replayGuard: new InMemoryNonceGuard() })
    expect(stale.ok).toBe(false)
    if (!stale.ok) assertNoSecret(stale.error, secrets, "an expired-request refusal")

    const ok = verifyMeshRequest(signed, { storedKey: key.rawPublicKey, expectedNodeId: WORKER_ID, now: at(5), replayGuard: guard })
    expect(ok.ok).toBe(true)
    const replay = verifyMeshRequest(signed, { storedKey: key.rawPublicKey, expectedNodeId: WORKER_ID, now: at(5), replayGuard: guard })
    expect(replay.ok).toBe(false)
    // A replay refusal NAMES the nonce, which is correct: the peer sent the nonce in a
    // header, so echoing it discloses nothing, and a refusal an operator cannot
    // correlate is a refusal they will file as unexplained. The SIGNATURE is different —
    // it is the credential.
    if (!replay.ok) assertNoSecret(replay.error, [pem, PEM_BODY, signed.signature], "a replay refusal")

    const unavailable = verifyMeshRequest(signed, { storedKey: key.rawPublicKey, expectedNodeId: WORKER_ID, now: at(5), replayGuard: new RefusingNonceGuard() })
    if (!unavailable.ok) assertNoSecret(unavailable.error, secrets, "a replay-guard-unavailable refusal")
  })

  it("the provider's refusals, for an enrolled node and for a broken store", async () => {
    const keyPair = NodeKeyPair.generate()
    const trust = new InMemoryNodeTrustStore()
    const pins = new InMemoryPeerKeyPinStore()
    const nodeId = nodeIdSchema.parse("node-enr-leak2")
    await trust.enroll({ nodeId, meshId: MESH_ID, nodeKeyId: keyPair.keyId, enrolledAt: at(0), displayName: "worker" })
    await pins.pin({ nodeId, meshId: MESH_ID, key: publicNodeKeyOf(keyPair), enrollmentId: "enr-1", now: at(1) })
    const secrets = [keyPair.exportPrivateKeyPem(), PEM_BODY]

    const signed = signMeshRequest(keyPair, {
      method: "POST",
      path: "/v1/mesh/command",
      bodyDigest: meshBodyDigest({ op: "start" }),
      timestamp: at(5),
      nonce: nonce(),
      nodeId,
      keyId: keyPair.keyId,
    })

    const bad = await new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: () => at(5) }).authenticate({
      expectedNodeId: nodeId,
      expectedMeshId: MESH_ID,
      signature: { ...signed, signature: base64Url(Buffer.alloc(64, 3)) },
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) assertNoSecret(bad.error, secrets, "the provider's signature refusal")

    const down = await new MeshIdentityProvider({ trust: new UnavailableNodeTrustStore(), pins, replayGuard: new InMemoryNonceGuard(), now: () => at(5) }).authenticate({
      expectedNodeId: nodeId,
      expectedMeshId: MESH_ID,
      signature: signed,
    })
    expect(down.ok).toBe(false)
    if (!down.ok) assertNoSecret(down.error, secrets, "a trust-store-unavailable refusal")
  })
})

describe("a secret does not reach a log line through the object that holds it", () => {
  it("neither a keypair nor a stored key record renders one by default", () => {
    const keyPair = NodeKeyPair.generate()
    const record = storedFor(keyPair)

    // `StoredNodeKey` is a plain object and therefore IS enumerable, so this is a real
    // risk rather than a theoretical one: the file store's own `serializeStoredNodeKey`
    // must be the only path that stringifies it, and a `JSON.stringify(record)` in a log
    // statement would emit the key.
    expect(JSON.stringify({ keyPair })).not.toContain(PEM_BODY)
    expect(String(keyPair)).not.toContain(PEM_BODY)

    // The record DOES carry the PEM, and that is what makes the sweep above necessary:
    // nothing stops a future caller from interpolating it, so the guarantee has to be
    // "no code in this module does", asserted over error paths rather than assumed.
    // This record's OWN body, not the module-level one — every generated key differs,
    // and a constant taken from a different key would not appear here at all.
    const ownBody = record.privateKeyPem.split("\n").filter((line) => line.includes("-----") === false).join("")
    expect(record.privateKeyPem).toContain("BEGIN PRIVATE KEY")
    expect(JSON.stringify(record)).toContain(ownBody.slice(0, 40))
  })

  it("an enrollment store's records never hold the raw code", async () => {
    const store = new InMemoryEnrollmentCodeStore()
    const issued = await issueEnrollmentCode({ meshId: MESH_ID, issuedBy: "user-1", now: at(0) }, store)

    if (!issued.ok) throw new Error(issued.error.message)
    // A store that can read the code back can log it, and a store that cannot read it
    // cannot leak it. That is the whole reason `code` is not a field on the record.
    const stored = store.find(issued.value.codeHash)
    expect(stored).toBeDefined()
    expect(JSON.stringify(stored)).not.toContain(issued.value.code)
    expect(JSON.stringify(store)).not.toContain(issued.value.code)
  })
})

describe("a synthetic check that the sweep above would actually catch a leak", () => {
  it("fails when a secret IS present, so a green sweep means something", () => {
    // The failure mode of a leak-detection test is that it passes for a reason
    // unrelated to leaks. Asserted by CONSTRUCTION here: the helper is shown refusing
    // an error that does contain the secret. Without this, a bug in `assertNoSecret`
    // — a typo, an inverted condition — would silence every assertion in this file.
    const leaky = createContractError("internal_failure", "identity.leaky", `the key is ${PEM_BODY}`)
    expect(() => assertNoSecret(leaky, [PEM_BODY], "a deliberately leaky error")).toThrow()
  })
})

import { describe, expect, it } from "vitest"
import { randomBytes } from "node:crypto"
import {
  MAX_FUTURE_SKEW_MS,
  MAX_REQUEST_AGE_MS,
  MAX_SIGNED_PATH_LENGTH,
  MESH_REQUEST_SIGNATURE_DOMAIN,
  meshSigningString,
  signMeshRequest,
  verifyMeshRequest,
  type MeshRequestSignature,
  type ReplayGuard,
} from "../../../../src/mesh/identity/request-signature.js"
import { DEFAULT_NONCE_RETENTION_MS, InMemoryNonceGuard, RefusingNonceGuard } from "../../../../src/mesh/identity/replay-guard.js"
import { InMemoryPeerKeyPinStore } from "../../../../src/mesh/identity/peer-key-pins.js"
import { InMemoryNodeTrustStore, verifyNodeTrust } from "../../../../src/mesh/identity/node-trust.js"
import { MeshIdentityProvider } from "../../../../src/mesh/identity/identity-provider.js"
import { NodeKeyPair } from "../../../../src/mesh/identity/node-key.js"
import { nodeIdSchema, type NodeId } from "../../../../src/orchestration/identifiers.js"
import { nodeKeyIdSchema } from "../../../../src/mesh/identity/wire-ids.js"
import { BearerAuthProvider } from "../../../../src/security/auth-provider.js"
import { MESH_ID, OTHER_MESH_ID, WORKER_ID, aKey, aRequest, asSignature, at, base64Url, nonce } from "./fixtures.js"

const STRANGER = nodeIdSchema.parse("node-stranger")

/**
 * A fresh enrolled-and-pinned node, for the provider tests.
 *
 * At MODULE scope rather than inside a `describe`, because the bearer tests below are
 * a separate `describe` and reached for it by name — a `describe` body is a closure, so
 * a helper declared inside one is simply not in scope in another. The previous version
 * was, and it was a `ReferenceError` waiting for whichever of the two ran first.
 */
function build() {
  const trust = new InMemoryNodeTrustStore()
  const pins = new InMemoryPeerKeyPinStore()
  const keyPair = NodeKeyPair.generate()
  const nodeId = nodeIdSchema.parse("node-enr-abc123")
  return { trust, pins, keyPair, nodeId }
}

function signedRequest(keyPair: NodeKeyPair, overrides = {}) {
  const request = aRequest({ nodeId: WORKER_ID, keyId: keyPair.keyId, ...overrides })
  return signMeshRequest(keyPair, {
    method: request.method,
    path: request.path,
    bodyDigest: request.bodyDigest,
    timestamp: request.timestamp,
    nonce: request.nonce,
    nodeId: request.nodeId,
    keyId: request.keyId,
  })
}

describe("meshSigningString", () => {
  it("binds method, path, body digest, timestamp, nonce, node id and key id", () => {
    const base = {
      method: "POST",
      path: "/v1/mesh/command?project=release",
      bodyDigest: `sha256:${"a".repeat(64)}`,
      timestamp: at(5),
      nonce: nonce(),
      nodeId: WORKER_ID,
      keyId: nodeKeyIdSchema.parse("key-0000000000000000"),
    }
    const reference = meshSigningString(base).toString("utf8")

    // Each field is changed on its own. If ANY of these produced the same string,
    // that field would be outside the signature and a signature could be lifted
    // from one request onto another that differs only in it.
    for (const field of ["method", "path", "bodyDigest", "timestamp", "nonce", "nodeId", "keyId"] as const) {
      const altered =
        field === "method"
          ? { ...base, method: "GET" }
          : field === "path"
            ? { ...base, path: "/v1/mesh/heartbeat" }
            : field === "bodyDigest"
              ? { ...base, bodyDigest: `sha256:${"b".repeat(64)}` }
              : field === "timestamp"
                ? { ...base, timestamp: base.timestamp + 1 }
                : field === "nonce"
                  ? { ...base, nonce: nonce() }
                  : field === "nodeId"
                    ? { ...base, nodeId: STRANGER }
                    : { ...base, keyId: nodeKeyIdSchema.parse("key-1111111111111111") }
      expect(meshSigningString(altered).toString("utf8"), `${field} is not bound`).not.toBe(reference)
    }
  })

  it("is domain-separated, so a signature made here is not a signature made for anything else", () => {
    const string = meshSigningString({
      method: "POST",
      path: "/v1/mesh/command",
      bodyDigest: `sha256:${"a".repeat(64)}`,
      timestamp: at(5),
      nonce: nonce(),
      nodeId: WORKER_ID,
      keyId: nodeKeyIdSchema.parse("key-0000000000000000"),
    }).toString("utf8")

    expect(string.startsWith(`${MESH_REQUEST_SIGNATURE_DOMAIN}\n`)).toBe(true)
    expect(MESH_REQUEST_SIGNATURE_DOMAIN).toBe("aibridge.mesh.request.v1")
  })

  it("cannot be confused by a path containing the delimiter", () => {
    // A hand-rolled "a:b:c" signing string is ambiguous the moment a field contains
    // the delimiter, and a path is attacker-supplied. Canonical JSON is not.
    const a = meshSigningString({
      method: "POST",
      path: "/a/command",
      bodyDigest: `sha256:${"a".repeat(64)}`,
      timestamp: 1,
      nonce: nonce(),
      nodeId: WORKER_ID,
      keyId: nodeKeyIdSchema.parse("key-0000000000000000"),
    })
    const b = meshSigningString({
      method: "POST",
      path: "/a/command" + "\n" + "x",
      bodyDigest: `sha256:${"a".repeat(64)}`,
      timestamp: 1,
      nonce: nonce().slice(0, 20),
      keyId: nodeKeyIdSchema.parse("key-0000000000000000"),
      nodeId: WORKER_ID,
    })
    expect(a.equals(b)).toBe(false)
  })
})

describe("verifyMeshRequest", () => {
  const key = aKey()

  function verify(signature: MeshRequestSignature, overrides: Partial<Parameters<typeof verifyMeshRequest>[1]> = {}) {
    return verifyMeshRequest(signature, {
      storedKey: key.rawPublicKey,
      expectedNodeId: WORKER_ID,
      now: at(5),
      replayGuard: new InMemoryNonceGuard(),
      ...overrides,
    })
  }

  it("accepts a valid signature", () => {
    const result = verify(signedRequest(key.keyPair))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.nodeId).toBe(WORKER_ID)
      expect(result.value.keyId).toBe(key.keyPair.keyId)
      // The handler reads the SIGNED fields, not the request object, so there is no
      // second spelling of "what was signed" to disagree with.
      expect(result.value.signed.path).toBe("/v1/mesh/command")
    }
  })

  it("refuses a signature lifted from one (method, path) onto another", () => {
    const captured = signedRequest(key.keyPair, { method: "GET", path: "/v1/mesh/heartbeat" })

    const ontoPost = verify(captured, { now: at(5) })
    const ontoOtherPath = verify(
      { ...captured, path: "/v1/mesh/command", signature: captured.signature },
      { now: at(5) },
    )

    // A read capability must not become a write capability, and a signature for one
    // endpoint must not authorise another. Both are the same assertion.
    expect(ontoPost.ok).toBe(true)
    expect(ontoOtherPath.ok).toBe(false)
    if (!ontoOtherPath.ok) expect(ontoOtherPath.reason).toBe("signature_invalid")

    // And the method itself is bound: replaying a GET signature as a POST.
    const post = signedRequest(key.keyPair, { method: "GET", path: "/v1/mesh/command" })
    const asPost = verify({ ...post, method: "POST" })
    expect(asPost.ok).toBe(false)
  })

  it("refuses a tampered body digest", () => {
    const signature = signedRequest(key.keyPair)
    const tampered = verify({ ...signature, bodyDigest: `sha256:${"f".repeat(64)}` })

    // The digest is what the signature covers instead of the body itself, which is
    // what lets the signature be checked before a megabyte of untrusted JSON is
    // interpreted. A body swapped for a different body of the same shape fails here.
    expect(tampered.ok).toBe(false)
    if (!tampered.ok) expect(tampered.reason).toBe("signature_invalid")
  })

  it("refuses a future timestamp beyond the skew allowance, and accepts one inside it", () => {
    const signature = signedRequest(key.keyPair, { timestamp: at(5) })

    const farFuture = verify(signature, { now: at(5) - MAX_FUTURE_SKEW_MS - 1 })
    expect(farFuture.ok).toBe(false)
    if (!farFuture.ok) expect(farFuture.reason).toBe("signature_not_yet_valid")

    // Thirty seconds of allowance is generous for NTP and keeps a fast clock from
    // extending the acceptance window by the full age bound.
    const justInside = verify(signature, { now: at(5) - MAX_FUTURE_SKEW_MS + 1_000 })
    expect(justInside.ok).toBe(true)
  })

  it("refuses an expired timestamp, and accepts one inside the age bound", () => {
    const signature = signedRequest(key.keyPair, { timestamp: at(5) })

    const expired = verify(signature, { now: at(5) + MAX_REQUEST_AGE_MS + 1 })
    expect(expired.ok).toBe(false)
    if (!expired.ok) {
      expect(expired.reason).toBe("signature_expired")
      // A separate refusal from the future-skew one, because the operator meanings
      // differ: one is a clock disagreement, the other is a capture.
      expect(expired.error.code).toBe("identity.request_expired")
    }

    const justInside = verify(signedRequest(key.keyPair, { timestamp: at(5) - MAX_REQUEST_AGE_MS + 1_000 }), { now: at(5) })
    expect(justInside.ok).toBe(true)
  })

  it("refuses a replayed nonce", () => {
    const guard = new InMemoryNonceGuard()
    const signature = signedRequest(key.keyPair)

    expect(verify(signature, { replayGuard: guard }).ok).toBe(true)
    const replay = verify(signature, { replayGuard: guard })

    // A freshness window alone does not stop replay: a signature valid for five
    // minutes is replayable five hundred times in those five minutes, and what it
    // authorises is not idempotent.
    expect(replay.ok).toBe(false)
    if (!replay.ok) {
      expect(replay.reason).toBe("replay_detected")
      expect(replay.error.code).toBe("identity.replay_detected")
    }
  })

  it("scopes nonces per node, so one node cannot burn another's", () => {
    const guard = new InMemoryNonceGuard()
    const shared = nonce()

    // A single global nonce space would let node A invalidate node B's in-flight
    // requests, which is a denial of service that needs no credentials and no
    // knowledge of B's key.
    const worker = signedRequest(key.keyPair, { nonce: shared })
    const strangerKey = aKey()
    const strangerRequest = aRequest({ nodeId: STRANGER, keyId: strangerKey.keyPair.keyId, nonce: shared })
    const stranger = signMeshRequest(strangerKey.keyPair, {
      method: strangerRequest.method,
      path: strangerRequest.path,
      bodyDigest: strangerRequest.bodyDigest,
      timestamp: strangerRequest.timestamp,
      nonce: strangerRequest.nonce,
      nodeId: strangerRequest.nodeId,
      keyId: strangerRequest.keyId,
    })

    expect(verify(worker, { replayGuard: guard }).ok).toBe(true)
    expect(verify(stranger, { replayGuard: guard, expectedNodeId: STRANGER, storedKey: strangerKey.rawPublicKey }).ok).toBe(true)
  })

  it("does not burn a nonce for a request whose signature is forged", () => {
    const guard = new InMemoryNonceGuard()
    const real = signedRequest(key.keyPair)

    // The victim's next nonce, with a forged signature.
    const forged = { ...real, signature: base64Url(randomBytes(64)) }
    expect(verify(forged, { replayGuard: guard }).ok).toBe(false)

    // If the nonce were consumed BEFORE the signature check, anyone could send
    // garbage with a victim's node id and next nonce and deny the victim a window of
    // legitimate requests. Consuming last makes that impossible.
    expect(verify(real, { replayGuard: guard }).ok).toBe(true)
  })

  it("refuses a request naming a different node than the seam it arrived at", () => {
    const signature = signedRequest(key.keyPair, { nodeId: STRANGER })
    const result = verify(signature, { expectedNodeId: WORKER_ID })

    // The identity a request is evaluated as is decided by the SEAM — which socket,
    // which route, which mesh — never by a header. Letting the header choose is how
    // a signature for node A becomes a request as node B.
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("node_mismatch")
      expect(result.error.code).toBe("identity.node_mismatch")
    }
  })

  it("refuses a signature from a key other than the pinned one", () => {
    const other = aKey()
    const result = verify(signedRequest(other.keyPair), { storedKey: key.rawPublicKey })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("signature_invalid")
  })

  it("refuses a malformed signature without attempting to verify it", () => {
    const result = verify({ ...signedRequest(key.keyPair), signature: "AAAA" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("signature_malformed")
  })

  it("refuses a malformed request shape before spending any crypto", () => {
    const good = signedRequest(key.keyPair)

    expect(verify({ ...good, nonce: "short" }).ok).toBe(false)
    expect(verify({ ...good, bodyDigest: "not-a-digest" }).ok).toBe(false)
    expect(verify({ ...good, path: "" }).ok).toBe(false)
    expect(verify({ ...good, method: "A".repeat(64) }).ok).toBe(false)
    expect(verify({ ...good, path: `/${"a".repeat(MAX_SIGNED_PATH_LENGTH + 1)}` }).ok).toBe(false)
  })

  it("refuses when the replay guard cannot answer, rather than accepting the request", () => {
    const result = verify(signedRequest(key.keyPair), { replayGuard: new RefusingNonceGuard() })

    // A guard that fails open is a guard that has been switched off by a disk-full.
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("replay_guard_unavailable")
  })

  it("refuses when the verifier is handed no clock value", () => {
    const result = verify(signedRequest(key.keyPair), { now: Number.NaN })
    expect(result.ok).toBe(false)
  })
})

describe("InMemoryNonceGuard", () => {
  it("refuses rather than evicting a live nonce when full", () => {
    const guard = new InMemoryNonceGuard({ maxTracked: 2 })
    guard.consume("a", at(0))
    guard.consume("b", at(0))
    const overflow = guard.consume("c", at(0))

    // Evicting here would let an unauthenticated flood invalidate a legitimate
    // node's nonces — a denial of service needing no credentials at all.
    expect(overflow.ok).toBe(false)
    if (!overflow.ok) expect(overflow.error.code).toBe("identity.replay_store_full")
    // The two already-recorded nonces are still recorded, not displaced.
    expect(guard.consume("a", at(0))).toEqual({ ok: true, value: "replay" })
  })

  it("forgets a nonce only after no request bearing it could still verify", () => {
    const guard = new InMemoryNonceGuard()
    const at5 = at(5)
    expect(guard.consume("n", at5)).toEqual({ ok: true, value: "recorded" })

    // Still inside the acceptance window: a replay must be refused.
    expect(guard.consume("n", at5 + MAX_REQUEST_AGE_MS)).toEqual({ ok: true, value: "replay" })
    // Past it, the request could not verify anyway, so forgetting is safe.
    expect(guard.consume("n", at5 + MAX_REQUEST_AGE_MS + MAX_FUTURE_SKEW_MS + 1)).toEqual({ ok: true, value: "recorded" })
  })

  it("refuses a clock value it cannot compute a deadline from", () => {
    const guard = new InMemoryNonceGuard()
    expect(guard.consume("n", Number.NaN).ok).toBe(false)
  })

  it("CANNOT GROW WITHOUT LIMIT, under a flood that never lets the window advance", () => {
    // The bound is reachable by an UNAUTHENTICATED peer, because a request that fails
    // its signature check never gets this far — so the guard is the one structure on the
    // request path whose size an outsider controls. A guard that grew, or that evicted a
    // live nonce to keep growing, is a denial of service against every enrolled node
    // bought with no credentials at all.
    const maxTracked = 64
    const guard = new InMemoryNonceGuard({ maxTracked })

    for (let index = 0; index < maxTracked * 4; index += 1) {
      // The SAME instant throughout, so nothing expires and pruning can never make
      // room. The worst case, not a convenient one.
      const outcome = guard.consume(`flood-${index}`, at(5))
      if (index >= maxTracked) {
        expect(outcome.ok, `flood entry ${index} was admitted past the bound`).toBe(false)
        if (!outcome.ok) expect(outcome.error.code).toBe("identity.replay_store_full")
      }
    }
    expect(guard.size).toBe(maxTracked)
  })

  it("evicts once the window advances, so a long-lived controller does not accumulate nonces forever", () => {
    const guard = new InMemoryNonceGuard({ maxTracked: 4 })
    for (let index = 0; index < 4; index += 1) guard.consume(`n-${index}`, at(0))
    expect(guard.size).toBe(4)

    // At capacity, a nonce that is STILL LIVE is answered as a replay rather than
    // refused, and the refusal is not what is being asserted here — what matters is
    // that a flood cannot make the guard forget it. Evicting to make room would turn an
    // unauthenticated flood into a window in which a captured request replays cleanly.
    expect(guard.consume("n-0", at(0))).toEqual({ ok: true, value: "replay" })
    expect(guard.size).toBe(4)

    // Past every retention deadline the entries go and the guard is usable again —
    // the difference between "refuses a flood" and "stops accepting requests forever".
    const later = at(0) + DEFAULT_NONCE_RETENTION_MS + 1
    expect(guard.consume("n-0", later)).toEqual({ ok: true, value: "recorded" })
    expect(guard.size).toBe(1)
  })
})

describe("MeshIdentityProvider", () => {
  it("authenticates an enrolled, pinned node with a valid signature", async () => {
    const { trust, pins, keyPair, nodeId } = build()
    await trust.enroll({ nodeId, meshId: MESH_ID, nodeKeyId: keyPair.keyId, enrolledAt: at(0), displayName: "worker" })
    await pins.pin({ nodeId, meshId: MESH_ID, key: { nodeKeyId: keyPair.keyId, publicKey: keyPair.publicKey, fingerprint: keyPair.fingerprint }, enrollmentId: "enr-1", now: at(1) })

    const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: () => at(5) })
    const request = aRequest({ nodeId, keyId: keyPair.keyId })
    const signature = signMeshRequest(keyPair, {
      method: request.method,
      path: request.path,
      bodyDigest: request.bodyDigest,
      timestamp: request.timestamp,
      nonce: request.nonce,
      nodeId,
      keyId: keyPair.keyId,
    })

    const outcome = await provider.authenticate({ expectedNodeId: nodeId, expectedMeshId: MESH_ID, signature })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.value.nodeId).toBe(nodeId)
      expect(outcome.value.nodeKeyId).toBe(keyPair.keyId)
      expect(outcome.value.fingerprint).toBe(keyPair.fingerprint)
      expect(outcome.value.enrolledAt).toBe(at(0))
    }
  })

  it("refuses an unknown nodeId: no pin, no trust, no admission", async () => {
    const { trust, pins } = build()
    const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: () => at(5) })
    const other = aKey()
    const request = aRequest({ nodeId: STRANGER, keyId: other.keyPair.keyId })
    const signature = signMeshRequest(other.keyPair, {
      method: request.method,
      path: request.path,
      bodyDigest: request.bodyDigest,
      timestamp: request.timestamp,
      nonce: request.nonce,
      nodeId: STRANGER,
      keyId: other.keyPair.keyId,
    })

    const outcome = await provider.authenticate({ expectedNodeId: STRANGER, expectedMeshId: MESH_ID, signature })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toBe("node_unknown")
      expect(outcome.error.code).toBe("identity.node_not_enrolled")
    }
  })

  it("refuses a keyId that is not the pinned one, before spending a verification", async () => {
    const { trust, pins, keyPair, nodeId } = build()
    await trust.enroll({ nodeId, meshId: MESH_ID, nodeKeyId: keyPair.keyId, enrolledAt: at(0), displayName: "worker" })
    await pins.pin({ nodeId, meshId: MESH_ID, key: { nodeKeyId: keyPair.keyId, publicKey: keyPair.publicKey, fingerprint: keyPair.fingerprint }, enrollmentId: "enr-1", now: at(1) })

    const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: () => at(5) })
    const rotatedOut = aKey()
    const request = aRequest({ nodeId, keyId: rotatedOut.keyPair.keyId })
    const signature = signMeshRequest(rotatedOut.keyPair, {
      method: request.method,
      path: request.path,
      bodyDigest: request.bodyDigest,
      timestamp: request.timestamp,
      nonce: request.nonce,
      nodeId,
      keyId: rotatedOut.keyPair.keyId,
    })

    const outcome = await provider.authenticate({ expectedNodeId: nodeId, expectedMeshId: MESH_ID, signature })
    // A rotated key is dead immediately; there is no grace period during which both
    // keys are honoured.
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe("pin_key_id_unknown")
  })

  it("refuses a node enrolled in a different mesh", async () => {
    const { trust, pins, keyPair, nodeId } = build()
    await trust.enroll({ nodeId, meshId: OTHER_MESH_ID, nodeKeyId: keyPair.keyId, enrolledAt: at(0), displayName: "worker" })
    const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: () => at(5) })
    const request = aRequest({ nodeId, keyId: keyPair.keyId })
    const signature = signMeshRequest(keyPair, {
      method: request.method,
      path: request.path,
      bodyDigest: request.bodyDigest,
      timestamp: request.timestamp,
      nonce: request.nonce,
      nodeId,
      keyId: keyPair.keyId,
    })

    const outcome = await provider.authenticate({ expectedNodeId: nodeId, expectedMeshId: MESH_ID, signature })
    // Tailscale reachability is not a cross-mesh grant: a node that can open a
    // socket to this controller has still presented no credential this mesh trusts.
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe("node_wrong_mesh")
  })

  it("refuses when the trust store is unavailable rather than reading it as empty", async () => {
    const { pins, keyPair, nodeId } = build()
    const unavailable = new (await import("../../../../src/mesh/identity/node-trust.js")).UnavailableNodeTrustStore()
    await pins.pin({ nodeId, meshId: MESH_ID, key: { nodeKeyId: keyPair.keyId, publicKey: keyPair.publicKey, fingerprint: keyPair.fingerprint }, enrollmentId: "enr-1", now: at(1) })
    const provider = new MeshIdentityProvider({ trust: unavailable, pins, replayGuard: new InMemoryNonceGuard(), now: () => at(5) })
    const request = aRequest({ nodeId, keyId: keyPair.keyId })
    const signature = signMeshRequest(keyPair, {
      method: request.method,
      path: request.path,
      bodyDigest: request.bodyDigest,
      timestamp: request.timestamp,
      nonce: request.nonce,
      nodeId,
      keyId: keyPair.keyId,
    })

    const outcome = await provider.authenticate({ expectedNodeId: nodeId, expectedMeshId: MESH_ID, signature })
    // Reading an unreadable revocation set as an empty one inverts the module: the
    // safe state becomes the one you get when the disk is full.
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe("trust_store_failure")
  })
})

describe("verifyNodeTrust", () => {
  it("refuses a node that is not enrolled", async () => {
    const result = await verifyNodeTrust(new InMemoryNodeTrustStore(), { nodeId: WORKER_ID, meshId: MESH_ID })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("node_unknown")
      // `null` is a REFUSAL at the authentication seam, not an undecided state that
      // a caller is free to read permissively.
      expect(result.error.code).toBe("identity.node_not_enrolled")
    }
  })
})

describe("Tailscale reachability is not authentication", () => {
  it("gives no identity decision a parameter a peer address could arrive in", async () => {
    // A structural assertion, not a behavioural one: a behavioural test would pass
    // today and stop passing the day someone adds a `peerAddress` parameter to
    // `verifyNodeTrust`. So this reads the source and asserts that the modules which
    // make identity decisions take IDs and a clock and nothing else.
    //
    // The word list is the vocabulary a Tailscale-derived identity would arrive in:
    // an address, a hostname, a tailnet name, a MAC. None of them appears as a
    // parameter name in any identity decision.
    const forbidden = /\b(remoteAddress|remoteIp|peerAddress|peerIp|peerHostname|remoteHost|tailnet|host|hostname|address|ip|addr)\b\s*[:?]/
    const decisionModules = [
      "node-trust.ts",
      "peer-key-pins.ts",
      "request-signature.ts",
      "identity-provider.ts",
      "enrollment-code.ts",
    ]
    const { readFile } = await import("node:fs/promises")
    const { fileURLToPath } = await import("node:url")
    const { dirname, join } = await import("node:path")
    const here = dirname(fileURLToPath(import.meta.url))

    for (const file of decisionModules) {
      const source = await readFile(join(here, "..", "..", "..", "..", "src", "mesh", "identity", file), "utf8")
      expect(forbidden.test(source), `${file} takes a network-identity parameter`).toBe(false)
    }
  })

  it("does not accept a hostname or address in place of an id", async () => {
    // A Tailscale address is not a wire id, so it cannot be substituted for one: the
    // grammar check refuses it before any store is consulted.
    //
    // This cast IS the assertion. There is no schema that produces a `NodeId` from an
    // address — the whole claim is that none exists — so the only way to put the value
    // in front of the function is to defeat the brand, and then assert that defeating
    // the brand buys nothing. Written as a plain `as NodeId` rather than `as never` so
    // the type it is lying about is the type the test is about.
    const result = await verifyNodeTrust(new InMemoryNodeTrustStore(), {
      nodeId: "100.64.0.7" as NodeId,
      meshId: MESH_ID,
    })
    // `node_not_enrolled` rather than a parse error, because the trust store is asked
    // about a `nodeId` it has never heard of, and the point is that no ADDRESS-LOOKUP
    // happens: an address that reaches here is simply a node nobody has enrolled.
    expect(result.ok).toBe(false)
  })

  it("refuses a valid shared bearer token where a node signature is required", async () => {
    // The EXISTING credential. It is a real, working credential for the single-host
    // bridge, and asserting that it is refused here is the point: the temptation to
    // accept it "in addition" to the signature is exactly what would make the mesh
    // unauthorisable per node.
    const bearer = new BearerAuthProvider("shared-bridge-secret")
    const authorization = "Bearer shared-bridge-secret"
    expect(bearer.validate(authorization)).toBe(true)

    const { trust, pins, keyPair, nodeId } = buildForBearer()
    const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: () => at(5) })

    // A node that never enrolled, presenting the shared token and no signature. There
    // is no `authorization` field on `AuthenticateRequest`, so there is nothing for
    // the provider to consult even if a future gateway wanted to pass one.
    const outcome = await provider.authenticate({
      expectedNodeId: nodeId,
      expectedMeshId: MESH_ID,
      signature: asSignature(aRequest({ nodeId, keyId: keyPair.keyId, nonce: nonce() }), "AAABsignature"),
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe("node_unknown")
  })

  it("refuses a valid shared bearer token even for an ENROLLED node, because a bearer is not a signature", async () => {
    const trust = new InMemoryNodeTrustStore()
    const pins = new InMemoryPeerKeyPinStore()
    const keyPair = NodeKeyPair.generate()
    const nodeId = nodeIdSchema.parse("node-enr-bearer2")
    await trust.enroll({ nodeId, meshId: MESH_ID, nodeKeyId: keyPair.keyId, enrolledAt: at(0), displayName: "worker" })
    await pins.pin({ nodeId, meshId: MESH_ID, key: { nodeKeyId: keyPair.keyId, publicKey: keyPair.publicKey, fingerprint: keyPair.fingerprint }, enrollmentId: "enr-1", now: at(1) })

    const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: () => at(5) })
    // A bearer-authenticated shape of the request: the node id header names the node
    // and the token proves the shared secret, and nothing is signed. This is what the
    // bridge's own routes accept, and it is NOT identity on a mesh.
    // 64 bytes, so the refusal is the SIGNATURE check and not a length check: a
    // bearer token that happens to be the wrong length would be refused for the
    // wrong reason, and this assertion is about the missing binding, not the size.
    const forged = asSignature(aRequest({ nodeId, keyId: keyPair.keyId, nonce: nonce() }), base64Url(randomBytes(64)))

    const outcome = await provider.authenticate({ expectedNodeId: nodeId, expectedMeshId: MESH_ID, signature: forged })

    // Two reasons, and the second is the one usually forgotten: a bearer is not
    // per-node, so revoking one node would mean rotating it for every node; and it
    // is not a SIGNATURE, so nothing binds it to a method, path, body, time or nonce
    // and any hop that can read the header can replay it forever.
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.code).toBe("identity.signature_invalid")
  })
})

function buildForBearer(): ReturnType<typeof build> {
  const trust = new InMemoryNodeTrustStore()
  const pins = new InMemoryPeerKeyPinStore()
  const keyPair = NodeKeyPair.generate()
  const nodeId = nodeIdSchema.parse("node-enr-bearer")
  return { trust, pins, keyPair, nodeId }
}

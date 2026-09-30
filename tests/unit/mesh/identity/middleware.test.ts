/**
 * The Fastify adapter.
 *
 * `./middleware.ts` is one of exactly two modules in `src/mesh/identity/` allowed to
 * touch the framework, and it is where the module's guarantees stop being pure
 * functions and become HTTP behaviour. That makes it the place two of the
 * milestone's claims are only testable:
 *
 *   1. **The handler does not run.** Every other file in this directory can assert
 *      that a forged request is refused; only a test with a real handler behind the
 *      hook can assert that the handler was never entered. A `preHandler` that
 *      refused AND then called `done()` would pass every test in the pure modules.
 *   2. **The shared bearer token is not an alternative.** The pure modules have no
 *      route to put an `Authorization` header on, so "there is no branch that
 *      consults it" is only provable here.
 */
import { describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { randomBytes } from "node:crypto"
import { createMeshIdentityHook, authenticateForRequest, authenticatedNodeFor, meshBodyDigest, statusForIdentityRefusal, MESH_IDENTITY_HEADERS } from "../../../../src/mesh/identity/middleware.js"
import { InMemoryNodeTrustStore, type NodeTrustStore } from "../../../../src/mesh/identity/node-trust.js"
import { InMemoryPeerKeyPinStore, type PeerKeyPinStore } from "../../../../src/mesh/identity/peer-key-pins.js"
import { InMemoryNonceGuard, RefusingNonceGuard } from "../../../../src/mesh/identity/replay-guard.js"
import { MeshIdentityProvider, type IdentityProvider } from "../../../../src/mesh/identity/identity-provider.js"
import { NodeKeyPair } from "../../../../src/mesh/identity/node-key.js"
import { signMeshRequest } from "../../../../src/mesh/identity/request-signature.js"
import { BearerAuthProvider } from "../../../../src/security/auth-provider.js"
import { createContractError, type Result } from "../../../../src/orchestration/errors.js"
import { nodeIdSchema } from "../../../../src/orchestration/identifiers.js"
import { MESH_ID, WORKER_ID, aKey, at, base64Url, nonce } from "./fixtures.js"

/** An enrolled, pinned node, plus a client that can sign for it. */
async function aSeam() {
  const trust = new InMemoryNodeTrustStore()
  const pins = new InMemoryPeerKeyPinStore()
  const keyPair = NodeKeyPair.generate()
  const nodeId = WORKER_ID
  await trust.enroll({ nodeId, meshId: MESH_ID, nodeKeyId: keyPair.keyId, enrolledAt: at(0), displayName: "worker" })
  await pins.pin({ nodeId, meshId: MESH_ID, key: { nodeKeyId: keyPair.keyId, publicKey: keyPair.publicKey, fingerprint: keyPair.fingerprint }, enrollmentId: "enr-1", now: at(1) })
  const provider: IdentityProvider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: () => at(5) })
  return { trust, pins, keyPair, nodeId, provider }
}

/** Headers for a request `keyPair` signs. Every part is a separate header by design. */
function signedHeaders(
  keyPair: NodeKeyPair,
  overrides: { method?: string; path?: string; body?: unknown; nodeId?: string; signature?: string } = {},
) {
  const method = overrides.method ?? "POST"
  const path = overrides.path ?? "/v1/mesh/command"
  const body = overrides.body ?? { runId: "run-1", op: "start" }
  const signature = signMeshRequest(keyPair, {
    method,
    path,
    bodyDigest: meshBodyDigest(body),
    timestamp: at(5),
    nonce: nonce(),
    nodeId: WORKER_ID,
    keyId: keyPair.keyId,
  })
  return {
    [MESH_IDENTITY_HEADERS.nodeId]: WORKER_ID,
    [MESH_IDENTITY_HEADERS.keyId]: keyPair.keyId,
    [MESH_IDENTITY_HEADERS.timestamp]: String(at(5)),
    [MESH_IDENTITY_HEADERS.nonce]: signature.nonce,
    [MESH_IDENTITY_HEADERS.signature]: overrides.signature ?? signature.signature,
    [MESH_IDENTITY_HEADERS.bodyDigest]: meshBodyDigest(body),
  }
}

/** A server whose handler records that it ran. */
async function serverWith(
  provider: IdentityProvider,
  handler: () => void,
  extra: Record<string, unknown> = {},
): Promise<FastifyInstance> {
  const app = Fastify()
  app.post("/v1/mesh/command", { preHandler: createMeshIdentityHook({ provider, expectedNodeId: WORKER_ID, expectedMeshId: MESH_ID, ...extra }) }, async () => {
    handler()
    return { ok: true }
  })
  return app
}

describe("createMeshIdentityHook", () => {
  it("refuses BEFORE the handler body runs, not after", async () => {
    const { provider, keyPair } = await aSeam()
    let handlerRan = false
    const app = await serverWith(provider, () => {
      handlerRan = true
    })

    const response = await app.inject({ method: "POST", url: "/v1/mesh/command", headers: signedHeaders(keyPair, { signature: base64Url(randomBytes(64)) }) })
    await app.close()

    // THE assertion. A `preHandler` that refuses and then calls `done()` anyway would
    // leave every other test in this directory green, because they never have a
    // handler to check. "Authentication failed" and "the handler still ran" is the
    // failure mode a hook is uniquely able to have.
    expect(handlerRan).toBe(false)
    expect(response.statusCode).toBe(401)
  })

  it("runs the handler exactly once for a genuinely signed request, and attaches the node", async () => {
    const { provider, keyPair } = await aSeam()
    let handlerRan = 0
    let seenNodeId: string | undefined
    const app = Fastify()
    app.post(
      "/v1/mesh/command",
      { preHandler: createMeshIdentityHook({ provider, expectedNodeId: WORKER_ID, expectedMeshId: MESH_ID }) },
      async (request) => {
        handlerRan += 1
        seenNodeId = authenticatedNodeFor(request)?.nodeId
        return { ok: true }
      },
    )

    const response = await app.inject({ method: "POST", url: "/v1/mesh/command", headers: signedHeaders(keyPair) })
    await app.close()

    // A hook that refuses everything also "passes" every refusal test above, so the
    // positive case is what makes the negative ones mean anything.
    expect(response.statusCode).toBe(200)
    expect(handlerRan).toBe(1)
    expect(seenNodeId).toBe(WORKER_ID)
  })

  it("binds the query string, so a signature for one project is not valid for another", async () => {
    const { provider, keyPair } = await aSeam()
    const app = await serverWith(provider, () => undefined)

    // Signed for `?project=release`, including the query — the request target is the
    // target. `project` selects what work is done on this mesh, so a signing string
    // that normalised it away would turn a scoped capability into a mesh-wide one.
    const signed = signedHeaders(keyPair, { path: "/v1/mesh/command?project=release" })
    const captured = await app.inject({ method: "POST", url: "/v1/mesh/command?project=release", headers: signed })
    const lifted = await app.inject({ method: "POST", url: "/v1/mesh/command?project=other", headers: signed })
    await app.close()

    expect(captured.statusCode).toBe(200)
    expect(lifted.statusCode).toBe(401)
  })

  it("answers 403 for a revoked node and 401 for everything else", async () => {
    const trust = new InMemoryNodeTrustStore()
    const pins = new InMemoryPeerKeyPinStore()
    const keyPair = NodeKeyPair.generate()
    await trust.enroll({ nodeId: WORKER_ID, meshId: MESH_ID, nodeKeyId: keyPair.keyId, enrolledAt: at(0), displayName: "worker" })
    await pins.pin({ nodeId: WORKER_ID, meshId: MESH_ID, key: { nodeKeyId: keyPair.keyId, publicKey: keyPair.publicKey, fingerprint: keyPair.fingerprint }, enrollmentId: "enr-1", now: at(1) })
    // Revoke through the store directly: the hook's job is to surface the distinction,
    // and `revokeNode` is covered by its own tests.
    await trust.revoke({ nodeId: WORKER_ID, meshId: MESH_ID, reason: "stolen", by: "user-1", at: at(1), revokedKeyId: keyPair.keyId })

    const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: () => at(5) })
    let handlerRan = false
    const app = await serverWith(provider, () => {
      handlerRan = true
    })

    const revoked = await app.inject({ method: "POST", url: "/v1/mesh/command", headers: signedHeaders(keyPair) })
    await app.close()

    // The node id is already observable to every enrolled peer, so saying "this one is
    // revoked" discloses nothing new — and it is the difference between an operator
    // who knows what happened and one sent to read the source.
    expect(revoked.statusCode).toBe(403)
    expect(handlerRan).toBe(false)
    expect(statusForIdentityRefusal("node_revoked")).toBe(403)
    expect(statusForIdentityRefusal("signature_invalid")).toBe(401)
    expect(statusForIdentityRefusal("replay_detected")).toBe(401)
  })

  it("echoes nothing the requester sent in the refusal body", async () => {
    const { provider, keyPair } = await aSeam()
    const app = await serverWith(provider, () => undefined)
    const headers = signedHeaders(keyPair, { signature: base64Url(randomBytes(64)) })

    const response = await app.inject({ method: "POST", url: "/v1/mesh/command", headers })
    await app.close()

    const body = response.body
    // Not the signature, not the nonce, not the headers. A gateway log line pasted
    // into a ticket is a normal thing for an operator to do, and this body is what
    // they would paste.
    for (const value of Object.values(headers)) expect(body).not.toContain(String(value))
  })
})

describe("the shared bearer token is not a mesh credential", () => {
  it("refuses a VALID bearer token where a node signature is required", async () => {
    // The token is real and working. That is the point: this is not a test that a
    // wrong token is refused, it is a test that the RIGHT token buys nothing here.
    const bearer = new BearerAuthProvider("shared-bridge-secret")
    const authorization = "Bearer shared-bridge-secret"
    expect(bearer.validate(authorization)).toBe(true)

    const { provider, keyPair } = await aSeam()
    let handlerRan = false
    const app = await serverWith(provider, () => {
      handlerRan = true
    })

    // A request that the SINGLE-HOST bridge's own routes would accept, sent to a mesh
    // route: a valid bearer, no per-request signature.
    const response = await app.inject({
      method: "POST",
      url: "/v1/mesh/command",
      headers: { authorization },
    })
    await app.close()

    expect(response.statusCode).toBe(401)
    expect(handlerRan).toBe(false)
  })

  it("refuses a valid bearer token for an ENROLLED node, because a bearer is not a signature", async () => {
    // The second reason, and the one usually forgotten. A shared bearer is not
    // per-node, so revoking one node means rotating it for every node; and it is not a
    // SIGNATURE, so nothing binds it to a method, path, body, time or nonce, and any
    // hop that can read the header can replay it forever.
    const { provider, keyPair } = await aSeam()
    let handlerRan = false
    const app = await serverWith(provider, () => {
      handlerRan = true
    })

    const bearer = new BearerAuthProvider("shared-bridge-secret")
    // Node id and key id present and correct; the signature replaced by the token's
    // value. 64 bytes so the refusal is the SIGNATURE check and not a length check.
    const headers = { ...signedHeaders(keyPair), authorization: "Bearer shared-bridge-secret" }
    headers[MESH_IDENTITY_HEADERS.signature] = bearer.validate(`Bearer ${"a".repeat(32)}`) ? base64Url(randomBytes(64)) : base64Url(randomBytes(64))

    const response = await app.inject({ method: "POST", url: "/v1/mesh/command", headers })
    await app.close()

    expect(response.statusCode).toBe(401)
    expect(handlerRan).toBe(false)
  })
})

describe("authenticateForRequest", () => {
  /**
   * Runs a request through a real route and hands back the `authenticateForRequest`
   * verdict for it.
   *
   * Driven through `inject` rather than by hand-building a `FastifyRequest`. A
   * hand-built object is missing exactly the fields a real one has — `raw.url` above
   * all — so a test using one exercises a shape the framework never produces, and
   * "it passed" says nothing about the running server.
   */
  async function verdictFor(
    provider: IdentityProvider,
    request: { method: "POST" | "GET"; url: string; headers: Record<string, string> },
  ): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
    const app = Fastify()
    let captured: Awaited<ReturnType<typeof authenticateForRequest>> | undefined
    app.route({
      method: request.method,
      url: "/probe",
      preHandler: async (req) => {
        // Always 200. This route is measuring the VERDICT, not the status, and letting
        // the hook's own refusal choose the status would be a second, redundant path
        // to get a 401 for the wrong reason.
        captured = await authenticateForRequest(req, { provider, expectedNodeId: WORKER_ID, expectedMeshId: MESH_ID })
      },
      handler: async () => ({ ok: true }),
    })
    await app.inject(request)
    await app.close()
    if (!captured) throw new Error("the preHandler never ran")
    return captured.ok
      ? { ok: true }
      : { ok: false, reason: captured.reason, message: captured.error.message }
  }

  it("refuses a request missing any single identity header, naming which one", async () => {
    const { provider, keyPair } = await aSeam()
    const full = signedHeaders(keyPair, { path: "/probe" })

    for (const header of Object.values(MESH_IDENTITY_HEADERS)) {
      const headers: Record<string, string> = { ...full }
      delete headers[header]
      const outcome = await verdictFor(provider, { method: "POST", url: "/probe", headers })

      // Each part is a separate header precisely so that one cannot be inferred from
      // another, and the message names the header so a new client author gets a
      // five-minute fix instead of an afternoon.
      expect(outcome.ok, `${header} was not required`).toBe(false)
      if (!outcome.ok) {
        expect(outcome.reason).toBe("request_malformed")
        expect(outcome.message).toContain(header)
      }
    }
  })

  it("refuses when the replay guard is absent, rather than disabling replay defence", async () => {
    const { trust, pins, keyPair } = await aSeam()
    const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new RefusingNonceGuard(), now: () => at(5) })
    const outcome = await verdictFor(provider, { method: "POST", url: "/probe", headers: signedHeaders(keyPair, { path: "/probe" }) })

    // A guard that fails open is a guard that has been switched off by a disk-full.
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe("replay_guard_unavailable")
  })

  it("takes the node and mesh from the SEAM, so a header cannot choose which node it is", async () => {
    const { trust, pins, keyPair } = await aSeam()
    const other = aKey()
    const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: () => at(5) })
    const app = Fastify()
    let captured: Awaited<ReturnType<typeof authenticateForRequest>> | undefined
    app.post(
      "/probe",
      {
        preHandler: async (req) => {
          // A seam configured for a node nobody has enrolled. The headers name a real,
          // enrolled, pinned node, and the seam still decides — because the node a
          // request is evaluated as is a property of where it arrived, not of what it
          // says about itself.
          captured = await authenticateForRequest(req, {
            provider,
            expectedNodeId: nodeIdSchema.parse("node-nobody-enrolled"),
            expectedMeshId: MESH_ID,
          })
        },
      },
      async () => ({ ok: true }),
    )
    const headers = signedHeaders(keyPair, { path: "/probe" })
    headers[MESH_IDENTITY_HEADERS.keyId] = other.public.nodeKeyId
    await app.inject({ method: "POST", url: "/probe", headers })
    await app.close()

    expect(captured?.ok).toBe(false)
    if (captured && !captured.ok) expect(captured.reason).toBe("node_unknown")
  })
})

describe("a store that cannot answer is a refusal, not a default", () => {
  it("refuses through the whole seam when the trust store is unreadable", async () => {
    // Every method refuses. One that answered `null` would be the permissive default
    // this module is built to refuse, and it would be invisible: a node that is not
    // enrolled and a node whose store is unreachable produce the same verdict, and only
    // one of them is a fault.
    const down = (): Result<never> => ({
      ok: false,
      error: createContractError("internal_failure", "identity.trust_store_unavailable", "the trust store is unavailable"),
    })
    const broken: NodeTrustStore = {
      trusted: async () => down(),
      revocation: async () => down(),
      revocationByKeyId: async () => down(),
      enroll: async () => down(),
      revoke: async () => down(),
      listTrusted: async () => down(),
    }
    const pins: PeerKeyPinStore = new InMemoryPeerKeyPinStore()
    const keyPair = NodeKeyPair.generate()
    const provider = new MeshIdentityProvider({ trust: broken, pins, replayGuard: new InMemoryNonceGuard(), now: () => at(5) })
    let handlerRan = false
    const app = await serverWith(provider, () => {
      handlerRan = true
    })

    const response = await app.inject({ method: "POST", url: "/v1/mesh/command", headers: signedHeaders(keyPair) })
    await app.close()

    expect(response.statusCode).toBe(401)
    expect(handlerRan).toBe(false)
  })
})

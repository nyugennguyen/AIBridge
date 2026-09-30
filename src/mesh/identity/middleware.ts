import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from "fastify"
import { digestJson } from "../../orchestration/digest.js"
import { createContractError, type ContractError } from "../../orchestration/errors.js"
import type { MeshId, NodeId } from "../../orchestration/identifiers.js"
import { base64UrlSchema, nodeKeyIdSchema } from "../protocol/identifiers.js"
import { nodeIdSchema } from "../../orchestration/identifiers.js"
import type { AuthenticatedNode, IdentityProvider } from "./identity-provider.js"
import type { MeshRequestSignature } from "./request-signature.js"

/**
 * THIS MODULE IS ALLOWED TO TOUCH THE FRAMEWORK AND THE CLOCK.
 *
 * It is one of exactly two places in `src/mesh/identity/` that is (the other is
 * the filesystem key store). Everything it does that is not that — the trust
 * decision, the pin check, the signature check, the replay check — is delegated to
 * pure functions elsewhere in this directory, which is what makes the
 * fail-closed policy testable without a socket.
 *
 * Four things this adapter is responsible for, and one it is not:
 *
 *   1. Lifting the signature out of headers. A mesh request's identity travels in
 *      `x-aibridge-mesh-*` headers and nowhere else, so a body field can never be
 *      the thing that names the sender.
 *   2. Computing the body digest with the SAME canonical encoder the payload
 *      digests use. This is the one that is not optional: a sender that digested
 *      with `JSON.stringify` and a receiver that digests canonically disagree
 *      about every request, and the symptom is a signature failure that reads as
 *      a key problem.
 *   3. Turning a refusal into a status code and a body in the gateway's error
 *      contract — and putting NOTHING ELSE in that body.
 *   4. Attaching the authenticated node where a handler can read it.
 *
 * NOT its job: deciding WHICH node this socket is. That is `expectedNodeId` and
 * `expectedMeshId`, supplied by the route or the transport, because the identity
 * a request is evaluated as is a property of where it arrived.
 *
 * On the shared bearer token — the thing a reader is most tempted to wire in here:
 * `BearerAuthProvider` in `src/security/auth-provider.ts` is the EXISTING shared
 * secret for the single-host bridge, and it must NOT be accepted on a mesh route.
 * Two reasons, and the second is the one that is usually forgotten:
 *
 *   (a) It is not per-node, so revoking one node means rotating it for every
 *       node, which is exactly what the milestone forbids — "node identity is
 *       individually revocable".
 *   (b) It is not a SIGNATURE. It proves a bearer to whoever relays it, so any hop
 *       that can see the header can replay it, forever, on any mesh route. There
 *       is no method, path, body, timestamp or nonce bound to it, so a token
 *       captured from a health check authorises a command. Adding a bearer check
 *       here "in addition" to the signature would not be defence in depth: it
 *       would introduce a second, weaker credential on the same route, and one
 *       that a future operator would reasonably believe is per-node because it is
 *       described as authentication.
 *
 * So: this hook reads ONLY `x-aibridge-mesh-*`. There is no branch anywhere below
 * that consults `Authorization`, and `../../../../tests/unit/mesh/identity/
 * middleware.test.ts` drives a real Fastify server to assert that a VALID bearer token
 * is refused and that the handler behind this hook never runs.
 */

/** The headers a node signs over. Named so a gateway and a node cannot drift. */
export const MESH_IDENTITY_HEADERS = {
  nodeId: "x-aibridge-mesh-node-id",
  keyId: "x-aibridge-mesh-key-id",
  timestamp: "x-aibridge-mesh-timestamp",
  nonce: "x-aibridge-mesh-nonce",
  signature: "x-aibridge-mesh-signature",
  bodyDigest: "x-aibridge-mesh-body-digest",
} as const

export interface MeshIdentityHookOptions {
  readonly provider: IdentityProvider
  /**
   * The node and mesh this seam is for.
   *
   * Supplied per route or per server, never read from the request. A hook that
   * read them from headers would be trusting the peer to name which node it is.
   */
  readonly expectedNodeId: NodeId
  readonly expectedMeshId: MeshId
  /**
   * How the request target is spelled for signing. Defaults to the raw request
   * target INCLUDING the query string.
   *
   * The default is the security-relevant part. A "pathname only" spelling would
   * leave `?project=` and `?session=` outside the signature, and on this mesh
   * those parameters select what work is done — the signature would be valid for a
   * different project than the one it authorised.
   */
  readonly signedPath?: (request: FastifyRequest) => string
  /**
   * How the body digest is obtained. Defaults to the `x-aibridge-mesh-body-digest`
   * header, which is what a bodyless request (a WebSocket upgrade, a GET) uses.
   *
   * A gateway that wants the digest computed from the body it already parsed
   * supplies a function; it must return the digest of the SAME bytes the node
   * signed, and the default exists so that a forgetful gateway is at least
   * consistent with itself rather than accidentally signing `undefined`.
   */
  readonly bodyDigest?: (request: FastifyRequest) => string | undefined
}

/**
 * The authenticated node, keyed by request object.
 *
 * A `WeakMap` rather than a property on the request, deliberately. Declaring a
 * `meshNode` field on Fastify's `FastifyRequest` would put mesh identity into the
 * type of EVERY request in the process, including the single-host bridge's, and
 * "this request has a mesh identity" would become a question the compiler lets a
 * route answer `undefined` about. A `WeakMap` with an accessor makes the
 * distinction explicit and keeps the entries collectable.
 */
const AUTHENTICATED_NODES = new WeakMap<FastifyRequest, AuthenticatedNode>()

/** The node this request authenticated as. `undefined` before the hook has run. */
export function authenticatedNodeFor(request: FastifyRequest): AuthenticatedNode | undefined {
  return AUTHENTICATED_NODES.get(request)
}

/**
 * The gateway's error body for an identity refusal.
 *
 * A `ContractError` and nothing else. Not the request body, not the headers, not
 * the signature, not the node's public key. Every field is either a code or a
 * message written in this directory, and
 * `tests/unit/mesh/identity/no-secret-leak.test.ts` sweeps the module's error paths
 * and asserts that no private key, enrollment code or signature appears in one, so
 * the assertion about "the response leaks nothing" is a statement about code in this
 * repository rather than a habit.
 */
export interface MeshIdentityErrorBody {
  readonly error: ContractError
}

/**
 * Which HTTP status a refusal becomes.
 *
 * 401 for "we do not accept this credential": a bad signature, an unknown node, a
 * replay, a malformed request. 403 for "this credential is a real one and it is no
 * longer welcome" — which today means a revoked node.
 *
 * Revocation is answered with 403 rather than folded into the 401 bucket on
 * purpose. The node id is already observable to every enrolled peer (heartbeats,
 * `peerKeyPins`, the enrollment log), so saying "this one is revoked" discloses
 * nothing an attacker could not already see — and an operator whose node stopped
 * connecting after a revoke gets an answer that names the reason instead of one
 * that sends them to read the source. The revocation's own `reason` and `by` are
 * NOT in the body; those are operator-facing and stay in the audit log.
 */
export function statusForIdentityRefusal(reason: string): 401 | 403 {
  return reason === "node_revoked" ? 403 : 401
}

/**
 * The Fastify `preHandler` that authenticates a mesh request.
 *
 * `preHandler`, not an `onRequest` hook and not per-route code, for one reason
 * that matters: it is the FIRST thing that runs after routing, so the route has
 * already been chosen and the seam knows which node it is deciding for, while the
 * handler body has provably not begun. `onRequest` would run before routing and
 * would have to guess the seam from the URL; a per-route `preHandler` is one a
 * route author can forget, and a forgotten authentication hook is a route with no
 * authentication at all. A test asserts the handler body does not run.
 *
 * A node identity is decided on the way IN and nowhere else, which is why this
 * returns 401/403 rather than attaching a flag a later check reads.
 */
export function createMeshIdentityHook(options: MeshIdentityHookOptions): preHandlerHookHandler {
  return function meshIdentityPreHandler(request: FastifyRequest, reply: FastifyReply, done): void {
    void authenticateForRequest(request, options).then((outcome) => {
      if (outcome.ok) {
        AUTHENTICATED_NODES.set(request, outcome.value)
        done()
        return
      }
      // The reply body is the ContractError and the status. The request body, the
      // headers and the signature are not echoed — a peer that sent a forged
      // signature gets back a refusal that contains nothing of what it sent, which
      // is also why a failing gateway log line can be pasted into a ticket.
      void reply
        .code(statusForIdentityRefusal(outcome.reason))
        .send({ error: outcome.error } satisfies MeshIdentityErrorBody)
    })
  }
}

/** The `Result` flavour, for a gateway that composes rather than hooks. */
export async function authenticateForRequest(
  request: FastifyRequest,
  options: MeshIdentityHookOptions,
): Promise<{ ok: true; value: AuthenticatedNode } | { ok: false; reason: string; error: ContractError }> {
  const extracted = extractSignature(request, options)
  if (!extracted.ok) return extracted

  const outcome = await options.provider.authenticate({
    expectedNodeId: options.expectedNodeId,
    expectedMeshId: options.expectedMeshId,
    signature: extracted.value,
  })
  return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, reason: outcome.reason, error: outcome.error }
}

/**
 * Lifts a {@link MeshRequestSignature} out of the request.
 *
 * Every failure here is a REFUSAL with a message that says which header was
 * missing and why it is required, and never includes the header's value. A
 * malformed request is the most likely thing a new client sends, and a message
 * that names the header is the difference between a five-minute fix and an
 * afternoon; a message that echoes the value would be a signature in a log the
 * first time someone pastes a request into an issue.
 */
function extractSignature(
  request: FastifyRequest,
  options: MeshIdentityHookOptions,
): { ok: true; value: MeshRequestSignature } | { ok: false; reason: string; error: ContractError } {
  const headers = request.headers
  const nodeId = nodeIdSchema.safeParse(headerValue(headers[MESH_IDENTITY_HEADERS.nodeId]))
  if (!nodeId.success) return missingHeader(MESH_IDENTITY_HEADERS.nodeId, "the node this request is for")
  const keyId = nodeKeyIdSchema.safeParse(headerValue(headers[MESH_IDENTITY_HEADERS.keyId]))
  if (!keyId.success) return missingHeader(MESH_IDENTITY_HEADERS.keyId, "which of the node's pinned keys signed it")
  const timestamp = Number(headerValue(headers[MESH_IDENTITY_HEADERS.timestamp]))
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    return missingHeader(MESH_IDENTITY_HEADERS.timestamp, "when the request was signed, in epoch milliseconds")
  }
  const nonce = headerValue(headers[MESH_IDENTITY_HEADERS.nonce])
  if (nonce === undefined) return missingHeader(MESH_IDENTITY_HEADERS.nonce, "the one-time value that makes this request unrepeatable")
  const signature = base64UrlSchema.safeParse(headerValue(headers[MESH_IDENTITY_HEADERS.signature]))
  if (!signature.success) return missingHeader(MESH_IDENTITY_HEADERS.signature, "the node's ed25519 signature over the request")

  const suppliedDigest = options.bodyDigest?.(request)
  const declaredDigest = suppliedDigest ?? headerValue(headers[MESH_IDENTITY_HEADERS.bodyDigest])
  if (declaredDigest === undefined) {
    return missingHeader(MESH_IDENTITY_HEADERS.bodyDigest, "the digest of the body the signature covers")
  }
  if (suppliedDigest === undefined) {
    // THE DEFAULT IS A CLAIM UNTIL IT IS CHECKED, and this is the line that makes
    // it a check rather than a claim.
    //
    // With no `bodyDigest` supplied, the digest the signature covers is the one in
    // the HEADER, so the signature proves "somebody holding this node's key vouched
    // for a body with this digest" — and says nothing about the body that actually
    // arrived. A hop that can rewrite the body (a relay on the mesh, a proxy, a
    // compromised peer between two nodes) therefore swaps the payload and keeps every
    // header, and the whole authenticated request verifies: the same 200, the same
    // nonce, the same key, over a command the node never signed. That is precisely
    // the substitution the module comment above names as the reason `bodyDigest` is
    // in the signing string at all, and the default configuration defeated it.
    //
    // The check is HERE, in the same cheap phase as the header checks, and before the
    // provider: an unauthenticated request must not be able to burn a legitimate
    // node's one-time nonce, and a SHA-256 over an already-parsed body is cheaper
    // than the ed25519 verification it precedes.
    //
    // A route that supplies its own `bodyDigest` is not double-checked. That function
    // is documented to return the digest of the bytes the node signed, so the
    // signature already covers the body and there is nothing left to compare.
    const arrived = arrivedBodyDigest(request)
    if (arrived !== null && arrived !== declaredDigest) {
      return {
        ok: false,
        reason: "body_digest_mismatch",
        error: createContractError(
          "policy_denied",
          "identity.body_digest_mismatch",
          "The request body does not hash to the digest its signature covers. The signature is bound to a body digest, so a body that does not match it is a body nobody signed — whether that is a relay rewriting the payload or a sender that digested something other than what it sent, the request is refused rather than acted on.",
        ),
      }
    }
  }

  const path = options.signedPath?.(request) ?? request.raw.url ?? request.url
  return {
    ok: true,
    value: {
      method: request.method,
      path,
      bodyDigest: declaredDigest,
      timestamp,
      nonce,
      signature: signature.data,
      nodeId: nodeId.data,
      // `nodeKeyIdSchema` is the protocol's own branded schema, so its output IS a
      // `NodeKeyId`. Written without a cast deliberately: a cast here would be a
      // place where the brand could be laundered, and this is the one function every
      // mesh request's identity passes through.
      keyId: keyId.data,
    },
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return undefined
  return value
}

/**
 * The digest of the body that actually arrived, or `null` when none did.
 *
 * `null` rather than a digest of `null` for the bodyless case, because the two are
 * different facts: a GET and a WebSocket upgrade carry no body and are authenticated
 * over a declared digest the sender chose for them (see the `bodyDigest` option),
 * while a POST that carries one is authenticated over the body itself. A
 * bodyless request is therefore never refused here — a route whose clients sign
 * `digestJson(null)` for an upgrade keeps working, and a route that sends a real
 * body gets the body checked.
 *
 * Digesting the PARSED body rather than the raw bytes is deliberate and is what
 * makes the check exact rather than approximate: Fastify has already parsed it, so
 * whitespace, key order and number spelling in transit cannot make a faithful
 * request fail, and the digest is computed by the same `canonicalJson` the payload
 * digests use.
 */
function arrivedBodyDigest(request: FastifyRequest): string | null {
  const body = (request as { readonly body?: unknown }).body
  if (body === undefined) return null
  return meshBodyDigest(body)
}

function missingHeader(header: string, what: string): { ok: false; reason: string; error: ContractError } {
  return {
    ok: false,
    reason: "request_malformed",
    error: createContractError(
      "validation",
      "identity.header_missing",
      `The '${header}' header is required: it is ${what}. Mesh requests are authenticated by a per-request node signature, and each of its parts is a separate header so that a part cannot be inferred from another. The bridge's shared bearer token is not accepted here — see the comment in ./middleware.ts.`,
    ),
  }
}

/**
 * The digest a node signs for a body, on the node's side.
 *
 * Exported so a node's HTTP client and a test compute it the same way the
 * receiver does. The alternative — each side calling `digestJson` and hoping they
 * agree — has produced a signature failure that reads as a key compromise, and
 * will produce one again.
 */
export function meshBodyDigest(body: unknown): string {
  return digestJson(body ?? null)
}

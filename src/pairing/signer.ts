/**
 * Client side of request signing (Phase 3, ADR 0012): the headers a node
 * attaches to an outbound `/trigger`, `/report` or `/enroll`.
 *
 * Reuses the mesh signing string (`signMeshRequest`) and header names
 * (`MESH_IDENTITY_HEADERS`) so the bridge verifies with exactly the code the
 * mesh gateway uses. A signature is minted per transmission (fresh timestamp
 * and nonce), so a retried callback is a new signed request, not a replay.
 *
 * Never returns, logs or embeds key material: the output is the public
 * signature headers only.
 */
import { randomBytes } from "node:crypto"
import { nodeIdSchema } from "../orchestration/identifiers.js"
import type { NodeKeyPair } from "../mesh/identity/node-key.js"
import { MESH_IDENTITY_HEADERS, meshBodyDigest } from "../mesh/identity/middleware.js"
import { signMeshRequest } from "../mesh/identity/request-signature.js"
import { loadNodeKey } from "./files.js"

export interface RequestSigner {
  /** Signature headers for one request, or `{}` when this node has no key. */
  headersFor(method: string, url: string, body: unknown): Promise<Record<string, string>>
}

/** Signature headers for a request whose body is `body` (a parsed value, or `null`). */
export function signedRequestHeaders(input: {
  readonly key: NodeKeyPair
  readonly agentId: string
  readonly method: string
  readonly url: string
  readonly body: unknown
  readonly now: number
  readonly nonce?: string
}): Record<string, string> {
  const nodeId = nodeIdSchema.parse(input.agentId)
  const target = new URL(input.url)
  const signature = signMeshRequest(input.key, {
    method: input.method.toUpperCase(),
    path: `${target.pathname}${target.search}`,
    bodyDigest: meshBodyDigest(input.body),
    timestamp: input.now,
    nonce: input.nonce ?? randomBytes(24).toString("base64url"),
    nodeId,
    keyId: input.key.keyId,
  })
  return {
    [MESH_IDENTITY_HEADERS.nodeId]: signature.nodeId,
    [MESH_IDENTITY_HEADERS.keyId]: signature.keyId,
    [MESH_IDENTITY_HEADERS.timestamp]: String(signature.timestamp),
    [MESH_IDENTITY_HEADERS.nonce]: signature.nonce,
    [MESH_IDENTITY_HEADERS.signature]: signature.signature,
    [MESH_IDENTITY_HEADERS.bodyDigest]: signature.bodyDigest,
  }
}

/** Parses a JSON request body the way the receiving Fastify parser will. */
export function bodyForDigest(body: unknown): unknown {
  if (body === undefined || body === null) return null
  if (typeof body === "string") {
    if (body.length === 0) return null
    return JSON.parse(body) as unknown
  }
  return JSON.parse(JSON.stringify(body)) as unknown
}

/**
 * A signer for a profile: loads `<stateDir>/identity/self.node-key.json`
 * lazily (a key created by `aibr enroll` after the bridge started is picked up
 * on the next request) and signs as `agentId`. No key, or an agent id that is
 * not a wire id, means unsigned requests -- the receiver decides whether that
 * is acceptable (`security.request_signing`).
 */
export function createProfileRequestSigner(options: {
  readonly stateDir: string
  readonly agentId: string
  readonly now?: () => number
  readonly loadKey?: (stateDir: string) => Promise<NodeKeyPair | null>
}): RequestSigner {
  const loadKey = options.loadKey ?? loadNodeKey
  const now = options.now ?? Date.now
  let cached: NodeKeyPair | null = null
  return {
    async headersFor(method, url, body) {
      if (!nodeIdSchema.safeParse(options.agentId).success) return {}
      if (cached === null) {
        try {
          cached = await loadKey(options.stateDir)
        } catch {
          // An unsafe or corrupt key file is not used; the request goes unsigned
          // and a `required` receiver refuses it, which surfaces the problem.
          return {}
        }
      }
      if (cached === null) return {}
      return signedRequestHeaders({ key: cached, agentId: options.agentId, method, url, body: bodyForDigest(body), now: now() })
    },
  }
}

/**
 * Server side of request signing for `/trigger` and `/report` (Phase 3,
 * ADR 0012).
 *
 * Runs AFTER the bearer check (defence in depth: with `auth_mode:
 * "bearer-token"` both are required) and BEFORE any source/capability check, so
 * `source_agent_id` is decided by the verified key rather than by the body.
 *
 * The cryptographic decision is the mesh one, unchanged:
 * `authenticateForRequest` (header extraction + body-digest binding) ->
 * `MeshIdentityProvider` (revocation -> trust -> pin -> ed25519 -> replay).
 * The node id header only SELECTS which pinned key the signature must verify
 * against; a peer can therefore only claim an agent id whose private key it
 * holds.
 */
import type { FastifyRequest } from "fastify"
import { nodeIdSchema } from "../orchestration/identifiers.js"
import { MeshIdentityProvider } from "../mesh/identity/identity-provider.js"
import { MESH_IDENTITY_HEADERS, authenticateForRequest } from "../mesh/identity/middleware.js"
import { InMemoryNonceGuard } from "../mesh/identity/replay-guard.js"
import type { ReplayGuard } from "../mesh/identity/request-signature.js"
import type { RequestSigningMode } from "../config/types.js"
import { FilePeerStore, PAIRING_MESH, pinStoreOf } from "./peer-store.js"

export interface IdentityRefusal {
  readonly ok: false
  readonly status: 401 | 403
  readonly body: { readonly error: string; readonly code: string }
}

export type IdentityCheck = { readonly ok: true; readonly agentId: string | null } | IdentityRefusal

export interface RequestIdentityGuard {
  readonly mode: RequestSigningMode
  /**
   * `claimedAgentId` is the body's sender id (`source_agent_id` on both
   * `/trigger` and `/report`). When the request is signed it must equal the
   * verified key's enrolled agent id.
   */
  check(request: FastifyRequest, claimedAgentId: unknown): Promise<IdentityCheck>
}

/** Refusals that mean "a real credential this node does not (or no longer) trusts". */
const FORBIDDEN_REASONS: ReadonlySet<string> = new Set([
  "node_unknown",
  "node_revoked",
  "node_wrong_mesh",
  "pin_missing",
  "pin_key_id_unknown",
  "pin_key_mismatch",
  "pin_node_mismatch",
  "pin_mesh_mismatch",
])

export function hasSignatureHeaders(headers: FastifyRequest["headers"]): boolean {
  return Object.values(MESH_IDENTITY_HEADERS).some((name) => headers[name] !== undefined)
}

export function createRequestIdentityGuard(options: {
  readonly mode: RequestSigningMode
  readonly peers: FilePeerStore
  readonly replayGuard?: ReplayGuard
  readonly now?: () => number
}): RequestIdentityGuard {
  const provider = new MeshIdentityProvider({
    trust: options.peers,
    pins: pinStoreOf(options.peers),
    replayGuard: options.replayGuard ?? new InMemoryNonceGuard(),
    now: options.now ?? Date.now,
  })
  const mode = options.mode

  return {
    mode,
    async check(request, claimedAgentId) {
      if (mode === "off") return { ok: true, agentId: null }
      if (!hasSignatureHeaders(request.headers)) {
        if (mode === "optional") return { ok: true, agentId: null }
        return refuse(
          401,
          "signature_required",
          "This bridge requires signed requests (security.request_signing: required). Pair this node with `aibr enroll join <code>` so its requests carry a node signature.",
        )
      }
      const header = request.headers[MESH_IDENTITY_HEADERS.nodeId]
      const nodeId = nodeIdSchema.safeParse(Array.isArray(header) ? undefined : header)
      if (!nodeId.success) {
        return refuse(401, "identity.header_missing", `The '${MESH_IDENTITY_HEADERS.nodeId}' header is missing or not a valid agent id.`)
      }
      const outcome = await authenticateForRequest(request, {
        provider,
        expectedNodeId: nodeId.data,
        expectedMeshId: PAIRING_MESH,
      })
      if (!outcome.ok) {
        const forbidden = FORBIDDEN_REASONS.has(outcome.reason)
        return refuse(
          forbidden ? 403 : 401,
          outcome.error.code,
          forbidden
            ? `The signing key for "${nodeId.data}" is not pinned on this node (or was revoked). Pair it with \`aibr enroll\`. (${outcome.error.message})`
            : outcome.error.message,
        )
      }
      const verified = outcome.value.nodeId as string
      if (typeof claimedAgentId === "string" && claimedAgentId !== verified) {
        return refuse(
          403,
          "identity.source_mismatch",
          `source_agent_id "${claimedAgentId}" does not match the verified signing identity "${verified}". The sender is decided by the key, not by the body.`,
        )
      }
      return { ok: true, agentId: verified }
    },
  }
}

/**
 * The guard a route uses. A config that asks for signing without a guard
 * wired in is a wiring fault, reported when the app is built rather than as a
 * silently unenforced policy.
 */
export function requireIdentityGuard(
  mode: RequestSigningMode | undefined,
  guard: RequestIdentityGuard | undefined,
): RequestIdentityGuard | undefined {
  const effective = mode ?? "off"
  if (effective === "off") return guard
  if (guard === undefined) {
    throw new Error(
      `security.request_signing is "${effective}" but no request identity guard was supplied to the app; refusing to serve /trigger and /report without verifying signatures.`,
    )
  }
  if (guard.mode !== effective) {
    throw new Error(`The request identity guard is in "${guard.mode}" mode but the config says "${effective}".`)
  }
  return guard
}

function refuse(status: 401 | 403, code: string, error: string): IdentityRefusal {
  return { ok: false, status, body: { error, code } }
}

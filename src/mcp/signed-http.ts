/**
 * Request signing for the Claude Code plugin's MCP client (Phase 3, ADR 0012).
 *
 * One entry point, `prepareSignedRequest`, called from `BridgeTools.http` for
 * every authenticated call (POST /trigger, GET /jobs/:id). It:
 *   1. swaps in the per-peer bearer token written by `aibr enroll join`
 *      (`secrets/peers/<id>.bearer_token`) when one exists for the target, and
 *   2. adds node-signature headers when the profile has a node key
 *      (`<stateDir>/identity/self.node-key.json`).
 *
 * Key material never leaves this module: only the public signature headers are
 * returned, and the per-peer token is reported back so the caller can add it to
 * its redaction list.
 */
import type { ProfilePaths } from "../host/paths.js"
import { loadNodeKey, peerBearerTokenPath } from "../pairing/files.js"
import { bodyForDigest, signedRequestHeaders } from "../pairing/signer.js"
import type { NodeKeyPair } from "../mesh/identity/node-key.js"

export interface SigningProfile {
  readonly paths: ProfilePaths
  readonly config: { readonly agent_id: string; readonly agents: readonly { readonly id: string; readonly url: string }[] }
}

export interface PreparedRequest {
  readonly init: RequestInit
  /** Secrets used for this request that must be redacted from any output. */
  readonly secrets: readonly string[]
}

export interface SignedHttpDeps {
  readonly readFile: (path: string) => Promise<string>
  readonly now: () => number
  readonly loadKey?: (stateDir: string) => Promise<NodeKeyPair | null>
}

export async function prepareSignedRequest(
  profile: SigningProfile,
  url: string,
  init: RequestInit,
  deps: SignedHttpDeps,
): Promise<PreparedRequest> {
  const headers: Record<string, string> = { ...headersRecord(init.headers) }
  const secrets: string[] = []

  const peer = profile.config.agents.find((agent) => sameOrigin(agent.url, url))
  if (peer !== undefined) {
    try {
      const token = (await deps.readFile(peerBearerTokenPath(profile.paths.secretsDir, peer.id))).trim()
      if (token !== "") {
        headers.authorization = `Bearer ${token}`
        secrets.push(token)
      }
    } catch {
      // no per-peer token: the profile's shared token stays
    }
  }

  let key: NodeKeyPair | null = null
  try {
    key = await (deps.loadKey ?? loadNodeKey)(profile.paths.stateDir)
  } catch {
    key = null // an unsafe key file is not used; a `required` worker then answers 401
  }
  if (key !== null) {
    try {
      Object.assign(
        headers,
        signedRequestHeaders({
          key,
          agentId: profile.config.agent_id,
          method: init.method ?? "GET",
          url,
          body: bodyForDigest(init.body),
          now: deps.now(),
        }),
      )
    } catch {
      // agent_id is not a wire id: send unsigned
    }
  }
  return { init: { ...init, headers }, secrets }
}

function headersRecord(headers: RequestInit["headers"]): Record<string, string> {
  if (headers === undefined) return {}
  const out: Record<string, string> = {}
  new Headers(headers).forEach((value, name) => {
    out[name] = value
  })
  return out
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

import { timingSafeEqual } from "node:crypto"
import type { AuthMode } from "../config/types.js"

export interface AuthProvider {
  validate(authorizationHeader: string | undefined): boolean
}

export class BearerAuthProvider implements AuthProvider {
  constructor(private readonly token: string) {
    if (token.length === 0) {
      // An empty bearer token validates every request carrying "Bearer " -- the
      // buffers compare equal at length 0 -- so refusing it here is the only
      // place that can be done without inspecting a caller's reasoning.
      throw new Error("BearerAuthProvider requires a non-empty token")
    }
  }

  validate(authorizationHeader: string | undefined): boolean {
    if (!authorizationHeader?.startsWith("Bearer ")) return false
    const received = Buffer.from(authorizationHeader.slice("Bearer ".length))
    const expected = Buffer.from(this.token)
    return received.length === expected.length && timingSafeEqual(received, expected)
  }
}

/**
 * Authenticates nothing. Every request is accepted.
 *
 * Only reachable through a config whose `security.auth_mode` is `"none"`, which
 * `aibr setup` refuses to author for a bridge that is not bound to a Tailscale
 * CGNAT address. It is a real mode rather than an absence of a provider so the
 * decision is visible in one call site instead of being implied by a null token
 * that some other call site forgot to check.
 */
export class OpenAuthProvider implements AuthProvider {
  validate(_authorizationHeader: string | undefined): boolean {
    return true
  }
}

/**
 * Constant-time comparison of a request's bearer credential against one specific
 * secret, without selecting an auth mode.
 *
 * The orchestration seam asks a DIFFERENT question than `AuthProvider.validate`:
 * not "is this caller admitted?" (the provider answers that) but "does this
 * caller hold the OPERATOR credential?" — the sole authority for user-kind
 * `actor` claims. ADR 0008 §4: authorization must rest on authenticated state,
 * never on self-asserted payload fields. The shared bearer secret admits peers
 * and carries no per-caller identity, so a payload claiming `kind: "user"` is
 * only as trustworthy as the credential checked here.
 */
export function bearerTokenMatches(authorizationHeader: string | undefined, token: string | null): boolean {
  if (token === null || token.length === 0) return false
  if (!authorizationHeader?.startsWith("Bearer ")) return false
  const received = Buffer.from(authorizationHeader.slice("Bearer ".length))
  const expected = Buffer.from(token)
  return received.length === expected.length && timingSafeEqual(received, expected)
}

/**
 * Selects the auth provider for a config's auth mode.
 *
 * FAILS CLOSED rather than defaulting. `auth_mode: "bearer-token"` with no token
 * to compare against is a broken profile, not an open one: silently selecting
 * `OpenAuthProvider` here would turn "the secret file is missing" into "every
 * request is authorized", which is the exact failure the bearer check exists to
 * prevent. So the mismatch throws, and the caller's process refuses to start.
 */
export function createAuthProvider(mode: AuthMode, bearerToken: string | null): AuthProvider {
  if (mode === "none") return new OpenAuthProvider()
  if (bearerToken === null || bearerToken.length === 0) {
    throw new Error(
      `security.auth_mode is "${mode}" but no bearer token is available. ` +
        `Restore the bearer token secret, or set auth_mode to "none" deliberately.`,
    )
  }
  return new BearerAuthProvider(bearerToken)
}

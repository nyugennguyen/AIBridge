/**
 * Authorization for the operator endpoints (approve / reject / pending /
 * stop-all): the OPERATOR credential, never the peer bearer, and by default
 * only from this host.
 *
 * The peer bearer admits machines; it says nothing about a human. Approval is
 * the one decision a peer must not be able to make for itself, so these routes
 * accept only `Authorization: Bearer <AIBRIDGE_OPERATOR_TOKEN>` (constant-time
 * compare) and refuse everything else with 403, including a valid peer bearer.
 *
 * "This host" means loopback OR one of this machine's own interface addresses:
 * the bridge usually binds the Tailscale address only, so `aibr approve`
 * running on the worker connects from that same address. A tailnet peer has a
 * different source address, and WireGuard authenticates source addresses, so
 * it cannot pass for this host.
 */
import { networkInterfaces } from "node:os"
import type { BridgeConfig } from "../config/types.js"
import { bearerTokenMatches } from "./auth-provider.js"

export type OperatorDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly statusCode: 401 | 403; readonly body: { readonly error: string; readonly code: string } }

/** Strips an IPv4-mapped IPv6 prefix so `::ffff:127.0.0.1` compares as `127.0.0.1`. */
export function normalizeAddress(address: string): string {
  const lower = address.toLowerCase()
  return lower.startsWith("::ffff:") && lower.includes(".") ? lower.slice("::ffff:".length) : lower
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeAddress(address)
  return normalized === "::1" || normalized.startsWith("127.")
}

/** Every address configured on this host's interfaces. */
export function localInterfaceAddresses(): ReadonlySet<string> {
  const addresses = new Set<string>()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(normalizeAddress(entry.address))
  }
  return addresses
}

export interface OperatorAuthOptions {
  readonly config: BridgeConfig
  readonly operatorToken: string | null
  /** This host's own addresses; injectable for tests. */
  readonly localAddresses?: () => ReadonlySet<string>
}

export function authorizeOperatorRequest(
  options: OperatorAuthOptions,
  request: { readonly headers: { readonly authorization?: string | undefined }; readonly ip: string },
): OperatorDecision {
  if (options.operatorToken === null || options.operatorToken.length === 0) {
    return {
      ok: false,
      statusCode: 403,
      body: {
        error: "No operator credential is configured on this node (AIBRIDGE_OPERATOR_TOKEN or secrets/operator_token).",
        code: "operator_not_configured",
      },
    }
  }
  const authorization = request.headers.authorization
  if (authorization === undefined || authorization.length === 0) {
    return { ok: false, statusCode: 401, body: { error: "Unauthorized", code: "operator_credential_required" } }
  }
  if (!bearerTokenMatches(authorization, options.operatorToken)) {
    // A valid PEER bearer lands here too: it admits machines, not operators.
    return { ok: false, statusCode: 403, body: { error: "Operator credential required", code: "operator_credential_required" } }
  }
  const localOnly = options.config.security.approval_from_loopback_only ?? true
  if (localOnly) {
    const address = normalizeAddress(request.ip)
    const local = isLoopbackAddress(address) || (options.localAddresses ?? localInterfaceAddresses)().has(address)
    if (!local) {
      return {
        ok: false,
        statusCode: 403,
        body: { error: "Operator actions are accepted only from this node itself", code: "operator_not_local" },
      }
    }
  }
  return { ok: true }
}

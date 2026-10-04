/**
 * M7.8 / F-02 / SEC-06 / SF-17: Egress origin binding and destination authorization.
 *
 * ## The invariant this module defends
 *
 * > **An unlisted origin is rejected BEFORE any `Authorization` header is constructed.**
 *
 * `F-02` (High) was that `CallbackReporter.send` attached the node bearer token
 * to any caller-supplied `callback_url` validated only for URL syntax.
 *
 * This module binds destination origins against `config.agents[].url` before
 * any request is dispatched, forbids cross-origin redirects, and pins IP
 * addresses to Tailscale CGNAT (`100.64.0.0/10`) or local loopback.
 */

export class UnlistedOriginError extends Error {
  readonly code = "EGRESS_UNLISTED_ORIGIN"
  constructor(message: string) {
    super(message)
    this.name = "UnlistedOriginError"
  }
}

export class CrossOriginRedirectError extends Error {
  readonly code = "EGRESS_CROSS_ORIGIN_REDIRECT"
  constructor(message: string) {
    super(message)
    this.name = "CrossOriginRedirectError"
  }
}

export class NonCgnatAddressError extends Error {
  readonly code = "EGRESS_NON_CGNAT_ADDRESS"
  constructor(message: string) {
    super(message)
    this.name = "NonCgnatAddressError"
  }
}

export interface AgentOriginConfig {
  readonly id: string
  readonly url: string
}

/**
 * Checks whether an IPv4 address falls within the Tailscale CGNAT subnet (100.64.0.0/10)
 * or local loopback (127.0.0.0/8).
 */
export function isAllowedIp(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part))
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false
  }

  // Loopback 127.0.0.0/8
  if (parts[0] === 127) return true

  // Tailscale CGNAT: 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true

  return false
}

/**
 * Resolves and validates the destination origin against configured agents.
 *
 * MUST be called before constructing any `Authorization` header.
 */
export function assertDestinationOriginAllowed(
  callbackUrl: string,
  agents: readonly AgentOriginConfig[],
): { readonly origin: string; readonly targetUrl: URL; readonly agent: AgentOriginConfig } {
  let targetUrl: URL
  try {
    targetUrl = new URL(callbackUrl)
  } catch {
    throw new UnlistedOriginError(`Invalid callback URL: ${callbackUrl}`)
  }

  const origin = targetUrl.origin

  // Find matching agent origin in config.agents
  const matchingAgent = agents.find((agent) => {
    try {
      const agentUrl = new URL(agent.url)
      return agentUrl.origin === origin
    } catch {
      return false
    }
  })
  if (!matchingAgent) {
    throw new UnlistedOriginError(
      `Destination origin '${origin}' does not match any configured agent. Rejecting before Authorization construction.`,
    )
  }

  // If hostname is an IPv4 address, enforce Tailscale CGNAT (100.64.0.0/10) or loopback
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(targetUrl.hostname) && !isAllowedIp(targetUrl.hostname)) {
    throw new NonCgnatAddressError(
      `Destination IP address '${targetUrl.hostname}' is not in Tailscale CGNAT subnet (100.64.0.0/10)`,
    )
  }

  return { origin, targetUrl, agent: matchingAgent }
}

/**
 * Performs a fetch that forbids cross-origin redirects.
 *
 * Uses `redirect: "manual"` to intercept redirects and refuse cross-origin hops.
 */
export async function safeEgressFetch(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  targetUrl: string,
  init: RequestInit,
  expectedOrigin: string,
): Promise<Response> {
  const response = await fetcher(targetUrl, {
    ...init,
    redirect: "manual",
  })

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location")
    if (location) {
      let redirectUrl: URL
      try {
        redirectUrl = new URL(location, targetUrl)
      } catch {
        throw new CrossOriginRedirectError(`Malformed redirect location: '${location}'`)
      }

      if (redirectUrl.origin !== expectedOrigin) {
        throw new CrossOriginRedirectError(
          `Cross-origin redirect to '${redirectUrl.origin}' rejected (expected '${expectedOrigin}')`,
        )
      }
    }
  }

  return response
}

import { describe, expect, it } from "vitest"
import type { BridgeConfig } from "../../../src/config/types.js"
import { authorizeOperatorRequest, isLoopbackAddress, normalizeAddress } from "../../../src/security/operator-auth.js"
import { sanitizeChildProcessEnv, CLAUDE_PROVIDER_ENV_KEYS } from "../../../src/runtime/sanitizer.js"
import { testConfig } from "../../integration/fixtures.js"

const TOKEN = "operator-secret-value"

function check(
  request: { authorization?: string; ip?: string },
  options: { token?: string | null; config?: BridgeConfig; local?: string[] } = {},
) {
  return authorizeOperatorRequest(
    {
      config: options.config ?? testConfig(),
      operatorToken: options.token === undefined ? TOKEN : options.token,
      localAddresses: () => new Set(options.local ?? ["100.64.0.3"]),
    },
    { headers: { authorization: request.authorization }, ip: request.ip ?? "127.0.0.1" },
  )
}

describe("authorizeOperatorRequest", () => {
  it("accepts the operator token from loopback and from this host's own address", () => {
    expect(check({ authorization: `Bearer ${TOKEN}` })).toEqual({ ok: true })
    expect(check({ authorization: `Bearer ${TOKEN}`, ip: "::1" })).toEqual({ ok: true })
    expect(check({ authorization: `Bearer ${TOKEN}`, ip: "::ffff:127.0.0.1" })).toEqual({ ok: true })
    expect(check({ authorization: `Bearer ${TOKEN}`, ip: "100.64.0.3" })).toEqual({ ok: true })
  })

  it("refuses the peer bearer with 403 and a missing credential with 401", () => {
    expect(check({ authorization: "Bearer peer-bearer" })).toMatchObject({ ok: false, statusCode: 403 })
    expect(check({ authorization: `Bearer ${TOKEN}x` })).toMatchObject({ ok: false, statusCode: 403 })
    expect(check({})).toMatchObject({ ok: false, statusCode: 401 })
  })

  it("fails closed when no operator token is configured", () => {
    expect(check({ authorization: "Bearer " }, { token: null })).toMatchObject({ ok: false, statusCode: 403, body: { code: "operator_not_configured" } })
    expect(check({ authorization: "Bearer " }, { token: "" })).toMatchObject({ ok: false, statusCode: 403 })
  })

  it("refuses another machine unless approval_from_loopback_only is false", () => {
    expect(check({ authorization: `Bearer ${TOKEN}`, ip: "100.64.0.9" })).toMatchObject({ ok: false, statusCode: 403, body: { code: "operator_not_local" } })
    const config = testConfig()
    const open = { ...config, security: { ...config.security, approval_from_loopback_only: false } }
    expect(check({ authorization: `Bearer ${TOKEN}`, ip: "100.64.0.9" }, { config: open })).toEqual({ ok: true })
  })

  it("normalizes addresses", () => {
    expect(normalizeAddress("::FFFF:10.0.0.1")).toBe("10.0.0.1")
    expect(isLoopbackAddress("127.0.0.2")).toBe(true)
    expect(isLoopbackAddress("10.0.0.1")).toBe(false)
  })
})

describe("the operator token never reaches a Claude or script child", () => {
  it("is stripped by the child-environment sanitizer, with or without provider keys allowed", () => {
    const env = { PATH: "/bin", AIBRIDGE_OPERATOR_TOKEN: TOKEN, AIBRIDGE_BEARER_TOKEN: "b", ANTHROPIC_API_KEY: "k" }
    const claude = sanitizeChildProcessEnv(env, CLAUDE_PROVIDER_ENV_KEYS)
    expect(claude).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "k" })
    const script = sanitizeChildProcessEnv(env, [])
    expect(script).toEqual({ PATH: "/bin" })
  })
})

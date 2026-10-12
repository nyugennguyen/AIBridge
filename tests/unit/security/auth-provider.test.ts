import { describe, expect, it } from "vitest"
import {
  BearerAuthProvider,
  OpenAuthProvider,
  createAuthProvider,
} from "../../../src/security/auth-provider.js"

describe("BearerAuthProvider", () => {
  it("accepts a matching bearer token", () => {
    const provider = new BearerAuthProvider("secret")

    expect(provider.validate("Bearer secret")).toBe(true)
  })

  it("rejects missing or incorrect bearer tokens", () => {
    const provider = new BearerAuthProvider("secret")

    expect(provider.validate(undefined)).toBe(false)
    expect(provider.validate("Basic secret")).toBe(false)
    expect(provider.validate("Bearer wrong")).toBe(false)
  })

  it("refuses an empty token rather than accepting everything", () => {
    // A zero-length secret compares equal to any other zero-length secret, so
    // "Bearer " would validate. Refusing it at construction is cheaper than
    // auditing every caller for the case.
    expect(() => new BearerAuthProvider("")).toThrow("non-empty token")
  })
})

describe("OpenAuthProvider", () => {
  it("accepts every request, including one with no header at all", () => {
    const provider = new OpenAuthProvider()

    expect(provider.validate(undefined)).toBe(true)
    expect(provider.validate("Bearer anything")).toBe(true)
  })
})

describe("createAuthProvider", () => {
  it("returns a bearer provider by default, so an existing config is unchanged", () => {
    const provider = createAuthProvider("bearer-token", "secret")

    expect(provider.validate("Bearer secret")).toBe(true)
    expect(provider.validate(undefined)).toBe(false)
  })

  it("returns an open provider in none mode, even with no token at all", () => {
    const provider = createAuthProvider("none", null)

    expect(provider.validate(undefined)).toBe(true)
  })

  it("fails closed when bearer-token mode has no secret", () => {
    // The whole point: a missing secret file must not become an open bridge.
    expect(() => createAuthProvider("bearer-token", null)).toThrow("no bearer token is available")
    expect(() => createAuthProvider("bearer-token", "")).toThrow("no bearer token is available")
  })

  it("ignores a stale token left behind in none mode", () => {
    // `aibr setup` refuses to author this, but a hand-edited config can produce
    // it: the secret is never read, and the mode the operator chose is honoured.
    const provider = createAuthProvider("none", "leftover-secret")

    expect(provider.validate(undefined)).toBe(true)
  })
})

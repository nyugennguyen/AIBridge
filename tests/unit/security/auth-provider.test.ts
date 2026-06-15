import { describe, expect, it } from "vitest"
import { BearerAuthProvider } from "../../../src/security/auth-provider.js"

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
})

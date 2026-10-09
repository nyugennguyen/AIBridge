import { describe, expect, it } from "vitest"

import { DEFAULT_OPENCODE_PORT, resolveOpencodePort } from "../../../src/host/opencode-port.js"

function profile(port: number): { opencode: { server_port: number } } {
  return { opencode: { server_port: port } }
}

describe("resolveOpencodePort", () => {
  // This is the bug: a profile on 4097 launched opencode on 4096 instead, and
  // the resulting failure named neither the port nor the conflict.
  it("uses the port the profile configures", () => {
    expect(resolveOpencodePort(profile(4097), {})).toBe("4097")
  })

  it("lets OPENCODE_PORT override the profile", () => {
    expect(resolveOpencodePort(profile(4097), { OPENCODE_PORT: "5000" })).toBe("5000")
  })

  it("falls back to 4096 when the profile is absent", () => {
    expect(resolveOpencodePort(undefined, {})).toBe(DEFAULT_OPENCODE_PORT)
  })

  it("falls back to 4096 when the env var is empty", () => {
    expect(resolveOpencodePort(profile(4097), { OPENCODE_PORT: "" })).toBe("4097")
  })

  it("ignores a nonsensical configured port rather than passing it to a spawn", () => {
    expect(resolveOpencodePort(profile(0), {})).toBe(DEFAULT_OPENCODE_PORT)
    expect(resolveOpencodePort(profile(-1), {})).toBe(DEFAULT_OPENCODE_PORT)
  })
})
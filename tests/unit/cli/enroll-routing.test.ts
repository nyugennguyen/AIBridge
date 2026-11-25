import { describe, expect, it } from "vitest"
import { runCli, type CliDeps } from "../../../src/cli.js"
import { parseEnrollArgs, runEnrollCommand } from "../../../src/cli/enroll.js"
import { decodePairingCode, encodePairingCode, parseTtl } from "../../../src/pairing/pairing-code.js"

function deps(extra: Partial<CliDeps>): { deps: CliDeps; out: () => string } {
  const chunks: string[] = []
  const base = { writer: (s: string) => chunks.push(s), isTTY: false, ...extra }
  return { deps: base as unknown as CliDeps, out: () => chunks.join("") }
}

describe("aibr enroll routing", () => {
  it("passes enroll argv through untouched (the code is positional)", async () => {
    let seen: readonly string[] = []
    const { deps: d } = deps({ runEnroll: async (a) => ((seen = a), 0) })
    expect(await runCli(["enroll", "join", "aibr1-abc", "--profile", "dev"], d)).toBe(0)
    expect(seen).toEqual(["join", "aibr1-abc", "--profile", "dev"])
  })

  it("prints enroll help and lists enroll in the global help", async () => {
    const { deps: d, out } = deps({ runEnroll: async () => 99 })
    expect(await runCli(["enroll", "--help"], d)).toBe(0)
    expect(out()).toContain("aibr enroll issue")
    const global = deps({})
    await runCli(["--help"], global.deps)
    expect(global.out()).toMatch(/enroll\s+Pair nodes/)
  })

  it("rejects an unknown subcommand and flag with a usage exit code", async () => {
    const out: string[] = []
    const d = { env: { HOME: "/nonexistent-home" }, fetch, now: Date.now, write: (t: string) => void out.push(t) }
    expect(await runEnrollCommand(["bogus"], d)).toBe(64)
    expect(await runEnrollCommand(["issue", "--nope"], d)).toBe(64)
    expect(out.join("")).toContain("unknown flag --nope")
  })

  it("parses flags in both spellings", () => {
    const parsed = parseEnrollArgs(["issue", "--capabilities=investigate,run-tests", "-p", "w", "--ttl", "5m"])
    expect(parsed.sub).toBe("issue")
    expect(parsed.flags.get("--capabilities")).toBe("investigate,run-tests")
    expect(parsed.flags.get("--profile")).toBe("w")
    expect(parsed.flags.get("--ttl")).toBe("5m")
  })
})

describe("pairing code", () => {
  it("round-trips and rejects garbage", () => {
    const code = encodePairingCode({ url: "http://100.64.0.2:8787", secret: "A".repeat(24), keyId: "key-0123456789abcdef" })
    expect(code.startsWith("aibr1-")).toBe(true)
    expect(decodePairingCode(code)).toEqual({ ok: true, value: { url: "http://100.64.0.2:8787", secret: "A".repeat(24), keyId: "key-0123456789abcdef" } })
    expect(decodePairingCode("aibr1-!!").ok).toBe(false)
    expect(decodePairingCode(encodePairingCode({ url: "file:///etc", secret: "A".repeat(24), keyId: "key-0123456789abcdef" })).ok).toBe(false)
  })

  it("parses TTLs", () => {
    expect(parseTtl("10m")).toBe(600_000)
    expect(parseTtl("1h")).toBe(3_600_000)
    expect(parseTtl("90s")).toBe(90_000)
    expect(parseTtl("5")).toBe(300_000)
    expect(parseTtl("soon")).toBeNull()
    expect(parseTtl("0m")).toBeNull()
  })
})

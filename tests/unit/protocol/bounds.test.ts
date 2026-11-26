import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import {
  MAX_COMMAND_PAYLOAD_BYTES,
  MAX_ENVELOPE_BYTES,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_HEARTBEAT_AGE_MS,
  MAX_RULE_PATTERN_LENGTH,
  REPLAY_WINDOW_MS,
  canonicalByteLength,
} from "../../../src/mesh/protocol/bounds.js"
import { ARRAY_MAX, protocolVersionListSchema } from "../../../src/mesh/protocol/identifiers.js"
import { evaluateReplayWindow } from "../../../src/mesh/protocol/envelope.js"

/**
 * §6 of the spec: the resource bounds and their stated values.
 *
 * The record families that applied most of these bounds (command, event,
 * heartbeat, the registry's single parse entry point, the rule-pattern analyser)
 * were removed in 3.2.0 (D4). What is still applied by code that runs is the
 * replay window, which request signing uses, and the canonical byte measure.
 */

const T1 = "2026-09-28T00:00:10.000Z"
const T2 = "2026-09-28T00:00:20.000Z"
const T1_MS = Date.parse(T1)
const T2_MS = Date.parse(T2)

describe("the §6 table, value for value", () => {
  it("exports every bound at exactly the value the spec states", () => {
    const stated: Record<string, number> = {
      MAX_ENVELOPE_BYTES: 262_144,
      MAX_COMMAND_PAYLOAD_BYTES: 131_072,
      MAX_EVENT_PAYLOAD_BYTES: 131_072,
      REPLAY_WINDOW_MS: 300_000,
      MAX_HEARTBEAT_AGE_MS: 90_000,
      MAX_RULE_PATTERN_LENGTH: 128,
    }
    const actual: Record<string, number> = {
      MAX_ENVELOPE_BYTES,
      MAX_COMMAND_PAYLOAD_BYTES,
      MAX_EVENT_PAYLOAD_BYTES,
      REPLAY_WINDOW_MS,
      MAX_HEARTBEAT_AGE_MS,
      MAX_RULE_PATTERN_LENGTH,
    }
    expect(actual).toEqual(stated)
  })
})

describe("canonical byte length", () => {
  it("measures CANONICAL bytes, which is the same measure the digest covers", () => {
    const ascii = "a".repeat(100)
    expect(canonicalByteLength({ ascii })).toBe(JSON.stringify({ ascii }).length)
    // 100 CJK characters are 300 UTF-8 bytes; a limit counting characters would
    // be off by three on exactly the content an attacker would choose.
    expect(canonicalByteLength({ cjk: "字".repeat(100) })).toBeGreaterThan(canonicalByteLength({ cjk: "a".repeat(100) }))
  })
})

describe("REPLAY_WINDOW_MS", () => {
  it("is the skew allowance on issuedAt, applied to the exact millisecond", () => {
    const envelope = { issuedAt: T2, expiresAt: "2026-09-28T01:00:00.000Z" }
    expect(evaluateReplayWindow(envelope, T2_MS - REPLAY_WINDOW_MS).ok).toBe(true)
    const over = evaluateReplayWindow(envelope, T2_MS - REPLAY_WINDOW_MS - 1)
    expect(over.ok).toBe(false)
    expect(over.ok === false && over.reason).toBe("not_yet_valid")
    expect(over.ok === false && over.error.message).toContain(String(REPLAY_WINDOW_MS))
  })

  it("accepts a record inside its window", () => {
    expect(evaluateReplayWindow({ issuedAt: T1, expiresAt: T2 }, T1_MS).ok).toBe(true)
  })
})

describe("the protocol module is pure", () => {
  it("reads no clock, no randomness and no I/O anywhere under src/mesh/protocol", () => {
    const directory = new URL("../../../src/mesh/protocol/", import.meta.url)
    const forbidden = [
      /\bDate\.now\b/,
      /\bnew Date\(\s*\)/,
      /\bMath\.random\b/,
      /\brandomUUID\b/,
      /from\s+"node:fs/,
      /from\s+"node:net/,
      /from\s+"node:http/,
      /from\s+"node:crypto/,
      /\bfetch\(/,
      /\bprocess\./,
    ]
    const files = [...readdirSync(directory).filter((name) => name.endsWith(".ts"))].sort()
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(new URL(file, directory), "utf8")
      // Comments are allowed to NAME these things; only executable code is forbidden.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${file} matches ${pattern}`).toBe(false)
      }
    }
  })

  it("depends on nothing outside src/orchestration", () => {
    const directory = new URL("../../../src/mesh/protocol/", import.meta.url)
    const allowed = /^(\.\.\/){2}orchestration\/[\w./-]+\.js$|^\.\.?\/[\w./-]+\.js$|^zod$/
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(new URL(file, directory), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
      for (const match of source.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
        expect(match[1], `${file} imports ${match[1]}`).toMatch(allowed)
      }
    }
  })
})

describe("bounds that are not in the §6 table", () => {
  it("the collection and version-list bounds are named and applied", () => {
    expect(ARRAY_MAX).toBe(128)
    // One more than the list bound is refused, and the list is also de-duplicated.
    expect(protocolVersionListSchema.safeParse(Array.from({ length: 65 }, (_, i) => i + 1)).success).toBe(false)
    expect(protocolVersionListSchema.safeParse([1, 1]).success).toBe(false)
  })
})

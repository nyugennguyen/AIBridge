/**
 * M7.6 backoff policy parity test: asserts that the TypeScript policy
 * produces identical outputs to the 16/16 golden vectors committed in
 * `router/tests/backoff-parity-vector.json`.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  backoffDelayMs,
  exceedsMaxAttempts,
  totalBackoffMs,
  DELIVERY_BACKOFF_MS,
  MAX_DELIVERY_BACKOFF_MS,
  MESH_OUTBOX_CLAIM_LEASE_MS,
  MESH_OUTBOX_MAX_ATTEMPTS,
} from "../../../../src/mesh/outbox/policy.js"

interface GoldenVector {
  failed_attempts: number
  expected_delay_ms: number
  exceeds_max: boolean
}

const VECTOR_PATH = fileURLToPath(new URL("../../../../router/tests/backoff-parity-vector.json", import.meta.url))

describe("M7.6 backoff policy parity with router", () => {
  const vectors: GoldenVector[] = JSON.parse(readFileSync(VECTOR_PATH, "utf8"))

  it("asserts exactly 16 golden vectors in [1, 16]", () => {
    expect(vectors).toHaveLength(16)
  })

  it("all 16 golden vectors match backoffDelayMs and exceedsMaxAttempts", () => {
    for (const vector of vectors) {
      expect(
        backoffDelayMs(vector.failed_attempts),
        `backoff delay for attempt ${vector.failed_attempts}`,
      ).toBe(vector.expected_delay_ms)

      expect(
        exceedsMaxAttempts(vector.failed_attempts),
        `exceedsMaxAttempts for attempt ${vector.failed_attempts}`,
      ).toBe(vector.exceeds_max)
    }
  })

  it("attempt 0 is refused with an error in TypeScript", () => {
    expect(() => backoffDelayMs(0)).toThrow(/requires a positive attempt count/)
  })

  it("constants match the Rust definitions exactly", () => {
    expect(DELIVERY_BACKOFF_MS).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 300_000,
    ])
    expect(MAX_DELIVERY_BACKOFF_MS).toBe(300_000)
    expect(MESH_OUTBOX_MAX_ATTEMPTS).toBe(8)
    expect(MESH_OUTBOX_CLAIM_LEASE_MS).toBe(30_000)
    expect(totalBackoffMs()).toBe(127_000)
  })
})

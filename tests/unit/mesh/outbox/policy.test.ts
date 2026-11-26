import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  DELIVERY_BACKOFF_MS,
  MESH_OUTBOX_CLAIM_LEASE_MS,
  MESH_OUTBOX_MAX_ATTEMPTS,
  MAX_DELIVERY_BACKOFF_MS,
  backoffDelayMs,
  describeDeliveryFailure,
  exceedsMaxAttempts,
  nextAttemptAt,
  terminalDeliveryError,
  totalBackoffMs,
} from "../../../../src/mesh/outbox/policy.js"

/**
 * The delivery policy shared by the egress outbox (`src/callback/egress-outbox.ts`),
 * the ingress drainer (`src/ingress/drainer.ts`) and, by port, the Rust router
 * (`router/src/policy.rs`). These are the pure policy cases that used to live in
 * the mesh deliverer's test file; the deliverer itself was removed in 3.2.0 (D4).
 *
 * The tests assert the EXACT schedule rather than "it backs off": the numbers
 * are what an operator acts on when a delivery is stuck.
 */

const POLICY_SOURCE = readFileSync(join(import.meta.dirname, "../../../../src/mesh/outbox/policy.ts"), "utf8")
const T0_MS = Date.parse("2026-09-28T00:00:00.000Z")
const at = (seconds: number): number => T0_MS + seconds * 1000
const iso = (ms: number): string => new Date(ms).toISOString()

describe("the backoff schedule is exactly doubling to a 300s ceiling", () => {
  it("is 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s and then 300s", () => {
    expect(DELIVERY_BACKOFF_MS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 300_000])
  })

  it("doubles until the ceiling and holds there", () => {
    for (let attempts = 1; attempts <= 8; attempts += 1) {
      expect(backoffDelayMs(attempts), `after attempt ${attempts}`).toBe(1_000 * 2 ** (attempts - 1))
    }
    expect(backoffDelayMs(9)).toBe(MAX_DELIVERY_BACKOFF_MS)
    expect(backoffDelayMs(50)).toBe(MAX_DELIVERY_BACKOFF_MS)
  })

  it("never returns a delay above the ceiling, whatever the attempt count", () => {
    for (let attempts = 1; attempts <= 100; attempts += 1) {
      expect(backoffDelayMs(attempts)).toBeLessThanOrEqual(MAX_DELIVERY_BACKOFF_MS)
    }
  })

  it("refuses a non-positive attempt count rather than returning a silent zero", () => {
    // A zero backoff on a malformed attempt count is a hot loop against a record
    // that cannot be delivered. Throwing is the loud direction.
    expect(() => backoffDelayMs(0)).toThrow()
    expect(() => backoffDelayMs(-1)).toThrow()
    expect(() => backoffDelayMs(1.5)).toThrow()
  })

  it("the schedule is longer than the threshold, because they answer different questions", () => {
    expect(DELIVERY_BACKOFF_MS.length).toBeGreaterThan(MESH_OUTBOX_MAX_ATTEMPTS)
  })

  it("the whole retry lifecycle is 127s, which is under the 300s ceiling", () => {
    expect(totalBackoffMs()).toBe(127_000)
    expect(totalBackoffMs()).toBeLessThan(MAX_DELIVERY_BACKOFF_MS)
    expect(totalBackoffMs()).toBeLessThan(180_000)
  })

  it("the claim lease is 30 seconds", () => {
    expect(MESH_OUTBOX_CLAIM_LEASE_MS).toBe(30_000)
  })

  it("the numbers are stated with their reasoning in the module", () => {
    expect(POLICY_SOURCE).toMatch(/127 seconds/)
    expect(POLICY_SOURCE).toMatch(/300s ceiling/)
    expect(POLICY_SOURCE).toMatch(/Not jittered/)
  })
})

describe("the threshold is exactly 8 attempts", () => {
  it("is eight", () => {
    expect(MESH_OUTBOX_MAX_ATTEMPTS).toBe(8)
  })

  it("goes terminal on the eighth failure and requeues the seventh", () => {
    for (let attempts = 1; attempts < MESH_OUTBOX_MAX_ATTEMPTS; attempts += 1) {
      expect(exceedsMaxAttempts(attempts), `${attempts} attempts`).toBe(false)
    }
    expect(exceedsMaxAttempts(MESH_OUTBOX_MAX_ATTEMPTS)).toBe(true)
    expect(exceedsMaxAttempts(MESH_OUTBOX_MAX_ATTEMPTS + 1)).toBe(true)
  })

  it("a terminal error names the id, the count, and says the record is retained", () => {
    const error = terminalDeliveryError("mevt-evt-x", 8, new Error("ECONNRESET"))
    expect(error.code).toBe("mesh.outbox_poison_record")
    expect(error.retryable).toBe(false)
    expect(error.message).toContain("mevt-evt-x")
    expect(error.message).toContain("failed 8 deliveries")
    expect(error.message).toContain("RETAINED")
  })
})

describe("a delivery failure is described without leaking the payload", () => {
  it("describes a failure by its CODE", () => {
    const coded = Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" })
    expect(describeDeliveryFailure(coded)).toBe("ECONNRESET")
    expect(describeDeliveryFailure(new TypeError("x"))).toBe("TypeError")
    expect(describeDeliveryFailure("a string")).toBe("a string")
    expect(describeDeliveryFailure({ weird: true })).toBe("an unknown error")
  })

  it("builds the next deadline through the kernel's timestamp schema", () => {
    expect(nextAttemptAt(at(0), 1)).toBe(iso(at(1)))
    // The delay after attempt 7 is 64s; the cumulative wait across the first
    // seven is 127s, which is what `totalBackoffMs` reports.
    expect(nextAttemptAt(at(0), 7)).toBe(iso(at(64)))
    expect(Date.parse(nextAttemptAt(at(0), 7)) - at(0)).toBe(64_000)
    expect(totalBackoffMs()).toBe(127_000)
  })
})

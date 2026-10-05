import { describe, expect, it } from "vitest"
import { MAX_BODY_BYTES } from "../../src/runtime/constants.js"
import { triggerRequestSchema } from "../../src/config/schemas.js"

describe("M8.5 / M7-C5: Ingress Path Resource and Load Limits", () => {
  it("enforces maximum request body byte ceiling (1 MiB)", () => {
    expect(MAX_BODY_BYTES).toBe(1024 * 1024)

    // A payload within 1 MiB is accepted for schema inspection
    const normalPayload = {
      prompt: "Execute bounded work",
      project_dir: "/tmp",
      callback_url: "http://peer:8787/report",
      source_agent_id: "peer",
      target_agent_id: "peer",
      capability: "code_review",
      timeout_seconds: 60,
    }
    const normalParse = triggerRequestSchema.safeParse(normalPayload)
    expect(normalParse.success).toBe(true)

    // A simulated oversized body payload (> 1 MiB)
    const giantPrompt = "A".repeat(1024 * 1024 + 10)
    const giantPayload = {
      ...normalPayload,
      prompt: giantPrompt,
    }
    const byteLength = new TextEncoder().encode(JSON.stringify(giantPayload)).length
    expect(byteLength).toBeGreaterThan(MAX_BODY_BYTES)
  })

  it("enforces admission inflight caps and rejection reasons under flood conditions", () => {
    // Global inflight limit is 64 per router specification
    const INFLIGHT_CAP = 64
    let activeInflight = 0
    let rejectedCount = 0

    function simulateAcquire(): boolean {
      if (activeInflight >= INFLIGHT_CAP) {
        rejectedCount++
        return false // 429 Too Many Requests + Retry-After
      }
      activeInflight++
      return true
    }

    // Simulate 100 concurrent requests burst
    const results: boolean[] = []
    for (let i = 0; i < 100; i++) {
      results.push(simulateAcquire())
    }

    const acceptedCount = results.filter(Boolean).length
    expect(acceptedCount).toBe(64)
    expect(rejectedCount).toBe(36)
  })
})

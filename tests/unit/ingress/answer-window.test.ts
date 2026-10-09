/**
 * The answer window must outlast the idle settle window.
 *
 * A model that takes half a minute to produce its first token spends that whole
 * gap reporting `idle`. It trips the settle window first, then has to survive the
 * answer window too. If the two windows are close together, a slow-but-working
 * model is indistinguishable from a dead turn -- which is exactly what happened
 * with `opencode/big-pickle` on 2026-10-10: settled at 17:46:07.560, first
 * message at 17:46:32.124, answer discarded.
 */
import { describe, expect, it } from "vitest"

import { ANSWER_GRACE_MS, MIN_ANSWER_GRACE_MS } from "../../../src/ingress/answer-window.js"
import { DEFAULT_IDLE_SETTLE_MS } from "../../../src/opencode/monitor.js"

describe("answer window", () => {
  it("is materially longer than the idle settle window", () => {
    expect(ANSWER_GRACE_MS).toBeGreaterThan(DEFAULT_IDLE_SETTLE_MS * 5)
  })

  // The specific failure: a 3s settle plus a 5s answer window gave a working
  // model 8.8s to produce its first token. It needed 33s.
  it("covers a first token far slower than the settle window", () => {
    expect(ANSWER_GRACE_MS).toBeGreaterThanOrEqual(30_000)
  })

  it("keeps a floor so the two windows cannot collapse together", () => {
    expect(MIN_ANSWER_GRACE_MS).toBeGreaterThan(DEFAULT_IDLE_SETTLE_MS)
    expect(ANSWER_GRACE_MS).toBeGreaterThanOrEqual(MIN_ANSWER_GRACE_MS)
  })
})
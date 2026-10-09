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
    expect(ANSWER_GRACE_MS).toBeGreaterThan(DEFAULT_IDLE_SETTLE_MS)
  })

  // The specific failure: a 3s settle plus a 5s answer window gave a working
  // model 8.8s to produce its first token. It needed 33s.
  it("covers a first token far slower than the settle window", () => {
    expect(ANSWER_GRACE_MS).toBeGreaterThanOrEqual(30_000)
  })

  it("keeps a floor so the two windows cannot collapse together", () => {
    expect(MIN_ANSWER_GRACE_MS).toBeGreaterThan(0)
    expect(ANSWER_GRACE_MS).toBeGreaterThanOrEqual(MIN_ANSWER_GRACE_MS)
  })
})

describe("idle settle window", () => {
  // Measured, not guessed. On 2026-10-10 `opencode/big-pickle` left a 47-second
  // gap between two messages of a single turn (17:50:31 -> 17:51:18). A 3s window
  // read that gap as the end of the turn and discarded the answer. Anything under
  // a minute will misread a tool call on this model as a finished turn.
  it("clears the longest tool-call gap observed from a real agent", () => {
    expect(DEFAULT_IDLE_SETTLE_MS).toBeGreaterThanOrEqual(60_000)
  })
})
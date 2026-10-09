/**
 * What counts as "the turn said something".
 *
 * ## Why counting messages was not enough
 *
 * The first version of the empty-turn guard counted assistant messages, which
 * looked right and was not. When a turn dies mid-flight opencode still stores an
 * assistant message -- one with no parts. Observed live against
 * `AI_APICallError: Invalid API Key`: `user: parts=[text]`, `assistant: parts=[]`.
 * A message-counting guard reported `completed` on a turn that produced nothing,
 * which is the exact bug it was written to close.
 *
 * A part is where output lives. An assistant message with no non-empty text part
 * is a turn that failed before saying anything.
 */
import { describe, expect, it } from "vitest"

import { countAnsweringAssistantMessages } from "../../../src/opencode/answer.js"

function assistant(...parts: Array<Record<string, unknown>>): unknown {
  return { info: { role: "assistant" }, parts }
}

const text = (value: string): Record<string, unknown> => ({ type: "text", text: value })

describe("countAnsweringAssistantMessages", () => {
  it("counts an assistant message that has text", () => {
    expect(countAnsweringAssistantMessages([assistant(text("hello"))])).toBe(1)
  })

  // The regression: opencode stores an assistant message with no parts when a turn
  // fails, and counting it as an answer reports a dead turn as completed.
  it("does not count an assistant message with no parts", () => {
    expect(countAnsweringAssistantMessages([{ info: { role: "assistant" }, parts: [] }])).toBe(0)
  })

  it("does not count a whitespace-only text part", () => {
    expect(countAnsweringAssistantMessages([assistant(text("   \n "))])).toBe(0)
  })

  it("counts a tool-only assistant message as no answer", () => {
    expect(countAnsweringAssistantMessages([assistant({ type: "tool", tool: "read" })])).toBe(0)
  })

  it("ignores user messages", () => {
    const user = { info: { role: "user" }, parts: [text("hi")] }
    expect(countAnsweringAssistantMessages([user])).toBe(0)
  })

  it("counts a real answer alongside a failed earlier turn", () => {
    expect(
      countAnsweringAssistantMessages([
        { info: { role: "assistant" }, parts: [] },
        assistant(text("recovered")),
      ]),
    ).toBe(1)
  })

  it("returns 0 for a session with no messages", () => {
    expect(countAnsweringAssistantMessages([])).toBe(0)
  })

  it("returns 0 when the response is not a list", () => {
    expect(countAnsweringAssistantMessages(null)).toBe(0)
    expect(countAnsweringAssistantMessages(undefined)).toBe(0)
    expect(countAnsweringAssistantMessages({ messages: [] })).toBe(0)
  })

  it("tolerates malformed entries rather than throwing", () => {
    expect(countAnsweringAssistantMessages([null, 42, "x", { parts: [] }])).toBe(0)
  })
})
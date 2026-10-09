/**
 * Did this turn actually say anything?
 *
 * ## Why counting messages was not enough
 *
 * The first version of the empty-turn guard counted assistant messages, which
 * looked right and was not. When a turn dies mid-flight opencode still stores an
 * assistant message -- one with no parts. Observed live against
 * `AI_APICallError: Invalid API Key`: `user: parts=[text]`, `assistant: parts=[]`.
 * A message-counting guard therefore reported `completed` on a turn that produced
 * nothing, which is the exact bug it was written to close.
 *
 * A part is where output lives. An assistant message with no non-empty text part
 * is a turn that failed before saying anything.
 */

interface UnknownRecord {
  readonly [key: string]: unknown
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null
}

/**
 * Count assistant messages that carry actual text.
 *
 * Pure, and separated from the SDK call, because the rule worth pinning is the
 * one about what counts as an answer -- not the request that fetches it.
 */
export function countAnsweringAssistantMessages(messages: unknown): number {
  if (!Array.isArray(messages)) return 0

  let count = 0
  for (const message of messages) {
    if (!isRecord(message)) continue
    const info = message["info"]
    if (!isRecord(info) || info["role"] !== "assistant") continue

    const parts = message["parts"]
    if (!Array.isArray(parts)) continue

    // A text part with only whitespace is not an answer either: it is what a
    // turn that emitted a newline and then failed leaves behind.
    const saidSomething = parts.some((part) => {
      if (!isRecord(part)) return false
      if (part["type"] !== "text") return false
      const text = part["text"]
      return typeof text === "string" && text.trim() !== ""
    })

    if (saidSomething) count += 1
  }
  return count
}
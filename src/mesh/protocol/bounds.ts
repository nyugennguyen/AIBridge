import { canonicalJson } from "../../orchestration/digest.js"

/**
 * Every resource bound the mesh protocol enforces, in one place.
 *
 * These are named exports rather than literals because a bound that only exists
 * inside a handler is a bound nobody can assert. `bounds.test.ts` states each
 * value here, and each family schema or evaluator below actually applies it, so
 * "we have a limit" is a claim the test suite either proves or contradicts.
 *
 * The sizes are measured against CANONICAL JSON, not against a particular
 * serialization: a limit defined against one encoder's framing is a limit the
 * next encoder silently evades, and canonical bytes are also what the payload
 * digest is computed over, so the number the limit is checked against and the
 * number the integrity check covers are the same number.
 */
export const MAX_ENVELOPE_BYTES = 262_144

export const MAX_TERMINAL_FRAME_BYTES = 65_536

export const MAX_TERMINAL_BUFFER_BYTES = 1_048_576

export const MAX_TERMINAL_FRAMES_PER_SECOND = 512

export const MAX_VIEWERS_PER_TERMINAL = 16

export const MAX_COMMAND_PAYLOAD_BYTES = 131_072

export const MAX_EVENT_PAYLOAD_BYTES = 131_072

export const REPLAY_WINDOW_MS = 300_000

export const MAX_HEARTBEAT_AGE_MS = 90_000

export const MAX_RULE_PATTERN_LENGTH = 128

/**
 * Canonical byte length of a value.
 *
 * `TextEncoder` is a language global rather than a `node:` import, which keeps
 * this module inside the pure protocol boundary while still measuring real
 * UTF-8 bytes instead of JS string length — a 256-character string of CJK
 * characters is 768 bytes, and a limit that counted the former would be off by
 * three on exactly the content an attacker would choose.
 */
export function canonicalByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).length
}

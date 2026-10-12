/**
 * The shared `tskey-` guard.
 *
 * This module exists because `aibr discover` and `aibr setup` each carried their
 * own copy of the rule, and duplicated redaction logic is the kind that passes
 * review because each copy reads as deliberate. The tests below pin the behaviour
 * both call sites depend on, so a future edit has one place to break loudly.
 */

import { describe, expect, it } from "vitest"
import {
  isCredentialShapedAgentId,
  scrubCredentialShapedAgentId,
} from "../../../src/cli/discovery-safety.js"

describe("isCredentialShapedAgentId", () => {
  it("matches a tskey value", () => {
    expect(isCredentialShapedAgentId("tskey-abcdef123456")).toBe(true)
  })

  it("matches a near miss that the redaction corpus would not", () => {
    // `src/memory/redaction/detectors.ts` requires a {20,} body. This is
    // deliberately looser, because the failure directions are not symmetric:
    // a false positive costs one peer reported as unidentified (recoverable),
    // a false negative puts a credential on a terminal (not recoverable).
    expect(isCredentialShapedAgentId("tskey-short")).toBe(true)
    expect(isCredentialShapedAgentId("tskey-")).toBe(true)
  })

  it("matches regardless of case", () => {
    expect(isCredentialShapedAgentId("TSKEY-abcdef123456")).toBe(true)
  })

  it("does not match an ordinary agent id", () => {
    expect(isCredentialShapedAgentId("worker-vps")).toBe(false)
    expect(isCredentialShapedAgentId("dev-main")).toBe(false)
    // The prefix must be anchored: an id that merely CONTAINS the token is a
    // different string and is reported honestly.
    expect(isCredentialShapedAgentId("not-a-tskey-value")).toBe(false)
    expect(isCredentialShapedAgentId("")).toBe(false)
  })

  it("does not match a null id", () => {
    expect(isCredentialShapedAgentId(null)).toBe(false)
  })
})

describe("scrubCredentialShapedAgentId", () => {
  it("answers null for a credential-shaped id", () => {
    expect(scrubCredentialShapedAgentId("tskey-abcdef123456")).toBeNull()
  })

  it("passes an ordinary id through unchanged", () => {
    expect(scrubCredentialShapedAgentId("worker-vps")).toBe("worker-vps")
  })

  it("leaves null alone rather than widening it", () => {
    expect(scrubCredentialShapedAgentId(null)).toBeNull()
  })
})

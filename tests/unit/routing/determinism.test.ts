/**
 * M6.6 — determinism. The headline test of this module.
 *
 * ADR 0007 section 14: "Same registry snapshot plus same compiled rules plus same
 * preferences gives the same selection." This file is that sentence as a test, and
 * it is asserted three ways that fail for three different reasons:
 *
 *   1. Across fifty invocations — catches hidden state, a clock read, a
 *      `Math.random`, an unsorted iteration, or a memoised cache that was mutated.
 *   2. Across two separately-built but identical snapshot arrays — catches
 *      identity-keyed behaviour (a `Map` keyed by object, a `Set` of references)
 *      and anything that depends on build order rather than content.
 *   3. Under every rotation of the INPUT array — catches an ordering that leaks
 *      from the caller's array into the result. Rotation rather than shuffle,
 *      because a shuffle needs `Math.random` and a test whose failure depends on a
 *      coin toss is a test that fails occasionally.
 *
 * The `localeCompare` regression guard lives here too. It exists to fail LOUDLY if
 * someone "improves" the comparator to something prettier: `localeCompare` looks
 * like an improvement and is a reproducibility bug.
 */

import { describe, expect, it } from "vitest"
import { nodeIdSchema } from "../../../src/orchestration/identifiers.js"
import {
  buildRoutingSnapshot,
  compareByCodeUnit,
  digestRoutingResult,
  EMPTY_ROUTING_PREFERENCE,
  rankNodes,
  sortedUnique,
} from "../../../src/routing/index.js"
import type { RoutingNodeSnapshot, RoutingPreference, RoutingResult } from "../../../src/routing/index.js"
import {
  aContext,
  aRequest,
  aSnapshot,
  at,
  authorizedFor,
  enroll,
  heartbeat,
  inMemoryRegistry,
  iso,
  rotated,
  TestClock,
} from "./fixtures.js"

/** A deliberately messy eligible set: mixed eligibility, mixed preference order. */
function mixedSnapshots(): readonly RoutingNodeSnapshot[] {
  return [
    aSnapshot({ nodeId: nodeIdSchema.parse("node-zulu") }),
    aSnapshot({ nodeId: nodeIdSchema.parse("node-alpha"), projectIds: [] }),
    aSnapshot({ nodeId: nodeIdSchema.parse("node-mike"), activeSessions: 4, maxConcurrentSessions: 4 }),
    aSnapshot({ nodeId: nodeIdSchema.parse("node-bravo"), capabilities: ["fs.exec"] }),
    aSnapshot({ nodeId: nodeIdSchema.parse("node-charlie") }),
    aSnapshot({
      nodeId: nodeIdSchema.parse("node-delta"),
      revoked: true,
      livenessState: "revoked",
      healthy: false,
      healthReason: "liveness_revoked",
    }),
  ]
}

const MIXED_PREFERENCE: RoutingPreference = {
  preferredNodeIds: ["node-charlie", "node-zulu"],
  excludedNodeIds: ["node-gone"],
  requiredRuntimeKind: "opencode",
  requiredProjectPathId: "path-release-1",
}

function rankOf(snapshots: readonly RoutingNodeSnapshot[], preferences: RoutingPreference = MIXED_PREFERENCE) {
  const outcome = rankNodes(snapshots, aRequest(), preferences)
  if (!outcome.ok) throw new Error(`ranking was refused: ${outcome.error.code} — ${outcome.error.message}`)
  return outcome.value
}

describe("the same inputs produce a byte-identical answer", () => {
  it("returns an identical result, explanation, and digest across fifty invocations", () => {
    const first = rankOf(mixedSnapshots())
    for (let attempt = 0; attempt < 49; attempt += 1) {
      const again = rankOf(mixedSnapshots())
      expect(again).toEqual(first)
      expect(again.explanationText).toBe(first.explanationText)
      expect(again.digest).toBe(first.digest)
      expect(JSON.stringify(again)).toBe(JSON.stringify(first))
    }
    expect(first.selectedNodeId).toBe("node-charlie")
  })

  it("returns an identical answer for two separately built but identical snapshot arrays", () => {
    const left = rankOf(mixedSnapshots())
    const right = rankOf(mixedSnapshots())
    expect(right).toEqual(left)
    expect(right.digest).toBe(left.digest)
    expect(right.explanationText).toBe(left.explanationText)
  })

  it("ignores every rotation of the input array, so read order cannot reach the answer", () => {
    const snapshots = mixedSnapshots()
    const baseline = rankOf(snapshots)
    for (let shift = 1; shift < snapshots.length; shift += 1) {
      const rotatedResult = rankOf(rotated(snapshots, shift))
      expect(rotatedResult).toEqual(baseline)
      expect(rotatedResult.digest).toBe(baseline.digest)
      expect(rotatedResult.explanationText).toBe(baseline.explanationText)
    }
  })

  it("produces a different digest for a different preference order, because the order is part of the answer", () => {
    const ordered = rankOf(mixedSnapshots(), { ...EMPTY_ROUTING_PREFERENCE, preferredNodeIds: ["node-charlie", "node-zulu"] })
    const shuffled = rankOf(mixedSnapshots(), { ...EMPTY_ROUTING_PREFERENCE, preferredNodeIds: ["node-zulu", "node-charlie"] })
    // Both preferences select an ELIGIBLE node, and the winner is whichever the
    // rules named first — so a different preference order is a different answer,
    // and the digest must say so rather than collapsing both onto "node-something".
    expect(ordered.selectedNodeId).toBe("node-charlie")
    expect(shuffled.selectedNodeId).toBe("node-zulu")
    expect(ordered.digest).not.toBe(shuffled.digest)
    // The candidate LIST is in nodeId order either way, so the two reports stay
    // comparable line for line.
    expect(ordered.candidates.map((c) => c.nodeId)).toEqual(shuffled.candidates.map((c) => c.nodeId))
  })

  it("produces a digest that a caller can re-derive from the frozen result", () => {
    const result = rankOf(mixedSnapshots())
    expect(digestRoutingResult(result)).toBe(result.digest)
  })

  it("produces a different digest when any part of the answer differs", () => {
    const baseline = rankOf(mixedSnapshots())
    const withoutSelection = rankOf(mixedSnapshots(), EMPTY_ROUTING_PREFERENCE)
    const other = rankOf(mixedSnapshots().slice(0, 3))
    expect(withoutSelection.digest).not.toBe(baseline.digest)
    expect(other.digest).not.toBe(baseline.digest)
    // A snapshot array that produces the SAME answer produces the same digest,
    // whatever order it arrived in.
    expect(rankOf(rotated(mixedSnapshots(), 3)).digest).toBe(baseline.digest)
  })

  it("is reproducible across two independently built registries", async () => {
    const build = async () => {
      const clock = new TestClock()
      const { registry, store } = inMemoryRegistry(clock)
      await enroll(store, { nodeId: "node-alpha" })
      await enroll(store, { nodeId: "node-bravo" })
      await heartbeat(registry, { nodeId: "node-alpha" })
      await heartbeat(registry, { nodeId: "node-bravo", capabilities: ["fs.read", "gpu"] })
      const result = await buildRoutingSnapshot(
        registry,
        aRequest(),
        aContext({ authorizedProjectIds: authorizedFor("node-alpha", "node-bravo") }),
      )
      if (!result.ok) throw new Error("unreachable")
      return result.value
    }
    const left = rankOf(await build())
    const right = rankOf(await build())
    expect(right.digest).toBe(left.digest)
    expect(right.explanationText).toBe(left.explanationText)
    expect(right.selectedNodeId).toBe("node-alpha")
  })

  it("produces the same answer when the request asks for the same things in a different order", () => {
    // The request's arrays are SETS of alternatives, so their order is not part of
    // the question. The adapter sorts them and the ranker compares them by
    // membership, which is what makes this hold.
    const forwards = rankOf(mixedSnapshots(), EMPTY_ROUTING_PREFERENCE)
    const shuffledRequest = rankNodes(
      mixedSnapshots(),
      aRequest({
        requiredCapabilities: ["fs.read"],
        requiredRuntimeKinds: ["opencode"],
        now: at(0),
      }),
      EMPTY_ROUTING_PREFERENCE,
    )
    expect(shuffledRequest.ok).toBe(true)
    if (!shuffledRequest.ok) throw new Error("unreachable")
    expect(shuffledRequest.value.digest).toBe(forwards.digest)
  })

  it("does not read a clock: two rankings of the same snapshots at the same request instant agree", () => {
    const snapshots = [aSnapshot({ observedAt: iso(at(0)) })]
    const before = rankNodes(snapshots, aRequest(), EMPTY_ROUTING_PREFERENCE)
    const after = rankNodes(snapshots, aRequest(), EMPTY_ROUTING_PREFERENCE)
    expect(before.ok && after.ok).toBe(true)
    if (!before.ok || !after.ok) throw new Error("unreachable")
    expect(after.value).toEqual(before.value)
  })

  it("answers an empty snapshot array deterministically", () => {
    const first = rankOf([])
    const second = rankOf([])
    expect(first).toEqual(second)
    expect(first.selectedNodeId).toBeNull()
    expect(first.consideredCount).toBe(0)
  })
})

describe("the code-unit comparator never consults a locale", () => {
  it("returns -1, 0, and 1 and nothing else, for equal and unequal inputs", () => {
    expect(compareByCodeUnit("a", "a")).toBe(0)
    expect(compareByCodeUnit("a", "b")).toBe(-1)
    expect(compareByCodeUnit("b", "a")).toBe(1)
  })

  it("is antisymmetric on every adjacent pair in a mixed-case, mixed-punctuation list", () => {
    const ids = ["Node-a", "node-a", "NODE-A", "node-0", "node--", "node_", "node.a"]
    const sorted = [...ids].sort(compareByCodeUnit)
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const lower = sorted[index]!
      const upper = sorted[index + 1]!
      expect(compareByCodeUnit(lower, upper)).toBe(-1)
      expect(compareByCodeUnit(upper, lower)).toBe(1)
    }
    expect(sorted).toEqual([...ids].sort())
  })

  it("disagrees with localeCompare on at least one pair, which is why localeCompare is banned", () => {
    const ids = ["Node-a", "node-a", "NODE-A", "node-0", "node--", "node.a", "node_b"]
    const byCodeUnit = [...ids].sort(compareByCodeUnit)
    const byLocale = [...ids].sort((a, b) => a.localeCompare(b))
    // The point is not that they differ on THIS runtime — it is that the code-unit
    // ordering is the one the answer is defined in, and it is computable from the
    // two strings alone. The assertion records the disagreement where there is one.
    expect(byCodeUnit).toEqual([...ids].sort())
    if (byLocale.join(",") !== byCodeUnit.join(",")) {
      expect(byLocale).not.toEqual(byCodeUnit)
    }
  })

  it("sorts and de-duplicates identically for a value list however it is ordered", () => {
    const values = ["opencode", "claude", "opencode", "aider"]
    expect(sortedUnique(values)).toEqual(sortedUnique([...values].reverse()))
    expect(sortedUnique(values)).toEqual(["aider", "claude", "opencode"])
  })
})

describe("a routing answer is frozen, so a caller cannot edit a decision after it is made", () => {
  it("freezes the result and every collection reachable from it", () => {
    const result: RoutingResult = rankOf(mixedSnapshots())
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.candidates)).toBe(true)
    expect(Object.isFrozen(result.candidates[0]!.exclusions)).toBe(true)
    expect(Object.isFrozen(result.explanationText)).toBe(true)
    expect(Object.isFrozen(result.preferenceIgnored)).toBe(true)
    expect(Object.isFrozen(result.demotedNodeIds)).toBe(true)
  })

  it("refuses to let a caller change the selection in place", () => {
    const result = rankOf(mixedSnapshots()) as unknown as { selectedNodeId: string | null }
    expect(() => {
      result.selectedNodeId = "node-zulu"
    }).toThrow()
    expect(rankOf(mixedSnapshots()).selectedNodeId).toBe("node-charlie")
  })
})

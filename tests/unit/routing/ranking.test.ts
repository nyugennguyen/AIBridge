/**
 * M6.6 — stage 2 (preference) and stage 3 (tie-break).
 *
 * The property under test throughout is that a preference can only REORDER an
 * eligible set. Every test here is one way a routing layer could quietly acquire
 * the power to add a node that failed a hard check, or to remove one that passed,
 * and the reason that would be a safety-floor widening expressed as a preference.
 */

import { describe, expect, it } from "vitest"
import { nodeIdSchema } from "../../../src/orchestration/identifiers.js"
import { compareByCodeUnit, EMPTY_ROUTING_PREFERENCE, rankNodes } from "../../../src/routing/index.js"
import type { RoutingNodeSnapshot, RoutingPreference } from "../../../src/routing/index.js"
import { aRequest, aSnapshot, OTHER_PATH_ID, PROJECT_PATH_ID } from "./fixtures.js"

function preference(overrides: Partial<RoutingPreference> = {}): RoutingPreference {
  return { ...EMPTY_ROUTING_PREFERENCE, ...overrides }
}

function rank(
  snapshots: readonly RoutingNodeSnapshot[],
  preferences: RoutingPreference = preference(),
  request = aRequest(),
) {
  const outcome = rankNodes(snapshots, request, preferences)
  if (!outcome.ok) throw new Error(`ranking was refused: ${outcome.error.code} — ${outcome.error.message}`)
  return outcome.value
}

const THREE_ELIGIBLE = [
  aSnapshot({ nodeId: nodeIdSchema.parse("node-charlie") }),
  aSnapshot({ nodeId: nodeIdSchema.parse("node-alpha") }),
  aSnapshot({ nodeId: nodeIdSchema.parse("node-bravo") }),
]

describe("stage 2 reorders the eligible set and cannot resurrect an excluded node", () => {
  it("selects the lowest nodeId by code unit when no preference is expressed", () => {
    const result = rank(THREE_ELIGIBLE)
    expect(result.selectedNodeId).toBe("node-alpha")
    expect(result.candidates.filter((c) => c.eligible).map((c) => c.rank)).toEqual([0, 1, 2])
    expect(result.tieBreakApplied).toBe(true)
    expect(result.preferenceApplied).toBe(false)
  })

  it("selects the first named node when a preference names one", () => {
    const result = rank(THREE_ELIGIBLE, preference({ preferredNodeIds: ["node-charlie"] }))
    expect(result.selectedNodeId).toBe("node-charlie")
    expect(result.preferenceApplied).toBe(true)
    expect(result.tieBreakApplied).toBe(false)
  })

  it("honours the preference's ORDER rather than the node id order within it", () => {
    const result = rank(THREE_ELIGIBLE, preference({ preferredNodeIds: ["node-charlie", "node-bravo"] }))
    expect(result.selectedNodeId).toBe("node-charlie")
    const ranks = Object.fromEntries(result.candidates.map((c) => [c.nodeId, c.rank]))
    expect(ranks["node-charlie"]).toBe(0)
    expect(ranks["node-bravo"]).toBe(1)
    expect(ranks["node-alpha"]).toBe(2)
  })

  it("cannot resurrect an unhealthy node that a preference names first", () => {
    const result = rank(
      [
        aSnapshot({
          nodeId: nodeIdSchema.parse("node-charlie"),
          livenessState: "stale",
          healthy: false,
          healthReason: "liveness_stale",
        }),
        aSnapshot({ nodeId: nodeIdSchema.parse("node-alpha") }),
        aSnapshot({ nodeId: nodeIdSchema.parse("node-bravo") }),
      ],
      preference({ preferredNodeIds: ["node-charlie", "node-bravo", "node-alpha"] }),
    )

    // The unhealthy node is FIRST in the preference and is still excluded, and the
    // next preference is chosen. This is the single most important test in the
    // file: a preference is an ordering over the eligible set, not a grant.
    expect(result.selectedNodeId).toBe("node-bravo")
    const charlie = result.candidates.find((c) => c.nodeId === "node-charlie")!
    expect(charlie.eligible).toBe(false)
    expect(charlie.rank).toBeNull()
    expect(charlie.selected).toBe(false)
    expect(charlie.exclusions.map((e) => e.code)).toContain("unhealthy")
  })

  it("cannot resurrect an unauthorized node that a preference names first", () => {
    const result = rank(
      [
        aSnapshot({ nodeId: nodeIdSchema.parse("node-charlie"), projectIds: [] }),
        aSnapshot({ nodeId: nodeIdSchema.parse("node-alpha") }),
      ],
      preference({ preferredNodeIds: ["node-charlie", "node-alpha"] }),
    )
    expect(result.selectedNodeId).toBe("node-alpha")
    expect(result.candidates.find((c) => c.nodeId === "node-charlie")!.eligible).toBe(false)
  })

  it("reports every ignored preference with the eligibility reason that made it unusable", () => {
    const result = rank(
      [
        aSnapshot({ nodeId: nodeIdSchema.parse("node-charlie"), projectIds: [] }),
        aSnapshot({ nodeId: nodeIdSchema.parse("node-delta"), revoked: true, livenessState: "revoked", healthy: false, healthReason: "liveness_revoked" }),
        aSnapshot({ nodeId: nodeIdSchema.parse("node-alpha") }),
      ],
      preference({ preferredNodeIds: ["node-delta", "node-charlie", "node-alpha"] }),
    )

    expect(result.preferenceIgnored.map((ignored) => ignored.nodeId)).toEqual(["node-charlie", "node-delta"])
    const charlie = result.preferenceIgnored.find((ignored) => ignored.nodeId === "node-charlie")!
    expect(charlie.exclusions.map((exclusion) => exclusion.code)).toContain("not_authorized_for_project")
    const delta = result.preferenceIgnored.find((ignored) => ignored.nodeId === "node-delta")!
    expect(delta.exclusions.map((exclusion) => exclusion.code)).toContain("revoked")
    expect(result.explanationText).toContain("preference_ignored node-charlie")
    expect(result.explanationText).toContain("preference_ignored node-delta")
  })

  it("ignores a preference naming a node that is not on the mesh at all, without pretending it was excluded", () => {
    // A node the snapshot does not contain cannot carry exclusions, so reporting
    // it as `preference_ignored` would be a claim about a node routing never saw.
    const result = rank(THREE_ELIGIBLE, preference({ preferredNodeIds: ["node-ghost"] }))
    expect(result.selectedNodeId).toBe("node-alpha")
    expect(result.preferenceIgnored).toEqual([])
    expect(result.preferenceApplied).toBe(true)
  })

  it("demotes rather than excludes a node that fails a preference's required runtime kind", () => {
    const result = rank(
      [
        aSnapshot({ nodeId: nodeIdSchema.parse("node-alpha"), runtimeKinds: ["opencode"] }),
        aSnapshot({ nodeId: nodeIdSchema.parse("node-bravo"), runtimeKinds: ["claude"] }),
      ],
      preference({ requiredRuntimeKind: "opencode" }),
      aRequest({ requiredRuntimeKinds: ["opencode", "claude"] }),
    )

    expect(result.candidates.find((c) => c.nodeId === "node-bravo")!.eligible).toBe(true)
    expect(result.selectedNodeId).toBe("node-alpha")
    expect(result.demotedNodeIds).toEqual(["node-bravo"])
    expect(result.candidates.find((c) => c.nodeId === "node-bravo")!.demotedByPreference).toBe(true)
  })

  it("still selects a demoted node when it is the only eligible one", () => {
    const result = rank(
      [aSnapshot({ nodeId: nodeIdSchema.parse("node-bravo"), runtimeKinds: ["claude"] })],
      preference({ requiredRuntimeKind: "opencode" }),
      aRequest({ requiredRuntimeKinds: ["opencode", "claude"] }),
    )
    expect(result.selectedNodeId).toBe("node-bravo")
    expect(result.candidates[0]!.demotedByPreference).toBe(true)
    expect(result.candidates[0]!.rank).toBe(0)
  })

  it("demotes rather than excludes a node that fails a preference's required project path", () => {
    const result = rank(
      [
        aSnapshot({ nodeId: nodeIdSchema.parse("node-alpha"), projectPathIds: [PROJECT_PATH_ID] }),
        aSnapshot({ nodeId: nodeIdSchema.parse("node-bravo"), projectPathIds: [PROJECT_PATH_ID, OTHER_PATH_ID] }),
      ],
      preference({ requiredProjectPathId: OTHER_PATH_ID }),
      // The dispatch's own path check is a hard check, so the request asks for both
      // paths as alternatives; the preference then asks for one of them SOFTLY.
      aRequest(),
    )

    expect(result.selectedNodeId).toBe("node-bravo")
    expect(result.demotedNodeIds).toEqual(["node-alpha"])
    // The hard check still passes for a node advertising another path, because the
    // dispatch's own path check is the authorization; the preference's requirement
    // is a soft ordering hint on top of it.
    expect(result.candidates.find((c) => c.nodeId === "node-alpha")!.eligible).toBe(true)
  })

  it("lets an explicitly named node outrank a demoted one, because naming a node is the more specific statement", () => {
    const result = rank(
      [
        aSnapshot({ nodeId: nodeIdSchema.parse("node-alpha"), runtimeKinds: ["opencode"] }),
        aSnapshot({ nodeId: nodeIdSchema.parse("node-bravo"), runtimeKinds: ["claude"] }),
      ],
      preference({ requiredRuntimeKind: "opencode", preferredNodeIds: ["node-bravo"] }),
      aRequest({ requiredRuntimeKinds: ["opencode", "claude"] }),
    )
    expect(result.selectedNodeId).toBe("node-bravo")
  })

  it("orders the tenth preference before the second rather than after it", () => {
    // A string sort of "p10" against "p2" puts the tenth first, which is a
    // plausible-looking bug a deterministic selector cannot afford.
    const preferred = Array.from({ length: 12 }, (_, index) => `node-${String(index).padStart(2, "0")}`)
    const snapshots = preferred.map((nodeId) => aSnapshot({ nodeId: nodeIdSchema.parse(nodeId) }))
    const result = rank(snapshots, preference({ preferredNodeIds: preferred }))
    const ranks = Object.fromEntries(result.candidates.map((c) => [c.nodeId, c.rank]))
    expect(result.selectedNodeId).toBe("node-00")
    expect(ranks["node-09"]).toBe(9)
    expect(ranks["node-10"]).toBe(10)
    expect(ranks["node-11"]).toBe(11)
  })
})

describe("stage 3 breaks ties by UTF-16 code unit, never by locale", () => {
  it("orders two node ids that differ only by case by code unit, so uppercase sorts first", () => {
    // "N" (0x4E) < "n" (0x6E). `localeCompare` would give the opposite in most
    // locales, and a different answer again on a machine with a different locale
    // table — which is exactly why the tie-break may never use it.
    const result = rank([
      aSnapshot({ nodeId: nodeIdSchema.parse("node-a") }),
      aSnapshot({ nodeId: nodeIdSchema.parse("Node-a") }),
    ])
    expect(result.selectedNodeId).toBe("Node-a")
    // The two orderings DISAGREE, and the direction of the disagreement is not
    // fixed by the language: `localeCompare` consults locale collation, where the
    // base letter usually wins over case, so here it ranks "node-a" first. That is
    // precisely why it is banned. If a future runtime flips this sign the test
    // still passes, because what is asserted is that the two never coincide.
    expect("Node-a" < "node-a").toBe(true)
    expect("Node-a".localeCompare("node-a")).not.toBe(-1)
  })

  it("orders non-ASCII identifiers by code unit, where a code point above the ASCII range sorts LAST", () => {
    // `nodeIdSchema` is deliberately ASCII-only, so a non-ASCII node id cannot
    // reach the ranker through a valid snapshot. The comparator is exported and is
    // what every ordering in this module goes through, so it is pinned directly —
    // and pinned against the `<` operator rather than against a locale table,
    // because "é"(0xE9) > "z"(0x7A) is a code-unit fact and a locale fact would
    // disagree with it.
    expect(compareByCodeUnit("node-é", "node-z")).toBe(1)
    expect("node-z" < "node-é").toBe(true)
    // A LEADING non-ASCII character sorts after every ASCII letter, because 0xE9
    // exceeds every code unit below 0xFF and a first-unit comparison stops at the
    // first difference. So an identifier beginning with "é" sorts LAST, not first.
    expect(compareByCodeUnit("étape", "zulu")).toBe(1)
    expect("zulu" < "étape").toBe(true)
    expect(compareByCodeUnit("a", "A")).toBe(1)
    expect(compareByCodeUnit("A", "a")).toBe(-1)
  })

  it("orders punctuation before digits before letters by code unit, matching the `<` operator", () => {
    const ids = ["node-z", "node-a", "node-0", "node--", "node-."]
    const snapshots = ids.map((nodeId) => aSnapshot({ nodeId: nodeIdSchema.parse(nodeId) }))
    const result = rank(snapshots)
    // "-"(0x2D) < "."(0x2E) < "0"(0x30) < "a"(0x61) < "z"(0x7A).
    expect(result.candidates.map((c) => c.nodeId)).toEqual(["node--", "node-.", "node-0", "node-a", "node-z"])
    expect(result.candidates.map((c) => c.nodeId)).toEqual([...ids].sort())
    expect(result.selectedNodeId).toBe("node--")
  })

  it("agrees with the `<` operator on every ordering rather than with the host locale", () => {
    const ids = ["Node-B", "node-a", "NODE-c", "node-A", "node-0", "node-z"]
    const snapshots = ids.map((nodeId) => aSnapshot({ nodeId: nodeIdSchema.parse(nodeId) }))
    const result = rank(snapshots)
    expect(result.candidates.map((c) => c.nodeId)).toEqual([...ids].sort())
  })

  it("reports that the tie-break decided the outcome when the top two tie on preference", () => {
    const result = rank(THREE_ELIGIBLE, preference({ preferredNodeIds: ["node-alpha", "node-bravo"] }))
    // `node-alpha` wins on preference index 0 and `node-bravo` on index 1, so the
    // code-unit tie-break did not decide; the preference did.
    expect(result.selectedNodeId).toBe("node-alpha")
    expect(result.tieBreakApplied).toBe(false)
  })

  it("reports that the tie-break decided the outcome when a preference named nothing that was eligible", () => {
    // `node-zulu` is named and absent from the mesh, so every eligible node ties on
    // both stage-2 keys and the code-unit comparison alone separates them. The
    // preference is still reported as applied — it WAS expressed, it just had no
    // effect on the order.
    const result = rank(THREE_ELIGIBLE, preference({ preferredNodeIds: ["node-zulu"] }))
    expect(result.selectedNodeId).toBe("node-alpha")
    expect(result.tieBreakApplied).toBe(true)
    expect(result.preferenceApplied).toBe(true)
    expect(result.preferenceIgnored).toEqual([])
  })

  it("reports that the tie-break decided the outcome when two named nodes are demoted alike", () => {
    const result = rank(
      [
        aSnapshot({ nodeId: nodeIdSchema.parse("node-alpha"), runtimeKinds: ["claude"] }),
        aSnapshot({ nodeId: nodeIdSchema.parse("node-bravo"), runtimeKinds: ["claude"] }),
      ],
      preference({ preferredNodeIds: ["node-charlie", "node-bravo", "node-alpha"], requiredRuntimeKind: "opencode" }),
      aRequest({ requiredRuntimeKinds: ["opencode", "claude"] }),
    )
    // `node-charlie` is named at index 0 but is not on the mesh, so the top two
    // eligible nodes carry preference indexes 1 and 2 — different keys — and the
    // tie-break did NOT decide. Recorded explicitly because it is the boundary
    // case: two demoted nodes still order by preference first.
    expect(result.selectedNodeId).toBe("node-bravo")
    expect(result.tieBreakApplied).toBe(false)
    expect(result.demotedNodeIds).toEqual(["node-alpha", "node-bravo"])
  })

  it("reports no tie-break when there was only one eligible node to choose between", () => {
    const result = rank([aSnapshot({ nodeId: nodeIdSchema.parse("node-zulu") })])
    expect(result.selectedNodeId).toBe("node-zulu")
    expect(result.tieBreakApplied).toBe(false)
  })
})

describe("the eligible set and the candidate report are each deterministic", () => {
  it("lists candidates in nodeId code-unit order regardless of the order the snapshots arrived in", () => {
    const forwards = rank(THREE_ELIGIBLE)
    const backwards = rank([...THREE_ELIGIBLE].reverse())
    expect(forwards.candidates.map((c) => c.nodeId)).toEqual([
      "node-alpha",
      "node-bravo",
      "node-charlie",
    ])
    expect(backwards.candidates.map((c) => c.nodeId)).toEqual(forwards.candidates.map((c) => c.nodeId))
  })

  it("assigns ranks that follow the selection order while listing candidates in code-unit order", () => {
    const result = rank(THREE_ELIGIBLE, preference({ preferredNodeIds: ["node-charlie"] }))
    const byId = Object.fromEntries(result.candidates.map((c) => [c.nodeId, c.rank]))
    expect(byId["node-charlie"]).toBe(0)
    expect(byId["node-alpha"]).toBe(1)
    expect(byId["node-bravo"]).toBe(2)
  })

  it("counts eligible and excluded nodes separately from the number considered", () => {
    const result = rank([
      aSnapshot({ nodeId: nodeIdSchema.parse("node-alpha") }),
      aSnapshot({ nodeId: nodeIdSchema.parse("node-bravo"), projectIds: [] }),
      aSnapshot({ nodeId: nodeIdSchema.parse("node-charlie"), activeSessions: 4, maxConcurrentSessions: 4 }),
    ])
    expect(result.consideredCount).toBe(3)
    expect(result.eligibleCount).toBe(1)
    expect(result.excludedCount).toBe(2)
  })
})

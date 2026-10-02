/**
 * M6.6 — hard eligibility: one test per exclusion code, and the checks that make
 * eligibility a safety property rather than a filter.
 *
 * Every member of `ROUTING_EXCLUSION_REASONS` is reachable and asserted here. That
 * is the whole point of the file: an exclusion code nobody can produce is a code
 * nobody reads, and an exclusion code nobody asserts is a code that will be
 * "optimised away" the first time someone tidies a conditional.
 */

import { describe, expect, it } from "vitest"
import { MAX_HEARTBEAT_AGE_MS } from "../../../src/mesh/protocol/bounds.js"
import { nodeIdSchema } from "../../../src/orchestration/identifiers.js"
import { rankNodes, ROUTING_CHECK_ORDER, ROUTING_EXCLUSION_REASONS } from "../../../src/routing/index.js"
import type { RoutingNodeSnapshot, RoutingPreference } from "../../../src/routing/index.js"
import {
  aContext,
  aRequest,
  aSnapshot,
  at,
  authorizedFor,
  CANARY,
  enroll,
  heartbeat,
  inMemoryRegistry,
  iso,
  OTHER_PATH_ID,
  PROJECT_ID,
  PROJECT_PATH_ID,
  revoke,
  snapshotsFor,
  TestClock,
} from "./fixtures.js"

function rank(snapshots: readonly RoutingNodeSnapshot[], preferences?: Partial<RoutingPreference>) {
  const outcome = rankNodes(
    snapshots,
    aRequest(),
    preferences === undefined
      ? { preferredNodeIds: [], excludedNodeIds: [], requiredRuntimeKind: null, requiredProjectPathId: null }
      : { preferredNodeIds: [], excludedNodeIds: [], requiredRuntimeKind: null, requiredProjectPathId: null, ...preferences },
  )
  if (!outcome.ok) throw new Error(`ranking was refused: ${outcome.error.code} — ${outcome.error.message}`)
  return outcome.value
}

function codesOf(result: ReturnType<typeof rank>, nodeId: string): readonly string[] {
  const candidate = result.candidates.find((entry) => entry.nodeId === nodeId)
  if (candidate === undefined) throw new Error(`no candidate was reported for ${nodeId}`)
  return candidate.exclusions.map((exclusion) => exclusion.code)
}

describe("hard eligibility records every reason a node cannot be selected", () => {
  it("reports a revoked node as revoked, ahead of every other exclusion", () => {
    const result = rank([aSnapshot({ revoked: true, livenessState: "revoked", healthy: false, healthReason: "liveness_revoked" })])
    // `unhealthy` is reported alongside it rather than suppressed: a revoked node is
    // not live, and an operator reading the codes should see both facts. What the
    // fixed order guarantees is that the TERMINAL one leads.
    expect(codesOf(result, "node-alpha")).toEqual(["revoked", "unhealthy"])
    expect(result.selectedNodeId).toBeNull()
  })

  it("reports a node that is not authorized for the project", () => {
    const result = rank([aSnapshot({ projectIds: [] })])
    expect(codesOf(result, "node-alpha")).toContain("not_authorized_for_project")
  })

  it("reports a node whose advertised project paths do not include the dispatch's", () => {
    const result = rank([aSnapshot({ projectPathIds: [OTHER_PATH_ID] })])
    expect(codesOf(result, "node-alpha")).toContain("project_path_not_advertised")
  })

  it("reports a node that advertises none of the required runtime kinds", () => {
    const result = rank([aSnapshot({ runtimeKinds: ["claude"] })])
    expect(codesOf(result, "node-alpha")).toContain("missing_runtime_kind")
  })

  it("reports a node that advertises none of the required capabilities", () => {
    const result = rank([aSnapshot({ capabilities: ["fs.exec"] })])
    expect(codesOf(result, "node-alpha")).toContain("missing_capability")
  })

  it("reports a node whose registry verdict declined, keeping the registry's own refusal reason", () => {
    const result = rank([
      aSnapshot({
        verdictEligible: false,
        verdictReason: "denied_by_permission_envelope",
      }),
    ])
    expect(codesOf(result, "node-alpha")).toContain("verdict_declined")
    const candidate = result.candidates[0]!
    const declined = candidate.exclusions.find((exclusion) => exclusion.code === "verdict_declined")
    expect(declined?.reason).toContain("denied_by_permission_envelope")
    // The explanation must say what the verdict is not, in the same breath as
    // reporting it: a reader who sees `verdict_declined` must not read it as
    // "the registry refused permission".
    expect(declined?.reason).toContain("authorizes=false")
  })

  it("reports a node excluded by rule, and applies that code after every mesh check", () => {
    const result = rank(
      [aSnapshot({ nodeId: nodeIdSchema.parse("node-alpha"), revoked: true, livenessState: "revoked", healthy: false, healthReason: "liveness_revoked" })],
      { excludedNodeIds: ["node-alpha"] },
    )
    // Both codes, mesh fault first: a rule's opinion is the least authoritative
    // fact about a machine, so it never leads the list.
    expect(codesOf(result, "node-alpha")).toEqual(["revoked", "unhealthy", "excluded_by_rule"])
  })

  it("reports a node the CALLER excluded under the same code a rule would produce", () => {
    const outcome = rankNodes(
      [aSnapshot()],
      aRequest({ excludeNodeIds: [nodeIdSchema.parse("node-alpha")] }),
      { preferredNodeIds: [], excludedNodeIds: [], requiredRuntimeKind: null, requiredProjectPathId: null },
    )
    if (!outcome.ok) throw new Error("unreachable")
    expect(codesOf(outcome.value, "node-alpha")).toEqual(["excluded_by_rule"])
  })

  it("records every failing code on a node that fails several checks at once", () => {
    const result = rank([
      aSnapshot({
        projectIds: [],
        projectPathIds: [],
        runtimeKinds: [],
        capabilities: [],
        healthy: false,
        healthReason: "liveness_stale",
        livenessState: "stale",
        verdictEligible: false,
        verdictReason: "node_stale",
      }),
    ])
    expect(codesOf(result, "node-alpha")).toEqual([
      "not_authorized_for_project",
      "project_path_not_advertised",
      "missing_runtime_kind",
      "missing_capability",
      "unhealthy",
      "verdict_declined",
    ])
  })

  it("emits the failing codes in the fixed check order rather than in evaluation order", () => {
    const result = rank([
      aSnapshot({
        revoked: true,
        livenessState: "revoked",
        healthy: false,
        healthReason: "liveness_revoked",
        projectIds: [],
        capabilities: [],
        verdictEligible: false,
        verdictReason: "node_revoked",
      }),
    ])
    const codes = codesOf(result, "node-alpha")
    const positions = codes.map((code) => ROUTING_CHECK_ORDER.indexOf(code as never))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it("declares a check order that covers every exclusion code exactly once", () => {
    // If a code were reachable but absent from the order it could never be
    // reported; if the order carried a member the enum did not, it would not
    // typecheck. Asserted together so neither drifts from the other.
    expect([...ROUTING_CHECK_ORDER].sort()).toEqual([...ROUTING_EXCLUSION_REASONS].sort())
    expect(new Set(ROUTING_CHECK_ORDER).size).toBe(ROUTING_CHECK_ORDER.length)
  })

  it("treats required runtime kinds and capabilities as alternatives rather than a conjunction", () => {
    const outcome = rankNodes(
      [aSnapshot({ runtimeKinds: ["claude"], capabilities: ["fs.exec"] })],
      aRequest({ requiredRuntimeKinds: ["opencode", "claude"], requiredCapabilities: ["fs.read", "fs.exec"] }),
      { preferredNodeIds: [], excludedNodeIds: [], requiredRuntimeKind: null, requiredProjectPathId: null },
    )
    if (!outcome.ok) throw new Error("unreachable")
    expect(outcome.value.selectedNodeId).toBe("node-alpha")
  })

  it("checks a required tool category against the advertised capability names and reports the shortfall", () => {
    const outcome = rankNodes(
      [aSnapshot()],
      aRequest({ requiredToolCategories: ["shell"] }),
      { preferredNodeIds: [], excludedNodeIds: [], requiredRuntimeKind: null, requiredProjectPathId: null },
    )
    if (!outcome.ok) throw new Error("unreachable")
    // The mesh advertisement has no separate category vocabulary, so a category is
    // checked as a capability name and a shortfall is reported rather than dropped.
    expect(codesOf(outcome.value, "node-alpha")).toContain("missing_capability")
  })
})

describe("unhealthy and unauthorized nodes are excluded no matter how well they match", () => {
  it("never selects an unhealthy node even when its capabilities are a perfect match", () => {
    const result = rank([
      aSnapshot({
        nodeId: nodeIdSchema.parse("node-alpha"),
        capabilities: ["fs.read"],
        runtimeKinds: ["opencode"],
        projectPathIds: [PROJECT_PATH_ID],
        livenessState: "stale",
        healthy: false,
        healthReason: "liveness_stale",
      }),
    ])
    expect(result.selectedNodeId).toBeNull()
    expect(result.eligibleCount).toBe(0)
    expect(codesOf(result, "node-alpha")).toContain("unhealthy")
  })

  it("never selects an unauthorized node, and never does so because a preference named it", () => {
    const result = rank([aSnapshot({ projectIds: [] })], { preferredNodeIds: ["node-alpha"] })
    expect(result.selectedNodeId).toBeNull()
    expect(codesOf(result, "node-alpha")).toContain("not_authorized_for_project")
    expect(result.preferenceIgnored.map((ignored) => ignored.nodeId)).toEqual(["node-alpha"])
    expect(result.preferenceIgnored[0]!.exclusions.map((exclusion) => exclusion.code)).toContain(
      "not_authorized_for_project",
    )
  })

  it("excludes a node whose heartbeat is past the freshness bound, as the registry itself derives it", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })
    await heartbeat(registry, { nodeId: "node-alpha", observedAt: at(0) })

    const context = aContext({ authorizedProjectIds: authorizedFor("node-alpha") })
    const stale = await snapshotsFor(
      registry,
      aRequest({ now: at(0) + MAX_HEARTBEAT_AGE_MS + 1_000 }),
      context,
    )
    const fresh = await snapshotsFor(registry, aRequest({ now: at(0) }), context)

    expect(stale[0]!.livenessState).toBe("stale")
    expect(fresh[0]!.livenessState).toBe("live")
    expect(rank(stale).selectedNodeId).toBeNull()
    expect(rank(fresh).selectedNodeId).toBe("node-alpha")
  })

  it("excludes a revoked node through the real registry, not through a hand-built snapshot", async () => {
    const clock = new TestClock()
    const { registry, store } = inMemoryRegistry(clock)
    await enroll(store, { nodeId: "node-alpha" })
    await heartbeat(registry, { nodeId: "node-alpha" })
    await revoke(registry, "node-alpha")

    const snapshots = await snapshotsFor(
      registry,
      aRequest(),
      aContext({ authorizedProjectIds: authorizedFor("node-alpha") }),
    )

    const result = rank(snapshots)
    expect(result.selectedNodeId).toBeNull()
    expect(codesOf(result, "node-alpha")).toContain("revoked")
  })

  it("reports a saturated node under concurrency_saturated and not under any budget-derived code", () => {
    const result = rank([aSnapshot({ activeSessions: 4, maxConcurrentSessions: 4 })])
    expect(codesOf(result, "node-alpha")).toEqual(["concurrency_saturated"])
    const reason = result.candidates[0]!.exclusions[0]!.reason
    // The reason names what the check is NOT, because the three ceilings this
    // codebase has — a node advertisement, a scheduler cap, and a budget — look
    // alike in a log line and mean entirely different things.
    expect(reason).toContain("NOT a Milestone 6 budget")
    expect(reason).toContain("SchedulerOptions.maxConcurrency")
  })

  it("does not report concurrency_saturated when a node is one session below its ceiling", () => {
    const result = rank([aSnapshot({ activeSessions: 3, maxConcurrentSessions: 4 })])
    expect(result.selectedNodeId).toBe("node-alpha")
  })
})

describe("routing refuses to rank anything it cannot read", () => {
  it("refuses a snapshot array containing a projection that does not satisfy the schema", () => {
    const outcome = rankNodes(
      [aSnapshot({ activeSessions: 9, maxConcurrentSessions: 4 })],
      aRequest(),
      { preferredNodeIds: [], excludedNodeIds: [], requiredRuntimeKind: null, requiredProjectPathId: null },
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("unreachable")
    expect(outcome.error.code).toBe("routing.snapshot_invalid")
  })

  it("refuses a request whose fields the schema rejects", () => {
    const outcome = rankNodes(
      [aSnapshot()],
      { ...aRequest(), projectPathId: "not a path id" } as never,
      { preferredNodeIds: [], excludedNodeIds: [], requiredRuntimeKind: null, requiredProjectPathId: null },
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("unreachable")
    expect(outcome.error.code).toBe("routing.request_invalid")
  })

  it("refuses a preference that is not readable rather than applying half of it", () => {
    const outcome = rankNodes(
      [aSnapshot()],
      aRequest(),
      { preferredNodeIds: null } as unknown as RoutingPreference,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error("unreachable")
    expect(outcome.error.code).toBe("routing.preference_invalid")
  })

  it("keeps a canary planted in a snapshot out of every exclusion reason", () => {
    const result = rank([aSnapshot({ displayName: CANARY, projectIds: [] })])
    for (const candidate of result.candidates) {
      for (const exclusion of candidate.exclusions) {
        expect(exclusion.reason).not.toContain(CANARY)
      }
    }
    expect(result.explanationText).not.toContain(CANARY)
  })

  it("reads a projection that never went through the adapter, so ranking is testable in isolation", () => {
    const result = rank([aSnapshot({ observedAt: iso(at(0)) })])
    expect(result.selectedNodeId).toBe("node-alpha")
    expect(result.candidates[0]!.rank).toBe(0)
    expect(result.candidates[0]!.selected).toBe(true)
    expect(PROJECT_ID).toBe("proj-release")
  })
})

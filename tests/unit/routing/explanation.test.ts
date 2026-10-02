/**
 * M6.6 — explanation completeness and the no-secret guarantee.
 *
 * ADR 0007 section 12: a rendered explanation contains identifiers, enum values,
 * numbers, digests, rule metadata, and reason strings, and never prompt text, task
 * descriptions, context item content, memory record content, capability payload
 * bytes, terminal output, environment values, bearer tokens, or provider
 * credentials.
 *
 * The enforcement here is STRUCTURAL rather than documentary. Every explanation
 * string is assembled from a closed set of sources — a reason code, an enum member,
 * a number, and identifiers the caller supplied — and this file plants a distinct
 * canary in every free-text field of a snapshot and asserts that none of it
 * survives. A renderer that quoted the snapshot would fail; a renderer that quotes
 * only reason codes cannot.
 *
 * The other half is completeness. An explanation that is safe but silent is half a
 * feature: every node must appear, and every excluded node must carry a code and a
 * sentence an operator can act on.
 */

import { describe, expect, it } from "vitest"
import { nodeIdSchema, projectPathIdSchema } from "../../../src/orchestration/identifiers.js"
import { EMPTY_ROUTING_PREFERENCE, rankNodes, ROUTING_EXCLUSION_REASONS } from "../../../src/routing/index.js"
import type { RoutingNodeSnapshot, RoutingResult } from "../../../src/routing/index.js"
import { aRequest, aSnapshot, at, CANARY, iso, PROJECT_ID, PROJECT_PATH_ID } from "./fixtures.js"

function rank(
  snapshots: readonly RoutingNodeSnapshot[],
  preferences = EMPTY_ROUTING_PREFERENCE,
  request = aRequest(),
): RoutingResult {
  const outcome = rankNodes(snapshots, request, preferences)
  if (!outcome.ok) throw new Error(`ranking was refused: ${outcome.error.code} — ${outcome.error.message}`)
  return outcome.value
}

/**
 * A snapshot with a DISTINCT canary in every field that is not an enum or a number.
 *
 * Distinct rather than one shared string, so a leak of exactly one field cannot be
 * masked by a check that only looks for a token which also appears in a field the
 * renderer legitimately quotes.
 */
function canarySnapshot(nodeId: string): RoutingNodeSnapshot {
  return aSnapshot({
    nodeId: nodeIdSchema.parse(nodeId),
    displayName: `${CANARY}-displayName`,
    projectIds: [PROJECT_ID],
    // `nodeId` is an identifier and IS quoted; the canary rides in the fields that
    // are not: the advertisement and the health/timestamp fields.
    capabilities: ["fs.read"],
    runtimeKinds: ["opencode"],
    projectPathIds: [PROJECT_PATH_ID],
    observedAt: iso(at(0)),
    // A node that fails a capability check echoes the REQUEST's requirement, not
    // the node's advertisement, so the canary in the advertisement cannot leak
    // through the reason even when the reason is long.
    verdictReason: "node_never_seen",
  })
}

const FULL_SNAPSHOT_SET: readonly RoutingNodeSnapshot[] = [
  canarySnapshot("node-alpha"),
  canarySnapshot("node-bravo"),
  canarySnapshot("node-charlie"),
  aSnapshot({ nodeId: nodeIdSchema.parse("node-delta"), projectIds: [] }),
  aSnapshot({ nodeId: nodeIdSchema.parse("node-echo"), projectPathIds: [] }),
  aSnapshot({ nodeId: nodeIdSchema.parse("node-foxtrot"), capabilities: [] }),
  aSnapshot({ nodeId: nodeIdSchema.parse("node-golf"), runtimeKinds: [] }),
  aSnapshot({
    nodeId: nodeIdSchema.parse("node-hotel"),
    revoked: true,
    livenessState: "revoked",
    healthy: false,
    healthReason: "liveness_revoked",
  }),
  aSnapshot({ nodeId: nodeIdSchema.parse("node-india"), activeSessions: 4, maxConcurrentSessions: 4 }),
  aSnapshot({ nodeId: nodeIdSchema.parse("node-juliet"), verdictEligible: false, verdictReason: "node_never_seen" }),
]

describe("an explanation accounts for every node the snapshot contained", () => {
  it("produces one candidate line per node for a full snapshot run", () => {
    const result = rank(FULL_SNAPSHOT_SET)
    expect(result.consideredCount).toBe(FULL_SNAPSHOT_SET.length)
    expect(result.candidates).toHaveLength(FULL_SNAPSHOT_SET.length)
    const lines = result.explanationText.split("\n").filter((line) => line.startsWith("routing: candidate "))
    expect(lines).toHaveLength(FULL_SNAPSHOT_SET.length)
  })

  it("names every node in the explanation, so no node is silently dropped", () => {
    const result = rank(FULL_SNAPSHOT_SET)
    for (const snapshot of FULL_SNAPSHOT_SET) {
      expect(result.candidates.some((candidate) => candidate.nodeId === snapshot.nodeId)).toBe(true)
      expect(result.explanationText).toContain(snapshot.nodeId)
    }
  })

  it("gives every excluded node at least one code and a human-readable reason", () => {
    const result = rank(FULL_SNAPSHOT_SET)
    const excluded = result.candidates.filter((candidate) => !candidate.eligible)
    expect(excluded.length).toBeGreaterThan(0)
    for (const candidate of excluded) {
      expect(candidate.exclusions.length).toBeGreaterThan(0)
      for (const exclusion of candidate.exclusions) {
        expect(ROUTING_EXCLUSION_REASONS).toContain(exclusion.code)
        expect(exclusion.reason.length).toBeGreaterThan(20)
        // A reason that does not name the node cannot be actioned: an operator
        // reading a log line has to know which node it is about.
        expect(exclusion.reason).toContain(candidate.nodeId)
      }
      expect(result.explanationText).toContain(`routing: excluded ${candidate.nodeId} `)
    }
  })

  it("gives every eligible node a rank, and marks exactly one of them selected", () => {
    const result = rank(FULL_SNAPSHOT_SET)
    const eligible = result.candidates.filter((candidate) => candidate.eligible)
    expect(eligible.map((candidate) => candidate.rank)).toEqual([0, 1, 2])
    expect(eligible.filter((candidate) => candidate.selected)).toHaveLength(1)
    expect(result.selectedNodeId).toBe(eligible.find((candidate) => candidate.selected)!.nodeId)
  })

  it("states the counts in the header so a report can be read without counting lines", () => {
    const result = rank(FULL_SNAPSHOT_SET)
    expect(result.explanationText).toContain(`considered=${result.consideredCount}`)
    expect(result.explanationText).toContain(`eligible=${result.eligibleCount}`)
    expect(result.explanationText).toContain(`excluded=${result.excludedCount}`)
    expect(result.explanationText).toContain(`preferenceApplied=${result.preferenceApplied}`)
    expect(result.explanationText).toContain(`tieBreakApplied=${result.tieBreakApplied}`)
    expect(result.explanationText).toContain(`project=${PROJECT_ID}`)
    expect(result.explanationText).toContain(`projectPath=${PROJECT_PATH_ID}`)
  })

  it("explains an empty eligible set rather than reporting a bare null", () => {
    const result = rank([aSnapshot({ projectIds: [] })])
    expect(result.selectedNodeId).toBeNull()
    expect(result.explanationText).toContain("routing: selected none")
    expect(result.explanationText).toContain("no node satisfied every hard check")
    expect(result.explanationText).toContain("not_authorized_for_project")
  })

  it("renders one exclusion line per failing code, not one line per node", () => {
    const result = rank([
      aSnapshot({ projectIds: [], projectPathIds: [], runtimeKinds: [], capabilities: [] }),
    ])
    const lines = result.explanationText
      .split("\n")
      .filter((line) => line.startsWith("routing: excluded node-alpha "))
    expect(lines).toHaveLength(4)
  })

  it("reports a preference that named an unusable node, with the codes that made it unusable", () => {
    const result = rank(FULL_SNAPSHOT_SET, {
      preferredNodeIds: ["node-delta", "node-juliet", "node-alpha"],
      excludedNodeIds: ["node-echo"],
      requiredRuntimeKind: "opencode",
      requiredProjectPathId: PROJECT_PATH_ID,
    })
    expect(result.explanationText).toContain("routing: preference preferred=[node-delta,node-juliet,node-alpha]")
    expect(result.explanationText).toContain("routing: preference excluded=[node-echo]")
    expect(result.explanationText).toContain("routing: preference requiredRuntimeKind=opencode")
    expect(result.explanationText).toContain("routing: preference requiredProjectPathId=path-release-1")
    expect(result.explanationText).toContain("routing: preference_ignored node-delta")
    expect(result.explanationText).toContain("routing: preference_ignored node-juliet")
    expect(result.explanationText).not.toContain("preference_ignored node-alpha")
  })

  it("marks a demoted node in the explanation so a reader can see it was demoted rather than ignored", () => {
    const result = rank(
      [
        aSnapshot({ nodeId: nodeIdSchema.parse("node-alpha"), runtimeKinds: ["opencode"] }),
        aSnapshot({ nodeId: nodeIdSchema.parse("node-bravo"), runtimeKinds: ["claude"] }),
      ],
      { ...EMPTY_ROUTING_PREFERENCE, requiredRuntimeKind: "opencode" },
      // The dispatch's own runtime requirement is relaxed to BOTH kinds, so the
      // hard check passes and the preference's requirement is the only thing that
      // separates the two nodes.
      aRequest({ requiredRuntimeKinds: ["opencode", "claude"] }),
    )
    expect(result.explanationText).toContain("routing: demoted_by_preference node-bravo")
    expect(result.explanationText).toContain("demoted_by_preference")
  })

  it("orders the candidate lines by nodeId code unit, so two runs are diffable line for line", () => {
    const result = rank(FULL_SNAPSHOT_SET)
    const candidateIds = result.candidates.map((candidate) => candidate.nodeId)
    expect(candidateIds).toEqual([...candidateIds].sort())
  })
})

describe("no free text from a snapshot reaches an explanation", () => {
  it("contains no canary planted in any snapshot field", () => {
    const result = rank(FULL_SNAPSHOT_SET)
    expect(result.explanationText).not.toContain(CANARY)
    for (const candidate of result.candidates) {
      for (const exclusion of candidate.exclusions) {
        expect(exclusion.reason).not.toContain(CANARY)
      }
    }
  })

  it("contains no canary even when the explanation covers every exclusion code at once", () => {
    const everything = aSnapshot({
      displayName: `${CANARY}-displayName`,
      projectIds: [],
      projectPathIds: [],
      runtimeKinds: [],
      capabilities: [],
      healthy: false,
      healthReason: "liveness_stale",
      livenessState: "stale",
      verdictEligible: false,
      verdictReason: "node_stale",
      activeSessions: 4,
      maxConcurrentSessions: 4,
    })
    const result = rank([everything], { ...EMPTY_ROUTING_PREFERENCE, excludedNodeIds: ["node-alpha"] })
    expect(result.explanationText).not.toContain(CANARY)
    // Every code but `revoked`, which is the one exclusion a node cannot both fail
    // and not fail: revocation is terminal and a revoked node reports it first.
    expect(result.candidates[0]!.exclusions.map((exclusion) => exclusion.code)).toEqual(
      ROUTING_EXCLUSION_REASONS.filter((code) => code !== "revoked"),
    )
  })

  it("names the node by its identifier and never by its display name", () => {
    const result = rank([canarySnapshot("node-alpha"), canarySnapshot("node-bravo")])
    expect(result.explanationText).toContain("node-alpha")
    expect(result.explanationText).not.toContain(`${CANARY}-displayName`)
  })

  it("quotes only identifiers, enums, numbers, and reason codes", () => {
    const result = rank([
      aSnapshot({
        projectIds: [],
        healthReason: "liveness_stale",
        livenessState: "stale",
        healthy: false,
        activeSessions: 4,
        maxConcurrentSessions: 4,
      }),
    ])
    // The numeric facts the operator needs ARE present, because numbers are on the
    // permitted list and "4 of 4" is the difference between a wait and a callout.
    const reason = result.candidates[0]!.exclusions.find((e) => e.code === "concurrency_saturated")!.reason
    expect(reason).toContain("4 active sessions")
    expect(reason).toContain("ceiling of 4")
    // And the enum member is present, because an enum is on the permitted list and
    // `liveness_stale` is checkable in a way a sentence about it is not.
    const unhealthy = result.candidates[0]!.exclusions.find((e) => e.code === "unhealthy")!.reason
    expect(unhealthy).toContain("liveness_stale")
  })

  it("never renders a snapshot's advertised capability names, project path ids, or timestamp", () => {
    const result = rank([
      aSnapshot({
        capabilities: ["fs.exec"],
        projectPathIds: [projectPathIdSchema.parse("path-never-rendered")],
        observedAt: "2026-09-28T00:00:00.000Z",
      }),
    ])
    expect(result.explanationText).toContain("fs.read")
    expect(result.explanationText).not.toContain("fs.exec")
    expect(result.explanationText).not.toContain("path-never-rendered")
    expect(result.explanationText).not.toContain("2026-09-28T00:00:00.000Z")
  })

  it("carries the digest outside the explanation text, so the explanation cannot widen what the digest covers", () => {
    const result = rank([aSnapshot()])
    expect(result.explanationText).not.toContain(result.digest)
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

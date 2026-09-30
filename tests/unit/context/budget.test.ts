/**
 * M5.5: budget pruning and the refusal that must not be softened.
 *
 * The plan says "Budget pruning removes lowest-priority optional items and
 * records every exclusion", and the stop condition says context rendering must
 * not differ without a digest change. The interesting case is the one where the
 * budget *cannot* be met by pruning: then the assembly must fail, because a
 * manifest that omits a required item describes a dispatch nobody approved.
 *
 * These tests pin the specific set pruned, not just "something was pruned".
 * A greedy pass is the algorithm; if a future change makes it a knapsack, the
 * diff should show up as a failing expectation here rather than as a silent
 * change in what agents read.
 *
 * The last block is the M5.9 exclusion-honesty work: an exclusion's `kind` field
 * must name a kind (SF-17) and must be omitted exactly when the ontology says the
 * reason forbids it (SF-21).
 */

import { describe, expect, it } from "vitest"
import {
  assembleContext,
  estimateCost,
  exclusionKindOf,
  revealsKindForReason,
  sourceIdOf,
} from "../../../src/context/assembler.js"
import {
  CONTEXT_EXCLUSION_REASONS,
  SENSITIVE_EXCLUSION_REASONS,
  type ContextExclusionReason,
} from "../../../src/memory/ontology.js"
import type { ContextCandidate } from "../../../src/context/types.js"
import {
  artifactCandidate,
  dispatchCandidate,
  fixedProvider,
  memoryCandidate,
  policy,
  request,
  runSummaryCandidate,
  safetyCandidate,
} from "./fixtures.js"

function itemsOf(result: Awaited<ReturnType<typeof assembleContext>>, category: string): string[] {
  if (!result.ok) return []
  return result.value.items.filter((item) => item.category === category).map((item) => item.sourceId)
}

function excludedIds(result: Awaited<ReturnType<typeof assembleContext>>, reason: string): string[] {
  if (!result.ok) return []
  return result.value.excluded.filter((entry) => entry.reason === reason).map((entry) => entry.sourceId).sort()
}

describe("M5.5 budget accounting", () => {
  it("estimates cost as a fixed function of the text, never a tokenizer", () => {
    expect(estimateCost("abcd", "tokens")).toBe(1)
    expect(estimateCost("abcde", "tokens")).toBe(2)
    expect(estimateCost("abcd", "bytes")).toBe(4)
    // The same string costs the same on every call and in every process.
    expect(estimateCost("some context text", "tokens")).toBe(estimateCost("some context text", "tokens"))
  })

  it("records the budget estimate as the sum of the included items", async () => {
    const candidates = [safetyCandidate(), dispatchCandidate(), memoryCandidate({ memoryId: "m-1", content: "x".repeat(40) })]
    const result = await assembleContext(request(), { provider: fixedProvider(candidates) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const sum = result.value.items.reduce((total, item) => total + item.estimatedCost, 0)
    expect(result.value.budget.estimated).toBe(sum)
    expect(result.value.budget.maximum).toBe(100_000)
  })

  it("prunes the LOWEST-priority optional item first and records the exclusion", async () => {
    const candidates = [
      safetyCandidate(),
      dispatchCandidate(),
      memoryCandidate({ memoryId: "m-high", content: "high priority constraint", priority: 900 }),
      memoryCandidate({ memoryId: "m-low", content: "low priority note", priority: 100 }),
    ]
    // floor(8) + dispatch(36) + high(6) = 50 exactly. The low item needs 5 more.
    const tight = policy({ budget: { maximum: 50, unit: "tokens" } })
    const result = await assembleContext(request({ policy: tight }), { provider: fixedProvider(candidates) })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(itemsOf(result, "project_constraints")).toEqual(["m-high"])
    expect(excludedIds(result, "budget_exceeded")).toEqual(["m-low"])
    expect(result.value.budget.estimated).toBeLessThanOrEqual(result.value.budget.maximum)
  })

  it("prunes in ranked order, so a set of equal-priority items is cut from the last", async () => {
    const candidates = [
      safetyCandidate(),
      memoryCandidate({ memoryId: "m-a", content: "a".repeat(4), priority: 500 }),
      memoryCandidate({ memoryId: "m-b", content: "b".repeat(4), priority: 500 }),
      memoryCandidate({ memoryId: "m-c", content: "c".repeat(4), priority: 500 }),
    ]
    // floor(8) + three 1-token items = 11. A budget of 10 admits exactly two.
    const tight = policy({ budget: { maximum: 10, unit: "tokens" } })
    const result = await assembleContext(request({ policy: tight }), { provider: fixedProvider(candidates) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const included = itemsOf(result, "project_constraints")
    expect(included).toEqual(["m-a", "m-b"])
    expect(excludedIds(result, "budget_exceeded")).toEqual(["m-c"])
  })

  it("REFUSES the assembly when a required item does not fit, rather than dropping it", async () => {
    const candidates = [safetyCandidate("A very long safety floor statement. ".repeat(20))]
    const tight = policy({ budget: { maximum: 5, unit: "tokens" } })
    const result = await assembleContext(request({ policy: tight }), { provider: fixedProvider(candidates) })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("context.budget_exceeded")
    expect(result.error.category).toBe("validation")
    // The refusal must not hand back a manifest an approval could bind to.
    expect(Object.keys(result.error)).not.toContain("items")
  })

  it("a refused assembly produces no manifest at all, so nothing can be approved against it", async () => {
    const candidates = [safetyCandidate("x".repeat(500))]
    const result = await assembleContext(
      request({ policy: policy({ budget: { maximum: 3, unit: "tokens" } }) }),
      { provider: fixedProvider(candidates) },
    )
    expect(result.ok).toBe(false)
  })

  it("a byte budget is a byte budget, not a token budget with a different name", async () => {
    const candidates = [memoryCandidate({ memoryId: "m-1", content: "é".repeat(50) })]
    const tight = policy({ budget: { maximum: 40, unit: "bytes" } })
    const result = await assembleContext(request({ policy: tight }), { provider: fixedProvider(candidates) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 'é' is two UTF-8 bytes, so 50 of them cost 100 bytes and cannot fit in 40.
    // A token estimate would have called it 12 and included it.
    expect(result.value.items).toHaveLength(0)
    expect(excludedIds(result, "budget_exceeded")).toEqual(["m-1"])
  })

  it("records EVERY pruned item, not just the first", async () => {
    const candidates = [
      safetyCandidate(),
      memoryCandidate({ memoryId: "m-1", content: "one".repeat(10), priority: 300 }),
      memoryCandidate({ memoryId: "m-2", content: "two".repeat(10), priority: 200 }),
      memoryCandidate({ memoryId: "m-3", content: "three".repeat(10), priority: 100 }),
    ]
    const tight = policy({ budget: { maximum: 12, unit: "tokens" } })
    const result = await assembleContext(request({ policy: tight }), { provider: fixedProvider(candidates) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const pruned = excludedIds(result, "budget_exceeded")
    expect(pruned.length).toBeGreaterThan(0)
    // Everything not included is accounted for somewhere in the exclusion list.
    const accounted = new Set([
      ...result.value.items.map((item) => item.sourceId),
      ...result.value.excluded.map((entry) => entry.sourceId),
    ])
    for (const candidate of candidates) expect(accounted.has(sourceIdOf(candidate))).toBe(true)
  })
})

describe("M5.5 policy-driven selection", () => {
  it("excludes a disabled category and records why, rather than omitting it silently", async () => {
    const candidates = [safetyCandidate(), dispatchCandidate(), memoryCandidate({ memoryId: "m-1", content: "a decision" })]
    const result = await assembleContext(
      request({ policy: policy({ disabledCategories: ["project_constraints"] }) }),
      { provider: fixedProvider(candidates) },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(itemsOf(result, "project_constraints")).toHaveLength(0)
    expect(excludedIds(result, "policy_disabled")).toEqual(["m-1"])
  })

  it("a policy priority override beats the candidate's own priority", async () => {
    const candidates = [
      safetyCandidate(),
      memoryCandidate({ memoryId: "m-default", content: "default priority", priority: 500 }),
      memoryCandidate({ memoryId: "m-boosted", content: "boosted priority", priority: 10 }),
    ]
    const result = await assembleContext(
      request({ policy: policy({ priorityByCategory: { project_constraints: 500 } }) }),
      { provider: fixedProvider(candidates) },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const constraints = result.value.items.filter((item) => item.category === "project_constraints")
    expect(constraints.map((item) => item.sourceId)).toEqual(["m-boosted", "m-default"])
  })

  it("REFUSES a source offered twice, rather than resolving the conflict by arrival order", async () => {
    const first = memoryCandidate({ memoryId: "m-dup", content: "first body" })
    const second = memoryCandidate({ memoryId: "m-dup", content: "second body" })
    const result = await assembleContext(request(), { provider: fixedProvider([safetyCandidate(), first, second]) })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("context.duplicate_source")
    // The message names the source id, never either body.
    expect(result.error.message).toContain("m-dup")
    expect(result.error.message).not.toContain("first body")
    expect(result.error.message).not.toContain("second body")
  })

  it("refuses the duplicate in either arrival order, so the refusal is not order-dependent", async () => {
    const first = memoryCandidate({ memoryId: "m-dup", content: "first body" })
    const second = memoryCandidate({ memoryId: "m-dup", content: "second body" })
    const forward = await assembleContext(request(), { provider: fixedProvider([safetyCandidate(), first, second]) })
    const reverse = await assembleContext(request(), { provider: fixedProvider([safetyCandidate(), second, first]) })

    expect(forward.ok).toBe(false)
    expect(reverse.ok).toBe(false)
    if (forward.ok || reverse.ok) return
    expect(forward.error.code).toBe(reverse.error.code)
  })

  it("an identical repeat of the same candidate is still a duplicate, not a free no-op", async () => {
    // Two copies of one body would render twice and hash to two items, so the
    // check is on the id and not on the content. Saying so is the point.
    const candidate = memoryCandidate({ memoryId: "m-same", content: "one body" })
    const result = await assembleContext(request(), { provider: fixedProvider([safetyCandidate(), candidate, candidate]) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("context.duplicate_source")
  })
})

/** A memory candidate of a named ontology kind, with a deliberately different inclusion reason. */
function typedMemory(input: {
  memoryId: string
  memoryKind: string
  reason: ContextCandidate["reason"]
  content?: string
  priority?: number
  sensitivity?: ContextCandidate["sensitivity"]
}): ContextCandidate {
  const base = memoryCandidate({
    memoryId: input.memoryId,
    content: input.content ?? "a body",
    reason: input.reason,
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
  })
  return { ...base, source: { kind: "memory", memoryId: input.memoryId, memoryKind: input.memoryKind } }
}

describe("M5.9 an exclusion names a KIND, not an inclusion reason", () => {
  it("a budget_exceeded exclusion names the record's memory kind", async () => {
    // SF-17: this used to report `kind: candidate.reason`, so a `handoff` record
    // excluded for budget reported `kind: "handoff_packet"` — an inclusion
    // reason wearing a field named `kind`, which the TUI then printed.
    const candidates = [
      safetyCandidate(),
      typedMemory({ memoryId: "m-keep", memoryKind: "decision", reason: "active_decision", content: "kept", priority: 900 }),
      typedMemory({ memoryId: "m-cut", memoryKind: "handoff", reason: "handoff_packet", content: "pruned", priority: 100 }),
    ]
    const tight = policy({ budget: { maximum: 9, unit: "tokens" } })
    const result = await assembleContext(request({ policy: tight }), { provider: fixedProvider(candidates) })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [exclusion] = result.value.excluded.filter((entry) => entry.reason === "budget_exceeded")
    expect(exclusion?.sourceId).toBe("m-cut")
    expect(exclusion?.revealsKind).toBe(true)
    expect(exclusion?.kind).toBe("handoff")
    // Explicitly: not the inclusion reason, and not the category either.
    expect(exclusion?.kind).not.toBe("handoff_packet")
    expect(exclusion?.kind).not.toBe("active_decision")
  })

  it("a policy_disabled exclusion names the memory kind too", async () => {
    const candidates = [typedMemory({ memoryId: "m-1", memoryKind: "constraint", reason: "active_constraint" })]
    const result = await assembleContext(
      request({ policy: policy({ disabledCategories: ["project_constraints"] }) }),
      { provider: fixedProvider(candidates) },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.excluded[0]?.kind).toBe("constraint")
  })

  it("a NON-memory exclusion names the source it came from, which is still a kind", async () => {
    // There is no record kind for a safety floor, a dispatch envelope, an
    // artifact, or a run summary. The label used is the source discriminant, so
    // the field says what the thing is rather than repeating the reason.
    //
    // `policy_disabled` rather than `budget_exceeded`, because a safety floor is
    // `optional: false` and can therefore never be pruned without failing the
    // whole assembly — the test is about labels, not about pruning arithmetic.
    const candidates = [
      safetyCandidate(),
      dispatchCandidate(),
      artifactCandidate("artifact-report"),
      runSummaryCandidate("summary-1", "Three tasks completed."),
      typedMemory({ memoryId: "m-1", memoryKind: "finding", reason: "active_decision" }),
    ]
    const result = await assembleContext(
      request({
        policy: policy({
          disabledCategories: ["safety_instructions", "dispatch_approval", "task_references", "run_summary"],
        }),
      }),
      { provider: fixedProvider(candidates) },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const kinds = Object.fromEntries(result.value.excluded.map((entry) => [entry.sourceId, entry.kind]))
    expect(kinds["safety:floor.default"]).toBe("safety_floor")
    expect(kinds["dispatch:dispatch-m5"]).toBe("dispatch_envelope")
    expect(kinds["artifact:artifact-report"]).toBe("artifact")
    expect(kinds["run-summary:summary-1"]).toBe("run_summary")
    // And none of them is the inclusion reason it arrived with: the reasons are
    // `safety_floor`, `approved_dispatch`, `task_artifact_reference`, `run_summary`.
    expect(kinds["artifact:artifact-report"]).not.toBe("task_artifact_reference")
    expect(kinds["dispatch:dispatch-m5"]).not.toBe("approved_dispatch")
    // The memory candidate was still included, so it has no exclusion at all.
    expect(result.value.excluded.map((entry) => entry.sourceId)).not.toContain("m-1")
  })

  it("the label is a pure function of the candidate, so the TUI and the manifest cannot disagree", () => {
    expect(exclusionKindOf(typedMemory({ memoryId: "m-1", memoryKind: "user_correction", reason: "active_decision" }))).toBe(
      "user_correction",
    )
    expect(exclusionKindOf(safetyCandidate())).toBe("safety_floor")
    expect(exclusionKindOf(artifactCandidate("artifact-x"))).toBe("artifact")
    expect(exclusionKindOf(runSummaryCandidate("summary-x", "body"))).toBe("run_summary")
  })

  it("a sensitive exclusion names NO kind at all, whichever kind the record was", async () => {
    const candidates = [
      typedMemory({ memoryId: "m-secret", memoryKind: "handoff", reason: "handoff_packet", sensitivity: "prohibited" }),
      typedMemory({ memoryId: "m-above", memoryKind: "constraint", reason: "active_constraint", sensitivity: "restricted" }),
    ]
    const result = await assembleContext(
      request({ destination: { nodeId: "node-a", roleId: request().destination.roleId, clearance: "public_to_project" } }),
      { provider: fixedProvider(candidates) },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    for (const exclusion of result.value.excluded) {
      expect(exclusion.revealsKind).toBe(false)
      expect(exclusion.kind).toBeUndefined()
    }
    expect(result.value.excluded.map((entry) => entry.reason).sort()).toEqual([
      "prohibited_content",
      "sensitivity_above_clearance",
    ])
  })
})

describe("M5.9 NON_REVEALING is derived from the ontology, not remembered per call site", () => {
  it("the decision agrees with SENSITIVE_EXCLUSION_REASONS for EVERY reason", () => {
    // SF-21: `NON_REVEALING` was a hand-copied duplicate that nothing read, and
    // the invariant was maintained by each call site passing `false` in the
    // right argument position. This asserts the two can no longer disagree.
    for (const reason of CONTEXT_EXCLUSION_REASONS) {
      expect(revealsKindForReason(reason)).toBe(!SENSITIVE_EXCLUSION_REASONS.includes(reason))
    }
  })

  it("adding a reason to the ontology set makes it non-revealing HERE, with no edit to the assembler", () => {
    // The property that makes the set load-bearing rather than documentation. If
    // the derivation were replaced by a call-site boolean again, this would fail:
    // `budget_exceeded` is passed `true` by every call site that uses it.
    const widened = new Set<ContextExclusionReason>([...SENSITIVE_EXCLUSION_REASONS, "budget_exceeded"])
    expect(revealsKindForReason("budget_exceeded")).toBe(true)
    expect(revealsKindForReason("budget_exceeded", widened)).toBe(false)
  })

  it("no exclusion the assembler produces ever pairs a kind with revealsKind false", async () => {
    // Belt and braces over the schema's own superRefine: the assembler does not
    // need the schema to catch it, and the schema still does.
    const candidates = [
      safetyCandidate(),
      dispatchCandidate(),
      artifactCandidate("artifact-report"),
      runSummaryCandidate("summary-1", "summary"),
      typedMemory({ memoryId: "m-public", memoryKind: "decision", reason: "active_decision", priority: 900 }),
      typedMemory({ memoryId: "m-secret", memoryKind: "handoff", reason: "handoff_packet", sensitivity: "prohibited" }),
      typedMemory({ memoryId: "m-ref", memoryKind: "constraint", reason: "active_constraint", sensitivity: "secret_reference_only" }),
    ]
    for (const maximum of [50, 10_000]) {
      const result = await assembleContext(
        request({ policy: policy({ budget: { maximum, unit: "tokens" } }) }),
        { provider: fixedProvider(candidates) },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      for (const exclusion of result.value.excluded) {
        if (!exclusion.revealsKind) expect(exclusion.kind).toBeUndefined()
      }
    }
  })
})


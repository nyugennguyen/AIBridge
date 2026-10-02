/**
 * M6.3 — the divergence sweep.
 *
 * ============================== WHY A SECOND FILE ==============================
 *
 * `preview.test.ts` proves the preview agrees with `evaluateRules` on cases a
 * person thought of. That is the property ADR 0007 stop condition 1 names, and
 * it is the property most likely to look fine while being wrong: a preview that
 * agreed on all six hand-written cases and disagreed on the seventh is a
 * divergence, and the six green tests are not evidence against it. This file
 * exists to generate the cases nobody thought of.
 *
 * WHAT IT DOES. A deterministic generator seeded from a CONSTANT produces
 * `SWEEP_CASES` variations of (rule set, history entry): predicates drawn from
 * twenty-six shapes including the three combinators and the universal predicate,
 * actions drawn from all six kinds, activation states drawn from all four,
 * expiry drawn from never / future / past, version numbers drawn so that
 * supersession fires, and history entries with nulls, out-of-project ids,
 * unknown numeric requests and instants on both sides of every rule's expiry.
 * For every variation the preview's per-rule, per-entry `matchOutcome` and
 * matched-dispatch set are compared against a DIRECT `evaluateRules` call, with
 * the preview nowhere in the oracle's construction.
 *
 * `Math.random` is not used and the seed is not read from a clock. A fuzzer whose
 * seed changes per run reports a different failure set per run, so a failure
 * could not be reproduced and therefore could not be fixed; a fuzzer seeded from
 * the clock has the same problem plus a run whose result depends on when it
 * started. The generator is a LINEAR CONGRUENTIAL one, which is the weakest
 * generator there is — the right trade, because these tests are not searching
 * for a needle, they are walking a whole class of inputs and the only property
 * that matters is that the same class is visited every time.
 *
 * VARIATIONS THAT DO NOT COMPILE ARE COUNTED, NOT SKIPPED SILENTLY. A generated
 * rule that the compiler refuses — most often a `pre_approve_within_bounds` on
 * the universal predicate, which ADR 0007 section 8 refuses on purpose — is a
 * real outcome of the generator, and the test asserts the compiled count is
 * comfortably high so a generator that stopped producing valid input could not
 * quietly reduce this file to a loop over refusals.
 *
 * THE CONTEXT IS BUILT IN THIS FILE, independently of the module, by omitting
 * the four keys the history records for its own sake and filling the four the
 * ADR's per-entry shape does not carry. A shared helper would make every
 * comparison below a tautology.
 */

import { describe, expect, it } from "vitest"
import { compileRuleSet, evaluateRules, type CompiledRuleSet, type RuleEvaluationContext } from "../../../src/rules/index.js"
import {
  previewCompiledRuleSet,
  proposalHistoryEntrySchema,
  type ProposalHistoryEntry,
  type RulePreview,
} from "../../../src/rules/preview.js"
import { rawHistoryEntry } from "./preview.fixtures.js"

// ===========================================================================
// The generator
// ===========================================================================

/** The seed. A constant, so the sweep visits the same cases on every run. */
const SEED = 0x5eed_0007

/** How many (rule set, history) variations the sweep generates and checks. */
const SWEEP_CASES = 240

/** The generator. LCG over 2^32, the Numerical Recipes constants. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
}

function pick<T>(random: () => number, members: readonly T[]): T {
  const value = members[Math.floor(random() * members.length)]
  if (value === undefined) throw new Error("pick() called with an empty member list")
  return value
}

function maybe(random: () => number, probability: number): boolean {
  return random() < probability
}

/** Twenty-six predicate shapes, covering every field family and all three combinators. */
const PREDICATE_SHAPES: readonly (readonly unknown[])[] = [
  [{ field: "projectId", operator: "eq", value: "proj-1" }],
  [{ field: "projectId", operator: "in", value: ["proj-1", "proj-2"] }],
  [{ field: "projectId", operator: "in", value: ["proj-2"] }],
  [{ field: "roleId", operator: "eq", value: "role-1" }],
  [{ field: "roleId", operator: "in", value: ["role-1", "role-2"] }],
  [{ field: "roleId", operator: "eq", value: "role-nobody" }],
  [{ field: "roleVersion", operator: "between", value: { min: 1, max: 5 } }],
  [{ field: "roleVersion", operator: "gte", value: 2 }],
  [{ field: "capability", operator: "any", value: ["fs.read", "net.fetch"] }],
  [{ field: "capability", operator: "all", value: ["fs.read"] }],
  [{ field: "capability", operator: "none", value: ["fs.write"] }],
  [{ field: "toolCategory", operator: "any", value: ["shell"] }],
  [{ field: "runtimeKind", operator: "eq", value: "opencode" }],
  [{ field: "runtimeKind", operator: "eq", value: "claude" }],
  [{ field: "targetNodeId", operator: "in", value: ["node-1", "node-2"] }],
  [{ field: "nodeAdvertisedCapability", operator: "any", value: ["fs.read"] }],
  [{ field: "projectPathId", operator: "eq", value: "path-1" }],
  [{ field: "taskLabel", operator: "hasAny", value: ["release", "urgent"] }],
  [{ field: "taskLabel", operator: "lacks", value: ["blocked"] }],
  [{ field: "dependencyOutcome", operator: "anySucceeded" }],
  [{ field: "dependencyOutcome", operator: "none" }],
  [{ field: "fanOut", operator: "lte", value: 4 }],
  [{ field: "concurrency", operator: "between", value: { min: 1, max: 3 } }],
  [{ field: "retryLimit", operator: "lte", value: 1 }],
  [{ field: "timeoutSeconds", operator: "lte", value: 900 }],
  [{ field: "taskTitlePattern", pattern: "deploy.*" }],
  [
    {
      field: "scheduleWindow",
      windows: [{ daysOfWeek: [1, 2, 3, 4, 5], startMinuteOfDay: 540, endMinuteOfDay: 1020, timeZone: "UTC" }],
    },
  ],
  // The three combinators, plus the universal predicate.
  [{ field: "all", predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }, { field: "capability", operator: "any", value: ["fs.read"] }] }],
  [{ field: "any", predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }, { field: "roleId", operator: "eq", value: "role-1" }] }],
  [{ field: "not", predicate: { field: "roleId", operator: "eq", value: "role-1" } }],
  [],
]

/** All six action kinds. */
const ACTION_SHAPES: readonly unknown[] = [
  { kind: "deny_with_reason", reason: "frozen" },
  { kind: "require_approval", requireApprovalForDispatch: true },
  { kind: "require_approval", requireApprovalForCapabilities: ["fs.write"] },
  { kind: "add_restrictions", deniedCapabilities: ["fs.write"], maximumTimeoutSeconds: 300 },
  { kind: "set_stricter_budget", budget: { maximumFanOut: 4, maximumRetryLimit: 1 } },
  { kind: "select_routing_preference", preference: { preferredNodeIds: ["node-2"] } },
  {
    kind: "pre_approve_within_bounds",
    approvedCapabilities: ["fs.read"],
    maximumTimeoutSeconds: 900,
    allowDestructiveEffects: false,
    allowExternalEffects: false,
    maximumFanOut: 4,
    maximumConcurrency: 2,
    maximumRetryLimit: 1,
    maximumSensitivity: "restricted",
  },
]

/**
 * The four activation states, DRAWN WITH WEIGHTS.
 *
 * Weighted rather than uniform because the interesting comparisons are between
 * an eligible rule and an ineligible one. A uniform draw would put three quarters
 * of every sweep on `not_activated`, `revoked` and `expired`, the sweep would
 * still be green, and the cases where a predicate is actually EVALUATED would be
 * a handful of them. Seven parts in ten are activated so the eligible population
 * dominates, and the other three parts are there precisely so the ineligible
 * outcomes — where a preview and an evaluator are most likely to describe the
 * same absence differently — are still visited thousands of times over.
 */
const ACTIVATION_SHAPES: readonly (readonly [unknown, number])[] = [
  [{ state: "activated", activatedAt: "2026-01-01T00:00:00Z", activatedBy: { kind: "user", userId: "user-1" } }, 7],
  [{ state: "draft", activatedAt: null, activatedBy: null }, 1],
  [{ state: "revoked", activatedAt: "2026-01-01T00:00:00Z", activatedBy: { kind: "user", userId: "user-1" } }, 1],
  [{ state: "expired", activatedAt: "2026-01-01T00:00:00Z", activatedBy: { kind: "user", userId: "user-1" } }, 1],
]

function weightedPick(random: () => number, members: readonly (readonly [unknown, number])[]): unknown {
  const total = members.reduce((sum, [, weight]) => sum + weight, 0)
  let cursor = random() * total
  for (const [value, weight] of members) {
    cursor -= weight
    if (cursor < 0) return value
  }
  return members[0]?.[0]
}

const EXPIRY_SHAPES: readonly (string | null)[] = [null, "2026-12-31T00:00:00Z", "2026-01-15T00:00:00Z"]

const INSTANTS: readonly string[] = [
  "2026-01-10T12:00:00Z",
  "2026-02-02T12:00:00Z",
  "2026-02-02T03:00:00Z",
  "2026-02-02T20:00:00Z",
  "2026-06-01T12:00:00Z",
]

function randomRuleDocument(random: () => number, index: number): Record<string, unknown> {
  const predicates = pick(random, PREDICATE_SHAPES).map((predicate) => structuredClone(predicate))
  // A pre-approval may not be universal (ADR 0007 section 8), so on a draw the
  // generator does NOT repair, the compiler refuses and the case is counted —
  // and the refusal itself is part of the class being walked.
  const action = structuredClone(pick(random, ACTION_SHAPES)) as { kind: string }
  return {
    languageVersion: 2,
    // Two ids and two versions, allocated so that index 0 is `rule-00@1` and
    // index 2 is `rule-00@2`: a generated set therefore carries SUPERSEDED
    // versions alongside live ones, which is where a preview and an evaluator
    // are most likely to describe the same absence differently.
    ruleId: `rule-${String(index % 2).padStart(2, "0")}`,
    templateVersion: 1 + Math.floor(index / 2),
    projectId: "proj-1",
    name: `sweep rule ${index}`,
    description: "A generated rule.",
    enabled: maybe(random, 0.93),
    activation: structuredClone(weightedPick(random, ACTIVATION_SHAPES)),
    predicates,
    actions: [action],
    expiresAt: pick(random, EXPIRY_SHAPES),
    author: { kind: "user", userId: "user-1" },
    createdAt: "2026-01-01T00:00:00Z",
  }
}

function randomHistoryEntry(random: () => number, index: number): Record<string, unknown> {
  return rawHistoryEntry({
    dispatchId: `disp-${String(index).padStart(3, "0")}`,
    runId: `run-${index % 3}`,
    taskId: `task-${index % 5}`,
    projectId: maybe(random, 0.9) ? "proj-1" : "proj-2",
    roleId: maybe(random, 0.85) ? "role-1" : null,
    roleVersion: maybe(random, 0.85) ? 1 + Math.floor(random() * 5) : null,
    requestedCapabilities: maybe(random, 0.8) ? ["fs.read", "net.fetch"] : [],
    runtimeKind: maybe(random, 0.85) ? "opencode" : null,
    targetNodeId: maybe(random, 0.85) ? "node-1" : null,
    projectPathId: maybe(random, 0.9) ? "path-1" : null,
    taskLabels: maybe(random, 0.8) ? ["release"] : [],
    dependencyOutcomes: maybe(random, 0.8) ? ["succeeded", "failed"] : [],
    requestedFanOut: maybe(random, 0.85) ? 1 + Math.floor(random() * 6) : null,
    requestedConcurrency: maybe(random, 0.85) ? 1 + Math.floor(random() * 4) : null,
    requestedRetryLimit: maybe(random, 0.85) ? Math.floor(random() * 3) : null,
    declaredTimeoutSeconds: maybe(random, 0.85) ? 60 * (1 + Math.floor(random() * 20)) : null,
    contextManifestSensitivity: maybe(random, 0.8) ? "restricted" : null,
    evaluatedAt: pick(random, INSTANTS),
    state: maybe(random, 0.5) ? "completed" : "proposed",
  })
}

// ===========================================================================
// The oracle, built without the preview
// ===========================================================================

function historyContext(entry: ProposalHistoryEntry): RuleEvaluationContext {
  const { dispatchId: _d, runId: _r, taskId: _t, state: _s, ...carried } = entry
  return { ...carried, toolCategories: [], nodeAdvertisedCapabilities: null, taskTitle: null, currentBudget: null }
}

function identityOf(rule: { ruleId: string; templateVersion: number }): string {
  return `${rule.ruleId}@${rule.templateVersion}`
}

// ===========================================================================
// The sweep
// ===========================================================================

describe("across 240 generated (rule set, history) variations, the preview never disagrees with the evaluator", () => {
  it("reports the evaluator's own matchOutcome and matched set for every rule and every entry", () => {
    const random = makeRng(SEED)
    let compiledSets = 0
    let refusedSets = 0
    let comparedOutcomes = 0
    let matchedRules = 0
    const outcomeTally = new Map<string, number>()
    const refusalCodes = new Map<string, number>()

    for (let sweep = 0; sweep < SWEEP_CASES; sweep += 1) {
      const ruleCount = 1 + Math.floor(random() * 4)
      const documents = Array.from({ length: ruleCount }, (_unused, index) => randomRuleDocument(random, index))
      const compiled: CompiledRuleSet | null = (() => {
        const result = compileRuleSet(documents)
        if (!result.ok) {
          refusedSets += 1
          refusalCodes.set(result.error.code, (refusalCodes.get(result.error.code) ?? 0) + 1)
          return null
        }
        compiledSets += 1
        return result.value
      })()
      if (compiled === null) continue

      const entryCount = Math.floor(random() * 5)
      const rawEntries = Array.from({ length: entryCount }, (_unused, index) => randomHistoryEntry(random, index))
      const history = {
        proposals: rawEntries.filter((_unused, index) => index % 2 === 0),
        finishedDispatches: rawEntries.filter((_unused, index) => index % 2 === 1),
      }
      // Both halves are validated by the module itself; entries that do not
      // satisfy the shape are dropped here so the sweep compares real evaluations
      // rather than the refusal path, which `preview.test.ts` covers directly.
      const historyResult = previewCompiledRuleSet(compiled, history, { now: "2026-03-02T09:00:00Z", actorId: "user-sweep", activationConfirmed: true })
      if (!historyResult.ok) continue
      const preview: RulePreview = historyResult.value

      // The dispatches the preview says it evaluated, read off ONE rule's
      // evaluation list — every rule in a set is evaluated against the same
      // dispatches, so taking them from the first rule avoids listing each
      // dispatch once per rule.
      const evaluated = preview.rules[0]?.evaluations.map((evaluation) => evaluation.dispatchId) ?? []
      const byDispatch = new Map<string, ProposalHistoryEntry>()
      for (const entry of history.proposals) {
        const parsed = proposalHistoryEntrySchema.safeParse(entry)
        if (parsed.success) byDispatch.set(parsed.data.dispatchId, parsed.data)
      }
      for (const entry of history.finishedDispatches) {
        const parsed = proposalHistoryEntrySchema.safeParse(entry)
        if (parsed.success) byDispatch.set(parsed.data.dispatchId, parsed.data)
      }

      for (const rule of compiled.rules) {
        const reported = preview.rules.find((entry) => identityOf(entry) === identityOf(rule))
        expect(reported, `sweep ${sweep}: no preview entry for ${identityOf(rule)}`).toBeDefined()
        if (reported === undefined) continue

        const matched: string[] = []
        for (const dispatchId of evaluated) {
          const source = byDispatch.get(dispatchId)
          if (source === undefined) continue
          const result = evaluateRules(compiled, historyContext(source))
          const trace = result.traces.find((candidate) => identityOf(candidate) === identityOf(rule))
          expect(trace, `sweep ${sweep}: ${identityOf(rule)} has no trace`).toBeDefined()
          const evaluation = reported.evaluations.find((candidate) => candidate.dispatchId === dispatchId)
          expect(evaluation, `sweep ${sweep}: ${identityOf(rule)} has no evaluation for ${dispatchId}`).toBeDefined()
          expect(
            evaluation?.matchOutcome,
            `sweep ${sweep}: ${identityOf(rule)} against ${dispatchId}`,
          ).toBe(trace?.matchOutcome)
          expect(evaluation?.reason, `sweep ${sweep}: ${identityOf(rule)} reason against ${dispatchId}`).toBe(trace?.reason)
          outcomeTally.set(evaluation?.matchOutcome ?? "missing", (outcomeTally.get(evaluation?.matchOutcome ?? "missing") ?? 0) + 1)
          comparedOutcomes += 1
          if (trace?.matchOutcome === "matched") matched.push(dispatchId)
        }
        matchedRules += matched.length
        expect([...reported.matchedHistory].sort(), `sweep ${sweep}: ${identityOf(rule)} matched set`).toEqual(matched.sort())
        expect(reported.matchedHistoryCount).toBe(matched.length)
      }
    }

    // The sweep has to have actually swept, on a distribution broad enough to be
    // worth sweeping. A generator that silently produced only refusals, or only
    // ineligible rules, would leave this file green while testing nothing, so the
    // counts are ASSERTED rather than logged.
    //
    // `comparedOutcomes` was 970 before the M6.10 HIGH-1 fix, 807 after it, and is
    // 733 now. Each drop is a fix working: the generator emits predicates that look
    // plausible but are vacuous or un-disclosable — `capability none [...]`,
    // `roleVersion gte 1`, bare `not`s, and now the cross-axis `any` at
    // PREDICATE_SHAPES[5] — which the compiler REFUSES as universal pre-approvals,
    // so fewer generated sets compile and fewer outcomes get compared. The threshold
    // moves with the reality rather than being deleted, because a divergence sweep
    // whose breadth assertion was loosened to "any number above zero" would stop
    // detecting a generator that had quietly stopped generating anything.
    //
    // The third drop is worth naming: `any(projectId eq "p", roleId eq "r")` was on
    // this list as a legitimate cross-axis disjunction until the independent review
    // showed it is a grant — the disclosure renders the union as a per-axis product,
    // so the rule fires for roles the disclosure does not name. The generator was
    // feeding the sweep a shape that should never have compiled, which is precisely
    // the class of defect a divergence sweep is supposed to catch and here it was
    // being supplied by the fixture instead.
    expect(compiledSets).toBeGreaterThan(180)
    expect(refusedSets).toBeGreaterThan(0)
    // And the refusals are the ones the language is SUPPOSED to make — a
    // pre-approval or a routing preference that constrains nothing, or constrains
    // it in a way the disclosure cannot render (ADR 0007 sections 8.2.3 and 8.2.5)
    // — rather than a generator producing malformed documents, which would mean the
    // sweep was walking the wrong class.
    expect([...refusalCodes.keys()]).toEqual(["rule.universal_pre_approval"])
    expect(comparedOutcomes).toBeGreaterThan(700)
    // And it has to have visited the outcomes that matter. `matched` and
    // `not_matched` alone would mean the sweep never reached a disabled,
    // superseded, expired or out-of-scope rule, which is where a preview and an
    // evaluator are most likely to describe the same absence differently.
    for (const outcome of ["matched", "not_matched", "disabled", "not_activated", "expired", "revoked", "project_scope_mismatch", "superseded"]) {
      expect(outcomeTally.get(outcome) ?? 0, `the sweep never observed '${outcome}'`).toBeGreaterThan(0)
    }
    expect(matchedRules).toBeGreaterThan(150)
  })

  it("produces a byte-identical preview for every variation across 3 repeated runs", () => {
    // Determinism is the property the divergence sweep would quietly depend on:
    // if the preview were not a function of its inputs, a disagreement found on
    // one run might not reproduce on the next, and "did not reproduce" would be
    // indistinguishable from "did not happen". The generator is RE-SEEDED for
    // each pass, so the three passes walk the same cases in the same order and
    // the lists must match element for element rather than merely in length.
    const passes: string[][] = []
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const random = makeRng(SEED)
      const digests: string[] = []
      for (let sweep = 0; sweep < 40; sweep += 1) {
        const documents = Array.from({ length: 1 + Math.floor(random() * 3) }, (_unused, index) => randomRuleDocument(random, index))
        const entries = Array.from({ length: 1 + Math.floor(random() * 3) }, (_unused, index) => randomHistoryEntry(random, index))
        const compiled = compileRuleSet(documents)
        if (!compiled.ok) continue
        const result = previewCompiledRuleSet(compiled.value, { proposals: entries, finishedDispatches: [] }, {
          now: "2026-03-02T09:00:00Z",
          actorId: "user-sweep",
          activationConfirmed: false,
        })
        if (!result.ok) continue
        digests.push(`${result.value.digest} ${result.value.explanationText}`)
      }
      expect(digests.length).toBeGreaterThan(20)
      passes.push(digests)
    }
    expect(passes[1]).toEqual(passes[0])
    expect(passes[2]).toEqual(passes[0])
  })
})

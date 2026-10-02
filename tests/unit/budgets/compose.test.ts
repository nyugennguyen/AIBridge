/**
 * M6.5 — budget composition: the algebra, the widening discipline, and cost
 * honesty.
 *
 * The properties asserted here are the ones that make a budget UNBYPASSABLE, and
 * they are asserted at the level of the claim rather than the level of the
 * example:
 *
 *   - elementwise `min` over present keys, crossed by hand on EVERY numeric
 *     field and in both directions (a tighter input, a looser input, an absent
 *     input);
 *   - a declared value above the current budget is recorded and ignored, naming
 *     the attempted value, and the result is never wider than EITHER input;
 *   - `usageUnit` is not composed, because `min` over a denominator is not a
 *     quantity;
 *   - enforceability comes from the OBSERVATION. A `maximumUsageUnits` budget
 *     with no adapter usage is `not_enforceable`, warns, and refuses nothing —
 *     and the same budget WITH usage is `enforceable` and does refuse. Both
 *     directions are asserted because a module that always said
 *     `not_enforceable` would pass the first and must fail the second.
 *
 * The cross-rule composition tests consume `RuleEvaluationResult.budgets`
 * STRUCTURALLY — the type is declared below, from the ADR's own wording, and
 * `src/rules` is never imported. See the docblock on `RuleBudgetCompositionLike`.
 */

import { describe, expect, it } from "vitest"
import {
  BUDGET_FIELDS,
  BUDGET_NUMERIC_FIELDS,
  NO_BUDGET_OBSERVATION,
  admitUsage,
  budgetLimitsSchema,
  composeBudgets,
  composeBudgetsOrRefuse,
  scopeCeiling,
  reportedUsageObservation,
  type BudgetComposition,
  type BudgetContribution,
  type BudgetLimits,
  type BudgetObservation,
  type UsageObservation,
} from "../../../src/budgets/index.js"

// ===========================================================================
// The structural boundary with the rule engine
// ===========================================================================

/**
 * `RuleEvaluationResult.budgets`, declared STRUCTURALLY.
 *
 * WHY declare it here rather than import it: ADR 0007 section 13.2 makes budget
 * reservation an input to dispatch eligibility, so the dependency runs
 * `budgets <- rules` — the rule engine PRODUCES budgets and this module consumes
 * them. Importing `src/rules` from `src/budgets` would invert that, and would put
 * a rule evaluator underneath the thing that gates launches, which is the shape
 * that lets a budget gain the power to decide which rules apply to it.
 *
 * `src/rules/types.ts:1238` declares the same shape. If the two drift, the
 * `barrel.test.ts` source scan does NOT catch it — so this file asserts
 * compatibility structurally instead: the fixture below is written to be
 * assignable to `BudgetComposition`'s limits and to carry exactly the members the
 * ADR names, and `composeRuleBudgetComposition` accepts it without a cast. A
 * change to either shape that breaks the other breaks the build.
 *
 * This is deliberately NOT a second budget evaluator. It does no matching, no
 * normalisation, and no coercion: it maps already-decided rule output onto the
 * one function `composeBudgets` already provides.
 */
interface RuleBudgetCompositionLike {
  /** Elementwise `min` of the applied contributions over the current budget. */
  readonly limits: BudgetLimits
  /** Sorted by field name, then by rule sort key. */
  readonly rejectedWidening: readonly {
    readonly ruleId: string
    readonly field: string
    readonly attempted: number
    readonly current: number
  }[]
}

/** The rule id and budget a single matched `set_stricter_budget` action contributes. */
interface RuleBudgetContributionLike {
  readonly ruleId: string
  readonly limits: BudgetLimits
}

/** Maps rule-engine output onto this module's contribution shape. No evaluation happens here. */
export function composeRuleBudgetComposition(
  base: BudgetLimits,
  contributions: readonly RuleBudgetContributionLike[],
  ruleResult: RuleBudgetCompositionLike,
  observation: BudgetObservation = NO_BUDGET_OBSERVATION,
): BudgetComposition {
  const mapped: readonly BudgetContribution[] = contributions.map((contribution) => ({
    source: contribution.ruleId,
    limits: contribution.limits,
  }))
  const composed = composeBudgets(base, mapped, observation)
  // The rule engine's own rejected-widening list and this module's must agree on
  // FACTS even though they are computed independently. Asserting it here rather
  // than trusting either is the point: two independent derivations that must
  // agree are worth more than one derivation nobody checked.
  for (const rejection of ruleResult.rejectedWidening) {
    const mine = composed.rejectedWidening.find(
      (attempt) => attempt.source === rejection.ruleId && attempt.field === rejection.field,
    )
    expect(mine, `rule '${rejection.ruleId}' field '${rejection.field}'`).toBeDefined()
    expect(mine?.attempted).toBe(rejection.attempted)
    expect(mine?.current).toBe(rejection.current)
  }
  return composed
}

// ===========================================================================
// Fixtures local to this file
// ===========================================================================

const BASE: BudgetLimits = {
  maximumConcurrency: 5,
  maximumFanOut: 3,
  maximumRetryLimit: 2,
  maximumWallClockSeconds: 600,
}

function contribution(source: string, limits: BudgetLimits): BudgetContribution {
  return { source, limits }
}

/** Every numeric field present, so a "cross every field" loop is exhaustive. */
function everyFieldWith(value: number): BudgetLimits {
  return {
    maximumConcurrency: value,
    maximumFanOut: value,
    maximumRetryLimit: value,
    maximumUsageUnits: value,
    maximumWallClockSeconds: value,
  }
}

// ===========================================================================
// Elementwise min
// ===========================================================================

describe("composeBudgets applies elementwise min over present keys", () => {
  it("takes the smaller value when a contribution is tighter than the base", () => {
    const composed = composeBudgets(BASE, [contribution("rule-a", { maximumConcurrency: 2, maximumFanOut: 8 })])
    expect(composed.limits.maximumConcurrency).toBe(2)
    // Fan-out was raised from 3 to 8, so it stays at 3 (see the widening tests).
    expect(composed.limits.maximumFanOut).toBe(3)
    expect(composed.rejectedWidening).toEqual([
      { source: "rule-a", field: "maximumFanOut", attempted: 8, current: 3 },
    ])
  })

  it("applies a contribution on a field the base does not declare, which is narrowing from unbounded", () => {
    const composed = composeBudgets({ maximumConcurrency: 5 }, [contribution("rule-a", { maximumFanOut: 9 })])
    expect(composed.limits.maximumConcurrency).toBe(5)
    expect(composed.limits.maximumFanOut).toBe(9)
    // Establishing a ceiling where there was none is not a widening attempt.
    expect(composed.rejectedWidening).toEqual([])
    expect(composed.warnings).toEqual([])
  })

  it("leaves a field absent from every input absent from the result", () => {
    const composed = composeBudgets({ maximumConcurrency: 4 }, [contribution("rule-a", { maximumRetryLimit: 1 })])
    expect(Object.keys(composed.limits).sort()).toEqual(["maximumConcurrency", "maximumRetryLimit"])
  })

  it("folds several contributions to the minimum across all of them", () => {
    const composed = composeBudgets(
      { maximumConcurrency: 9 },
      [contribution("rule-a", { maximumConcurrency: 7 }), contribution("rule-b", { maximumConcurrency: 3 })],
    )
    expect(composed.limits.maximumConcurrency).toBe(3)
  })

  it("crosses every numeric field in both directions and never returns a value above either input", () => {
    // Exhaustive by construction: the loop walks `BUDGET_NUMERIC_FIELDS`, so a
    // field added to the type without a case here fails to compile rather than
    // silently going untested.
    for (const field of BUDGET_NUMERIC_FIELDS) {
      const baseValue = 8
      const tighter = composeBudgets({ ...everyFieldWith(baseValue), [field]: baseValue }, [contribution("rule-a", { [field]: 3 } as BudgetLimits)])
      expect(tighter.limits[field], `${field} tighter`).toBe(3)
      const looser = composeBudgets({ ...everyFieldWith(baseValue), [field]: baseValue }, [contribution("rule-a", { [field]: 12 } as BudgetLimits)])
      expect(looser.limits[field], `${field} looser`).toBe(baseValue)
      expect(tighter.limits[field], `${field} never wider than base`).toBeLessThanOrEqual(baseValue)
      expect(looser.limits[field], `${field} never wider than base`).toBeLessThanOrEqual(baseValue)
    }
  })

  it("is frozen, so a caller cannot widen a composed budget in place after the fact", () => {
    const composed = composeBudgets({ maximumConcurrency: 4 })
    expect(Object.isFrozen(composed)).toBe(true)
    expect(Object.isFrozen(composed.limits)).toBe(true)
    expect(Object.isFrozen(composed.enforceability)).toBe(true)
    expect(Object.isFrozen(composed.warnings)).toBe(true)
  })
})

// ===========================================================================
// Widening attempts
// ===========================================================================

describe("composeBudgets records a widening attempt and never applies it", () => {
  it("returns the current budget when a contribution is above it", () => {
    const composed = composeBudgets({ maximumConcurrency: 5 }, [contribution("rule-x", { maximumConcurrency: 50 })])
    expect(composed.limits.maximumConcurrency).toBe(5)
    expect(composed.rejectedWidening).toEqual([
      { source: "rule-x", field: "maximumConcurrency", attempted: 50, current: 5 },
    ])
  })

  it("records a warning that names the attempted value, the current value, and the source", () => {
    const composed = composeBudgets({ maximumConcurrency: 5 }, [contribution("rule-x", { maximumConcurrency: 50 })])
    expect(composed.warnings).toHaveLength(1)
    const warning = composed.warnings[0]!
    expect(warning).toContain("maximumConcurrency")
    expect(warning).toContain("rule-x")
    expect(warning).toContain("50")
    expect(warning).toContain("5")
    // The warning has to say the attempt had NO effect, or a reader cannot tell
    // "we refused this" from "we applied it and it did not matter".
    expect(warning).toContain("ignored")
  })

  it("records a widening attempt for every numeric field crossed above the base", () => {
    const base = everyFieldWith(4)
    const composed = composeBudgets(base, [contribution("rule-x", everyFieldWith(9))])
    expect(composed.rejectedWidening.map((attempt) => attempt.field).sort()).toEqual([...BUDGET_NUMERIC_FIELDS].sort())
    for (const attempt of composed.rejectedWidening) {
      expect(attempt.current).toBe(4)
      expect(attempt.attempted).toBe(9)
    }
    // Nothing was applied.
    for (const field of BUDGET_NUMERIC_FIELDS) {
      expect(composed.limits[field]).toBe(4)
    }
  })

  it("records no widening attempt when a contribution EQUALS the base", () => {
    const composed = composeBudgets({ maximumConcurrency: 5 }, [contribution("rule-x", { maximumConcurrency: 5 })])
    expect(composed.limits.maximumConcurrency).toBe(5)
    expect(composed.rejectedWidening).toEqual([])
    expect(composed.warnings).toEqual([])
  })

  it("de-duplicates a repeated identical widening attempt from the same source", () => {
    const composed = composeBudgets(
      { maximumConcurrency: 5 },
      [contribution("rule-x", { maximumConcurrency: 9 }), contribution("rule-x", { maximumConcurrency: 9 })],
    )
    expect(composed.warnings).toHaveLength(1)
    expect(composed.rejectedWidening).toHaveLength(1)
  })

  it("sorts rejected widening attempts by field then source, in code-unit order", () => {
    const composed = composeBudgets(
      { maximumConcurrency: 1, maximumFanOut: 1 },
      [
        contribution("rule-z", { maximumFanOut: 9 }),
        contribution("rule-a", { maximumFanOut: 8 }),
        contribution("rule-a", { maximumConcurrency: 8 }),
      ],
    )
    expect(composed.rejectedWidening.map((attempt) => `${attempt.field}/${attempt.source}`)).toEqual([
      "maximumConcurrency/rule-a",
      "maximumFanOut/rule-a",
      "maximumFanOut/rule-z",
    ])
  })

  it("is never wider than either input, for any pair, checked field by field", () => {
    const next = (() => {
      let state = 7
      return () => ((state = (state * 31 + 17) % 997) / 997)
    })()
    for (let trial = 0; trial < 300; trial += 1) {
      const base: BudgetLimits = {}
      const incoming: BudgetLimits = {}
      for (const field of BUDGET_NUMERIC_FIELDS) {
        if (next() < 0.8) base[field] = 1 + Math.floor(next() * 12)
        if (next() < 0.8) incoming[field] = 1 + Math.floor(next() * 12)
      }
      const composed = composeBudgets(base, [contribution("rule-sweep", incoming)])
      for (const field of BUDGET_NUMERIC_FIELDS) {
        const result = composed.limits[field]
        if (base[field] !== undefined) expect(result, `base ${field}`).toBeLessThanOrEqual(base[field])
        if (incoming[field] !== undefined) expect(result, `incoming ${field}`).toBeLessThanOrEqual(incoming[field])
      }
    }
  })
})

// ===========================================================================
// usageUnit is a denominator, not a ceiling
// ===========================================================================

describe("composeBudgets does not apply min to usageUnit", () => {
  /**
   * Warnings mentioning `usageUnit` and a source, i.e. the CONFLICT warnings.
   *
   * Filtered rather than compared whole because a base that declares
   * `maximumUsageUnits` and no observation necessarily also carries the
   * not-enforceable usage warning — a different fact, asserted elsewhere — and a
   * test about unit composition should not have to account for it.
   */
  function unitConflictWarnings(warnings: readonly string[]): readonly string[] {
    return warnings.filter((warning) => warning.startsWith("budget.usageUnit:"))
  }

  it("keeps the base's unit and records a conflict when a contribution disagrees", () => {
    const composed = composeBudgets(
      { maximumUsageUnits: 1_000, usageUnit: "tokens" },
      [contribution("rule-x", { usageUnit: "bytes" })],
      reportedUsageObservation(10, "tokens"),
    )
    expect(composed.limits.usageUnit).toBe("tokens")
    const conflicts = unitConflictWarnings(composed.warnings)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toContain("rule-x")
    expect(conflicts[0]).toContain("bytes")
  })

  it("accepts a unit a later contribution AGREES with, without a conflict warning", () => {
    const composed = composeBudgets(
      { maximumUsageUnits: 1_000, usageUnit: "tokens" },
      [contribution("rule-a", { usageUnit: "tokens" })],
      reportedUsageObservation(10, "tokens"),
    )
    expect(composed.limits.usageUnit).toBe("tokens")
    expect(unitConflictWarnings(composed.warnings)).toEqual([])
    expect(composed.warnings).toEqual([])
  })

  it("adopts the first declared unit when the base declares none", () => {
    const composed = composeBudgets(
      { maximumUsageUnits: 10 },
      [contribution("rule-a", { usageUnit: "bytes" })],
      reportedUsageObservation(1, "bytes"),
    )
    expect(composed.limits.usageUnit).toBe("bytes")
    expect(unitConflictWarnings(composed.warnings)).toEqual([])
    // Establishing a denominator is not a widening, so it also produces no
    // `rejectedWidening` entry.
    expect(composed.rejectedWidening).toEqual([])
  })
})

// ===========================================================================
// Enforceability: the honesty property
// ===========================================================================

describe("enforceability is computed from the adapter observation, never from the budget being set", () => {
  const USAGE_BUDGET: BudgetLimits = { maximumUsageUnits: 1_000, usageUnit: "tokens" }

  it("reports a usage budget with NO adapter usage as not_enforceable, with a warning, and refuses nothing", () => {
    const composed = composeBudgets(USAGE_BUDGET, [], NO_BUDGET_OBSERVATION)
    expect(composed.limits.maximumUsageUnits).toBe(1_000)
    expect(composed.enforceability.maximumUsageUnits).toBe("not_enforceable")
    // The warning must NAME the budget, or a reader cannot tell which limit went
    // unenforced.
    expect(composed.warnings.some((warning) => warning.includes("maximumUsageUnits"))).toBe(true)
    // And nothing is refused: `composeBudgets` never refuses, and `admitUsage`
    // with the same observation must admit.
    const admission = admitUsage(composed.limits, NO_BUDGET_OBSERVATION, 10_000_000)
    expect(admission.admitted).toBe(true)
    expect(admission.enforceability).toBe("not_enforceable")
  })

  it("reports a usage budget WITH reliable adapter usage as enforceable", () => {
    const composed = composeBudgets(USAGE_BUDGET, [], reportedUsageObservation(100, "tokens"))
    expect(composed.enforceability.maximumUsageUnits).toBe("enforceable")
    expect(composed.enforceability.usageUnit).toBe("enforceable")
    expect(composed.warnings).toEqual([])
  })

  it("refuses a usage request that crosses a MEASURED budget", () => {
    // The direction that a "always not_enforceable" module would fail.
    const composed = composeBudgets(USAGE_BUDGET, [], reportedUsageObservation(900, "tokens"))
    expect(composed.enforceability.maximumUsageUnits).toBe("enforceable")
    const admission = admitUsage(composed.limits, reportedUsageObservation(900, "tokens"), 200)
    expect(admission.admitted).toBe(false)
    expect(admission.enforceability).toBe("enforceable")
    if (!admission.admitted) {
      expect(admission.refusal.code).toBe("budget.usage_exceeded")
      expect(admission.refusal.limit).toBe(1_000)
      expect(admission.refusal.heldUnits).toBe(900)
      expect(admission.refusal.requestedUnits).toBe(200)
    }
  })

  it("admits a usage request that stays under a MEASURED budget", () => {
    const admission = admitUsage(USAGE_BUDGET, reportedUsageObservation(900, "tokens"), 100)
    expect(admission.admitted).toBe(true)
    expect(admission.enforceability).toBe("enforceable")
  })

  it("is not_enforceable when the adapter reported usage it does not treat as reliable", () => {
    const unreliable: BudgetObservation = {
      usage: { reported: true, reliable: false, unit: "tokens", consumedUnits: 900 },
      retryCounting: true,
    }
    const composed = composeBudgets(USAGE_BUDGET, [], unreliable)
    expect(composed.enforceability.maximumUsageUnits).toBe("not_enforceable")
    const admission = admitUsage(USAGE_BUDGET, unreliable, 1_000_000)
    expect(admission.admitted).toBe(true)
  })

  it("is not_enforceable when the adapter measured a DIFFERENT unit than the budget declares", () => {
    // tokens against a bytes budget is not a comparison, it is two numbers
    // subtracted, so this must not be reported as enforceable and must not refuse.
    const observation = reportedUsageObservation(900, "bytes")
    const composed = composeBudgets(USAGE_BUDGET, [], observation)
    expect(composed.enforceability.maximumUsageUnits).toBe("not_enforceable")
    expect(composed.warnings.some((warning) => warning.includes("bytes") && warning.includes("tokens"))).toBe(true)
    expect(admitUsage(USAGE_BUDGET, observation, 1_000_000).admitted).toBe(true)
  })

  it("is not_enforceable when the budget declares no unit for the adapter to compare against", () => {
    const composed = composeBudgets({ maximumUsageUnits: 1_000 }, [], reportedUsageObservation(10, "tokens"))
    expect(composed.enforceability.maximumUsageUnits).toBe("not_enforceable")
    expect(admitUsage({ maximumUsageUnits: 1_000 }, reportedUsageObservation(10, "tokens"), 1_000_000).admitted).toBe(true)
  })

  it("reports a USAGE budget that was never set as not_enforceable without warning about it", () => {
    // An absent budget is not an unenforced budget; warning about it would be
    // noise, and a caller reading the warning list needs it to mean something.
    const composed = composeBudgets({ maximumConcurrency: 5 })
    expect(composed.enforceability.maximumUsageUnits).toBe("not_enforceable")
    expect(composed.warnings.some((warning) => warning.includes("maximumUsageUnits"))).toBe(false)
  })

  it("reports the ledger-enforced fields as enforceable whenever they are set", () => {
    const composed = composeBudgets({ maximumConcurrency: 5, maximumFanOut: 3, maximumWallClockSeconds: 60 })
    expect(composed.enforceability.maximumConcurrency).toBe("enforceable")
    expect(composed.enforceability.maximumFanOut).toBe("enforceable")
    expect(composed.enforceability.maximumWallClockSeconds).toBe("enforceable")
  })

  it("reports a retry limit as not_enforceable when no retry counter was reported, and warns", () => {
    const composed = composeBudgets({ maximumRetryLimit: 2 })
    expect(composed.enforceability.maximumRetryLimit).toBe("not_enforceable")
    expect(composed.warnings.some((warning) => warning.includes("maximumRetryLimit"))).toBe(true)
    // Reported counter -> enforceable, no warning.
    const counted: BudgetObservation = {
      usage: { reported: false, reliable: false, unit: null, consumedUnits: null },
      retryCounting: true,
    }
    const withCounter = composeBudgets({ maximumRetryLimit: 2 }, [], counted)
    expect(withCounter.enforceability.maximumRetryLimit).toBe("enforceable")
    expect(withCounter.warnings).toEqual([])
  })

  it("gives every field of BudgetLimits a verdict, so no key can read as undefined", () => {
    const composed = composeBudgets({})
    expect(Object.keys(composed.enforceability).sort()).toEqual([...BUDGET_FIELDS].sort())
    for (const field of BUDGET_FIELDS) {
      expect(["enforceable", "not_enforceable"]).toContain(composed.enforceability[field])
    }
  })
})

describe("admitUsage reports a reason for every outcome and refuses an unaddable request", () => {
  const USAGE_BUDGET: BudgetLimits = { maximumUsageUnits: 100, usageUnit: "tokens" }

  it("admits with usage_no_budget when no usage budget is declared", () => {
    const admission = admitUsage({ maximumConcurrency: 5 }, reportedUsageObservation(10, "tokens"), 10)
    expect(admission.admitted).toBe(true)
    expect(admission.reason).toBe("usage_no_budget")
    expect(admission.enforceability).toBe("not_enforceable")
  })

  it("admits with usage_not_reported when the adapter reported nothing", () => {
    const admission = admitUsage(USAGE_BUDGET, NO_BUDGET_OBSERVATION, 10)
    expect(admission.admitted).toBe(true)
    expect(admission.reason).toBe("usage_not_reported")
    expect(admission.warnings.some((warning) => warning.includes("maximumUsageUnits"))).toBe(true)
  })

  it("admits with usage_unit_unreported when the adapter gave no unit", () => {
    const observation: BudgetObservation = {
      usage: { reported: true, reliable: true, unit: null, consumedUnits: 10 },
      retryCounting: true,
    }
    const admission = admitUsage(USAGE_BUDGET, observation, 10)
    expect(admission.admitted).toBe(true)
    expect(admission.reason).toBe("usage_unit_unreported")
  })

  it("admits with usage_figure_unreported when the adapter gave no figure", () => {
    const observation: BudgetObservation = {
      usage: { reported: true, reliable: true, unit: "tokens", consumedUnits: null },
      retryCounting: true,
    }
    const admission = admitUsage(USAGE_BUDGET, observation, 10)
    expect(admission.admitted).toBe(true)
    expect(admission.reason).toBe("usage_figure_unreported")
  })

  it("refuses a negative or fractional requestedUnits rather than treating it as zero", () => {
    for (const requested of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const admission = admitUsage(USAGE_BUDGET, reportedUsageObservation(10, "tokens"), requested)
      expect(admission.admitted, `requested=${requested}`).toBe(false)
      if (!admission.admitted) expect(admission.refusal.code).toBe("budget.units_invalid")
    }
  })

  it("admits a zero-unit usage request against a measured budget, which is a no-op not a bypass", () => {
    const admission = admitUsage(USAGE_BUDGET, reportedUsageObservation(10, "tokens"), 0)
    expect(admission.admitted).toBe(true)
    expect(admission.enforceability).toBe("enforceable")
  })
})

// ===========================================================================
// Validation
// ===========================================================================

describe("composeBudgets refuses a budget it cannot read rather than coercing it", () => {
  it("returns a named refusal through composeBudgetsOrRefuse for an unreadable base", () => {
    const result = composeBudgetsOrRefuse({ maximumConcurrency: 5.5 } as unknown as BudgetLimits)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.code).toBe("budget.request_invalid")
  })

  it("names the offending source when a contribution is unreadable", () => {
    const result = composeBudgetsOrRefuse({ maximumConcurrency: 5 }, [
      { source: "rule-bad", limits: { maximumFanOut: 0 } as unknown as BudgetLimits },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.message).toContain("rule-bad")
  })

  it("refuses a limits object carrying a key the schema does not define", () => {
    expect(budgetLimitsSchema.safeParse({ maximumConcurrenc: 5 }).success).toBe(false)
    expect(budgetLimitsSchema.safeParse({ maximumConcurrency: 5 }).success).toBe(true)
  })
})

describe("scopeCeiling distinguishes a declared ceiling from an absent one", () => {
  it("reads each scope's own limit", () => {
    const limits: BudgetLimits = { maximumConcurrency: 5, maximumFanOut: 3 }
    expect(scopeCeiling(limits, "concurrency")).toBe(5)
    expect(scopeCeiling(limits, "fan_out")).toBe(3)
  })

  it("returns null for an undeclared scope rather than inventing a large number", () => {
    // A caller mapping "unbounded" onto Infinity and adding to it would produce a
    // NaN refusal message; mapping it onto a concrete maximum would be inventing a
    // limit nobody set.
    expect(scopeCeiling({ maximumFanOut: 3 }, "concurrency")).toBeNull()
    expect(scopeCeiling({}, "fan_out")).toBeNull()
  })
})

// ===========================================================================
// Cross-rule composition, structurally
// ===========================================================================

describe("two rules each setting set_stricter_budget compose to the elementwise minimum", () => {
  it("folds rule-a and rule-b over the project budget and applies the tighter of the two", () => {
    const ruleResult: RuleBudgetCompositionLike = { limits: { maximumConcurrency: 2, maximumFanOut: 3 }, rejectedWidening: [] }
    const composed = composeRuleBudgetComposition(
      { maximumConcurrency: 8, maximumFanOut: 4 },
      [
        { ruleId: "rule-a", limits: { maximumConcurrency: 5, maximumFanOut: 2 } },
        { ruleId: "rule-b", limits: { maximumConcurrency: 2 } },
      ],
      ruleResult,
    )
    expect(composed.limits.maximumConcurrency).toBe(2)
    expect(composed.limits.maximumFanOut).toBe(2)
    expect(composed.rejectedWidening).toEqual([])
  })

  it("records a widening attempt when a rule sets a LOOSER budget than the project", () => {
    const ruleResult: RuleBudgetCompositionLike = {
      limits: { maximumConcurrency: 4 },
      rejectedWidening: [{ ruleId: "rule-loose", field: "maximumConcurrency", attempted: 99, current: 4 }],
    }
    const composed = composeRuleBudgetComposition(
      { maximumConcurrency: 4 },
      [{ ruleId: "rule-loose", limits: { maximumConcurrency: 99 } }],
      ruleResult,
    )
    // The project budget is UNCHANGED. A rule that asks for more gets nothing.
    expect(composed.limits.maximumConcurrency).toBe(4)
    expect(composed.rejectedWidening).toEqual([
      { source: "rule-loose", field: "maximumConcurrency", attempted: 99, current: 4 },
    ])
    expect(composed.warnings.some((warning) => warning.includes("rule-loose") && warning.includes("99"))).toBe(true)
  })

  it("records the narrowing attempt only once when TWO rules each try to loosen the same field", () => {
    const ruleResult: RuleBudgetCompositionLike = { limits: { maximumConcurrency: 4 }, rejectedWidening: [] }
    const composed = composeRuleBudgetComposition(
      { maximumConcurrency: 4 },
      [
        { ruleId: "rule-a", limits: { maximumConcurrency: 8 } },
        { ruleId: "rule-b", limits: { maximumConcurrency: 12 } },
      ],
      ruleResult,
    )
    expect(composed.limits.maximumConcurrency).toBe(4)
    expect(composed.rejectedWidening).toHaveLength(2)
    expect(composed.rejectedWidening.map((attempt) => attempt.source).sort()).toEqual(["rule-a", "rule-b"])
  })

  it("is the same composition whether the contributions arrive in rule order or reversed", () => {
    const base: BudgetLimits = { maximumConcurrency: 8, maximumFanOut: 8 }
    const a: RuleBudgetContributionLike = { ruleId: "rule-a", limits: { maximumConcurrency: 3 } }
    const b: RuleBudgetContributionLike = { ruleId: "rule-b", limits: { maximumFanOut: 2 } }
    const empty: RuleBudgetCompositionLike = { limits: {}, rejectedWidening: [] }
    const forward = composeRuleBudgetComposition(base, [a, b], empty)
    const reversed = composeRuleBudgetComposition(base, [b, a], empty)
    expect(reversed.limits).toEqual(forward.limits)
    expect(reversed.warnings).toEqual(forward.warnings)
  })
})

// ===========================================================================
// Purity
// ===========================================================================

describe("composeBudgets is pure", () => {
  it("produces a byte-identical composition for identical inputs", () => {
    const observation: UsageObservation = { reported: true, reliable: true, unit: "tokens", consumedUnits: 5 }
    const first = composeBudgets(USAGE_ONLY, [contribution("rule-a", { maximumUsageUnits: 50 })], {
      usage: observation,
      retryCounting: true,
    })
    const second = composeBudgets(USAGE_ONLY, [contribution("rule-a", { maximumUsageUnits: 50 })], {
      usage: observation,
      retryCounting: true,
    })
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it("does not mutate the base budget it was given", () => {
    const base: BudgetLimits = { maximumConcurrency: 8 }
    composeBudgets(base, [contribution("rule-a", { maximumConcurrency: 2, maximumFanOut: 2 })])
    expect(base).toEqual({ maximumConcurrency: 8 })
  })

  it("does not mutate a contribution it was given", () => {
    const incoming: BudgetLimits = { maximumConcurrency: 99 }
    composeBudgets({ maximumConcurrency: 8 }, [contribution("rule-a", incoming)])
    expect(incoming).toEqual({ maximumConcurrency: 99 })
  })

  it("defaults to the pessimistic observation when none is supplied", () => {
    const composed = composeBudgets({ maximumUsageUnits: 10, usageUnit: "tokens" })
    expect(composed.enforceability.maximumUsageUnits).toBe("not_enforceable")
    expect(composed.warnings.length).toBeGreaterThan(0)
  })
})

const USAGE_ONLY: BudgetLimits = { maximumUsageUnits: 1_000, usageUnit: "tokens" }

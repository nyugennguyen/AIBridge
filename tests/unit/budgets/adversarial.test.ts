/**
 * M6.5 — adversarial tests. The properties, stated as claims a broken module
 * would fail, and swept rather than exemplified.
 *
 * WHY this file exists separately from `compose.test.ts`, which already asserts
 * elementwise `min` by hand on every field: a hand-built example proves the branch
 * under it works, and a bug in the branch that only fires on an input shape nobody
 * thought of is exactly what a hand-built example cannot reach. Everything here is
 * therefore either a SWEEP over a seeded generator or a test whose failure mode is
 * "the module claimed something it cannot know".
 *
 * The claims, and the implementation bug each one is aimed at:
 *
 *   - **A1 — Monotonicity.** For every pair of budgets, the composed result is
 *     `<=` BOTH inputs on every present numeric key. Aimed at any branch that
 *     assigns a contribution's value without comparing it to the running minimum —
 *     e.g. a `Math.min` that was written as `||`, where a base of `0` would be
 *     replaced by the contribution's value. `Math.min(x, 0)` is `0` and `x || y`
 *     is `y`, so a falsy-handling mistake here is silent on every non-zero fixture.
 *     `maximumRetryLimit` admits `0` precisely so that sweep has a way to reach it.
 *   - **A2 — Cost honesty, in BOTH directions.** A usage budget with no reliable
 *     measurement is `not_enforceable`, warns, and ADMITS; the same budget with a
 *     reliable measurement in the declared unit is `enforceable` and REFUSES when
 *     the request crosses the limit. A module that always answered
 *     `not_enforceable` passes the first half and fails the second; one that always
 *     answered `enforceable` does the reverse. Neither half is optional, which is
 *     why they are asserted adjacently rather than in two files.
 *   - **A3 — No budget is unbypassable via its absence.** An absent limit is
 *     `not_enforceable` with NO warning (there is nothing to warn about), and a
 *     limit whose enforcer reported nothing is `not_enforceable` WITH a warning
 *     naming it. The distinction matters because a caller triaging warnings needs
 *     "nobody asked for this" to read differently from "we cannot enforce this".
 *   - **A4 — Determinism.** The same inputs produce a byte-identical composition,
 *     on every sweep iteration, so a sweep result is reproducible and a failure can
 *     be re-run. `Math.random()` and a host clock would both make the sweeps
 *     unfalsifiable.
 *
 * Determinism mechanism: `seededLcg` from `./fixtures.js`, seeded per test with a
 * literal. `Math.random()` is never used (types.ts I7), so every assertion below
 * has exactly one reproducible outcome.
 */

import { describe, expect, it } from "vitest"
import {
  BUDGET_FIELDS,
  BUDGET_NUMERIC_FIELDS,
  BUDGET_REFUSALS,
  InMemoryBudgetLedgerStore,
  NO_BUDGET_OBSERVATION,
  REPLAY_REJECTION_REASONS,
  USAGE_ADMISSION_REASONS,
  admitUsage,
  budgetDecisionSchema,
  composeBudgets,
  reportedUsageObservation,
  replayDurableReservations,
  type BudgetComposition,
  type BudgetContribution,
  type BudgetDecision,
  type BudgetLimits,
  type BudgetObservation,
} from "../../../src/budgets/index.js"
import { NOW, PROJECT_ID, heldRecords, randomBudget, randomInt, reservationRecord, seededLcg } from "./fixtures.js"

/** A contribution from a named source. The `source` is what a widening attempt is attributed to. */
function contribution(source: string, limits: BudgetLimits): BudgetContribution {
  return { source, limits }
}

// ===========================================================================
// A1 — Monotonicity, swept
// ===========================================================================

describe("composition is monotone non-widening over a seeded sweep", () => {
  it("never returns a value above either input, on any present key, over 512 budget pairs", () => {
    // 512 pairs x 5 numeric fields x up to 2 inputs = the assertion runs thousands
    // of times, from ONE seed, so a failure is reproducible by re-running.
    const next = seededLcg(20_260_301)
    let pairs = 0
    let comparisons = 0
    let wideningAttempts = 0

    for (let trial = 0; trial < 512; trial += 1) {
      // Two independently-generated budgets, each with fields absent about one time
      // in six. A sweep over only fully-populated budgets would never reach the
      // "the base does not declare this field" branch, which is the branch where a
      // narrowing/widening confusion would be easiest to hide.
      const base = randomBudget(next)
      const incoming = randomBudget(next)
      const composed = composeBudgets(base, [contribution("rule-sweep", incoming)])
      pairs += 1
      wideningAttempts += composed.rejectedWidening.length

      for (const field of BUDGET_NUMERIC_FIELDS) {
        const result = composed.limits[field]
        if (base[field] !== undefined) {
          comparisons += 1
          expect(result, `trial ${trial} field ${field} vs base`).toBeLessThanOrEqual(base[field]!)
        }
        if (incoming[field] !== undefined) {
          comparisons += 1
          expect(result, `trial ${trial} field ${field} vs incoming`).toBeLessThanOrEqual(incoming[field]!)
        }
      }

      // Every key present in an input must be present in the result: `min` never
      // DELETES a limit. A composition that dropped a limit when one side declared it
      // would pass every `<=` assertion above while silently unbinding the budget.
      for (const field of BUDGET_NUMERIC_FIELDS) {
        if (base[field] !== undefined || incoming[field] !== undefined) {
          expect(composed.limits[field], `trial ${trial} field ${field} presence`).toBeDefined()
        }
      }
    }

    // Guard the sweep against being vacuous. Without these, a generator that stopped
    // producing values would leave 512 iterations asserting nothing.
    expect(pairs).toBe(512)
    expect(comparisons).toBeGreaterThan(2_000)
    // Widening attempts must actually occur, or A1 would only ever have been
    // exercised in the direction where the base is tighter.
    expect(wideningAttempts).toBeGreaterThan(0)
  })

  it("reaches a falsy base value of 0 and still narrows rather than substitutes", () => {
    // The one place `min` and `||` disagree: `Math.min(0, 5)` is `0` and
    // `0 || 5` is `5`. `maximumRetryLimit` is the only field whose range includes
    // `0`, so it is the only field on which a falsy-handling bug is observable —
    // which is exactly why that field's range admits `0` at all.
    expect(composeBudgets({ maximumRetryLimit: 0 }).limits.maximumRetryLimit).toBe(0)
    expect(composeBudgets({ maximumRetryLimit: 0 }, [contribution("rule-a", { maximumRetryLimit: 5 })]).limits.maximumRetryLimit).toBe(0)
    // And the mirror: a base of `0` with a contribution of `0` is not a widening
    // attempt, because it is not an increase.
    const equal = composeBudgets({ maximumRetryLimit: 0 }, [contribution("rule-a", { maximumRetryLimit: 0 })])
    expect(equal.limits.maximumRetryLimit).toBe(0)
    expect(equal.rejectedWidening).toEqual([])
  })

  it("composes three or more contributions to the minimum across all of them, not the last one read", () => {
    // A composition that assigned in iteration order rather than folding would return
    // whatever the final contribution said. The contributions are ordered so that
    // neither the first nor the last is the minimum.
    const composed = composeBudgets(
      { maximumConcurrency: 9 },
      [
        contribution("rule-a", { maximumConcurrency: 7 }),
        contribution("rule-b", { maximumConcurrency: 2 }),
        contribution("rule-c", { maximumConcurrency: 5 }),
      ],
    )
    expect(composed.limits.maximumConcurrency).toBe(2)
  })

  it("is byte-identical for identical inputs, on every sweep iteration", () => {
    const next = seededLcg(777)
    for (let trial = 0; trial < 128; trial += 1) {
      const base = randomBudget(next)
      const incoming = randomBudget(next)
      const observation: BudgetObservation =
        trial % 2 === 0
          ? NO_BUDGET_OBSERVATION
          : reportedUsageObservation(randomInt(next, 0, 5_000), "tokens")
      const contributions = [contribution("rule-a", incoming), contribution("rule-b", randomBudget(next))]
      const first = composeBudgets(base, contributions, observation)
      const second = composeBudgets(base, contributions, observation)
      // Serialised, not compared field by field: a byte-identical claim is a claim
      // about the whole object, including key insertion order.
      expect(JSON.stringify(second), `trial ${trial}`).toBe(JSON.stringify(first))
    }
  })
})

// ===========================================================================
// A2 — Cost honesty, in both directions
// ===========================================================================

describe("a usage budget is enforceable only when a measurement supports it, and neither failure mode is silent", () => {
  const MEASURED_BUDGET: BudgetLimits = { maximumUsageUnits: 1_000, usageUnit: "tokens" }

  it("refuses a request that crosses a MEASURED limit, carrying the limit, the consumed figure and the request", () => {
    // The direction a permanently-`not_enforceable` module fails. It has to be
    // asserted here, with real numbers, or "honest" and "useless" are the same
    // implementation.
    const observation = reportedUsageObservation(900, "tokens")
    const composed = composeBudgets(MEASURED_BUDGET, [], observation)
    expect(composed.enforceability.maximumUsageUnits).toBe("enforceable")

    const admission = admitUsage(MEASURED_BUDGET, observation, 200)
    expect(admission.admitted).toBe(false)
    expect(admission.reason).toBe("usage_budget_exceeded")
    expect(admission.enforceability).toBe("enforceable")
    if (!admission.admitted) {
      expect(admission.refusal.code).toBe("budget.usage_exceeded")
      expect(admission.refusal.limit).toBe(1_000)
      expect(admission.refusal.heldUnits).toBe(900)
      expect(admission.refusal.requestedUnits).toBe(200)
      // The projected figure is stated, so an operator can see HOW FAR over the
      // limit the request was rather than having to reconstruct it.
      expect(admission.refusal.message).toContain("1100")
    }
    // A warning here would be a claim that the limit is NOT being enforced, which is
    // the opposite of what just happened.
    expect(admission.warnings).toEqual([])
  })

  it("admits an arbitrarily large request when the same budget has NO measurement, and says so", () => {
    // The direction a permanently-`enforceable` module fails. Refusing here would be
    // inventing a consumption figure nobody reported.
    const composed = composeBudgets(MEASURED_BUDGET, [], NO_BUDGET_OBSERVATION)
    expect(composed.limits.maximumUsageUnits).toBe(1_000)
    expect(composed.enforceability.maximumUsageUnits).toBe("not_enforceable")

    const admission = admitUsage(MEASURED_BUDGET, NO_BUDGET_OBSERVATION, 1_000_000_000)
    expect(admission.admitted).toBe(true)
    expect(admission.enforceability).toBe("not_enforceable")
    expect(admission.reason).toBe("usage_not_reported")
    // The warning has to NAME the budget, or a reader cannot tell which limit went
    // unenforced.
    expect(admission.warnings.some((warning) => warning.includes("maximumUsageUnits"))).toBe(true)
    // And it has to say no dispatch is refused on it, so a reader does not infer a
    // refusal from the presence of a warning.
    expect(admission.warnings.every((warning) => warning.includes("no dispatch is refused"))).toBe(true)
  })

  it("switches from refusing to admitting on the observation ALONE, with the budget unchanged", () => {
    // The sharpest form of A2: identical limits, identical request, opposite
    // outcomes. Nothing about the DOCUMENT changes — only what the runtime adapter
    // reported. So "enforceable" cannot be a property of the budget, which is
    // exactly the claim being tested.
    const request = 5_000
    const unmeasured = admitUsage(MEASURED_BUDGET, NO_BUDGET_OBSERVATION, request)
    const measured = admitUsage(MEASURED_BUDGET, reportedUsageObservation(0, "tokens"), request)
    expect(unmeasured.admitted).toBe(true)
    expect(measured.admitted).toBe(false)
    // Same limit object both times, so the only thing that changed the outcome is
    // the observation.
    if (!measured.admitted) {
      expect(measured.refusal.limit).toBe(1_000)
      expect(measured.refusal.requestedUnits).toBe(request)
    }
  })

  it("treats every partial measurement as unmeasurable rather than as zero", () => {
    // Four distinct holes in the evidence, each producing an admission and a named
    // reason. A module that defaulted any of them to `0` would enforce the limit
    // against a figure it made up.
    const holes: readonly { readonly observation: BudgetObservation; readonly reason: string }[] = [
      { observation: NO_BUDGET_OBSERVATION, reason: "usage_not_reported" },
      {
        observation: { usage: { reported: true, reliable: false, unit: "tokens", consumedUnits: 0 }, retryCounting: true },
        reason: "usage_unreliable",
      },
      {
        observation: { usage: { reported: true, reliable: true, unit: null, consumedUnits: 0 }, retryCounting: true },
        reason: "usage_unit_unreported",
      },
      {
        observation: { usage: { reported: true, reliable: true, unit: "tokens", consumedUnits: null }, retryCounting: true },
        reason: "usage_figure_unreported",
      },
    ]
    for (const hole of holes) {
      const admission = admitUsage(MEASURED_BUDGET, hole.observation, 1_000_000)
      expect(admission.admitted, hole.reason).toBe(true)
      expect(admission.reason, hole.reason).toBe(hole.reason)
      expect(admission.enforceability, hole.reason).toBe("not_enforceable")
    }
  })

  it("never treats a unit the budget did not declare as a basis for enforcement", () => {
    // `maximumUsageUnits` with no `usageUnit` and a perfect measurement is still not
    // enforceable: the number has no denominator, so comparing it is meaningless.
    const composed = composeBudgets({ maximumUsageUnits: 1_000 }, [], reportedUsageObservation(0, "tokens"))
    expect(composed.enforceability.maximumUsageUnits).toBe("not_enforceable")
    expect(admitUsage({ maximumUsageUnits: 1_000 }, reportedUsageObservation(0, "tokens"), 1_000_000).admitted).toBe(true)
  })
})

// ===========================================================================
// A3 — Absence is not the same as unenforceability
// ===========================================================================

describe("an absent budget and an unenforced budget are reported differently", () => {
  it("warns about a budget that was set but cannot be enforced, and stays silent about one that was never set", () => {
    const setButUnmeasured = composeBudgets({ maximumUsageUnits: 100 }, [], NO_BUDGET_OBSERVATION)
    expect(setButUnmeasured.enforceability.maximumUsageUnits).toBe("not_enforceable")
    expect(setButUnmeasured.warnings.filter((warning) => warning.includes("maximumUsageUnits"))).toHaveLength(1)

    const neverSet = composeBudgets({ maximumConcurrency: 5 }, [], NO_BUDGET_OBSERVATION)
    expect(neverSet.enforceability.maximumUsageUnits).toBe("not_enforceable")
    // No warning: there is nothing to enforce and nothing anybody asked for, so a
    // warning would be noise that trains a reader to ignore the list.
    expect(neverSet.warnings.filter((warning) => warning.includes("maximumUsageUnits"))).toHaveLength(0)
  })

  it("reports not_enforceable for EVERY absent key without warning about any of them", () => {
    const composed = composeBudgets({}, [], NO_BUDGET_OBSERVATION)
    expect(composed.limits).toEqual({})
    for (const field of BUDGET_FIELDS) {
      expect(composed.enforceability[field], field).toBe("not_enforceable")
    }
    expect(composed.warnings).toEqual([])
  })

  it("validates every composed decision against its own schema before returning it", () => {
    // The composition assembles `limits` member by member rather than through Zod,
    // so this is the check that a field it built cannot be one the schema would
    // refuse.
    //
    // Parsed through the THREE ADR MEMBERS rather than the whole composition:
    // `budgetDecisionSchema` is `.strict()`, and `BudgetComposition` is a documented
    // additive extension carrying a fourth member, `rejectedWidening`
    // (`types.ts:369-381`). Parsing the extended object against the ADR shape would
    // fail on that member alone, so the check is "the ADR-shaped projection is a
    // valid `BudgetDecision`", which is the claim that actually matters to a caller
    // on the M0 contract path.
    const next = seededLcg(4242)
    for (let trial = 0; trial < 200; trial += 1) {
      const composed = composeBudgets(randomBudget(next), [contribution("rule-sweep", randomBudget(next))])
      expect(budgetDecisionSchema.safeParse(adrProjectionOf(composed)).success, `trial ${trial}`).toBe(true)
    }
  })

  it("keeps every composed decision within the declared warning bound", () => {
    // A warning list is a function of the fields and the observation, so its length
    // is bounded by construction; a caller rendering it into an audit view needs a
    // known worst case.
    const next = seededLcg(9_001)
    let widest = 0
    for (let trial = 0; trial < 300; trial += 1) {
      // Every field set AND a conflicting unit from a second source maximises the
      // number of distinct warnings a composition can produce.
      const composed = composeBudgets(
        { ...randomBudget(next), usageUnit: "tokens" },
        [
          contribution("rule-a", { ...everyNumericField(9), usageUnit: "bytes" }),
          contribution("rule-b", { ...everyNumericField(11), usageUnit: "provider_cost_micros" }),
        ],
        NO_BUDGET_OBSERVATION,
      )
      widest = Math.max(widest, composed.warnings.length)
      expect(budgetDecisionSchema.safeParse(adrProjectionOf(composed)).success, `trial ${trial}`).toBe(true)
    }
    // Loose bound: the point is that the count is a small constant, not a function of
    // the number of contributions.
    expect(widest).toBeLessThanOrEqual(32)
  })

  it("is assignable to the ADR's BudgetDecision shape without a cast, extension and all", () => {
    // The additive extension is only safe if a caller that knows nothing about
    // `rejectedWidening` can still hold the result. This is the structural half of
    // the check above: `expectTypeOf` would be the usual tool, but a plain
    // assignment to a `BudgetDecision`-typed binding makes the same statement and
    // fails the build on a change.
    const composed = composeBudgets({ maximumConcurrency: 5 }, [contribution("rule-a", { maximumConcurrency: 2 })])
    const decision: BudgetDecision = composed
    expect(decision.limits.maximumConcurrency).toBe(2)
    // And the extension is still reachable for a caller that wants it.
    expect(composed.rejectedWidening).toEqual([])
  })
})

/** The three members ADR 0007 section 13.1 names, with the extension dropped. */
function adrProjectionOf(composition: BudgetComposition): BudgetDecision {
  return { limits: composition.limits, enforceability: composition.enforceability, warnings: composition.warnings }
}

function everyNumericField(value: number): BudgetLimits {
  return {
    maximumConcurrency: value,
    maximumFanOut: value,
    maximumRetryLimit: value,
    maximumUsageUnits: value,
    maximumWallClockSeconds: value,
  }
}

// ===========================================================================
// Closed vocabularies
// ===========================================================================

describe("the vocabularies a caller renders are closed and enumerated", () => {
  it("exposes every refusal code as a member of a list a caller can iterate", () => {
    // "The budget said no" is a statement an operator has to read, render and diff.
    // An open-ended refusal vocabulary is a vocabulary nobody can enumerate.
    expect([...BUDGET_REFUSALS].sort()).toEqual([...BUDGET_REFUSALS])
    expect(BUDGET_REFUSALS.length).toBeGreaterThan(0)
    // Code-unit ordered in the source itself, so a rendered list is in a defined
    // order without the caller sorting it.
    expect([...BUDGET_REFUSALS]).toEqual([...BUDGET_REFUSALS].sort())
    for (const code of BUDGET_REFUSALS) {
      expect(code, code).toMatch(/^budget\.[a-z_]+$/)
    }
  })

  it("exposes every usage-admission reason as a member of a list, in code-unit order", () => {
    expect([...USAGE_ADMISSION_REASONS]).toEqual([...USAGE_ADMISSION_REASONS].sort())
    expect(USAGE_ADMISSION_REASONS.length).toBeGreaterThan(0)
  })

  it("never emits an admission reason that is not in the declared vocabulary", () => {
    // Swept rather than exemplified: an unlisted reason string would be a value a
    // caller rendering the report has no case for.
    const next = seededLcg(31_337)
    const vocabulary = new Set<string>(USAGE_ADMISSION_REASONS)
    for (let trial = 0; trial < 400; trial += 1) {
      const limits = randomBudget(next)
      const observation: BudgetObservation =
        next() < 0.5
          ? NO_BUDGET_OBSERVATION
          : {
              usage: {
                reported: next() < 0.8,
                reliable: next() < 0.8,
                unit: next() < 0.5 ? "tokens" : next() < 0.5 ? "bytes" : "provider_cost_micros",
                consumedUnits: next() < 0.2 ? null : randomInt(next, 0, 10_000),
              },
              retryCounting: next() < 0.5,
            }
      const admission = admitUsage(limits, observation, randomInt(next, 0, 20_000))
      expect(vocabulary.has(admission.reason), `trial ${trial}: ${admission.reason}`).toBe(true)
      // Every warning, when there is one, names the budget it is about.
      for (const warning of admission.warnings) {
        expect(warning, `trial ${trial}`).toContain("budget.")
      }
    }
  })

  it("never emits a refusal outside the declared vocabulary, from any sweep input", () => {
    const next = seededLcg(64_064)
    const vocabulary = new Set<string>(BUDGET_REFUSALS)
    for (let trial = 0; trial < 300; trial += 1) {
      const admission = admitUsage(randomBudget(next), NO_BUDGET_OBSERVATION, randomInt(next, 0, 5_000))
      if (admission.admitted) continue
      expect(vocabulary.has(admission.refusal.code), `trial ${trial}: ${admission.refusal.code}`).toBe(true)
    }
  })
})

// ===========================================================================
// Replay admission
// ===========================================================================

/**
 * **A5 — A replay cannot be talked into installing more than the ceiling allows.**
 *
 * The bug this is aimed at is a real one and it shipped once: `replayDurableReservations`
 * used to restore every durable row verbatim, so five `held` rows against a ceiling
 * of one produced `held: 5`, five eligible dispatches, and a ledger that then
 * refused every reserve with a total nothing could account for. The property it
 * broke is not "a ceiling exists" — that held throughout — it is `held <= ceiling`
 * AFTER A CRASH, which is the one moment the invariant has to survive that a test
 * suite full of reserve assertions never reaches.
 *
 * The sweep is adversarial about NAMING as well as about counts. Admission walks
 * rows in `reservationId` code-unit order, which means a writer that names its rows
 * `res-000`, `res-001`, … decides which rows get the room. That is a deliberate
 * consequence of having a total order at all, and it is safe for exactly one
 * reason: the order decides WHICH rows are displaced, never HOW MANY. Every row
 * below is given a name chosen to sort as early as possible, so the adversary is
 * spending its whole budget on rows replay would have admitted anyway, and the
 * invariant must still hold.
 */
describe("a replay cannot be talked into admitting more than the ceiling allows", () => {
  it("holds `held <= ceiling` for 300 adversarially-named logs, and names every row it refused", () => {
    const next = seededLcg(0xa5_5eed)
    const TRIALS = 300
    let refusals = 0

    for (let trial = 0; trial < TRIALS; trial += 1) {
      const ceiling = randomInt(next, 1, 6)
      // As many occupying rows as the sweep likes, each asking for up to 3 units,
      // each named so it sorts BEFORE any row that would not.
      const rowCount = randomInt(next, 1, 24)
      const rows = Array.from({ length: rowCount }, (_, index) =>
        reservationRecord({
          reservationId: `res-${String(index).padStart(4, "0")}`,
          dispatchId: `disp-${String(index).padStart(4, "0")}`,
          scope: "concurrency",
          units: randomInt(next, 1, 3),
          state: randomInt(next, 0, 3) === 0 ? "committed" : "held",
          leaseExpiresAt: "2026-03-02T12:00:00.000Z",
          createdAt: NOW,
          updatedAt: NOW,
        }),
      )

      const store = new InMemoryBudgetLedgerStore()
      const report = replayDurableReservations(store, rows, {
        now: NOW,
        ceilings: [{ projectId: PROJECT_ID, scope: "concurrency", ceiling }],
      })

      // The claim, for the record, on every single trial.
      expect(store.heldUnitsFor(PROJECT_ID, "concurrency"), `trial ${trial}`).toBeLessThanOrEqual(ceiling)
      // And the number of rows left OCCUPYING is bounded by what the log could have
      // been, not merely by the units: a reservation is all-or-nothing, so a ceiling
      // of N admits at most N single-unit rows.
      const occupying = store.listHeld().length + store.list().filter((r) => r.state === "committed").length
      expect(occupying, `trial ${trial}`).toBeLessThanOrEqual(ceiling)
      // Every refused row says so, with a reason from the closed vocabulary and a
      // sentence that begins with it — a report nobody can act on is not a report.
      for (const rejection of report.rejected) {
        refusals += 1
        expect(REPLAY_REJECTION_REASONS, `trial ${trial}`).toContain(rejection.reason)
        expect(rejection.detail.startsWith(`replay.${rejection.reason}:`), `trial ${trial}`).toBe(true)
        expect(store.read(rejection.reservationId)?.state, `trial ${trial}`).toBe("expired")
      }
      // Conservation, so a trial cannot pass by refusing everything and admitting
      // nothing: a replay that refused every row would trivially hold the ceiling.
      for (const total of report.scopes) {
        expect(total.admittedUnits + total.rejectedUnits, `trial ${trial}`).toBe(total.occupiedUnits)
        expect(total.admittedUnits, `trial ${trial}`).toBeLessThanOrEqual(ceiling)
      }
      // Nothing lost, and nothing invented.
      expect(report.restored, `trial ${trial}`).toEqual(rows.map((row) => row.reservationId).sort())
    }

    // The sweep has to have met the refusal path, or it proved nothing about it.
    expect(refusals).toBeGreaterThan(0)
    expect(TRIALS).toBe(300)
  })

  it("refuses a replay whose ceilings are not numbers rather than guessing one", () => {
    // A ceiling is either a non-negative integer or `null`. Anything else is a
    // caller bug, and replay THROWS on it rather than coercing — because the two
    // coercions available are `Number(x) || 0` (which turns a ceiling of 0 into
    // "no ceiling", i.e. no limit at all) and `Number(x) || Infinity` (which turns
    // an absent ceiling into an unbounded one). Both are the bug this check exists
    // to prevent, and both are silent.
    for (const ceiling of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() =>
        replayDurableReservations(new InMemoryBudgetLedgerStore(), heldRecords(3), {
          now: NOW,
          ceilings: [{ projectId: PROJECT_ID, scope: "concurrency", ceiling }],
        }),
      ).toThrow(RangeError)
    }
  })
})

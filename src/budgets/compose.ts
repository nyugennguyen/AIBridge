/**
 * M6.5 — budget composition and usage admission.
 *
 * # What this module is
 *
 * The pure half of the budget subsystem. Two functions, both total, both with
 * no clock and no store:
 *
 *   - `composeBudgets(base, contributions, observation?)` answers "what is the
 *     budget in force, and which parts of it can this run actually enforce".
 *   - `admitUsage(limits, observation, requestedUnits)` answers "may this
 *     dispatch consume `requestedUnits` more", and it is the ONLY place in this
 *     milestone where a usage budget can produce a refusal.
 *
 * # Named invariants
 *
 * - **C1 — The composition is monotone non-widening.** The result is `<=` every
 *   input elementwise, on every present numeric key, for every input. There is
 *   no branch that can return a contribution's value over the base's, because
 *   the narrowing step is `Math.min` and the only way a contribution's value
 *   survives is by being `<=` the base's. `tests/unit/budgets/adversarial.test.ts`
 *   runs a 256-pair sweep from a seeded LCG to make this falsifiable rather than
 *   asserted, and `compose.test.ts` crosses every field by hand.
 * - **C2 — A widening attempt is RECORDED AND NAMED, never silently dropped.**
 *   It produces a warning naming the field, the attempted value, the current
 *   value, and the source that attempted it, plus a `rejectedWidening` entry.
 *   The reason is the same one `narrowPolicyState` records
 *   (`src/orchestration/policy/floor.ts:101`): an escalation that leaves no
 *   trace is indistinguishable from a rule that never matched.
 * - **C3 — `usageUnit` is NOT composed.** It is a denominator, not a ceiling,
 *   and `min` is meaningless over it. The FIRST unit declared wins and a later,
 *   disagreeing unit is recorded as a conflict warning and ignored, because a
 *   unit that can change under a standing budget silently reinterprets what the
 *   budget's number means. See `composeUsageUnit` for the full argument.
 * - **C4 — Enforceability is computed from the OBSERVATION, never from whether
 *   a budget was set** (`src/budgets/types.ts` I6). This is the honesty property
 *   the plan singles out: `maximumUsageUnits` with no adapter-reported usage is
 *   `not_enforceable`, carries a warning that names the budget, and NEVER
 *   refuses. A module that refused here would be inventing a measurement, and a
 *   module that reported `enforceable` would be claiming one.
 * - **C5 — `maximumUsageUnits` is enforceable only when the measurement is
 *   COMPLETE and in the DECLARED unit.** Four things must all hold: the adapter
 *   reported, the report is reliable, a unit was declared on the budget, and the
 *   adapter reported the same unit. Any one missing is `not_enforceable` with a
 *   distinct, named reason — tokens measured against a byte budget is not a
 *   comparison, it is two numbers subtracted.
 * - **C6 — Warnings are sorted and de-duplicated.** Two contributions from the
 *   same source that both attempt the same widening produce one warning, and the
 *   order does not depend on the order the contributions arrived in.
 * - **C7 — No rule evaluation happens here.** `RuleEvaluationResult.budgets` is
 *   consumed STRUCTURALLY (see `RuleBudgetContribution` below). This module
 *   does not import `src/rules`, does not re-evaluate a predicate, and does not
 *   contain a second budget evaluator: `composeBudgets` composes a list of
 *   already-decided budget objects, and deciding which rules matched is the rule
 *   engine's job that has already happened by the time a caller gets here.
 * - **C8 — Pure.** No clock, no randomness, no filesystem, no network, no
 *   process. The same `(base, contributions, observation)` produces a
 *   byte-identical composition.
 *
 * # Stop conditions
 *
 *   - **S1 — Stop if any input pair can produce a result wider than an input.**
 *     The sweep in `adversarial.test.ts` is the tripwire.
 *   - **S2 — Stop if a usage budget can be reported `enforceable` without a
 *     reliable measurement in the DECLARED unit**, or if it can refuse without
 *     one.
 *   - **S3 — Stop if this module ever needs to know which RULE produced a
 *     budget.** That is the moment the structural boundary has been crossed and
 *     the second evaluator has begun.
 */

import {
  BUDGET_FIELDS,
  BUDGET_NUMERIC_FIELDS,
  NO_BUDGET_OBSERVATION,
  budgetLimitsSchema,
  type BudgetComposition,
  type BudgetContribution,
  type BudgetEnforceability,
  type BudgetEnforceabilityRecord,
  type BudgetLimits,
  type BudgetNumericField,
  type BudgetObservation,
  type BudgetWideningAttempt,
  type UsageAdmission,
  type UsageAdmissionReason,
  type UsageUnit,
  type UsageObservation,
  budgetRefusal,
  budgetRefuse,
  deepFreezeBudgets,
  sortedUniqueBudgets,
  type BudgetResult,
} from "./types.js"

// ===========================================================================
// Numeric composition
// ===========================================================================

/**
 * The warning text for a rejected widening attempt.
 *
 * Names all four facts an audit needs — the field, what was attempted, what is
 * in force, and who attempted it — and asserts the attempt had no effect. The
 * final clause matters: without it, a reader cannot tell "we refused this" from
 * "we applied it and it did not matter".
 */
function wideningWarning(source: string, field: BudgetNumericField, attempted: number, current: number): string {
  return `budget.${field}: source '${source}' attempted to raise the ceiling ${current} -> ${attempted}; ignored`
}

/**
 * The warning text for a `usageUnit` conflict.
 *
 * C3: the first declared unit wins and the disagreement is named, because a
 * silently-accepted second unit would reinterpret a standing budget's number
 * without changing the number itself.
 */
function unitConflictWarning(source: string, attempted: UsageUnit, current: UsageUnit): string {
  return `budget.usageUnit: source '${source}' attempted to change the unit ${current} -> ${attempted}; ignored because a standing budget's number is only meaningful in the unit it was declared in`
}

/**
 * Composes the `usageUnit` denominator.
 *
 * Returns the winning unit and the warnings, in that order, because the two are
 * genuinely computed together: a conflict is only detectable by comparing
 * against the unit that won.
 *
 * C3's full argument: `usageUnit` is the denominator of `maximumUsageUnits`.
 * Applying `min` to it is not merely meaningless, it is harmful — "the smaller
 * of tokens and bytes" is not a quantity. So the field is composed by
 * FIRST-WRITE-WINS, which is monotone in the only sense that matters (a
 * standing budget's meaning cannot change under it), and every disagreement is
 * reported.
 */
function composeUsageUnit(
  base: BudgetLimits,
  contributions: readonly BudgetContribution[],
): { readonly unit: UsageUnit | undefined; readonly warnings: readonly string[] } {
  const warnings: string[] = []
  let unit = base.usageUnit
  for (const contribution of contributions) {
    const attempted = contribution.limits.usageUnit
    if (attempted === undefined) continue
    if (unit === undefined) {
      // The base declared no unit, so this is the first one in force. It is a
      // DENOMINATOR being established, not a ceiling being widened, so there is
      // no widening attempt to record.
      unit = attempted
      continue
    }
    if (attempted !== unit) {
      warnings.push(unitConflictWarning(contribution.source, attempted, unit))
    }
  }
  return { unit, warnings: sortedUniqueBudgets(warnings) }
}

/**
 * Composes one numeric field.
 *
 * Returns the composed value and the widening attempts against it. A field
 * absent from the base is a DENOMINATOR-free unbounded field: the first
 * contribution that declares one establishes it, which is narrowing (from
 * unbounded to bounded), never widening.
 */
function composeNumericField(
  base: BudgetLimits,
  contributions: readonly BudgetContribution[],
  field: BudgetNumericField,
): {
  readonly value: number | undefined
  readonly attempts: readonly BudgetWideningAttempt[]
  readonly warnings: readonly string[]
} {
  const attempts: BudgetWideningAttempt[] = []
  const warnings: string[] = []
  let value = base[field]
  for (const contribution of contributions) {
    const attempted = contribution.limits[field]
    if (attempted === undefined) continue
    if (value === undefined) {
      // Unbounded -> bounded. Strictly a narrowing; nothing to record.
      value = attempted
      continue
    }
    if (attempted > value) {
      attempts.push({ source: contribution.source, field, attempted, current: value })
      warnings.push(wideningWarning(contribution.source, field, attempted, value))
      continue
    }
    value = attempted
  }
  return { value, attempts, warnings }
}

// ===========================================================================
// Enforceability
// ===========================================================================

/** One enforcement verdict, plus the warning that explains a negative one. */
interface EnforceabilityVerdict {
  readonly enforceability: BudgetEnforceability
  readonly warnings: readonly string[]
}

/**
 * The verdict for a field this module can enforce itself.
 *
 * A field this module owns (`maximumConcurrency`, `maximumFanOut`,
 * `maximumWallClockSeconds`) is `enforceable` whenever it is SET, because the
 * enforcement is structural: concurrency and fan-out are enforced by a
 * reservation transaction that either produced a `held` reservation or did not,
 * and wall-clock is enforced by the lease on that reservation. There is no
 * second place the enforcement could fail to happen.
 */
function selfEnforcedVerdict(limits: BudgetLimits, field: BudgetNumericField): EnforceabilityVerdict {
  return {
    enforceability: limits[field] === undefined ? "not_enforceable" : "enforceable",
    warnings: [],
  }
}

/**
 * The verdict for `maximumRetryLimit`.
 *
 * This module does not count retries — the dispatcher does — so the limit is
 * enforceable only when the dispatcher has said it is counting them. The
 * pessimistic default is the point (types.ts I6): a caller who does not report a
 * retry counter gets a warning rather than a silent claim that retries are
 * bounded.
 */
function retryVerdict(limits: BudgetLimits, observation: BudgetObservation): EnforceabilityVerdict {
  if (limits.maximumRetryLimit === undefined) {
    return { enforceability: "not_enforceable", warnings: [] }
  }
  if (observation.retryCounting) {
    return { enforceability: "enforceable", warnings: [] }
  }
  return {
    enforceability: "not_enforceable",
    warnings: [
      "budget.maximumRetryLimit: the dispatcher reported no retry counter for this run, so the limit is recorded but NOT enforceable and no dispatch is refused on it",
    ],
  }
}

/**
 * Why a usage budget is not enforceable, or `null` when it is.
 *
 * C5: four independent conditions, each with its own message, because "not
 * enforceable" without a reason is the failure mode this whole module exists to
 * avoid — a budget that is quietly unenforced looks identical to one that is
 * quietly enforced.
 */
function usageEnforcementWarning(limits: BudgetLimits, usage: UsageObservation): string | null {
  const declared = limits.maximumUsageUnits
  if (declared === undefined) return null
  if (!usage.reported) {
    return "budget.maximumUsageUnits: the runtime adapter reported no usage for this run, so the budget is recorded but NOT enforceable and no dispatch is refused on it"
  }
  if (!usage.reliable) {
    return "budget.maximumUsageUnits: the runtime adapter reported usage this build does not treat as reliable, so the budget is recorded but NOT enforceable and no dispatch is refused on it"
  }
  if (usage.consumedUnits === null) {
    return "budget.maximumUsageUnits: the runtime adapter reported usage without a consumed figure, so the budget is recorded but NOT enforceable and no dispatch is refused on it"
  }
  if (usage.unit === null) {
    return "budget.maximumUsageUnits: the runtime adapter reported usage without a unit, so the budget is recorded but NOT enforceable and no dispatch is refused on it"
  }
  if (limits.usageUnit === undefined) {
    return `budget.maximumUsageUnits: the budget declares no usageUnit, so ${usage.unit} figures cannot be compared against it; recorded but NOT enforceable and no dispatch is refused on it`
  }
  if (limits.usageUnit !== usage.unit) {
    return `budget.maximumUsageUnits: the budget is denominated in ${limits.usageUnit} but the runtime adapter reported ${usage.unit}, so the budget is recorded but NOT enforceable and no dispatch is refused on it`
  }
  return null
}

/**
 * The verdicts for `maximumUsageUnits` and `usageUnit`.
 *
 * They are computed TOGETHER because they are the same claim: a budget is
 * enforceable when the unit it is denominated in is known, and the unit is only
 * known when the adapter reported one in that same unit. Reporting `usageUnit`
 * as `enforceable` while `maximumUsageUnits` is `not_enforceable` would let a
 * reader conclude the budget is measured, which is the inference S2 forbids.
 */
function usageVerdicts(limits: BudgetLimits, usage: UsageObservation): {
  readonly maximumUsageUnits: EnforceabilityVerdict
  readonly usageUnit: EnforceabilityVerdict
} {
  const warning = usageEnforcementWarning(limits, usage)
  if (warning === null) {
    const enforceable: EnforceabilityVerdict = { enforceability: "enforceable", warnings: [] }
    // Both absent: neither claim is made.
    if (limits.maximumUsageUnits === undefined && limits.usageUnit === undefined) {
      const absent: EnforceabilityVerdict = { enforceability: "not_enforceable", warnings: [] }
      return { maximumUsageUnits: absent, usageUnit: absent }
    }
    return { maximumUsageUnits: enforceable, usageUnit: enforceable }
  }
  const notEnforceable: EnforceabilityVerdict = { enforceability: "not_enforceable", warnings: [warning] }
  if (limits.maximumUsageUnits === undefined && limits.usageUnit === undefined) {
    // Nothing was declared, so the warning does not apply and nothing is claimed.
    return {
      maximumUsageUnits: { enforceability: "not_enforceable", warnings: [] },
      usageUnit: { enforceability: "not_enforceable", warnings: [] },
    }
  }
  return { maximumUsageUnits: notEnforceable, usageUnit: notEnforceable }
}

/**
 * The full enforceability record.
 *
 * Every key of `BudgetLimits` gets a verdict, in `BUDGET_FIELDS` order, and the
 * record is built explicitly rather than in a loop over the keys so that adding a
 * field to `BUDGET_FIELDS` without deciding its enforcer is a type error rather
 * than an `undefined` verdict read as `not_enforceable`.
 */
function computeEnforceability(
  limits: BudgetLimits,
  observation: BudgetObservation,
): { readonly record: BudgetEnforceabilityRecord; readonly warnings: readonly string[] } {
  const concurrency = selfEnforcedVerdict(limits, "maximumConcurrency")
  const fanOut = selfEnforcedVerdict(limits, "maximumFanOut")
  const wallClock = selfEnforcedVerdict(limits, "maximumWallClockSeconds")
  const retry = retryVerdict(limits, observation)
  const usage = usageVerdicts(limits, observation.usage)

  return {
    record: {
      maximumConcurrency: concurrency.enforceability,
      maximumFanOut: fanOut.enforceability,
      maximumRetryLimit: retry.enforceability,
      maximumUsageUnits: usage.maximumUsageUnits.enforceability,
      maximumWallClockSeconds: wallClock.enforceability,
      usageUnit: usage.usageUnit.enforceability,
    },
    warnings: sortedUniqueBudgets([
      ...concurrency.warnings,
      ...fanOut.warnings,
      ...retry.warnings,
      ...usage.maximumUsageUnits.warnings,
      ...wallClock.warnings,
    ]),
  }
}

// ===========================================================================
// composeBudgets
// ===========================================================================

/**
 * The composed budget for one dispatch.
 *
 * `contributions` are already-decided budget objects in the caller's sort order.
 * This function does not evaluate a rule, does not match a predicate, and does
 * not know what a rule is (C7): by the time a caller composes, the rule engine
 * has already decided which contributions apply, and re-deciding here would be
 * the second evaluator ADR 0007 section 10 forbids.
 *
 * A base or contribution that does not satisfy `budgetLimitsSchema` is refused
 * with `budget.request_invalid` rather than silently coerced. Coercing a budget
 * would be worse than the check-then-act gap: a `maximumConcurrency` that arrived
 * as `"5"` and became `5` would be a budget whose meaning was decided by
 * something other than the schema.
 */
export function composeBudgets(
  base: BudgetLimits,
  contributions: readonly BudgetContribution[] = [],
  observation: BudgetObservation = NO_BUDGET_OBSERVATION,
): BudgetComposition {
  const parsedBase = budgetLimitsSchema.safeParse(base)
  if (!parsedBase.success) {
    throw new RangeError(
      `composeBudgets was given a base budget that does not satisfy budgetLimitsSchema: ${parsedBase.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    )
  }
  for (const contribution of contributions) {
    const parsed = budgetLimitsSchema.safeParse(contribution.limits)
    if (!parsed.success) {
      throw new RangeError(
        `composeBudgets was given a contribution from '${contribution.source}' that does not satisfy budgetLimitsSchema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      )
    }
  }

  const current = parsedBase.data
  const attempts: BudgetWideningAttempt[] = []
  const warnings: string[] = []

  const limits: BudgetLimits = {}
  for (const field of BUDGET_NUMERIC_FIELDS) {
    const composed = composeNumericField(current, contributions, field)
    attempts.push(...composed.attempts)
    warnings.push(...composed.warnings)
    if (composed.value !== undefined) {
      limits[field] = composed.value
    }
  }
  const unit = composeUsageUnit(current, contributions)
  warnings.push(...unit.warnings)
  if (unit.unit !== undefined) {
    limits.usageUnit = unit.unit
  }

  const enforceability = computeEnforceability(limits, observation)
  warnings.push(...enforceability.warnings)

  // The result is validated through the module's OWN schema before it leaves, so
  // a field assembled by this function cannot be one the schema would refuse.
  // This is a cheap assertion, not a parse: it is here because the assembly above
  // builds the object member by member rather than through Zod.
  const parsedLimits = budgetLimitsSchema.safeParse(limits)
  if (!parsedLimits.success) {
    throw new RangeError("composeBudgets produced a limits object that does not satisfy budgetLimitsSchema")
  }

  return deepFreezeBudgets<BudgetComposition>({
    limits: parsedLimits.data,
    enforceability: enforceability.record,
    warnings: sortedUniqueBudgets(warnings),
    // De-duplicated on the whole tuple, so the machine-readable list and the
    // warning list agree in LENGTH as well as in content. A caller comparing
    // `warnings.length` against `rejectedWidening.length` to decide whether an
    // escalation was suppressed would otherwise be misled by a caller that
    // supplied the same `set_stricter_budget` action twice — a key
    // `(ruleId, field)` pair that cannot legitimately appear twice in a compiled
    // rule set, and which `src/rules` reports once.
    rejectedWidening: dedupeAttempts(attempts).sort(
      (left, right) => compareByCodeUnit(left.field, right.field) || compareByCodeUnit(left.source, right.source),
    ),
  })
}

/** One entry per distinct `(field, source, attempted, current)`. First occurrence wins. */
function dedupeAttempts(attempts: readonly BudgetWideningAttempt[]): BudgetWideningAttempt[] {
  const seen = new Set<string>()
  const unique: BudgetWideningAttempt[] = []
  for (const attempt of attempts) {
    const key = `${attempt.field}${attempt.source}${attempt.attempted}${attempt.current}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(attempt)
  }
  return unique
}

/**
 * UTF-16 code-unit comparison.
 *
 * `left < right` directly, never `localeCompare`: two machines with different
 * ICU locale data would sort the same `rejectedWidening` list differently, and a
 * report whose order is machine-dependent is a report nobody can diff.
 */
export function compareByCodeUnit(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * The composition entry point, in `Result` form.
 *
 * Provided so a caller on an error path never has to catch the `RangeError` from
 * `composeBudgets`. The refusal names the offending source, because "a budget
 * was malformed" without saying which one is a refusal nobody can act on.
 */
export function composeBudgetsOrRefuse(
  base: BudgetLimits,
  contributions: readonly BudgetContribution[] = [],
  observation: BudgetObservation = NO_BUDGET_OBSERVATION,
): BudgetResult<BudgetComposition> {
  try {
    return { ok: true, value: composeBudgets(base, contributions, observation) }
  } catch (error) {
    return budgetRefuse(
      "budget.request_invalid",
      error instanceof Error ? error.message : "composeBudgets was given an unreadable budget",
    )
  }
}

/**
 * The ceiling for a scope, or `null` when no budget declares one.
 *
 * Returns `null` for "no ceiling declared" rather than a large number, because
 * a caller that maps "unbounded" onto `Infinity` and then adds to it produces a
 * `NaN` refusal message, and a caller that maps it onto a concrete maximum is
 * silently inventing a limit nobody set.
 */
export function scopeCeiling(limits: BudgetLimits, scope: "concurrency" | "fan_out"): number | null {
  return scope === "concurrency" ? (limits.maximumConcurrency ?? null) : (limits.maximumFanOut ?? null)
}

// ===========================================================================
// Usage admission
// ===========================================================================

/**
 * Why a usage request was refused, when it was.
 *
 * Reads off the same conditions `usageEnforcementWarning` uses, so the reason
 * and the warning can never disagree about whether the budget was enforceable.
 */
function usageRefusalReason(
  limits: BudgetLimits,
  usage: UsageObservation,
): UsageAdmissionReason | null {
  if (limits.maximumUsageUnits === undefined) return null
  if (!usage.reported) return "usage_not_reported"
  if (!usage.reliable) return "usage_unreliable"
  if (usage.consumedUnits === null) return "usage_figure_unreported"
  if (usage.unit === null) return "usage_unit_unreported"
  if (limits.usageUnit === undefined) return "usage_unit_undeclared"
  if (limits.usageUnit !== usage.unit) return "usage_unit_mismatch"
  return null
}

/**
 * May this dispatch consume `requestedUnits` more against the usage budget?
 *
 * # The shape of the answer
 *
 *   - **No budget declared** -> admitted, `not_enforceable`, `usage_no_budget`.
 *   - **Budget declared, not measurable** -> admitted, `not_enforceable`, and a
 *     warning naming the budget. NEVER refused. This is C4 and it is the single
 *     most important behaviour in this module: refusing a cost budget that cannot
 *     be measured would report a cost the system does not know.
 *   - **Budget declared, measurable, within the limit** -> admitted,
 *     `enforceable`, `usage_within_budget`.
 *   - **Budget declared, measurable, over the limit** -> refused,
 *     `enforceable`, `usage_budget_exceeded`, with a `budget.usage_exceeded`
 *     refusal carrying the limit, the consumed total, and the request.
 *
 * The refusal is deliberately reached only on the last line. A module that
 * always answered `not_enforceable` would pass the first three cases, which is
 * why `adversarial.test.ts` asserts the fourth with real numbers.
 *
 * `requestedUnits` must be a non-negative safe integer or the whole request is
 * refused as `budget.units_invalid`; a negative usage request is not "no usage",
 * it is an arithmetic error, and treating it as zero would let a caller with a
 * bug in its accounting under-report forever.
 */
export function admitUsage(
  limits: BudgetLimits,
  observation: BudgetObservation = NO_BUDGET_OBSERVATION,
  requestedUnits: number,
): UsageAdmission {
  const parsed = budgetLimitsSchema.safeParse(limits)
  if (!parsed.success) {
    return {
      admitted: false,
      enforceability: "not_enforceable",
      reason: "usage_no_budget",
      warnings: [],
      observed: observation.usage,
      refusal: budgetRefusal(
        "budget.request_invalid",
        `admitUsage was given limits that do not satisfy budgetLimitsSchema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
        { requestedUnits: Number.isSafeInteger(requestedUnits) ? requestedUnits : null },
      ),
    }
  }
  const effective = parsed.data
  const usage = observation.usage

  if (!Number.isSafeInteger(requestedUnits) || requestedUnits < 0) {
    return {
      admitted: false,
      enforceability: "not_enforceable",
      reason: "usage_no_budget",
      warnings: [],
      observed: usage,
      refusal: budgetRefusal(
        "budget.units_invalid",
        `admitUsage was given requestedUnits=${requestedUnits}, which is not a non-negative safe integer; a usage request that cannot be added is refused rather than treated as zero`,
        { requestedUnits: Number.isSafeInteger(requestedUnits) ? requestedUnits : null },
      ),
    }
  }

  if (effective.maximumUsageUnits === undefined) {
    return {
      admitted: true,
      enforceability: "not_enforceable",
      reason: "usage_no_budget",
      warnings: [],
      observed: usage,
    }
  }

  const unmeasurable = usageRefusalReason(effective, usage)
  if (unmeasurable !== null) {
    const warning =
      usageEnforcementWarning(effective, usage) ??
      "budget.maximumUsageUnits: the budget could not be evaluated against a measurement; recorded but NOT enforceable and no dispatch is refused on it"
    return {
      admitted: true,
      enforceability: "not_enforceable",
      reason: unmeasurable,
      warnings: [warning],
      observed: usage,
    }
  }

  const limit = effective.maximumUsageUnits
  const consumed = usage.consumedUnits as number
  const projected = consumed + requestedUnits
  if (projected > limit) {
    return {
      admitted: false,
      enforceability: "enforceable",
      reason: "usage_budget_exceeded",
      warnings: [],
      observed: usage,
      refusal: budgetRefusal(
        "budget.usage_exceeded",
        `budget.maximumUsageUnits: consuming ${requestedUnits} more ${usage.unit} would reach ${projected}, above the ceiling of ${limit} (${consumed} already consumed); refused`,
        { limit, heldUnits: consumed, requestedUnits },
      ),
    }
  }
  return {
    admitted: true,
    enforceability: "enforceable",
    reason: projected === consumed ? "usage_reliable" : "usage_within_budget",
    warnings: [],
    observed: usage,
  }
}

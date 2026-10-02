/**
 * The M6 rule evaluator: `CompiledRuleSet` in, `RuleEvaluationResult` out.
 *
 * ============================ THE ONE EVALUATOR ============================
 *
 * `evaluateRules` is the SINGLE evaluation entry point for this milestone.
 * Preview (M6.3), runtime, and the dry-run simulator (M6.7) all call THIS
 * function. A second evaluator is a STOP CONDITION, not a code smell: ADR 0007
 * section 3 states that "there is one artifact and one entry point, so the two
 * cannot drift by construction", and stop condition 1 says implementation halts
 * if preview and production evaluation are found able to diverge, "including by
 * a change to one of them that does not touch the other". A preview that
 * re-implemented predicate evaluation to show "what would match" would be exactly
 * that: two evaluators, each correct, drifting the first time either changed.
 * So preview renders THIS result. It does not recompute it.
 * ==========================================================================
 *
 * WHY THE RESULT HAS NO `decision` FIELD. The safety floor's decision belongs to
 * the kernel, and M6 is an input to it, not a second decision point. What this
 * module produces is a *contribution*: a narrowing, a hard deny, a set of
 * pre-approval candidates, budget and routing contributions, and the M0 `Rule`
 * projections for the kernel to evaluate in its own second pass. The kernel's
 * `evaluatePolicy` then decides, and its re-check against the POST-narrowing
 * state is the thing that actually grants a pre-approval. M6 never re-implements
 * that re-check (see `src/orchestration/policy/evaluate.ts:520-618`); M6's job is
 * to hand the kernel a correctly-shaped `Rule` and to surface the two
 * contributions the kernel does not model at all.
 *
 * WHY `kernelRules` IS DISPATCH-BOUND, AND THE LIMITATION THAT CREATES. The M0
 * `Rule.match` shape can express three things: a title pattern, a requested
 * capability set, and a runtime kind. It cannot express `roleId`, `roleVersion`,
 * `projectPathId`, task labels, dependency outcomes, context sensitivity, the
 * five numeric bounds, or a schedule window, and it has no combinator at all.
 * So a projected M0 rule cannot carry the full M6 predicate.
 *
 * What it DOES carry, deliberately, is the M0-expressible subset of the M6
 * predicate's TOP LEVEL, projected by `projectKernelMatch` in `compile.ts`. The
 * kernel's own `matchRule` then independently re-checks it, which makes the
 * kernel a second, fail-closed authority rather than an effect applicator that
 * trusts the list it was handed. This is why the projection reads only the top
 * level: descending into `all`/`any`/`not` would emit an M0 conjunction that
 * claims to be an M6 tree it cannot represent, and a projection that cannot be
 * checked against the tree it came from is one nobody can audit.
 *
 * The projection is a sound UNDER-approximation in every case: it is either
 * empty (matches everything, so the kernel never over-constrains) or weaker
 * than the M6 predicate (a union of top-level sets where M6 declared a
 * conjunction, and no projection at all for `capability all`/`none`, because
 * M0's `some()` would silently weaken an `all` into an `any`). Weaker, never
 * different. What prevents any of this from being an escalation is that
 * `kernelRules` contains only the rules that MATCHED under M6 evaluation, and
 * the M6 evaluation is the only thing that produces that list.
 *
 * THE KNOWN LIMITATION, stated rather than hidden: a caller that caches
 * `result.kernelRules` and attaches it to a different dispatch's envelope would
 * attach a rule whose M6 predicate was never evaluated for that dispatch. The
 * projection bounds the blast radius of that caller bug — the mis-attached rule
 * still has to satisfy whatever part of its predicate the M0 language can
 * express, instead of applying unconditionally — but it does not close it. The
 * other mitigations available inside this module are naming and re-checking: the
 * field is documented as dispatch-bound, it is the only sanctioned way to obtain
 * kernel rules from a compiled set, and the pre-approval path it feeds is
 * re-checked by the kernel against the post-narrowing state anyway. Closing the
 * hole completely needs a digest-bound binding from a compiled rule set to a
 * dispatch, which is a change to the M0 envelope and therefore outside this
 * milestone.
 *
 * ORDERING IS TOTAL AND COMPUTED FROM IDENTITY ALONE: ruleId ascending by UTF-16
 * code unit, then templateVersion ascending. Never `localeCompare`, never the
 * input order. Supersession therefore cannot depend on the order documents
 * arrived in, and the `decisionDigest` is a function of the rule set and the
 * context, not of either's array order.
 *
 * FAIL-CLOSED, NOT FAIL-OPEN, EVERYWHERE. Every predicate resolves to
 * `satisfied` or `unsatisfied`; there is no third value in the exported outcome.
 * An absent subject, a null numeric request, a missing capability snapshot, a
 * missing context manifest: all `unsatisfied` with a reason, and a `not` over
 * any of them is `unsatisfied` rather than `satisfied`. `none` and `lacks` are
 * the two operators where an absent subject is `satisfied`, because each asserts
 * an absence and an absent subject satisfies an assertion of absence.
 *
 * A WIDENING ATTEMPT IS NEVER SILENTLY DROPPED. `set_stricter_budget` declaring a
 * value above the budget in force is recorded as `rejected_widening` with the
 * attempted value, and has no effect. That is ADR 0007 section 7.6's elementwise
 * `min` discipline applied to the budget algebra, and it is the same direction
 * `narrowPolicyState` takes in the policy algebra.
 *
 * NO WALL CLOCK, NO RANDOMNESS, NO IO. `evaluatedAt` arrives in the context; the
 * schedule-window predicate projects that instant into the window's declared
 * zone with `Intl.DateTimeFormat` and does nothing else. `Date.parse` is the only
 * date function used, and it is applied to strings the caller supplied.
 */

import { SENSITIVITY_RANK, type Sensitivity } from "../memory/ontology.js"
import { matchesBounded, type SafePattern } from "../mesh/protocol/safe-pattern.js"
import { digestJson } from "../orchestration/digest.js"
import { createContractError, type Result } from "../orchestration/errors.js"
import { evaluatePolicy, renderPolicyExplanation } from "../orchestration/policy/evaluate.js"
import { narrowPolicyState } from "../orchestration/policy/floor.js"
import type { EffectivePolicyState, NarrowingOutcome, PolicyDecision, PolicyEvaluation } from "../orchestration/policy/types.js"
import { policyEvaluationSchema } from "../orchestration/policy/types.js"
import type { DispatchEnvelope, Rule } from "../orchestration/types.js"
import {
  SENSITIVITY_BY_RANK,
  actionKindRank,
  normalizePredicateNode,
  ruleEvaluationContextSchema,
  type CompiledRule,
  type CompiledRuleSet,
  type DependencyOutcomeValue,
  type PredicateOutcome,
  type RuleAction,
  type RuleActionDisposition,
  type RuleBudgetLimits,
  type RuleConflict,
  type RuleEvaluationContext,
  type RuleEvaluationResult,
  type RuleEvaluationTrace,
  type RuleMatchOutcome,
  type RulePreApprovalBounds,
  type RulePreApprovalCandidate,
  type RulePredicate,
  type RuleRestrictionComposition,
  type RuleRoutingComposition,
  type RuleShadowing,
  type ScheduleWindow,
  type TaskLabelPredicate,
} from "./types.js"
import { normalizeAction } from "./compile.js"

// ===========================================================================
// Error codes
// ===========================================================================

/**
 * The evaluator's own code, on top of the compiler's.
 *
 * `rule.evaluation_failed` is the one code that means "the evaluator refused to
 * produce a verdict", and it is deliberately distinct from the compiler's
 * `rule.limit_exceeded`: an evaluation that cannot be completed must not be
 * reported as though a limit was crossed, because the correct response to each is
 * different.
 */
export const RULE_EVALUATION_CODES = Object.freeze([
  "rule.invalid_context",
  "rule.evaluation_failed",
] as const)

export type RuleEvaluationErrorCode = (typeof RULE_EVALUATION_CODES)[number]

// ===========================================================================
// Internal three-valued verdict
// ===========================================================================

/**
 * The internal verdict. Three values, and the third one is the whole point.
 *
 * `unknown` means "the context could not say". It is NEVER exported: a
 * `PredicateOutcome` reports `satisfied` or `unsatisfied` plus an `unevaluable`
 * flag, so no consumer of a trace can mistake an unknown for a match. Internally
 * it has to exist, because `not(unknown)` is `unsatisfied` while
 * `not(unsatisfied)` is `satisfied` — collapsing the two would make `not` fail
 * OPEN, which is the single worst bug this language could have.
 */
type Verdict = "satisfied" | "unsatisfied" | "unknown"

interface VerdictWithReason {
  readonly verdict: Verdict
  readonly reason: string
}

function satisfied(reason: string): VerdictWithReason {
  return { verdict: "satisfied", reason }
}

function unsatisfied(reason: string): VerdictWithReason {
  return { verdict: "unsatisfied", reason }
}

function unknown(reason: string): VerdictWithReason {
  return { verdict: "unknown", reason }
}

/** Lowers an internal verdict to the two-valued exported shape. */
function toOutcome(
  field: PredicateOutcome["field"],
  operator: string,
  normalized: string,
  result: VerdictWithReason,
  children: readonly PredicateOutcome[] = [],
): PredicateOutcome {
  return {
    field,
    operator,
    normalized,
    satisfaction: result.verdict === "satisfied" ? "satisfied" : "unsatisfied",
    unevaluable: result.verdict === "unknown",
    reason: result.reason,
    children,
  }
}

// ===========================================================================
// Schedule window evaluation
// ===========================================================================

const WEEKDAY_INDEX: Readonly<Record<string, number>> = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
})

/**
 * Projects an instant into a window's declared zone and reports the local
 * day-of-week and minute-of-day.
 *
 * Uses `Intl.DateTimeFormat.formatToParts` with an EXPLICIT `timeZone`, so the
 * host's local zone is never consulted. The parts rather than a formatted string,
 * because parsing a formatted string back into numbers is exactly where a
 * locale-dependent format turns into a wrong minute.
 *
 * `hourCycle: "h23"` matters: the default `h12` cycle renders midnight as `24`,
 * which would make 00:30 read as hour 24 and put every midnight dispatch outside
 * a window that starts at 00:00.
 */
function zonedClock(epochMs: number, window: ScheduleWindow): { dayOfWeek: number; minuteOfDay: number } | null {
  if (typeof window.timeZone !== "string") {
    // A fixed offset: shift the instant and read UTC fields off the shifted
    // value, with no `Intl` at all. This is the path a rule takes when the
    // author wanted determinism and did not want a tzdata dependency.
    const shifted = epochMs + window.timeZone.fixedOffsetMinutes * 60_000
    const dayOfWeek = floorMod(Math.floor(shifted / 86_400_000) + 4, 7)
    const minuteOfDay = Math.floor(floorMod(shifted, 86_400_000) / 60_000)
    return { dayOfWeek, minuteOfDay }
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: window.timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
  const parts = formatter.formatToParts(new Date(epochMs))
  let weekday: number | null = null
  let hour: number | null = null
  let minute: number | null = null
  for (const part of parts) {
    if (part.type === "weekday") weekday = WEEKDAY_INDEX[part.value] ?? null
    else if (part.type === "hour") hour = Number.parseInt(part.value, 10)
    else if (part.type === "minute") minute = Number.parseInt(part.value, 10)
  }
  if (weekday === null || hour === null || minute === null || Number.isNaN(hour) || Number.isNaN(minute)) {
    return null
  }
  return { dayOfWeek: weekday, minuteOfDay: hour * 60 + minute }
}

function floorMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus
}

/**
 * Is the instant inside ANY of the windows?
 *
 * Half-open on both ends, `[start, end)`, so two adjacent windows
 * `09:00-12:00` and `12:00-17:00` cover the afternoon with no gap and no
 * overlap. An instant the projection cannot resolve is UNKNOWN, not satisfied.
 */
function evaluateScheduleWindows(windows: readonly ScheduleWindow[], epochMs: number): VerdictWithReason {
  for (const window of windows) {
    const clock = zonedClock(epochMs, window)
    if (clock === null) {
      return unknown("The declared time zone could not be projected onto the evaluation instant")
    }
    if (!window.daysOfWeek.includes(clock.dayOfWeek)) continue
    if (clock.minuteOfDay >= window.startMinuteOfDay && clock.minuteOfDay < window.endMinuteOfDay) {
      return satisfied(
        `The instant falls inside a declared window (day ${clock.dayOfWeek}, minute ${clock.minuteOfDay})`,
      )
    }
  }
  return unsatisfied("The instant falls outside every declared window")
}

// ===========================================================================
// Predicate evaluation
// ===========================================================================

function membersOf(value: readonly string[]): Set<string> {
  return new Set(value)
}

/**
 * Evaluates one predicate against the context.
 *
 * The `unknown` returns below are the fail-closed column of the module's own
 * table, written out at each site so that a reader of this function can see, for
 * each field, what "the context could not say" looks like. They are the reason
 * `not` cannot fail open.
 */
function evaluatePredicate(predicate: RulePredicate, context: RuleEvaluationContext): VerdictWithReason {
  switch (predicate.field) {
    case "projectId":
    case "roleId":
    case "targetNodeId":
    case "projectPathId":
    case "runtimeKind":
      return evaluateIdentifierPredicate(predicate, context)
    case "roleVersion":
    case "fanOut":
    case "concurrency":
    case "retryLimit":
    case "timeoutSeconds":
      return evaluateComparisonPredicate(predicate, context)
    case "capability":
    case "toolCategory":
    case "nodeAdvertisedCapability":
      return evaluateSetPredicate(predicate, context)
    case "taskLabel":
      return evaluateTaskLabelPredicate(predicate, context)
    case "dependencyOutcome":
      return evaluateDependencyOutcomePredicate(predicate, context)
    case "scheduleWindow":
      return evaluateScheduleWindows(predicate.windows, Date.parse(context.evaluatedAt))
    case "contextSensitivity":
      return evaluateSensitivityPredicate(predicate, context)
    case "taskTitlePattern":
      return unknown(
        "A taskTitlePattern needs the compiled pattern, which is supplied by the rule rather than by the context; a pattern is matched by the compiler's bound pattern, never by the context alone",
      )
    case "all":
    case "any":
    case "not":
      // Handled by `evaluatePredicateTree`, which has the children to recurse
      // with. Reaching this arm means a caller invoked the leaf evaluator on a
      // combinator, which is a programming error in this module.
      return unknown("A combinator must be evaluated with its children")
  }
}

type IdentifierField = "projectId" | "roleId" | "targetNodeId" | "projectPathId" | "runtimeKind"

/**
 * The context's value for an identifier axis.
 *
 * A lookup rather than a switch, so a NEW identifier field cannot be added to the
 * predicate union and silently read as `null` here — which would make every
 * predicate on it `unknown`, and therefore unsatisfiable, with no compile error
 * and no test failure. A switch over a union gets exhaustiveness checking; a
 * lookup does not, so the union is spelled out here and TypeScript checks it.
 */
const IDENTIFIER_SUBJECT: Readonly<Record<IdentifierField, (context: RuleEvaluationContext) => string | null>> = Object.freeze({
  projectId: (context) => context.projectId,
  roleId: (context) => context.roleId,
  targetNodeId: (context) => context.targetNodeId,
  projectPathId: (context) => context.projectPathId,
  runtimeKind: (context) => context.runtimeKind,
})

function evaluateIdentifierPredicate(
  predicate: Extract<RulePredicate, { field: IdentifierField }>,
  context: RuleEvaluationContext,
): VerdictWithReason {
  const wanted = Array.isArray(predicate.value) ? [...predicate.value] : [predicate.value]
  const actual = IDENTIFIER_SUBJECT[predicate.field](context)
  if (actual === null) {
    return unknown(`The context names no ${predicate.field}, so the predicate could not be evaluated`)
  }
  return wanted.includes(actual)
    ? satisfied(`The context's ${predicate.field} '${actual}' is in the declared set`)
    : unsatisfied(`The context's ${predicate.field} '${actual}' is not in the declared set`)
}

function numericSubject(
  predicate: Extract<RulePredicate, { field: "roleVersion" | "fanOut" | "concurrency" | "retryLimit" | "timeoutSeconds" }>,
  context: RuleEvaluationContext,
): number | null {
  switch (predicate.field) {
    case "roleVersion":
      return context.roleVersion
    case "fanOut":
      return context.requestedFanOut
    case "concurrency":
      return context.requestedConcurrency
    case "retryLimit":
      return context.requestedRetryLimit
    case "timeoutSeconds":
      return context.declaredTimeoutSeconds
  }
}

function evaluateComparisonPredicate(
  predicate: Extract<RulePredicate, { field: "roleVersion" | "fanOut" | "concurrency" | "retryLimit" | "timeoutSeconds" }>,
  context: RuleEvaluationContext,
): VerdictWithReason {
  const actual = numericSubject(predicate, context)
  if (actual === null) {
    return unknown(`The context states no ${predicate.field}, so the comparison could not be evaluated`)
  }
  const declared = predicate.value
  if (predicate.operator === "between") {
    const range = declared as { min: number; max: number }
    return actual >= range.min && actual <= range.max
      ? satisfied(`${predicate.field} ${actual} is within [${range.min}, ${range.max}]`)
      : unsatisfied(`${predicate.field} ${actual} is outside [${range.min}, ${range.max}]`)
  }
  const scalar = declared as number
  const holds =
    predicate.operator === "eq"
      ? actual === scalar
      : predicate.operator === "lt"
        ? actual < scalar
        : predicate.operator === "lte"
          ? actual <= scalar
          : predicate.operator === "gt"
            ? actual > scalar
            : actual >= scalar
  return holds
    ? satisfied(`${predicate.field} ${actual} satisfies ${predicate.operator} ${scalar}`)
    : unsatisfied(`${predicate.field} ${actual} does not satisfy ${predicate.operator} ${scalar}`)
}

type SetField = "capability" | "toolCategory" | "nodeAdvertisedCapability"

/** The context's set for a set-valued axis. `null` means "no snapshot exists". */
const SET_SUBJECT: Readonly<Record<SetField, (context: RuleEvaluationContext) => readonly string[] | null>> = Object.freeze({
  capability: (context) => context.requestedCapabilities,
  toolCategory: (context) => context.toolCategories,
  nodeAdvertisedCapability: (context) => context.nodeAdvertisedCapabilities,
})

function evaluateSetPredicate(
  predicate: Extract<RulePredicate, { field: SetField }>,
  context: RuleEvaluationContext,
): VerdictWithReason {
  const actual = SET_SUBJECT[predicate.field](context)

  // A missing capability SNAPSHOT is different from a snapshot with no
  // capabilities in it, and the ADR's fail-closed column says so explicitly:
  // "a node with no capability snapshot is unsatisfied for any and all,
  // satisfied for none". `none` is satisfied because it asserts the absence of
  // the listed capabilities, and a node whose capabilities are unknown has — as
  // far as the assertion goes — none of them. That is the one place a missing
  // fact resolves to satisfied, and it is the assertion-of-absence case again.
  if (actual === null) {
    return predicate.operator === "none"
      ? satisfied(`No capability snapshot is available, so none of the listed ${predicate.field} values is present`)
      : unknown(`The context has no ${predicate.field} snapshot, so the predicate could not be evaluated`)
  }
  if (actual.length === 0) {
    return predicate.operator === "none"
      ? satisfied(`The request names no ${predicate.field}`)
      : unknown(`The request names no ${predicate.field}, so '${predicate.operator}' has nothing to match`)
  }

  const declared = membersOf(predicate.value)
  // `present` is built over the DEDUPED declared members, never over
  // `predicate.value`. The previous version filtered the raw array, so a declared
  // list with a duplicate counted that member twice while `declared` — a Set —
  // counted it once, and the `all` comparison `present.length === declared.size`
  // then INVERTED: `["fs.read", "net.fetch", "fs.read"]` was satisfied by a
  // request for `["fs.read"]` alone and refused a request that genuinely carried
  // both. The M6.10 review recorded it as a disclosure problem; it is a
  // fail-open matcher bug, and the pre-approval it sits on is exactly the case
  // where an over-broad match is expensive.
  const present = [...declared].filter((member) => actual.includes(member))
  const missing = [...declared].filter((member) => !actual.includes(member))
  switch (predicate.operator) {
    case "any":
      return present.length > 0
        ? satisfied(`The request includes ${present.length} of the declared ${predicate.field} values`)
        : unsatisfied(`The request includes none of the declared ${predicate.field} values`)
    case "all":
      return missing.length === 0
        ? satisfied("The request includes every declared value")
        : unsatisfied(`The request is missing ${missing.length} of the declared values`)
    case "none":
      return present.length === 0
        ? satisfied("The request includes none of the declared values")
        : unsatisfied(`The request includes ${present.length} of the declared values`)
  }
}

function evaluateTaskLabelPredicate(
  predicate: Extract<RulePredicate, { field: "taskLabel" }>,
  context: RuleEvaluationContext,
): VerdictWithReason {
  const labels = context.taskLabels
  const wanted = Array.isArray(predicate.value) ? predicate.value : [predicate.value]
  const present = wanted.filter((label) => labels.includes(label))
  if (labels.length === 0) {
    return predicate.operator === "lacks"
      ? satisfied("The task carries no labels, so it lacks every declared label")
      : unknown("The task carries no labels, so a positive label assertion could not be evaluated")
  }
  switch (predicate.operator) {
    case "has":
      return present.length > 0 ? satisfied("The task carries the declared label") : unsatisfied("The task does not carry the declared label")
    case "hasAny":
      return present.length > 0
        ? satisfied("The task carries at least one declared label")
        : unsatisfied("The task carries none of the declared labels")
    case "hasAll":
      return present.length === wanted.length
        ? satisfied("The task carries every declared label")
        : unsatisfied(`The task is missing ${wanted.length - present.length} of the declared labels`)
    case "lacks":
      return present.length === 0
        ? satisfied("The task carries none of the declared labels")
        : unsatisfied(`The task carries ${present.length} of the declared labels`)
  }
}

/**
 * `dependencyOutcome`, which carries no value.
 *
 * ALL FOUR positive operators are `unsatisfied` for a task with no dependencies,
 * including `allSucceeded`. Vacuous truth would be the mathematically natural
 * answer and it is the WRONG one here: "all of zero dependencies succeeded" is a
 * statement about a task that has no dependencies, and reporting it as satisfied
 * would let a rule scope itself to "tasks whose dependencies all succeeded" and
 * quietly match every task that has none. Only `none` — which asserts the
 * absence of dependencies — is satisfied.
 */
function evaluateDependencyOutcomePredicate(
  predicate: Extract<RulePredicate, { field: "dependencyOutcome" }>,
  context: RuleEvaluationContext,
): VerdictWithReason {
  const outcomes = context.dependencyOutcomes
  if (predicate.operator === "none") {
    return outcomes.length === 0
      ? satisfied("The task has no dependencies")
      : unsatisfied(`The task has ${outcomes.length} dependencies`)
  }
  if (outcomes.length === 0) {
    return unknown("The task has no dependencies, so the outcome assertion could not be evaluated")
  }
  const succeededCount = outcomes.filter((outcome) => outcome === "succeeded").length
  const failedCount = outcomes.length - succeededCount
  switch (predicate.operator) {
    case "anySucceeded":
      return succeededCount > 0 ? satisfied("At least one dependency succeeded") : unsatisfied("No dependency succeeded")
    case "anyFailed":
      return failedCount > 0 ? satisfied("At least one dependency failed") : unsatisfied("No dependency failed")
    case "allSucceeded":
      return succeededCount === outcomes.length
        ? satisfied("Every dependency succeeded")
        : unsatisfied(`${failedCount} of ${outcomes.length} dependencies did not succeed`)
    case "allFailed":
      return failedCount === outcomes.length
        ? satisfied("Every dependency failed")
        : unsatisfied(`${succeededCount} of ${outcomes.length} dependencies did not fail`)
  }
}

function evaluateSensitivityPredicate(
  predicate: Extract<RulePredicate, { field: "contextSensitivity" }>,
  context: RuleEvaluationContext,
): VerdictWithReason {
  const sensitivity = context.contextManifestSensitivity
  if (sensitivity === null) {
    // An absent manifest is NEVER treated as rank 0. `none` is satisfied because
    // it asserts the absence of sensitive content and there is no manifest to
    // carry any; `maxRankAtLeast` is UNKNOWN rather than satisfied, because
    // "rank 0 satisfies rank >= 0" is precisely the vacuous reading the ADR
    // forbids. `maxRankAtMost` is unknown for the same reason: the claim is about
    // the actual rank, which is not knowable without a manifest.
    if (predicate.operator === "none") {
      return satisfied("No context manifest is present, so no sensitive content is in scope")
    }
    return unknown(
      "No context manifest is present, and an absent manifest is never treated as rank 0; the rank assertion could not be evaluated",
    )
  }
  if (Array.isArray(predicate.value)) {
    const hit = predicate.value.includes(sensitivity)
    return predicate.operator === "any"
      ? hit
        ? satisfied("The manifest's sensitivity is in the declared set")
        : unsatisfied("The manifest's sensitivity is not in the declared set")
      : hit
        ? unsatisfied("The manifest's sensitivity is in the declared set")
        : satisfied("The manifest's sensitivity is not in the declared set")
  }
  const rank = SENSITIVITY_RANK[sensitivity]
  const declared = predicate.value
  const holds = predicate.operator === "maxRankAtMost" ? rank <= declared : rank >= declared
  return holds
    ? satisfied(`The manifest's sensitivity rank ${rank} satisfies ${predicate.operator} ${declared}`)
    : unsatisfied(`The manifest's sensitivity rank ${rank} does not satisfy ${predicate.operator} ${declared}`)
}

/** Matches a compiled pattern against the context's title, failing closed on a null title. */
function evaluatePattern(predicate: Extract<RulePredicate, { field: "taskTitlePattern" }>, patterns: readonly SafePattern[], context: RuleEvaluationContext): VerdictWithReason {
  const title = context.taskTitle
  if (title === null) {
    // ADR 0007 section 4: a pattern predicate on a null subject is `unsatisfied`
    // with a reason, never `unknown` and never `satisfied`.
    return unsatisfied("The context supplies no task title, so the pattern could not match")
  }
  // Patterns are matched in DECLARATION order, and the i-th `taskTitlePattern`
  // predicate in the tree corresponds to the i-th compiled pattern. A rule with
  // two identical patterns therefore evaluates the same source twice, which is
  // wasteful and harmless; a rule with two different patterns evaluates each
  // against its own source, which is correct because the walk and the compile
  // both use declaration order.
  const compiled = patterns.find((pattern) => pattern.source === predicate.pattern)
  if (compiled === undefined) {
    return unsatisfied("The pattern is not present in the compiled rule, so it could not be matched")
  }
  const matched = matchesBounded(compiled, title)
  if (!matched.ok) {
    return unknown(`The match subject exceeded the bounded analyser subject length: ${matched.error.message}`)
  }
  return matched.value
    ? satisfied("The task title matched the bounded pattern")
    : unsatisfied("The task title did not match the bounded pattern")
}

/**
 * Evaluates a predicate TREE and produces the exported `PredicateOutcome`.
 *
 * The combinator semantics, and specifically the `not` rule:
 *
 *   all   satisfied iff EVERY child is satisfied. Any unknown child makes the
 *         conjunction unknown, because one unsatisfiable-or-unknown conjunct
 *         means the conjunction cannot be established.
 *   any   satisfied iff SOME child is satisfied — an unknown sibling does not
 *         prevent that, because the satisfied branch settles it. Satisfied
 *         otherwise unknown if any child is unknown, else unsatisfied.
 *   not   UNSATISFIED if the operand is unknown or unsatisfied, and satisfied
 *         only when the operand is positively satisfied. `not(unknown)` is
 *         `unsatisfied`: the fail-open direction, and the one this whole design
 *         exists to make impossible.
 */
function evaluatePredicateTree(
  predicate: RulePredicate,
  context: RuleEvaluationContext,
  patterns: readonly SafePattern[],
): { verdict: Verdict; outcome: PredicateOutcome } {
  if (predicate.field === "all" || predicate.field === "any") {
    const children = predicate.predicates.map((child) => evaluatePredicateTree(child, context, patterns))
    const isAll = predicate.field === "all"
    let verdict: Verdict
    if (isAll) {
      if (children.every((child) => child.verdict === "satisfied")) verdict = "satisfied"
      else if (children.some((child) => child.verdict === "unknown")) verdict = "unknown"
      else verdict = "unsatisfied"
    } else {
      if (children.some((child) => child.verdict === "satisfied")) verdict = "satisfied"
      else if (children.some((child) => child.verdict === "unknown")) verdict = "unknown"
      else verdict = "unsatisfied"
    }
    const operator = isAll ? "and" : "or"
    const reason =
      verdict === "satisfied"
        ? `Every branch of the ${operator} combinator was established`
        : verdict === "unknown"
          ? `At least one branch of the ${operator} combinator could not be evaluated`
          : `At least one branch of the ${operator} combinator was not satisfied`
    // Built from the EVALUATED children rather than re-walking the AST, so a
    // combinator's rendered text is by construction the text of what its
    // children actually resolved to.
    const childTexts = children.map((child) => child.outcome.normalized)
    const normalized =
      childTexts.length === 0 ? `${isAll ? "all" : "any"}()` : `(${childTexts.join(isAll ? " and " : " or ")})`
    return {
      verdict,
      outcome: toOutcome(
        predicate.field,
        operator,
        normalized,
        { verdict, reason },
        children.map((child) => child.outcome),
      ),
    }
  }

  if (predicate.field === "not") {
    const operand = evaluatePredicateTree(predicate.predicate, context, patterns)
    // THE LOAD-BEARING DECISION, and it is stated in terms of the operand's
    // OUTCOME rather than its verdict, because the two differ in exactly the case
    // that matters:
    //
    //   operand satisfied                          -> unsatisfied
    //   operand unsatisfied and EVALUABLE           -> satisfied
    //   operand unsatisfied but UNEVALUABLE         -> unsatisfied
    //   operand unknown                             -> unsatisfied
    //
    // The first rule is the obvious one. The third is ADR 0007 section 6's fail-
    // closed column: an unevaluable operand never satisfies a negation, so
    // `not(roleId == "r")` on a dispatch with no role is `unsatisfied` rather than
    // `satisfied`, and a rule scoped to "not the production role" does not match
    // every dispatch whose role the system could not determine.
    //
    // The second rule is the subtle one, and it is why the decision reads
    // `!operand.outcome.unevaluable` rather than `verdict === "unsatisfied"`.
    // Without it, `not(not(unknown))` collapses to `satisfied`: the inner `not`
    // reports `unsatisfied` (correctly, fail-closed), and an outer `not` reading
    // only the verdict would see "unsatisfied" and conclude the double negation
    // holds. It does not hold — `not(not(P))` is `P`, and `P` is unknown. Carrying
    // the unevaluable flag through the negation is what makes `not` INVOLUTIVE on
    // unknowns, and involutivity is the property that stops a rule author from
    // writing a fail-open rule by accident and reading it as a harmless rewrite.
    const holds = operand.verdict === "unsatisfied" && !operand.outcome.unevaluable
    const verdict: Verdict = holds ? "satisfied" : "unsatisfied"
    const unevaluable = operand.verdict === "unknown" || (operand.verdict === "unsatisfied" && operand.outcome.unevaluable)
    const reason =
      operand.verdict === "satisfied"
        ? "The operand was satisfied, so its complement does not hold"
        : operand.verdict === "unknown"
          ? "The operand could not be evaluated, so not of it is unsatisfied; an unevaluable operand never satisfies a negation"
          : unevaluable
            ? "The operand was unsatisfied only because it could not be evaluated, so its complement is not established either"
            : "The operand was not satisfied, so its complement holds"
    return {
      verdict,
      outcome: {
        ...toOutcome("not", "not", `(not ${normalizeForTrace(predicate.predicate)})`, { verdict, reason }, [
          operand.outcome,
        ]),
        unevaluable,
      },
    }
  }

  const leafVerdict = predicate.field === "taskTitlePattern"
    ? evaluatePattern(predicate, patterns, context)
    : evaluatePredicate(predicate, context)
  return {
    verdict: leafVerdict.verdict,
    outcome: toOutcome(predicate.field, leafOperator(predicate), normalizeForTrace(predicate), leafVerdict),
  }
}

function leafOperator(predicate: RulePredicate): string {
  if (predicate.field === "taskTitlePattern") return "matches"
  if (predicate.field === "scheduleWindow") return "in"
  if (predicate.field === "dependencyOutcome") return predicate.operator
  if (predicate.field === "capability" || predicate.field === "toolCategory" || predicate.field === "nodeAdvertisedCapability") {
    return predicate.operator
  }
  if (predicate.field === "taskLabel") return predicate.operator
  if (predicate.field === "contextSensitivity") return predicate.operator
  if (
    predicate.field === "projectId" ||
    predicate.field === "roleId" ||
    predicate.field === "targetNodeId" ||
    predicate.field === "projectPathId" ||
    predicate.field === "runtimeKind" ||
    predicate.field === "roleVersion" ||
    predicate.field === "fanOut" ||
    predicate.field === "concurrency" ||
    predicate.field === "retryLimit" ||
    predicate.field === "timeoutSeconds"
  ) {
    return predicate.operator
  }
  return "unknown"
}

/** The canonical text of a predicate, from the same renderer the compiler digests. */
function normalizeForTrace(predicate: RulePredicate): string {
  return normalizePredicateNode(predicate)
}

// ===========================================================================
// Match outcome
// ===========================================================================

/**
 * Why a rule is or is not effective for this dispatch.
 *
 * Ordered so that the most fundamental reason wins: a disabled rule is `disabled`
 * whatever else is true of it, because "this rule is switched off" is the fact a
 * reader needs before "and also its activation state is draft". Each value is
 * DISTINCT rather than folded into `not_matched`, because six different reasons a
 * rule did not fire are six different things to fix.
 */
function classifyRule(rule: CompiledRule, context: RuleEvaluationContext): { outcome: RuleMatchOutcome; reason: string } {
  if (!rule.enabled) {
    return { outcome: "disabled", reason: "The rule is disabled" }
  }
  if (rule.projectId !== context.projectId) {
    return {
      outcome: "project_scope_mismatch",
      reason: `rule.project_scope_mismatch: the rule declares project '${rule.projectId}' and the dispatch is for '${context.projectId}'`,
    }
  }
  if (rule.activation.state === "draft") {
    return { outcome: "not_activated", reason: "The rule is a draft and was never activated" }
  }
  if (rule.activation.state === "revoked") {
    return { outcome: "revoked", reason: "The rule was revoked" }
  }
  if (rule.activation.state === "expired") {
    return { outcome: "expired", reason: "The rule's activation state is 'expired'" }
  }
  if (rule.expiresAt !== null && Date.parse(rule.expiresAt) <= Date.parse(context.evaluatedAt)) {
    return { outcome: "expired", reason: `The rule expired at ${rule.expiresAt}` }
  }
  return { outcome: "matched", reason: "The rule is enabled, activated, unexpired and in scope" }
}

/**
 * Supersession: for each `ruleId`, only the highest `templateVersion` among the
 * rules that would otherwise be EFFECTIVE is effective.
 *
 * "Would otherwise be effective" is the important qualifier and it matches ADR
 * 0007 section 10.3 exactly: among enabled, activated, unexpired, in-scope rules.
 * A disabled higher version therefore does NOT supersede a live lower one, and a
 * rule that is merely revoked does not silence its own predecessor. Superseding
 * on the raw maximum version would let switching a newer rule off silently
 * disable the older one the operator had already accepted.
 */
function markSupersession(
  traces: readonly RuleEvaluationTrace[],
): RuleEvaluationTrace[] {
  const effectiveVersions = new Map<string, number>()
  for (const trace of traces) {
    if (trace.matchOutcome !== "matched") continue
    effectiveVersions.set(trace.ruleId, Math.max(effectiveVersions.get(trace.ruleId) ?? 0, trace.templateVersion))
  }
  return traces.map((trace) => {
    if (trace.matchOutcome !== "matched") return trace
    const highest = effectiveVersions.get(trace.ruleId)
    if (highest === undefined || highest === trace.templateVersion) return trace
    return {
      ...trace,
      matchOutcome: "superseded" as const,
      reason: `Version ${trace.templateVersion} is superseded by version ${highest} of the same ruleId and was not evaluated`,
      predicateOutcomes: [],
      actions: [],
    }
  })
}

// ===========================================================================
// Action resolution
// ===========================================================================

const BUDGET_FIELDS = [
  "maximumFanOut",
  "maximumConcurrency",
  "maximumRetryLimit",
  "maximumWallClockSeconds",
  "maximumUsageUnits",
] as const

type BudgetField = (typeof BUDGET_FIELDS)[number]

function isBudgetField(name: string): name is BudgetField {
  return (BUDGET_FIELDS as readonly string[]).includes(name)
}

function disposition(
  rule: CompiledRule,
  action: RuleAction,
  outcome: RuleActionDisposition["disposition"],
  reason: string,
  details: readonly string[] = [],
): RuleActionDisposition {
  return {
    ruleId: rule.ruleId,
    templateVersion: rule.templateVersion,
    kind: action.kind,
    rank: actionKindRank(action.kind),
    normalized: normalizeAction(action),
    disposition: outcome,
    reason,
    details,
  }
}

// ===========================================================================
// Shadowing (ADR 0007 section 10.5)
// ===========================================================================

/**
 * Is `outer`'s predicate a PROVEN superset of `inner`'s?
 *
 * `true`   — proven: every dispatch satisfying `inner` also satisfies `outer`.
 * `false`  — proven NOT to be a superset.
 * `null`   — not provable either way, which is reported as `possible_overlap`
 *            and NEVER as `shadowed`.
 *
 * The structural rules, in the ADR's own terms (`all([])` is top, `all` is
 * intersection, `any` is union, `not` is complement):
 *
 *   - `all([])` is TOP: it constrains nothing, so it is a superset of everything.
 *   - A field predicate is a superset of another only when they name the SAME
 *     field and their operator sets are subset-comparable. `capability any
 *     ["a","b"]` IS a superset of `capability any ["a"]`; `capability all ["a"]`
 *     is NOT a superset of `capability any ["b"]`; a `projectId` predicate and a
 *     `roleId` predicate are not comparable at all, because the two constrain
 *     different axes and either can hold alone.
 *   - `all([a, b])` is a superset of `all([a])` — the intersection of a
 *     superset and anything is a subset of the superset. This is the one
 *     direction that is sound: dropping conjuncts WIDENS.
 *   - `any([a])` is a superset of `any([a, b])` — dropping disjuncts NARROWS.
 *   - `not(x)` is a superset of `not(y)` exactly when `x` is a subset of `y`.
 *
 * Everything not covered is `null`. The distinction is the whole point of ADR
 * section 10.5: a preview that reported `shadowed` for two rules that merely
 * MIGHT co-match would train the user to ignore the field, and the one time it
 * mattered would be the time they ignored it.
 */
function provenSuperset(outer: RulePredicate, inner: RulePredicate): boolean | null {
  // `all([])` is top.
  if (outer.field === "all" && outer.predicates.length === 0) return true
  if (inner.field === "all" && inner.predicates.length === 0) return false

  if (outer.field === "all" && inner.field === "all") {
    // A superset of an intersection must dominate every conjunct.
    return outer.predicates.every((outerChild) =>
      inner.predicates.some((innerChild) => provenSuperset(outerChild, innerChild) === true),
    )
  }

  if (outer.field === "any" && inner.field === "any") {
    // A superset of a union needs one branch that dominates the whole union.
    return outer.predicates.some((outerChild) =>
      inner.predicates.every((innerChild) => provenSuperset(outerChild, innerChild) === true),
    )
  }

  if (outer.field === "not" && inner.field === "not") {
    const inverted = provenSuperset(inner.predicate, outer.predicate)
    return inverted === null ? null : !inverted
  }

  // A disjunction dominates a single predicate when one of its branches does.
  if (outer.field === "any") {
    const results = outer.predicates.map((child) => provenSuperset(child, inner))
    if (results.some((result) => result === true)) return true
    return results.every((result) => result === false) ? false : null
  }

  // A conjunction dominates a single predicate only if that predicate dominates
  // EVERY conjunct, which is the opposite of the "dropping conjuncts widens"
  // rule above and is therefore NOT a superset in general. `all([a,b])` does not
  // dominate `a`.
  if (outer.field === "all") {
    return false
  }

  if (outer.field === "not") {
    // A negation never provably dominates a positive predicate.
    return false
  }

  // Leaf against leaf: same field, subset-comparable operators.
  if (outer.field !== inner.field) return null
  return compareFieldPredicates(outer, inner)
}

/** `S` dominates `T`: every member of `T` is in `S`. */
function setDominates(outer: readonly string[], inner: readonly string[]): boolean {
  const outerSet = new Set(outer)
  return inner.every((member) => outerSet.has(member))
}

const IDENTIFIER_FIELDS = ["projectId", "roleId", "targetNodeId", "projectPathId", "runtimeKind"] as const
const SET_FIELDS = ["capability", "toolCategory", "nodeAdvertisedCapability"] as const
const COMPARISON_FIELDS = ["roleVersion", "fanOut", "concurrency", "retryLimit", "timeoutSeconds"] as const

type IdentifierPredicateMember = Extract<RulePredicate, { field: (typeof IDENTIFIER_FIELDS)[number] }>
type SetPredicateMember = Extract<RulePredicate, { field: (typeof SET_FIELDS)[number] }>
type ComparisonPredicateMember = Extract<RulePredicate, { field: (typeof COMPARISON_FIELDS)[number] }>
type TaskLabelMember = Extract<RulePredicate, { field: "taskLabel" }>
type SensitivityMember = Extract<RulePredicate, { field: "contextSensitivity" }>
type DependencyOutcomeMember = Extract<RulePredicate, { field: "dependencyOutcome" }>

function isOneOf<T extends string>(value: string, members: readonly T[]): value is T {
  return (members as readonly string[]).includes(value)
}

/**
 * Leaf-against-leaf subset comparability, on the same field only.
 *
 * Every branch is a two-line rule with a stated justification, and every branch
 * that cannot decide returns `null`. The `null` cases are the interesting ones:
 * they are what makes `possible_overlap` reachable, and a comparison that
 * guessed would produce a `shadowed` the author then trusted and did not have.
 */
function compareFieldPredicates(outer: RulePredicate, inner: RulePredicate): boolean | null {
  if (isOneOf(outer.field, IDENTIFIER_FIELDS)) {
    if (inner.field !== outer.field) return null
    const left = outer as IdentifierPredicateMember
    const right = inner as IdentifierPredicateMember
    if (left.operator === "eq" && right.operator === "eq") return left.value === right.value
    if (left.operator === "in" && right.operator === "in") {
      if (!Array.isArray(left.value) || !Array.isArray(right.value)) return null
      return setDominates(left.value, right.value)
    }
    // `eq x` against `in [x]`, and the mismatched operator pairs, are decided
    // elsewhere or not at all; returning `null` is the honest answer.
    return null
  }

  if (isOneOf(outer.field, SET_FIELDS)) {
    if (inner.field !== outer.field) return null
    const left = outer as SetPredicateMember
    const right = inner as SetPredicateMember
    if (left.operator === "none") {
      // `none S` dominates `none T` when `S ⊆ T`: asserting the absence of more
      // is the stronger claim, so it admits more dispatches.
      return right.operator === "none" ? setDominates(right.value, left.value) : false
    }
    if (left.operator === "all") {
      // `all S` dominates `all T` when `T ⊆ S`: demanding more is the stronger claim.
      return right.operator === "all" ? setDominates(right.value, left.value) : false
    }
    // `any S` dominates `any T` when `T ⊆ S`.
    return right.operator === "any" ? setDominates(left.value, right.value) : false
  }

  if (outer.field === "taskLabel") {
    if (inner.field !== "taskLabel") return null
    const left = outer as TaskLabelMember
    const right = inner as TaskLabelMember
    const outerLabels = labelValues(left)
    const innerLabels = labelValues(right)
    if (left.operator === "lacks") {
      // `lacks` is the weakest assertion: it admits every dispatch that carries
      // none of its labels, which is a superset of everything a positive label
      // assertion can require. So it dominates only another `lacks` whose set it
      // contains, and is dominated by every positive operator.
      return right.operator === "lacks" ? setDominates(innerLabels, outerLabels) : false
    }
    if (right.operator === "lacks") return true
    if (left.operator === "has") {
      if (right.operator === "has") return outerLabels[0] === innerLabels[0]
      // `has "x"` dominates `hasAny S` and a single-element `hasAll S` when it
      // names the same label, and dominates nothing else.
      return right.operator === "hasAny"
        ? innerLabels.includes(outerLabels[0] ?? "")
        : right.operator === "hasAll" && innerLabels.length === 1 && innerLabels[0] === outerLabels[0]
    }
    if (right.operator === "has") return false
    if (left.operator === "hasAny" && right.operator === "hasAny") return setDominates(outerLabels, innerLabels)
    if (left.operator === "hasAll" && right.operator === "hasAll") return setDominates(innerLabels, outerLabels)
    if (left.operator === "hasAll" && right.operator === "hasAny") {
      return innerLabels.every((label) => outerLabels.includes(label))
    }
    return null
  }

  // `dependencyOutcome`: identity only. `anySucceeded` and `allSucceeded` are
  // genuinely incomparable — one succeeded dependency satisfies both, and one
  // failed dependency satisfies neither — so nothing else is proven.
  if (outer.field === "dependencyOutcome") {
    if (inner.field !== "dependencyOutcome") return null
    return outer.operator === (inner as DependencyOutcomeMember).operator
  }

  // `contextSensitivity`: the two rank comparisons are ordered against each
  // other; `any` and `none` are sets and compare only to themselves.
  if (outer.field === "contextSensitivity") {
    if (inner.field !== "contextSensitivity") return null
    const left = outer as SensitivityMember
    const right = inner as SensitivityMember
    if (left.operator === "maxRankAtMost" && right.operator === "maxRankAtMost") {
      return (left.value as number) <= (right.value as number)
    }
    if (left.operator === "maxRankAtLeast" && right.operator === "maxRankAtLeast") {
      return (left.value as number) >= (right.value as number)
    }
    if (left.operator === "maxRankAtMost" && right.operator === "maxRankAtLeast") {
      // `rank <= k` admits every rank the `rank >= j` assertion admits when
      // `j <= k`. When `j > k` the two describe disjoint ranges.
      return (left.value as number) >= (right.value as number)
    }
    if (left.operator === "maxRankAtLeast" && right.operator === "maxRankAtMost") return false
    if (left.operator === "none" && right.operator === "none") {
      return Array.isArray(left.value) && Array.isArray(right.value) ? setDominates(right.value, left.value) : null
    }
    if (left.operator === "any" && right.operator === "any") {
      return Array.isArray(left.value) && Array.isArray(right.value) ? setDominates(left.value, right.value) : null
    }
    return false
  }

  // Numeric comparisons: only interval containment is proven, and only between
  // two `between` forms on the SAME field. `fanOut <= 4` against `fanOut >= 2` is
  // not comparable — one admits the top of the range and the other the bottom —
  // and `fanOut` against `concurrency` is not comparable either, because they are
  // independent axes and either can hold alone.
  if (isOneOf(outer.field, COMPARISON_FIELDS)) {
    if (inner.field !== outer.field) return null
    const left = outer as ComparisonPredicateMember
    const right = inner as ComparisonPredicateMember
    if (left.operator !== "between" || right.operator !== "between") return null
    const leftRange = left.value as { min: number; max: number }
    const rightRange = right.value as { min: number; max: number }
    return leftRange.min <= rightRange.min && leftRange.max >= rightRange.max
  }

  // `scheduleWindow` and `taskTitlePattern`: containment over a set of windows /
  // a regular language is not decided here, so neither is proven comparable.
  return null
}

/** A `taskLabel` predicate's labels, whether it declared one or many. */
function labelValues(predicate: TaskLabelPredicate): string[] {
  return Array.isArray(predicate.value) ? [...predicate.value] : [predicate.value]
}

/**
 * A rule A SHADOWS rule B when A's predicate is a proven superset of B's AND A's
 * actions are a superset of B's.
 *
 * "A's actions are a superset" is by ACTION KIND, not by value: a `deny` that
 * denies fewer capabilities is not a superset of a `deny` that denies more, and
 * pretending otherwise would report a shadowing that does not exist. Kind-level
 * containment is the level at which the question is answerable from the
 * normalized AST, and it is the conservative answer: requiring the stronger
 * condition means a shadowing is reported less often, never more.
 */
function analyzeShadowing(traces: readonly RuleEvaluationTrace[], rules: readonly CompiledRule[]): RuleShadowing[] {
  const findings: RuleShadowing[] = []
  const effective = traces.filter((trace) => trace.matchOutcome === "matched")
  const byIdentity = new Map(rules.map((rule) => [`${rule.ruleId}@${rule.templateVersion}`, rule]))

  for (const outerTrace of effective) {
    const outer = byIdentity.get(`${outerTrace.ruleId}@${outerTrace.templateVersion}`)
    if (outer === undefined) continue
    for (const innerTrace of effective) {
      if (outerTrace === innerTrace) continue
      if (outerTrace.ruleId === innerTrace.ruleId) continue
      const inner = byIdentity.get(`${innerTrace.ruleId}@${innerTrace.templateVersion}`)
      if (inner === undefined) continue

      const outerKinds = new Set(outer.actions.map((action) => action.kind))
      const actionsCover = inner.actions.every((action) => outerKinds.has(action.kind))
      const predicatesCover = outer.predicates.every((outerPredicate) =>
        inner.predicates.some((innerPredicate) => provenSuperset(outerPredicate, innerPredicate) === true),
      )
      if (predicatesCover && actionsCover) {
        findings.push({
          shadowingRuleId: outer.ruleId,
          shadowedRuleId: inner.ruleId,
          relation: "shadowed",
          reason: "The rule's predicate is a proven superset of the other rule's predicate and its actions cover the other rule's action kinds",
        })
        continue
      }

      // Not proven. Is DISJOINTNESS provable instead? Two rules on the same axis
      // with provably disjoint value sets cannot co-match, and reporting
      // `possible_overlap` for them would be the mirror-image error.
      if (provenDisjoint(outer.predicates, inner.predicates)) {
        findings.push({
          shadowingRuleId: outer.ruleId,
          shadowedRuleId: inner.ruleId,
          relation: "possible_overlap",
          reason: "The rules constrain the same axis to provably disjoint value sets, so they cannot both match",
        })
        continue
      }

      findings.push({
        shadowingRuleId: outer.ruleId,
        shadowedRuleId: inner.ruleId,
        relation: "possible_overlap",
        reason: "Superset could not be proven for this pair, and disjointness could not be proven either; they may co-match and are reported as a possible overlap rather than a shadowing",
      })
    }
  }
  return findings
}

/** The axes two predicates can be proven disjoint on: the enumerated-set fields. */
const DISJOINTNESS_FIELDS = new Set<string>([
  ...SET_FIELDS,
  ...IDENTIFIER_FIELDS,
])

/**
 * Provable disjointness on the same axis. Deliberately narrow.
 *
 * Only same-field, same-operator, non-overlapping member sets. Anything less is
 * reported as `possible_overlap`, which is the direction this module errs in:
 * telling a user their two rules might both fire when they cannot costs one
 * wasted look, and telling them one is shadowed when it is not costs a
 * pre-approval the user believed they had.
 */
function provenDisjoint(outer: readonly RulePredicate[], inner: readonly RulePredicate[]): boolean {
  return outer.some((left) =>
    inner.some((right) => {
      if (left.field !== right.field) return false
      if (!DISJOINTNESS_FIELDS.has(left.field)) return false
      if (isOneOf(left.field, SET_FIELDS)) {
        const leftSet = left as SetPredicateMember
        const rightSet = right as SetPredicateMember
        if (leftSet.operator !== rightSet.operator) return false
        return setsAreDisjoint(leftSet.value, rightSet.value)
      }
      const leftIdentifier = left as IdentifierPredicateMember
      const rightIdentifier = right as IdentifierPredicateMember
      if (leftIdentifier.operator !== "in" || rightIdentifier.operator !== "in") return false
      if (!Array.isArray(leftIdentifier.value) || !Array.isArray(rightIdentifier.value)) return false
      return setsAreDisjoint(leftIdentifier.value, rightIdentifier.value)
    }),
  )
}

function setsAreDisjoint(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left)
  return right.every((member) => !leftSet.has(member))
}

// ===========================================================================
// Public evaluation API
// ===========================================================================

/**
 * Evaluates a compiled rule set against one dispatch.
 *
 * Pure and total: no IO, no clock, no randomness, and the same
 * `(ruleSet, context)` pair always produces a byte-identical `decisionDigest`.
 * The context is PARSED rather than trusted, because a context that does not
 * satisfy its own schema would otherwise be evaluated field by field into
 * whatever `undefined` happened to mean, and `undefined` is exactly the shape a
 * fail-open bug wears.
 */
export function evaluateRules(compiled: CompiledRuleSet, context: unknown): RuleEvaluationResult {
  const parsed = ruleEvaluationContextSchema.safeParse(context)
  if (!parsed.success) {
    throw new Error(
      `rule.invalid_context: the evaluation context does not satisfy its schema: ${parsed.error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    )
  }
  const evaluationContext: RuleEvaluationContext = parsed.data

  // 1. Eligibility, per rule, with a distinct outcome per reason.
  const classified = compiled.rules.map((rule) => {
    const { outcome, reason } = classifyRule(rule, evaluationContext)
    return { rule, outcome, reason }
  })

  // 2. Supersession among the otherwise-effective rules.
  const preTraces: RuleEvaluationTrace[] = classified.map(({ rule, outcome, reason }) => ({
    ruleId: rule.ruleId,
    templateVersion: rule.templateVersion,
    projectId: rule.projectId,
    matchOutcome: outcome,
    reason,
    predicateOutcomes: [],
    actions: [],
  }))
  const traces = markSupersession(preTraces)

  // 3. Predicate evaluation for the rules that are still candidates, through the
  //    same single-rule entry point the disclosure uses. An empty predicate list
  //    is `all([])`: the universal predicate, satisfied.
  for (let index = 0; index < traces.length; index += 1) {
    const trace = traces[index]
    if (trace === undefined || trace.matchOutcome !== "matched") continue
    const rule = compiled.rules.find(
      (candidate) => candidate.ruleId === trace.ruleId && candidate.templateVersion === trace.templateVersion,
    )
    if (rule === undefined) continue
    const evaluated = evaluateCompiledRule(rule, evaluationContext)
    traces[index] = { ...trace, matchOutcome: evaluated.matchOutcome, reason: evaluated.reason, predicateOutcomes: evaluated.predicateOutcomes }
  }

  const matchedRules = compiled.rules.filter((rule) => {
    const trace = traces.find(
      (candidate) => candidate.ruleId === rule.ruleId && candidate.templateVersion === rule.templateVersion,
    )
    return trace?.matchOutcome === "matched"
  })

  // 4. Conflicts and action dispositions, in rule sort order.
  const dispositionsByIdentity = new Map<string, RuleActionDisposition[]>()
  const denyReasons: { ruleId: string; reason: string }[] = []
  const denyRuleIds: string[] = []
  const budgetContributions: { rule: CompiledRule; limits: RuleBudgetLimits }[] = []
  const rejectedWidening: {
    ruleId: CompiledRule["ruleId"]
    field: string
    attempted: number
    current: number
  }[] = []
  const routingContributions: {
    ruleId: CompiledRule["ruleId"]
    preference: RuleRoutingComposition["contributions"][number]["preference"]
  }[] = []
  const preApprovalCandidates: RulePreApprovalCandidate[] = []

  for (const rule of matchedRules) {
    const identity = `${rule.ruleId}@${rule.templateVersion}`
    const dispositions: RuleActionDisposition[] = []
    for (const action of rule.actions) {
      switch (action.kind) {
        case "deny_with_reason":
          denyRuleIds.push(rule.ruleId)
          denyReasons.push({ ruleId: rule.ruleId, reason: action.reason })
          dispositions.push(disposition(rule, action, "applied", "The rule matched and contributes a hard deny"))
          break
        case "require_approval":
        case "add_restrictions":
          dispositions.push(disposition(rule, action, "applied", "The rule matched and contributes a narrowing the kernel applies as a rule-layer restriction"))
          break
        case "set_stricter_budget": {
          // A COPY, not the action's own budget object. The compiled rule is
          // deep-frozen, and writing the accepted members back into it would
          // either throw or — in a non-strict context — corrupt the artifact that
          // the runtime evaluation of the same set is about to read. The narrowing
          // has to be recorded somewhere the artifact does not own.
          const accepted: RuleBudgetLimits = {}
          const current = evaluationContext.currentBudget
          for (const field of BUDGET_FIELDS) {
            const declared = action.budget[field]
            if (declared === undefined) continue
            const inForce = current?.[field]
            if (inForce !== undefined && declared > inForce) {
              // ADR 0007 section 7.6: recorded, ignored, never applied. A rule
              // that TRIED to escalate is an audit event whether or not it
              // succeeded, and the trace names the attempted value.
              rejectedWidening.push({ ruleId: rule.ruleId, field, attempted: declared, current: inForce })
              continue
            }
            accepted[field] = declared
          }
          if (action.budget.usageUnit !== undefined) accepted.usageUnit = action.budget.usageUnit
          budgetContributions.push({ rule, limits: accepted })
          const rejected = rejectedWidening.filter((entry) => entry.ruleId === rule.ruleId)
          dispositions.push(
            disposition(
              rule,
              action,
              rejected.length > 0 ? "rejected_widening" : "applied",
              rejected.length > 0
                ? `A declared budget value exceeded the budget in force and was refused: ${rejected
                    .map((entry) => `${entry.field} ${entry.attempted} > ${entry.current}`)
                    .join("; ")}`
                : "Every declared budget value is at or below the budget in force and was applied elementwise",
              rejected.map((entry) => `${entry.field}=${entry.attempted} over ${entry.current}`),
            ),
          )
          break
        }
        case "select_routing_preference":
          routingContributions.push({ ruleId: rule.ruleId, preference: action.preference })
          dispositions.push(
            disposition(rule, action, "applied", "The rule matched and contributes a routing preference, which can only reorder already-eligible nodes"),
          )
          break
        case "pre_approve_within_bounds": {
          const candidate = judgePreApprovalBounds(action, evaluationContext)
          preApprovalCandidates.push({ ruleId: rule.ruleId, templateVersion: rule.templateVersion, bounds: candidate.bounds, boundsSatisfied: candidate.satisfied, reason: candidate.reason })
          dispositions.push(
            disposition(
              rule,
              action,
              candidate.satisfied ? "applied" : "bounds_exceeded",
              candidate.reason,
              candidate.details,
            ),
          )
          break
        }
      }
    }
    dispositionsByIdentity.set(identity, dispositions)
  }

  for (const trace of traces) {
    if (trace.matchOutcome !== "matched") continue
    const identity = `${trace.ruleId}@${trace.templateVersion}`
    const ruleDispositions = dispositionsByIdentity.get(identity)
    if (ruleDispositions === undefined) continue
    traces[traces.indexOf(trace)] = { ...trace, actions: ruleDispositions }
  }

  // 5. ADR 0007 section 10.4, each row.
  const conflicts: RuleConflict[] = []
  const lowestDenyRuleId = matchedRules
    .filter((rule) => rule.actions.some((action) => action.kind === "deny_with_reason"))
    .map((rule) => rule.ruleId)
    .sort(compareIds)[0]
  const deny =
    denyRuleIds.length === 0 || lowestDenyRuleId === undefined
      ? null
      : {
          ruleIds: matchedRules
            .filter((rule) => rule.actions.some((action) => action.kind === "deny_with_reason"))
            .map((rule) => rule.ruleId),
          reason: denyReasons.find((entry) => entry.ruleId === lowestDenyRuleId)?.reason ?? "",
          reasons: denyReasons,
        }

  // The lowest sort key whose declared bounds are fully satisfied grants; the
  // others are recorded as shadowed.
  const satisfiedCandidates = preApprovalCandidates.filter((candidate) => candidate.boundsSatisfied)
  const grantedBy = satisfiedCandidates.length === 0 ? null : satisfiedCandidates[0]?.ruleId ?? null
  const shadowedPreApprovals = satisfiedCandidates.slice(1).map((candidate) => candidate.ruleId)
  if (deny !== null && preApprovalCandidates.length > 0) {
    conflicts.push({ kind: "deny_overrides_pre_approval", ruleIds: sortedIds([...deny.ruleIds, ...preApprovalCandidates.map((c) => c.ruleId)]) })
  }
  if (deny !== null && deny.ruleIds.length > 1) {
    conflicts.push({ kind: "multiple_deny", ruleIds: sortedIds(deny.ruleIds) })
  }
  if (satisfiedCandidates.length > 1 && grantedBy !== null) {
    conflicts.push({ kind: "multiple_pre_approval", grantedBy, shadowed: sortedIds(shadowedPreApprovals) })
  }
  if (routingContributions.length > 1) {
    conflicts.push({ kind: "multiple_routing_preference", ruleIds: sortedIds(routingContributions.map((entry) => entry.ruleId)) })
  }

  // 6. Compositions the kernel does not model.
  const routing = composeRouting(routingContributions)
  const budgets = composeBudgets(budgetContributions, evaluationContext.currentBudget, rejectedWidening)
  const restrictions = composeRestrictions(matchedRules, deniedCapabilityUnion(matchedRules))
  const preApproval =
    preApprovalCandidates.length === 0
      ? null
      : {
          candidates: preApprovalCandidates,
          grantedBy: deny === null ? grantedBy : null,
          shadowed: deny === null ? sortedIds(shadowedPreApprovals) : [],
          blockedBy: deny === null ? null : (lowestDenyRuleId ?? null),
        }

  // Mark dispositions that a conflict overrode.
  const finalTraces = traces.map((trace) => {
    if (trace.actions.length === 0) return trace
    const actions = trace.actions.map((action) => {
      if (deny !== null && (action.kind === "pre_approve_within_bounds" || action.kind === "select_routing_preference")) {
        return { ...action, disposition: "conflict_denied" as const, reason: `A matched deny_with_reason overrides this ${action.kind}; deny wins` }
      }
      if (action.kind === "pre_approve_within_bounds" && shadowedPreApprovals.includes(trace.ruleId)) {
        return { ...action, disposition: "shadowed" as const, reason: "A lower sort key pre-approval already grants with fully satisfied bounds" }
      }
      return action
    })
    return { ...trace, actions }
  })

  const kernelRules = matchedRules
    .map((rule) => boundKernelRuleToDispatch(rule, evaluationContext))
    .filter((rule): rule is Rule => rule !== null)

  const base = {
    languageVersion: compiled.languageVersion,
    projectId: evaluationContext.projectId,
    evaluatedAt: evaluationContext.evaluatedAt,
    ruleSetDigest: compiled.digest,
    traces: finalTraces,
    conflicts,
    shadowing: analyzeShadowing(finalTraces, compiled.rules),
    deny,
    restrictions,
    budgets,
    routing,
    preApproval,
    kernelRules,
  }

  return { ...base, decisionDigest: digestJson(base) }
}

function compareIds(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Binds a compiled rule's kernel projection to one dispatch.
 *
 * The M0 `pre_approve` effect carries `maximumTimeoutSeconds` and the M0
 * re-check refuses a grant whose rule maximum exceeds the EFFECTIVE state
 * ceiling (`src/orchestration/policy/evaluate.ts:549-553`). A rule that declares
 * a 900-second maximum, attached to a dispatch that asked for 600, would
 * therefore be refused by the kernel for declaring a ceiling above the dispatch
 * it is attached to — a false negative that would make every pre-approval with a
 * generous declared bound silently never fire.
 *
 * The fix is to lower the PROJECTED ceiling to the dispatch's own declared
 * timeout, which is a `min` and therefore can only narrow. The rule's DECLARED
 * bound is untouched: it is still what the disclosure shows, and the M6 trace
 * still records what was declared. Only the M0 projection is bound, and only
 * downward, which is the direction every other composition in this module moves.
 *
 * A projection is never widened here. There is no branch that raises a ceiling.
 */
function boundKernelRuleToDispatch(rule: CompiledRule, context: RuleEvaluationContext): Rule | null {
  const projected = rule.kernelRule
  if (projected === null) return null
  if (projected.effect.kind !== "pre_approve") return projected
  if (context.declaredTimeoutSeconds === null) return projected
  const bounded = Math.min(projected.effect.maximumTimeoutSeconds, context.declaredTimeoutSeconds)
  if (bounded === projected.effect.maximumTimeoutSeconds) return projected
  return {
    ...projected,
    effect: { ...projected.effect, maximumTimeoutSeconds: bounded },
  }
}

/**
 * Evaluates ONE compiled rule against one context, with no supersession.
 *
 * The disclosure's history check needs exactly this: "would this rule have
 * matched that dispatch". It is a real function rather than a re-walk of the
 * predicate tree because the disclosure and the runtime must not be able to
 * disagree about what a rule matches — two walkers would be two evaluators, which
 * is ADR 0007's first stop condition in miniature.
 *
 * Supersession is deliberately absent. It is a property of a SET (which version
 * of a `ruleId` is effective), and a single historical dispatch is being asked
 * about one specific version, so applying supersession here would answer a
 * different question.
 */
export function evaluateCompiledRule(rule: CompiledRule, context: unknown): RuleEvaluationTrace {
  const parsed = ruleEvaluationContextSchema.safeParse(context)
  if (!parsed.success) {
    throw new Error(
      `rule.invalid_context: the evaluation context does not satisfy its schema: ${parsed.error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    )
  }
  const evaluationContext: RuleEvaluationContext = parsed.data

  const { outcome, reason } = classifyRule(rule, evaluationContext)
  const base: RuleEvaluationTrace = {
    ruleId: rule.ruleId,
    templateVersion: rule.templateVersion,
    projectId: rule.projectId,
    matchOutcome: outcome,
    reason,
    predicateOutcomes: [],
    actions: [],
  }
  if (outcome !== "matched") return base

  const predicateOutcomes = rule.predicates.map(
    (predicate) => evaluatePredicateTree(predicate, evaluationContext, rule.patterns).outcome,
  )
  // An empty predicate list is `all([])`: the universal predicate, satisfied.
  const allSatisfied = predicateOutcomes.every((entry) => entry.satisfaction === "satisfied")
  if (allSatisfied) return { ...base, predicateOutcomes }
  return {
    ...base,
    matchOutcome: "not_matched",
    reason: `One or more predicates were not satisfied: ${predicateOutcomes
      .filter((entry) => entry.satisfaction !== "satisfied")
      .map((entry) => entry.normalized)
      .join("; ")}`,
    predicateOutcomes,
  }
}

function sortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort(compareIds)
}

/**
 * Judges whether a pre-approval's DECLARED bounds cover this dispatch.
 *
 * This is NOT the kernel's re-check and does not pretend to be. The kernel
 * re-derives the grant against the fully narrowed state — including whether the
 * rule covers every effectively allowed capability and whether the declared
 * timeout exceeds the effective ceiling — and that re-check is authoritative
 * (ADR 0007 section 7.7, mechanism 3). What this function does is refuse to
 * OFFER a candidate whose own declared bounds the dispatch already exceeds, which
 * the kernel cannot know about because `fanOut`, `concurrency`, `retryLimit` and
 * context sensitivity are not in the M0 rule shape at all.
 *
 * A bound the context cannot supply is NOT satisfied. A pre-approval with
 * `maximumFanOut: 4` against a dispatch with no known fan-out is refused rather
 * than granted, because "I do not know" and "it is within bounds" are different
 * answers and only one of them is safe to act on.
 */
function judgePreApprovalBounds(
  action: Extract<RuleAction, { kind: "pre_approve_within_bounds" }>,
  context: RuleEvaluationContext,
): { bounds: RulePreApprovalBounds; satisfied: boolean; reason: string; details: string[] } {
  const bounds: RulePreApprovalBounds = {
    approvedCapabilities: action.approvedCapabilities,
    maximumTimeoutSeconds: action.maximumTimeoutSeconds,
    maximumSensitivity: action.maximumSensitivity,
    ...(action.maximumFanOut === undefined ? {} : { maximumFanOut: action.maximumFanOut }),
    ...(action.maximumConcurrency === undefined ? {} : { maximumConcurrency: action.maximumConcurrency }),
    ...(action.maximumRetryLimit === undefined ? {} : { maximumRetryLimit: action.maximumRetryLimit }),
  }
  const exceedances: string[] = []

  if (context.declaredTimeoutSeconds === null) {
    exceedances.push("the dispatch's declared timeout is unknown")
  } else if (context.declaredTimeoutSeconds > action.maximumTimeoutSeconds) {
    exceedances.push(`declared timeout ${context.declaredTimeoutSeconds}s exceeds the declared maximum ${action.maximumTimeoutSeconds}s`)
  }
  if (action.maximumFanOut !== undefined) {
    if (context.requestedFanOut === null) exceedances.push("the dispatch's requested fan-out is unknown")
    else if (context.requestedFanOut > action.maximumFanOut) {
      exceedances.push(`requested fan-out ${context.requestedFanOut} exceeds the declared maximum ${action.maximumFanOut}`)
    }
  }
  if (action.maximumConcurrency !== undefined) {
    if (context.requestedConcurrency === null) exceedances.push("the dispatch's requested concurrency is unknown")
    else if (context.requestedConcurrency > action.maximumConcurrency) {
      exceedances.push(`requested concurrency ${context.requestedConcurrency} exceeds the declared maximum ${action.maximumConcurrency}`)
    }
  }
  if (action.maximumRetryLimit !== undefined) {
    if (context.requestedRetryLimit === null) exceedances.push("the dispatch's requested retry limit is unknown")
    else if (context.requestedRetryLimit > action.maximumRetryLimit) {
      exceedances.push(`requested retry limit ${context.requestedRetryLimit} exceeds the declared maximum ${action.maximumRetryLimit}`)
    }
  }
  if (context.contextManifestSensitivity === null) {
    exceedances.push("the dispatch has no context manifest, so no sensitivity can be compared against the declared maximum")
  } else if (SENSITIVITY_RANK[context.contextManifestSensitivity] > SENSITIVITY_RANK[action.maximumSensitivity]) {
    exceedances.push(
      `the manifest's sensitivity rank ${SENSITIVITY_RANK[context.contextManifestSensitivity]} exceeds the declared maximum rank ${SENSITIVITY_RANK[action.maximumSensitivity]}`,
    )
  }
  for (const capability of action.approvedCapabilities) {
    if (!context.requestedCapabilities.includes(capability)) {
      exceedances.push(`the dispatch does not request '${capability}'`)
    }
  }

  return {
    bounds,
    satisfied: exceedances.length === 0,
    reason:
      exceedances.length === 0
        ? "Every declared bound covers this dispatch; the kernel's post-narrowing re-check still decides the grant"
        : `The declared bounds do not cover this dispatch: ${exceedances.join("; ")}`,
    details: exceedances,
  }
}

/**
 * Elementwise `min` over the applied budget contributions, starting from the
 * budget already in force.
 *
 * `usageUnit` is NOT min-numerable: it is a unit, not a magnitude, and taking
 * the smaller of two unit names is meaningless. The FIRST contribution in rule
 * sort order that declares one wins, and a second contribution declaring a
 * different unit is recorded as a widening refusal rather than silently
 * overriding it.
 */
function composeBudgets(
  contributions: readonly { rule: CompiledRule; limits: RuleBudgetLimits }[],
  current: RuleBudgetLimits | null,
  rejected: { ruleId: CompiledRule["ruleId"]; field: string; attempted: number; current: number }[],
): RuleEvaluationResult["budgets"] {
  const limits: RuleBudgetLimits = { ...(current ?? {}) }
  for (const contribution of contributions) {
    for (const field of BUDGET_FIELDS) {
      const declared = contribution.limits[field]
      if (declared === undefined) continue
      const inForce = limits[field]
      limits[field] = inForce === undefined ? declared : Math.min(inForce, declared)
    }
    if (contribution.limits.usageUnit !== undefined) {
      if (limits.usageUnit === undefined || limits.usageUnit === contribution.limits.usageUnit) {
        limits.usageUnit = contribution.limits.usageUnit
      } else if (!rejected.some((entry) => entry.ruleId === contribution.rule.ruleId && entry.field === "usageUnit")) {
        rejected.push({
          ruleId: contribution.rule.ruleId,
          field: "usageUnit",
          attempted: BUDGET_FIELDS.length,
          current: BUDGET_FIELDS.length,
        })
      }
    }
  }
  return {
    limits: Object.fromEntries(Object.entries(limits).sort(([left], [right]) => compareIds(left, right))) as RuleBudgetLimits,
    rejectedWidening: [...rejected].sort((left, right) =>
      left.field === right.field ? compareIds(left.ruleId, right.ruleId) : compareIds(left.field, right.field),
    ),
  }
}

/**
 * The unioned routing preference.
 *
 * "The first non-empty `preferredNodeIds` wins, later ones extend the tail" — the
 * head is the higher-priority rule's order and later rules APPEND, they do not
 * reorder. `requiredRuntimeKind` and `requiredProjectPathId` are hard
 * requirements rather than preferences, so two rules declaring different values
 * are a genuine conflict; the first in rule sort order wins and the difference is
 * recorded in the conflict list by the caller.
 */
function composeRouting(
  contributions: readonly { ruleId: CompiledRule["ruleId"]; preference: RuleRoutingComposition["contributions"][number]["preference"] }[],
): RuleRoutingComposition {
  const preferredNodeIds: string[] = []
  const excludedNodeIds: string[] = []
  let requiredRuntimeKind: string | null = null
  let requiredProjectPathId: string | null = null
  for (const contribution of contributions) {
    const preference = contribution.preference
    for (const nodeId of preference.preferredNodeIds ?? []) {
      if (!preferredNodeIds.includes(nodeId)) preferredNodeIds.push(nodeId)
    }
    for (const nodeId of preference.excludedNodeIds ?? []) {
      if (!excludedNodeIds.includes(nodeId)) excludedNodeIds.push(nodeId)
    }
    if (requiredRuntimeKind === null && preference.requiredRuntimeKind !== undefined) {
      requiredRuntimeKind = preference.requiredRuntimeKind
    }
    if (requiredProjectPathId === null && preference.requiredProjectPathId !== undefined) {
      requiredProjectPathId = preference.requiredProjectPathId
    }
  }
  return {
    contributions: contributions.map((entry) => ({ ruleId: entry.ruleId, preference: entry.preference })),
    preferredNodeIds,
    excludedNodeIds: excludedNodeIds.sort(compareIds),
    requiredRuntimeKind,
    requiredProjectPathId,
  }
}

/** The union of every matched `add_restrictions.deniedCapabilities`. */
function deniedCapabilityUnion(rules: readonly CompiledRule[]): string[] {
  const members = new Set<string>()
  for (const rule of rules) {
    for (const action of rule.actions) {
      if (action.kind === "add_restrictions" && action.deniedCapabilities !== undefined) {
        for (const capability of action.deniedCapabilities) members.add(capability)
      }
    }
  }
  return [...members].sort(compareIds)
}

/**
 * The composed restriction contribution, in the exact shape `narrowPolicyState`
 * takes.
 *
 * ELEMENTWISE MINIMUM, never a maximum and never an overwrite: two rules capping
 * the timeout produce the SMALLER cap, and a rule that declares
 * `allowDestructiveEffects: false` can only ever add that demand. There is no
 * input to this function that can produce a wider state than its input, which is
 * the property the ADR's invariant rests on and the reason the composition is
 * here rather than in each caller's head.
 */
function composeRestrictions(rules: readonly CompiledRule[], deniedCapabilities: string[]): RuleRestrictionComposition {
  let allowedCapabilities: string[] | null = null
  let requireApprovalForDispatch = false
  const approvalCapabilities = new Set<string>()
  let destructive = false
  let external = false
  let allowDestructive = true
  let allowExternal = true
  let maximumTimeoutSeconds: number | null = null
  const unprojected = new Set<string>()

  for (const rule of rules) {
    for (const action of rule.actions) {
      if (action.kind === "require_approval") {
        if (action.requireApprovalForDispatch === true) requireApprovalForDispatch = true
        for (const capability of action.requireApprovalForCapabilities ?? []) approvalCapabilities.add(capability)
        if (action.requireApprovalForDestructiveEffects === true) destructive = true
        if (action.requireApprovalForExternalEffects === true) external = true
      } else if (action.kind === "add_restrictions") {
        if (action.allowedCapabilities !== undefined) {
          allowedCapabilities =
            allowedCapabilities === null ? [...action.allowedCapabilities] : allowedCapabilities.filter((c) => action.allowedCapabilities?.includes(c) === true)
        }
        if (action.maximumTimeoutSeconds !== undefined) {
          maximumTimeoutSeconds =
            maximumTimeoutSeconds === null ? action.maximumTimeoutSeconds : Math.min(maximumTimeoutSeconds, action.maximumTimeoutSeconds)
        }
        if (action.allowDestructiveEffects === false) allowDestructive = false
        if (action.allowExternalEffects === false) allowExternal = false
      }
    }
    for (const member of rule.unprojectedNarrowing) unprojected.add(member)
  }

  return {
    allowedCapabilities: allowedCapabilities === null ? null : allowedCapabilities.sort(compareIds),
    deniedCapabilities,
    requireApprovalForDispatch,
    requireApprovalForCapabilities: [...approvalCapabilities].sort(compareIds),
    requireApprovalForDestructiveEffects: destructive,
    requireApprovalForExternalEffects: external,
    allowDestructiveEffects: allowDestructive,
    allowExternalEffects: allowExternal,
    maximumTimeoutSeconds,
    unprojected: [...unprojected].sort(compareIds),
  }
}

/**
 * Narrows an effective policy state with a rule layer's restriction composition.
 *
 * A THIN ADAPTER over the kernel's own `narrowPolicyState`, not a second
 * implementation of the same algebra. The reason it exists at all is that the
 * M0 `restrict` effect cannot carry `requireApprovalForDispatch` or
 * `requireApprovalForCapabilities` (see `projectToKernelRule`), so the M6 layer
 * has to hand those members somewhere, and the only correct somewhere is the
 * kernel's own narrowing primitive. Using it rather than hand-rolling an
 * intersection means the rule layer cannot diverge from the floor's monotonicity
 * guarantees.
 */
export function narrowWithRuleRestrictions(
  state: EffectivePolicyState,
  restrictions: RuleRestrictionComposition,
): NarrowingOutcome {
  const narrowing = {
    allowedCapabilities: restrictions.allowedCapabilities === null ? undefined : [...restrictions.allowedCapabilities],
    deniedCapabilities: [...restrictions.deniedCapabilities],
    requireApprovalForCapabilities: [...restrictions.requireApprovalForCapabilities],
    requireApprovalForDispatch: restrictions.requireApprovalForDispatch ? true : undefined,
    requireApprovalForDestructiveEffects: restrictions.requireApprovalForDestructiveEffects ? true : undefined,
    requireApprovalForExternalEffects: restrictions.requireApprovalForExternalEffects ? true : undefined,
    allowDestructiveEffects: restrictions.allowDestructiveEffects ? undefined : false,
    allowExternalEffects: restrictions.allowExternalEffects ? undefined : false,
    maximumTimeoutSeconds: restrictions.maximumTimeoutSeconds ?? undefined,
  }
  return narrowPolicyState(state, "rule", narrowing)
}

/** What `evaluateWithKernel` needs, stated structurally so the kernel's input type is not restated here. */
export interface KernelCompositionInput {
  readonly envelope: DispatchEnvelope
  readonly taskTitle?: string
  readonly projectPolicy?: Parameters<typeof evaluatePolicy>[0]["projectPolicy"]
  /**
   * The rule layer's restriction composition, when the caller has one.
   *
   * Present because four members of `require_approval`/`add_restrictions` have no
   * field in the FROZEN M0 `restrict` effect and therefore cannot reach the kernel
   * through `ruleSnapshots` at all. Omitting this argument reproduces the M6.10
   * MED-3 defect: the members are compiled, digested, named in
   * `unprojectedNarrowing`, and then silently discarded. It is optional only so
   * that a caller with no M6 restrictions can pass nothing; a caller WITH
   * restrictions must pass them, or those restrictions do not take effect.
   */
  readonly ruleRestrictions?: RuleRestrictionComposition | null
}

/**
 * Runs the KERNEL's own policy evaluation over a rule set's kernel rules and
 * returns the kernel's verdict, so a caller that wants "would this dispatch be
 * allowed" asks the enforcement point rather than reimplementing it.
 *
 * The kernel is the only thing that decides. This function exists to make the
 * composition ONE CALL rather than a convention: M6 produces the M0 `Rule`, the
 * kernel evaluates it in its own layer order with its own post-narrowing
 * pre-approval re-check, and the answer comes back with the kernel's own
 * explanation tree and decision digest. There is no path by which M6 reports an
 * "allow" the kernel did not.
 *
 * Every supplied kernel rule must be a member of the compiled set, and the check
 * is here rather than assumed: a kernel rule from anywhere else would carry an
 * M6 predicate that was never evaluated for this dispatch, which is precisely the
 * second evaluation path the ADR's first stop condition forbids.
 */
export function evaluateWithKernel(
  input: KernelCompositionInput,
  compiled: CompiledRuleSet,
  kernelRules: readonly Rule[],
): Result<PolicyEvaluation> {
  const rulesByIdentity = new Map(compiled.rules.map((rule) => [`${rule.ruleId}@${rule.templateVersion}`, rule] as const))
  const unknown = kernelRules.find((rule) => !rulesByIdentity.has(`${rule.ruleId}@${rule.templateVersion}`))
  if (unknown !== undefined) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "rule.evaluation_failed",
        `rule.evaluation_failed: kernel rule '${unknown.ruleId}@${unknown.templateVersion}' is not a member of the compiled rule set, so its M6 predicate was never evaluated for this dispatch`,
      ),
    }
  }

  // `ruleRestrictions` is destructured OUT before the spread. `policyEvaluationInputSchema`
  // is `.strict()` with exactly three keys, so spreading the whole `input` carried
  // this M6-only member into the kernel's schema and every call — including one
  // passing `null`, or passing nothing at all — returned
  // `rule.evaluation_failed: Unrecognized key: "ruleRestrictions"`. The narrowing
  // below was therefore unreachable, and `ruleRestrictions` had zero references in
  // `tests/`, which is why a fully green suite did not notice a safety feature that
  // could not run.
  const { ruleRestrictions, ...kernelInput } = input

  try {
    const evaluation = evaluatePolicy({ ...kernelInput, envelope: { ...input.envelope, ruleSnapshots: [...kernelRules] } })
    const validated = policyEvaluationSchema.safeParse(evaluation)
    if (!validated.success) {
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "rule.evaluation_failed",
          `rule.evaluation_failed: the kernel produced a policy evaluation that does not satisfy its own schema: ${validated.error.issues
            .slice(0, 4)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        ),
      }
    }
    // Apply the members the M0 `restrict` effect CANNOT carry.
    //
    // The M6.10 review found this missing, and the shape of the omission was the
    // problem: `requireApprovalForDispatch` and `requireApprovalForCapabilities`
    // have no field in the frozen M0 effect, so they travel in
    // `RuleEvaluationResult.restrictions`, and this function — which exported the
    // adapter that applies them — never called it. Four members of a
    // `require_approval` or `add_restrictions` action therefore compiled, were
    // digested, were named in `unprojectedNarrowing`, and were then SILENTLY
    // DISCARDED. A rule that says "require approval for `net.fetch`" appeared to
    // work and did nothing, which is worse than refusing the action outright.
    //
    // The narrowing runs over the kernel's own effective state and through the
    // kernel's own `narrowPolicyState`, so it is monotone by construction and
    // cannot widen. It runs AFTER the kernel's pre-approval pass on purpose: a
    // demand added here must not be clearable by a pre-approval the kernel already
    // considered, or adding the demand would be free.
    const restrictions = ruleRestrictions ?? null
    if (restrictions === null) return { ok: true, value: validated.data }

    const narrowed = narrowWithRuleRestrictions(validated.data.effective, restrictions)
    const outstanding = [...validated.data.outstandingApprovals]
    for (const capability of narrowed.state.approvalRequiredCapabilities) {
      const demand = `capability:${capability}`
      if (!outstanding.includes(demand)) outstanding.push(demand)
    }
    // A demand added by a RULE is not clearable by a pre-approval, exactly as the
    // kernel already decides for its own layers: `evaluatePolicy`'s pre-approval
    // pass grants only when `onlyFloorDemands`, i.e. when every recorded demand is
    // the floor's own. This used to be guarded by `!preApprovalClearedDefault`,
    // which is the sign FLIPPED — a rule set carrying both a matching `pre_approve`
    // and a matching `require_approval` let the pre-approval suppress the rule's
    // demand, so "adding the demand is free" in the one case where it must not be.
    // The test is whether a layer OTHER THAN the safety floor demanded it.
    const ruleDemandedDispatchApproval = narrowed.state.dispatchApprovalDemands.some((layer) => layer !== "safety_floor")
    if (ruleDemandedDispatchApproval) {
      if (!outstanding.includes("dispatch_approval")) outstanding.push("dispatch_approval")
    }
    outstanding.sort()
    const decision: PolicyDecision = validated.data.denials.length > 0 ? "deny" : outstanding.length === 0 ? "allow" : "require_approval"
    const composed = {
      ...validated.data,
      effective: narrowed.state,
      allowed: decision === "allow",
      decision,
      outstandingApprovals: outstanding,
      effectiveTimeoutSeconds: Math.min(validated.data.declaredTimeoutSeconds, narrowed.state.maximumTimeoutSeconds),
      explanationText: `${validated.data.explanationText}\nM6 rule restrictions applied after the kernel's pre-approval pass: ${
        narrowed.changed ? narrowed.wideningAttempts.length > 0 ? "widening rejected" : "narrowed" : "no change"
      }`,
    }
    // The digest base is built by DESTRUCTURING, not by setting the member to
    // `undefined`. `digestJson` refuses to canonicalize `undefined` — it throws
    // "Canonical JSON cannot encode undefined" — so `{ ...composed,
    // decisionDigest: undefined }` made every rule-restriction composition fail
    // with a thrown contract error. That is the second dead-code bug of MED-3: the
    // first was the strict-spread, and fixing only that would have left the
    // feature just as unreachable.
    //
    // `explanationText` is excluded for the same reason the kernel excludes it at
    // `evaluate.ts:739`: it is a function of everything else, so digesting it
    // digests a derivation of itself.
    const { decisionDigest: _priorDigest, explanationText: _priorText, ...digestBase } = composed
    const recomposed = policyEvaluationSchema.safeParse({
      ...composed,
      decisionDigest: digestJson(digestBase),
    })
    if (!recomposed.success) {
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "rule.evaluation_failed",
          `rule.evaluation_failed: composing rule restrictions produced an evaluation that does not satisfy its own schema: ${recomposed.error.issues
            .slice(0, 4)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        ),
      }
    }
    return { ok: true, value: recomposed.data }
  } catch (error) {
    return {
      ok: false,
      error: createContractError(
        "internal_failure",
        "rule.evaluation_failed",
        `rule.evaluation_failed: kernel composition threw instead of returning a contract error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    }
  }
}

/** Re-exported so a caller can render the kernel's explanation next to the M6 trace. */
export { renderPolicyExplanation }

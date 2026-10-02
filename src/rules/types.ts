/**
 * M6 rule language v2: the schemas, the compiled shapes, and the evaluation
 * result shapes.
 *
 * WHY a new language version rather than a widened `ruleSchema`: ADR 0007
 * section 2. `ruleSchema` sits inside the digest-bound, three-reviewer-attested
 * M0 surface. Spending that attestation on a wider predicate enum would spend it
 * on the least consequential part of this milestone and leave the action
 * vocabulary, the universal-predicate restriction and the reserved literals
 * unreviewed. So the language is separately versioned (`languageVersion: 2`),
 * every type here is a `z.infer` of a schema declared in this file, and the
 * bridge back to the kernel is `CompiledRule.kernelRule` — a `restrict` /
 * `pre_approve` PROJECTION, never a hand-written substitute.
 *
 * THE TWO INVARIANTS THIS FILE EXISTS TO MAKE UNREPRESENTABLE:
 *
 *   1. No rule can widen the safety floor. `allowDestructiveEffects` and
 *      `allowExternalEffects` are `z.literal(false)` in BOTH
 *      `pre_approve_within_bounds` and `add_restrictions`, and absent elsewhere.
 *      A schema-valid document cannot express the escalation at all, so the
 *      refusal path is a test that asserts absence rather than a branch that
 *      asserts handling.
 *
 *   2. `not` cannot fail open. A predicate outcome is `satisfied` or
 *      `unsatisfied` and never a third "unknown" value, and a `not` whose
 *      operand could not be evaluated resolves to `unsatisfied`. The
 *      implementation detail that makes this checkable is an internal
 *      three-valued verdict; the EXPORTED `PredicateOutcome` is two-valued and
 *      carries a separate `unevaluable` flag, so no consumer of a trace can
 *      read an unknown as a match.
 *
 * FAIL-CLOSED COLUMN (ADR 0007 section 6, "Fails closed"). Each row records what
 * "absent" means for the context field that feeds it, because a nullable field
 * without a stated meaning is where fail-open bugs live:
 *
 *   field                       absent means                       outcome
 *   --------------------------  ---------------------------------  --------------
 *   projectId                   never absent                       -
 *   roleId                      the dispatch named no role         unsatisfied
 *   roleVersion                 no role version was named          unsatisfied
 *   requestedCapabilities       the request asks for nothing        any/all unsat.
 *   toolCategories              no categories were named           any/all unsat.
 *   runtimeKind                 the dispatch named no runtime       unsatisfied
 *   targetNodeId                a local dispatch, no target node    unsatisfied
 *   nodeAdvertisedCapabilities  no capability snapshot for node    any/all unsat.
 *   projectPathId               the path is not on the allowlist    unsatisfied
 *   taskLabels                  the task carries no labels          has* unsat.
 *   dependencyOutcomes          the task has no dependencies        all but `none`
 *   requestedFanOut             unknown                             unsatisfied
 *   requestedConcurrency        unknown                             unsatisfied
 *   requestedRetryLimit         unknown                             unsatisfied
 *   declaredTimeoutSeconds      unknown                             unsatisfied
 *   taskTitle                   no title was supplied               unsatisfied
 *   contextManifestSensitivity  no context manifest for the run    any/maxRankAtLeast
 *
 * `none` and `lacks` are the two places where "absent" resolves to SATISFIED,
 * and both are deliberate: each asserts the ABSENCE of something, so an absent
 * subject satisfies the assertion rather than defeating it. Everything else
 * resolves to `unsatisfied`, and an absent context manifest is never treated as
 * rank 0 (ADR 0007 section 6, row 17).
 *
 * NO WALL CLOCK. `Intl` is used only to project an already-supplied instant
 * (`RuleEvaluationContext.evaluatedAt`) into a declared time zone, and
 * `Date.parse` is the only date function used; `Date.now`, `new Date()`,
 * `Math.random`, `process`, the filesystem and the network do not appear in
 * `src/rules/`. `tests/unit/rules/barrel.test.ts` asserts that by source scan.
 */

import { z } from "zod"
import {
  SENSITIVITY_LEVELS,
  SENSITIVITY_RANK,
  sensitivitySchema,
  type Sensitivity,
} from "../memory/ontology.js"
import type { SafePattern } from "../mesh/protocol/safe-pattern.js"
import {
  capabilitySchema,
  digestSchema,
  nodeIdSchema,
  projectIdSchema,
  projectPathIdSchema,
  roleIdSchema,
  ruleIdSchema,
  timestampSchema,
} from "../orchestration/identifiers.js"
import { SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS } from "../orchestration/policy/types.js"
import { actorSchema } from "../orchestration/schemas.js"
import type { Rule } from "../orchestration/types.js"
import {
  MAX_CONCURRENCY,
  MAX_FAN_OUT,
  MAX_RULE_NAME_LENGTH,
  MAX_RULE_NOTE_LENGTH,
  MAX_RULE_REASON_LENGTH,
  MAX_RETRY_LIMIT,
  PARSE_SHAPE_ARRAY_GUARD,
  type RuleLimits,
} from "./limits.js"

// ===========================================================================
// Language version
// ===========================================================================

/**
 * The rule language version this module reads and writes.
 *
 * Separate from the M0 record `schemaVersion` on purpose (ADR 0007 section 2):
 * the M0 domain version is frozen behind a signed attestation and the rule
 * language is not part of that surface. A document at any other language version
 * is refused with `rule.language_version_unsupported` rather than coerced,
 * because a coerced predicate is a predicate nobody wrote.
 */
export const ruleLanguageVersion = 2

export const ruleLanguageVersionSchema = z.literal(ruleLanguageVersion)

export type RuleLanguageVersion = z.infer<typeof ruleLanguageVersionSchema>

// ===========================================================================
// Shared leaf vocabulary
// ===========================================================================

/**
 * A human annotation attached to a predicate. Display-only.
 *
 * Never evaluated, never part of `normalizedPredicate`, and never part of a
 * compiled rule's digest: editing a comment must not change the meaning of a
 * rule and therefore must not invalidate an approval taken against it. Zero
 * length is allowed because "0 to 512 characters" is the ADR's own wording and
 * an empty annotation is not an error.
 */
export const ruleNoteSchema = z.string().max(MAX_RULE_NOTE_LENGTH)

/**
 * The opaque token alphabet shared by capabilities, tool categories, runtime
 * kinds, task labels and node ids.
 *
 * Reused from `capabilitySchema` rather than restated: the M0 capability
 * alphabet is `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, and a second alphabet for
 * "the same kind of identifier" in this module is a second thing that can drift.
 * It also does the untrusted-input work the ADR's "rule code executes nothing"
 * row needs: `=>`, a backtick, a space and a newline are all outside the
 * alphabet, so a rule document carrying them as a predicate value is refused
 * rather than matched, while `process`, `require` and `eval` are legal opaque
 * tokens that match nothing.
 */
export const ruleTokenSchema = capabilitySchema

/** A bounded member list. The real bound is `MAX_ENUMERATED_MEMBERS`, applied by the compiler. */
function memberList<T extends z.ZodType<string>>(member: T): z.ZodArray<T> {
  return z.array(member).max(PARSE_SHAPE_ARRAY_GUARD)
}

/** The budget already in force for a dispatch. */
const ruleEvaluationBudgetSchema = z
  .object({
    maximumFanOut: z.number().int().min(1).max(MAX_FAN_OUT).safe().optional(),
    maximumConcurrency: z.number().int().min(1).max(MAX_CONCURRENCY).safe().optional(),
    maximumRetryLimit: z.number().int().min(0).max(MAX_RETRY_LIMIT).safe().optional(),
    maximumWallClockSeconds: z.number().int().min(1).max(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS).safe().optional(),
    maximumUsageUnits: z.number().int().min(1).safe().optional(),
    usageUnit: z.enum(["tokens", "bytes", "provider_cost_micros"]).optional(),
  })
  .strict()

/** The declared body of a `set_stricter_budget` action. */
const budgetBodySchema = ruleEvaluationBudgetSchema

// ===========================================================================
// Schedule windows (ADR 0007 section 6.2)
// ===========================================================================

/**
 * IANA time zone identifiers this build understands.
 *
 * Validated at PARSE time against `Intl.supportedValuesOf("timeZone")`, so a
 * typo in a zone is a compile error naming the zone rather than a rule that
 * silently never fires. `UTC` is unioned in because it is accepted by
 * `Intl.DateTimeFormat` on every runtime even where a canonical list omits it.
 *
 * The host's local zone is never consulted implicitly (ADR 0007 section 6.2): an
 * implicit local zone makes a rule's meaning depend on the machine that
 * evaluates it, which breaks determinism and makes a dry run on a laptop
 * disagree with the controller.
 */
export const IANA_TIME_ZONES: ReadonlySet<string> = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"])

const ianaTimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => IANA_TIME_ZONES.has(value), {
    message: "Must be an IANA time zone identifier known to Intl.supportedValuesOf('timeZone')",
  })

/** An explicit fixed UTC offset, in minutes. -840..840 is the real range of UTC offsets. */
const fixedOffsetSchema = z
  .object({
    fixedOffsetMinutes: z.number().int().min(-840).max(840),
  })
  .strict()

/**
 * A window's zone, as written.
 *
 * A `string | object` union rather than a discriminated union because the two
 * members have disjoint JSON types, so the union is already unambiguous. The
 * ADR specifies the shape as `string | { fixedOffsetMinutes }` and inventing a
 * tag key would be a second thing to migrate.
 */
export const ruleTimeZoneSchema = z.union([ianaTimeZoneSchema, fixedOffsetSchema])

const dayOfWeekSchema = z.number().int().min(0).max(6)

export const scheduleWindowSchema = z
  .object({
    /** 0 = Sunday .. 6 = Saturday. 1..7 members, unique. */
    daysOfWeek: z.array(dayOfWeekSchema).min(1).max(7).refine((days) => new Set(days).size === days.length, {
      message: "Days of week must be unique",
    }),
    startMinuteOfDay: z.number().int().min(0).max(1_439),
    /** Strictly greater than `startMinuteOfDay`: a wrapping window is refused. */
    endMinuteOfDay: z.number().int().min(0).max(1_439),
    timeZone: ruleTimeZoneSchema,
  })
  .strict()
  .refine((window) => window.endMinuteOfDay > window.startMinuteOfDay, {
    path: ["endMinuteOfDay"],
    message: "A window must not wrap: endMinuteOfDay must be strictly greater than startMinuteOfDay",
  })

export type ScheduleWindow = z.infer<typeof scheduleWindowSchema>

// ===========================================================================
// Predicates (ADR 0007 section 6)
// ===========================================================================

/**
 * Any single field predicate — the eighteen non-combinator arms of
 * `rulePredicateSchema`, as one type.
 *
 * Named and exported because the compiler's vacuity check needs to inspect a
 * field predicate's OPERATOR and VALUE, which a `RulePredicate` union does not
 * expose without narrowing at every access. It is a union of the schema's arms,
 * so adding a nineteenth field predicate is a compile error here rather than a
 * silently-unhandled `field`.
 */
export type FieldPredicate = Exclude<RulePredicate, { readonly field: "all" | "any" | "not" }>

/**
 * The field-predicate names, in ADR table order. `all` / `any` / `not` are the
 * three combinators and are not in this list.
 */
export const RULE_PREDICATE_FIELDS = [
  "projectId",
  "roleId",
  "roleVersion",
  "capability",
  "toolCategory",
  "runtimeKind",
  "targetNodeId",
  "nodeAdvertisedCapability",
  "projectPathId",
  "taskLabel",
  "dependencyOutcome",
  "fanOut",
  "concurrency",
  "retryLimit",
  "timeoutSeconds",
  "scheduleWindow",
  "contextSensitivity",
  "taskTitlePattern",
] as const

/**
 * The fields that make a `pre_approve_within_bounds` or
 * `select_routing_preference` rule non-universal (ADR 0007 section 8).
 *
 * Exactly the ADR's twelve. Note what is NOT here: `fanOut`, `concurrency`,
 * `retryLimit`, `timeoutSeconds` and `scheduleWindow` are absent because they
 * bound the SHAPE of a dispatch rather than its SCOPE, and a pre-approval
 * constrained only by "timeout <= 900" is the match-all pre-approval wearing a
 * hat. `taskTitlePattern` is absent because ADR section 8 names the list
 * exhaustively and a title pattern is not on it.
 *
 * The refusal is a COMPILER pass, not a schema refinement, because a universal
 * rule is a legal document for `deny_with_reason`, `require_approval`,
 * `add_restrictions` and `set_stricter_budget`, and the same predicate list has
 * to compile for those.
 */
export const NON_UNIVERSAL_PREDICATE_FIELDS = [
  "projectId",
  "roleId",
  "roleVersion",
  "capability",
  "toolCategory",
  "runtimeKind",
  "targetNodeId",
  "nodeAdvertisedCapability",
  "projectPathId",
  "taskLabel",
  "dependencyOutcome",
  "contextSensitivity",
] as const

/** Dependency outcomes, as recorded on a task. */
export const dependencyOutcomeValues = ["succeeded", "failed"] as const

export const dependencyOutcomeValueSchema = z.enum(dependencyOutcomeValues)

export type DependencyOutcomeValue = z.infer<typeof dependencyOutcomeValueSchema>

/** Rank to rung name. Derived from `SENSITIVITY_RANK`, never an assumed order. */
export const SENSITIVITY_BY_RANK: readonly Sensitivity[] = Object.freeze(
  [...SENSITIVITY_LEVELS].sort((left, right) => SENSITIVITY_RANK[left] - SENSITIVITY_RANK[right]),
)

/**
 * `pre_approve_within_bounds`' sensitivity ceiling, expressed as a ladder RANK.
 *
 * A rank rather than a name, so the comparison is the canonical `SENSITIVITY_RANK`
 * ordering owned by `src/memory/ontology.ts` and not a second ladder declared
 * here. The normalized form renders the rank back to its rung NAME, which is why
 * the ADR's example reads `contextSensitivity maxRankAtMost restricted`.
 */
const sensitivityRankSchema = z.number().int().min(0).max(SENSITIVITY_BY_RANK.length - 1)

/** The comparison operators every bounded-integer predicate shares. */
const COMPARISON_OPERATORS = ["eq", "lt", "lte", "gt", "gte", "between"] as const

type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number]

const COMPARISON_RENDER: Readonly<Record<ComparisonOperator, string>> = Object.freeze({
  eq: "==",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  between: "between",
})

/** Renders one comparison operator in the canonical normalized form. */
export function comparisonOperatorText(operator: ComparisonOperator): string {
  return COMPARISON_RENDER[operator]
}

/** A `{min,max}` range whose members share the caller's value domain. */
function rangeOf(scalar: z.ZodType<number>): z.ZodType<{ min: number; max: number }> {
  return z.object({ min: scalar, max: scalar }).strict()
}

/**
 * One of the five bounded-integer predicates.
 *
 * `value` is `number | {min,max}` and a `superRefine` binds the two shapes to
 * the operator, because a union discriminated on `field` alone cannot. That
 * refine is what makes `fanOut eq {min:1,max:2}` a compile error rather than a
 * comparison of a number against an object.
 */
function comparisonPredicate<F extends "roleVersion" | "fanOut" | "concurrency" | "retryLimit" | "timeoutSeconds">(
  field: F,
  minimum: number,
  maximum: number,
) {
  const scalar = z.number().int().safe().min(minimum).max(maximum)
  return z
    .object({
      field: z.literal(field),
      operator: z.enum(COMPARISON_OPERATORS),
      value: z.union([scalar, rangeOf(scalar)]),
      note: ruleNoteSchema.optional(),
    })
    .strict()
    .superRefine((predicate, ctx) => {
      const isRange = typeof predicate.value === "object"
      if (predicate.operator === "between" && !isRange) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "'between' requires a {min,max} value" })
      }
      if (predicate.operator !== "between" && isRange) {
        ctx.addIssue({ code: "custom", path: ["value"], message: `'${predicate.operator}' requires a scalar value` })
      }
    })
}

/** One of the identifier-valued predicates: `eq` takes a scalar, `in` takes a list. */
function identifierPredicate<F extends "projectId" | "roleId" | "targetNodeId" | "projectPathId" | "runtimeKind">(
  field: F,
  member: z.ZodType<string>,
) {
  return z
    .object({
      field: z.literal(field),
      operator: z.enum(["eq", "in"]),
      value: z.union([member, memberList(member)]),
      note: ruleNoteSchema.optional(),
    })
    .strict()
    .superRefine((predicate, ctx) => {
      const isList = Array.isArray(predicate.value)
      if (predicate.operator === "in" && !isList) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "'in' requires an array value" })
      }
      if (predicate.operator === "eq" && isList) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "'eq' requires a scalar value" })
      }
    })
}

/** `capability`, `toolCategory` and `nodeAdvertisedCapability`: `any`/`all`/`none` over a list. */
function setPredicate<F extends "capability" | "toolCategory" | "nodeAdvertisedCapability">(field: F) {
  return z
    .object({
      field: z.literal(field),
      operator: z.enum(["any", "all", "none"]),
      value: memberList(ruleTokenSchema),
      note: ruleNoteSchema.optional(),
    })
    .strict()
}

const taskLabelPredicateSchema = z
  .object({
    field: z.literal("taskLabel"),
    operator: z.enum(["has", "hasAny", "hasAll", "lacks"]),
    value: z.union([ruleTokenSchema, memberList(ruleTokenSchema)]),
    note: ruleNoteSchema.optional(),
  })
  .strict()
  .superRefine((predicate, ctx) => {
    const isList = Array.isArray(predicate.value)
    if (predicate.operator === "has" && isList) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "'has' requires a single label" })
    }
    if (predicate.operator !== "has" && !isList) {
      ctx.addIssue({ code: "custom", path: ["value"], message: `'${predicate.operator}' requires an array of labels` })
    }
  })

const dependencyOutcomePredicateSchema = z
  .object({
    field: z.literal("dependencyOutcome"),
    operator: z.enum(["anySucceeded", "anyFailed", "allSucceeded", "allFailed", "none"]),
    note: ruleNoteSchema.optional(),
  })
  .strict()

const scheduleWindowPredicateSchema = z
  .object({
    field: z.literal("scheduleWindow"),
    windows: z.array(scheduleWindowSchema).max(PARSE_SHAPE_ARRAY_GUARD),
    note: ruleNoteSchema.optional(),
  })
  .strict()

const contextSensitivityPredicateSchema = z
  .object({
    field: z.literal("contextSensitivity"),
    operator: z.enum(["any", "none", "maxRankAtMost", "maxRankAtLeast"]),
    value: z.union([z.array(sensitivitySchema).max(SENSITIVITY_LEVELS.length), sensitivityRankSchema]),
    note: ruleNoteSchema.optional(),
  })
  .strict()
  .superRefine((predicate, ctx) => {
    const isRank = typeof predicate.value === "number"
    const wantsRank = predicate.operator === "maxRankAtMost" || predicate.operator === "maxRankAtLeast"
    if (wantsRank && !isRank) {
      ctx.addIssue({ code: "custom", path: ["value"], message: `'${predicate.operator}' requires an integer rank` })
    }
    if (!wantsRank && isRank) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `'${predicate.operator}' requires an array of sensitivity names`,
      })
    }
  })

/**
 * A pattern-valued predicate.
 *
 * This field is NOT one of the seventeen numbered fields in ADR 0007 section 6's
 * table, and it is present anyway because sections 4 and 9 both require a
 * pattern path in the M6 compiler and section 6's table leaves nowhere for one
 * to live: section 4 states two rules about pattern compilation and about a
 * pattern predicate evaluated against a `null` subject, and section 9 lists
 * `MAX_RULE_PATTERN_LENGTH` and `MAX_RULE_PATTERN_NESTING_DEPTH` among the
 * limits the compiler applies. The M0 kernel's `taskTitlePattern` is the
 * existing surface with a `null`-able subject (`RuleMatchContext.taskTitle`),
 * so the M6 field carries the M0 name, its value is compiled by
 * `compileSafePattern`, and it is matched by `matchesBounded` — the only pattern
 * path in the system.
 *
 * The field's own shape is `.min(1)` and nothing else: the length bound is NOT
 * restated here, because `compileSafePattern` is what reports `too_long`, and
 * restating it would turn a `rule.pattern_refused` carrying the analyser's own
 * detail into a generic shape error.
 */
const taskTitlePatternPredicateSchema = z
  .object({
    field: z.literal("taskTitlePattern"),
    pattern: z.string().min(1),
    note: ruleNoteSchema.optional(),
  })
  .strict()

// --- The eighteen field-predicate schemas, each named and each independently inferable ---

export const projectIdPredicateSchema = identifierPredicate("projectId", projectIdSchema)
export const roleIdPredicateSchema = identifierPredicate("roleId", roleIdSchema)
export const roleVersionPredicateSchema = comparisonPredicate("roleVersion", 1, 1_000)
export const capabilityPredicateSchema = setPredicate("capability")
export const toolCategoryPredicateSchema = setPredicate("toolCategory")
export const runtimeKindPredicateSchema = identifierPredicate("runtimeKind", z.string().min(1).max(128))
export const targetNodeIdPredicateSchema = identifierPredicate("targetNodeId", nodeIdSchema)
export const nodeAdvertisedCapabilityPredicateSchema = setPredicate("nodeAdvertisedCapability")
export const projectPathIdPredicateSchema = identifierPredicate("projectPathId", projectPathIdSchema)
export const taskLabelPredicateSchemaExport = taskLabelPredicateSchema
export const dependencyOutcomePredicateSchemaExport = dependencyOutcomePredicateSchema
export const fanOutPredicateSchema = comparisonPredicate("fanOut", 1, MAX_FAN_OUT)
export const concurrencyPredicateSchema = comparisonPredicate("concurrency", 1, MAX_CONCURRENCY)
export const retryLimitPredicateSchema = comparisonPredicate("retryLimit", 0, MAX_RETRY_LIMIT)
export const timeoutSecondsPredicateSchema = comparisonPredicate("timeoutSeconds", 1, SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS)
export const scheduleWindowPredicateSchemaExport = scheduleWindowPredicateSchema
export const contextSensitivityPredicateSchemaExport = contextSensitivityPredicateSchema
export const taskTitlePatternPredicateSchemaExport = taskTitlePatternPredicateSchema

export type ProjectIdPredicate = z.infer<typeof projectIdPredicateSchema>
export type RoleIdPredicate = z.infer<typeof roleIdPredicateSchema>
export type RoleVersionPredicate = z.infer<typeof roleVersionPredicateSchema>
export type CapabilityPredicate = z.infer<typeof capabilityPredicateSchema>
export type ToolCategoryPredicate = z.infer<typeof toolCategoryPredicateSchema>
export type RuntimeKindPredicate = z.infer<typeof runtimeKindPredicateSchema>
export type TargetNodeIdPredicate = z.infer<typeof targetNodeIdPredicateSchema>
export type NodeAdvertisedCapabilityPredicate = z.infer<typeof nodeAdvertisedCapabilityPredicateSchema>
export type ProjectPathIdPredicate = z.infer<typeof projectPathIdPredicateSchema>
export type TaskLabelPredicate = z.infer<typeof taskLabelPredicateSchemaExport>
export type DependencyOutcomePredicate = z.infer<typeof dependencyOutcomePredicateSchemaExport>
export type FanOutPredicate = z.infer<typeof fanOutPredicateSchema>
export type ConcurrencyPredicate = z.infer<typeof concurrencyPredicateSchema>
export type RetryLimitPredicate = z.infer<typeof retryLimitPredicateSchema>
export type TimeoutSecondsPredicate = z.infer<typeof timeoutSecondsPredicateSchema>
export type ScheduleWindowPredicate = z.infer<typeof scheduleWindowPredicateSchemaExport>
export type ContextSensitivityPredicate = z.infer<typeof contextSensitivityPredicateSchemaExport>
export type TaskTitlePatternPredicate = z.infer<typeof taskTitlePatternPredicateSchemaExport>

/** The three combinator arms. The only hand-written members of the union. */
export type AllPredicate = { readonly field: "all"; readonly predicates: readonly RulePredicate[]; readonly note?: string }
export type AnyPredicate = { readonly field: "any"; readonly predicates: readonly RulePredicate[]; readonly note?: string }
export type NotPredicate = { readonly field: "not"; readonly predicate: RulePredicate; readonly note?: string }

/**
 * The predicate union.
 *
 * EIGHTEEN members are `z.infer` of the eighteen named field schemas above; the
 * three combinator arms are written out, because a `z.infer` of a recursive
 * schema is a circular type alias and TypeScript rejects it. That is the same
 * constraint `policyExplanationNodeSchema`
 * (`src/orchestration/policy/types.ts:146`) works under, and the same
 * discipline answers it: the hand-written part is the three arms that recurse,
 * and every arm that does NOT recurse is inferred from its schema.
 *
 * `schema.test.ts` asserts the two agree in both directions — a representative
 * document parses to a value typed as this union, and every member of this union
 * is accepted by the schema — so a drift between them is a test failure rather
 * than a type error nobody sees.
 */
export type RulePredicate =
  | ProjectIdPredicate
  | RoleIdPredicate
  | RoleVersionPredicate
  | CapabilityPredicate
  | ToolCategoryPredicate
  | RuntimeKindPredicate
  | TargetNodeIdPredicate
  | NodeAdvertisedCapabilityPredicate
  | ProjectPathIdPredicate
  | TaskLabelPredicate
  | DependencyOutcomePredicate
  | FanOutPredicate
  | ConcurrencyPredicate
  | RetryLimitPredicate
  | TimeoutSecondsPredicate
  | ScheduleWindowPredicate
  | ContextSensitivityPredicate
  | TaskTitlePatternPredicate
  | AllPredicate
  | AnyPredicate
  | NotPredicate

/**
 * The whole predicate language, as ONE recursive discriminated union on `field`.
 *
 * `z.lazy` for the recursion, following `policyExplanationNodeSchema` rather
 * than inventing a second idiom. The `as unknown as` cast is the price of a
 * discriminated union whose members recurse into the union itself, and it is
 * confined to this one expression.
 */
export const rulePredicateSchema: z.ZodType<RulePredicate> = z.lazy(
  () =>
    z.discriminatedUnion("field", [
      projectIdPredicateSchema,
      roleIdPredicateSchema,
      roleVersionPredicateSchema,
      capabilityPredicateSchema,
      toolCategoryPredicateSchema,
      runtimeKindPredicateSchema,
      targetNodeIdPredicateSchema,
      nodeAdvertisedCapabilityPredicateSchema,
      projectPathIdPredicateSchema,
      taskLabelPredicateSchemaExport,
      dependencyOutcomePredicateSchemaExport,
      fanOutPredicateSchema,
      concurrencyPredicateSchema,
      retryLimitPredicateSchema,
      timeoutSecondsPredicateSchema,
      scheduleWindowPredicateSchemaExport,
      contextSensitivityPredicateSchemaExport,
      taskTitlePatternPredicateSchemaExport,
      z.object({ field: z.literal("all"), predicates: z.array(rulePredicateSchema).max(PARSE_SHAPE_ARRAY_GUARD), note: ruleNoteSchema.optional() }).strict(),
      z.object({ field: z.literal("any"), predicates: z.array(rulePredicateSchema).max(PARSE_SHAPE_ARRAY_GUARD), note: ruleNoteSchema.optional() }).strict(),
      z.object({ field: z.literal("not"), predicate: rulePredicateSchema, note: ruleNoteSchema.optional() }).strict(),
    ]) as unknown as z.ZodType<RulePredicate>,
)

/** The `field` discriminator of a predicate, combinators included. */
export type RulePredicateField = RulePredicate["field"]

/** True for the three combinator members. */
export function isCombinatorPredicate(predicate: RulePredicate): predicate is RulePredicate & {
  field: "all" | "any" | "not"
} {
  return predicate.field === "all" || predicate.field === "any" || predicate.field === "not"
}

/** Every predicate in the tree, in declaration order (depth-first, pre-order). */
export function walkPredicates(predicates: readonly RulePredicate[]): RulePredicate[] {
  const found: RulePredicate[] = []
  const visit = (predicate: RulePredicate): void => {
    found.push(predicate)
    if (predicate.field === "all" || predicate.field === "any") {
      for (const child of predicate.predicates) visit(child)
    } else if (predicate.field === "not") {
      visit(predicate.predicate)
    }
  }
  for (const predicate of predicates) visit(predicate)
  return found
}

// ===========================================================================
// Normalized predicate form (ADR 0007 section 11)
// ===========================================================================

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

function quoted(value: string): string {
  return JSON.stringify(value)
}

/** Sorted and de-duplicated by UTF-16 code unit. Never `localeCompare`. */
export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))
}

function paddedMinutes(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60)
  const minutes = minuteOfDay % 60
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+"
  return `UTC${sign}${paddedMinutes(Math.abs(minutes))}`
}

/**
 * A window in the canonical normalized form: `Mon,Tue,Wed 09:00-17:00 Zone`.
 *
 * Days are rendered as a sorted, comma-joined list of three-letter names rather
 * than as ranges. The ADR's `Mon-Fri 09:00-17:00 America/New_York` is an
 * illustration, and a range-compressed grammar would need a rule for whether
 * `Sat,Sun` is `Sat-Sun` or `Sun-Sat` — a second convention to get wrong, in a
 * form that decides whether a pre-approval is live at 03:00 on a Sunday.
 */
export function normalizeScheduleWindow(window: ScheduleWindow): string {
  const days = [...window.daysOfWeek]
    .sort((left, right) => left - right)
    .map((day) => DAY_NAMES[day])
    .join(",")
  const zone = typeof window.timeZone === "string" ? window.timeZone : offsetText(window.timeZone.fixedOffsetMinutes)
  return `${days} ${paddedMinutes(window.startMinuteOfDay)}-${paddedMinutes(window.endMinuteOfDay)} ${zone}`
}

function renderList(values: readonly string[]): string {
  return `[${sortedUnique(values).map(quoted).join(",")}]`
}

function renderComparison(field: string, operator: ComparisonOperator, value: number | { min: number; max: number }): string {
  if (operator === "between") {
    const range = value as { min: number; max: number }
    return `${field} between ${range.min} and ${range.max}`
  }
  return `${field} ${COMPARISON_RENDER[operator]} ${value as number}`
}

/**
 * The canonical single-line form of ONE predicate (ADR 0007 section 11).
 *
 * "Field name, operator, members sorted by code unit, combinators parenthesized,
 * no whitespace variance." Two deliberate consequences:
 *
 *   - `note` never appears. A note is an annotation, not part of the predicate's
 *     meaning, which is what lets an annotation edit leave a compiled rule's
 *     digest unchanged.
 *   - Combinator CHILDREN keep declaration order. Members of a SET are sorted
 *     because a set has no order to preserve; the children of a conjunction are
 *     ordered by the author, and ADR 0007 section 10.2 makes that order visible
 *     to the user on purpose.
 */
export function normalizePredicateNode(predicate: RulePredicate): string {
  switch (predicate.field) {
    case "all":
      return predicate.predicates.length === 0 ? "all()" : `(${predicate.predicates.map(normalizePredicateNode).join(" and ")})`
    case "any":
      return predicate.predicates.length === 0 ? "any()" : `(${predicate.predicates.map(normalizePredicateNode).join(" or ")})`
    case "not":
      return `(not ${normalizePredicateNode(predicate.predicate)})`
    case "taskTitlePattern":
      return `taskTitlePattern matches ${quoted(predicate.pattern)}`
    case "scheduleWindow":
      return `scheduleWindow in [${sortedUnique(predicate.windows.map(normalizeScheduleWindow)).join(",")}]`
    case "dependencyOutcome":
      return `dependencyOutcome ${predicate.operator}`
    case "capability":
    case "toolCategory":
    case "nodeAdvertisedCapability":
      return `${predicate.field} ${predicate.operator} ${renderList(predicate.value)}`
    case "contextSensitivity":
      return typeof predicate.value === "number"
        ? `contextSensitivity ${predicate.operator} ${SENSITIVITY_BY_RANK[predicate.value]}`
        : `contextSensitivity ${predicate.operator} ${renderList(predicate.value)}`
    case "taskLabel":
      return Array.isArray(predicate.value)
        ? `${predicate.field} ${predicate.operator} ${renderList(predicate.value)}`
        : `${predicate.field} ${predicate.operator} ${quoted(predicate.value)}`
    case "roleVersion":
    case "fanOut":
    case "concurrency":
    case "retryLimit":
    case "timeoutSeconds":
      return renderComparison(predicate.field, predicate.operator, predicate.value)
    case "projectId":
    case "roleId":
    case "targetNodeId":
    case "projectPathId":
    case "runtimeKind":
      return Array.isArray(predicate.value)
        ? `${predicate.field} in ${renderList(predicate.value)}`
        : `${predicate.field} == ${quoted(predicate.value)}`
  }
}

// ===========================================================================
// Actions (ADR 0007 section 7)
// ===========================================================================

/**
 * Action-kind rank order (ADR 0007 section 10.2): restrictive before permissive.
 *
 * The rationale is auditability, not severity: the dispositions a reader must
 * understand before they can judge a grant are computed and recorded first, so
 * the explanation reads "here is what is forbidden, here is what is capped, and
 * therefore here is what was granted".
 */
export const RULE_ACTION_KIND_RANK = Object.freeze({
  deny_with_reason: 0,
  require_approval: 1,
  add_restrictions: 2,
  set_stricter_budget: 3,
  select_routing_preference: 4,
  pre_approve_within_bounds: 5,
} as const)

export const ruleActionKindSchema = z.enum([
  "deny_with_reason",
  "require_approval",
  "add_restrictions",
  "set_stricter_budget",
  "select_routing_preference",
  "pre_approve_within_bounds",
])

export type RuleActionKind = z.infer<typeof ruleActionKindSchema>

/** The rank of an action kind. Total and fixed, so a sort can never be ambiguous. */
export function actionKindRank(kind: RuleActionKind): number {
  return RULE_ACTION_KIND_RANK[kind]
}

const reasonTextSchema = z.string().min(1).max(MAX_RULE_REASON_LENGTH)

const denyWithReasonSchema = z
  .object({
    kind: z.literal("deny_with_reason"),
    reason: reasonTextSchema,
  })
  .strict()

/**
 * A `PermissionNarrowing` subset, field for field. Projects into `kernelRule`
 * as a `restrict` effect, so the M3 engine enforces it with its existing
 * approval accounting and its existing `outstandingApprovals` list.
 */
const requireApprovalSchema = z
  .object({
    kind: z.literal("require_approval"),
    requireApprovalForDispatch: z.boolean().optional(),
    requireApprovalForCapabilities: memberList(ruleTokenSchema).optional(),
    requireApprovalForDestructiveEffects: z.boolean().optional(),
    requireApprovalForExternalEffects: z.boolean().optional(),
  })
  .strict()
  .refine((action) => Object.keys(action).length > 1, {
    message: "require_approval must declare at least one field",
  })

/**
 * A pre-approval, bounded.
 *
 * `allowDestructiveEffects` and `allowExternalEffects` are `z.literal(false)`,
 * not `z.boolean()`: the escalation is UNREPRESENTABLE rather than refused at
 * runtime. The kernel's own re-check remains as defence in depth for the M0
 * `pre_approve` effect, which is still a `z.boolean()`.
 *
 * `maximumSensitivity` is REQUIRED, not optional. The plan's pre-approval
 * disclosure has to show a maximum sensitivity, and a disclosure that renders
 * "no sensitivity bound" for a pre-approval is a disclosure that understates
 * the reach of a grant.
 */
const preApproveWithinBoundsSchema = z
  .object({
    kind: z.literal("pre_approve_within_bounds"),
    approvedCapabilities: memberList(ruleTokenSchema),
    maximumTimeoutSeconds: z.number().int().min(1).max(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS).safe(),
    allowDestructiveEffects: z.literal(false),
    allowExternalEffects: z.literal(false),
    maximumFanOut: z.number().int().min(1).max(MAX_FAN_OUT).safe().optional(),
    maximumConcurrency: z.number().int().min(1).max(MAX_CONCURRENCY).safe().optional(),
    maximumRetryLimit: z.number().int().min(0).max(MAX_RETRY_LIMIT).safe().optional(),
    maximumSensitivity: sensitivitySchema,
  })
  .strict()
  .refine((action) => action.approvedCapabilities.length > 0, {
    path: ["approvedCapabilities"],
    message: "A pre-approval must approve at least one capability",
  })

/**
 * A narrowing, in the same `PermissionNarrowing` subset vocabulary as
 * `require_approval`. The two `z.literal(false)` fields exist so a rule can
 * state "destructive effects stay off here" explicitly; they cannot state the
 * opposite.
 */
const addRestrictionsSchema = z
  .object({
    kind: z.literal("add_restrictions"),
    deniedCapabilities: memberList(ruleTokenSchema).optional(),
    allowedCapabilities: memberList(ruleTokenSchema).optional(),
    maximumTimeoutSeconds: z.number().int().min(1).max(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS).safe().optional(),
    allowDestructiveEffects: z.literal(false).optional(),
    allowExternalEffects: z.literal(false).optional(),
  })
  .strict()
  .refine((action) => Object.keys(action).length > 1, {
    message: "add_restrictions must declare at least one field",
  })

/**
 * A routing PREFERENCE.
 *
 * `preferredNodeIds` is an ordered list, not a score. A numeric weight would be
 * a hidden priority no screen can render as an ordering a user can reason about,
 * and two weights that tie produce an ordering that depends on evaluation order
 * rather than on the rule.
 */
const routingPreferenceBodySchema = z
  .object({
    preferredNodeIds: memberList(ruleTokenSchema).optional(),
    requiredRuntimeKind: z.string().min(1).max(128).optional(),
    requiredProjectPathId: ruleTokenSchema.optional(),
    excludedNodeIds: memberList(ruleTokenSchema).optional(),
  })
  .strict()
  .refine((preference) => Object.keys(preference).length > 0, {
    message: "select_routing_preference must declare at least one preference member",
  })

const selectRoutingPreferenceSchema = z
  .object({
    kind: z.literal("select_routing_preference"),
    preference: routingPreferenceBodySchema,
  })
  .strict()

/**
 * A budget, declared as an elementwise tightening.
 *
 * A declared value GREATER than the effective budget is a widening attempt: it
 * is recorded, refused, and never applied. That is the same monotone discipline
 * `narrowPolicyState` applies to the policy algebra, applied to a different one.
 */
const setStricterBudgetSchema = z
  .object({
    kind: z.literal("set_stricter_budget"),
    budget: budgetBodySchema,
  })
  .strict()
  .refine((action) => Object.keys(action.budget).length > 0, {
    message: "set_stricter_budget must declare at least one budget member",
  })

/** The action vocabulary, discriminated on `kind`. */
export const ruleActionSchema = z.discriminatedUnion("kind", [
  denyWithReasonSchema,
  requireApprovalSchema,
  addRestrictionsSchema,
  setStricterBudgetSchema,
  selectRoutingPreferenceSchema,
  preApproveWithinBoundsSchema,
])

export type RuleAction = z.infer<typeof ruleActionSchema>

/**
 * The declared bounds of a `set_stricter_budget` action, and the shape a caller
 * hands in as `RuleEvaluationContext.currentBudget`. Structurally identical to
 * ADR 0007 section 13.1's `BudgetLimits`, so `src/budgets/` can consume the M6
 * composition without importing this module.
 */
export type RuleBudgetLimits = z.infer<typeof budgetBodySchema>

/** A routing preference, as declared. Consumed by `src/routing/`. */
export type RuleRoutingPreference = z.infer<typeof routingPreferenceBodySchema>

/** The bounds a `pre_approve_within_bounds` action declares. */
export type RulePreApprovalBounds = Pick<
  z.infer<typeof preApproveWithinBoundsSchema>,
  | "approvedCapabilities"
  | "maximumTimeoutSeconds"
  | "maximumFanOut"
  | "maximumConcurrency"
  | "maximumRetryLimit"
  | "maximumSensitivity"
>

/** Actions, in the parse-shape guard. The real bound is `MAX_ACTIONS_PER_RULE`, applied by the compiler. */
const ruleActionsSchema = z.array(ruleActionSchema).max(PARSE_SHAPE_ARRAY_GUARD)

/**
 * Comparator over actions, by action-kind rank.
 *
 * `Array.prototype.sort` is STABLE in every JavaScript engine this repository
 * supports, so sorting with this comparator preserves declaration order WITHIN a
 * kind. That matters for the same reason ADR 0007 section 10.2 gives for
 * predicates: declaration order is part of the normalized form and is therefore
 * visible to the user, and which of two `deny_with_reason` actions is the one
 * whose reason is reported is a function of the document rather than of the sort
 * implementation.
 */
export function compareRuleActionKindsByRank(left: RuleAction, right: RuleAction): number {
  return actionKindRank(left.kind) - actionKindRank(right.kind)
}

// ===========================================================================
// Activation and the authored document
// ===========================================================================

/**
 * Lifecycle state, discriminated so that `activated` cannot be written without
 * the two facts an audit needs: when, and by whom.
 *
 * `draft` carries neither, which makes "this rule was never activated" a value
 * in the artifact rather than a pair of nulls a reader has to interpret.
 */
export const ruleActivationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("draft"), activatedAt: z.null(), activatedBy: z.null() }).strict(),
  z
    .object({
      state: z.literal("activated"),
      activatedAt: timestampSchema,
      activatedBy: actorSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("expired"),
      activatedAt: timestampSchema.nullable(),
      activatedBy: actorSchema.nullable(),
    })
    .strict(),
  z
    .object({
      state: z.literal("revoked"),
      activatedAt: timestampSchema.nullable(),
      activatedBy: actorSchema.nullable(),
    })
    .strict(),
])

export type RuleActivation = z.infer<typeof ruleActivationSchema>

/**
 * A rule as AUTHORED. This is the only shape accepted from outside the module.
 *
 * Strict at every level: an unknown key in a rule document is a compile error
 * with a named code, not a field silently dropped on the floor. A dropped field
 * is the mechanism by which "I wrote `allowDestructiveEffects: true`" and "I
 * wrote nothing" become the same document.
 */
export const ruleSourceDocumentSchema = z
  .object({
    languageVersion: ruleLanguageVersionSchema,
    ruleId: ruleIdSchema,
    templateVersion: z.number().int().positive().safe(),
    projectId: projectIdSchema,
    name: z
      .string()
      .min(1)
      .max(MAX_RULE_NAME_LENGTH)
      .refine((value) => value === value.trim(), { message: "Must not have surrounding whitespace" }),
    description: z.string().min(1).max(MAX_RULE_REASON_LENGTH),
    enabled: z.boolean(),
    activation: ruleActivationSchema,
    predicates: z.array(rulePredicateSchema).max(PARSE_SHAPE_ARRAY_GUARD),
    actions: ruleActionsSchema,
    expiresAt: timestampSchema.nullable(),
    author: actorSchema,
    createdAt: timestampSchema,
  })
  .strict()

export type RuleSourceDocument = z.infer<typeof ruleSourceDocumentSchema>

// ===========================================================================
// Compiled shapes (ADR 0007 section 3)
// ===========================================================================

/**
 * A rule after compilation: normalized, pattern-compiled, projected, digested.
 *
 * `patterns` holds `SafePattern` objects and NEVER raw source, and the compiled
 * rule's digest is computed over the pattern SOURCES rather than over the
 * `SafePattern` values, because a `RegExp` is not plain JSON and canonical JSON
 * refuses to encode one. The raw text survives only on the source document, for
 * the audit record — the same compile-once/keep-raw-for-audit precedent as
 * `src/mesh/protocol/rules.ts`.
 */
export interface CompiledRule {
  readonly ruleId: z.infer<typeof ruleIdSchema>
  readonly templateVersion: number
  readonly projectId: z.infer<typeof projectIdSchema>
  readonly name: string
  readonly description: string
  readonly enabled: boolean
  readonly activation: RuleActivation
  readonly expiresAt: z.infer<typeof timestampSchema> | null
  /** Declared order, preserved: ADR section 10.2 makes it visible to the user. */
  readonly predicates: readonly RulePredicate[]
  /** The canonical single-line form the disclosure shows and the digest covers. */
  readonly normalizedPredicate: string
  /** In action-kind rank order. */
  readonly actions: readonly RuleAction[]
  /** Compiled patterns, never raw source. Empty for a rule with no pattern predicate. */
  readonly patterns: readonly SafePattern[]
  /** The M0 `Rule` projection, or `null` when no action projects into one. */
  readonly kernelRule: Rule | null
  /** The M0 effect field names the M0 `restrict` / `pre_approve` effect cannot carry. */
  readonly unprojectedNarrowing: readonly string[]
  /** The authored document, kept for the audit record only. */
  readonly source: RuleSourceDocument
  readonly digest: z.infer<typeof digestSchema>
}

/** The single representation preview, runtime and simulation all evaluate. */
export interface CompiledRuleSet {
  readonly languageVersion: RuleLanguageVersion
  /** Deep-frozen, in evaluation order: ruleId ascending by code unit, then templateVersion ascending. */
  readonly rules: readonly CompiledRule[]
  /** The section 9 table this set was compiled under. */
  readonly limits: RuleLimits
  readonly digest: z.infer<typeof digestSchema>
}

// ===========================================================================
// Evaluation context
// ===========================================================================

/**
 * The immutable input to evaluation.
 *
 * Every field predicate reads appears here, and every nullable field's "absent"
 * meaning is stated in this module's fail-closed table above, next to the
 * declaration rather than in a comment three files away.
 *
 * `evaluatedAt` IS the injected clock. There is no clock object, no `Date.now`
 * and no `new Date()` anywhere in this module; a schedule window is evaluated
 * by projecting this already-supplied instant into the window's declared zone.
 *
 * `currentBudget` is the budget already in force. It is here because ADR 0007
 * section 7.6 composes `set_stricter_budget` against "the effective budget" and
 * declares a value greater than the effective budget a widening attempt; without
 * the current budget in the input there is nothing to compare against and every
 * contribution would be indistinguishable from the first one. `null` means "no
 * budget in force", under which nothing is a widening attempt.
 */
export const ruleEvaluationContextSchema = z
  .object({
    projectId: projectIdSchema,
    roleId: roleIdSchema.nullable(),
    roleVersion: z.number().int().min(1).max(1_000).nullable(),
    requestedCapabilities: memberList(ruleTokenSchema),
    toolCategories: memberList(ruleTokenSchema),
    runtimeKind: z.string().min(1).max(128).nullable(),
    targetNodeId: nodeIdSchema.nullable(),
    nodeAdvertisedCapabilities: memberList(ruleTokenSchema).nullable(),
    projectPathId: projectPathIdSchema.nullable(),
    taskLabels: memberList(ruleTokenSchema),
    dependencyOutcomes: z.array(dependencyOutcomeValueSchema).max(PARSE_SHAPE_ARRAY_GUARD),
    requestedFanOut: z.number().int().min(1).max(MAX_FAN_OUT).nullable(),
    requestedConcurrency: z.number().int().min(1).max(MAX_CONCURRENCY).nullable(),
    requestedRetryLimit: z.number().int().min(0).max(MAX_RETRY_LIMIT).nullable(),
    declaredTimeoutSeconds: z.number().int().min(1).max(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS).nullable(),
    taskTitle: z.string().min(1).max(256).nullable(),
    evaluatedAt: timestampSchema,
    contextManifestSensitivity: sensitivitySchema.nullable(),
    currentBudget: ruleEvaluationBudgetSchema.nullable(),
  })
  .strict()

export type RuleEvaluationContext = z.infer<typeof ruleEvaluationContextSchema>

// ===========================================================================
// Evaluation result (ADR 0007 sections 10.4, 10.5, 11)
// ===========================================================================

/**
 * Why a rule was or was not applied. Eight distinct values, never collapsed
 * into "not matched": a disabled rule, an unactivated rule, an expired rule, a
 * revoked rule, a superseded version, an out-of-scope project and a genuine
 * predicate miss are seven different facts about a rule, and an audit view that
 * cannot tell them apart is an audit view that cannot answer "why did my rule
 * not fire".
 */
export const ruleMatchOutcomeSchema = z.enum([
  "matched",
  "not_matched",
  "disabled",
  "not_activated",
  "expired",
  "revoked",
  "superseded",
  "project_scope_mismatch",
])

export type RuleMatchOutcome = z.infer<typeof ruleMatchOutcomeSchema>

/** Two-valued by construction. See this module's second invariant. */
export const predicateSatisfactionSchema = z.enum(["satisfied", "unsatisfied"])

export type PredicateSatisfaction = z.infer<typeof predicateSatisfactionSchema>

/**
 * The trace of one predicate.
 *
 * `satisfaction` is two-valued and never a third value. `unevaluable` says
 * whether the reason it is `unsatisfied` is "the context said no" or "the context
 * could not say", which is what lets a reader of a trace tell a genuine mismatch
 * from a missing fact — and what lets `not` fail closed without inventing a
 * `satisfied`-with-caveat.
 */
export interface PredicateOutcome {
  readonly field: RulePredicateField
  readonly operator: string
  readonly normalized: string
  readonly satisfaction: PredicateSatisfaction
  readonly unevaluable: boolean
  readonly reason: string
  /** Present for combinators only; empty for a leaf. */
  readonly children: readonly PredicateOutcome[]
}

/** What happened to one action of one rule. */
export const actionDispositionSchema = z.enum([
  "applied",
  "not_applicable",
  "shadowed",
  "conflict_denied",
  "rejected_widening",
  "bounds_exceeded",
])

export type ActionDisposition = z.infer<typeof actionDispositionSchema>

export interface RuleActionDisposition {
  readonly ruleId: z.infer<typeof ruleIdSchema>
  readonly templateVersion: number
  readonly kind: RuleActionKind
  readonly rank: number
  readonly normalized: string
  readonly disposition: ActionDisposition
  readonly reason: string
  /** The attempted values behind a `rejected_widening` or a `bounds_exceeded`. */
  readonly details: readonly string[]
}

/** Everything one rule did, or why it did nothing. */
export interface RuleEvaluationTrace {
  readonly ruleId: z.infer<typeof ruleIdSchema>
  readonly templateVersion: number
  readonly projectId: z.infer<typeof projectIdSchema>
  readonly matchOutcome: RuleMatchOutcome
  readonly reason: string
  /** Empty unless the rule was actually evaluated. */
  readonly predicateOutcomes: readonly PredicateOutcome[]
  /** In action-kind rank order. Empty unless the rule was actually evaluated. */
  readonly actions: readonly RuleActionDisposition[]
}

/** ADR 0007 section 10.4, one member per row. */
export type RuleConflict =
  | { readonly kind: "deny_overrides_pre_approval"; readonly ruleIds: readonly string[] }
  | { readonly kind: "multiple_deny"; readonly ruleIds: readonly string[] }
  | { readonly kind: "multiple_pre_approval"; readonly grantedBy: string; readonly shadowed: readonly string[] }
  | { readonly kind: "multiple_routing_preference"; readonly ruleIds: readonly string[] }

/** ADR 0007 section 10.5. `shadowed` is only ever reported when PROVEN. */
export const ruleShadowRelationSchema = z.enum(["shadowed", "possible_overlap"])

export type RuleShadowRelation = z.infer<typeof ruleShadowRelationSchema>

export interface RuleShadowing {
  readonly shadowingRuleId: z.infer<typeof ruleIdSchema>
  readonly shadowedRuleId: z.infer<typeof ruleIdSchema>
  readonly relation: RuleShadowRelation
  readonly reason: string
}

/** The composed budget and every rejected widening attempt against it. */
export interface RuleBudgetComposition {
  /** Elementwise `min` of the applied contributions over the current budget. */
  readonly limits: RuleBudgetLimits
  /** Sorted by field name, then by rule sort key. */
  readonly rejectedWidening: readonly {
    readonly ruleId: z.infer<typeof ruleIdSchema>
    readonly field: string
    readonly attempted: number
    readonly current: number
  }[]
}

/** One matched `select_routing_preference`, in rule sort order. */
export interface RuleRoutingContribution {
  readonly ruleId: z.infer<typeof ruleIdSchema>
  readonly preference: RuleRoutingPreference
}

/**
 * The unioned routing preference: the first non-empty `preferredNodeIds` wins
 * the head, later ones extend the tail.
 */
export interface RuleRoutingComposition {
  readonly contributions: readonly RuleRoutingContribution[]
  readonly preferredNodeIds: readonly string[]
  readonly excludedNodeIds: readonly string[]
  readonly requiredRuntimeKind: string | null
  readonly requiredProjectPathId: string | null
}

/** One matched `pre_approve_within_bounds` candidate and whether its declared bounds cover this dispatch. */
export interface RulePreApprovalCandidate {
  readonly ruleId: z.infer<typeof ruleIdSchema>
  readonly templateVersion: number
  readonly bounds: RulePreApprovalBounds
  readonly boundsSatisfied: boolean
  readonly reason: string
}

/**
 * The pre-approval composition.
 *
 * `grantedBy` is the M6-level answer to ADR 0007 section 10.4's "lowest sort key
 * whose bounds are fully satisfied grants". It is NOT the kernel's answer: the
 * kernel re-checks every candidate against the post-narrowing state in its own
 * second pass, and that re-check is what actually grants. This field says which
 * rule the kernel will be asked about first; `blockedBy` names a matched deny
 * when one makes the question moot.
 */
export interface RulePreApprovalComposition {
  readonly candidates: readonly RulePreApprovalCandidate[]
  readonly grantedBy: string | null
  readonly shadowed: readonly string[]
  readonly blockedBy: string | null
}

/**
 * The composed restriction contribution: a `PermissionNarrowing`, shaped to be
 * handed to the kernel's own `narrowPolicyState` rather than applied by a second
 * implementation of the same algebra.
 */
export interface RuleRestrictionComposition {
  readonly allowedCapabilities: readonly string[] | null
  readonly deniedCapabilities: readonly string[]
  readonly requireApprovalForDispatch: boolean
  readonly requireApprovalForCapabilities: readonly string[]
  readonly requireApprovalForDestructiveEffects: boolean
  readonly requireApprovalForExternalEffects: boolean
  readonly allowDestructiveEffects: boolean
  readonly allowExternalEffects: boolean
  readonly maximumTimeoutSeconds: number | null
  /** The members the M0 `restrict` effect cannot carry, named. */
  readonly unprojected: readonly string[]
}

/** The M6 rule layer's contribution to one dispatch. The decision itself belongs to the kernel. */
export interface RuleEvaluationResult {
  readonly languageVersion: RuleLanguageVersion
  readonly projectId: z.infer<typeof projectIdSchema>
  readonly evaluatedAt: z.infer<typeof timestampSchema>
  readonly ruleSetDigest: z.infer<typeof digestSchema>
  /**
   * `digestJson` over everything else on this result, computed the way
   * `evaluatePolicy` computes its own (`src/orchestration/policy/evaluate.ts:707`):
   * over a stable base object that excludes the digest itself and the rendered
   * text. Excluding `explanationText` is deliberate — it is a function of the
   * result, so including it would make the digest cover a derivation of itself.
   */
  readonly decisionDigest: z.infer<typeof digestSchema>
  /** One entry per compiled rule, in evaluation order. */
  readonly traces: readonly RuleEvaluationTrace[]
  readonly conflicts: readonly RuleConflict[]
  readonly shadowing: readonly RuleShadowing[]
  readonly deny: {
    readonly ruleIds: readonly string[]
    /** The reason of the LOWEST sort key, which is the one reported. */
    readonly reason: string
    readonly reasons: readonly { readonly ruleId: string; readonly reason: string }[]
  } | null
  readonly restrictions: RuleRestrictionComposition
  readonly budgets: RuleBudgetComposition
  readonly routing: RuleRoutingComposition
  readonly preApproval: RulePreApprovalComposition | null
  /**
   * The M0 `Rule` projections, DISPATCH-BOUND: one per rule that actually
   * matched this context, in rule sort order.
   *
   * The M0 projection's own `match` is a sound UNDER-approximation of the M6
   * predicate — it can only narrow what the kernel will accept, never widen it —
   * but it is not a substitute for M6 evaluation, because the M0 match shape
   * cannot express twelve of the seventeen fields. This list is therefore
   * dispatch-bound by construction: it is a field of a per-dispatch result, and
   * it is the ONLY sanctioned way to obtain kernel rules from a compiled set. A
   * caller that caches it and reuses it on another dispatch has reintroduced the
   * second evaluation path the ADR's first stop condition forbids; that is a
   * known limitation, recorded in the module docblock of `evaluate.ts`.
   */
  readonly kernelRules: readonly Rule[]
}

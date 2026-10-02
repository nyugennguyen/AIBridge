/**
 * M6 run templates and role packs: the authored document schema, the refusal
 * vocabulary, and the two pure helpers that the repository and the instantiator
 * both depend on.
 *
 * ============================== WHAT THIS MODULE IS ==============================
 *
 * ADR 0007 section 15 says, in one sentence, the whole requirement:
 *
 * > A template is a versioned, parameterized document. Instantiation produces an
 * > immutable snapshot with its own digest, in the same shape and for the same
 * > reason as `RoleRepository.createSnapshot`: editing a template must not mutate
 * > a run or a role that was already created from it. The plan's criterion
 * > "template edits do not mutate instantiated snapshots" is therefore a property
 * > of the snapshot being a separate frozen value with its own digest, not of a
 * > convention about how templates are updated.
 *
 * The last clause is the design constraint, and it is the reason this module
 * exists in the shape it does. If immutability were a convention about how
 * `updateTemplate` writes, then a single careless write path — a mutation of a
 * stored array, a shared sub-object between a template and a snapshot, an
 * `updateTemplate` that returned the same object with a field reassigned — would
 * silently break it, and nothing would fail. So instead:
 *
 *   1. A `RunTemplateSnapshot` is a SEPARATE value built by pure derivation from a
 *      `RunTemplate`. It shares no object with the template it came from.
 *   2. That snapshot is DEEP-fROZEN. Not "frozen at the top level" — every nested
 *      array and record, because `resolvedSteps[0].dependsOn.push(...)` on a
 *      shallow-frozen snapshot succeeds in sloppy mode and is exactly the bug.
 *   3. It carries its own `snapshotDigest`, computed over everything that defines
 *      the run's BEHAVIOUR, and `verifyRunTemplateSnapshotDigest` recomputes it.
 *      A snapshot whose digest does not verify is not a snapshot.
 *
 * `tests/unit/workflows/immutability.test.ts` asserts all three, and the second
 * one is asserted by mutating a NESTED value rather than the top-level object,
 * because the top-level case is the one that passes trivially.
 *
 * ============================== THE FOUR NAMED INVARIANTS ==============================
 *
 * I1. NO CLOCK, NO RANDOMNESS, NO IO. Every time value in this module is either
 *     supplied by the caller or copied from a value the caller supplied. There is
 *     no `Date.now()`, no `new Date()`, no `Math.random()`, no filesystem, no
 *     network. This is asserted by source scan in `barrel.test.ts` rather than
 *     trusted, because a purity claim in a comment cannot fail.
 *
 * I2. ORDERING IS UTF-16 CODE UNIT (`a < b`), NEVER `localeCompare`, AND EVERY
 *     OUTPUT COLLECTION IS SORTED AND DE-DUPLICATED. Two instantiations with the
 *     same inputs must produce the same digest, and a digest is over canonical
 *     JSON — so an array left in author order is a digest that depends on how the
 *     author happened to type the document. ADR 0007 section 10.2 gives the same
 *     reason for the same choice in the rule language.
 *
 * I3. A TEMPLATE CANNOT DECLARE A RUN THAT NEEDS WIDER PERMISSION THAN ITS ROLE
 *     OR THE SAFETY FLOOR ALLOWS. Two mechanisms, both checkable:
 *     `resolvedStepSchema.timeoutSeconds` is capped at
 *     `SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS` by the value schema (so a
 *     well-formed snapshot cannot carry a wider timeout), and
 *     `instantiateTemplate` re-checks both the floor and the per-role capability
 *     containment and refuses with a named code. The schema bound is
 *     representability; the instantiation check is reporting, and it exists
 *     because a template AUTHORED with a too-long timeout is refused with a code
 *     that says what is wrong rather than as an opaque shape error.
 *
 * I4. A PARAMETER NAME IS AN IDENTIFIER, NOT A STRING. `TEMPLATE_IDENTIFIER_PATTERN`
 *     is `/^[a-z][a-z0-9_]{0,63}$/`. Two reasons, both load-bearing: parameter
 *     names are interpolated into normalized display text (the pre-approval
 *     disclosure of ADR 0007 section 11 is built from bound values and their
 *     names), and they are inputs to the snapshot digest. A name containing a
 *     space, a quote, a newline, or a `${` is a quoting bug waiting to happen at
 *     every one of those sites, and the class of bug is "the displayed text says
 *     something different from the digested text". Lowercase-only, because a
 *     case-insensitive name comparison is a second rule nobody wrote down.
 *
 * ============================== DEVIATIONS FROM `RoleRepository` ==============================
 *
 * Stated here because a reviewer comparing the two modules should not have to
 * diff them to find out. The full list is in the handoff; the three that shape
 * this file are:
 *
 *   D1. `shortTextSchema`, `runtimeKindSchema`, `TEXT_MAX` and `TIMEOUT_MAX_SECONDS`
 *      are module-private in `src/orchestration/schemas.ts`, so this file declares
 *      its own bounds as named, documented constants rather than reaching into a
 *      frozen file for magic numbers. Where the kernel DOES export the value
 *      (`SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS`, `capabilitySchema`, `actorSchema`,
 *      `projectPathIdSchema`, `digestSchema`, `timestampSchema`, `schemaVersionSchema`)
 *      it is imported and reused — a second alphabet for "the same kind of token"
 *      is a second thing that can drift, which is the reason
 *      `src/rules/types.ts:148` reuses `capabilitySchema` as its own token schema.
 *
 *   D2. The budget body is declared STRUCTURALLY here and is NOT imported from
 *      `src/rules`. It is field-for-field identical to
 *      `RuleEvaluationResult.budgets.limits`, so `src/budgets/` and the M6
 *      evaluator can consume a template step's budget without this module importing
 *      the rule engine (ADR 0007 section 1 allows `workflows -> rules`, so this is
 *      a choice, not a constraint — see the long note on `templateBudgetLimitsSchema`).
 *
 *   D3. The refusal vocabulary lives in THIS file rather than in whichever file
 *      happens to raise first. Three files in this module refuse
 *      (`repository.ts` for version conflicts, `instantiate.ts` for binding and
 *      graph problems, and the `superRefine` below for authoring problems), and a
 *      code union declared in one of them would make the other two import an error
 *      class to name a type.
 *
 * STOP CONDITIONS FOR THIS MODULE. Implementation halts and returns to ADR 0007 if:
 *
 *   1. A `RunTemplateSnapshot` is found able to change after it has been returned
 *      — i.e. if any object in it is reachable from a live `RunTemplate`.
 *   2. Two instantiations of the same template version with the same inputs are
 *      found able to produce different digests.
 *   3. A `RunTemplateSnapshot` is found able to name a `timeoutSeconds` above
 *      `SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS`, or a capability the named role does
 *      not grant.
 *   4. A template edit is found able to affect an already-created snapshot's
 *      digest, its bound parameters, or its resolved steps.
 */

import { z } from "zod"
import {
  capabilitySchema,
  digestSchema,
  projectIdSchema,
  projectPathIdSchema,
  roleIdSchema,
  schemaVersionSchema,
  timestampSchema,
  type Digest,
  type ProjectId,
  type RoleId,
  type Timestamp,
} from "../orchestration/identifiers.js"
import { createContractError } from "../orchestration/errors.js"
import { SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS } from "../orchestration/policy/types.js"
import { actorSchema } from "../orchestration/schemas.js"
import type { CycleType } from "../orchestration/scheduler/types.js"

// ===========================================================================
// Limits
// ===========================================================================

/**
 * The whole limit table, in one place, each value a named export.
 *
 * These live in `types.ts` rather than in a separate `limits.ts` the way
 * `src/rules/` does, and the reason is size rather than principle: ADR 0007
 * section 9's table has twenty rows spanning four subsystems, and a file per
 * table is worth it there. This module's table is nine rows, all of them value
 * domains on the two schemas declared below, so a `limits.ts` would be a file
 * whose entire content is one export statement. Each value is applied by the
 * schema or the check named beside it, and `schema.test.ts` crosses each one by
 * exactly one and asserts the refusal — plus asserts the value AT the boundary is
 * accepted, because a limit that rejects its own boundary is a different limit
 * from the documented one.
 */

/**
 * Steps in one template.
 *
 * A template is something a person reads before approving a recurring dispatch
 * shape. Sixty-four steps is already more than fits on the screen that would
 * display it, and a template nobody reads is a template nobody audits.
 */
export const MAX_TEMPLATE_STEPS = 64

/** Parameter definitions in one template. Bounds the display of the bound-parameter table. */
export const MAX_TEMPLATE_PARAMETERS = 32

/** Members in one `enum` parameter definition. Reuses ADR 0007 section 9's rationale for `MAX_ENUMERATED_MEMBERS`. */
export const MAX_TEMPLATE_ENUM_VALUES = 64

/** Entries in one step's `labelValues`. A label table is for reading, not for encoding data. */
export const MAX_TEMPLATE_LABEL_VALUES = 32

/** `dependsOn` entries on one step. Bounds the dependency fan-in of a single node. */
export const MAX_TEMPLATE_DEPENDENCIES = 64

/** Capabilities one step may request. Matches the kernel's `ARRAY_MAX` of 128 for capability lists. */
export const MAX_TEMPLATE_STEP_CAPABILITIES = 128

/** Template name length. Matches the kernel's `shortTextSchema`. */
export const MAX_TEMPLATE_NAME_LENGTH = 256

/** Template description length. Matches the kernel's `textSchema`. */
export const MAX_TEMPLATE_DESCRIPTION_LENGTH = 4_096

/** Longest string a `string`/`enum` parameter may carry. Matches `MAX_TEMPLATE_DESCRIPTION_LENGTH`. */
export const MAX_TEMPLATE_PARAMETER_STRING_LENGTH = 4_096

/**
 * The AUTHORING ceiling for a step's `timeoutSeconds`.
 *
 * Deliberately WIDER than `SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS`, and this is
 * the one place in the module where a value the system will refuse is
 * representable. The reason: a template authored with a 24-hour step timeout is a
 * template whose author needs to be told which of three things is wrong — the
 * timeout, the role that grants it, or the parameter they meant to bind. A schema
 * bound at the floor would report all three as one shape error and name none.
 * The floor is applied where it binds: `resolvedStepSchema` caps it, and
 * `instantiateTemplate` refuses with `workflow.timeout_exceeds_safety_floor`.
 *
 * The value is the kernel's own ceiling for a role or rule timeout
 * (`TIMEOUT_MAX_SECONDS`, `src/orchestration/schemas.ts:44`), restated because
 * that constant is module-private.
 */
export const MAX_TEMPLATE_STEP_TIMEOUT_SECONDS = 86_400

/** Fan-out a step budget may declare. Mirrors ADR 0007 section 9's `MAX_FAN_OUT`. */
export const MAX_TEMPLATE_BUDGET_FAN_OUT = 256

/** Concurrency a step budget may declare. Mirrors ADR 0007 section 9's `MAX_CONCURRENCY`. */
export const MAX_TEMPLATE_BUDGET_CONCURRENCY = 256

/** Retry limit a step budget may declare. Mirrors ADR 0007 section 9's `MAX_RETRY_LIMIT`. */
export const MAX_TEMPLATE_BUDGET_RETRY_LIMIT = 16

// ===========================================================================
// Refusal vocabulary
// ===========================================================================

/**
 * Every code this module can refuse with.
 *
 * A union rather than free strings, for the reason recorded at
 * `src/rules/compile.ts:99`: a refusal a caller cannot branch on is a refusal a
 * UI can only show. The distinctions here are the ones that need different words
 * in front of a person — `workflow.unknown_parameter` (a typo, and the template
 * author needs to see WHICH name) is a different problem from
 * `workflow.missing_parameter` (the run cannot start), and
 * `workflow.capability_exceeds_role` is a different problem again, because it is
 * a statement about authority rather than about shape.
 */
export type WorkflowErrorCode =
  /** The document does not satisfy `runTemplateSchema`. */
  | "workflow.invalid_template"
  /** The requested version was reused with different content. */
  | "workflow.version_conflict"
  /** The version was not a positive integer, or skipped a step. */
  | "workflow.invalid_version"
  /** No such template, or no such version of it. */
  | "workflow.template_not_found"
  /** An input named a parameter the template does not declare. */
  | "workflow.unknown_parameter"
  /** A required parameter had no supplied value and no default. */
  | "workflow.missing_parameter"
  /** The supplied value was not of the declared type at all. */
  | "workflow.parameter_type_mismatch"
  /** The supplied value was of the declared type but outside its bounds. */
  | "workflow.parameter_out_of_range"
  /** The supplied value was a string that is not a member of the declared enum. */
  | "workflow.parameter_not_in_enum"
  /** The resolved dependency graph contains a cycle. */
  | "workflow.dependency_cycle"
  /** A `dependsOn` entry named a step the template does not declare. */
  | "workflow.unknown_dependency"
  /** A step's `roleId` did not resolve against the supplied role set. */
  | "workflow.role_not_found"
  /** A step requested a capability its role does not grant. */
  | "workflow.capability_exceeds_role"
  /** A step declared a `timeoutSeconds` above `SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS`. */
  | "workflow.timeout_exceeds_safety_floor"
  /** A step's label binding named a parameter that ended up unbound. */
  | "workflow.label_unbound"

/**
 * The one error type this module throws, and the one every refusal is
 * convertible to.
 *
 * A sibling of `RoleVersionConflictError` and friends: a `code`, a `category`,
 * the identifying fields, and `toContractError()`. The difference is that those
 * three are declared in `repository.ts` because the repository is the only thing
 * that raises them, while this one is shared by three files (deviation D3).
 */
export class WorkflowTemplateError extends Error {
  readonly code: WorkflowErrorCode
  readonly category: "validation" | "conflict"
  readonly templateId: string
  readonly detail: Readonly<Record<string, string>>

  constructor(
    code: WorkflowErrorCode,
    templateId: string,
    message: string,
    options?: { category?: "validation" | "conflict"; detail?: Readonly<Record<string, string>> },
  ) {
    super(message)
    this.name = "WorkflowTemplateError"
    this.code = code
    this.category = options?.category ?? "validation"
    this.templateId = templateId
    this.detail = options?.detail ?? {}
  }

  toContractError(): ReturnType<typeof createContractError> {
    return createContractError(this.category, this.code, this.message.slice(0, 4_096))
  }
}

// ===========================================================================
// Shared vocabulary
// ===========================================================================

/**
 * The identifier alphabet for parameter names and step ids: lowercase, then
 * lowercase/digit/underscore, at most 64 characters.
 *
 * Invariant I4 explains why. It is exported because the refusal messages and the
 * tests both need to state the alphabet rather than describe it.
 */
export const TEMPLATE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/** A parameter name or a step id. See `TEMPLATE_IDENTIFIER_PATTERN`. */
export const templateIdentifierSchema = z.string().regex(TEMPLATE_IDENTIFIER_PATTERN)

/**
 * A run template's identity.
 *
 * Reuses `capabilitySchema` for its alphabet — the kernel's opaque token
 * pattern — rather than declaring a third spelling of "an opaque identifier",
 * for the reason at `src/rules/types.ts:148`. Branded so a `RunTemplateId` and a
 * `Capability` are not interchangeable at a call site even though they share an
 * alphabet.
 */
export const runTemplateIdSchema = capabilitySchema.brand<"RunTemplateId">()

/**
 * A runtime kind, reusing the same opaque token alphabet.
 *
 * `runtimeKindSchema` is module-private in `src/orchestration/schemas.ts`, so
 * this is the reuse route rather than a restatement: it is the identical pattern
 * under a name that says what it is used for here.
 */
export const templateRuntimeKindSchema = capabilitySchema

/** A positive safe integer, for versions. Same shape as the kernel's `positiveSafeIntegerSchema`. */
export const positiveSafeIntegerSchema = z.number().int().positive().safe()

const shortTextSchema = z
  .string()
  .min(1)
  .max(MAX_TEMPLATE_NAME_LENGTH)
  .refine((value) => value === value.trim(), "Must not have surrounding whitespace")

/** The parameter type vocabulary. Declared here, applied by the checks below. */
export const templateParameterTypeSchema = z.enum(["string", "integer", "boolean", "enum", "project_path_id"])

/**
 * A bound parameter value.
 *
 * A union of three JSON primitives and nothing else. There is no object-valued
 * and no array-valued parameter, and that is deliberate: a parameter value
 * reaches the digest, the normalized display text, and the capability request of
 * a dispatch, and a structured value would have to be traversed, canonically
 * encoded, and displayed three times correctly. The cheapest way to keep those
 * three in agreement is for there to be nothing to traverse.
 */
export const templateParameterValueSchema = z.union([z.string(), z.number(), z.boolean()])

export type TemplateParameterValue = z.infer<typeof templateParameterValueSchema>

/** The parameter types whose value is TEXT, and which a label may therefore bind to. */
export const TEXTUAL_PARAMETER_TYPES = ["string", "enum", "project_path_id"] as const

/**
 * A step's declared budget.
 *
 * STRUCTURALLY IDENTICAL to `RuleEvaluationResult["budgets"]["limits"]`
 * (`src/rules/types.ts:1240`) and to ADR 0007 section 13.1's `BudgetLimits`, and
 * deliberately NOT imported from `src/rules`. The reasoning, because this is the
 * one place in the module where a reader could reasonably say "just import it":
 *
 *   1. ADR 0007 section 1 permits `workflows -> rules`, so an import would be
 *      legal. It is still the wrong edge. A template's budget is an INPUT a user
 *      authored; the evaluator's budget output is a COMPOSITION computed from
 *      matched rules. Importing the output shape would make the authored input's
 *      validation depend on the evaluator's module, so an evaluator refactor that
 *      added a field would silently widen what a template may declare.
 *   2. The ceiling constants are restated rather than imported, so the same
 *      drift risk exists in the NUMBERS. They are named here
 *      (`MAX_TEMPLATE_BUDGET_FAN_OUT` and siblings) so a reviewer can see the
 *      mirror in one place, and this docblock names where the originals live.
 *      `src/budgets/` is the module that owns the budget ALGEBRA, and it composes
 *      both shapes; this module owns neither.
 *   3. A budget with no members is refused. `set_stricter_budget` in the rule
 *      language refuses it too (ADR 0007 section 7.6, "at least one member must
 *      be present"), and a budget that declares nothing is a budget a reader
 *      would display as one.
 */
export const templateBudgetLimitsSchema = z
  .object({
    maximumFanOut: z.number().int().min(1).max(MAX_TEMPLATE_BUDGET_FAN_OUT).safe().optional(),
    maximumConcurrency: z.number().int().min(1).max(MAX_TEMPLATE_BUDGET_CONCURRENCY).safe().optional(),
    maximumRetryLimit: z.number().int().min(0).max(MAX_TEMPLATE_BUDGET_RETRY_LIMIT).safe().optional(),
    maximumWallClockSeconds: z.number().int().min(1).max(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS).safe().optional(),
    maximumUsageUnits: z.number().int().min(1).safe().optional(),
    usageUnit: z.enum(["tokens", "bytes", "provider_cost_micros"]).optional(),
  })
  .strict()
  .refine((budget) => Object.keys(budget).length > 0, {
    message: "A step budget must declare at least one member; an empty budget is indistinguishable from no budget",
  })

export type TemplateBudgetLimits = z.infer<typeof templateBudgetLimitsSchema>

// ===========================================================================
// Parameter definitions
// ===========================================================================

/**
 * One declared parameter.
 *
 * The three "present iff" rules below are the reason this is not a bag of
 * optional fields. Every constraint field is meaningful for exactly one or two
 * parameter types, and a constraint that is silently ignored by the type it does
 * not apply to is a constraint the author believes is being enforced:
 *
 *   `enumValues`  present iff `type === "enum"`. An `enumValues` on a `string`
 *                 parameter is a list nobody reads and a constraint nobody
 *                 applies.
 *   `minimum` /
 *   `maximum`     present iff `type === "integer"`. On a `string` they are
 *                 meaningless, and on a `boolean` they would be the language's
 *                 most confusing possible field.
 *   `minLength` /
 *   `maxLength`   present iff `type === "string"`, and absent otherwise. Not on
 *                 an `enum`: the members are already enumerated, so a length
 *                 bound could only be redundant. Not on a `boolean`: a length
 *                 bound on a value with no length is a bound on nothing.
 *
 * `defaultValue`, when present, must itself satisfy the definition's own type and
 * constraints. That is checked here rather than only at instantiation because a
 * default that cannot satisfy its own definition is a document that is wrong on
 * its face, and the author should be told at authoring time rather than the first
 * time somebody omits the parameter.
 */
export const templateParameterDefinitionSchema = z
  .object({
    name: templateIdentifierSchema,
    type: templateParameterTypeSchema,
    required: z.boolean(),
    defaultValue: templateParameterValueSchema.optional(),
    enumValues: z
      .array(z.string().min(1).max(MAX_TEMPLATE_PARAMETER_STRING_LENGTH))
      .max(MAX_TEMPLATE_ENUM_VALUES)
      .readonly()
      .optional(),
    minimum: z.number().int().safe().optional(),
    maximum: z.number().int().safe().optional(),
    minLength: z.number().int().min(0).safe().optional(),
    maxLength: z.number().int().min(0).safe().optional(),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message })
    }

    const isEnum = definition.type === "enum"
    if (isEnum && (definition.enumValues === undefined || definition.enumValues.length === 0)) {
      issue(["enumValues"], "An enum parameter must declare at least one member; an empty enum is unsatisfiable, not permissive")
    }
    if (!isEnum && definition.enumValues !== undefined) {
      issue(["enumValues"], `enumValues applies only to a parameter of type 'enum', not '${definition.type}'`)
    }
    if (definition.enumValues !== undefined) {
      const seen = new Set<string>()
      for (const [index, member] of definition.enumValues.entries()) {
        if (seen.has(member)) issue(["enumValues", index], `Duplicate enum member '${member}'`)
        seen.add(member)
      }
    }

    const isInteger = definition.type === "integer"
    for (const field of ["minimum", "maximum"] as const) {
      if (isInteger && definition[field] === undefined) {
        issue([field], `An integer parameter must declare ${field}`)
      }
      if (!isInteger && definition[field] !== undefined) {
        issue([field], `${field} applies only to a parameter of type 'integer', not '${definition.type}'`)
      }
    }
    if (isInteger && definition.minimum !== undefined && definition.maximum !== undefined && definition.minimum > definition.maximum) {
      issue(["minimum"], `minimum ${definition.minimum} is above maximum ${definition.maximum}`)
    }

    // Length bounds belong to `string` and to nothing else. An `enum` already
    // enumerates its members, so a length bound on one can only ever be
    // redundant, and `project_path_id` is bounded by `projectPathIdSchema`. One
    // constraint field per type keeps each rule memorable and leaves no field
    // whose enforcement depends on reading the type first.
    const isString = definition.type === "string"
    for (const field of ["minLength", "maxLength"] as const) {
      if (isString && definition[field] === undefined) {
        issue([field], `A 'string' parameter must declare ${field}`)
      }
      if (!isString && definition[field] !== undefined) {
        issue([field], `${field} applies only to a parameter of type 'string', not '${definition.type}'`)
      }
      if (definition[field] !== undefined && definition[field] > MAX_TEMPLATE_PARAMETER_STRING_LENGTH) {
        issue([field], `${field} ${definition[field]} exceeds MAX_TEMPLATE_PARAMETER_STRING_LENGTH (${MAX_TEMPLATE_PARAMETER_STRING_LENGTH})`)
      }
    }
    if (
      definition.minLength !== undefined &&
      definition.maxLength !== undefined &&
      definition.minLength > definition.maxLength
    ) {
      issue(["minLength"], `minLength ${definition.minLength} is above maxLength ${definition.maxLength}`)
    }

    if (definition.defaultValue !== undefined) {
      const outcome = checkParameterValue(definition, definition.defaultValue)
      if (!outcome.ok) {
        issue(["defaultValue"], `defaultValue does not satisfy this parameter's own definition: ${outcome.message}`)
      }
    }
  })

export type TemplateParameterDefinition = z.infer<typeof templateParameterDefinitionSchema>

/**
 * Checks one value against one definition, and says precisely which rule it
 * broke.
 *
 * This is the ONLY implementation of "is this value legal for this parameter",
 * and it is used from two places that would otherwise disagree: the
 * `superRefine` above, which checks a declared `defaultValue` at authoring time,
 * and `instantiateTemplate`, which checks a supplied value at run time. Two
 * implementations would mean a default accepted by the authoring check and
 * refused at instantiation, or the reverse — and the second one is a bug that
 * only appears for the parameter somebody happens to leave unbound.
 *
 * The returned codes are the `workflow.parameter_*` family, so a caller can tell
 * a type error from a range error from an enum error without parsing prose.
 */
export function checkParameterValue(
  definition: TemplateParameterDefinition,
  value: unknown,
): { ok: true; value: TemplateParameterValue } | { ok: false; code: WorkflowErrorCode; message: string } {
  const name = definition.name
  const fail = (code: WorkflowErrorCode, message: string): { ok: false; code: WorkflowErrorCode; message: string } => ({
    ok: false,
    code,
    message: `Parameter '${name}': ${message}`,
  })

  switch (definition.type) {
    case "boolean": {
      if (typeof value !== "boolean") {
        return fail("workflow.parameter_type_mismatch", `expected a boolean, received ${describeJsonShape(value)}`)
      }
      return { ok: true, value }
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        return fail("workflow.parameter_type_mismatch", `expected an integer, received ${describeJsonShape(value)}`)
      }
      if (definition.minimum !== undefined && value < definition.minimum) {
        return fail("workflow.parameter_out_of_range", `${value} is below the declared minimum ${definition.minimum}`)
      }
      if (definition.maximum !== undefined && value > definition.maximum) {
        return fail("workflow.parameter_out_of_range", `${value} is above the declared maximum ${definition.maximum}`)
      }
      return { ok: true, value }
    }
    case "enum": {
      if (typeof value !== "string") {
        return fail("workflow.parameter_type_mismatch", `expected an enum member string, received ${describeJsonShape(value)}`)
      }
      if (!(definition.enumValues ?? []).includes(value)) {
        // The offending value is deliberately NOT echoed. It is caller-supplied
        // content that will land in a log and, via `toContractError()`, in a
        // rendered refusal, and the members are named instead — the operator
        // typed the value and knows it. This is ADR 0007 section 12's rule about
        // what may appear in an explanation, applied to a refusal.
        return fail(
          "workflow.parameter_not_in_enum",
          `the supplied value is not one of the declared members [${(definition.enumValues ?? []).join(", ")}]`,
        )
      }
      return { ok: true, value }
    }
    case "project_path_id": {
      if (typeof value !== "string") {
        return fail("workflow.parameter_type_mismatch", `expected a project path id, received ${describeJsonShape(value)}`)
      }
      const parsed = projectPathIdSchema.safeParse(value)
      if (!parsed.success) {
        // ADR 0007 section 6.1: a path predicate references an opaque id, never a
        // filesystem path, a prefix, or a pattern. This is the check that keeps a
        // template parameter from being the place that rule is forgotten.
        return fail(
          "workflow.parameter_type_mismatch",
          "the supplied value is not an opaque project path id; a template parameter of type 'project_path_id' names an allowlisted path identifier and never a filesystem path, a prefix, or a pattern (ADR 0007 section 6.1)",
        )
      }
      return { ok: true, value }
    }
    case "string": {
      if (typeof value !== "string") {
        return fail("workflow.parameter_type_mismatch", `expected a string, received ${describeJsonShape(value)}`)
      }
      if (definition.minLength !== undefined && value.length < definition.minLength) {
        return fail("workflow.parameter_out_of_range", `${value.length} characters is below the declared minLength ${definition.minLength}`)
      }
      if (definition.maxLength !== undefined && value.length > definition.maxLength) {
        return fail("workflow.parameter_out_of_range", `${value.length} characters is above the declared maxLength ${definition.maxLength}`)
      }
      return { ok: true, value }
    }
  }
}

/** A JSON shape description, for a refusal message. Never the value itself. */
function describeJsonShape(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  switch (typeof value) {
    case "undefined":
      return "no value"
    case "string":
      return "a string"
    case "number":
      return Number.isSafeInteger(value) ? "an integer" : "a non-integer number"
    case "boolean":
      return "a boolean"
    case "object":
      return "an object"
    default:
      return typeof value
  }
}

// ===========================================================================
// Steps
// ===========================================================================

/**
 * One step of a template.
 *
 * `labelValues` binds a task label to a PARAMETER BY NAME REFERENCE, not by
 * interpolation. `{ "environment": "target_environment" }` means "this step's
 * `environment` label is the value bound to the parameter named
 * `target_environment`". The alternative — a value containing `${name}` and a
 * substitution pass — is a small expression language, and ADR 0007's non-goals
 * rule out exactly that: "Evaluating JavaScript, shell, or any user-supplied
 * expression" and "No computed values". A name reference is a join, so it has no
 * evaluation step to get wrong, and the value that reaches the digest is the
 * bound value itself.
 *
 * The keys are opaque tokens (`capabilitySchema`) so they are the same kind of
 * identifier a task label already is; the values are parameter names, checked
 * against the template's own `parameterDefinitions` in the `superRefine` on
 * `runTemplateSchema`, and re-checked at instantiation because a label may bind
 * to an OPTIONAL parameter that was left unbound.
 */
export const templateStepSchema = z
  .object({
    stepId: templateIdentifierSchema,
    kind: z.enum(["task", "dispatch"]),
    title: shortTextSchema,
    roleId: roleIdSchema,
    // Every collection in this module is declared `.readonly()`, so the inferred
    // type is `readonly T[]` and a caller holding a `RunTemplate` cannot push onto
    // it. The alternative — mutable arrays plus a convention — is the same class
    // of guarantee this module exists to replace, one level down.
    dependsOn: z.array(templateIdentifierSchema).max(MAX_TEMPLATE_DEPENDENCIES).default([]).readonly(),
    capabilities: z.array(capabilitySchema).max(MAX_TEMPLATE_STEP_CAPABILITIES).default([]).readonly(),
    runtimeKind: templateRuntimeKindSchema,
    timeoutSeconds: z.number().int().min(1).max(MAX_TEMPLATE_STEP_TIMEOUT_SECONDS).safe(),
    // A record cannot be `.max()`-ed in Zod v4, so `MAX_TEMPLATE_LABEL_VALUES` is
    // enforced by a refine on its key count. The alternative — expressing a label
    // table as an array of entries — would be a second shape for the same thing
    // and would make a label read as `[key, value]` at every call site.
    labelValues: z
      .record(capabilitySchema, templateIdentifierSchema)
      .refine((labels) => Object.keys(labels).length <= MAX_TEMPLATE_LABEL_VALUES, {
        message: `A step may declare at most ${MAX_TEMPLATE_LABEL_VALUES} label bindings (MAX_TEMPLATE_LABEL_VALUES)`,
      })
      .default({})
      .readonly(),
    budget: templateBudgetLimitsSchema.optional(),
  })
  .strict()

export type TemplateStep = z.infer<typeof templateStepSchema>

/**
 * A step after its parameters have been bound.
 *
 * Identical to `TemplateStep` except that `labelValues` now carries the BOUND
 * values rather than parameter-name references, and `timeoutSeconds` is capped at
 * `SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS` rather than at the authoring ceiling.
 * That cap is invariant I3 expressed as representability: a document satisfying
 * `resolvedStepSchema` cannot carry a run that needs a wider timeout, whatever
 * built it.
 */
export const resolvedStepSchema = z
  .object({
    stepId: templateIdentifierSchema,
    kind: z.enum(["task", "dispatch"]),
    title: shortTextSchema,
    roleId: roleIdSchema,
    dependsOn: z.array(templateIdentifierSchema).max(MAX_TEMPLATE_DEPENDENCIES).readonly(),
    capabilities: z.array(capabilitySchema).max(MAX_TEMPLATE_STEP_CAPABILITIES).readonly(),
    runtimeKind: templateRuntimeKindSchema,
    timeoutSeconds: z.number().int().min(1).max(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS).safe(),
    labelValues: z.record(capabilitySchema, z.string().max(MAX_TEMPLATE_PARAMETER_STRING_LENGTH)).readonly(),
    budget: templateBudgetLimitsSchema.optional(),
  })
  .strict()

export type ResolvedStep = z.infer<typeof resolvedStepSchema>

// ===========================================================================
// The template
// ===========================================================================

/**
 * A run template, as authored.
 *
 * `ruleSetDigest` is a DIGEST REFERENCE and never raw rules. ADR 0007 section 3
 * makes `CompiledRuleSet` the one representation of rules, and re-parsing rules
 * here would be a second parser whose output could differ from the evaluator's
 * — which is stop condition 1. So a template says "a run starting from this
 * template starts with the rule set whose digest is X", and `src/simulation/`
 * resolves it against a real compiled set and reports when it cannot. `null`
 * means "no declared starting rule set", which is the default-installation shape
 * (ADR 0007 section 18 ships zero enabled rules).
 */
export const runTemplateSchema = z
  .object({
    templateId: runTemplateIdSchema,
    templateVersion: positiveSafeIntegerSchema,
    projectId: projectIdSchema,
    name: shortTextSchema,
    description: z.string().max(MAX_TEMPLATE_DESCRIPTION_LENGTH),
    parameterDefinitions: z.array(templateParameterDefinitionSchema).max(MAX_TEMPLATE_PARAMETERS).readonly(),
    steps: z.array(templateStepSchema).min(1).max(MAX_TEMPLATE_STEPS).readonly(),
    ruleSetDigest: digestSchema.nullable(),
    author: actorSchema,
    createdAt: timestampSchema,
    schemaVersion: schemaVersionSchema,
  })
  .strict()
  .superRefine((template, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message })
    }

    // Parameter names are the key of `boundParameters` and appear in normalized
    // display text, so a duplicate is not a harmless redefinition: it is two
    // documents claiming one name, and which one wins would be array order.
    const definitions = new Map<string, number>()
    for (const [index, definition] of template.parameterDefinitions.entries()) {
      const first = definitions.get(definition.name)
      if (first !== undefined) {
        issue(
          ["parameterDefinitions", index, "name"],
          `Parameter name '${definition.name}' is already declared at index ${first}; two definitions cannot own one name`,
        )
      } else {
        definitions.set(definition.name, index)
      }
    }

    // Step ids are the join key of `dependsOn` and of every cycle report, so a
    // duplicate makes a dependency edge ambiguous in the same way.
    const steps = new Map<string, number>()
    for (const [index, step] of template.steps.entries()) {
      const first = steps.get(step.stepId)
      if (first !== undefined) {
        issue(["steps", index, "stepId"], `Step id '${step.stepId}' is already declared at index ${first}`)
      } else {
        steps.set(step.stepId, index)
      }
    }

    for (const [index, step] of template.steps.entries()) {
      for (const [depIndex, dependency] of step.dependsOn.entries()) {
        if (!steps.has(dependency)) {
          issue(
            ["steps", index, "dependsOn", depIndex],
            `Step '${step.stepId}' depends on '${dependency}', which this template does not declare`,
          )
        }
      }

      for (const [key, parameterName] of Object.entries(step.labelValues)) {
        const definition = template.parameterDefinitions.find((candidate) => candidate.name === parameterName)
        if (definition === undefined) {
          issue(
            ["steps", index, "labelValues", key],
            `Label '${key}' binds to parameter '${parameterName}', which this template does not declare`,
          )
          continue
        }
        if (!isTextualParameterType(definition.type)) {
          issue(
            ["steps", index, "labelValues", key],
            `Label '${key}' binds to parameter '${parameterName}' of type '${definition.type}'; a label is text, so it may only bind to a 'string', 'enum' or 'project_path_id' parameter`,
          )
        }
      }
    }

    // A self-dependency is reported as a `self` cycle rather than as an
    // unknown-dependency, because the author who wrote it needs to be told it is
    // a cycle and not that they misspelled a step id. Existence is checked
    // first, so a typo never reaches the cycle finder.
    const cycle = findStepDependencyCycle(template.steps)
    if (cycle !== null) {
      issue(
        ["steps"],
        `Template dependency cycle: ${cycle.cycle.join(" -> ")} (${cycle.cycleType}); a step graph must be acyclic because a run cannot order two steps that each wait for the other`,
      )
    }
  })

export type RunTemplate = z.infer<typeof runTemplateSchema>

/**
 * The authoring input, which is a `RunTemplate` with the two identity and clock
 * fields the caller supplies rather than the module deriving.
 *
 * A sibling of `RoleTemplateInput`: the repository is the only writer, so it may
 * require `createdAt` and default `templateVersion`, and every other field is
 * already constrained by `runTemplateSchema`. The repository PARSES this, so an
 * untyped caller gets the same named refusals as a typed one.
 */
export interface RunTemplateInput {
  // A template id and a project id are plain `string`s here, and a digest and a
  // timestamp are the branded kernel types. The asymmetry is deliberate: the
  // first two are FREE-FORM for authoring (a caller building a template before
  // it has a project record legitimately has an unvalidated string), while a
  // digest and a timestamp are formats this module does not define and retyping
  // them would mean re-deciding them. `runTemplateSchema` validates all four, so
  // an authoring input that lies about any of them is refused at `createTemplate`
  // rather than stored.
  readonly templateId: string
  readonly templateVersion?: number
  readonly projectId: string
  readonly name: string
  readonly description?: string
  readonly parameterDefinitions?: readonly Readonly<TemplateParameterDefinition>[]
  readonly steps: readonly Readonly<TemplateStep>[]
  readonly ruleSetDigest?: string | null
  readonly author: unknown
  /** Injected. NEVER defaulted to a clock read; there is no clock in this module. */
  readonly createdAt: string
  readonly schemaVersion?: z.infer<typeof schemaVersionSchema>
}

// ===========================================================================
// The snapshot
// ===========================================================================

/**
 * An immutable instantiation of a template.
 *
 * `capturedAt` is present and is DELIBERATELY NOT part of `snapshotDigest`.
 * The digest covers what defines the run's behaviour — which is what an audit
 * asks "is this the same run?" about — and a clock reading is not that. This is
 * the same exclusion as `explanationText` in the M6 rule evaluator's
 * `decisionDigest` (`src/rules/types.ts:1320`): a field that is a function of the
 * rest of the value must not be inside the digest of that value, or the digest
 * would cover a derivation of itself and two identical runs taken at different
 * times would compare unequal.
 */
export const runTemplateSnapshotSchema = z
  .object({
    templateId: runTemplateIdSchema,
    templateVersion: positiveSafeIntegerSchema,
    snapshotDigest: digestSchema,
    /** Keyed by parameter name. Keys are inserted in sorted order (invariant I2). */
    boundParameters: z.record(templateIdentifierSchema, templateParameterValueSchema).readonly(),
    /** Sorted by `stepId` (invariant I2). */
    resolvedSteps: z.array(resolvedStepSchema).min(1).max(MAX_TEMPLATE_STEPS).readonly(),
    capturedAt: timestampSchema,
    ruleSetDigest: digestSchema.nullable(),
  })
  .strict()

export type RunTemplateSnapshot = z.infer<typeof runTemplateSnapshotSchema>

/** A project id, re-exported so a caller of this module need not import `identifiers.js`. */
export type { Digest, ProjectId, RoleId, Timestamp }

/** Which parameter types carry text, and which a label may bind to. */
export function isTextualParameterType(type: z.infer<typeof templateParameterTypeSchema>): boolean {
  return type === "string" || type === "enum" || type === "project_path_id"
}

/**
 * Finds a cycle in a step dependency graph, or reports that there is none.
 *
 * A close, deliberate sibling of the DFS in `src/orchestration/scheduler/dag.ts:131`
 * rather than a call to it, and the reason is worth stating because
 * "why did you not reuse it?" is the right question:
 *
 *   1. `validateDag` takes `DagInput`, whose real cases are `TaskGraphNode[]`,
 *      `Record<string, TaskGraphNode>` and a whole `RunProjectionState`. Its
 *      nodes carry a `state: ProjectionTaskState` and its edges carry a
 *      `failurePolicy`, because it validates a RUN that is being scheduled. A
 *      template step has neither: it is an authored document with no run behind
 *      it yet, which is the whole reason the snapshot is a separate value.
 *   2. Its errors are `SchedulerError` subclasses carrying `scheduler.*` codes
 *      and messages that say "task". Reusing them here would put the code
 *      `scheduler.cycle_detected` on a refusal that happened during TEMPLATE
 *      AUTHORING, before any run or task existed. A code that names the wrong
 *      subsystem is worse than a duplicated twelve lines, because it sends a
 *      reader to the scheduler's audit view for a document that never reached it.
 *
 * What IS reused is the vocabulary: the return type carries the kernel's own
 * `CycleType` union (`self` | `direct` | `indirect`, imported type-only from
 * `src/orchestration/scheduler/types.js`), and the traversal is deterministic in
 * the same way — ids sorted, so a graph has one cycle to report rather than
 * whichever one the map's insertion order reached first.
 *
 * `tests/unit/workflows/instantiate.test.ts` asserts this function's verdicts
 * against `validateDag`'s on the same graphs, which is what keeps the two from
 * drifting.
 */
export function findStepDependencyCycle(
  steps: readonly { readonly stepId: string; readonly dependsOn: readonly string[] }[],
): { cycle: readonly string[]; cycleType: CycleType } | null {
  const ids = steps.map((step) => step.stepId).sort(compareCodeUnits)
  const byId = new Map(steps.map((step) => [step.stepId, step]))
  const idSet = new Set(ids)
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const walk = (current: string, path: readonly string[]): { cycle: readonly string[]; cycleType: CycleType } | null => {
    visiting.add(current)
    const step = byId.get(current)
    const dependencies = step === undefined ? [] : sortedUniqueStrings(step.dependsOn)
    for (const dependency of dependencies) {
      if (!idSet.has(dependency)) continue
      if (visiting.has(dependency)) {
        const start = path.indexOf(dependency)
        const cycle = [...path.slice(start), dependency]
        const cycleType: CycleType =
          cycle.length === 2 && cycle[0] === cycle[1] ? "self" : cycle.length === 3 && cycle[0] === cycle[2] ? "direct" : "indirect"
        return { cycle, cycleType }
      }
      if (!visited.has(dependency)) {
        const found = walk(dependency, [...path, dependency])
        if (found !== null) return found
      }
    }
    visiting.delete(current)
    visited.add(current)
    return null
  }

  for (const id of ids) {
    if (visited.has(id)) continue
    const found = walk(id, [id])
    if (found !== null) return found
  }
  return null
}

// ===========================================================================
// Ordering and freezing
// ===========================================================================

/**
 * UTF-16 code-unit ordering, exported so every ordering in the module goes
 * through one function.
 *
 * Invariant I2. `.sort()` with no comparator sorts by UTF-16 code unit already,
 * but spelling the comparator makes the choice explicit at each call site and
 * makes a future `localeCompare` a visible diff rather than a silent
 * regression.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

/** Sorted and de-duplicated by code unit. The one de-duplicating helper in the module. */
export function sortedUniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits)
}

/**
 * Recursively freezes a value.
 *
 * Same idiom as `deepFreeze` in `src/orchestration/roles/repository.ts:68` and
 * `src/orchestration/policy/floor.ts:13`, written out again because all three
 * copies are module-private. It is written out rather than shared because a
 * shared `deepFreeze` would be a new module under `src/orchestration/`, and ADR
 * 0007 section 1 forbids editing that tree for M6 — the honest form of "reuse" in
 * a milestone that may not add to the frozen surface is to copy an eight-line
 * pure function and say so.
 *
 * Note the early return on an already-frozen value: freezing a DAG that shares
 * a sub-object between two parents would otherwise recurse forever, and the
 * shared `deepFreeze` in `roles/repository.ts` does the same.
 */
export function deepFreezeWorkflow<T>(value: T): T {
  freezeRecursively(value, new Set())
  return value
}

/**
 * The recursion, with the ancestor set explicit.
 *
 * The three existing copies of `deepFreeze` in this repository all guard with
 * `if (Object.isFrozen(value)) return value`, and this one does NOT, because that
 * guard is wrong in the presence of Zod's `.readonly()`. `.readonly()` freezes the
 * containers it produces, so `resolvedSteps` arrives here ALREADY frozen — and
 * the guard would return immediately and never descend into the step objects
 * inside it, which is precisely the level where a shallow freeze leaks. The
 * symptom would be a snapshot whose array cannot be pushed to and whose steps can
 * be rewritten, which is the worst possible shape: it looks frozen at every level
 * a test is most likely to check.
 *
 * So termination is carried by an explicit ANCESTOR set rather than by frozenness.
 * A cyclic value terminates because a value already on the current path is not
 * re-entered; a DAG — the same frozen sub-object reached from two parents, which
 * is what a bound value shared between two steps would be — is traversed once per
 * path, which is correct because freezing it once is enough.
 */
function freezeRecursively<T>(value: T, ancestors: Set<object>): void {
  if (value === null || typeof value !== "object") return
  if (ancestors.has(value)) return
  ancestors.add(value)
  try {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      freezeRecursively((value as Record<string, unknown>)[key], ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

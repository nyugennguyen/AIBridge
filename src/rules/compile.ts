/**
 * The rule compiler: `unknown` in, deep-frozen `CompiledRule` out.
 *
 * WHY compilation exists at all, rather than evaluating the source document
 * directly (ADR 0007 section 3): there is exactly one representation of a rule
 * set, and it is the only input to preview, runtime and simulation. A preview
 * that re-parsed the source would be a second parser, and two parsers drift —
 * that is the ADR's first stop condition. So the compiler is a gate, not an
 * optimisation: by the time a rule set exists, every pattern has been vetted,
 * every member set is sorted, every limit has been applied, and every grant is
 * projected into the M0 shape the kernel already knows how to enforce.
 *
 * THE CHECK ORDER IS DELIBERATE, and each step has its own named code, because
 * "the rule was refused" is not a diagnosis:
 *
 *   1. language version      `rule.language_version_unsupported`
 *   2. schema parse          `rule.invalid_source`
 *   3. predicate shape       `rule.limit_exceeded`   (depth, node count, surface count)
 *   4. per-limit checks      `rule.limit_exceeded`
 *   5. pattern compilation   `rule.pattern_refused`
 *   6. empty-enum refusals   `rule.empty_enum`
 *   7. universal predicate   `rule.universal_pre_approval`
 *   8. project scope         `rule.project_scope_mismatch`
 *   9. canonical byte limit  `rule.limit_exceeded`
 *  10. digest
 *
 * WHY VERSION BEFORE SCHEMA: a document from a future language is not a document
 * with a bad field, and reporting "unrecognized key: languageVersion" for a v3
 * rule tells an author nothing about what to change. WHY PATTERNS AFTER LIMITS:
 * pattern compilation is the most expensive step in the pipeline and there is no
 * point analysing a pattern in a rule that was already over a limit. WHY
 * EMPTY-ENUM BEFORE UNIVERSAL: `any([])` is unsatisfiable by definition, which is
 * a different defect from "this pre-approval constrains nothing", and an author
 * who wrote `any([])` needs to be told that, not told their pre-approval is too
 * broad. WHY DIGEST LAST: the digest covers the normalized form, so it cannot be
 * computed until normalization has happened.
 *
 * STEP 3 IS A SEPARATE STEP FROM STEP 2 AND THAT IS THE POINT. Zod's recursive
 * parse is not stack-safe on adversarial input: a 20,000-deep `not` chain throws
 * `RangeError: Maximum call stack size exceeded` from inside `safeParse`, not a
 * `ZodError`. Measured depth and node count BEFORE handing the document to Zod,
 * iteratively, so the refusal is a contract error with a code instead of a
 * process-level crash. This is the one place where the compiler looks at the
 * raw `unknown` before the schema does, and it looks only at shape.
 *
 * NOTHING IN THIS FILE THROWS for an expected refusal. `compileRule` and
 * `compileRuleSet` return `Result<T>`, because a compiler that throws turns a
 * typo in a rule document into an unhandled rejection somewhere far from the
 * author who made it.
 */

import { canonicalByteLength } from "../mesh/protocol/bounds.js"
import { compileSafePattern, type SafePattern } from "../mesh/protocol/safe-pattern.js"
import { digestJson } from "../orchestration/digest.js"
import { createContractError, type ContractError, type Result } from "../orchestration/errors.js"
import { FROZEN_DOMAIN_SCHEMA_VERSION } from "../orchestration/identifiers.js"
import { ruleSchema } from "../orchestration/schemas.js"
import type { Rule } from "../orchestration/types.js"
import {
  MAX_ACTIONS_PER_RULE,
  MAX_COMBINATOR_NODES_PER_RULE,
  MAX_COMPILED_RULE_SET_CANONICAL_BYTES,
  MAX_ENUMERATED_MEMBERS,
  MAX_LABEL_MEMBERS,
  MAX_PREDICATES_PER_RULE,
  MAX_PREDICATE_DEPTH,
  MAX_RULE_EXPIRY_DAYS,
  MAX_RULES_PER_SET,
  MAX_SCHEDULE_WINDOWS_PER_RULE,
  ruleLimits,
} from "./limits.js"
import {
  NON_UNIVERSAL_PREDICATE_FIELDS,
  actionKindRank,
  normalizePredicateNode,
  ruleLanguageVersion,
  rulePredicateSchema,
  ruleSourceDocumentSchema,
  sortedUnique,
  walkPredicates,
  type CompiledRule,
  type CompiledRuleSet,
  type FieldPredicate,
  type RuleAction,
  type RuleActionKind,
  type RuleActivation,
  type RulePredicate,
  type RuleSourceDocument,
} from "./types.js"

// ===========================================================================
// Error codes
// ===========================================================================

/**
 * Every code the compiler and evaluator can return.
 *
 * Named as a union rather than left as free strings because a refusal that
 * cannot be branched on is a refusal a UI can only show, not act on, and
 * `rule.empty_enum` in particular has to be distinguishable from
 * `rule.universal_pre_approval`: one author wrote an impossible predicate and the
 * other wrote a grant with no scope, and the two need different words.
 */
export type RuleErrorCode =
  | "rule.invalid_source"
  | "rule.limit_exceeded"
  | "rule.pattern_refused"
  | "rule.universal_pre_approval"
  | "rule.empty_enum"
  | "rule.language_version_unsupported"
  | "rule.project_scope_mismatch"
  | "rule.evaluation_failed"
  | "rule.conflicting_action_effects"

function refuse(category: Parameters<typeof createContractError>[0], code: RuleErrorCode, message: string): Result<never> {
  return { ok: false, error: createContractError(category, code, message.slice(0, 4_096)) }
}

// ===========================================================================
// Deep freeze
// ===========================================================================

/**
 * Recursively freezes a compiled value.
 *
 * Same idiom as `deepFreeze` in `src/orchestration/policy/floor.ts`, and the
 * reason it is written out again rather than imported is that the floor's copy
 * is module-private. A compiled rule set is DEEP-frozen because a preview that
 * annotated the artifact with "what matched" would corrupt the runtime
 * evaluation of the same set, and there is nowhere else to put that state
 * (ADR 0007 section 3).
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

// ===========================================================================
// Structural pre-scan
// ===========================================================================

/**
 * Iterative measurement of a raw document's predicate tree, BEFORE Zod sees it.
 *
 * ITERATIVE on purpose: a recursive walk of the very structure that can exhaust
 * the stack would exhaust the stack measuring it. The walk carries an explicit
 * stack, so its memory is bounded by the tree's BREADTH rather than its depth,
 * and a cyclic structure is caught by the node budget rather than by looping.
 *
 * Returns the maximum depth and the node count, or a refusal. The node budget is
 * a hard multiple of the two real limits so that a document cannot be enormous
 * and shallow enough to pass, and so that the number reported on a refusal is
 * the one that actually crossed the limit.
 */
function measureRawPredicates(raw: unknown): { ok: true; nodes: number } | { ok: false; error: ContractError } {
  const nodeBudget = MAX_COMBINATOR_NODES_PER_RULE * 4 + MAX_PREDICATES_PER_RULE + 8
  type Frame = { value: unknown; depth: number }
  const stack: Frame[] = []
  if (Array.isArray(raw)) {
    for (let index = raw.length - 1; index >= 0; index -= 1) stack.push({ value: raw[index], depth: 1 })
  } else if (raw !== null && typeof raw === "object") {
    const predicates = (raw as Record<string, unknown>)["predicates"]
    if (Array.isArray(predicates)) {
      for (let index = predicates.length - 1; index >= 0; index -= 1) stack.push({ value: predicates[index], depth: 1 })
    }
  }

  let nodes = 0
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) break
    nodes += 1
    if (nodes > nodeBudget) {
      return {
        ok: false,
        error: createContractError(
          "validation",
          "rule.limit_exceeded",
          `Predicate structure exceeds ${nodeBudget} nodes before parsing, which is beyond any shape this language accepts (MAX_COMBINATOR_NODES_PER_RULE is ${MAX_COMBINATOR_NODES_PER_RULE}); refused without parsing so that an adversarial nesting cannot exhaust the parser's stack`,
        ),
      }
    }
    if (frame.depth > MAX_PREDICATE_DEPTH) {
      return {
        ok: false,
        error: createContractError(
          "validation",
          "rule.limit_exceeded",
          `Predicate nesting reaches depth ${frame.depth}, over the MAX_PREDICATE_DEPTH of ${MAX_PREDICATE_DEPTH}; refused before parsing so the refusal is a contract error rather than a stack overflow`,
        ),
      }
    }
    if (frame.value === null || typeof frame.value !== "object") continue
    // A bare array counts as a level of nesting even though it is not a predicate.
    // It has to: an array is what Zod recurses through, so `predicates: [[[[…]]]`
    // is exactly as deep to the parser as a `not` chain of the same length, and
    // the point of this scan is to bound the PARSER's recursion, not to classify
    // the author's intent.
    if (Array.isArray(frame.value)) {
      for (let index = frame.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: frame.value[index], depth: frame.depth + 1 })
      }
      continue
    }
    const record = frame.value as Record<string, unknown>
    if (record["field"] === "all" || record["field"] === "any") {
      const children = record["predicates"]
      if (Array.isArray(children)) {
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push({ value: children[index], depth: frame.depth + 1 })
        }
      }
    } else if (record["field"] === "not") {
      stack.push({ value: record["predicate"], depth: frame.depth + 1 })
    }
  }
  return { ok: true, nodes }
}

// ===========================================================================
// Limit checks
// ===========================================================================

/**
 * Every `MAX_*` complexity and format limit in ADR 0007 section 9, as one
 * ordered pass over a PARSED document.
 *
 * Ordered cheapest-first and, within a document, surface-count before
 * member-count, so the refusal a large document gets is about the first thing it
 * got wrong rather than the last.
 */
function checkLimits(document: RuleSourceDocument): Result<true> {
  if (document.predicates.length > MAX_PREDICATES_PER_RULE) {
    return refuse(
      "validation",
      "rule.limit_exceeded",
      `Rule declares ${document.predicates.length} top-level predicates, over the MAX_PREDICATES_PER_RULE of ${MAX_PREDICATES_PER_RULE}`,
    )
  }
  if (document.actions.length > MAX_ACTIONS_PER_RULE) {
    return refuse(
      "validation",
      "rule.limit_exceeded",
      `Rule declares ${document.actions.length} actions, over the MAX_ACTIONS_PER_RULE of ${MAX_ACTIONS_PER_RULE}`,
    )
  }

  const nodes = walkPredicates(document.predicates)
  if (nodes.length > MAX_COMBINATOR_NODES_PER_RULE) {
    return refuse(
      "validation",
      "rule.limit_exceeded",
      `Rule's predicate tree has ${nodes.length} nodes, over the MAX_COMBINATOR_NODES_PER_RULE of ${MAX_COMBINATOR_NODES_PER_RULE}`,
    )
  }

  const labelBound = document.predicates.flatMap((predicate) =>
    predicate.field === "taskLabel" && Array.isArray(predicate.value) ? [predicate.value.length] : [],
  )
  if (labelBound.some((count) => count > MAX_LABEL_MEMBERS)) {
    return refuse(
      "validation",
      "rule.limit_exceeded",
      `A taskLabel set has ${Math.max(...labelBound)} members, over the MAX_LABEL_MEMBERS of ${MAX_LABEL_MEMBERS}`,
    )
  }

  const enumerated = collectEnumeratedSets(document)
  for (const entry of enumerated) {
    if (entry.count > MAX_ENUMERATED_MEMBERS) {
      return refuse(
        "validation",
        "rule.limit_exceeded",
        `Enumerated set '${entry.path}' has ${entry.count} members, over the MAX_ENUMERATED_MEMBERS of ${MAX_ENUMERATED_MEMBERS}`,
      )
    }
  }

  const windowCount = nodes
    .filter((predicate) => predicate.field === "scheduleWindow")
    .reduce((total, predicate) => total + (predicate as { windows: readonly unknown[] }).windows.length, 0)
  if (windowCount > MAX_SCHEDULE_WINDOWS_PER_RULE) {
    return refuse(
      "validation",
      "rule.limit_exceeded",
      `Rule declares ${windowCount} schedule windows, over the MAX_SCHEDULE_WINDOWS_PER_RULE of ${MAX_SCHEDULE_WINDOWS_PER_RULE}`,
    )
  }

  if (document.expiresAt !== null) {
    const created = Date.parse(document.createdAt)
    const expires = Date.parse(document.expiresAt)
    const days = Math.floor((expires - created) / 86_400_000)
    if (days > MAX_RULE_EXPIRY_DAYS) {
      return refuse(
        "validation",
        "rule.limit_exceeded",
        `expiresAt is ${days} days after createdAt, over the MAX_RULE_EXPIRY_DAYS of ${MAX_RULE_EXPIRY_DAYS}; 'no expiry' is expressed as a null expiresAt and is warned about in the disclosure`,
      )
    }
  }

  return { ok: true, value: true }
}

interface EnumeratedSet {
  readonly path: string
  readonly count: number
}

/**
 * Every enumerated member set in a document, in a deterministic order.
 *
 * Collected rather than checked field by field so that ADDING a predicate field
 * with a member set cannot silently ship an unenforced limit: a new field's set
 * is either listed here or it is not bounded, and the compiler's behaviour on
 * it is then a visible omission rather than an invisible one.
 */
function collectEnumeratedSets(document: RuleSourceDocument): EnumeratedSet[] {
  const sets: EnumeratedSet[] = []
  document.predicates.forEach((predicate, index) => {
    const at = `predicates[${index}]`
    switch (predicate.field) {
      case "projectId":
      case "roleId":
      case "targetNodeId":
      case "projectPathId":
      case "runtimeKind":
        if (Array.isArray(predicate.value)) sets.push({ path: `${at}.${predicate.field}`, count: predicate.value.length })
        break
      case "capability":
      case "toolCategory":
      case "nodeAdvertisedCapability":
        sets.push({ path: `${at}.${predicate.field}`, count: predicate.value.length })
        break
      case "contextSensitivity":
        if (Array.isArray(predicate.value)) {
          sets.push({ path: `${at}.contextSensitivity`, count: predicate.value.length })
        }
        break
      case "taskLabel":
        if (Array.isArray(predicate.value)) sets.push({ path: `${at}.taskLabel`, count: predicate.value.length })
        break
      case "all":
      case "any": {
        const childLimit = Math.min(predicate.predicates.length, MAX_COMBINATOR_NODES_PER_RULE + 1)
        if (childLimit > MAX_COMBINATOR_NODES_PER_RULE) {
          sets.push({ path: `${at}.${predicate.field}.predicates`, count: childLimit })
        }
        break
      }
      default:
        break
    }
  })
  document.actions.forEach((action, index) => {
    const at = `actions[${index}]`
    switch (action.kind) {
      case "pre_approve_within_bounds":
        sets.push({ path: `${at}.approvedCapabilities`, count: action.approvedCapabilities.length })
        break
      case "require_approval":
        if (action.requireApprovalForCapabilities !== undefined) {
          sets.push({ path: `${at}.requireApprovalForCapabilities`, count: action.requireApprovalForCapabilities.length })
        }
        break
      case "add_restrictions":
        if (action.deniedCapabilities !== undefined) {
          sets.push({ path: `${at}.deniedCapabilities`, count: action.deniedCapabilities.length })
        }
        if (action.allowedCapabilities !== undefined) {
          sets.push({ path: `${at}.allowedCapabilities`, count: action.allowedCapabilities.length })
        }
        break
      case "select_routing_preference":
        if (action.preference.preferredNodeIds !== undefined) {
          sets.push({ path: `${at}.preferredNodeIds`, count: action.preference.preferredNodeIds.length })
        }
        if (action.preference.excludedNodeIds !== undefined) {
          sets.push({ path: `${at}.excludedNodeIds`, count: action.preference.excludedNodeIds.length })
        }
        break
      default:
        break
    }
  })
  return sets
}

// ===========================================================================
// Pattern compilation
// ===========================================================================

/**
 * Compiles every pattern in a document, or refuses the whole document.
 *
 * REFUSAL RATHER THAN ABSORPTION is the decision here, and it is the one place
 * this module deliberately DIVERGES from the M0 kernel. The kernel's behaviour
 * is that a malformed `taskTitlePattern` never matches
 * (`src/orchestration/policy/evaluate.ts:56-63`), which is safe for a narrowing
 * effect and unsafe to inherit: under the same rule a mistyped pre-approval
 * pattern would silently never pre-approve, and a user debugging that would not
 * be told their rule is broken. So a pattern that fails to compile is a compile
 * error, reported with the bounded analyser's own detail.
 */
function compilePatterns(document: RuleSourceDocument): Result<SafePattern[]> {
  const patterns: SafePattern[] = []
  for (const predicate of walkPredicates(document.predicates)) {
    if (predicate.field !== "taskTitlePattern") continue
    const compiled = compileSafePattern(predicate.pattern)
    if (!compiled.ok) {
      return refuse(
        "policy_denied",
        "rule.pattern_refused",
        `Rule '${document.ruleId}@${document.templateVersion}' carries a taskTitlePattern the bounded analyser refused [${compiled.error.code}]: ${compiled.error.message}`,
      )
    }
    patterns.push(compiled.value)
  }
  return { ok: true, value: patterns }
}

// ===========================================================================
// Empty-enum refusals
// ===========================================================================

/**
 * Refuses predicates that can never be satisfied.
 *
 * ADR 0007 section 8 refuses three shapes — `any([])`, a `scheduleWindow` with
 * no windows, and a `capability any []` with no members — on the grounds that
 * "a rule that matches nothing is indistinguishable from a rule that was never
 * loaded". The same argument covers two shapes the ADR does not enumerate, and
 * they are refused here under the same code for the same reason:
 *
 *   - an EMPTY member set on any `any` / `all` / `none` set predicate. `all []`
 *     and `none []` are vacuously universal, and allowing them next to `any []`
 *     (which is refused) would give a pre-approval two spellings of "constrain
 *     nothing" where one is refused and one is not.
 *   - a `between` whose `min` is greater than its `max`, which is an empty
 *     interval by construction.
 *
 * The schema deliberately does NOT enforce these: enforcing them there would
 * make them `rule.invalid_source`, indistinguishable from a typo, and would put
 * the two policies in two places.
 */
function checkUnsatisfiable(document: RuleSourceDocument): Result<true> {
  for (const predicate of walkPredicates(document.predicates)) {
    // An identifier-valued `in` with no members matches nothing, and an empty
    // member set on a set predicate is vacuous. Both are one shape: an
    // enumeration with nothing in it.
    if (
      (predicate.field === "projectId" ||
        predicate.field === "roleId" ||
        predicate.field === "targetNodeId" ||
        predicate.field === "projectPathId" ||
        predicate.field === "runtimeKind" ||
        // `taskLabel` was MISSING from this list, which the M6.10 revision caught:
        // `taskLabel hasAll []` and `hasAny []` are vacuously satisfied by every
        // labelled dispatch, so they matched everything and cleared the safety
        // floor while naming a label set no author wrote. `has` takes a single
        // label and is a different shape, so it is excluded here.
        (predicate.field === "taskLabel" && predicate.operator !== "has")) &&
      (predicate.operator === "in" ||
        predicate.operator === "hasAny" ||
        predicate.operator === "hasAll") &&
      predicate.value.length === 0
    ) {
      return refuse(
        "validation",
        "rule.empty_enum",
        `Rule '${document.ruleId}@${document.templateVersion}' declares ${predicate.field} in [] with no members, which matches nothing; a rule that matches nothing is indistinguishable from a rule that was never loaded`,
      )
    }
    if (predicate.field === "any" && predicate.predicates.length === 0) {
      return refuse(
        "validation",
        "rule.empty_enum",
        `Rule '${document.ruleId}@${document.templateVersion}' declares any([]), which is unsatisfiable by definition; a rule that matches nothing is indistinguishable from a rule that was never loaded`,
      )
    }
    if (predicate.field === "scheduleWindow" && predicate.windows.length === 0) {
      return refuse(
        "validation",
        "rule.empty_enum",
        `Rule '${document.ruleId}@${document.templateVersion}' declares a scheduleWindow with no windows, which never fires; a rule that matches nothing is indistinguishable from a rule that was never loaded`,
      )
    }
    if (predicate.field === "capability" || predicate.field === "toolCategory" || predicate.field === "nodeAdvertisedCapability") {
      if (predicate.value.length === 0) {
        return refuse(
          "validation",
          "rule.empty_enum",
          `Rule '${document.ruleId}@${document.templateVersion}' declares ${predicate.field} ${predicate.operator} [] with no members, which is vacuous; a rule that constrains nothing in one spelling and something in another is a rule nobody can read`,
        )
      }
    }
    if (
      (predicate.field === "fanOut" ||
        predicate.field === "concurrency" ||
        predicate.field === "retryLimit" ||
        predicate.field === "roleVersion" ||
        predicate.field === "timeoutSeconds") &&
      predicate.operator === "between" &&
      (predicate.value as { min: number; max: number }).min > (predicate.value as { min: number; max: number }).max
    ) {
      return refuse(
        "validation",
        "rule.empty_enum",
        `Rule '${document.ruleId}@${document.templateVersion}' declares ${predicate.field} between ${
          (predicate.value as { min: number; max: number }).min
        } and ${(predicate.value as { min: number; max: number }).max}, an empty interval; a predicate that can never be satisfied is indistinguishable from a typo`,
      )
    }
    if (predicate.field === "contextSensitivity" && Array.isArray(predicate.value) && predicate.value.length === 0) {
      return refuse(
        "validation",
        "rule.empty_enum",
        `Rule '${document.ruleId}@${document.templateVersion}' declares contextSensitivity ${predicate.operator} [] with no members, which is vacuous`,
      )
    }
  }
  return { ok: true, value: true }
}

// ===========================================================================
// Universal-predicate restriction (ADR 0007 section 8)
// ===========================================================================

/** The two action kinds that may not be universal. */
const SCOPE_BOUND_ACTION_KINDS: ReadonlySet<RuleActionKind> = new Set<RuleActionKind>([
  "pre_approve_within_bounds",
  "select_routing_preference",
])

/**
 * Refuses a `pre_approve_within_bounds` or `select_routing_preference` rule
 * that constrains none of ADR section 8's twelve scope fields.
 *
 * A `not` still counts as constraining. `not(projectId eq "p")` is a predicate
 * that cannot be satisfied by every dispatch, so the rule is not universal and
 * the disclosure can state exactly what it excludes. Counting only POSITIVE
 * occurrences would refuse that rule for a reason that does not apply, and a
 * refusal the author cannot understand is a refusal they work around by writing
 * a narrower, less comprehensible rule.
 */
/**
 * The predicate forms that can actually EXCLUDE a dispatch, per axis.
 *
 * "Can exclude" is not "names a field". `roleVersion gte 1` names a scope field
 * and is satisfied by every dispatch the schema admits, because `roleVersion`
 * is bounded `1..1000`. `capability none ["net.fetch"]` names a field and is
 * satisfied by every dispatch that never requests `net.fetch`. Both were
 * accepted by the previous shape of this check, and both let one activated rule
 * clear the safety floor's per-dispatch approval for a whole project — see ADR
 * 0007 section 8, and the `rule.universal_pre_approval` refusal below.
 *
 * So each axis lists only CONSTRUCTIVE forms: an operator that positively names
 * a value from a bounded vocabulary, or a comparison strictly interior to its
 * declared range. Anything else — a vacuous comparison at a domain edge, a
 * `lacks`, a `none`, a bare `not` — is excluded, because a `not` inverts the
 * predicate it wraps and can only ever DISCARD exclusions.
 */
const CONSTRUCTIVE_FORMS: Readonly<Record<ScopeBoundAxis, ReadonlySet<string>>> = Object.freeze({
  // Closed identifier vocabularies: `eq`/`in` name a value, so they exclude
  // every dispatch that names a different one.
  projectId: new Set(["eq", "in"]),
  roleId: new Set(["eq", "in"]),
  projectPathId: new Set(["eq", "in"]),
  runtimeKind: new Set(["eq", "in"]),
  targetNodeId: new Set(["eq", "in"]),
  // Set membership. `any`/`all` exclude a dispatch that omits a named member.
  // `none` is excluded: it names a value's ABSENCE, so a dispatch that never
  // requests the capability satisfies it.
  capability: new Set(["any", "all"]),
  toolCategory: new Set(["any", "all"]),
  nodeAdvertisedCapability: new Set(["any", "all"]),
  // `roleVersion` is bounded 1..1000. A comparison strictly inside that range
  // excludes the endpoints; `gte 1` / `lte 1000` exclude nothing, so the
  // operator alone is not enough and the bounds are inspected as well.
  roleVersion: new Set(["eq", "lt", "gt", "lte", "gte", "between"]),
  // Task labels are free text with no closed vocabulary, so `has`/`hasAny`/
  // `hasAll` name a literal and exclude a dispatch lacking it. `lacks` names
  // an absence and is excluded.
  taskLabel: new Set(["has", "hasAny", "hasAll"]),
  // A dependency outcome is a closed two-value vocabulary.
  dependencyOutcome: new Set(["anySucceeded", "anyFailed", "allSucceeded", "allFailed"]),
  // `contextSensitivity` is a four-rung lattice. Every rank comparison is
  // interior except a comparison pinned to the extremes, which no rung set can
  // exclude; the bounds are inspected as well.
  contextSensitivity: new Set(["any", "maxRankAtMost", "maxRankAtLeast"]),
})

/** The declared range of `roleVersion`, from its own schema. */
const ROLE_VERSION_MINIMUM = 1
const ROLE_VERSION_MAXIMUM = 1_000

/** The four rungs of the context sensitivity lattice, low to high. */
const SENSITIVITY_RANKS = 4

type ScopeBoundAxis = (typeof NON_UNIVERSAL_PREDICATE_FIELDS)[number]

/**
 * Whether one field predicate can exclude at least one dispatch.
 *
 * `eq`/`in` and the membership operators are constructive by construction. The
 * range comparisons need their BOUNDS inspected, because a comparison pinned to
 * an edge of a declared range excludes nothing.
 */
function excludesDispatch(predicate: FieldPredicate): boolean {
  const operator = "operator" in predicate ? predicate.operator : undefined
  if (operator === undefined) return false
  const allowed = CONSTRUCTIVE_FORMS[predicate.field as ScopeBoundAxis]
  if (allowed === undefined || !allowed.has(operator)) return false

  if (predicate.field === "roleVersion") {
    const value = "value" in predicate ? predicate.value : undefined
    if (operator === "between") {
      const range = value as { readonly min?: number; readonly max?: number } | undefined
      // A range touching BOTH declared edges spans the whole domain.
      if (range?.min === undefined || range?.max === undefined) return false
      return !(range.min <= ROLE_VERSION_MINIMUM && range.max >= ROLE_VERSION_MAXIMUM)
    }
    if (typeof value !== "number") return false
    if (operator === "eq") return value > ROLE_VERSION_MINIMUM && value < ROLE_VERSION_MAXIMUM
    if (operator === "lt") return value > ROLE_VERSION_MINIMUM
    if (operator === "gt") return value < ROLE_VERSION_MAXIMUM
    if (operator === "lte") return value < ROLE_VERSION_MAXIMUM
    if (operator === "gte") return value > ROLE_VERSION_MINIMUM
    return false
  }

  if (predicate.field === "contextSensitivity") {
    // `any` names a rung from the closed four-rung lattice, so it excludes every
    // manifest whose sensitivity is a different rung. `none` names an absence and
    // is not in the constructive set above.
    if (operator === "any") return true
    const value = "value" in predicate ? predicate.value : undefined
    if (typeof value !== "number") return false
    // Ranks run 0..SENSITIVITY_RANKS-1. `maxRankAtMost 3` is satisfied by every
    // rung; `maxRankAtLeast 0` likewise.
    if (operator === "maxRankAtMost") return value < SENSITIVITY_RANKS - 1
    if (operator === "maxRankAtLeast") return value > 0
    return false
  }

  return true
}

/**
 * The scope axes this predicate tree constrains, as opposed to merely naming.
 *
 * A `not` contributes NOTHING, which is the correction to the previous version
 * of this pass. That version counted a `not` as constraining on the argument
 * that "`not(projectId eq "p")` is a predicate that cannot be satisfied by every
 * dispatch" — but it cannot be satisfied by the dispatch that names `p`, and in
 * a system with one project every other dispatch satisfies it. Counting it let a
 * rule whose whole predicate is a vacuous `not` clear the safety floor. A `not`
 * can only ever discard exclusions the tree below it established, so the tree
 * below it is what gets inspected, and a rule whose ONLY constraint is a `not`
 * is the match-all pre-approval this release refuses.
 */
/**
 * True when a negation occurs ANYWHERE beneath `predicate`, at any depth.
 *
 * The question is deliberately "does this subtree mention a `not`", not "do this
 * subtree's direct children". A branch like `any(projectId eq p, not projectId eq
 * p)` is a tautology, and so is any disjunction containing one, but the tautology
 * can sit one or two levels below the `any` being judged. Testing only direct
 * children is what let a nested tautology compile as a scope and grant a
 * pre-approval to a role its author never named.
 *
 * **EXPORTED because `collectReach` in `explain.ts` must ask the same question.**
 * That function walks the same predicate tree to build the section 11 disclosure,
 * and for most of this milestone the two walks disagreed: the compiler learned to
 * ignore a vacuous branch while the disclosure kept citing it, so the disclosure
 * asserted a bound the rule did not have. Three defects in a row (F-1, F-3, and the
 * original HIGH-1) came from exactly this split, and two were closed by fixing the
 * compiler and leaving the disclosure alone. There is now ONE question with ONE
 * answer, and both walks ask it. See the `Reach` consistency test in
 * `tests/unit/rules/explain.test.ts` for the assertion that keeps them agreeing.
 */
export function subtreeContainsNegation(predicate: RulePredicate): boolean {
  if (predicate.field === "not") return true
  if (predicate.field === "all" || predicate.field === "any") return predicate.predicates.some(subtreeContainsNegation)
  return false
}

function constrainingScopeAxes(predicates: readonly RulePredicate[]): readonly ScopeBoundAxis[] {
  const found = new Set<ScopeBoundAxis>()
  for (const predicate of predicates) {
    if (predicate.field === "all") {
      for (const nested of constrainingScopeAxes(predicate.predicates)) found.add(nested)
      continue
    }
    if (predicate.field === "any") {
      // An `any` branch is a DISJUNCTION, and a disjunction is only as constraining
      // as its most constraining arm. Counting every arm therefore over-reports:
      // `any(projectId eq "p", not projectId eq "p")` is a TAUTOLOGY — one arm holds
      // for every dispatch — and the previous version counted the positive arm and
      // skipped the `not`, declaring the rule scoped. It then cleared the safety
      // floor's approval while the DISCLOSURE reported a one-project reach, citing
      // the very atom whose negation is its sibling.
      //
      // A `not` arm makes the whole DISJUNCTION unusable as a scope, not merely
      // unused. `any(A, not A)` is a tautology — the two arms are complementary, so
      // the branch holds for every dispatch — and dropping the `not` and counting
      // `A` is precisely the bug: it declared the rule scoped while the disclosure
      // reported a one-project reach citing the atom whose negation is its sibling.
      //
      // The general case needs no complement reasoning. A disjunction containing a
      // negation cannot be stated as a reachable SET on any axis, which is the same
      // reason `not` alone is refused: the ADR section 11 disclosure would have to
      // render `unknown` for a rule whose whole purpose is to scope. So the branch
      // contributes nothing, and the enclosing `all` decides whether some OTHER
      // arm scopes the rule. Fail-closed, and consistent with the `not` rule rather
      // than a second special case for `any(A, not A)`.
      //
      // The negation test reads the WHOLE SUBTREE, not the direct children. That
      // distinction was a live fail-open grant: with only the direct children
      // inspected, `any(roleId eq r, any(projectId eq p, not projectId eq p))` — a
      // tautology, because the inner arm is a disjunction with a negation — was
      // accepted as scoped. It then approved dispatches for a role the author
      // never named, verified end to end:
      //
      //   role=role-1 project=proj-1 (the role the author wrote) -> allow
      //   role=role-9 project=proj-1 (a role NEVER named)        -> allow
      //
      // while the disclosure reported `roles: ["role-1"]`. The one-level check
      // looked correct because the reviewer's own boundary case, `any(all(A, not A))`,
      // is fail-closed for an unrelated reason — that arm is unsatisfiable, so it
      // matches nothing. This shape is SATISFIABLE, because the arm is a tautology,
      // so it fires. Same syntactic gap, opposite safety consequence.
      if (subtreeContainsNegation(predicate)) continue
      // The arms' axes are UNIONED — but only when they are the SAME axis.
      //
      // A same-axis disjunction is a genuine set operation and the disclosure
      // renders it correctly: `any(projectId eq "p", projectId eq "q")` discloses
      // `reach.projects = ["p", "q"]`, which is the true union.
      //
      // A CROSS-axis disjunction is not a set operation at all, and cannot be
      // rendered as the per-axis PRODUCT the section 11 disclosure is required to
      // produce. `any(roleId eq "role-1", targetNodeId eq "node-1")` matches every
      // dispatch that is on `role-1` OR on `node-1`, but the disclosure reported
      // `reach.roles = ["role-1"]` and `reach.nodes = ["node-1"]` — which reads as
      // the AND, a far smaller set. The rule then fired where the disclosure says it
      // does not, and the kernel returned `allow` with no outstanding approvals:
      //
      //   role=role-1 node=node-1 -> allow
      //   role=role-9 node=node-1 -> allow   <-- role-9 was never named
      //
      // This is the same grant the negation rule above exists to prevent, reached
      // with no negation at all. Only `projectId` is independently gated downstream
      // (`classifyRule` refuses a foreign project), so on roles, nodes and paths the
      // over-report is a real grant; a fuzz over axis pairs found 21 of 56 granting
      // wider than disclosed.
      //
      // So a cross-axis disjunction contributes nothing. That is not conservatism
      // here — it is the same rule as the negation case, for the same reason: the
      // disclosure cannot state the reach, so a rule that relies on it cannot be
      // scoped. `constrainingScopeAxes` asks "can the disclosure render this", and
      // the honest answer for a cross-axis `any` is no. A previous revision of this
      // comment argued the opposite and pinned
      // `any(projectId eq "p", roleId eq "r")` as a CONTROL that must compile; that
      // shape is an instance of this defect, and the control was wrong.
      const armAxes = predicate.predicates.map((nested) => constrainingScopeAxes([nested]))
      const distinct = [...new Set(armAxes.map((axes) => axes.join(",")))]
      if (distinct.length !== 1) continue
      for (const axis of armAxes[0] ?? []) found.add(axis)
      continue
    }
    if (predicate.field === "not") continue
    if (excludesDispatch(predicate as FieldPredicate)) found.add(predicate.field as ScopeBoundAxis)
  }
  return [...found].sort()
}

function checkNotUniversal(document: RuleSourceDocument): Result<true> {
  const scopeBearing = document.actions.filter((action) => SCOPE_BOUND_ACTION_KINDS.has(action.kind))
  if (scopeBearing.length === 0) return { ok: true, value: true }

  const constraining = constrainingScopeAxes(document.predicates)
  if (constraining.length > 0) return { ok: true, value: true }

  const kinds = sortedUnique(scopeBearing.map((action) => action.kind))
  return refuse(
    "policy_denied",
    "rule.universal_pre_approval",
    `Rule '${document.ruleId}@${document.templateVersion}' carries ${kinds.join(" and ")} but constrains none of [${NON_UNIVERSAL_PREDICATE_FIELDS.join(", ")}], so it applies to every dispatch. A pre-approval that constrains nothing is the shape this release refuses; scope it to at least one of those fields, or express the concern as a restriction, which is permitted to be universal.`,
  )
}

// ===========================================================================
// Action normalisation and the M0 projection
// ===========================================================================

/** Actions in action-kind rank order, stable within a kind (ADR 0007 section 10.2). */
function sortActions(actions: readonly RuleAction[]): RuleAction[] {
  return actions
    .map((action, index) => ({ action, index }))
    .sort((left, right) => {
      const byRank = actionKindRank(left.action.kind) - actionKindRank(right.action.kind)
      return byRank === 0 ? left.index - right.index : byRank
    })
    .map((entry) => entry.action)
}

/**
 * Canonical text for one action, used in traces and disclosures.
 *
 * Members sorted by code unit so that two documents differing only in member
 * ORDER produce the same text — the same reason `normalizedPredicate` sorts
 * members, and the same reason it does not sort children.
 */
export function normalizeAction(action: RuleAction): string {
  switch (action.kind) {
    case "deny_with_reason":
      return `deny_with_reason(${JSON.stringify(action.reason)})`
    case "require_approval": {
      const parts: string[] = []
      if (action.requireApprovalForDispatch !== undefined) parts.push(`requireApprovalForDispatch=${action.requireApprovalForDispatch}`)
      if (action.requireApprovalForCapabilities !== undefined) {
        parts.push(`requireApprovalForCapabilities=${JSON.stringify(sortedUnique(action.requireApprovalForCapabilities))}`)
      }
      if (action.requireApprovalForDestructiveEffects !== undefined) {
        parts.push(`requireApprovalForDestructiveEffects=${action.requireApprovalForDestructiveEffects}`)
      }
      if (action.requireApprovalForExternalEffects !== undefined) {
        parts.push(`requireApprovalForExternalEffects=${action.requireApprovalForExternalEffects}`)
      }
      return `require_approval[${parts.join(",")}]`
    }
    case "add_restrictions": {
      const parts: string[] = []
      if (action.deniedCapabilities !== undefined) {
        parts.push(`deniedCapabilities=${JSON.stringify(sortedUnique(action.deniedCapabilities))}`)
      }
      if (action.allowedCapabilities !== undefined) {
        parts.push(`allowedCapabilities=${JSON.stringify(sortedUnique(action.allowedCapabilities))}`)
      }
      if (action.maximumTimeoutSeconds !== undefined) parts.push(`maximumTimeoutSeconds=${action.maximumTimeoutSeconds}`)
      if (action.allowDestructiveEffects !== undefined) parts.push(`allowDestructiveEffects=${action.allowDestructiveEffects}`)
      if (action.allowExternalEffects !== undefined) parts.push(`allowExternalEffects=${action.allowExternalEffects}`)
      return `add_restrictions[${parts.join(",")}]`
    }
    case "set_stricter_budget": {
      const parts = Object.entries(action.budget)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
        .map(([key, value]) => `${key}=${value}`)
      return `set_stricter_budget[${parts.join(",")}]`
    }
    case "select_routing_preference": {
      const parts: string[] = []
      const preference = action.preference
      if (preference.preferredNodeIds !== undefined) {
        parts.push(`preferredNodeIds=${JSON.stringify([...preference.preferredNodeIds])}`)
      }
      if (preference.requiredRuntimeKind !== undefined) parts.push(`requiredRuntimeKind=${JSON.stringify(preference.requiredRuntimeKind)}`)
      if (preference.requiredProjectPathId !== undefined) {
        parts.push(`requiredProjectPathId=${JSON.stringify(preference.requiredProjectPathId)}`)
      }
      if (preference.excludedNodeIds !== undefined) {
        parts.push(`excludedNodeIds=${JSON.stringify(sortedUnique(preference.excludedNodeIds))}`)
      }
      return `select_routing_preference[${parts.join(",")}]`
    }
    case "pre_approve_within_bounds": {
      const parts: string[] = [`approvedCapabilities=${JSON.stringify(sortedUnique(action.approvedCapabilities))}`]
      parts.push(`maximumTimeoutSeconds=${action.maximumTimeoutSeconds}`)
      parts.push(`maximumSensitivity=${action.maximumSensitivity}`)
      if (action.maximumFanOut !== undefined) parts.push(`maximumFanOut=${action.maximumFanOut}`)
      if (action.maximumConcurrency !== undefined) parts.push(`maximumConcurrency=${action.maximumConcurrency}`)
      if (action.maximumRetryLimit !== undefined) parts.push(`maximumRetryLimit=${action.maximumRetryLimit}`)
      return `pre_approve_within_bounds[${parts.join(",")}]`
    }
  }
}

/**
 * The M0-EXPRESSIBLE SUBSET of an M6 rule's predicate list, as an M0 `match`.
 *
 * WHY THIS IS NOT `{}`. ADR 0007 section 2 says the M0 kernel "remains the
 * enforcement point for the actions it already understands". A projection that
 * emits `match: {}` does not honour that sentence: `matchRule`
 * (`src/orchestration/policy/evaluate.ts:44`) treats a rule whose `match`
 * declares no criteria as `matched: true`, so the kernel would apply the effect
 * UNCONDITIONALLY and the whole predicate would rest on the M6 evaluator having
 * gated the rule out. That gate is correct today, but it is a single gate. With
 * the subset below the kernel independently re-checks whatever it is able to
 * express, which matters because `kernelRules` is dispatch-bound by CONSTRUCTION
 * and not by the type system (`src/rules/evaluate.ts`, module docblock): if that
 * binding is ever broken by a caller, a mis-attached rule still has to satisfy
 * the part of the predicate the M0 language can state before the kernel will act
 * on it.
 *
 * THE SUBSET IS EXACTLY THREE PREDICATE FORMS, read from the TOP LEVEL of the
 * predicate list and from nowhere else:
 *
 *   taskTitlePattern                    -> match.taskTitlePattern
 *   capability any [...]                -> match.requestedCapabilitiesAny
 *   runtimeKind eq "k" | in [...]       -> match.runtimeKinds
 *
 * Those are the three fields `ruleMatchSchema`
 * (`src/orchestration/schemas.ts:267`) has, and nothing else in the eighteen M6
 * fields has anywhere to land. `match` legitimately stays `{}` for a rule built
 * from the other fifteen fields, and that is correct rather than a gap in the
 * projection: a manufactured non-empty match would be worse than none, because a
 * reader would have no way to tell which M6 predicate it came from.
 *
 * WHY NESTING IS NOT DESCENDED. `all` / `any` / `not` are combinators and M0 has
 * no combinator, so an M0 `match` is a FLAT CONJUNCTION of at most three criteria
 * and an M6 predicate list is a tree. The only sound projection of a nested M6
 * predicate into a flat M0 conjunction is the EMPTY one, for a reason that has
 * nothing to do with difficulty: flattening `(a or b)` or `not a` into a
 * conjunction is not a widening of the kernel's check, it is a different claim
 * about what the rule means. Projecting `all[capability any [x]]` looks like
 * documentation of the M6 predicate and is in fact a projection that reads as
 * though M6 were narrowing to `x` while the kernel is in fact not narrowing at
 * all. A projection that cannot be checked against the M6 tree by reading the
 * M6 tree is a projection nobody can audit, so the top-level list is the whole
 * of the projection's input and the docblock is the whole of its reasoning.
 *
 * WHY `capability all` AND `capability none` CONTRIBUTE NOTHING. M0's
 * `requestedCapabilitiesAny` is checked with `some()`
 * (`src/orchestration/policy/evaluate.ts:74`), which is an ANY over the dispatch's
 * requested capabilities. Projecting an `all` through it would silently weaken
 * "the dispatch asks for every one of these" into "the dispatch asks for one of
 * these" — a pre-approval scoped to a conjunction would come out of the kernel
 * scoped to a disjunction, and nothing downstream could see the substitution
 * because both sides are just a list of strings. `none` has no M0 counterpart at
 * all (there is no `requestedCapabilitiesNone`), and inventing one would be a
 * second M0 shape, which is what ADR 0007 section 2 exists to prevent. So both are
 * OMITTED, and the omission is the weaker direction: the kernel checks less than
 * M6, never more, never differently.
 *
 * WHY A SECOND TOP-LEVEL `capability any` / `runtimeKind` UNIONS. Two top-level
 * predicates are CONJUNCTIONED by the M6 evaluator. Unioning their members into a
 * single M0 `some()` / `includes` check is strictly weaker than the conjunction of
 * the two disjunctions — the kernel matches where M6 would not, and M6 is the
 * authority, so the direction is the safe one. It is the same "weaker, never
 * different" property as the `all` / `none` omission, arrived at a different way.
 *
 * WHY A SECOND TOP-LEVEL `taskTitlePattern` KEEPS THE FIRST. M0 has one pattern
 * field and M6 can declare several. Projecting the first DECLARED one is
 * deterministic (declaration order is already part of the normalized form, ADR
 * section 10.2) and still strictly weaker than the conjunction of all of them.
 * Projecting the last, or the longest, or refusing the rule would each be a
 * different arbitrary rule; the first is the one an auditor reading the M6 list
 * top-down can find without being told which one was chosen.
 *
 * THE RESIDUAL GAP, STATED. The kernel enforces a STRICTLY WEAKER predicate than
 * M6, in three places at once: it has no combinator, it has fifteen fewer fields,
 * and its two set checks are ANY where M6 can be ALL. That is not fixed here and
 * cannot be fixed without editing the frozen `ruleSchema`. So M6 remains the
 * authority on WHICH RULES APPLY, and this projection is a second, independent,
 * fail-closed check on the part of the answer M0 can state: a rule the kernel
 * cannot match is skipped with a reason, and a rule the kernel CAN match still
 * has to clear the kernel's own post-narrowing pre-approval re-check before any
 * grant exists.
 *
 * WHAT AN INCOMPATIBLE VALUE DOES. Nothing is sanitised or truncated. The
 * projected object is parsed through the frozen `ruleSchema` by the caller, and a
 * value M0 cannot hold — a runtime kind outside the M0 token alphabet, a union
 * longer than `ARRAY_MAX` — fails that parse and is refused at COMPILE time with
 * `rule.invalid_source`, rather than being projected and then rejected by the
 * kernel at dispatch time where the author is not watching.
 */
function projectKernelMatch(document: RuleSourceDocument): Rule["match"] {
  let titlePattern: string | undefined
  const capabilities: string[] = []
  const runtimeKinds: string[] = []

  for (const predicate of document.predicates) {
    if (predicate.field === "taskTitlePattern") {
      if (titlePattern === undefined) titlePattern = predicate.pattern
      continue
    }
    // `all` and `none` are omitted; see the docblock. Only `any` shares the M0
    // `some()` semantics, and `any([])` was already refused as an empty enum
    // before the projection runs, so a contributed list is never empty.
    if (predicate.field === "capability") {
      if (predicate.operator === "any") capabilities.push(...predicate.value)
      continue
    }
    if (predicate.field === "runtimeKind") {
      runtimeKinds.push(...(Array.isArray(predicate.value) ? predicate.value : [predicate.value]))
    }
  }

  return {
    ...(titlePattern === undefined ? {} : { taskTitlePattern: titlePattern }),
    ...(capabilities.length === 0 ? {} : { requestedCapabilitiesAny: sortedUnique(capabilities) }),
    ...(runtimeKinds.length === 0 ? {} : { runtimeKinds: sortedUnique(runtimeKinds) }),
  }
}

/**
 * Projects an M6 action into the M0 `Rule` shape, or reports that it cannot.
 *
 * THE PROJECTION IS A RE-SHAPING, NOT A TRANSLATION, and the distinction is
 * load-bearing. `ruleSchema` is the M0 contract: it cannot be widened, and
 * M6 does not try. Only four of the six M6 action kinds project at all:
 *
 *   require_approval          -> `restrict`   (deniedCapabilities plus the two
 *                                                  approval booleans)
 *   add_restrictions          -> `restrict`   (merged with the above)
 *   pre_approve_within_bounds -> `pre_approve`
 *   deny_with_reason          -> null (M6 enforces it; the kernel's own deny
 *                                 still applies and M6 only ever ANDs with it)
 *   set_stricter_budget       -> null (the kernel does not model budgets)
 *   select_routing_preference -> null (the kernel does not model routing)
 *
 * `M0 restrict cannot express requireApprovalForDispatch` — the M0
 * `restrictiveRuleEffectSchema` has no such field, only the two effect booleans.
 * A projection that invented one would be a second M0 shape, and the ADR's
 * entire reason for having a separate language version is that it does not edit
 * `ruleSchema`. So `require_approval`'s dispatch-level and capability-level
 * demands go into the M6 `restrictions` composition and are applied by the
 * caller's own `narrowPolicyState` call. That is a real capability the
 * projection cannot carry, and it is NAMED in `unprojectedNarrowing` rather than
 * dropped, because "the kernel enforces everything" would otherwise be a false
 * claim.
 */
function projectToKernelRule(document: RuleSourceDocument, actions: readonly RuleAction[]): Result<Rule | null> {
  const restrictActions = actions.filter(
    (action) => action.kind === "require_approval" || action.kind === "add_restrictions",
  )
  const preApprovalActions = actions.filter((action) => action.kind === "pre_approve_within_bounds")

  if (restrictActions.length === 0 && preApprovalActions.length === 0) {
    return { ok: true, value: null }
  }

  if (restrictActions.length > 0 && preApprovalActions.length > 0) {
    const kinds = sortedUnique(actions.map((action) => action.kind))
    return refuse(
      "policy_denied",
      "rule.conflicting_action_effects",
      `Rule '${document.ruleId}@${document.templateVersion}' carries both a narrowing action and pre_approve_within_bounds [${kinds.join(", ")}]. The M0 Rule shape holds exactly one effect, so one of the two would have to be dropped from the kernel projection; a drop is worse than a refusal, so the combination is refused. Write two rules instead — the conflict rules in ADR 0007 section 10.4 already resolve them, and two rules get two explanation nodes and two sort keys.`,
    )
  }

  if (preApprovalActions.length > 0) {
    const action = preApprovalActions[0]
    if (action === undefined || action.kind !== "pre_approve_within_bounds") {
      return refuse("validation", "rule.invalid_source", "Internal: expected a pre_approve_within_bounds action")
    }
    // The M0 `pre_approve` effect is a pure re-shaping: same capabilities, same
    // timeout ceiling, same two effect flags. The kernel's own post-narrowing
    // re-check then re-derives the grant against the fully narrowed state, which
    // is where "this pre-approval exceeds the effective timeout" is decided.
    const projected = ruleSchema.safeParse({
      schemaVersion: FROZEN_DOMAIN_SCHEMA_VERSION,
      ruleId: document.ruleId,
      templateVersion: document.templateVersion,
      projectId: document.projectId,
      enabled: document.enabled,
      match: projectKernelMatch(document),
      effect: {
        kind: "pre_approve",
        approvedCapabilities: sortedUnique(action.approvedCapabilities),
        maximumTimeoutSeconds: action.maximumTimeoutSeconds,
        allowDestructiveEffects: action.allowDestructiveEffects,
        allowExternalEffects: action.allowExternalEffects,
      },
      author: document.author,
      createdAt: document.createdAt,
    })
    if (!projected.success) {
      return refuse(
        "validation",
        "rule.invalid_source",
        `Rule '${document.ruleId}@${document.templateVersion}' projects to an M0 rule (match plus pre_approve effect) the frozen ruleSchema rejects: ${projected.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("; ")}`,
      )
    }
    return { ok: true, value: projected.data }
  }

  const deniedCapabilities = sortedUnique(
    restrictActions.flatMap((action) => (action.kind === "add_restrictions" ? (action.deniedCapabilities ?? []) : [])),
  )
  const projected = ruleSchema.safeParse({
    schemaVersion: FROZEN_DOMAIN_SCHEMA_VERSION,
    ruleId: document.ruleId,
    templateVersion: document.templateVersion,
    projectId: document.projectId,
    enabled: document.enabled,
    match: projectKernelMatch(document),
    effect: {
      kind: "restrict",
      deniedCapabilities,
      requireApprovalForDestructiveEffects: restrictActions.some(
        (action) =>
          (action.kind === "require_approval" && action.requireApprovalForDestructiveEffects === true) ||
          (action.kind === "add_restrictions" && action.allowDestructiveEffects === false),
      ),
      requireApprovalForExternalEffects: restrictActions.some(
        (action) =>
          (action.kind === "require_approval" && action.requireApprovalForExternalEffects === true) ||
          (action.kind === "add_restrictions" && action.allowExternalEffects === false),
      ),
    },
    author: document.author,
    createdAt: document.createdAt,
  })
  if (!projected.success) {
    return refuse(
      "validation",
      "rule.invalid_source",
      `Rule '${document.ruleId}@${document.templateVersion}' projects to an M0 rule (match plus restrict effect) the frozen ruleSchema rejects: ${projected.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    )
  }
  return { ok: true, value: projected.data }
}

/** The narrowing members the M0 `restrict` effect has no field for. */
function unprojectedNarrowingMembers(actions: readonly RuleAction[]): string[] {
  const members: string[] = []
  for (const action of actions) {
    if (action.kind === "require_approval") {
      if (action.requireApprovalForDispatch !== undefined) members.push("requireApprovalForDispatch")
      if (action.requireApprovalForCapabilities !== undefined) members.push("requireApprovalForCapabilities")
    }
    if (action.kind === "add_restrictions") {
      if (action.allowedCapabilities !== undefined) members.push("allowedCapabilities")
      if (action.maximumTimeoutSeconds !== undefined) members.push("maximumTimeoutSeconds")
    }
  }
  return sortedUnique(members)
}

// ===========================================================================
// Public compile API
// ===========================================================================

/**
 * Compiles one authored rule document.
 *
 * The whole body is wrapped so that no input — cyclic, absurdly deep, or of a
 * type the schema never anticipated — can produce a thrown non-contract error.
 * `rule.evaluation_failed` is the catch-all, and it exists because a compiler
 * that throws on a malformed document turns a typo into a crash somewhere far
 * from the author who made it.
 */
export function compileRule(source: unknown): Result<CompiledRule> {
  try {
    return compileRuleUnguarded(source)
  } catch (error) {
    return refuse(
      "internal_failure",
      "rule.evaluation_failed",
      `Compiling a rule document failed unexpectedly and was refused rather than thrown: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function compileRuleUnguarded(source: unknown): Result<CompiledRule> {
  // 1. Language version, before the schema, so a v3 document is told its version
  //    is wrong rather than that its fields are.
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    return refuse(
      "validation",
      "rule.invalid_source",
      `A rule document must be a JSON object; received ${describeShape(source)}`,
    )
  }
  const declaredVersion = (source as Record<string, unknown>)["languageVersion"]
  if (declaredVersion !== ruleLanguageVersion) {
    return refuse(
      "unsupported_capability",
      "rule.language_version_unsupported",
      `Rule language version ${JSON.stringify(declaredVersion)} is not supported; this build reads version ${ruleLanguageVersion} only. A document at another version is refused rather than coerced, because a coerced predicate is a predicate nobody wrote.`,
    )
  }

  // 3. Structural pre-scan, before Zod, so an adversarial nesting is a contract
  //    error rather than a stack overflow inside the recursive parse.
  const measured = measureRawPredicates((source as Record<string, unknown>)["predicates"])
  if (!measured.ok) {
    return { ok: false, error: measured.error }
  }

  // 2. Schema parse.
  let parsed: RuleSourceDocument
  try {
    const result = ruleSourceDocumentSchema.safeParse(source)
    if (!result.success) {
      return refuse(
        "validation",
        "rule.invalid_source",
        `Rule document does not satisfy the rule language v${ruleLanguageVersion} shape: ${result.error.issues
          .slice(0, 8)
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("; ")}`,
      )
    }
    parsed = result.data
  } catch (error) {
    if (error instanceof RangeError) {
      return refuse(
        "validation",
        "rule.limit_exceeded",
        `Rule document's predicate nesting exhausted the parser's stack; refused with rule.limit_exceeded (MAX_PREDICATE_DEPTH is ${MAX_PREDICATE_DEPTH}) rather than thrown`,
      )
    }
    throw error
  }

  // 4. Complexity and format limits.
  const limits = checkLimits(parsed)
  if (!limits.ok) return limits

  // 5. Pattern compilation, through the one bounded analyser in the system.
  const patterns = compilePatterns(parsed)
  if (!patterns.ok) return patterns

  // 6. Unsatisfiable predicates.
  const satisfiable = checkUnsatisfiable(parsed)
  if (!satisfiable.ok) return satisfiable

  // 7. The "match all" restriction.
  const notUniversal = checkNotUniversal(parsed)
  if (!notUniversal.ok) return notUniversal

  // 8. Normalisation, then the M0 projection.
  const actions = sortActions(parsed.actions)
  const projected = projectToKernelRule(parsed, actions)
  if (!projected.ok) return projected

  const normalizedPredicate = describePredicates(parsed.predicates)
  // The rule's own digest covers only what can change its BEHAVIOUR: identity,
  // whether it is enabled and activated, when it expires, the normalized
  // predicate, the actions and the pattern sources. `name`, `description` and
  // `author` are deliberately absent — they are labels an operator reads, and
  // renaming a rule must not invalidate an approval taken against it. The
  // compiled rule's `source` keeps them for the audit record.
  const digest = digestJson({
    languageVersion: ruleLanguageVersion,
    ruleId: parsed.ruleId,
    templateVersion: parsed.templateVersion,
    projectId: parsed.projectId,
    enabled: parsed.enabled,
    activation: parsed.activation,
    expiresAt: parsed.expiresAt,
    normalizedPredicate,
    actions: actions.map(normalizeAction),
    patternSources: patterns.value.map((pattern) => pattern.source),
  })

  return {
    ok: true,
    value: deepFreeze<CompiledRule>({
      ruleId: parsed.ruleId,
      templateVersion: parsed.templateVersion,
      projectId: parsed.projectId,
      name: parsed.name,
      description: parsed.description,
      enabled: parsed.enabled,
      activation: parsed.activation as RuleActivation,
      expiresAt: parsed.expiresAt,
      predicates: parsed.predicates,
      normalizedPredicate,
      actions,
      patterns: patterns.value,
      kernelRule: projected.value,
      unprojectedNarrowing: unprojectedNarrowingMembers(actions),
      source: parsed,
      digest,
    }),
  }
}

/**
 * The canonical single-line form of a predicate LIST (ADR 0007 section 11).
 *
 * Declared here and re-exported by `explain.ts` as
 * `describeNormalizedPredicate`, because the compiler needs it to build the
 * digest and the explainer needs it to render, and two implementations of the
 * canonical form is exactly the drift the ADR's section 11 forbids: "it is the
 * form the compiler digests, so the thing a user reads and the thing that is
 * hashed cannot differ".
 */
export function describePredicates(predicates: readonly RulePredicate[]): string {
  if (predicates.length === 0) return "all()"
  if (predicates.length === 1) {
    const only = predicates[0]
    return only === undefined ? "all()" : normalizePredicateNode(only)
  }
  return `(${predicates.map(normalizePredicateNode).join(" and ")})`
}

/** A human description of a value's JSON shape, for a refusal message. */
function describeShape(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return `a ${typeof value}`
}

/**
 * Compiles a set of authored rule documents into the ONE representation.
 *
 * Rules are ordered by `ruleId` ascending in UTF-16 code unit, then by
 * `templateVersion` ascending, and that order is computed from identity alone so
 * the result does not depend on the order the documents arrived in. Code-unit
 * comparison rather than `localeCompare`: the M3 kernel orders rule snapshots
 * with `localeCompare`, the two can differ for identifiers that differ by case
 * or contain non-ASCII characters, and the difference is safe here because
 * supersession selects by MAXIMUM version and every conflict rule is decided by
 * restrictiveness rather than by position (ADR 0007 section 10.2).
 *
 * A set spanning two projects is refused. Rules are per-project in the M0
 * contract, a `CompiledRuleSet` is the input to a dispatch's evaluation, and a
 * mixed-project set would put a rule authored for another project into a
 * project it does not belong to.
 */
export function compileRuleSet(sources: readonly unknown[]): Result<CompiledRuleSet> {
  try {
    return compileRuleSetUnguarded(sources)
  } catch (error) {
    return refuse(
      "internal_failure",
      "rule.evaluation_failed",
      `Compiling a rule set failed unexpectedly and was refused rather than thrown: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function compileRuleSetUnguarded(sources: readonly unknown[]): Result<CompiledRuleSet> {
  if (!Array.isArray(sources)) {
    return refuse("validation", "rule.invalid_source", `A rule set must be an array of rule documents; received ${describeShape(sources)}`)
  }
  if (sources.length > MAX_RULES_PER_SET) {
    return refuse(
      "validation",
      "rule.limit_exceeded",
      `Rule set declares ${sources.length} rules, over the MAX_RULES_PER_SET of ${MAX_RULES_PER_SET}`,
    )
  }

  const compiled: CompiledRule[] = []
  for (let index = 0; index < sources.length; index += 1) {
    const result = compileRule(sources[index])
    if (!result.ok) {
      return {
        ok: false,
        error: createContractError(
          result.error.category,
          result.error.code,
          `Rule set entry ${index}: ${result.error.message}`.slice(0, 4_096),
        ),
      }
    }
    compiled.push(result.value)
  }

  compiled.sort(compareCompiledRules)

  const projectId = compiled[0]?.projectId
  for (const rule of compiled) {
    if (rule.projectId !== projectId) {
      return refuse(
        "policy_denied",
        "rule.project_scope_mismatch",
        `Rule set mixes projects: '${rule.ruleId}@${rule.templateVersion}' declares project '${rule.projectId}' and the set's project is '${projectId ?? "none"}'. Rules are per-project, and a set spanning two projects would put a rule into a project it does not belong to.`,
      )
    }
  }

  const duplicate = findDuplicateIdentity(compiled)
  if (duplicate !== null) {
    return refuse(
      "validation",
      "rule.invalid_source",
      `Rule set declares '${duplicate}' more than once. Two documents with the same ruleId and templateVersion are two rules with one identity, and which one wins would depend on input order.`,
    )
  }

  const base = {
    languageVersion: ruleLanguageVersion,
    limits: ruleLimits,
    rules: compiled.map((rule) => ({ ...compiledRuleProjection(rule), digest: rule.digest })),
  }
  const bytes = canonicalByteLength(base)
  if (bytes > MAX_COMPILED_RULE_SET_CANONICAL_BYTES) {
    return refuse(
      "validation",
      "rule.limit_exceeded",
      `Compiled rule set is ${bytes} canonical bytes, over the MAX_COMPILED_RULE_SET_CANONICAL_BYTES of ${MAX_COMPILED_RULE_SET_CANONICAL_BYTES}. The limit is measured against canonical JSON so that the size checked and the size digested are the same size.`,
    )
  }

  return {
    ok: true,
    value: deepFreeze<CompiledRuleSet>({
      languageVersion: ruleLanguageVersion,
      rules: compiled,
      limits: ruleLimits,
      digest: digestJson(base),
    }),
  }
}

/**
 * The JSON-safe projection of a compiled rule, used for the SET digest and for
 * the set's canonical byte measurement.
 *
 * It is a PROJECTION rather than the rule itself for two reasons that both
 * matter. `patterns` holds `SafePattern` objects carrying a `RegExp`, which
 * canonical JSON refuses to encode, so the pattern SOURCES stand in for them.
 * And the set's canonical size is measured over this projection rather than over
 * a list of per-rule digests: a list of 64-character digests is ~200 bytes per
 * rule no matter how large the rule is, so measuring THAT would make a
 * 256-KiB bound unreachable in practice and the limit a comment. Measuring the
 * projection makes the bound a real ceiling on how much rule text a set can
 * carry, which is what "a rule a person cannot read on one screen is a rule
 * nobody audits" is about.
 */
function compiledRuleProjection(rule: CompiledRule): Record<string, unknown> {
  return {
    ruleId: rule.ruleId,
    templateVersion: rule.templateVersion,
    projectId: rule.projectId,
    name: rule.name,
    description: rule.description,
    enabled: rule.enabled,
    activation: rule.activation,
    expiresAt: rule.expiresAt,
    normalizedPredicate: rule.normalizedPredicate,
    actions: rule.actions,
    patternSources: rule.patterns.map((pattern) => pattern.source),
    // `kernelRule` is DELIBERATELY absent, and the reasons are both load-bearing.
    //
    // It is DERIVED, not new information: `match` is computed from the same
    // top-level predicates `normalizedPredicate` already covers and `effect` from
    // the same actions, so including it would double-count every one of them in the
    // measurement and in the digest. Everything the projection reads is already in
    // this projection, which is why excluding `kernelRule` cannot let two documents
    // with different kernel projections share a digest.
    //
    // More importantly, including it would make every rule's digest move when the
    // FROZEN M0 `ruleSchema` moved — and ADR 0007 section 2 exists precisely so
    // that the M6 language does not depend on the M0 surface. A digest that changed
    // because an unrelated M0 field was added would invalidate every open approval
    // in the system on an M0 change, which is the coupling section 2 refuses.
    //
    // The projection is still carried on `CompiledRule.kernelRule` and still handed
    // to the kernel; it is simply not part of the rule's identity.
    unprojectedNarrowing: [...rule.unprojectedNarrowing],
  }
}

/** ruleId ascending by code unit, then templateVersion ascending. */
export function compareCompiledRules(left: CompiledRule, right: CompiledRule): number {
  if (left.ruleId === right.ruleId) return left.templateVersion - right.templateVersion
  return left.ruleId < right.ruleId ? -1 : 1
}

function findDuplicateIdentity(rules: readonly CompiledRule[]): string | null {
  const seen = new Set<string>()
  for (const rule of rules) {
    const identity = `${rule.ruleId}@${rule.templateVersion}`
    if (seen.has(identity)) return identity
    seen.add(identity)
  }
  return null
}

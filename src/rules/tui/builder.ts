/**
 * M6.8 — the keyboard-only rule builder.
 *
 * # THE ONE INVARIANT THAT MATTERS MOST: NO SECOND VALIDATOR
 *
 * This module assembles a candidate `RuleSourceDocument` and hands it to the REAL
 * `compileRule`. It does not decide whether the document is acceptable, and it
 * does not restate one of the compiler's rules in order to fail faster.
 *
 * Why this is not a performance decision. The compiler's refusals are the
 * LANGUAGE's contract: `rule.universal_pre_approval`, `rule.empty_enum`,
 * `rule.limit_exceeded`, `rule.pattern_refused` and the rest. A builder that
 * pre-checked "does this pre-approval constrain a scope field?" would be a second
 * implementation of ADR 0007 section 8, and the two would disagree the first time
 * somebody added a scope field to `NON_UNIVERSAL_PREDICATE_FIELDS` and updated
 * `checkNotUniversal` but not the builder. The disagreement would be silent in one
 * direction and a false refusal in the other: a builder that refuses a document the
 * compiler accepts teaches the author that the tool is broken, and a builder that
 * accepts one the compiler refuses lets them submit something that fails with no
 * explanation of which keystroke caused it.
 *
 * So the builder's entire job is TRANSLATION — keystrokes to document fields — and
 * the compiler's answer is surfaced verbatim: every refusal code appears in
 * `compileCodes` exactly as `compileRule` produced it, and `compileMessages`
 * carries the compiler's own message for the same index. A test asserts this by
 * finding a case where a naive builder-side check would disagree with the compiler
 * and confirming the compiler's answer is the one shown.
 *
 * # WHAT "BYTE-IDENTICAL" MEANS HERE
 *
 * `assembleRuleDocument` returns a plain object whose field set, field names and
 * value shapes are the ones `ruleSourceDocumentSchema` declares. The builder never
 * adds a key the schema does not declare and never omits one it does, because
 * `.strict()` turns an unknown key into `rule.invalid_source` and a missing key
 * into a different refusal — so "the builder's output is exactly what the compiler
 * is handed" is a property of this file and nothing else.
 *
 * A field whose value the builder cannot represent (an operator the field does not
 * support, a value that is not a legal token) is written as the AUTHOR typed it,
 * and the compiler refuses it. The alternative — omitting the key, or coercing the
 * value — would be the builder deciding.
 *
 * # DEFAULTS ARE DEFAULTS, NOT VALIDATION
 *
 * `defaultRuleTuiDraft` seeds a legal-looking document. Every seeded value is
 * inside the language's bounds so that an untouched draft compiles, which is what
 * makes "start editing and watch the normalized predicate update" usable. Changing
 * a seed to an out-of-bounds value would make the builder refuse to open; changing
 * it to a value the compiler refuses would make the first screen a wall of
 * refusals. Neither is a check — they are a starting point.
 *
 * # NAMED INVARIANTS
 *
 *   - **B1 — The compiler decides.** `compileRule` is the only acceptance test.
 *     Refusal codes are passed through verbatim, never rewritten or re-coded.
 *   - **B2 — Purity.** No clock, no randomness, no IO. `now` and the actor are
 *     parameters. Same draft in, same document out, on every run.
 *   - **B3 — Code-unit ordering (T2).** The predicate and action vocabularies are
 *     cycled in `RULE_PREDICATE_FIELDS` / `RULE_ACTION_KIND_RANK` order, which are
 *     the language's own declared orders, so the cycle is reproducible on every
 *     machine. `nextInCycle` wraps; it never sorts by locale.
 *   - **B4 — No content leaks (T7).** The builder holds identifiers, enums,
 *     numbers and authored reason strings. It has no field through which a prompt,
 *     a task description or a context manifest item could arrive, which is why
 *     there is nothing for it to leak.
 *   - **B5 — `unknown` in, `RuleSourceDocument` out.** The draft's editable fields
 *     are strings, because that is what a keystroke produces. The assembly step
 *     narrows them and the compiler is what makes the narrowing safe.
 *
 * # STOP CONDITIONS
 *
 *   - **S-B1 — If the builder wants to refuse something, put the refusal in
 *     `compileRule` instead.** A builder-side refusal with a builder-side code is a
 *     second language.
 *   - **S-B2 — If a new action or predicate field appears, add it to the language's
 *     schema and this module reads it from there.** A local copy of the vocabulary
 *     in this file is a second vocabulary.
 */

import { compileRule, type RuleErrorCode } from "../compile.js"
import { UNKNOWN_REACH_TEXT, describeNormalizedPredicate } from "../explain.js"
import {
  NON_UNIVERSAL_PREDICATE_FIELDS,
  RULE_ACTION_KIND_RANK,
  RULE_PREDICATE_FIELDS,
  ruleLanguageVersion,
  rulePredicateSchema,
  type RuleActionKind,
  type RulePredicate,
  type RulePredicateField,
} from "../types.js"
import { z } from "zod"

/**
 * A predicate LIST, as the canonical-form renderer takes one.
 *
 * Declared here rather than imported because `rulePredicateSchema` is a single
 * predicate, and this module needs the array form to feed
 * `describeNormalizedPredicate`. The element is the language's own schema, so a
 * parse through this array says the same thing a parse through the language's
 * `ruleSourceDocumentSchema` says about the same predicate.
 */
const rulePredicateArraySchema = z.array(rulePredicateSchema)
import {
  compareRuleTuiCodeUnits,
  sortedRuleTuiStrings,
  type RuleTuiBuilderDraft,
  type RuleTuiBuilderField,
  type RuleTuiDanger,
} from "./types.js"

// ===========================================================================
// Vocabularies, read from the language rather than restated (S-B2)
// ===========================================================================

/**
 * The predicate fields the builder can add, in the language's own table order.
 *
 * Taken from `RULE_PREDICATE_FIELDS` rather than listed here, because ADR 0007
 * section 6's table IS the order a reader expects to cycle through, and a second
 * copy of the list would be a second thing to update when a field is added.
 */
export const RULE_TUI_PREDICATE_FIELDS: readonly RulePredicateField[] = RULE_PREDICATE_FIELDS

/**
 * The action kinds the builder can add, in action-kind RANK order.
 *
 * Rank order rather than alphabet, for the reason ADR 0007 section 10.2 gives:
 * restrictive before permissive, so a user cycling the vocabulary sees
 * `deny_with_reason` before `pre_approve_within_bounds`. Alphabetical order would
 * put `select_routing_preference` before `set_stricter_budget` and hide the
 * direction the ADR says the reading order has.
 */
export const RULE_TUI_ACTION_KINDS: readonly RuleActionKind[] = (
  Object.keys(RULE_ACTION_KIND_RANK) as RuleActionKind[]
).sort((left, right) => RULE_ACTION_KIND_RANK[left] - RULE_ACTION_KIND_RANK[right])

/**
 * A legal authored value for each action kind, used when the user adds one.
 *
 * # WHY EACH KIND GETS ITS OWN, RATHER THAN ONE SHARED DEFAULT
 *
 * `assembleAction` writes a DIFFERENT shape per kind, and the shapes are not
 * interchangeable. `pre_approve_within_bounds` needs at least one approved capability
 * and a sensitivity; `set_stricter_budget` needs at least one numeric budget member;
 * `select_routing_preference` needs at least one preference member. A single shared
 * default would therefore have to be simultaneously a capability token and a number,
 * which is impossible — and picking one kind's value for all six would mean four of
 * the six kinds open on a refusal the author never caused.
 *
 * Every value is an OPAQUE TOKEN or a legal number, because the same string is also
 * what `require_approval` and `add_restrictions` split into member lists, and
 * `ruleTokenSchema` refuses a token containing a space. So "deny-this-rule" rather
 * than "denied by the rule being authored": a seed is a value the user is expected to
 * REPLACE, and a seed with spaces in it is refused before they can.
 */
export const RULE_TUI_DEFAULT_ACTION_VALUES: Readonly<Record<string, string>> = Object.freeze({
  deny_with_reason: "denied-by-rule",
  require_approval: "fs.write",
  add_restrictions: "fs.write",
  set_stricter_budget: "4",
  select_routing_preference: "node-1",
  pre_approve_within_bounds: "fs.read",
})

/**
 * The legal default value for an action kind.
 *
 * An unrecognised kind returns the empty string rather than a guess: the assembled
 * action is `{kind}` alone, which the compiler refuses with a code, and a
 * plausible-looking invented member would be a member the author never wrote.
 */
export function defaultActionValueFor(kind: string): string {
  return RULE_TUI_DEFAULT_ACTION_VALUES[kind] ?? ""
}

/**
 * Operators each predicate field accepts, in declaration order.
 *
 * A DECLARATION of the schema's shape, not a check against it: this is how the
 * builder knows which operator to write when the user cycles, and writing an
 * operator the field does not accept is the compiler's refusal to make. The
 * `scheduleWindow` and `taskTitlePattern` fields carry no operator, which is why
 * their entries are empty and cycling one is a no-op rather than an error.
 */
export const RULE_TUI_OPERATORS_BY_FIELD: Readonly<Record<string, readonly string[]>> = Object.freeze({
  projectId: ["eq", "in"],
  roleId: ["eq", "in"],
  roleVersion: ["eq", "lt", "lte", "gt", "gte", "between"],
  capability: ["any", "all", "none"],
  toolCategory: ["any", "all", "none"],
  runtimeKind: ["eq", "in"],
  targetNodeId: ["eq", "in"],
  nodeAdvertisedCapability: ["any", "all", "none"],
  projectPathId: ["eq", "in"],
  taskLabel: ["has", "hasAny", "hasAll", "lacks"],
  dependencyOutcome: ["anySucceeded", "anyFailed", "allSucceeded", "allFailed", "none"],
  fanOut: ["eq", "lt", "lte", "gt", "gte", "between"],
  concurrency: ["eq", "lt", "lte", "gt", "gte", "between"],
  retryLimit: ["eq", "lt", "lte", "gt", "gte", "between"],
  timeoutSeconds: ["eq", "lt", "lte", "gt", "gte", "between"],
  scheduleWindow: [],
  contextSensitivity: ["any", "none", "maxRankAtMost", "maxRankAtLeast"],
  taskTitlePattern: [],
})

/** The two action kinds ADR 0007 section 8 refuses to let be universal. */
export const RULE_TUI_SCOPE_BOUND_ACTION_KINDS: ReadonlySet<string> = new Set([
  "pre_approve_within_bounds",
  "select_routing_preference",
])

/**
 * A legal authored value for each predicate field, used when the user adds one.
 *
 * # WHY THIS IS A DEFAULT AND NOT A VALIDATION
 *
 * The draft holds ONE `predicateValue`, so a value typed for `projectId` is still in
 * the field when the user switches to `fanOut` and adds a predicate — and `"proj-1"`
 * narrowed for `fanOut` is `null`, which the compiler refuses with
 * `rule.invalid_source`. So without this, adding a predicate for any bounded-integer
 * field would show a refusal the author never caused and cannot see the cause of.
 *
 * Seeding a legal value when a predicate is ADDED is not a check on what the author
 * typed: `builder-set-field` still writes any value, and the compiler still refuses
 * whatever is wrong. This is the STARTING POINT for a field the author has just
 * chosen, exactly as `defaultRuleTuiDraft` is the starting point for a document.
 *
 * Every value is INSIDE the field's bounds, so an added predicate compiles before the
 * author has typed anything. A default outside a bound would open the builder on a
 * refusal, which the module docblock calls out as the failure to avoid.
 */
export const RULE_TUI_DEFAULT_PREDICATE_VALUES: Readonly<Record<string, string>> = Object.freeze({
  projectId: "proj-1",
  roleId: "role-1",
  roleVersion: "1",
  capability: "fs.read",
  toolCategory: "fs",
  runtimeKind: "opencode",
  targetNodeId: "node-1",
  nodeAdvertisedCapability: "fs.read",
  projectPathId: "path-1",
  taskLabel: "release",
  dependencyOutcome: "",
  fanOut: "1",
  concurrency: "1",
  retryLimit: "0",
  timeoutSeconds: "900",
  scheduleWindow: "",
  contextSensitivity: "restricted",
  taskTitlePattern: "release",
})

/**
 * The legal default value for a predicate field.
 *
 * An unrecognised field returns the empty string rather than a guess. An empty value
 * narrows to `null` or `[]`, both of which the compiler refuses with a code — which is
 * the correct outcome for a field this builder does not know how to seed, and much
 * better than a plausible-looking value the author would have to notice was invented.
 */
export function defaultPredicateValueFor(field: string): string {
  return RULE_TUI_DEFAULT_PREDICATE_VALUES[field] ?? ""
}

// ===========================================================================
// Cycle helpers (B3)
// ===========================================================================

/**
 * The next member of a cycle, wrapping.
 *
 * Wraps rather than clamps, so cycling forward past the end returns to the start
 * and a user can reach every member from any other in a bounded number of
 * presses. Clamping would make the last member reachable only from the
 * second-to-last, which is a dead end a user cannot tell from a broken key.
 */
export function nextInCycle(members: readonly string[], current: string, delta: number): string {
  if (members.length === 0) return current
  const index = members.indexOf(current)
  const from = index === -1 ? 0 : index
  const size = members.length
  const next = (((from + delta) % size) + size) % size
  return members[next] ?? current
}

/** The next predicate field in the language's table order. */
export function nextPredicateField(current: string, delta: number): string {
  return nextInCycle([...RULE_TUI_PREDICATE_FIELDS], current, delta)
}

/** The next action kind in rank order. */
export function nextActionKind(current: string, delta: number): string {
  return nextInCycle([...RULE_TUI_ACTION_KINDS], current, delta)
}

/** The next operator the field accepts. Returns the current one when it accepts none. */
export function nextPredicateOperator(field: string, current: string, delta: number): string {
  return nextInCycle(RULE_TUI_OPERATORS_BY_FIELD[field] ?? [], current, delta)
}

// ===========================================================================
// The draft
// ===========================================================================

/**
 * A starting document.
 *
 * `now` and `actorId` are parameters (B2). The seeded values are all INSIDE the
 * language's bounds, for the reason the module docblock gives: an untouched draft
 * compiles, so the first thing a user sees on the builder screen is a rule they
 * can edit, not a wall of refusals.
 *
 * `authorKind` is `user` and `authorId` defaults to the supplied actor. The
 * `actor` shape is `src/orchestration/schemas.ts`'s, which is what
 * `ruleSourceDocumentSchema` declares — structurally compatible, and the assembly
 * step is where that compatibility is exercised.
 */
export function defaultRuleTuiDraft(now: string, actorId: string): RuleTuiBuilderDraft {
  return {
    ruleId: "rule-new",
    templateVersion: 1,
    projectId: "proj-1",
    name: "new rule",
    description: "a rule being authored",
    enabled: true,
    expiresAt: null,
    authorKind: "user",
    authorId: actorId,
    createdAt: now,
    predicateField: "projectId",
    predicateOperator: "eq",
    predicateValue: "proj-1",
    predicateNote: "",
    actionKind: "deny_with_reason",
    // An OPAQUE TOKEN, not prose, and that is a requirement rather than a style
    // choice. The same authored string feeds every action kind: `assembleAction`
    // splits it on commas into MEMBER LISTS for the list-valued kinds, and a prose
    // default ("denied by the rule being authored") splits into members containing
    // spaces, which `ruleTokenSchema` refuses — so a draft opened with a prose
    // default would show `rule.invalid_source` for an untouched action, and the author
    // would have to fix a field they had not touched.
    //
    // The token is also a legal `deny_with_reason` reason (any 1..4096 string), so
    // the default compiles for the default kind AND narrows legally for the others.
    actionValue: "denied-by-rule",
    focus: "metadata",
    cursor: 0,
  }
}

/** Replace one field on a draft. `undefined` values become the empty string. */
export function withBuilderField(
  draft: RuleTuiBuilderDraft,
  field: RuleTuiBuilderField,
  value: string,
): RuleTuiBuilderDraft {
  switch (field) {
    case "ruleId":
      return { ...draft, ruleId: value }
    case "templateVersion": {
      // `Number` on the empty string is `0`, and `0` is not a positive integer, so
      // an emptied field produces a document the compiler refuses. That is the
      // intended behaviour: the builder does not clamp a cleared field to a legal
      // value (B1), it writes what was typed.
      const parsed = Number(value)
      return { ...draft, templateVersion: Number.isFinite(parsed) ? parsed : Number.NaN }
    }
    case "projectId":
      return { ...draft, projectId: value }
    case "name":
      return { ...draft, name: value }
    case "description":
      return { ...draft, description: value }
    case "predicateValue":
      return { ...draft, predicateValue: value }
    case "predicateNote":
      return { ...draft, predicateNote: value }
    case "actionValue":
      return { ...draft, actionValue: value }
  }
}

/**
 * Append one character to a text field.
 *
 * Keyboard-only authoring needs this: a builder whose text fields can only be set
 * wholesale has no way to type a `:` into a timestamp or a `.` into a node id.
 * `backspace` removes the last character, which is why a `delete`-forward key is
 * not required.
 */
export function appendToBuilderField(
  draft: RuleTuiBuilderDraft,
  field: RuleTuiBuilderField,
  character: string,
): RuleTuiBuilderDraft {
  return withBuilderField(draft, field, `${currentBuilderFieldValue(draft, field)}${character}`)
}

/** Remove the last character of a text field. */
export function backspaceBuilderField(draft: RuleTuiBuilderDraft, field: RuleTuiBuilderField): RuleTuiBuilderDraft {
  const current = currentBuilderFieldValue(draft, field)
  return withBuilderField(draft, field, current.slice(0, -1))
}

/** The current textual value of a builder field, for the append/backspace pair. */
export function currentBuilderFieldValue(draft: RuleTuiBuilderDraft, field: RuleTuiBuilderField): string {
  switch (field) {
    case "ruleId":
      return draft.ruleId
    case "templateVersion":
      return Number.isFinite(draft.templateVersion) ? String(draft.templateVersion) : ""
    case "projectId":
      return draft.projectId
    case "name":
      return draft.name
    case "description":
      return draft.description
    case "predicateValue":
      return draft.predicateValue
    case "predicateNote":
      return draft.predicateNote
    case "actionValue":
      return draft.actionValue
  }
}

// ===========================================================================
// Assembly — the only place a document is built (B1, B5)
// ===========================================================================

/**
 * The operator to write for a field, given the operator the author has selected.
 *
 * The author's choice when the field DECLARES it, and otherwise the field's first
 * declared operator. The fallback matters: the builder holds ONE operator on the
 * draft, and the user can add a predicate for any of the eighteen fields, so a
 * `between` selected for `fanOut` will be carried into a `projectId` that declares only
 * `eq` and `in`. Writing the author's operator there would produce
 * `projectId between "a"` — which `.strict()` refuses as a shape error and which the
 * author never asked for.
 *
 * Falling back is not validation: it picks the operator the SCHEMA declares, and the
 * compiler still decides whether the assembled document is acceptable. A field that
 * declares no operator (`scheduleWindow`, `taskTitlePattern`) falls back to `"eq"`,
 * which `assemblePredicate` then omits because those fields carry no operator key.
 */
function operatorForField(field: string, selected: string): string {
  const declared = RULE_TUI_OPERATORS_BY_FIELD[field] ?? []
  return declared.includes(selected) ? selected : (declared[0] ?? "eq")
}

/**
 * Narrow one authored string to the predicate shape its FIELD declares.
 *
 * This is NARROWING, not validation. It asks "which JavaScript shape does this
 * field's schema call a value?" and produces that shape. It does not ask "is this
 * value legal?", and every check that would be such a question is left to
 * `compileRule`:
 *
 *   - `in` and the set operators take arrays, so a comma-separated string becomes
 *     a member list. Whether the list is too long, empty, or holds a character the
 *     token alphabet forbids is `MAX_ENUMERATED_MEMBERS` and `ruleTokenSchema`'s
 *     business, and the compiler applies both.
 *   - `between` takes `{min,max}`, so "2,8" becomes that object. Whether `min > max`
 *     is `rule.empty_enum`, and the compiler says so.
 *   - The bounded-integer fields take numbers, so a non-numeric string becomes
 *     `null` and the compiler refuses the shape. Coercing "abc" to `0` would be
 *     the builder inventing a value the author did not write.
 *   - `contextSensitivity` takes rung names for `any`/`none` and a rank for the
 *     `maxRank*` operators, so the same string narrows two ways and the compiler
 *     decides whether the pairing is the one that field wanted.
 */
function narrowPredicateValue(field: string, operator: string, value: string): unknown {
  const members = value.split(",").map((member) => member.trim()).filter((member) => member.length > 0)
  if (operator === "in" || operator === "any" || operator === "all" || operator === "none" || operator === "hasAny" || operator === "hasAll" || operator === "lacks") {
    return members
  }
  if (operator === "between") {
    const [min, max] = members.length === 2 ? members : [value, value]
    const minimum = Number(min)
    const maximum = Number(max)
    return { min: Number.isFinite(minimum) ? minimum : null, max: Number.isFinite(maximum) ? maximum : null }
  }
  if (field === "contextSensitivity" && (operator === "maxRankAtMost" || operator === "maxRankAtLeast")) {
    const rank = Number(value)
    return Number.isFinite(rank) ? rank : null
  }
  if (
    field === "roleVersion" ||
    field === "fanOut" ||
    field === "concurrency" ||
    field === "retryLimit" ||
    field === "timeoutSeconds"
  ) {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : null
  }
  return value
}

/** One predicate as the builder assembles it, before the compiler has seen it. */
function assemblePredicate(draft: RuleTuiBuilderDraft, field: string, operator: string, value: string, note: string): Record<string, unknown> {
  const narrowed = narrowPredicateValue(field, operator, value)
  const assembled: Record<string, unknown> = { field }
  // `dependencyOutcome`, `scheduleWindow` and `taskTitlePattern` do not carry a
  // `value` key at all, and `.strict()` makes an extra key a refusal rather than a
  // silently dropped field. So the key is written only for the shapes that declare
  // it, which is a statement about the SCHEMA, not about whether the value is
  // acceptable.
  if (field === "scheduleWindow") {
    assembled["windows"] = []
  } else if (field === "taskTitlePattern") {
    assembled["pattern"] = value
  } else {
    // Every remaining field declares an `operator`. `dependencyOutcome` declares one
    // and NO `value` — ADR 0007 section 6's row 11 gives it five operators and an
    // empty value column — so the `value` key is the one omitted, not the operator.
    // Omitting the operator there produced a document the schema refused for a shape
    // reason rather than for anything the author did.
    assembled["operator"] = operator
    if (field !== "dependencyOutcome") assembled["value"] = narrowed
  }
  if (note.length > 0) assembled["note"] = note
  return assembled
}

/**
 * One action as the builder assembles it.
 *
 * Each branch writes the members that action kind DECLARES, and nothing else. The
 * two `allow*Effects` members of a pre-approval are written as `false` because
 * `z.literal(false)` makes that the only representable value; the builder does not
 * offer a key that would set them to anything else, and it does not need to refuse
 * one.
 */
function assembleAction(draft: RuleTuiBuilderDraft, kind: string, value: string): Record<string, unknown> {
  const members = value.split(",").map((member) => member.trim()).filter((member) => member.length > 0)
  switch (kind) {
    case "deny_with_reason":
      return { kind: "deny_with_reason", reason: value }
    case "require_approval":
      return { kind: "require_approval", requireApprovalForDispatch: true, requireApprovalForCapabilities: members }
    case "add_restrictions":
      return { kind: "add_restrictions", deniedCapabilities: members, allowDestructiveEffects: false, allowExternalEffects: false }
    case "set_stricter_budget":
      return { kind: "set_stricter_budget", budget: { maximumFanOut: members.length > 0 ? Number(members[0]) : null } }
    case "select_routing_preference":
      return { kind: "select_routing_preference", preference: { preferredNodeIds: members } }
    case "pre_approve_within_bounds":
      return {
        kind: "pre_approve_within_bounds",
        approvedCapabilities: members,
        maximumTimeoutSeconds: 900,
        allowDestructiveEffects: false,
        allowExternalEffects: false,
        maximumSensitivity: "restricted",
      }
    default:
      // An action kind the language does not declare. The draft cannot reach one
      // through `builder-cycle-action-kind` (the cycle is over the declared kinds),
      // so this branch exists only so that a draft handed in from outside cannot
      // make the builder throw: it produces a document the compiler refuses.
      return { kind }
  }
}

/**
 * The candidate document, exactly as `compileRule` will receive it.
 *
 * Returns `unknown` rather than `RuleSourceDocument` because the draft may not be
 * a valid document — that is the whole point — and typing it as the schema's
 * inferred type would be a claim the builder cannot make. `compileBuilderDocument`
 * is the function that hands this to the compiler.
 *
 * `predicates` and `actions` are the COLLECTIONS the caller supplies. They are
 * separate parameters rather than fields on the draft because the draft holds only
 * the fields being edited and the collections are what the user has built up so
 * far; keeping them apart is what lets `builder-add-predicate` append without
 * rewriting a draft.
 */
export function assembleRuleDocument(
  draft: RuleTuiBuilderDraft,
  predicateFields: readonly string[],
  actionKinds: readonly string[],
): unknown {
  const predicates = predicateFields.map((field) =>
    assemblePredicate(draft, field, operatorForField(field, draft.predicateOperator), draft.predicateValue, draft.predicateNote),
  )
  const actions = actionKinds.map((kind) => assembleAction(draft, kind, draft.actionValue))
  return {
    languageVersion: ruleLanguageVersion,
    ruleId: draft.ruleId,
    templateVersion: draft.templateVersion,
    projectId: draft.projectId,
    name: draft.name,
    description: draft.description,
    enabled: draft.enabled,
    // A draft is ALWAYS `draft`. Activation is not a builder field (see
    // `ruleTuiBuilderDraftSchema`'s docblock), so a document this function
    // produces can never claim to be activated, which is what makes "the builder
    // cannot grant" a property of the value rather than a promise.
    activation: { state: "draft", activatedAt: null, activatedBy: null },
    predicates,
    actions,
    expiresAt: draft.expiresAt,
    author: { kind: draft.authorKind, [authorIdKey(draft.authorKind)]: draft.authorId },
    createdAt: draft.createdAt,
  }
}

/** The actor union's member name for an author kind. */
function authorIdKey(kind: RuleTuiBuilderDraft["authorKind"]): string {
  switch (kind) {
    case "user":
      return "userId"
    case "node":
      return "nodeId"
    case "service":
      return "serviceId"
  }
}

// ===========================================================================
// Compilation — the compiler decides (B1)
// ===========================================================================

/**
 * What the compiler said.
 *
 * `codes` are the compiler's own `RuleErrorCode`s, verbatim and in the order it
 * produced them. `messages` are the compiler's own messages at the same indices,
 * so a screen can render code and reason together without having to re-derive one
 * from the other. An empty `codes` with `ok: true` is the ONLY way to say
 * "compiles": there is no builder-side "looks fine" state.
 */
export interface RuleTuiCompileReport {
  readonly ok: boolean
  readonly codes: readonly string[]
  readonly messages: readonly string[]
  /** The compiler's canonical single-line predicate form, or `null` on refusal. */
  readonly normalizedPredicate: string | null
  /** The compiled rule's digest, or `null` on refusal. */
  readonly digest: string | null
  /** True when the document was refused with this code. */
  refusedWith(code: RuleErrorCode): boolean
}

/**
 * Compile the candidate with the REAL compiler.
 *
 * The one place this directory calls into the language. There is no try/catch
 * around it that would substitute a friendlier answer: `compileRule` already
 * converts every internal throw into `rule.evaluation_failed`, so a catch here
 * would only ever mask a code the user needs to see.
 */
export function compileBuilderDocument(document: unknown): RuleTuiCompileReport {
  const result = compileRule(document)
  if (!result.ok) {
    // Captured into a local BEFORE the closure, because a narrowing on `result` does
    // not survive into a function body. Reading `result.error` inside the closure
    // would be a property access on a type the compiler has already proved is the
    // success arm, and the error would be silently `undefined` at run time.
    const code: string = result.error.code
    const message: string = result.error.message
    return {
      ok: false,
      codes: [code],
      messages: [message],
      normalizedPredicate: null,
      digest: null,
      refusedWith: (refusalCode) => refusalCode === code,
    }
  }
  return {
    ok: true,
    codes: [],
    messages: [],
    normalizedPredicate: result.value.normalizedPredicate,
    digest: result.value.digest,
    // A compiled document refused nothing, so the predicate is vacuously false. The
    // parameter is named `_code` rather than `code` because it is genuinely unused,
    // and a reader should not go looking for the comparison.
    refusedWith: () => false,
  }
}

// ===========================================================================
// Danger analysis
// ===========================================================================

/**
 * The dangers a candidate document carries, BEFORE it compiles.
 *
 * Two of the four classes are about documents that will never compile — an
 * unscoped pre-approval is refused outright — so this function runs over the
 * ASSEMBLED PREDICATE LIST rather than over a compiled rule, and reports the
 * compiler's own code as the `code` on the flag. That is what lets the builder show
 * `rule.universal_pre_approval` as the reason a draft cannot be submitted, with the
 * code the caller will actually receive.
 *
 * `unconstrained_reach` and `no_expiry` are properties of a document that DOES
 * compile, and they are reported for the same pre-approval. The axis name is the
 * one the disclosure uses, and the rendered reach is `UNKNOWN_REACH_TEXT`, never an
 * empty set (ADR 0007 section 11).
 */
export function analyzeBuilderDangers(
  draft: RuleTuiBuilderDraft,
  predicateFields: readonly string[],
  actionKinds: readonly string[],
): RuleTuiDanger[] {
  const dangers: RuleTuiDanger[] = []
  const identity = { ruleId: draft.ruleId, templateVersion: draft.templateVersion }
  const scopeBearing = actionKinds.filter((kind) => RULE_TUI_SCOPE_BOUND_ACTION_KINDS.has(kind))

  if (scopeBearing.length > 0) {
    const fields = new Set(predicateFields)
    const constraining = NON_UNIVERSAL_PREDICATE_FIELDS.filter((field) => fields.has(field))
    if (constraining.length === 0) {
      const kinds = sortedRuleTuiStrings(scopeBearing)
      dangers.push({
        kind: "unscoped_pre_approval",
        ...identity,
        // The compiler's own code, not a builder code. If `checkNotUniversal` ever
        // renames it, this line is the only thing that has to change, and the test
        // that asserts the code is passed through verbatim is what catches a miss.
        code: "rule.universal_pre_approval",
        subject: kinds.join(" and "),
        detail: `This rule carries ${kinds.join(" and ")} but constrains none of [${NON_UNIVERSAL_PREDICATE_FIELDS.join(", ")}], so it applies to every dispatch. The compiler refuses it with rule.universal_pre_approval.`,
      })
    }
  }

  if (actionKinds.includes("pre_approve_within_bounds")) {
    if (draft.expiresAt === null) {
      dangers.push({
        kind: "no_expiry",
        ...identity,
        code: null,
        subject: "expiresAt",
        detail:
          "This pre-approval declares expiresAt: null, which ADR 0007 section 11 requires be shown as the literal 'no expiry'. It stays effective until it is revoked or disabled, and no date stops it on its own.",
      })
    }
    for (const axis of unconstrainedReachAxesFor(predicateFields)) {
      dangers.push({
        kind: "unconstrained_reach",
        ...identity,
        code: null,
        subject: axis,
        detail: `The predicate is unconstrained on '${axis}', so this pre-approval can match any value on that axis. Its reach is shown as '${UNKNOWN_REACH_TEXT}' and not as an empty set, because an empty set would read as "matches nothing" and the truth is "matches everything".`,
      })
    }
  }

  return dangers
}

/**
 * The reach axes a predicate field list leaves unconstrained.
 *
 * The five axes are the ones ADR 0007 section 11's disclosure table names. A field
 * that constrains an axis is one of the five identifier/set fields below; every
 * other field — a numeric bound, a schedule window, a pattern — leaves all five
 * unconstrained, which is correct: `timeoutSeconds <= 900` says nothing about
 * which projects can match.
 */
export function unconstrainedReachAxesFor(predicateFields: readonly string[]): readonly string[] {
  const fields = new Set(predicateFields)
  const constrained: Record<string, string> = {
    projects: "projectId",
    roles: "roleId",
    capabilities: "capability",
    nodes: "targetNodeId",
    projectPaths: "projectPathId",
  }
  return (Object.keys(constrained) as (keyof typeof constrained)[])
    .filter((axis) => !fields.has(constrained[axis] ?? ""))
    .sort(compareRuleTuiCodeUnits)
}

/**
 * Whether the draft's predicate list constrains any of ADR 0007 section 8's twelve.
 *
 * Exported because the view model reports it as a row field and a test asserts it
 * agrees with the compiler on a document both can see.
 */
export function draftConstrainsScope(predicateFields: readonly string[]): readonly string[] {
  const fields = new Set(predicateFields)
  return NON_UNIVERSAL_PREDICATE_FIELDS.filter((field) => fields.has(field))
}

// ===========================================================================
// Template capture
// ===========================================================================

/**
 * Capture the current rule set as a reusable template.
 *
 * Returns the VALUE, not the write. A template names a rule set by DIGEST and never
 * by document (`src/workflows/index.ts`), so the capture carries `ruleSetDigest`
 * and the rule identities and nothing else — no predicate text, no actions, no
 * content. That is also why this function can live in a presentation layer without
 * importing `src/workflows/`, which ADR 0007 section 1 forbids in that direction.
 *
 * `now` is a parameter (B2): a capture stamped with a clock read inside this
 * function would make the stored template's `createdAt` depend on when the key was
 * pressed, which is the property the templates module's determinism tests rest on.
 */
export function captureRuleSetAsTemplate(input: {
  readonly templateId: string
  readonly projectId: string
  readonly name: string
  readonly ruleSetDigest: string
  readonly ruleIdentities: readonly string[]
  readonly author: { readonly kind: "user" | "node" | "service"; readonly id: string }
  readonly now: string
}): {
  readonly templateId: string
  readonly projectId: string
  readonly name: string
  readonly description: string
  readonly ruleSetDigest: string
  readonly ruleIdentities: readonly string[]
  readonly author: { readonly kind: "user" | "node" | "service"; readonly id: string }
  readonly createdAt: string
  readonly steps: readonly { readonly stepId: string }[]
} {
  return {
    templateId: input.templateId,
    projectId: input.projectId,
    name: input.name,
    description: `rules ${input.ruleIdentities.length === 0 ? "(none)" : input.ruleIdentities.join(",")} at digest ${input.ruleSetDigest}`,
    ruleSetDigest: input.ruleSetDigest,
    // Sorted and de-duplicated (T2): two captures of the same set must be the same
    // value even if the rows arrived in a different order.
    ruleIdentities: sortedRuleTuiStrings(input.ruleIdentities),
    author: input.author,
    createdAt: input.now,
    steps: [],
  }
}

// ===========================================================================
// Normalized form — the language's renderer, never a second one
// ===========================================================================

/**
 * The canonical form of the predicate list the draft would submit, or `null`.
 *
 * `null` is a STATED value, not a refusal and not a throw: it means "these
 * predicates do not satisfy the predicate schema yet, so there is no normalized
 * form to show". The refusal with a CODE is `compileBuilderDocument`'s, and the two
 * answers are different facts — a draft whose `projectId` is empty has no
 * normalized form AND is refused with `rule.invalid_source` — so the screen shows
 * the refusal and this is simply absent.
 *
 * The rendering itself is `describeNormalizedPredicate`, the one canonical-form
 * renderer in the language (`src/rules/explain.ts:236`, itself a re-export of the
 * compiler's `describePredicates`). Calling it here is what makes the form the user
 * watches update while typing byte-identical to the form the compiler digests
 * (ADR 0007 section 11: "the thing a user reads and the thing that is hashed
 * cannot differ").
 *
 * The predicates are parsed through `rulePredicateSchema` first because that
 * function's parameter is `readonly RulePredicate[]`, a type the builder only has
 * after the language has agreed the shape is one. Parsing is NARROWING here, not
 * validation of the document: `compileBuilderDocument` is what decides.
 */
export function builderNormalizedPredicate(
  draft: RuleTuiBuilderDraft,
  predicateFields: readonly string[],
): string | null {
  const parsed = parsePredicates(draft, predicateFields)
  if (parsed === null) return null
  return describeNormalizedPredicate(parsed)
}

/**
 * The assembled predicates, parsed, or `null` when they do not satisfy the schema.
 *
 * An EMPTY list parses to an empty array rather than `null`: `all([])` is the
 * universal predicate and has a canonical form (`describePredicates` renders it
 * `all()`), so "no predicates yet" is a real state with real text, not a missing
 * one.
 */
function parsePredicates(draft: RuleTuiBuilderDraft, predicateFields: readonly string[]): RulePredicate[] | null {
  const assembled = predicateFields.map((field) =>
    assemblePredicate(draft, field, operatorForField(field, draft.predicateOperator), draft.predicateValue, draft.predicateNote),
  )
  const result = rulePredicateArraySchema.safeParse(assembled)
  return result.success ? (result.data as RulePredicate[]) : null
}

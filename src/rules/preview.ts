/**
 * M6.3 — rule preview and impact analysis.
 *
 * ======================= NO SECOND EVALUATOR. EVER. =======================
 *
 * This module has NO parser, NO matcher, and NO notion of what a rule does. It
 * consumes the SAME `CompiledRuleSet` the runtime consumes and calls the SAME
 * `evaluateRules`, once per supplied history entry, and then REPORTS what those
 * results said. Every "would this match" question in here has exactly one
 * implementation and it is not this file's.
 *
 * ADR 0007 stop condition 1: "Preview and production evaluation are found able
 * to diverge, including by a change to one of them that does not touch the
 * other." The structural answer is that there is no second thing TO change: a
 * preview that re-parsed the source would be a second parser, and a preview
 * that re-walked the predicate tree would be a second matcher. Either would
 * drift the first time `evaluateRules` changed. So this module has no branch
 * that decides whether a rule matches a dispatch. The only value it computes
 * about matching is the set of `dispatchId`s whose evaluation came back
 * `matched`, read off a trace.
 *
 * A test asserts this by calling `evaluateRules` DIRECTLY and comparing
 * (`preview.test.ts`, "the divergence guard"). The property is otherwise
 * unfalsifiable by accident: a reviewer reading this file cannot tell whether
 * `summarizeAxes` is a second matcher or a summariser of what the author wrote,
 * and the assertion cannot.
 *
 * WHAT IS DERIVED HERE, AND WHY IT IS NOT EVALUATION. Three things are computed
 * from the predicate AST, and all three are SUMMARIES OF WHAT THE AUTHOR
 * DECLARED, not decisions about a dispatch:
 *
 *   1. `unconstrainedAxes` — which axes the AST does not constrain at all.
 *   2. `futureScope` — the values each reach axis names, for a rule that has
 *      not matched anything yet, so a reader can see what it would reach.
 *   3. The pre-approval warning, which restates the action's DECLARED bounds.
 *
 * None of them can change which dispatch a rule matches, and `evaluateRules`
 * consults none of them.
 * ===========================================================================
 *
 * STRUCTURED VIEW MODEL PLUS DERIVED `lines`, following
 * `src/context/tui/memory-view.ts`. A string can only be asserted on with
 * `toContain`, which cannot distinguish "this rule is unconstrained on projects"
 * from "this warning happens to mention projects". So the structure is the
 * product and `lines` is derived from it at the very end; the tests read the
 * structure, and a renderer that wanted text reads `lines`.
 *
 * `shadowed` AND `possible_overlap` ARE REPORTED DISTINCTLY, never collapsed
 * into "overlaps". ADR 0007 section 10.5 is explicit that conflating them trains
 * the user to ignore the field, "and the one time it mattered would be the time
 * they ignored it". Both relations are carried through from `evaluateRules`'
 * own `analyzeShadowing` output unchanged; this module does not re-derive,
 * re-rank, or merge them, and the docblock on `RulePreviewShadowing` restates
 * why the field is not collapsed.
 *
 * AN UNCONSTRAINED AXIS RENDERS `"unknown"`, NOT AN EMPTY SET. An axis the
 * predicate does not constrain matches EVERYTHING. An empty set would render as
 * `[]` and read as "matches nothing" — the exact opposite of the truth, in a
 * bracket pair that looks like data. ADR 0007 section 11 says the same about a
 * pre-approval's reach, and `buildPreApprovalDisclosure` already makes that
 * choice for the disclosure. The literal is SHARED, not restated: preview
 * imports `UNKNOWN_REACH_TEXT` from `explain.ts`, so the two cannot drift.
 *
 * THE DISCLOSURE IS REUSED, NOT REWRITTEN. `preApprovalDisclosures` is
 * `buildPreApprovalDisclosure`'s output verbatim, and the matched-dispatch
 * explanation is `renderRuleExplanation`'s output verbatim. There is no second
 * renderer and no second disclosure in this file. A pre-approval that could
 * never fire yet still gets its disclosure: withholding the disclosure until
 * activation would mean the screen a user must read BEFORE activating does not
 * exist yet, which is the one screen whose absence is a safety problem.
 *
 * ONE DELIBERATE, DOCUMENTED DIFFERENCE FROM THE DISCLOSURE'S OWN HISTORY
 * CHECK. `buildPreApprovalDisclosure` asks "would THIS VERSION of this rule have
 * matched that dispatch" and answers it through `evaluateCompiledRule`, which is
 * deliberately supersession-free (a single historical dispatch is a question
 * about one specific version). This module's `evaluations` ask the SET-level
 * question through `evaluateRules`, which applies supersession, so a superseded
 * version reports `superseded` here and may still appear as a historical match
 * in the disclosure. That is two different questions with two correct answers,
 * and the preview reports the set-level one because the runtime enforces the
 * set-level one. It is called out here so a reader does not read the
 * disagreement as a divergence bug — the divergence test compares
 * `evaluations` against `evaluateRules` and nothing else.
 *
 * NO WALL CLOCK, NO RANDOMNESS, NO IO. `now` is supplied by the caller and is
 * the only clock read; `evaluateRules` is handed each entry's OWN
 * `evaluatedAt`, because "would this rule have matched that dispatch" is a
 * question about the instant that dispatch was evaluated, and replaying it
 * against today's clock would silently expire every rule whose `expiresAt` has
 * since passed. `tests/unit/rules/barrel.test.ts` asserts the absence of
 * `Date.now`, `new Date()`, `Math.random`, the filesystem, the network and
 * `new RegExp` over every file in this directory, by source scan.
 *
 * THE AUDIT INPUT TYPE IS STRUCTURAL. `auditRulePreviewForSecrets` takes its
 * preview as `unknown` and walks it generically, for the reason recorded at
 * `src/context/isolation.ts:94-122`: a redaction check that imported the view
 * model it was checking could be defeated by a change to the view model. Naming
 * only `unknown` means the audit survives a new field on `RulePreview` — the
 * new field is walked, and if it carried content the audit would find it.
 *
 * TWO PREVIEW-LOCAL LIMITS, DECLARED HERE RATHER THAN IN `limits.ts`. ADR 0007
 * section 9's table is the LANGUAGE's limits; these two bound how much HISTORY
 * the preview replays and how many rendered explanations it carries, which are
 * properties of the preview rather than of the language. They are named exports
 * so a test can cross them, for the same reason the section 9 constants are.
 */

import { z } from "zod"
import { sensitivitySchema } from "../memory/ontology.js"
import { canonicalJson, digestJson } from "../orchestration/digest.js"
import { createContractError, type Result } from "../orchestration/errors.js"
import {
  dispatchIdSchema,
  nodeIdSchema,
  projectIdSchema,
  projectPathIdSchema,
  roleIdSchema,
  runIdSchema,
  taskIdSchema,
  timestampSchema,
} from "../orchestration/identifiers.js"
import { SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS } from "../orchestration/policy/types.js"
import { actorSchema, dispatchStateSchema } from "../orchestration/schemas.js"
import {
  MAX_CONCURRENCY,
  MAX_ENUMERATED_MEMBERS,
  MAX_FAN_OUT,
  MAX_LABEL_MEMBERS,
  MAX_RETRY_LIMIT,
  PARSE_SHAPE_ARRAY_GUARD,
} from "./limits.js"
import { evaluateRules } from "./evaluate.js"
import {
  UNKNOWN_REACH_TEXT,
  buildPreApprovalDisclosure,
  renderRuleExplanation,
  type DisclosureBound,
  type PreApprovalDisclosure,
  type ReachAxis,
} from "./explain.js"
import {
  RULE_PREDICATE_FIELDS,
  SENSITIVITY_BY_RANK,
  dependencyOutcomeValueSchema,
  dependencyOutcomeValues,
  ruleTokenSchema,
  type CompiledRule,
  type CompiledRuleSet,
  type RuleConflict,
  type RuleEvaluationContext,
  type RuleEvaluationResult,
  type RuleLanguageVersion,
  type RuleMatchOutcome,
  type RulePredicate,
  type RuleShadowing,
} from "./types.js"

// ===========================================================================
// Preview-local limits
// ===========================================================================

/**
 * Maximum history entries the preview will EVALUATE.
 *
 * TRUNCATION, NOT REFUSAL, and the reason is the direction of the failure. A
 * refusal would mean a user with a long history cannot see the disclosure that
 * justifies activating a pre-approval — and the busy user is exactly the user a
 * pre-approval is for, so the refusal would remove the safety screen in the
 * situation where skipping it is most tempting. A truncation is visible, named,
 * counted, reported in `history.droppedEntryCount` and in `structuralWarnings`,
 * so a short `matchedHistory` can never be read as a complete one. That is the
 * same "admit what you left out" discipline `renderRuleExplanation` applies to
 * its own text bound.
 *
 * The retained entries are the MOST RECENT, after a total sort on
 * `(evaluatedAt, dispatchId)`, because that is the part of the history a user
 * will recognise.
 */
export const MAX_PREVIEW_HISTORY_ENTRIES = 256

/**
 * Maximum rules whose matched-dispatch explanation is rendered inline.
 *
 * `renderRuleExplanation` is reused rather than reimplemented, and it bounds its
 * own text by `MAX_EXPLANATION_TEXT_CHARS`. This bounds how many times a
 * preview calls it, so a 512-rule set cannot put 512 explanations in one object.
 * The rules that get theirs are the first in rule sort order that matched at
 * least one entry; the rest report `null`, and the number of omissions appears
 * in `structuralWarnings` so an unexplained `null` is never read as "there was
 * nothing to explain".
 */
export const MAX_PREVIEW_EXPLANATIONS = 8

// ===========================================================================
// Error codes
// ===========================================================================

/**
 * The preview's own refusals.
 *
 * Separate from the compiler's and the evaluator's unions on purpose: those are
 * a contract about the LANGUAGE, and this is a contract about the SUPPLIED
 * HISTORY. A caller that handles `rule.invalid_source` has learned nothing about
 * whether its history entries satisfy this module's schema, so collapsing the
 * two would make a malformed history entry look like a malformed rule.
 */
export const RULE_PREVIEW_CODES = Object.freeze(["rule.preview_invalid_input"] as const)

export type RulePreviewErrorCode = (typeof RULE_PREVIEW_CODES)[number]

// ===========================================================================
// History and options
// ===========================================================================

/**
 * One past or proposed dispatch, as the preview is given it.
 *
 * The shape is the evaluation context MINUS four fields, and each omission is
 * load-bearing rather than incidental:
 *
 *   - `taskTitle` is absent because a title IS task-description content and ADR
 *     0007 section 12 forbids it reaching a disclosure. A rule carrying a
 *     `taskTitlePattern` predicate therefore reports `not_matched` against every
 *     history entry, because the preview genuinely does not have the subject.
 *     It reports that rather than guessing: a preview that invented a title
 *     would be showing a match the runtime could not reproduce.
 *   - `toolCategories` and `nodeAdvertisedCapabilities` are absent because the
 *     ADR's per-entry shape does not carry them. They are supplied as "no
 *     categories named" and "no capability snapshot", which the language defines
 *     as `unsatisfied` for `any`/`all`, so they fail closed.
 *   - `currentBudget` is absent because a replay is not a budget negotiation.
 *     `null` means "no budget in force", under which a `set_stricter_budget`
 *     contribution is never a widening attempt — so a history replay never
 *     reports a `rejected_widening`, which is a real difference from a live
 *     evaluation and is a known limitation.
 *
 * `.strict()` at every level, for the reason `ruleSourceDocumentSchema` gives:
 * a silently dropped key is the mechanism by which "I recorded the fan-out" and
 * "I recorded nothing" become the same document. The array bounds are the
 * language's own (`MAX_ENUMERATED_MEMBERS`, `MAX_LABEL_MEMBERS`), so a history
 * entry cannot smuggle in a set the language would refuse in a rule.
 */
const historyEntryShape = {
  dispatchId: dispatchIdSchema,
  runId: runIdSchema,
  taskId: taskIdSchema,
  projectId: projectIdSchema,
  roleId: roleIdSchema.nullable(),
  roleVersion: z.number().int().min(1).max(1_000).nullable(),
  requestedCapabilities: z.array(ruleTokenSchema).max(MAX_ENUMERATED_MEMBERS),
  runtimeKind: z.string().min(1).max(128).nullable(),
  targetNodeId: nodeIdSchema.nullable(),
  projectPathId: projectPathIdSchema.nullable(),
  taskLabels: z.array(ruleTokenSchema).max(MAX_LABEL_MEMBERS),
  dependencyOutcomes: z.array(dependencyOutcomeValueSchema).max(dependencyOutcomeValues.length),
  requestedFanOut: z.number().int().min(1).max(MAX_FAN_OUT).nullable(),
  requestedConcurrency: z.number().int().min(1).max(MAX_CONCURRENCY).nullable(),
  requestedRetryLimit: z.number().int().min(0).max(MAX_RETRY_LIMIT).nullable(),
  declaredTimeoutSeconds: z.number().int().min(1).max(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS).nullable(),
  contextManifestSensitivity: sensitivitySchema.nullable(),
  evaluatedAt: timestampSchema,
  state: dispatchStateSchema,
}

/** A dispatch that was proposed and may still be awaiting an approval. */
export const proposalHistoryEntrySchema = z.object(historyEntryShape).strict()
export type ProposalHistoryEntry = z.infer<typeof proposalHistoryEntrySchema>

/** A dispatch that reached a terminal state. */
export const finishedDispatchSummarySchema = z.object(historyEntryShape).strict()
export type FinishedDispatchSummary = z.infer<typeof finishedDispatchSummarySchema>

/**
 * The immutable history a preview is computed over.
 *
 * `proposals` and `finishedDispatches` are two ARRAYS rather than one union
 * because a dispatch can legitimately appear in both — proposed, then finished
 * — and the preview de-duplicates by `dispatchId` after a total sort, keeping
 * the observation with the later `evaluatedAt`. `readonly` throughout: the
 * preview treats its history as an audit record and has no business changing it.
 */
export const rulePreviewHistorySchema = z
  .object({
    proposals: z.array(proposalHistoryEntrySchema).max(PARSE_SHAPE_ARRAY_GUARD),
    finishedDispatches: z.array(finishedDispatchSummarySchema).max(PARSE_SHAPE_ARRAY_GUARD),
  })
  .strict()

export type RulePreviewHistory = z.infer<typeof rulePreviewHistorySchema>

/**
 * The preview's inputs other than the artifact and the history.
 *
 * `now` is the INJECTED CLOCK and the only clock this module reads; it becomes
 * `generatedAt` and it is covered by the preview digest, so a preview taken at
 * two different instants is two different artifacts rather than one artifact
 * rendered twice. `activationConfirmed` is the caller's record that the operator
 * saw the section 11 disclosure and confirmed it — ADR 0007 section 18 requires
 * an explicit confirmation that DISPLAYS the disclosure, so the flag is the
 * evidence that the screen was shown, and its absence is reported rather than
 * assumed.
 */
export const rulePreviewOptionsSchema = z
  .object({
    now: timestampSchema,
    actorId: ruleTokenSchema,
    activationConfirmed: z.boolean().optional(),
  })
  .strict()

export type RulePreviewOptions = z.infer<typeof rulePreviewOptionsSchema>

// ===========================================================================
// The preview's shape
// ===========================================================================

/**
 * One axis's declared reach: a sorted set, or the literal `"unknown"`.
 *
 * The two members are NOT interchangeable and the union is deliberate. `[]` is a
 * legal array and would be read as "matches nothing", the opposite of what an
 * unconstrained axis means; `"unknown"` cannot be mistaken for data because it
 * is a string where a set is expected.
 */
export type RulePreviewAxis = readonly string[] | typeof UNKNOWN_REACH_TEXT

/**
 * What a rule WOULD match, read off its own predicate AST.
 *
 * Reported for every rule, and most useful for the ones that have not matched
 * anything yet: a rule with zero history matches tells the reader nothing on
 * its own, and this answers "what is it waiting for".
 */
export interface RulePreviewFutureScope {
  readonly projectIds: RulePreviewAxis
  readonly roles: RulePreviewAxis
  readonly capabilities: RulePreviewAxis
  readonly nodes: RulePreviewAxis
  readonly projectPaths: RulePreviewAxis
}

/**
 * One history entry, as `evaluateRules` answered it. The divergence surface.
 *
 * Every field is COPIED from the trace or from the entry, never recomputed.
 * `tests/unit/rules/preview-divergence.test.ts` walks this array and compares it
 * against a direct `evaluateRules` call for every generated case.
 */
export interface RulePreviewEvaluation {
  readonly dispatchId: string
  readonly runId: string
  readonly taskId: string
  readonly matchOutcome: RuleMatchOutcome
  /** Copied verbatim from the trace. */
  readonly reason: string
  readonly state: z.infer<typeof dispatchStateSchema>
  readonly evaluatedAt: string
}

/** One ADR 0007 section 10.4 conflict, as it applies to this rule. */
export interface RulePreviewConflict {
  readonly kind: RuleConflict["kind"]
  /** The rules the conflict names, sorted and de-duplicated. */
  readonly ruleIds: readonly string[]
  /** Stable one-line form, for `lines`. Derived, never a decision. */
  readonly detail: string
}

/**
 * One ADR 0007 section 10.5 shadowing finding, as it applies to this rule.
 *
 * `relation` is `shadowed` ONLY when the evaluator PROVED a superset relation
 * structurally on the normalized AST, and `possible_overlap` when it could not.
 * The two are kept apart here for the reason the evaluator keeps them apart: a
 * preview that called a merely-possible co-match "shadowed" would be claiming a
 * pre-approval is dead when it is alive — in the same field, every time, until
 * the reader stopped reading the field, and ADR 0007 section 10.5 names exactly
 * that failure. `proven` restates the same fact as a boolean so a caller can
 * branch without string-matching the relation; it is DERIVED from the relation,
 * not from a second analysis, so it cannot disagree with it.
 */
export interface RulePreviewShadowing {
  readonly relation: RuleShadowRelationLiteral
  readonly proven: boolean
  /** `otherRuleId` is the shadowING rule when this one is shadowed. */
  readonly otherRuleId: string
  readonly direction: "shadowed_by" | "shadows"
  readonly reason: string
  readonly detail: string
}

/** The two relations, named literally so the type does not widen silently. */
export type RuleShadowRelationLiteral = "shadowed" | "possible_overlap"

/** One rule, as the preview reports it. */
export interface RulePreviewEntry {
  readonly ruleId: string
  readonly templateVersion: number
  readonly projectId: string
  readonly name: string
  readonly enabled: boolean
  /** The author as an identifier. Rendered the way the disclosure renders it. */
  readonly author: string
  readonly activation: {
    readonly state: string
    readonly activatedAt: string | null
    readonly activatedBy: string | null
  }
  readonly expiresAt: string | null
  readonly normalizedPredicate: string
  readonly digest: string
  /**
   * The aggregate over the history: `matched` if the rule matched at least one
   * entry, otherwise the highest-precedence outcome observed, otherwise `null`
   * when no entry was evaluated at all. `RULE_PREVIEW_OUTCOME_PRECEDENCE` is the
   * published order.
   */
  readonly matchOutcome: RuleMatchOutcome | null
  /** Every evaluated entry, in the preview's canonical history order. */
  readonly evaluations: readonly RulePreviewEvaluation[]
  readonly matchedHistoryCount: number
  /** Dispatch ids, sorted and de-duplicated. */
  readonly matchedHistory: readonly string[]
  /** Action kinds, in the compiler's action-kind rank order. */
  readonly actionKinds: readonly string[]
  readonly hasPreApproval: boolean
  /** `true` when activation or confirmation is outstanding. */
  readonly activationRequired: boolean
  readonly conflicts: readonly RulePreviewConflict[]
  readonly shadowing: readonly RulePreviewShadowing[]
  /** Sorted, de-duplicated. Union of this module's and the disclosure's. */
  readonly warnings: readonly string[]
  /** The single pre-approval warning, or `null` for a rule that pre-approves nothing. */
  readonly preApprovalWarning: string | null
  readonly futureScope: RulePreviewFutureScope
  /** Field names the predicate does not constrain, sorted. */
  readonly unconstrainedAxes: readonly string[]
  /**
   * `renderRuleExplanation` output for this rule's first matched entry, or
   * `null`. Reused, never re-rendered, and bounded by `MAX_PREVIEW_EXPLANATIONS`.
   */
  readonly matchedDispatchExplanation: string | null
}

/** What the preview could not determine, or what a reader must be told. */
export interface RulePreviewHistoryReport {
  /** Entries after de-duplication and sorting, before the truncation. */
  readonly entriesConsidered: number
  /** Entries actually passed to `evaluateRules`. */
  readonly entriesEvaluated: number
  /** `true` when `entriesEvaluated < entriesConsidered`. */
  readonly truncated: boolean
  /** How many entries were dropped, so a short list is never read as complete. */
  readonly droppedEntryCount: number
  /** The bound that fired, named so the reader can see the number. */
  readonly limit: number
}

/** The preview. A structure, with `lines` and `explanationText` derived from it. */
export interface RulePreview {
  readonly languageVersion: RuleLanguageVersion
  readonly ruleSetDigest: string
  /** The injected clock. Never `Date.now()`. */
  readonly generatedAt: string
  readonly requestedBy: string
  readonly activationConfirmed: boolean
  readonly history: RulePreviewHistoryReport
  /** One entry per compiled rule, in the compiled set's own evaluation order. */
  readonly rules: readonly RulePreviewEntry[]
  /**
   * Every axis name constrained by NO rule in the set, sorted.
   *
   * Set-wide, because the axis that matters is the one no rule bounds: a
   * pre-approval unconstrained on projects or capabilities is exactly the shape
   * ADR 0007 section 8 refuses, and it is refused per rule at compile time, so
   * anything reported here is a statement about a rule whose OTHER axis carries
   * the constraint.
   */
  readonly unconstrainedAxes: readonly string[]
  /** `ruleId@templateVersion` of every pre-approval awaiting activation or confirmation, sorted. */
  readonly activationRequired: readonly string[]
  /** `buildPreApprovalDisclosure` output, verbatim. Never re-disclosed here. */
  readonly preApprovalDisclosures: readonly PreApprovalDisclosure[]
  /** Sorted, de-duplicated, human-readable. */
  readonly structuralWarnings: readonly string[]
  /**
   * `digestJson` over everything else on this preview.
   *
   * Excludes `digest` itself, and excludes `lines` and `explanationText` for the
   * reason `RuleEvaluationResult` excludes its own `explanationText`: both are
   * functions of the rest, so including them would make the digest cover a
   * derivation of itself.
   */
  readonly digest: string
  /** Display only. */
  readonly explanationText: string
  /** Display only. */
  readonly lines: readonly string[]
}

/**
 * The order in which a rule's non-`matched` outcomes are summarised.
 *
 * A rule that matched no history entry still matched no entry for a REASON, and
 * there are seven reasons — a disabled rule, an unactivated one, an expired one,
 * a revoked one, a superseded one, an out-of-scope one and a genuine predicate
 * miss are seven different facts, and the fail-closed discipline this module
 * inherits says seven different facts get seven different values. The aggregate
 * reports the one a reader most needs to act on, and this array is the published
 * order so the choice is inspectable rather than implied.
 *
 * `not_activated` leads because that is the state a pre-approval spends its life
 * in before the operator confirms it, and `project_scope_mismatch` sits above
 * `not_matched` because a rule aimed at another project will never match
 * anything in THIS project's history however its predicates are written.
 */
export const RULE_PREVIEW_OUTCOME_PRECEDENCE: readonly RuleMatchOutcome[] = Object.freeze([
  "not_activated",
  "revoked",
  "expired",
  "superseded",
  "disabled",
  "project_scope_mismatch",
  "not_matched",
])

// ===========================================================================
// The no-secret audit
// ===========================================================================

/**
 * The audit's input, declared STRUCTURALLY.
 *
 * The preview is `unknown` on purpose. `src/context/isolation.ts:94-122` records
 * the reason: a redaction check that imported the view model it was checking
 * could be defeated by a change to the view model, because the check would be
 * re-shaped by exactly the edit it was supposed to catch. Naming only `unknown`
 * means this audit survives a new field on `RulePreview` — the new field is
 * walked, and if it carried content the audit would find it.
 */
export interface RulePreviewAuditInput {
  /** The value under audit, walked generically. */
  readonly preview: unknown
  /** Any text a consumer rendered from it, checked in addition to the value. */
  readonly renderedText?: readonly string[]
  /** Literals that must not appear anywhere, in any encoding. */
  readonly seededCanaries: readonly string[]
}

/**
 * The encodings a value could plausibly arrive in.
 *
 * The same list `src/context/isolation.ts` uses, for the same reason: a canary
 * checked only in its raw form is defeated by a value that is JSON-escaped,
 * percent-encoded or base64'd on its way into a rendered artifact, and the
 * check would have passed.
 */
function encodingsOf(value: string): readonly string[] {
  return [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value, "utf8").toString("base64")]
}

/**
 * Audits a preview for seeded content.
 *
 * Returns findings rather than a boolean: a boolean would tell a reviewer that
 * something was wrong and not what, which is the same objection
 * `verifyPreviewMatchesManifest` raises. An empty list means "checked every
 * canary in every encoding against the whole value and found nothing", not
 * "found nothing to check".
 */
export function auditRulePreviewForSecrets(input: RulePreviewAuditInput): readonly string[] {
  const haystacks: readonly { label: string; text: string }[] = [
    { label: "preview", text: safeCanonical(input.preview) },
    ...(input.renderedText ?? []).map((text, index) => ({ label: `renderedText[${index}]`, text })),
  ]
  const findings: string[] = []
  for (const canary of input.seededCanaries) {
    for (const encoding of encodingsOf(canary)) {
      if (encoding.length === 0) continue
      for (const haystack of haystacks) {
        if (haystack.text.includes(encoding)) findings.push(`canary of ${encoding.length} chars found in ${haystack.label}`)
      }
    }
  }
  return findings
}

/**
 * Canonical JSON, or a marker if the value cannot be encoded.
 *
 * A value canonical JSON refuses (a `RegExp` on a pattern field, a cyclic
 * object) is reported as a finding rather than crashing the audit: an audit that
 * throws on the value it was asked about has audited nothing, and the throw
 * would be indistinguishable from a clean pass at the call site.
 */
function safeCanonical(value: unknown): string {
  try {
    return canonicalJson(value)
  } catch {
    return "<<unencodable: this value cannot be canonicalised, which is itself a finding>>"
  }
}

// ===========================================================================
// Axis summary over the predicate AST
// ===========================================================================

/**
 * Which axes the predicate constrains, and to what declared values.
 *
 * This is a SUMMARISER, not a matcher. Nothing in this section reads an
 * evaluation context, and nothing here can say whether a dispatch matches; it
 * answers "what did the author NAME", which is a different question from "what
 * will fire".
 */
interface AxisSummary {
  readonly constrained: ReadonlySet<string>
  readonly values: ReadonlyMap<string, readonly string[]>
  readonly negated: ReadonlySet<string>
}

const IDENTIFIER_FIELDS = new Set<string>(["projectId", "roleId", "targetNodeId", "projectPathId", "runtimeKind"])

/**
 * Operators that assert an ABSENCE, which bounds nothing to a known set.
 *
 * `capability none ["fs.write"]` is a claim about what the request must NOT
 * contain, not a bound on what it may contain, and reporting the wrapped members
 * as the axis's reach would UNDERSTATE the rule in the direction that hides a
 * grant. The same is true of `taskLabel lacks [...]`, and of a `none` on either
 * tool category or node capability. `buildPreApprovalDisclosure` makes the same
 * call for `capability none`, and the two agreeing is the point: the disclosure
 * and the future scope report one truth about one document.
 */
const NEGATING_OPERATORS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  capability: ["none"],
  toolCategory: ["none"],
  nodeAdvertisedCapability: ["none"],
  taskLabel: ["lacks"],
})

/** Fields that constrain without naming members: numeric bounds, windows, patterns. */
const OPAQUE_CONSTRAINING_FIELDS = new Set<string>([
  "roleVersion",
  "fanOut",
  "concurrency",
  "retryLimit",
  "timeoutSeconds",
  "scheduleWindow",
  "taskTitlePattern",
])

interface MutableAxisSummary {
  readonly constrained: Set<string>
  readonly values: Map<string, Set<string>>
  readonly negated: Set<string>
}

function addValues(summary: MutableAxisSummary, field: string, values: readonly string[]): void {
  const existing = summary.values.get(field)
  if (existing === undefined) {
    summary.values.set(field, new Set(values))
    return
  }
  for (const value of values) existing.add(value)
}

function identifierMembers(value: string | readonly string[]): readonly string[] {
  return Array.isArray(value) ? [...(value as readonly string[])] : [value as string]
}

function operatorOf(predicate: RulePredicate): string {
  const candidate = predicate as { operator?: unknown }
  return typeof candidate.operator === "string" ? candidate.operator : ""
}

/**
 * A rank bound IS a set of rung names, and it is derived from the canonical
 * `SENSITIVITY_BY_RANK` rather than from a second ladder of names declared here.
 * ADR 0007 section 1 requires that reuse for exactly this reason: a second
 * ladder of context-sensitivity names in `src/rules/` is a second thing that can
 * drift from the first.
 */
function sensitivityMembers(operator: string, value: unknown): readonly string[] {
  if (typeof value === "number") {
    if (operator === "maxRankAtMost") return SENSITIVITY_BY_RANK.slice(0, value + 1)
    if (operator === "maxRankAtLeast") return SENSITIVITY_BY_RANK.slice(value)
    return []
  }
  return Array.isArray(value) ? [...(value as readonly string[])] : []
}

function declaredMembers(predicate: RulePredicate): readonly string[] {
  if (IDENTIFIER_FIELDS.has(predicate.field)) {
    return identifierMembers((predicate as { value: string | readonly string[] }).value)
  }
  if (predicate.field === "contextSensitivity") {
    const withOperator = predicate as { operator: string; value: unknown }
    return sensitivityMembers(withOperator.operator, withOperator.value)
  }
  if (predicate.field === "capability" || predicate.field === "toolCategory" || predicate.field === "nodeAdvertisedCapability") {
    return [...(predicate as { value: readonly string[] }).value]
  }
  if (predicate.field === "taskLabel") {
    return identifierMembers((predicate as { value: string | readonly string[] }).value)
  }
  if (OPAQUE_CONSTRAINING_FIELDS.has(predicate.field)) {
    // A numeric bound, a schedule window and a pattern all CONSTRAIN their axis
    // without naming members on it, so the axis counts as constrained and its
    // name is absent from `unconstrainedAxes` — but there is no set of values to
    // report for it, and inventing an empty one would be the same `[]` mistake
    // `UNKNOWN_REACH_TEXT` exists to avoid. None of these fields is one of the
    // five reach axes the disclosure names, so the future scope is unaffected.
    return []
  }
  return []
}

function visitPredicate(predicate: RulePredicate, summary: MutableAxisSummary, underNegation: boolean): void {
  if (predicate.field === "all" || predicate.field === "any") {
    // Both combinators contribute the UNION of their children's declared values.
    // For `any` that is exactly right — the axis is reachable through either
    // branch. For `all` it OVERSTATES each child's individual reach, which is
    // the direction that errs safe for a disclosure: it tells the reader the
    // rule may reach more than any single conjunct would, never less.
    for (const child of predicate.predicates) visitPredicate(child, summary, underNegation)
    return
  }
  if (predicate.field === "not") {
    // A NEGATION CONSTRAINS NOTHING TO A KNOWN SET, and reporting the wrapped
    // values as the axis's reach would overstate the rule in the direction that
    // hides a grant. The axis is marked negated and left unconstrained, and the
    // fact is reported as its own warning rather than folded into the set.
    visitPredicate(predicate.predicate, summary, true)
    return
  }

  const field = predicate.field
  if (underNegation || NEGATING_OPERATORS[field]?.includes(operatorOf(predicate)) === true) {
    summary.negated.add(field)
    return
  }
  summary.constrained.add(field)
  addValues(summary, field, declaredMembers(predicate))
}

function summarizeAxes(predicates: readonly RulePredicate[]): AxisSummary {
  const summary: MutableAxisSummary = { constrained: new Set(), values: new Map(), negated: new Set() }
  for (const predicate of predicates) visitPredicate(predicate, summary, false)
  return {
    constrained: summary.constrained,
    negated: summary.negated,
    values: new Map([...summary.values].map(([field, members]) => [field, [...members] as readonly string[]])),
  }
}

// ===========================================================================
// History normalisation
// ===========================================================================

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits)
}

/** Total order on history entries, computed from identity alone. */
function compareHistoryEntries(left: ProposalHistoryEntry, right: ProposalHistoryEntry): number {
  const byTime = compareCodeUnits(left.evaluatedAt, right.evaluatedAt)
  if (byTime !== 0) return byTime
  return compareCodeUnits(left.dispatchId, right.dispatchId)
}

/**
 * Both history arrays, merged, de-duplicated and ordered.
 *
 * A `dispatchId` seen twice keeps the observation with the LATER `evaluatedAt`:
 * the same dispatch in `proposals` and in `finishedDispatches` is one dispatch
 * that was proposed and then finished, and the later statement is the current
 * one. Because the sort is total before the de-duplication, which copy survives
 * is decided by `(evaluatedAt, dispatchId)` rather than by which array the
 * caller happened to put it in — that is what makes the preview independent of
 * the caller's array order.
 */
function mergeHistory(history: RulePreviewHistory): readonly ProposalHistoryEntry[] {
  const ordered = [...history.proposals, ...history.finishedDispatches].sort(compareHistoryEntries)
  const byDispatch = new Map<string, ProposalHistoryEntry>()
  for (const entry of ordered) byDispatch.set(entry.dispatchId, entry)
  return [...byDispatch.values()].sort(compareHistoryEntries)
}

/**
 * The most recent `MAX_PREVIEW_HISTORY_ENTRIES` entries, and the count dropped.
 *
 * Truncating from the FRONT keeps the most recent history. The dropped count is
 * returned rather than logged so the caller can put it in front of the reader.
 */
function applyHistoryBound(entries: readonly ProposalHistoryEntry[]): {
  readonly evaluated: readonly ProposalHistoryEntry[]
  readonly considered: number
  readonly dropped: number
} {
  if (entries.length <= MAX_PREVIEW_HISTORY_ENTRIES) {
    return { evaluated: entries, considered: entries.length, dropped: 0 }
  }
  return {
    evaluated: entries.slice(entries.length - MAX_PREVIEW_HISTORY_ENTRIES),
    considered: entries.length,
    dropped: entries.length - MAX_PREVIEW_HISTORY_ENTRIES,
  }
}

/**
 * The `RuleEvaluationContext` for one history entry.
 *
 * A COPY, and only of the fields the history owns. The context fields the
 * history does not carry are supplied at their fail-closed values, documented in
 * this module's docblock and on `historyEntryShape`: a title is content, the two
 * category/snapshot fields are not in the ADR's shape, and a replay has no
 * budget in force.
 */
function contextForEntry(entry: ProposalHistoryEntry): RuleEvaluationContext {
  return {
    projectId: entry.projectId,
    roleId: entry.roleId,
    roleVersion: entry.roleVersion,
    requestedCapabilities: [...entry.requestedCapabilities],
    toolCategories: [],
    runtimeKind: entry.runtimeKind,
    targetNodeId: entry.targetNodeId,
    nodeAdvertisedCapabilities: null,
    projectPathId: entry.projectPathId,
    taskLabels: [...entry.taskLabels],
    dependencyOutcomes: [...entry.dependencyOutcomes],
    requestedFanOut: entry.requestedFanOut,
    requestedConcurrency: entry.requestedConcurrency,
    requestedRetryLimit: entry.requestedRetryLimit,
    declaredTimeoutSeconds: entry.declaredTimeoutSeconds,
    taskTitle: null,
    evaluatedAt: entry.evaluatedAt,
    contextManifestSensitivity: entry.contextManifestSensitivity,
    currentBudget: null,
  }
}

// ===========================================================================
// Conflict and shadowing detail forms
// ===========================================================================

function conflictRuleIds(conflict: RuleConflict): readonly string[] {
  switch (conflict.kind) {
    case "multiple_pre_approval":
      return [conflict.grantedBy, ...conflict.shadowed]
    default:
      return conflict.ruleIds
  }
}

/**
 * A stable one-line form of a conflict.
 *
 * A derived string for display, never a decision: the structured `kind` and
 * `ruleIds` on `RulePreviewConflict` are what a test reads, and `detail` exists
 * so the `lines` renderer and the disclosure's `conflicts` array can both name
 * the same finding identically instead of each writing its own format.
 */
function conflictDetail(conflict: RuleConflict): string {
  if (conflict.kind === "multiple_pre_approval") {
    return `multiple_pre_approval[grantedBy=${conflict.grantedBy};shadowed=${conflict.shadowed.join(",")}]`
  }
  return `${conflict.kind}[${conflictRuleIds(conflict).join(",")}]`
}

/** The evaluator's own rendering of a shadowing finding, reproduced exactly. */
function shadowingDetail(entry: RuleShadowing): string {
  return `${entry.relation}:${entry.shadowingRuleId}>${entry.shadowedRuleId}`
}

function outcomePrecedence(outcome: RuleMatchOutcome): number {
  const index = RULE_PREVIEW_OUTCOME_PRECEDENCE.indexOf(outcome)
  return index === -1 ? RULE_PREVIEW_OUTCOME_PRECEDENCE.length : index
}

// ===========================================================================
// The preview
// ===========================================================================

/**
 * Builds the preview.
 *
 * Returns a `Result` rather than throwing, and the only failure it can report is
 * a malformed history or a malformed options object. The compiled rule set is
 * TRUSTED rather than parsed, because `compileRuleSet` is the only way to produce
 * one and it deep-freezes what it returns — that single-artifact property is
 * what the whole module rests on, and re-validating it here would add a second
 * parser without adding a check.
 *
 * The order of operations is load-bearing. The history is bounded and normalised
 * FIRST, so the number of `evaluateRules` calls is a function of the published
 * bound rather than of the caller's array; then every bounded entry is evaluated
 * ONCE through the runtime entry point; then the per-rule report is assembled
 * from those results; then the disclosures are built by `explain.ts`; then the
 * digest.
 */
export function previewCompiledRuleSet(
  compiled: CompiledRuleSet,
  history: unknown,
  options: unknown,
): Result<RulePreview> {
  const parsedHistory = rulePreviewHistorySchema.safeParse(history)
  if (!parsedHistory.success) {
    return invalidInput("history", parsedHistory.error.issues)
  }
  const parsedOptions = rulePreviewOptionsSchema.safeParse(options)
  if (!parsedOptions.success) {
    return invalidInput("options", parsedOptions.error.issues)
  }

  const activationConfirmed = parsedOptions.data.activationConfirmed === true
  const bounded = applyHistoryBound(mergeHistory(parsedHistory.data))

  // ================= THE ONE EVALUATOR. One call per bounded entry. =================
  const evaluationsByEntry = bounded.evaluated.map((entry) => {
    const context = contextForEntry(entry)
    return { entry, context, result: evaluateRules(compiled, context) }
  })

  // Rendered lazily and cached per dispatch, because `renderRuleExplanation`
  // covers the whole result for one dispatch and every matched rule in it would
  // otherwise re-render the same text.
  const explanationsByDispatch = new Map<string, string>()
  const explanationFor = (dispatchId: string): string => {
    const cached = explanationsByDispatch.get(dispatchId)
    if (cached !== undefined) return cached
    const source = evaluationsByEntry.find((candidate) => candidate.entry.dispatchId === dispatchId)
    // Every dispatch in `evaluationsByEntry` came from a call above, so this
    // cannot be undefined; the fallback exists so a future caller that hands in
    // a different collection gets a stated value rather than an `undefined` in a
    // digest.
    const text = source === undefined ? "No evaluation was recorded for this dispatch" : renderRuleExplanation(source.result)
    explanationsByDispatch.set(dispatchId, text)
    return text
  }

  const rules: RulePreviewEntry[] = []
  const disclosures: PreApprovalDisclosure[] = []
  const structuralWarnings: string[] = []
  const possibleOverlapPairs = new Set<string>()
  const constrainedAnywhere = new Set<string>()
  let explanationsRendered = 0
  let explanationsOmitted = 0

  for (const rule of compiled.rules) {
    const identity = `${rule.ruleId}@${rule.templateVersion}`
    const axes = summarizeAxes(rule.predicates)
    for (const field of axes.constrained) constrainedAnywhere.add(field)

    const evaluations: RulePreviewEvaluation[] = evaluationsByEntry.map(({ entry, result }) => {
      const trace = result.traces.find(
        (candidate) => candidate.ruleId === rule.ruleId && candidate.templateVersion === rule.templateVersion,
      )
      return {
        dispatchId: entry.dispatchId,
        runId: entry.runId,
        taskId: entry.taskId,
        // COPIED from the trace. `?? "not_matched"` cannot fire for a compiled
        // set, because `evaluateRules` emits one trace per compiled rule found
        // by this same identity; it is here so that a missing trace would be a
        // stated value inside the digest rather than an `undefined`.
        matchOutcome: trace?.matchOutcome ?? "not_matched",
        reason: trace?.reason ?? "The evaluator returned no trace for this rule",
        state: entry.state,
        evaluatedAt: entry.evaluatedAt,
      }
    })

    const matchedHistory = sortedUnique(
      evaluations.filter((evaluation) => evaluation.matchOutcome === "matched").map((evaluation) => evaluation.dispatchId),
    )

    const conflicts = collectConflicts(rule.ruleId, evaluationsByEntry)
    const shadowing = collectShadowing(rule.ruleId, evaluationsByEntry)
    const hasPreApproval = rule.actions.some((action) => action.kind === "pre_approve_within_bounds")
    const activationRequired = hasPreApproval && (rule.activation.state !== "activated" || !activationConfirmed)
    const futureScope = buildFutureScope(axes)

    // The ONE disclosure, built for every pre-approval rule whether or not it
    // can fire. Built from the same contexts that were just evaluated, so its
    // history section cannot claim a match the evaluator would not agree with.
    const disclosure = hasPreApproval
      ? buildPreApprovalDisclosure(rule, {
          historicalDispatches: evaluationsByEntry.map(({ entry, context }) => ({ dispatchId: entry.dispatchId, context })),
          conflicts: conflicts.map((conflict) => conflict.detail),
          shadowing: shadowing.map((finding) => finding.detail),
        })
      : null
    if (disclosure !== null) disclosures.push(disclosure)

    const unconstrainedAxes = RULE_PREDICATE_FIELDS.filter((field) => !axes.constrained.has(field)).sort(compareCodeUnits)

    const unconstrainedReach = hasPreApproval ? unconstrainedReachAxes(futureScope) : []
    const warnings = [
      ...(disclosure?.warnings ?? []),
      ...negationWarnings(identity, axes),
      ...unconstrainedPreApprovalWarnings(identity, unconstrainedReach),
      ...activationWarnings(identity, rule.activation.state, activationRequired, activationConfirmed),
      ...shadowingWarnings(identity, shadowing),
    ]
    if (hasPreApproval && matchedHistory.length === 0) {
      warnings.push(
        `Rule '${identity}' is a pre-approval that matched none of the ${bounded.evaluated.length} supplied history entr${
          bounded.evaluated.length === 1 ? "y" : "ies"
        }; it is reported with its future scope rather than with matches.`,
      )
    }

    // Explanations go to the first rules in the compiled set's own evaluation
    // order that matched something. The rest report `null` and the omission is
    // counted into `structuralWarnings`, because an unexplained `null` reads as
    // "there was nothing to explain" rather than "the bound fired".
    let matchedDispatchExplanation: string | null = null
    const firstMatch = evaluations.find((evaluation) => evaluation.matchOutcome === "matched")
    if (firstMatch !== undefined) {
      if (explanationsRendered < MAX_PREVIEW_EXPLANATIONS) {
        matchedDispatchExplanation = explanationFor(firstMatch.dispatchId)
        explanationsRendered += 1
      } else {
        explanationsOmitted += 1
      }
    }

    // Set-level statements, built from the TYPED per-rule values above rather
    // than by re-scanning the warning strings. A prefix match on a warning's
    // prose is a check that silently stops matching the first time somebody
    // rewords the sentence, and a warning that quietly stops reaching the
    // set-level summary is the failure mode this module cannot have.
    if (unconstrainedReach.length > 0) {
      structuralWarnings.push(
        `Rule '${identity}' is a pre-approval UNCONSTRAINED on ${unconstrainedReach.join(", ")}; each is reported as '${UNKNOWN_REACH_TEXT}' rather than as an empty set, because an unconstrained axis matches every value on it.`,
      )
    }
    for (const finding of shadowing) {
      if (finding.relation === "shadowed") {
        structuralWarnings.push(`${identity}: ${finding.detail} — ${finding.reason}`)
      } else {
        // Counted, not listed. The pairwise count is O(rules²), and a
        // set-level list of every possible co-match would bury the PROVEN
        // shadowing rows — which are the ones a reader must act on — under
        // hundreds of "these might both fire" lines. The full detail stays on
        // each rule's own `shadowing` array, where it is one field away.
        //
        // Keyed by the UNORDERED pair, from the typed fields rather than from
        // the derived detail string: the evaluator reports each direction
        // separately, so keying on the direction would report every overlap
        // twice and the count would be a number nobody could reconcile with the
        // pairs on screen.
        possibleOverlapPairs.add(sortedUnique([rule.ruleId, finding.otherRuleId]).join("|"))
      }
    }

    rules.push({
      ruleId: rule.ruleId,
      templateVersion: rule.templateVersion,
      projectId: rule.projectId,
      name: rule.name,
      enabled: rule.enabled,
      author: disclosure?.author ?? describeAuthor(rule),
      activation: {
        state: rule.activation.state,
        activatedAt: rule.activation.activatedAt,
        activatedBy: rule.activation.activatedBy === null ? null : describeActor(rule.activation.activatedBy),
      },
      expiresAt: rule.expiresAt,
      normalizedPredicate: rule.normalizedPredicate,
      digest: rule.digest,
      matchOutcome: aggregateOutcome(evaluations.map((evaluation) => evaluation.matchOutcome)),
      evaluations,
      matchedHistoryCount: matchedHistory.length,
      matchedHistory,
      actionKinds: rule.actions.map((action) => action.kind),
      hasPreApproval,
      activationRequired,
      conflicts,
      shadowing,
      warnings: sortedUnique(warnings),
      preApprovalWarning: hasPreApproval
        ? preApprovalWarningFor(rule, disclosure, {
            matchedHistory,
            evaluatedEntries: bounded.evaluated.length,
            active: !activationRequired,
          })
        : null,
      futureScope,
      unconstrainedAxes,
      matchedDispatchExplanation,
    })
  }

  if (explanationsOmitted > 0) {
    structuralWarnings.push(
      `${explanationsOmitted} matched rule(s) carried no rendered explanation: a preview holds at most ${MAX_PREVIEW_EXPLANATIONS}, taken in rule sort order.`,
    )
  }
  if (bounded.dropped > 0) {
    structuralWarnings.push(
      `The supplied history held ${bounded.considered} entries and the preview evaluated the ${bounded.evaluated.length} most recent; ${bounded.dropped} were dropped by MAX_PREVIEW_HISTORY_ENTRIES of ${MAX_PREVIEW_HISTORY_ENTRIES}. A shorter matchedHistory is therefore not a complete history.`,
    )
  }

  const activationRequired = sortedUnique(
    rules.filter((entry) => entry.activationRequired).map((entry) => `${entry.ruleId}@${entry.templateVersion}`),
  )
  for (const identity of activationRequired) {
    structuralWarnings.push(
      `Rule '${identity}' carries pre_approve_within_bounds and cannot pre-approve until its activation state is 'activated' AND the operator's activation confirmation is recorded.`,
    )
  }
  if (possibleOverlapPairs.size > 0) {
    structuralWarnings.push(
      `${possibleOverlapPairs.size} rule pair(s) are reported as possible_overlap: the evaluator could not prove a superset relation and could not prove disjointness either. That is NOT shadowing, and no such rule is dead. Each pair is listed on the rules' own 'shadowing' arrays.`,
    )
  }

  const base = {
    languageVersion: compiled.languageVersion,
    ruleSetDigest: compiled.digest,
    generatedAt: parsedOptions.data.now,
    requestedBy: parsedOptions.data.actorId,
    activationConfirmed,
    history: {
      entriesConsidered: bounded.considered,
      entriesEvaluated: bounded.evaluated.length,
      truncated: bounded.dropped > 0,
      droppedEntryCount: bounded.dropped,
      limit: MAX_PREVIEW_HISTORY_ENTRIES,
    },
    rules,
    unconstrainedAxes: RULE_PREDICATE_FIELDS.filter((field) => !constrainedAnywhere.has(field)).sort(compareCodeUnits),
    activationRequired,
    preApprovalDisclosures: disclosures,
    structuralWarnings: sortedUnique(structuralWarnings),
  }
  const digest = digestJson(base)
  const structure: Omit<RulePreview, "lines" | "explanationText"> = { ...base, digest }
  const lines = renderPreviewLines(structure)
  return { ok: true, value: { ...structure, lines, explanationText: lines.join("\n") } }
}

// ===========================================================================
// Assembly helpers
// ===========================================================================

function invalidInput(
  what: "history" | "options",
  issues: readonly { path: PropertyKey[]; message: string }[],
): { ok: false; error: ReturnType<typeof createContractError> } {
  return {
    ok: false,
    error: createContractError(
      "validation",
      "rule.preview_invalid_input",
      `rule.preview_invalid_input: the supplied ${what} does not satisfy its schema: ${issues
        .slice(0, 6)
        .map((issue) => `${issue.path.map((segment) => String(segment)).join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
    ),
  }
}

/**
 * `matched` if anything matched, otherwise the highest-precedence outcome, or
 * `null` when nothing was evaluated at all.
 */
function aggregateOutcome(outcomes: readonly RuleMatchOutcome[]): RuleMatchOutcome | null {
  if (outcomes.length === 0) return null
  if (outcomes.includes("matched")) return "matched"
  let best: RuleMatchOutcome | null = null
  for (const outcome of outcomes) {
    if (best === null || outcomePrecedence(outcome) < outcomePrecedence(best)) best = outcome
  }
  return best
}

function collectConflicts(
  ruleId: string,
  evaluations: readonly { result: RuleEvaluationResult }[],
): RulePreviewConflict[] {
  const byDetail = new Map<string, RulePreviewConflict>()
  for (const { result } of evaluations) {
    for (const conflict of result.conflicts) {
      // A conflict is only this rule's when it NAMES this rule. A
      // `deny_overrides_pre_approval` between two other rules says nothing about
      // this one, and reporting it here would fill the field with rows a reader
      // has to re-read to learn they are irrelevant.
      if (!conflictRuleIds(conflict).includes(ruleId)) continue
      const detail = conflictDetail(conflict)
      if (byDetail.has(detail)) continue
      byDetail.set(detail, { kind: conflict.kind, ruleIds: sortedUnique(conflictRuleIds(conflict)), detail })
    }
  }
  return [...byDetail.values()].sort((left, right) => compareCodeUnits(left.detail, right.detail))
}

function collectShadowing(
  ruleId: string,
  evaluations: readonly { result: RuleEvaluationResult }[],
): RulePreviewShadowing[] {
  const byDetail = new Map<string, RulePreviewShadowing>()
  for (const { result } of evaluations) {
    for (const finding of result.shadowing) {
      const isShadowing = finding.shadowingRuleId === ruleId
      const isShadowed = finding.shadowedRuleId === ruleId
      if (!isShadowing && !isShadowed) continue
      const detail = shadowingDetail(finding)
      if (byDetail.has(detail)) continue
      byDetail.set(detail, {
        relation: finding.relation,
        // DERIVED from the relation, not from a second analysis of the AST, so
        // the boolean and the relation cannot disagree.
        proven: finding.relation === "shadowed",
        otherRuleId: isShadowing ? finding.shadowedRuleId : finding.shadowingRuleId,
        direction: isShadowing ? "shadows" : "shadowed_by",
        reason: finding.reason,
        detail,
      })
    }
  }
  return [...byDetail.values()].sort((left, right) => compareCodeUnits(left.detail, right.detail))
}

function buildFutureScope(axes: AxisSummary): RulePreviewFutureScope {
  const axis = (field: string): RulePreviewAxis =>
    axes.constrained.has(field) ? sortedUnique(axes.values.get(field) ?? []) : UNKNOWN_REACH_TEXT
  return {
    projectIds: axis("projectId"),
    roles: axis("roleId"),
    capabilities: axis("capability"),
    nodes: axis("targetNodeId"),
    projectPaths: axis("projectPathId"),
  }
}

function negationWarnings(identity: string, axes: AxisSummary): string[] {
  return [...axes.negated].sort(compareCodeUnits).map(
    (field) =>
      `Rule '${identity}' constrains '${field}' only by NEGATION or by asserting an absence, so the axis has no known value set and is reported as unconstrained.`,
  )
}

/** The reach axis names, in the order the disclosure names them. */
const REACH_AXIS_NAMES: readonly { name: string; value: (scope: RulePreviewFutureScope) => RulePreviewAxis }[] = [
  { name: "projects", value: (scope) => scope.projectIds },
  { name: "roles", value: (scope) => scope.roles },
  { name: "capabilities", value: (scope) => scope.capabilities },
  { name: "nodes", value: (scope) => scope.nodes },
  { name: "projectPaths", value: (scope) => scope.projectPaths },
]

/** The reach axes this rule's predicate leaves unconstrained, in a fixed order. */
function unconstrainedReachAxes(scope: RulePreviewFutureScope): readonly string[] {
  return REACH_AXIS_NAMES.filter(({ value }) => value(scope) === UNKNOWN_REACH_TEXT).map(({ name }) => name)
}

/**
 * The ADR 0007 section 8 / section 11 warning, in the preview's own words.
 *
 * A SECOND, shorter statement alongside the disclosure's per-axis warning, and
 * it is not a duplicate: the disclosure's sentence explains what `unknown`
 * MEANS, one axis at a time; this one names the rule and every unconstrained
 * axis together, which is the form the set-level `structuralWarnings` needs. The
 * axis list is computed from the typed `futureScope`, never by re-reading the
 * disclosure's prose, so a reworded sentence cannot silently drop the warning.
 */
function unconstrainedPreApprovalWarnings(identity: string, unconstrained: readonly string[]): string[] {
  return unconstrained.map(
    (name) =>
      `Rule '${identity}' is a pre-approval UNCONSTRAINED on ${name}; its reach is '${UNKNOWN_REACH_TEXT}', not an empty set, because an unconstrained axis matches every value on it.`,
  )
}

function activationWarnings(
  identity: string,
  state: string,
  activationRequired: boolean,
  activationConfirmed: boolean,
): string[] {
  if (!activationRequired) return []
  const reasons: string[] = []
  if (state !== "activated") reasons.push(`its activation state is '${state}' rather than 'activated'`)
  if (!activationConfirmed) {
    reasons.push("the caller's activationConfirmed flag is false, so the operator's confirmation of the disclosure has not been recorded")
  }
  return [`Rule '${identity}' CANNOT pre-approve: ${reasons.join("; ")}. It is listed in activationRequired until both are satisfied.`]
}

function shadowingWarnings(identity: string, findings: readonly RulePreviewShadowing[]): string[] {
  return findings.map((finding) =>
    finding.relation === "shadowed"
      ? `Rule '${identity}' is ${finding.direction === "shadows" ? "a PROVEN SHADOWING RULE for" : "PROVENLY SHADOWED BY"} '${finding.otherRuleId}' — the evaluator proved the relation on the normalized AST.`
      : `Rule '${identity}' and '${finding.otherRuleId}' may co-match (possible_overlap); that is NOT shadowing and does not mean either rule is dead.`,
  )
}

function boundText(name: string, bound: DisclosureBound): string {
  return bound.kind === "declared" ? `${name}=${String(bound.value)}` : `${name}=unbounded`
}

/**
 * The expiry clause: the literal text `"no expiry"` when the rule has no date.
 *
 * A literal, because ADR 0007 section 11 names it and because `null` in a
 * rendered preview reads like a data value rather than a statement. A rule with
 * no expiry stays effective until it is revoked or disabled, and there is no
 * date at which it stops on its own — which is why this is one of the eight
 * items a pre-approval disclosure must show.
 */
function describeExpiry(rule: CompiledRule): string {
  return rule.expiresAt === null ? "no expiry" : rule.expiresAt
}

/**
 * The single pre-approval warning, naming every item ADR 0007 section 11
 * requires.
 *
 * Every clause is an exact string a test asserts the presence of, so the
 * requirement is checkable rather than a matter of prose: the DECLARED bounds
 * (never a computed narrowing), the reach, the history matches, the conflicts
 * and shadowing, the expiry or the literal `"no expiry"`, the author, the
 * version, the activation state, the activation time and who activated.
 *
 * The whole thing is one line joined by `; ` so that a display can show it
 * without re-parsing it, and so that a test can assert on the presence of each
 * clause without asserting on a format this module is free to extend.
 */
function preApprovalWarningFor(
  rule: CompiledRule,
  disclosure: PreApprovalDisclosure | null,
  facts: { matchedHistory: readonly string[]; evaluatedEntries: number; active: boolean },
): string {
  const identity = `${rule.ruleId}@${rule.templateVersion}`
  const action = rule.actions.find((candidate) => candidate.kind === "pre_approve_within_bounds")
  const approved =
    action !== undefined && action.kind === "pre_approve_within_bounds" ? sortedUnique(action.approvedCapabilities).join(",") : ""
  const bounds =
    disclosure === null
      ? "bounds=unavailable"
      : [
          boundText("maximumFanOut", disclosure.bounds.fanOut),
          boundText("maximumConcurrency", disclosure.bounds.concurrency),
          boundText("maximumRetryLimit", disclosure.bounds.retryLimit),
          boundText("maximumTimeoutSeconds", disclosure.bounds.timeoutSeconds),
          boundText("maximumSensitivity", disclosure.bounds.sensitivity),
        ].join(", ")
  const reach =
    disclosure === null
      ? "reach=unavailable"
      : (Object.entries(disclosure.reach) as readonly [string, ReachAxis][])
          .map(([name, axis]) => `${name}=${axis.kind === "unknown" ? UNKNOWN_REACH_TEXT : `[${axis.values.join(",")}]`}`)
          .join(", ")
  const history =
    facts.matchedHistory.length === 0
      ? `history=matched 0 of ${facts.evaluatedEntries} supplied history entries`
      : `history=matched ${facts.matchedHistory.length} of ${facts.evaluatedEntries} supplied history entries: ${facts.matchedHistory.join(",")}`
  return [
    `pre-approval ${identity}`,
    `author=${disclosure?.author ?? describeAuthor(rule)}`,
    `version=${rule.templateVersion}`,
    `activationState=${rule.activation.state}`,
    `activationTime=${rule.activation.activatedAt ?? "none"}`,
    `activatedBy=${rule.activation.activatedBy === null ? "none" : describeActor(rule.activation.activatedBy)}`,
    `normalizedPredicate=${rule.normalizedPredicate}`,
    `approvedCapabilities=[${approved}]`,
    bounds,
    `reach=${reach}`,
    history,
    `conflicts=[${(disclosure?.conflicts ?? []).join(",")}]`,
    `shadowing=[${(disclosure?.shadowing ?? []).join(",")}]`,
    `expiry=${describeExpiry(rule)}`,
    facts.active ? "active=yes" : "active=no",
  ].join("; ")
}

/**
 * An actor as an identifier.
 *
 * The same convention `buildPreApprovalDisclosure` uses, reimplemented here for
 * the rules that carry no pre-approval and therefore get no disclosure. The
 * alternative — a second format — would mean the author of a deny rule is shown
 * differently from the author of a pre-approval rule, for no reason a reader
 * could infer.
 */
function describeActor(actor: z.infer<typeof actorSchema>): string {
  switch (actor.kind) {
    case "user":
      return `user:${actor.userId}`
    case "node":
      return `node:${actor.nodeId}`
    case "session":
      return `session:${actor.sessionId}`
    case "system":
      return `system:${actor.name}`
  }
}

function describeAuthor(rule: CompiledRule): string {
  return describeActor(rule.source.author)
}

// ===========================================================================
// The derived lines
// ===========================================================================

const INDENT = "  "

function renderAxis(axis: RulePreviewAxis): string {
  return axis === UNKNOWN_REACH_TEXT ? UNKNOWN_REACH_TEXT : `[${axis.join(",")}]`
}

/**
 * The display form. DERIVED from the structure and never the other way round,
 * following `src/context/tui/memory-view.ts`: a renderer is one consumer of this
 * data and a test is another, and a test can only assert on a string with
 * `toContain`.
 */
function renderPreviewLines(preview: Omit<RulePreview, "lines" | "explanationText">): string[] {
  const lines: string[] = []
  lines.push(`rule preview: language v${preview.languageVersion}, ruleSetDigest ${preview.ruleSetDigest}`)
  lines.push(`generatedAt: ${preview.generatedAt} (requested by ${preview.requestedBy})`)
  lines.push(
    `history: ${preview.history.entriesEvaluated} entr${preview.history.entriesEvaluated === 1 ? "y" : "ies"} evaluated of ${preview.history.entriesConsidered} supplied` +
      (preview.history.truncated ? `, ${preview.history.droppedEntryCount} dropped by the limit of ${preview.history.limit}` : ""),
  )
  lines.push(`unconstrainedAxes: ${preview.unconstrainedAxes.length === 0 ? "none" : preview.unconstrainedAxes.join(",")}`)
  lines.push(`activationRequired: ${preview.activationRequired.length === 0 ? "none" : preview.activationRequired.join(",")}`)

  lines.push("rules:")
  if (preview.rules.length === 0) lines.push(`${INDENT}(none)`)
  for (const rule of preview.rules) {
    lines.push(`${INDENT}${rule.ruleId}@${rule.templateVersion}: ${rule.matchOutcome ?? "no_history"} — ${rule.name}`)
    lines.push(`${INDENT.repeat(2)}predicate: ${rule.normalizedPredicate}`)
    lines.push(
      `${INDENT.repeat(2)}history: ${rule.matchedHistory.length === 0 ? "no matches" : rule.matchedHistory.join(",")} (${rule.matchedHistoryCount} matched)`,
    )
    lines.push(
      `${INDENT.repeat(2)}future scope: projects=${renderAxis(rule.futureScope.projectIds)}` +
        ` roles=${renderAxis(rule.futureScope.roles)}` +
        ` capabilities=${renderAxis(rule.futureScope.capabilities)}` +
        ` nodes=${renderAxis(rule.futureScope.nodes)}` +
        ` projectPaths=${renderAxis(rule.futureScope.projectPaths)}`,
    )
    lines.push(
      `${INDENT.repeat(2)}unconstrained axes: ${rule.unconstrainedAxes.length === 0 ? "none" : rule.unconstrainedAxes.join(",")}`,
    )
    lines.push(
      `${INDENT.repeat(2)}conflicts: ${rule.conflicts.length === 0 ? "none" : rule.conflicts.map((entry) => entry.detail).join(" ")}`,
    )
    lines.push(
      `${INDENT.repeat(2)}shadowing: ${rule.shadowing.length === 0 ? "none" : rule.shadowing.map((entry) => `${entry.relation} ${entry.direction} ${entry.otherRuleId}`).join(" ")}`,
    )
    if (rule.preApprovalWarning !== null) lines.push(`${INDENT.repeat(2)}${rule.preApprovalWarning}`)
  }

  lines.push(`structural warnings: ${preview.structuralWarnings.length === 0 ? "none" : ""}`)
  for (const warning of preview.structuralWarnings) lines.push(`${INDENT}- ${warning}`)
  lines.push(`digest: ${preview.digest}`)
  return lines
}

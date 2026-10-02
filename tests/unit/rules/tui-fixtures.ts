/**
 * Shared fixtures for the M6.8 rule TUI tests.
 *
 * # WHY THE CANARY IS SEEDED HERE AND NOT IN ONE TEST FILE
 *
 * ADR 0007 section 12's list of what must never reach a rendered rule screen is
 * enforced by seeding a canary into every field that COULD carry content and
 * asserting it appears nowhere in the output. That assertion has to be made against
 * a state that is fully loaded — rules, preview, explanation, raw document, builder
 * draft — because a leak would come from whichever screen renders the field.
 *
 * `CANARY` is therefore seeded into:
 *
 *   - the rule `name` and `description`, which is where an operator might paste a
 *     task title;
 *   - a `deny_with_reason` reason, which is the one free-text field the language
 *     genuinely allows an author to write prose into;
 *   - the builder draft's `name`, `description` and `predicateNote`;
 *   - the evaluation context's `taskTitle`, `taskLabels`, `toolCategories` and
 *     `nodeAdvertisedCapabilities`, which is the class `explain.test.ts` seeds.
 *
 * The tests assert the absence in BOTH `lines` and the structured fields, and the
 * tests that seed a canary into a rule's own metadata assert that the metadata a
 * user IS supposed to see (the ruleId, the digest, the match outcome) is still
 * present — otherwise "no canary anywhere" would pass for a view model that renders
 * nothing at all.
 *
 * # EVERY FIXTURE IS VALIDATED
 *
 * Each builder validates through the module's OWN schema, so a fixture that has
 * drifted out of the rule language is a loud failure at the first test that uses it
 * rather than a subtly-wrong input three layers down. The one builder that
 * deliberately produces something the language REFUSES — `unscopedPreApprovalRows` —
 * says so in its name and its docblock.
 */

import {
  UNKNOWN_REACH_TEXT,
  compileRuleSet,
  evaluateRules,
  previewCompiledRuleSet,
  type CompiledRuleSet,
  type PreApprovalDisclosure,
  type RuleEvaluationContext,
  type RulePreview,
  type RulePreviewEntry,
} from "../../../src/rules/index.js"
import { canonicalJson } from "../../../src/orchestration/digest.js"
import { builderRuleTuiRows } from "../../../src/rules/tui/index.js"
import type { RuleTuiDanger, RuleTuiPreviewEntryShape, RuleTuiUiState } from "../../../src/rules/tui/index.js"
import { initialRuleTuiState } from "../../../src/rules/tui/index.js"
import { PROJECT_ID, ROLE_ID, preApprovalDocument, validContext, validRuleDocument } from "./fixtures.js"
import { HISTORY_INSTANT, PREVIEW_NOW, finishedEntry, previewHistory, previewOptions } from "./preview.fixtures.js"

// ===========================================================================
// Clocks and actors
// ===========================================================================

/**
 * The TUI's injected clock.
 *
 * A fixed string. Every fixture that renders passes this, and `state.now` is compared
 * against it — a view model that read a clock itself would render a different `now`
 * than the state carries, which is exactly the assertion that catches it.
 */
export const TUI_NOW = "2026-04-01T12:00:00Z"

/** The actor recorded on a template capture. An identifier, never content. */
export const TUI_ACTOR = "user-operator-11"

/** The viewport minimum, so a fixture need not repeat the numbers. */
export const NARROW_VIEWPORT = { columns: 60, rows: 18 } as const

/** A comfortable viewport, for the tests that are not about fitting. */
export const WIDE_VIEWPORT = { columns: 120, rows: 40 } as const

// ===========================================================================
// The canary
// ===========================================================================

/**
 * The literal seeded into AUTHORED rule metadata.
 *
 * ADR 0007 section 12 PERMITS this on a rendered rule screen: a rule's name,
 * description and reason string are "rule metadata" and "reason strings authored by a
 * user for the purpose of explaining a decision". So the tests assert it APPEARS —
 * see the fixture's docblock for why that is the interesting assertion.
 */
export const CANARY = "CANARY-RULE-TUI-AUTHORED-METADATA"

/** A second authored-metadata canary, so a test can prove it reads a specific field. */
export const CANARY_SECONDARY = "CANARY-RULE-TUI-AUTHORED-REASON"

/**
 * The literal seeded into the fields a rule screen must NEVER render.
 *
 * Distinct from `CANARY`, which seeds authored metadata. A single literal across both
 * would make "the authored reason must render" and "no canary may render"
 * unsatisfiable together, and the pair of assertions is the point.
 */
export const CONTENT_CANARY = "CANARY-RULE-TUI-MUST-NOT-APPEAR-AT-ALL"

/**
 * Every canary a rule screen must NEVER render.
 *
 * The CONTENT canary only. The two authored-metadata canaries are deliberately
 * absent: they are values the ADR permits, and including them here would make the
 * no-leak assertion contradict the anti-vacuity assertion that they must appear.
 */
export const ALL_CANARIES: readonly string[] = [CONTENT_CANARY]

/**
 * An evaluation context with the content canary in every field that could carry it.
 *
 * Reuses `validContext` from the shared fixtures so the context is schema-valid and
 * only its CONTENT differs — a fixture that was also malformed would make a leak
 * assertion unfalsifiable.
 */
export function canaryContext(): RuleEvaluationContext {
  return validContext({
    taskTitle: CONTENT_CANARY,
    taskLabels: [CONTENT_CANARY],
    toolCategories: [CONTENT_CANARY],
    nodeAdvertisedCapabilities: [CONTENT_CANARY],
  })
}

// ===========================================================================
// Rule documents
// ===========================================================================

/**
 * A deny rule whose authored metadata is seeded with canaries.
 *
 * # WHY THE CANARY IS IN AUTHORED METADATA, AND WHY THAT IS THE POINT
 *
 * ADR 0007 section 12 permits a rendered rule screen to contain "rule metadata" and
 * "reason strings authored by a user for the purpose of explaining a decision". It
 * forbids prompt text, task descriptions, context manifest item content, memory
 * record content, capability payload bytes, terminal output, environment values and
 * credentials. So a rule's own `name`, `description` and `deny_with_reason` reason
 * are NOT leaks — they are exactly the values the section allows, and a screen that
 * hid them would be hiding the reason the rule exists.
 *
 * What must never appear is content from the OTHER sources. So this fixture seeds
 * canaries in BOTH places, and the tests assert the correct thing about each:
 *
 *   - The AUTHORED metadata must APPEAR. `tui.test.ts`'s "renders the rule's own
 *     authored metadata" test asserts it does, which is the anti-vacuity check that
 *     stops "no canary anywhere" from passing for a view model that renders nothing.
 *   - The CONTEXT content must NOT appear. `canaryContext()` seeds the task title,
 *     task labels, tool categories and node capabilities, and the tests assert the
 *     canary is absent from every screen. That is the actual ADR section 12 property.
 *
 * Seeding both with the same literal would make the two assertions contradict each
 * other, so the authored-metadata canary and the content canary are DISTINCT values
 * (`CANARY` and `CONTENT_CANARY`) and each test asserts against the right one.
 */
export function canaryDenyDocument(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return validRuleDocument({
    ruleId: "rule-canary",
    name: `deny deploys ${CANARY}`,
    description: `a rule about ${CANARY}`,
    predicates: [{ field: "roleId", operator: "eq", value: ROLE_ID }],
    actions: [{ kind: "deny_with_reason", reason: `deploys are frozen because ${CANARY_SECONDARY}` }],
    ...overrides,
  }) as unknown as Record<string, unknown>
}

/**
 * The content canary.
 *
 * Seeded into the fields a TUI must never render: the task title (which IS a task
 * description), the task labels, the tool categories and the node advertised
 * capabilities. This is the same set `tests/unit/rules/explain.test.ts` seeds, and
 * for the same reason.
 *


/** A pre-approval scoped to a project AND a capability: no danger, no refusal. */
export function cleanPreApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return preApprovalDocument({
    ruleId: "rule-clean-pre",
    predicates: [
      { field: "projectId", operator: "eq", value: PROJECT_ID },
      { field: "capability", operator: "any", value: ["fs.read"] },
    ],
    actions: [
      {
        kind: "pre_approve_within_bounds",
        approvedCapabilities: ["fs.read"],
        maximumTimeoutSeconds: 900,
        allowDestructiveEffects: false,
        allowExternalEffects: false,
        maximumSensitivity: "restricted",
      },
    ],
    expiresAt: "2026-12-01T00:00:00Z",
    ...overrides,
  }) as unknown as Record<string, unknown>
}

/**
 * A pre-approval scoped ONLY to a capability, so four of the five reach axes are
 * unconstrained.
 *
 * `roles`, `nodes`, `projects` and `projectPaths` will all render as
 * `UNKNOWN_REACH_TEXT`. This is the fixture the "unknown is not empty" test uses,
 * because a pre-approval constrained on exactly one axis is the case where the
 * difference between "matches everything" and "matches nothing" is most visible.
 *
 * It also carries `expiresAt: null`, so it is BOTH an unconstrained-reach fixture and
 * a no-expiry fixture. The two warnings are independent — a dated rule can have an
 * unbounded axis and an undated rule can be fully scoped — and the tests that need one
 * without the other override `expiresAt`.
 */
export function partiallyScopedPreApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return preApprovalDocument({
    ruleId: "rule-partial-pre",
    name: "pre-approve fs.read anywhere in this project",
    predicates: [{ field: "capability", operator: "any", value: ["fs.read"] }],
    expiresAt: null,
    ...overrides,
  }) as unknown as Record<string, unknown>
}

/**
 * A rule that PROVABLY shadows another.
 *
 * `rule-shadow-winner` has `all([])` as its predicate, which is top, and an action
 * set that is a superset of `rule-loser`'s. `evaluateRules` can therefore prove the
 * superset relation structurally on the normalized AST (ADR 0007 section 10.5), and
 * reports `shadowed` rather than `possible_overlap`.
 */
export function shadowingDocuments(): readonly Record<string, unknown>[] {
  return [
    validRuleDocument({
      ruleId: "rule-loser",
      name: "deny on one role",
      predicates: [{ field: "roleId", operator: "eq", value: ROLE_ID }],
      actions: [{ kind: "deny_with_reason", reason: "role is frozen" }],
    }) as unknown as Record<string, unknown>,
    validRuleDocument({
      ruleId: "rule-shadow-winner",
      name: "deny everywhere",
      predicates: [],
      actions: [{ kind: "deny_with_reason", reason: "everything is frozen" }],
    }) as unknown as Record<string, unknown>,
  ]
}

/**
 * Two rules whose superset relation CANNOT be proven, so the evaluator reports
 * `possible_overlap`.
 *
 * `all(roleId eq "a")` and `all(roleId eq "b")` are neither comparable as a superset
 * nor provably disjoint by the structural comparison, which is the condition
 * ADR 0007 section 10.5 names for `possible_overlap`.
 */
export function overlappingDocuments(): readonly Record<string, unknown>[] {
  return [
    validRuleDocument({
      ruleId: "rule-overlap-a",
      name: "deny role a",
      predicates: [{ field: "roleId", operator: "eq", value: "role-a" }],
      actions: [{ kind: "deny_with_reason", reason: "a is frozen" }],
    }) as unknown as Record<string, unknown>,
    validRuleDocument({
      ruleId: "rule-overlap-b",
      name: "deny role b",
      predicates: [{ field: "roleId", operator: "eq", value: "role-b" }],
      actions: [{ kind: "deny_with_reason", reason: "b is frozen" }],
    }) as unknown as Record<string, unknown>,
  ]
}

// ===========================================================================
// Compiling and previewing
// ===========================================================================

/** Compile documents, or throw. Fixtures must not produce a `Result`. */
export function compiledSetOf(documents: readonly unknown[]): CompiledRuleSet {
  const result = compileRuleSet(documents)
  if (!result.ok) throw new Error(`fixture did not compile: ${result.error.code} ${result.error.message}`)
  return result.value
}

/**
 * Preview a compiled set against one finished dispatch, or throw.
 *
 * `options.context` lets a caller supply the evaluation context the history entry is
 * PLAYED BACK against. That is not a preview option — `previewCompiledRuleSet` builds
 * its own contexts from the history entries, which by design carry no task title and
 * no tool categories (`src/rules/preview.ts`, `contextForEntry`). The parameter
 * exists so a leak test can prove the content canary never reaches the screen even
 * though it was present in the context the language evaluated, and so it is threaded
 * through a SEPARATE `evaluateRules` call whose result the view model never reads.
 *
 * The context is evaluated and its explanation rendered, then DISCARDED. The state
 * this feeds carries only the preview's own text. That is the property under test: a
 * rule screen's content must come from the preview, and the preview's own guarantees
 * are what make that safe.
 */
export function previewOf(
  documents: readonly unknown[],
  options: { readonly historyEntries?: readonly unknown[]; readonly context?: RuleEvaluationContext } = {},
): RulePreview {
  const compiled = compiledSetOf(documents)
  if (options.context !== undefined) {
    // Evaluate the canaried context so the literal genuinely travels through the
    // language, and assert here that the language itself refused to render it. If the
    // LANGUAGE leaked it, the view model's guarantee would be resting on a false
    // premise and this fixture would fail loudly instead.
    const result = evaluateRules(compiled, options.context)
    const encoded = canonicalJson({ ...result, explanationText: "" })
    if (encoded.includes(CONTENT_CANARY)) {
      throw new Error("the rule evaluator leaked seeded content; the TUI's no-leak assertion would be vacuous")
    }
  }
  const result = previewCompiledRuleSet(
    compiled,
    previewHistory({ finishedDispatches: options.historyEntries ?? [finishedEntry({ evaluatedAt: HISTORY_INSTANT })] }),
    previewOptions({ now: PREVIEW_NOW, actorId: TUI_ACTOR, activationConfirmed: true }),
  )
  if (!result.ok) throw new Error(`fixture did not preview: ${result.error.code} ${result.error.message}`)
  return result.value
}

/** The disclosure a preview built for a rule, or `null`. */
export function disclosureFor(preview: RulePreview, ruleId: string): PreApprovalDisclosure | null {
  return preview.preApprovalDisclosures.find((disclosure) => disclosure.ruleId === ruleId) ?? null
}

/** One preview entry by rule id. Throws when absent, so a fixture gap is loud. */
export function entryFor(preview: RulePreview, ruleId: string): RulePreviewEntry {
  const entry = preview.rules.find((candidate) => candidate.ruleId === ruleId)
  if (entry === undefined) throw new Error(`no preview entry for ${ruleId}`)
  return entry
}

// ===========================================================================
// TUI states
// ===========================================================================

/**
 * A TUI state with the supplied rule documents loaded.
 *
 * Goes through `previewCompiledRuleSet` and `builderRuleTuiRows` rather than
 * hand-building rows, so the rows a test asserts on are the rows the real pipeline
 * produces. A fixture that hand-wrote a row could assert anything about it.
 */
export function stateWithRules(
  documents: readonly unknown[],
  overrides: Partial<RuleTuiUiState> = {},
  options: { readonly historyEntries?: readonly unknown[]; readonly context?: RuleEvaluationContext } = {},
): RuleTuiUiState {
  const preview = previewOf(documents, options)
  const entries = preview.rules as readonly RuleTuiPreviewEntryShape[]
  return {
    ...initialRuleTuiState(TUI_NOW, WIDE_VIEWPORT),
    rows: builderRuleTuiRows(entries),
    previewEntries: entries,
    now: TUI_NOW,
    ...overrides,
  }
}

/**
 * A TUI state carrying the canary rule, with its raw, preview and explanation text.
 *
 * Built from a preview evaluated against `canaryContext()`'s CONTENT canary, so the
 * content canary has actually travelled through the compiler, the evaluator, the
 * preview and the explanation renderer before the view model ever sees it. A leak
 * assertion against a context that never reached the pipeline would be vacuous.
 *
 * The AUTHORED-metadata canaries are in the rule's own `name` and reason, which the
 * ADR permits on screen. The tests assert those APPEAR; see `canaryDenyDocument`.
 */
export function canaryState(): RuleTuiUiState {
  const preview = previewOf([canaryDenyDocument()], { context: canaryContext() })
  const compiled = compiledSetOf([canaryDenyDocument()])
  const entry = entryFor(preview, "rule-canary")
  return {
    ...initialRuleTuiState(TUI_NOW, WIDE_VIEWPORT),
    rows: builderRuleTuiRows(preview.rules as readonly RuleTuiPreviewEntryShape[]),
    previewEntries: preview.rules as readonly RuleTuiPreviewEntryShape[],
    now: TUI_NOW,
    // The raw document is what the raw screen shows: the exact JSON of the source
    // document the author wrote, which carries the authored-metadata canaries and NOT
    // the content canary (a rule document has no field for a task description).
    rawDocumentText: JSON.stringify(compiled.rules[0]?.source ?? {}, null, 2),
    previewText: preview.explanationText,
    explanationText: entry.matchedDispatchExplanation ?? "",
  }
}

/** The empty state, for the "nothing loaded" assertions. */
export function emptyState(overrides: Partial<RuleTuiUiState> = {}): RuleTuiUiState {
  return { ...initialRuleTuiState(TUI_NOW, WIDE_VIEWPORT), ...overrides }
}

// ===========================================================================
// Danger fixtures
// ===========================================================================

/**
 * A danger list with one flag of each class.
 *
 * Built by hand rather than derived, because a test that asserts "all four classes
 * are visible" must not be asserting on the same function that produces them — that
 * would pass even if the derivation were wrong in every class at once.
 */
export function allFourDangers(): readonly RuleTuiDanger[] {
  return [
    {
      kind: "unscoped_pre_approval",
      ruleId: "rule-d",
      templateVersion: 1,
      code: "rule.universal_pre_approval",
      subject: "pre_approve_within_bounds",
      detail: "carries a pre-approval and constrains no scope field",
    },
    {
      kind: "unconstrained_reach",
      ruleId: "rule-d",
      templateVersion: 1,
      code: null,
      subject: "projects",
      detail: "the predicate is unconstrained on projects",
    },
    {
      kind: "no_expiry",
      ruleId: "rule-d",
      templateVersion: 1,
      code: null,
      subject: "expiresAt",
      detail: "expiresAt is null, which renders as the literal no expiry",
    },
    {
      kind: "bounds_exceed_effective_budget",
      ruleId: "rule-d",
      templateVersion: 1,
      code: null,
      subject: "maximumTimeoutSeconds",
      detail: "the declared bound is wider than the budget in force",
    },
  ]
}

/** The unknown-reach literal, re-exported so a test does not hard-code `"unknown"`. */
export const UNKNOWN = UNKNOWN_REACH_TEXT
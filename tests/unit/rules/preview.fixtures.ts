/**
 * Fixtures for the M6.3 preview tests.
 *
 * WHY A SEPARATE FILE RATHER THAN MORE BUILDERS IN `./fixtures.ts`: the shared
 * fixtures build RULE DOCUMENTS and EVALUATION CONTEXTS, which are the language's
 * two entry points. A preview history entry is neither — it is a record of
 * something that already happened, and its whole purpose is to be a faithful
 * account of a past dispatch rather than a valid document. Conflating the two
 * would make it tempting to validate a history entry with the context schema,
 * which is the check this module explicitly must not make: the preview builds
 * the context, and the fields it fills in at their fail-closed values (no title,
 * no tool categories, no node capability snapshot, no budget in force) are
 * exactly the ones the context schema would have required.
 *
 * Every builder here returns a VALIDATED value where validation is possible, so
 * a fixture that has drifted out of the preview's own schema is a loud failure
 * at the first test that uses it rather than a refusal three layers up.
 *
 * `rawHistoryEntry` is the unvalidated counterpart, for the adversarial tests
 * that need an entry which is wrong in exactly one way.
 */

import { compileRuleSet, type CompiledRule, type CompiledRuleSet, type RuleSourceDocument } from "../../../src/rules/index.js"
import {
  finishedDispatchSummarySchema,
  proposalHistoryEntrySchema,
  rulePreviewHistorySchema,
  rulePreviewOptionsSchema,
  type FinishedDispatchSummary,
  type ProposalHistoryEntry,
  type RulePreviewHistory,
  type RulePreviewOptions,
} from "../../../src/rules/preview.js"
import { NODE_ID, PATH_ID, PROJECT_ID, ROLE_ID, USER_ID, preApprovalDocument, validRuleDocument } from "./fixtures.js"

// ===========================================================================
// Clocks and actors
// ===========================================================================

/**
 * The preview's injected clock: a Monday in March, well after every fixture's
 * `evaluatedAt` and after the window instant the shared fixtures use.
 *
 * A fixed string, never `Date.now()`. A fixture whose clock moved would make
 * "does a rule with no expiry still have no expiry" a test that passes in
 * February and fails in December.
 */
export const PREVIEW_NOW = "2026-03-02T09:00:00Z"

/** The instant every fixture history entry was evaluated at. */
export const HISTORY_INSTANT = "2026-02-02T12:00:00Z"

/** The actor asking for the preview. Rendered as an identifier, never as content. */
export const PREVIEW_ACTOR = "user-operator-7"

// ===========================================================================
// History
// ===========================================================================

/**
 * A history entry with every field the preview's shape carries, all populated.
 *
 * Populated rather than minimal so a test asserting "an absent `roleId` is
 * unsatisfied" is asserting the ABSENCE rather than the fact that the fixture
 * never had one. The four context fields the shape does NOT carry — task title,
 * tool categories, node capability snapshot, budget in force — are documented on
 * `historyEntryShape` in `src/rules/preview.ts`; there is no knob for them
 * here, and that is deliberate.
 */
export function rawHistoryEntry(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    dispatchId: "disp-1",
    runId: "run-1",
    taskId: "task-1",
    projectId: PROJECT_ID,
    roleId: ROLE_ID,
    roleVersion: 3,
    requestedCapabilities: ["fs.read", "net.fetch"],
    runtimeKind: "opencode",
    targetNodeId: NODE_ID,
    projectPathId: PATH_ID,
    taskLabels: ["release"],
    dependencyOutcomes: ["succeeded"],
    requestedFanOut: 2,
    requestedConcurrency: 2,
    requestedRetryLimit: 1,
    declaredTimeoutSeconds: 600,
    contextManifestSensitivity: "restricted",
    evaluatedAt: HISTORY_INSTANT,
    state: "completed",
    ...overrides,
  }
}

/** A validated proposed dispatch. */
export function proposalEntry(overrides: Partial<Record<string, unknown>> = {}): ProposalHistoryEntry {
  return proposalHistoryEntrySchema.parse(rawHistoryEntry(overrides))
}

/** A validated finished dispatch. */
export function finishedEntry(overrides: Partial<Record<string, unknown>> = {}): FinishedDispatchSummary {
  return finishedDispatchSummarySchema.parse(rawHistoryEntry({ state: "completed", ...overrides }))
}

/** A validated history, with both halves empty unless told otherwise. */
export function previewHistory(overrides: Partial<Record<string, unknown>> = {}): RulePreviewHistory {
  return rulePreviewHistorySchema.parse({ proposals: [], finishedDispatches: [], ...overrides })
}

/** A validated options object. `activationConfirmed` is TRUE unless overridden. */
export function previewOptions(overrides: Partial<Record<string, unknown>> = {}): RulePreviewOptions {
  return rulePreviewOptionsSchema.parse({ now: PREVIEW_NOW, actorId: PREVIEW_ACTOR, activationConfirmed: true, ...overrides })
}

// ===========================================================================
// Rule documents
// ===========================================================================

/**
 * A pre-approval that names a project AND a capability, so its disclosure has
 * one constrained reach axis and four `unknown` ones.
 *
 * `capability any ["fs.read"]` is what makes `reach.capabilities` a set rather
 * than `unknown`; the other four axes are unconstrained, which is the shape
 * ADR 0007 section 11 says must be said in words.
 */
export function scopedPreApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return preApprovalDocument({
    ruleId: "rule-pre-scoped",
    name: "pre-approve reads on one project",
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
        maximumFanOut: 4,
        maximumConcurrency: 2,
        maximumRetryLimit: 1,
        maximumSensitivity: "restricted",
      },
    ],
    ...overrides,
  })
}

/**
 * A pre-approval that names TWO projects, for the future-scope set assertion.
 *
 * `projectId in ["proj-1","proj-2"]` is the one case where the future scope is a
 * set of more than one member, so a test can tell "the rule named its projects"
 * from "the rule named nothing and the module invented a set".
 */
export function twoProjectPreApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return preApprovalDocument({
    ruleId: "rule-pre-two-projects",
    name: "pre-approve reads on two projects",
    predicates: [
      { field: "projectId", operator: "in", value: [PROJECT_ID, "proj-2"] },
      { field: "capability", operator: "any", value: ["fs.read"] },
    ],
    ...overrides,
  })
}

/**
 * A pre-approval whose ONLY scope predicate is a capability.
 *
 * The rule ADR 0007 section 8 requires to exist at all — at least one predicate
 * from the twelve non-universal fields — while being unconstrained on projects.
 * This is the fixture that proves an unconstrained axis is REPORTED rather than
 * rendered as an empty set.
 */
export function capabilityOnlyPreApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return preApprovalDocument({
    ruleId: "rule-pre-capability-only",
    name: "pre-approve reads anywhere they are asked for",
    predicates: [{ field: "capability", operator: "any", value: ["fs.read"] }],
    ...overrides,
  })
}

/** A deny rule with NO predicates: the universal predicate, `all([])`. */
export function universalDenyDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return validRuleDocument({
    ruleId: "rule-universal-deny",
    name: "deny everything",
    predicates: [],
    actions: [{ kind: "deny_with_reason", reason: "this project is frozen" }],
    ...overrides,
  })
}

/**
 * A deny rule scoped to one role: the rule the universal deny above PROVABLY
 * shadows, because `all([])` is top and a deny is a deny.
 */
export function roleDenyDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return validRuleDocument({
    ruleId: "rule-role-deny",
    name: "deny the reviewer role",
    predicates: [{ field: "roleId", operator: "eq", value: ROLE_ID }],
    actions: [{ kind: "deny_with_reason", reason: "reviewers may not dispatch" }],
    ...overrides,
  })
}

/** A deny rule scoped to two projects, for a conflict test. */
export function projectDenyDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return validRuleDocument({
    ruleId: "rule-project-deny",
    name: "deny project one",
    predicates: [{ field: "projectId", operator: "eq", value: PROJECT_ID }],
    actions: [{ kind: "deny_with_reason", reason: "project one is frozen" }],
    ...overrides,
  })
}

/** A pre-approval matching the same dispatch, so a deny and a grant conflict. */
export function conflictingPreApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return preApprovalDocument({
    ruleId: "rule-pre-conflict",
    name: "pre-approve reads on project one",
    predicates: [
      { field: "projectId", operator: "eq", value: PROJECT_ID },
      { field: "capability", operator: "any", value: ["fs.read"] },
    ],
    ...overrides,
  })
}

/**
 * A `require_approval` rule scoped to two projects.
 *
 * Pairs with `roleApprovalDocument` to produce a PROVABLE `possible_overlap`:
 * neither predicate is a proven superset of the other and the two are not
 * provably disjoint, so the evaluator may only report that they might co-match.
 */
export function scopeApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return validRuleDocument({
    ruleId: "rule-scope-approval",
    name: "ask before dispatching on two projects",
    predicates: [{ field: "projectId", operator: "in", value: [PROJECT_ID, "proj-2"] }],
    actions: [{ kind: "require_approval", requireApprovalForDispatch: true }],
    ...overrides,
  })
}

/**
 * A `require_approval` rule scoped to one role.
 *
 * The other half of the overlap pair. Deliberately a DIFFERENT field from
 * `scopeApprovalDocument`: two rules on the same axis with disjoint member sets
 * would be provably DISJOINT, and the evaluator reports that as a
 * `possible_overlap` for a different reason ("they cannot both match"). This
 * pair is the honest "we cannot tell" case, which is the one ADR 0007 section
 * 10.5 is about.
 */
export function roleApprovalDocument(overrides: Partial<Record<string, unknown>> = {}): RuleSourceDocument {
  return validRuleDocument({
    ruleId: "rule-role-approval",
    name: "ask before the reviewer role dispatches",
    predicates: [{ field: "roleId", operator: "eq", value: ROLE_ID }],
    actions: [{ kind: "require_approval", requireApprovalForDispatch: true }],
    ...overrides,
  })
}

// ===========================================================================
// Compilation
// ===========================================================================

/**
 * Compiles a set or THROWS.
 *
 * A fixture that fails to compile is a broken fixture, and a throw says so at
 * the line that built it rather than producing a `Result` every test would have
 * to unwrap before it could assert anything about the preview.
 */
export function setOf(documents: readonly unknown[]): CompiledRuleSet {
  const compiled = compileRuleSet(documents)
  if (!compiled.ok) throw new Error(`fixture failed to compile: ${compiled.error.code} ${compiled.error.message}`)
  return compiled.value
}

/** The single rule of a one-document set. */
export function onlyRule(documents: readonly unknown[]): CompiledRule {
  const rule = setOf(documents).rules[0]
  if (rule === undefined) throw new Error("expected exactly one compiled rule")
  return rule
}

export { NODE_ID, PATH_ID, PROJECT_ID, ROLE_ID, USER_ID }

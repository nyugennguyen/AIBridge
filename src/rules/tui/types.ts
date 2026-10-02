/**
 * M6.8 — the rule TUI's own vocabulary: screens, overlays, keys, actions, and
 * the state shape.
 *
 * # WHY A SEPARATE `types.ts` AND NOT A `types.ts` UNDER `src/tui/`
 *
 * ADR 0007 section 1 declares the dependency direction as strictly downward, and
 * `src/rules/` sits near the bottom: `rules -> orchestration,
 * mesh/protocol/safe-pattern, memory/ontology` and nothing else. `src/tui/` is a
 * CONSUMER of orchestration state, not a module `src/rules/` may reach upward
 * into. So this file declares its OWN screen/overlay/action unions, structurally
 * compatible with the shell's, and the shell maps them when it integrates.
 *
 * The compatibility claim is checked rather than asserted in prose. The tests
 * assign a value of every type declared here to the shell's corresponding slot,
 * which fails at compile time if either side changes shape. That is the same
 * structural-compatibility discipline `src/notifications/tui-adapter.ts` uses for
 * its `string | null` notice: `src/notifications/` declares the shape, `src/tui/`
 * imports it, and neither imports the other.
 *
 * `RULE_TUI_MINIMUM_COLUMNS` / `RULE_TUI_MINIMUM_ROWS` restate
 * `src/tui/types.ts:9-10`. Restated, NOT imported, for the direction reason
 * above, and `tests/unit/rules/tui.test.ts` asserts the two pairs are equal so
 * the restatement cannot drift into being a different minimum.
 *
 * # NAMED INVARIANTS
 *
 *   - **T1 — The clock is injected.** Every value that could be a time arrives
 *     as a parameter: `initialRuleTuiState(now)`, and `now` on the state. There is
 *     no `Date.now()`, no `new Date()` and no ambient clock anywhere in this
 *     directory, so two renders of the same state are byte-identical.
 *   - **T2 — Code-unit ordering, never `localeCompare`.** Every sorted
 *     collection in this directory goes through `compareCodeUnits` /
 *     `sortedRuleTuiStrings`, for the reason ADR 0007 section 10.2 gives: a rule
 *     set ordered by locale would evaluate differently on two machines.
 *   - **T3 — Exhaustive reducer.** `reduceRuleTui` switches over every member of
 *     `RuleTuiActionType` with NO `default` clause, so an action added later is a
 *     compile error rather than a keystroke that silently does nothing
 *     (`src/tui/state.ts:46-144`, `src/notifications/tui-adapter.ts:274`).
 *   - **T4 — The state is the only input to the view.** `buildRuleTuiView` reads
 *     the state and nothing else. It does not compile, evaluate, preview or read
 *     a clock, so a view is a pure function of what the reducer already decided.
 *   - **T5 — `unknown`, not `any`, on every caller-supplied payload.** A rule
 *     document, a preview history and a simulation result all arrive untrusted,
 *     and `unknown` is what makes the compiler (rather than this layer) the first
 *     thing that inspects them.
 *   - **T6 — Structurally declared ports.** `src/simulation/` does not exist yet
 *     and `src/workflows/` may not be imported from `src/rules/`
 *     (`tests/unit/workflows/barrel.test.ts:63`), so both are declared as
 *     structural interfaces here rather than imported. See the simulation section
 *     of `index.ts` for the exact symbols to wire.
 *   - **T7 — No secrets.** Nothing in this directory renders prompt text, task
 *     descriptions, context manifest content, memory record content, capability
 *     payload bytes, terminal output, environment values or credentials
 *     (ADR 0007 section 12). Every rendered value comes from a compiled rule, a
 *     preview, a disclosure, an explanation, or a constant declared here.
 *
 * # STOP CONDITIONS
 *
 *   - **S-RT1 — If the view needs a value the preview does not carry, add it to
 *     `RulePreviewEntry` in `src/rules/preview.ts` deliberately.** The tempting
 *     alternative is to derive it here from the evaluation context, and that is a
 *     second source of truth for a safety screen.
 *   - **S-RT2 — If a screen needs to WRITE anything, return an intent rather than
 *     performing the write.** `routeRuleTuiKey` returns `RuleTuiIntent`; the
 *     caller performs repository writes. A presentation layer that wrote would
 *     make its own tests unable to reach a state without a side effect.
 *   - **S-RT3 — If `shadowed` and `possible_overlap` ever seem like one field,
 *     stop.** ADR 0007 section 10.5: conflating them trains the user to ignore
 *     the field, and the one time it mattered would be the time they ignored it.
 */

import { z } from "zod"

// ===========================================================================
// Screens and overlays
// ===========================================================================

/**
 * The eight screens.
 *
 * `list` is the entry point; `detail` is one rule; `raw` is the exact stored
 * document; `preview` is `previewCompiledRuleSet`'s output for the set;
 * `builder` is the authoring surface; `templates` is the reusable-template
 * capture; `simulation` is the dry run; `conflicts` is the conflict/shadowing
 * report.
 */
export const RULE_TUI_SCREENS = [
  "list",
  "detail",
  "raw",
  "preview",
  "builder",
  "templates",
  "simulation",
  "conflicts",
] as const
export type RuleTuiScreen = (typeof RULE_TUI_SCREENS)[number]

/**
 * Overlays. Four of the five exist because a keystroke on this screen can change
 * what a dispatch is allowed to do.
 *
 * `activation-confirm` and `dangerous-warning` are separate on purpose: the first
 * asks "did you mean to enable this", the second says "this rule is dangerous in
 * a specific named way". A user who confirmed an activation without having read
 * the warning has confirmed nothing.
 */
export const RULE_TUI_OVERLAYS = ["none", "help", "activation-confirm", "dangerous-warning", "discard-confirm"] as const
export type RuleTuiOverlay = (typeof RULE_TUI_OVERLAYS)[number]

// ===========================================================================
// Viewport
// ===========================================================================

/**
 * The viewport minimum this directory is written against.
 *
 * Restated from `src/tui/types.ts:9-10` rather than imported, for the direction
 * reason in the module docblock (T6). The values are asserted equal to the
 * shell's in `tests/unit/rules/tui.test.ts`; a restatement that silently became
 * a different minimum would make the narrow-viewport test assert the wrong thing.
 */
export const RULE_TUI_MINIMUM_COLUMNS = 60
export const RULE_TUI_MINIMUM_ROWS = 18

/** Terminal size. Structurally `src/tui/types.ts`'s `TuiDimensions`. */
export const ruleTuiDimensionsSchema = z
  .object({
    columns: z.number().int().positive().safe(),
    rows: z.number().int().positive().safe(),
  })
  .strict()
export type RuleTuiDimensions = z.infer<typeof ruleTuiDimensionsSchema>

// ===========================================================================
// Ordering helpers (T2)
// ===========================================================================

/** UTF-16 code-unit comparison. Never `localeCompare`. */
export function compareRuleTuiCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

/** Sorted and de-duplicated by code unit (T2). */
export function sortedRuleTuiStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareRuleTuiCodeUnits)
}

// ===========================================================================
// Dangerous-rule warnings
// ===========================================================================

/**
 * The closed vocabulary of danger classes.
 *
 * Four, and each names a DIFFERENT failure mode with a DIFFERENT remediation, so
 * collapsing them would produce a warning a user cannot act on:
 *
 *   - `unscoped_pre_approval` — a pre-approval with no scope field. The compiler
 *     refuses this at document level (`rule.universal_pre_approval`), so the flag
 *     is how the builder shows the refusal BEFORE the user submits.
 *   - `unconstrained_reach` — an axis the predicate leaves unbounded. The literal
 *     shown is `UNKNOWN_REACH_TEXT`, never an empty set (ADR 0007 section 11).
 *   - `no_expiry` — `pre_approve_within_bounds` with `expiresAt: null`. ADR 0007
 *     section 9: "no expiry" remains `null` and is warned about.
 *   - `bounds_exceed_effective_budget` — a declared bound wider than the budget
 *     actually in force. ADR 0007 section 11 requires the DECLARED bound on the
 *     disclosure, which is exactly why the mismatch has to be named.
 */
export const RULE_TUI_DANGER_KINDS = [
  "unscoped_pre_approval",
  "unconstrained_reach",
  "no_expiry",
  "bounds_exceed_effective_budget",
] as const
export type RuleTuiDangerKind = (typeof RULE_TUI_DANGER_KINDS)[number]

/**
 * One warning, STRUCTURALLY typed.
 *
 * `code` is the refusal code when the danger is a compiler refusal and `null`
 * when it is a property of a document that compiled. That distinction is load
 * bearing: a user who is told "the compiler refused this" and a user who is told
 * "this compiles and is still dangerous" need different words, and a single
 * string field would force one of them to be wrong.
 */
export const ruleTuiDangerSchema = z
  .object({
    kind: z.enum(RULE_TUI_DANGER_KINDS),
    ruleId: z.string(),
    templateVersion: z.number().int().positive().safe(),
    /** The compiler's own code, verbatim, when there is one. */
    code: z.string().nullable(),
    /**
     * For `unconstrained_reach`, the axis name. For
     * `bounds_exceed_effective_budget`, the budget member. Otherwise `null`.
     */
    subject: z.string().nullable(),
    /** The operator-facing sentence. Never contains rule content (T7). */
    detail: z.string(),
  })
  .strict()
export type RuleTuiDanger = z.infer<typeof ruleTuiDangerSchema>

// ===========================================================================
// The builder draft
// ===========================================================================

/**
 * What the keyboard builder is editing.
 *
 * A draft, NOT a `RuleSourceDocument`: the fields are the ones an author fills in
 * incrementally, and the values are held as authored strings/booleans so a
 * half-finished rule can be on screen. `assembleRuleDocument` in `builder.ts`
 * turns a draft into the exact document `compileRule` is handed, and the
 * COMPILER decides whether it is acceptable — the builder never second-guesses it
 * (see `builder.ts`'s "no second validator" invariant).
 *
 * `activation` starts as `draft` and is NOT editable in this milestone. Turning a
 * draft into an activated rule is the dangerous path, and it goes through the
 * activation-confirm overlay rather than through a builder field, because a
 * builder field would make activation a keystroke away from a value edit.
 */
export const ruleTuiBuilderDraftSchema = z
  .object({
    ruleId: z.string(),
    templateVersion: z.number().int().positive().safe(),
    projectId: z.string(),
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    expiresAt: z.string().nullable(),
    authorKind: z.enum(["user", "node", "service"]),
    authorId: z.string(),
    createdAt: z.string(),
    predicateField: z.string(),
    predicateOperator: z.string(),
    predicateValue: z.string(),
    predicateNote: z.string(),
    actionKind: z.string(),
    actionValue: z.string(),
    /** Which list the focus is on: the predicate list or the action list. */
    focus: z.enum(["metadata", "predicate", "action"]),
    /** Index within the focused list. */
    cursor: z.number().int().min(0).safe(),
  })
  .strict()
export type RuleTuiBuilderDraft = z.infer<typeof ruleTuiBuilderDraftSchema>

// ===========================================================================
// Ports to modules this layer may not import (T6)
// ===========================================================================

/**
 * What the simulation screen reports back.
 *
 * # WHY THIS IS DECLARED HERE AND NOT IMPORTED FROM `src/simulation/`
 *
 * `src/simulation/` EXISTS as of the last commit before this file was written, but
 * ADR 0007 section 1 declares the edge as `simulation -> rules`, never the reverse,
 * and `tests/unit/workflows/barrel.test.ts:63` already shows how this repo settles a
 * disallowed edge: by source scan, over every file under `src/`. So `src/rules/tui/`
 * may not import it, and a structural declaration is the only honest port.
 *
 * The reasoning is `src/context/isolation.ts:94-122`'s, which
 * `src/rules/preview.ts`'s `RulePreviewAuditInput` restates for the same module: a
 * port typed as the real interface could be re-shaped by a change to the module it
 * names, and the thing being protected here is a SAFETY screen's reading of a dry
 * run. A structural port can only be satisfied by a value that genuinely has these
 * fields.
 *
 * # THE FIELDS ARE CHOSEN TO MATCH WHAT `DryRunPlan` ACTUALLY CARRIES
 *
 * Read against `src/simulation/plan.ts`'s `DryRunPlan` rather than guessed:
 *
 *   - `ruleSetDigest` is `DryRunPlan.ruleSetDigest`, copied verbatim.
 *   - `dispatchIds` is the `dispatches[].dispatchId` set, sorted and de-duplicated.
 *   - `decisions[].outcome` is derived from the dispatch's own evaluation: a rejection
 *     with `reasonCode === "rule.denied"` is `deny`, one with an approval requirement is
 *     `require_approval`, and a dispatch with neither is `allow`. `unknown` is reserved
 *     for a dispatch the plan did not decide, so "the simulation had nothing to say"
 *     is a value rather than a silent omission.
 *   - `decisions[].explanation` is `renderRuleExplanation`'s output for that dispatch —
 *     the SAME renderer the rest of this directory consumes, never a second one.
 *   - `warnings` is `DryRunPlan.warnings`, whose `detail` strings are the module's own
 *     and are already free of content by the simulator's I2 invariant.
 *
 * TODO(M6.8-INTEGRATION): when the shell wires the simulation screen, it maps a
 * `DryRunPlan` onto this interface at ONE place — the `request-simulation` intent
 * handler named in `index.ts` — and dispatches `simulation-reported`. The exact symbols
 * to use are `buildDryRunPlan` / `dryRunPlan` in `src/simulation/plan.ts` and
 * `SimulationRequest` from `src/simulation/types.js`. Delete this comment and keep the
 * interface: it is the boundary, and the shell's adapter is the only thing that should
 * know `DryRunPlan`'s shape.
 */
export interface RuleTuiSimulationReport {
  /** `ruleSetDigest` of the set that was simulated. Proves which set was run. */
  readonly ruleSetDigest: string
  /** The dispatch ids the simulation decided about, sorted and de-duplicated. */
  readonly dispatchIds: readonly string[]
  /** Per dispatch: the outcome the simulation predicted. */
  readonly decisions: readonly {
    readonly dispatchId: string
    /** `allow`, `require_approval`, `deny`, or `unknown`. */
    readonly outcome: "allow" | "require_approval" | "deny" | "unknown"
    /** Rule ids that determined the outcome, sorted and de-duplicated. */
    readonly ruleIds: readonly string[]
    /** `renderRuleExplanation`-shaped text, or `null` when none was rendered. */
    readonly explanation: string | null
  }[]
  /** What the simulation could not determine. Never an empty string for silence. */
  readonly warnings: readonly string[]
}

/**
 * The template-capture port.
 *
 * `src/workflows/` may not be imported from `src/rules/` — ADR 0007 section 1
 * declares `workflows -> rules` and not the reverse, and
 * `tests/unit/workflows/barrel.test.ts:63` enforces it by source scan. So the
 * capture goes out as a plain value and the CALLER performs the write, which is
 * also the correct direction for a presentation layer (S-RT2).
 *
 * The value is shaped like `RunTemplateInput`'s identity and binding members, so
 * the integration is a field-by-field mapping rather than a redesign.
 */
export interface RuleTuiTemplateCapture {
  readonly templateId: string
  readonly projectId: string
  readonly name: string
  readonly description: string
  /** The rule set's digest. A template names a rule set by DIGEST, never by document. */
  readonly ruleSetDigest: string
  /** The rule identities captured, sorted and de-duplicated. */
  readonly ruleIdentities: readonly string[]
  /** The actor. Shape-compatible with `src/orchestration/schemas.ts`'s actor. */
  readonly author: { readonly kind: "user" | "node" | "service"; readonly id: string }
  /** Injected clock reading. NEVER a `Date.now()` inside the capture. */
  readonly createdAt: string
  /** The workflow steps a template carries. Empty here; the caller supplies them. */
  readonly steps: readonly { readonly stepId: string }[]
}

// ===========================================================================
// State
// ===========================================================================

/**
 * One rule as the TUI lists it.
 *
 * Every field a test needs is STRUCTURAL. There is deliberately no `summary`
 * string here even though `src/context/tui/memory-view.ts` has one, because this
 * list's whole job is to be asserted on: a pre-rendered row would let a test
 * pass on `toContain("unconstrained on projects")` without the row actually
 * carrying an unconstrained axis.
 */
export interface RuleTuiRuleRow {
  readonly ruleId: string
  readonly templateVersion: number
  /** `ruleId@templateVersion`. The identity a disclosure is keyed by. */
  readonly identity: string
  readonly projectId: string
  readonly name: string
  readonly enabled: boolean
  readonly activationState: string
  readonly activatedAt: string | null
  readonly activatedBy: string | null
  /** The timestamp, or the literal `no_expiry` text when there is none. */
  readonly expiresAt: string | null
  readonly expiresAtLabel: string
  readonly matchOutcome: string | null
  readonly matchedHistoryCount: number
  readonly normalizedPredicate: string
  readonly digest: string
  readonly actionKinds: readonly string[]
  readonly hasPreApproval: boolean
  readonly activationRequired: boolean
  /** Axis NAMES the predicate does not constrain, sorted. */
  readonly unconstrainedAxes: readonly string[]
  /** Reach axes whose value is `UNKNOWN_REACH_TEXT`, in the disclosure's order. */
  readonly unconstrainedReachAxes: readonly string[]
  readonly conflictCount: number
  /** Proven `shadowed` findings only. Never mixed with `possibleOverlapCount`. */
  readonly shadowedCount: number
  /** Unproven co-match findings. Never mixed with `shadowedCount` (ADR 10.5). */
  readonly possibleOverlapCount: number
  readonly warnings: readonly string[]
  readonly dangers: readonly RuleTuiDanger[]
}

/** One reach axis, as the row and the detail screen carry it. */
export interface RuleTuiReachAxisView {
  readonly name: string
  /** `true` when the value is the literal `UNKNOWN_REACH_TEXT`. */
  readonly unknown: boolean
  /** The values. EMPTY when `unknown` is true, and never read as "matches nothing". */
  readonly values: readonly string[]
  readonly sources: readonly string[]
}

/**
 * The `RulePreviewEntry` fields this layer reads, declared STRUCTURALLY.
 *
 * Not `import type { RulePreviewEntry }`, for the reason
 * `src/context/isolation.ts:94-122` gives: a port typed against the concrete
 * interface is re-shaped by a change to that interface, and the rows a safety screen
 * renders are exactly what must not shift under a change to the module that feeds it.
 * Naming only the fields read means a new field on `RulePreviewEntry` is simply not
 * rendered — visible — rather than silently changing what a row means.
 *
 * Every field named here is one `RulePreviewEntry` carries, so a real entry
 * satisfies this without a cast.
 */
export interface RuleTuiPreviewEntryShape {
  readonly ruleId: string
  readonly templateVersion: number
  readonly projectId: string
  readonly name: string
  readonly enabled: boolean
  readonly author: string
  readonly activation: {
    readonly state: string
    readonly activatedAt: string | null
    readonly activatedBy: string | null
  }
  readonly expiresAt: string | null
  readonly normalizedPredicate: string
  readonly digest: string
  readonly matchOutcome: string | null
  readonly matchedHistoryCount: number
  readonly actionKinds: readonly string[]
  readonly hasPreApproval: boolean
  readonly activationRequired: boolean
  readonly conflicts: readonly { readonly kind: string; readonly ruleIds: readonly string[]; readonly detail: string }[]
  readonly shadowing: readonly {
    readonly relation: "shadowed" | "possible_overlap"
    readonly proven: boolean
    readonly otherRuleId: string
    readonly direction: "shadowed_by" | "shadows"
    readonly reason: string
    readonly detail: string
  }[]
  readonly warnings: readonly string[]
  readonly futureScope: {
    readonly projectIds: readonly string[] | "unknown"
    readonly roles: readonly string[] | "unknown"
    readonly capabilities: readonly string[] | "unknown"
    readonly nodes: readonly string[] | "unknown"
    readonly projectPaths: readonly string[] | "unknown"
  }
  readonly unconstrainedAxes: readonly string[]
}

/** One conflict, structured. */
export interface RuleTuiConflictView {
  readonly kind: string
  readonly ruleIds: readonly string[]
  readonly detail: string
}

/**
 * One shadowing finding.
 *
 * `relation` is carried through from `RulePreviewShadowing.relation` and is NEVER
 * widened to a boolean. `proven` is derived from it, never analysed separately
 * (S-RT3).
 */
export interface RuleTuiShadowView {
  readonly relation: "shadowed" | "possible_overlap"
  readonly proven: boolean
  readonly otherRuleId: string
  readonly direction: "shadowed_by" | "shadows"
  readonly reason: string
  readonly detail: string
}

// ===========================================================================
// Actions
// ===========================================================================

export type RuleTuiAction =
  // --- intake: values the CALLER supplies, never a keystroke ---------------
  | {
      readonly type: "rule-set-loaded"
      readonly rows: readonly RuleTuiRuleRow[]
      /**
       * The preview entries the rows were built from, kept so the conflicts screen
       * derives from the SAME values rather than from a second findings array the
       * caller assembles. Two arrays would be two places where `shadowed` and
       * `possible_overlap` are told apart (S-RT3).
       */
      readonly previewEntries: readonly RuleTuiPreviewEntryShape[]
      readonly now: string
    }
  | { readonly type: "preview-loaded"; readonly previewText: string }
  | { readonly type: "raw-loaded"; readonly documentText: string }
  | { readonly type: "explanation-loaded"; readonly explanationText: string }
  | { readonly type: "builder-loaded"; readonly draft: RuleTuiBuilderDraft }
  | { readonly type: "builder-edited"; readonly draft: RuleTuiBuilderDraft }
  | { readonly type: "compile-result"; readonly codes: readonly string[]; readonly messages: readonly string[] }
  | { readonly type: "templates-loaded"; readonly captures: readonly RuleTuiTemplateCapture[] }
  | { readonly type: "simulation-reported"; readonly report: RuleTuiSimulationReport | null }
  | { readonly type: "notice"; readonly message: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "clear-error" }
  // --- navigation ----------------------------------------------------------
  | { readonly type: "navigate"; readonly screen: RuleTuiScreen }
  | { readonly type: "set-overlay"; readonly overlay: RuleTuiOverlay }
  | { readonly type: "dismiss-overlay" }
  | { readonly type: "toggle-help" }
  | { readonly type: "set-confirmation-armed"; readonly armed: boolean }
  | { readonly type: "move"; readonly delta: number }
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "scroll"; readonly delta: number }
  // --- enable/disable ------------------------------------------------------
  | { readonly type: "request-enable-change" }
  | { readonly type: "apply-enable-change" }
  // --- activation ----------------------------------------------------------
  | { readonly type: "request-activation" }
  | { readonly type: "confirm-activation" }
  | { readonly type: "confirm-danger" }
  // --- builder -------------------------------------------------------------
  | { readonly type: "builder-focus"; readonly focus: RuleTuiBuilderDraft["focus"] }
  | { readonly type: "builder-move"; readonly delta: number }
  | {
      readonly type: "builder-set-field"
      readonly field: RuleTuiBuilderField
      readonly value: string
      /**
       * How the value is applied.
       *
       * `append` is what a printable keypress does, `backspace` removes the last
       * character, and `replace` sets the whole value. All three go through the same
       * action because they are the same OPERATION — write a value into a field —
       * and three actions for one operation would let the reducer grow three
       * subtly different copies of the field switch.
       */
      readonly mode: "replace" | "append" | "backspace"
    }
  | { readonly type: "builder-toggle-enabled" }
  | { readonly type: "builder-add-predicate" }
  | { readonly type: "builder-remove-predicate" }
  | { readonly type: "builder-add-action" }
  | { readonly type: "builder-remove-action" }
  | { readonly type: "builder-cycle-predicate-field" }
  | { readonly type: "builder-cycle-predicate-operator" }
  | { readonly type: "builder-cycle-action-kind" }
  | { readonly type: "builder-cycle-focus" }
  | { readonly type: "builder-abandon" }
  // --- templates / simulation ---------------------------------------------
  | { readonly type: "request-template-capture" }
  | { readonly type: "request-simulation" }
  // --- discard -------------------------------------------------------------
  | { readonly type: "request-discard" }
  | { readonly type: "confirm-discard" }

/**
 * The declared action list.
 *
 * Declared so a caller can enumerate what a keystroke can produce without
 * reading the reducer, and so a new action is a compile error in
 * `reduceRuleTui` until it is listed here (T3).
 */
export const RULE_TUI_ACTIONS = [
  "rule-set-loaded",
  "preview-loaded",
  "raw-loaded",
  "explanation-loaded",
  "builder-loaded",
  "builder-edited",
  "compile-result",
  "templates-loaded",
  "simulation-reported",
  "notice",
  "error",
  "clear-error",
  "navigate",
  "set-overlay",
  "dismiss-overlay",
  "toggle-help",
  "set-confirmation-armed",
  "move",
  "select",
  "scroll",
  "request-enable-change",
  "apply-enable-change",
  "request-activation",
  "confirm-activation",
  "confirm-danger",
  "builder-focus",
  "builder-move",
  "builder-set-field",
  "builder-toggle-enabled",
  "builder-add-predicate",
  "builder-remove-predicate",
  "builder-add-action",
  "builder-remove-action",
  "builder-cycle-predicate-field",
  "builder-cycle-predicate-operator",
  "builder-cycle-action-kind",
  "builder-cycle-focus",
  "builder-abandon",
  "request-template-capture",
  "request-simulation",
  "request-discard",
  "confirm-discard",
] as const
export type RuleTuiActionType = (typeof RULE_TUI_ACTIONS)[number]

/**
 * The subset of actions a KEYSTROKE produces.
 *
 * Split from the full list because the intake actions above are VALUES a caller
 * supplies — a compiled rule set, a preview, a template list — and no keystroke
 * can produce them. `tests/unit/rules/tui-keyboard.test.ts` asserts this list is
 * exactly the set of action types `routeRuleTuiKey` can return a dispatch for,
 * which is the property that makes "keyboard-only" checkable rather than a claim.
 */
export const RULE_TUI_KEY_PRODUCED_ACTIONS = [
  "navigate",
  "dismiss-overlay",
  "toggle-help",
  "set-confirmation-armed",
  "move",
  "select",
  "scroll",
  "request-enable-change",
  "apply-enable-change",
  "request-activation",
  "confirm-activation",
  "confirm-danger",
  "builder-move",
  "builder-set-field",
  "builder-toggle-enabled",
  "builder-add-predicate",
  "builder-remove-predicate",
  "builder-add-action",
  "builder-remove-action",
  "builder-cycle-predicate-field",
  "builder-cycle-predicate-operator",
  "builder-cycle-action-kind",
  "builder-cycle-focus",
  "builder-abandon",
  "request-template-capture",
  "request-simulation",
  "request-discard",
  "confirm-discard",
] as const
export type RuleTuiKeyProducedActionType = (typeof RULE_TUI_KEY_PRODUCED_ACTIONS)[number]

/**
 * The actions NO key produces, and why each is here.
 *
 * Declared rather than left implicit, because `RULE_TUI_KEY_PRODUCED_ACTIONS` is
 * asserted to be exactly the set `routeRuleTuiKey` can return a dispatch for — so an
 * action in neither list would be one nothing could ever cause.
 *
 *   - `builder-focus` is the DIRECT form (`focus: "predicate"`) and no key names a
 *     focus target. `tab` produces `builder-cycle-focus`, which advances through them
 *     in order; a key that jumped straight to one would make the cycle's position
 *     meaningless. A caller that needs to set focus directly (a test, or a shell that
 *     wants to restore it) dispatches this.
 *   - `set-overlay` is the same direct form for overlays, for the same reason: `?`
 *     produces `toggle-help` and every dialog has a key of its own.
 *   - Everything else in this list is an INTAKE action — a value the CALLER supplies,
 *     which is why `initialRuleTuiState` cannot produce them either.
 */
export const RULE_TUI_NON_KEY_ACTIONS = [
  "set-overlay",
  "builder-focus",
  "rule-set-loaded",
  "preview-loaded",
  "raw-loaded",
  "explanation-loaded",
  "builder-loaded",
  "builder-edited",
  "compile-result",
  "templates-loaded",
  "simulation-reported",
  "notice",
  "error",
  "clear-error",
] as const

/** The builder's editable text fields, as a closed vocabulary. */
export const RULE_TUI_BUILDER_FIELDS = [
  "ruleId",
  "templateVersion",
  "projectId",
  "name",
  "description",
  "predicateValue",
  "predicateNote",
  "actionValue",
] as const
export type RuleTuiBuilderField = (typeof RULE_TUI_BUILDER_FIELDS)[number]

// ===========================================================================
// State
// ===========================================================================

export interface RuleTuiUiState {
  readonly screen: RuleTuiScreen
  readonly overlay: RuleTuiOverlay
  /** The injected clock reading (T1). */
  readonly now: string
  readonly dimensions: RuleTuiDimensions
  readonly rows: readonly RuleTuiRuleRow[]
  /**
   * The preview entries the rows came from.
   *
   * Held alongside `rows` rather than being re-supplied as a findings array, so the
   * conflicts screen and the list screen describe the same rule set from one set of
   * values (S-RT3).
   */
  readonly previewEntries: readonly RuleTuiPreviewEntryShape[]
  readonly selectedIndex: number
  readonly scrollOffset: number
  /**
   * `true` only after the user has moved focus onto the confirm control.
   *
   * Same discipline as `src/tui/types.ts:60` and `src/tui/state.ts:113-114`: a
   * destructive dialog opens UNARMED, and the confirm key does nothing until a
   * focus move has armed it. A dialog whose confirm button is live the instant it
   * opens is a dialog where Enter-through-past is an activation.
   */
  readonly confirmationArmed: boolean
  /** The row whose enable flag the next `apply-enable-change` would flip. */
  readonly pendingEnableChange: { readonly ruleId: string; readonly templateVersion: number; readonly toEnabled: boolean } | null
  /** The rule awaiting activation confirmation. */
  readonly pendingActivation: { readonly ruleId: string; readonly templateVersion: number } | null
  /** The builder draft, or `null` before one is opened. */
  readonly draft: RuleTuiBuilderDraft | null
  /** Predicate field names currently in the draft, in declaration order. */
  readonly draftPredicates: readonly string[]
  /** Action kinds currently in the draft, in declaration order. */
  readonly draftActions: readonly string[]
  /** Refusal codes from the last `compileRule`, verbatim and in order. */
  readonly compileCodes: readonly string[]
  /** Refusal messages from the last `compileRule`, index-aligned with the codes. */
  readonly compileMessages: readonly string[]
  /** True when the last compile SUCCEEDED. */
  readonly compiled: boolean
  readonly rawDocumentText: string
  readonly previewText: string
  readonly explanationText: string
  readonly templateCaptures: readonly RuleTuiTemplateCapture[]
  readonly simulationReport: RuleTuiSimulationReport | null
  /** A template capture the caller is expected to persist. Never performed here (S-RT2). */
  readonly pendingTemplateCapture: RuleTuiTemplateCapture | null
  /** A simulation the caller is expected to run. Never performed here (S-RT2). */
  readonly pendingSimulationRequest: { readonly ruleSetDigest: string; readonly now: string } | null
  /** Non-sensitive status, shaped like `TuiUiState.notice` but owned here. */
  readonly notice: string | null
  readonly error: string | null
}

// ===========================================================================
// Keys and intents
// ===========================================================================

/**
 * A keystroke.
 *
 * `text` is the literal character for a printable key and `undefined` for a
 * control key. The builder needs it: a keyboard-only authoring surface with no
 * way to type a character is not an authoring surface. `paste` is refused with a
 * reason rather than accepted, because a paste into a rule predicate is a paste
 * of unvalidated text into a document the compiler will hash.
 */
export type RuleTuiKey =
  | { readonly type: "key"; readonly name: string; readonly ctrl?: boolean; readonly shift?: boolean; readonly text?: string }
  | { readonly type: "paste"; readonly text: string }

/**
 * The key arm of `RuleTuiKey`.
 *
 * Split out because `routeRuleTuiKey` refuses a paste before any other handling, so
 * every screen router downstream only ever sees a key. Naming the narrowed shape
 * means those functions read `key.name` without a discriminant check they do not
 * need, and a screen router cannot be handed a paste by accident.
 */
export type RuleTuiNamedKey = Extract<RuleTuiKey, { readonly type: "key" }>

export type RuleTuiIntent =
  | { readonly type: "none" }
  | { readonly type: "close" }
  | { readonly type: "dispatch"; readonly action: RuleTuiAction }
  | { readonly type: "reject"; readonly reason: string }
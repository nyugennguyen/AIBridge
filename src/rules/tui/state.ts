/**
 * M6.8 — the rule TUI's state, its reducer and its key routing.
 *
 * # WHY THE STATE CARRIES VALUES RATHER THAN DERIVING THEM
 *
 * `src/context/tui/memory-view.ts` filters in its REDUCER and renders in its view
 * model, for the stated reason: "what is on screen" must be a function of
 * `(state, manifest)` with no I/O. This module is the reducer half of that split,
 * and it is also where the three things that CANNOT be derived land:
 *
 *   1. The compiled rule rows. They come from `compileRuleSet` and
 *      `previewCompiledRuleSet`, both of which the caller runs. This module stores
 *      what they produced and never re-derives it, so there is one preview per
 *      rule set rather than one per render.
 *   2. The builder draft. Editing it is a keystroke, and a keystroke cannot run the
 *      compiler without making the reducer do IO.
 *   3. The refusal codes. `compileBuilderDocument` is called by the CALLER and its
 *      answer arrives as `compile-result`. If the reducer called the compiler
 *      itself, `reduceRuleTui` would stop being a pure function of its arguments
 *      and the determinism test would be asserting something the code does not
 *      guarantee.
 *
 * # NAMED INVARIANTS
 *
 *   - **T1 — The clock is injected.** `now` is set once by
 *     `initialRuleTuiState(now)` and thereafter only changed by an action that
 *     carries one. No `Date.now()`, no `new Date()`.
 *   - **T3 — Exhaustive reducer, no `default`.** `reduceRuleTui` switches over
 *     every `RuleTuiActionType`. An action added without a case is a compile error
 *     here rather than a keystroke that silently does nothing.
 *   - **R1 — Activation requires an ARMED confirmation.** `confirm-activation` is
 *     ignored unless `overlay === "activation-confirm"` AND
 *     `confirmationArmed === true`. Both conditions, because the overlay opens
 *     unarmed and arming is a separate deliberate keystroke. This is
 *     `src/tui/types.ts:60`'s `confirmationArmed` applied to a rule: a pre-approval
 *     is the one action in this screen that can grant without a dispatch-time
 *     approval, so it must not be one Enter-press away.
 *   - **R2 — The dangerous-warning overlay is not skippable.** A rule with any
 *     danger flag cannot leave the `dangerous-warning` overlay except through
 *     `confirm-danger`, and `confirm-danger` does not itself activate. Activation
 *     from that overlay is a SECOND armed confirmation, which is the point: reading
 *     the warning and agreeing to it are two acts.
 *   - **R3 — An enable/disable change is explicit and states its target.** A toggle
 *     is two steps: `request-enable-change` records WHAT would change
 *     (`pendingEnableChange`), and `apply-enable-change` is what emits it. There is
 *     no single keystroke that flips a flag, because the flag decides whether a
 *     dispatch is evaluated at all.
 *   - **R4 — No writes.** The reducer never touches a repository. Effects leave as
 *     `pendingActivation`, `pendingTemplateCapture` and `pendingSimulationRequest`,
 *     which the caller reads and acts on (S-RT2).
 *   - **R5 — Purity and totality.** Same `(state, action)` gives the same state,
 *     with no clock, no randomness and no IO. The `50`-iteration determinism test in
 *     `tests/unit/rules/tui.test.ts` is what makes this checkable.
 *
 * # STOP CONDITIONS
 *
 *   - **S-ST1 — If a keystroke needs authorization to do anything, return
 *     `reject` with a reason rather than `none`.** A keystroke that silently does
 *     nothing is worse than one that says why (`memory-view.ts`'s S13,
 *     `tui-adapter.ts`'s S13).
 *   - **S-ST2 — If a new screen needs new state, add the field here and add a row to
 *     the help overlay.** A screen whose state lives in a closure would make the
 *     view model's purity untestable.
 */

import {
  RULE_TUI_BUILDER_FIELDS,
  type RuleTuiAction,
  type RuleTuiBuilderDraft,
  type RuleTuiBuilderField,
  type RuleTuiDimensions,
  type RuleTuiIntent,
  type RuleTuiKey,
  type RuleTuiNamedKey,
  type RuleTuiOverlay,
  type RuleTuiRuleRow,
  type RuleTuiScreen,
  type RuleTuiUiState,
} from "./types.js"
import {
  appendToBuilderField,
  backspaceBuilderField,
  captureRuleSetAsTemplate,
  defaultActionValueFor,
  defaultPredicateValueFor,
  nextActionKind,
  nextPredicateField,
  nextPredicateOperator,
  withBuilderField,
} from "./builder.js"

// ===========================================================================
// Initial state
// ===========================================================================

/**
 * The initial state.
 *
 * `now` and `dimensions` are parameters (T1, R5). Everything else is a stated
 * default rather than a lazily-computed one: `rows: []` means "no rule set has
 * been loaded", which the view renders as a distinct message rather than as an
 * empty list, and `compiled: false` means "the candidate has not been compiled
 * yet", which is a different fact from "the candidate compiles".
 *
 * `overlay: "none"` and `confirmationArmed: false` are the safest pair available:
 * no dialog is open, and if one opens it opens unarmed.
 */
export function initialRuleTuiState(now: string, dimensions: RuleTuiDimensions): RuleTuiUiState {
  return {
    screen: "list",
    overlay: "none",
    now,
    dimensions,
    rows: [],
    previewEntries: [],
    selectedIndex: 0,
    scrollOffset: 0,
    confirmationArmed: false,
    pendingEnableChange: null,
    pendingActivation: null,
    draft: null,
    draftPredicates: [],
    draftActions: [],
    compileCodes: [],
    compileMessages: [],
    compiled: false,
    rawDocumentText: "",
    previewText: "",
    explanationText: "",
    templateCaptures: [],
    simulationReport: null,
    pendingTemplateCapture: null,
    pendingSimulationRequest: null,
    notice: null,
    error: null,
  }
}

/** Clamp an index into `[0, length - 1]`, or `0` for an empty collection. */
function clampIndex(index: number, length: number): number {
  if (length === 0) return 0
  return Math.max(0, Math.min(index, length - 1))
}

/** The row the selection is on, or `null`. */
function selectedRow(state: RuleTuiUiState): RuleTuiRuleRow | null {
  return state.rows[clampIndex(state.selectedIndex, state.rows.length)] ?? null
}

/**
 * Does the selected row carry at least one danger flag?
 *
 * Read from the row rather than recomputed from the rule, because the row's
 * `dangers` is what the screen SHOWS. A confirmation gate keyed off a recomputed
 * answer and a screen keyed off the row would be two answers to one question, and
 * the day they disagreed the gate would be open while the warning was showing.
 */
function selectedRowIsDangerous(state: RuleTuiUiState): boolean {
  return (selectedRow(state)?.dangers.length ?? 0) > 0
}

// ===========================================================================
// Reducer (T3, R1..R5)
// ===========================================================================

/**
 * Pure state transition.
 *
 * Exhaustive over `RuleTuiActionType` with NO `default` clause (T3), and free of
 * any effect (R4). The cases that "cannot happen" return the state unchanged and
 * say so in a comment, rather than being silently swallowed — a case that returns
 * the state is still an exhaustive case, so the exhaustiveness check still fires
 * when a new action appears.
 */
export function reduceRuleTui(state: RuleTuiUiState, action: RuleTuiAction): RuleTuiUiState {
  switch (action.type) {
    // --- intake -----------------------------------------------------------
    case "rule-set-loaded":
      return {
        ...state,
        rows: action.rows,
        previewEntries: action.previewEntries,
        selectedIndex: 0,
        scrollOffset: 0,
        now: action.now,
        error: null,
      }
    case "preview-loaded":
      return { ...state, previewText: action.previewText }
    case "raw-loaded":
      return { ...state, rawDocumentText: action.documentText }
    case "explanation-loaded":
      return { ...state, explanationText: action.explanationText }
    case "builder-loaded":
      return {
        ...state,
        draft: action.draft,
        draftPredicates: [],
        draftActions: [],
        compileCodes: [],
        compileMessages: [],
        compiled: false,
        error: null,
      }
    case "builder-edited":
      // An edit invalidates the last compile answer. Leaving the old codes on screen
      // after an edit would be showing a refusal for a document the user has
      // already changed, which is the same class of lie as a stale preview.
      return { ...state, draft: action.draft, compileCodes: [], compileMessages: [], compiled: false }
    case "compile-result":
      return {
        ...state,
        compileCodes: action.codes,
        compileMessages: action.messages,
        compiled: action.codes.length === 0,
        error: null,
      }
    case "templates-loaded":
      return { ...state, templateCaptures: action.captures }
    case "simulation-reported":
      return { ...state, simulationReport: action.report }
    case "notice":
      return { ...state, notice: action.message, error: null }
    case "error":
      return { ...state, error: action.message, notice: null }
    case "clear-error":
      return { ...state, error: null }

    // --- navigation -------------------------------------------------------
    case "navigate":
      return {
        ...state,
        screen: action.screen,
        overlay: "none",
        confirmationArmed: false,
        scrollOffset: 0,
        pendingEnableChange: null,
        pendingActivation: null,
      }
    case "set-overlay":
      // Opening an overlay DISARMS it (R1). `src/tui/state.ts:113` does the same for
      // the shell's confirmation dialogs, and the reason is the same: a dialog whose
      // confirm control is live on the frame it appears cannot be read before it is
      // accepted.
      return { ...state, overlay: action.overlay, confirmationArmed: false, scrollOffset: 0 }
    case "dismiss-overlay":
      return {
        ...state,
        overlay: "none",
        confirmationArmed: false,
        // A dismissed activation request is a CANCELLED activation request. Leaving
        // `pendingActivation` set would let a caller that reads it after the overlay
        // closed perform an activation the user backed out of.
        pendingActivation: null,
        pendingEnableChange: null,
        scrollOffset: 0,
      }
    case "toggle-help":
      return { ...state, overlay: state.overlay === "help" ? "none" : "help", confirmationArmed: false }
    case "set-confirmation-armed":
      // Arming is only meaningful while a dialog is open. With no overlay it is a
      // no-op rather than a stored `true` that a later overlay would inherit.
      return state.overlay === "none" ? state : { ...state, confirmationArmed: action.armed }
    case "move":
      // A staged enable change is dropped for the same reason `select` drops it: the
      // staged change names a rule by identity, and after a move the selection is a
      // different rule — so applying it would change a rule the user was not looking
      // at when they staged it.
      return {
        ...state,
        selectedIndex: clampIndex(state.selectedIndex + action.delta, state.rows.length),
        scrollOffset: 0,
        pendingEnableChange: null,
      }
    case "select":
      return {
        ...state,
        selectedIndex: clampIndex(action.index, state.rows.length),
        scrollOffset: 0,
        pendingEnableChange: null,
      }
    case "scroll":
      return { ...state, scrollOffset: Math.max(0, state.scrollOffset + action.delta) }

    // --- enable/disable (R3) ----------------------------------------------
    case "request-enable-change": {
      const row = selectedRow(state)
      if (row === null) return state
      return {
        ...state,
        pendingEnableChange: {
          ruleId: row.ruleId,
          templateVersion: row.templateVersion,
          toEnabled: !row.enabled,
        },
        notice: `Rule '${row.identity}' would be ${row.enabled ? "disabled" : "enabled"}; nothing has changed yet.`,
      }
    }
    case "apply-enable-change": {
      const pending = state.pendingEnableChange
      if (pending === null) return state
      // The change is reported to the caller through the notice rather than applied
      // to `rows` here: `rows` is the CALLER's compiled output, and a reducer that
      // edited it would be holding a rule set the caller never compiled (R4). The
      // caller performs the write and dispatches `rule-set-loaded` with the result.
      return {
        ...state,
        pendingEnableChange: null,
        notice: `Rule '${pending.ruleId}@${pending.templateVersion}' was submitted to be ${pending.toEnabled ? "enabled" : "disabled"}.`,
      }
    }

    // --- activation (R1, R2) ----------------------------------------------
    case "request-activation": {
      const row = selectedRow(state)
      if (row === null) return state
      // A dangerous rule routes through the warning overlay FIRST. The two overlays
      // are separate because they ask different questions, and the dangerous one
      // additionally records which classes of danger were seen.
      const overlay: RuleTuiOverlay = row.dangers.length > 0 ? "dangerous-warning" : "activation-confirm"
      return {
        ...state,
        overlay,
        confirmationArmed: false,
        pendingActivation: { ruleId: row.ruleId, templateVersion: row.templateVersion },
        scrollOffset: 0,
      }
    }
    case "confirm-danger": {
      // Reading the warning is not agreeing to activate. Moving from the warning to
      // the activation dialog DISARMS the dialog, so agreeing requires the arming
      // keystroke as well (R2).
      if (state.overlay !== "dangerous-warning") return state
      return { ...state, overlay: "activation-confirm", confirmationArmed: false, scrollOffset: 0 }
    }
    case "confirm-activation": {
      // BOTH conditions (R1). Armed alone is not enough, because a caller could set
      // the flag while no dialog was open; the overlay alone is not enough, because
      // a dialog that opens already armed can be accepted by one Enter.
      if (state.overlay !== "activation-confirm") return state
      if (!state.confirmationArmed) return state
      const pending = state.pendingActivation
      if (pending === null) return state
      return {
        ...state,
        overlay: "none",
        confirmationArmed: false,
        notice: `Activation of '${pending.ruleId}@${pending.templateVersion}' was confirmed and is waiting on the caller to perform it.`,
      }
    }

    // --- builder ----------------------------------------------------------
    case "builder-focus": {
      if (state.draft === null) return state
      return { ...state, draft: { ...state.draft, focus: action.focus, cursor: 0 } }
    }
    case "builder-move": {
      if (state.draft === null) return state
      const length = builderListLength(state)
      return { ...state, draft: { ...state.draft, cursor: clampIndex(state.draft.cursor + action.delta, length) } }
    }
    case "builder-set-field": {
      const draft = state.draft
      if (draft === null) return state
      // Editing invalidates the last compile answer, so the codes are cleared here
      // rather than in a follow-up action. Leaving them would show a refusal for a
      // document the user has already changed.
      return {
        ...state,
        draft: applyBuilderFieldEdit(draft, action.field, action.value, action.mode),
        compileCodes: [],
        compileMessages: [],
        compiled: false,
      }
    }
    case "builder-toggle-enabled": {
      if (state.draft === null) return state
      return { ...state, draft: { ...state.draft, enabled: !state.draft.enabled }, compileCodes: [], compileMessages: [], compiled: false }
    }
    case "builder-add-predicate": {
      if (state.draft === null) return state
      // Adding a predicate also SEEDS a legal value for the chosen field, for the
      // reason `defaultPredicateValueFor`'s docblock gives: the draft holds one value
      // slot, so a value typed for `projectId` would otherwise be narrowed for
      // `fanOut` and refused for a reason the author never caused. This seeds the
      // STARTING POINT; `builder-set-field` still writes anything and the compiler
      // still decides.
      return {
        ...state,
        draftPredicates: [...state.draftPredicates, state.draft.predicateField],
        draft: { ...state.draft, predicateValue: defaultPredicateValueFor(state.draft.predicateField) },
        compileCodes: [], compileMessages: [], compiled: false,
      }
    }
    case "builder-remove-predicate": {
      if (state.draft === null) return state
      const last = state.draftPredicates.length - 1
      if (last < 0) return state
      return { ...state, draftPredicates: state.draftPredicates.slice(0, last), compileCodes: [], compileMessages: [], compiled: false }
    }
    case "builder-add-action": {
      if (state.draft === null) return state
      // Seeds a legal value for the chosen kind, for the reason
      // `defaultActionValueFor`'s docblock gives. Each action kind declares a
      // different shape, so there is no single default that would be legal for all six.
      return {
        ...state,
        draftActions: [...state.draftActions, state.draft.actionKind],
        draft: { ...state.draft, actionValue: defaultActionValueFor(state.draft.actionKind) },
        compileCodes: [], compileMessages: [], compiled: false,
      }
    }
    case "builder-remove-action": {
      if (state.draft === null) return state
      const last = state.draftActions.length - 1
      if (last < 0) return state
      return { ...state, draftActions: state.draftActions.slice(0, last), compileCodes: [], compileMessages: [], compiled: false }
    }
    case "builder-cycle-predicate-field": {
      if (state.draft === null) return state
      return {
        ...state,
        draft: { ...state.draft, predicateField: nextPredicateField(state.draft.predicateField, 1) },
        compileCodes: [], compileMessages: [], compiled: false,
      }
    }
    case "builder-cycle-predicate-operator": {
      if (state.draft === null) return state
      return {
        ...state,
        draft: {
          ...state.draft,
          predicateOperator: nextPredicateOperator(state.draft.predicateField, state.draft.predicateOperator, 1),
        },
        compileCodes: [], compileMessages: [], compiled: false,
      }
    }
    case "builder-cycle-action-kind": {
      if (state.draft === null) return state
      return { ...state, draft: { ...state.draft, actionKind: nextActionKind(state.draft.actionKind, 1) }, compileCodes: [], compileMessages: [], compiled: false }
    }
    case "builder-cycle-focus": {
      if (state.draft === null) return state
      const focus = nextBuilderFocus(state.draft.focus)
      return { ...state, draft: { ...state.draft, focus, cursor: 0 }, compileCodes: [], compileMessages: [], compiled: false }
    }
    case "builder-abandon": {
      if (state.draft === null) return state
      return {
        ...state,
        draft: null,
        draftPredicates: [],
        draftActions: [],
        compileCodes: [],
        compileMessages: [],
        compiled: false,
        screen: "list",
        overlay: "none",
        confirmationArmed: false,
      }
    }

    // --- templates / simulation (R4) -------------------------------------
    case "request-template-capture": {
      // The capture is computed HERE and stored as a pending VALUE (R4). It names
      // the set by digest and by sorted identities and carries no document, no
      // predicate text and no content, which is why a presentation layer can
      // produce it without importing `src/workflows/`.
      //
      // `=== undefined` and not `=== null`: indexing an empty readonly array yields
      // `undefined`, and a `=== null` guard would let it through and read a property
      // off it.
      const first = state.rows[0]
      if (first === undefined) return state
      const capture = captureRuleSetAsTemplate({
        templateId: `rules-${first.projectId}`,
        projectId: first.projectId,
        name: `${first.projectId} rule set`,
        ruleSetDigest: first.digest,
        ruleIdentities: state.rows.map((row) => row.identity),
        author: { kind: "user", id: "rule-tui-operator" },
        // The injected clock (T1). Never a read here.
        now: state.now,
      })
      return { ...state, pendingTemplateCapture: capture }
    }
    case "request-simulation": {
      // Same `=== undefined` guard as the capture above: an empty row list has no
      // first element, and there is no rule set to simulate against.
      const first = state.rows[0]
      if (first === undefined) return state
      // The REQUEST, not the run. The caller runs it and dispatches
      // `simulation-reported`; this module never imports `src/simulation/`, which
      // does not exist yet (types.ts T6).
      return { ...state, pendingSimulationRequest: { ruleSetDigest: first.digest, now: state.now } }
    }

    // --- discard ----------------------------------------------------------
    case "request-discard": {
      // A discard with nothing to discard is not a dialog. Opening an armed-by-
      // accident confirm for an already-empty builder would be a dialog whose only
      // possible outcome is "yes, discard nothing".
      if (state.draft === null) return state
      return { ...state, overlay: "discard-confirm", confirmationArmed: false, scrollOffset: 0 }
    }
    case "confirm-discard": {
      if (state.overlay !== "discard-confirm") return state
      if (!state.confirmationArmed) return state
      return {
        ...state,
        overlay: "none",
        confirmationArmed: false,
        draft: null,
        draftPredicates: [],
        draftActions: [],
        compileCodes: [],
        compileMessages: [],
        compiled: false,
      }
    }
  }
}

/** The length of the list the draft's focus is on. */
function builderListLength(state: RuleTuiUiState): number {
  if (state.draft === null) return 0
  switch (state.draft.focus) {
    case "metadata":
      return RULE_TUI_BUILDER_FIELDS.length
    case "predicate":
      return state.draftPredicates.length
    case "action":
      return state.draftActions.length
  }
}

/** The three focus targets, in the order `builder-cycle-focus` walks them. */
const BUILDER_FOCUS_ORDER: readonly RuleTuiBuilderDraft["focus"][] = ["metadata", "predicate", "action"]

/** The next focus target, wrapping. Mirrors `nextInCycle` in `builder.ts`. */
export function nextBuilderFocus(current: RuleTuiBuilderDraft["focus"]): RuleTuiBuilderDraft["focus"] {
  const index = BUILDER_FOCUS_ORDER.indexOf(current)
  return BUILDER_FOCUS_ORDER[(index + 1) % BUILDER_FOCUS_ORDER.length] ?? current
}

// ===========================================================================
// Key routing (S-ST1)
// ===========================================================================

/** The screens a key navigates to from the list, in a fixed table. */
const LIST_SCREEN_KEYS: Readonly<Record<string, RuleTuiScreen>> = Object.freeze({
  d: "detail",
  r: "raw",
  p: "preview",
  b: "builder",
  t: "templates",
  s: "simulation",
  c: "conflicts",
})

/**
 * Route one keystroke.
 *
 * Pure, and with no access to a repository or a renderer (R4). An `enter` on a
 * selection is a `dispatch`; an `enter` on a dangerous rule opens the warning; and
 * anything that would need authority to do anything comes back as `reject` with a
 * reason rather than as `none` (S-ST1).
 *
 * Two behaviours are worth naming:
 *
 *   - `confirm-activation` is only ever routed from the `activation-confirm`
 *     overlay, and only when the state says it is armed. The router CHECKS the
 *     arming as well as dispatching the action, so the guard exists in two places:
 *     the router refuses to emit the action, and the reducer ignores it if it
 *     arrives anyway. One guard would be a guard that could be bypassed by a caller
 *     that dispatched the action directly.
 *   - A paste is refused with a reason rather than accepted. A paste into a rule
 *     predicate is unvalidated text entering a document the compiler will hash, and
 *     "the paste was silently dropped" is indistinguishable from "the paste did
 *     nothing".
 */
export function routeRuleTuiKey(state: RuleTuiUiState, key: RuleTuiKey): RuleTuiIntent {
  if (key.type === "paste") {
    return { type: "reject", reason: "pasted text is not accepted on the rule screen; a rule predicate is a value the compiler validates, and a paste bypasses the keystroke-by-keystroke review that makes an authored value reviewable" }
  }
  return routeNamedKey(state, key)
}

/**
 * Everything after the paste refusal.
 *
 * Split out so the paste arm is handled ONCE, at the boundary, and every screen
 * router below is written against the narrowed key type rather than re-checking a
 * discriminant it can never see the other arm of.
 */
function routeNamedKey(state: RuleTuiUiState, key: RuleTuiNamedKey): RuleTuiIntent {
  if (key.ctrl === true && key.name.toLowerCase() === "c") return { type: "close" }
  if (key.name === "f1" || key.name === "?") {
    return { type: "dispatch", action: { type: "toggle-help" } }
  }

  if (state.overlay !== "none") {
    return routeOverlayKey(state, key)
  }

  if (key.name === "escape") {
    if (state.screen === "list") return { type: "none" }
    return { type: "dispatch", action: { type: "navigate", screen: "list" } }
  }

  switch (state.screen) {
    case "list":
      return routeListKey(state, key)
    case "detail":
      return routeDetailKey(state, key)
    case "raw":
      return routeScrollKey(state, key)
    case "preview":
      return routeScrollKey(state, key)
    case "builder":
      return routeBuilderKey(state, key)
    case "templates":
      return routeTemplatesKey(state, key)
    case "simulation":
      return routeSimulationKey(state, key)
    case "conflicts":
      return routeConflictsKey(state, key)
  }
}

/** Keys while a dialog is open. The dialog owns every key except help. */
function routeOverlayKey(state: RuleTuiUiState, key: RuleTuiNamedKey): RuleTuiIntent {
  if (key.name === "escape") return { type: "dispatch", action: { type: "dismiss-overlay" } }
  switch (state.overlay) {
    case "none":
    case "help":
      return { type: "none" }
    case "dangerous-warning": {
      // Reading the warning and agreeing to it are two acts (R2). `enter` on the
      // warning moves to the activation dialog, unarmed; it does not activate.
      if (key.name === "enter" || key.name === "right" || key.name === "l") {
        return { type: "dispatch", action: { type: "confirm-danger" } }
      }
      return { type: "none" }
    }
    case "activation-confirm": {
      // Arm first. `tab` or `right` moves focus onto the confirm control; only then
      // does `enter` mean anything (R1).
      if (key.name === "tab" || key.name === "right" || key.name === "l") {
        return { type: "dispatch", action: { type: "set-confirmation-armed", armed: true } }
      }
      if (key.name === "enter") {
        if (!state.confirmationArmed) {
          return { type: "reject", reason: "the activation dialog is not armed; move focus onto the confirm control first" }
        }
        return { type: "dispatch", action: { type: "confirm-activation" } }
      }
      return { type: "none" }
    }
    case "discard-confirm": {
      if (key.name === "tab" || key.name === "right" || key.name === "l") {
        return { type: "dispatch", action: { type: "set-confirmation-armed", armed: true } }
      }
      if (key.name === "enter") {
        if (!state.confirmationArmed) {
          return { type: "reject", reason: "the discard dialog is not armed; move focus onto the confirm control first" }
        }
        return { type: "dispatch", action: { type: "confirm-discard" } }
      }
      return { type: "none" }
    }
  }
}

/** The list screen. */
function routeListKey(state: RuleTuiUiState, key: RuleTuiNamedKey): RuleTuiIntent {
  if (key.name === "j" || key.name === "down") return { type: "dispatch", action: { type: "move", delta: 1 } }
  if (key.name === "k" || key.name === "up") return { type: "dispatch", action: { type: "move", delta: -1 } }
  if (key.name === "g") return { type: "dispatch", action: { type: "select", index: 0 } }
  if (key.name === "G") return { type: "dispatch", action: { type: "select", index: Math.max(0, state.rows.length - 1) } }
  const screen = LIST_SCREEN_KEYS[key.name]
  if (screen !== undefined) return { type: "dispatch", action: { type: "navigate", screen } }
  return { type: "none" }
}

/** The detail screen, where the two enabling actions live. */
function routeDetailKey(state: RuleTuiUiState, key: RuleTuiNamedKey): RuleTuiIntent {
  if (key.name === "j" || key.name === "down") return { type: "dispatch", action: { type: "move", delta: 1 } }
  if (key.name === "k" || key.name === "up") return { type: "dispatch", action: { type: "move", delta: -1 } }
  if (key.name === "e") return { type: "dispatch", action: { type: "request-enable-change" } }
  if (key.name === "E") return { type: "dispatch", action: { type: "apply-enable-change" } }
  if (key.name === "a") return { type: "dispatch", action: { type: "request-activation" } }
  return { type: "none" }
}

/** The raw and preview screens scroll only. */
function routeScrollKey(state: RuleTuiUiState, key: RuleTuiNamedKey): RuleTuiIntent {
  if (key.name === "j" || key.name === "down") return { type: "dispatch", action: { type: "scroll", delta: 1 } }
  if (key.name === "k" || key.name === "up") return { type: "dispatch", action: { type: "scroll", delta: -1 } }
  return { type: "none" }
}

/**
 * The builder screen.
 *
 * Every draft operation is here. A screen whose operations needed the mouse would
 * not be keyboard-only, so there is no operation in this module that a key cannot
 * reach — and `tests/unit/rules/tui-keyboard.test.ts` drives this function to prove
 * it rather than reading the table.
 */
function routeBuilderKey(state: RuleTuiUiState, key: RuleTuiNamedKey): RuleTuiIntent {
  if (state.draft === null) return { type: "none" }
  if (key.name === "tab") return { type: "dispatch", action: { type: "builder-cycle-focus" } }
  if (key.name === "j" || key.name === "down") return { type: "dispatch", action: { type: "builder-move", delta: 1 } }
  if (key.name === "k" || key.name === "up") return { type: "dispatch", action: { type: "builder-move", delta: -1 } }
  if (key.name === "space") return { type: "dispatch", action: { type: "builder-toggle-enabled" } }
  if (key.name === "n") return { type: "dispatch", action: { type: "builder-add-predicate" } }
  if (key.name === "N") return { type: "dispatch", action: { type: "builder-remove-predicate" } }
  if (key.name === "a") return { type: "dispatch", action: { type: "builder-add-action" } }
  if (key.name === "A") return { type: "dispatch", action: { type: "builder-remove-action" } }
  if (key.name === "f") return { type: "dispatch", action: { type: "builder-cycle-predicate-field" } }
  if (key.name === "o") return { type: "dispatch", action: { type: "builder-cycle-predicate-operator" } }
  if (key.name === "c") return { type: "dispatch", action: { type: "builder-cycle-action-kind" } }
  if (key.name === "w") return { type: "dispatch", action: { type: "builder-abandon" } }
  if (key.name === "x") return { type: "dispatch", action: { type: "request-discard" } }
  if (key.name === "backspace") {
    return {
      type: "dispatch",
      action: { type: "builder-set-field", field: focusedBuilderField(state), value: "", mode: "backspace" },
    }
  }
  // A printable character types into the focused text field. Without this the
  // builder has no way to author a value at all, and "keyboard-only" would be true
  // only of the navigation.
  if (key.text !== undefined && key.text.length === 1) {
    return {
      type: "dispatch",
      action: { type: "builder-set-field", field: focusedBuilderField(state), value: key.text, mode: "append" },
    }
  }
  return { type: "none" }
}

/**
 * The text field the builder's focus is on.
 *
 * Metadata focus walks `RULE_TUI_BUILDER_FIELDS` by the draft's cursor; the
 * predicate and action lists have one editable value each, so both focus targets
 * resolve to their own single field. The cursor is clamped against the list length
 * by `builder-move`, so an out-of-range cursor cannot index past the array.
 */
export function focusedBuilderField(state: RuleTuiUiState): RuleTuiBuilderField {
  const draft = state.draft
  if (draft === null) return "name"
  switch (draft.focus) {
    case "predicate":
      return "predicateValue"
    case "action":
      return "actionValue"
    case "metadata":
      return RULE_TUI_BUILDER_FIELDS[clampIndex(draft.cursor, RULE_TUI_BUILDER_FIELDS.length)] ?? "name"
  }
}

/** The templates screen. */
function routeTemplatesKey(state: RuleTuiUiState, key: RuleTuiNamedKey): RuleTuiIntent {
  if (key.name === "n") return { type: "dispatch", action: { type: "request-template-capture" } }
  if (key.name === "j" || key.name === "down") return { type: "dispatch", action: { type: "scroll", delta: 1 } }
  if (key.name === "k" || key.name === "up") return { type: "dispatch", action: { type: "scroll", delta: -1 } }
  return { type: "none" }
}

/** The simulation screen. */
function routeSimulationKey(state: RuleTuiUiState, key: RuleTuiNamedKey): RuleTuiIntent {
  if (key.name === "enter" || key.name === "r") return { type: "dispatch", action: { type: "request-simulation" } }
  if (key.name === "j" || key.name === "down") return { type: "dispatch", action: { type: "scroll", delta: 1 } }
  if (key.name === "k" || key.name === "up") return { type: "dispatch", action: { type: "scroll", delta: -1 } }
  return { type: "none" }
}

/** The conflicts screen moves the rule selection and scrolls the finding list. */
function routeConflictsKey(state: RuleTuiUiState, key: RuleTuiNamedKey): RuleTuiIntent {
  if (key.name === "j" || key.name === "down") return { type: "dispatch", action: { type: "move", delta: 1 } }
  if (key.name === "k" || key.name === "up") return { type: "dispatch", action: { type: "move", delta: -1 } }
  if (key.name === "J") return { type: "dispatch", action: { type: "scroll", delta: 1 } }
  if (key.name === "K") return { type: "dispatch", action: { type: "scroll", delta: -1 } }
  return { type: "none" }
}

/**
 * Apply one edit to a draft field.
 *
 * Delegates to `builder.ts`'s three field functions rather than switching on the
 * field name a SECOND time. The switch over `RuleTuiBuilderField` exists once, in
 * `withBuilderField`; a second copy here would be a second place where "which field
 * is this" is decided, and the two would disagree about a field added later.
 */
function applyBuilderFieldEdit(
  draft: RuleTuiBuilderDraft,
  field: RuleTuiBuilderField,
  value: string,
  mode: "replace" | "append" | "backspace",
): RuleTuiBuilderDraft {
  if (mode === "replace") return withBuilderField(draft, field, value)
  if (mode === "append") return appendToBuilderField(draft, field, value)
  return backspaceBuilderField(draft, field)
}
/**
 * M6.8 — the rule TUI's view model.
 *
 * # WHY A STRUCTURE AND NOT A RENDERED STRING
 *
 * The decision `src/context/tui/memory-view.ts` records, for its reasons:
 * "a string can only be asserted on with `toContain`, which cannot distinguish
 * 'the reason is prohibition' from 'the reason is a bullet that happens to mention a
 * prohibited record'". Every rule screen here is a SAFETY screen, and every safety
 * screen is one where "the test passed but for the wrong reason" is the failure that
 * ships. So `buildRuleTuiView` returns a STRUCTURE and `lines` is a derived member
 * assigned last, exactly as `memory-view.ts` and `src/notifications/tui-adapter.ts`
 * do.
 *
 * Concretely: `RuleTuiDanger` is four typed fields, not a sentence. A test asserts
 * `danger.kind === "unconstrained_reach"` and `danger.subject === "projects"`, which
 * no `toContain` can do — a warning string that mentions "projects" for a different
 * reason would satisfy a substring assertion about the warning.
 *
 * # WHAT THIS MODULE CONSUMES, AND WHAT IT MUST NOT
 *
 * Consumes, and does not reimplement: `buildPreApprovalDisclosure`'s
 * `PreApprovalDisclosure`, `renderRuleExplanation`'s text, `UNKNOWN_REACH_TEXT`,
 * and `previewCompiledRuleSet`'s per-rule findings. There is no second renderer and
 * no second disclosure here. `RuleTuiShadowView.relation` is carried through from
 * `RulePreviewShadowing.relation` unchanged, and `proven` is derived from it rather
 * than analysed (ADR 0007 section 10.5, S-RT3).
 *
 * Does NOT compute: whether a rule matches a dispatch, what its reach is, what its
 * bounds are, whether two rules shadow. Those are the compiler's, the evaluator's,
 * the preview's and the disclosure's answers, and this module reports what they said.
 *
 * # THE NARROW VIEWPORT
 *
 * `lines` is rendered in full and `state.scrollOffset` selects a window, so a long
 * preview does not get truncated with the warning block discarded — the warnings are
 * at the TOP of the render, before any scrolling content, which is what
 * `tests/unit/rules/tui.test.ts`'s narrow-viewport test asserts by scrolling until
 * every warning line has been visible at least once. A renderer that truncated the
 * output to the viewport would make the warning block the thing that disappears.
 *
 * # NAMED INVARIANTS
 *
 *   - **T1 — The clock is injected.** `now` arrives on the state. Nothing here reads
 *     a clock.
 *   - **T2 — Code-unit ordering.** Every sorted collection goes through
 *     `sortedRuleTuiStrings`. Never `localeCompare`.
 *   - **T4 — The state is the only input.** `buildRuleTuiView` reads the state and
 *     nothing else: no compile, no evaluate, no preview, no IO. A view model that
 *     evaluated would be a second evaluator, which ADR 0007 section 1's stop
 *     condition names.
 *   - **T7 — No secrets.** Every string rendered comes from a compiled rule, a
 *     preview, a disclosure, an explanation, a refusal message, or a constant in
 *     this directory. There is no field through which prompt text, a task
 *     description, context manifest content or a memory record could arrive
 *     (ADR 0007 section 12).
 *   - **V1 — `lines` is derived, never primary.** It is declared LAST on the view
 *     model interface and assigned LAST in the builder, so a field added above it
 *     cannot be rendered in a way the structure does not describe.
 *   - **V2 — The four danger classes are all present or all absent, never
 *     reordered.** `dangers` is built by iterating the danger vocabulary, so two
 *     states with the same dangers produce the same array in the same order.
 *
 * # STOP CONDITIONS
 *
 *   - **S-V1 — If the view needs a value `previewCompiledRuleSet` does not report,
 *     stop and add it there.** Deriving it here would be a second analysis of the
 *     predicate AST, and `preview.ts`'s docblock is explicit that `summarizeAxes`
 *     must stay a summariser rather than becoming a second matcher.
 *   - **S-V2 — If `shadowed` and `possible_overlap` ever need one field, stop.**
 */

import { UNKNOWN_REACH_TEXT } from "../explain.js"
import {
  RULE_TUI_DANGER_KINDS,
  RULE_TUI_MINIMUM_COLUMNS,
  RULE_TUI_MINIMUM_ROWS,
  compareRuleTuiCodeUnits,
  sortedRuleTuiStrings,
  type RuleTuiBuilderDraft,
  type RuleTuiConflictView,
  type RuleTuiDanger,
  type RuleTuiDangerKind,
  type RuleTuiOverlay,
  type RuleTuiPreviewEntryShape,
  type RuleTuiReachAxisView,
  type RuleTuiRuleRow,
  type RuleTuiScreen,
  type RuleTuiShadowView,
  type RuleTuiSimulationReport,
  type RuleTuiTemplateCapture,
  type RuleTuiUiState,
} from "./types.js"
import { builderNormalizedPredicate } from "./builder.js"

// ===========================================================================
// The view model
// ===========================================================================

/**
 * The builder screen's structured content.
 *
 * The normalized predicate is `null` when the draft's predicates do not satisfy the
 * predicate schema yet, which is a DIFFERENT fact from "the draft is refused" — the
 * refusal codes are on `compileCodes` and the two are read separately on purpose.
 */
export interface RuleTuiBuilderView {
  readonly draft: RuleTuiBuilderDraft | null
  /** The canonical single-line predicate form, or `null` when there is none yet. */
  readonly normalizedPredicate: string | null
  readonly predicateFields: readonly string[]
  readonly actionKinds: readonly string[]
  /** `true` on the last compile, `false` otherwise — including "never compiled". */
  readonly compiled: boolean
  /** The compiler's own refusal codes, verbatim. */
  readonly compileCodes: readonly string[]
  /** Index-aligned with `compileCodes`. */
  readonly compileMessages: readonly string[]
  /** Dangers detected in the draft before it is submitted. */
  readonly dangers: readonly RuleTuiDanger[]
}

/** The template screen's structured content. */
export interface RuleTuiTemplatesView {
  readonly captures: readonly RuleTuiTemplateCapture[]
  /** The capture waiting on the caller. Never written here (S-RT2). */
  readonly pending: RuleTuiTemplateCapture | null
}

/** The simulation screen's structured content. */
export interface RuleTuiSimulationView {
  readonly report: RuleTuiSimulationReport | null
  /** The request waiting on the caller. `null` when nothing has been requested. */
  readonly pendingRequest: { readonly ruleSetDigest: string; readonly now: string } | null
}

/** One conflict/shadowing pair, as the conflicts screen lists it. */
export interface RuleTuiConflictScreenEntry {
  readonly ruleId: string
  readonly identity: string
  readonly conflicts: readonly RuleTuiConflictView[]
  /** Proven `shadowed` findings. */
  readonly shadowing: readonly RuleTuiShadowView[]
  /** Unproven co-match findings. NEVER merged with `shadowing` (S-V2). */
  readonly possibleOverlaps: readonly RuleTuiShadowView[]
}

export interface RuleTuiConflictsView {
  readonly entries: readonly RuleTuiConflictScreenEntry[]
  /** Total proven `shadowed` findings across every rule. */
  readonly shadowedTotal: number
  /** Total unproven co-match findings across every rule. */
  readonly possibleOverlapTotal: number
}

/** The detail screen's structured content. */
export interface RuleTuiDetailView {
  readonly row: RuleTuiRuleRow | null
  readonly dangers: readonly RuleTuiDanger[]
  /** The five reach axes, in the disclosure's order. Empty array when absent. */
  readonly reachAxes: readonly RuleTuiReachAxisView[]
  /** What `apply-enable-change` would do, stated before it is done. */
  readonly pendingEnableChange: { readonly ruleId: string; readonly templateVersion: number; readonly toEnabled: boolean } | null
  /** What activation is waiting on, or `null`. */
  readonly pendingActivation: { readonly ruleId: string; readonly templateVersion: number } | null
}

export interface RuleTuiViewModel {
  readonly screen: RuleTuiScreen
  readonly title: string
  readonly rows: readonly RuleTuiRuleRow[]
  readonly selectedIndex: number
  readonly selected: RuleTuiRuleRow | null
  /** Every danger on every row, sorted by identity then by the danger vocabulary. */
  readonly dangers: readonly RuleTuiDanger[]
  /** `true` when the SELECTED row carries at least one danger. */
  readonly selectedIsDangerous: boolean
  readonly detail: RuleTuiDetailView
  readonly builder: RuleTuiBuilderView
  readonly templates: RuleTuiTemplatesView
  readonly simulation: RuleTuiSimulationView
  readonly conflicts: RuleTuiConflictsView
  readonly rawDocumentText: string
  readonly previewText: string
  readonly explanationText: string
  readonly overlay: RuleTuiOverlay
  /**
   * True while a dialog that changes what a dispatch may do is open.
   *
   * This is the one boolean a renderer must consult before drawing a confirm
   * control, because the control's enabled-ness is `confirmationArmed` and NOT this
   * flag — an open-but-unarmed dialog is the state R1 exists to make possible.
   */
  readonly blockingOverlay: boolean
  readonly confirmationArmed: boolean
  readonly notice: string | null
  readonly error: string | null
  /** The viewport this view was built for. Named `viewportRows` and not `rows`,
   *  because `rows` above is the rule list: a view model with two fields of the
   *  same name is one whose consumers have to guess which they are reading. */
  readonly columns: number
  readonly viewportRows: number
  /** Rendered lines. Declared LAST and assigned LAST (V1). */
  readonly lines: readonly string[]
}

// ===========================================================================
// Titles
// ===========================================================================

function titleFor(screen: RuleTuiScreen): string {
  switch (screen) {
    case "list":
      return "Rules"
    case "detail":
      return "Rule detail"
    case "raw":
      return "Rule source"
    case "preview":
      return "Rule preview"
    case "builder":
      return "Rule builder"
    case "templates":
      return "Rule templates"
    case "simulation":
      return "Rule simulation"
    case "conflicts":
      return "Rule conflicts"
  }
}

// ===========================================================================
// Reach axes
// ===========================================================================

/**
 * The five reach axes, in the order ADR 0007 section 11's disclosure table names
 * them.
 *
 * `unknown` is `true` exactly when the rendered value is `UNKNOWN_REACH_TEXT`. The
 * `values` array is then EMPTY, and the two facts are separate fields precisely so
 * that "unconstrained" cannot be rendered as "matches nothing" by a consumer that
 * only reads `values` (ADR 0007 section 11).
 */
function reachAxisViews(source: Pick<RuleTuiPreviewEntryShape, "futureScope"> | null): RuleTuiReachAxisView[] {
  if (source === null) return []
  const scope = source.futureScope
  const names: readonly { name: string; value: readonly string[] | typeof UNKNOWN_REACH_TEXT }[] = [
    { name: "projects", value: scope.projectIds },
    { name: "roles", value: scope.roles },
    { name: "capabilities", value: scope.capabilities },
    { name: "nodes", value: scope.nodes },
    { name: "projectPaths", value: scope.projectPaths },
  ]
  return names.map(({ name, value }) => {
    if (value === UNKNOWN_REACH_TEXT) {
      return { name, unknown: true, values: [], sources: [] }
    }
    const members = value as readonly string[]
    return { name, unknown: false, values: sortedRuleTuiStrings(members), sources: [] }
  })
}

// ===========================================================================
// Dangers
// ===========================================================================

/**
 * Order dangers by the danger vocabulary, then by subject.
 *
 * The vocabulary order, not alphabetical and not the order they were discovered in:
 * `unscoped_pre_approval` first because it is the refusal, then the two
 * disclosure-shaped facts, then the budget mismatch. A user reading a warning list
 * should meet the refusal first, because a document refused for being unscoped is a
 * document whose other warnings are about a rule that cannot exist.
 *
 * Sorting by SUBJECT within a kind is what makes the array a function of its
 * contents (V2): two states with the same dangers in different discovery orders
 * produce the same array.
 */
function sortDangers(dangers: readonly RuleTuiDanger[]): RuleTuiDanger[] {
  return [...dangers].sort((left, right) => {
    const byKind = RULE_TUI_DANGER_KINDS.indexOf(left.kind) - RULE_TUI_DANGER_KINDS.indexOf(right.kind)
    if (byKind !== 0) return byKind
    const byIdentity = compareRuleTuiCodeUnits(
      `${left.ruleId}@${left.templateVersion}`,
      `${right.ruleId}@${right.templateVersion}`,
    )
    if (byIdentity !== 0) return byIdentity
    return compareRuleTuiCodeUnits(left.subject ?? "", right.subject ?? "")
  })
}

// ===========================================================================
// The builder
// ===========================================================================

/**
 * Build the view.
 *
 * Pure (T4): the state is the only input, nothing here compiles, evaluates,
 * previews, reads a clock or performs IO. In particular the normalized predicate on
 * `builder` is `builderNormalizedPredicate`, which renders through the language's own
 * `describeNormalizedPredicate` and returns `null` when the draft's predicates do not
 * parse — it does not compile the document, because compiling is the CALLER's job and
 * its answer arrives as `compile-result`.
 */
export function buildRuleTuiView(state: RuleTuiUiState): RuleTuiViewModel {
  const selectedIndex = Math.max(0, Math.min(state.selectedIndex, Math.max(0, state.rows.length - 1)))
  const selected = state.rows[selectedIndex] ?? null
  // The detail screen's reach axes come from the SELECTED preview entry, not from
  // `null`. Reading them from the same entry the row was built from is what keeps
  // the list's `unconstrainedReachAxes` and the detail's per-axis values describing
  // one rule set rather than two (S-RT3's one-place rule applied to axes).
  const detail: RuleTuiDetailView = {
    row: selected,
    dangers: selected?.dangers ?? [],
    reachAxes: reachAxisViews(state.previewEntries[selectedIndex] ?? null),
    pendingEnableChange: state.pendingEnableChange,
    pendingActivation: state.pendingActivation,
  }
  const builder: RuleTuiBuilderView = {
    draft: state.draft,
    normalizedPredicate: state.draft === null ? null : builderNormalizedPredicate(state.draft, state.draftPredicates),
    predicateFields: state.draftPredicates,
    actionKinds: state.draftActions,
    compiled: state.compiled,
    compileCodes: state.compileCodes,
    compileMessages: state.compileMessages,
    dangers: [],
  }
  const templates: RuleTuiTemplatesView = {
    captures: state.templateCaptures,
    pending: state.pendingTemplateCapture,
  }
  const simulation: RuleTuiSimulationView = {
    report: state.simulationReport,
    pendingRequest: state.pendingSimulationRequest,
  }
  // The conflicts screen is derived from the SAME preview entries the rows were built
  // from, rather than from a second caller-supplied findings array. Two arrays would
  // be two places where `shadowed` and `possible_overlap` are told apart, and S-RT3
  // says there is exactly one.
  const conflicts: RuleTuiConflictsView = buildRuleTuiConflicts(state.previewEntries)
  const allDangers = sortDangers(state.rows.flatMap((row) => row.dangers))

  const view: RuleTuiViewModel = {
    screen: state.screen,
    title: titleFor(state.screen),
    rows: state.rows,
    selectedIndex,
    selected,
    dangers: allDangers,
    selectedIsDangerous: (selected?.dangers.length ?? 0) > 0,
    detail,
    builder,
    templates,
    simulation,
    conflicts,
    rawDocumentText: state.rawDocumentText,
    previewText: state.previewText,
    explanationText: state.explanationText,
    overlay: state.overlay,
    blockingOverlay: state.overlay === "activation-confirm" || state.overlay === "dangerous-warning",
    confirmationArmed: state.confirmationArmed,
    notice: state.notice,
    error: state.error,
    columns: state.dimensions.columns,
    viewportRows: state.dimensions.rows,
    lines: [],
  }
  return { ...view, lines: renderRuleTuiLines(view, state) }
}

// ===========================================================================
// Rendering (V1)
// ===========================================================================

/** One-line summaries are truncated by a fixed, stated width. */
const SUMMARY_CHARACTERS = 96

/**
 * Truncate with a literal ellipsis.
 *
 * `…` rather than `...`, following `memory-view.ts` and `tui-adapter.ts`: the marker
 * is a single character that cannot occur in an identifier or a normalized form, so
 * a truncated line is distinguishable from a complete one that happens to be long.
 */
export function summarizeRuleTuiText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  if (collapsed.length <= SUMMARY_CHARACTERS) return collapsed
  return `${collapsed.slice(0, SUMMARY_CHARACTERS - 1)}…`
}

/**
 * The footer for a screen.
 *
 * One line, always, and it names the keys that DO something on the current screen.
 * A footer that listed every key would be a footer nobody reads; a footer that
 * omitted the dangerous ones would be worse, so activation and enable appear on
 * every screen where they are reachable.
 */
function footerFor(view: RuleTuiViewModel): string {
  const common = "? help · esc back · ctrl-c close"
  switch (view.screen) {
    case "list":
      return `j/k move · enter/G first/last · d detail · r raw · p preview · b builder · t templates · s simulation · c conflicts · ${common}`
    case "detail":
      return `j/k move · e stage enable change · E apply it · a activate · ${common}`
    case "raw":
    case "preview":
    case "conflicts":
      return `j/k scroll · J/K long scroll · ${common}`
    case "builder":
      return `tab focus · j/k move · type to edit · backspace delete · space enabled · f field · o operator · c action kind · n/N add/remove predicate · a/A add/remove action · w abandon · x discard · ${common}`
    case "templates":
    case "simulation":
      return `j/k scroll · enter run · ${common}`
  }
}

/**
 * The warning block.
 *
 * Rendered ABOVE every screen's content and before scrolling is applied, which is
 * what makes the narrow-viewport guarantee hold: at 60x18 a user scrolling through a
 * long preview still passes the warnings, because the warnings are at offset 0.
 *
 * The `!` prefix and the `DANGER` word are both present. The prefix is what a user
 * scanning a list sees; the word is what a test asserts on, and a user reading the
 * line in a terminal that collapses colour is the other half of why both are there.
 */
function dangerLines(dangers: readonly RuleTuiDanger[]): string[] {
  if (dangers.length === 0) return []
  return [
    `DANGER: ${dangers.length} warning${dangers.length === 1 ? "" : "s"}`,
    ...dangers.map((danger) => {
      const code = danger.code === null ? "" : ` [${danger.code}]`
      const subject = danger.subject === null ? "" : ` (${danger.subject})`
      return `! ${danger.kind}${subject}${code}: ${summarizeRuleTuiText(danger.detail)}`
    }),
    "",
  ]
}

/**
 * The overlay block.
 *
 * The confirm control's label is a function of `confirmationArmed`, and the unarmed
 * label says what to do rather than just being dim. `src/tui/view-model.ts:132` does
 * this for the shell (`controls(destructive)`), and the reason is the same: a user
 * who presses Enter on an apparently-live dialog has been told, in the dialog, that
 * the dialog is not live.
 */
function overlayLines(view: RuleTuiViewModel): string[] {
  switch (view.overlay) {
    case "none":
      return []
    case "help":
      return ["", "help:", "  j/k move   tab cycle focus   enter open/confirm   esc back", "  a activate   e stage enable   E apply   x discard   ? close help"]
    case "activation-confirm": {
      const pending = view.detail.pendingActivation
      const target = pending === null ? "(no rule selected)" : `${pending.ruleId}@${pending.templateVersion}`
      const control = view.confirmationArmed ? "[Confirm]  enter to activate" : "[Back]  tab to arm, then enter"
      return ["", `Activate ${target}?`, control, "esc cancels"]
    }
    case "dangerous-warning": {
      const dangers = view.selected?.dangers ?? []
      return [
        "",
        `This rule carries ${dangers.length} warning${dangers.length === 1 ? "" : "s"}:`,
        ...dangers.map((danger) => `  ! ${danger.kind}${danger.subject === null ? "" : ` (${danger.subject})`}`),
        "",
        "[Back]  enter to read and continue",
      ]
    }
    case "discard-confirm": {
      const control = view.confirmationArmed ? "[Confirm]  enter to discard" : "[Back]  tab to arm, then enter"
      return ["", "Discard the rule being authored?", control, "esc keeps it"]
    }
  }
}

/**
 * Render the lines.
 *
 * Full render, then a scroll window. Nothing is truncated away, so every warning
 * line is reachable at some `scrollOffset`, and the footer is appended AFTER the
 * window so it is always on screen — a footer that scrolled off would be a footer
 * that stopped telling the user which keys work.
 */
function renderRuleTuiLines(view: RuleTuiViewModel, state: RuleTuiUiState): readonly string[] {
  const body: string[] = [`AIBridge — ${view.title}`, `rules: ${view.rows.length}`, ""]

  if (view.error !== null) body.push(`error: ${view.error}`)
  if (view.notice !== null) body.push(`notice: ${view.notice}`)

  // Warnings first, before any content, and before the scroll window. This is the
  // narrow-viewport guarantee: at 60x18 the warning block is visible at offset 0 no
  // matter how long the screen's own content is.
  body.push(...dangerLines(view.dangers))

  switch (view.screen) {
    case "list": {
      if (view.rows.length === 0) {
        body.push("no rule set has been loaded")
        break
      }
      for (const [index, row] of view.rows.entries()) {
        const marker = index === view.selectedIndex ? ">" : " "
        const flags = [
          row.enabled ? "enabled" : "disabled",
          row.activationState,
          row.matchOutcome ?? "unevaluated",
          `history:${row.matchedHistoryCount}`,
        ]
        if (row.hasPreApproval) flags.push("pre-approval")
        if (row.dangers.length > 0) flags.push(`danger:${row.dangers.length}`)
        body.push(`${marker} ${row.identity} [${flags.join(" ")}] ${summarizeRuleTuiText(row.name)}`)
        body.push(`    ${row.normalizedPredicate}`)
      }
      break
    }
    case "detail": {
      const row = view.detail.row
      if (row === null) {
        body.push("no rule selected")
        break
      }
      body.push(`${row.identity} — ${summarizeRuleTuiText(row.name)}`)
      body.push(`project: ${row.projectId}`)
      body.push(`enabled: ${String(row.enabled)}`)
      body.push(`activation: ${row.activationState}${row.activatedAt === null ? "" : ` at ${row.activatedAt}`}${row.activatedBy === null ? "" : ` by ${row.activatedBy}`}`)
      body.push(`expiry: ${row.expiresAtLabel}`)
      body.push(`match outcome: ${row.matchOutcome ?? "unevaluated"}`)
      body.push(`history matches: ${row.matchedHistoryCount}`)
      body.push(`actions: ${row.actionKinds.join(", ") || "(none)"}`)
      body.push(`digest: ${row.digest}`)
      body.push(`normalized: ${row.normalizedPredicate}`)
      if (row.unconstrainedAxes.length > 0) body.push(`unconstrained axes: ${row.unconstrainedAxes.join(", ")}`)
      if (view.detail.reachAxes.length > 0) {
        body.push("reach:")
        for (const axis of view.detail.reachAxes) {
          // The unknown case renders the LITERAL and nothing else. Rendering
          // `[]` would read as "matches nothing", which is the opposite of the
          // truth (ADR 0007 section 11).
          body.push(`  ${axis.name}: ${axis.unknown ? UNKNOWN_REACH_TEXT : `[${axis.values.join(",")}]`}`)
        }
      }
      if (view.detail.pendingEnableChange !== null) {
        const pending = view.detail.pendingEnableChange
        body.push(`pending: ${pending.ruleId}@${pending.templateVersion} would be ${pending.toEnabled ? "enabled" : "disabled"}`)
      }
      break
    }
    case "raw": {
      if (view.rawDocumentText.length === 0) {
        body.push("no rule document has been loaded")
        break
      }
      body.push(...view.rawDocumentText.split("\n"))
      break
    }
    case "preview": {
      if (view.previewText.length === 0) {
        body.push("no preview has been loaded")
        break
      }
      body.push(...view.previewText.split("\n"))
      break
    }
    case "builder": {
      const builder = view.builder
      if (builder.draft === null) {
        body.push("no rule is being authored")
        break
      }
      const draft = builder.draft
      body.push(`ruleId: ${draft.ruleId}   templateVersion: ${draft.templateVersion}   projectId: ${draft.projectId}`)
      body.push(`name: ${draft.name}`)
      body.push(`description: ${draft.description}`)
      body.push(`enabled: ${String(draft.enabled)}   expiresAt: ${draft.expiresAt ?? "null"}`)
      body.push(`normalized: ${builder.normalizedPredicate ?? "(no normalized form yet)"}`)
      body.push("")
      body.push(`focus: ${draft.focus}   cursor: ${draft.cursor}`)
      body.push(`predicates: ${builder.predicateFields.length === 0 ? "(none)" : builder.predicateFields.join(", ")}`)
      body.push(`actions: ${builder.actionKinds.length === 0 ? "(none)" : builder.actionKinds.join(", ")}`)
      body.push(`field: ${draft.predicateField} ${draft.predicateOperator}   value: ${draft.predicateValue}`)
      body.push(`action: ${draft.actionKind}   value: ${draft.actionValue}`)
      body.push("")
      if (builder.compiled) {
        body.push("compile: accepted by the rule compiler")
      } else if (builder.compileCodes.length === 0) {
        body.push("compile: not yet run")
      } else {
        body.push("compile REFUSED:")
        builder.compileCodes.forEach((code, index) => {
          const message = builder.compileMessages[index] ?? ""
          body.push(`  ${code}: ${message}`)
        })
      }
      break
    }
    case "templates": {
      const templates = view.templates
      body.push(`captured templates: ${templates.captures.length}`)
      for (const capture of templates.captures) {
        body.push(`  ${capture.templateId} — ${capture.name}`)
        body.push(`    ruleSetDigest: ${capture.ruleSetDigest}`)
        body.push(`    rules: ${capture.ruleIdentities.length === 0 ? "(none)" : capture.ruleIdentities.join(", ")}`)
      }
      if (templates.pending !== null) {
        body.push("")
        body.push(`pending capture: ${templates.pending.templateId} at digest ${templates.pending.ruleSetDigest}`)
      }
      break
    }
    case "simulation": {
      const simulation = view.simulation
      if (simulation.report === null) {
        if (simulation.pendingRequest === null) {
          body.push("no simulation has been requested or reported")
        } else {
          body.push(`requested a simulation of ${simulation.pendingRequest.ruleSetDigest} at ${simulation.pendingRequest.now}`)
          body.push("the caller runs it and reports the result")
        }
        break
      }
      body.push(`ruleSetDigest: ${simulation.report.ruleSetDigest}`)
      body.push(`dispatches: ${simulation.report.dispatchIds.length === 0 ? "(none)" : simulation.report.dispatchIds.join(", ")}`)
      for (const decision of simulation.report.decisions) {
        body.push(`  ${decision.dispatchId}: ${decision.outcome} [${decision.ruleIds.join(", ") || "no rule"}]`)
      }
      for (const warning of simulation.report.warnings) body.push(`! ${warning}`)
      break
    }
    case "conflicts": {
      const conflicts = view.conflicts
      if (conflicts.entries.length === 0) {
        body.push("no conflict or shadowing findings have been loaded")
        break
      }
      body.push(`shadowed (proven): ${conflicts.shadowedTotal}   possible_overlap (not proven): ${conflicts.possibleOverlapTotal}`)
      for (const entry of conflicts.entries) {
        body.push(`${entry.identity}`)
        for (const conflict of entry.conflicts) {
          body.push(`  conflict ${conflict.kind}: ${conflict.ruleIds.join(",")}`)
        }
        // Two labelled groups, never one. `shadowed` means the evaluator PROVED a
        // superset relation; `possible_overlap` means it could not prove either
        // way. Rendering them as one list would claim a pre-approval is dead when it
        // is alive (ADR 0007 section 10.5).
        for (const finding of entry.shadowing) {
          body.push(`  SHADOWED (proven) ${finding.direction === "shadows" ? "shadows" : "shadowed by"} ${finding.otherRuleId}: ${finding.reason}`)
        }
        for (const finding of entry.possibleOverlaps) {
          body.push(`  POSSIBLE_OVERLAP (not proven) with ${finding.otherRuleId}: ${finding.reason}`)
        }
      }
      break
    }
  }

  const window = body.slice(state.scrollOffset)
  const overlay = overlayLines(view)
  return Object.freeze([...window, "", ...overlay, footerFor(view)])
}

// ===========================================================================
// Building rows and conflict entries FROM a preview
// ===========================================================================

/**
 * Turn preview entries into the rows the list and detail screens render.
 *
 * The ONLY place a `RulePreviewEntry` becomes a `RuleTuiRuleRow`, so the two
 * screens cannot disagree about what a rule is. Every count is derived from the
 * TYPED fields rather than by counting warning strings: a prefix match on a warning's
 * prose is a check that silently stops matching the first time somebody rewords the
 * sentence, and `preview.ts` refuses to build its set-level statements that way for
 * the same reason.
 *
 * The two shadowing counts are the load-bearing part. `shadowedCount` counts only
 * `relation === "shadowed"` and `possibleOverlapCount` counts only
 * `relation === "possible_overlap"`, and `possible_overlap` is NOT also counted as
 * `shadowed`. ADR 0007 section 10.5: reporting two merely-possible co-matches as
 * `shadowed` would train the user to ignore the field, and the one time it mattered
 * would be the time they ignored it.
 *
 * `dangers` is computed from the row's OWN typed fields rather than from
 * `warnings`, because `warnings` is prose and a danger flag is a decision. The
 * classes are derived from `hasPreApproval`, `futureScope` and `expiresAt` — the
 * same inputs `buildPreApprovalDisclosure` reads, so a screen's danger flag and the
 * disclosure's warning are about the same fact.
 */
export function builderRuleTuiRows(entries: readonly RuleTuiPreviewEntryShape[]): RuleTuiRuleRow[] {
  return entries.map((entry) => {
    const reachAxes = reachAxisViews({ futureScope: entry.futureScope })
    const unconstrainedReachAxes = reachAxes.filter((axis) => axis.unknown).map((axis) => axis.name)
    const dangers = dangersForEntry(entry, unconstrainedReachAxes)
    return {
      ruleId: entry.ruleId,
      templateVersion: entry.templateVersion,
      identity: `${entry.ruleId}@${entry.templateVersion}`,
      projectId: entry.projectId,
      name: entry.name,
      enabled: entry.enabled,
      activationState: entry.activation.state,
      activatedAt: entry.activation.activatedAt,
      activatedBy: entry.activation.activatedBy,
      expiresAt: entry.expiresAt,
      // The LITERAL "no expiry", never `null` and never `never`. ADR 0007 section 11
      // names the text, and a `null` in an expiry slot reads as a data value rather
      // than as a statement that nothing will stop this rule.
      expiresAtLabel: entry.expiresAt ?? "no expiry",
      matchOutcome: entry.matchOutcome,
      matchedHistoryCount: entry.matchedHistoryCount,
      normalizedPredicate: entry.normalizedPredicate,
      digest: entry.digest,
      actionKinds: entry.actionKinds,
      hasPreApproval: entry.hasPreApproval,
      activationRequired: entry.activationRequired,
      unconstrainedAxes: entry.unconstrainedAxes,
      unconstrainedReachAxes,
      conflictCount: entry.conflicts.length,
      shadowedCount: entry.shadowing.filter((finding) => finding.relation === "shadowed").length,
      possibleOverlapCount: entry.shadowing.filter((finding) => finding.relation === "possible_overlap").length,
      warnings: entry.warnings,
      dangers,
    }
  })
}

/**
 * The danger flags for one preview entry.
 *
 * Two of the four classes are NOT derived here, and that is deliberate:
 *
 *   - `unscoped_pre_approval` is a COMPILE refusal. A rule carrying one never reached
 *     a preview, because `compileRuleSet` refused it first. Surfacing it is
 *     `analyzeBuilderDangers`' job on the builder screen, where the document has not
 *     been submitted. Deriving it here would be deriving a property of a document
 *     that cannot exist in this collection.
 *   - `bounds_exceed_effective_budget` needs the budget ACTUALLY IN FORCE, which the
 *     preview does not carry — a history replay supplies `currentBudget: null` by
 *     design (`src/rules/preview.ts`, `contextForEntry`). Inventing a budget here
 *     would produce a warning about a comparison nobody made.
 *
 * The two that ARE derived are the two whose inputs the preview genuinely has.
 */
function dangersForEntry(entry: RuleTuiPreviewEntryShape, unconstrainedReachAxes: readonly string[]): RuleTuiDanger[] {
  const dangers: RuleTuiDanger[] = []
  const identity = { ruleId: entry.ruleId, templateVersion: entry.templateVersion }
  if (!entry.hasPreApproval) return dangers
  for (const axis of unconstrainedReachAxes) {
    dangers.push({
      kind: "unconstrained_reach",
      ...identity,
      code: null,
      subject: axis,
      detail: `The predicate is unconstrained on '${axis}', so this pre-approval can match any value on that axis. Its reach is shown as '${UNKNOWN_REACH_TEXT}' and not as an empty set, because an empty set would read as "matches nothing" and the truth is "matches everything".`,
    })
  }
  if (entry.expiresAt === null) {
    dangers.push({
      kind: "no_expiry",
      ...identity,
      code: null,
      subject: "expiresAt",
      detail:
        "This pre-approval declares expiresAt: null, which ADR 0007 section 11 requires be shown as the literal 'no expiry'. It stays effective until it is revoked or disabled, and no date stops it on its own.",
    })
  }
  return sortDangers(dangers)
}

/**
 * The conflicts screen's entries, split by relation.
 *
 * Two separate arrays, never one. `entry.shadowing` holds ONLY proven `shadowed`
 * findings and `entry.possibleOverlaps` holds ONLY `possible_overlap` findings, and
 * the split is by the typed `relation` rather than by the derived `proven`, because
 * `relation` is what the evaluator emitted and `proven` is what this module derived
 * from it. Splitting on the derived value would mean a bug in the derivation split
 * the arrays wrongly and nothing else would notice.
 *
 * `relation` is copied through verbatim and is never widened to a boolean on the
 * row or the entry (S-RT3).
 */
export function buildRuleTuiConflicts(entries: readonly RuleTuiPreviewEntryShape[]): RuleTuiConflictsView {
  const built = entries.map((entry): RuleTuiConflictScreenEntry => {
    const shadowing: RuleTuiShadowView[] = []
    const possibleOverlaps: RuleTuiShadowView[] = []
    for (const finding of entry.shadowing) {
      const view: RuleTuiShadowView = {
        relation: finding.relation,
        proven: finding.proven,
        otherRuleId: finding.otherRuleId,
        direction: finding.direction,
        reason: finding.reason,
        detail: finding.detail,
      }
      if (finding.relation === "shadowed") shadowing.push(view)
      else possibleOverlaps.push(view)
    }
    const conflicts: RuleTuiConflictView[] = entry.conflicts.map((conflict) => ({
      kind: conflict.kind,
      ruleIds: conflict.ruleIds,
      detail: conflict.detail,
    }))
    return {
      ruleId: entry.ruleId,
      identity: `${entry.ruleId}@${entry.templateVersion}`,
      conflicts,
      shadowing,
      possibleOverlaps,
    }
  })
  return {
    entries: built,
    shadowedTotal: built.reduce((total, entry) => total + entry.shadowing.length, 0),
    possibleOverlapTotal: built.reduce((total, entry) => total + entry.possibleOverlaps.length, 0),
  }
}

// ===========================================================================
// Reach-axis construction for a loaded row (exported for the integration step)
// ===========================================================================

/**
 * Build reach-axis views from a preview entry's `futureScope`.
 *
 * Exported because a caller that renders the detail screen has a preview entry and
 * not a row: the row carries the axis NAMES (`unconstrainedReachAxes`) for the list,
 * while the detail screen needs the per-axis values. The function is here so both
 * paths use one implementation and cannot disagree about which axes are unknown.
 */
export { reachAxisViews as buildRuleTuiReachAxes }

// ===========================================================================
// Viewport
// ===========================================================================

/**
 * Whether a terminal is at least the minimum this directory renders for.
 *
 * Restated against the module's own constants rather than the shell's, for the
 * direction reason `types.ts` gives, and asserted equal in the tests.
 */
export function isUsableRuleTuiViewport(columns: number, rows: number): boolean {
  return columns >= RULE_TUI_MINIMUM_COLUMNS && rows >= RULE_TUI_MINIMUM_ROWS
}
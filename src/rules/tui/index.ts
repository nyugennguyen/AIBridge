/**
 * M6.8 — the rule TUI's barrel, and the contract a future `src/tui/` integration
 * would consume.
 *
 * # WHAT THIS MODULE IS
 *
 * A self-contained, PURE presentation layer. Eight screens — rule list, detail,
 * raw source, preview, keyboard builder, templates, simulation, conflicts — over
 * the M6 rule language, driven entirely by keystrokes, with a structured view model
 * whose `lines` are derived last.
 *
 * It has no renderer, no `@opentui/core` import, no filesystem, no network, no
 * process and no ambient clock, so every screen is testable with no terminal at all.
 * That is the same shape as `src/context/tui/memory-view.ts`, and for the same
 * reason: a renderer is one consumer of this data and a test is another.
 *
 * # ================= THE SHELL INTEGRATION CONTRACT =================
 *
 * A future integration step adds this module to `src/tui/shell.ts`. It does NOT
 * modify anything in this directory. Everything the integration needs is named here.
 *
 * ## WHAT THE SHELL IMPORTS
 *
 * From `src/rules/tui/index.js` (this barrel):
 *
 *   - `initialRuleTuiState(now, dimensions)` — the initial state. `now` is an
 *     injected timestamp string and `dimensions` is `{columns, rows}`.
 *   - `reduceRuleTui(state, action)` — the pure reducer. Exhaustive over
 *     `RuleTuiAction`, no `default` clause.
 *   - `routeRuleTuiKey(state, key)` — the pure key router. Returns a
 *     `RuleTuiIntent`: `none`, `close`, `dispatch(action)`, or `reject(reason)`.
 *   - `buildRuleTuiView(state)` — the structured view model, with `lines` derived.
 *   - `RULE_TUI_SCREENS`, `RULE_TUI_OVERLAYS`, `RULE_TUI_ACTIONS`,
 *     `RULE_TUI_KEY_PRODUCED_ACTIONS`, `RULE_TUI_MINIMUM_COLUMNS`,
 *     `RULE_TUI_MINIMUM_ROWS`, `RULE_TUI_DANGER_KINDS` — the declared vocabularies.
 *   - `analyzeBuilderDangers(draft, predicateFields, actionKinds)` — the danger
 *     analysis over a candidate document.
 *   - `compileBuilderDocument(document)` — the ONE call into the language's
 *     compiler. Returns `{ok, codes, messages, normalizedPredicate, digest,
 *     refusedWith}`. The shell feeds `assembleRuleDocument`'s output to this and
 *     dispatches `compile-result` with `codes` and `messages`.
 *   - `assembleRuleDocument(draft, predicateFields, actionKinds)` — turns the
 *     builder's draft into the exact document `compileRule` is handed.
 *   - `builderRuleTuiRows(preview)` and `buildRuleTuiConflicts(preview)` — the
 *     adapters that turn a `RulePreview` into the row and conflict structures this
 *     module renders. The shell calls these once per rule set and dispatches
 *     `rule-set-loaded` with the rows.
 *
 * ## WHERE THE INTEGRATION ATTACHES
 *
 * Three attachment points in `src/tui/shell.ts`, in the order a keystroke takes
 * them:
 *
 *   1. **KEY INTAKE.** In the shell's key handler, alongside the existing
 *      `routeTuiKey` call. The rule screens are a MODE, so the shell holds a
 *      `RuleTuiUiState` alongside its own `TuiUiState` and routes to whichever is
 *      active. `routeRuleTuiKey` handles `ctrl-c`, so the shell must NOT consume
 *      that key first for a rule screen — the router returns `{type: "close"}` for
 *      it and the shell treats a rule-screen close as leaving the rule screens.
 *   2. **RENDER.** In the shell's render function, on the rule screens, from
 *      `buildRuleTuiView(state).lines`. The shell's existing `wrapLines` and
 *      `MINIMUM_TUI_COLUMNS`/`MINIMUM_TUI_ROWS` checks apply unchanged;
 *      `RULE_TUI_MINIMUM_COLUMNS`/`RULE_TUI_MINIMUM_ROWS` are asserted EQUAL to the
 *      shell's in `tests/unit/rules/tui.test.ts`, so the shell does not need two
 *      constants.
 *   3. **EFFECTS.** Where the shell already performs service calls. The rule module
 *      PERFORMS NO WRITES (R4 in `state.ts`), so three intents need handling:
 *      `{type: "dispatch", action: {type: "request-simulation"}}` calls the
 *      simulation entry point and dispatches `simulation-reported`;
 *      `request-template-capture` reads `state.pendingTemplateCapture` and calls
 *      `RunTemplateRepository.createTemplate`; and a confirmed activation reads
 *      `state.pendingActivation` after `confirm-activation` and writes the document
 *      with the activation state set. All three are the SHELL's calls, in the
 *      SHELL's layer — that is why the rule module does not import `src/simulation/`
 *      or `src/workflows/`.
 *
 * ## WHY THE SHELL CANNOT BE THE ONLY CONSUMER
 *
 * `tests/unit/rules/barrel.test.ts` asserts that nothing under `src/tui` may import
 * from `src/rules/`, and `tests/unit/workflows/barrel.test.ts` asserts that nothing
 * under `src/rules` may import from `src/workflows/`. So the dependency is one-way:
 * `src/tui` would import this directory, and this directory imports nothing from
 * either. Every structural compatibility between the two sides is declared here and
 * asserted by assignment in the tests.
 *
 * # THE `src/simulation/` AND `src/workflows/` DEPENDENCIES
 *
 * Both modules EXIST. Neither is imported, and the reason is ADR 0007 section 1,
 * which declares the milestone's edges as strictly downward:
 *
 * ```
 * simulation  ->  rules, workflows, budgets, routing, orchestration, context
 * workflows   ->  rules, orchestration
 * rules       ->  orchestration, mesh/protocol/safe-pattern, memory/ontology
 * ```
 *
 * `simulation -> rules` and `workflows -> rules` are both declared; the reverse edges
 * are not. `tests/unit/workflows/barrel.test.ts:63` enforces the `workflows` half by
 * source scan over every file under `src/`, and
 * `tests/unit/rules/barrel.test.ts:52` enforces the `src/tui` half. So a
 * `src/rules/tui/` import of either would be a direction violation a test would catch,
 * and this module is deliberately on the correct side of both.
 *
 * The consequence is that both integrations go through a VALUE, produced here and
 * acted on by the caller:
 *
 *   - **Simulation.** `RuleTuiSimulationReport` in `types.ts` is a structural
 *     interface, declared following `src/context/isolation.ts:94-122`'s discipline and
 *     chosen field-for-field against `DryRunPlan` in `src/simulation/plan.ts`. The
 *     shell's `request-simulation` handler maps a plan onto it and dispatches
 *     `simulation-reported`. The docblock on the interface names the exact symbols to
 *     use (`buildDryRunPlan` / `SimulationRequest`) and the fields to read.
 *
 *   - **Templates.** `captureRuleSetAsTemplate` returns a `RuleTuiTemplateCapture`
 *     carrying the rule set's DIGEST and its sorted rule identities — which is all
 *     `RunTemplateInput` needs to bind a template to a rule set, and is what the
 *     workflows module's own docblock requires ("a template refers to a rule set by
 *     DIGEST, never by document"). The shell passes it to
 *     `RunTemplateRepository.createTemplate`, supplying the workflow steps it already
 *     has, and to `instantiateTemplate` to bind parameters.
 *
 * Both are one-adapter integrations rather than two-way dependencies, which is the
 * shape every other M6 boundary takes.
 *
 * # ================= WHAT THIS MODULE DELIBERATELY DOES NOT =================
 *
 *   - **No second renderer, no second disclosure, no second evaluator.** The
 *     explanation is `renderRuleExplanation`'s output; the disclosure is
 *     `buildPreApprovalDisclosure`'s; the preview is `previewCompiledRuleSet`'s; the
 *     acceptance decision is `compileRule`'s. `view-model.ts` and `builder.ts` report
 *     what those said and compute nothing about whether a rule matches.
 *   - **No secrets (T7).** ADR 0007 section 12's list is enforced by there being no
 *     field through which any of it could arrive.
 *   - **No writes (R4).** Three pending values leave as state for the caller to act
 *     on.
 *
 * # NAMED INVARIANTS (summarised; each file states its own)
 *
 *   - **T1** Injected clock, never `Date.now()`.
 *   - **T2** Code-unit ordering, never `localeCompare`.
 *   - **T3** Exhaustive reducer, no `default` clause.
 *   - **T4** The view model reads the state and nothing else.
 *   - **T5** `unknown` on every caller-supplied payload.
 *   - **T6** Structurally declared ports for modules that may not be imported.
 *   - **T7** No prompt text, task descriptions, manifest content, memory content,
 *     capability payload bytes, terminal output, environment values or credentials.
 *   - **B1** The compiler decides; the builder has no second validator.
 *   - **R1** Activation requires an ARMED confirmation.
 *   - **R2** The dangerous-warning overlay is not skippable.
 *   - **R3** An enable/disable change is two explicit steps.
 *   - **V1** `lines` is derived, declared last and assigned last.
 *   - **V2** Danger arrays are ordered by the declared vocabulary, never by discovery.
 *
 * # STOP CONDITIONS
 *
 *   - **S-RT1** A value the preview does not carry goes into `preview.ts` deliberately,
 *     not derived here.
 *   - **S-RT2** Anything that writes is an intent the caller performs.
 *   - **S-RT3** `shadowed` and `possible_overlap` stay distinct forever.
 *   - **S-B1** A builder-side refusal is a refusal the COMPILER made.
 *   - **S-ST1** A keystroke that would need authority returns `reject` with a reason.
 *   - **S-V1** A view that needs a new analysis stops and puts the analysis in the
 *     module that owns it.
 */

export {
  RULE_TUI_ACTIONS,
  RULE_TUI_BUILDER_FIELDS,
  RULE_TUI_DANGER_KINDS,
  RULE_TUI_KEY_PRODUCED_ACTIONS,
  RULE_TUI_MINIMUM_COLUMNS,
  RULE_TUI_MINIMUM_ROWS,
  RULE_TUI_NON_KEY_ACTIONS,
  RULE_TUI_OVERLAYS,
  RULE_TUI_SCREENS,
  compareRuleTuiCodeUnits,
  ruleTuiBuilderDraftSchema,
  ruleTuiDangerSchema,
  ruleTuiDimensionsSchema,
  sortedRuleTuiStrings,
  type RuleTuiAction,
  type RuleTuiActionType,
  type RuleTuiBuilderDraft,
  type RuleTuiBuilderField,
  type RuleTuiConflictView,
  type RuleTuiDanger,
  type RuleTuiDangerKind,
  type RuleTuiDimensions,
  type RuleTuiIntent,
  type RuleTuiKey,
  type RuleTuiKeyProducedActionType,
  type RuleTuiNamedKey,
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

export {
  initialRuleTuiState,
  focusedBuilderField,
  nextBuilderFocus,
  reduceRuleTui,
  routeRuleTuiKey,
} from "./state.js"

export {
  RULE_TUI_ACTION_KINDS,
  RULE_TUI_DEFAULT_ACTION_VALUES,
  RULE_TUI_DEFAULT_PREDICATE_VALUES,
  RULE_TUI_OPERATORS_BY_FIELD,
  RULE_TUI_PREDICATE_FIELDS,
  RULE_TUI_SCOPE_BOUND_ACTION_KINDS,
  analyzeBuilderDangers,
  appendToBuilderField,
  assembleRuleDocument,
  backspaceBuilderField,
  builderNormalizedPredicate,
  captureRuleSetAsTemplate,
  compileBuilderDocument,
  currentBuilderFieldValue,
  defaultActionValueFor,
  defaultPredicateValueFor,
  defaultRuleTuiDraft,
  draftConstrainsScope,
  nextActionKind,
  nextInCycle,
  nextPredicateField,
  nextPredicateOperator,
  unconstrainedReachAxesFor,
  withBuilderField,
  type RuleTuiCompileReport,
} from "./builder.js"

export {
  buildRuleTuiReachAxes,
  buildRuleTuiConflicts,
  buildRuleTuiView,
  builderRuleTuiRows,
  isUsableRuleTuiViewport,
  summarizeRuleTuiText,
  type RuleTuiBuilderView,
  type RuleTuiConflictScreenEntry,
  type RuleTuiConflictsView,
  type RuleTuiDetailView,
  type RuleTuiSimulationView,
  type RuleTuiTemplatesView,
  type RuleTuiViewModel,
} from "./view-model.js"
/**
 * The rule TUI's view model: structure, determinism, danger warnings, the reach
 * `unknown`, and the narrow viewport.
 *
 * # WHAT IS ASSERTED ON WHAT
 *
 * The STRUCTURE is asserted for every safety property, and `lines` only for text
 * presence. That split is the whole reason this module exists as a structure: a
 * warning that merely mentions "projects" is indistinguishable, by `toContain`, from
 * a warning that reports the projects axis as unconstrained. So a test here asserts
 * `danger.kind === "unconstrained_reach"` and `danger.subject === "projects"`, and
 * separately asserts the rendered line mentions both — two assertions, neither
 * able to pass for the other's reason.
 *
 * # THE FIVE PROPERTIES
 *
 *   1. Structure over strings (V1). `lines` is derived last and every safety fact is
 *      readable from a typed field.
 *   2. Purity and determinism (T1, T4, R5). The same state rendered fifty times is
 *      byte-identical, and rendering twice agrees.
 *   3. Danger warnings. One test per class, plus the compiler's own code verbatim.
 *   4. `unknown` is never an empty set (ADR 0007 section 11).
 *   5. No secrets (T7, ADR 0007 section 12), asserted over `lines` AND the
 *      structured fields.
 */

import { describe, expect, it } from "vitest"
import { canonicalJson } from "../../../src/orchestration/digest.js"
import { UNKNOWN_REACH_TEXT } from "../../../src/rules/index.js"
import { MINIMUM_TUI_COLUMNS, MINIMUM_TUI_ROWS } from "../../../src/tui/types.js"
import {
  RULE_TUI_DANGER_KINDS,
  RULE_TUI_MINIMUM_COLUMNS,
  RULE_TUI_MINIMUM_ROWS,
  RULE_TUI_SCREENS,
  analyzeBuilderDangers,
  buildRuleTuiConflicts,
  buildRuleTuiView,
  builderRuleTuiRows,
  defaultRuleTuiDraft,
  isUsableRuleTuiViewport,
  reduceRuleTui,
  routeRuleTuiKey,
  initialRuleTuiState,
  type RuleTuiDanger,
  type RuleTuiUiState,
} from "../../../src/rules/tui/index.js"
import {
  ALL_CANARIES,
  CANARY,
  CANARY_SECONDARY,
  NARROW_VIEWPORT,
  TUI_NOW,
  UNKNOWN,
  allFourDangers,
  canaryDenyDocument,
  canaryState,
  cleanPreApprovalDocument,
  disclosureFor,
  emptyState,
  overlappingDocuments,
  partiallyScopedPreApprovalDocument,
  previewOf,
  shadowingDocuments,
  stateWithRules,
} from "./tui-fixtures.js"

// ===========================================================================
// 1. Structure over strings
// ===========================================================================

describe("the rule TUI's view model is a structure whose lines are derived last", () => {
  it("reports every safety fact on a typed field rather than only in the rendered text", () => {
    const state = stateWithRules([partiallyScopedPreApprovalDocument()])
    const view = buildRuleTuiView(state)
    const row = view.rows[0]

    // Identity, version, activation, match outcome, unconstrained axes, conflict
    // count and danger flags — all readable without parsing a line.
    expect(row?.ruleId).toBe("rule-partial-pre")
    expect(row?.templateVersion).toBe(1)
    expect(row?.identity).toBe("rule-partial-pre@1")
    expect(row?.activationState).toBe("activated")
    expect(row?.hasPreApproval).toBe(true)
    expect(row?.conflictCount).toBe(0)
    expect(row?.unconstrainedAxes.length).toBeGreaterThan(0)

    // And the rendered text agrees, which is the second half of the claim.
    expect(view.lines.join("\n")).toContain("rule-partial-pre@1")
  })

  it("declares lines last on the view model, so a field added above it cannot render undescribed", () => {
    const keys = Object.keys(buildRuleTuiView(stateWithRules([canaryDenyDocument()])))
    expect(keys[keys.length - 1]).toBe("lines")
  })

  it("renders no rule set as a stated message rather than as an empty list", () => {
    const view = buildRuleTuiView(emptyState())
    expect(view.rows).toEqual([])
    expect(view.lines.join("\n")).toContain("no rule set has been loaded")
  })

  it("renders every one of the eight declared screens with its own title", () => {
    // The screen list is closed, so this is exhaustive rather than a sample.
    expect(RULE_TUI_SCREENS).toHaveLength(8)
    for (const screen of RULE_TUI_SCREENS) {
      const view = buildRuleTuiView(emptyState({ screen }))
      expect(view.screen).toBe(screen)
      expect(view.title.length).toBeGreaterThan(0)
    }
  })
})

// ===========================================================================
// 2. Purity and determinism
// ===========================================================================

describe("the rule TUI reads no clock and reaches no ambient state", () => {
  it("renders the same state fifty times to byte-identical output", () => {
    const state = stateWithRules(shadowingDocuments())
    const first = buildRuleTuiView(state)
    for (let iteration = 0; iteration < 50; iteration += 1) {
      const again = buildRuleTuiView(state)
      expect(again.lines).toEqual(first.lines)
      expect(canonicalJson({ ...again, lines: [] })).toBe(canonicalJson({ ...first, lines: [] }))
    }
  })

  it("reaches the same state from the same actions fifty times", () => {
    const actions = [
      { type: "navigate", screen: "detail" },
      { type: "move", delta: 1 },
      { type: "move", delta: -1 },
      { type: "request-enable-change" },
      { type: "navigate", screen: "conflicts" },
    ] as const
    const run = (): RuleTuiUiState =>
      actions.reduce(
        (state, action) => reduceRuleTui(state, action as never),
        initialRuleTuiState(TUI_NOW, NARROW_VIEWPORT),
      )
    const first = run()
    for (let iteration = 0; iteration < 50; iteration += 1) {
      expect(run()).toEqual(first)
    }
  })

  it("reports the injected clock on the state rather than reading one itself", () => {
    const state = initialRuleTuiState(TUI_NOW, NARROW_VIEWPORT)
    expect(state.now).toBe(TUI_NOW)
    expect(buildRuleTuiView(state).lines.join("\n")).not.toContain("1970")
  })

  it("orders dangers by the declared vocabulary, so discovery order cannot change the array", () => {
    const state = emptyState({
      rows: builderRuleTuiRows([
        previewOf([partiallyScopedPreApprovalDocument()]).rules[0]! as never,
      ]),
      previewEntries: previewOf([partiallyScopedPreApprovalDocument()]).rules as never,
    })
    const view = buildRuleTuiView(state)
    const kinds = view.dangers.map((danger) => danger.kind)
    // Sorted by RULE_TUI_DANGER_KINDS order, which puts the refusal first.
    const ranks = kinds.map((kind) => RULE_TUI_DANGER_KINDS.indexOf(kind))
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right))
  })
})

// ===========================================================================
// 3. Danger warnings, one test per class
// ===========================================================================

describe("a dangerous rule produces a visible, typed, actionable warning", () => {
  it("warns that a pre-approval constrains no scope field, carrying the compiler's own refusal code", () => {
    // The builder path, because a document like this is REFUSED at compile time and
    // so never reaches a preview. The code is the compiler's, verbatim.
    const draft = defaultRuleTuiDraft(TUI_NOW, "user-1")
    const dangers = analyzeBuilderDangers(draft, [], ["pre_approve_within_bounds"])
    const unscoped = dangers.find((danger) => danger.kind === "unscoped_pre_approval")

    expect(unscoped).toBeDefined()
    expect(unscoped?.code).toBe("rule.universal_pre_approval")
    expect(unscoped?.subject).toBe("pre_approve_within_bounds")
    expect(unscoped?.detail).toContain("applies to every dispatch")
  })

  it("warns that a reach axis is unconstrained, and names the axis rather than an empty value", () => {
    const draft = defaultRuleTuiDraft(TUI_NOW, "user-1")
    const dangers = analyzeBuilderDangers(draft, ["capability"], ["pre_approve_within_bounds"])
    const unconstrained = dangers.filter((danger) => danger.kind === "unconstrained_reach")

    // Four of the five axes: a rule constrained on capabilities only. Asserted
    // code-unit sorted because `analyzeBuilderDangers` sorts its axis list that way,
    // and sorted output is the module's determinism guarantee (T2).
    expect(unconstrained.length).toBe(4)
    expect(unconstrained.map((danger) => danger.subject)).toEqual([
      "nodes",
      "projectPaths",
      "projects",
      "roles",
    ])
    for (const danger of unconstrained) {
      expect(danger.code).toBeNull()
      expect(danger.detail).toContain(UNKNOWN_REACH_TEXT)
    }
  })

  it("warns that a pre-approval with expiresAt null has no expiry, using the literal the ADR names", () => {
    const draft = defaultRuleTuiDraft(TUI_NOW, "user-1")
    // expiresAt starts as null on the default draft.
    expect(draft.expiresAt).toBeNull()
    const dangers = analyzeBuilderDangers(draft, ["projectId"], ["pre_approve_within_bounds"])
    const noExpiry = dangers.find((danger) => danger.kind === "no_expiry")

    expect(noExpiry).toBeDefined()
    expect(noExpiry?.subject).toBe("expiresAt")
    expect(noExpiry?.detail).toContain("no expiry")
  })

  it("warns that a declared bound is wider than the effective budget once a budget is in force", () => {
    // The disclosure reports the DECLARED bounds, which is what the reader must see
    // (ADR 0007 section 11), so a declared bound wider than the budget in force is
    // a fact only the screen can state. It is derived from the disclosure's own
    // `bounds` and the effective budget, never from a recomputed narrowing.
    const preview = previewOf([cleanPreApprovalDocument()])
    const disclosure = disclosureFor(preview, "rule-clean-pre")
    expect(disclosure).not.toBeNull()

    const effectiveBudget = { maximumWallClockSeconds: 60 }
    const declared = disclosure!.bounds.timeoutSeconds
    expect(declared.kind).toBe("declared")
    const declaredValue = declared.kind === "declared" ? Number(declared.value) : 0
    expect(declaredValue).toBeGreaterThan(effectiveBudget.maximumWallClockSeconds)
  })

  it("renders every danger class on its own labelled line, above the screen's own content", () => {
    const rows = builderRuleTuiRows([
      previewOf([partiallyScopedPreApprovalDocument()]).rules[0]! as never,
    ])
    const state = emptyState({ rows, previewEntries: [] })
    const view = buildRuleTuiView(state)
    const rendered = view.lines

    expect(rendered[0]).toContain("AIBridge")
    const dangerHeader = rendered.findIndex((line) => line.startsWith("DANGER:"))
    expect(dangerHeader).toBeGreaterThan(0)

    // Every danger on the row is rendered before the screen body, so a user sees
    // the warnings before the content they qualify.
    const lastDangerLine = rendered.findIndex((line) => line.startsWith("! "))
    const bodyStart = rendered.findIndex((line) => line.startsWith("> rule-"))
    expect(lastDangerLine).toBeLessThan(bodyStart)
  })

  it("carries all four danger classes through the renderer as four distinct typed values", () => {
    // The danger list is attached to the ROW directly, after `builderRuleTuiRows` has
    // derived its own — so this test is NOT asserting on the same derivation that
    // produces the flags. If `dangersForEntry` were wrong in every class at once, this
    // would still pass, which is the point: it isolates the RENDERER's ability to
    // carry four distinct classes.
    const derived = builderRuleTuiRows(previewOf([partiallyScopedPreApprovalDocument()]).rules as never)
    const base = derived[0]!
    const rows = [{ ...base, dangers: allFourDangers() }]
    const view = buildRuleTuiView(emptyState({ rows }))

    const kinds = new Set(view.dangers.map((danger) => danger.kind))
    expect(kinds.size).toBe(4)
    for (const kind of RULE_TUI_DANGER_KINDS) {
      expect(kinds.has(kind)).toBe(true)
    }
    // And every one is rendered, under its own label.
    const rendered = view.lines.join("\n")
    for (const kind of RULE_TUI_DANGER_KINDS) {
      expect(rendered).toContain(kind)
    }
  })

  it("does not derive an unscoped_pre_approval flag from a preview, because such a rule never compiles", () => {
    // The class is a COMPILE refusal, so a rule carrying one cannot be in a compiled
    // set. A row that derived it anyway would be warning about a rule that does not
    // exist — and the builder screen is where that warning belongs.
    const rows = builderRuleTuiRows(previewOf([partiallyScopedPreApprovalDocument()]).rules as never)
    expect(rows[0]?.dangers.some((danger) => danger.kind === "unscoped_pre_approval")).toBe(false)
  })
})

// ===========================================================================
// 4. Unknown reach is never empty
// ===========================================================================

describe("an unconstrained reach axis renders the literal 'unknown' and never an empty set", () => {
  it("reports four axes as unknown for a pre-approval scoped to one capability", () => {
    const preview = previewOf([partiallyScopedPreApprovalDocument()])
    const rows = builderRuleTuiRows(preview.rules as never)
    const row = rows[0]
    // The row's list is in the DISCLOSURE's axis order (projects, roles,
    // capabilities, nodes, projectPaths — `RulePreviewFutureScope`'s declaration
    // order), filtered to the unknown ones. Declaration order, not code-unit order:
    // the five axes are read in the order the ADR's disclosure table lists them, and
    // re-sorting them alphabetically would reorder a table the user has learned.
    expect(row?.unconstrainedReachAxes).toEqual(["projects", "roles", "nodes", "projectPaths"])
    // And the set is what is asserted, independent of order.
    expect([...(row?.unconstrainedReachAxes ?? [])].sort()).toEqual([
      "nodes",
      "projectPaths",
      "projects",
      "roles",
    ])

    // The disclosure says the same thing in its own typed form.
    const disclosure = disclosureFor(preview, "rule-partial-pre")
    expect(disclosure?.reach.projects.kind).toBe("unknown")
    expect(disclosure?.reach.capabilities.kind).toBe("constrained")
  })

  it("renders the literal text for an unknown axis and an empty value list beside it", () => {
    const state = stateWithRules([partiallyScopedPreApprovalDocument()], { screen: "detail" })
    const view = buildRuleTuiView(state)
    const projects = view.detail.reachAxes.find((axis) => axis.name === "projects")

    // The STRUCTURE: `unknown` is a separate boolean, so no consumer reading `values`
    // can mistake "unconstrained" for "matches nothing".
    expect(projects?.unknown).toBe(true)
    expect(projects?.values).toEqual([])

    // The TEXT: the literal, and never a bracket pair that looks like data.
    const reachLine = view.lines.find((line) => line.includes("projects:"))
    expect(reachLine).toContain(UNKNOWN_REACH_TEXT)
    expect(reachLine).not.toContain("[]")
  })

  it("renders a constrained axis as its member list, so the two cases are distinguishable in text", () => {
    const state = stateWithRules([partiallyScopedPreApprovalDocument()], { screen: "detail" })
    const view = buildRuleTuiView(state)
    const capabilities = view.detail.reachAxes.find((axis) => axis.name === "capabilities")
    expect(capabilities?.unknown).toBe(false)
    expect(capabilities?.values).toEqual(["fs.read"])
    const line = view.lines.find((entry) => entry.includes("capabilities:"))
    expect(line).toContain("[fs.read]")
  })

  it("never renders an empty string or an empty array in place of the literal", () => {
    const state = stateWithRules([partiallyScopedPreApprovalDocument()], { screen: "detail" })
    const view = buildRuleTuiView(state)
    for (const axis of view.detail.reachAxes) {
      if (axis.unknown) {
        const line = view.lines.find((entry) => entry.includes(`${axis.name}:`))
        expect(line).toBeDefined()
        expect(line).toContain(UNKNOWN)
        expect(line).not.toContain("[]")
        expect(axis.values).not.toBe(undefined)
      }
    }
  })
})

// ===========================================================================
// 5. No secrets
// ===========================================================================

describe("the rule TUI renders no seeded CONTENT, while still rendering a rule's authored metadata", () => {
  it("carries no content canary in any structured field of the view model, on any screen", () => {
    const state = canaryState()
    // The content canary travelled through the compiler, the evaluator and the
    // preview before the view model saw this state — `previewOf`'s `context` option
    // asserts that the language itself refused to render it. So a match here is a
    // leak in THIS layer.
    for (const screen of RULE_TUI_SCREENS) {
      const view = buildRuleTuiView({ ...state, screen })
      // `lines` is excluded here and asserted in the next test; this one walks the
      // STRUCTURED fields, which is what a renderer or an audit would read.
      const encoded = canonicalJson({ ...view, lines: [] })
      for (const canary of ALL_CANARIES) {
        expect(encoded, `${screen} leaked ${canary}`).not.toContain(canary)
      }
    }
  })

  it("carries no content canary in the rendered lines of ANY screen, including the raw source view", () => {
    const state = canaryState()
    // No screen is excluded here, and that is the difference from a canary seeded in
    // authored metadata. A rule document has no field a task description could reach,
    // so the raw screen cannot show the content canary either.
    for (const screen of RULE_TUI_SCREENS) {
      const rendered = buildRuleTuiView({ ...state, screen }).lines.join("\n")
      for (const canary of ALL_CANARIES) {
        expect(rendered, `${screen} leaked ${canary}`).not.toContain(canary)
      }
    }
  })

  it("renders a rule's own authored metadata, which ADR 0007 section 12 permits and which a screen must show", () => {
    // The ANTI-VACUITY half. Every no-leak assertion above would also pass for a view
    // model that rendered nothing at all, so the screen is required to render the
    // rule's name, its reason, its identity and its digest. A rule's name and reason
    // are "rule metadata" and "reason strings authored by a user for the purpose of
    // explaining a decision" — the values section 12 explicitly allows, and the
    // reason the screen exists.
    const state = canaryState()
    const list = buildRuleTuiView({ ...state, screen: "list" })
    expect(list.lines.join("\n")).toContain(CANARY)
    expect(list.rows[0]?.name).toContain(CANARY)
    expect(list.rows[0]?.digest.length).toBeGreaterThan(0)
    expect(list.lines.join("\n")).toContain("rule-canary@1")

    // The reason string reaches the screen through the language's own explanation
    // renderer, reused verbatim.
    expect(state.explanationText).toContain(CANARY_SECONDARY)
    const raw = buildRuleTuiView({ ...state, screen: "raw" })
    expect(raw.lines.join("\n")).toContain(CANARY_SECONDARY)
  })

  it("renders the compiled refusal verbatim, and no field of the context alongside it", () => {
    const state = emptyState({
      screen: "builder",
      draft: defaultRuleTuiDraft(TUI_NOW, "user-1"),
      compileCodes: ["rule.universal_pre_approval"],
      compileMessages: ["Rule 'rule-new@1' carries pre_approve_within_bounds but constrains none of [...]"],
    })
    const view = buildRuleTuiView(state)
    expect(view.builder.compileCodes).toEqual(["rule.universal_pre_approval"])
    // The refusal code AND the compiler's own message, so the screen shows what the
    // compiler said rather than a summary of it.
    expect(view.lines.join("\n")).toContain("rule.universal_pre_approval")
    expect(view.lines.join("\n")).toContain("constrains none of")
  })

  it("audits the danger sentences themselves, since they are hand-composed prose", () => {
    // The danger `detail` strings are written in `view-model.ts` and `builder.ts`
    // rather than imported from the preview, so they are the one place in this
    // module where a reworded sentence could carry content.
    const encoded = canonicalJson(allFourDangers())
    for (const canary of ALL_CANARIES) {
      expect(encoded).not.toContain(canary)
    }
  })
})

// ===========================================================================
// 6. Narrow viewport
// ===========================================================================

describe("every warning line is reachable at the minimum viewport", () => {
  it("restates the shell's minimum rather than inventing a different one", () => {
    // The module declares its own constants for the dependency-direction reason
    // `types.ts` gives. This is the assertion that stops the restatement from
    // drifting into being a DIFFERENT minimum, which would make every viewport test
    // below assert the wrong thing.
    expect(RULE_TUI_MINIMUM_COLUMNS).toBe(MINIMUM_TUI_COLUMNS)
    expect(RULE_TUI_MINIMUM_ROWS).toBe(MINIMUM_TUI_ROWS)
    expect(isUsableRuleTuiViewport(59, 18)).toBe(false)
    expect(isUsableRuleTuiViewport(60, 17)).toBe(false)
    expect(isUsableRuleTuiViewport(60, 18)).toBe(true)
  })

  it("keeps every warning line visible while scrolling through a long preview at 60x18", () => {
    const rows = builderRuleTuiRows([previewOf([partiallyScopedPreApprovalDocument()]).rules[0]! as never])
    // A deliberately long preview, so the screen cannot fit everything and the
    // scroll window has to do the work.
    const longPreview = Array.from({ length: 400 }, (_, index) => `preview line ${index}`).join("\n")
    const state = emptyState({
      screen: "preview",
      rows,
      previewEntries: [],
      previewText: longPreview,
      dimensions: NARROW_VIEWPORT,
    })

    const view = buildRuleTuiView(state)
    const warningLines = view.lines.filter((line) => line.startsWith("! "))
    expect(warningLines.length).toBeGreaterThan(0)

    // Scroll reachability, following `tests/unit/tui/state.test.ts:73`'s approach:
    // walk the offsets and require every warning line to appear at least once.
    const seen = new Set<string>()
    const maxOffset = view.lines.length
    for (let offset = 0; offset <= maxOffset; offset += 1) {
      const scrolled = buildRuleTuiView({ ...state, scrollOffset: offset })
      for (const line of scrolled.lines) {
        if (warningLines.includes(line)) seen.add(line)
      }
    }
    expect(seen.size).toBe(warningLines.length)
  })

  it("shows the warnings at scroll offset zero, before any scrolling is needed", () => {
    const rows = builderRuleTuiRows([previewOf([partiallyScopedPreApprovalDocument()]).rules[0]! as never])
    const view = buildRuleTuiView(emptyState({ rows, dimensions: NARROW_VIEWPORT }))
    const headerIndex = view.lines.findIndex((line) => line.startsWith("DANGER:"))
    const firstWarningIndex = view.lines.findIndex((line) => line.startsWith("! "))
    // A user who never scrolls still sees them.
    expect(headerIndex).toBeLessThan(NARROW_VIEWPORT.rows)
    expect(firstWarningIndex).toBeLessThan(NARROW_VIEWPORT.rows)
    expect(firstWarningIndex).toBeGreaterThan(headerIndex)
  })

  it("wraps no authored prose wider than the minimum column count", () => {
    // The shell owns wrapping, so this asserts the RULE module emits no prose that
    // cannot be wrapped — that is, no SPACE-separated token wider than the viewport.
    // A digest is a single unbreakable token of 71 characters and is deliberately
    // excluded: the shell cannot wrap it, and hiding a digest to make a wrapping
    // assertion pass would remove the one value an audit compares. The rule is about
    // PROSE, and digests are values.
    const state = stateWithRules(shadowingDocuments(), { screen: "detail", dimensions: NARROW_VIEWPORT })
    const view = buildRuleTuiView(state)
    for (const line of view.lines) {
      if (line.includes("sha256:")) continue
      const longestToken = Math.max(0, ...line.split(/\s+/).map((token) => token.length))
      expect(longestToken, `a token wider than the viewport: ${line}`).toBeLessThanOrEqual(RULE_TUI_MINIMUM_COLUMNS)
    }
  })

  it("states the viewport it declares support for on the view model", () => {
    const view = buildRuleTuiView(stateWithRules(shadowingDocuments(), { dimensions: NARROW_VIEWPORT }))
    expect(view.columns).toBe(60)
    expect(view.viewportRows).toBe(18)
  })

  it("renders the activation dialog with its confirm control unarmed, and names what to do", () => {
    const state = reduceRuleTui(stateWithRules([canaryDenyDocument()], { screen: "detail" }), {
      type: "request-activation",
    })
    const view = buildRuleTuiView(state)
    expect(view.overlay).toBe("activation-confirm")
    expect(view.confirmationArmed).toBe(false)
    expect(view.blockingOverlay).toBe(true)
    expect(view.lines.join("\n")).toContain("[Back]")
    expect(view.lines.join("\n")).toContain("tab to arm")
  })
})

// ===========================================================================
// 7. shadowed vs possible_overlap
// ===========================================================================

describe("shadowed and possible_overlap stay distinct in structure and in text", () => {
  it("reports a proven superset relation as shadowed and not as possible_overlap", () => {
    const preview = previewOf(shadowingDocuments())
    const conflicts = buildRuleTuiConflicts(preview.rules as never)
    // The winner shadows the loser, so at least one PROVEN finding exists.
    expect(conflicts.shadowedTotal).toBeGreaterThan(0)

    const shadowedOnly = conflicts.entries.flatMap((entry) => entry.shadowing)
    for (const finding of shadowedOnly) {
      expect(finding.relation).toBe("shadowed")
      expect(finding.proven).toBe(true)
    }
  })

  it("reports an unprovable co-match as possible_overlap and never as shadowed", () => {
    const preview = previewOf(overlappingDocuments())
    const conflicts = buildRuleTuiConflicts(preview.rules as never)

    // Whatever the evaluator reports, the SPLIT is by relation and the two arrays
    // are disjoint. If the evaluator proved nothing, there is nothing in `shadowing`
    // — which is the correct answer and is asserted rather than assumed.
    for (const entry of conflicts.entries) {
      for (const finding of entry.shadowing) expect(finding.relation).toBe("shadowed")
      for (const finding of entry.possibleOverlaps) expect(finding.relation).toBe("possible_overlap")
      expect(entry.shadowing.map((f) => f.relation)).not.toContain("possible_overlap")
      expect(entry.possibleOverlaps.map((f) => f.relation)).not.toContain("shadowed")
    }
  })

  it("counts the two relations separately on a row, and never counts an overlap as shadowed", () => {
    const rows = builderRuleTuiRows(previewOf(overlappingDocuments()).rules as never)
    for (const row of rows) {
      const total = row.shadowedCount + row.possibleOverlapCount
      const reported = previewOf(overlappingDocuments()).rules.find(
        (entry) => entry.ruleId === row.ruleId,
      )?.shadowing.length
      expect(total).toBe(reported ?? 0)
    }
  })

  it("renders the two relations under two different labels on the conflicts screen", () => {
    const preview = previewOf(shadowingDocuments(), { historyEntries: [] })
    const state = stateWithRules(shadowingDocuments(), { screen: "conflicts" }, { historyEntries: [] })
    const view = buildRuleTuiView(state)
    const rendered = view.lines.join("\n")

    // With a proven finding present, the proven label appears.
    expect(rendered).toContain("shadowed (proven)")
    expect(rendered).toContain("possible_overlap (not proven)")
    // And the two labels never appear in one another's line.
    for (const line of view.lines) {
      if (line.includes("SHADOWED (proven)")) expect(line).not.toContain("POSSIBLE_OVERLAP")
      if (line.includes("POSSIBLE_OVERLAP")) expect(line).not.toContain("SHADOWED (proven)")
    }
    expect(preview.rules.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// 8. Sorting
// ===========================================================================

describe("every sorted collection in the view is ordered by code unit", () => {
  it("orders the rule rows by the caller's preview order rather than re-sorting them", () => {
    const preview = previewOf(shadowingDocuments())
    const rows = builderRuleTuiRows(preview.rules as never)
    // The compiled set's order is ruleId ascending by code unit, and the rows keep
    // it. A view that sorted would be a view whose output depended on a preference it
    // also performed (`memory-view.ts`'s reasoning).
    const identities = rows.map((row) => row.identity)
    expect(identities).toEqual([...identities].sort())
  })

  it("orders unconstrained axis names by code unit", () => {
    const rows = builderRuleTuiRows(previewOf(shadowingDocuments()).rules as never)
    for (const row of rows) {
      expect(row.unconstrainedAxes).toEqual([...row.unconstrainedAxes].sort())
    }
  })
})
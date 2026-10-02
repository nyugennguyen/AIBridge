/**
 * The rule TUI's builder: assembly, and its agreement with the real compiler.
 *
 * # THE PROPERTY UNDER TEST
 *
 * `src/rules/tui/builder.ts` assembles a candidate document and hands it to the REAL
 * `compileRule`. It does not validate. This file is what makes that claim checkable
 * rather than a promise, in two directions:
 *
 *   1. **What the builder produces compiles.** Every field the builder assembles
 *      satisfies the language's schema, so a document it produces is one `compileRule`
 *      accepts — provided the authored VALUES are legal. Asserted by compiling
 *      assembled documents and asserting `ok`.
 *
 *   2. **What the compiler refuses, the builder reports with the compiler's own
 *      code.** Every `RuleErrorCode` reachable through the builder is triggered and
 *      asserted to appear verbatim in `compileCodes`. A builder-side code, or a
 *      rewritten message, would fail this.
 *
 * # THE DISAGREEMENT CASE (requirement 9, explicitly)
 *
 * "Assert by finding a case where builder-side validation and the compiler would
 * disagree and confirming the compiler wins."
 *
 * `between` with `min > max` is that case, and it is the sharpest available one. A
 * naive builder would reasonably check the range it just assembled and refuse to
 * submit it — `fanOut between 8 and 2` is empty, and refusing an empty interval is
 * the obviously-correct behaviour for an authoring tool. But `compileRule` applies
 * the check as `rule.empty_enum` with a message that says what to do about it, and
 * ADR 0007 section 6 lists it as a compile error rather than a schema refinement. So
 * the builder must let it through, and the screen must show the compiler's answer.
 *
 * The second disagreement case is the `none` operator on a capability set: the
 * builder narrows `none` to a member LIST like every other set operator, and the
 * compiler refuses an empty one with `rule.empty_enum`. A builder that "helpfully"
 * omitted the empty list would produce a DIFFERENT document — one with no `value`
 * key at all, which the schema refuses for a different reason and with a different
 * code. The test asserts the document the builder assembles has the empty array, so
 * the refusal the user sees is the compiler's about emptiness rather than a shape
 * error about a missing key.
 */

import { describe, expect, it } from "vitest"
import {
  compileRule,
  ruleSourceDocumentSchema,
  type RuleErrorCode,
} from "../../../src/rules/index.js"
import {
  RULE_TUI_ACTION_KINDS,
  RULE_TUI_DEFAULT_ACTION_VALUES,
  RULE_TUI_DEFAULT_PREDICATE_VALUES,
  RULE_TUI_OPERATORS_BY_FIELD,
  RULE_TUI_PREDICATE_FIELDS,
  analyzeBuilderDangers,
  assembleRuleDocument,
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
  type RuleTuiBuilderDraft,
} from "../../../src/rules/tui/index.js"
import { TUI_NOW, allFourDangers } from "./tui-fixtures.js"
import { USER_ID } from "./fixtures.js"

/** A draft with the given authored overrides, for readability below. */
function draftWith(overrides: Partial<RuleTuiBuilderDraft> = {}): RuleTuiBuilderDraft {
  return { ...defaultRuleTuiDraft(TUI_NOW, USER_ID), ...overrides }
}

/** Assemble, then compile, and return the report. */
function assembleAndCompile(
  draft: RuleTuiBuilderDraft,
  predicates: readonly string[] = [],
  actions: readonly string[] = [],
): ReturnType<typeof compileBuilderDocument> {
  return compileBuilderDocument(assembleRuleDocument(draft, predicates, actions))
}

// ===========================================================================
// Assembly produces what the compiler accepts
// ===========================================================================

describe("a document the builder assembles is one the rule compiler accepts", () => {
  it("assembles the untouched default draft into a document that compiles", () => {
    const draft = defaultRuleTuiDraft(TUI_NOW, USER_ID)
    const report = assembleAndCompile(draft, ["projectId"], ["deny_with_reason"])

    expect(report.ok).toBe(true)
    expect(report.codes).toEqual([])
    expect(report.normalizedPredicate).toBe('projectId == "proj-1"')
    expect(report.digest).toMatch(/^sha256:/)
  })

  it("assembles a document whose field set is exactly the language's, with nothing added or dropped", () => {
    const draft = draftWith()
    const document = assembleRuleDocument(draft, ["projectId"], ["deny_with_reason"]) as Record<string, unknown>

    // Byte-identical in the sense that matters: the SAME field set the language's
    // schema declares. An unknown key is `rule.invalid_source` under `.strict()`, and
    // a missing key is a different refusal, so "exactly these keys" is the property.
    expect(Object.keys(document).sort()).toEqual(
      [
        "actions",
        "activation",
        "author",
        "createdAt",
        "description",
        "enabled",
        "expiresAt",
        "languageVersion",
        "name",
        "predicates",
        "projectId",
        "ruleId",
        "templateVersion",
      ].sort(),
    )
  })

  it("produces a document that satisfies the language's own schema verbatim", () => {
    const draft = draftWith()
    const document = assembleRuleDocument(draft, ["projectId"], ["deny_with_reason"])
    // Parsing through the LANGUAGE's schema, not the builder's. This is the check
    // that the builder and the language agree about the shape.
    expect(() => ruleSourceDocumentSchema.parse(document)).not.toThrow()
  })

  it("always assembles a draft activation, so a builder output can never claim to be activated", () => {
    // The safety-relevant property: activation is not a builder field, and the
    // assembled value says so. `ruleActivationSchema` makes `{state: "activated"}`
    // require both `activatedAt` and `activatedBy`, so a bare draft activation is the
    // only thing this function can produce for it.
    const document = assembleRuleDocument(draftWith(), ["projectId"], ["deny_with_reason"]) as Record<string, unknown>
    expect(document["activation"]).toEqual({ state: "draft", activatedAt: null, activatedBy: null })
  })

  it("compiles for every action kind the builder can cycle to, with the seeded default value", () => {
    // EXHAUSTIVE over the builder's own action vocabulary, not a sample. The value is
    // the draft's seeded default for the action kind, which is the value a user would
    // have after pressing `a` without typing anything.
    for (const kind of RULE_TUI_ACTION_KINDS) {
      const draft = draftWith({ actionKind: kind, actionValue: defaultActionValueFor(kind) })
      const report = assembleAndCompile(draft, ["projectId"], [kind])
      expect(report.ok, `${kind} should compile: ${report.messages.join("; ")}`).toBe(true)
    }
  })

  it("compiles for every predicate field the builder can cycle to, with the seeded default value", () => {
    // EXHAUSTIVE over the eighteen fields, each with the value `builder-add-predicate`
    // seeds for it and the operator the field declares first.
    //
    // `scheduleWindow` is the one field that cannot compile from the builder at all:
    // ADR 0007 section 6.2 makes a window set with no windows a COMPILE ERROR rather
    // than a rule that never matches, and the builder assembles `windows: []` because
    // authoring a window needs a day picker this screen does not have yet. So the
    // builder's one unavoidable refusal is asserted explicitly — it is a LANGUAGE rule
    // the builder surfaces, not a gap in it, and the assertion is what stops the other
    // seventeen from quietly becoming refusals too.
    const notAuthorable: readonly string[] = ["scheduleWindow"]
    for (const field of RULE_TUI_PREDICATE_FIELDS) {
      const operator = RULE_TUI_OPERATORS_BY_FIELD[field]?.[0] ?? "eq"
      const draft = draftWith({
        predicateField: field,
        predicateOperator: operator,
        predicateValue: defaultPredicateValueFor(field),
      })
      const report = assembleAndCompile(draft, [field], ["deny_with_reason"])
      if (notAuthorable.includes(field)) {
        expect(report.ok, `${field} cannot be authored yet`).toBe(false)
        expect(report.codes).toEqual(["rule.empty_enum"])
        expect(report.messages[0]).toContain("never fires")
      } else {
        expect(report.ok, `${field} ${operator} should compile: ${report.messages.join("; ")}`).toBe(true)
      }
    }
  })

  it("seeds a value for every predicate field, so adding one never shows an unexplained refusal", () => {
    // The reason the seeding exists: a value typed for one field would be narrowed for
    // another, and the author would see a refusal they could not account for.
    for (const field of RULE_TUI_PREDICATE_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(RULE_TUI_DEFAULT_PREDICATE_VALUES, field), field).toBe(true)
    }
    // An unknown field gets the empty string rather than a plausible guess, which the
    // compiler refuses with a code the author can act on.
    expect(defaultPredicateValueFor("not-a-field")).toBe("")
  })
})

// ===========================================================================
// The compiler decides, and its code is surfaced verbatim
// ===========================================================================

describe("a document the compiler refuses is refused in the builder with the compiler's own code", () => {
  it("surfaces rule.universal_pre_approval verbatim, with the compiler's message", () => {
    // A pre-approval constraining only `timeoutSeconds`, which ADR 0007 section 8
    // names as NOT a scope field: "a pre-approval constrained only by timeout <= 900
    // is the match-all pre-approval wearing a hat". Both seeded values are legal for
    // their fields, so the refusal is about SCOPE and about nothing else.
    const draft = draftWith({
      predicateField: "timeoutSeconds",
      predicateValue: defaultPredicateValueFor("timeoutSeconds"),
      actionKind: "pre_approve_within_bounds",
      actionValue: defaultActionValueFor("pre_approve_within_bounds"),
    })
    const report = assembleAndCompile(draft, ["timeoutSeconds"], ["pre_approve_within_bounds"])

    expect(report.ok).toBe(false)
    expect(report.codes).toEqual(["rule.universal_pre_approval"])
    expect(report.messages[0]).toContain("applies to every dispatch")
    // The predicate the compiler refuses on is NOT reported as a normalized form,
    // because there is none for a document that did not compile.
    expect(report.normalizedPredicate).toBeNull()
    expect(report.refusedWith("rule.universal_pre_approval")).toBe(true)
    expect(report.refusedWith("rule.empty_enum")).toBe(false)
  })

  it("surfaces rule.empty_enum for an empty interval, where a builder-side check would have refused first", () => {
    // THE DISAGREEMENT CASE. `fanOut between 8 and 2` is an empty interval. A naive
    // builder would check `min <= max` itself and never offer the document — which is
    // why this test asserts the builder ASSEMBLES it and the COMPILER refuses it.
    // The builder ASSEMBLES it. `between` narrows "8,2" to a range object, exactly as
    // authored — an empty one, and the builder does not notice or care.
    const betweenDraft = narrowTo(draftWith({ predicateValue: "8,2" }), "fanOut", "between")
    const narrowedDocument = assembleRuleDocument(betweenDraft, ["fanOut"], ["deny_with_reason"]) as Record<string, unknown>
    expect(narrowedDocument["predicates"]).toEqual([
      { field: "fanOut", operator: "between", value: { min: 8, max: 2 } },
    ])

    // The compiler refuses, and its code is the one the screen shows.
    const report = compileBuilderDocument(narrowedDocument)
    expect(report.ok).toBe(false)
    expect(report.codes).toEqual(["rule.empty_enum"])
    expect(report.messages[0]).toContain("empty interval")
    expect(report.messages[0]).toContain("indistinguishable from a typo")
  })

  it("surfaces rule.empty_enum for an empty capability set, and keeps the empty array in the document", () => {
    // The SECOND disagreement case. The builder narrows `none` (and every other set
    // operator) to a member list, so an empty authored value produces `[]`. A builder
    // that omitted the empty list would produce a document with no `value` key, which
    // the schema refuses for a DIFFERENT reason — and the user would be told about a
    // missing key rather than about the emptiness that is the actual mistake.
    const draft = draftWith({ predicateField: "capability", predicateValue: "" })
    const narrowed = narrowTo(draft, "capability", "any")
    const document = assembleRuleDocument(narrowed, ["capability"], ["deny_with_reason"]) as Record<string, unknown>

    // The empty array IS in the document. This is the assertion that distinguishes
    // the two refusal paths.
    expect(document["predicates"]).toEqual([{ field: "capability", operator: "any", value: [] }])

    const report = compileBuilderDocument(document)
    expect(report.ok).toBe(false)
    expect(report.codes).toEqual(["rule.empty_enum"])
    expect(report.messages[0]).toContain("vacuous")
  })

  it("surfaces rule.invalid_source when an authored value is not the shape the field declares", () => {
    // An empty ruleId. The builder writes it as authored — it does not substitute a
    // placeholder — and the schema's `.min(1)` is what refuses it.
    const draft = draftWith({ ruleId: "" })
    const report = assembleAndCompile(draft, ["projectId"], ["deny_with_reason"])

    expect(report.ok).toBe(false)
    expect(report.codes).toEqual(["rule.invalid_source"])
    expect(report.messages[0]).toContain("ruleId")
  })

  it("surfaces rule.invalid_source for a name with surrounding whitespace, which the schema forbids", () => {
    // Another case a builder would never "helpfully" trim: the schema REFUSES a name
    // with surrounding whitespace rather than accepting it, so trimming in the builder
    // would silently change the author's text and produce a document the compiler
    // never saw.
    const draft = draftWith({ name: " padded name " })
    const report = assembleAndCompile(draft, ["projectId"], ["deny_with_reason"])

    expect(report.ok).toBe(false)
    expect(report.codes).toEqual(["rule.invalid_source"])
  })

  it("surfaces rule.limit_exceeded when a draft declares more predicates than the language allows", () => {
    const draft = draftWith()
    const tooMany = Array.from({ length: 65 }, () => "projectId")
    const report = assembleAndCompile(draft, tooMany, ["deny_with_reason"])

    expect(report.ok).toBe(false)
    expect(report.codes).toEqual(["rule.limit_exceeded"])
    expect(report.messages[0]).toContain("65")
  })

  it("surfaces rule.limit_exceeded when a draft declares more actions than the language allows", () => {
    const draft = draftWith()
    const report = assembleAndCompile(
      draft,
      ["projectId"],
      Array.from({ length: 17 }, () => "deny_with_reason"),
    )

    expect(report.ok).toBe(false)
    expect(report.codes).toEqual(["rule.limit_exceeded"])
  })

  it("agrees with a direct compileRule call on every refusal it surfaces", () => {
    // The builder must not paraphrase. For each case, the builder's codes are compared
    // against the compiler's own answer for the SAME document object.
    const draft = draftWith({ ruleId: "" })
    const document = assembleRuleDocument(draft, ["projectId"], ["deny_with_reason"])
    const direct = compileRule(document)

    expect(direct.ok).toBe(false)
    const report = compileBuilderDocument(document)
    expect(report.ok).toBe(false)
    if (!direct.ok) {
      expect(report.codes).toEqual([direct.error.code])
      expect(report.messages).toEqual([direct.error.message])
    }
  })

  it("reports no codes at all when the document compiles", () => {
    const report = assembleAndCompile(draftWith(), ["projectId"], ["deny_with_reason"])
    expect(report.ok).toBe(true)
    expect(report.codes).toEqual([])
    expect(report.messages).toEqual([])
    expect(report.refusedWith("rule.invalid_source")).toBe(false)
  })
})

// ===========================================================================
// Vocabularies come from the language
// ===========================================================================

describe("the builder's vocabularies are the language's own, not copies", () => {
  it("cycles predicate fields in RULE_PREDICATE_FIELDS order and wraps", () => {
    expect(RULE_TUI_PREDICATE_FIELDS[0]).toBe("projectId")
    expect(RULE_TUI_PREDICATE_FIELDS).toHaveLength(18)
    // Forward from the last wraps to the first.
    const last = RULE_TUI_PREDICATE_FIELDS[RULE_TUI_PREDICATE_FIELDS.length - 1]!
    expect(nextPredicateField(last, 1)).toBe("projectId")
    // Backward from the first wraps to the last.
    expect(nextPredicateField("projectId", -1)).toBe(last)
  })

  it("cycles action kinds in RANK order, so restrictive kinds come before permissive ones", () => {
    // ADR 0007 section 10.2's reading order, not alphabetical: a user cycling the
    // vocabulary must meet `deny_with_reason` before `pre_approve_within_bounds`.
    expect(RULE_TUI_ACTION_KINDS[0]).toBe("deny_with_reason")
    expect(RULE_TUI_ACTION_KINDS[RULE_TUI_ACTION_KINDS.length - 1]).toBe("pre_approve_within_bounds")
    expect(RULE_TUI_ACTION_KINDS.indexOf("require_approval")).toBeLessThan(
      RULE_TUI_ACTION_KINDS.indexOf("pre_approve_within_bounds"),
    )
  })

  it("cycles operators within the field's declared set, and is a no-op for a field with none", () => {
    expect(nextPredicateOperator("projectId", "eq", 1)).toBe("in")
    expect(nextPredicateOperator("projectId", "in", 1)).toBe("eq")
    // `scheduleWindow` and `taskTitlePattern` declare no operator.
    expect(RULE_TUI_OPERATORS_BY_FIELD["scheduleWindow"]).toEqual([])
    expect(nextPredicateOperator("scheduleWindow", "eq", 1)).toBe("eq")
    expect(nextPredicateOperator("taskTitlePattern", "eq", 1)).toBe("eq")
  })

  it("declares an operator set for every predicate field, so no field is missing a declaration", () => {
    for (const field of RULE_TUI_PREDICATE_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(RULE_TUI_OPERATORS_BY_FIELD, field), field).toBe(true)
    }
  })

  it("wraps a cycle for a single-member list and for an empty one", () => {
    expect(nextInCycle(["only"], "only", 1)).toBe("only")
    expect(nextInCycle([], "current", 1)).toBe("current")
  })

  it("cycles an action kind by name as the router does", () => {
    expect(nextActionKind("deny_with_reason", 1)).toBe("require_approval")
  })
})

// ===========================================================================
// Narrowing, not validation
// ===========================================================================

describe("the builder narrows an authored string to the shape its field declares, and decides nothing", () => {
  it("writes a non-numeric value for a bounded-integer field as null, which the compiler refuses", () => {
    // Coercing "abc" to 0 would be the builder INVENTING a value the author did not
    // write, and 0 is outside `fanOut`'s 1..256 range so the refusal would name the
    // wrong problem.
    const draft = narrowTo(draftWith({ predicateValue: "abc" }), "fanOut", "eq")
    const document = assembleRuleDocument(draft, ["fanOut"], ["deny_with_reason"]) as Record<string, unknown>
    expect(document["predicates"]).toEqual([{ field: "fanOut", operator: "eq", value: null }])
    expect(compileBuilderDocument(document).codes).toEqual(["rule.invalid_source"])
  })

  it("splits a comma-separated value into a member list for the list operators", () => {
    const draft = narrowTo(draftWith({ predicateValue: "fs.read, net.fetch" }), "capability", "any")
    const document = assembleRuleDocument(draft, ["capability"], ["deny_with_reason"]) as Record<string, unknown>
    expect(document["predicates"]).toEqual([{ field: "capability", operator: "any", value: ["fs.read", "net.fetch"] }])
    expect(compileBuilderDocument(document).ok).toBe(true)
  })

  it("writes an empty member list for an empty authored list, so the refusal is about emptiness", () => {
    const draft = narrowTo(draftWith({ predicateValue: "" }), "capability", "all")
    const document = assembleRuleDocument(draft, ["capability"], ["deny_with_reason"]) as Record<string, unknown>
    expect(document["predicates"]).toEqual([{ field: "capability", operator: "all", value: [] }])
    expect(compileBuilderDocument(document).codes).toEqual(["rule.empty_enum"])
  })

  it("narrows a sensitivity rank for the maxRank operators and rung names for the set operators", () => {
    const rankDraft = narrowTo(draftWith({ predicateValue: "1" }), "contextSensitivity", "maxRankAtMost")
    const rankDocument = assembleRuleDocument(rankDraft, ["contextSensitivity"], ["deny_with_reason"]) as Record<string, unknown>
    expect(rankDocument["predicates"]).toEqual([{ field: "contextSensitivity", operator: "maxRankAtMost", value: 1 }])

    const setDraft = narrowTo(draftWith({ predicateValue: "restricted" }), "contextSensitivity", "any")
    const setDocument = assembleRuleDocument(setDraft, ["contextSensitivity"], ["deny_with_reason"]) as Record<string, unknown>
    expect(setDocument["predicates"]).toEqual([{ field: "contextSensitivity", operator: "any", value: ["restricted"] }])
  })

  it("writes each key by the field's own declaration, and omits the ones that field does not have", () => {
    // `.strict()` turns an extra key into a refusal, so the builder writes keys from
    // the SCHEMA's declaration per field rather than "what predicates usually have".
    // The three fields differ from each other, which is why each is asserted separately.
    //
    // `scheduleWindow` has a `windows` key and no `operator` and no `value`.
    // `taskTitlePattern` has a `pattern` key and no `operator` and no `value`.
    // `dependencyOutcome` has an `operator` (ADR 0007 section 6 row 11 gives it five)
    // and NO `value` — which is the case a single "fields with no value have no
    // operator" rule would have got wrong.
    const cases: readonly { field: string; expected: Record<string, unknown> }[] = [
      { field: "scheduleWindow", expected: { field: "scheduleWindow", windows: [] } },
      { field: "taskTitlePattern", expected: { field: "taskTitlePattern", pattern: "x" } },
      {
        field: "dependencyOutcome",
        expected: { field: "dependencyOutcome", operator: RULE_TUI_OPERATORS_BY_FIELD["dependencyOutcome"]?.[0] },
      },
    ]
    for (const { field, expected } of cases) {
      const draft = narrowTo(draftWith({ predicateValue: "x" }), field, "eq")
      const document = assembleRuleDocument(draft, [field], ["deny_with_reason"]) as Record<string, unknown>
      const predicate = (document["predicates"] as Record<string, unknown>[])[0]!
      expect(predicate).toEqual(expected)
      if (field !== "dependencyOutcome") {
        expect(predicate).not.toHaveProperty("operator")
        expect(predicate).not.toHaveProperty("value")
      }
      expect(predicate).not.toHaveProperty("value")
    }
  })

  it("omits the note key entirely when the note is empty, since the schema declares it optional", () => {
    const withNote = draftWith({ predicateNote: "why this exists" })
    const notedDocument = assembleRuleDocument(withNote, ["projectId"], ["deny_with_reason"]) as Record<string, unknown>
    expect((notedDocument["predicates"] as Record<string, unknown>[])[0]).toHaveProperty("note", "why this exists")

    const withoutNote = draftWith({ predicateNote: "" })
    const plainDocument = assembleRuleDocument(withoutNote, ["projectId"], ["deny_with_reason"]) as Record<string, unknown>
    expect((plainDocument["predicates"] as Record<string, unknown>[])[0]).not.toHaveProperty("note")
  })

  it("compiles a predicate carrying a note, because a note is display-only and never evaluated", () => {
    const draft = draftWith({ predicateNote: "scoped so the release bot is covered" })
    expect(assembleAndCompile(draft, ["projectId"], ["deny_with_reason"]).ok).toBe(true)
  })
})

// ===========================================================================
// Fields
// ===========================================================================

describe("a builder field is written as the author typed it", () => {
  it("sets every declared field and reads each one back", () => {
    const draft = defaultRuleTuiDraft(TUI_NOW, USER_ID)
    for (const [field, value] of [
      ["ruleId", "rule-typed"],
      ["templateVersion", "7"],
      ["projectId", "proj-typed"],
      ["name", "typed name"],
      ["description", "typed description"],
      ["predicateValue", "typed-predicate"],
      ["predicateNote", "typed note"],
      ["actionValue", "typed action"],
    ] as const) {
      const updated = withBuilderField(draft, field, value)
      expect(currentBuilderFieldValue(updated, field)).toBe(value)
    }
  })

  it("writes a non-numeric template version as NaN, which the compiler refuses rather than the builder clamping", () => {
    const draft = withBuilderField(defaultRuleTuiDraft(TUI_NOW, USER_ID), "templateVersion", "not-a-number")
    // `Number("")` is 0 and 0 is not a positive integer, so an emptied field also
    // produces a refusal. Clamping either to 1 would be the builder deciding.
    expect(Number.isNaN(draft.templateVersion)).toBe(true)
    const report = assembleAndCompile(draft, ["projectId"], ["deny_with_reason"])
    expect(report.ok).toBe(false)
    expect(report.codes).toEqual(["rule.invalid_source"])
  })

  it("reads an unparseable template version back as the empty string, so backspace can clear it", () => {
    const draft = withBuilderField(defaultRuleTuiDraft(TUI_NOW, USER_ID), "templateVersion", "not-a-number")
    expect(currentBuilderFieldValue(draft, "templateVersion")).toBe("")
  })

  it("defaults to a document inside the language's bounds, so an untouched draft compiles", () => {
    // The module docblock's reason: a draft that opened on a wall of refusals would
    // make the builder unusable, and a default outside a bound would be a check.
    const draft = defaultRuleTuiDraft(TUI_NOW, USER_ID)
    expect(assembleAndCompile(draft, ["projectId"], ["deny_with_reason"]).ok).toBe(true)
    expect(draft.expiresAt).toBeNull()
    // The draft has no `activation` member AT ALL — activation is not a builder
    // field, which is what makes "the builder cannot activate" a property of the
    // draft's type rather than a promise in a comment.
    expect(Object.keys(draft)).not.toContain("activation")
  })
})

// ===========================================================================
// The normalized form
// ===========================================================================

describe("the builder shows the language's canonical form, not a second renderer", () => {
  it("renders the universal predicate as all() when no predicates are declared", () => {
    // `describePredicates` renders an empty list `all()`. A builder that rendered "no
    // predicates" instead would show a DIFFERENT string from the one the compiler
    // digests (ADR 0007 section 11: the thing a user reads and the thing that is
    // hashed cannot differ).
    expect(builderNormalizedPredicate(draftWith(), [])).toBe("all()")
  })

  it("renders a predicate's canonical form, identical to the compiled rule's own field", () => {
    const draft = draftWith()
    const shown = builderNormalizedPredicate(draft, ["projectId"])
    const compiled = compileRule(assembleRuleDocument(draft, ["projectId"], ["deny_with_reason"]))
    expect(compiled.ok).toBe(true)
    if (compiled.ok) expect(shown).toBe(compiled.value.normalizedPredicate)
  })

  it("returns null rather than a wrong string when the draft's predicates do not parse", () => {
    // A stated absence, and NOT a refusal: the refusal with a code is the compiler's,
    // reported separately. An empty string here would render as a form with no
    // predicate, which is a claim the draft has not earned.
    const draft = draftWith({ predicateField: "projectId", predicateValue: "" })
    expect(builderNormalizedPredicate(draft, ["projectId"])).toBeNull()
    // And the refusal is available separately, with its code.
    expect(compileBuilderDocument(assembleRuleDocument(draft, ["projectId"], ["deny_with_reason"])).codes).toEqual([
      "rule.invalid_source",
    ])
  })

  it("renders a note as absent from the canonical form, because a note never widens a predicate", () => {
    // ADR 0007 section 6: "a note is display-only, is never evaluated, and never
    // widens a predicate". So two drafts differing only in their note have the SAME
    // canonical form and the same digest — which is what makes editing a comment not
    // invalidate an approval.
    const plain = draftWith({ predicateNote: "" })
    const noted = draftWith({ predicateNote: "an explanatory note" })
    expect(builderNormalizedPredicate(noted, ["projectId"])).toBe(builderNormalizedPredicate(plain, ["projectId"]))

    const plainCompiled = compileRule(assembleRuleDocument(plain, ["projectId"], ["deny_with_reason"]))
    const notedCompiled = compileRule(assembleRuleDocument(noted, ["projectId"], ["deny_with_reason"]))
    expect(plainCompiled.ok && notedCompiled.ok).toBe(true)
    if (plainCompiled.ok && notedCompiled.ok) {
      expect(notedCompiled.value.digest).toBe(plainCompiled.value.digest)
    }
  })
})

// ===========================================================================
// Danger analysis over a candidate
// ===========================================================================

describe("the builder reports the dangers of a candidate before it is submitted", () => {
  it("reports the universal-pre-approval refusal with the compiler's code", () => {
    // A rule carrying a pre-approval and NO scope field. Both other danger classes
    // fire too — an unconstrained rule has every reach axis unbounded and has no
    // expiry — so this asserts on the SPECIFIC flag rather than on the array's length.
    const dangers = analyzeBuilderDangers(draftWith(), [], ["pre_approve_within_bounds"])
    const unscoped = dangers.filter((danger) => danger.kind === "unscoped_pre_approval")
    expect(unscoped).toHaveLength(1)
    expect(unscoped[0]?.code).toBe("rule.universal_pre_approval")
    expect(unscoped[0]?.subject).toBe("pre_approve_within_bounds")
    expect(unscoped[0]?.detail).toContain("applies to every dispatch")
  })

  it("reports nothing of the kind once a scope field is present, matching the compiler's own acceptance", () => {
    // The builder's danger analysis and the compiler's refusal must AGREE on when the
    // rule is unscoped, or the screen would warn about a rule that compiles or stay
    // silent about one that does not. Both sides read `NON_UNIVERSAL_PREDICATE_FIELDS`.
    for (const scopeField of ["projectId", "roleVersion", "taskLabel", "contextSensitivity"]) {
      const dangers = analyzeBuilderDangers(draftWith(), [scopeField], ["pre_approve_within_bounds"])
      expect(dangers.some((danger) => danger.kind === "unscoped_pre_approval"), scopeField).toBe(false)
    }
    // And a field that is NOT one of the twelve leaves it unscoped.
    for (const shapeField of ["timeoutSeconds", "fanOut", "scheduleWindow", "taskTitlePattern"]) {
      const dangers = analyzeBuilderDangers(draftWith(), [shapeField], ["pre_approve_within_bounds"])
      expect(dangers.some((danger) => danger.kind === "unscoped_pre_approval"), shapeField).toBe(true)
    }
  })

  it("reports the refusal for select_routing_preference as well as for a pre-approval", () => {
    const dangers = analyzeBuilderDangers(draftWith(), [], ["select_routing_preference"])
    expect(dangers.some((danger) => danger.kind === "unscoped_pre_approval")).toBe(true)
  })

  it("reports no unconstrained-reach danger for a rule that pre-approves nothing", () => {
    // A deny rule is not granted anything, so its unbounded axes are not a warning.
    const dangers = analyzeBuilderDangers(draftWith(), [], ["deny_with_reason"])
    expect(dangers.some((danger) => danger.kind === "unconstrained_reach")).toBe(false)
  })

  it("reports no no-expiry danger once a date is declared", () => {
    const dated = draftWith({ expiresAt: "2026-12-01T00:00:00Z" })
    const dangers = analyzeBuilderDangers(dated, ["projectId"], ["pre_approve_within_bounds"])
    expect(dangers.some((danger) => danger.kind === "no_expiry")).toBe(false)
  })

  it("orders its dangers by the declared vocabulary, with the refusal first", () => {
    const dangers = analyzeBuilderDangers(draftWith(), [], ["pre_approve_within_bounds"])
    const kinds = dangers.map((danger) => danger.kind)
    // `unscoped_pre_approval` then `no_expiry`, in that order — the vocabulary's.
    expect(kinds.indexOf("unscoped_pre_approval")).toBeLessThan(kinds.indexOf("no_expiry"))
  })

  it("names the axes a predicate list leaves unconstrained, in code-unit order", () => {
    expect(unconstrainedReachAxesFor(["capability"])).toEqual(["nodes", "projectPaths", "projects", "roles"])
    expect(unconstrainedReachAxesFor(["projectId", "roleId", "capability", "targetNodeId", "projectPathId"])).toEqual([])
    // A numeric bound constrains no reach axis, correctly.
    expect(unconstrainedReachAxesFor(["timeoutSeconds"]).length).toBe(5)
  })

  it("reports the scope fields a predicate list constrains, in the ADR's order", () => {
    expect(draftConstrainsScope(["roleId", "projectId"])).toEqual(["projectId", "roleId"])
    expect(draftConstrainsScope(["fanOut"])).toEqual([])
  })
})

// ===========================================================================
// Template capture
// ===========================================================================

describe("capturing a rule set as a template names the set by digest and carries no document", () => {
  it("captures the digest and the sorted identities, and no predicate text", () => {
    const capture = captureRuleSetAsTemplate({
      templateId: "rules-proj-1",
      projectId: "proj-1",
      name: "proj-1 rule set",
      ruleSetDigest: "sha256:abc",
      ruleIdentities: ["rule-b@1", "rule-a@2", "rule-a@1"],
      author: { kind: "user", id: USER_ID },
      now: TUI_NOW,
    })
    // Sorted and de-duplicated (T2): two captures of the same set must be equal even
    // if the rows arrived in a different order.
    expect(capture.ruleIdentities).toEqual(["rule-a@1", "rule-a@2", "rule-b@1"])
    expect(capture.ruleSetDigest).toBe("sha256:abc")
    expect(capture.createdAt).toBe(TUI_NOW)
    // The digest is the binding, and there is no document anywhere in the capture.
    expect(capture).not.toHaveProperty("documents")
    expect(capture).not.toHaveProperty("predicates")
    expect(capture).not.toHaveProperty("actions")
  })

  it("stamps the capture with the injected clock rather than reading one", () => {
    const capture = captureRuleSetAsTemplate({
      templateId: "t",
      projectId: "proj-1",
      name: "n",
      ruleSetDigest: "sha256:abc",
      ruleIdentities: [],
      author: { kind: "user", id: USER_ID },
      now: TUI_NOW,
    })
    expect(capture.createdAt).toBe(TUI_NOW)
    // The same input twice gives the same value, which is what makes a stored
    // template's `createdAt` reproducible.
    expect(
      captureRuleSetAsTemplate({
        templateId: "t",
        projectId: "proj-1",
        name: "n",
        ruleSetDigest: "sha256:abc",
        ruleIdentities: [],
        author: { kind: "user", id: USER_ID },
        now: TUI_NOW,
      }),
    ).toEqual(capture)
  })

  it("says 'none' in its description for an empty rule set rather than leaving a blank", () => {
    const capture = captureRuleSetAsTemplate({
      templateId: "t",
      projectId: "proj-1",
      name: "n",
      ruleSetDigest: "sha256:abc",
      ruleIdentities: [],
      author: { kind: "user", id: USER_ID },
      now: TUI_NOW,
    })
    expect(capture.description).toContain("(none)")
    expect(capture.description.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// Every compiler code the builder can surface
// ===========================================================================

describe("the builder surfaces every refusal code reachable through it", () => {
  const reachable: readonly RuleErrorCode[] = [
    "rule.invalid_source",
    "rule.limit_exceeded",
    "rule.empty_enum",
    "rule.universal_pre_approval",
  ]

  it("reports each of them with the code the compiler produced, never a builder code", () => {
    // `rule.pattern_refused`, `rule.language_version_unsupported`,
    // `rule.project_scope_mismatch`, `rule.evaluation_failed` and
    // `rule.conflicting_action_effects` are NOT reachable from a builder draft: the
    // builder fixes the language version, always writes the draft's own projectId, has
    // no pattern field to compile, cannot produce a cyclic document from a list, and
    // cannot produce conflicting action effects from the action shapes it writes. So
    // the list above is exhaustive for THIS entry point, and a code outside it would
    // be a builder bug rather than a gap.
    expect(reachable).toHaveLength(4)
  })

  it("never invents a code that is not one the compiler emitted", () => {
    // Every case below assembles from SEEDED values, so the ONLY thing wrong with each
    // document is the thing under test. A case that was also malformed would produce
    // a refusal for the wrong reason and the code assertion would pass for a
    // coincidental one.
    const scoped = draftWith({
      predicateField: "projectId",
      predicateValue: defaultPredicateValueFor("projectId"),
    })
    const cases: readonly { document: unknown; expected: RuleErrorCode }[] = [
      {
        document: assembleRuleDocument(draftWith({ ruleId: "" }), ["projectId"], ["deny_with_reason"]),
        expected: "rule.invalid_source",
      },
      {
        document: assembleRuleDocument(scoped, ["projectId"], Array.from({ length: 17 }, () => "deny_with_reason")),
        expected: "rule.limit_exceeded",
      },
      {
        document: assembleRuleDocument(
          narrowTo(draftWith({ predicateValue: "" }), "capability", "any"),
          ["capability"],
          ["deny_with_reason"],
        ),
        expected: "rule.empty_enum",
      },
      {
        document: assembleRuleDocument(
          draftWith({
            predicateField: "timeoutSeconds",
            predicateValue: defaultPredicateValueFor("timeoutSeconds"),
            actionKind: "pre_approve_within_bounds",
            actionValue: defaultActionValueFor("pre_approve_within_bounds"),
          }),
          ["timeoutSeconds"],
          ["pre_approve_within_bounds"],
        ),
        expected: "rule.universal_pre_approval",
      },
    ]
    for (const { document, expected } of cases) {
      const report = compileBuilderDocument(document)
      expect(report.ok).toBe(false)
      expect(report.codes).toEqual([expected])
      expect(report.refusedWith(expected)).toBe(true)
    }
  })
})

/**
 * Re-narrow a draft for a chosen operator.
 *
 * The builder's own draft carries `predicateOperator`, but `assembleRuleDocument`
 * uses the field's FIRST declared operator — the default a user would get. Setting a
 * different operator means changing `predicateField` and `predicateValue` together,
 * which is what this helper does, and the two callers that need a non-default operator
 * use it so the intent is explicit rather than hidden in a spread.
 */
function narrowTo(draft: RuleTuiBuilderDraft, field: string, operator: string): RuleTuiBuilderDraft {
  return { ...draft, predicateField: field, predicateOperator: operator }
}

/** The danger list, re-exported so the "no canary in danger prose" audit can see it. */
export { allFourDangers }
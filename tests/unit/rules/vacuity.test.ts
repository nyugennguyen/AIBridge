/**
 * The two vacuous-predicate holes the M6.10 revision closed, and the controls
 * that say the closure did not over-refuse.
 *
 * HOLE ONE — the tautology. `constrainingScopeAxes` recursed into `all`/`any`
 * and counted any constructive descendant while skipping every `not` it met. So
 * `any(projectId eq "proj-1", not projectId eq "proj-1")` — a disjunction whose
 * arms are complementary, and therefore true for every dispatch — counted
 * `projectId` as constraining, compiled, was DISCLOSED as scoped to one project,
 * and cleared the safety floor's per-dispatch approval for every dispatch in
 * that project. Fifteen of the nineteen constructive atoms produce it. The
 * disclosure is what makes it a Stop Condition 5 hit: it did not say `unknown`,
 * it asserted a narrow reach it did not have.
 *
 * The rule the fix installs: an `any` branch containing ANY `not` arm
 * contributes NOTHING. A disjunction containing a negation cannot be stated as
 * a reachable set on any axis, which is the same reason a bare `not` is already
 * refused. Fail-closed, and consistent with the `not` rule rather than a second
 * special case for the literal shape `any(A, not A)`.
 *
 * HOLE TWO — `taskLabel` was missing from the `rule.empty_enum` branch.
 * `hasAll []` and `hasAny []` are vacuously satisfied by every labelled
 * dispatch, so they matched everything and cleared the floor while naming a
 * label set no author wrote. `has` takes a single label and is a different
 * shape, so it is excluded from the refusal.
 *
 * THE CONTROLS ARE THE POINT. A fix that refuses everything passes every
 * refusal assertion while breaking the feature, so each refusal family here is
 * paired with a shape that must still compile — including a disjunction, a
 * `taskLabel has` with a real label, a non-vacuous `hasAll`, and the case that
 * reads as most dangerous: a tautological `any` sitting under an `all` beside a
 * real sibling, which is sound precisely because `all` is a conjunction.
 */

import { describe, expect, it } from "vitest"
import { compileRule, compileRuleSet, evaluateRules } from "../../../src/rules/index.js"
import { rawPreApprovalDocument, rawRuleDocument, validContext } from "./fixtures.js"

/** A pre-approval document, so the universal check applies. The actions are the two it is enforced for. */
function preApproval(predicates: readonly unknown[]): Record<string, unknown> {
  return rawPreApprovalDocument({ predicates: [...predicates] })
}

/** A deny document, so the universal check does NOT apply and only the empty-enum check can speak. */
function deny(predicates: readonly unknown[]): Record<string, unknown> {
  return rawRuleDocument({ predicates: [...predicates], actions: [{ kind: "deny_with_reason", reason: "x" }] })
}

/** The refusal code, or `null` when the document compiled. */
function refusalCode(document: Record<string, unknown>): string | null {
  const compiled = compileRule(document)
  return compiled.ok ? null : compiled.error.code
}

// ===========================================================================
// Hole one — a disjunction containing a negation
// ===========================================================================

describe("a disjunction containing a negation is refused as a universal pre-approval, because a disjunction with a `not` arm cannot state a reachable set", () => {
  it("refuses `any(A, not A)` on a closed identifier axis, which is the tautology itself", () => {
    // THE REGRESSION. Before the fix this compiled, was disclosed as
    // `projectId: {kind: "constrained", values: ["proj-1"]}`, and cleared the
    // floor: `evaluatePolicy` returned `allow` with
    // `preApprovalClearedDefault: true` and `outstandingApprovals: []`.
    for (const atom of [
      { field: "projectId", operator: "eq", value: "proj-1" },
      { field: "roleId", operator: "eq", value: "role-1" },
      { field: "projectPathId", operator: "eq", value: "path-1" },
      { field: "runtimeKind", operator: "eq", value: "opencode" },
      { field: "targetNodeId", operator: "eq", value: "node-1" },
    ]) {
      const label = `${String(atom.field)} ${String(atom.operator)}`
      const compiled = compileRule(
        preApproval([{ field: "any", predicates: [atom, { field: "not", predicate: atom }] }]),
      )
      expect(compiled.ok, `any(${label}, not ${label}) must be refused`).toBe(false)
      if (!compiled.ok) expect(compiled.error.code, label).toBe("rule.universal_pre_approval")
    }
  })

  it("refuses `any(A, not A)` on the SET axes too, because the arms are complementary whatever A names", () => {
    for (const atom of [
      { field: "capability", operator: "any", value: ["fs.read"] },
      { field: "capability", operator: "all", value: ["fs.read", "net.fetch"] },
      { field: "toolCategory", operator: "any", value: ["shell"] },
      { field: "nodeAdvertisedCapability", operator: "all", value: ["fs.read"] },
      { field: "taskLabel", operator: "hasAny", value: ["release"] },
      { field: "roleVersion", operator: "gt", value: 1 },
      { field: "contextSensitivity", operator: "maxRankAtMost", value: 2 },
    ]) {
      const label = `${String(atom.field)} ${String(atom.operator)}`
      const compiled = compileRule(
        preApproval([{ field: "any", predicates: [atom, { field: "not", predicate: atom }] }]),
      )
      expect(compiled.ok, `any(${label}, not ${label}) must be refused`).toBe(false)
      if (!compiled.ok) expect(compiled.error.code, label).toBe("rule.universal_pre_approval")
    }
  })

  it("refuses `any(not A)` with no positive arm at all, because the branch has nothing left to scope the rule", () => {
    const compiled = compileRule(
      preApproval([{ field: "any", predicates: [{ field: "not", predicate: { field: "projectId", operator: "eq", value: "proj-1" } }] }]),
    )
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.universal_pre_approval")
  })

  it("refuses a tautology with the arms in the other order, because a disjunction does not care which arm is written first", () => {
    const atom = { field: "projectId", operator: "eq", value: "proj-1" }
    const compiled = compileRule(
      preApproval([{ field: "any", predicates: [{ field: "not", predicate: atom }, atom] }]),
    )
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.universal_pre_approval")
  })

  it("refuses a tautology whose arms are not IDENTICAL but still cover every dispatch", () => {
    // `any(A, not A)` is the tautology the review found, but the general form is
    // "a disjunction containing a negation". This arm pair is not complementary
    // as written — it names two different values — and is still refused, which
    // is the stated rule rather than a special case for the literal shape.
    const compiled = compileRule(
      preApproval([
        {
          field: "any",
          predicates: [
            { field: "projectId", operator: "eq", value: "proj-1" },
            { field: "not", predicate: { field: "projectId", operator: "eq", value: "proj-2" } },
          ],
        },
      ]),
    )
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.universal_pre_approval")
  })

  it("refuses a tautology that is the ONLY member of an enclosing `all`, because nothing else scopes the rule", () => {
    const atom = { field: "projectId", operator: "eq", value: "proj-1" }
    const compiled = compileRule(
      preApproval([{ field: "all", predicates: [{ field: "any", predicates: [atom, { field: "not", predicate: atom }] }] }]),
    )
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.universal_pre_approval")
  })

  it("CONTROL: still compiles a disjunction with no negation in it, because that is how an author writes 'either of these two projects'", () => {
    // The control that a fix refusing every `any` would break. A disjunction of
    // two constructive atoms IS statable as a reachable set, so it must compile.
    const scopes: readonly { readonly label: string; readonly predicate: unknown }[] = [
      {
        label: "any(capability any A, capability any B)",
        predicate: {
          field: "any",
          predicates: [
            { field: "capability", operator: "any", value: ["fs.read"] },
            { field: "capability", operator: "any", value: ["net.fetch"] },
          ],
        },
      },
      {
        label: "any(projectId eq a, projectId eq b)",
        predicate: {
          field: "any",
          predicates: [
            { field: "projectId", operator: "eq", value: "proj-1" },
            { field: "projectId", operator: "eq", value: "proj-2" },
          ],
        },
      },
      {
        label: "any(all(A,B), all(A,C))",
        predicate: {
          field: "any",
          predicates: [
            { field: "all", predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }, { field: "capability", operator: "any", value: ["fs.read"] }] },
            { field: "all", predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }, { field: "capability", operator: "any", value: ["net.fetch"] }] },
          ],
        },
      },
    ]
    for (const scope of scopes) {
      const compiled = compileRule(preApproval([scope.predicate]))
      expect(compiled.ok, `${scope.label} must still compile`).toBe(true)
    }
  })

  it("CONTROL: still compiles a tautological `any` sitting under an `all` beside a real sibling, because a conjunction cannot be widened by a tautology", () => {
    // The control for the direction the fix had to get right. `all([any(A, not A), B])`
    // is satisfiability-equivalent to `B`: a conjunction with a tautological
    // conjunct is `B`. The sibling scopes the rule, and the disclosure that
    // reports `B`'s reach is therefore CORRECT rather than optimistic — so
    // refusing it would be an over-refusal of a sound rule, and the branch
    // contributing nothing is what makes that soundness visible.
    const atom = { field: "projectId", operator: "eq", value: "proj-1" }
    const compiled = compileRule(
      preApproval([
        {
          field: "all",
          predicates: [
            { field: "any", predicates: [atom, { field: "not", predicate: atom }] },
            { field: "capability", operator: "any", value: ["fs.read"] },
          ],
        },
      ]),
    )
    expect(compiled.ok, "a tautological conjunct beside a real scope must still compile").toBe(true)
  })

  it("REFUSED, and deliberately so: `any(A∧B, A∧¬B)` is satisfiability-equivalent to `A`, but the check cannot see that and refuses it", () => {
    // THIS TEST CHANGED DIRECTION, and the change is the point.
    //
    // It previously asserted `compiled.ok === true`, as a control proving the
    // one-level negation check did not over-refuse. Closing the nested-negation gap
    // required reading the whole subtree, and the whole subtree of this shape
    // contains a `not` — so it is now refused.
    //
    // That is an over-refusal of a genuinely SOUND rule: `A∧B ∨ A∧¬B` is exactly
    // `A`, so the rule's true reach IS the set the disclosure would report.
    // Distinguishing it from `any(R, any(A, ¬A))` — which is a TAUTOLOGY and was
    // silently approving dispatches for roles the author never named — requires
    // deciding satisfiability over a predicate language that has no vocabulary for
    // it.
    //
    // The trade is deliberate and asymmetric in the right direction. Refusing a
    // sound rule costs an author a rewrite; ADMITTING a tautology clears the safety
    // floor for dispatches the author never authorised. The milestone is
    // conservative-by-refusal everywhere else (see the empty-enum refusals and the
    // domain-edge range checks), and this is the same posture applied to a case the
    // syntactic test cannot resolve. Recorded as residual risk in ADR 0007 rather
    // than papered over.
    const compiled = compileRule(
      preApproval([
        {
          field: "any",
          predicates: [
            {
              field: "all",
              predicates: [
                { field: "projectId", operator: "eq", value: "proj-1" },
                { field: "capability", operator: "any", value: ["fs.read"] },
              ],
            },
            {
              field: "all",
              predicates: [
                { field: "projectId", operator: "eq", value: "proj-1" },
                { field: "not", predicate: { field: "capability", operator: "any", value: ["fs.read"] } },
              ],
            },
          ],
        },
      ]),
    )
    expect(compiled.ok, "the subtree check cannot distinguish this sound rule from a tautology, so it refuses").toBe(false)
    if (compiled.ok) return
    expect(compiled.error.code).toBe("rule.universal_pre_approval")
  })

  it("the sibling CONTROL still holds: `any(A, B)` with no negation anywhere still compiles", () => {
    // The control that keeps the refusal above honest. If EVERY disjunction were
    // refused, the test before it would pass while the feature was dead. A
    // disjunction whose arms pin different axes is exactly the legitimate case.
    const compiled = compileRule(
      preApproval([
        {
          field: "any",
          predicates: [
            { field: "projectId", operator: "eq", value: "proj-1" },
            { field: "roleId", operator: "eq", value: "role-1" },
          ],
        },
      ]),
    )
    expect(compiled.ok, "a disjunction that genuinely excludes dispatches must still compile").toBe(true)
  })

  it("CLOSED, not documented: an `any` arm containing a `not` BELOW a combinator is now refused, so the fail-open it enabled can no longer be written", () => {
    // THIS TEST ALSO CHANGED DIRECTION. It previously asserted `compiled.ok ===
    // true` and argued the shape was harmless because `any(all(A, not A))` yields
    // an UNSATISFIABLE rule that never matches. That argument was sound about the
    // evaluation and wrong about the risk: the same syntactic gap — the negation
    // test reading only an `any`'s DIRECT children — also admitted shapes whose arm
    // is a TAUTOLOGY rather than a contradiction, and those DO fire.
    //
    // The measured case, through the real compiler and the real kernel:
    //
    //   any(roleId eq "role-1", any(projectId eq "proj-1", not projectId eq "proj-1"))
    //
    // is `roleId = role-1 ∨ TRUE`, a tautology on the projects axis. It compiled,
    // the disclosure reported `roles: ["role-1"]`, and the kernel ALLOWED a
    // dispatch for `role-9` — a role the author never named:
    //
    //   role=role-1 project=proj-1 (the role the author wrote) -> allow
    //   role=role-9 project=proj-1 (a role NEVER named)        -> allow
    //
    // The unsatisfiable shape and the tautological one are indistinguishable to a
    // syntactic check, so the check now refuses both. This test asserts the
    // unsatisfiable one is refused too, and the nested grant case below asserts the
    // tautological one never reaches the kernel at all.
    const atom = { field: "projectId", operator: "eq", value: "proj-1" }
    const document = preApproval([{ field: "any", predicates: [{ field: "all", predicates: [atom, { field: "not", predicate: atom }] }] }])
    const compiled = compileRule(document)
    expect(compiled.ok, "an unsatisfiable rule is refused rather than compiled as a scope").toBe(false)
    if (compiled.ok) return
    expect(compiled.error.code).toBe("rule.universal_pre_approval")
  })

  it("a nested tautology cannot reach the kernel at all, so no role the author never named can be approved", () => {
    // The end-to-end assertion for the defect above, and the reason the subtree
    // check exists. Compile-time refusal is the strong form — a rule that does not
    // compile cannot fire — but this walks the whole path anyway, because the
    // earlier one-level check also "refused" nothing here and the failure only
    // appeared at the kernel's `allow`.
    const atom = { field: "projectId", operator: "eq", value: "proj-1" }
    const document = preApproval([
      {
        field: "any",
        predicates: [
          { field: "roleId", operator: "eq", value: "role-1" },
          { field: "any", predicates: [atom, { field: "not", predicate: atom }] },
        ],
      },
    ])
    const set = compileRuleSet([document])
    expect(set.ok, "a disjunction whose arm is a tautology must not compile as a scope").toBe(false)
    if (set.ok) return
    expect(set.error.code).toBe("rule.universal_pre_approval")
  })

  it("CONTROL: an `all` whose other member is a `not` compiles on the strength of its constructive sibling alone, which is what the sibling is for", () => {
    // The `not` contributes nothing, so `projectId eq "proj-1"` is the only
    // constraint — and the document compiles on THAT basis. This is the
    // documented behaviour rather than a refusal, and it is the other half of
    // the control above: the branch-contributes-nothing rule is about what a
    // `not` ADDS, not about what a rule is allowed to contain.
    const compiled = compileRule(
      preApproval([
        {
          field: "all",
          predicates: [
            { field: "projectId", operator: "eq", value: "proj-1" },
            { field: "not", predicate: { field: "capability", operator: "none", value: ["never-requested"] } },
          ],
        },
      ]),
    )
    expect(compiled.ok).toBe(true)
  })
})

// ===========================================================================
// Hole two — an empty task-label enumeration
// ===========================================================================

describe("an empty task-label enumeration is refused as an unsatisfiable predicate", () => {
  it("refuses `taskLabel hasAll []`, which is vacuously satisfied by every labelled dispatch", () => {
    // THE REGRESSION. `hasAll` is in `CONSTRUCTIVE_FORMS`, so before the fix this
    // compiled, matched every labelled dispatch, and cleared the safety floor
    // (`kernel=allow cleared=true` in the review's measurement) while naming a
    // label set no author wrote. `taskLabel` was simply missing from the
    // `rule.empty_enum` branch, which had entries for the three set axes and for
    // `projectId in []` and nothing for labels.
    const compiled = compileRule(deny([{ field: "taskLabel", operator: "hasAll", value: [] }]))
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) {
      expect(compiled.error.code).toBe("rule.empty_enum")
      // The message names the field, because "your rule is unsatisfiable" is not
      // actionable and this one is.
      expect(compiled.error.message).toContain("taskLabel")
    }
  })

  it("refuses `taskLabel hasAny []`, which is vacuously satisfied by every labelled dispatch for the same reason", () => {
    const compiled = compileRule(deny([{ field: "taskLabel", operator: "hasAny", value: [] }]))
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.empty_enum")
  })

  it("refuses an empty label set on a PRE-APPROVAL as `rule.empty_enum` rather than as a universal pre-approval, because unsatisfiability is checked first and is the more specific truth", () => {
    // Both refusals describe this document. The empty enum is the more specific
    // one and the one the author can act on, so it is the one reported.
    const compiled = compileRule(preApproval([{ field: "taskLabel", operator: "hasAll", value: [] }]))
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.empty_enum")
  })

  it("refuses an empty label set nested inside `all` and `any`, because the walk visits every node of the tree", () => {
    for (const tree of [
      { field: "all", predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }, { field: "taskLabel", operator: "hasAll", value: [] }] },
      { field: "any", predicates: [{ field: "taskLabel", operator: "hasAny", value: [] }] },
    ]) {
      const compiled = compileRule(deny([tree]))
      expect(compiled.ok).toBe(false)
      if (!compiled.ok) expect(compiled.error.code).toBe("rule.empty_enum")
    }
  })

  it("CONTROL: still compiles `taskLabel has` with a real label, because `has` takes a single label and is a different shape from an enumeration", () => {
    // The control. The refusal excludes `operator: "has"` deliberately: `has`
    // carries one string, not an array, so `has []` was never a legal document
    // and the schema refuses it as `rule.invalid_source` on its own. Widening
    // the empty-enum rule to cover `has` would therefore change nothing, and
    // asserting it here is what pins the exclusion as deliberate.
    const compiled = compileRule(deny([{ field: "taskLabel", operator: "has", value: "release" }]))
    expect(compiled.ok).toBe(true)

    // And the empty-enum schema really does refuse `has []` separately, so the
    // exclusion is not a hole.
    const emptyHas = compileRule(deny([{ field: "taskLabel", operator: "has", value: [] }]))
    expect(emptyHas.ok).toBe(false)
    if (!emptyHas.ok) expect(emptyHas.error.code).toBe("rule.invalid_source")
  })

  it("CONTROL: still compiles a non-vacuous `hasAll` and matches only a task carrying EVERY declared label", () => {
    // The control's whole purpose. `hasAll []` is refused for being an empty
    // enumeration; `hasAll ["release", "urgent"]` is a real constraint, and it
    // must still compile AND still discriminate — a refusal of the empty case
    // that also refused this one would be a fix that broke the operator.
    const document = deny([{ field: "taskLabel", operator: "hasAll", value: ["release", "urgent"] }])
    expect(compileRule(document).ok).toBe(true)
    const compiled = compileRuleSet([document])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return

    const outcome = (taskLabels: readonly string[]): string | undefined =>
      evaluateRules(compiled.value, validContext({ taskLabels: [...taskLabels] })).traces[0]?.matchOutcome
    expect(outcome(["release", "urgent"])).toBe("matched")
    expect(outcome(["release"])).toBe("not_matched")
    expect(outcome(["urgent", "other"])).toBe("not_matched")
    expect(outcome(["other"])).toBe("not_matched")
  })
})

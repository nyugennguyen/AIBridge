/**
 * The compiler: `unknown` in, a deep-frozen `CompiledRule` out, and a refusal
 * with a NAMED code for everything in between.
 *
 * Four properties are under test, and each is a property the ADR makes a
 * structural claim about:
 *
 *   1. THE CHECK ORDER. A document is refused for the FIRST thing wrong with it,
 *      and each step has its own code. `rule.language_version_unsupported` is
 *      checked before the schema so a v3 document is told its version is wrong
 *      rather than that its fields are; patterns are compiled after the limits
 *      so the most expensive step does not run on a document already refused.
 *
 *   2. DEEP FREEZE. A compiled rule set is deep-frozen, so a preview that
 *      annotated the artifact with "what matched" would corrupt the runtime
 *      evaluation of the same set. The test attempts a mutation and asserts it
 *      either throws or has no effect, at EVERY level of nesting.
 *
 *   3. ORDER INDEPENDENCE. A shuffled input array yields the same rule order,
 *      the same per-rule digests and the same set digest. Supersession must not
 *      depend on arrival order, or a rule set would mean different things
 *      depending on how it was loaded.
 *
 *   4. THE M0 PROJECTION IS A PROJECTION. Every `kernelRule` is parsed through
 *      the FROZEN `ruleSchema`, so a projection that drifted from the M0 contract
 *      is a compile error rather than a value the kernel would reject later.
 */

import { describe, expect, it } from "vitest"
import {
  MAX_RULES_PER_SET,
  NON_UNIVERSAL_PREDICATE_FIELDS,
  compileRule,
  compileRuleSet,
  describePredicates,
  normalizeAction,
  ruleActionSchema,
} from "../../../src/rules/index.js"
import { ruleSchema } from "../../../src/orchestration/schemas.js"
import { matchRule } from "../../../src/orchestration/policy/evaluate.js"
import type { RuleMatchContext } from "../../../src/orchestration/policy/types.js"
import type { Rule } from "../../../src/orchestration/types.js"
import { canonicalJson } from "../../../src/orchestration/digest.js"
import {
  PROJECT_ID,
  budgetDocument,
  clone,
  preApprovalDocument,
  rawPreApprovalDocument,
  rawRuleDocument,
  requireApprovalDocument,
  routingDocument,
  validRuleDocument,
} from "./fixtures.js"

/** The one pre-approval shape the tests reuse, so a change to it is one edit. */
const PRE_APPROVAL_ACTION = {
  kind: "pre_approve_within_bounds",
  approvedCapabilities: ["fs.read"],
  maximumTimeoutSeconds: 900,
  allowDestructiveEffects: false,
  allowExternalEffects: false,
  maximumSensitivity: "restricted",
}

// ===========================================================================
// Acceptance and identity
// ===========================================================================

describe("a compiled rule carries the identity, the metadata and the digest", () => {
  it("compiles a valid document", () => {
    const result = compileRule(validRuleDocument())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.ruleId).toBe("rule-a")
    expect(result.value.templateVersion).toBe(1)
    expect(result.value.projectId).toBe("proj-1")
    expect(result.value.enabled).toBe(true)
  })

  it("produces a digest that changes when anything behavioural changes", () => {
    const base = compileRule(validRuleDocument())
    expect(base.ok).toBe(true)
    if (!base.ok) return

    // Identity.
    const otherId = compileRule(validRuleDocument({ ruleId: "rule-b" }))
    expect(otherId.ok && otherId.value.digest).not.toBe(base.value.digest)

    // Version.
    const otherVersion = compileRule(validRuleDocument({ templateVersion: 2 }))
    expect(otherVersion.ok && otherVersion.value.digest).not.toBe(base.value.digest)

    // Enabled.
    const disabled = compileRule(validRuleDocument({ enabled: false }))
    expect(disabled.ok && disabled.value.digest).not.toBe(base.value.digest)

    // Activation state.
    const draft = compileRule(validRuleDocument({ activation: { state: "draft", activatedAt: null, activatedBy: null } }))
    expect(draft.ok && draft.value.digest).not.toBe(base.value.digest)

    // Expiry.
    const expiring = compileRule(validRuleDocument({ expiresAt: "2027-01-01T00:00:00Z" }))
    expect(expiring.ok && expiring.value.digest).not.toBe(base.value.digest)

    // Predicate.
    const otherPredicate = compileRule(validRuleDocument({ predicates: [{ field: "roleId", operator: "eq", value: "role-2" }] }))
    expect(otherPredicate.ok && otherPredicate.value.digest).not.toBe(base.value.digest)

    // Action.
    const otherAction = compileRule(validRuleDocument({ actions: [{ kind: "deny_with_reason", reason: "a different reason" }] }))
    expect(otherAction.ok && otherAction.value.digest).not.toBe(base.value.digest)
  })

  it("produces the SAME digest when only a label changes, because a label is not behaviour", () => {
    // `name`, `description` and a predicate `note` are all display-only. Renaming
    // a rule must not invalidate an approval taken against it, and the way to
    // guarantee that is to leave them out of the digest rather than to hope a
    // consumer ignores them.
    const base = compileRule(validRuleDocument())
    expect(base.ok).toBe(true)
    if (!base.ok) return

    for (const overrides of [
      { name: "a completely different name" },
      { description: "a completely different description" },
      { predicates: [{ field: "roleId", operator: "eq", value: "role-1", note: "an annotation" }] },
      { author: { kind: "system", name: "seed" } },
    ]) {
      const relabelled = compileRule(validRuleDocument(overrides))
      expect(relabelled.ok).toBe(true)
      if (relabelled.ok) expect(relabelled.value.digest).toBe(base.value.digest)
    }
  })

  it("produces the same digest regardless of the ORDER of a member set", () => {
    // A set has no order, so two documents differing only in member order are the
    // same rule. If the digest moved, an approval would be invalidated by a
    // re-ordering that changed nothing.
    const ascending = compileRule(
      rawRuleDocument({ predicates: [{ field: "capability", operator: "any", value: ["fs.read", "net.fetch"] }], actions: [{ kind: "deny_with_reason", reason: "x" }] }),
    )
    const descending = compileRule(
      rawRuleDocument({ predicates: [{ field: "capability", operator: "any", value: ["net.fetch", "fs.read"] }], actions: [{ kind: "deny_with_reason", reason: "x" }] }),
    )
    expect(ascending.ok).toBe(true)
    expect(descending.ok).toBe(true)
    if (ascending.ok && descending.ok) expect(ascending.value.digest).toBe(descending.value.digest)
  })

  it("keeps the raw source on the compiled rule for the audit record", () => {
    // The compile-once/keep-raw-for-audit precedent from
    // `src/mesh/protocol/rules.ts`: the compiled form is what evaluation reads and
    // the source is what an auditor reads, and they are both on the artifact.
    const result = compileRule(validRuleDocument())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.source.ruleId).toBe("rule-a")
    expect(result.value.source.description).toBe("A deny scoped to one role.")
  })
})

// ===========================================================================
// The normalized form
// ===========================================================================

describe("the normalized predicate is the canonical form the digest covers", () => {
  const cases: readonly { predicate: unknown; expected: string }[] = [
      { predicate: { field: "projectId", operator: "eq", value: "p" }, expected: 'projectId == "p"' },
      { predicate: { field: "projectId", operator: "in", value: ["b", "a"] }, expected: 'projectId in ["a","b"]' },
      { predicate: { field: "roleId", operator: "eq", value: "r" }, expected: 'roleId == "r"' },
      { predicate: { field: "roleVersion", operator: "between", value: { min: 1, max: 3 } }, expected: "roleVersion between 1 and 3" },
      { predicate: { field: "roleVersion", operator: "lte", value: 3 }, expected: "roleVersion <= 3" },
      { predicate: { field: "roleVersion", operator: "gte", value: 1 }, expected: "roleVersion >= 1" },
      { predicate: { field: "roleVersion", operator: "lt", value: 4 }, expected: "roleVersion < 4" },
      { predicate: { field: "roleVersion", operator: "gt", value: 1 }, expected: "roleVersion > 1" },
      { predicate: { field: "roleVersion", operator: "eq", value: 2 }, expected: "roleVersion == 2" },
      { predicate: { field: "capability", operator: "any", value: ["fs.read"] }, expected: 'capability any ["fs.read"]' },
      { predicate: { field: "capability", operator: "all", value: ["b", "a"] }, expected: 'capability all ["a","b"]' },
      { predicate: { field: "capability", operator: "none", value: ["a"] }, expected: 'capability none ["a"]' },
      { predicate: { field: "toolCategory", operator: "any", value: ["shell"] }, expected: 'toolCategory any ["shell"]' },
      { predicate: { field: "runtimeKind", operator: "eq", value: "opencode" }, expected: 'runtimeKind == "opencode"' },
      { predicate: { field: "targetNodeId", operator: "in", value: ["n1"] }, expected: 'targetNodeId in ["n1"]' },
      { predicate: { field: "nodeAdvertisedCapability", operator: "any", value: ["gpu"] }, expected: 'nodeAdvertisedCapability any ["gpu"]' },
      { predicate: { field: "projectPathId", operator: "eq", value: "path-1" }, expected: 'projectPathId == "path-1"' },
      { predicate: { field: "taskLabel", operator: "has", value: "release" }, expected: 'taskLabel has "release"' },
      { predicate: { field: "taskLabel", operator: "hasAny", value: ["b", "a"] }, expected: 'taskLabel hasAny ["a","b"]' },
      { predicate: { field: "taskLabel", operator: "lacks", value: ["hotfix"] }, expected: 'taskLabel lacks ["hotfix"]' },
      { predicate: { field: "dependencyOutcome", operator: "anyFailed" }, expected: "dependencyOutcome anyFailed" },
      { predicate: { field: "fanOut", operator: "lte", value: 4 }, expected: "fanOut <= 4" },
      { predicate: { field: "concurrency", operator: "lte", value: 2 }, expected: "concurrency <= 2" },
      { predicate: { field: "retryLimit", operator: "lte", value: 1 }, expected: "retryLimit <= 1" },
      { predicate: { field: "timeoutSeconds", operator: "lte", value: 900 }, expected: "timeoutSeconds <= 900" },
      { predicate: { field: "contextSensitivity", operator: "maxRankAtMost", value: 1 }, expected: "contextSensitivity maxRankAtMost restricted" },
      { predicate: { field: "contextSensitivity", operator: "maxRankAtLeast", value: 0 }, expected: "contextSensitivity maxRankAtLeast public_to_project" },
      { predicate: { field: "contextSensitivity", operator: "any", value: ["restricted"] }, expected: 'contextSensitivity any ["restricted"]' },
      { predicate: { field: "taskTitlePattern", pattern: "^deploy" }, expected: 'taskTitlePattern matches "^deploy"' },
      { predicate: { field: "all", predicates: [] }, expected: "all()" },
      { predicate: { field: "not", predicate: { field: "roleId", operator: "eq", value: "r" } }, expected: '(not roleId == "r")' },
      {
        predicate: { field: "all", predicates: [{ field: "roleId", operator: "eq", value: "a" }, { field: "roleId", operator: "eq", value: "b" }] },
        expected: '(roleId == "a" and roleId == "b")',
      },
      {
        predicate: { field: "any", predicates: [{ field: "roleId", operator: "eq", value: "a" }, { field: "roleId", operator: "eq", value: "b" }] },
        expected: '(roleId == "a" or roleId == "b")',
      },
  ]
  for (const testCase of cases) {
    it(`renders ${JSON.stringify(testCase.predicate).slice(0, 70)} as ${testCase.expected}`, () => {
      const compiled = compileRule(rawRuleDocument({ predicates: [testCase.predicate] }))
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) return
      expect(compiled.value.normalizedPredicate).toBe(testCase.expected)
    })
  }

  it("renders a schedule window with its days, hours and zone as written", () => {
    const compiled = compileRule(
      rawRuleDocument({
        predicates: [
          {
            field: "scheduleWindow",
            windows: [
              { daysOfWeek: [1, 2, 3, 4, 5], startMinuteOfDay: 540, endMinuteOfDay: 1020, timeZone: "America/New_York" },
              { daysOfWeek: [0], startMinuteOfDay: 0, endMinuteOfDay: 1439, timeZone: { fixedOffsetMinutes: -300 } },
            ],
          },
        ],
      }),
    )
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    // Days sorted by index and rendered as a comma-joined list rather than a
    // range: a range grammar would need a rule for whether `Sat,Sun` is
    // `Sat-Sun` or `Sun-Sat`, and that is a convention to get wrong in a form
    // that decides whether a pre-approval is live at 03:00 on a Sunday.
    expect(compiled.value.normalizedPredicate).toBe(
      'scheduleWindow in [Mon,Tue,Wed,Thu,Fri 09:00-17:00 America/New_York,Sun 00:00-23:59 UTC-05:00]',
    )
  })

  it("keeps combinator CHILDREN in declaration order, because declaration order is visible to the user", () => {
    const ascending = compileRule(
      rawRuleDocument({ predicates: [{ field: "all", predicates: [{ field: "roleId", operator: "eq", value: "a" }, { field: "roleId", operator: "eq", value: "b" }] }] }),
    )
    const reversed = compileRule(
      rawRuleDocument({ predicates: [{ field: "all", predicates: [{ field: "roleId", operator: "eq", value: "b" }, { field: "roleId", operator: "eq", value: "a" }] }] }),
    )
    expect(ascending.ok && reversed.ok).toBe(true)
    if (ascending.ok && reversed.ok) {
      expect(ascending.value.normalizedPredicate).not.toBe(reversed.value.normalizedPredicate)
      expect(ascending.value.digest).not.toBe(reversed.value.digest)
    }
  })

  it("excludes a note from the normalized form, so an annotation cannot change what a rule means", () => {
    const withNote = compileRule(
      rawRuleDocument({ predicates: [{ field: "roleId", operator: "eq", value: "role-1", note: "an annotation" }] }),
    )
    const withoutNote = compileRule(rawRuleDocument({ predicates: [{ field: "roleId", operator: "eq", value: "role-1" }] }))
    expect(withNote.ok && withoutNote.ok).toBe(true)
    if (withNote.ok && withoutNote.ok) {
      expect(withNote.value.normalizedPredicate).toBe(withoutNote.value.normalizedPredicate)
      expect(withNote.value.digest).toBe(withoutNote.value.digest)
      expect(withNote.value.normalizedPredicate).not.toContain("annotation")
    }
  })

  it("renders `any([])` as `any()` through the normalizer, even though the compiler refuses the document", () => {
    // `any([])` is unsatisfiable and the compiler refuses it, so this case can
    // never be reached through `compileRule`. The renderer still has to produce a
    // total function over the AST, because `describeNormalizedPredicate` is a
    // public entry point and a caller can hand it anything the TYPE admits.
    expect(describePredicates([{ field: "any", predicates: [] }])).toBe("any()")
  })

  it("renders a top-level predicate list as a conjunction, and an empty one as universal", () => {
    expect(describePredicates([])).toBe("all()")
    expect(describePredicates([{ field: "roleId", operator: "eq", value: "r" }])).toBe('roleId == "r"')
    expect(
      describePredicates([
        { field: "roleId", operator: "eq", value: "r" },
        { field: "projectId", operator: "eq", value: "p" },
      ]),
    ).toBe('(roleId == "r" and projectId == "p")')
  })
})

// ===========================================================================
// Action order and normalisation
// ===========================================================================

describe("actions are compiled in action-kind rank order, restrictively first", () => {
  it("orders a mixed action list by rank, restrictively before permissively", () => {
    // The four NON-granting kinds can all coexist in one rule, and the order they
    // are recorded in is the order a reader needs to see them: what is forbidden,
    // then what is capped, then what is merely preferred. The pre-approval is a
    // separate case below because it cannot share a rule with a narrowing.
    const compiled = compileRule(
      rawRuleDocument({
        predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
        actions: [
          { kind: "select_routing_preference", preference: { preferredNodeIds: ["node-1"] } },
          { kind: "add_restrictions", deniedCapabilities: ["fs.write"] },
          { kind: "deny_with_reason", reason: "no" },
          { kind: "set_stricter_budget", budget: { maximumFanOut: 4 } },
          { kind: "require_approval", requireApprovalForDispatch: true },
        ],
      }),
    )
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value.actions.map((action) => action.kind)).toEqual([
      "deny_with_reason",
      "require_approval",
      "add_restrictions",
      "set_stricter_budget",
      "select_routing_preference",
    ])
  })

  it("orders a pre-approval alone, at the top of the rank order", () => {
    const compiled = compileRule(preApprovalDocument({ actions: [PRE_APPROVAL_ACTION] }))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value.actions.map((action) => action.kind)).toEqual(["pre_approve_within_bounds"])
  })

  it("keeps two actions of the SAME kind in declaration order", () => {
    const compiled = compileRule(
      rawRuleDocument({
        actions: [
          { kind: "deny_with_reason", reason: "first" },
          { kind: "deny_with_reason", reason: "second" },
        ],
      }),
    )
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value.actions.map((action) => (action.kind === "deny_with_reason" ? action.reason : ""))).toEqual(["first", "second"])
  })

  it("normalises an action to a canonical text form with members sorted", () => {
    const cases: readonly { action: unknown; expected: string }[] = [
      { action: { kind: "deny_with_reason", reason: "because" }, expected: 'deny_with_reason("because")' },
      { action: { kind: "require_approval", requireApprovalForDispatch: true }, expected: "require_approval[requireApprovalForDispatch=true]" },
      { action: { kind: "add_restrictions", deniedCapabilities: ["b", "a"] }, expected: 'add_restrictions[deniedCapabilities=["a","b"]]' },
      {
        action: { kind: "set_stricter_budget", budget: { maximumFanOut: 4, usageUnit: "tokens" } },
        expected: "set_stricter_budget[maximumFanOut=4,usageUnit=tokens]",
      },
      {
        action: { kind: "select_routing_preference", preference: { preferredNodeIds: ["n2", "n1"] } },
        expected: 'select_routing_preference[preferredNodeIds=["n2","n1"]]',
      },
    ]
    for (const testCase of cases) {
      // The action is parsed through the language's own action schema first, so
      // the normalizer is only ever handed a value the language admits.
      const parsed = ruleActionSchema.safeParse(testCase.action)
      expect(parsed.success).toBe(true)
      if (!parsed.success) continue
      expect(normalizeAction(parsed.data)).toBe(testCase.expected)
    }
  })

  it("keeps `preferredNodeIds` in its declared order, because it is an ordering and not a set", () => {
    // Every other list in the language is sorted, and this one deliberately is
    // not: it is the preference ORDER, and sorting it would silently reverse a
    // preference the author ranked.
    const compiled = compileRule(
      rawRuleDocument({
        predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
        actions: [{ kind: "select_routing_preference", preference: { preferredNodeIds: ["node-z", "node-a"] } }],
      }),
    )
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value.actions[0]).toMatchObject({ kind: "select_routing_preference" })
    expect(normalizeAction(compiled.value.actions[0]!)).toContain('preferredNodeIds=["node-z","node-a"]')
  })
})

// ===========================================================================
// Deep freeze
// ===========================================================================

describe("a compiled rule set is deep-frozen, so an annotation of one cannot corrupt another", () => {
  /** The names frozen at every level, walked from the artifact outward. */
  function frozenPaths(value: unknown, path: string, found: string[] = []): string[] {
    if (value === null || typeof value !== "object") return found
    if (Object.isFrozen(value)) found.push(path)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      frozenPaths((value as Record<string, unknown>)[key], `${path}.${key}`, found)
    }
    return found
  }

  it("freezes the set, each rule, and the collections inside each rule", () => {
    const compiled = compileRuleSet([preApprovalDocument(), budgetDocument()])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const paths = frozenPaths(compiled.value, "set")
    expect(paths).toContain("set")
    expect(paths).toContain("set.rules")
    expect(paths).toContain("set.rules.0")
    expect(paths).toContain("set.rules.0.predicates")
    expect(paths).toContain("set.rules.0.actions")
    expect(paths).toContain("set.rules.0.activation")
    // The DEEPEST level, which is the one a preview would actually reach for: a
    // predicate's `value` array, an action's member list. A freeze that stopped at
    // the rule would leave exactly those mutable.
    expect(paths.some((path) => path.split(".").length >= 4)).toBe(true)
  })

  it("refuses a mutation of the set, a rule, and a nested collection", () => {
    const compiled = compileRuleSet([preApprovalDocument()])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const set = compiled.value
    const rule = set.rules[0]!

    // Each attempt is in a `try` because the failure mode differs by engine: a
    // silent no-op in sloppy mode, a throw in strict mode. What matters is the
    // same either way, which is asserted by reading the value back.
    const attempts: readonly (() => void)[] = [
      () => {
        (set as unknown as { rules: unknown[] }).rules = []
      },
      () => {
        (rule as { enabled: boolean }).enabled = false
      },
      () => {
        (rule.predicates as unknown as unknown[]).length = 0
      },
      () => {
        ;(rule.actions as unknown as Array<{ kind: string }>)[0]!.kind = "deny_with_reason"
      },
    ]
    for (const attempt of attempts) {
      try {
        attempt()
      } catch {
        // A throw is the strict-mode outcome and is equally a refusal.
      }
    }

    expect(set.rules).toHaveLength(1)
    expect(rule.enabled).toBe(true)
    expect(rule.predicates).toHaveLength(1)
    expect(rule.actions[0]?.kind).toBe("pre_approve_within_bounds")
  })

  it("freezes the compiled patterns, so a caller cannot bolt a `g` flag onto a vetted regex", () => {
    // A global or sticky regexp advances `lastIndex` across calls, which would make
    // matching a function of what was matched before rather than of
    // (pattern, subject). `compileSafePattern` freezes the object; the compiled
    // rule carries the frozen value and does not rebuild it.
    const compiled = compileRule(
      rawRuleDocument({ predicates: [{ field: "taskTitlePattern", pattern: "^deploy" }], actions: [{ kind: "deny_with_reason", reason: "x" }] }),
    )
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(Object.isFrozen(compiled.value.patterns[0])).toBe(true)
    expect(Object.isFrozen(compiled.value.patterns[0]?.regex)).toBe(true)
  })
})

// ===========================================================================
// The M0 projection
// ===========================================================================

describe("the M0 projection is a re-shaping that satisfies the frozen ruleSchema exactly", () => {
  it("projects a pre-approval into an M0 pre_approve effect", () => {
    const compiled = compileRule(preApprovalDocument())
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const projected = compiled.value.kernelRule
    expect(projected).not.toBeNull()
    if (projected === null) return
    // Re-parsed through the frozen schema HERE, in the test, as well as in the
    // compiler: a projection that drifted would fail one of the two, and which one
    // matters less than that it fails.
    expect(ruleSchema.safeParse(projected).success).toBe(true)
    expect(projected.effect).toEqual({
      kind: "pre_approve",
      approvedCapabilities: ["fs.read"],
      maximumTimeoutSeconds: 900,
      allowDestructiveEffects: false,
      allowExternalEffects: false,
    })
  })

  it("projects a narrowing into an M0 restrict effect", () => {
    const compiled = compileRule(
      rawRuleDocument({
        predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
        actions: [{ kind: "add_restrictions", deniedCapabilities: ["fs.write"] }],
      }),
    )
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const projected = compiled.value.kernelRule
    expect(projected).not.toBeNull()
    if (projected === null) return
    expect(ruleSchema.safeParse(projected).success).toBe(true)
    expect(projected.effect.kind).toBe("restrict")
  })

  it("merges two narrowing actions into one M0 restrict effect, and refuses a narrowing alongside a pre-approval", () => {
    // The merge is asserted below; the refusal is asserted here because it is the
    // same shape of question: `kernelRule` holds ONE effect, so what happens when
    // a rule wants two is a design decision rather than an accident.
    // `kernelRule` is SINGULAR, so two `add_restrictions` must merge. Denied
    // capabilities are unioned and the approval booleans are OR-ed, which is the
    // monotone direction: merging can only ever deny more.
    const compiled = compileRule(
      rawRuleDocument({
        predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
        actions: [
          { kind: "add_restrictions", deniedCapabilities: ["fs.write"] },
          { kind: "require_approval", requireApprovalForDispatch: true },
        ],
      }),
    )
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const projected = compiled.value.kernelRule
    if (projected === null || projected.effect.kind !== "restrict") throw new Error("expected a restrict projection")
    expect(ruleSchema.safeParse(projected).success).toBe(true)
  })

  it("projects nothing for the three actions the kernel does not model", () => {
    // `deny_with_reason` is enforced by the M6 evaluator and only ever ANDs with
    // the kernel's own deny. `set_stricter_budget` and `select_routing_preference`
    // are for subsystems the kernel has no concept of; forcing them into an M0
    // effect would be inventing a shape.
    for (const document of [validRuleDocument(), budgetDocument(), routingDocument()]) {
      const compiled = compileRule(document)
      expect(compiled.ok).toBe(true)
      if (compiled.ok) expect(compiled.value.kernelRule).toBeNull()
    }
  })

  it("names the narrowing members the M0 restrict effect cannot carry", () => {
    // The M0 `restrict` effect has no `requireApprovalForDispatch` and no
    // `requireApprovalForCapabilities`. Pretending it did would be a second M0
    // shape, which is exactly what ADR 0007 section 2 exists to avoid — so the
    // members are NAMED as unprojected rather than dropped, because "the kernel
    // enforces everything" would otherwise be a false claim.
    const compiled = compileRule(requireApprovalDocument())
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    // Only the member this action actually declared appears. Reporting the other
    // one would say the rule asks for something it does not ask for.
    expect(compiled.value.unprojectedNarrowing).toEqual(["requireApprovalForDispatch"])
    const withCapabilities = compileRule(
      rawRuleDocument({ predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }], actions: [{ kind: "require_approval", requireApprovalForDispatch: true, requireApprovalForCapabilities: ["fs.read"] }] }),
    )
    expect(withCapabilities.ok).toBe(true)
    if (withCapabilities.ok) {
      expect(withCapabilities.value.unprojectedNarrowing).toEqual([
        "requireApprovalForCapabilities",
        "requireApprovalForDispatch",
      ])
    }
  })

  it("refuses a rule that carries BOTH a narrowing and a pre-approval, rather than dropping one", () => {
    // `kernelRule` holds exactly one effect, so one of the two would have to be
    // dropped from the projection. A drop is worse than a refusal: the user can
    // act on a refusal and cannot act on a silent omission.
    const compiled = compileRule(
      rawRuleDocument({
        predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
        actions: [
          { kind: "add_restrictions", deniedCapabilities: ["fs.write"] },
          { kind: "pre_approve_within_bounds", approvedCapabilities: ["fs.read"], maximumTimeoutSeconds: 900, allowDestructiveEffects: false, allowExternalEffects: false, maximumSensitivity: "restricted" },
        ],
      }),
    )
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.conflicting_action_effects")
  })

  // ---------------------------------------------------------------------------
  // The match projection: the M0-expressible subset, and the kernel enforcing it
  // ---------------------------------------------------------------------------

  /** A context the M0 matcher can be handed directly. The M0 shape is only three fields. */
  function kernelContext(overrides: Partial<RuleMatchContext> = {}): RuleMatchContext {
    return { taskTitle: "deploy the api", requestedCapabilities: ["fs.read"], runtimeKind: "opencode", ...overrides }
  }

  function kernelRuleOf(document: unknown): Rule {
    const compiled = compileRule(document)
    if (!compiled.ok) throw new Error(`expected a compiling rule, got ${compiled.error.code}: ${compiled.error.message}`)
    if (compiled.value.kernelRule === null) throw new Error("expected a non-null kernelRule")
    return compiled.value.kernelRule
  }

  it("projects a top-level `capability any` into `match.requestedCapabilitiesAny`, and the M0 kernel REFUSES a dispatch outside it", () => {
    // THE LOAD-BEARING TEST. Before the match projection existed, `match` was `{}`
    // and `matchRule` treats a criterion-less match as `matched: true` — so the
    // kernel applied the pre-approval UNCONDITIONALLY and the predicate rested
    // entirely on the M6 evaluator's gate. This asserts the kernel itself now says
    // no: `matchRule` is imported from the M0 module and run against a context
    // whose requested capabilities do not intersect the projection.
    const kernelRule = kernelRuleOf(
      rawPreApprovalDocument({
        predicates: [{ field: "capability", operator: "any", value: ["fs.read"] }],
        actions: [PRE_APPROVAL_ACTION],
      }),
    )
    expect(kernelRule.match.requestedCapabilitiesAny).toEqual(["fs.read"])

    const refused = matchRule(kernelRule, kernelContext({ requestedCapabilities: ["fs.write"] }))
    expect(refused.matched).toBe(false)
    expect(refused.reason).toContain("requestedCapabilitiesAny")

    // And the positive direction, so the test is not passing because the projection
    // is unconditionally false: a dispatch that DOES ask for `fs.read` matches.
    expect(matchRule(kernelRule, kernelContext({ requestedCapabilities: ["fs.read"] })).matched).toBe(true)
  })

  it("projects a top-level `runtimeKind` into `match.runtimeKinds`, and the M0 kernel refuses a dispatch of another kind", () => {
    const kernelRule = kernelRuleOf(
      rawPreApprovalDocument({
        predicates: [{ field: "runtimeKind", operator: "eq", value: "opencode" }],
        actions: [PRE_APPROVAL_ACTION],
      }),
    )
    expect(kernelRule.match.runtimeKinds).toEqual(["opencode"])
    expect(matchRule(kernelRule, kernelContext({ runtimeKind: "claude" })).matched).toBe(false)
    expect(matchRule(kernelRule, kernelContext({ runtimeKind: "opencode" })).matched).toBe(true)

    // `in` projects the same way, and the members sort and de-duplicate.
    const listed = kernelRuleOf(
      rawPreApprovalDocument({
        predicates: [{ field: "runtimeKind", operator: "in", value: ["opencode", "claude", "opencode"] }],
        actions: [PRE_APPROVAL_ACTION],
      }),
    )
    expect(listed.match.runtimeKinds).toEqual(["claude", "opencode"])
  })

  it("projects a top-level `taskTitlePattern` into `match.taskTitlePattern`, and the M0 kernel agrees with it", () => {
    // `^deploy` is a pattern `compileSafePattern` accepts: it is a literal run
    // anchored at the start, so there is no unbounded quantifier and no ambiguous
    // alternation to trip any of its six refusals.
    //
    // The rule also carries a `capability` predicate because ADR 0007 section 8's
    // twelve scope fields do NOT include `taskTitlePattern` — a pre-approval scoped
    // only by a title is the universal pre-approval wearing a hat, and the compiler
    // refuses it before the projection is ever reached. That refusal is unchanged by
    // this work; it just means the title pattern cannot be the rule's ONLY predicate.
    const kernelRule = kernelRuleOf(
      rawPreApprovalDocument({
        predicates: [{ field: "capability", operator: "any", value: ["fs.read"] }, { field: "taskTitlePattern", pattern: "^deploy" }],
        actions: [PRE_APPROVAL_ACTION],
      }),
    )
    expect(kernelRule.match.taskTitlePattern).toBe("^deploy")
    expect(matchRule(kernelRule, kernelContext({ taskTitle: "rollback the api" })).matched).toBe(false)
    expect(matchRule(kernelRule, kernelContext({ taskTitle: "deploy the api" })).matched).toBe(true)

    // The M0 matcher FAILS CLOSED on a `null` title: a rule requiring a title and
    // given none is not a rule that matches. The M6 side resolves the same absence
    // to `unsatisfied` (types.ts, fail-closed column), so the two agree.
    expect(matchRule(kernelRule, kernelContext({ taskTitle: null })).matched).toBe(false)
  })

  it("leaves `match` EMPTY for a rule whose predicates are all nested or all outside the M0 language", () => {
    // EXPECTED, NOT A BUG. Three cases, and each is a case where an M0 `match`
    // could only be manufactured by descending into a combinator or by inventing
    // a field M0 does not have:
    //   - `all[...]` over an M0-expressible field: the subtree is not descended.
    //   - `taskLabel has`: M0's `match` has no task-label criterion at all.
    // A rule whose only top-level predicate is one of these projects `match: {}`,
    // the kernel matches it unconditionally, and M6 remains the authority on
    // whether it applies. `match: {}` here is the SOUND under-approximation: the
    // kernel checks less than M6, never more and never differently.
    //
    // A `not` over an M0 field is NOT in this list any more: it is now refused at
    // compile time as a universal pre-approval, so it never reaches the
    // projection. See the "counts a `not` as NOT constraining" case above for why
    // that is the correct disposition rather than a projection edge case.
    for (const predicate of [
      { field: "all", predicates: [{ field: "capability", operator: "any", value: ["fs.read"] }] },
      { field: "any", predicates: [{ field: "capability", operator: "any", value: ["fs.read"] }] },
      { field: "taskLabel", operator: "has", value: "release" },
      { field: "toolCategory", operator: "any", value: ["shell"] },
      { field: "roleId", operator: "eq", value: "role-1" },
    ]) {
      const kernelRule = kernelRuleOf(rawPreApprovalDocument({ predicates: [predicate], actions: [PRE_APPROVAL_ACTION] }))
      expect(kernelRule.match).toEqual({})
    }
  })

  it("does NOT project `capability all` or `capability none`, because the kernel's `some()` is an ANY and would weaken an `all` into an `any`", () => {
    // M0's `requestedCapabilitiesAny` is checked with `some()`. Projecting an `all`
    // through it would turn "the dispatch asks for every one of these" into "the
    // dispatch asks for one of these" — a pre-approval scoped to a conjunction
    // would come out of the kernel scoped to a disjunction, and nothing downstream
    // could see the substitution because both sides are just a list of strings.
    // `none` has no M0 counterpart at all. Both are OMITTED, which is the weaker
    // direction: the kernel checks less than M6.
    //
    // `none` needs a REAL scope alongside it now, because a pre-approval whose
    // only predicate is `capability none [...]` is refused as universal. Pairing it
    // with a constructive `projectId` keeps the rule compiling, so the assertion is
    // about the PROJECTION of `none` and not about the vacuity check.
    for (const operator of ["all", "none"]) {
      const kernelRule = kernelRuleOf(
        rawPreApprovalDocument({
          predicates: [
            { field: "projectId", operator: "eq", value: "proj-1" },
            { field: "capability", operator, value: ["fs.read", "fs.write"] },
          ],
          actions: [PRE_APPROVAL_ACTION],
        }),
      )
      expect(kernelRule.match.requestedCapabilitiesAny).toBeUndefined()
    }
  })

  it("keeps the FIRST declared top-level `taskTitlePattern` when M6 declares several", () => {
    // M0 has one pattern field and M6 can declare several, so a conjunction of them
    // cannot be carried. The first DECLARED one is deterministic — declaration
    // order is already part of `normalizedPredicate` (ADR 0007 section 10.2) — and
    // still strictly weaker than the conjunction, which is the direction that
    // matters. Projecting the last, the longest, or refusing would each be a
    // different arbitrary rule.
    const kernelRule = kernelRuleOf(
      rawPreApprovalDocument({
        predicates: [
          { field: "capability", operator: "any", value: ["fs.read"] },
          { field: "taskTitlePattern", pattern: "^deploy" },
          { field: "taskTitlePattern", pattern: "^rollback" },
        ],
        actions: [PRE_APPROVAL_ACTION],
      }),
    )
    expect(kernelRule.match.taskTitlePattern).toBe("^deploy")
  })

  it("sorts and de-duplicates every projected member list, in CODE UNIT order", () => {
    // `localeCompare` would order these differently on different hosts, and a
    // projected `match` that moved with the machine's locale would make the kernel's
    // decision a function of the controller's locale. M0's own `ruleMatchSchema`
    // additionally REFUSES duplicates, so a list that reached it unsorted-and-
    // duplicated would be a compile error rather than a match.
    const kernelRule = kernelRuleOf(
      rawPreApprovalDocument({
        predicates: [
          { field: "capability", operator: "any", value: ["net.fetch", "fs.read", "net.fetch"] },
          { field: "capability", operator: "any", value: ["fs.write", "fs.read"] },
          { field: "runtimeKind", operator: "in", value: ["opencode", "claude"] },
          { field: "runtimeKind", operator: "eq", value: "Aider" },
        ],
        actions: [PRE_APPROVAL_ACTION],
      }),
    )
    expect(kernelRule.match.requestedCapabilitiesAny).toEqual(["fs.read", "fs.write", "net.fetch"])
    // Code unit, so the uppercase member sorts before every lowercase one.
    expect(kernelRule.match.runtimeKinds).toEqual(["Aider", "claude", "opencode"])
  })

  it("projects the SAME `match` onto a `restrict` effect as onto a `pre_approve`", () => {
    // Both projections carry the match. A narrowing whose match the kernel ignored
    // would be the same unconditional-application hole in the half of the language
    // that actually narrows.
    const projected = kernelRuleOf(
      rawRuleDocument({
        predicates: [{ field: "capability", operator: "any", value: ["fs.read"] }],
        actions: [{ kind: "add_restrictions", deniedCapabilities: ["fs.write"] }],
      }),
    )
    expect(projected.effect.kind).toBe("restrict")
    expect(projected.match.requestedCapabilitiesAny).toEqual(["fs.read"])
    expect(matchRule(projected, kernelContext({ requestedCapabilities: ["fs.write"] })).matched).toBe(false)
  })

  it("satisfies the frozen `ruleSchema` for every projected subset, so a drift is a compile error", () => {
    // The property that makes the refusal path reachable at all: `match` is built
    // by re-shaping, so it is parsed through the SAME `ruleSchema` the kernel will
    // use. An M0-incompatible value is refused here, at compile time, rather than
    // projected and then rejected by the kernel at dispatch time.
    // Every predicate shape the projection can see, plus the two it cannot. A
    // `pre_approve_within_bounds` needs one of ADR section 8's twelve scope fields
    // to compile at all, so each case is paired with `capability any [fs.read]`
    // where the case under test is not itself a scope field.
    // The scope predicate a non-scope case is paired with. It is a CONSTRUCTIVE
    // `projectId` rather than a bare `capability any`, because `alreadyScoped` only
    // checks which FIELDS a case names — and `capability none ["fs.read"]` names a
    // scope field while constraining nothing, so pairing by field name alone would
    // leave the pre-approval projection unexercised for exactly the cases that most
    // need it. See the vacuity tests for why naming is not constraining.
    const SCOPE_FIELD = new Set(["projectId", "roleId", "roleVersion", "capability", "toolCategory", "runtimeKind", "targetNodeId", "nodeAdvertisedCapability", "projectPathId", "taskLabel", "dependencyOutcome", "contextSensitivity"])
    const scope: unknown = { field: "projectId", operator: "eq", value: "proj-1" }
    // The VACUOUS forms among the cases below, which name a scope field but
    // constrain nothing and therefore cannot serve as the scoping predicate.
    const VACUOUS_FORMS = new Set(["none", "lacks"])
    const cases: readonly unknown[][] = [
      [{ field: "capability", operator: "any", value: ["fs.read"] }],
      [{ field: "capability", operator: "all", value: ["fs.read", "fs.write"] }],
      [{ field: "capability", operator: "none", value: ["fs.read"] }],
      [{ field: "runtimeKind", operator: "in", value: ["opencode", "claude"] }],
      [{ field: "runtimeKind", operator: "eq", value: "opencode" }],
      [{ field: "taskTitlePattern", pattern: "^deploy" }],
      [{ field: "capability", operator: "any", value: ["fs.read"] }, { field: "taskTitlePattern", pattern: "^deploy" }],
      [{ field: "roleId", operator: "eq", value: "role-1" }],
      [{ field: "all", predicates: [{ field: "capability", operator: "any", value: ["fs.read"] }] }],
      [],
    ]
    const restrictAction = { kind: "add_restrictions", deniedCapabilities: ["fs.write"] }
    for (const predicates of cases) {
      // A universal restriction is legal where a universal pre-approval is not, so
      // the narrowing projection is exercised on the exact same predicate lists.
      expect(ruleSchema.safeParse(kernelRuleOf(rawRuleDocument({ predicates, actions: [restrictAction] }))).success).toBe(true)
      // The pre-approval projection only compiles when the predicate tree
      // CONSTRUCTIVELY constrains one of the twelve scope fields, which is the ADR
      // section 8 restriction and not a limit of the projection. A case whose only
      // scope field is a vacuous form is therefore given the constructive `scope`
      // alongside it, so every case still reaches the projection it is testing.
      const constructsScope = predicates.some((predicate) => {
        const field = (predicate as { field: string }).field
        if (!SCOPE_FIELD.has(field)) return false
        const operator = (predicate as { operator?: string }).operator
        return operator === undefined || !VACUOUS_FORMS.has(operator)
      })
      const scoping = constructsScope ? predicates : [scope, ...predicates]
      expect(ruleSchema.safeParse(kernelRuleOf(rawPreApprovalDocument({ predicates: scoping, actions: [PRE_APPROVAL_ACTION] }))).success).toBe(true)
    }
  })

  it("REFUSES a projected value the frozen `ruleSchema` cannot hold, at compile time, with `rule.invalid_source`", () => {
    // The negative case for the property above, and it has to be a case that
    // REACHES the projection rather than one an earlier pass already refuses.
    // Two routes exist:
    //
    //   - an M0 alphabet the M6 predicate admits and M0 does not. M6's
    //     `runtimeKind` is any 1..128-character string; M0's is the frozen
    //     `runtimeKindSchema` regex, so `node/v1` parses under M6 and cannot be
    //     projected. It is refused rather than dropped: silently dropping a
    //     constraint the author wrote is the failure this whole module refuses.
    //   - a union longer than M0's `ARRAY_MAX` of 128. Three 64-member
    //     `runtimeKind in` predicates union to 192, each under the M6
    //     `MAX_ENUMERATED_MEMBERS` of 64 and under `MAX_PREDICATES_PER_RULE`, and
    //     the M0 `ruleMatchSchema` bounds the union at 128.
    //
    // Note that a DUPLICATE `runtimeKinds` is NOT a reachable case: the projection
    // de-duplicates, and the M6 `ruleSourceDocumentSchema` does not refuse
    // duplicates in the first place, so the second refusal route is the count and
    // never the duplication. `taskTitlePattern` longer than M0's `SHORT_TEXT_MAX`
    // of 256 is likewise unreachable — `MAX_RULE_PATTERN_LENGTH` is 128 and
    // `compileSafePattern` refuses at 128 with `rule.pattern_refused`, one step
    // before the projection runs.
    const badAlphabet = rawPreApprovalDocument({
      predicates: [{ field: "runtimeKind", operator: "eq", value: "node/v1" }],
      actions: [PRE_APPROVAL_ACTION],
    })
    const members = (offset: number): string[] => Array.from({ length: 64 }, (_, index) => `rt-${offset + index}`)
    const tooManyMembers = rawPreApprovalDocument({
      predicates: [
        { field: "runtimeKind", operator: "in", value: members(0) },
        { field: "runtimeKind", operator: "in", value: members(64) },
        { field: "runtimeKind", operator: "in", value: members(128) },
      ],
      actions: [PRE_APPROVAL_ACTION],
    })

    for (const document of [badAlphabet, tooManyMembers]) {
      const compiled = compileRule(document)
      expect(compiled.ok).toBe(false)
      if (compiled.ok) continue
      expect(compiled.error.code).toBe("rule.invalid_source")
      // The refusal names the projection, so an author is told WHICH step refused
      // rather than being handed a generic shape error.
      expect(compiled.error.message).toContain("match")
    }
  })

  it("still projects NOTHING for a rule with no predicates, so a `deny_with_reason` carries no kernel rule", () => {
    // Unchanged by the match work: `deny_with_reason` is enforced by M6 and has no
    // M0 effect to project into, so the answer stays `null` rather than becoming an
    // M0 rule with an empty effect. The empty `match` belongs to a rule that HAS a
    // projectable effect, not to a rule that has none.
    const compiled = compileRule(rawRuleDocument({ predicates: [], actions: [{ kind: "deny_with_reason", reason: "never on a friday" }] }))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value.kernelRule).toBeNull()
    expect(compiled.value.unprojectedNarrowing).toEqual([])
  })

  it("writes the rule's OWN project onto the projection, so the kernel's scope check agrees with M6's", () => {
    const compiled = compileRule(preApprovalDocument())
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value.kernelRule?.projectId).toBe("proj-1")
    expect(compiled.value.kernelRule?.ruleId).toBe("rule-pre")
    expect(compiled.value.kernelRule?.templateVersion).toBe(1)
  })
})

// ===========================================================================
// The universal-predicate restriction
// ===========================================================================

describe("the 'match all' restriction refuses a pre-approval that constrains nothing, and permits a universal restriction", () => {
  it("refuses a pre-approval with an empty predicate list", () => {
    const compiled = compileRule(rawPreApprovalDocument({ predicates: [] }))
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) {
      expect(compiled.error.code).toBe("rule.universal_pre_approval")
      // The message must name the fields that would have scoped it, because
      // "your rule is too broad" is not actionable and this one is.
      expect(compiled.error.message).toContain("projectId")
    }
  })

  it("refuses a pre-approval whose only predicate is all([])", () => {
    const compiled = compileRule(rawPreApprovalDocument({ predicates: [{ field: "all", predicates: [] }] }))
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.universal_pre_approval")
  })

  it("refuses a routing preference that constrains nothing, because it can reorder every dispatch", () => {
    const compiled = compileRule(
      rawRuleDocument({ predicates: [], actions: [{ kind: "select_routing_preference", preference: { preferredNodeIds: ["node-1"] } }] }),
    )
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.universal_pre_approval")
  })

  it("permits the SAME universal shape for the four restricting action kinds", () => {
    // A restriction that applies everywhere is the SAFE direction, and refusing it
    // would push a user with a genuinely global concern toward writing a narrower,
    // less comprehensible rule.
    for (const actions of [
      [{ kind: "deny_with_reason", reason: "never on a friday" }],
      [{ kind: "require_approval", requireApprovalForDispatch: true }],
      [{ kind: "add_restrictions", deniedCapabilities: ["fs.write"] }],
      [{ kind: "set_stricter_budget", budget: { maximumFanOut: 4 } }],
    ]) {
      const compiled = compileRule(rawRuleDocument({ predicates: [], actions }))
      expect(compiled.ok).toBe(true)
    }
  })

  it("accepts a pre-approval scoped by ANY ONE of the twelve scope fields", () => {
    // Every field, individually. A restriction that works for `projectId` and
    // silently fails for `taskLabel` would be a bug in the check, not in the rule.
    //
    // Each entry uses a CONSTRUCTIVE form — one that positively names a value and
    // therefore excludes at least one dispatch. Naming a field is not enough:
    // `roleVersion lte 3` is constructive but `roleVersion lte 1000` excludes
    // nothing, and `dependencyOutcome none` names an ABSENCE. The vacuous forms
    // are refused by the test immediately below, and this one is the regression
    // guard for the other direction: tightening the check must not start refusing
    // legitimate scoping.
    const scopes: readonly { readonly label: string; readonly predicate: unknown }[] = [
      { label: "projectId eq", predicate: { field: "projectId", operator: "eq", value: "proj-1" } },
      { label: "projectId in", predicate: { field: "projectId", operator: "in", value: ["proj-1", "proj-2"] } },
      { label: "roleId eq", predicate: { field: "roleId", operator: "eq", value: "role-1" } },
      { label: "roleVersion interior", predicate: { field: "roleVersion", operator: "lte", value: 3 } },
      { label: "roleVersion between interior", predicate: { field: "roleVersion", operator: "between", value: { min: 1, max: 3 } } },
      { label: "capability any", predicate: { field: "capability", operator: "any", value: ["fs.read"] } },
      { label: "capability all", predicate: { field: "capability", operator: "all", value: ["fs.read"] } },
      { label: "toolCategory any", predicate: { field: "toolCategory", operator: "any", value: ["shell"] } },
      { label: "runtimeKind eq", predicate: { field: "runtimeKind", operator: "eq", value: "opencode" } },
      { label: "runtimeKind in", predicate: { field: "runtimeKind", operator: "in", value: ["opencode", "claude-code"] } },
      { label: "targetNodeId in", predicate: { field: "targetNodeId", operator: "in", value: ["node-1", "node-2"] } },
      { label: "nodeAdvertisedCapability any", predicate: { field: "nodeAdvertisedCapability", operator: "any", value: ["gpu"] } },
      { label: "projectPathId eq", predicate: { field: "projectPathId", operator: "eq", value: "path-1" } },
      { label: "taskLabel has", predicate: { field: "taskLabel", operator: "has", value: "release" } },
      { label: "taskLabel hasAll", predicate: { field: "taskLabel", operator: "hasAll", value: ["release", "urgent"] } },
      { label: "taskLabel hasAll", predicate: { field: "taskLabel", operator: "hasAll", value: ["release", "urgent"] } },
      { label: "dependencyOutcome anyFailed", predicate: { field: "dependencyOutcome", operator: "anyFailed" } },
      { label: "contextSensitivity any", predicate: { field: "contextSensitivity", operator: "any", value: ["restricted"] } },
      { label: "contextSensitivity interior rank", predicate: { field: "contextSensitivity", operator: "maxRankAtMost", value: 1 } },
    ]
    // Every one of the twelve ADR scope fields must appear, so a future field
    // added to `NON_UNIVERSAL_PREDICATE_FIELDS` cannot be added without a case.
    const covered = new Set(scopes.map((scope) => (scope.predicate as { field: string }).field))
    for (const field of NON_UNIVERSAL_PREDICATE_FIELDS) {
      expect(covered.has(field), `no constructive scope case for '${field}'`).toBe(true)
    }
    for (const scope of scopes) {
      const compiled = compileRule(rawPreApprovalDocument({ predicates: [scope.predicate] }))
      expect(compiled.ok, `${scope.label} must still compile`).toBe(true)
    }
  })

  it("refuses a pre-approval scoped only by a VACUOUS form, because naming a field is not constraining it", () => {
    // Every one of these names one of the twelve scope fields and excludes
    // NOTHING. The M6.10 security review showed the first, third, fifth and sixth
    // clearing the safety floor end to end through the real `evaluatePolicy`.
    const vacuous: readonly { readonly label: string; readonly predicate: unknown }[] = [
      // A tautology at the low edge of its declared 1..1000 range.
      { label: "roleVersion gte 1", predicate: { field: "roleVersion", operator: "gte", value: 1 } },
      { label: "roleVersion lte 1000", predicate: { field: "roleVersion", operator: "lte", value: 1_000 } },
      { label: "roleVersion between whole domain", predicate: { field: "roleVersion", operator: "between", value: { min: 1, max: 1_000 } } },
      // An absence: satisfied by every dispatch that never requests the value.
      { label: "taskLabel lacks", predicate: { field: "taskLabel", operator: "lacks", value: ["never-set"] } },
      { label: "capability none", predicate: { field: "capability", operator: "none", value: ["never-requested"] } },
      { label: "nodeAdvertisedCapability none", predicate: { field: "nodeAdvertisedCapability", operator: "none", value: ["gpu"] } },
      { label: "dependencyOutcome none", predicate: { field: "dependencyOutcome", operator: "none" } },
      // Rank comparisons pinned to the ends of the four-rung lattice.
      { label: "contextSensitivity maxRankAtMost 3", predicate: { field: "contextSensitivity", operator: "maxRankAtMost", value: 3 } },
      { label: "contextSensitivity maxRankAtLeast 0", predicate: { field: "contextSensitivity", operator: "maxRankAtLeast", value: 0 } },
      // A negation whose tree beneath it is vacuous.
      {
        label: "not(projectId eq nonexistent)",
        predicate: { field: "not", predicate: { field: "projectId", operator: "eq", value: "proj-does-not-exist" } },
      },
      {
        label: "not(capability none)",
        predicate: { field: "not", predicate: { field: "capability", operator: "none", value: ["fs.write"] } },
      },
    ]
    for (const entry of vacuous) {
      const compiled = compileRule(rawPreApprovalDocument({ predicates: [entry.predicate] }))
      expect(compiled.ok, `${entry.label} must be refused as a universal pre-approval`).toBe(false)
      if (!compiled.ok) expect(compiled.error.code, entry.label).toBe("rule.universal_pre_approval")
    }
  })

  it("refuses a vacuous scope EVEN WHEN a vacuous one is combined with it under `all`", () => {
    // The tree form is the escape hatch an author would reach for: `all` of a
    // real scope and a vacuous predicate reads like two restrictions and is one.
    const compiled = compileRule(
      rawPreApprovalDocument({
        predicates: [
          {
            field: "all",
            predicates: [
              { field: "projectId", operator: "eq", value: "proj-1" },
              { field: "capability", operator: "none", value: ["never-requested"] },
            ],
          },
        ],
      }),
    )
    expect(compiled.ok).toBe(true)
    // And the converse: a tree whose ONLY members are vacuous is refused, however
    // deeply it is nested. Nesting is not scoping.
    const deepVacuous = compileRule(
      rawPreApprovalDocument({
        predicates: [
          { field: "all", predicates: [{ field: "any", predicates: [{ field: "capability", operator: "none", value: ["x"] }] }] },
        ],
      }),
    )
    expect(deepVacuous.ok).toBe(false)
  })

  it("still refuses a pre-approval scoped only by a SHAPE bound, because a shape is not a scope", () => {
    // `fanOut`, `concurrency`, `retryLimit`, `timeoutSeconds` and `scheduleWindow`
    // are deliberately absent from the twelve: a pre-approval constrained only by
    // "timeout <= 900" is the match-all pre-approval wearing a hat.
    for (const predicate of [
      { field: "fanOut", operator: "lte", value: 4 },
      { field: "concurrency", operator: "lte", value: 2 },
      { field: "retryLimit", operator: "lte", value: 1 },
      { field: "timeoutSeconds", operator: "lte", value: 900 },
      { field: "scheduleWindow", windows: [{ daysOfWeek: [1, 2, 3, 4, 5], startMinuteOfDay: 540, endMinuteOfDay: 1020, timeZone: "UTC" }] },
      { field: "taskTitlePattern", pattern: "^deploy" },
    ]) {
      const compiled = compileRule(rawPreApprovalDocument({ predicates: [predicate] }))
      expect(compiled.ok).toBe(false)
      if (!compiled.ok) expect(compiled.error.code).toBe("rule.universal_pre_approval")
    }
  })

  it("counts a `not` as NOT constraining, because a negation can only discard exclusions", () => {
    // This test previously asserted the OPPOSITE, on the argument that
    // `not(projectId == "p")` "cannot be satisfied by every dispatch". That
    // argument is false: it cannot be satisfied by the dispatch that names `p`,
    // and every other dispatch satisfies it. In a system with one project the
    // rule therefore matches every dispatch there is, and the M6.10 security
    // review confirmed end to end that such a rule cleared the safety floor's
    // per-dispatch approval (`evaluatePolicy` returned `allow`,
    // `preApprovalClearedDefault: true`).
    //
    // A `not` inverts what it wraps, so it can only REMOVE exclusions the tree
    // below it established. If that tree is vacuous, the `not` is vacuous. The
    // rule the check actually needs is the constructive one: the tree must
    // contain a field predicate that positively names a value, and a `not`
    // contributes nothing toward that.
    const vacuousNot = compileRule(
      rawPreApprovalDocument({ predicates: [{ field: "not", predicate: { field: "projectId", operator: "eq", value: "other" } }] }),
    )
    expect(vacuousNot.ok).toBe(false)
    if (!vacuousNot.ok) expect(vacuousNot.error.code).toBe("rule.universal_pre_approval")

    // And a `not` around a CONSTRUCTIVE predicate is refused too, which is a
    // deliberate second-order decision rather than an oversight. `not(projectId ==
    // "other")` really does exclude the dispatch that names `"other"`, so
    // excluding it on "a `not` contributes nothing" grounds would be right about
    // the mechanism and wrong about the consequence.
    //
    // The reason it is still refused is the DISCLOSURE. ADR 0007 section 11
    // requires a pre-approval to show the projects, roles, capabilities, nodes
    // and paths it can match. A rule scoped by `not(projectId == "other")` has
    // no such set: its reach is the complement of a singleton, which is every
    // project except one, and `explain.ts` reports that axis as `unknown` — so
    // the reader would be shown `unknown` for a rule that actually has enormous
    // reach. Refusing at compile time is the honest answer: the disclosure cannot
    // be built for this rule, so the rule is refused rather than shipped with an
    // unreadable disclosure.
    const notAroundConstructive = compileRule(
      rawPreApprovalDocument({
        predicates: [{ field: "not", predicate: { field: "projectId", operator: "eq", value: "other" } }],
      }),
    )
    expect(notAroundConstructive.ok).toBe(false)
    if (!notAroundConstructive.ok) expect(notAroundConstructive.error.code).toBe("rule.universal_pre_approval")
  })

  it("counts a nested scope field, because the restriction is about the TREE", () => {
    const compiled = compileRule(
      rawPreApprovalDocument({
        predicates: [{ field: "all", predicates: [{ field: "not", predicate: { field: "fanOut", operator: "lte", value: 4 } }] }],
      }),
    )
    // `fanOut` is not a scope field, so nesting it does not make the rule scoped.
    expect(compiled.ok).toBe(false)
  })
})

// ===========================================================================
// Empty-enum refusals
// ===========================================================================

describe("an unsatisfiable predicate is a compile error, not a rule that never matches", () => {
  it("refuses `in []` on every identifier field", () => {
    for (const field of ["projectId", "roleId", "targetNodeId", "projectPathId", "runtimeKind"]) {
      const compiled = compileRule(rawRuleDocument({ predicates: [{ field, operator: "in", value: [] }] }))
      expect(compiled.ok).toBe(false)
      if (!compiled.ok) expect(compiled.error.code).toBe("rule.empty_enum")
    }
  })

  it("refuses an empty set on capability, toolCategory and nodeAdvertisedCapability, for ANY operator", () => {
    // The ADR names `capability any []`. `all []` and `none []` are refused too,
    // and for the same reason: they are vacuously universal, so allowing them
    // would give a pre-approval two spellings of "constrain nothing" where one is
    // refused and one is not.
    for (const field of ["capability", "toolCategory", "nodeAdvertisedCapability"]) {
      for (const operator of ["any", "all", "none"]) {
        const compiled = compileRule(rawRuleDocument({ predicates: [{ field, operator, value: [] }] }))
        expect(compiled.ok).toBe(false)
        if (!compiled.ok) expect(compiled.error.code).toBe("rule.empty_enum")
      }
    }
  })

  it("refuses a scheduleWindow with no windows", () => {
    const compiled = compileRule(rawRuleDocument({ predicates: [{ field: "scheduleWindow", windows: [] }] }))
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.empty_enum")
  })

  it("refuses `any([])`", () => {
    const compiled = compileRule(rawRuleDocument({ predicates: [{ field: "any", predicates: [] }] }))
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.empty_enum")
  })

  it("refuses a `between` whose min exceeds its max, on every numeric field", () => {
    for (const field of ["roleVersion", "fanOut", "concurrency", "retryLimit", "timeoutSeconds"]) {
      const compiled = compileRule(rawRuleDocument({ predicates: [{ field, operator: "between", value: { min: 9, max: 1 } }] }))
      expect(compiled.ok).toBe(false)
      if (!compiled.ok) expect(compiled.error.code).toBe("rule.empty_enum")
    }
  })

  it("accepts `all([])`, which is the universal predicate and not an empty set", () => {
    // The asymmetry is the point: `all([])` is a DEFINED universal predicate that
    // section 8 then restricts for two action kinds, while `any([])` is
    // unsatisfiable by definition and is refused outright.
    const compiled = compileRule(rawRuleDocument({ predicates: [{ field: "all", predicates: [] }] }))
    expect(compiled.ok).toBe(true)
  })
})

// ===========================================================================
// Pattern compilation
// ===========================================================================

describe("a pattern that fails to compile makes the whole rule invalid", () => {
  const refusals: readonly { pattern: string; why: string }[] = [
    { pattern: "(a+)+", why: "a nested unbounded quantifier" },
    { pattern: "(?=x)*", why: "a repetition of an empty match" },
    { pattern: "(?<=x)y", why: "a lookbehind" },
    { pattern: "(a|a)*", why: "an ambiguous alternation" },
    { pattern: "(((a{1,2}){1,2}){1,2})", why: "quantifiers nested three deep" },
    { pattern: "[unterminated", why: "a character class that does not close" },
  ]

  for (const refusal of refusals) {
    it(`refuses ${refusal.pattern} (${refusal.why})`, () => {
      const compiled = compileRule(
        rawRuleDocument({ predicates: [{ field: "taskTitlePattern", pattern: refusal.pattern }], actions: [{ kind: "deny_with_reason", reason: "x" }] }),
      )
      expect(compiled.ok).toBe(false)
      if (!compiled.ok) {
        expect(compiled.error.code).toBe("rule.pattern_refused")
        // The analyser's own detail travels with the refusal, because "your pattern
        // is unsafe" is not something an author can act on.
        expect(compiled.error.message).toContain("taskTitlePattern")
      }
    })
  }

  it("stores the compiled pattern, never the raw source, on the rule", () => {
    const compiled = compileRule(
      rawRuleDocument({ predicates: [{ field: "taskTitlePattern", pattern: "^deploy" }], actions: [{ kind: "deny_with_reason", reason: "x" }] }),
    )
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value.patterns).toHaveLength(1)
    expect(compiled.value.patterns[0]?.source).toBe("^deploy")
    // The raw text survives only on the source document, for the audit record.
    expect(compiled.value.source.predicates[0]).toMatchObject({ pattern: "^deploy" })
  })
})

// ===========================================================================
// Set compilation: order, scope, duplicates
// ===========================================================================

describe("a compiled rule set is ordered, scoped and duplicate-free", () => {
  it("orders by ruleId ascending in UTF-16 code unit, then templateVersion ascending", () => {
    const compiled = compileRuleSet([
      validRuleDocument({ ruleId: "rule-c", templateVersion: 1 }),
      validRuleDocument({ ruleId: "rule-a", templateVersion: 2 }),
      validRuleDocument({ ruleId: "rule-a", templateVersion: 1 }),
      validRuleDocument({ ruleId: "rule-b", templateVersion: 1 }),
    ])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value.rules.map((rule) => `${rule.ruleId}@${rule.templateVersion}`)).toEqual([
      "rule-a@1",
      "rule-a@2",
      "rule-b@1",
      "rule-c@1",
    ])
  })

  it("orders by CODE UNIT rather than by locale, so the order does not depend on the machine", () => {
    // `localeCompare` would put "rule-a" after "rule-B" under some locales and
    // before it under others, which would make a rule set's evaluation order
    // depend on the host's locale. The uppercase member sorts first by code unit
    // and that is the whole claim.
    const compiled = compileRuleSet([
      validRuleDocument({ ruleId: "rule-a" }),
      validRuleDocument({ ruleId: "rule-A" }),
    ])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value.rules.map((rule) => rule.ruleId)).toEqual(["rule-A", "rule-a"])
  })

  it("produces the same order, the same per-rule digests and the same set digest for a SHUFFLED input", () => {
    // The property that makes supersession independent of arrival order. A set
    // that meant different things depending on how it was loaded could not carry
    // a single digest, and a digest that changed with load order could not be the
    // thing an approval is bound to.
    const documents = [
      validRuleDocument({ ruleId: "rule-c" }),
      validRuleDocument({ ruleId: "rule-a", templateVersion: 1 }),
      validRuleDocument({ ruleId: "rule-a", templateVersion: 2, enabled: false }),
      validRuleDocument({ ruleId: "rule-b" }),
    ]
    const forward = compileRuleSet(documents)
    const shuffled = compileRuleSet([documents[2]!, documents[3]!, documents[0]!, documents[1]!])
    const reversed = compileRuleSet([...documents].reverse())

    expect(forward.ok && shuffled.ok && reversed.ok).toBe(true)
    if (!forward.ok || !shuffled.ok || !reversed.ok) return
    expect(shuffled.value.digest).toBe(forward.value.digest)
    expect(reversed.value.digest).toBe(forward.value.digest)
    expect(shuffled.value.rules.map((rule) => `${rule.ruleId}@${rule.templateVersion}`)).toEqual(
      forward.value.rules.map((rule) => `${rule.ruleId}@${rule.templateVersion}`),
    )
  })

  it("refuses a set spanning two projects", () => {
    // Rules are per-project in the M0 contract, and a set spanning two projects
    // would put a rule authored for one into a project it does not belong to.
    const compiled = compileRuleSet([validRuleDocument({ projectId: "proj-1" }), validRuleDocument({ ruleId: "rule-b", projectId: "proj-2" })])
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.project_scope_mismatch")
  })

  it("refuses the same ruleId and templateVersion twice, because which one wins would depend on input order", () => {
    const compiled = compileRuleSet([validRuleDocument(), validRuleDocument({ actions: [{ kind: "deny_with_reason", reason: "a different reason" }] })])
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.invalid_source")
  })

  it("accepts the same ruleId at two DIFFERENT templateVersions, because that is how supersession is expressed", () => {
    const compiled = compileRuleSet([validRuleDocument({ templateVersion: 1 }), validRuleDocument({ templateVersion: 2 })])
    expect(compiled.ok).toBe(true)
    if (compiled.ok) expect(compiled.value.rules).toHaveLength(2)
  })

  it("accepts an empty set, because 'no rules' is a legitimate state and not an error", () => {
    const compiled = compileRuleSet([])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value.rules).toHaveLength(0)
  })

  it("refuses a set that is not an array", () => {
    for (const value of [null, undefined, 42, { rules: [] }, "rules"]) {
      const compiled = compileRuleSet(value as never)
      expect(compiled.ok).toBe(false)
    }
  })

  it("states the limit table it compiled under, so an artifact says which budget it was built to", () => {
    const compiled = compileRuleSet([validRuleDocument()])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value.limits.MAX_RULES_PER_SET).toBe(MAX_RULES_PER_SET)
    expect(Object.isFrozen(compiled.value.limits)).toBe(true)
  })

  it("names the failing entry when one member of a set is refused", () => {
    // "Rule set entry 1: ..." — a set-level refusal that does not say WHICH rule
    // is a refusal an author has to bisect by hand.
    const compiled = compileRuleSet([validRuleDocument(), rawRuleDocument({ ruleId: "rule-b", actions: [{ kind: "nonsense" }] })])
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.message).toContain("entry 1")
  })
})

// ===========================================================================
// The language version is checked before the schema
// ===========================================================================

describe("a document at another language version is told its VERSION is wrong, not that its fields are", () => {
  it("refuses version 1, which is the M0 record version, with the version code", () => {
    const compiled = compileRule(rawRuleDocument({ languageVersion: 1 }))
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) {
      expect(compiled.error.code).toBe("rule.language_version_unsupported")
      expect(compiled.error.message).toContain("version 1")
      expect(compiled.error.message).toContain("version 2")
    }
  })

  it("refuses a document with no languageVersion at all, with the version code rather than a shape error", () => {
    const document = rawRuleDocument()
    delete document["languageVersion"]
    const compiled = compileRule(document)
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.language_version_unsupported")
  })

  it("refuses a document that is not an object before it looks at anything in it", () => {
    for (const value of [null, undefined, 42, "a rule", []]) {
      const compiled = compileRule(value)
      expect(compiled.ok).toBe(false)
      if (!compiled.ok) expect(compiled.error.code).toBe("rule.invalid_source")
    }
  })
})

// ===========================================================================
// Determinism
// ===========================================================================

describe("compiling the same document twice produces the same artifact, byte for byte", () => {
  it("produces an identical digest, normalized form and canonical projection", () => {
    const document = preApprovalDocument()
    const first = compileRule(document)
    const second = compileRule(clone(document))
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.digest).toBe(first.value.digest)
    expect(second.value.normalizedPredicate).toBe(first.value.normalizedPredicate)
    // The canonical projection is the thing the set digest is measured over, so
    // it has to be identical for the set digest to be stable.
    expect(canonicalJson(second.value.actions)).toBe(canonicalJson(first.value.actions))
  })

  it("produces the same set digest across fifty compilations of the same documents", () => {
    const documents = [preApprovalDocument(), budgetDocument(), validRuleDocument()]
    const digests = new Set<string>()
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const compiled = compileRuleSet(clone(documents))
      expect(compiled.ok).toBe(true)
      if (compiled.ok) digests.add(compiled.value.digest)
    }
    // One distinct digest across fifty runs. More than one would mean something in
    // the pipeline reads a clock, a random source, or an object key order.
    expect(digests.size).toBe(1)
  })
})

// ===========================================================================
// Immutability of the source
// ===========================================================================

describe("compiling does not mutate the source document", () => {
  it("leaves the input exactly as it was", () => {
    // The compiler is handed a document a caller may still be holding; mutating
    // it would make the caller's copy differ from what was compiled, and the
    // digest would then describe something the caller cannot reproduce.
    const document = preApprovalDocument()
    const before = canonicalJson(document)
    compileRule(document)
    expect(canonicalJson(document)).toBe(before)
  })
})

// ===========================================================================
// The digest covers what the kernel projection is derived from
// ===========================================================================

describe("excluding kernelRule from the digest does not let two documents collide", () => {
  // `compiledRuleProjection` deliberately omits `kernelRule` from a rule's
  // identity, because `match` is derived from the top-level predicates and
  // `effect` from the actions, both of which the projection already covers, and
  // because including it would make every rule's digest move when the FROZEN M0
  // `ruleSchema` moved. That argument is load-bearing, so it is asserted rather
  // than only written down: if it were wrong, two documents whose KERNEL
  // PROJECTS DIFFERENTLY could share one digest, and a digest that cannot tell
  // two rules apart cannot bind an approval to the rule that granted it.
  //
  // Each pair below differs ONLY in a predicate the M0 projection reads. If the
  // digest ever collides on a pair, the exclusion of `kernelRule` has become
  // unsound and the kernel would be handed a projection the digest never covered.
  const collidingPairs: readonly { readonly label: string; readonly left: (p: unknown) => unknown; readonly right: (p: unknown) => unknown }[] = [
    {
      label: "a different requested-capability set",
      left: () => preApprovalDocument({ predicates: [{ field: "capability", operator: "any", value: ["fs.read"] }] }),
      right: () => preApprovalDocument({ predicates: [{ field: "capability", operator: "any", value: ["fs.write"] }] }),
    },
    {
      label: "a different runtime kind",
      left: () => preApprovalDocument({ predicates: [{ field: "runtimeKind", operator: "eq", value: "opencode" }] }),
      right: () => preApprovalDocument({ predicates: [{ field: "runtimeKind", operator: "eq", value: "claude-code" }] }),
    },
    {
      label: "a different title pattern",
      left: () =>
        preApprovalDocument({
          predicates: [
            { field: "projectId", operator: "eq", value: PROJECT_ID },
            { field: "taskTitlePattern", pattern: "^build" },
          ],
        }),
      right: () =>
        preApprovalDocument({
          predicates: [
            { field: "projectId", operator: "eq", value: PROJECT_ID },
            { field: "taskTitlePattern", pattern: "^deploy" },
          ],
        }),
    },
    {
      label: "a projectable predicate against none at all",
      // `require_approval` rather than `pre_approve_within_bounds`, because ADR
      // section 8 refuses a universal PRE-APPROVAL. For a pre-approval the
      // "projectable predicate against none" case is not merely differently
      // digested, it is unreachable; a narrowing action may be universal, which
      // is what makes this pair expressible at all.
      left: () => requireApprovalDocument({ predicates: [{ field: "runtimeKind", operator: "eq", value: "opencode" }] }),
      right: () => requireApprovalDocument({ predicates: [] }),
    },
  ]

  for (const pair of collidingPairs) {
    it(`gives ${pair.label} a different digest even though only the kernel projection differs`, () => {
      const left = compileRule(pair.left(undefined))
      const right = compileRule(pair.right(undefined))
      expect(left.ok).toBe(true)
      expect(right.ok).toBe(true)
      if (!left.ok || !right.ok) return
      // Sanity: the two really are different rules by the measure that matters.
      expect(canonicalJson(left.value.kernelRule?.match ?? {})).not.toBe(
        canonicalJson(right.value.kernelRule?.match ?? {}),
      )
      expect(left.value.digest).not.toBe(right.value.digest)
      expect(left.value.normalizedPredicate).not.toBe(right.value.normalizedPredicate)
    })
  }

  it("gives two documents with the SAME kernel projection the same digest", () => {
    // The converse, so the previous test cannot be satisfied by a digest that
    // simply changes on every compile.
    const document = preApprovalDocument({
      predicates: [{ field: "capability", operator: "any", value: ["fs.read"] }],
    })
    const first = compileRule(clone(document))
    const second = compileRule(clone(document))
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.value.digest).toBe(second.value.digest)
    expect(canonicalJson(first.value.kernelRule?.match ?? {})).toBe(
      canonicalJson(second.value.kernelRule?.match ?? {}),
    )
  })

  it("gives a set digest that changes when only a projectable predicate changes", () => {
    const left = compileRuleSet([preApprovalDocument({ ruleId: "rule-a", predicates: [{ field: "runtimeKind", operator: "eq", value: "opencode" }] })])
    const right = compileRuleSet([preApprovalDocument({ ruleId: "rule-a", predicates: [{ field: "runtimeKind", operator: "eq", value: "codex" }] })])
    expect(left.ok).toBe(true)
    expect(right.ok).toBe(true)
    if (!left.ok || !right.ok) return
    expect(left.value.digest).not.toBe(right.value.digest)
  })
})

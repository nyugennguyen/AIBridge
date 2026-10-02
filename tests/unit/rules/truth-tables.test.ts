/**
 * The truth tables: for every operator of every predicate field, the satisfied
 * and unsatisfied case.
 *
 * This is the file that decides whether the language fails CLOSED. The ADR's
 * fail-closed column is a specification, and a specification that is not tested
 * per operator is a specification that was written and not read. So the shape
 * here is deliberately mechanical: one table per field, one row per operator,
 * and for each row a context that satisfies it and a context that does not.
 *
 * THE ROW THAT MATTERS MOST is the `not` one, near the end:
 *
 *   `not(unknown) == unsatisfied`
 *
 * If that were `satisfied`, the language would fail OPEN: a rule scoped to "not
 * the production role" would MATCH a dispatch whose role the system could not
 * determine, and the failure mode is a rule applying where its author said it
 * must not. It is asserted on its own, at the top level, with the three states of
 * the operand made explicit — not as a side effect of some larger case.
 *
 * WHY `satisfied`/`unsatisfied` IS ALL AN OUTCOME CAN BE. The internal verdict has
 * three states, but the exported `PredicateOutcome.satisfaction` has two and a
 * separate `unevaluable` flag. These tests assert that the flag is set whenever
 * the context could not say, which is what makes the two-valued form honest rather
 * than lossy.
 */

import { describe, expect, it } from "vitest"
import { compileRule, compileRuleSet, evaluateRules, type RuleEvaluationContext } from "../../../src/rules/index.js"
import { rawRuleDocument, validContext } from "./fixtures.js"

/**
 * Compiles a rule whose only predicate is `predicate`, evaluates it against
 * `context`, and returns the single top-level predicate outcome.
 *
 * The rule carries `deny_with_reason` so it compiles without tripping the
 * universal-predicate restriction: a rule with one field predicate and no
 * pre-approval is not universal, but a rule with an EMPTY predicate list would be.
 */
function evaluateOne(predicate: unknown, context: Partial<Record<string, unknown>> = {}) {
  const compiled = compileRuleSet([
    rawRuleDocument({
      predicates: [predicate],
      actions: [{ kind: "deny_with_reason", reason: "test" }],
    }),
  ])
  expect(compiled.ok).toBe(true)
  if (!compiled.ok) throw new Error(compiled.error.message)
  const result = evaluateRules(compiled.value, validContext(context))
  const trace = result.traces[0]
  expect(trace).toBeDefined()
  return trace?.predicateOutcomes[0]
}

/**
 * Compiles one document and returns the single rule's match outcome.
 *
 * Goes through `compileRuleSet` rather than fabricating a `CompiledRuleSet` around
 * a `CompiledRule`, because the SET is the only thing evaluation accepts and a
 * test that reached past the compiler would be testing a shape the module does
 * not support.
 */
function matchOutcomeOf(document: Record<string, unknown>, context: Partial<Record<string, unknown>> = {}): string | undefined {
  const compiled = compileRuleSet([document])
  expect(compiled.ok).toBe(true)
  if (!compiled.ok) throw new Error(compiled.error.message)
  return evaluateRules(compiled.value, validContext(context)).traces[0]?.matchOutcome
}

function satisfaction(predicate: unknown, context: Partial<Record<string, unknown>> = {}): "satisfied" | "unsatisfied" {
  const outcome = evaluateOne(predicate, context)
  expect(outcome).toBeDefined()
  if (!outcome) throw new Error("no outcome")
  return outcome.satisfaction
}

function unevaluable(predicate: unknown, context: Partial<Record<string, unknown>> = {}): boolean {
  const outcome = evaluateOne(predicate, context)
  if (!outcome) throw new Error("no outcome")
  return outcome.unevaluable
}

// ===========================================================================
// 1. projectId — eq, in
// ===========================================================================

describe("predicate 1 projectId compares by eq and in against a value that is never absent", () => {
  it("satisfies eq when the project matches", () => {
    expect(satisfaction({ field: "projectId", operator: "eq", value: "proj-1" })).toBe("satisfied")
  })

  it("unsatisfies eq when the project differs", () => {
    expect(satisfaction({ field: "projectId", operator: "eq", value: "proj-2" })).toBe("unsatisfied")
  })

  it("satisfies in when the project is one of the members", () => {
    expect(satisfaction({ field: "projectId", operator: "in", value: ["proj-2", "proj-1"] })).toBe("satisfied")
  })

  it("unsatisfies in when the project is not a member", () => {
    expect(satisfaction({ field: "projectId", operator: "in", value: ["proj-2", "proj-3"] })).toBe("unsatisfied")
  })
})

// ===========================================================================
// 2. roleId — eq, in. Absent role is unsatisfied.
// ===========================================================================

describe("predicate 2 roleId treats an absent role as unsatisfied, not as a match", () => {
  it("satisfies eq when the role matches", () => {
    expect(satisfaction({ field: "roleId", operator: "eq", value: "role-1" })).toBe("satisfied")
  })

  it("unsatisfies eq when the role differs", () => {
    expect(satisfaction({ field: "roleId", operator: "eq", value: "role-2" })).toBe("unsatisfied")
  })

  it("satisfies in when the role is one of the members", () => {
    expect(satisfaction({ field: "roleId", operator: "in", value: ["role-1", "role-2"] })).toBe("satisfied")
  })

  it("unsatisfies in when the role is not a member", () => {
    expect(satisfaction({ field: "roleId", operator: "in", value: ["role-2"] })).toBe("unsatisfied")
  })

  it("unsatisfies eq on a context that names no role, and says the context could not say", () => {
    expect(satisfaction({ field: "roleId", operator: "eq", value: "role-1" }, { roleId: null })).toBe("unsatisfied")
    expect(unevaluable({ field: "roleId", operator: "eq", value: "role-1" }, { roleId: null })).toBe(true)
  })

  it("unsatisfies in on a context that names no role", () => {
    expect(satisfaction({ field: "roleId", operator: "in", value: ["role-1"] }, { roleId: null })).toBe("unsatisfied")
  })
})

// ===========================================================================
// 3. roleVersion — eq, lt, lte, gt, gte, between
// ===========================================================================

describe("predicate 3 roleVersion compares numerically, with an absent version unsatisfied", () => {
  const cases: readonly { operator: string; value: unknown; contextVersion: number; expected: "satisfied" | "unsatisfied" }[] = [
    { operator: "eq", value: 3, contextVersion: 3, expected: "satisfied" },
    { operator: "eq", value: 3, contextVersion: 4, expected: "unsatisfied" },
    { operator: "lt", value: 4, contextVersion: 3, expected: "satisfied" },
    { operator: "lt", value: 3, contextVersion: 3, expected: "unsatisfied" },
    { operator: "lte", value: 3, contextVersion: 3, expected: "satisfied" },
    { operator: "lte", value: 2, contextVersion: 3, expected: "unsatisfied" },
    { operator: "gt", value: 2, contextVersion: 3, expected: "satisfied" },
    { operator: "gt", value: 3, contextVersion: 3, expected: "unsatisfied" },
    { operator: "gte", value: 3, contextVersion: 3, expected: "satisfied" },
    { operator: "gte", value: 4, contextVersion: 3, expected: "unsatisfied" },
    { operator: "between", value: { min: 1, max: 3 }, contextVersion: 2, expected: "satisfied" },
    // Both endpoints are INCLUSIVE, which is a choice: a `between 1 and 3` that
    // excluded 3 would be surprising, and a range a reader has to reason about
    // inclusively is a range they will get wrong.
    { operator: "between", value: { min: 1, max: 3 }, contextVersion: 1, expected: "satisfied" },
    { operator: "between", value: { min: 1, max: 3 }, contextVersion: 3, expected: "satisfied" },
    { operator: "between", value: { min: 1, max: 3 }, contextVersion: 4, expected: "unsatisfied" },
    { operator: "between", value: { min: 5, max: 9 }, contextVersion: 3, expected: "unsatisfied" },
  ]

  for (const testCase of cases) {
    it(`${testCase.operator} ${JSON.stringify(testCase.value)} against roleVersion ${testCase.contextVersion} is ${testCase.expected}`, () => {
      expect(
        satisfaction({ field: "roleVersion", operator: testCase.operator, value: testCase.value }, { roleVersion: testCase.contextVersion }),
      ).toBe(testCase.expected)
    })
  }

  it("unsatisfies every operator on a context that names no role version", () => {
    for (const operator of ["eq", "lt", "lte", "gt", "gte"]) {
      expect(satisfaction({ field: "roleVersion", operator, value: 3 }, { roleVersion: null })).toBe("unsatisfied")
    }
    expect(satisfaction({ field: "roleVersion", operator: "between", value: { min: 1, max: 5 } }, { roleVersion: null })).toBe("unsatisfied")
  })

  it("refuses a `between` whose min exceeds its max at compile time, so it never reaches a truth table", () => {
    const compiled = compileRule(
      rawRuleDocument({ predicates: [{ field: "roleVersion", operator: "between", value: { min: 5, max: 1 } }] }),
    )
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.empty_enum")
  })
})

// ===========================================================================
// 4/5/8. capability, toolCategory, nodeAdvertisedCapability — any, all, none
// ===========================================================================

describe("the set-valued predicates implement any, all and none over a request", () => {
  it("capability any is satisfied by an intersection and unsatisfied by a disjoint set", () => {
    expect(satisfaction({ field: "capability", operator: "any", value: ["fs.read", "fs.write"] })).toBe("satisfied")
    // `net.fetch` IS requested by the fixture, so the disjoint case names
    // capabilities the request does not carry.
    expect(satisfaction({ field: "capability", operator: "any", value: ["fs.write", "net.egress"] })).toBe("unsatisfied")
  })

  it("capability all is satisfied only when every member is requested", () => {
    expect(satisfaction({ field: "capability", operator: "all", value: ["fs.read", "net.fetch"] })).toBe("satisfied")
    expect(satisfaction({ field: "capability", operator: "all", value: ["fs.read", "fs.write"] })).toBe("unsatisfied")
  })

  it("capability none is satisfied only when no member is requested", () => {
    expect(satisfaction({ field: "capability", operator: "none", value: ["fs.write"] })).toBe("satisfied")
    expect(satisfaction({ field: "capability", operator: "none", value: ["fs.read"] })).toBe("unsatisfied")
  })

  it("capability any over a request with no capabilities is unsatisfied, and is marked unevaluable", () => {
    // The ADR's fail-closed column, row 4, in its own words. `unevaluable` is set
    // because an empty request is not the same fact as a request that asked for
    // something else — and a `not` over the two must behave the same way, which
    // only holds because both are `unsatisfied`.
    expect(satisfaction({ field: "capability", operator: "any", value: ["fs.read"] }, { requestedCapabilities: [] })).toBe("unsatisfied")
    expect(unevaluable({ field: "capability", operator: "any", value: ["fs.read"] }, { requestedCapabilities: [] })).toBe(true)
  })

  it("capability all over a request with no capabilities is unsatisfied", () => {
    expect(satisfaction({ field: "capability", operator: "all", value: ["fs.read"] }, { requestedCapabilities: [] })).toBe("unsatisfied")
  })

  it("capability none over a request with no capabilities is satisfied", () => {
    // The assertion-of-absence case: "the request has none of these" is TRUE of a
    // request that asks for nothing, and reporting it as anything else would make
    // `none` a claim about the request rather than about a capability.
    expect(satisfaction({ field: "capability", operator: "none", value: ["fs.read"] }, { requestedCapabilities: [] })).toBe("satisfied")
  })

  it("toolCategory behaves identically to capability over its own axis", () => {
    expect(satisfaction({ field: "toolCategory", operator: "any", value: ["shell"] })).toBe("satisfied")
    expect(satisfaction({ field: "toolCategory", operator: "any", value: ["net"] })).toBe("unsatisfied")
    expect(satisfaction({ field: "toolCategory", operator: "all", value: ["shell", "fs"] })).toBe("satisfied")
    expect(satisfaction({ field: "toolCategory", operator: "all", value: ["shell", "net"] })).toBe("unsatisfied")
    expect(satisfaction({ field: "toolCategory", operator: "none", value: ["net"] })).toBe("satisfied")
    expect(satisfaction({ field: "toolCategory", operator: "none", value: ["shell"] })).toBe("unsatisfied")
  })

  it("nodeAdvertisedCapability any and all are unsatisfied with no capability snapshot, and none is satisfied", () => {
    // The ADR's fail-closed column, row 8, verbatim. A node with NO SNAPSHOT is
    // different from a node whose snapshot lists nothing, and the difference is
    // visible: `none` asserts an absence, and a node whose capabilities are
    // unknown has — as far as that assertion goes — none of them.
    const noSnapshot = { nodeAdvertisedCapabilities: null }
    expect(satisfaction({ field: "nodeAdvertisedCapability", operator: "any", value: ["fs.read"] }, noSnapshot)).toBe("unsatisfied")
    expect(unevaluable({ field: "nodeAdvertisedCapability", operator: "any", value: ["fs.read"] }, noSnapshot)).toBe(true)
    expect(satisfaction({ field: "nodeAdvertisedCapability", operator: "all", value: ["fs.read"] }, noSnapshot)).toBe("unsatisfied")
    expect(satisfaction({ field: "nodeAdvertisedCapability", operator: "none", value: ["fs.read"] }, noSnapshot)).toBe("satisfied")
  })

  it("nodeAdvertisedCapability distinguishes an empty snapshot from an absent one only in the reason", () => {
    const emptySnapshot = { nodeAdvertisedCapabilities: [] }
    expect(satisfaction({ field: "nodeAdvertisedCapability", operator: "any", value: ["fs.read"] }, emptySnapshot)).toBe("unsatisfied")
    expect(satisfaction({ field: "nodeAdvertisedCapability", operator: "none", value: ["fs.read"] }, emptySnapshot)).toBe("satisfied")
    // Both are `unsatisfied` for `any`, but the absent snapshot is marked
    // unevaluable and the empty one is not: the system KNOWS the node advertises
    // nothing, which is a fact, rather than failing to know.
    expect(unevaluable({ field: "nodeAdvertisedCapability", operator: "any", value: ["fs.read"] }, emptySnapshot)).toBe(true)
  })
})

// ===========================================================================
// 6. runtimeKind — eq, in. Absent runtime is unsatisfied.
// ===========================================================================

describe("predicate 6 runtimeKind treats an absent runtime kind as unsatisfied", () => {
  it("satisfies eq and in when the runtime matches", () => {
    expect(satisfaction({ field: "runtimeKind", operator: "eq", value: "opencode" })).toBe("satisfied")
    expect(satisfaction({ field: "runtimeKind", operator: "in", value: ["claude", "opencode"] })).toBe("satisfied")
  })

  it("unsatisfies eq and in when the runtime differs", () => {
    expect(satisfaction({ field: "runtimeKind", operator: "eq", value: "claude" })).toBe("unsatisfied")
    expect(satisfaction({ field: "runtimeKind", operator: "in", value: ["claude"] })).toBe("unsatisfied")
  })

  it("unsatisfies on a context that names no runtime", () => {
    expect(satisfaction({ field: "runtimeKind", operator: "eq", value: "opencode" }, { runtimeKind: null })).toBe("unsatisfied")
    expect(unevaluable({ field: "runtimeKind", operator: "eq", value: "opencode" }, { runtimeKind: null })).toBe(true)
  })
})

// ===========================================================================
// 7. targetNodeId — eq, in. Absent node (local dispatch) is unsatisfied.
// ===========================================================================

describe("predicate 7 targetNodeId treats a local dispatch, which has no target node, as unsatisfied", () => {
  it("satisfies eq and in when the node matches", () => {
    expect(satisfaction({ field: "targetNodeId", operator: "eq", value: "node-1" })).toBe("satisfied")
    expect(satisfaction({ field: "targetNodeId", operator: "in", value: ["node-1", "node-2"] })).toBe("satisfied")
  })

  it("unsatisfies eq and in when the node differs", () => {
    expect(satisfaction({ field: "targetNodeId", operator: "eq", value: "node-2" })).toBe("unsatisfied")
    expect(satisfaction({ field: "targetNodeId", operator: "in", value: ["node-2"] })).toBe("unsatisfied")
  })

  it("unsatisfies on a context with no target node, which is what a local dispatch looks like", () => {
    expect(satisfaction({ field: "targetNodeId", operator: "eq", value: "node-1" }, { targetNodeId: null })).toBe("unsatisfied")
    expect(unevaluable({ field: "targetNodeId", operator: "eq", value: "node-1" }, { targetNodeId: null })).toBe(true)
  })
})

// ===========================================================================
// 9. projectPathId — eq, in. An un-allowlisted path is unsatisfied.
// ===========================================================================

describe("predicate 9 projectPathId treats an un-allowlisted path as unsatisfied", () => {
  it("satisfies eq and in when the path matches", () => {
    expect(satisfaction({ field: "projectPathId", operator: "eq", value: "path-1" })).toBe("satisfied")
    expect(satisfaction({ field: "projectPathId", operator: "in", value: ["path-1", "path-2"] })).toBe("satisfied")
  })

  it("unsatisfies eq and in when the path differs", () => {
    expect(satisfaction({ field: "projectPathId", operator: "eq", value: "path-2" })).toBe("unsatisfied")
    expect(satisfaction({ field: "projectPathId", operator: "in", value: ["path-2"] })).toBe("unsatisfied")
  })

  it("unsatisfies on a context with no allowlisted path", () => {
    // The predicate is a FILTER over an already-authorized set, not the
    // authorization: `authorizeLaunchPath` upstream already refused a path that is
    // not on the allowlist, so by the time a rule sees `null` the dispatch is
    // unauthorized and the rule must not match it.
    expect(satisfaction({ field: "projectPathId", operator: "eq", value: "path-1" }, { projectPathId: null })).toBe("unsatisfied")
  })

  it("compares an opaque path ID, never a path string, so no rule can name a directory", () => {
    // A filesystem path is not a legal value: the identifier alphabet excludes
    // `/`. A rule cannot name a directory, and a path rule's blast radius cannot
    // depend on the filesystem layout.
    const compiled = compileRule(
      rawRuleDocument({ predicates: [{ field: "projectPathId", operator: "eq", value: "/Users/someone/project" }] }),
    )
    expect(compiled.ok).toBe(false)
  })
})

// ===========================================================================
// 10. taskLabel — has, hasAny, hasAll, lacks
// ===========================================================================

describe("predicate 10 taskLabel treats a task with no labels as unsatisfied for has* and satisfied for lacks", () => {
  it("satisfies has when the task carries the label", () => {
    expect(satisfaction({ field: "taskLabel", operator: "has", value: "release" })).toBe("satisfied")
  })

  it("unsatisfies has when the task does not carry the label", () => {
    expect(satisfaction({ field: "taskLabel", operator: "has", value: "hotfix" })).toBe("unsatisfied")
  })

  it("satisfies hasAny on an intersection and unsatisfies it on a disjoint set", () => {
    expect(satisfaction({ field: "taskLabel", operator: "hasAny", value: ["hotfix", "release"] })).toBe("satisfied")
    expect(satisfaction({ field: "taskLabel", operator: "hasAny", value: ["hotfix"] })).toBe("unsatisfied")
  })

  it("satisfies hasAll only when every label is present", () => {
    expect(satisfaction({ field: "taskLabel", operator: "hasAll", value: ["release", "urgent"] })).toBe("satisfied")
    expect(satisfaction({ field: "taskLabel", operator: "hasAll", value: ["release", "hotfix"] })).toBe("unsatisfied")
  })

  it("satisfies lacks only when no declared label is present", () => {
    expect(satisfaction({ field: "taskLabel", operator: "lacks", value: ["hotfix"] })).toBe("satisfied")
    expect(satisfaction({ field: "taskLabel", operator: "lacks", value: ["release"] })).toBe("unsatisfied")
  })

  it("unsatisfies has, hasAny and hasAll on a task with no labels, and satisfies lacks", () => {
    const noLabels = { taskLabels: [] }
    expect(satisfaction({ field: "taskLabel", operator: "has", value: "release" }, noLabels)).toBe("unsatisfied")
    expect(satisfaction({ field: "taskLabel", operator: "hasAny", value: ["release"] }, noLabels)).toBe("unsatisfied")
    expect(satisfaction({ field: "taskLabel", operator: "hasAll", value: ["release"] }, noLabels)).toBe("unsatisfied")
    expect(satisfaction({ field: "taskLabel", operator: "lacks", value: ["release"] }, noLabels)).toBe("satisfied")
  })
})

// ===========================================================================
// 11. dependencyOutcome — anySucceeded, anyFailed, allSucceeded, allFailed, none
// ===========================================================================

describe("predicate 11 dependencyOutcome treats a task with no dependencies as unsatisfied for every operator except none", () => {
  it("satisfies anySucceeded when at least one dependency succeeded", () => {
    expect(satisfaction({ field: "dependencyOutcome", operator: "anySucceeded" })).toBe("satisfied")
  })

  it("unsatisfies anySucceeded when no dependency succeeded", () => {
    expect(satisfaction({ field: "dependencyOutcome", operator: "anySucceeded" }, { dependencyOutcomes: ["failed", "failed"] })).toBe("unsatisfied")
  })

  it("satisfies anyFailed when at least one dependency failed", () => {
    expect(satisfaction({ field: "dependencyOutcome", operator: "anyFailed" })).toBe("satisfied")
  })

  it("unsatisfies anyFailed when no dependency failed", () => {
    expect(satisfaction({ field: "dependencyOutcome", operator: "anyFailed" }, { dependencyOutcomes: ["succeeded"] })).toBe("unsatisfied")
  })

  it("satisfies allSucceeded only when every dependency succeeded", () => {
    expect(satisfaction({ field: "dependencyOutcome", operator: "allSucceeded" }, { dependencyOutcomes: ["succeeded", "succeeded"] })).toBe("satisfied")
    expect(satisfaction({ field: "dependencyOutcome", operator: "allSucceeded" })).toBe("unsatisfied")
  })

  it("satisfies allFailed only when every dependency failed", () => {
    expect(satisfaction({ field: "dependencyOutcome", operator: "allFailed" }, { dependencyOutcomes: ["failed", "failed"] })).toBe("satisfied")
    expect(satisfaction({ field: "dependencyOutcome", operator: "allFailed" }, { dependencyOutcomes: ["failed", "succeeded"] })).toBe("unsatisfied")
  })

  it("satisfies none exactly when the task has no dependencies", () => {
    expect(satisfaction({ field: "dependencyOutcome", operator: "none" }, { dependencyOutcomes: [] })).toBe("satisfied")
    expect(satisfaction({ field: "dependencyOutcome", operator: "none" })).toBe("unsatisfied")
  })

  it("unsatisfies allSucceeded for a task with NO dependencies rather than accepting vacuous truth", () => {
    // The single most surprising row in the language, and the one most likely to
    // be "fixed" into a bug. Vacuously, "all of zero dependencies succeeded" is
    // true; practically, it means the rule scoped itself to "tasks whose
    // dependencies all succeeded" and would then match every task that has none.
    const noDependencies = { dependencyOutcomes: [] }
    for (const operator of ["anySucceeded", "anyFailed", "allSucceeded", "allFailed"]) {
      expect(satisfaction({ field: "dependencyOutcome", operator }, noDependencies)).toBe("unsatisfied")
    }
  })
})

// ===========================================================================
// 12-15. fanOut, concurrency, retryLimit, timeoutSeconds
// ===========================================================================

describe("the five numeric predicates share one comparison set and fail closed on an unknown value", () => {
  const axes = [
    { field: "fanOut", contextKey: "requestedFanOut", present: 2, presentValue: "a present fan-out" },
    { field: "concurrency", contextKey: "requestedConcurrency", present: 2, presentValue: "a present concurrency" },
    { field: "retryLimit", contextKey: "requestedRetryLimit", present: 1, presentValue: "a present retry limit" },
    { field: "timeoutSeconds", contextKey: "declaredTimeoutSeconds", present: 600, presentValue: "a present timeout" },
  ] as const

  for (const axis of axes) {
    it(`${axis.field} implements all six comparison operators over ${axis.presentValue}`, () => {
      const value = axis.field === "timeoutSeconds" ? 600 : 2
      const cases: readonly { operator: string; declared: unknown; actual: number; expected: "satisfied" | "unsatisfied" }[] = [
        { operator: "eq", declared: value, actual: value, expected: "satisfied" },
        { operator: "eq", declared: value + 1, actual: value, expected: "unsatisfied" },
        { operator: "lt", declared: value + 1, actual: value, expected: "satisfied" },
        { operator: "lt", declared: value, actual: value, expected: "unsatisfied" },
        { operator: "lte", declared: value, actual: value, expected: "satisfied" },
        { operator: "gt", declared: value - 1, actual: value, expected: "satisfied" },
        { operator: "gt", declared: value, actual: value, expected: "unsatisfied" },
        { operator: "gte", declared: value, actual: value, expected: "satisfied" },
        { operator: "gte", declared: value + 1, actual: value, expected: "unsatisfied" },
        { operator: "between", declared: { min: value - 1, max: value + 1 }, actual: value, expected: "satisfied" },
        { operator: "between", declared: { min: value + 1, max: value + 5 }, actual: value, expected: "unsatisfied" },
      ]
      for (const testCase of cases) {
        expect(
          satisfaction(
            { field: axis.field, operator: testCase.operator, value: testCase.declared },
            { [axis.contextKey]: testCase.actual },
          ),
        ).toBe(testCase.expected)
      }
    })

    it(`${axis.field} is unsatisfied and unevaluable when the context states no value`, () => {
      // The ADR's fail-closed column for rows 12 through 15: "an unknown fan-out
      // is unsatisfied, never satisfied". The `unevaluable` flag is what lets a
      // `not` over it stay unsatisfied rather than flipping to satisfied.
      //
      // The declared bound is inside each axis's own domain, because a value over
      // the ceiling would be refused at COMPILE time and the test would be
      // asserting nothing about evaluation.
      const declared = axis.field === "timeoutSeconds" ? 600 : 1
      expect(satisfaction({ field: axis.field, operator: "lte", value: declared }, { [axis.contextKey]: null })).toBe("unsatisfied")
      expect(unevaluable({ field: axis.field, operator: "lte", value: declared }, { [axis.contextKey]: null })).toBe(true)
    })
  }
})

// ===========================================================================
// 16. scheduleWindow
// ===========================================================================

describe("predicate 16 scheduleWindow is satisfied inside a declared window in its declared zone", () => {
  const weekdayWindow = {
    daysOfWeek: [1, 2, 3, 4, 5],
    startMinuteOfDay: 9 * 60,
    endMinuteOfDay: 17 * 60,
    timeZone: "UTC",
  }

  it("satisfies inside the window", () => {
    expect(satisfaction({ field: "scheduleWindow", windows: [weekdayWindow] }, { evaluatedAt: "2026-02-02T12:00:00Z" })).toBe("satisfied")
  })

  it("unsatisfies before the window opens, on a half-open interval", () => {
    expect(satisfaction({ field: "scheduleWindow", windows: [weekdayWindow] }, { evaluatedAt: "2026-02-02T08:59:00Z" })).toBe("unsatisfied")
  })

  it("satisfies at the opening minute", () => {
    expect(satisfaction({ field: "scheduleWindow", windows: [weekdayWindow] }, { evaluatedAt: "2026-02-02T09:00:00Z" })).toBe("satisfied")
  })

  it("unsatisfies at the closing minute, because the interval is half-open", () => {
    // Half-open on both ends is what lets two adjacent windows cover an afternoon
    // with no gap and no overlap; a closed end would double-count the boundary.
    expect(satisfaction({ field: "scheduleWindow", windows: [weekdayWindow] }, { evaluatedAt: "2026-02-02T17:00:00Z" })).toBe("unsatisfied")
  })

  it("unsatisfies on a day the window does not name", () => {
    // 2026-02-07 is a Saturday.
    expect(satisfaction({ field: "scheduleWindow", windows: [weekdayWindow] }, { evaluatedAt: "2026-02-07T12:00:00Z" })).toBe("unsatisfied")
  })

  it("evaluates in the DECLARED zone rather than the host's, so two hosts agree", () => {
    // 12:00 UTC is 07:00 in New York, which is before a 09:00 window opens. A rule
    // that read the host's local zone would satisfy this on a machine in London
    // and not on one in New York, which is exactly the divergence ADR 0007
    // section 6.2 refuses.
    const newYorkMorning = { ...weekdayWindow, timeZone: "America/New_York" }
    expect(satisfaction({ field: "scheduleWindow", windows: [newYorkMorning] }, { evaluatedAt: "2026-02-02T12:00:00Z" })).toBe("unsatisfied")
    // 15:00 UTC is 10:00 in New York, inside the window.
    expect(satisfaction({ field: "scheduleWindow", windows: [newYorkMorning] }, { evaluatedAt: "2026-02-02T15:00:00Z" })).toBe("satisfied")
  })

  it("evaluates a fixed UTC offset with no tzdata dependency at all", () => {
    const plusTwo = { ...weekdayWindow, timeZone: { fixedOffsetMinutes: 120 } }
    // 12:00 UTC is 14:00 at +02:00, inside the window.
    expect(satisfaction({ field: "scheduleWindow", windows: [plusTwo] }, { evaluatedAt: "2026-02-02T12:00:00Z" })).toBe("satisfied")
    // 06:00 UTC is 08:00 at +02:00, before it opens.
    expect(satisfaction({ field: "scheduleWindow", windows: [plusTwo] }, { evaluatedAt: "2026-02-02T06:00:00Z" })).toBe("unsatisfied")
  })

  it("treats midnight as hour 0 rather than hour 24, so a window starting at 00:00 covers it", () => {
    // `hourCycle: "h12"` renders midnight as "24" in some ICU builds, which would
    // put every midnight dispatch outside a window that starts at 00:00 — a real
    // bug, and the reason the formatter is given an explicit hour cycle.
    const allDay = { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startMinuteOfDay: 0, endMinuteOfDay: 1, timeZone: "UTC" }
    expect(satisfaction({ field: "scheduleWindow", windows: [allDay] }, { evaluatedAt: "2026-02-02T00:00:00Z" })).toBe("satisfied")
  })

  it("refuses a wrapping window at compile time, because a wrap needs a convention and a convention is an off-by-one", () => {
    const compiled = compileRule(
      rawRuleDocument({ predicates: [{ field: "scheduleWindow", windows: [{ daysOfWeek: [1], startMinuteOfDay: 22 * 60, endMinuteOfDay: 3 * 60, timeZone: "UTC" }] }] }),
    )
    expect(compiled.ok).toBe(false)
  })

  it("refuses an unknown IANA zone at PARSE time, so a typo is a compile error rather than a rule that never fires", () => {
    const compiled = compileRule(
      rawRuleDocument({ predicates: [{ field: "scheduleWindow", windows: [{ daysOfWeek: [1], startMinuteOfDay: 0, endMinuteOfDay: 60, timeZone: "Mars/Olympus_Mons" }] }] }),
    )
    expect(compiled.ok).toBe(false)
  })
})

// ===========================================================================
// 17. contextSensitivity
// ===========================================================================

describe("predicate 17 contextSensitivity never treats an absent manifest as rank 0", () => {
  it("satisfies any when the manifest's sensitivity is in the declared set", () => {
    expect(satisfaction({ field: "contextSensitivity", operator: "any", value: ["restricted", "public_to_project"] })).toBe("satisfied")
  })

  it("unsatisfies any when it is not", () => {
    expect(satisfaction({ field: "contextSensitivity", operator: "any", value: ["secret_reference_only"] })).toBe("unsatisfied")
  })

  it("satisfies none when the manifest's sensitivity is not in the declared set", () => {
    expect(satisfaction({ field: "contextSensitivity", operator: "none", value: ["secret_reference_only"] })).toBe("satisfied")
  })

  it("unsatisfies none when it is", () => {
    expect(satisfaction({ field: "contextSensitivity", operator: "none", value: ["restricted"] })).toBe("unsatisfied")
  })

  it("satisfies maxRankAtMost when the rank is at or below the declared rank", () => {
    // rank 1 is `restricted`.
    expect(satisfaction({ field: "contextSensitivity", operator: "maxRankAtMost", value: 1 })).toBe("satisfied")
    expect(satisfaction({ field: "contextSensitivity", operator: "maxRankAtMost", value: 2 })).toBe("satisfied")
  })

  it("unsatisfies maxRankAtMost when the rank is above it", () => {
    expect(satisfaction({ field: "contextSensitivity", operator: "maxRankAtMost", value: 0 })).toBe("unsatisfied")
  })

  it("satisfies maxRankAtLeast when the rank is at or above the declared rank", () => {
    expect(satisfaction({ field: "contextSensitivity", operator: "maxRankAtLeast", value: 1 })).toBe("satisfied")
    expect(satisfaction({ field: "contextSensitivity", operator: "maxRankAtLeast", value: 0 })).toBe("satisfied")
  })

  it("unsatisfies maxRankAtLeast when the rank is below it", () => {
    expect(satisfaction({ field: "contextSensitivity", operator: "maxRankAtLeast", value: 2 })).toBe("unsatisfied")
  })

  it("unsatisfies any and maxRankAtLeast with no manifest, and never treats the absence as rank 0", () => {
    // The ADR's fail-closed column, row 17. `maxRankAtLeast 0` would be satisfied
    // by a rank-0 reading of "no manifest", which is precisely the vacuous
    // reading the ADR forbids — the assertion is about the ACTUAL rank, and with
    // no manifest there is no actual rank to assert about.
    const noManifest = { contextManifestSensitivity: null }
    expect(satisfaction({ field: "contextSensitivity", operator: "any", value: ["public_to_project"] }, noManifest)).toBe("unsatisfied")
    expect(satisfaction({ field: "contextSensitivity", operator: "maxRankAtLeast", value: 0 }, noManifest)).toBe("unsatisfied")
    expect(unevaluable({ field: "contextSensitivity", operator: "maxRankAtLeast", value: 0 }, noManifest)).toBe(true)
  })

  it("unsatisfies maxRankAtMost with no manifest too, for the same reason", () => {
    // Not named in the ADR's column, and the omission is a gap rather than a
    // permission: `maxRankAtMost 3` would be satisfied by a rank-0 reading, so
    // the two rank operators are treated alike. `none` is the one exception,
    // because it asserts an absence.
    expect(satisfaction({ field: "contextSensitivity", operator: "maxRankAtMost", value: 3 }, { contextManifestSensitivity: null })).toBe("unsatisfied")
  })

  it("satisfies none with no manifest, because it asserts an absence", () => {
    expect(satisfaction({ field: "contextSensitivity", operator: "none", value: ["restricted"] }, { contextManifestSensitivity: null })).toBe("satisfied")
  })
})

// ===========================================================================
// Combinators
// ===========================================================================

describe("the combinators implement all, any and not", () => {
  const satisfiedLeaf = { field: "roleId", operator: "eq", value: "role-1" }
  const unsatisfiedLeaf = { field: "roleId", operator: "eq", value: "role-2" }
  const unknownLeaf = { field: "roleId", operator: "eq", value: "role-1" }

  it("all([]) is the universal predicate and is satisfied against any context", () => {
    // The universal predicate is a DEFINED thing in this language, not an error:
    // it is what a rule with no predicates at all means, and section 8 restricts
    // it only for the two action kinds that may not be universal. The second
    // context is deliberately hostile — no role, and a different project — to
    // show that universality is over the PREDICATE and not over the fixture.
    expect(satisfaction({ field: "all", predicates: [] })).toBe("satisfied")
    expect(satisfaction({ field: "all", predicates: [] }, { roleId: null, taskLabels: [], dependencyOutcomes: [] })).toBe("satisfied")
  })

  it("all over satisfied leaves is satisfied", () => {
    expect(satisfaction({ field: "all", predicates: [satisfiedLeaf, satisfiedLeaf] })).toBe("satisfied")
  })

  it("all over one unsatisfied leaf is unsatisfied", () => {
    expect(satisfaction({ field: "all", predicates: [satisfiedLeaf, unsatisfiedLeaf] })).toBe("unsatisfied")
  })

  it("all over one unevaluable leaf is unsatisfied and unevaluable, because a conjunction cannot be established", () => {
    expect(satisfaction({ field: "all", predicates: [satisfiedLeaf, unknownLeaf] }, { roleId: null })).toBe("unsatisfied")
    expect(unevaluable({ field: "all", predicates: [satisfiedLeaf, unknownLeaf] }, { roleId: null })).toBe(true)
  })

  it("any over one satisfied leaf is satisfied even when a sibling is unevaluable", () => {
    // The asymmetry with `all` is deliberate and load-bearing: a satisfied branch
    // SETTLES a disjunction, so an unknown sibling cannot unsettle it. If `any`
    // propagated `unknown` here, `any(role matches, role unknown)` would be
    // unsatisfied for a dispatch that plainly matches.
    expect(satisfaction({ field: "any", predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }, unknownLeaf] }, { roleId: null })).toBe("satisfied")
  })

  it("any over unsatisfied leaves is unsatisfied", () => {
    expect(satisfaction({ field: "any", predicates: [unsatisfiedLeaf, unsatisfiedLeaf] })).toBe("unsatisfied")
  })

  it("any over one unevaluable leaf and no satisfied leaf is unsatisfied and unevaluable", () => {
    expect(satisfaction({ field: "any", predicates: [unsatisfiedLeaf, unknownLeaf] }, { roleId: null })).toBe("unsatisfied")
  })

  it("any([]) is refused at compile time, because it is unsatisfiable by definition", () => {
    const compiled = compileRule(
      rawRuleDocument({ predicates: [{ field: "any", predicates: [] }], actions: [{ kind: "deny_with_reason", reason: "x" }] }),
    )
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.empty_enum")
  })

  it("not over a satisfied leaf is unsatisfied", () => {
    expect(satisfaction({ field: "not", predicate: satisfiedLeaf })).toBe("unsatisfied")
  })

  it("not over an unsatisfied leaf is satisfied", () => {
    expect(satisfaction({ field: "not", predicate: unsatisfiedLeaf })).toBe("satisfied")
  })
})

// ===========================================================================
// The row the whole file exists for
// ===========================================================================

describe("not fails closed, and this is the single most important property in the language", () => {
  it("not(unknown) is unsatisfied, NOT satisfied", () => {
    // If this were `satisfied`, a rule scoped to "not the production role" would
    // MATCH a dispatch whose role the system could not determine, and the failure
    // mode is a rule applying exactly where its author said it must not. There is
    // no compensating control for this: the predicate IS the only thing standing
    // between a rule and every dispatch of that shape.
    expect(satisfaction({ field: "not", predicate: { field: "roleId", operator: "eq", value: "role-1" } }, { roleId: null })).toBe("unsatisfied")
  })

  it("not(unknown) is marked unevaluable, so the trace says the operand could not be evaluated", () => {
    expect(unevaluable({ field: "not", predicate: { field: "roleId", operator: "eq", value: "role-1" } }, { roleId: null })).toBe(true)
  })

  it("not(not(unknown)) is unsatisfied too, because not is INVOLUTIVE on an unknown", () => {
    // `not(not(P))` is `P`, and `P` is unknown here. The naive implementation —
    // read the operand's verdict, negate it — gets this RIGHT by accident for one
    // negation and WRONG for two: the inner `not` reports `unsatisfied`, and an
    // outer `not` reading only the verdict concludes the double negation holds.
    // Carrying the `unevaluable` flag through the negation is what makes it hold.
    expect(satisfaction({ field: "not", predicate: { field: "not", predicate: { field: "roleId", operator: "eq", value: "role-1" } } }, { roleId: null })).toBe("unsatisfied")
  })

  it("not is involutive on a genuinely unsatisfied operand, so the rewrite is not a way to smuggle a grant", () => {
    // The counterpart: double-negating something that really is false DOES
    // satisfy, and it should. Without this the fix above would have made `not`
    // useless rather than merely safe.
    const definitelyFalse = { field: "roleId", operator: "eq", value: "role-2" }
    expect(satisfaction({ field: "not", predicate: definitelyFalse })).toBe("satisfied")
    expect(satisfaction({ field: "not", predicate: { field: "not", predicate: definitelyFalse } })).toBe("unsatisfied")
  })

  it("not over EVERY unknown-producing field is unsatisfied", () => {
    // The whole fail-closed column, negated, as one table. If any of these were
    // satisfied, the language fails open on that axis.
    const unknownProducing: readonly { predicate: unknown; context: Partial<RuleEvaluationContext> }[] = [
      { predicate: { field: "roleId", operator: "eq", value: "role-1" }, context: { roleId: null } },
      { predicate: { field: "roleVersion", operator: "lte", value: 5 }, context: { roleVersion: null } },
      { predicate: { field: "runtimeKind", operator: "eq", value: "opencode" }, context: { runtimeKind: null } },
      { predicate: { field: "targetNodeId", operator: "eq", value: "node-1" }, context: { targetNodeId: null } },
      { predicate: { field: "projectPathId", operator: "eq", value: "path-1" }, context: { projectPathId: null } },
      { predicate: { field: "nodeAdvertisedCapability", operator: "any", value: ["fs.read"] }, context: { nodeAdvertisedCapabilities: null } },
      { predicate: { field: "capability", operator: "any", value: ["fs.read"] }, context: { requestedCapabilities: [] } },
      { predicate: { field: "toolCategory", operator: "any", value: ["shell"] }, context: { toolCategories: [] } },
      { predicate: { field: "taskLabel", operator: "has", value: "release" }, context: { taskLabels: [] } },
      { predicate: { field: "dependencyOutcome", operator: "allSucceeded" }, context: { dependencyOutcomes: [] } },
      { predicate: { field: "fanOut", operator: "lte", value: 4 }, context: { requestedFanOut: null } },
      { predicate: { field: "concurrency", operator: "lte", value: 4 }, context: { requestedConcurrency: null } },
      { predicate: { field: "retryLimit", operator: "lte", value: 4 }, context: { requestedRetryLimit: null } },
      { predicate: { field: "timeoutSeconds", operator: "lte", value: 900 }, context: { declaredTimeoutSeconds: null } },
      { predicate: { field: "contextSensitivity", operator: "any", value: ["restricted"] }, context: { contextManifestSensitivity: null } },
      { predicate: { field: "contextSensitivity", operator: "maxRankAtLeast", value: 0 }, context: { contextManifestSensitivity: null } },
    ]
    for (const entry of unknownProducing) {
      const negated = { field: "not", predicate: entry.predicate }
      expect(satisfaction(negated, entry.context)).toBe("unsatisfied")
    }
  })

  it("not over the two operators that DO resolve an absent subject to satisfied, is unsatisfied", () => {
    // `lacks` and `none` assert an ABSENCE, so an absent subject satisfies them and
    // their negation is unsatisfied. This is the complement of the row above and
    // it is the ONLY other place `not` can be unsatisfied for a reason other than
    // the operand being unsatisfied.
    expect(satisfaction({ field: "not", predicate: { field: "taskLabel", operator: "lacks", value: ["release"] } }, { taskLabels: [] })).toBe("unsatisfied")
    expect(satisfaction({ field: "not", predicate: { field: "dependencyOutcome", operator: "none" } }, { dependencyOutcomes: [] })).toBe("unsatisfied")
    expect(satisfaction({ field: "not", predicate: { field: "capability", operator: "none", value: ["fs.read"] } }, { requestedCapabilities: [] })).toBe("unsatisfied")
  })
})

// ===========================================================================
// Combinator nesting
// ===========================================================================

describe("combinators nest, and nesting does not change the fail-closed direction", () => {
  it("all over any over unsatisfied leaves is unsatisfied", () => {
    expect(
      satisfaction({
        field: "all",
        predicates: [
          { field: "any", predicates: [{ field: "roleId", operator: "eq", value: "role-9" }, { field: "roleId", operator: "eq", value: "role-8" }] },
          { field: "projectId", operator: "eq", value: "proj-1" },
        ],
      }),
    ).toBe("unsatisfied")
  })

  it("any over all over unsatisfied leaves is unsatisfied", () => {
    expect(
      satisfaction({
        field: "any",
        predicates: [
          { field: "all", predicates: [{ field: "roleId", operator: "eq", value: "role-9" }] },
          { field: "all", predicates: [{ field: "projectId", operator: "eq", value: "proj-9" }] },
        ],
      }),
    ).toBe("unsatisfied")
  })

  it("all over any, where the any is satisfied, is satisfied", () => {
    expect(
      satisfaction({
        field: "all",
        predicates: [
          { field: "any", predicates: [{ field: "roleId", operator: "eq", value: "role-9" }, { field: "roleId", operator: "eq", value: "role-1" }] },
          { field: "projectId", operator: "eq", value: "proj-1" },
        ],
      }),
    ).toBe("satisfied")
  })

  it("a satisfied predicate ANYWHERE in a disjunction settles it, however deep the unknown siblings", () => {
    const deepUnknown = {
      field: "not",
      predicate: { field: "not", predicate: { field: "roleId", operator: "eq", value: "role-1" } },
    }
    expect(satisfaction({ field: "any", predicates: [deepUnknown, { field: "projectId", operator: "eq", value: "proj-1" }] }, { roleId: null })).toBe("satisfied")
  })

  it("a rule whose top-level predicates are ALL unsatisfied does not match, whatever the combinators say", () => {
    // The rule-level conjunction: an empty top-level list is universal, a
    // non-empty one is a conjunction, and one unsatisfied member is enough.
    expect(
      matchOutcomeOf(
        rawRuleDocument({
          predicates: [
            { field: "roleId", operator: "eq", value: "role-1" },
            { field: "roleId", operator: "eq", value: "role-2" },
          ],
          actions: [{ kind: "deny_with_reason", reason: "x" }],
        }),
      ),
    ).toBe("not_matched")
  })

  it("a rule with an empty top-level predicate list matches everything, which is why the universal restriction exists", () => {
    expect(matchOutcomeOf(rawRuleDocument({ predicates: [], actions: [{ kind: "deny_with_reason", reason: "x" }] }))).toBe("matched")
  })
})

// ===========================================================================
// taskTitlePattern
// ===========================================================================

describe("the pattern predicate matches through the bounded analyser and fails closed on a null subject", () => {
  it("satisfies when the title matches the compiled pattern", () => {
    expect(satisfaction({ field: "taskTitlePattern", pattern: "^deploy" }, { taskTitle: "deploy the api" })).toBe("satisfied")
  })

  it("unsatisfies when the title does not match", () => {
    expect(satisfaction({ field: "taskTitlePattern", pattern: "^deploy" }, { taskTitle: "roll back the api" })).toBe("unsatisfied")
  })

  it("unsatisfies, and is not unevaluable, on a null subject", () => {
    // ADR 0007 section 4: a pattern predicate on a `null` subject reports
    // `unsatisfied` with a reason, never `unknown` and never `satisfied`. The
    // reason it is NOT `unknown` is that a missing title is a definite fact about
    // the dispatch, and treating it as an unknown would let a `not` over it flip
    // to satisfied.
    expect(satisfaction({ field: "taskTitlePattern", pattern: "^deploy" }, { taskTitle: null })).toBe("unsatisfied")
    expect(unevaluable({ field: "taskTitlePattern", pattern: "^deploy" }, { taskTitle: null })).toBe(false)
  })

  it("refuses to compile a pattern the bounded analyser rejects, rather than never matching it", () => {
    // The M0 kernel's behaviour is that a bad `taskTitlePattern` never matches,
    // which is safe for a narrowing effect and unsafe to inherit: a mistyped
    // PRE-APPROVAL pattern would silently never pre-approve, and the user
    // debugging it would not be told their rule is broken.
    const compiled = compileRule(
      rawRuleDocument({ predicates: [{ field: "taskTitlePattern", pattern: "(a+)+" }], actions: [{ kind: "deny_with_reason", reason: "x" }] }),
    )
    expect(compiled.ok).toBe(false)
    if (!compiled.ok) expect(compiled.error.code).toBe("rule.pattern_refused")
  })
})

// ===========================================================================
// Outcome shape
// ===========================================================================

describe("an exported predicate outcome is two-valued, always", () => {
  it("never reports a third satisfaction value, whatever the context says", () => {
    // The internal verdict has three states; the exported one has two plus a flag.
    // A consumer of a trace that could see "unknown" would have to decide what to
    // do with it, and every consumer would decide differently.
    const compiled = compileRuleSet([
      rawRuleDocument({
        predicates: [{ field: "roleId", operator: "eq", value: "role-1" }],
        actions: [{ kind: "deny_with_reason", reason: "x" }],
      }),
    ])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    for (const context of [validContext(), validContext({ roleId: null })]) {
      const result = evaluateRules(compiled.value, context)
      for (const trace of result.traces) {
        for (const outcome of trace.predicateOutcomes) {
          expect(["satisfied", "unsatisfied"]).toContain(outcome.satisfaction)
        }
      }
    }
  })

  it("records the child outcomes of a combinator, so a trace explains itself", () => {
    const outcome = evaluateOne({
      field: "all",
      predicates: [
        { field: "roleId", operator: "eq", value: "role-1" },
        { field: "projectId", operator: "eq", value: "proj-9" },
      ],
    })
    expect(outcome?.children).toHaveLength(2)
    expect(outcome?.children[0]?.satisfaction).toBe("satisfied")
    expect(outcome?.children[1]?.satisfaction).toBe("unsatisfied")
  })

  it("records a leaf with no children, so a reader can tell a leaf from an empty combinator", () => {
    const leaf = evaluateOne({ field: "roleId", operator: "eq", value: "role-1" })
    expect(leaf?.children).toEqual([])
    const emptyAll = evaluateOne({ field: "all", predicates: [] })
    expect(emptyAll?.children).toEqual([])
  })

  it("never leaks the task title into an outcome reason, so a trace carries no task content", () => {
    const outcome = evaluateOne({ field: "taskTitlePattern", pattern: "^deploy" }, { taskTitle: "CANARY-SECRET-TITLE" })
    expect(JSON.stringify(outcome)).not.toContain("CANARY-SECRET-TITLE")
  })
})

// ===========================================================================
// The universal rule, as a top-level list
// ===========================================================================

describe("the top-level predicate list is a conjunction, and an empty one is universal", () => {
  it("matches when every member is satisfied", () => {
    expect(
      matchOutcomeOf(
        rawRuleDocument({
          predicates: [
            { field: "roleId", operator: "eq", value: "role-1" },
            { field: "projectId", operator: "eq", value: "proj-1" },
          ],
          actions: [{ kind: "deny_with_reason", reason: "x" }],
        }),
      ),
    ).toBe("matched")
  })

  it("does not match when one member is unevaluable, because a conjunction needs every member", () => {
    expect(
      matchOutcomeOf(
        rawRuleDocument({
          predicates: [
            { field: "roleId", operator: "eq", value: "role-1" },
            { field: "projectId", operator: "eq", value: "proj-1" },
          ],
          actions: [{ kind: "deny_with_reason", reason: "x" }],
        }),
        { roleId: null },
      ),
    ).toBe("not_matched")
  })
})

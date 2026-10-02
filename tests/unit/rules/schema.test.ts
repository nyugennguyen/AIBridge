/**
 * The schema: what a rule document may say, and — more importantly — what it may
 * not.
 *
 * Two halves, and the second is the one that matters:
 *
 *   1. ACCEPTANCE. Every valid shape parses. A schema that refuses a legal
 *      document is a schema that makes the language unusable, and the failure
 *      mode is quiet — a user works around it by writing something the schema
 *      accepts and the language does not mean.
 *
 *   2. REFUSAL, and specifically the UNREPRESENTABLE. `allowDestructiveEffects`
 *      and `allowExternalEffects` are `z.literal(false)`. The tests below assert
 *      that a document asking for `true` is refused, which means the escalation
 *      cannot be expressed at all — so the refusal path is never reached by a
 *      schema-valid document and the test asserts an ABSENCE rather than
 *      asserting a branch's handling. That is the difference between "we check
 *      for this" and "this cannot be written", and it is the whole point of
 *      ADR 0007 section 7.3.
 *
 * The hand-written / inferred split in `RulePredicate` is asserted here too: the
 * eighteen field arms are `z.infer` of their schemas and the three combinator
 * arms are written out (a `z.infer` of a recursive schema is a circular type
 * alias and TypeScript rejects it). A drift between the schema and the type
 * would compile on one side and fail on the other, so both directions are
 * checked here.
 */

import { describe, expect, it } from "vitest"
import {
  IANA_TIME_ZONES,
  NON_UNIVERSAL_PREDICATE_FIELDS,
  RULE_ACTION_KIND_RANK,
  RULE_PREDICATE_FIELDS,
  SENSITIVITY_BY_RANK,
  actionKindRank,
  compareRuleActionKindsByRank,
  isCombinatorPredicate,
  ruleActionSchema,
  ruleEvaluationContextSchema,
  ruleLanguageVersion,
  rulePredicateSchema,
  ruleSourceDocumentSchema,
  scheduleWindowSchema,
  walkPredicates,
  type RuleAction,
  type RuleActionKind,
  type RulePredicate,
} from "../../../src/rules/index.js"
import { SENSITIVITY_LEVELS, SENSITIVITY_RANK } from "../../../src/memory/ontology.js"
import { preApprovalDocument, rawPreApprovalDocument, rawRuleDocument, validContext, validRuleDocument } from "./fixtures.js"

// ===========================================================================
// The language version
// ===========================================================================

describe("the rule language is separately versioned at 2", () => {
  it("states version 2, distinct from the frozen M0 record version", () => {
    // The M0 `schemaVersion` is 1 and is behind a signed attestation. The rule
    // language is version 2 and is not, which is the whole reason it exists as a
    // separate contract rather than as a widened `ruleSchema`.
    expect(ruleLanguageVersion).toBe(2)
    expect(ruleSourceDocumentSchema.parse(validRuleDocument()).languageVersion).toBe(2)
  })
})

// ===========================================================================
// Acceptance
// ===========================================================================

describe("every legal rule document shape parses", () => {
  it("accepts the minimal document", () => {
    expect(ruleSourceDocumentSchema.safeParse(validRuleDocument()).success).toBe(true)
  })

  it("accepts each of the four activation states", () => {
    const states: readonly Record<string, unknown>[] = [
      { state: "draft", activatedAt: null, activatedBy: null },
      { state: "activated", activatedAt: "2026-01-01T00:00:00Z", activatedBy: { kind: "user", userId: "user-1" } },
      { state: "expired", activatedAt: null, activatedBy: null },
      { state: "revoked", activatedAt: "2026-01-01T00:00:00Z", activatedBy: { kind: "user", userId: "user-1" } },
    ]
    for (const activation of states) {
      expect(ruleSourceDocumentSchema.safeParse(rawRuleDocument({ activation })).success).toBe(true)
    }
  })

  it("accepts an activated rule whose actor is a node, a session, or the system", () => {
    // `actor` is the kernel's own four-way actor union, reused rather than
    // restated: a second actor vocabulary in this module would be a second thing
    // that can drift from the one the audit record already uses.
    const actors: readonly Record<string, unknown>[] = [
      { kind: "user", userId: "user-1" },
      { kind: "node", nodeId: "node-1" },
      { kind: "session", sessionId: "session-1" },
      { kind: "system", name: "seed" },
    ]
    for (const actor of actors) {
      expect(
        ruleSourceDocumentSchema.safeParse(
          rawRuleDocument({ activation: { state: "activated", activatedAt: "2026-01-01T00:00:00Z", activatedBy: actor } }),
        ).success,
      ).toBe(true)
    }
  })

  it("accepts every action kind, with a body each kind requires", () => {
    const actions: readonly RuleAction[] = [
      { kind: "deny_with_reason", reason: "because" },
      { kind: "require_approval", requireApprovalForDispatch: true },
      { kind: "require_approval", requireApprovalForCapabilities: ["fs.read"] },
      { kind: "require_approval", requireApprovalForDestructiveEffects: true },
      { kind: "add_restrictions", deniedCapabilities: ["fs.write"] },
      { kind: "add_restrictions", allowedCapabilities: ["fs.read"] },
      { kind: "add_restrictions", maximumTimeoutSeconds: 600 },
      { kind: "add_restrictions", allowDestructiveEffects: false },
      { kind: "set_stricter_budget", budget: { maximumFanOut: 4 } },
      { kind: "set_stricter_budget", budget: { usageUnit: "tokens", maximumUsageUnits: 1000 } },
      { kind: "select_routing_preference", preference: { preferredNodeIds: ["node-1"] } },
      { kind: "select_routing_preference", preference: { requiredRuntimeKind: "opencode" } },
      {
        kind: "pre_approve_within_bounds",
        approvedCapabilities: ["fs.read"],
        maximumTimeoutSeconds: 900,
        allowDestructiveEffects: false,
        allowExternalEffects: false,
        maximumSensitivity: "restricted",
      },
    ]
    for (const action of actions) {
      expect(ruleActionSchema.safeParse(action).success).toBe(true)
    }
  })

  it("accepts every one of the eighteen predicate fields, at its minimum shape", () => {
    const leaves: readonly unknown[] = [
      { field: "projectId", operator: "eq", value: "proj-1" },
      { field: "roleId", operator: "in", value: ["role-1"] },
      { field: "roleVersion", operator: "between", value: { min: 1, max: 3 } },
      { field: "capability", operator: "none", value: ["fs.write"] },
      { field: "toolCategory", operator: "any", value: ["shell"] },
      { field: "runtimeKind", operator: "eq", value: "opencode" },
      { field: "targetNodeId", operator: "eq", value: "node-1" },
      { field: "nodeAdvertisedCapability", operator: "all", value: ["fs.read"] },
      { field: "projectPathId", operator: "eq", value: "path-1" },
      { field: "taskLabel", operator: "has", value: "release" },
      { field: "taskLabel", operator: "hasAll", value: ["release", "urgent"] },
      { field: "dependencyOutcome", operator: "anyFailed" },
      { field: "fanOut", operator: "lte", value: 4 },
      { field: "concurrency", operator: "between", value: { min: 1, max: 8 } },
      { field: "retryLimit", operator: "eq", value: 1 },
      { field: "timeoutSeconds", operator: "lte", value: 900 },
      { field: "scheduleWindow", windows: [{ daysOfWeek: [1], startMinuteOfDay: 540, endMinuteOfDay: 1020, timeZone: "UTC" }] },
      { field: "contextSensitivity", operator: "maxRankAtMost", value: 1 },
      { field: "contextSensitivity", operator: "any", value: ["restricted"] },
      { field: "taskTitlePattern", pattern: "^deploy" },
    ]
    // Twenty leaves for eighteen fields: `taskLabel` and `contextSensitivity`
    // each appear twice because they have two value shapes (scalar-or-list, and
    // rank-or-names) and both shapes are legal.
    expect(leaves).toHaveLength(RULE_PREDICATE_FIELDS.length + 2)
    for (const leaf of leaves) {
      expect(rulePredicateSchema.safeParse(leaf).success).toBe(true)
    }
  })

  it("accepts the three combinators, including all([]) and not(all([]))", () => {
    const combinators: readonly unknown[] = [
      { field: "all", predicates: [] },
      { field: "any", predicates: [{ field: "roleId", operator: "eq", value: "role-1" }] },
      { field: "not", predicate: { field: "roleId", operator: "eq", value: "role-1" } },
    ]
    for (const combinator of combinators) {
      expect(rulePredicateSchema.safeParse(combinator).success).toBe(true)
    }
  })

  it("accepts a note of zero length, because the ADR says 0 to 512", () => {
    expect(rulePredicateSchema.safeParse({ field: "roleId", operator: "eq", value: "role-1", note: "" }).success).toBe(true)
  })

  it("accepts an expiry in the past, because an expired rule is a legitimate authored state", () => {
    expect(ruleSourceDocumentSchema.safeParse(rawRuleDocument({ expiresAt: "2020-01-01T00:00:00Z" })).success).toBe(true)
  })
})

// ===========================================================================
// Refusal
// ===========================================================================

describe("every illegal shape is refused with a named reason", () => {
  it("refuses a document that is not an object", () => {
    for (const value of [null, undefined, 42, "a rule", true, [], [{ field: "all", predicates: [] }]]) {
      expect(ruleSourceDocumentSchema.safeParse(value).success).toBe(false)
    }
  })

  it("refuses an unknown top-level key, because a dropped field is a silent change of meaning", () => {
    const parsed = ruleSourceDocumentSchema.safeParse(rawRuleDocument({ defaultAction: { kind: "allow" } }))
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true)
    }
  })

  it("refuses a missing required key", () => {
    for (const key of ["ruleId", "templateVersion", "projectId", "name", "description", "enabled", "activation", "predicates", "actions", "author", "createdAt"]) {
      const document = rawRuleDocument()
      delete document[key]
      expect(ruleSourceDocumentSchema.safeParse(document).success).toBe(false)
    }
  })

  it("refuses a name with surrounding whitespace, because a trimmed name is a name the author did not type", () => {
    expect(ruleSourceDocumentSchema.safeParse(rawRuleDocument({ name: " deny " })).success).toBe(false)
  })

  it("refuses an unknown predicate field", () => {
    expect(rulePredicateSchema.safeParse({ field: "promptContains", operator: "eq", value: "secret" }).success).toBe(false)
  })

  it("refuses an unknown operator on a known field", () => {
    // Each field carries its own operator set, so `contains` on `capability` and
    // `regex` on `projectId` are both refused rather than being coerced to
    // something the field does mean.
    expect(rulePredicateSchema.safeParse({ field: "capability", operator: "contains", value: ["x"] }).success).toBe(false)
    expect(rulePredicateSchema.safeParse({ field: "projectId", operator: "regex", value: "x" }).success).toBe(false)
    expect(rulePredicateSchema.safeParse({ field: "taskLabel", operator: "any", value: ["x"] }).success).toBe(false)
  })

  it("refuses an operator whose value shape does not match it", () => {
    // `in` needs a list and `eq` needs a scalar. Without the binding refine, a
    // `z.union` would accept `eq ["a","b"]` and the evaluator would compare a
    // number to an array.
    expect(rulePredicateSchema.safeParse({ field: "projectId", operator: "in", value: "proj-1" }).success).toBe(false)
    expect(rulePredicateSchema.safeParse({ field: "projectId", operator: "eq", value: ["proj-1"] }).success).toBe(false)
    expect(rulePredicateSchema.safeParse({ field: "taskLabel", operator: "has", value: ["a"] }).success).toBe(false)
    expect(rulePredicateSchema.safeParse({ field: "taskLabel", operator: "hasAny", value: "a" }).success).toBe(false)
  })

  it("refuses `between` with a scalar and a comparison with a range", () => {
    expect(rulePredicateSchema.safeParse({ field: "fanOut", operator: "between", value: 4 }).success).toBe(false)
    expect(rulePredicateSchema.safeParse({ field: "fanOut", operator: "lte", value: { min: 1, max: 4 } }).success).toBe(false)
  })

  it("refuses a rank where a name list is required, and a name list where a rank is required", () => {
    expect(rulePredicateSchema.safeParse({ field: "contextSensitivity", operator: "maxRankAtMost", value: ["restricted"] }).success).toBe(false)
    expect(rulePredicateSchema.safeParse({ field: "contextSensitivity", operator: "any", value: 1 }).success).toBe(false)
  })

  it("refuses an unknown sensitivity name", () => {
    expect(rulePredicateSchema.safeParse({ field: "contextSensitivity", operator: "any", value: ["top_secret"] }).success).toBe(false)
  })

  it("refuses an unknown dependency outcome operator", () => {
    expect(rulePredicateSchema.safeParse({ field: "dependencyOutcome", operator: "anyTimedOut" }).success).toBe(false)
  })

  it("refuses a `dependencyOutcome` that carries a value, because the operator already says everything", () => {
    expect(rulePredicateSchema.safeParse({ field: "dependencyOutcome", operator: "anyFailed", value: "task-1" }).success).toBe(false)
  })

  it("refuses a `scheduleWindow` that carries an operator, because it has none", () => {
    expect(rulePredicateSchema.safeParse({ field: "scheduleWindow", operator: "in", windows: [] }).success).toBe(false)
  })

  it("refuses a pattern predicate that carries a `value` key rather than a `pattern` key", () => {
    expect(rulePredicateSchema.safeParse({ field: "taskTitlePattern", value: "^deploy" }).success).toBe(false)
  })

  it("refuses an empty pattern, which would match every title", () => {
    expect(rulePredicateSchema.safeParse({ field: "taskTitlePattern", pattern: "" }).success).toBe(false)
  })

  it("refuses a non-UTC timestamp, because the identifier grammar is RFC 3339 UTC and a local offset is a second thing to convert", () => {
    expect(ruleSourceDocumentSchema.safeParse(rawRuleDocument({ createdAt: "2026-01-01T00:00:00+01:00" })).success).toBe(false)
    expect(ruleSourceDocumentSchema.safeParse(rawRuleDocument({ createdAt: "2026-01-01 00:00:00" })).success).toBe(false)
  })

  it("refuses a templateVersion that is not a positive integer", () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(ruleSourceDocumentSchema.safeParse(rawRuleDocument({ templateVersion: value })).success).toBe(false)
    }
  })
})

// ===========================================================================
// The unrepresentable escalations
// ===========================================================================

describe("the floor-relaxing fields cannot be expressed at all", () => {
  it("refuses allowDestructiveEffects: true on pre_approve_within_bounds", () => {
    // THE central claim of ADR 0007 section 7.7, mechanism 1. A schema-valid
    // document cannot request a destructive-effect pre-approval, so the refusal
    // path is unreachable and this test asserts an ABSENCE.
    const parsed = ruleSourceDocumentSchema.safeParse(
      rawPreApprovalDocument({
        actions: [
          {
            kind: "pre_approve_within_bounds",
            approvedCapabilities: ["fs.read"],
            maximumTimeoutSeconds: 900,
            allowDestructiveEffects: true,
            allowExternalEffects: false,
            maximumSensitivity: "restricted",
          },
        ],
      }),
    )
    expect(parsed.success).toBe(false)
  })

  it("refuses allowExternalEffects: true on pre_approve_within_bounds", () => {
    expect(
      ruleSourceDocumentSchema.safeParse(
        rawPreApprovalDocument({
          actions: [
            {
              kind: "pre_approve_within_bounds",
              approvedCapabilities: ["fs.read"],
              maximumTimeoutSeconds: 900,
              allowDestructiveEffects: false,
              allowExternalEffects: true,
              maximumSensitivity: "restricted",
            },
          ],
        }),
      ).success,
    ).toBe(false)
  })

  it("refuses allowDestructiveEffects: true and allowExternalEffects: true on add_restrictions", () => {
    // The same reasoning in the other action: the field exists so a rule can
    // state "destructive effects stay OFF here" explicitly, and the only legal
    // value is the disabling one.
    for (const field of ["allowDestructiveEffects", "allowExternalEffects"] as const) {
      expect(ruleSourceDocumentSchema.safeParse(rawRuleDocument({ actions: [{ kind: "add_restrictions", [field]: true }] })).success).toBe(false)
    }
  })

  it("refuses the effect flags on every other action, because they are not fields those actions have", () => {
    for (const action of [
      { kind: "deny_with_reason", reason: "x" },
      { kind: "require_approval", requireApprovalForDispatch: true },
      { kind: "set_stricter_budget", budget: { maximumFanOut: 1 } },
      { kind: "select_routing_preference", preference: { preferredNodeIds: ["node-1"] } },
    ]) {
      expect(ruleSourceDocumentSchema.safeParse(rawRuleDocument({ actions: [{ ...action, allowDestructiveEffects: true }] })).success).toBe(false)
    }
  })

  it("accepts the flags at their only legal value, so the restriction is expressible", () => {
    // The other half: a schema that refuses `false` as well would make the
    // restriction unexpressible, and a restriction nobody can write is not a
    // restriction.
    expect(
      ruleSourceDocumentSchema.safeParse(
        rawRuleDocument({ actions: [{ kind: "add_restrictions", allowDestructiveEffects: false, allowExternalEffects: false }] }),
      ).success,
    ).toBe(true)
  })

  it("requires maximumSensitivity on a pre-approval, because the disclosure has to show a sensitivity bound", () => {
    const withoutIt = rawPreApprovalDocument({
      actions: [
        {
          kind: "pre_approve_within_bounds",
          approvedCapabilities: ["fs.read"],
          maximumTimeoutSeconds: 900,
          allowDestructiveEffects: false,
          allowExternalEffects: false,
        },
      ],
    })
    expect(ruleSourceDocumentSchema.safeParse(withoutIt).success).toBe(false)
  })

  it("requires at least one capability to be approved, since approving nothing is not an approval", () => {
    const empty = rawPreApprovalDocument({
      actions: [
        {
          kind: "pre_approve_within_bounds",
          approvedCapabilities: [],
          maximumTimeoutSeconds: 900,
          allowDestructiveEffects: false,
          allowExternalEffects: false,
          maximumSensitivity: "restricted",
        },
      ],
    })
    // Refused by the schema's `min(1)`, which is why the compiler's empty-enum
    // pass does not need to handle this case as well.
    expect(ruleSourceDocumentSchema.safeParse(empty).success).toBe(false)
  })

  it("refuses an action that declares no members at all", () => {
    for (const action of [
      { kind: "require_approval" },
      { kind: "add_restrictions" },
      { kind: "set_stricter_budget", budget: {} },
      { kind: "select_routing_preference", preference: {} },
    ]) {
      expect(ruleSourceDocumentSchema.safeParse(rawRuleDocument({ actions: [action] })).success).toBe(false)
    }
  })
})

// ===========================================================================
// The token alphabet does the untrusted-input work
// ===========================================================================

describe("the opaque token alphabet refuses executable-looking text and accepts harmless words", () => {
  it("refuses an operator character, a backtick and a space inside a capability name", () => {
    // `=>`, a backtick and a newline are all outside the alphabet, so a rule
    // document carrying them is REFUSED rather than compiled and matched. That is
    // stronger than "treated as an opaque string that matches nothing", and it is
    // the right direction: a value the language cannot represent is a value the
    // author did not mean.
    for (const value of ["fs.read => process", "`whoami`", "fs read", "fs.read\nrm -rf"]) {
      expect(rulePredicateSchema.safeParse({ field: "capability", operator: "any", value: [value] }).success).toBe(false)
    }
  })

  it("accepts the dangerous WORDS as opaque identifiers, which then match nothing", () => {
    // `process`, `require`, `eval`, `function`, `constructor` and `prototype` are
    // all legal identifiers under the opaque alphabet. They compile, they are
    // stored, and they match a dispatch only if the dispatch requests a capability
    // with that exact name. Nothing in this module evaluates a string, so a legal
    // token is inert — which is the property under test, and it is asserted by
    // acceptance here and by non-matching in `evaluate.test.ts`.
    for (const value of ["process", "require", "eval", "function", "constructor", "prototype"]) {
      expect(rulePredicateSchema.safeParse({ field: "capability", operator: "any", value: [value] }).success).toBe(true)
    }
  })

  it("refuses `__proto__` even as a VALUE, because the alphabet starts with an alphanumeric", () => {
    // A bonus from reusing the kernel's alphabet rather than restating it: the
    // leading-character rule excludes `_`, so the one identifier in this family
    // that JavaScript treats specially cannot be written at all. There is no
    // second defence here and none is needed.
    expect(rulePredicateSchema.safeParse({ field: "capability", operator: "any", value: ["__proto__"] }).success).toBe(false)
    expect(rulePredicateSchema.safeParse({ field: "capability", operator: "any", value: ["_private"] }).success).toBe(false)
  })

  it("refuses every dangerous KEY except `__proto__`, which Zod's strict check drops rather than reports", () => {
    // `JSON.parse` is the one way to get an own `__proto__` key onto a document
    // object, and Zod's unrecognized-key check does NOT report it: the check is
    // `"<key>" in <shape>`, and `"__proto__" in {}` is TRUE through the prototype
    // chain, so the key reads as recognized and is silently dropped. That is
    // recorded here rather than papered over, because a reader who assumed the
    // schema refused it would be wrong.
    //
    // What matters is that dropping it is SAFE, and that is what the next two
    // cases establish: the key does not survive, and nothing is polluted. The
    // other prototype-chain names ARE reported, because they are not on
    // `Object.prototype` itself.
    const polluted = JSON.parse('{"ruleId":"rule-pwned","__proto__":{"admin":true}}') as Record<string, unknown>
    expect(Object.keys(polluted)).toContain("__proto__")
    const parsed = ruleSourceDocumentSchema.safeParse({ ...validRuleDocument(), ...polluted })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // Dropped, not carried: the compiled document has no such member.
      expect(Object.keys(parsed.data)).not.toContain("__proto__")
    }

    for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const document = JSON.parse(`{"ruleId":"rule-x","${key}":1}`) as Record<string, unknown>
      expect(ruleSourceDocumentSchema.safeParse({ ...validRuleDocument(), ...document }).success).toBe(false)
    }
  })

  it("does not pollute anything when a document carries an own `__proto__` key", () => {
    // The property that makes the previous case safe rather than merely lucky:
    // an own `__proto__` from `JSON.parse` is DATA, and dropping it leaves the
    // prototype chain of every object this module touches exactly as it was.
    const before = ({} as Record<string, unknown>)["admin"]
    const polluted = JSON.parse('{"ruleId":"rule-pwned","__proto__":{"admin":true}}') as Record<string, unknown>
    const parsed = ruleSourceDocumentSchema.safeParse({ ...validRuleDocument(), ...polluted })
    expect(parsed.success).toBe(true)
    expect(({} as Record<string, unknown>)["admin"]).toBe(before)
    expect((Object.prototype as unknown as Record<string, unknown>)["admin"]).toBeUndefined()
    if (parsed.success) {
      expect((parsed.data as unknown as Record<string, unknown>)["admin"]).toBeUndefined()
      expect(Object.getPrototypeOf(parsed.data)).toBe(Object.prototype)
    }
  })
})

// ===========================================================================
// Schedule windows
// ===========================================================================

describe("a schedule window requires an explicit, checked time zone", () => {
  it("accepts an IANA identifier this build knows", () => {
    expect(IANA_TIME_ZONES.has("America/New_York")).toBe(true)
    expect(IANA_TIME_ZONES.has("UTC")).toBe(true)
    expect(
      scheduleWindowSchema.safeParse({ daysOfWeek: [1], startMinuteOfDay: 0, endMinuteOfDay: 60, timeZone: "America/New_York" }).success,
    ).toBe(true)
  })

  it("refuses an IANA identifier this build does not know, at PARSE time", () => {
    expect(
      scheduleWindowSchema.safeParse({ daysOfWeek: [1], startMinuteOfDay: 0, endMinuteOfDay: 60, timeZone: "Not/AZone" }).success,
    ).toBe(false)
  })

  it("accepts a fixed offset across its whole range and refuses one outside it", () => {
    for (const minutes of [-840, 0, 840, 330]) {
      expect(
        scheduleWindowSchema.safeParse({ daysOfWeek: [1], startMinuteOfDay: 0, endMinuteOfDay: 60, timeZone: { fixedOffsetMinutes: minutes } }).success,
      ).toBe(true)
    }
    for (const minutes of [-841, 841, 0.5]) {
      expect(
        scheduleWindowSchema.safeParse({ daysOfWeek: [1], startMinuteOfDay: 0, endMinuteOfDay: 60, timeZone: { fixedOffsetMinutes: minutes } }).success,
      ).toBe(false)
    }
  })

  it("refuses a window that wraps past midnight", () => {
    // A wrapping window needs either a second-day flag or a wrap convention, and
    // both are places to put an off-by-one that grants a window nobody displayed.
    expect(
      scheduleWindowSchema.safeParse({ daysOfWeek: [1], startMinuteOfDay: 1_380, endMinuteOfDay: 180, timeZone: "UTC" }).success,
    ).toBe(false)
  })

  it("refuses a zero-length window, which never fires", () => {
    expect(
      scheduleWindowSchema.safeParse({ daysOfWeek: [1], startMinuteOfDay: 600, endMinuteOfDay: 600, timeZone: "UTC" }).success,
    ).toBe(false)
  })

  it("refuses an empty day set and a repeated day", () => {
    expect(scheduleWindowSchema.safeParse({ daysOfWeek: [], startMinuteOfDay: 0, endMinuteOfDay: 60, timeZone: "UTC" }).success).toBe(false)
    expect(scheduleWindowSchema.safeParse({ daysOfWeek: [1, 1], startMinuteOfDay: 0, endMinuteOfDay: 60, timeZone: "UTC" }).success).toBe(false)
  })

  it("refuses a day outside 0..6 and a minute outside 0..1439", () => {
    expect(scheduleWindowSchema.safeParse({ daysOfWeek: [7], startMinuteOfDay: 0, endMinuteOfDay: 60, timeZone: "UTC" }).success).toBe(false)
    expect(scheduleWindowSchema.safeParse({ daysOfWeek: [-1], startMinuteOfDay: 0, endMinuteOfDay: 60, timeZone: "UTC" }).success).toBe(false)
    expect(scheduleWindowSchema.safeParse({ daysOfWeek: [1], startMinuteOfDay: 1_440, endMinuteOfDay: 1_500, timeZone: "UTC" }).success).toBe(false)
  })
})

// ===========================================================================
// The evaluation context schema
// ===========================================================================

describe("the evaluation context is itself a schema, and a malformed one is refused rather than evaluated", () => {
  it("accepts the fully populated fixture", () => {
    expect(ruleEvaluationContextSchema.safeParse(validContext()).success).toBe(true)
  })

  it("accepts a context with every nullable field null, which is a real dispatch shape", () => {
    const empty = ruleEvaluationContextSchema.safeParse({
      projectId: "proj-1",
      roleId: null,
      roleVersion: null,
      requestedCapabilities: [],
      toolCategories: [],
      runtimeKind: null,
      targetNodeId: null,
      nodeAdvertisedCapabilities: null,
      projectPathId: null,
      taskLabels: [],
      dependencyOutcomes: [],
      requestedFanOut: null,
      requestedConcurrency: null,
      requestedRetryLimit: null,
      declaredTimeoutSeconds: null,
      taskTitle: null,
      evaluatedAt: "2026-02-02T12:00:00Z",
      contextManifestSensitivity: null,
      currentBudget: null,
    })
    expect(empty.success).toBe(true)
  })

  it("refuses a context with an unknown key, because an extra field is a field the evaluator ignores silently", () => {
    expect(ruleEvaluationContextSchema.safeParse({ ...validContext(), prompt: "secret" }).success).toBe(false)
  })

  it("refuses a context missing a key, because `undefined` is the shape a fail-open bug wears", () => {
    const context = validContext() as unknown as Record<string, unknown>
    delete context["roleId"]
    expect(ruleEvaluationContextSchema.safeParse(context).success).toBe(false)
  })

  it("refuses an out-of-domain numeric value, so an evaluation cannot read a fan-out the language does not have", () => {
    expect(ruleEvaluationContextSchema.safeParse({ ...validContext(), requestedFanOut: 0 }).success).toBe(false)
    expect(ruleEvaluationContextSchema.safeParse({ ...validContext(), requestedConcurrency: 257 }).success).toBe(false)
    expect(ruleEvaluationContextSchema.safeParse({ ...validContext(), requestedRetryLimit: 17 }).success).toBe(false)
    expect(ruleEvaluationContextSchema.safeParse({ ...validContext(), declaredTimeoutSeconds: 3_601 }).success).toBe(false)
  })

  it("refuses a task title over the bounded analyser's subject length", () => {
    // The same 256 the `SafePattern` ReDoS argument is made over, asserted here
    // so the two cannot drift: a longer subject would make the analyser's bound
    // untrue.
    expect(ruleEvaluationContextSchema.safeParse({ ...validContext(), taskTitle: "t".repeat(257) }).success).toBe(false)
    expect(ruleEvaluationContextSchema.safeParse({ ...validContext(), taskTitle: "t".repeat(256) }).success).toBe(true)
  })
})

// ===========================================================================
// The derived tables
// ===========================================================================

describe("the derived tables are total and consistent", () => {
  it("ranks every action kind, restrictively before permissively", () => {
    // ADR 0007 section 10.2's order, stated as a claim about the RANKING rather
    // than about a list: a grant is computed after every disposition a reader
    // needs in order to judge it.
    const kinds: RuleActionKind[] = [
      "deny_with_reason",
      "require_approval",
      "add_restrictions",
      "set_stricter_budget",
      "select_routing_preference",
      "pre_approve_within_bounds",
    ]
    for (const kind of kinds) expect(actionKindRank(kind)).toBe(RULE_ACTION_KIND_RANK[kind])
    expect(RULE_ACTION_KIND_RANK.deny_with_reason).toBeLessThan(RULE_ACTION_KIND_RANK.pre_approve_within_bounds)
    expect(RULE_ACTION_KIND_RANK.require_approval).toBeLessThan(RULE_ACTION_KIND_RANK.add_restrictions)
    expect(RULE_ACTION_KIND_RANK.add_restrictions).toBeLessThan(RULE_ACTION_KIND_RANK.set_stricter_budget)
    expect(RULE_ACTION_KIND_RANK.set_stricter_budget).toBeLessThan(RULE_ACTION_KIND_RANK.select_routing_preference)
    expect(RULE_ACTION_KIND_RANK.select_routing_preference).toBeLessThan(RULE_ACTION_KIND_RANK.pre_approve_within_bounds)
  })

  it("orders actions by rank, stably, so declaration order survives within a kind", () => {
    const sorted = [
      { kind: "pre_approve_within_bounds" },
      { kind: "deny_with_reason", reason: "b" },
      { kind: "require_approval", requireApprovalForDispatch: true },
      { kind: "deny_with_reason", reason: "a" },
    ] as unknown as RuleAction[]
    const byRank = [...sorted].sort(compareRuleActionKindsByRank)
    // The two denies keep their relative order, which is what "stable" means here
    // and what makes the normalized form a function of the document rather than
    // of the sort implementation.
    expect(byRank.map((action) => action.kind)).toEqual([
      "deny_with_reason",
      "deny_with_reason",
      "require_approval",
      "pre_approve_within_bounds",
    ])
  })

  it("names eighteen predicate fields, seventeen constraining plus the pattern surface", () => {
    expect(RULE_PREDICATE_FIELDS).toHaveLength(18)
    // The twelve that make a pre-approval non-universal are a SUBSET of the
    // eighteen, and a field in both lists is a field that counts toward scope.
    for (const field of NON_UNIVERSAL_PREDICATE_FIELDS) {
      expect(RULE_PREDICATE_FIELDS).toContain(field)
    }
    expect(NON_UNIVERSAL_PREDICATE_FIELDS).toHaveLength(12)
  })

  it("derives the rank order from SENSITIVITY_RANK rather than assuming the declared order is the ranked order", () => {
    // If `SENSITIVITY_LEVELS` were ever reordered without the ranks following, a
    // module that assumed declaration order equals rank order would silently
    // compare the wrong way. Deriving it makes that impossible.
    for (let rank = 0; rank < SENSITIVITY_BY_RANK.length; rank += 1) {
      expect(SENSITIVITY_RANK[SENSITIVITY_BY_RANK[rank] as keyof typeof SENSITIVITY_RANK]).toBe(rank)
    }
    expect(SENSITIVITY_BY_RANK).toHaveLength(SENSITIVITY_LEVELS.length)
  })

  it("recognises the three combinators and nothing else", () => {
    for (const field of ["all", "any", "not"] as const) {
      expect(isCombinatorPredicate({ field } as unknown as RulePredicate)).toBe(true)
    }
    expect(isCombinatorPredicate({ field: "roleId" } as unknown as RulePredicate)).toBe(false)
  })

  it("walks a predicate tree depth-first in declaration order", () => {
    const tree = [
      {
        field: "all" as const,
        predicates: [
          { field: "roleId" as const, operator: "eq" as const, value: "role-1" },
          { field: "not" as const, predicate: { field: "projectId" as const, operator: "eq" as const, value: "proj-1" } },
        ],
      },
      { field: "capability" as const, operator: "any" as const, value: ["fs.read"] },
    ] as unknown as RulePredicate[]
    expect(walkPredicates(tree).map((predicate) => predicate.field)).toEqual([
      "all",
      "roleId",
      "not",
      "projectId",
      "capability",
    ])
  })
})

// ===========================================================================
// Schema and type agree
// ===========================================================================

describe("the hand-written combinator arms and the inferred field arms agree with the schema", () => {
  it("accepts a value of every arm of the declared union", () => {
    // Forward direction: everything the TYPE admits, the SCHEMA parses. A new arm
    // added to the type without a schema member would be caught here.
    const arms: readonly RulePredicate[] = [
      { field: "projectId", operator: "eq", value: "proj-1" as never },
      { field: "roleId", operator: "in", value: ["role-1"] as never },
      { field: "roleVersion", operator: "between", value: { min: 1, max: 2 } },
      { field: "capability", operator: "all", value: ["fs.read"] },
      { field: "toolCategory", operator: "none", value: ["shell"] },
      { field: "runtimeKind", operator: "eq", value: "opencode" },
      { field: "targetNodeId", operator: "eq", value: "node-1" as never },
      { field: "nodeAdvertisedCapability", operator: "any", value: ["fs.read"] },
      { field: "projectPathId", operator: "in", value: ["path-1"] as never },
      { field: "taskLabel", operator: "has", value: "release" },
      { field: "dependencyOutcome", operator: "allFailed" },
      { field: "fanOut", operator: "lte", value: 4 },
      { field: "concurrency", operator: "gte", value: 1 },
      { field: "retryLimit", operator: "gt", value: 0 },
      { field: "timeoutSeconds", operator: "between", value: { min: 1, max: 900 } },
      { field: "scheduleWindow", windows: [{ daysOfWeek: [1], startMinuteOfDay: 0, endMinuteOfDay: 60, timeZone: "UTC" }] },
      { field: "contextSensitivity", operator: "maxRankAtLeast", value: 0 },
      { field: "taskTitlePattern", pattern: "^x" },
      { field: "all", predicates: [] },
      { field: "any", predicates: [] },
      { field: "not", predicate: { field: "roleId", operator: "eq", value: "role-1" as never } },
    ]
    expect(arms).toHaveLength(RULE_PREDICATE_FIELDS.length + 3)
    for (const arm of arms) {
      expect(rulePredicateSchema.safeParse(arm).success).toBe(true)
    }
  })

  it("refuses a discriminator the type does not admit", () => {
    // Backward direction: the schema admits nothing outside the type. An
    // unrecognised discriminator is a compile error rather than a silently
    // skipped predicate.
    expect(rulePredicateSchema.safeParse({ field: "systemPrompt", value: "x" }).success).toBe(false)
    expect(rulePredicateSchema.safeParse({ field: "code", value: "process.exit()" }).success).toBe(false)
  })

  it("refuses a combinator whose child is not a predicate, rather than treating it as absent", () => {
    // A missing child would make `not()` and `all()` behave as though the author
    // had written something narrower than they did.
    expect(rulePredicateSchema.safeParse({ field: "not" }).success).toBe(false)
    expect(rulePredicateSchema.safeParse({ field: "not", predicate: null }).success).toBe(false)
    expect(rulePredicateSchema.safeParse({ field: "all", predicates: [null] }).success).toBe(false)
    expect(rulePredicateSchema.safeParse({ field: "all", predicates: ["roleId"] }).success).toBe(false)
  })
})

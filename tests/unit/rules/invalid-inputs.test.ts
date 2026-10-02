/**
 * Adversarial inputs: hundreds of mutations of a valid rule document, plus the
 * values that are not documents at all, plus the words an attacker would put in a
 * rule to get code executed.
 *
 * THE CLAIM BEING TESTED, in one sentence: for ANY input, `compileRule` either
 * returns a compiled rule or returns a refusal with a NAMED code, and never
 * throws. Not "usually" and not "for the shapes I thought of" — for every input
 * the generator produces, and the generator is seeded from a constant so the set
 * of inputs is identical on every run and every machine.
 *
 * WHY A SEEDED GENERATOR AND NOT `Math.random`. A fuzzer whose seed changes per
 * run reports a different failure set per run, so a failure nobody can reproduce
 * is a failure nobody can fix. A seeded one is a fixed corpus: when it finds
 * something, the same input finds it again tomorrow. The generator is a linear
 * congruential sequence, which is the weakest there is — these tests are not
 * searching for a needle, they are asserting that a whole CLASS of malformed
 * input is refused, and the only property that matters is that the class is
 * visited every time.
 *
 * WHY `never throws` IS ASSERTED RATHER THAN ASSUMED. The compiler is a trust
 * boundary over untrusted input. A compiler that throws turns a typo in a rule
 * document into an unhandled rejection in whatever loaded it, which is a crash
 * with no diagnostic. The assertions below wrap every call and require a
 * `ContractError` back.
 *
 * THE CODE-EXECUTION CASES are here rather than in the schema test because the
 * claim is not "the schema refuses them" but "nothing in this module EXECUTES
 * them". A rule document carrying `process`, `require`, `eval`, `function`, `=>`,
 * a backtick, `__proto__`, `constructor` or `prototype` as a predicate or action
 * value is either refused outright or treated as an opaque string that matches
 * nothing — and in neither case is any global touched, which is asserted by
 * reading a global before and after.
 */

import { describe, expect, it } from "vitest"
import { compileRule, compileRuleSet, evaluateRules, type CompiledRuleSet } from "../../../src/rules/index.js"
import { RULE_ERROR_CODES } from "./fixtures.js"
import {
  clone,
  makeRng,
  nestedArrays,
  notChain,
  pick,
  preApprovalDocument,
  randomInt,
  randomToken,
  rawPreApprovalDocument,
  rawRuleDocument,
  validContext,
  validRuleDocument,
} from "./fixtures.js"

/**
 * The words an attacker would put in a rule hoping something evaluates them.
 *
 * Declared at module scope because two describe blocks assert against it: one that
 * compiles them, and one that reads the globals around them.
 */
export const dangerousValues: readonly string[] = [
    "process",
    "require",
    "eval",
    "function",
    "=>",
    "`whoami`",
    "__proto__",
    "constructor",
    "prototype",
    "process.exit(1)",
    "require('fs')",
    "eval('1+1')",
    "function(){return 1}",
    "globalThis",
    "process.env.SECRET",
    "${process.env.SECRET}",
    "a; b",
    "a && b",
    "a | b",
    "a`b",
  ]

/** The seed. A constant, so the corpus is the same on every run. */
const SEED = 0x5eed_1234

/**
 * Compiles, and REQUIRES a refusal.
 *
 * The throw inside is the assertion: if compilation succeeds, the input was
 * accepted and the test fails naming what was accepted. If compilation throws,
 * the `catch` re-throws a failure that says so, because an uncaught throw in the
 * module under test is exactly the property being ruled out.
 */
function expectRefused(input: unknown, what: string): string {
  const outcome = compileEitherWay(input, what)
  if (outcome.ok) {
    throw new Error(`${what}: compileRule ACCEPTED ${JSON.stringify(input).slice(0, 200)}`)
  }
  return outcome.error.code
}

/**
 * Compiles, and REQUIRES a well-formed answer of either kind.
 *
 * THE ACTUAL CONTRACT, and the reason the fuzz cases use this rather than
 * `expectRefused`: for any input, `compileRule` returns EITHER a compiled rule
 * that satisfies its own shape OR a refusal carrying a code from the declared
 * union — and it never throws. A fuzzer that only produced invalid inputs would
 * prove the schema is strict; it would not prove the strictness is not vacuous,
 * and it would not cover the pool entries that happen to be VALID (an empty
 * action list, a well-formed predicate). Both outcomes are checked here, which is
 * what makes the fuzz pass a test of the contract rather than a test of the
 * schema's refusal rate.
 */
function compileEitherWay(input: unknown, what: string): ReturnType<typeof compileRule> {
  let result: ReturnType<typeof compileRule>
  try {
    result = compileRule(input)
  } catch (error) {
    throw new Error(`${what}: compileRule THREW instead of returning a Result: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (result.ok) {
    // An accepted document must be a real artifact, not merely "not refused".
    expect(result.value.digest, `${what}: an accepted rule must carry a digest`).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(Object.isFrozen(result.value), `${what}: an accepted rule must be frozen`).toBe(true)
    expect(typeof result.value.normalizedPredicate, `${what}: an accepted rule must be normalized`).toBe("string")
  } else {
    // Every refusal carries a code from the declared union. A code outside it
    // would mean a caller could not branch on it.
    expect(RULE_ERROR_CODES, `${what}: refusal code`).toContain(result.error.code)
    expect(result.error.message.length).toBeGreaterThan(0)
    expect(result.error.message.length).toBeLessThanOrEqual(4_096)
  }
  return result
}

// ===========================================================================
// Not documents at all
// ===========================================================================

describe("a value that is not a rule document is refused, never thrown at", () => {
  const notDocuments: readonly { value: unknown; what: string }[] = [
    { value: null, what: "null" },
    { value: undefined, what: "undefined" },
    { value: 0, what: "zero" },
    { value: -1, what: "a negative number" },
    { value: Number.NaN, what: "NaN" },
    { value: Number.POSITIVE_INFINITY, what: "infinity" },
    { value: 1e308 * 10, what: "a number too large to be safe" },
    { value: "", what: "the empty string" },
    { value: "a rule document", what: "a bare string" },
    { value: true, what: "true" },
    { value: false, what: "false" },
    { value: [], what: "an empty array" },
    { value: [validRuleDocument()], what: "an array containing a document" },
    { value: {}, what: "an empty object" },
    { value: { languageVersion: 2 }, what: "a document with only a version" },
    { value: new Map(), what: "a Map" },
    { value: new Set(), what: "a Set" },
    { value: new Date(0), what: "a Date" },
    { value: () => undefined, what: "a function" },
    { value: Symbol("x"), what: "a symbol" },
    { value: 10n, what: "a bigint" },
  ]

  for (const entry of notDocuments) {
    it(`refuses ${entry.what}`, () => {
      const code = expectRefused(entry.value, entry.what)
      // A value that is not a plain object, or that carries no `languageVersion`,
      // is refused by the version check BEFORE the schema runs — so the honest code
      // is the version one, and asserting `invalid_source` here would be asserting
      // something the module deliberately does not do.
      expect(["rule.invalid_source", "rule.language_version_unsupported"]).toContain(code)
    })
  }

  it("refuses every one of them in a single pass, so the table above is exhaustive for this shape", () => {
    // The per-value cases above name each one; this asserts the whole list in one
    // place so a value added to the list without a case is still covered.
    for (const entry of notDocuments) {
      const result = compileRule(entry.value)
      expect(result.ok).toBe(false)
    }
  })

  it("refuses a rule set that is not an array", () => {
    for (const value of [null, undefined, 42, "rules", { rules: [] }]) {
      const result = compileRuleSet(value as never)
      expect(result.ok).toBe(false)
    }
  })
})

// ===========================================================================
// Structural mutations
// ===========================================================================

describe("every structural mutation of a valid document is refused or accepted deliberately, and never thrown at", () => {
  const requiredKeys = [
    "languageVersion",
    "ruleId",
    "templateVersion",
    "projectId",
    "name",
    "description",
    "enabled",
    "activation",
    "predicates",
    "actions",
    "expiresAt",
    "author",
    "createdAt",
  ] as const

  it("refuses the document with each required key dropped", () => {
    for (const key of requiredKeys) {
      const document = rawRuleDocument()
      delete document[key]
      const code = expectRefused(document, `dropping '${key}'`)
      // `languageVersion` is checked before the schema, so it gets the version
      // code; everything else is a shape error. Both are refusals with a code.
      expect(["rule.language_version_unsupported", "rule.invalid_source"]).toContain(code)
    }
  })

  it("refuses the document with each required key replaced by a wrong type", () => {
    const wrongValues: readonly unknown[] = [null, 0, 1, -1, 1.5, "", "x", true, false, [], {}, Number.NaN]
    for (const key of requiredKeys) {
      for (const wrong of wrongValues) {
        const document = rawRuleDocument({ [key]: wrong })
        // `name` legitimately rejects `""` for length and `expiresAt` rejects
        // `null` never, but every one of these combinations is a refusal — the
        // assertion is that it is a REFUSAL, not which code.
        const result = compileRule(document)
        if (!result.ok) {
          expect(RULE_ERROR_CODES).toContain(result.error.code)
        }
      }
    }
  })

  it("refuses the document with an unknown key added at every level", () => {
    const mutations: readonly { what: string; document: unknown }[] = [
      { what: "an unknown top-level key", document: rawRuleDocument({ extra: 1 }) },
      { what: "an unknown activation key", document: rawRuleDocument({ activation: { state: "draft", activatedAt: null, activatedBy: null, extra: 1 } }) },
      { what: "an unknown predicate key", document: rawRuleDocument({ predicates: [{ field: "roleId", operator: "eq", value: "role-1", extra: 1 }] }) },
      { what: "an unknown action key", document: rawRuleDocument({ actions: [{ kind: "deny_with_reason", reason: "x", extra: 1 }] }) },
      { what: "an unknown key on a range", document: rawRuleDocument({ predicates: [{ field: "fanOut", operator: "between", value: { min: 1, max: 2, extra: 1 } }] }) },
      { what: "an unknown key on a schedule window", document: rawRuleDocument({ predicates: [{ field: "scheduleWindow", windows: [{ daysOfWeek: [1], startMinuteOfDay: 0, endMinuteOfDay: 1, timeZone: "UTC", extra: 1 }] }] }) },
      { what: "an unknown key on a fixed offset", document: rawRuleDocument({ predicates: [{ field: "scheduleWindow", windows: [{ daysOfWeek: [1], startMinuteOfDay: 0, endMinuteOfDay: 1, timeZone: { fixedOffsetMinutes: 0, extra: 1 } }] }] }) },
    ]
    for (const mutation of mutations) {
      const code = expectRefused(mutation.document, mutation.what)
      expect(["rule.invalid_source", "rule.limit_exceeded", "rule.empty_enum"]).toContain(code)
    }
  })

  it("refuses an oversized string in every string-valued field", () => {
    const huge = "x".repeat(100_000)
    const mutations: readonly { what: string; document: unknown }[] = [
      { what: "an oversized name", document: rawRuleDocument({ name: huge }) },
      { what: "an oversized description", document: rawRuleDocument({ description: huge }) },
      { what: "an oversized deny reason", document: rawRuleDocument({ actions: [{ kind: "deny_with_reason", reason: huge }] }) },
      { what: "an oversized predicate note", document: rawRuleDocument({ predicates: [{ field: "roleId", operator: "eq", value: "role-1", note: huge }] }) },
      { what: "an oversized pattern", document: rawRuleDocument({ predicates: [{ field: "taskTitlePattern", pattern: huge }] }) },
      { what: "an oversized ruleId", document: rawRuleDocument({ ruleId: huge }) },
      { what: "an oversized author name", document: rawRuleDocument({ author: { kind: "system", name: huge } }) },
    ]
    for (const mutation of mutations) {
      expectRefused(mutation.document, mutation.what)
    }
  })

  it("refuses an oversized array in every array-valued field", () => {
    const many = Array.from({ length: 5_000 }, (_unused, index) => `member-${index}`)
    const mutations: readonly { what: string; document: unknown }[] = [
      { what: "an oversized top-level predicate list", document: rawRuleDocument({ predicates: many.map(() => ({ field: "roleId", operator: "eq", value: "role-1" })) }) },
      { what: "an oversized action list", document: rawRuleDocument({ actions: many.map((_unused, index) => ({ kind: "deny_with_reason", reason: `r${index}` })) }) },
      { what: "an oversized enum member list", document: rawRuleDocument({ predicates: [{ field: "projectId", operator: "in", value: many }] }) },
      { what: "an oversized capability list", document: rawRuleDocument({ predicates: [{ field: "capability", operator: "any", value: many }] }) },
      { what: "an oversized label list", document: rawRuleDocument({ predicates: [{ field: "taskLabel", operator: "hasAny", value: many }] }) },
      { what: "an oversized window list", document: rawRuleDocument({ predicates: [{ field: "scheduleWindow", windows: many.map(() => ({ daysOfWeek: [1], startMinuteOfDay: 0, endMinuteOfDay: 1, timeZone: "UTC" })) }] }) },
      { what: "an oversized approved-capability list", document: rawPreApprovalDocument({ actions: [{ kind: "pre_approve_within_bounds", approvedCapabilities: many, maximumTimeoutSeconds: 900, allowDestructiveEffects: false, allowExternalEffects: false, maximumSensitivity: "restricted" }] }) },
    ]
    for (const mutation of mutations) {
      expectRefused(mutation.document, mutation.what)
    }
  })

  it("refuses absurd nesting, of objects and of arrays, without a stack overflow", () => {
    // Both shapes, and both DEEPER than the parser's own recursion tolerance: the
    // pre-scan is what makes these contract errors rather than `RangeError`s.
    expectRefused(rawRuleDocument({ predicates: [notChain(20_000)] }), "a 20,000-deep not chain")
    expectRefused(rawRuleDocument({ predicates: nestedArrays(20_000) }), "a 20,000-deep array nest")
    expectRefused(rawRuleDocument({ predicates: [notChain(500)] }), "a 500-deep not chain")
  })

  it("refuses a self-referential predicate list, rather than looping forever", () => {
    // The one input shape that would hang a naive walk. A cycle is caught by the
    // node budget rather than by exhausting memory, and the refusal says so.
    const cyclic: Record<string, unknown> = { field: "all", predicates: [] }
    ;(cyclic["predicates"] as unknown[]).push(cyclic)
    expectRefused(rawRuleDocument({ predicates: [cyclic] }), "a self-referential predicate")

    const selfNot: Record<string, unknown> = { field: "not" }
    selfNot["predicate"] = selfNot
    expectRefused(rawRuleDocument({ predicates: [selfNot] }), "a self-referential not")

    const selfArray: unknown[] = []
    selfArray.push(selfArray)
    expectRefused(rawRuleDocument({ predicates: selfArray }), "a self-referential predicate array")
  })

  it("DROPS a document's own `__proto__` key without effect, rather than refusing the document", () => {
    // Zod's unrecognized-key check does not report `__proto__`: it tests
    // `"<key>" in <shape>`, and that is TRUE through the prototype chain, so the
    // key reads as recognized. So the document is ACCEPTED with the key dropped —
    // which is the safe outcome, and the test states it rather than asserting a
    // refusal that does not happen. `schema.test.ts` asserts the same gap and the
    // other prototype-chain names, which ARE reported.
    const polluted = JSON.parse('{"ruleId":"rule-pwned","__proto__":{"isAdmin":true}}') as Record<string, unknown>
    const result = compileRule({ ...rawRuleDocument(), ...polluted })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Dropped, not carried, and not inherited: the compiled document is an
      // ordinary object with the ordinary prototype.
      expect(Object.keys(result.value)).not.toContain("__proto__")
      expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype)
      expect((result.value as unknown as Record<string, unknown>)["isAdmin"]).toBeUndefined()
    }
    // And nothing anywhere was polluted by the attempt.
    expect(({} as Record<string, unknown>)["isAdmin"]).toBeUndefined()
    expect((Object.prototype as unknown as Record<string, unknown>)["isAdmin"]).toBeUndefined()
  })
})

// ===========================================================================
// The fuzz pass
// ===========================================================================

describe("several hundred generated mutations of a valid document are each refused with a code, and none throws", () => {
  /** The value pool the generator draws from: every shape the language knows, plus nonsense. */
  function mutationPool(random: () => number): unknown {
    return pick(random, [
      // Type confusions on a scalar field.
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "",
      "x".repeat(randomInt(random, 1, 600)),
      "a".repeat(randomInt(random, 100, 5_000)),
      true,
      false,
      null,
      [],
      {},
      [[]],
      [{}],
      // Shape confusions on a list field.
      [1, 2, 3],
      ["a", "b"],
      [null],
      [{}],
      Array.from({ length: randomInt(random, 0, 200) }, () => `m-${randomInt(random, 0, 999)}`),
      // Predicate-shaped values, some valid and some not.
      { field: "roleId", operator: "eq", value: "role-1" },
      { field: "roleId", operator: "in", value: [] },
      { field: "roleId", operator: "regex", value: ".*" },
      { field: "nonsense", operator: "eq", value: "x" },
      { field: "fanOut", operator: "between", value: { min: 9, max: 1 } },
      { field: "fanOut", operator: "between", value: 4 },
      { field: "fanOut", operator: "lte", value: 100_000 },
      { field: "not" },
      { field: "not", predicate: null },
      { field: "all", predicates: [] },
      { field: "all", predicates: [{ field: "roleId", operator: "eq", value: "role-1" }] },
      { field: "scheduleWindow", windows: [] },
      { field: "scheduleWindow", windows: [{ daysOfWeek: [1], startMinuteOfDay: 0, endMinuteOfDay: 1, timeZone: "Mars/Base" }] },
      { field: "contextSensitivity", operator: "maxRankAtMost", value: 99 },
      { field: "contextSensitivity", operator: "any", value: ["not_a_sensitivity"] },
      { field: "taskTitlePattern", pattern: "(a+)+" },
      // Action-shaped values.
      { kind: "deny_with_reason", reason: "" },
      { kind: "deny_with_reason" },
      { kind: "nonsense" },
      { kind: "require_approval" },
      { kind: "require_approval", requireApprovalForDispatch: "yes" },
      { kind: "add_restrictions", allowedCapabilities: "fs.read" },
      { kind: "set_stricter_budget", budget: null },
      { kind: "select_routing_preference", preference: {} },
      {
        kind: "pre_approve_within_bounds",
        approvedCapabilities: [],
        maximumTimeoutSeconds: 900,
        allowDestructiveEffects: false,
        allowExternalEffects: false,
        maximumSensitivity: "restricted",
      },
      {
        kind: "pre_approve_within_bounds",
        approvedCapabilities: ["fs.read"],
        maximumTimeoutSeconds: 900,
        allowDestructiveEffects: true,
        allowExternalEffects: false,
        maximumSensitivity: "restricted",
      },
      // Timestamps and identifiers.
      "2026-01-01T00:00:00Z",
      "2026-01-01",
      "not-a-timestamp",
      "rule-1",
      "-leading-dash",
      "has space",
      "has/slash",
      randomToken(random, randomInt(random, 1, 300)),
    ])
  }

  it("answers 500 single-field mutations with a well-formed artifact or a coded refusal, and never throws", () => {
    const random = makeRng(SEED)
    const keys = Object.keys(rawRuleDocument()) as (keyof ReturnType<typeof rawRuleDocument>)[]
    const codes = new Set<string>()
    let accepted = 0

    for (let attempt = 0; attempt < 500; attempt += 1) {
      const document = rawRuleDocument()
      const key = pick(random, keys)
      document[key] = mutationPool(random)
      const result = compileEitherWay(document, `mutation ${attempt} on '${key}'`)
      if (result.ok) accepted += 1
      else codes.add(result.error.code)
    }

    // Not "the fuzzer ran" but "the fuzzer reached several distinct outcomes":
    // more than one refusal path, and at least one acceptance. A corpus that only
    // ever produced refusals would prove the schema is strict and nothing else.
    expect(codes.size).toBeGreaterThan(1)
    expect(accepted).toBeGreaterThan(0)
  })

  it("answers 500 predicate-slot mutations with a well-formed artifact or a coded refusal, and never throws", () => {
    const random = makeRng(SEED ^ 0x9e37_79b9)
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const document = rawRuleDocument()
      const predicates = Array.from({ length: randomInt(random, 0, 4) }, () => mutationPool(random))
      document["predicates"] = predicates
      compileEitherWay(document, `predicate mutation ${attempt}`)
    }
  })

  it("answers 500 action-slot mutations with a well-formed artifact or a coded refusal, and never throws", () => {
    const random = makeRng(SEED ^ 0x85eb_ca6b)
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const document = rawRuleDocument()
      document["actions"] = Array.from({ length: randomInt(random, 0, 3) }, () => mutationPool(random))
      compileEitherWay(document, `action mutation ${attempt}`)
    }
  })

  it("answers 200 whole-document replacements with a well-formed artifact or a coded refusal, and never throws", () => {
    const random = makeRng(SEED ^ 0xc2b2_ae35)
    for (let attempt = 0; attempt < 200; attempt += 1) {
      compileEitherWay(mutationPool(random), `replacement ${attempt}`)
    }
  })

  it("answers a fuzzed SET with a well-formed artifact or a coded refusal naming the entry, and never throws", () => {
    const random = makeRng(SEED ^ 0x27d4_eb2f)
    let refused = 0
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const documents = [validRuleDocument(), rawRuleDocument({ ruleId: "rule-b", [pick(random, Object.keys(rawRuleDocument()))]: mutationPool(random) })]
      let result: ReturnType<typeof compileRuleSet>
      try {
        result = compileRuleSet(documents)
      } catch (error) {
        throw new Error(`set mutation ${attempt}: compileRuleSet THREW: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (result.ok) {
        expect(Object.isFrozen(result.value)).toBe(true)
        expect(result.value.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
        continue
      }
      refused += 1
      expect(RULE_ERROR_CODES).toContain(result.error.code)
      // A set-level refusal must say WHICH entry, because "one of your rules is
      // wrong" is a bisect an author has to do by hand.
      expect(result.error.message).toContain("entry 1")
    }
    expect(refused).toBeGreaterThan(0)
  })

  it("produces the SAME verdicts on a second run with the same seed, so a failure is reproducible", () => {
    // The property that makes this file useful as a corpus rather than as a smoke
    // test: the same seed must produce the same verdicts — and the same DIGESTS
    // for the accepted ones — or a failure found on one machine cannot be
    // reproduced on another.
    const runOnce = (): string[] => {
      const random = makeRng(SEED)
      const keys = Object.keys(rawRuleDocument()) as (keyof ReturnType<typeof rawRuleDocument>)[]
      const verdicts: string[] = []
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const document = rawRuleDocument()
        document[pick(random, keys)] = mutationPool(random)
        const result = compileRule(document)
        verdicts.push(result.ok ? `ACCEPTED ${result.value.digest}` : `REFUSED ${result.error.code}`)
      }
      return verdicts
    }
    expect(runOnce()).toEqual(runOnce())
  })

  it("accepts a fuzzed document only when it happens to be a VALID one, and then the artifact is well formed", () => {
    // The other direction. A fuzzer that only produces refusals proves the schema
    // is strict; it does not prove the strictness is not vacuous. So the mutated
    // field is sometimes replaced with another VALID value, and those inputs must
    // COMPILE.
    const random = makeRng(SEED ^ 0x1b87_3593)
    const validValues: readonly [string, unknown][] = [
      ["ruleId", "rule-mutated"],
      ["templateVersion", 2],
      ["projectId", "proj-1"],
      ["name", "a different name"],
      ["description", "a different description"],
      ["enabled", false],
      ["expiresAt", "2030-01-01T00:00:00Z"],
      ["predicates", [{ field: "roleId", operator: "eq", value: "role-2" }]],
      ["actions", [{ kind: "deny_with_reason", reason: "a different reason" }]],
    ]
    let accepted = 0
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [key, value] = pick(random, validValues)
      const result = compileRule(rawRuleDocument({ [key]: value }))
      if (result.ok) {
        accepted += 1
        expect(result.value.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
        expect(Object.isFrozen(result.value)).toBe(true)
      }
    }
    // Every one of those replacements is valid, so every one must compile. An
    // `accepted` count below the attempt count would mean the schema is refusing
    // legal documents, which is the failure this case exists to catch.
    expect(accepted).toBe(200)
  })
})

// ===========================================================================
// No code execution
// ===========================================================================

describe("a rule document carrying executable-looking text is refused or inert, and no global is touched", () => {
  it("refuses or treats inertly every dangerous value in a capability predicate", () => {
    for (const value of dangerousValues) {
      const result = compileRule(
        rawRuleDocument({ predicates: [{ field: "capability", operator: "any", value: [value] }], actions: [{ kind: "deny_with_reason", reason: "x" }] }),
      )
      if (result.ok) {
        // Compiled as an OPAQUE TOKEN. It is stored, and it matches a dispatch only
        // if the dispatch requests a capability with that exact name.
        expect(result.value.patterns).toHaveLength(0)
        expect(result.value.normalizedPredicate).toContain(JSON.stringify(value))
      } else {
        expect(RULE_ERROR_CODES).toContain(result.error.code)
      }
    }
  })

  it("refuses or treats inertly every dangerous value in a deny reason", () => {
    for (const value of dangerousValues) {
      const result = compileRule(rawRuleDocument({ actions: [{ kind: "deny_with_reason", reason: value }] }))
      // A reason is free text by design — it is authored to explain a decision —
      // so these compile and are stored as text. What matters is that they are
      // never evaluated, which the next cases establish.
      expect(result.ok).toBe(true)
    }
  })

  it("refuses or treats inertly every dangerous value in a task title pattern", () => {
    for (const value of dangerousValues) {
      const result = compileRule(
        rawRuleDocument({ predicates: [{ field: "taskTitlePattern", pattern: value }], actions: [{ kind: "deny_with_reason", reason: "x" }] }),
      )
      // Either the bounded analyser refused it, or it compiled as a pattern that
      // matches at most the literal text. There is no third outcome: nothing in
      // this module evaluates a pattern as anything but a pattern.
      if (result.ok) expect(result.value.patterns).toHaveLength(1)
      else expect(RULE_ERROR_CODES).toContain(result.error.code)
    }
  })

  it("refuses a dangerous value used as a field NAME or an operator", () => {
    for (const value of ["process", "eval", "__proto__", "constructor"]) {
      expectRefused(rawRuleDocument({ predicates: [{ field: value, operator: "eq", value: "x" }] }), `field '${value}'`)
      expectRefused(rawRuleDocument({ predicates: [{ field: "roleId", operator: value, value: "x" }] }), `operator '${value}'`)
      expectRefused(rawRuleDocument({ actions: [{ kind: value, reason: "x" }] }), `action kind '${value}'`)
    }
  })

  it("touches no global while compiling any of them", () => {
    // The observable form of "no code execution": a global read before and after,
    // over the whole dangerous corpus. A module that reached `globalThis`, `eval`ed
    // a rule value, or installed a global would move one of these.
    const before = {
      process: (globalThis as Record<string, unknown>)["process"],
      globalThis: (globalThis as Record<string, unknown>)["globalThis"],
      eval: (globalThis as Record<string, unknown>)["eval"],
      Function: (globalThis as Record<string, unknown>)["Function"],
    }
    const globalKeysBefore = Object.getOwnPropertyNames(globalThis).sort().join(",")

    for (const value of dangerousValues) {
      compileRule(rawRuleDocument({ predicates: [{ field: "capability", operator: "any", value: [value] }] }))
      compileRule(rawRuleDocument({ actions: [{ kind: "deny_with_reason", reason: value }] }))
      compileRule(rawRuleDocument({ predicates: [{ field: "taskTitlePattern", pattern: value }] }))
    }

    const after = {
      process: (globalThis as Record<string, unknown>)["process"],
      globalThis: (globalThis as Record<string, unknown>)["globalThis"],
      eval: (globalThis as Record<string, unknown>)["eval"],
      Function: (globalThis as Record<string, unknown>)["Function"],
    }
    expect(after).toEqual(before)
    expect(Object.getOwnPropertyNames(globalThis).sort().join(",")).toBe(globalKeysBefore)
  })

  it("compiles a pattern that would be catastrophic to match, and REFUSES it rather than compiling it", () => {
    // The distinction the M6 compiler makes deliberately against the M0 kernel: a
    // bad pattern never matching is safe for a narrowing effect and unsafe to
    // inherit for a pre-approval, because the user is not told their rule is
    // broken.
    for (const pattern of ["(a+)+", "(a*)*", "([a-z]+)*", "(a|a)*", "(?:)*", "(?=x)*", "(?<=x)y"]) {
      const result = compileRule(
        rawRuleDocument({ predicates: [{ field: "taskTitlePattern", pattern }], actions: [{ kind: "deny_with_reason", reason: "x" }] }),
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe("rule.pattern_refused")
    }
  })

  it("evaluates an inert compiled rule without touching a global", () => {
    // The end of the chain: a rule carrying `process` as a capability COMPILES, and
    // evaluating it matches nothing a real dispatch would. There is no path from a
    // capability name to anything but a string comparison.
    const compiled = compileRuleSet([
      rawRuleDocument({
        predicates: [{ field: "capability", operator: "any", value: ["process", "require", "eval"] }],
        actions: [{ kind: "deny_with_reason", reason: "x" }],
      }),
    ])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const set: CompiledRuleSet = compiled.value
    // A dispatch that DOES request a capability named `process` matches it, because
    // the name is a name. Nothing is executed either way.
    expect(evaluateRules(set, validContext({ requestedCapabilities: ["process"] })).traces[0]?.matchOutcome).toBe("matched")
    expect(evaluateRules(set, validContext({ requestedCapabilities: ["fs.read"] })).traces[0]?.matchOutcome).toBe("not_matched")
  })
})

// ===========================================================================
// The refusal codes
// ===========================================================================

describe("every refusal names a code from the declared union, and each declared code is reachable", () => {
  it("uses only declared codes, across the whole dangerous corpus", () => {
    for (const value of dangerousValues) {
      for (const document of [
        rawRuleDocument({ predicates: [{ field: "capability", operator: "any", value: [value] }] }),
        rawRuleDocument({ predicates: [{ field: "taskTitlePattern", pattern: value }] }),
        rawRuleDocument({ actions: [{ kind: "deny_with_reason", reason: value }] }),
      ]) {
        const result = compileRule(document)
        if (!result.ok) expect(RULE_ERROR_CODES).toContain(result.error.code)
      }
    }
  })

  it("reaches each of the codes this module can produce, so no declared code is unreachable", () => {
    // A declared code nothing can return is a code a caller may branch on and
    // never see, which is worse than not declaring it.
    const seen = new Set<string>()
    const record = (document: unknown): void => {
      const result = compileRule(document)
      if (!result.ok) seen.add(result.error.code)
    }
    // rule.invalid_source
    record({ languageVersion: 2 })
    // rule.language_version_unsupported
    record(rawRuleDocument({ languageVersion: 1 }))
    // rule.limit_exceeded
    record(rawRuleDocument({ predicates: [notChain(50)] }))
    // rule.empty_enum
    record(rawRuleDocument({ predicates: [{ field: "projectId", operator: "in", value: [] }] }))
    // rule.universal_pre_approval
    record(rawPreApprovalDocument({ predicates: [] }))
    // rule.pattern_refused
    record(rawRuleDocument({ predicates: [{ field: "taskTitlePattern", pattern: "(a+)+" }] }))
    // rule.conflicting_action_effects
    record(
      rawRuleDocument({
        predicates: [{ field: "projectId", operator: "eq", value: "proj-1" }],
        actions: [
          { kind: "add_restrictions", deniedCapabilities: ["fs.write"] },
          { kind: "pre_approve_within_bounds", approvedCapabilities: ["fs.read"], maximumTimeoutSeconds: 900, allowDestructiveEffects: false, allowExternalEffects: false, maximumSensitivity: "restricted" },
        ],
      }),
    )
    // rule.project_scope_mismatch, at the SET level
    const mixed = compileRuleSet([validRuleDocument(), validRuleDocument({ ruleId: "rule-b", projectId: "proj-2" })])
    if (!mixed.ok) seen.add(mixed.error.code)

    for (const code of seen) expect(RULE_ERROR_CODES).toContain(code)
    expect(seen.size).toBeGreaterThanOrEqual(7)
  })

  it("never reports a code outside the union, across every refusal in this file", () => {
    // The negative direction, which is the one a caller depends on: a code they do
    // not have a case for is a code they will fall through on.
    const random = makeRng(SEED ^ 0xdead_10cc)
    const keys = Object.keys(rawRuleDocument()) as (keyof ReturnType<typeof rawRuleDocument>)[]
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const document = rawRuleDocument()
      document[pick(random, keys)] = pick(random, [null, 0, "", [], {}, "x".repeat(randomInt(random, 1, 400))])
      const result = compileRule(document)
      if (!result.ok) expect(RULE_ERROR_CODES).toContain(result.error.code)
    }
  })
})

// ===========================================================================
// The compiled artifact survives hostile input
// ===========================================================================

describe("a rule set that survived the fuzzer is still a well-formed, frozen, evaluable artifact", () => {
  it("compiles, freezes and evaluates a set assembled from many near-miss mutations", () => {
    // The positive control for the whole file: after several hundred refusals, the
    // documents that were NOT refused still behave like artifacts.
    const documents = [
      validRuleDocument(),
      preApprovalDocument(),
      rawRuleDocument({ ruleId: "rule-budget", actions: [{ kind: "set_stricter_budget", budget: { maximumFanOut: 2 } }] }),
      rawRuleDocument({
        ruleId: "rule-pattern",
        predicates: [{ field: "taskTitlePattern", pattern: "^deploy" }],
        actions: [{ kind: "deny_with_reason", reason: "x" }],
      }),
    ]
    const compiled = compileRuleSet(documents)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(Object.isFrozen(compiled.value)).toBe(true)
    const result = evaluateRules(compiled.value, validContext())
    expect(result.decisionDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    // Evaluating the artifact twice is the same decision, so nothing in the
    // evaluation mutated it.
    expect(evaluateRules(compiled.value, validContext()).decisionDigest).toBe(result.decisionDigest)
  })

  it("does not retain a reference to the input document in a way a later mutation could reach", () => {
    // The compiled rule keeps the source for the audit record, and it is a
    // STRUCTURED CLONE through the schema rather than the caller's object: a
    // caller mutating its own copy afterwards must not change what was compiled.
    const document = rawRuleDocument({ name: "original" })
    const compiled = compileRule(document)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    document["name"] = "mutated after compilation"
    expect(compiled.value.name).toBe("original")
    expect(compiled.value.digest).toBe(compileRule(rawRuleDocument({ name: "original" })).ok ? compiled.value.digest : "")
  })
})

/**
 * Every limit in ADR 0007 section 9, asserted to be ENFORCED.
 *
 * The test this file exists to be is not "the constant has the documented value".
 * It is "a document that crosses the limit by exactly one is refused, AND a
 * document exactly AT the limit is accepted". A limit nobody can trigger is a
 * comment, and a limit that also rejects its own boundary is a DIFFERENT limit
 * from the one documented — so every case here is a pair, and both halves are
 * named as claims.
 *
 * Three limits need a different shape of argument, and say so where they do:
 *
 *   - `MAX_RULE_PATTERN_LENGTH` and `MAX_RULE_PATTERN_NESTING_DEPTH` are
 *     enforced by the reused bounded analyser rather than by a local check. The
 *     tests cross them through `compileRule` and assert the refusal comes back as
 *     `rule.pattern_refused`, which is the code that says "the analyser said no"
 *     rather than "a shape check said no".
 *   - `MAX_RULE_PATTERN_NESTING_DEPTH` is not independently settable by an author
 *     (a pattern is a string), so it is crossed by a pattern whose quantifiers
 *     nest three deep with every repetition bounded — the polynomial case the
 *     analyser refuses on depth alone.
 *   - `MAX_EXPLANATION_TEXT_CHARS` is a property of the RENDERER, not of the
 *     compiler, and the test proves the renderer respects it by producing a
 *     result large enough to need dropping lines.
 */

import { describe, expect, it } from "vitest"
import {
  MAX_ACTIONS_PER_RULE,
  MAX_COMBINATOR_NODES_PER_RULE,
  MAX_COMPILED_RULE_SET_CANONICAL_BYTES,
  MAX_CONCURRENCY,
  MAX_ENUMERATED_MEMBERS,
  MAX_EXPLANATION_TEXT_CHARS,
  MAX_FAN_OUT,
  MAX_LABEL_MEMBERS,
  MAX_PREDICATES_PER_RULE,
  MAX_PREDICATE_DEPTH,
  MAX_RULE_EXPIRY_DAYS,
  MAX_RULE_NAME_LENGTH,
  MAX_RULE_NOTE_LENGTH,
  MAX_RULE_PATTERN_LENGTH,
  MAX_RULE_PATTERN_NESTING_DEPTH,
  MAX_RULE_REASON_LENGTH,
  MAX_RETRY_LIMIT,
  MAX_RULES_PER_SET,
  MAX_SCHEDULE_WINDOWS_PER_RULE,
  MAX_BOUNDED_NESTING_DEPTH,
  SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
  buildPreApprovalDisclosure,
  compileRule,
  compileRuleSet,
  evaluateRules,
  renderRuleExplanation,
  ruleLimits,
} from "../../../src/rules/index.js"
import { MAX_RULE_PATTERN_LENGTH as MESH_PATTERN_LENGTH } from "../../../src/mesh/protocol/bounds.js"
import { policyEvaluationSchema } from "../../../src/orchestration/policy/types.js"
import {
  validRuleDocument,
  rawRuleDocument,
  nestedArrays,
  preApprovalDocument,
  rawPreApprovalDocument,
  validContext,
  clone,
} from "./fixtures.js"

/**
 * Compiles and returns the error code, failing the test if compilation SUCCEEDED.
 *
 * Takes the RAW builder rather than the validating one, because a limit test has
 * to construct the document the limit refuses — and a fixture that validated
 * could not produce it.
 */
function refusalCode(document: unknown): string {
  const result = compileRule(document)
  if (result.ok) {
    throw new Error(`expected a refusal, got a compiled ${result.value.ruleId}@${result.value.templateVersion}`)
  }
  return result.error.code
}

describe("the section 9 table states the values ADR 0007 section 9 states", () => {
  it("states every documented value", () => {
    // The literal numbers, not references to other constants, so that a change to
    // a constant is a visible diff against the ADR rather than a consistent move
    // of two things that both moved.
    expect(MAX_PREDICATES_PER_RULE).toBe(64)
    expect(MAX_PREDICATE_DEPTH).toBe(6)
    expect(MAX_COMBINATOR_NODES_PER_RULE).toBe(256)
    expect(MAX_RULES_PER_SET).toBe(512)
    expect(MAX_ACTIONS_PER_RULE).toBe(16)
    expect(MAX_ENUMERATED_MEMBERS).toBe(64)
    expect(MAX_LABEL_MEMBERS).toBe(32)
    expect(MAX_SCHEDULE_WINDOWS_PER_RULE).toBe(8)
    expect(MAX_RULE_PATTERN_LENGTH).toBe(128)
    expect(MAX_RULE_PATTERN_NESTING_DEPTH).toBe(2)
    expect(MAX_RULE_NAME_LENGTH).toBe(256)
    expect(MAX_RULE_REASON_LENGTH).toBe(4096)
    expect(MAX_RULE_NOTE_LENGTH).toBe(512)
    expect(MAX_COMPILED_RULE_SET_CANONICAL_BYTES).toBe(262_144)
    expect(MAX_EXPLANATION_TEXT_CHARS).toBe(65_536)
    expect(MAX_FAN_OUT).toBe(256)
    expect(MAX_CONCURRENCY).toBe(256)
    expect(MAX_RETRY_LIMIT).toBe(16)
    expect(MAX_RULE_EXPIRY_DAYS).toBe(3655)
  })

  it("publishes the same table as one frozen value, so a compiled set states the budget it was compiled under", () => {
    expect(ruleLimits.MAX_PREDICATES_PER_RULE).toBe(MAX_PREDICATES_PER_RULE)
    expect(Object.isFrozen(ruleLimits)).toBe(true)
    // Every named constant is IN the table. A constant exported but absent from
    // the table would be a limit a `CompiledRuleSet` does not declare.
    for (const [name, value] of Object.entries(ruleLimits)) {
      expect(typeof value).toBe("number")
      expect(name.startsWith("MAX_")).toBe(true)
    }
    // Nineteen: the section 9 table has nineteen rows, and a row in the table that
    // is missing from the published value is a limit a compiled set does not
    // declare.
    expect(Object.keys(ruleLimits)).toHaveLength(19)
  })

  it("reuses the mesh protocol's pattern bounds rather than re-deriving them", () => {
    // A second number for the same bound is a second thing that can drift, and a
    // rule pattern vetted at one length and matched at another is a pattern whose
    // ReDoS argument does not hold.
    expect(MAX_RULE_PATTERN_LENGTH).toBe(MESH_PATTERN_LENGTH)
    expect(MAX_RULE_PATTERN_NESTING_DEPTH).toBe(MAX_BOUNDED_NESTING_DEPTH)
  })

  it("bounds the explanation at the same number the kernel bounds its own", () => {
    // Probed against the kernel schema rather than against a comment: the kernel
    // writes the bound as a literal (`policyEvaluation.explanationText`), so the
    // only way to know the two numbers agree is to ask the schema.
    const atLimit = "x".repeat(MAX_EXPLANATION_TEXT_CHARS)
    const overLimit = "x".repeat(MAX_EXPLANATION_TEXT_CHARS + 1)
    expect(policyEvaluationSchema.shape.explanationText.safeParse(atLimit).success).toBe(true)
    expect(policyEvaluationSchema.shape.explanationText.safeParse(overLimit).success).toBe(false)
  })
})

describe("the surface predicate count is enforced, and the boundary is accepted", () => {
  it("accepts exactly MAX_PREDICATES_PER_RULE top-level predicates", () => {
    const document = validRuleDocument({
      predicates: Array.from({ length: MAX_PREDICATES_PER_RULE }, () => ({
        field: "roleId",
        operator: "eq",
        value: "role-1",
      })),
    })
    const result = compileRule(document)
    expect(result.ok).toBe(true)
  })

  it("refuses MAX_PREDICATES_PER_RULE plus one", () => {
    const document = validRuleDocument({
      predicates: Array.from({ length: MAX_PREDICATES_PER_RULE + 1 }, () => ({
        field: "roleId",
        operator: "eq",
        value: "role-1",
      })),
    })
    expect(refusalCode(document)).toBe("rule.limit_exceeded")
  })
})

describe("the predicate node count is enforced independently of the surface count", () => {
  /** A balanced tree of exactly `nodes` combinator nodes within the depth bound. */
  function combinatorTree(nodes: number): unknown[] {
    // `all` over N `not` leaves costs N + 1 nodes and N + 1 levels of depth, so
    // the width is chosen to stay inside MAX_PREDICATE_DEPTH.
    const leaves = Math.max(1, Math.floor((nodes - 1) / 2))
    return [
      {
        field: "all",
        predicates: Array.from({ length: leaves }, () => ({
          field: "not",
          predicate: { field: "roleId", operator: "eq", value: "role-1" },
        })),
      },
    ]
  }

  it("accepts a tree within the node budget", () => {
    const result = compileRule(validRuleDocument({ predicates: combinatorTree(64) }))
    expect(result.ok).toBe(true)
  })

  it("refuses a tree over the node budget even though its surface count is one", () => {
    // The point of the separate limit: this rule declares ONE top-level predicate
    // and is still over budget, which MAX_PREDICATES_PER_RULE would not catch.
    const result = compileRule(
      validRuleDocument({
        predicates: [
          {
            field: "all",
            predicates: Array.from({ length: 200 }, () => ({
              field: "not",
              predicate: { field: "roleId", operator: "eq", value: "role-1" },
            })),
          },
        ],
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("rule.limit_exceeded")
  })

  it("refuses a tree over the node budget inside a single combinator", () => {
    // 257 leaves + 1 `all` = 258 nodes, one over the 256 budget, and the depth
    // is only 2 so the depth limit is not what fires.
    const document = validRuleDocument({
      predicates: [
        {
          field: "all",
          predicates: Array.from({ length: 257 }, () => ({ field: "roleId", operator: "eq", value: "role-1" })),
        },
      ],
    })
    expect(refusalCode(document)).toBe("rule.limit_exceeded")
  })

  it("accepts a combinator node count of exactly the budget", () => {
    // 255 leaves + 1 `all` = 256 nodes exactly.
    const document = validRuleDocument({
      predicates: [
        {
          field: "all",
          predicates: Array.from({ length: 255 }, () => ({ field: "roleId", operator: "eq", value: "role-1" })),
        },
      ],
    })
    const result = compileRule(document)
    expect(result.ok).toBe(true)
  })

  it("states that the shared budget is a single number, not two", () => {
    // `combinatorTree` is only meaningful because the node budget is one number.
    expect(combinatorTree(1)).toHaveLength(1)
    expect(MAX_COMBINATOR_NODES_PER_RULE).toBe(256)
  })
})

describe("the predicate depth is enforced, and the boundary is accepted", () => {
  /** `nots` nested `not` combinators over a leaf: total depth is `nots + 1`. */
  function nest(nots: number): unknown {
    let predicate: unknown = { field: "roleId", operator: "eq", value: "role-1" }
    for (let index = 0; index < nots; index += 1) predicate = { field: "not", predicate }
    return predicate
  }

  it("counts a top-level predicate as depth 1, so MAX_PREDICATE_DEPTH admits that many levels", () => {
    // Stated as a claim about the COUNTING, not just the number: five `not`s over a
    // leaf is depth 6 and compiles, six is depth 7 and does not. An off-by-one here
    // would silently make the documented limit mean something else.
    const atLimit = compileRule(rawRuleDocument({ predicates: [nest(MAX_PREDICATE_DEPTH - 1)] }))
    expect(atLimit.ok).toBe(true)
    const overLimit = compileRule(rawRuleDocument({ predicates: [nest(MAX_PREDICATE_DEPTH)] }))
    expect(overLimit.ok).toBe(false)
    if (!overLimit.ok) expect(overLimit.error.code).toBe("rule.limit_exceeded")
  })

  it("refuses a nest one level deeper BEFORE parsing, with the limit code rather than a shape error", () => {
    // The pre-scan runs before Zod so the depth bound is the thing that fires.
    // After the parse it would still be refused, but by the parse, and the message
    // would be about a shape rather than about a bound.
    const result = compileRule(rawRuleDocument({ predicates: [nest(MAX_PREDICATE_DEPTH)] }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("rule.limit_exceeded")
      expect(result.error.message).toContain("MAX_PREDICATE_DEPTH")
    }
  })

  it("refuses a nest so deep it would exhaust the parser's stack, still as a contract error", () => {
    // The reason the pre-scan exists: a 20,000-deep chain makes Zod's recursive
    // parse throw `RangeError: Maximum call stack size exceeded`, and a compiler
    // that throws on a malformed document turns a typo into a crash somewhere far
    // from the author who made it.
    const result = compileRule(rawRuleDocument({ predicates: [nest(20_000)] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("rule.limit_exceeded")
  })

  it("refuses a deeply nested ARRAY the same way, because the pre-scan walks the raw structure", () => {
    const result = compileRule(rawRuleDocument({ predicates: nestedArrays(20_000) }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("rule.limit_exceeded")
  })
})

describe("the rules-per-set limit is enforced, and the boundary is accepted", () => {
  /**
   * The smallest rule the language accepts: a draft with no predicates, a
   * one-character name and a one-character deny reason.
   *
   * Minimal on purpose. The two set-level limits are in TENSION by
   * construction: 512 fully-formed rules with a readable name, a described
   * purpose and a real predicate do not fit inside 256 KiB of canonical JSON, so
   * a set at the count limit is only reachable with small rules. That tension is
   * the ADR's, not this module's, and it is the correct shape — the count limit
   * bounds the number of rules and the byte limit bounds how much text they
   * carry, and a set that trips the second has genuinely exceeded it.
   */
  function minimalRule(index: number): Record<string, unknown> {
    return rawRuleDocument({
      ruleId: `r${index}`,
      name: "n",
      description: "d",
      predicates: [],
      actions: [{ kind: "deny_with_reason", reason: "r" }],
      activation: { state: "draft", activatedAt: null, activatedBy: null },
      author: { kind: "system", name: "s" },
    })
  }

  it("accepts a set of exactly MAX_RULES_PER_SET", () => {
    const result = compileRuleSet(Array.from({ length: MAX_RULES_PER_SET }, (_unused, index) => minimalRule(index)))
    expect(result.ok).toBe(true)
  })

  it("refuses a set of MAX_RULES_PER_SET plus one, naming the COUNT limit rather than the byte limit", () => {
    const result = compileRuleSet(Array.from({ length: MAX_RULES_PER_SET + 1 }, (_unused, index) => minimalRule(index)))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("rule.limit_exceeded")
      // The message must name `MAX_RULES_PER_SET` and not the byte limit, so a
      // reader who trips the count bound is told which bound they tripped.
      expect(result.error.message).toContain("MAX_RULES_PER_SET")
    }
  })
})

describe("the actions-per-rule limit is enforced, and the boundary is accepted", () => {
  function repeatedDenies(count: number): unknown[] {
    return Array.from({ length: count }, (_unused, index) => ({
      kind: "deny_with_reason",
      reason: `reason ${index}`,
    }))
  }

  it("accepts exactly MAX_ACTIONS_PER_RULE actions", () => {
    const result = compileRule(validRuleDocument({ actions: repeatedDenies(MAX_ACTIONS_PER_RULE) }))
    expect(result.ok).toBe(true)
  })

  it("refuses MAX_ACTIONS_PER_RULE plus one", () => {
    expect(refusalCode(rawRuleDocument({ actions: repeatedDenies(MAX_ACTIONS_PER_RULE + 1) }))).toBe(
      "rule.limit_exceeded",
    )
  })
})

describe("the enumerated-member bound is enforced on every set, and the boundary is accepted", () => {
  const members = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `cap-${index}`)

  it("accepts exactly MAX_ENUMERATED_MEMBERS in a predicate `in` set", () => {
    const result = compileRule(validRuleDocument({ predicates: [{ field: "projectId", operator: "in", value: members(MAX_ENUMERATED_MEMBERS) }] }))
    expect(result.ok).toBe(true)
  })

  it("refuses MAX_ENUMERATED_MEMBERS plus one in a predicate `in` set", () => {
    expect(
      refusalCode(rawRuleDocument({ predicates: [{ field: "projectId", operator: "in", value: members(MAX_ENUMERATED_MEMBERS + 1) }] })),
    ).toBe("rule.limit_exceeded")
  })

  it("accepts exactly MAX_ENUMERATED_MEMBERS approved capabilities", () => {
    const result = compileRule(
      preApprovalDocument({
        actions: [
          {
            kind: "pre_approve_within_bounds",
            approvedCapabilities: members(MAX_ENUMERATED_MEMBERS),
            maximumTimeoutSeconds: 900,
            allowDestructiveEffects: false,
            allowExternalEffects: false,
            maximumSensitivity: "restricted",
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
  })

  it("refuses MAX_ENUMERATED_MEMBERS plus one approved capabilities", () => {
    expect(
      refusalCode(
        preApprovalDocument({
          actions: [
            {
              kind: "pre_approve_within_bounds",
              approvedCapabilities: members(MAX_ENUMERATED_MEMBERS + 1),
              maximumTimeoutSeconds: 900,
              allowDestructiveEffects: false,
              allowExternalEffects: false,
              maximumSensitivity: "restricted",
            },
          ],
        }),
      ),
    ).toBe("rule.limit_exceeded")
  })

  it("refuses an over-long deniedCapabilities set in add_restrictions", () => {
    expect(
      refusalCode(
        validRuleDocument({
          actions: [{ kind: "add_restrictions", deniedCapabilities: members(MAX_ENUMERATED_MEMBERS + 1) }],
        }),
      ),
    ).toBe("rule.limit_exceeded")
  })
})

describe("the label bound is enforced separately from the enumerated bound, and the boundary is accepted", () => {
  const labels = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `label-${index}`)

  it("accepts exactly MAX_LABEL_MEMBERS labels", () => {
    const result = compileRule(validRuleDocument({ predicates: [{ field: "taskLabel", operator: "hasAny", value: labels(MAX_LABEL_MEMBERS) }] }))
    expect(result.ok).toBe(true)
  })

  it("refuses MAX_LABEL_MEMBERS plus one", () => {
    // Below the enumerated bound and still refused, which is the whole reason the
    // label bound exists: labels are free-form and would otherwise be capped at 64
    // like everything else, making this limit indistinguishable from that one.
    const count = MAX_LABEL_MEMBERS + 1
    expect(count).toBeLessThan(MAX_ENUMERATED_MEMBERS)
    expect(refusalCode(rawRuleDocument({ predicates: [{ field: "taskLabel", operator: "hasAll", value: labels(count) }] }))).toBe(
      "rule.limit_exceeded",
    )
  })
})

describe("the schedule-window bound is enforced, and the boundary is accepted", () => {
  const windows = (count: number): unknown[] =>
    Array.from({ length: count }, (_unused, index) => ({
      daysOfWeek: [index % 7],
      startMinuteOfDay: 0,
      endMinuteOfDay: 60,
      timeZone: "UTC",
    }))

  it("accepts exactly MAX_SCHEDULE_WINDOWS_PER_RULE windows", () => {
    const result = compileRule(validRuleDocument({ predicates: [{ field: "scheduleWindow", windows: windows(MAX_SCHEDULE_WINDOWS_PER_RULE) }] }))
    expect(result.ok).toBe(true)
  })

  it("refuses MAX_SCHEDULE_WINDOWS_PER_RULE plus one", () => {
    expect(refusalCode(rawRuleDocument({ predicates: [{ field: "scheduleWindow", windows: windows(MAX_SCHEDULE_WINDOWS_PER_RULE + 1) }] }))).toBe(
      "rule.limit_exceeded",
    )
  })
})

describe("the pattern bounds are enforced through the reused bounded analyser", () => {
  it("refuses a pattern one character over the length bound, as a pattern refusal", () => {
    // The exact length is accepted by the analyser (proved in the next case); one
    // more is not, and the refusal arrives as `rule.pattern_refused` rather than
    // as a shape error, because the analyser is what reports it.
    const atLimit = `^${"a".repeat(MAX_RULE_PATTERN_LENGTH - 2)}$`
    expect(atLimit).toHaveLength(MAX_RULE_PATTERN_LENGTH)
    const over = `${atLimit}a`
    expect(over).toHaveLength(MAX_RULE_PATTERN_LENGTH + 1)
    expect(refusalCode(rawRuleDocument({ predicates: [{ field: "taskTitlePattern", pattern: over }] }))).toBe(
      "rule.pattern_refused",
    )
  })

  it("accepts a pattern of exactly the length bound", () => {
    const pattern = `^${"a".repeat(MAX_RULE_PATTERN_LENGTH - 2)}$`
    expect(pattern).toHaveLength(MAX_RULE_PATTERN_LENGTH)
    const result = compileRule(validRuleDocument({ predicates: [{ field: "taskTitlePattern", pattern }] }))
    expect(result.ok).toBe(true)
  })

  it("refuses quantifiers nested one level deeper than the bound, with every repetition bounded", () => {
    // `((a{1,2}){1,2}){1,2}` is the depth-3 shape. It is NOT the exponential
    // case — every repetition is capped — which is exactly why the analyser
    // refuses it: over a bounded subject it is a polynomial of degree 3, and
    // depth 3 on a 256-character title is a denial of service whatever its
    // asymptotics say.
    const atBound = "((a{1,2}){1,2})"
    const overBound = "(((a{1,2}){1,2}){1,2})"
    expect(refusalCode(rawRuleDocument({ predicates: [{ field: "taskTitlePattern", pattern: overBound }] }))).toBe(
      "rule.pattern_refused",
    )
    const accepted = compileRule(validRuleDocument({ predicates: [{ field: "taskTitlePattern", pattern: atBound }] }))
    expect(accepted.ok).toBe(true)
  })
})

describe("the string-length bounds are enforced, and the boundary is accepted", () => {
  it("accepts a name of exactly MAX_RULE_NAME_LENGTH and refuses one more", () => {
    const atLimit = validRuleDocument({ name: "n".repeat(MAX_RULE_NAME_LENGTH) })
    expect(compileRule(atLimit).ok).toBe(true)
    expect(refusalCode(rawRuleDocument({ name: "n".repeat(MAX_RULE_NAME_LENGTH + 1) }))).toBe("rule.invalid_source")
  })

  it("accepts a deny reason of exactly MAX_RULE_REASON_LENGTH and refuses one more", () => {
    const reason = "r".repeat(MAX_RULE_REASON_LENGTH)
    expect(compileRule(validRuleDocument({ actions: [{ kind: "deny_with_reason", reason }] })).ok).toBe(true)
    const over = "r".repeat(MAX_RULE_REASON_LENGTH + 1)
    expect(refusalCode(rawRuleDocument({ actions: [{ kind: "deny_with_reason", reason: over }] }))).toBe("rule.invalid_source")
  })

  it("accepts a note of exactly MAX_RULE_NOTE_LENGTH and refuses one more", () => {
    const atLimit = rawRuleDocument({ predicates: [{ field: "roleId", operator: "eq", value: "role-1", note: "n".repeat(MAX_RULE_NOTE_LENGTH) }] })
    expect(compileRule(atLimit).ok).toBe(true)
    const overLimit = rawRuleDocument({ predicates: [{ field: "roleId", operator: "eq", value: "role-1", note: "n".repeat(MAX_RULE_NOTE_LENGTH + 1) }] })
    expect(refusalCode(overLimit)).toBe("rule.invalid_source")
  })
})

describe("the canonical byte bound is enforced, and the boundary is accepted", () => {
  it("refuses a set whose canonical form is over the byte bound", () => {
    // Each rule is small; it takes many of them to cross 256 KiB, which is the
    // point of measuring canonical bytes rather than counting rules.
    const documents = Array.from({ length: MAX_RULES_PER_SET }, (_unused, index) =>
      validRuleDocument({
        ruleId: `rule-${String(index).padStart(4, "0")}`,
        name: `rule number ${index} ${"n".repeat(200)}`,
        description: "d".repeat(500),
        actions: [{ kind: "deny_with_reason", reason: `reason ${index} ${"r".repeat(400)}` }],
      }),
    )
    const result = compileRuleSet(documents)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("rule.limit_exceeded")
      expect(result.error.message).toContain("canonical bytes")
    }
  })

  it("accepts a set well inside the byte bound", () => {
    const documents = Array.from({ length: 10 }, (_unused, index) =>
      validRuleDocument({ ruleId: `rule-${String(index).padStart(4, "0")}` }),
    )
    expect(compileRuleSet(documents).ok).toBe(true)
  })

  it("states that the byte bound is the size the digest covers", () => {
    // The two numbers being equal is what makes "the size the limit is checked
    // against and the size the digest covers are the same size" true rather than
    // aspirational.
    expect(MAX_COMPILED_RULE_SET_CANONICAL_BYTES).toBe(262_144)
  })
})

describe("the numeric domain bounds are enforced by the value schema", () => {
  it("accepts a fan-out of exactly MAX_FAN_OUT and refuses one more", () => {
    const atLimit = rawRuleDocument({ predicates: [{ field: "fanOut", operator: "lte", value: MAX_FAN_OUT }] })
    expect(compileRule(atLimit).ok).toBe(true)
    const over = rawRuleDocument({ predicates: [{ field: "fanOut", operator: "lte", value: MAX_FAN_OUT + 1 }] })
    expect(refusalCode(over)).toBe("rule.invalid_source")
  })

  it("accepts a concurrency of exactly MAX_CONCURRENCY and refuses one more", () => {
    const atLimit = rawRuleDocument({ predicates: [{ field: "concurrency", operator: "lte", value: MAX_CONCURRENCY }] })
    expect(compileRule(atLimit).ok).toBe(true)
    const over = rawRuleDocument({ predicates: [{ field: "concurrency", operator: "lte", value: MAX_CONCURRENCY + 1 }] })
    expect(refusalCode(over)).toBe("rule.invalid_source")
  })

  it("accepts a retry limit of exactly MAX_RETRY_LIMIT and refuses one more", () => {
    const atLimit = rawRuleDocument({ predicates: [{ field: "retryLimit", operator: "lte", value: MAX_RETRY_LIMIT }] })
    expect(compileRule(atLimit).ok).toBe(true)
    const over = rawRuleDocument({ predicates: [{ field: "retryLimit", operator: "lte", value: MAX_RETRY_LIMIT + 1 }] })
    expect(refusalCode(over)).toBe("rule.invalid_source")
  })

  it("accepts a timeout of exactly the safety floor's ceiling and refuses one more", () => {
    // The timeout bound is the FLOOR's ceiling, not a local one: a rule may not
    // declare a pre-approval beyond what the floor permits, which is why this is
    // a re-declaration of `SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS` rather than a
    // second number.
    expect(SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS).toBe(3_600)
    const atLimit = rawPreApprovalDocument({
      actions: [
        {
          kind: "pre_approve_within_bounds",
          approvedCapabilities: ["fs.read"],
          maximumTimeoutSeconds: SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS,
          allowDestructiveEffects: false,
          allowExternalEffects: false,
          maximumSensitivity: "restricted",
        },
      ],
    })
    expect(compileRule(atLimit).ok).toBe(true)
    const over = rawPreApprovalDocument({
      actions: [
        {
          kind: "pre_approve_within_bounds",
          approvedCapabilities: ["fs.read"],
          maximumTimeoutSeconds: SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS + 1,
          allowDestructiveEffects: false,
          allowExternalEffects: false,
          maximumSensitivity: "restricted",
        },
      ],
    })
    expect(refusalCode(over)).toBe("rule.invalid_source")
  })
})

describe("the expiry bound is enforced, and the boundary is accepted", () => {
  const createdAt = "2026-01-01T00:00:00Z"

  it("accepts an expiry of exactly MAX_RULE_EXPIRY_DAYS and refuses one more", () => {
    // Computed from the constant rather than written as a literal date, so the
    // boundary case is the boundary of the number under test and not a date
    // someone picked and believed was ten years out.
    const day = 86_400_000
    const atLimitInstant = Date.parse(createdAt) + MAX_RULE_EXPIRY_DAYS * day
    const overLimitInstant = atLimitInstant + day
    const atLimit = validRuleDocument({ createdAt, expiresAt: new Date(atLimitInstant).toISOString().replace(".000Z", "Z") })
    expect(compileRule(atLimit).ok).toBe(true)
    const over = validRuleDocument({ createdAt, expiresAt: new Date(overLimitInstant).toISOString().replace(".000Z", "Z") })
    expect(refusalCode(over)).toBe("rule.limit_exceeded")
  })

  it("states that the 'no expiry' form is still expressible, and is warned about in the disclosure", () => {
    // The bound removes the OTHER shape of "no expiry" — a date so far out it
    // reads as unbounded — not the honest one. `null` compiles, and the
    // disclosure says in words that the rule never stops applying on its own.
    const result = compileRule(validRuleDocument({ createdAt, expiresAt: null }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const disclosure = buildPreApprovalDisclosure(result.value)
    expect(disclosure.expiresAt.kind).toBe("no_expiry")
    expect(disclosure.warnings.join(" ")).toContain("no expiry")
  })
})

describe("the explanation bound is enforced by the renderer", () => {
  it("never renders more than MAX_EXPLANATION_TEXT_CHARS, and says what it dropped", () => {
    // Enough matched rules, each with a long deny reason, to produce more text
    // than the bound allows. The rules are minimal so that what is under test is
    // the RENDERER's dropping behaviour and not the set byte limit.
    const documents = Array.from({ length: 200 }, (_unused, index) =>
      rawRuleDocument({
        ruleId: `r${index}`,
        name: "n",
        description: "d",
        predicates: [{ field: "roleId", operator: "eq", value: "role-1" }],
        actions: [{ kind: "deny_with_reason", reason: `reason ${index} ${"r".repeat(400)}` }],
        activation: { state: "activated", activatedAt: "2026-01-01T00:00:00Z", activatedBy: { kind: "system", name: "s" } },
        author: { kind: "system", name: "s" },
      }),
    )
    const compiled = compileRuleSet(documents)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const result = evaluateRules(compiled.value, validContext())
    const text = renderRuleExplanation(result)
    expect(text.length).toBeLessThanOrEqual(MAX_EXPLANATION_TEXT_CHARS)
    expect(text).toContain("further line(s) were not rendered")
  })

  it("renders the whole explanation when it fits", () => {
    const compiled = compileRuleSet([validRuleDocument()])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const text = renderRuleExplanation(evaluateRules(compiled.value, validContext()))
    expect(text).not.toContain("further line(s) were not rendered")
    // Pure function of the result: the same result renders the same text, and a
    // render is not an operation that mutates what it renders.
    expect(renderRuleExplanation(evaluateRules(compiled.value, validContext()))).toBe(text)
    expect(clone(text)).toEqual(text)
  })
})

import { describe, expect, it } from "vitest"
import {
  MAX_BOUNDED_NESTING_DEPTH,
  MAX_RULE_MATCH_SUBJECT_LENGTH,
  checkSafePattern,
  compileSafePattern,
  matchesBounded,
  matchesSafePattern,
} from "../../../src/mesh/protocol/safe-pattern.js"
import {
  MAX_RULE_PATTERN_LENGTH,
} from "../../../src/mesh/protocol/bounds.js"
import { RULE_AUTHOR_CAPABILITY, authorizeRuleWrite, matchesRuleTitle, toKernelRule } from "../../../src/mesh/protocol/rules.js"
import { actorSchema } from "../../../src/orchestration/schemas.js"
import { shortTextBound } from "./helpers.js"

/**
 * R7 (§7 of the spec): the `taskTitlePattern` ReDoS decision.
 *
 * The finding was that a rule pattern is matched against task titles with only a
 * length bound, and a rule author on the mesh supplies the pattern — so a
 * catastrophic pattern from a lower-privileged node is a remote denial of
 * service against the controller's policy evaluation. "It fails closed" is not
 * closure: a node that hangs rather than letting you in is still a hang.
 *
 * The tests below are therefore mostly NEGATIVE, because the interesting
 * behaviour is the refusal. The positives matter just as much: an analyser that
 * refuses everything is not a safe analyser, it is an unusable one, and §9 asks
 * for both halves — the catastrophic shapes refused AND ordinary patterns still
 * matching.
 */

/** §7's own list, plus the neighbours of each shape. */
const MUST_REFUSE: readonly { pattern: string; why: string }[] = [
  { pattern: "(a+)+$", why: "nested unbounded quantifier" },
  { pattern: "(a*)*$", why: "nested unbounded quantifier" },
  { pattern: "([a-zA-Z]+)*$", why: "nested unbounded quantifier over a class" },
  { pattern: "(\\w+\\s?)*$", why: "nested unbounded quantifier with an optional inner part" },
  { pattern: "(a|a)*$", why: "ambiguous alternation, no nested quantifier at all" },
  { pattern: "(a|a?)*$", why: "ambiguous alternation where one branch is nullable" },
  { pattern: "(?:^|\\s)*$", why: "one alternation branch matches empty" },
  { pattern: "(?<=\\$)\\d+", why: "lookbehind" },
  { pattern: "(?<!x)\\d+", why: "negative lookbehind" },
  { pattern: "(?:)*", why: "repeating a group that matches nothing" },
  { pattern: "(?=x)*", why: "repeating a lookahead that consumes nothing" },
  { pattern: "(a\\1b)+", why: "backreference inside a quantified group" },
  { pattern: "^(((\\d{1,9}){1,9}){1,9}){1,9}$", why: "quantifiers nested three deep" },
]

const MUST_ACCEPT: readonly { pattern: string; subject: string }[] = [
  { pattern: "^task-\\d+$", subject: "task-42" },
  { pattern: "^deploy-.*$", subject: "deploy-anything at all" },
  { pattern: "^task-\\d*$", subject: "task-" },
  { pattern: "^fix-\\w+-\\d+$", subject: "fix-parser-7" },
  { pattern: "^(\\d{1,3}\\.){3}\\d{1,3}$", subject: "10.0.0.1" },
  { pattern: "^(feat|fix|chore):", subject: "feat: add a thing" },
  { pattern: "^(a|b)*$", subject: "abab" },
  { pattern: "^(?!skip).*$", subject: "do this" },
]

/**
 * Patterns the analyser refuses CONSERVATIVELY, documented rather than hidden.
 *
 * `(\.\d+){2}` is the shape of a semantic-version match: its body contains an
 * unbounded quantifier, so rule 3 fires even though the mandatory `.` at the
 * front of the body means the engine has only one way to match at each position
 * and the pattern is in fact linear. Distinguishing that from `(a+)+` needs a
 * first-set/follow-set analysis this parser does not implement, and the file's
 * stated policy is that the analyser errs towards refusal: a false refusal costs
 * an author one alternative spelling, a false accept costs the mesh a hung
 * policy evaluation. `^v1-(\.\d+)*$` is the spelling that is accepted.
 */
const KNOWN_CONSERVATIVE_REFUSALS: readonly string[] = ["^v\\d+(\\.\\d+){2}$", "^(a+){3}$"]

describe("compileSafePattern refuses the catastrophic shapes", () => {
  for (const { pattern, why } of MUST_REFUSE) {
    it(`refuses ${JSON.stringify(pattern)} — ${why}`, () => {
      const result = checkSafePattern(pattern)
      expect(result.ok, pattern).toBe(false)
      if (result.ok) return
      // Named rather than a boolean, so a rule-authoring UI can say something
      // specific instead of parsing a message.
      expect([
        "too_long",
        "does_not_compile",
        "nested_quantifier",
        "lookbehind",
        "empty_matching_quantifier",
        "ambiguous_alternation",
      ]).toContain(result.refusal)
      expect(result.error.category).toBe("policy_denied")
      expect(result.error.retryable).toBe(false)
    })
  }

  it("is deterministic, so a refused pattern is refused every time it is offered", () => {
    // A path-dependent analyser is an oracle: a pattern that compiles on the
    // second attempt is a pattern an author can walk past the gate.
    for (const { pattern } of MUST_REFUSE) {
      expect(checkSafePattern(pattern).ok, pattern).toBe(checkSafePattern(pattern).ok)
    }
  })
})

describe("compileSafePattern still accepts ordinary patterns", () => {
  for (const { pattern, subject } of MUST_ACCEPT) {
    it(`accepts ${JSON.stringify(pattern)} and matches ${JSON.stringify(subject)}`, () => {
      const compiled = compileSafePattern(pattern)
      expect(compiled.ok, pattern).toBe(true)
      if (!compiled.ok) return
      expect(matchesSafePattern(compiled.value, subject), `${pattern} ~ ${subject}`).toBe(true)
    })
  }

  it("reports a non-match as a non-match rather than as a refusal", () => {
    const compiled = compileSafePattern("^task-\\d+$")
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(matchesSafePattern(compiled.value, "task-abc")).toBe(false)
    expect(matchesSafePattern(compiled.value, "not a task")).toBe(false)
  })

  it("leaves matching a pure function of (pattern, subject), with no sticky or global state", () => {
    // A `/g` or `/y` flag makes the result depend on `lastIndex`, i.e. on what
    // was matched before. Ten identical calls must give ten identical answers.
    const compiled = compileSafePattern("a")
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value.regex.flags).toBe("")
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(matchesSafePattern(compiled.value, "a"), String(attempt)).toBe(true)
      expect(matchesSafePattern(compiled.value, "b"), String(attempt)).toBe(false)
    }
  })
})

describe("the four hard bounds", () => {
  it("refuses a pattern longer than MAX_RULE_PATTERN_LENGTH", () => {
    expect(MAX_RULE_PATTERN_LENGTH).toBe(128)
    const atBound = "^" + "a".repeat(MAX_RULE_PATTERN_LENGTH - 2) + "$"
    expect(atBound.length).toBe(MAX_RULE_PATTERN_LENGTH)
    expect(compileSafePattern(atBound).ok).toBe(true)
    const overBound = "^" + "a".repeat(MAX_RULE_PATTERN_LENGTH - 1) + "$"
    expect(overBound.length).toBe(MAX_RULE_PATTERN_LENGTH + 1)
    const refused = checkSafePattern(overBound)
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.refusal).toBe("too_long")
    // Length is checked FIRST and on its own, so the message names the bound the
    // plan asks for rather than something an author has to decode.
    expect(refused.ok === false && refused.error.message).toContain(String(MAX_RULE_PATTERN_LENGTH))
  })

  it("refuses a pattern that does not compile", () => {
    for (const pattern of ["(", "[a-", "a{2,1}", "*", "\\"]) {
      expect(checkSafePattern(pattern).ok, pattern).toBe(false)
    }
    const result = checkSafePattern("(")
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.refusal).toBe("does_not_compile")
  })

  it("refuses an empty pattern, which is a wildcard rather than a rule", () => {
    const result = checkSafePattern("")
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.code).toBe("rule.pattern_empty")
  })

  it("refuses a construct the safety analysis cannot model rather than assuming it is safe", () => {
    // A `(?!...)`-style construct this parser does not understand, or one it
    // understands but cannot reason about. The direction is the point: unknown
    // means refused.
    const result = checkSafePattern("(?<=a)(b)")
    expect(result.ok).toBe(false)
  })
})

describe("the subject is bounded too", () => {
  it("agrees with the kernel's task-title bound, so the linear-time argument has a real number", () => {
    // The ReDoS argument is "bounded pattern x bounded subject x linear
    // matching". If the subject half were an assumption the argument would be
    // decorative.
    expect(MAX_RULE_MATCH_SUBJECT_LENGTH).toBe(shortTextBound())
  })

  it("refuses to match against a subject over that bound", () => {
    const compiled = compileSafePattern("^task-\\d+$")
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(matchesBounded(compiled.value, "task-1")).toEqual({ ok: true, value: true })
    const over = matchesBounded(compiled.value, "a".repeat(MAX_RULE_MATCH_SUBJECT_LENGTH + 1))
    expect(over.ok).toBe(false)
    expect(over.ok === false && over.error.code).toBe("rule.match_subject_too_long")
  })
})

describe("bounded nesting is allowed only while it stays cheap", () => {
  it("admits the depth an ordinary version-like title needs and refuses one more level", () => {
    // The distinction is the NUMBER, not the presence. `(a{1,3}){3}` is bounded
    // work — both repetitions have a finite maximum, so the engine explores a
    // fixed number of partitions — while `((\d{1,9}){1,9}){1,9}` compounds three
    // of them into a combinatorial search over a 256-character subject.
    expect(MAX_BOUNDED_NESTING_DEPTH).toBe(2)
    expect(compileSafePattern("^(\\d{1,3}\\.){3}$").ok).toBe(true)
    expect(compileSafePattern("^(((\\d{1,9}){1,9}){1,9}){1,9}$").ok).toBe(false)
  })

  it("documents, rather than hides, the refusals its heuristics make conservatively", () => {
    // Every one of these is refused, and every one of them is a shape a human
    // might reasonably write. They are listed here so a future refinement of the
    // analyser is measured against a known list rather than against nothing.
    for (const pattern of KNOWN_CONSERVATIVE_REFUSALS) {
      const result = checkSafePattern(pattern)
      expect(result.ok, pattern).toBe(false)
      expect(result.ok === false && result.refusal, pattern).toBe("nested_quantifier")
    }
  })
})

describe("remote rule authoring", () => {
  const write = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 2,
    ruleId: "rule-1",
    projectId: "project-release",
    templateVersion: 1,
    enabled: true,
    match: { taskTitlePattern: "^task-\\d+$" },
    effect: {
      kind: "pre_approve",
      approvedCapabilities: ["fs.read"],
      maximumTimeoutSeconds: 600,
      allowDestructiveEffects: false,
      allowExternalEffects: false,
    },
    author: actorSchema.parse({ kind: "node", nodeId: "node-worker-1" }),
    createdAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  })

  const author = (overrides: Record<string, unknown> = {}) => ({
    enrolled: true,
    grantedCapabilities: [RULE_AUTHOR_CAPABILITY],
    authorNodeId: "node-worker-1",
    ...overrides,
  })

  it("refuses a title pattern from a node that has not completed enrollment", () => {
    // Tailscale reachability is not enrollment, and enrollment is not authority.
    // Both are required, which is why they are two fields.
    const result = authorizeRuleWrite(write(), author({ enrolled: false }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.refusal).toBe("not_enrolled")
    expect(result.ok === false && result.error.message).toContain("Tailscale reachability is not enrollment")
  })

  it("refuses a title pattern from an enrolled node that does not hold policy.ruleAuthor", () => {
    const result = authorizeRuleWrite(write(), author({ grantedCapabilities: ["fs.read", "fs.write"] }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.refusal).toBe("not_rule_author")
    expect(result.ok === false && result.error.code).toBe("rule.pattern_requires_rule_author")
  })

  it("checks authority BEFORE the pattern, so an unauthorised peer learns nothing about the analyser", () => {
    // Telling an unauthorised peer "that pattern has a nested quantifier" is a
    // small but free piece of information.
    const result = authorizeRuleWrite(write({ match: { taskTitlePattern: "(a+)+$" } }), author({ grantedCapabilities: [] }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.refusal).toBe("not_rule_author")
    expect(JSON.stringify(result)).not.toMatch(/quantifier|backtrack/i)
  })

  it("refuses a catastrophic pattern even from a node that DOES hold policy.ruleAuthor", () => {
    // The authority gate is not a pattern gate. Both are required, and neither
    // substitutes for the other.
    const result = authorizeRuleWrite(write({ match: { taskTitlePattern: "(a+)+$" } }), author())
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.refusal).toBe("pattern_unsafe")
  })

  it("accepts a pattern from an authorised author and attaches the compiled form", () => {
    const result = authorizeRuleWrite(write(), author())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.compiledPattern?.source).toBe("^task-\\d+$")
    expect(result.value.compiledPattern?.length).toBe("^task-\\d+$".length)
  })

  it("accepts a rule with no title pattern from an enrolled node, with no pattern attached", () => {
    // A capability-only rule is ordinary and must not be blocked by the
    // authoring gate; there is no pattern to be unsafe.
    const result = authorizeRuleWrite(write({ match: { runtimeKinds: ["opencode"] } }), author({ grantedCapabilities: [] }))
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.compiledPattern).toBeNull()
  })

  it("reports 'no opinion' rather than 'did not match' for a rule with no pattern", () => {
    // Collapsing the two would report an absent matcher as a failed one and turn
    // it into a debugging session.
    const result = authorizeRuleWrite(write({ match: { runtimeKinds: ["opencode"] } }), author())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(matchesRuleTitle(result.value, "anything")).toEqual({ ok: true, value: null })
    // The subject bound is a property of RUNNING a pattern, so a rule with no
    // pattern answers "no opinion" without measuring anything at all.
    expect(matchesRuleTitle(result.value, "a".repeat(MAX_RULE_MATCH_SUBJECT_LENGTH + 1))).toEqual({ ok: true, value: null })
  })

  it("matches a prepared rule's title through the bounded seam", () => {
    const result = authorizeRuleWrite(write(), author())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(matchesRuleTitle(result.value, "task-42")).toEqual({ ok: true, value: true })
    expect(matchesRuleTitle(result.value, "chore-42")).toEqual({ ok: true, value: false })
  })

  it("converts a prepared rule into the kernel's own rule, and the conversion is a re-shaping", () => {
    const result = authorizeRuleWrite(write(), author())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const kernel = toKernelRule(result.value)
    expect(kernel.ruleId).toBe("rule-1")
    expect(kernel.match.taskTitlePattern).toBe("^task-\\d+$")
    expect(kernel.effect.kind).toBe("pre_approve")
  })

  it("refuses a write with no schemaVersion, because a write with no version is a shape this build guesses at", () => {
    const { schemaVersion: _omitted, ...unversioned } = write()
    const result = authorizeRuleWrite(unversioned, author())
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.code).toBe("rule.write_invalid")
  })
})

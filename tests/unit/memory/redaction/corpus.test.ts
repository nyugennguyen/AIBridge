/**
 * M5.4 — the corpus test. Every case, every expectation.
 *
 * This is the file the M5 gate report cites. It does three things, in this
 * order, and the order matters:
 *
 * 1. **The seeded shapes are valid.** Each fragment-joined secret is re-derived
 *    and checked against the format the rule that catches it claims to
 *    recognise. `corpus.ts` assembles its secrets from parts so that no
 *    credential literal is committed to the repository; the cost of that is
 *    that a typo in a fragment would produce a "true positive" that only passes
 *    because the typo made it match something else. This block is the guard
 *    against that, and it is why the fragments are stored at all.
 * 2. **Every case matches its expectation exactly** — the full sorted rule-id
 *    set, not a superset check, and the status. Exactness is what makes a
 *    `false_positive` case meaningful: a case defined by the rule it wrongly
 *    fires cannot tolerate a superset test, or it could not report one.
 * 3. **No seeded secret appears in any produced outcome**, and re-applying
 *    redaction to any corpus text is a no-op.
 *
 * The last block asserts the corpus is *large enough* to mean something: a
 * corpus of three true positives and no near misses is a corpus that proves
 * only that the patterns compile.
 */

import { describe, expect, it } from "vitest"
import {
  CORPUS_FALSE_POSITIVES,
  CORPUS_NEAR_MISSES,
  CORPUS_POLICY,
  CORPUS_TRUE_POSITIVES,
  PEM_BODY_LINES,
  REDACTION_CORPUS,
  SEEDED_SECRETS,
} from "../../../../src/memory/redaction/corpus.js"
import { DeterministicRedactionPipeline, PROHIBITED_TEXT } from "../../../../src/memory/redaction/pipeline.js"
import { defaultRedactionPolicy } from "../../../../src/memory/redaction/index.js"
import { assertOutcomeCarriesNoSecret } from "./fixtures.js"

const pipeline = new DeterministicRedactionPipeline()

/** What each seeded secret's catching rule claims the format is. */
const SEEDED_SHAPES: readonly { name: string; length: number; pattern: RegExp; why: string }[] = [
  { name: "awsAccessKeyId", length: 20, pattern: /^(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}$/, why: "4-character prefix plus 16 uppercase alphanumerics" },
  { name: "awsSecretAccessKey", length: 40, pattern: /^[A-Za-z0-9/+=]{40}$/, why: "the assignment rule matches exactly 40 characters" },
  { name: "githubClassicPat", length: 40, pattern: /^ghp_[A-Za-z0-9]{36}$/, why: "`ghp_` plus 36 alphanumerics" },
  { name: "githubFineGrainedPat", length: 51, pattern: /^github_pat_[A-Za-z0-9_]{40}$/, why: "`github_pat_` plus 40 URL-safe characters" },
  { name: "slackBotToken", length: 36, pattern: /^xoxb-\d{10}-[A-Za-z0-9-]{20}$/, why: "`xoxb-` plus a team number and a token" },
  { name: "googleApiKey", length: 39, pattern: /^AIza[0-9A-Za-z_-]{35}$/, why: "`AIza` plus exactly 35 characters" },
  { name: "openAiProjectKey", length: 40, pattern: /^sk-proj-[A-Za-z0-9_-]{32}$/, why: "`sk-proj-` plus 32 characters" },
  { name: "openAiLegacyKey", length: 35, pattern: /^sk-[A-Za-z0-9_-]{32}$/, why: "bare `sk-` plus 32 characters" },
  { name: "tailscaleAuthKey", length: 36, pattern: /^tskey-[A-Za-z0-9-]{30}$/, why: "`tskey-` plus 30 characters" },
  { name: "bearerOpaqueToken", length: 47, pattern: /^[A-Za-z0-9._~+/=-]{47}$/, why: "an opaque bearer value" },
  {
    name: "jwt",
    length: 128,
    pattern: /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/,
    why: "three dot-separated base64url segments, the first starting `eyJ`",
  },
  { name: "unclassifiedOpaqueKey", length: 37, pattern: /^[A-Za-z0-9]{37}$/, why: "no recognisable prefix — the catch-all's reason to exist" },
  { name: "dbPasswordValue", length: 15, pattern: /^[a-z0-9-]{15}$/, why: "a human-chosen password, which is why it needs a key name to be found" },
]

describe("the seeded secrets are assembled correctly, not by accident", () => {
  it.each(SEEDED_SHAPES.map((shape) => [shape.name, shape] as const))("%s", (name, shape) => {
    const value = SEEDED_SECRETS[name as keyof typeof SEEDED_SECRETS]
    expect(value, `${name} is missing from the seeded table`).toBeTypeOf("string")
    expect(value.length, `${name} is ${value.length} characters; ${shape.why}`).toBe(shape.length)
    expect(shape.pattern.test(value), `${name} does not match its declared format`).toBe(true)
  })

  it("every seeded secret is distinct, so no case passes on the wrong one", () => {
    const values = Object.values(SEEDED_SECRETS)
    expect(new Set(values).size).toBe(values.length)
  })

  it("the PEM body lines are base64 of a plausible length, not a real key", () => {
    expect(PEM_BODY_LINES.length).toBeGreaterThanOrEqual(3)
    for (const line of PEM_BODY_LINES) {
      expect(line).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
      expect(line.length).toBeGreaterThanOrEqual(16)
    }
  })
})

describe("every corpus case matches its expectation", () => {
  it.each(REDACTION_CORPUS.map((corpusCase) => [corpusCase.name, corpusCase] as const))("%s", (name, corpusCase) => {
    const outcome = pipeline.redact(corpusCase.text, CORPUS_POLICY)
    expect(name).toBe(corpusCase.name)
    expect(outcome.status, `status for ${name}`).toBe(corpusCase.expectedStatus)
    // Exact, sorted, and complete. A superset check would let a rule fire that
    // the case does not name, which is precisely the failure a
    // `false_positive` case exists to record.
    expect([...outcome.ruleIds], `rule ids for ${name}`).toEqual([...corpusCase.expectedRuleIds])
    expect(outcome.spanCount, `span count for ${name}`).toBe(outcome.matches.length)
    if (corpusCase.expectedStatus === "prohibited") {
      expect(outcome.text, `a prohibited case must not return storable text`).toBe(PROHIBITED_TEXT)
    }
  })

  it("a documented false positive really does fire, and is not merely labelled as one", () => {
    // The whole point of the `false_positive` kind. If these stopped firing, the
    // corpus would be describing a rule set nobody ships, and the notes would be
    // advertising a precision that does not exist.
    for (const corpusCase of CORPUS_FALSE_POSITIVES) {
      expect(corpusCase.expectedRuleIds.length, `${corpusCase.name} names no rule, so it documents nothing`).toBeGreaterThan(0)
      const outcome = pipeline.redact(corpusCase.text, CORPUS_POLICY)
      expect(outcome.status, `${corpusCase.name} was expected to over-redact`).not.toBe("none")
    }
  })

  it("a documented near miss really does slip through", () => {
    for (const corpusCase of CORPUS_NEAR_MISSES) {
      const outcome = pipeline.redact(corpusCase.text, CORPUS_POLICY)
      expect(outcome.status, `${corpusCase.name} was expected to be missed`).toBe("none")
      expect(outcome.text, `${corpusCase.name} was expected to pass through unchanged`).toBe(corpusCase.text)
    }
  })

  it("a prohibited case's outcome text contains nothing of its input", () => {
    for (const corpusCase of REDACTION_CORPUS.filter((entry) => entry.expectedStatus === "prohibited")) {
      const outcome = pipeline.redact(corpusCase.text, CORPUS_POLICY)
      expect(outcome.text).toBe(PROHIBITED_TEXT)
      for (const token of corpusCase.text.split(/[^A-Za-z0-9_]+/).filter((token) => token.length >= 3)) {
        expect(outcome.text, `${corpusCase.name} echoed ${token}`).not.toContain(token)
      }
    }
  })
})

describe("no produced outcome carries a seeded secret", () => {
  it("sweeps the whole serialized outcome for every case", () => {
    for (const corpusCase of REDACTION_CORPUS) {
      const outcome = pipeline.redact(corpusCase.text, CORPUS_POLICY)
      assertOutcomeCarriesNoSecret(outcome, `the outcome for ${corpusCase.name}`)
    }
  })

  it("sweeps the case text against its seeded material, so a case is really seeded", () => {
    // A "true positive" whose text contains no secret material would pass every
    // other assertion here while testing nothing. Three kinds of seeded
    // material, because there are three ways a case can be a true positive:
    //
    //   a joined secret        the pattern rules
    //   a PEM body line        the armoured block is assembled, so the joined
    //                           table does not cover it
    //   a configured path      the policy-derived mention rules
    //
    // A case outside those three is a case whose text needs its own seed, and
    // this is where that gets noticed.
    const configuredPaths = CORPUS_POLICY.sensitivePaths ?? []
    for (const corpusCase of CORPUS_TRUE_POSITIVES) {
      const joined = Object.values(SEEDED_SECRETS).filter((secret) => corpusCase.text.includes(secret))
      const pemBody = PEM_BODY_LINES.filter((line) => corpusCase.text.includes(line))
      const paths = configuredPaths.filter((path) => corpusCase.text.includes(path))
      expect(
        joined.length + pemBody.length + paths.length,
        `${corpusCase.name} embeds no seeded secret, PEM body, or configured path`,
      ).toBeGreaterThan(0)
    }
  })

  it("sweeps the diagnostic description of a record built from each case", () => {
    for (const corpusCase of REDACTION_CORPUS) {
      const described = pipeline.describe({ memoryId: `mem-corpus-${corpusCase.name}` })
      assertOutcomeCarriesNoSecret({ text: described, ruleIds: [], matches: [], status: "none", spanCount: 0 }, `describe for ${corpusCase.name}`)
    }
  })
})

describe("redaction is stable under reapplication across the whole corpus", () => {
  it.each(REDACTION_CORPUS.map((corpusCase) => [corpusCase.name, corpusCase] as const))("%s", (name, corpusCase) => {
    const once = pipeline.redact(corpusCase.text, CORPUS_POLICY)
    const twice = pipeline.redact(once.text, CORPUS_POLICY)
    // A stored record is rewritten on supersession, re-imported, and re-rendered
    // for a new audience. If redaction were not a fixed point, each of those
    // would grow a marker or a span and the record would be unreadable after a
    // handful of rewrites.
    expect(twice.text, `re-applying redaction to ${name} changed the text`).toBe(once.text)
  })
})

describe("the corpus is large enough to mean something", () => {
  it("covers at least twelve true positives", () => {
    expect(CORPUS_TRUE_POSITIVES.length).toBeGreaterThanOrEqual(12)
  })

  it("documents at least eight false positives and near misses", () => {
    expect(CORPUS_FALSE_POSITIVES.length + CORPUS_NEAR_MISSES.length).toBeGreaterThanOrEqual(8)
    // And both kinds, because a corpus of only missed secrets or only over-firing
    // rules measures half the property.
    expect(CORPUS_FALSE_POSITIVES.length).toBeGreaterThanOrEqual(4)
    expect(CORPUS_NEAR_MISSES.length).toBeGreaterThanOrEqual(4)
  })

  it("has unique names, because the gate report cites them", () => {
    const names = REDACTION_CORPUS.map((corpusCase) => corpusCase.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("has a written reason for every case", () => {
    for (const corpusCase of REDACTION_CORPUS) {
      expect(corpusCase.note.length, `${corpusCase.name} has no note`).toBeGreaterThan(40)
    }
  })

  it("declares an expected status consistent with its rule set", () => {
    for (const corpusCase of REDACTION_CORPUS) {
      if (corpusCase.expectedRuleIds.length === 0) {
        expect(corpusCase.expectedStatus, `${corpusCase.name} names no rule but is not 'none'`).toBe("none")
      } else {
        expect(corpusCase.expectedStatus, `${corpusCase.name} names rules but is 'none'`).not.toBe("none")
      }
    }
  })

  it("the catch-all rule is exercised, and is not the most common answer", () => {
    // If `unclassified_high_entropy_token` dominated the corpus the rule set
    // would be a single regex with eleven comments on it, and the specific rules
    // would be untested attribution.
    const all = REDACTION_CORPUS.flatMap((corpusCase) => corpusCase.expectedRuleIds)
    const catchAll = all.filter((ruleId) => ruleId === "unclassified_high_entropy_token").length
    expect(catchAll).toBeGreaterThan(0)
    expect(catchAll).toBeLessThan(all.length / 3)
  })
})

describe("the corpus policy is the shipped policy", () => {
  it("uses the same detector set as defaultRedactionPolicy()", () => {
    // If these drift, the corpus stops describing the rules that ship, and the
    // gate report cites a rule set nobody runs. Compare by rule id, not by
    // identity: `defaultDetectors()` returns fresh instances every call.
    const shipped = defaultRedactionPolicy()
    expect(shipped.detectors.map((detector) => detector.ruleId)).toEqual([...CORPUS_POLICY.detectors].map((detector) => detector.ruleId))
    expect(shipped.replacement).toBe(CORPUS_POLICY.replacement)
  })

  it("uses the same replacement the pipeline defaults to", () => {
    expect(CORPUS_POLICY.replacement).toBe("[REDACTED]")
  })

  it("declares both key and path rules, so both derived detectors are covered", () => {
    expect(CORPUS_POLICY.sensitiveKeys?.length ?? 0).toBeGreaterThan(0)
    expect(CORPUS_POLICY.sensitivePaths?.length ?? 0).toBeGreaterThan(0)
  })

  it("catches every true positive under the shipped default policy too", () => {
    // The corpus runs against its own narrower key and path lists so a case can
    // name a path deliberately. The shipped policy is a superset of those, and
    // this is the assertion that it stays one: a default policy that *missed* a
    // corpus true positive would be shipping a weaker rule set than the
    // evidence file describes.
    const shipped = defaultRedactionPolicy()
    for (const corpusCase of CORPUS_TRUE_POSITIVES) {
      const outcome = pipeline.redact(corpusCase.text, shipped)
      expect(outcome.status, `${corpusCase.name} under the shipped policy`).toBe(corpusCase.expectedStatus)
      for (const ruleId of corpusCase.expectedRuleIds) {
        expect([...outcome.ruleIds], `${corpusCase.name} under the shipped policy`).toContain(ruleId)
      }
    }
  })

  it("a shipped-policy redacted outcome still carries no seeded secret", () => {
    const shipped = defaultRedactionPolicy()
    for (const corpusCase of REDACTION_CORPUS) {
      assertOutcomeCarriesNoSecret(pipeline.redact(corpusCase.text, shipped), `the shipped-policy outcome for ${corpusCase.name}`)
    }
  })
})

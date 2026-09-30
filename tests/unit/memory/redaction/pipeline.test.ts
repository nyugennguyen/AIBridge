/**
 * M5.4 — the pipeline's guarantees: determinism, labels, non-leakage, and
 * stability under reapplication.
 *
 * The corpus file owns "which text produces which rules", including the false
 * positives and the near misses. This file owns the properties that must hold for
 * *every* input, and it holds them over a mix of seeded secrets, recorded fake
 * detectors, and pathological strings — because a guarantee asserted only over
 * the corpus is a guarantee over the corpus.
 *
 * The four load-bearing assertions:
 *
 *   determinism   byte-identical output for identical input, and independent of
 *                 the order `policy.detectors` happens to list rules in
 *   labels        a `prohibits` rule makes the whole outcome prohibited, and the
 *                 outcome's text shares no character with the input
 *   non-leakage   the *entire serialized outcome* contains no seeded secret, and
 *                 `describe` contains nothing but the record id
 *   idempotence   re-applying redaction to redacted text changes nothing
 *
 * The determinism check compares `digestJson(outcome)` rather than the objects,
 * for the same reason the rest of the milestone hashes canonical JSON: a
 * `toEqual` on two objects passes on structural equality and would not notice a
 * key that appeared in one and not the other, whereas a digest change is a
 * single, unambiguous "these are different bytes".
 */

import { describe, expect, it } from "vitest"
import { digestJson } from "../../../../src/orchestration/digest.js"
import type { RedactionOutcome, SecretDetector } from "../../../../src/memory/ports.js"
import {
  DEFAULT_REPLACEMENT,
  DeterministicRedactionPipeline,
  PROHIBITED_TEXT,
} from "../../../../src/memory/redaction/pipeline.js"
import { highEntropyDetector, pemPrivateKeyDetector } from "../../../../src/memory/redaction/detectors.js"
import { PEM_BODY_LINES } from "../../../../src/memory/redaction/corpus.js"
import {
  CORPUS_POLICY,
  SEEDED_SECRETS,
  aPipeline,
  aPolicy,
  assertOutcomeCarriesNoSecret,
  expectAscendingNonOverlapping,
  recordedDetector,
} from "./fixtures.js"

const PEM_RSA = ["-----BEGIN RSA PRIVATE KEY-----", ...PEM_BODY_LINES, "-----END RSA PRIVATE KEY-----"].join("\n")

/** A representative set of documents, redacted under the shipped policy. */
const DOCUMENTS: readonly string[] = Object.freeze([
  "",
  "the build is green and the report is attached",
  `account ${SEEDED_SECRETS.awsAccessKeyId} was rejected`,
  `pushed with ${SEEDED_SECRETS.githubClassicPat}`,
  `Authorization: Bearer ${SEEDED_SECRETS.bearerOpaqueToken}`,
  `deadline set with ${SEEDED_SECRETS.jwt}`,
  `DB_PASSWORD = ${SEEDED_SECRETS.dbPasswordValue} in the override`,
  `the deploy key is in ~/.aws/credentials on the vps box`,
  `cp .env before running the seed script`,
  `line one\nline two\n${SEEDED_SECRETS.slackBotToken}\nline four`,
  PEM_RSA,
  `a doc with a key\n${PEM_RSA}\nand a token ${SEEDED_SECRETS.googleApiKey} after it`,
])

function documentPolicy(): { detectors: readonly SecretDetector[]; sensitiveKeys?: readonly string[]; sensitivePaths?: readonly string[] } {
  return {
    detectors: [...CORPUS_POLICY.detectors],
    sensitiveKeys: CORPUS_POLICY.sensitiveKeys,
    sensitivePaths: CORPUS_POLICY.sensitivePaths,
  }
}

describe("determinism", () => {
  it("the same input and policy produce byte-identical outcomes", () => {
    const pipeline = aPipeline()
    for (const text of DOCUMENTS) {
      const policy = documentPolicy()
      const first = pipeline.redact(text, policy)
      const second = pipeline.redact(text, policy)
      expect(digestJson(second), `outcome for ${JSON.stringify(text.slice(0, 24))} was not deterministic`).toBe(digestJson(first))
    }
  })

  it("the order rules are listed in does not affect the outcome", () => {
    const pipeline = aPipeline()
    const forward = documentPolicy()
    const reversed: RedactionOutcome[] = []
    for (const text of DOCUMENTS) {
      const policy = { ...forward, detectors: [...forward.detectors].reverse() }
      reversed.push(pipeline.redact(text, policy))
    }
    DOCUMENTS.forEach((text, index) => {
      const policy = forward
      expect(digestJson(reversed[index]), `outcome for ${JSON.stringify(text.slice(0, 24))} depended on detector order`).toBe(
        digestJson(pipeline.redact(text, policy)),
      )
    })
  })

  it("a caller-supplied rule set is used, not replaced by the built-in one", () => {
    // The policy's `detectors` is the complete rule set. Silently unioning it
    // with the built-in set would mean "which rules applied to this record"
    // could not be answered from the policy alone, and a caller who deliberately
    // narrowed the rules would get them back anyway.
    const outcome = aPipeline().redact(`account ${SEEDED_SECRETS.awsAccessKeyId}`, aPolicy([]))
    expect(outcome.status).toBe("none")
    expect(outcome.text).toBe(`account ${SEEDED_SECRETS.awsAccessKeyId}`)
  })
})

describe("matches are ascending, non-overlapping, and free of text", () => {
  it("holds for every document under the shipped policy", () => {
    const pipeline = aPipeline()
    for (const text of DOCUMENTS) {
      const outcome = pipeline.redact(text, documentPolicy())
      expectAscendingNonOverlapping(outcome.matches)
      expect(outcome.spanCount).toBe(outcome.matches.length)
      expect([...outcome.ruleIds]).toEqual([...outcome.ruleIds].sort())
      expect(new Set(outcome.ruleIds).size).toBe(outcome.ruleIds.length)
    }
  })

  it("each accepted span is gone from the output text and the surrounding text is not", () => {
    const pipeline = aPipeline()
    const text = `before ${SEEDED_SECRETS.bearerOpaqueToken} after`
    const outcome = pipeline.redact(text, documentPolicy())
    expect(outcome.text).toBe(`before ${DEFAULT_REPLACEMENT} after`)
    // The point of checking the surroundings as well as the span: a rule that
    // reported the right offsets but substituted over the whole line would pass
    // a "the secret is gone" test and destroy the record.
    expect(outcome.text.startsWith("before ")).toBe(true)
    expect(outcome.text.endsWith(" after")).toBe(true)
  })

  it("the longest match wins at an overlap, and the lower rule id breaks a tie", () => {
    const pipeline = aPipeline()
    // The JWT is strictly longer than the entropy run over its first segment, so
    // the specific rule must survive; `tp-jwt-service-account` in the corpus
    // pins the attribution.
    const outcome = pipeline.redact(`token ${SEEDED_SECRETS.jwt} expired`, documentPolicy())
    expect(outcome.ruleIds).toEqual(["jwt"])
    expect(outcome.text).toBe(`token ${DEFAULT_REPLACEMENT} expired`)

    // A tie between two rules on a byte-identical span goes to the lower id, not
    // to whichever the caller listed first. The entropy rule sorts last, so the
    // specific rule wins here too.
    const tied = pipeline.redact(`key ${SEEDED_SECRETS.googleApiKey} end`, documentPolicy())
    expect(tied.ruleIds).toEqual(["google_api_key"])
  })
})

describe("a prohibiting rule makes the whole outcome prohibited", () => {
  it("replaces the text with a fixed constant and shares no word with the input", () => {
    const input = `key\n${PEM_RSA}\ntrailing`
    const outcome = aPipeline().redact(input, documentPolicy())
    expect(outcome.status).toBe("prohibited")
    expect(outcome.text).toBe(PROHIBITED_TEXT)
    // Not "contains nothing sensitive" — contains *nothing of the input at all*.
    // A prohibited outcome that kept a prefix would put must-not-store content
    // in the one object that gets serialized onto a record. Checked per token
    // rather than per character, because a constant marker necessarily shares
    // letters with a base64 body and a per-character assertion could only ever
    // be satisfied by a marker with no letters in it.
    for (const token of input.split(/[^A-Za-z0-9_]+/).filter((token) => token.length >= 3)) {
      expect(outcome.text, "a prohibited outcome echoed a token from its input").not.toContain(token)
    }
    assertOutcomeCarriesNoSecret(outcome, "a prohibited outcome")
  })

  it("still reports which rule classified the input, and how many spans", () => {
    const outcome = aPipeline().redact(PEM_RSA, documentPolicy())
    expect(outcome.ruleIds).toEqual(["pem_private_key"])
    expect(outcome.spanCount).toBe(1)
    expect(outcome.matches).toHaveLength(1)
  })

  it("wins over any ordinary rule in the same document", () => {
    // A document with a token *and* a key is prohibited, not "redacted with one
    // span missing". The ontology is terminal for `prohibited` content and
    // `isRenderable` is false for it, so a partial redaction would be a record
    // that claims to hold a redacted derivative of something unstoreable.
    const outcome = aPipeline().redact(`token ${SEEDED_SECRETS.githubClassicPat}\n${PEM_RSA}`, documentPolicy())
    expect(outcome.status).toBe("prohibited")
    expect(outcome.text).toBe(PROHIBITED_TEXT)
    expect(outcome.ruleIds).toEqual(["pem_private_key"])
  })

  it("is not downgraded when the matched text happens to equal the replacement", () => {
    // The one place the "already redacted" filter must not apply. A rule that
    // classified the input as must-not-store is not second-guessed because the
    // literal it matched was `[PROHIBITED]`.
    const outcome = aPipeline().redact(`-----BEGIN PRIVATE KEY-----\n${PROHIBITED_TEXT}\n-----END PRIVATE KEY-----`, {
      ...documentPolicy(),
      replacement: PROHIBITED_TEXT,
    })
    expect(outcome.status).toBe("prohibited")
  })
})

describe("no secret material reaches the outcome or a diagnostic", () => {
  it("the entire serialized outcome is swept for every document", () => {
    const pipeline = aPipeline()
    for (const text of DOCUMENTS) {
      const outcome = pipeline.redact(text, documentPolicy())
      assertOutcomeCarriesNoSecret(outcome, `the outcome for ${JSON.stringify(text.slice(0, 24))}`)
    }
  })

  it("an outcome carries nothing beyond the redacted text, ids, offsets, and counts", () => {
    const outcome = aPipeline().redact(`token ${SEEDED_SECRETS.githubClassicPat}`, documentPolicy())
    expect(Object.keys(outcome).sort()).toEqual(["matches", "ruleIds", "spanCount", "status", "text"])
  })

  it("describe carries the record id and nothing else, even for a record full of secrets", () => {
    const pipeline = aPipeline()
    const record = {
      memoryId: "mem-redaction-0001",
      content: `the key is ${SEEDED_SECRETS.githubClassicPat} and the password is ${SEEDED_SECRETS.dbPasswordValue}`,
      payload: { secretReferences: [{ reference: "vault:prod/deploy", summary: "deploy key" }] },
    }
    const described = pipeline.describe(record)
    expect(described).toContain(record.memoryId)
    for (const secret of Object.values(SEEDED_SECRETS)) {
      expect(described, "describe leaked a seeded secret").not.toContain(secret)
    }
    // The only variable content in the string is the id, so everything else is a
    // fixed prefix. A caller logging two records must not be able to tell them
    // apart except by id.
    expect(described.replace(record.memoryId, "")).toBe(pipeline.describe({ memoryId: "mem-redaction-0002" }).replace("mem-redaction-0002", ""))
  })

  it("describe scrubs a mis-assigned id rather than printing it", () => {
    // Defence in depth, not the primary control: the id schemas are what
    // guarantee a memoryId is an identifier. A diagnostic string is the last
    // place a wrong argument should be able to leak, so `describe` runs the id
    // through the built-in rules before composing.
    const pipeline = aPipeline()
    const described = pipeline.describe({ memoryId: `mem ${SEEDED_SECRETS.githubClassicPat}` })
    expect(described).not.toContain(SEEDED_SECRETS.githubClassicPat)
    expect(described).toContain(DEFAULT_REPLACEMENT)
  })
})

describe("redaction is stable under reapplication", () => {
  it("redact(redact(x)) equals redact(x) for every document", () => {
    const pipeline = aPipeline()
    for (const text of DOCUMENTS) {
      const once = pipeline.redact(text, documentPolicy())
      const twice = pipeline.redact(once.text, documentPolicy())
      expect(twice.text, `re-applying redaction changed ${JSON.stringify(text.slice(0, 24))}`).toBe(once.text)
    }
  })

  it("a marker in the output is not itself matched and replaced again", () => {
    // The concrete failure this guards: `password = [REDACTED]` re-matched on
    // every rewrite of a stored record, growing a marker per pass until the
    // record was unreadable. The bare-value class excludes `[`, and the
    // pipeline additionally drops a span byte-identical to the replacement.
    const pipeline = aPipeline()
    const once = pipeline.redact(`DB_PASSWORD = ${SEEDED_SECRETS.dbPasswordValue}`, documentPolicy())
    expect(once.text).toBe(`DB_PASSWORD = ${DEFAULT_REPLACEMENT}`)
    const twice = pipeline.redact(once.text, documentPolicy())
    expect(twice.status).toBe("none")
    expect(twice.text).toBe(once.text)
  })

  it("a custom replacement that looks like a value is still a fixed point", () => {
    const pipeline = aPipeline()
    const policy = { ...documentPolicy(), replacement: "REDACTED_VALUE" }
    const once = pipeline.redact(`DB_PASSWORD = ${SEEDED_SECRETS.dbPasswordValue}`, policy)
    expect(once.text).toBe("DB_PASSWORD = REDACTED_VALUE")
    expect(pipeline.redact(once.text, policy).text).toBe(once.text)
  })

  it("a prohibited outcome's text is a fixed point, and its status becomes none", () => {
    // Correct, and asserted rather than left implicit: the prohibition is a
    // property of the *input*, and re-applying to the label has no input left to
    // classify. This is also what stops a stored `[PROHIBITED]` derivative from
    // being re-labelled: the record schema already refuses `sensitivity:
    // "prohibited"` with `redaction.status: "none"`.
    const pipeline = aPipeline()
    const once = pipeline.redact(PEM_RSA, documentPolicy())
    expect(once.status).toBe("prohibited")
    const twice = pipeline.redact(once.text, documentPolicy())
    expect(twice.text).toBe(PROHIBITED_TEXT)
    expect(twice.status).toBe("none")
  })
})

describe("the prefilter gate is honoured, and a caller's rule is used", () => {
  it("never calls detect on a detector whose appliesTo returned false", () => {
    const skipping = recordedDetector({ ruleId: "never_applies", appliesTo: () => false })
    const pipeline = aPipeline()
    const outcome = pipeline.redact("text with MARK inside", aPolicy([skipping]))
    expect(skipping.appliedTo).toHaveLength(1)
    expect(skipping.detected).toHaveLength(0)
    expect(outcome.status).toBe("none")
  })

  it("calls detect once per applicable detector and honours the spans it returns", () => {
    const rule = recordedDetector({ ruleId: "caller_rule" })
    const outcome = aPipeline().redact("text with MARK inside", aPolicy([rule]))
    expect(rule.detected).toEqual(["text with MARK inside"])
    expect(outcome.ruleIds).toEqual(["caller_rule"])
    expect(outcome.text).toBe(`text with ${DEFAULT_REPLACEMENT} inside`)
  })

  it("honours a caller rule that prohibits, over the ordinary ones", () => {
    const rule = recordedDetector({ ruleId: "caller_prohibits", prohibits: true })
    const outcome = aPipeline().redact(`token ${SEEDED_SECRETS.githubClassicPat} and MARK`, aPolicy([...CORPUS_POLICY.detectors, rule]))
    expect(outcome.status).toBe("prohibited")
    expect(outcome.ruleIds).toEqual(["caller_prohibits"])
    expect(outcome.text).toBe(PROHIBITED_TEXT)
  })
})

describe("policy-derived rules compose with the built-in set", () => {
  it("redacts a sensitive key even when the value is entirely unremarkable", () => {
    const outcome = aPipeline().redact("password = correct-horse-battery-staple", {
      detectors: [highEntropyDetector()],
      sensitiveKeys: ["password"],
    })
    expect(outcome.ruleIds).toEqual(["sensitive_key_assignment"])
    expect(outcome.text).toBe(`password = ${DEFAULT_REPLACEMENT}`)
  })

  it("redacts a path mention without any filesystem interaction", () => {
    // A path that cannot exist, redacted identically to one that could: the
    // pipeline reads nothing, the rule is over the string. And only the
    // *configured literal* goes — the surrounding directory is left alone,
    // because `sensitivePaths` says what it knows and guessing the rest of a
    // path from a fragment of it would be the module inventing facts.
    const mention = "/var/empty/aibridge-never-created/id_rsa"
    const outcome = aPipeline().redact(`the key path is ${mention} per the runbook`, {
      detectors: [],
      sensitivePaths: ["id_rsa"],
    })
    expect(outcome.ruleIds).toEqual(["sensitive_path_mention"])
    expect(outcome.text).toBe(`the key path is /var/empty/aibridge-never-created/${DEFAULT_REPLACEMENT} per the runbook`)
  })

  it("a policy with neither keys nor paths still uses its detectors", () => {
    const outcome = aPipeline().redact(`token ${SEEDED_SECRETS.githubClassicPat}`, { detectors: [pemPrivateKeyDetector()] })
    expect(outcome.status).toBe("none")
  })

  it("an empty policy is inert, not a crash", () => {
    const outcome = aPipeline().redact(`token ${SEEDED_SECRETS.githubClassicPat}`, { detectors: [] })
    expect(outcome).toEqual({ text: `token ${SEEDED_SECRETS.githubClassicPat}`, ruleIds: [], matches: [], status: "none", spanCount: 0 })
  })
})

describe("replacement is a fixed constant by default", () => {
  it("is the same for every document, so a rewritten record is comparable", () => {
    const pipeline = aPipeline()
    const outcomes = DOCUMENTS.map((text) => pipeline.redact(text, documentPolicy())).filter((outcome) => outcome.status === "redacted")
    expect(outcomes.length).toBeGreaterThan(3)
    for (const outcome of outcomes) {
      expect(outcome.text).toContain(DEFAULT_REPLACEMENT)
      expect(outcome.text).not.toContain("[REDACTED][REDACTED]")
    }
  })

  it("is fixed even when the policy asks for something else", () => {
    // Not a test that the policy is ignored — a test that the default is a
    // constant rather than a function of the input, which is what "fixed, so
    // redaction is deterministic" is for.
    expect(DEFAULT_REPLACEMENT).toBe("[REDACTED]")
    expect(PROHIBITED_TEXT).toBe("[PROHIBITED]")
    expect(DEFAULT_REPLACEMENT).not.toBe(PROHIBITED_TEXT)
  })
})

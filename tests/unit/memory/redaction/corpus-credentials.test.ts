/**
 * The redaction corpus must not contain a string a credential scanner will
 * accept.
 *
 * ## What happened
 *
 * `fp-url-path-tail` carried a real Slack incoming-webhook URL whose path
 * segments were Slack's own documented placeholders (`T00000000/B00000000`). It
 * was never a credential, and the case exists precisely to assert that a long URL
 * path tail looks like a high-entropy token.
 *
 * GitHub's push protection read it as a live webhook anyway and refused the push
 * with GH013. The scanner is right about the shape and wrong about the intent,
 * and that argument cannot be made from inside a commit. Worse, the scanner works
 * PER COMMIT: fixing the tip was not enough, the string had to leave every commit
 * in the pushed range.
 *
 * So the corpus now uses RFC 2606 reserved domains. These tests exist so the next
 * person to add a realistic-looking fixture finds out here, in milliseconds,
 * instead of at a push that has already been refused.
 */

import { describe, expect, it } from "vitest"
import { REDACTION_CORPUS } from "../../../../src/memory/redaction/corpus.js"
import { defaultDetectors } from "../../../../src/memory/redaction/detectors.js"

/**
 * Hosted webhook URLs — the credential shape that BLOCKED a push.
 *
 * ## Why this list is short, and why it excludes API keys
 *
 * The obvious over-reach here is to forbid every recognisable credential shape
 * from the corpus. That is wrong, and the corpus proves it: `tp-github-pat`,
 * `tp-aws-access-key-id`, `tp-openai-project-key`, `tp-pem-rsa-private-key` and
 * friends are the corpus's *true positives*. A redactor test suite without them
 * has nothing to prove, and they have pushed to this repository many times
 * without a flag -- their values are visibly synthetic (`AKIAIOSFODNN7EXAMPLE`,
 * the key AWS itself prints in its docs).
 *
 * A webhook URL is different in kind. There is no "obviously synthetic" webhook
 * URL: the string IS the credential, the host is real, and anyone holding it can
 * post to a third party's chat. A scanner is right to stop on it, and no value
 * substitution makes a real webhook host safe to commit. So only this class is
 * forbidden, and it is forbidden by SHAPE rather than by the one string we
 * happened to trip.
 *
 * The hostnames are assembled from fragments on purpose: this file must not
 * itself contain a string that push protection would refuse, which is the same
 * mistake it exists to catch.
 */
const SLACK_HOST = ["hooks", "slack", "com"].join(".");
const LIVE_WEBHOOK_URLS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Slack incoming webhook", new RegExp(`https?://${SLACK_HOST.replace(/\./g, "\\.")}/services/`, "i")],
  ["Slack workflow webhook", new RegExp(`https?://${SLACK_HOST.replace(/\./g, "\\.")}/workflows/`, "i")],
  ["Discord webhook", /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\//i],
  ["PagerDuty webhook", /https?:\/\/events\.pagerduty\.com\/integration\//i],
  ["Microsoft Teams webhook", /https?:\/\/[\w.-]*webhook\.office\.com\/webhookb2\//i],
  ["Zapier catch hook", /https?:\/\/hooks\.zapier\.com\/hooks\/catch\/\d+\//i],
]

/** A URL whose host is reserved for documentation. RFC 2606 / RFC 6761. */
const RESERVED_HOST = /\b(?:example\.(?:com|net|org)|[a-z0-9-]+\.(?:example|test|invalid|localhost))\b/i

describe("the redaction corpus carries no pushable credential", () => {
  it("names no live webhook host in any case's text", () => {
    const offenders: string[] = []
    for (const testCase of REDACTION_CORPUS) {
      for (const [label, pattern] of LIVE_WEBHOOK_URLS) {
        if (pattern.test(testCase.text)) {
          offenders.push(`${testCase.name}: matches ${label}`)
        }
      }
    }
    expect(
      offenders,
      "These corpus fixtures would be caught by GitHub push protection and would " +
        "block a push. Replace the vendor host with a reserved documentation " +
        "domain; the shape the case tests is unaffected.",
    ).toEqual([])
  })

  it("still carries its API-key true positives, which must not be 'fixed' away", () => {
    // The guard on the guard. A future reader who sees the rule above may
    // reasonably conclude the corpus should stop containing credential shapes at
    // all. It must not: these cases are what the redactor is proven against.
    const names = REDACTION_CORPUS.map((testCase) => testCase.name)
    for (const required of [
      "tp-github-classic-pat",
      "tp-aws-access-key-id",
      "tp-openai-project-key",
      "tp-pem-rsa-private-key",
    ]) {
      expect(names, `${required} is a true positive and must remain`).toContain(required)
    }
  })

  it("uses a reserved documentation domain for every URL in a case", () => {
    // Not every case has a URL, and not every URL needs to be reserved -- but a
    // fixture pointing at a real host is asking for a 3am surprise.
    const hosts = new Set<string>()
    for (const testCase of REDACTION_CORPUS) {
      for (const match of testCase.text.matchAll(/https?:\/\/([^/\s:@]+)/g)) {
        hosts.add(match[1]!.toLowerCase())
      }
    }

    const unexpected = [...hosts].filter((host) => !RESERVED_HOST.test(host))
    expect(
      unexpected,
      "Point fixture URLs at a reserved domain (example.com, example.test, " +
        "example.invalid, localhost) rather than a host that exists.",
    ).toEqual([])
  })
})

describe("the corpus still tests what it tested", () => {
  it("fp-url-path-tail still fires the high-entropy rule", () => {
    // The reserved-domain swap must not have quietly disarmed the case: this is
    // the assertion that would have caught "fixed" the fixture into uselessness.
    const testCase = REDACTION_CORPUS.find((c) => c.name === "fp-url-path-tail")
    expect(testCase, "the case must still exist").toBeDefined()

    const hits = defaultDetectors().flatMap((detector) =>
      detector.detect(testCase!.text).map((match) => detector.ruleId),
    )
    expect(hits, "the long URL path tail must still be classified").toContain(
      "unclassified_high_entropy_token",
    )
  })

  it("nm-slack-webhook-short-path is still a near miss, not a detection", () => {
    // The sibling case: a SHORT path stays under the entropy minimum. If the
    // domain swap made this one fire, the pair would no longer demonstrate that
    // recall is a function of how much random text the issuer put in it.
    const testCase = REDACTION_CORPUS.find((c) => c.name === "nm-slack-webhook-short-path")
    expect(testCase, "the case must still exist").toBeDefined()

    const hits = defaultDetectors().flatMap((detector) =>
      detector.detect(testCase!.text).map((match) => detector.ruleId),
    )
    expect(hits, "a short path must stay below the entropy minimum").toEqual([])
  })
})
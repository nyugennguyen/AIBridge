/**
 * M5.4 — the detector table, asserted rule by rule.
 *
 * Three properties matter here, and only one of them is "does it fire".
 *
 * 1. **Each rule fires on its own shape**, and reports the rule id and the exact
 *    span. A rule that fires on the wrong span is worse than a rule that does
 *    not fire, because the span is what the pipeline deletes — a rule that
 *    reports offsets one character short leaves a character of a credential in
 *    a stored record, and no test of "did it match" would notice.
 * 2. **`appliesTo` is a superset of `detect`.** The frozen port calls it "a
 *    cheap pre-filter", and a pre-filter that is *narrower* than the pattern is
 *    an invisible false-negative generator: tightening it for performance is a
 *    one-character edit with no failing test. Every rule is checked against a
 *    spread of inputs, asserting `detect` non-empty implies `appliesTo` true.
 * 3. **A detector cannot return what it matched.** The port enforces it by
 *    shape; this file enforces it by sweeping the rendered matches for the
 *    seeded literals, so a future `RedactionMatch` field cannot be added
 *    quietly.
 *
 * The corpus's *cross-rule* behaviour — attribution, overlap, false positives,
 * near misses — is in `corpus.test.ts`, not here.
 */

import { describe, expect, it } from "vitest"
import {
  AUTHORIZATION_BEARER_RULE,
  AWS_ACCESS_KEY_ID_RULE,
  AWS_SECRET_ACCESS_KEY_RULE,
  BUILTIN_RULE_IDS,
  DEFAULT_MINIMUM_HIGH_ENTROPY_LENGTH,
  GITHUB_TOKEN_RULE,
  GOOGLE_API_KEY_RULE,
  HIGH_ENTROPY_RULE,
  JWT_RULE,
  OPENAI_STYLE_KEY_RULE,
  PEM_PRIVATE_KEY_RULE,
  SENSITIVE_KEY_ASSIGNMENT_RULE,
  SENSITIVE_PATH_MENTION_RULE,
  SLACK_TOKEN_RULE,
  TAILSCALE_AUTH_KEY_RULE,
  authorizationBearerDetector,
  awsAccessKeyIdDetector,
  awsSecretAccessKeyDetector,
  createSensitiveKeyDetector,
  createSensitivePathDetector,
  defaultDetectors,
  githubTokenDetector,
  googleApiKeyDetector,
  highEntropyDetector,
  jwtDetector,
  openAiStyleKeyDetector,
  pemPrivateKeyDetector,
  slackTokenDetector,
  tailscaleAuthKeyDetector,
} from "../../../../src/memory/redaction/detectors.js"
import type { SecretDetector } from "../../../../src/memory/ports.js"
import { PEM_BODY_LINES, SEEDED_SECRETS, expectAscendingNonOverlapping } from "./fixtures.js"

const PEM_RSA = ["-----BEGIN RSA PRIVATE KEY-----", ...PEM_BODY_LINES, "-----END RSA PRIVATE KEY-----"].join("\n")

interface RuleCase {
  readonly detector: SecretDetector
  readonly ruleId: string
  readonly text: string
  /** The exact spans the rule must report, as `text.slice(start, end)`. */
  readonly spans: readonly string[]
}

const RULE_CASES: readonly RuleCase[] = [
  {
    detector: pemPrivateKeyDetector(),
    ruleId: PEM_PRIVATE_KEY_RULE,
    text: `the key was\n${PEM_RSA}\nand the rest of the log follows`,
    spans: [PEM_RSA],
  },
  {
    detector: awsAccessKeyIdDetector(),
    ruleId: AWS_ACCESS_KEY_ID_RULE,
    text: `account ${SEEDED_SECRETS.awsAccessKeyId} is free tier`,
    spans: [SEEDED_SECRETS.awsAccessKeyId],
  },
  {
    detector: awsSecretAccessKeyDetector(),
    ruleId: AWS_SECRET_ACCESS_KEY_RULE,
    // The value only, never the variable name: the stored text must keep the
    // fact that an AWS secret was configured.
    text: `AWS_SECRET_ACCESS_KEY = ${SEEDED_SECRETS.awsSecretAccessKey} pasted`,
    spans: [SEEDED_SECRETS.awsSecretAccessKey],
  },
  {
    detector: githubTokenDetector(),
    ruleId: GITHUB_TOKEN_RULE,
    text: `pushed with ${SEEDED_SECRETS.githubClassicPat} to main`,
    spans: [SEEDED_SECRETS.githubClassicPat],
  },
  {
    detector: githubTokenDetector(),
    ruleId: GITHUB_TOKEN_RULE,
    text: `ci uses ${SEEDED_SECRETS.githubFineGrainedPat} nightly`,
    spans: [SEEDED_SECRETS.githubFineGrainedPat],
  },
  {
    detector: slackTokenDetector(),
    ruleId: SLACK_TOKEN_RULE,
    text: `notify via ${SEEDED_SECRETS.slackBotToken} please`,
    spans: [SEEDED_SECRETS.slackBotToken],
  },
  {
    detector: googleApiKeyDetector(),
    ruleId: GOOGLE_API_KEY_RULE,
    text: `maps 403 with ${SEEDED_SECRETS.googleApiKey}`,
    spans: [SEEDED_SECRETS.googleApiKey],
  },
  {
    detector: openAiStyleKeyDetector(),
    ruleId: OPENAI_STYLE_KEY_RULE,
    text: `router rejected ${SEEDED_SECRETS.openAiProjectKey}`,
    spans: [SEEDED_SECRETS.openAiProjectKey],
  },
  {
    detector: openAiStyleKeyDetector(),
    ruleId: OPENAI_STYLE_KEY_RULE,
    text: `legacy ${SEEDED_SECRETS.openAiLegacyKey} still pinned`,
    spans: [SEEDED_SECRETS.openAiLegacyKey],
  },
  {
    detector: tailscaleAuthKeyDetector(),
    ruleId: TAILSCALE_AUTH_KEY_RULE,
    text: `join with ${SEEDED_SECRETS.tailscaleAuthKey} then handshake`,
    spans: [SEEDED_SECRETS.tailscaleAuthKey],
  },
  {
    detector: authorizationBearerDetector(),
    ruleId: AUTHORIZATION_BEARER_RULE,
    text: `Authorization: Bearer ${SEEDED_SECRETS.bearerOpaqueToken}`,
    spans: [SEEDED_SECRETS.bearerOpaqueToken],
  },
  {
    detector: jwtDetector(),
    ruleId: JWT_RULE,
    text: `deadline set with ${SEEDED_SECRETS.jwt} which expired`,
    spans: [SEEDED_SECRETS.jwt],
  },
  {
    detector: highEntropyDetector(),
    ruleId: HIGH_ENTROPY_RULE,
    text: `the service key ${SEEDED_SECRETS.unclassifiedOpaqueKey} must rotate`,
    spans: [SEEDED_SECRETS.unclassifiedOpaqueKey],
  },
  {
    detector: createSensitiveKeyDetector(["password", "db_password"])!,
    ruleId: SENSITIVE_KEY_ASSIGNMENT_RULE,
    text: `DB_PASSWORD = ${SEEDED_SECRETS.dbPasswordValue} in the override`,
    spans: [SEEDED_SECRETS.dbPasswordValue],
  },
  {
    detector: createSensitivePathDetector(["~/.aws/credentials", ".env"])!,
    ruleId: SENSITIVE_PATH_MENTION_RULE,
    text: `the key is in ~/.aws/credentials on the vps, and .env is local`,
    spans: ["~/.aws/credentials", ".env"],
  },
]

describe("each rule fires on its own shape and reports the exact span", () => {
  it.each(RULE_CASES.map((ruleCase) => [ruleCase.ruleId, ruleCase] as const))("%s", (_ruleId, ruleCase) => {
    const matches = ruleCase.detector.detect(ruleCase.text)
    expectAscendingNonOverlapping(matches)
    expect(matches.map((match) => ruleCase.text.slice(match.start, match.end))).toEqual([...ruleCase.spans])
    expect(matches.every((match) => match.ruleId === ruleCase.ruleId)).toBe(true)
  })

  it("detects every occurrence of a repeated secret, not just the first", () => {
    const text = `first ${SEEDED_SECRETS.slackBotToken} then ${SEEDED_SECRETS.slackBotToken} again`
    const matches = slackTokenDetector().detect(text)
    expectAscendingNonOverlapping(matches)
    expect(matches).toHaveLength(2)
  })

  it("covers every documented GitHub token prefix, not just `ghp_`", () => {
    // Four prefixes plus the fine-grained form. A prefix list that quietly
    // covered three of the four would look complete in review and miss a token
    // class nobody thought to test.
    for (const prefix of ["ghp_", "gho_", "ghs_", "ghu_"]) {
      const token = `${prefix}${"a".repeat(36)}`
      const matches = githubTokenDetector().detect(`pushed with ${token} to main`)
      expectAscendingNonOverlapping(matches)
      expect(matches.map((match) => token)).toEqual([token])
    }
  })

  it("does not treat a short `ghx_` string as a GitHub token", () => {
    expect(githubTokenDetector().detect(`ghx_${"a".repeat(36)}`)).toHaveLength(0)
  })

  it("a private key rule is the only one that prohibits", () => {
    expect(pemPrivateKeyDetector().prohibits).toBe(true)
    const prohibiting = RULE_CASES.filter((ruleCase) => ruleCase.detector.prohibits === true)
    expect(prohibiting.map((ruleCase) => ruleCase.ruleId)).toEqual([PEM_PRIVATE_KEY_RULE])
    // And nothing else in the shipped set, or a future rule added with
    // `prohibits: true` would silently make a whole class of documents
    // unstoreable — which is a decision the corpus, not the detector list,
    // should be making.
    for (const detector of defaultDetectors()) {
      if (detector.ruleId === PEM_PRIVATE_KEY_RULE) continue
      expect(detector.prohibits, `${detector.ruleId} must not prohibit`).toBeUndefined()
    }
  })
})

describe("appliesTo is a superset of detect, never a narrower filter", () => {
  const probes = [
    "",
    "a",
    "nothing interesting here at all",
    // Assembled from a prefix and a body rather than written out, for the same
    // reason `corpus.ts` fragments its seeds: this test file must not be the
    // place a credential literal first appears in the repository.
    ["AKIA", "QZ7M4XPL2NRDK8VT"].join(""),
    "akia lowercase is not a key id",
    "ghp_short",
    "AIza",
    "tskey-",
    "sk-",
    "bearer",
    "eyJ",
    "password",
    "PASSWORD:",
    "~/.aws/credentials",
    ".envrc is a different file",
    "x".repeat(DEFAULT_MINIMUM_HIGH_ENTROPY_LENGTH),
    "aaaaaaaaaa",
    PEM_RSA,
    `multi ${SEEDED_SECRETS.githubClassicPat} and ${SEEDED_SECRETS.jwt} lines`,
  ]

  it.each(defaultDetectors().map((detector) => [detector.ruleId, detector] as const))("%s", (_ruleId, detector) => {
    for (const probe of probes) {
      const matches = detector.detect(probe)
      if (matches.length === 0) continue
      expect(detector.appliesTo(probe), `${detector.ruleId} detected but its prefilter rejected`).toBe(true)
    }
  })

  it("the prefilter is not a performance-only claim: it actually rejects", () => {
    // The converse of a superset test. A prefilter that accepts everything is
    // useless, and the port describes the method as a cheap gate, so this is a
    // contract rather than an optimisation. The probe is deliberately shorter
    // than `DEFAULT_MINIMUM_HIGH_ENTROPY_LENGTH` so the catch-all's length gate
    // is exercised too — a literal prefilter has nothing to say about a string
    // that is too short to contain its pattern.
    const irrelevant = "build green"
    for (const detector of defaultDetectors()) {
      expect(detector.appliesTo(irrelevant), `${detector.ruleId} prefilter never rejects`).toBe(false)
    }
  })
})

describe("a detector reports offsets and nothing else", () => {
  it("no rendered match list contains a seeded secret", () => {
    for (const ruleCase of RULE_CASES) {
      const rendered = JSON.stringify(ruleCase.detector.detect(ruleCase.text))
      for (const secret of Object.values(SEEDED_SECRETS)) {
        expect(rendered, `${ruleCase.ruleId} leaked a seeded secret`).not.toContain(secret)
      }
      for (const line of PEM_BODY_LINES) {
        expect(rendered, `${ruleCase.ruleId} leaked PEM key material`).not.toContain(line)
      }
    }
  })

  it("the shape is exactly three fields, so a fourth cannot be added by accident", () => {
    for (const ruleCase of RULE_CASES) {
      for (const match of ruleCase.detector.detect(ruleCase.text)) {
        expect(Object.keys(match).sort()).toEqual(["end", "ruleId", "start"])
      }
    }
  })
})

describe("the catch-all entropy rule", () => {
  it("honours a configured minimum length", () => {
    const text = "a".repeat(40)
    expect(highEntropyDetector().detect(text)).toEqual([])
    // A single repeated character fails the character-class test, so the probe
    // needs a mixed run to be a fair test of the *length* gate.
    const mixed = "a1".repeat(20)
    expect(highEntropyDetector().detect(mixed)).toHaveLength(1)
    expect(highEntropyDetector({ minimumLength: 16 }).detect(mixed)).toHaveLength(1)
    expect(highEntropyDetector({ minimumLength: 64 }).detect(mixed)).toHaveLength(0)
  })

  it("refuses a run that is not actually mixed", () => {
    // The reason a 32-character single-class identifier is not redacted: the
    // class filter is the only thing separating a secret from a padded label.
    expect(highEntropyDetector().detect("x".repeat(64))).toHaveLength(0)
    expect(highEntropyDetector({ minimumCharacterClasses: 1 }).detect("x".repeat(64))).toHaveLength(1)
  })

  it("refuses a configuration it cannot honour", () => {
    expect(() => highEntropyDetector({ minimumLength: 4 })).toThrow(RangeError)
    expect(() => highEntropyDetector({ minimumLength: 32.5 })).toThrow(RangeError)
    expect(() => highEntropyDetector({ minimumCharacterClasses: 0 })).toThrow(RangeError)
    expect(() => highEntropyDetector({ minimumCharacterClasses: 9 })).toThrow(RangeError)
  })

  it("matches a whole run, not a slice of a longer one", () => {
    // A run longer than the minimum must be reported once, at full length, or
    // the tail of the secret survives redaction.
    const long = "a1b2".repeat(20)
    const matches = highEntropyDetector().detect(`key ${long} end`)
    expectAscendingNonOverlapping(matches)
    expect(matches).toHaveLength(1)
    expect(matches[0].end - matches[0].start).toBe(long.length)
  })
})

describe("rule ids are part of the contract", () => {
  it("every built-in id is unique and all are shipped", () => {
    expect(new Set(BUILTIN_RULE_IDS).size).toBe(BUILTIN_RULE_IDS.length)
    expect(defaultDetectors().map((detector) => detector.ruleId)).toEqual([...BUILTIN_RULE_IDS])
  })

  it("the catch-all sorts after every other built-in id", () => {
    // Load-bearing. Overlap resolution breaks a byte-identical-span tie on the
    // lower `ruleId`, so a rename that moved the catch-all earlier would hand
    // every long token's attribution to the anonymous rule and an operator
    // triaging `MemoryRedaction.ruleIds` would learn nothing. See the
    // `detectors.ts` docblock.
    const others = BUILTIN_RULE_IDS.filter((ruleId) => ruleId !== HIGH_ENTROPY_RULE)
    for (const ruleId of others) {
      expect(ruleId < HIGH_ENTROPY_RULE, `${ruleId} must sort before the catch-all ${HIGH_ENTROPY_RULE}`).toBe(true)
    }
  })

  it("the policy-derived ids are distinct from the built-in ones", () => {
    expect(BUILTIN_RULE_IDS).not.toContain(SENSITIVE_KEY_ASSIGNMENT_RULE)
    expect(BUILTIN_RULE_IDS).not.toContain(SENSITIVE_PATH_MENTION_RULE)
  })
})

describe("the policy-derived key detector", () => {
  it("is absent rather than inert when no keys are configured", () => {
    expect(createSensitiveKeyDetector([])).toBeUndefined()
    expect(createSensitiveKeyDetector([""])).toBeUndefined()
  })

  it("matches a key name case-insensitively, and prefers the longest configured name", () => {
    const detector = createSensitiveKeyDetector(["password", "db_password"])!
    const text = "db_password = hunter2"
    const matches = detector.detect(text)
    expectAscendingNonOverlapping(matches)
    expect(matches).toHaveLength(1)
    expect(text.slice(matches[0].start, matches[0].end)).toBe("hunter2")

    const upper = detector.detect("PASSWORD = hunter2")
    expect(upper).toHaveLength(1)
  })

  it("takes a quoted value whole, and never runs past the closing quote", () => {
    const detector = createSensitiveKeyDetector(["password"])!
    const withDouble = `password = "hunter2" trailing`
    const withSingle = `password = 'hunter2'`
    // The quotes are inside the span: they are delimiters carrying no
    // information, and folding them in keeps the group single-valued. What
    // matters is that `trailing` is *not* part of the match — a rule that ran
    // to end-of-line would redact the sentence around the secret.
    for (const text of [withDouble, withSingle]) {
      const matches = detector.detect(text)
      expectAscendingNonOverlapping(matches)
      expect(matches).toHaveLength(1)
      expect(text.slice(matches[0].start, matches[0].end)).toBe(text.slice(11, 20))
    }
    expect(withDouble).toContain('"hunter2"')
  })

  it("does not match a key that is only a substring of a longer identifier", () => {
    const detector = createSensitiveKeyDetector(["token"])!
    // `api_token` is a different name. A detector that matched it would report a
    // span nobody asked about, and an operator could not tell which rule to add
    // to the policy.
    expect(detector.detect("api_token = abc123")).toHaveLength(0)
    expect(detector.detect("token: abc123")).toHaveLength(1)
  })

  it("does not match a name with no assignment, which is the near-miss corpus case", () => {
    const detector = createSensitiveKeyDetector(["password"])!
    expect(detector.detect("the shared password is hunter2")).toHaveLength(0)
  })
})

describe("the policy-derived path detector redacts mentions, not files", () => {
  it("is absent rather than inert when no paths are configured", () => {
    expect(createSensitivePathDetector([])).toBeUndefined()
    expect(createSensitivePathDetector([""])).toBeUndefined()
  })

  it("matches a listed path wherever it is mentioned", () => {
    const detector = createSensitivePathDetector(["~/.aws/credentials", ".env"])!
    const text = "read ~/.aws/credentials and .env before running"
    const matches = detector.detect(text)
    expectAscendingNonOverlapping(matches)
    expect(matches.map((match) => text.slice(match.start, match.end))).toEqual(["~/.aws/credentials", ".env"])
  })

  it("stops at an identifier character, so `.envrc` and `aws_credentials` are not paths", () => {
    const detector = createSensitivePathDetector([".env", "credentials"])!
    expect(detector.detect("use .envrc here")).toHaveLength(0)
    expect(detector.detect("set aws_credentials=1")).toHaveLength(0)
    // ...and deliberately does not stop at a dot, because `.env.local` is the
    // same secret file with a suffix.
    expect(detector.detect("copy .env.local")).toHaveLength(1)
  })

  it("behaves identically for a path that does not exist on disk", () => {
    // The behavioural proof that nothing here touches the filesystem: a path
    // under a directory that cannot exist is still redacted, because the rule
    // is over the *string*. The corpus's `fp-url-path-tail` sibling shows the
    // same thing for URLs.
    const detector = createSensitivePathDetector(["/nonexistent-aibridge/credentials"])!
    const matches = detector.detect("see /nonexistent-aibridge/credentials for the value")
    expectAscendingNonOverlapping(matches)
    expect(matches).toHaveLength(1)
  })
})

describe("defaultDetectors is a stable, immutable set", () => {
  it("is frozen and returns independent detector instances", () => {
    const first = defaultDetectors()
    expect(Object.isFrozen(first)).toBe(true)
    expect(defaultDetectors()).not.toBe(first)
    // Rules are per-instance regexes with mutable `lastIndex`; two pipelines
    // sharing one instance would share a cursor, which is exactly the class of
    // bug the M5 context assembler is forbidden from having.
    expect(first[0]).not.toBe(defaultDetectors()[0])
  })
})

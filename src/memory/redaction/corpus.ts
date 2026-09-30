/**
 * M5.4 — the seeded-secret and false-positive corpus.
 *
 * This file is the evidence for every claim the redaction pipeline makes, and
 * it is exported from the package (not hidden in `tests/`) because two other
 * milestone deliverables have to cite it: M5.9's isolation audit and the M5
 * gate report. A redaction claim presented without the list of its known
 * failures is not reviewable.
 *
 * # Best-effort means best-effort
 *
 * The milestone plan says "Do not promise perfect automatic secret detection",
 * and this corpus is the reason the sentence is there rather than politeness.
 * It contains three kinds of case and all three are asserted:
 *
 *   `true_positive`  a seeded secret that the rules catch.
 *   `false_positive` a rule that fires on text with no secret in it. **These are
 *                   asserted as firing.** Deleting one because it is annoying
 *                   is the failure mode this file exists to prevent: a detector
 *                   tuned until it stops complaining is a detector that will
 *                   eventually stop catching. Each note says why it is accepted,
 *                   and where the operator's remedy is (a longer
 *                   `minimumLength`, a different key list) rather than a
 *                   narrower regex.
 *   `near_miss`      a real secret the rules do **not** catch. Also asserted,
 *                   as `expectedRuleIds: []`. These are the honest answer to
 *                   "how good is this", and they are the cases an operator
 *                   must be able to see before trusting `status: "none"`.
 *
 * # Why the secrets are assembled from fragments
 *
 * Every seeded secret below is built by joining two or more string fragments,
 * and the case texts interpolate the assembled value. This is deliberate and
 * there are two reasons, both operational:
 *
 * 1. A pasted-in literal `AKIA…` in a repository is a credential to every
 *    secret scanner that runs over this repo — including whatever the CI
 *    already has — and it is a *live-looking* one that will be reported,
 *    triaged, and eventually allow-listed. Assembling from fragments means the
 *    corpus can be committed without arming anyone else's scanner, and without
 *    teaching a future reader to ignore this directory.
 * 2. It forces the shape assertions. `assertSeededShapesAreValid` in
 *    `corpus.test.ts` re-derives the length and charset of every seeded
 *    fragment-joined value, so a typo in a fragment fails the test loudly
 *    instead of producing a "true positive" that the rules only catch because
 *    the typo made it match something else.
 *
 * The fragments are still readable next to each other and the test prints them,
 * so this is obfuscation of *storage*, not of review.
 *
 * # The policy under test
 *
 * `CORPUS_POLICY` is the shipped default. The `near_miss` cases are written so
 * that they fail under it — a corpus that only passes because its policy lists
 * `hunter2` as a key name would be testing the list, not the detectors.
 */

import type { RedactionPolicy } from "../ports.js"
import { SENSITIVE_KEY_ASSIGNMENT_RULE, SENSITIVE_PATH_MENTION_RULE, defaultDetectors } from "./detectors.js"
import { DEFAULT_REPLACEMENT } from "./pipeline.js"

export type RedactionCorpusKind = "true_positive" | "false_positive" | "near_miss"

export interface RedactionCorpusCase {
  /** Stable slug. The gate report cites these. */
  readonly name: string
  readonly kind: RedactionCorpusKind
  readonly text: string
  /**
   * The exact, sorted set of rule ids the pipeline must report.
   *
   * Exact rather than "contains", because a corpus that tolerates extra rules
   * is a corpus that cannot report a false positive: every `false_positive`
   * case is *defined* by the rule it wrongly fires.
   */
  readonly expectedRuleIds: readonly string[]
  readonly expectedStatus: "none" | "redacted" | "prohibited"
  /** Why this case exists. Written for the person who wants to make it go away. */
  readonly note: string
}

// ---------------------------------------------------------------------------
// Seeded secrets
// ---------------------------------------------------------------------------

/**
 * Fragment tables. Joined below; see the module docblock for why.
 *
 * `pemBodyLineFragments` is a hand-written base64 skeleton, not a real key. It
 * only has to be long and mixed enough that the entropy rule would fire on it if
 * the `prohibits` classification did not short-circuit the outcome first — which
 * is the point: the PEM case must show that a prohibited document reports its
 * own rule and not the catch-all. It is fragmented for the same reason as
 * everything else here, so that no recognisable credential string appears
 * contiguously in the repository.
 */
const FRAGMENTS = {
  awsAccessKeyId: ["AKIA", "QZ7M4XPL", "2NRDK8VT"],
  awsSecretAccessKey: ["Zx9Pq2Lm4T", "vB7nKd3WsYf", "1Hq6Rt0WuE5Jc8XaZ", "qP"],
  githubClassicPat: ["ghp_", "A1b2C3d4E5f6G7h8", "I9j0K1l2M3n4O5p6", "Q7r8"],
  githubFineGrainedPat: ["github_pat_", "11ABCDEFG0", "1234567890abcdefghij", "KLMNOPQRST"],
  slackBotToken: ["xoxb-", "2439182736", "-", "Kd8fh3Jkd92fjHs83jdK"],
  googleApiKey: ["AIza", "SyD3kQ9vT2nB7xW1pL0mR4tY6uI8oP2aS", "5C"],
  openAiProjectKey: ["sk-proj-", "T3blbkFJ9dQm2RsL4", "vXcN8pZaW6yH1fG"],
  openAiLegacyKey: ["sk-", "T3blbkFJ9dQm2RsL4", "vXcN8pZaW6yH1fG"],
  tailscaleAuthKey: ["tskey-", "auth-k1Q7Xc9N2", "mP4L8vB6yH3wR5tD"],
  bearerOpaqueToken: ["Zk3nQ7wX2mR9tB4v", "L8yH1cD5pF6gJ0sA", "uE7iO2aN3kM4zX9"],
  jwtHeader: ["eyJhbGciOiJIUzI1NiIs", "InR5cCI6IkpXVCJ9"],
  jwtPayload: ["eyJzdWIiOiJtZW1v", "LTAwMSIsImF1ZCI6", "Im1lbW8tYXBpIn0"],
  jwtSignature: ["SflKxwRJSMeKKF2QT4f", "wpMeJf36POk6yJV_", "adQssw5c"],
  unclassifiedOpaqueKey: ["9f3a2b7cQ7wX2mR9t", "B4vL8yH1cD5pF6gJ0s", "A1"],
  dbPasswordValue: ["brisk-", "otter-", "93v"],
} as const

/** The PEM skeleton, as fragment pairs, joined by `PEM_BODY_LINES` below. */
const pemBodyLineFragments: readonly (readonly string[])[] = [
  ["MIIEowIBAAKC", "AQEAr"],
  ["1m9F3xQ7wX2m", "R9tB4vL8"],
  ["yH1cD5pF6gJ0", "sAuE7iO2"],
  ["aN3kM4zX9pR7", "tB1vC6dE"],
]

function joined(parts: readonly string[]): string {
  return parts.join("")
}

/**
 * The names of the assembled secrets.
 *
 * Declared rather than derived from `keyof typeof FRAGMENTS`: the JWT's three
 * segments are fragments of one secret, so deriving from the fragment table
 * would advertise three names that do not exist and force every reader through
 * an `Exclude`. The invariant is asserted from the other direction in
 * `corpus.test.ts`, which checks the table and the shape list agree.
 */
export type SeededSecretName =
  | "awsAccessKeyId"
  | "awsSecretAccessKey"
  | "bearerOpaqueToken"
  | "dbPasswordValue"
  | "githubClassicPat"
  | "githubFineGrainedPat"
  | "googleApiKey"
  | "jwt"
  | "openAiLegacyKey"
  | "openAiProjectKey"
  | "slackBotToken"
  | "tailscaleAuthKey"
  | "unclassifiedOpaqueKey"

export const SEEDED_SECRETS: Readonly<Record<SeededSecretName, string>> = Object.freeze({
  awsAccessKeyId: joined(FRAGMENTS.awsAccessKeyId),
  awsSecretAccessKey: joined(FRAGMENTS.awsSecretAccessKey),
  githubClassicPat: joined(FRAGMENTS.githubClassicPat),
  githubFineGrainedPat: joined(FRAGMENTS.githubFineGrainedPat),
  slackBotToken: joined(FRAGMENTS.slackBotToken),
  googleApiKey: joined(FRAGMENTS.googleApiKey),
  openAiProjectKey: joined(FRAGMENTS.openAiProjectKey),
  openAiLegacyKey: joined(FRAGMENTS.openAiLegacyKey),
  tailscaleAuthKey: joined(FRAGMENTS.tailscaleAuthKey),
  bearerOpaqueToken: joined(FRAGMENTS.bearerOpaqueToken),
  jwt: `${joined(FRAGMENTS.jwtHeader)}.${joined(FRAGMENTS.jwtPayload)}.${joined(FRAGMENTS.jwtSignature)}`,
  unclassifiedOpaqueKey: joined(FRAGMENTS.unclassifiedOpaqueKey),
  dbPasswordValue: joined(FRAGMENTS.dbPasswordValue),
})

/** Every seeded literal, for the leak sweep. Header/footer armour excluded. */
export const SEEDED_SECRET_LITERALS: readonly string[] = Object.freeze(Object.values(SEEDED_SECRETS))

/**
 * The base64 skeleton of the two PEM cases, exported so the leak sweep can look
 * for it. `SEEDED_SECRET_LITERALS` does not cover it: the armoured block is
 * assembled from `-----BEGIN …`/`-----END …` lines and a body, and an outcome
 * that leaked the *body* while reporting the block as prohibited would be a
 * leak the joined-secret table would not catch.
 */
export const PEM_BODY_LINES: readonly string[] = Object.freeze(pemBodyLineFragments.map(joined))

function pem(kind: string): string {
  return [`-----BEGIN ${kind}-----`, ...PEM_BODY_LINES, `-----END ${kind}-----`].join("\n")
}

const PEM_RSA = pem("RSA PRIVATE KEY")

const PEM_OPENSSH = pem("OPENSSH PRIVATE KEY")

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/** The shipped default rule set. See `index.ts#defaultRedactionPolicy`. */
export const CORPUS_POLICY: RedactionPolicy = Object.freeze({
  detectors: defaultDetectors(),
  sensitiveKeys: Object.freeze([
    "api_key",
    "aws_secret_access_key",
    "db_password",
    "passwd",
    "password",
    "secret",
    "token",
  ]),
  sensitivePaths: Object.freeze([".env", ".npmrc", "id_ed25519", "id_rsa", "secrets.yaml", "~/.aws/credentials"]),
  replacement: DEFAULT_REPLACEMENT,
})

// ---------------------------------------------------------------------------
// True positives
// ---------------------------------------------------------------------------

const TRUE_POSITIVES: readonly RedactionCorpusCase[] = Object.freeze([
  {
    name: "tp-pem-rsa-private-key",
    kind: "true_positive",
    text: `the deploy step failed; the key it printed was\n${PEM_RSA}\nand nothing after it is readable`,
    expectedRuleIds: ["pem_private_key"],
    expectedStatus: "prohibited",
    note: "The only rule that prohibits. A private key has no redacted remainder worth keeping, so the outcome carries no input characters at all.",
  },
  {
    name: "tp-pem-openssh-private-key",
    kind: "true_positive",
    text: `agent pasted\n${PEM_OPENSSH}\ninto the runbook by accident`,
    expectedRuleIds: ["pem_private_key"],
    expectedStatus: "prohibited",
    note: "The optional `(?:[A-Z0-9]+ )?` prefix is what makes OPENSSH, RSA, EC and ENCRYPTED all one rule instead of four that drift apart.",
  },
  {
    name: "tp-aws-access-key-id",
    kind: "true_positive",
    text: `deploy account ${SEEDED_SECRETS.awsAccessKeyId} is in the free tier and should be rotated`,
    expectedRuleIds: ["aws_access_key_id"],
    expectedStatus: "redacted",
    note: "An access key *id* is not a secret value, but it is half of a credential pair and identifies the principal, so it is redacted. Only 20 characters, so the entropy rule does not also claim it.",
  },
  {
    name: "tp-aws-secret-access-key-assignment",
    kind: "true_positive",
    text: `AWS_SECRET_ACCESS_KEY = ${SEEDED_SECRETS.awsSecretAccessKey} was pasted into the compose file`,
    expectedRuleIds: ["aws_secret_access_key"],
    expectedStatus: "redacted",
    note: "Only the value span is redacted, so the stored text still says an AWS secret was configured. That is the plan's 'store references, never values' property, in the shape of the rule.",
  },
  {
    name: "tp-github-classic-pat",
    kind: "true_positive",
    text: `the release job used ${SEEDED_SECRETS.githubClassicPat} to push the tag`,
    expectedRuleIds: ["github_token"],
    expectedStatus: "redacted",
    note: "A 40-character token is also a perfect entropy-rule candidate, so this case is also the test that the ruleId tiebreak credits the specific rule.",
  },
  {
    name: "tp-github-fine-grained-pat",
    kind: "true_positive",
    text: `CI is configured with ${SEEDED_SECRETS.githubFineGrainedPat} for the contents:write scope`,
    expectedRuleIds: ["github_token"],
    expectedStatus: "redacted",
    note: "The fine-grained form has a different prefix and an underscore in its body; both shapes are one rule because a triage list does not benefit from that distinction.",
  },
  {
    name: "tp-slack-bot-token",
    kind: "true_positive",
    text: `the incident channel needs ${SEEDED_SECRETS.slackBotToken} to post the rollback notice`,
    expectedRuleIds: ["slack_token"],
    expectedStatus: "redacted",
    note: "34 characters, so it also collides with the entropy rule; the tiebreak is exercised again.",
  },
  {
    name: "tp-google-api-key",
    kind: "true_positive",
    text: `maps failed with ${SEEDED_SECRETS.googleApiKey}; the quota looks exhausted`,
    expectedRuleIds: ["google_api_key"],
    expectedStatus: "redacted",
    note: "The `AIza` literal is the whole reason this rule can exist at all: 35 characters of base64url is otherwise unclassifiable.",
  },
  {
    name: "tp-openai-project-key",
    kind: "true_positive",
    text: `model router rejected ${SEEDED_SECRETS.openAiProjectKey} as malformed`,
    expectedRuleIds: ["openai_style_key"],
    expectedStatus: "redacted",
    note: "The `sk-proj-` variant, which is what every current key looks like; `sk-ant-` and the bare `sk-` form are the same rule.",
  },
  {
    name: "tp-openai-legacy-key",
    kind: "true_positive",
    text: `legacy adapter still has ${SEEDED_SECRETS.openAiLegacyKey} pinned in its defaults`,
    expectedRuleIds: ["openai_style_key"],
    expectedStatus: "redacted",
    note: "Kept as a separate case because the optional prefix group is exactly the kind of thing that silently stops matching when someone edits the pattern.",
  },
  {
    name: "tp-tailscale-auth-key",
    kind: "true_positive",
    text: `join the mesh with ${SEEDED_SECRETS.tailscaleAuthKey} and re-run the handshake`,
    expectedRuleIds: ["tailscale_auth_key"],
    expectedStatus: "redacted",
    note: "A Tailscale auth key is reusable and grants node enrollment, so it is the highest-consequence credential in this repo's own threat model.",
  },
  {
    name: "tp-authorization-bearer",
    kind: "true_positive",
    text: `Authorization: Bearer ${SEEDED_SECRETS.bearerOpaqueToken}`,
    expectedRuleIds: ["authorization_bearer"],
    expectedStatus: "redacted",
    note: "The value is replaced, the scheme is kept. Leftmost-longest is what stops the bare 48-character token from being matched on its own and leaving the word `Bearer` dangling next to a marker.",
  },
  {
    name: "tp-jwt-service-account",
    kind: "true_positive",
    text: `the context deadline was set with ${SEEDED_SECRETS.jwt} which expired mid-run`,
    expectedRuleIds: ["jwt"],
    expectedStatus: "redacted",
    note: "The JWT span is strictly longer than any of its three segments, so it beats the entropy rule on all three of them. Without the `eyJ` anchor this rule would fire on every dotted identifier in a stack trace.",
  },
  {
    name: "tp-unclassified-opaque-key",
    kind: "true_positive",
    text: `the service key ${SEEDED_SECRETS.unclassifiedOpaqueKey} must be rotated before friday`,
    expectedRuleIds: ["unclassified_high_entropy_token"],
    expectedStatus: "redacted",
    note: "A secret with no recognisable prefix. This is the case the catch-all exists for, and the one that proves it is worth its false-positive rate — without it, this value would be stored verbatim.",
  },
  {
    name: "tp-db-password-assignment",
    kind: "true_positive",
    text: `DB_PASSWORD = ${SEEDED_SECRETS.dbPasswordValue} in the staging compose override`,
    expectedRuleIds: [SENSITIVE_KEY_ASSIGNMENT_RULE],
    expectedStatus: "redacted",
    note: "Purely policy-driven: nothing about the value is remarkable. The rule exists because the deployment already knew the name, which is the strongest signal available and the only one that is not a guess.",
  },
  {
    name: "tp-aws-credentials-mention",
    kind: "true_positive",
    text: `the deploy key is in ~/.aws/credentials on the vps box, per the runbook`,
    expectedRuleIds: [SENSITIVE_PATH_MENTION_RULE],
    expectedStatus: "redacted",
    note: "A *mention*. Nothing is read from disk; the sentence discloses that a credential file exists on a named host, which is reconnaissance on its own.",
  },
  {
    name: "tp-dotenv-mention",
    kind: "true_positive",
    text: `run cp .env.example .env first; the loader reads the working directory`,
    expectedRuleIds: [SENSITIVE_PATH_MENTION_RULE],
    expectedStatus: "redacted",
    note: "`.env` is a four-character string in ordinary prose, and this is the accepted cost of redacting the mention: the file is a secret, and the sentence that names it is worth the false positive.",
  },
  {
    name: "tp-multiple-spans-one-document",
    kind: "true_positive",
    text: [
      `incident run-2026-03-11 summary:`,
      `- aws key ${SEEDED_SECRETS.awsAccessKeyId} was rejected`,
      `- chat notified via ${SEEDED_SECRETS.slackBotToken}`,
      `- mesh join blocked, Authorization: Bearer ${SEEDED_SECRETS.bearerOpaqueToken}`,
    ].join("\n"),
    expectedRuleIds: ["authorization_bearer", "aws_access_key_id", "slack_token"],
    expectedStatus: "redacted",
    note: "Four independent rules, four spans, sorted output. This is the case that would break if overlap resolution were order-dependent rather than sorted, and it is the one the idempotence test re-runs.",
  },
])

// ---------------------------------------------------------------------------
// False positives — asserted to fire, with a stated reason
// ---------------------------------------------------------------------------

const FALSE_POSITIVES: readonly RedactionCorpusCase[] = Object.freeze([
  {
    name: "fp-git-commit-sha",
    kind: "false_positive",
    text: `revert 8f3a2b7c9d1e4f5a6b0c3d2e1f9a8b7c6d5e4f30 in the hotfix branch, it is in the release notes`,
    expectedRuleIds: ["unclassified_high_entropy_token"],
    expectedStatus: "redacted",
    note: "A 40-character hex commit sha is the same shape as a secret and there is no way to tell them apart from the text. Accepted: the remedy is a higher `minimumLength` or a deployment that does not store shas in memory, not a narrower regex.",
  },
  {
    name: "fp-content-sha256-digest",
    kind: "false_positive",
    text: `lockfile digest 3b1f0a9c8e7d6b5a4f3e2d1c0b9a8f7e6d5c4b3a29180f7e6d5c4b3a2918076f5 verified against the registry`,
    expectedRuleIds: ["unclassified_high_entropy_token"],
    expectedStatus: "redacted",
    note: "The classic integrity digest. This is the single most common reason a redaction pipeline gets disabled, and it is why `minimumLength` is configurable rather than fixed.",
  },
  {
    name: "fp-sku-identifier",
    kind: "false_positive",
    text: `inventory sku sk-9f3a2b7c1d4e5f6a8b0c4d has no owning team and is blocking the count`,
    expectedRuleIds: ["openai_style_key"],
    expectedStatus: "redacted",
    note: "An internal stock code that happens to start `sk-`. The alternative is requiring 48 characters, which would miss the truncated key a log line actually carries — the rarer and worse failure.",
  },
  {
    name: "fp-slack-prefix-in-prose",
    kind: "false_positive",
    text: `we documented the xoxb-token-format-in-docs example for new joiners last week`,
    expectedRuleIds: ["slack_token"],
    expectedStatus: "redacted",
    note: "Naming the prefix in a runbook is a false positive the rules cannot avoid without knowing the value's structure. Writing `xox` + a space fixes the prose and does not require weakening the rule.",
  },
  {
    name: "fp-bearer-word-in-prose",
    kind: "false_positive",
    text: `the Bearer credentials were rotated on friday by the platform team, see ticket 4417`,
    expectedRuleIds: ["authorization_bearer"],
    expectedStatus: "redacted",
    note: "The word `Bearer` in a sentence is not a header. Worth keeping visible because it is the false positive most likely to be *fixed* by loosening the value charset, which would then miss short bearer tokens.",
  },
  {
    name: "fp-key-name-in-prose",
    kind: "false_positive",
    text: `the dispatch token: was not accepted by the scheduler on the retry, check the run log`,
    expectedRuleIds: [SENSITIVE_KEY_ASSIGNMENT_RULE],
    expectedStatus: "redacted",
    note: "`token` is a configured sensitive key and this sentence is not a credential. The rule cannot tell a key from a noun; the corpus makes the cost visible instead of hiding it in a tighter pattern.",
  },
  {
    name: "fp-dotenv-example-suffix",
    kind: "false_positive",
    text: `copy .env.example before running the seed script, the template is committed`,
    expectedRuleIds: [SENSITIVE_PATH_MENTION_RULE],
    expectedStatus: "redacted",
    note: "`.env.example` is a template and contains no values, but it is the same directory and a leak of which keys exist. The trailing guard stops `.envrc` and deliberately does not stop `.env.example`.",
  },
  {
    name: "fp-url-path-tail",
    kind: "false_positive",
    text: `post the alert to https://hooks.example.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX please`,
    expectedRuleIds: ["unclassified_high_entropy_token"],
    expectedStatus: "redacted",
    note: "A URL path tail of 32 or more URL-safe characters is one unbroken run, because `/` is in the entropy charset, so every long path looks like a token. The run is cut at the last `.`, which is why only the tail is redacted. This is the false positive that most often gets 'fixed' by dropping `/` from the charset, which then misses every base64 secret containing one.",
  },
])

// ---------------------------------------------------------------------------
// Near misses — real secrets the rules do not catch
// ---------------------------------------------------------------------------

const NEAR_MISSES: readonly RedactionCorpusCase[] = Object.freeze([
  {
    name: "nm-postgres-connection-string",
    kind: "near_miss",
    text: `staging runs postgres://aibridge:hunter2@db.internal:5432/aibridge with connection pool 20`,
    expectedRuleIds: [],
    expectedStatus: "none",
    note: "The highest-consequence gap in this file: a URL-embedded password is a real credential and nothing here matches one. A URL userinfo rule is the obvious addition and is not shipped, because half-remembered URL parsing is its own class of bug.",
  },
  {
    name: "nm-slack-webhook-short-path",
    kind: "near_miss",
    text: `post the alert to https://hooks.example.com/services/T1/B2/xY9 please, it is the staging hook`,
    expectedRuleIds: [],
    expectedStatus: "none",
    note: "A Slack incoming webhook is a credential anyone holding it can post with, and a short path keeps it under the entropy minimum. The sibling case `fp-url-path-tail` shows the same URL with a long tail *is* caught — which is the honest shape of this rule: recall is a function of how much random text the issuer put in it.",
  },
  {
    name: "nm-short-opaque-token",
    kind: "near_miss",
    text: `invite code A1b2C3d4E5f6 expires at midnight, do not forward it`,
    expectedRuleIds: [],
    expectedStatus: "none",
    note: "Twelve characters of mixed case and digits is a real secret that the 32-character entropy minimum is blind to. This is the direct cost of `DEFAULT_MINIMUM_HIGH_ENTROPY_LENGTH` and the reason it is a parameter.",
  },
  {
    name: "nm-already-masked-secret",
    kind: "near_miss",
    text: `the shared key is A1****B2****C3 in the vault export, confirm the rotation ticket`,
    expectedRuleIds: [],
    expectedStatus: "none",
    note: "Upstream masking has broken the run into sub-minimum fragments. Nothing to redact, and the corpus records it so that a future rule which *does* fire on this is understood as a false positive rather than an improvement.",
  },
  {
    name: "nm-pem-without-end-armour",
    kind: "near_miss",
    text: `cat /etc/ssl/private.key\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\ntruncated by the log buffer`,
    expectedRuleIds: [],
    expectedStatus: "none",
    note: "A half-printed key. The PEM rule requires its `END` armoured line and the body is below the entropy minimum, so a truncated key is not classified at all. Patched only by matching any BEGIN marker to end-of-input, which would prohibit every log that helpfully prints one.",
  },
  {
    name: "nm-hyphen-separated-groups",
    kind: "near_miss",
    text: `key groups 4f9c2b1d-8e7a6f5c-3b2a1908 were rotated on the ninth, check the vault log`,
    expectedRuleIds: [],
    expectedStatus: "none",
    note: "A secret broken into 8-character groups defeats the entropy rule, because the whole run including the dashes is 26 characters. Note how much the answer depends on group size: `fp-url-path-tail` shows the same trick with 32 characters of groups is caught. Human-transcribed secrets do not respect a length budget, and no minimum can be both above their length and below a real key's.",
  },
  {
    name: "nm-value-in-prose",
    kind: "near_miss",
    text: `the shared password is hunter2 for the staging box, rotate it after the demo`,
    expectedRuleIds: [],
    expectedStatus: "none",
    note: "The canonical unfixable case. `password` is a configured key but there is no `=` or `:` to anchor on, and requiring one would mean missing every secret a human wrote into a runbook. The corpus states it so `status: \"none\"` is never read as \"clean\".",
  },
])

/** Every case, in the order the gate report prints them. */
export const REDACTION_CORPUS: readonly RedactionCorpusCase[] = Object.freeze([...TRUE_POSITIVES, ...FALSE_POSITIVES, ...NEAR_MISSES])

export const CORPUS_TRUE_POSITIVES: readonly RedactionCorpusCase[] = Object.freeze(TRUE_POSITIVES)
export const CORPUS_FALSE_POSITIVES: readonly RedactionCorpusCase[] = Object.freeze(FALSE_POSITIVES)
export const CORPUS_NEAR_MISSES: readonly RedactionCorpusCase[] = Object.freeze(NEAR_MISSES)

/**
 * M5.4 — pluggable secret detectors.
 *
 * # What this module is and is not
 *
 * This is a *pattern library*. It is not, and the plan forbids it from being
 * presented as, a guarantee. The milestone's Redaction Design section says it
 * directly: "Combine deterministic patterns, configured sensitive paths/keys,
 * and explicit labels. Do not promise perfect automatic secret detection." The
 * reason is not humility — it is that a secret has no mandatory shape. A
 * password chosen by a human is indistinguishable from a word a human chose,
 * and no regex can tell them apart. Everything here is a *best-effort
 * heuristic* whose failure modes are catalogued in `corpus.ts` rather than
 * tuned away, because a detector that stops firing on benign prose by silently
 * tightening its pattern is a detector that will eventually stop firing on a
 * secret too.
 *
 * # Why a detector can never return what it matched
 *
 * `SecretDetector.detect` returns `RedactionMatch` — `ruleId`, `start`, `end`
 * and nothing else. That is enforced by the frozen port in `../ports.ts`, and
 * it is the single most important property of this file: a detector is a
 * function from text to *offsets*, so there is no code path by which matched
 * secret material can reach a log line, a diagnostic, an error message, or a
 * serialized outcome. `tests/unit/memory/redaction/pipeline.test.ts` sweeps the
 * whole serialized `RedactionOutcome` for seeded secret literals to keep this
 * from regressing into "the interface says so".
 *
 * # Overlap and tie-breaking
 *
 * Detectors are independent and overlapping by nature: a GitHub token is also
 * a long high-entropy string, and an `Authorization: Bearer` header is also a
 * JWT. The *pipeline* owns overlap resolution (see `../pipeline.ts`), not this
 * file. What this file guarantees is only that each detector's own output is
 * ascending and non-overlapping, which is what a `while (re.exec(...))` loop
 * gives you for free.
 *
 * # Rule ids
 *
 * Rule ids are part of the persisted contract: they land in
 * `MemoryRedaction.ruleIds` and in an operator's triage queue, so they are
 * stable strings and they are compared lexicographically to break ties
 * deterministically. That has one non-obvious consequence, which is
 * load-bearing and easy to break by renaming:
 *
 *   The catch-all entropy rule is named so that it sorts LAST among the
 *   built-in ids.
 *
 * When two rules produce byte-identical spans — a 39-character `AIza…` key
 * matched by both `google_api_key` and the entropy rule — the pipeline keeps
 * the lower `ruleId`, so the specific rule must sort first or every long token
 * would be reported as an anonymous high-entropy string and an operator
 * triaging `ruleIds` would learn nothing about which credential shape leaked.
 * `unclassified_high_entropy_token` begins with `u`, after every other built-in
 * id. A rename that breaks this silently degrades attribution; the corpus test
 * for the token rules would notice, but the comment is here so the rename is
 * not made blindly.
 *
 * # What a prefilter is allowed to do
 *
 * `SecretDetector.appliesTo` is a cheap gate. It must be a *superset* test:
 * returning `false` for text `detect` would match is a false negative that no
 * amount of pattern tuning elsewhere can recover, and a prefilter is exactly
 * the kind of optimization that gets tightened "just a little" for
 * performance. Every `appliesTo` here is a literal `includes`, a cheap
 * character-class test, or a length comparison.
 */

import type { RedactionMatch, SecretDetector } from "../ports.js"

// ---------------------------------------------------------------------------
// Rule ids
// ---------------------------------------------------------------------------

/** A PEM private key block. `prohibits`: the whole input is must-not-store. */
export const PEM_PRIVATE_KEY_RULE = "pem_private_key"
/** An AWS access key id, e.g. `AKIA…`. The id alone; it is still a credential. */
export const AWS_ACCESS_KEY_ID_RULE = "aws_access_key_id"
/** The 40-character value assigned to `aws_secret_access_key`. */
export const AWS_SECRET_ACCESS_KEY_RULE = "aws_secret_access_key"
/** GitHub personal access / OAuth / app / user / refresh / fine-grained PAT. */
export const GITHUB_TOKEN_RULE = "github_token"
/** A Slack `xox…` or `xapp…` token. */
export const SLACK_TOKEN_RULE = "slack_token"
/** A Google API key. `AIza` + 35. */
export const GOOGLE_API_KEY_RULE = "google_api_key"
/** An OpenAI-style `sk-` key, including the `sk-proj-` and `sk-ant-` forms. */
export const OPENAI_STYLE_KEY_RULE = "openai_style_key"
/** A Tailscale auth key. `tskey-…` */
export const TAILSCALE_AUTH_KEY_RULE = "tailscale_auth_key"
/** The value of an `Authorization: Bearer` / `bearer …` header. */
export const AUTHORIZATION_BEARER_RULE = "authorization_bearer"
/** A JSON Web Token: three dot-separated base64url segments. */
export const JWT_RULE = "jwt"
/**
 * The catch-all. Sorts last on purpose — see the module docblock.
 *
 * Named "unclassified" rather than "generic" because it is the honest label:
 * the rule fires precisely *because* it could not classify the string, and
 * calling that "generic" would read as though the pipeline understood it.
 */
export const HIGH_ENTROPY_RULE = "unclassified_high_entropy_token"
/** `key = value` where `key` is in `RedactionPolicy.sensitiveKeys`. */
export const SENSITIVE_KEY_ASSIGNMENT_RULE = "sensitive_key_assignment"
/** A mention of a path listed in `RedactionPolicy.sensitivePaths`. */
export const SENSITIVE_PATH_MENTION_RULE = "sensitive_path_mention"

/** Every built-in rule id, in the order `defaultDetectors()` returns them. */
export const BUILTIN_RULE_IDS: readonly string[] = Object.freeze([
  PEM_PRIVATE_KEY_RULE,
  AWS_ACCESS_KEY_ID_RULE,
  AWS_SECRET_ACCESS_KEY_RULE,
  GITHUB_TOKEN_RULE,
  SLACK_TOKEN_RULE,
  GOOGLE_API_KEY_RULE,
  OPENAI_STYLE_KEY_RULE,
  TAILSCALE_AUTH_KEY_RULE,
  AUTHORIZATION_BEARER_RULE,
  JWT_RULE,
  HIGH_ENTROPY_RULE,
])

// ---------------------------------------------------------------------------
// The detector implementation
// ---------------------------------------------------------------------------

export interface PatternDetectorSpec {
  readonly ruleId: string
  /** Source only — flags are chosen by the implementation. */
  readonly source: string
  /** Regex flags without `g`/`y`/`d`. `i` and `u` are honoured. */
  readonly flags?: string
  /**
   * Named capture group whose span is the match, instead of the whole match.
   * Used where the *value* is the secret and the surrounding syntax is useful
   * to keep, e.g. `aws_secret_access_key = …`.
   */
  readonly group?: string
  /** When true, any match classifies the whole input as must-not-store. */
  readonly prohibits?: boolean
  /**
   * Cheap superset gate. MUST NOT return `false` for text `detect` matches.
   * Omit and the detector falls back to probing its own pattern non-globally.
   */
  readonly appliesTo?: (text: string) => boolean
  /** Post-match filter. Returning false drops an otherwise valid match. */
  readonly accept?: (matched: string) => boolean
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

class PatternDetector implements SecretDetector {
  readonly ruleId: string
  readonly prohibits: true | undefined

  readonly #global: RegExp
  readonly #probe: RegExp
  readonly #group: string | undefined
  readonly #appliesTo: ((text: string) => boolean) | undefined
  readonly #accept: ((matched: string) => boolean) | undefined

  constructor(spec: PatternDetectorSpec) {
    this.ruleId = spec.ruleId
    if (spec.prohibits === true) this.prohibits = true
    const base = spec.flags ?? ""
    this.#global = new RegExp(spec.source, `${base}gd`)
    this.#probe = new RegExp(spec.source, base)
    this.#group = spec.group
    this.#appliesTo = spec.appliesTo
    this.#accept = spec.accept
  }

  appliesTo(text: string): boolean {
    if (this.#appliesTo !== undefined) return this.#appliesTo(text)
    this.#probe.lastIndex = 0
    return this.#probe.test(text)
  }

  detect(text: string): readonly RedactionMatch[] {
    const matches: RedactionMatch[] = []
    this.#global.lastIndex = 0
    let found: RegExpExecArray | null
    while ((found = this.#global.exec(text)) !== null) {
      // A zero-width match would spin forever; the built-in patterns are all
      // consuming, but this is a public constructor and a future caller's
      // pattern is not obliged to be.
      if (found[0].length === 0) {
        this.#global.lastIndex += 1
        continue
      }

      let start = found.index
      let end = found.index + found[0].length
      if (this.#group !== undefined) {
        const span = found.indices?.groups?.[this.#group]
        if (span === undefined) continue
        start = span[0]
        end = span[1]
      }
      if (end <= start) continue

      const matched = text.slice(start, end)
      if (this.#accept !== undefined && !this.#accept(matched)) continue

      matches.push({ ruleId: this.ruleId, start, end })
    }
    return matches
  }
}

function pattern(spec: PatternDetectorSpec): SecretDetector {
  return new PatternDetector(spec)
}

// ---------------------------------------------------------------------------
// The built-in detectors
// ---------------------------------------------------------------------------

/**
 * A PEM private key block. The only rule that `prohibits`.
 *
 * `prohibits` rather than "redact the block" because redacting it is not
 * possible in a way anyone should rely on: the block's *value* is its entire
 * content, and a caller who stores the redacted remainder of a key file is
 * storing a partial key. The ontology's `prohibited` is terminal for content
 * (`isRenderable` is false for it, and the record schema refuses an unlabelled
 * prohibited record), which is the correct destination for a raw key.
 *
 * The pattern requires a matching `END` armoured line. A truncated key — the
 * half that a log line captured — therefore does not match. This is a real
 * gap, recorded in `corpus.ts` as `nm-pem-without-end-armour`, and it is not
 * patched here because the only available patch (matching any `BEGIN … PRIVATE
 * KEY` to end-of-input) would prohibit any text that quotes a single PEM header,
 * which is a false positive in every log that ever helpfully printed one.
 */
export function pemPrivateKeyDetector(): SecretDetector {
  return pattern({
    ruleId: PEM_PRIVATE_KEY_RULE,
    source: String.raw`-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----`,
    prohibits: true,
    appliesTo: (text) => text.includes("PRIVATE KEY"),
  })
}

/**
 * An AWS access key id. `AKIA`/`ASIA`/`ABIA`/`ACCA`, or the legacy `A3T…`
 * form, plus exactly 16 uppercase alphanumerics.
 *
 * Uppercase-only is a deliberate narrowing: it is the real format, and a
 * case-insensitive version would match `akia`-prefixed words and identifiers.
 * The cost is `nm-lowercased-aws-key-id` in the corpus — a real but unlikely
 * gap, since AWS does not issue lowercase ids.
 */
export function awsAccessKeyIdDetector(): SecretDetector {
  return pattern({
    ruleId: AWS_ACCESS_KEY_ID_RULE,
    source: String.raw`\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b`,
    // Case-insensitive superset of the case-sensitive pattern: a key id that
    // fails this gate can never match, and one that passes may still not.
    appliesTo: (text) => /AKIA|ASIA|ACCA|ABIA/i.test(text),
  })
}

/**
 * The 40-character AWS secret access key, matched through its assignment.
 *
 * Requires the variable name, because a bare 40-character `[A-Za-z0-9/+=]`
 * string is indistinguishable from a base64 digest and the entropy rule already
 * owns that case. Only the *value* span is returned, so the stored text keeps
 * the fact that an AWS secret was configured — which is exactly the
 * "store references, never values" property the plan asks for.
 */
export function awsSecretAccessKeyDetector(): SecretDetector {
  return pattern({
    ruleId: AWS_SECRET_ACCESS_KEY_RULE,
    source: String.raw`(?<![A-Za-z0-9_])aws_secret_access_key(?![A-Za-z0-9_])\s*[:=]\s*["']?(?<value>[A-Za-z0-9/+=]{40})`,
    flags: "i",
    group: "value",
    appliesTo: (text) => text.toLowerCase().includes("aws_secret_access_key"),
  })
}

/** GitHub tokens: `ghp_`/`gho_`/`ghs_`/`ghu_`/`ghr_`, and `github_pat_`. */
export function githubTokenDetector(): SecretDetector {
  return pattern({
    ruleId: GITHUB_TOKEN_RULE,
    source: String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b`,
    appliesTo: (text) => /gh[pousr]_/.test(text) || text.includes("github_pat_"),
  })
}

/** Slack tokens: `xoxa`/`xoxb`/`xoxp`/`xoxr`/`xoxs` and `xapp`. */
export function slackTokenDetector(): SecretDetector {
  return pattern({
    ruleId: SLACK_TOKEN_RULE,
    source: String.raw`\b(?:xox[abprs]-|xapp-)[A-Za-z0-9-]{10,}`,
    appliesTo: (text) => /xox[abprs]-|xapp-/.test(text),
  })
}

/** A Google API key: the literal `AIza` followed by 35 URL-safe characters. */
export function googleApiKeyDetector(): SecretDetector {
  return pattern({
    ruleId: GOOGLE_API_KEY_RULE,
    source: String.raw`\bAIza[0-9A-Za-z_-]{35}\b`,
    appliesTo: (text) => text.includes("AIza"),
  })
}

/**
 * An OpenAI-style `sk-` key.
 *
 * `[A-Za-z0-9_-]{20,}` is deliberately short of a real key's length. A real
 * `sk-` key is 48 characters; requiring that would miss a truncated paste,
 * which is the form a log line usually carries. The cost is
 * `fp-prefixed-identifier` in the corpus: an internal identifier that happens
 * to start with `sk-` is redacted. That is a visible, accepted false positive.
 */
export function openAiStyleKeyDetector(): SecretDetector {
  return pattern({
    ruleId: OPENAI_STYLE_KEY_RULE,
    source: String.raw`\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}`,
    appliesTo: (text) => text.includes("sk-"),
  })
}

/** A Tailscale auth key: `tskey-` plus 20 or more URL-safe characters. */
export function tailscaleAuthKeyDetector(): SecretDetector {
  return pattern({
    ruleId: TAILSCALE_AUTH_KEY_RULE,
    source: String.raw`\btskey-[A-Za-z0-9-]{20,}`,
    appliesTo: (text) => text.includes("tskey-"),
  })
}

/**
 * The value of a `Bearer` credential.
 *
 * Matches the value only, so `Authorization: [REDACTED]` remains a
 * structurally recognizable — and still greppable — header. The value charset
 * includes `.` so an opaque token that happens to be a JWT is consumed whole
 * rather than leaving a dangling `.signature`.
 */
export function authorizationBearerDetector(): SecretDetector {
  return pattern({
    ruleId: AUTHORIZATION_BEARER_RULE,
    source: String.raw`\bbearer\s+(?<value>[A-Za-z0-9._~+/=-]{8,})`,
    flags: "i",
    group: "value",
    appliesTo: (text) => /bearer\s/i.test(text),
  })
}

/**
 * A JSON Web Token: `eyJ` + three dot-separated base64url segments.
 *
 * The `eyJ` prefix is not a secret format requirement, it is the base64 of
 * `{"` and holds for essentially every real JWT header, and it keeps this rule
 * from firing on every dotted identifier in a stack trace.
 */
export function jwtDetector(): SecretDetector {
  return pattern({
    ruleId: JWT_RULE,
    source: String.raw`\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b`,
    appliesTo: (text) => text.includes("eyJ"),
  })
}

export const DEFAULT_MINIMUM_HIGH_ENTROPY_LENGTH = 32

export interface HighEntropyDetectorOptions {
  /**
   * Shortest run considered. 32 is the default because it sits above every
   * common short identifier (a git short sha, a uuid fragment) and below the
   * shortest credential shape in the table above. Configurable, because a
   * deployment storing longer identifiers than that needs a different line and
   * silently lowering it for one document would be a false-positive factory.
   */
  readonly minimumLength?: number
  /**
   * How many of {lowercase, uppercase, digit, symbol} must appear. Two is the
   * floor that admits a hex digest; three would refuse a lowercase hex hash
   * and with it most commit shas and every sha256 output.
   */
  readonly minimumCharacterClasses?: number
}

const CHARACTER_CLASSES: readonly RegExp[] = Object.freeze([/[a-z]/, /[A-Z]/, /[0-9]/, /[+/=_-]/])

/**
 * A bare long high-entropy run of hex/base64/base64url characters.
 *
 * This is the weakest rule in the table and the one responsible for most of
 * the corpus's false positives, because a hash, a UUID and a secret are the
 * same shape. The `minimumCharacterClasses` filter is the only thing standing
 * between it and a detector that redacts every long identifier in the repo, and
 * it is a filter rather than a fix: `fp-git-commit-sha` and
 * `fp-content-sha256-digest` in the corpus are *accepted* false positives, and
 * an operator who is tired of them configures a higher minimum rather than
 * expecting this rule to learn the difference.
 */
export function highEntropyDetector(options: HighEntropyDetectorOptions = {}): SecretDetector {
  const minimumLength = options.minimumLength ?? DEFAULT_MINIMUM_HIGH_ENTROPY_LENGTH
  const minimumCharacterClasses = options.minimumCharacterClasses ?? 2
  if (!Number.isInteger(minimumLength) || minimumLength < 8) {
    throw new RangeError(`highEntropyDetector: minimumLength must be an integer >= 8, received ${minimumLength}`)
  }
  if (!Number.isInteger(minimumCharacterClasses) || minimumCharacterClasses < 1 || minimumCharacterClasses > CHARACTER_CLASSES.length) {
    throw new RangeError(
      `highEntropyDetector: minimumCharacterClasses must be an integer 1..${CHARACTER_CLASSES.length}, received ${minimumCharacterClasses}`,
    )
  }

  return pattern({
    ruleId: HIGH_ENTROPY_RULE,
    // Lookarounds rather than `\b`, because `-`, `+` and `=` are not word
    // characters and `\b` would let a run be matched out of the middle of a
    // longer base64 blob.
    source: String.raw`(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{${minimumLength},}(?![A-Za-z0-9+/=_-])`,
    appliesTo: (text) => text.length >= minimumLength,
    accept: (matched) => {
      let classes = 0
      for (const characterClass of CHARACTER_CLASSES) {
        if (characterClass.test(matched)) classes += 1
      }
      return classes >= minimumCharacterClasses
    },
  })
}

// ---------------------------------------------------------------------------
// Policy-derived detectors
// ---------------------------------------------------------------------------

/**
 * `key = value` for every key name in `RedactionPolicy.sensitiveKeys`.
 *
 * Returns `undefined` for an empty key list rather than a never-matching
 * detector, so `policy.detectors` stays a list of things that do something.
 *
 * Key names are matched case-insensitively (the port specifies it) and
 * longest-first, so `db_password` is preferred over `password` when both are
 * configured. The value is quoted-or-bare and must be non-empty: a bare value
 * stops at whitespace or at a bracket, so `password = [REDACTED]` yields no
 * match on reapplication and the pipeline's replacement stays a fixed point.
 * That is a real design constraint, not an accident — see `pipeline.ts`.
 *
 * Known and accepted: this fires on prose. `"the dispatch token: was not
 * accepted"` redacts the word `was`; the case is `fp-key-name-in-prose` in the
 * corpus. The alternative — requiring the value to look like a credential —
 * is the entropy rule's job, and doing it here would silently double-count.
 */
export function createSensitiveKeyDetector(keys: readonly string[]): SecretDetector | undefined {
  const usable = [...new Set(keys.filter((key) => key.length > 0))].sort((left, right) => right.length - left.length || left.localeCompare(right))
  if (usable.length === 0) return undefined

  const alternation = usable.map(escapeRegExp).join("|")
  const lowercased = usable.map((key) => key.toLowerCase())

  return pattern({
    ruleId: SENSITIVE_KEY_ASSIGNMENT_RULE,
    flags: "i",
    // One `value` group, three alternative shapes. The quotes are part of the
    // span and are consumed with it: they are delimiters, carry no information,
    // and folding them in keeps the group single-valued so the pipeline has one
    // span to reason about.
    source:
      String.raw`(?<![A-Za-z0-9_])(?:${alternation})(?![A-Za-z0-9_])\s*[:=]\s*(?<value>"[^"\n]{1,512}"|'[^'\n]{1,512}'|[^\s,;)\]}"'\[]{1,512})`,
    group: "value",
    // Must be a superset of `detect`: a key name present in any casing is
    // present in the lowercased text.
    appliesTo: (text) => {
      const haystack = text.toLowerCase()
      return lowercased.some((key) => haystack.includes(key))
    },
  })
}

/**
 * A mention of a path listed in `RedactionPolicy.sensitivePaths`.
 *
 * # These are *mentions*, not file operations
 *
 * The pipeline has no filesystem access and this module imports nothing from
 * `node:fs`. A sensitive path is a string a document may refer to — a runbook
 * saying "the key is in `~/.aws/credentials`" discloses that a credential file
 * exists on that machine, which is a reconnaissance step even though the file
 * itself is not read. So the rule redacts the mention and the plan's "artifact
 * readers enforce the same policy" is somebody else's module.
 *
 * A trailing `(?![A-Za-z0-9_])` stops `.env` from matching inside `.envrc`;
 * it deliberately does *not* stop `.env` from matching inside `.env.local` or
 * `.env.bak`, because those are the same secret file with a suffix. Matching
 * case-sensitively is right: a POSIX path is case-sensitive, and
 * `.ENVIRONMENT` in prose is not the same file as `.env`.
 */
export function createSensitivePathDetector(paths: readonly string[]): SecretDetector | undefined {
  const usable = [...new Set(paths.filter((path) => path.length > 0))].sort((left, right) => right.length - left.length || left.localeCompare(right))
  if (usable.length === 0) return undefined

  const alternation = usable.map(escapeRegExp).join("|")

  return pattern({
    ruleId: SENSITIVE_PATH_MENTION_RULE,
    // A leading guard stops `credentials` matching inside `aws_credentials`,
    // which is a variable name rather than a path. A trailing guard stops
    // `.env` matching inside `.envrc`.
    source: String.raw`(?<![A-Za-z0-9_])(?:${alternation})(?![A-Za-z0-9_])`,
    // `includes` is a superset of the regex: the regex can only match a listed
    // literal or a prefix of one.
    appliesTo: (text) => usable.some((path) => text.includes(path)),
  })
}

/**
 * Every built-in detector, in a fixed order.
 *
 * The order is documentation, not semantics: `pipeline.ts` resolves overlaps
 * by `(start, length, ruleId)` and is therefore independent of the order a
 * caller supplies. It is frozen so a caller cannot mutate the shared set.
 */
export function defaultDetectors(): readonly SecretDetector[] {
  return Object.freeze([
    pemPrivateKeyDetector(),
    awsAccessKeyIdDetector(),
    awsSecretAccessKeyDetector(),
    githubTokenDetector(),
    slackTokenDetector(),
    googleApiKeyDetector(),
    openAiStyleKeyDetector(),
    tailscaleAuthKeyDetector(),
    authorizationBearerDetector(),
    jwtDetector(),
    highEntropyDetector(),
  ])
}

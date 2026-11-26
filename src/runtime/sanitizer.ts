import { isAbsolute, relative, resolve } from "node:path"
import type { RedactionMatch, RedactionPolicy, SecretDetector } from "../memory/ports.js"
import {
  authorizationBearerDetector,
  awsAccessKeyIdDetector,
  awsSecretAccessKeyDetector,
  githubTokenDetector,
  googleApiKeyDetector,
  highEntropyDetector,
  jwtDetector,
  openAiStyleKeyDetector,
  pemPrivateKeyDetector,
  slackTokenDetector,
  tailscaleAuthKeyDetector,
} from "../memory/redaction/detectors.js"
import { DEFAULT_REPLACEMENT, DeterministicRedactionPipeline } from "../memory/redaction/pipeline.js"

const SENSITIVE_KEY_PATTERN = /(?:AIBRIDGE_|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|_KEY$|^KEY$)/i

/**
 * Provider credentials the Claude Code CLI needs to authenticate in print mode.
 * Both match SENSITIVE_KEY_PATTERN, so they must be allowlisted explicitly.
 * `CLAUDE_CODE_OAUTH_TOKEN` comes from `claude setup-token`; `ANTHROPIC_API_KEY`
 * is an API key. In `-p` mode the API key wins when both are present, so a
 * worker environment should carry only one of them. Non-secret variables such
 * as HOME and PATH are not matched by the pattern and always pass through.
 */
export const CLAUDE_PROVIDER_ENV_KEYS: readonly string[] = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]

export function sanitizeChildProcessEnv(
  sourceEnv: Record<string, string | undefined>,
  allowedProviderKeys: readonly string[] = [],
): Record<string, string> {
  const allowedSet = new Set(allowedProviderKeys)
  const sanitized: Record<string, string> = {}

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue

    // If explicitly allowed provider key (e.g. ANTHROPIC_API_KEY), pass through
    if (allowedSet.has(key)) {
      sanitized[key] = value
      continue
    }

    // Strip sensitive internal keys
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      continue
    }

    sanitized[key] = value
  }

  return sanitized
}

const REDACTED = DEFAULT_REPLACEMENT

const JOB_RESULT_HIGH_ENTROPY_MINIMUM_LENGTH = 32
/** In a `/`-separated run, one random-looking segment of this length is enough. */
const OPAQUE_PATH_SEGMENT_MINIMUM_LENGTH = 16

/**
 * Share of adjacent letter/digit pairs that switch class (lower, upper, digit)
 * above which a string reads as random rather than as words. Uniform random
 * base64 sits near 0.62; camelCase identifiers, Title_Case file names and ISO
 * timestamps sit near 0.2-0.35.
 */
const RANDOM_CLASS_TRANSITION_RATE = 0.45
/** Fewer adjacent pairs than this is too short to judge. */
const MINIMUM_JUDGED_PAIRS = 15

const HEX_RUN = /^[0-9a-fA-F-]+$/
/** A short sha is 7 characters; a shorter hex-looking segment may be part of a secret. */
const MINIMUM_HEX_SEGMENT_LENGTH = 7
const SRI_DIGEST_RUN = /^sha(?:1|256|384|512)-/

function characterClass(character: string): number {
  if (character >= "a" && character <= "z") return 1
  if (character >= "A" && character <= "Z") return 2
  if (character >= "0" && character <= "9") return 3
  return 0
}

/**
 * Whether `value` mixes lowercase, uppercase and digits the way random text
 * does: all three present, and the class changing between adjacent characters
 * at least `RANDOM_CLASS_TRANSITION_RATE` of the time. Pairs that include a
 * separator (`/`, `+`, `=`, `_`, `-`) are not counted.
 */
function looksRandom(value: string): boolean {
  let lower = false
  let upper = false
  let digit = false
  let pairs = 0
  let transitions = 0
  let previous = 0
  for (const character of value) {
    const current = characterClass(character)
    if (current === 1) lower = true
    else if (current === 2) upper = true
    else if (current === 3) digit = true
    if (current !== 0 && previous !== 0) {
      pairs += 1
      if (current !== previous) transitions += 1
    }
    previous = current
  }
  if (!lower || !upper || !digit) return false
  if (pairs < MINIMUM_JUDGED_PAIRS) return false
  return transitions / pairs >= RANDOM_CLASS_TRANSITION_RATE
}

/**
 * Whether a long run of base64/base64url characters looks like an opaque
 * credential rather than an identifier that merely shares the alphabet.
 *
 * - Hex with optional dashes is a commit sha, a sha256 digest, a UUID or a hex
 *   id, and is never redacted. The cost: a secret issued as bare hex (some
 *   vendors' 32-hex API keys) is not caught by this rule.
 * - `sha512-…` and friends are Subresource Integrity digests from lockfiles.
 * - Otherwise the run must `looksRandom`: a path, a slug, a camelCase
 *   identifier or a timestamped file name does not.
 * - `/` is both a path separator and a base64 character. In a run containing
 *   it, hex segments of 7+ characters (a sha in a commit URL, a UUID directory)
 *   are dropped before scoring, so they cannot make a path look random. A path
 *   or URL whose words dilute the score is still caught when one `/`-segment of
 *   16+ characters looks random on its own.
 */
export function isOpaqueSecretRun(run: string): boolean {
  if (HEX_RUN.test(run)) return false
  if (SRI_DIGEST_RUN.test(run)) return false
  if (!run.includes("/")) return looksRandom(run)
  const segments = run.split("/").filter((segment) => !(segment.length >= MINIMUM_HEX_SEGMENT_LENGTH && HEX_RUN.test(segment)))
  if (looksRandom(segments.join("/"))) return true
  return segments.some((segment) => segment.length >= OPAQUE_PATH_SEGMENT_MINIMUM_LENGTH && looksRandom(segment))
}

/** `NAME=` at the start of a run: an assignment whose value is the candidate. */
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=(?!=)/

/**
 * The catch-all entropy rule, narrowed for job results.
 *
 * `=` is in the base64 alphabet, so `API_TOKEN=<value>` is one run. The
 * `NAME=` prefix is cut off before the run is judged, so only the value is
 * redacted and `AWS_SECRET_ACCESS_KEY=…` lands on the same span as the specific
 * AWS rule, which then gets the credit.
 */
function jobResultHighEntropyDetector(): SecretDetector {
  const base = highEntropyDetector({ minimumLength: JOB_RESULT_HIGH_ENTROPY_MINIMUM_LENGTH, minimumCharacterClasses: 1 })
  return {
    ruleId: base.ruleId,
    appliesTo: (text) => base.appliesTo(text),
    detect: (text) => {
      const matches: RedactionMatch[] = []
      for (const match of base.detect(text)) {
        const run = text.slice(match.start, match.end)
        const assignment = ASSIGNMENT_PREFIX.exec(run)
        const start = assignment === null ? match.start : match.start + assignment[0].length
        if (start < match.end && isOpaqueSecretRun(text.slice(start, match.end))) matches.push({ ruleId: match.ruleId, start, end: match.end })
      }
      return matches
    },
  }
}

/** Keeps a detector's offsets-only contract and drops the matches `accept` rejects. */
function filteredDetector(base: SecretDetector, accept: (matched: string) => boolean): SecretDetector {
  return {
    ruleId: base.ruleId,
    appliesTo: (text) => base.appliesTo(text),
    detect: (text) => base.detect(text).filter((match) => accept(text.slice(match.start, match.end))),
  }
}

/**
 * A `Bearer` value made only of lowercase letters is an English word
 * ("bearer authentication", "Bearer credentials"), not a token. In this
 * repository's own history that prose was the most common false positive.
 */
function isPlausibleBearerValue(value: string): boolean {
  return !/^[a-z]+$/.test(value)
}

/** The same detector without `prohibits`, so its match is redacted in place. */
function redactingDetector(base: SecretDetector): SecretDetector {
  return { ruleId: base.ruleId, appliesTo: (text) => base.appliesTo(text), detect: (text) => base.detect(text) }
}

const TRUNCATED_PEM_PRIVATE_KEY_RULE = "pem_private_key_truncated"
const TRUNCATED_PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----(?:\r?\n[A-Za-z0-9+/=]{16,})*/g

/**
 * A PEM private key header followed by its base64 body lines, with or without
 * an `END` line. When `END` is present the complete-block rule wins (same
 * start, longer span); this one covers a key cut off by a bounded tail.
 */
const truncatedPemPrivateKeyDetector: SecretDetector = {
  ruleId: TRUNCATED_PEM_PRIVATE_KEY_RULE,
  appliesTo: (text) => text.includes("PRIVATE KEY-----"),
  detect: (text) =>
    [...text.matchAll(TRUNCATED_PEM_PRIVATE_KEY)].map((found) => ({
      ruleId: TRUNCATED_PEM_PRIVATE_KEY_RULE,
      start: found.index,
      end: found.index + found[0].length,
    })),
}

/**
 * A detector over one global, `d`-flagged regex whose first defined named group
 * among `groups` is the redacted span. `accept` sees the value and the
 * character right after the whole match (after a closing quote, if any).
 */
function valueDetector(
  ruleId: string,
  source: RegExp,
  groups: readonly string[],
  appliesTo: (text: string) => boolean,
  accept: (value: string, after: string, found: RegExpMatchArray, group: string) => boolean,
): SecretDetector {
  const pattern = new RegExp(source.source, `${source.flags.replace(/[gd]/g, "")}gd`)
  return {
    ruleId,
    appliesTo,
    detect: (text) => {
      const matches: RedactionMatch[] = []
      for (const found of text.matchAll(pattern)) {
        const group = groups.find((candidate) => found.indices?.groups?.[candidate] !== undefined)
        const span = group === undefined ? undefined : found.indices?.groups?.[group]
        if (group === undefined || span === undefined || span[1] <= span[0]) continue
        const matchEnd = (found.index ?? 0) + found[0].length
        if (!accept(text.slice(span[0], span[1]), text.slice(matchEnd, matchEnd + 1), found, group)) continue
        matches.push({ ruleId, start: span[0], end: span[1] })
      }
      return matches
    },
  }
}

/** `$VAR` or `${VAR}`: a reference to a value, not the value. */
const VARIABLE_REFERENCE = /^\$(?:\{[^}]*\}?|[A-Za-z_][A-Za-z0-9_]*)$/
/** `process.env.X`, `options.environment`, `this.secret`: a member path in code. */
const MEMBER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/
/** Type names, literals and keywords that follow `password:` in code, not a password. */
const CODE_KEYWORD =
  /^(?:string|number|boolean|symbol|undefined|null|true|false|None|nil|any|unknown|await|async|new|typeof|function|yield|void)$/
/** `ocPassword`, `fromEnv`: a camelCase variable name. */
const CAMEL_CASE_IDENTIFIER = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/

/**
 * Whether an assigned value is a reference or code rather than a secret:
 * a variable reference, a literal followed by `.` (`"A".repeat(24)`), and,
 * unquoted only, a member path, a call or index (`getPassword(`,
 * `options.environment[`), a type or keyword, or a camelCase variable name. The cost: an unquoted password shaped like `word.word` or
 * `camelCase` is not redacted by this rule.
 */
function isCodeOrReference(value: string, after: string, quoted: boolean): boolean {
  if (VARIABLE_REFERENCE.test(value)) return true
  // `"A".repeat(24)`: a literal with a method call on it is code.
  if (after === ".") return true
  if (quoted) return false
  if (after === "(" || after === "[") return true
  if (MEMBER_PATH.test(value)) return true
  if (CAMEL_CASE_IDENTIFIER.test(value)) return true
  return CODE_KEYWORD.test(value)
}

/** Assigned values shorter than this are placeholders or prose (`token: was`), not secrets. */
const MINIMUM_ASSIGNED_SECRET_LENGTH = 8

/**
 * Whether an assigned value looks like a secret. Any value shorter than
 * `MINIMUM_ASSIGNED_SECRET_LENGTH` is left alone. After `: ` a value that is
 * all lowercase letters (`token: every`) or contains a space (`token: set the
 * variable`) is prose and is also left alone. Accepted cost: a short
 * `PASSWORD=pw1` or a lowercase-word `password: changeme` is not redacted.
 */
function looksLikeAssignedSecret(value: string, colonForm: boolean): boolean {
  if (value.length < MINIMUM_ASSIGNED_SECRET_LENGTH) return false
  if (!colonForm) return true
  return !/^[a-z]+$/.test(value) && !value.includes(" ")
}

/** `bearerToken`, `hasExistingPassword`: a camelCase name is a code identifier, not a config key. */
const CAMEL_CASE_KEY = /[a-z][A-Z]/

const ENV_SECRET_ASSIGNMENT_RULE = "env_secret_assignment"
const SECRET_KEY_SUFFIX = String.raw`(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)`
const SECRET_KEY_SUFFIX_PROBE = /password|passwd|passphrase|secret|token|api_?key|access_key|private_key/i

/**
 * `NAME=value`, `NAME = value` or `name: value` where the name ends in a
 * credential word, case-insensitively: `POSTGRES_PASSWORD=…`,
 * `export GITHUB_TOKEN=…`, `api_key: …`, `"client_secret": "…"`. Only the
 * value is redacted (inside its quotes when quoted). An empty value, a `$VAR`
 * reference and a code expression (`isCodeOrReference`) are left alone, and so
 * is a camelCase name (`bearerToken: x`), which is a code identifier rather
 * than an env or config key.
 *
 * `: ` needs whitespace after the colon, so `token:abc` in a URL or a log key
 * does not match; `=` must not start `==` or `=>`. The value stops at the end
 * of the line, so `PASSWORD=` followed by a newline never swallows the next
 * line. `looksLikeAssignedSecret` drops short values and, after `: `, plain
 * lowercase words and values with a space, so prose such as "the dispatch
 * token: was not accepted" passes through.
 */
const envSecretAssignmentDetector = valueDetector(
  ENV_SECRET_ASSIGNMENT_RULE,
  new RegExp(
    String.raw`(?<![A-Za-z0-9_])(?<key>[A-Za-z0-9_]*${SECRET_KEY_SUFFIX})(?![A-Za-z0-9_])["']?(?:[ \t]*=(?![=>])|(?<colon>:)[ \t]+)[ \t]*` +
      String.raw`(?:"(?<double>[^"\n]+)"|'(?<single>[^'\n]+)'|(?<bare>\$\{[^}\n]*\}|[^\s,;()\[\]{}"'<>]+))`,
    "i",
  ),
  ["double", "single", "bare"],
  (text) => SECRET_KEY_SUFFIX_PROBE.test(text),
  (value, after, found, group) =>
    !CAMEL_CASE_KEY.test(found.groups?.key ?? "") &&
    !isCodeOrReference(value, after, group !== "bare") &&
    looksLikeAssignedSecret(value, found.groups?.colon !== undefined),
)

const CONNECTION_STRING_PASSWORD_RULE = "connection_string_password"

/**
 * The password of `scheme://user:password@host`, for any scheme (`postgres`,
 * `mysql`, `redis`, `amqp`, `mongodb+srv`, `https`, …). The user part may be
 * empty (`redis://:password@host`). Only the password is redacted; a `$VAR`
 * reference is left alone.
 */
const connectionStringPasswordDetector = valueDetector(
  CONNECTION_STRING_PASSWORD_RULE,
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@]*:(?<password>[^\s/@]+)@/,
  ["password"],
  (text) => text.includes("://") && text.includes("@"),
  (value) => !VARIABLE_REFERENCE.test(value),
)

/** The rule set `redactSecretsFromText` runs, exported for the corpus tests. */
export const JOB_RESULT_DETECTORS: readonly SecretDetector[] = Object.freeze([
  redactingDetector(pemPrivateKeyDetector()),
  truncatedPemPrivateKeyDetector,
  awsAccessKeyIdDetector(),
  awsSecretAccessKeyDetector(),
  githubTokenDetector(),
  slackTokenDetector(),
  googleApiKeyDetector(),
  openAiStyleKeyDetector(),
  tailscaleAuthKeyDetector(),
  filteredDetector(authorizationBearerDetector(), isPlausibleBearerValue),
  jwtDetector(),
  envSecretAssignmentDetector,
  connectionStringPasswordDetector,
  jobResultHighEntropyDetector(),
])

const JOB_RESULT_POLICY: RedactionPolicy = Object.freeze({
  detectors: JOB_RESULT_DETECTORS,
  replacement: REDACTED,
})

const JOB_RESULT_PIPELINE = new DeterministicRedactionPipeline({ diagnosticDetectors: JOB_RESULT_DETECTORS })

/**
 * Redacts secrets from text that leaves the worker: the Claude result summary
 * and errors, stderr tails and script output tails, and so the `runtimeResult`
 * and the `/report` callback built from them.
 *
 * Two passes, in this order:
 *
 * 1. Every `knownSecrets` entry of six or more characters is replaced
 *    verbatim. This is unchanged from before the pipeline was wired in.
 * 2. The `memory/redaction` pipeline runs with `JOB_RESULT_DETECTORS`: the
 *    vendor-prefixed rules (GitHub, AWS, Slack, Google, `sk-`, Tailscale, JWT,
 *    `Bearer` values, PEM private keys), env-style `*_PASSWORD=` / `*_TOKEN:`
 *    assignments, connection-string passwords, and a narrowed high-entropy
 *    catch-all.
 *
 * The job-result rule set differs from the memory default in four ways, all
 * because a job result is full of file paths, commit shas, UUIDs and code, and
 * a redactor that mangles those gets switched off:
 *
 * - The entropy rule only fires on runs `isOpaqueSecretRun` accepts: never on
 *   hex (shas, digests, UUIDs), SRI digests, or ordinary paths and URLs.
 * - `sensitivePaths` is not used: redacting the mention of `.env` would turn
 *   `.env.example` into `[REDACTED].example`.
 * - `sensitiveKeys` is replaced by `envSecretAssignmentDetector`, which
 *   matches any name ending in a credential word and leaves `$VAR` references
 *   and code (`password: options.environment[…]`) alone.
 * - A PEM private key is redacted in place instead of replacing the whole text
 *   with `[PROHIBITED]`, so the rest of the result stays readable. A key whose
 *   `END` line was cut off is redacted from `BEGIN` through its base64 body.
 *
 * Detection is best-effort: `src/memory/redaction/corpus.ts` lists what the
 * rules miss. Text with no `[REDACTED]` in it is not proven secret-free.
 */
export function redactSecretsFromText(text: string, knownSecrets: string[] = []): string {
  let result = text
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) {
      result = result.replaceAll(secret, REDACTED)
    }
  }
  return JOB_RESULT_PIPELINE.redact(result, JOB_RESULT_POLICY).text
}

export function isPathContained(targetPath: string, allowedRoot: string): boolean {
  const resolvedTarget = resolve(targetPath)
  const resolvedRoot = resolve(allowedRoot)
  const rel = relative(resolvedRoot, resolvedTarget)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}


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
 * `key = value` / `key: value` names whose value is redacted. Narrower than the
 * memory default: bare `token` and `credential` fire on prose ("the dispatch
 * token: was not accepted") and bare `secret` on code a result quotes
 * (`secret: z.string()`, `readonly secret: string`), so all three are left out.
 */
const JOB_RESULT_SENSITIVE_KEYS: readonly string[] = Object.freeze([
  "access_token",
  "api_key",
  "apikey",
  "auth_token",
  "aws_secret_access_key",
  "client_secret",
  "db_password",
  "passphrase",
  "passwd",
  "password",
  "private_key",
  "refresh_token",
])

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
  jobResultHighEntropyDetector(),
])

const JOB_RESULT_POLICY: RedactionPolicy = Object.freeze({
  detectors: JOB_RESULT_DETECTORS,
  sensitiveKeys: JOB_RESULT_SENSITIVE_KEYS,
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
 *    `Bearer` values, PEM private keys), a short `key = value` name list, and a
 *    narrowed high-entropy catch-all.
 *
 * The job-result rule set differs from the memory default in three ways, all
 * because a job result is full of file paths, commit shas, UUIDs and code, and
 * a redactor that mangles those gets switched off:
 *
 * - The entropy rule only fires on runs `isOpaqueSecretRun` accepts: never on
 *   hex (shas, digests, UUIDs), SRI digests, or ordinary paths and URLs.
 * - `sensitivePaths` is not used: redacting the mention of `.env` would turn
 *   `.env.example` into `[REDACTED].example`.
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


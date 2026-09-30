/**
 * M5.4 — the redaction subsystem's public surface.
 *
 * One import for callers. The three modules behind it are split by *who owns
 * the concern*:
 *
 *   `detectors.ts`  what counts as a secret, one rule at a time
 *   `pipeline.ts`   how rules are combined, deduplicated, and reported
 *   `corpus.ts`     what that combination demonstrably misses and over-fires on
 *
 * The corpus is exported alongside the code rather than living only in tests
 * because M5.9's isolation audit and the M5 gate report both have to cite it:
 * a redaction claim without the list of its known failures is a claim nobody
 * can review.
 *
 * Read `corpus.ts` before trusting `redact`. Detection here is best-effort by
 * design and the plan forbids promising otherwise.
 */

export {
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
} from "./detectors.js"
export type { HighEntropyDetectorOptions, PatternDetectorSpec } from "./detectors.js"

export { DEFAULT_REPLACEMENT, DeterministicRedactionPipeline, PROHIBITED_TEXT } from "./pipeline.js"
export type { DeterministicRedactionPipelineOptions } from "./pipeline.js"

export { CORPUS_POLICY, CORPUS_TRUE_POSITIVES, CORPUS_NEAR_MISSES, REDACTION_CORPUS, SEEDED_SECRETS } from "./corpus.js"
export type { RedactionCorpusCase, RedactionCorpusKind, SeededSecretName } from "./corpus.js"

import type { RedactionPolicy } from "../ports.js"
import { defaultDetectors } from "./detectors.js"
import { DEFAULT_REPLACEMENT } from "./pipeline.js"

/**
 * The rule set shipped for callers that have no policy of their own.
 *
 * `sensitiveKeys` is the conservative default: names that are a credential
 * wherever they appear. `sensitivePaths` is the set a mesh node is expected to
 * have on disk, and it is a *mention* list — nothing here opens a file.
 */
export function defaultRedactionPolicy(): RedactionPolicy {
  return {
    detectors: defaultDetectors(),
    sensitiveKeys: [
      "api_key",
      "apikey",
      "auth_token",
      "aws_secret_access_key",
      "credential",
      "db_password",
      "passphrase",
      "passwd",
      "password",
      "private_key",
      "secret",
      "token",
    ],
    sensitivePaths: [".env", ".npmrc", ".netrc", "id_ed25519", "id_rsa", "secrets.yaml", "~/.aws/config", "~/.aws/credentials"],
    replacement: DEFAULT_REPLACEMENT,
  }
}

/**
 * `redactSecretsFromText` runs the `memory/redaction` detectors and pipeline
 * (v3.2.0 plan §5.5, block R).
 *
 * Three properties are asserted here:
 *
 * 1. The M5.4 corpus, run through the sanitizer, behaves as the table below
 *    says. Every case must be listed, so a new corpus case fails this file
 *    until someone decides what job results should do with it.
 * 2. Text a job result is full of (commit shas, UUIDs, file paths, hex ids,
 *    URLs, lockfile digests) passes through byte-for-byte.
 * 3. The known-secret list behaves exactly as it did before the pipeline.
 */
import { describe, expect, it } from "vitest"
import { REDACTION_CORPUS } from "../../../src/memory/redaction/corpus.js"
import { isOpaqueSecretRun, redactSecretsFromText } from "../../../src/runtime/sanitizer.js"
import { PEM_BODY_LINES, SEEDED_SECRETS, SEEDED_SECRET_LITERALS } from "../memory/redaction/fixtures.js"

/**
 * What the sanitizer does with each corpus case. Where it differs from the
 * corpus's own `expectedStatus` (which is for the memory default policy), the
 * reason is on the line.
 */
const SANITIZER_OUTCOME: Readonly<Record<string, "redacted" | "unchanged">> = {
  // PEM blocks are redacted in place rather than prohibited.
  "tp-pem-rsa-private-key": "redacted",
  "tp-pem-openssh-private-key": "redacted",
  "tp-aws-access-key-id": "redacted",
  "tp-aws-secret-access-key-assignment": "redacted",
  "tp-github-classic-pat": "redacted",
  "tp-github-fine-grained-pat": "redacted",
  "tp-slack-bot-token": "redacted",
  "tp-google-api-key": "redacted",
  "tp-openai-project-key": "redacted",
  "tp-openai-legacy-key": "redacted",
  "tp-tailscale-auth-key": "redacted",
  "tp-authorization-bearer": "redacted",
  "tp-jwt-service-account": "redacted",
  "tp-unclassified-opaque-key": "redacted",
  "tp-db-password-assignment": "redacted",
  // Job results do not use `sensitivePaths`: redacting the mention of a path
  // corrupts paths (`.env.example` -> `[REDACTED].example`).
  "tp-aws-credentials-mention": "unchanged",
  "tp-dotenv-mention": "unchanged",
  "tp-multiple-spans-one-document": "redacted",
  // Hex is never a high-entropy hit in a job result.
  "fp-git-commit-sha": "unchanged",
  "fp-content-sha256-digest": "unchanged",
  // Still accepted false positives: the vendor prefix rules are unchanged.
  "fp-sku-identifier": "redacted",
  "fp-slack-prefix-in-prose": "redacted",
  // A lowercase word after "Bearer" is prose, not a token.
  "fp-bearer-word-in-prose": "unchanged",
  // `token: was`: a short lowercase word after `: ` is prose.
  "fp-key-name-in-prose": "unchanged",
  // No `sensitivePaths`.
  "fp-dotenv-example-suffix": "unchanged",
  // `XXXX…` is not random-looking, so the URL path tail survives.
  "fp-url-path-tail": "unchanged",
  // Caught here by the connection-string password rule.
  "nm-postgres-connection-string": "redacted",
  "nm-slack-webhook-short-path": "unchanged",
  "nm-short-opaque-token": "unchanged",
  "nm-already-masked-secret": "unchanged",
  // Caught here: a key cut off before its END line is redacted from BEGIN.
  "nm-pem-without-end-armour": "redacted",
  "nm-hyphen-separated-groups": "unchanged",
  "nm-value-in-prose": "unchanged",
}

function expectNoSeededSecret(output: string, what: string): void {
  for (const secret of SEEDED_SECRET_LITERALS) expect(output, `${what} leaked a seeded secret`).not.toContain(secret)
  for (const line of PEM_BODY_LINES) expect(output, `${what} leaked PEM key material`).not.toContain(line)
}

describe("redactSecretsFromText over the M5.4 redaction corpus", () => {
  it("has a decided outcome for every corpus case", () => {
    expect(Object.keys(SANITIZER_OUTCOME).sort()).toEqual(REDACTION_CORPUS.map((entry) => entry.name).sort())
  })

  for (const entry of REDACTION_CORPUS) {
    it(`${entry.kind} ${entry.name}`, () => {
      const output = redactSecretsFromText(entry.text)
      if (SANITIZER_OUTCOME[entry.name] === "unchanged") {
        expect(output).toBe(entry.text)
        return
      }
      expect(output).not.toBe(entry.text)
      expect(output).toContain("[REDACTED]")
      expect(output).not.toContain("[PROHIBITED]")
      if (entry.kind === "true_positive") expectNoSeededSecret(output, entry.name)
    })
  }

  it("keeps the text around a PEM private key", () => {
    const entry = REDACTION_CORPUS.find((candidate) => candidate.name === "tp-pem-rsa-private-key")!
    const output = redactSecretsFromText(entry.text)
    expect(output).toBe("the deploy step failed; the key it printed was\n[REDACTED]\nand nothing after it is readable")
  })

  it("redacts a PEM key cut off before its END line, body included", () => {
    const text = ["stderr tail:", "-----BEGIN OPENSSH PRIVATE KEY-----", ...PEM_BODY_LINES, "(truncated)"].join("\n")
    const output = redactSecretsFromText(text)
    expect(output).toBe("stderr tail:\n[REDACTED]\n(truncated)")
  })

  it("is stable under reapplication", () => {
    for (const entry of REDACTION_CORPUS) {
      const once = redactSecretsFromText(entry.text)
      expect(redactSecretsFromText(once), entry.name).toBe(once)
    }
  })
})

describe("redactSecretsFromText leaves job-result identifiers alone", () => {
  const untouched: ReadonlyArray<readonly [string, string]> = [
    ["git commit sha", "Checked out 8f3a2b7c9d1e4f5a6b0c3d2e1f9a8b7c6d5e4f30 (pinned by the trigger)."],
    ["short sha range", "Rebased 86abe01..987867d onto origin/dev."],
    ["uppercase sha", "Blob 8F3A2B7C9D1E4F5A6B0C3D2E1F9A8B7C6D5E4F30 differs."],
    ["sha256 digest", "image sha256:3b1f0a9c8e7d6b5a4f3e2d1c0b9a8f7e6d5c4b3a29180f7e6d5c4b3a2918076f5 pulled"],
    ["UUID", "runtime_session_id 550e8400-e29b-41d4-a716-446655440000 finished"],
    ["uppercase UUID", "correlation 9F1C2B3A-4D5E-4F60-8A7B-0C1D2E3F4A5B"],
    ["UUID without dashes", "trace 550e8400e29b41d4a716446655440000 sampled"],
    ["hex request id", "request id 0x7fa3c9e1b2d4f6a8c0e2b4d6f8a1c3e5 rejected"],
    ["hex ids grouped", "key groups 4f9c2b1d-8e7a6f5c-3b2a1908-77aa66bb-55cc44dd were listed"],
    ["absolute path", "Edited /Users/mac/Projects/AIBrigde/.claude/worktrees/agent-abd9e3e191b60db8a/src/runtime/sanitizer.ts"],
    ["deep relative path", "see tests/unit/memory/redaction/corpus-credentials.test.ts and src/server/routes/claude-dispatch.ts"],
    ["Title_Case file", "Docs/implementation-plans/Maintainance/AIBridge_Phase_1_Reliability_and_Documentation_Plan.md"],
    ["timestamped file", "wrote .playwright-mcp/console-2026-06-15T07-45-13-708Z.log"],
    ["Xcode path", "/Users/dev/Library/Developer/Xcode/DerivedData/MyApp-abc123def456/Build/Products/Debug-iphonesimulator/MyApp.app"],
    ["GitHub commit URL", "https://github.com/example/AIBridge/commit/8f3a2b7c9d1e4f5a6b0c3d2e1f9a8b7c6d5e4f30"],
    ["GitHub PR URL", "Opened https://github.com/example/AIBridge/pull/23 against dev"],
    ["SRI digest", '"integrity": "sha512-Zx9Pq2Lm4TvB7nKd3WsYf1Hq6Rt0WuE5Jc8XaZqPZx9Pq2Lm4TvB7nKd3WsYf1Hq6Rt0WuE5Jc8XaZqP=="'],
    ["camelCase identifier", "renamed buildClaudeLaunchRequestForV3Profiles to buildLaunchRequest"],
    ["SCREAMING_CASE constant", "MAX_CLAUDE_SUMMARY_LENGTH_FOR_V2_REPORTS is 16000"],
    ["ISO timestamps", "started_at 2026-11-26T08:15:30.123Z completed_at 2026-11-26T08:17:02.456Z"],
    ["job and session ids", "job_1 session ses_01JD3K8Y6Q2N4V7W9X1Z3B5C7E toolu_01A2B3C4D5E6F7G8H9J0K"],
    ["npm package", "added @anthropic-ai/claude-code@2.0.14 and typescript-eslint/parser"],
    ["word after bearer", "Configured bearer authentication for the router."],
    ["path mentioning .env", "Created .env.example and left .env untouched."],
  ]

  for (const [name, text] of untouched) {
    it(name, () => {
      expect(redactSecretsFromText(text)).toBe(text)
    })
  }

  it("leaves a realistic Claude job summary byte-for-byte unchanged", () => {
    const summary = [
      "Fixed the flaky retry test.",
      "",
      "- Root cause: `tests/integration/claude-trigger.test.ts` raced `JobManager.recordRuntimeResult` against the poll in",
      "  `src/runtime/claude-job-runner.ts` (introduced in 51310cd7a1b2c3d4e5f60718293a4b5c6d7e8f90).",
      "- Changed `src/jobs/manager.ts:100-112` to await the write; checkout pinned at 86abe01.",
      "- Session 550e8400-e29b-41d4-a716-446655440000, worktree /srv/aibr/worktrees/job_1/app.",
      "- bun test: 2149 pass, 0 fail (12.84s). See https://github.com/example/AIBridge/actions/runs/11923344556.",
      "",
      "Usage: $0.42 · 7 turns · claude-haiku-4-5-20251001",
    ].join("\n")
    expect(redactSecretsFromText(summary)).toBe(summary)
  })
})

describe("redactSecretsFromText still catches secrets in a job result", () => {
  it("redacts every vendor-prefixed seeded secret embedded in a summary", () => {
    const summary = [
      "Deployment notes:",
      `- GitHub: ${SEEDED_SECRETS.githubClassicPat}`,
      `- AWS: ${SEEDED_SECRETS.awsAccessKeyId}`,
      `- Slack: ${SEEDED_SECRETS.slackBotToken}`,
      `- Google: ${SEEDED_SECRETS.googleApiKey}`,
      `- OpenAI: ${SEEDED_SECRETS.openAiProjectKey}`,
      `- Tailscale: ${SEEDED_SECRETS.tailscaleAuthKey}`,
      `- JWT: ${SEEDED_SECRETS.jwt}`,
      `- opaque: ${SEEDED_SECRETS.unclassifiedOpaqueKey}`,
      `- header: Authorization: Bearer ${SEEDED_SECRETS.bearerOpaqueToken}`,
      `- env: AWS_SECRET_ACCESS_KEY=${SEEDED_SECRETS.awsSecretAccessKey}`,
      `- env: DB_PASSWORD=${SEEDED_SECRETS.dbPasswordValue}`,
      "- commit 8f3a2b7c9d1e4f5a6b0c3d2e1f9a8b7c6d5e4f30 in src/runtime/sanitizer.ts",
    ].join("\n")
    const output = redactSecretsFromText(summary)
    expectNoSeededSecret(output, "summary")
    expect(output).toContain("Authorization: Bearer [REDACTED]")
    expect(output).toContain("AWS_SECRET_ACCESS_KEY=[REDACTED]")
    expect(output).toContain("- commit 8f3a2b7c9d1e4f5a6b0c3d2e1f9a8b7c6d5e4f30 in src/runtime/sanitizer.ts")
  })

  it("catches at least 95% of random 40-character base64 and base64url secrets", () => {
    const alphabets = [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
    ]
    // A fixed linear congruential generator: the measurement is reproducible.
    let state = 20261126
    const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648
    for (const alphabet of alphabets) {
      let caught = 0
      const samples = 2000
      for (let index = 0; index < samples; index += 1) {
        let secret = ""
        for (let position = 0; position < 40; position += 1) secret += alphabet[Math.floor(next() * 64)]
        if (!redactSecretsFromText(`the service key ${secret} must be rotated`).includes(secret)) caught += 1
      }
      expect(caught / samples).toBeGreaterThanOrEqual(0.95)
    }
  })
})

describe("redactSecretsFromText env-style secret assignments", () => {
  const redacted: ReadonlyArray<readonly [string, string]> = [
    ["POSTGRES_PASSWORD=brisk-otter-93v", "POSTGRES_PASSWORD=[REDACTED]"],
    ["export GITHUB_TOKEN=plainvalue123", "export GITHUB_TOKEN=[REDACTED]"],
    ["api_key: plainvalue123", "api_key: [REDACTED]"],
    ["DB_PASSWD = hunter2hunter2", "DB_PASSWD = [REDACTED]"],
    ["APP_SECRET='single quoted value'", "APP_SECRET='[REDACTED]'"],
    ['"client_secret": "json-value-1234"', '"client_secret": "[REDACTED]"'],
    ["STRIPE_APIKEY=abc12345", "STRIPE_APIKEY=[REDACTED]"],
    ["MINIO_ACCESS_KEY=minioadmin", "MINIO_ACCESS_KEY=[REDACTED]"],
    ["SIGNING_PRIVATE_KEY=keymaterial", "SIGNING_PRIVATE_KEY=[REDACTED]"],
    ["run with --password=hunter2x now", "run with --password=[REDACTED] now"],
    ["PASSWORD=changeme\nNEXT=1", "PASSWORD=[REDACTED]\nNEXT=1"],
    ["db_password: Hunter2-prod", "db_password: [REDACTED]"],
    ["GET /jobs/abc?token=s3cr3t-value", "GET /jobs/abc?token=[REDACTED]"],
  ]
  for (const [input, expected] of redacted) {
    it(`redacts only the value: ${input.split("\n")[0]}`, () => {
      expect(redactSecretsFromText(input)).toBe(expected)
    })
  }

  const untouched: ReadonlyArray<readonly [string, string]> = [
    ["empty value", "POSTGRES_PASSWORD=\nNEXT=1"],
    ["empty quoted value", 'GITHUB_TOKEN=""'],
    ["$VAR reference", "POSTGRES_PASSWORD=$DB_PASS"],
    ["${VAR} reference", "export GITHUB_TOKEN=${GH_TOKEN}"],
    ["process.env member path", "const apiKey = process.env.API_KEY"],
    ["indexed code expression", "password: options.environment[config.opencode.password_env],"],
    ["call expression", "const password = getPassword()"],
    ["type annotation", "readonly password: string"],
    ["comparison", "if (password === undefined) return"],
    ["arrow function", "const token => token.trim()"],
    ["colon without space", "github_token:abc123"],
    ["key not ending in a credential word", "TOKEN_TTL=3600 and PASSWORD_MIN_LENGTH=12"],
    ["plural key", "max_tokens=4096"],
    ["camelCase key", "bearerToken: plainvalue123, const hasExistingToken = await pathExists(p)"],
    ["camelCase variable value", "OPENCODE_SERVER_PASSWORD: ocPassword"],
    ["literal with a method call", 'secret: "A".repeat(24)'],
    ["value shorter than 8 after =", "STRIPE_APIKEY=abc123 and PASSWORD=x"],
    ["value shorter than 8 after : ", "api_key: abc1234"],
    ["prose: token: every", "This REPLACES the existing token: every peer still using the old one"],
    ["prose: token: set", "No operator token: set AIBRIDGE_OPERATOR_TOKEN or create the file"],
    ["prose: token: the", "// no per-peer token: the profile's shared token stays"],
    ["prose: token: was", "the dispatch token: was not accepted by the scheduler"],
    ["lowercase word after : ", "gpg passphrase: correcthorse"],
    ["quoted value with a space after : ", '"client_secret": "json value here"'],
  ]
  for (const [name, text] of untouched) {
    it(`leaves ${name} alone`, () => {
      expect(redactSecretsFromText(text)).toBe(text)
    })
  }

  it("still redacts a snake_case word after `: ` (known false positive)", () => {
    // `prohibited_content` has an underscore, so it is not all lowercase letters.
    expect(redactSecretsFromText("  - m-secret: prohibited_content (detail withheld)")).toBe("  - m-secret: [REDACTED] (detail withheld)")
  })
})

describe("redactSecretsFromText connection-string passwords", () => {
  const redacted: ReadonlyArray<readonly [string, string]> = [
    ["postgres://aibridge:hunter2@db.internal:5432/app", "postgres://aibridge:[REDACTED]@db.internal:5432/app"],
    ["mongodb+srv://admin:s3cr%40t@cluster0.example.net/db", "mongodb+srv://admin:[REDACTED]@cluster0.example.net/db"],
    ["redis://:onlypassword@cache:6379/0", "redis://:[REDACTED]@cache:6379/0"],
    ["git clone https://bot:ghtoken123@example.com/org/repo.git", "git clone https://bot:[REDACTED]@example.com/org/repo.git"],
    ["amqp://guest:guest@rabbit//", "amqp://guest:[REDACTED]@rabbit//"],
  ]
  for (const [input, expected] of redacted) {
    it(`redacts only the password: ${input}`, () => {
      expect(redactSecretsFromText(input)).toBe(expected)
    })
  }

  const untouched: ReadonlyArray<readonly [string, string]> = [
    ["user without password", "postgres://aibridge@db.internal:5432/app"],
    ["host and port", "http://dev-main.tailnet:8787/report"],
    ["$VAR password", "postgres://app:${DB_PASS}@db:5432/app"],
    ["scp-style git remote", "git@github.com:example/AIBridge.git"],
    ["email address", "mailto:someone@example.com"],
  ]
  for (const [name, text] of untouched) {
    it(`leaves ${name} alone`, () => {
      expect(redactSecretsFromText(text)).toBe(text)
    })
  }
})

describe("redactSecretsFromText known-secret list", () => {
  it("replaces every occurrence of a known secret of six or more characters", () => {
    expect(redactSecretsFromText("a hunter2-x b hunter2-x", ["hunter2-x"])).toBe("a [REDACTED] b [REDACTED]")
  })

  it("ignores known secrets shorter than six characters and empty ones", () => {
    expect(redactSecretsFromText("abcde stays", ["abcde", ""])).toBe("abcde stays")
  })

  it("redacts a known secret that no detector would recognise", () => {
    expect(redactSecretsFromText("token=plain-words-here", ["plain-words-here"])).toBe("token=[REDACTED]")
  })
})

describe("isOpaqueSecretRun", () => {
  it("accepts random mixed-case runs and rejects hex, SRI digests, paths and words", () => {
    expect(isOpaqueSecretRun(SEEDED_SECRETS.unclassifiedOpaqueKey)).toBe(true)
    expect(isOpaqueSecretRun("8f3a2b7c9d1e4f5a6b0c3d2e1f9a8b7c6d5e4f30")).toBe(false)
    expect(isOpaqueSecretRun("550e8400-e29b-41d4-a716-446655440000")).toBe(false)
    expect(isOpaqueSecretRun("sha512-Zx9Pq2Lm4TvB7nKd3WsYf1Hq6Rt0WuE5Jc8XaZqP")).toBe(false)
    expect(isOpaqueSecretRun("Users/dev/Projects/MyApp2/src/components/Button")).toBe(false)
    expect(isOpaqueSecretRun("AIBridge_Phase_1_Reliability_and_Documentation_Plan")).toBe(false)
  })

  it("accepts a path-shaped run whose segment is a random token", () => {
    expect(isOpaqueSecretRun(`com/services/hooks/${SEEDED_SECRETS.unclassifiedOpaqueKey}`)).toBe(true)
  })
})

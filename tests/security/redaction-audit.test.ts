import { describe, expect, it } from "vitest"
import {
  redactString,
  redactValue,
} from "../../src/observability/redaction.js"

describe("Observability Redaction Engine Audit (M8.3)", () => {
  it("redacts prompts and sensitive content by key name", () => {
    const input = {
      jobId: "job-1",
      prompt: "SECRET PROMPT: How do I hack the mainframe?",
      terminal_content: "\x1b[31mSuper sensitive shell output\x1b[0m",
      memory_payload: { sensitiveFact: "User password is 123" },
      transcript: "User: show me credentials",
      safeAttribute: "normal value",
    }

    const redacted = redactValue(input) as Record<string, unknown>
    expect(redacted.prompt).toBe("[REDACTED_CONTENT]")
    expect(redacted.terminal_content).toBe("[REDACTED_CONTENT]")
    expect(redacted.memory_payload).toBe("[REDACTED_CONTENT]")
    expect(redacted.transcript).toBe("[REDACTED_CONTENT]")
    expect(redacted.safeAttribute).toBe("normal value")
  })

  it("redacts credentials and token keys", () => {
    const input = {
      authorization: "Bearer secret-token-abc",
      token: "raw-token-123",
      secret: "api-secret-key",
      password: "admin_password",
      private_key: "-----BEGIN PRIVATE KEY-----...",
      normalField: "public-id",
    }

    const redacted = redactValue(input) as Record<string, unknown>
    expect(redacted.authorization).toBe("[REDACTED_SECRET]")
    expect(redacted.token).toBe("[REDACTED_SECRET]")
    expect(redacted.secret).toBe("[REDACTED_SECRET]")
    expect(redacted.password).toBe("[REDACTED_SECRET]")
    expect(redacted.private_key).toBe("[REDACTED_SECRET]")
    expect(redacted.normalField).toBe("public-id")
  })

  it("scrubs authorization headers embedded in free text strings", () => {
    const rawText = "Failed calling http://example.com with Authorization: Bearer abcdef1234567890 for job 42"
    const cleaned = redactString(rawText)
    expect(cleaned).not.toContain("abcdef1234567890")
    expect(cleaned).toContain("[REDACTED_SECRET]")
  })

  it("redacts home directory paths outside project boundaries", () => {
    const rawPath = "Error reading /Users/bob/secrets/keys.json while in project"
    const cleaned = redactString(rawPath)
    expect(cleaned).not.toContain("bob")
    expect(cleaned).toContain("/Users/[REDACTED_USER]")
  })
})

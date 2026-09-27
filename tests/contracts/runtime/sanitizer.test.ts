import { describe, expect, it } from "vitest"
import { runtimeMetadataSchema } from "../../../src/runtime/schemas.js"
import {
  isPathContained,
  redactSecretsFromText,
  sanitizeChildProcessEnv,
} from "../../../src/runtime/sanitizer.js"

describe("Runtime Sanitizer & Security Contracts", () => {
  describe("sanitizeChildProcessEnv", () => {
    it("strips internal AIBRIDGE secrets and token variables while keeping standard PATH", () => {
      const dirtyEnv = {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/test",
        AIBRIDGE_AGENT_ID: "node-internal-secret",
        AIBRIDGE_CONFIG: "/etc/secret.json",
        OPENCODE_SERVER_PASSWORD: "super-secret-password",
        SESSION_TOKEN: "sensitive-token-123",
        CUSTOM_AUTH_HEADER: "Bearer xyz",
        ANTHROPIC_API_KEY: "sk-ant-api03-valid-key-value-1234567890",
      }

      const sanitized = sanitizeChildProcessEnv(dirtyEnv, ["ANTHROPIC_API_KEY"])
      expect(sanitized.PATH).toBe("/usr/bin:/bin")
      expect(sanitized.HOME).toBe("/Users/test")
      expect(sanitized.ANTHROPIC_API_KEY).toBe("sk-ant-api03-valid-key-value-1234567890")

      // Secrets strictly removed
      expect(sanitized.AIBRIDGE_AGENT_ID).toBeUndefined()
      expect(sanitized.AIBRIDGE_CONFIG).toBeUndefined()
      expect(sanitized.OPENCODE_SERVER_PASSWORD).toBeUndefined()
      expect(sanitized.SESSION_TOKEN).toBeUndefined()
      expect(sanitized.CUSTOM_AUTH_HEADER).toBeUndefined()
    })
  })

  describe("redactSecretsFromText", () => {
    it("redacts known secrets and common API key patterns", () => {
      const rawText = "Connecting with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456 and bearer secret-bridge-token-xyz"
      const redacted = redactSecretsFromText(rawText, ["secret-bridge-token-xyz"])
      expect(redacted).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456")
      expect(redacted).not.toContain("secret-bridge-token-xyz")
      expect(redacted).toContain("[REDACTED]")
    })
  })

  describe("runtimeMetadataSchema credential rejection", () => {
    it("strictly rejects metadata keys naming credentials, tokens, secrets, or passwords", () => {
      expect(() => runtimeMetadataSchema.parse({ token: "123" })).toThrow()
      expect(() => runtimeMetadataSchema.parse({ userPassword: "123" })).toThrow()
      expect(() => runtimeMetadataSchema.parse({ apiSecret: "123" })).toThrow()
      expect(() => runtimeMetadataSchema.parse({ providerCredential: "123" })).toThrow()
      expect(() => runtimeMetadataSchema.parse({ validHandle: "handle-123" })).not.toThrow()
    })
  })

  describe("isPathContained", () => {
    it("allows paths strictly within project boundary and rejects escaping paths", () => {
      const root = "/workspace/project"
      expect(isPathContained("/workspace/project", root)).toBe(true)
      expect(isPathContained("/workspace/project/src/index.ts", root)).toBe(true)
      expect(isPathContained("/workspace/project/sub/dir/file.txt", root)).toBe(true)

      // Rejections
      expect(isPathContained("/workspace/project/../etc/passwd", root)).toBe(false)
      expect(isPathContained("/etc/passwd", root)).toBe(false)
      expect(isPathContained("/workspace/other-project", root)).toBe(false)
    })
  })
})

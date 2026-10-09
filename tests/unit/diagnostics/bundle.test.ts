import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  generateSupportBundle,
  previewSupportBundle,
  supportBundleSchema,
} from "../../../src/diagnostics/index.js"
import { createSqliteDriver } from "../../../src/orchestration/event-store/sqlite-driver.js"
import type { StructuredLogEntry } from "../../../src/observability/types.js"
import { CLI_VERSION } from "../../../src/version.js"

const SECRET_CANARY = "CANARY_TOKEN_TOP_SECRET_98765"

describe("Diagnostics Support Bundle (M8.4, M7-C3)", () => {
  it("generates a support bundle matching schema without leaking secrets or payloads", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "aibr-bundle-test-"))
    const dbPath = join(tempDir, "ingress_outbox.sqlite")

    try {
      const driver = createSqliteDriver({ path: dbPath, create: true })
      driver.exec(`
        CREATE TABLE ingress_outbox (
          job_id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INT NOT NULL,
          terminal_error TEXT
        );
        INSERT INTO ingress_outbox VALUES ('job-1', '{"secret_payload":"sensitive"}', 'failed', 8, 'DEST_TIMEOUT');
      `)
      driver.close()

      const errors: StructuredLogEntry[] = [
        {
          timestamp: "2026-10-01T12:00:00.000Z",
          level: "error",
          event: "outbox.failed",
          jobId: "job-1",
          correlationId: "corr-100",
          nodeId: "node-alpha",
          errorCode: "DEST_TIMEOUT",
          attributes: {
            sensitiveHeader: `Bearer ${SECRET_CANARY}`,
            userPrompt: "confidential prompt",
          },
        },
      ]

      const bundle = generateSupportBundle(
        {
          profile: "dev-main",
          stateDir: tempDir,
          customSecrets: [SECRET_CANARY],
        },
        {
          routerVersion: "0.1.0",
          loggerErrors: errors,
          configData: {
            agent_id: "dev-main",
            bridge: {
              ingress_mode: "router",
              port: 8787,
              tailscale_bind_host: "100.64.0.1",
            },
            agents: [{ id: "test-vps" }],
          },
        },
      )

      // 1. Validates against schema
      const parseResult = supportBundleSchema.safeParse(bundle)
      expect(parseResult.success).toBe(true)

      // 2. M7-C3: router version, bind-preflight, outbox integrity without payload contents
      expect(bundle.versions.routerVersion).toBe("0.1.0")
      expect(bundle.health.bindPreflight.ok).toBe(true)
      const outboxDb = bundle.integrity.databases["ingress_outbox.sqlite"]
      expect(outboxDb).toBeDefined()
      expect(outboxDb?.status).toBe("healthy")

      // 3. Sensitive secret audit
      const serialized = JSON.stringify(bundle)
      expect(serialized.includes(SECRET_CANARY)).toBe(false)
      expect(serialized.includes("sensitive_payload")).toBe(false)

      // 4. Preserves correlation IDs in recent errors
      expect(bundle.recentRedactedErrors.length).toBe(1)
      const err = bundle.recentRedactedErrors[0]!
      expect(err.jobId).toBe("job-1")
      expect(err.correlationId).toBe("corr-100")
      expect(err.nodeId).toBe("node-alpha")
      expect(err.attributes?.sensitiveHeader).toBe("Bearer [REDACTED_CANARY_SECRET]")
      // 5. Preview generation
      const preview = previewSupportBundle(bundle)
      expect(preview).toContain("AIBridge Support Bundle (dev-main)")
      expect(preview).toContain(`Versions: npm ${CLI_VERSION} | Router: 0.1.0`)
      expect(preview).not.toContain(SECRET_CANARY)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

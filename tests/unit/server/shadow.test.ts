/**
 * M7.4 tests: bridge.ingress_mode flag, shadow mode mirroring, and divergence tracking.
 */

import { describe, expect, it } from "vitest"
import { bridgeConfigSchema } from "../../../src/config/schemas.js"
import { ShadowIngressMirror } from "../../../src/server/shadow.js"
import { runCli, type CliDeps } from "../../../src/cli.js"
import { testConfig } from "../../integration/fixtures.js"

describe("M7.4 ingress_mode flag and shadow mode", () => {
  it("bridge.ingress_mode defaults to 'engine' when absent", () => {
    const rawConfig = {
      agent_id: "test-vps",
      bridge: { host: "127.0.0.1", port: 8787, public_url: "http://test-vps.tailnet:8787" },
      opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096, username: "opencode", password_env: "OPENCODE_SERVER_PASSWORD" },
      security: { auth_mode: "bearer-token", allowed_sources: [] },
      permissions: { default_response: "reject", allow_tools: ["read"], require_plan_approval_for_tools: ["bash"] },
      projects: [{ id: "app", path: "/tmp", capabilities: ["testing"] }],
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787", capabilities: ["development"] }],
      timeouts: { default_job_seconds: 60, callback_retry_attempts: 1 },
      planning: { plan_annotator_enabled: true, require_approval_for: [] },
    }

    const parsed = bridgeConfigSchema.parse(rawConfig)
    expect(parsed.bridge.ingress_mode).toBe("engine")
  })

  it("bridge.ingress_mode accepts 'router'", () => {
    const config = testConfig()
    config.bridge.ingress_mode = "router"
    const parsed = bridgeConfigSchema.parse(config)
    expect(parsed.bridge.ingress_mode).toBe("router")
  })

  it("bridge.ingress_mode rejects unknown values", () => {
    const config = testConfig() as unknown as Record<string, unknown>
    ;(config.bridge as Record<string, unknown>).ingress_mode = "invalid-mode"
    expect(() => bridgeConfigSchema.parse(config)).toThrow()
  })

  describe("ShadowIngressMirror", () => {
    const config = testConfig()
    config.projects = [{ id: "temp", path: process.cwd(), capabilities: ["testing"] }]
    const mirror = new ShadowIngressMirror(config)

    it("evaluates a valid trigger identically to engine admission", () => {
      const payload = {
        schemaVersion: "v1",
        job_id: "job_valid_123",
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        capability: "testing",
        project_dir: process.cwd(),
        prompt: "test",
        callback_url: "http://dev-main.tailnet:8787/report",
        timeout_seconds: 60,
      }

      const result = mirror.evaluateTier1Trigger(payload)
      expect(result.admitted).toBe(true)

      // Mirror admission agrees with engine admission
      mirror.mirrorTrigger(payload, true)
      const stats = mirror.getStats()
      expect(stats.divergences).toBe(0)
      expect(stats.matches).toBe(1)
    })

    it("detects F-01 traversal in job_id", () => {
      const payload = {
        schemaVersion: "v1",
        job_id: "../escaped",
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        capability: "testing",
        project_dir: process.cwd(),
        prompt: "test",
        callback_url: "http://dev-main.tailnet:8787/report",
        timeout_seconds: 60,
      }

      const result = mirror.evaluateTier1Trigger(payload)
      expect(result.admitted).toBe(false)
      expect(result.reason).toBe("JOB_ID_TRAVERSAL_OR_INVALID_CHARSET")
    })

    it("detects F-06 unversioned or invalid schemaVersion", () => {
      const payload = {
        schemaVersion: "v2",
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        capability: "testing",
        project_dir: process.cwd(),
        prompt: "test",
        callback_url: "http://dev-main.tailnet:8787/report",
        timeout_seconds: 60,
      }

      const result = mirror.evaluateTier1Trigger(payload)
      expect(result.admitted).toBe(false)
      expect(result.reason).toBe("UNKNOWN_OR_MISSING_SCHEMA_VERSION")
    })

    it("evaluates a valid report", () => {
      const payload = {
        schemaVersion: "v1",
        job_id: "job_report_123",
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        status: "completed",
        summary: "done",
        findings: [],
        artifacts: [],
        started_at: "2026-10-04T00:00:00.000Z",
        completed_at: "2026-10-04T00:01:00.000Z",
      }

      const result = mirror.evaluateTier1Report(payload)
      expect(result.admitted).toBe(true)

      mirror.mirrorReport(payload, true)
      const stats = mirror.getStats()
      expect(stats.divergences).toBe(0)
    })
  })

  describe("CLI --shadow-mode flag", () => {
    it("parses --shadow-mode and passes it to serveBridge", async () => {
      let passedShadowMode: boolean | undefined
      const fakeDeps: CliDeps = {
        writer: () => {},
        isTTY: false,
        runSetup: async () => ({ kind: "persisted" }),
        startProfile: async () => ({ kind: "started", sessionName: "test" }),
        serveBridge: async (_profile, options) => {
          passedShadowMode = options?.shadowMode
        },
        runWorker: async () => {},
        statusProfile: async () => ({ kind: "healthy", sessionName: "test" }),
        runOpencode: async () => {},
        version: "0.1.0",
      }

      const exitCode = await runCli(["serve", "-p", "dev", "--shadow-mode"], fakeDeps)
      expect(exitCode).toBe(0)
      expect(passedShadowMode).toBe(true)
    })
  })
})

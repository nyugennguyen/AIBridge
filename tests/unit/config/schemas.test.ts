import { describe, expect, it } from "vitest"
import { bridgeConfigSchema, triggerRequestSchema, triggerResponseSchema } from "../../../src/config/schemas.js"

describe("AIBridge schemas", () => {
  it("accepts source authorization, permission policy, and planning config", () => {
    const parsed = bridgeConfigSchema.parse({
      agent_id: "test-vps",
      bridge: { host: "0.0.0.0", port: 8787, public_url: "http://test-vps.tailnet:8787" },
      opencode: { base_url: "http://127.0.0.1:4096", server_port: 4096, username: "opencode", password_env: "OPENCODE_SERVER_PASSWORD" },
      security: {
        auth_mode: "bearer-token",
        bearer_token: "secret",
        allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["testing"], requires_plan_approval: ["deployment"] }],
      },
      permissions: { default_response: "reject", allow_tools: ["read", "grep", "glob"], require_plan_approval_for_tools: ["bash", "edit", "write"] },
      projects: [{ id: "app", path: "/srv/apps/app", capabilities: ["testing"] }],
      agents: [{ id: "dev-main", url: "http://dev-main.tailnet:8787", capabilities: ["development"] }],
      timeouts: { default_job_seconds: 1800, callback_retry_attempts: 3 },
      planning: { plan_annotator_enabled: true, require_approval_for: ["deployment", "multi-agent-fanout"] },
    })

    expect(parsed.security.allowed_sources[0].source_agent_id).toBe("dev-main")
  })

  it("validates approved plan metadata on trigger requests", () => {
    const parsed = triggerRequestSchema.parse({
      source_agent_id: "dev-main",
      target_agent_id: "test-vps",
      capability: "testing",
      project_dir: "/srv/apps/app",
      prompt: "Run tests and report failures.",
      callback_url: "http://dev-main.tailnet:8787/report",
      timeout_seconds: 1800,
      metadata: { plan_status: "approved", plan_reference: ".omo/plans/test.md" },
    })

    expect(parsed.metadata?.plan_status).toBe("approved")
  })

  it("validates immediate trigger response shape", () => {
    const parsed = triggerResponseSchema.parse({
      accepted: true,
      job_id: "job_1",
      target_agent_id: "test-vps",
      opencode_session_id: "ses_1",
      status_url: "http://test-vps.tailnet:8787/jobs/job_1",
    })

    expect(parsed.accepted).toBe(true)
  })

  describe("extension fields: depends_on and task_id", () => {
    it("accepts depends_on array in trigger request", () => {
      const parsed = triggerRequestSchema.parse({
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        capability: "testing",
        project_dir: "/srv/apps/app",
        prompt: "Run tests.",
        callback_url: "http://dev-main.tailnet:8787/report",
        timeout_seconds: 1800,
        depends_on: ["job_1", "job_2"],
      })

      expect(parsed.depends_on).toEqual(["job_1", "job_2"])
    })

    it("defaults depends_on to empty array when omitted", () => {
      const parsed = triggerRequestSchema.parse({
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        capability: "testing",
        project_dir: "/srv/apps/app",
        prompt: "Run tests.",
        callback_url: "http://dev-main.tailnet:8787/report",
        timeout_seconds: 1800,
      })

      expect(parsed.depends_on).toEqual([])
    })

    it("accepts task_id string in trigger request", () => {
      const parsed = triggerRequestSchema.parse({
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        capability: "testing",
        project_dir: "/srv/apps/app",
        prompt: "Run tests.",
        callback_url: "http://dev-main.tailnet:8787/report",
        timeout_seconds: 1800,
        task_id: "#3",
      })

      expect(parsed.task_id).toBe("#3")
    })

    it("task_id is undefined when omitted", () => {
      const parsed = triggerRequestSchema.parse({
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        capability: "testing",
        project_dir: "/srv/apps/app",
        prompt: "Run tests.",
        callback_url: "http://dev-main.tailnet:8787/report",
        timeout_seconds: 1800,
      })

      expect(parsed.task_id).toBeUndefined()
    })

    it("accepts status and task_id in trigger response", () => {
      const parsed = triggerResponseSchema.parse({
        accepted: true,
        job_id: "job_1",
        target_agent_id: "test-vps",
        status_url: "http://test-vps.tailnet:8787/jobs/job_1",
        status: "blocked",
        task_id: "#3",
      })

      expect(parsed.status).toBe("blocked")
      expect(parsed.task_id).toBe("#3")
    })

    it("accepts accepted status in trigger response", () => {
      const parsed = triggerResponseSchema.parse({
        accepted: true,
        job_id: "job_1",
        target_agent_id: "test-vps",
        opencode_session_id: "ses_1",
        status_url: "http://test-vps.tailnet:8787/jobs/job_1",
        status: "accepted",
      })

      expect(parsed.status).toBe("accepted")
    })

    it("rejects invalid status value in trigger response", () => {
      expect(() =>
        triggerResponseSchema.parse({
          accepted: true,
          job_id: "job_1",
          target_agent_id: "test-vps",
          status_url: "http://test-vps.tailnet:8787/jobs/job_1",
          status: "running",
        }),
      ).toThrow()
    })
  })
})

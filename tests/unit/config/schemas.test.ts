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
})

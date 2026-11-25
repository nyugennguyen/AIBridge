import { describe, expect, it } from "vitest"
import type { BridgeConfig, CapabilityProfile } from "../../../src/config/types.js"
import type { JobRecord } from "../../../src/jobs/types.js"
import { digestDispatchEnvelope } from "../../../src/orchestration/digest.js"
import { buildClaudeLaunchArgs, validateClaudeLaunchProfile } from "../../../src/runtime/claude-adapter.js"
import {
  authorizeClaudeCapability,
  buildClaudeLaunchProfile,
  buildClaudeLaunchRequest,
  CLAUDE_INSTALLATION_ID,
  CLAUDE_SAFETY_FLOOR_DENY,
  claudeTimeoutSeconds,
  createConfigProjectResolver,
  maxConcurrentJobs,
  permissionDenialFindings,
  toOpaqueId,
  worktreePathId,
} from "../../../src/runtime/claude-job-runner.js"
import { testConfig, validTrigger } from "../../integration/fixtures.js"

function config(profiles: Record<string, Partial<CapabilityProfile>>, overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  const { opencode: _opencode, ...base } = testConfig()
  return {
    ...base,
    runtime: { kind: "claude" },
    capability_profiles: Object.fromEntries(
      Object.entries(profiles).map(([name, profile]) => [name, { requires_approval: false, ...profile }]),
    ),
    ...overrides,
  }
}

function job(overrides: Partial<JobRecord> = {}, trigger: Record<string, unknown> = {}): JobRecord {
  return {
    id: "job_1",
    trigger: validTrigger({ capability: "investigate", ...trigger }) as JobRecord["trigger"],
    status: "accepted",
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
    ...overrides,
  }
}

describe("CLAUDE_SAFETY_FLOOR_DENY", () => {
  it("is frozen and covers secrets, AIBridge state and shell egress", () => {
    expect(Object.isFrozen(CLAUDE_SAFETY_FLOOR_DENY)).toBe(true)
    expect(CLAUDE_SAFETY_FLOOR_DENY).toEqual(
      expect.arrayContaining(["Read(./.env*)", "Read(**/.env*)", "Read(~/.ssh/**)", "Read(~/.local/share/aibridge/**)", "Bash(curl *)"]),
    )
    // Current rule syntax only.
    for (const rule of CLAUDE_SAFETY_FLOOR_DENY) expect(rule).not.toMatch(/:\*\)/)
  })

  it("cannot be removed by a profile: deny is unioned, and allow cannot re-add a floor rule", () => {
    const profile = buildClaudeLaunchProfile(
      config({ wide: { allow: ["Bash", "Read", "Bash(curl *)", "Read(./.env*)"], deny: [] } }),
      "wide",
    )
    expect(profile.disallowedTools).toEqual(expect.arrayContaining([...CLAUDE_SAFETY_FLOOR_DENY]))
    expect(profile.allowedTools).toEqual(["Bash", "Read"])
    expect(profile.permissionMode).toBe("dontAsk")
  })

  it("keeps the floor when the profile has its own deny list, without duplicates", () => {
    const profile = buildClaudeLaunchProfile(config({ p: { deny: ["Edit", "Bash(curl *)"] } }), "p")
    expect(profile.disallowedTools).toEqual([...CLAUDE_SAFETY_FLOOR_DENY, "Edit"])
  })

  it("reaches argv after --disallowedTools for every launch", () => {
    const profile = buildClaudeLaunchProfile(config({ p: {} }), "p")
    expect(validateClaudeLaunchProfile(profile)).toBeUndefined()
    const args = buildClaudeLaunchArgs({ providerSessionId: "11111111-2222-4333-8444-555555555555", profile })
    const start = args.indexOf("--disallowedTools")
    expect(args.slice(start + 1, start + 1 + CLAUDE_SAFETY_FLOOR_DENY.length)).toEqual([...CLAUDE_SAFETY_FLOOR_DENY])
    expect(args).toContain("--strict-mcp-config")
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user")
  })
})

describe("buildClaudeLaunchProfile", () => {
  it("maps profile caps and the claude block", () => {
    const profile = buildClaudeLaunchProfile(
      config(
        { p: { allow: ["Read"], max_budget_usd: 1.5, max_turns: 12, append_system_prompt: "Be brief." } },
        { claude: { settings_path: "/etc/aibridge/claude-settings.json", setting_sources: ["user", "local"], strict_mcp_config: false } },
      ),
      "p",
    )
    expect(profile).toMatchObject({
      maxBudgetUsd: 1.5,
      maxTurns: 12,
      appendSystemPrompt: "Be brief.",
      settingsPath: "/etc/aibridge/claude-settings.json",
      settingSources: ["user", "local"],
      strictMcpConfig: false,
    })
  })

  it("throws for an unknown profile", () => {
    expect(() => buildClaudeLaunchProfile(config({}), "nope")).toThrow(/Unknown capability profile/)
  })
})

describe("authorizeClaudeCapability", () => {
  const trigger = (capability: string, extra: Record<string, unknown> = {}) =>
    validTrigger({ capability, ...extra }) as JobRecord["trigger"]

  it("refuses unknown and inherited capabilities, and marks approval-gated ones whatever the metadata says", () => {
    const cfg = config({ ok: {}, gated: { requires_approval: true }, scripted: { script: "x.sh" } })
    expect(authorizeClaudeCapability(cfg, trigger("missing"))).toMatchObject({ ok: false, statusCode: 403, body: { code: "unknown_capability_profile" } })
    expect(authorizeClaudeCapability(cfg, trigger("toString"))).toMatchObject({ ok: false, statusCode: 403 })
    expect(
      authorizeClaudeCapability(cfg, trigger("gated", { metadata: { plan_status: "approved" } })),
    ).toMatchObject({ ok: true, approvalRequired: true })
    expect(authorizeClaudeCapability(cfg, trigger("scripted"))).toMatchObject({ ok: true, approvalRequired: false })
    expect(authorizeClaudeCapability(cfg, trigger("ok"))).toMatchObject({ ok: true, name: "ok", approvalRequired: false })
  })

  it("treats planning.require_approval_for and source requires_plan_approval as approval-gated without trusting metadata", () => {
    const cfg = config({ ok: {} }, { planning: { plan_annotator_enabled: false, require_approval_for: ["ok"] } })
    expect(authorizeClaudeCapability(cfg, trigger("ok", { metadata: { plan_status: "approved" } }))).toMatchObject({
      ok: true,
      approvalRequired: true,
    })
    const bySource = config(
      { ok: {} },
      {
        security: {
          auth_mode: "bearer-token",
          allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["ok"], requires_plan_approval: ["ok"] }],
        },
      },
    )
    expect(authorizeClaudeCapability(bySource, trigger("ok", { metadata: { plan_status: "approved" } }))).toMatchObject({
      approvalRequired: true,
    })
  })
})

describe("maxConcurrentJobs", () => {
  it("defaults to 2 and follows limits.max_concurrent_jobs", () => {
    expect(maxConcurrentJobs(config({}))).toBe(2)
    expect(maxConcurrentJobs(config({}, { limits: { max_concurrent_jobs: 5 } }))).toBe(5)
  })
})

describe("buildClaudeLaunchRequest", () => {
  it("builds a valid, digest-stamped envelope for the allowlisted project", () => {
    const cfg = config({ investigate: { timeout_s: 120, model: "claude-haiku" } })
    const request = buildClaudeLaunchRequest({ config: cfg, job: job(), nodeId: "test-vps", installationId: CLAUDE_INSTALLATION_ID, now: "2026-11-25T00:00:00.000Z" })
    expect(request.dispatchEnvelopeDigest).toBe(digestDispatchEnvelope(request.dispatchEnvelope))
    expect(request.dispatchEnvelope.runtimeKind).toBe("claude")
    expect(request.dispatchEnvelope.requestedCapabilities).toEqual(["investigate"])
    expect(request.dispatchEnvelope.timeoutSeconds).toBe(120)
    expect(request.dispatchEnvelope.model).toBe("claude-haiku")
    expect(request.dispatchEnvelope.prompt).toBe("Run tests.")
  })

  it("derives opaque ids from caller-chosen job ids that are not valid kernel ids", () => {
    const cfg = config({ investigate: {} })
    const request = buildClaudeLaunchRequest({
      config: cfg,
      job: job({ id: "weird/job id" }, { job_id: "weird/job id" }),
      nodeId: "test-vps",
      installationId: CLAUDE_INSTALLATION_ID,
      now: "2026-11-25T00:00:00.000Z",
    })
    expect(request.dispatchEnvelope.dispatchId).toMatch(/^dispatch-[0-9a-f]{40}$/)
    expect(toOpaqueId("job_1", "job")).toBe("job_1")
  })

  it("refuses a project directory that is not allowlisted", () => {
    expect(() =>
      buildClaudeLaunchRequest({
        config: config({ investigate: {} }),
        job: job({}, { project_dir: "/etc" }),
        nodeId: "test-vps",
        installationId: CLAUDE_INSTALLATION_ID,
        now: "2026-11-25T00:00:00.000Z",
      }),
    ).toThrow(/not allowlisted/)
  })

  it("falls back to the trigger timeout", () => {
    expect(claudeTimeoutSeconds(config({ investigate: {} }), job().trigger)).toBe(60)
  })

  it("points a pinned job at its worktree, names the sha, and carries the operator approval id", () => {
    const sha = "a".repeat(40)
    const request = buildClaudeLaunchRequest({
      config: config({ investigate: {} }),
      job: job({
        checkout: { repo: "app", ref: "main", sha },
        approval: { status: "approved", requestedAt: "2026-11-25T00:00:00.000Z", decidedAt: "2026-11-25T00:01:00.000Z", decidedBy: "operator" },
      }),
      nodeId: "test-vps",
      installationId: CLAUDE_INSTALLATION_ID,
      now: "2026-11-25T00:00:00.000Z",
      inWorktree: true,
      timeoutSeconds: 30,
    })
    expect(request.dispatchEnvelope.projectPathId).toBe(worktreePathId("job_1"))
    expect(request.dispatchEnvelope.projectId).toBe("app")
    expect(request.dispatchEnvelope.timeoutSeconds).toBe(30)
    expect(request.dispatchEnvelope.roleSnapshot.instructions).toContain(sha)
    expect(request.approvalId).toBe("approval-job_1")
  })
})

describe("createConfigProjectResolver", () => {
  it("resolves only allowlisted project ids", async () => {
    const resolver = createConfigProjectResolver(testConfig().projects)
    expect(await resolver.resolve({ projectId: "app", projectPathId: "app", nodeId: "n" })).toEqual({ ok: true, value: "/srv/apps/app" })
    expect((await resolver.resolve({ projectId: "x", projectPathId: "x", nodeId: "n" })).ok).toBe(false)
  })

  it("resolves a worktree id only while the runner has registered it", async () => {
    const worktrees = new Map([[worktreePathId("job_1"), "/state/worktrees/job_1"]])
    const resolver = createConfigProjectResolver(testConfig().projects, worktrees)
    const scope = { projectId: "app", projectPathId: worktreePathId("job_1"), nodeId: "n" }
    expect(await resolver.resolve(scope)).toEqual({ ok: true, value: "/state/worktrees/job_1" })
    worktrees.clear()
    expect((await resolver.resolve(scope)).ok).toBe(false)
  })
})

describe("permissionDenialFindings", () => {
  it("de-duplicates by tool and input, and bounds the list", () => {
    const denials = [
      { toolName: "Bash", inputPreview: '{"command":"curl x"}', source: "stream" as const },
      { toolName: "Bash", inputPreview: '{"command":"curl x"}', source: "result" as const },
      ...Array.from({ length: 60 }, (_, index) => ({ toolName: "Edit", inputPreview: `${index}`, source: "result" as const })),
    ]
    const findings = permissionDenialFindings(denials, "investigate")
    expect(findings).toHaveLength(51)
    expect(findings[0]).toEqual({
      severity: "medium",
      title: "Tool denied: Bash",
      details: 'Denied by capability profile "investigate". Input: {"command":"curl x"}',
    })
    expect(findings[50]).toMatchObject({ severity: "low", title: "Further tool denials omitted" })
  })
})

/**
 * Runtime selection, capability profiles and the `claude` block in the bridge
 * config (Phase 2). Every config written before these fields existed must
 * parse with its meaning unchanged.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bridgeConfigSchema, triggerResponseSchema } from "../../../src/config/schemas.js"

const CONFIG_DIRECTORY = join(import.meta.dirname, "../../../config")

function readExample(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CONFIG_DIRECTORY, name), "utf8")) as Record<string, unknown>
}

const legacyExamples = readdirSync(CONFIG_DIRECTORY).filter(
  (name) => name.endsWith(".example.json") && name !== "claude-staging.example.json",
)

describe("bridge config back-compat", () => {
  it.each(legacyExamples)("%s parses as an OpenCode worker, unchanged", (name) => {
    const raw = readExample(name)
    const parsed = bridgeConfigSchema.parse(raw)
    expect(parsed.role).toBe("worker")
    expect(parsed.runtime).toEqual({ kind: "opencode" })
    expect(parsed.opencode).toEqual({ ...(raw.opencode as object) })
    expect(parsed.capability_profiles).toBeUndefined()
    expect(parsed.claude).toBeUndefined()
  })

  it("still requires the opencode block for the default runtime, with a clear message", () => {
    const { opencode: _opencode, ...raw } = readExample("test-vps.example.json")
    const result = bridgeConfigSchema.safeParse(raw)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(["opencode"])
    expect(result.error?.issues[0]?.message).toMatch(/required when runtime\.kind is "opencode"/)
  })

  it("accepts exactly the keys the setup wizard writes", () => {
    const base = readExample("dev-main.example.json")
    for (const role of ["worker", "orchestrator", "both"]) {
      for (const kind of ["opencode", "claude"]) {
        const parsed = bridgeConfigSchema.parse({ ...base, bridge: { ...(base.bridge as object), ingress_mode: "engine" }, role, runtime: { kind } })
        expect(parsed.role).toBe(role)
        expect(parsed.runtime.kind).toBe(kind)
      }
    }
    expect(bridgeConfigSchema.safeParse({ ...base, role: "leader" }).success).toBe(false)
    expect(bridgeConfigSchema.safeParse({ ...base, runtime: { kind: "codex" } }).success).toBe(false)
  })
})

describe("claude runtime config", () => {
  it("parses the claude-staging example with no opencode block", () => {
    const parsed = bridgeConfigSchema.parse(readExample("claude-staging.example.json"))
    expect(parsed.runtime.kind).toBe("claude")
    expect(parsed.opencode).toBeUndefined()
    expect(Object.keys(parsed.capability_profiles ?? {})).toEqual(["investigate", "run-tests", "fix-on-branch"])
    expect(parsed.capability_profiles?.investigate?.requires_approval).toBe(false)
    expect(parsed.capability_profiles?.["fix-on-branch"]?.requires_approval).toBe(true)
    // New rule syntax only: `Bash(cmd *)`, never the old `Bash(cmd:*)`.
    for (const profile of Object.values(parsed.capability_profiles ?? {})) {
      for (const rule of [...(profile.allow ?? []), ...(profile.deny ?? [])]) expect(rule).not.toMatch(/:\*\)/)
    }
  })

  it("defaults the claude block to user settings only and strict MCP", () => {
    const raw = readExample("claude-staging.example.json")
    const parsed = bridgeConfigSchema.parse({ ...raw, claude: {} })
    expect(parsed.claude).toEqual({ setting_sources: ["user"], strict_mcp_config: true })
  })

  it("rejects invalid profile values and names", () => {
    const raw = readExample("claude-staging.example.json")
    const withProfile = (profile: unknown, name = "p") => bridgeConfigSchema.safeParse({ ...raw, capability_profiles: { [name]: profile } })
    expect(withProfile({ max_budget_usd: 0 }).success).toBe(false)
    expect(withProfile({ max_turns: 1.5 }).success).toBe(false)
    expect(withProfile({ timeout_s: -1 }).success).toBe(false)
    expect(withProfile({ allow: [""] }).success).toBe(false)
    expect(withProfile({}, "has space").success).toBe(false)
    expect(withProfile({ script: "scripts/deploy.sh", requires_approval: true }).success).toBe(true)
  })

  it("refuses runtime claude behind the router ingress, whose drain loop only launches OpenCode", () => {
    const raw = readExample("claude-staging.example.json")
    const result = bridgeConfigSchema.safeParse({ ...raw, bridge: { ...(raw.bridge as object), ingress_mode: "router" } })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(["bridge", "ingress_mode"])
  })

  it("lets a trigger response carry runtime_session_id", () => {
    const parsed = triggerResponseSchema.parse({
      accepted: true,
      job_id: "job_1",
      target_agent_id: "staging",
      runtime_session_id: "11111111-2222-4333-8444-555555555555",
      status_url: "http://staging.tailnet:8787/jobs/job_1",
    })
    expect(parsed.runtime_session_id).toBe("11111111-2222-4333-8444-555555555555")
  })
})

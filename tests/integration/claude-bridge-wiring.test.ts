/**
 * `startBridge` with a Claude profile: the runner is wired, OpenCode is never
 * constructed against a server, and `/health` reports the runtime.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { startBridge } from "../../src/bridge.js"
import { createRuntime } from "../../src/ingress/runtime.js"

const EXAMPLE = join(import.meta.dirname, "../../config/claude-staging.example.json")

async function writeClaudeConfig(): Promise<{ configPath: string; stateDir: string }> {
  const directory = await mkdtemp(join(tmpdir(), "aibridge-claude-wiring-"))
  const configPath = join(directory, "config.json")
  await writeFile(configPath, await readFile(EXAMPLE, "utf8"))
  return { configPath, stateDir: join(directory, "state") }
}

describe("Claude runtime wiring", () => {
  it("startBridge sweeps stale worktrees, records approval requests in <state>/approvals.jsonl and serves operator routes", async () => {
    const { configPath, stateDir } = await writeClaudeConfig()
    await mkdir(join(stateDir, "worktrees", "job_left_behind"), { recursive: true })
    const bridge = await startBridge({
      configPath,
      stateDir,
      bearerToken: "secret",
      operatorToken: "operator-secret",
      profileName: "staging",
      environment: {},
    })
    expect(await readdir(join(stateDir, "worktrees"))).toEqual([])

    const triggered = await bridge.app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: {
        job_id: "job_1",
        source_agent_id: "dev-main",
        target_agent_id: "staging",
        capability: "fix-on-branch",
        project_dir: "/srv/apps/app-under-test",
        prompt: "Fix it.",
        callback_url: "http://dev-main.tailnet:8787/report",
        timeout_seconds: 600,
      },
    })
    expect(triggered.statusCode).toBe(202)
    expect(triggered.json()).toMatchObject({ status: "awaiting_approval", approve_hint: "aibr approve job_1 --profile staging" })
    const ledger = (await readFile(join(stateDir, "approvals.jsonl"), "utf8")).trim().split("\n")
    expect(ledger).toHaveLength(1)
    expect(JSON.parse(ledger[0]!)).toMatchObject({ seq: 1, type: "approval.requested", jobId: "job_1" })
    expect(ledger[0]).not.toContain("operator-secret")

    const pending = await bridge.app.inject({ method: "GET", url: "/operator/pending-jobs", headers: { authorization: "Bearer operator-secret" } })
    expect(pending.json().jobs.map((job: { job_id: string }) => job.job_id)).toEqual(["job_1"])
    const peer = await bridge.app.inject({ method: "GET", url: "/operator/pending-jobs", headers: { authorization: "Bearer secret" } })
    expect(peer.statusCode).toBe(403)
  })

  it("createRuntime builds a Claude runner and an inert OpenCode client", async () => {
    const { configPath, stateDir } = await writeClaudeConfig()
    const runtime = await createRuntime({ configPath, stateDir, bearerToken: "secret", environment: {} })
    expect(runtime.claudeJobRunner).toBeDefined()
    expect(runtime.claudeJobRunner?.nodeId).toBe("staging")
    expect(await runtime.opencodeClient.health()).toBe(false)
    await expect(runtime.opencodeClient.createSession("x", "/srv")).rejects.toThrow(/not configured/)
  })

  it("startBridge serves /health with runtime claude", async () => {
    const { configPath, stateDir } = await writeClaudeConfig()
    const bridge = await startBridge({ configPath, stateDir, bearerToken: "secret", environment: {} })
    const response = await bridge.app.inject({ method: "GET", url: "/health" })
    expect(response.json()).toEqual({
      ok: true,
      runtime: "claude",
      agent_id: "staging",
      capabilities: ["deploy", "fix-on-branch", "investigate", "run-tests"],
    })
  })

  it("an OpenCode profile gets no Claude runner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibridge-opencode-wiring-"))
    const configPath = join(directory, "config.json")
    await writeFile(configPath, await readFile(join(import.meta.dirname, "../../config/dev-main.example.json"), "utf8"))
    const runtime = await createRuntime({ configPath, stateDir: join(directory, "state"), bearerToken: "secret", environment: {} })
    expect(runtime.claudeJobRunner).toBeUndefined()
  })
})

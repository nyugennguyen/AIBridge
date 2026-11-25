/**
 * `startBridge` with a Claude profile: the runner is wired, OpenCode is never
 * constructed against a server, and `/health` reports the runtime.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
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
      capabilities: ["fix-on-branch", "investigate", "run-tests"],
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

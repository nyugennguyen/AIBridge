/**
 * Claude Code runs as the leader of its own process group: `terminate` stops
 * the tools and shells it started with it, and each spawned process is handed
 * to `trackProcess` (recorded until it exits).
 */
import { EventEmitter } from "node:events"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import { isProcessAlive, readProcessGroupId } from "../../../src/host/process-identity.js"
import { ClaudeCodeRuntimeAdapter, type ProcessHandle } from "../../../src/runtime/claude-adapter.js"
import { createTestLaunchRequest, createTestOperationContext } from "../../contracts/runtime/conformance-helpers.js"

const created: string[] = []
afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true })
})

class ExitingProcess extends EventEmitter implements ProcessHandle {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  kill(): boolean {
    return true
  }
}

const resolveProject = (directory: string) => ({
  async resolve() {
    return { ok: true as const, value: directory }
  },
})

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
}

describe("ClaudeCodeRuntimeAdapter process group and tracking", () => {
  it("with an injected spawn: no process group unless asked; tracked at spawn, cleared on exit", async () => {
    const spawned: Array<{ detached?: boolean; proc: ExitingProcess }> = []
    const tracked: unknown[] = []
    let cleared = 0
    const adapter = new ClaudeCodeRuntimeAdapter({
      executablePath: "claude-mock",
      nodeId: "node-contract",
      installationId: "installation-contract",
      projects: resolveProject("/workspace/contract"),
      spawn: (_command, _args, options) => {
        const proc = new ExitingProcess()
        spawned.push({ ...(options.detached !== undefined ? { detached: options.detached } : {}), proc })
        return proc
      },
      trackProcess: (spawn) => {
        tracked.push(spawn)
        return () => void (cleared += 1)
      },
    })
    const request = await createTestLaunchRequest({ commandId: "track", runtimeKind: "claude", dispatchId: "dispatch-track" })
    expect((await adapter.launch(request)).ok).toBe(true)
    expect(spawned[0]?.detached).toBeUndefined()
    expect(tracked).toEqual([{ dispatchId: "dispatch-track", pid: 4242, processGroup: false }])
    expect(cleared).toBe(0)
    spawned[0]!.proc.stdout.end()
    spawned[0]!.proc.emit("exit", 0, null)
    spawned[0]!.proc.emit("exit", 0, null)
    expect(cleared).toBe(2) // the clear function itself is idempotent (FileRuntimeProcessRegistry)
  })

  it("asks for a detached spawn when processGroup is set", async () => {
    let detached: boolean | undefined
    const adapter = new ClaudeCodeRuntimeAdapter({
      executablePath: "claude-mock",
      nodeId: "node-contract",
      installationId: "installation-contract",
      projects: resolveProject("/workspace/contract"),
      processGroup: true,
      spawn: (_command, _args, options) => {
        detached = options.detached
        return new ExitingProcess()
      },
    })
    const request = await createTestLaunchRequest({ commandId: "group", runtimeKind: "claude", dispatchId: "dispatch-group" })
    expect((await adapter.launch(request)).ok).toBe(true)
    expect(detached).toBe(true)
  })

  // `stubborn`: Claude ignores SIGTERM (SIGKILL after 3 s). `prompt`: Claude
  // exits on SIGTERM at once, but a tool it started ignores it: that tool must
  // be killed when Claude exits, not on a timer a closing bridge may not run.
  it.each([
    ["stubborn", `process.on("SIGTERM", () => {})`, 8_000],
    ["prompt", ``, 1_500],
  ] as const)("real spawn (%s leader): leads its own group; terminate stops it and a grandchild ignoring SIGTERM", async (_name, leaderTerm, within) => {
    const directory = await mkdtemp(join(tmpdir(), "aibridge-claude-group-"))
    created.push(directory)
    const pidFile = join(directory, "pids")
    const fakeClaude = join(directory, "fake-claude.js")
    await writeFile(
      fakeClaude,
      `#!${process.execPath}
${leaderTerm}
const { spawn } = require("node:child_process")
const grandchild = spawn(${JSON.stringify(process.execPath)}, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, process.pid + " " + grandchild.pid)
setInterval(() => {}, 1000)
`,
    )
    await chmod(fakeClaude, 0o755)
    const tracked: Array<{ pid: number; processGroup: boolean }> = []
    let cleared = false
    const adapter = new ClaudeCodeRuntimeAdapter({
      executablePath: fakeClaude,
      nodeId: "node-contract",
      installationId: "installation-contract",
      projects: resolveProject(directory),
      env: { PATH: process.env.PATH },
      trackProcess: (spawn) => {
        tracked.push(spawn)
        return () => void (cleared = true)
      },
    })
    const request = await createTestLaunchRequest({ commandId: "real", runtimeKind: "claude", dispatchId: "dispatch-real" })
    const launched = await adapter.launch(request)
    if (!launched.ok) throw new Error(launched.error.message)
    let pids: number[] = []
    for (let attempt = 0; attempt < 250 && pids.length < 2; attempt += 1) {
      pids = (await readFile(pidFile, "utf8").catch(() => "")).trim().split(" ").filter(Boolean).map(Number)
      if (pids.length < 2) await new Promise((done) => setTimeout(done, 20))
    }
    const [claudePid, grandchildPid] = pids as [number, number]
    try {
      expect(tracked).toEqual([{ dispatchId: "dispatch-real", pid: claudePid, processGroup: true }])
      expect(readProcessGroupId(claudePid)).toBe(claudePid)
      expect(readProcessGroupId(grandchildPid)).toBe(claudePid)

      await adapter.terminate(launched.value, createTestOperationContext("real-terminate"))
      await waitFor(() => !isProcessAlive(claudePid) && !isProcessAlive(grandchildPid), within)
      expect(isProcessAlive(claudePid)).toBe(false)
      expect(isProcessAlive(grandchildPid)).toBe(false)
      expect(cleared).toBe(true)
    } finally {
      for (const pid of [claudePid, grandchildPid]) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          /* gone */
        }
      }
    }
  }, 15_000)
})

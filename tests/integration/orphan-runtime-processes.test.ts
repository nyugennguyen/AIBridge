/**
 * Runtime processes left by a bridge that died without cleaning up, with real
 * processes: a "bridge" (a Bun script running the real runtime) launches a
 * fake `claude` and a script step, both of which ignore SIGTERM and start a
 * grandchild that ignores it too; the bridge is SIGKILLed; the next startup
 * stops all four and reports the jobs `interrupted: bridge restarted`.
 *
 * Also: the record of a process is cleared when it exits normally, and the
 * normal stop paths (kill switch, timeout, bridge close) stop the whole group.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { startBridge } from "../../src/bridge.js"
import { isProcessAlive, readProcessGroupId } from "../../src/host/process-identity.js"
import { createRuntime } from "../../src/ingress/runtime.js"
import { INTERRUPTED_BY_RESTART, reconcileJobsAfterRestart } from "../../src/jobs/reconcile.js"
import { RUNTIME_PROCESSES_DIR } from "../../src/runtime/process-registry.js"
import { STOPPED_BY_BRIDGE_SHUTDOWN } from "../../src/runtime/claude-job-runner.js"

const EXAMPLE = join(import.meta.dirname, "../../config/claude-staging.example.json")
const SRC_RUNTIME = join(import.meta.dirname, "../../src/ingress/runtime.ts")

/** Every PID a test saw, killed (SIGKILL) afterwards whatever happened. */
const seenPids = new Set<number>()
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
  for (const pid of seenPids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* gone */
    }
  }
  seenPids.clear()
})

interface Profile {
  readonly directory: string
  readonly configPath: string
  readonly stateDir: string
  readonly projectDir: string
  readonly claudePids: string
  readonly scriptPids: string
}

/**
 * A Claude profile whose `claude` is a fake that ignores SIGTERM and starts a
 * grandchild (same process group) that ignores it too, and writes both PIDs.
 * `slow-script` runs `slow.sh`, which does the same; `quick` times out after 1 s.
 */
async function profile(fakeClaudeBody?: string): Promise<Profile> {
  const directory = await mkdtemp(join(tmpdir(), "aibridge-orphans-"))
  const projectDir = join(directory, "project")
  await mkdir(projectDir)
  const claudePids = join(directory, "claude.pids")
  const scriptPids = join(directory, "script.pids")
  const fakeClaude = join(directory, "fake-claude.js")
  await writeFile(
    fakeClaude,
    `#!${process.execPath}\n` +
      (fakeClaudeBody ??
        `process.on("SIGTERM", () => {})
const { spawn } = require("node:child_process")
const grandchild = spawn(${JSON.stringify(process.execPath)}, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })
require("node:fs").writeFileSync(${JSON.stringify(claudePids)}, process.pid + " " + grandchild.pid)
setInterval(() => {}, 1000)
`),
  )
  await chmod(fakeClaude, 0o755)
  await writeFile(join(projectDir, "slow.sh"), `#!/bin/sh\ntrap '' TERM\nsleep 300 &\necho "$$ $!" > ${JSON.stringify(scriptPids)}\nwait\n`)
  await chmod(join(projectDir, "slow.sh"), 0o755)

  const config = JSON.parse(await readFile(EXAMPLE, "utf8")) as Record<string, any>
  config.runtime.executable = fakeClaude
  config.capability_profiles["slow-script"] = { script: "slow.sh", timeout_s: 600 }
  config.capability_profiles.quick = { allow: ["Read"], timeout_s: 1 }
  config.projects[0].path = projectDir
  config.projects[0].capabilities.push("slow-script", "quick")
  config.security.allowed_sources[0].capabilities.push("slow-script", "quick")
  config.agents = config.agents.map((agent: Record<string, unknown>) => ({ ...agent, url: "http://127.0.0.1:9" }))
  const configPath = join(directory, "config.json")
  await writeFile(configPath, JSON.stringify(config, null, 2))
  return { directory, configPath, stateDir: join(directory, "state"), projectDir, claudePids, scriptPids }
}

function trigger(id: string, capability: string, projectDir: string): Record<string, unknown> {
  return {
    job_id: id,
    source_agent_id: "dev-main",
    target_agent_id: "staging",
    capability,
    project_dir: projectDir,
    prompt: `Do ${id}.`,
    callback_url: "http://127.0.0.1:9/report",
    timeout_seconds: 600,
  }
}

async function until<T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** The two PIDs a fake wrote (`<leader> <grandchild>`), once both are there. */
async function pidsFrom(file: string): Promise<[number, number]> {
  const pids = await until(
    async () => {
      const values = (await readFile(file, "utf8").catch(() => "")).trim().split(/\s+/).filter(Boolean).map(Number)
      return values.length === 2 ? (values as [number, number]) : undefined
    },
    10_000,
    file,
  )
  for (const pid of pids) seenPids.add(pid)
  return pids
}

async function allGone(pids: readonly number[], timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (pids.some(isProcessAlive) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
  return !pids.some(isProcessAlive)
}

describe("runtime processes left by a killed bridge", () => {
  it("are stopped at the next startup (with their grandchildren), and their jobs end interrupted", async () => {
    const p = await profile()
    const bridgeScript = join(p.directory, "bridge.ts")
    await writeFile(
      bridgeScript,
      `import { createRuntime } from ${JSON.stringify(SRC_RUNTIME)}
const runtime = await createRuntime({ configPath: ${JSON.stringify(p.configPath)}, stateDir: ${JSON.stringify(p.stateDir)}, bearerToken: null, environment: { PATH: process.env.PATH ?? "" } })
const runner = runtime.claudeJobRunner!
const triggers = ${JSON.stringify([trigger("job_claude", "investigate", p.projectDir), trigger("job_script", "slow-script", p.projectDir)])}
for (const request of triggers) {
  const job = await runtime.jobManager.createJob(request as never)
  void runner.monitor(await runner.start(job))
}
console.log("started")
setInterval(() => {}, 1000)
`,
    )
    const bridge = spawn("bun", [bridgeScript], { stdio: ["ignore", "pipe", "pipe"] })
    children.push(bridge)
    let output = ""
    bridge.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()))
    bridge.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()))
    await until(() => (output.includes("started") ? true : undefined), 20_000, `the bridge to start (output: ${output})`).catch((error) => {
      throw new Error(`${(error as Error).message}: ${output}`)
    })
    const [claudePid, claudeGrandchild] = await pidsFrom(p.claudePids)
    const [scriptPid, scriptGrandchild] = await pidsFrom(p.scriptPids)
    expect(readProcessGroupId(claudeGrandchild)).toBe(claudePid)
    expect(readProcessGroupId(scriptGrandchild)).toBe(scriptPid)
    expect(await readdir(join(p.stateDir, RUNTIME_PROCESSES_DIR))).toHaveLength(2)

    // The bridge dies without cleaning up.
    const exited = new Promise((done) => bridge.once("exit", done))
    bridge.kill("SIGKILL")
    await exited
    expect([claudePid, claudeGrandchild, scriptPid, scriptGrandchild].every(isProcessAlive)).toBe(true)

    // The next startup.
    const logs: string[] = []
    const runtime = await createRuntime({
      configPath: p.configPath,
      stateDir: p.stateDir,
      bearerToken: null,
      environment: {},
      log: (level, message) => logs.push(`${level} ${message}`),
    })
    expect(runtime.orphanedProcesses.map((outcome) => outcome.action)).toEqual(["terminated", "terminated"])
    expect(await allGone([claudePid, claudeGrandchild, scriptPid, scriptGrandchild])).toBe(true)
    expect(logs.join("\n")).toMatch(new RegExp(`stopped claude process ${claudePid} of job job_claude`))
    expect(logs.join("\n")).toMatch(new RegExp(`stopped script process ${scriptPid} of job job_script`))
    expect(await readdir(join(p.stateDir, RUNTIME_PROCESSES_DIR))).toEqual([])

    const reconciled = await reconcileJobsAfterRestart({ jobManager: runtime.jobManager, config: runtime.config })
    expect(reconciled.interrupted.map((job) => job.id).sort()).toEqual(["job_claude", "job_script"])
    for (const id of ["job_claude", "job_script"]) {
      expect(await runtime.jobManager.getJob(id)).toMatchObject({ status: "failed", error: INTERRUPTED_BY_RESTART })
    }
  }, 40_000)

  it("a record is cleared when its process exits normally", async () => {
    const p = await profile(`setTimeout(() => process.exit(0), 300)\n`)
    const runtime = await createRuntime({ configPath: p.configPath, stateDir: p.stateDir, bearerToken: null, environment: { PATH: process.env.PATH ?? "" } })
    const runner = runtime.claudeJobRunner!
    const job = await runtime.jobManager.createJob(trigger("job_short", "investigate", p.projectDir) as never)
    const launch = await runner.start(job)
    const records = await readdir(join(p.stateDir, RUNTIME_PROCESSES_DIR))
    expect(records).toHaveLength(1)
    const record = JSON.parse(await readFile(join(p.stateDir, RUNTIME_PROCESSES_DIR, records[0]!), "utf8"))
    expect(record).toMatchObject({ jobId: "job_short", role: "claude", start: expect.stringMatching(/^(ps|linux):/) })
    expect(record.pgid).toBe(record.pid)
    await runner.monitor(launch)
    expect(await readdir(join(p.stateDir, RUNTIME_PROCESSES_DIR))).toEqual([])
  }, 20_000)

  it("the kill switch and a timeout stop the whole group", async () => {
    const p = await profile()
    const runtime = await createRuntime({ configPath: p.configPath, stateDir: p.stateDir, bearerToken: null, environment: { PATH: process.env.PATH ?? "" } })
    const runner = runtime.claudeJobRunner!

    const stopped = await runtime.jobManager.createJob(trigger("job_stop", "investigate", p.projectDir) as never)
    const stoppedDone = runner.monitor(await runner.start(stopped))
    const stoppedPids = await pidsFrom(p.claudePids)
    await runner.stopAll()
    await stoppedDone
    expect(await allGone(stoppedPids)).toBe(true)

    await writeFile(p.claudePids, "")
    const timed = await runtime.jobManager.createJob(trigger("job_quick", "quick", p.projectDir) as never)
    const timedDone = runner.monitor(await runner.start(timed))
    const timedPids = await pidsFrom(p.claudePids)
    expect((await timedDone)?.status).toBe("timed_out")
    expect(await allGone(timedPids, 6_000)).toBe(true)
    expect(await readdir(join(p.stateDir, RUNTIME_PROCESSES_DIR))).toEqual([])
  }, 30_000)

  it("closing the bridge (SIGTERM, SIGINT, Ctrl-C) stops its jobs' process groups and reports them stopped", async () => {
    const p = await profile()
    const bridge = await startBridge({ configPath: p.configPath, stateDir: p.stateDir, bearerToken: "secret", environment: { PATH: process.env.PATH ?? "" } })
    const triggered = await bridge.app.inject({
      method: "POST",
      url: "/trigger",
      headers: { authorization: "Bearer secret" },
      payload: trigger("job_close", "investigate", p.projectDir),
    })
    expect(triggered.statusCode).toBe(202)
    const pids = await pidsFrom(p.claudePids)
    await bridge.app.close()
    expect(await allGone(pids)).toBe(true)
    expect(await bridge.jobManager.getJob("job_close")).toMatchObject({ status: "failed", error: STOPPED_BY_BRIDGE_SHUTDOWN })
    expect(await readdir(join(p.stateDir, RUNTIME_PROCESSES_DIR))).toEqual([])
  }, 30_000)
})

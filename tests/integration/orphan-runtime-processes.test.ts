/**
 * Runtime processes and their process groups, with real processes.
 *
 * - A bridge that dies without cleaning up: a "bridge" (a Bun script running
 *   the real runtime) launches a fake `claude` and a script step, both of
 *   which ignore SIGTERM and start a grandchild that ignores it too; the
 *   bridge is SIGKILLed; the next startup stops all four and the jobs end
 *   `interrupted: bridge restarted`.
 * - The record of a process is cleared when it exits normally.
 * - The normal stop paths (kill switch, cancel, timeout, and a real
 *   `aibr serve` receiving SIGTERM, SIGINT or SIGHUP) stop the whole group,
 *   both when the leader ignores SIGTERM and when it exits at once while a
 *   tool it started ignores SIGTERM.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
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
const SRC_CLI = join(import.meta.dirname, "../../src/cli.ts")
const PROFILE = "orphans"

/** Every PID a test saw, and every child and directory it made, cleaned up afterwards whatever happened. */
const seenPids = new Set<number>()
const children: ChildProcess[] = []
const directories: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
  for (const pid of seenPids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* gone */
    }
  }
  seenPids.clear()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/**
 * `stubborn`: the leader (fake `claude`, or the script) ignores SIGTERM.
 * `prompt`: the leader exits on SIGTERM at once. Either way the grandchild
 * it starts (same process group) ignores SIGTERM.
 */
type Leader = "stubborn" | "prompt"

interface Profile {
  readonly directory: string
  readonly env: Record<string, string>
  readonly configPath: string
  readonly stateDir: string
  readonly projectDir: string
  readonly claudePids: string
  readonly scriptPids: string
  readonly port: number
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0))
    })
  })
}

/**
 * A Claude profile laid out as `aibr serve` finds it (XDG directories under
 * one temporary directory), whose `claude` and `slow-script` behave as
 * `leader` says and write `<leader pid> <grandchild pid>`. `quick` times out
 * after 1 s. `fakeClaudeBody` replaces the fake `claude` entirely.
 */
async function profile(leader: Leader = "stubborn", fakeClaudeBody?: string): Promise<Profile> {
  const directory = await mkdtemp(join(tmpdir(), "aibridge-orphans-"))
  directories.push(directory)
  const env = {
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"),
  }
  const configDir = join(env.XDG_CONFIG_HOME, "aibridge", PROFILE)
  const secretsDir = join(env.XDG_DATA_HOME, "aibridge", PROFILE, "secrets")
  const stateDir = join(env.XDG_STATE_HOME, "aibridge", PROFILE)
  const projectDir = join(directory, "project")
  for (const dir of [configDir, secretsDir, projectDir]) await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(secretsDir, "bearer_token"), "secret", { mode: 0o600 })

  const claudePids = join(directory, "claude.pids")
  const scriptPids = join(directory, "script.pids")
  const fakeClaude = join(directory, "fake-claude.js")
  await writeFile(
    fakeClaude,
    `#!${process.execPath}\n` +
      (fakeClaudeBody ??
        `${leader === "stubborn" ? `process.on("SIGTERM", () => {})` : ""}
const { spawn } = require("node:child_process")
const grandchild = spawn(${JSON.stringify(process.execPath)}, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })
require("node:fs").writeFileSync(${JSON.stringify(claudePids)}, process.pid + " " + grandchild.pid)
setInterval(() => {}, 1000)
`),
  )
  await chmod(fakeClaude, 0o755)
  const slow =
    leader === "stubborn"
      ? `#!/bin/sh\ntrap '' TERM\nsleep 300 &\necho "$$ $!" > ${JSON.stringify(scriptPids)}\nwait\n`
      : `#!/bin/sh\n(trap '' TERM; exec sleep 300) &\necho "$$ $!" > ${JSON.stringify(scriptPids)}\nwait\n`
  await writeFile(join(projectDir, "slow.sh"), slow)
  await chmod(join(projectDir, "slow.sh"), 0o755)

  const port = await freePort()
  const config = JSON.parse(await readFile(EXAMPLE, "utf8")) as Record<string, any>
  config.bridge = { ...config.bridge, host: "127.0.0.1", port, public_url: `http://127.0.0.1:${port}` }
  config.runtime.executable = fakeClaude
  config.capability_profiles["slow-script"] = { script: "slow.sh", timeout_s: 600 }
  config.capability_profiles.quick = { allow: ["Read"], timeout_s: 1 }
  config.projects[0].path = projectDir
  config.projects[0].capabilities.push("slow-script", "quick")
  config.security.allowed_sources[0].capabilities.push("slow-script", "quick")
  config.agents = config.agents.map((agent: Record<string, unknown>) => ({ ...agent, url: "http://127.0.0.1:9" }))
  const configPath = join(configDir, "config.json")
  await writeFile(configPath, JSON.stringify(config, null, 2))
  return { directory, env, configPath, stateDir, projectDir, claudePids, scriptPids, port }
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

async function allGone(pids: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (pids.some(isProcessAlive) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
  return !pids.some(isProcessAlive)
}

/** How long after a stop settles the group may take to vanish: a prompt leader's group goes at its exit, not 3 s later. */
const GONE_WITHIN: Record<Leader, number> = { stubborn: 4_000, prompt: 1_000 }

describe("runtime processes left by a killed bridge", () => {
  it("are stopped at the next startup (with their grandchildren), and their jobs end interrupted", async () => {
    const p = await profile("stubborn")
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
    await until(() => (output.includes("started") ? true : undefined), 20_000, "the bridge to start").catch((error) => {
      throw new Error(`${(error as Error).message}: ${output}`)
    })
    const [claudePid, claudeGrandchild] = await pidsFrom(p.claudePids)
    const [scriptPid, scriptGrandchild] = await pidsFrom(p.scriptPids)
    expect(readProcessGroupId(claudeGrandchild)).toBe(claudePid)
    expect(readProcessGroupId(scriptGrandchild)).toBe(scriptPid)
    // Both records carry their start time (added asynchronously outside Linux).
    await until(
      async () => {
        const names = await readdir(join(p.stateDir, RUNTIME_PROCESSES_DIR))
        const records = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(p.stateDir, RUNTIME_PROCESSES_DIR, name), "utf8"))))
        return records.length === 2 && records.every((record) => typeof record.start === "string") ? true : undefined
      },
      10_000,
      "both records with their start time",
    )

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
    expect(await allGone([claudePid, claudeGrandchild, scriptPid, scriptGrandchild], 3_000)).toBe(true)
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
    const p = await profile("stubborn", `setTimeout(() => process.exit(0), 300)\n`)
    const runtime = await createRuntime({ configPath: p.configPath, stateDir: p.stateDir, bearerToken: null, environment: { PATH: process.env.PATH ?? "" } })
    const runner = runtime.claudeJobRunner!
    const job = await runtime.jobManager.createJob(trigger("job_short", "investigate", p.projectDir) as never)
    const launch = await runner.start(job)
    const records = await readdir(join(p.stateDir, RUNTIME_PROCESSES_DIR))
    expect(records).toHaveLength(1)
    const record = JSON.parse(await readFile(join(p.stateDir, RUNTIME_PROCESSES_DIR, records[0]!), "utf8"))
    expect(record).toMatchObject({ jobId: "job_short", role: "claude" })
    expect(record.pgid).toBe(record.pid)
    await runner.monitor(launch)
    expect(await readdir(join(p.stateDir, RUNTIME_PROCESSES_DIR))).toEqual([])
  }, 20_000)
})

describe.each(["stubborn", "prompt"] as const)("stop paths with a %s leader stop the whole group", (leader) => {
  it("the kill switch (Claude Code and a script step)", async () => {
    const p = await profile(leader)
    const runtime = await createRuntime({ configPath: p.configPath, stateDir: p.stateDir, bearerToken: null, environment: { PATH: process.env.PATH ?? "" } })
    const runner = runtime.claudeJobRunner!
    const claudeJob = await runtime.jobManager.createJob(trigger("job_stop", "investigate", p.projectDir) as never)
    const scriptJob = await runtime.jobManager.createJob(trigger("job_stop_script", "slow-script", p.projectDir) as never)
    const done = [runner.monitor(await runner.start(claudeJob)), runner.monitor(await runner.start(scriptJob))]
    const pids = [...(await pidsFrom(p.claudePids)), ...(await pidsFrom(p.scriptPids))]
    await runner.stopAll()
    await Promise.all(done)
    expect(await allGone(pids, GONE_WITHIN[leader])).toBe(true)
    expect(await readdir(join(p.stateDir, RUNTIME_PROCESSES_DIR))).toEqual([])
  }, 30_000)

  it("a cancel", async () => {
    const p = await profile(leader)
    const runtime = await createRuntime({ configPath: p.configPath, stateDir: p.stateDir, bearerToken: null, environment: { PATH: process.env.PATH ?? "" } })
    const runner = runtime.claudeJobRunner!
    const job = await runtime.jobManager.createJob(trigger("job_cancel", "investigate", p.projectDir) as never)
    const done = runner.monitor(await runner.start(job))
    const pids = await pidsFrom(p.claudePids)
    expect(await runner.stop("job_cancel", "cancelled by requester")).toBe("stopping")
    expect(await done).toMatchObject({ status: "failed", error: "cancelled by requester" })
    expect(await allGone(pids, GONE_WITHIN[leader])).toBe(true)
  }, 30_000)

  it("a timeout", async () => {
    const p = await profile(leader)
    const runtime = await createRuntime({ configPath: p.configPath, stateDir: p.stateDir, bearerToken: null, environment: { PATH: process.env.PATH ?? "" } })
    const runner = runtime.claudeJobRunner!
    const job = await runtime.jobManager.createJob(trigger("job_quick", "quick", p.projectDir) as never)
    const done = runner.monitor(await runner.start(job))
    const pids = await pidsFrom(p.claudePids)
    expect((await done)?.status).toBe("timed_out")
    expect(await allGone(pids, GONE_WITHIN[leader])).toBe(true)
    expect(await readdir(join(p.stateDir, RUNTIME_PROCESSES_DIR))).toEqual([])
  }, 30_000)

  it("closing the bridge in process (app.close)", async () => {
    const p = await profile(leader)
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
    expect(await allGone(pids, GONE_WITHIN[leader])).toBe(true)
    expect(await bridge.jobManager.getJob("job_close")).toMatchObject({ status: "failed", error: STOPPED_BY_BRIDGE_SHUTDOWN })
    expect(await readdir(join(p.stateDir, RUNTIME_PROCESSES_DIR))).toEqual([])
  }, 30_000)
})

describe("a real `aibr serve` stopped by a signal", () => {
  it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)(
    "%s: stops its jobs' process groups, reports them stopped, and exits",
    async (signal) => {
      // A prompt leader: the grandchild ignoring SIGTERM must still be gone
      // although the bridge exits as soon as the leader has.
      const p = await profile("prompt")
      const serve = spawn("bun", [SRC_CLI, "serve", "--profile", PROFILE], {
        env: { ...process.env, ...p.env, AIBR_PROFILE: PROFILE },
        stdio: ["ignore", "pipe", "pipe"],
      })
      children.push(serve)
      let output = ""
      serve.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()))
      serve.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()))
      const exited = new Promise<number | null>((resolve) => serve.once("exit", (code) => resolve(code)))
      const base = `http://127.0.0.1:${p.port}`
      await until(
        async () => ((await fetch(`${base}/health`).then((response) => response.ok, () => false)) ? true : undefined),
        20_000,
        "aibr serve to listen",
      ).catch((error) => {
        throw new Error(`${(error as Error).message}: ${output}`)
      })
      const triggered = await fetch(`${base}/trigger`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(trigger("job_signal", "investigate", p.projectDir)),
      })
      expect(triggered.status).toBe(202)
      const pids = await pidsFrom(p.claudePids)

      serve.kill(signal)
      const code = await Promise.race([exited, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 15_000))])
      expect(code, output).toBe(0)
      expect(await allGone(pids, GONE_WITHIN.prompt)).toBe(true)
      const job = JSON.parse(await readFile(join(p.stateDir, "jobs", "job_signal.json"), "utf8"))
      expect(job).toMatchObject({ status: "failed", error: STOPPED_BY_BRIDGE_SHUTDOWN })
      expect(await readdir(join(p.stateDir, RUNTIME_PROCESSES_DIR))).toEqual([])
      expect(await readFile(join(p.stateDir, "logs", "aibridge.log"), "utf8")).toContain(`stopping (${signal})`)
    },
    40_000,
  )
})

import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readProcessStartTime } from "../../../src/host/process-identity.js"
import { FileRuntimeProcessRegistry } from "../../../src/runtime/process-registry.js"
import { ScriptRunner } from "../../../src/runtime/script-runner.js"

const created: string[] = []

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await chmod(directory, 0o700).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(prefix)
  created.push(directory)
  return directory
}

async function registryDir(): Promise<string> {
  return join(await tempDir(join(tmpdir(), "aibridge-procs-")), "runtime-processes")
}

describe("FileRuntimeProcessRegistry", () => {
  it("records synchronously (pid, start, pgid, job) and clears once", async () => {
    const directory = await registryDir()
    const registry = new FileRuntimeProcessRegistry(directory, { startTimeOf: () => "ps:Mon", now: () => "T", ownerPid: 99 })
    const clear = registry.track({ jobId: "job_1", role: "claude", pid: 4242, processGroup: true })
    // No await between track and list: the record is on disk already.
    const entries = registry.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      record: { jobId: "job_1", role: "claude", pid: 4242, start: "ps:Mon", pgid: 4242, recordedAt: "T", ownerPid: 99 },
    })
    clear()
    clear()
    expect(registry.list()).toEqual([])
  })

  it("omits an unreadable start time and a pgid for a process that does not lead a group", async () => {
    const registry = new FileRuntimeProcessRegistry(await registryDir(), { startTimeOf: () => undefined })
    registry.track({ jobId: "job_1", role: "script", pid: 5, processGroup: false })
    const [entry] = registry.list()
    expect(entry && "record" in entry ? entry.record : undefined).not.toHaveProperty("start")
    expect(entry && "record" in entry ? entry.record : undefined).not.toHaveProperty("pgid")
  })

  it("lists an unreadable file with its error and ignores other names", async () => {
    const directory = await registryDir()
    const registry = new FileRuntimeProcessRegistry(directory, { startTimeOf: () => "ps:Mon" })
    registry.track({ jobId: "job_1", role: "claude", pid: 10, processGroup: true })
    await writeFile(join(directory, "broken.json"), "{")
    await writeFile(join(directory, "half.json.tmp"), "{")
    const entries = registry.list()
    expect(entries.filter((entry) => "error" in entry)).toHaveLength(1)
    expect(entries.filter((entry) => "record" in entry)).toHaveLength(1)
  })

  it("never throws when it cannot write, and says so", async () => {
    const parent = await tempDir(join(tmpdir(), "aibridge-procs-ro-"))
    await chmod(parent, 0o500)
    const errors: string[] = []
    const registry = new FileRuntimeProcessRegistry(join(parent, "runtime-processes"), { onError: (message) => errors.push(message) })
    const clear = registry.track({ jobId: "job_1", role: "claude", pid: 10, processGroup: true })
    clear()
    await chmod(parent, 0o700)
    expect(errors.join("\n")).toMatch(/could not record claude process 10 of job job_1/)
  })

  it("an asynchronous start time: the record is written at once without it, then completed", async () => {
    const directory = await registryDir()
    let answer: (value: string) => void = () => undefined
    const registry = new FileRuntimeProcessRegistry(directory, { startTimeOf: () => new Promise<string>((resolve) => (answer = resolve)) })
    registry.track({ jobId: "job_1", role: "claude", pid: 4242, processGroup: true })
    const first = registry.list()[0]
    expect(first && "record" in first ? first.record : undefined).toMatchObject({ pid: 4242, pgid: 4242 })
    expect(first && "record" in first ? first.record : undefined).not.toHaveProperty("start")
    answer("ps:Mon")
    await new Promise((done) => setTimeout(done, 10))
    const second = registry.list()[0]
    expect(second && "record" in second ? second.record.start : undefined).toBe("ps:Mon")
    expect(registry.list()).toHaveLength(1)
  })

  it("an asynchronous start time that answers after the process exited does not bring the record back", async () => {
    const directory = await registryDir()
    let answer: (value: string) => void = () => undefined
    const registry = new FileRuntimeProcessRegistry(directory, { startTimeOf: () => new Promise<string>((resolve) => (answer = resolve)) })
    const clear = registry.track({ jobId: "job_1", role: "claude", pid: 4242, processGroup: true })
    clear()
    answer("ps:Mon")
    await new Promise((done) => setTimeout(done, 10))
    expect(registry.list()).toEqual([])
  })

  it("the default start time matches readProcessStartTime", async () => {
    const directory = await registryDir()
    const registry = new FileRuntimeProcessRegistry(directory)
    const clear = registry.track({ jobId: "job_1", role: "claude", pid: process.pid, processGroup: false })
    let start: string | undefined
    for (let attempt = 0; attempt < 250 && start === undefined; attempt += 1) {
      const [entry] = registry.list()
      start = entry !== undefined && "record" in entry ? entry.record.start : undefined
      if (start === undefined) await new Promise((done) => setTimeout(done, 20))
    }
    expect(start).toBe(readProcessStartTime(process.pid))
    clear()
  })

  it("checkDirectory: absent is fine, a group/world-writable directory is made private, a symlink is refused", async () => {
    const directory = await registryDir()
    const registry = new FileRuntimeProcessRegistry(directory)
    expect(registry.checkDirectory()).toEqual({ ok: true })
    await mkdir(directory, { mode: 0o777 })
    await chmod(directory, 0o777)
    expect(registry.checkDirectory()).toEqual({ ok: true })
    expect((await stat(directory)).mode & 0o777).toBe(0o700)

    const elsewhere = await tempDir(join(tmpdir(), "aibridge-procs-target-"))
    const linked = join(await tempDir(join(tmpdir(), "aibridge-procs-link-")), "runtime-processes")
    await symlink(elsewhere, linked)
    expect(new FileRuntimeProcessRegistry(linked).checkDirectory()).toMatchObject({ ok: false, reason: expect.stringMatching(/symlink/) })
  })

  it("lists a symlinked or non-regular record as an error, never reading through it", async () => {
    const directory = await registryDir()
    const registry = new FileRuntimeProcessRegistry(directory, { startTimeOf: () => "ps:Mon" })
    registry.track({ jobId: "job_1", role: "claude", pid: 10, processGroup: true })
    const outside = join(await tempDir(join(tmpdir(), "aibridge-procs-out-")), "record.json")
    await writeFile(outside, JSON.stringify({ jobId: "job_x", pid: 4242, role: "claude", start: "ps:Mon", recordedAt: "T", ownerPid: 1 }))
    await symlink(outside, join(directory, "linked.json"))
    await mkdir(join(directory, "dir.json"))
    const errors = registry.list().filter((entry) => "error" in entry)
    expect(errors.map((entry) => ("error" in entry ? entry.error : ""))).toEqual(["not a regular file", "not a regular file"])
    expect(registry.list().filter((entry) => "record" in entry)).toHaveLength(1)
  })

  it("a script step is recorded while it runs and cleared on its normal exit", async () => {
    const directory = await registryDir()
    const cwd = await tempDir(join(tmpdir(), "aibridge-procs-script-"))
    await writeFile(join(cwd, "ok.sh"), "#!/bin/sh\nsleep 0.3\n")
    await chmod(join(cwd, "ok.sh"), 0o755)
    const registry = new FileRuntimeProcessRegistry(directory)
    const running = new ScriptRunner({ env: { PATH: process.env.PATH } }).start({
      phase: "main",
      script: "ok.sh",
      cwd,
      timeoutMs: 10_000,
      trackProcess: (pid, processGroup) => registry.track({ jobId: "job_s", role: "script", pid, processGroup }),
    })
    let seen: unknown
    for (let attempt = 0; attempt < 50 && seen === undefined; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10))
      const [entry] = registry.list()
      if (entry !== undefined && "record" in entry) seen = entry.record
    }
    expect(seen).toMatchObject({ jobId: "job_s", role: "script", pgid: expect.any(Number) })
    expect((await running.result).exit_code).toBe(0)
    expect(await readdir(directory)).toEqual([])
  })
})

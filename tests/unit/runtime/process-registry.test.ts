import { chmod, mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FileRuntimeProcessRegistry } from "../../../src/runtime/process-registry.js"
import { ScriptRunner } from "../../../src/runtime/script-runner.js"

async function registryDir(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "aibridge-procs-")), "runtime-processes")
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
    const parent = await mkdtemp(join(tmpdir(), "aibridge-procs-ro-"))
    await chmod(parent, 0o500)
    const errors: string[] = []
    const registry = new FileRuntimeProcessRegistry(join(parent, "runtime-processes"), { onError: (message) => errors.push(message) })
    const clear = registry.track({ jobId: "job_1", role: "claude", pid: 10, processGroup: true })
    clear()
    await chmod(parent, 0o700)
    expect(errors.join("\n")).toMatch(/could not record claude process 10 of job job_1/)
  })

  it("a script step is recorded while it runs and cleared on its normal exit", async () => {
    const directory = await registryDir()
    const cwd = await mkdtemp(join(tmpdir(), "aibridge-procs-script-"))
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

import { spawn } from "node:child_process"
import { mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isProcessAlive } from "../../../src/host/process-identity.js"
import { terminateOrphanedRuntimeProcesses, type OrphanTerminationOptions } from "../../../src/runtime/orphan-processes.js"
import { FileRuntimeProcessRegistry, type RegistryEntry, type RuntimeProcessRecord } from "../../../src/runtime/process-registry.js"

/** A registry over a fixed list of records; `removed` collects what was removed. */
function registryOf(records: readonly Partial<RuntimeProcessRecord>[]) {
  const removed: string[] = []
  const entries: RegistryEntry[] = records.map((record, index) => ({
    path: `/registry/${index}.json`,
    record: { jobId: `job_${index}`, role: "claude", recordedAt: "T", ownerPid: 2, pid: 0, ...record } as RuntimeProcessRecord,
  }))
  return { registry: { list: () => entries, remove: (path: string) => void removed.push(path) }, removed }
}

interface FakeProcess {
  start: string | undefined
  pgid: number
  ignoresTerm?: boolean
  /** Ignores SIGKILL too (uninterruptible). */
  unkillable?: boolean
}

/** A fake process table: `kill` follows `process.kill` semantics (negative target: group; 0: probe). */
function world(processes: Record<number, FakeProcess>) {
  const table = new Map(Object.entries(processes).map(([pid, process]) => [Number(pid), { ...process }]))
  const signals: Array<[number, NodeJS.Signals | 0]> = []
  const esrch = (): never => {
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" })
  }
  const kill = (target: number, signal: NodeJS.Signals | 0): void => {
    const members = target < 0 ? [...table].filter(([, process]) => process.pgid === -target) : table.has(target) ? [[target, table.get(target)!] as const] : []
    if (members.length === 0) esrch()
    if (signal === 0) return
    signals.push([target, signal])
    for (const [pid, process] of members) {
      if (process.unkillable) continue
      if (signal === "SIGTERM" && process.ignoresTerm) continue
      table.delete(pid)
    }
  }
  const options: Partial<OrphanTerminationOptions> = {
    platform: "darwin",
    isAlive: (pid) => table.has(pid),
    startTimeOf: (pid) => table.get(pid)?.start,
    processGroupOf: (pid) => table.get(pid)?.pgid,
    kill,
    selfPid: 100,
    selfPgid: 100,
    graceMs: 50,
    killWaitMs: 50,
    pollMs: 5,
    log: () => undefined,
  }
  return { table, signals, options }
}

describe("terminateOrphanedRuntimeProcesses", () => {
  it("verified live leader: SIGTERM to its group, nothing else; the record is removed", async () => {
    const { table, signals, options } = world({ 500: { start: "ps:A", pgid: 500 }, 501: { start: "ps:B", pgid: 500 } })
    const { registry, removed } = registryOf([{ pid: 500, start: "ps:A", pgid: 500 }])
    const [outcome] = await terminateOrphanedRuntimeProcesses({ ...options, registry })
    expect(outcome).toMatchObject({ action: "terminated", signal: "SIGTERM", group: true })
    expect(signals).toEqual([[-500, "SIGTERM"]])
    expect(table.size).toBe(0)
    expect(removed).toEqual(["/registry/0.json"])
  })

  it("escalates to SIGKILL when the group ignores SIGTERM", async () => {
    const { table, signals, options } = world({ 500: { start: "ps:A", pgid: 500, ignoresTerm: true }, 501: { start: "ps:B", pgid: 500, ignoresTerm: true } })
    const { registry } = registryOf([{ pid: 500, start: "ps:A", pgid: 500 }])
    const [outcome] = await terminateOrphanedRuntimeProcesses({ ...options, registry })
    expect(outcome).toMatchObject({ action: "terminated", signal: "SIGKILL", group: true })
    expect(signals).toEqual([
      [-500, "SIGTERM"],
      [-500, "SIGKILL"],
    ])
    expect(table.size).toBe(0)
  })

  it("kills what is left of the group when the leader exits but a member ignores SIGTERM", async () => {
    const { table, signals, options } = world({ 500: { start: "ps:A", pgid: 500 }, 501: { start: "ps:B", pgid: 500, ignoresTerm: true } })
    const { registry } = registryOf([{ pid: 500, start: "ps:A", pgid: 500 }])
    const [outcome] = await terminateOrphanedRuntimeProcesses({ ...options, registry })
    expect(outcome).toMatchObject({ action: "terminated", signal: "SIGKILL", group: true })
    expect(signals.map(([, signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"])
    expect(table.size).toBe(0)
  })

  it("process without a recorded group: signals the PID only", async () => {
    const { signals, options } = world({ 500: { start: "ps:A", pgid: 7, ignoresTerm: true } })
    const { registry } = registryOf([{ pid: 500, start: "ps:A" }])
    const [outcome] = await terminateOrphanedRuntimeProcesses({ ...options, registry })
    expect(outcome).toMatchObject({ action: "terminated", signal: "SIGKILL", group: false })
    expect(signals).toEqual([
      [500, "SIGTERM"],
      [500, "SIGKILL"],
    ])
  })

  it("a verified process that no longer leads its recorded group: the process only", async () => {
    const { signals, options } = world({ 500: { start: "ps:A", pgid: 77 }, 501: { start: "ps:B", pgid: 77 } })
    const { registry } = registryOf([{ pid: 500, start: "ps:A", pgid: 500 }])
    await terminateOrphanedRuntimeProcesses({ ...options, registry })
    expect(signals).toEqual([[500, "SIGTERM"]])
  })

  it("never signals a live PID whose start time differs, is unreadable, was not recorded, or is of another form", async () => {
    const cases: Array<[FakeProcess, Partial<RuntimeProcessRecord>, string]> = [
      [{ start: "ps:OTHER", pgid: 500 }, { start: "ps:A" }, "reused"],
      [{ start: undefined, pgid: 500 }, { start: "ps:A" }, "unverified"],
      [{ start: "ps:A", pgid: 500 }, {}, "unverified"],
      [{ start: "ps:A", pgid: 500 }, { start: "" }, "unverified"],
      [{ start: "linux:boot:1", pgid: 500 }, { start: "ps:A" }, "unverified"],
    ]
    for (const [live, recorded, action] of cases) {
      const { table, signals, options } = world({ 500: live })
      const { registry, removed } = registryOf([{ pid: 500, pgid: 500, ...recorded }])
      const [outcome] = await terminateOrphanedRuntimeProcesses({ ...options, registry })
      expect(outcome?.action, JSON.stringify(recorded)).toBe(action)
      expect(signals, JSON.stringify(recorded)).toEqual([])
      expect(table.has(500)).toBe(true)
      expect(removed).toHaveLength(1)
    }
  })

  it("does nothing for a dead PID", async () => {
    const { signals, options } = world({})
    const { registry } = registryOf([{ pid: 500, start: "ps:A", pgid: 500 }])
    const [outcome] = await terminateOrphanedRuntimeProcesses({ ...options, registry })
    expect(outcome?.action).toBe("gone")
    expect(signals).toEqual([])
  })

  it("refuses PID 0, 1, negative, this process, and this process's group, even when verified", async () => {
    const { table, signals, options } = world({
      1: { start: "ps:init", pgid: 1 },
      100: { start: "ps:self", pgid: 100 },
      300: { start: "ps:C", pgid: 100 },
    })
    const { registry } = registryOf([
      { pid: 0, start: "ps:x" },
      { pid: 1, start: "ps:init", pgid: 1 },
      { pid: -5, start: "ps:x" },
      { pid: 100, start: "ps:self", pgid: 100 },
      { pid: 300, start: "ps:C", pgid: 100 },
      { pid: 300, start: "ps:C", pgid: 1 },
    ])
    const outcomes = await terminateOrphanedRuntimeProcesses({ ...options, registry })
    expect(outcomes.map((outcome) => outcome.action)).toEqual(["refused", "refused", "refused", "refused", "refused", "refused"])
    expect(signals).toEqual([])
    expect(table.size).toBe(3)
  })

  it("refuses a PID that leads this process's group", async () => {
    const { signals, options } = world({ 400: { start: "ps:L", pgid: 400 } })
    const { registry } = registryOf([{ pid: 400, start: "ps:L" }])
    const [outcome] = await terminateOrphanedRuntimeProcesses({ ...options, selfPgid: 400, registry })
    expect(outcome?.action).toBe("refused")
    expect(signals).toEqual([])
  })

  it("does not SIGKILL a leader that can no longer be verified after the grace", async () => {
    const { table, signals, options } = world({ 500: { start: "ps:A", pgid: 500, ignoresTerm: true } })
    const { registry } = registryOf([{ pid: 500, start: "ps:A", pgid: 500 }])
    let reads = 0
    const [outcome] = await terminateOrphanedRuntimeProcesses({
      ...options,
      registry,
      startTimeOf: (pid) => (++reads === 1 ? table.get(pid)?.start : undefined),
    })
    expect(outcome?.action).toBe("unverified")
    expect(signals).toEqual([[-500, "SIGTERM"]])
  })

  it("reports a process that survives SIGKILL", async () => {
    const { options } = world({ 500: { start: "ps:A", pgid: 500, ignoresTerm: true, unkillable: true } })
    const { registry } = registryOf([{ pid: 500, start: "ps:A", pgid: 500 }])
    const [outcome] = await terminateOrphanedRuntimeProcesses({ ...options, registry })
    expect(outcome).toMatchObject({ action: "survived", group: true })
  })

  it("handles every record in parallel: total time is about one grace, not one per record", async () => {
    const processes: Record<number, FakeProcess> = {}
    const records: Partial<RuntimeProcessRecord>[] = []
    for (let pid = 500; pid < 510; pid += 1) {
      processes[pid] = { start: `ps:${pid}`, pgid: pid, ignoresTerm: true }
      records.push({ pid, start: `ps:${pid}`, pgid: pid })
    }
    const { table, options } = world(processes)
    const { registry } = registryOf(records)
    const started = Date.now()
    const outcomes = await terminateOrphanedRuntimeProcesses({ ...options, registry, graceMs: 200, killWaitMs: 100 })
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(outcomes.every((outcome) => outcome.action === "terminated")).toBe(true)
    expect(table.size).toBe(0)
  })

  it("refuses a record whose process group is not the process itself", async () => {
    const { signals, options } = world({ 500: { start: "ps:A", pgid: 600 }, 600: { start: "ps:B", pgid: 600 } })
    const { registry } = registryOf([{ pid: 500, start: "ps:A", pgid: 600 }])
    const [outcome] = await terminateOrphanedRuntimeProcesses({ ...options, registry })
    expect(outcome).toMatchObject({ action: "refused", reason: expect.stringMatching(/process group 600 is not the process itself/) })
    expect(signals).toEqual([])
  })

  it("a read that never answers counts as unverifiable, within the read timeout", async () => {
    const { signals, options } = world({ 500: { start: "ps:A", pgid: 500 } })
    const { registry } = registryOf([{ pid: 500, start: "ps:A", pgid: 500 }])
    const started = Date.now()
    const [outcome] = await terminateOrphanedRuntimeProcesses({
      ...options,
      selfPgid: undefined,
      registry,
      readTimeoutMs: 100,
      startTimeOf: () => new Promise<string>(() => undefined),
      processGroupOf: () => new Promise<number>(() => undefined),
    })
    expect(outcome?.action).toBe("unverified")
    expect(signals).toEqual([])
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("acts on no record (and removes none) when the registry directory cannot be trusted", async () => {
    const { signals, options } = world({ 500: { start: "ps:A", pgid: 500 } })
    const { registry, removed } = registryOf([{ pid: 500, start: "ps:A", pgid: 500 }])
    const logs: string[] = []
    const outcomes = await terminateOrphanedRuntimeProcesses({
      ...options,
      registry: { ...registry, checkDirectory: () => ({ ok: false as const, reason: "it is owned by uid 0, not 501" }) },
      log: (level, message) => logs.push(`${level} ${message}`),
    })
    expect(outcomes).toEqual([])
    expect(signals).toEqual([])
    expect(removed).toEqual([])
    expect(logs.join("\n")).toMatch(/error .*cannot be trusted \(it is owned by uid 0/)
  })

  it("is a logged no-op on Windows", async () => {
    const { signals, options } = world({ 500: { start: "ps:A", pgid: 500 } })
    const { registry, removed } = registryOf([{ pid: 500, start: "ps:A", pgid: 500 }])
    const logs: string[] = []
    const [outcome] = await terminateOrphanedRuntimeProcesses({ ...options, platform: "win32", registry, log: (_level, message) => logs.push(message) })
    expect(outcome?.action).toBe("unsupported")
    expect(signals).toEqual([])
    expect(removed).toHaveLength(1)
    expect(logs.join("\n")).toMatch(/not supported on Windows/)
  })

  it("logs each action with the job id and PID", async () => {
    const { options } = world({ 500: { start: "ps:A", pgid: 500 }, 600: { start: "ps:NEW", pgid: 600 } })
    const { registry } = registryOf([
      { pid: 500, start: "ps:A", pgid: 500, jobId: "job_live" },
      { pid: 600, start: "", jobId: "job_unknown" },
      { pid: 700, start: "ps:C", jobId: "job_gone" },
    ])
    const logs: string[] = []
    await terminateOrphanedRuntimeProcesses({ ...options, registry, log: (level, message) => logs.push(`${level} ${message}`) })
    const text = logs.join("\n")
    expect(text).toMatch(/info stopped claude process 500 of job job_live .*SIGTERM, process group/)
    expect(text).toMatch(/warn claude process 600 of job job_unknown .*could not be verified.*NOT stopped.*troubleshooting/)
    expect(text).toMatch(/info claude process 700 of job job_gone .*had already exited/)
  })

  it("real process: stops a detached child that ignores SIGTERM, and its grandchild", async () => {
    // The child ignores SIGTERM and starts a grandchild (same group) that ignores it too.
    const program = `
      process.on("SIGTERM", () => {})
      const { spawn } = require("node:child_process")
      const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })
      console.log(String(grandchild.pid))
      setInterval(() => {}, 1000)
    `
    const child = spawn(process.execPath, ["-e", program], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
    const grandchildPid = await new Promise<number>((resolve) => child.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))))
    const registry = new FileRuntimeProcessRegistry(join(await mkdtemp(join(tmpdir(), "aibridge-orphan-")), "runtime-processes"))
    registry.track({ jobId: "job_real", role: "claude", pid: child.pid!, processGroup: true })
    // Outside Linux the start time is added to the record asynchronously.
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const [entry] = registry.list()
      if (entry !== undefined && "record" in entry && entry.record.start !== undefined) break
      await new Promise((done) => setTimeout(done, 20))
    }
    try {
      const [outcome] = await terminateOrphanedRuntimeProcesses({ registry, graceMs: 300, log: () => undefined })
      expect(outcome).toMatchObject({ action: "terminated", signal: "SIGKILL", group: true })
      expect(isProcessAlive(child.pid!)).toBe(false)
      // The grandchild is reparented and reaped by init/launchd: give it a moment.
      for (let attempt = 0; attempt < 50 && isProcessAlive(grandchildPid); attempt += 1) await new Promise((done) => setTimeout(done, 20))
      expect(isProcessAlive(grandchildPid)).toBe(false)
      expect(await readdir(registry.directory)).toEqual([])
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        /* already gone */
      }
    }
  }, 15_000)
})

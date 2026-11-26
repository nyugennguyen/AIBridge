/**
 * Review of PR #27: one executing process per profile. A second `aibr serve`
 * or `aibr worker` on the same state directory refuses to start and touches
 * no job, instead of interrupting the live process's jobs. Also covers the
 * restart pass of `startIngressWorker` (router ingress).
 */
import { existsSync, rmSync } from "node:fs"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { startBridge, type BridgeInstance } from "../../src/bridge.js"
import type { BridgeConfig } from "../../src/config/types.js"
import { acquireStateLock, readProcessStartTime, STATE_LOCK_FILE, StateLockHeldError, type StateLock } from "../../src/host/state-lock.js"
import { startIngressWorker, type IngressWorkerHandle } from "../../src/ingress/worker.js"
import { INTERRUPTED_BY_RESTART } from "../../src/jobs/reconcile.js"
import type { JobRecord } from "../../src/jobs/types.js"
import { createSqliteDriver } from "../../src/orchestration/event-store/sqlite-driver.js"
import { FakeOpencodeClient, testConfig } from "./fixtures.js"

const T0 = new Date(Date.now() - 5_000).toISOString()

function stored(id: string, status: JobRecord["status"], overrides: Partial<JobRecord> = {}, capability = "testing"): JobRecord {
  return {
    id,
    trigger: {
      job_id: id,
      source_agent_id: "dev-main",
      target_agent_id: "test-vps",
      capability,
      project_dir: "/srv/apps/app",
      prompt: `Do ${id}.`,
      callback_url: "http://dev-main.tailnet:8787/report",
      timeout_seconds: 600,
    },
    status,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

async function profile(config: BridgeConfig, jobs: readonly JobRecord[]): Promise<{ configPath: string; stateDir: string }> {
  const directory = await mkdtemp(join(tmpdir(), "aibridge-state-lock-"))
  const configPath = join(directory, "config.json")
  await writeFile(configPath, JSON.stringify(config))
  const stateDir = join(directory, "state")
  await mkdir(join(stateDir, "jobs"), { recursive: true })
  for (const job of jobs) await writeFile(join(stateDir, "jobs", `${job.id}.json`), JSON.stringify(job))
  return { configPath, stateDir }
}

async function storedStatus(stateDir: string, id: string): Promise<JobRecord> {
  return JSON.parse(await readFile(join(stateDir, "jobs", `${id}.json`), "utf8")) as JobRecord
}

const bridges: BridgeInstance[] = []
const workers: IngressWorkerHandle[] = []
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.app.close()
  for (const worker of workers.splice(0)) worker.stop()
})

describe("acquireStateLock", () => {
  const lockPath = (stateDir: string) => join(stateDir, STATE_LOCK_FILE)
  const writeLock = (stateDir: string, content: unknown) =>
    writeFile(lockPath(stateDir), typeof content === "string" ? content : `${JSON.stringify(content)}\n`)
  /** A world where every PID is alive, with the given start times. */
  const world = (starts: Record<number, string>) => ({
    isAlive: (pid: number) => starts[pid] !== undefined,
    startTimeOf: (pid: number) => starts[pid],
  })

  it("refuses a second holder naming its PID, and is free again after release", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-lock-"))
    const first = acquireStateLock(stateDir)
    let refusal: unknown
    try {
      acquireStateLock(stateDir)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(StateLockHeldError)
    expect((refusal as StateLockHeldError).pid).toBe(process.pid)
    expect((refusal as Error).message).toContain(`PID ${process.pid}`)
    first.release()
    expect(existsSync(lockPath(stateDir))).toBe(false)
    acquireStateLock(stateDir).release()
  })

  it("records the PID and its real start time (ps lstart)", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-lock-"))
    const lock = acquireStateLock(stateDir)
    const content = JSON.parse(await readFile(lockPath(stateDir), "utf8")) as { pid: number; start: string }
    expect(content.pid).toBe(process.pid)
    expect(content.start).toBe(readProcessStartTime(process.pid))
    expect(content.start.length).toBeGreaterThan(0)
    lock.release()
  })

  it("same PID with the same start time: held", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-lock-"))
    await writeLock(stateDir, { pid: 4242, start: "Thu Nov 26 09:00:00 2026", token: "t" })
    expect(() => acquireStateLock(stateDir, { pid: 5000, ...world({ 4242: "Thu Nov 26 09:00:00 2026", 5000: "now" }) })).toThrow(
      StateLockHeldError,
    )
  })

  it("PID reused after a reboot (different start time): stale, replaced", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-lock-"))
    await writeLock(stateDir, { pid: 4242, start: "Mon Nov 23 09:00:00 2026", token: "t" })
    const lock = acquireStateLock(stateDir, { pid: 5000, ...world({ 4242: "Thu Nov 26 09:00:00 2026", 5000: "now" }) })
    expect(JSON.parse(await readFile(lockPath(stateDir), "utf8"))).toMatchObject({ pid: 5000, start: "now" })
    lock.release()
  })

  it("a live PID of another user (EPERM) with a different start time: stale", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-lock-"))
    await writeLock(stateDir, { pid: 4242, start: "Mon Nov 23 09:00:00 2026", token: "t" })
    // isAlive answers true as it does on EPERM; only the start time differs.
    const lock = acquireStateLock(stateDir, { pid: 5000, isAlive: () => true, startTimeOf: (pid) => (pid === 4242 ? "Tue" : "now") })
    lock.release()
  })

  it("dead PID: stale, whatever the file holds", async () => {
    for (const content of ["999999 stale-token\n", { pid: 4242, start: "ps:Mon", token: "t" }, { pid: 4242, start: "", token: "t" }]) {
      const stateDir = await mkdtemp(join(tmpdir(), "aibridge-lock-"))
      await writeLock(stateDir, content)
      acquireStateLock(stateDir, { pid: 5000, ...world({ 5000: "now" }) }).release()
    }
  })

  it("live PID whose start time cannot be read now: held (safe side), naming the PID, the lock and the recovery doc", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-lock-"))
    await writeLock(stateDir, { pid: 4242, start: "ps:Mon", token: "t" })
    let refusal: unknown
    try {
      acquireStateLock(stateDir, { pid: 5000, isAlive: () => true, startTimeOf: (pid) => (pid === 5000 ? "now" : undefined) })
    } catch (error) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(StateLockHeldError)
    expect((refusal as Error).message).toContain("PID 4242")
    expect((refusal as Error).message).toContain(lockPath(stateDir))
    expect((refusal as Error).message).toContain("Docs/operations/troubleshooting.md")
  })

  it("live PID with no start time in the file (empty or pre-3.2 format): held", async () => {
    for (const content of ["4242 old-token\n", { pid: 4242, start: "", token: "t" }, { pid: 4242, token: "t" }]) {
      const stateDir = await mkdtemp(join(tmpdir(), "aibridge-lock-"))
      await writeLock(stateDir, content)
      expect(() => acquireStateLock(stateDir, { pid: 5000, ...world({ 4242: "ps:Thu", 5000: "now" }) })).toThrow(StateLockHeldError)
    }
  })

  it("release never removes a lock another process took over", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-lock-"))
    const lock = acquireStateLock(stateDir)
    await writeLock(stateDir, { pid: 424242, start: "x", token: "someone-else" })
    lock.release()
    expect(existsSync(lockPath(stateDir))).toBe(true)
  })

  it("two processes taking over the same stale lock at once: only one wins", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-lock-"))
    await writeLock(stateDir, { pid: 4242, start: "dead", token: "t" })
    const live = world({ 1001: "a", 1002: "b" })
    let second: StateLock | undefined
    let firstOutcome: unknown
    try {
      // Process 1001 judges the lock stale; before it moves it aside, process
      // 1002 does the whole takeover.
      acquireStateLock(stateDir, {
        pid: 1001,
        ...live,
        beforeTakeover: () => {
          if (second === undefined) second = acquireStateLock(stateDir, { pid: 1002, ...live })
        },
      })
      firstOutcome = "won"
    } catch (error) {
      firstOutcome = error
    }
    expect(second).toBeDefined()
    expect(firstOutcome).toBeInstanceOf(StateLockHeldError)
    expect((firstOutcome as StateLockHeldError).pid).toBe(1002)
    expect(JSON.parse(await readFile(lockPath(stateDir), "utf8"))).toMatchObject({ pid: 1002 })
    expect((await readdir(stateDir)).filter((name) => name !== STATE_LOCK_FILE)).toEqual([])
    second?.release()
  })

  it("real processes racing for a stale lock: at most one holds it", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-lock-race-"))
    await writeLock(stateDir, { pid: 4242, start: "dead", token: "t" })
    const script = join(stateDir, "..", `race-${Date.now()}.ts`)
    const module = join(import.meta.dirname, "../../src/host/state-lock.ts")
    await writeFile(
      script,
      `import { acquireStateLock } from ${JSON.stringify(module)}
try { const lock = acquireStateLock(${JSON.stringify(stateDir)}, { isAlive: (pid) => pid !== 4242 && pid > 0 && (() => { try { process.kill(pid, 0); return true } catch { return false } })() })
  console.log("won"); await new Promise((r) => setTimeout(r, 800)); lock.release() }
catch (error) { console.log(error?.code === "state_dir_locked" ? "held" : "error " + error) }\n`,
    )
    const runOne = () =>
      new Promise<string>((resolve) => {
        execFile("bun", [script], { timeout: 20_000 }, (_error, stdout) => resolve(stdout.trim()))
      })
    const outcomes = await Promise.all(Array.from({ length: 5 }, runOne))
    expect(outcomes.filter((outcome) => outcome === "won").length).toBeLessThanOrEqual(1)
    expect(outcomes.every((outcome) => outcome === "won" || outcome === "held")).toBe(true)
  }, 30_000)
})

describe("readProcessStartTime", () => {
  it("does not depend on the caller's time zone or locale (ps path)", () => {
    const utc = readProcessStartTime(process.pid, { platform: "darwin", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } })
    const hcm = readProcessStartTime(process.pid, { platform: "darwin", env: { ...process.env, TZ: "Asia/Ho_Chi_Minh", LC_ALL: "fr_FR.UTF-8" } })
    expect(utc).toBeDefined()
    expect(utc?.startsWith("ps:")).toBe(true)
    expect(hcm).toBe(utc)
  })

  it("runs ps with TZ=UTC and LC_ALL=C whatever the environment says", () => {
    const seen: Array<Record<string, string | undefined>> = []
    const value = readProcessStartTime(42, {
      platform: "darwin",
      env: { TZ: "Asia/Ho_Chi_Minh", LC_ALL: "vi_VN.UTF-8", PATH: "/usr/bin" },
      runPs: (_pid, env) => {
        seen.push(env)
        return "  Thu Nov 26 07:07:00 2026  \n"
      },
    })
    expect(value).toBe("ps:Thu Nov 26 07:07:00 2026")
    expect(seen[0]).toMatchObject({ TZ: "UTC", LC_ALL: "C", LANG: "C", PATH: "/usr/bin" })
  })

  it("on Linux reads /proc/<pid>/stat field 22 and the boot id, without ps", () => {
    const files: Record<string, string> = {
      // comm with spaces and a ")" must not shift the fields.
      "/proc/4242/stat": "4242 (aibr (serve) x) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 7 0 987654 123456789 2000",
      "/proc/sys/kernel/random/boot_id": "6f1c2b9e-0000-4000-8000-000000000001\n",
    }
    const value = readProcessStartTime(4242, {
      platform: "linux",
      readFile: (path) => files[path],
      runPs: () => {
        throw new Error("ps must not run on Linux")
      },
    })
    expect(value).toBe("linux:6f1c2b9e-0000-4000-8000-000000000001:987654")

    // Same PID after a reboot: another boot id, so another value.
    files["/proc/sys/kernel/random/boot_id"] = "aaaaaaaa-0000-4000-8000-000000000002\n"
    expect(readProcessStartTime(4242, { platform: "linux", readFile: (path) => files[path], runPs: () => undefined })).not.toBe(value)
  })

  it("is undefined when nothing can be read", () => {
    expect(readProcessStartTime(4242, { platform: "linux", readFile: () => undefined, runPs: () => undefined })).toBeUndefined()
    expect(readProcessStartTime(4242, { platform: "darwin", runPs: () => "" })).toBeUndefined()
  })
})

describe("a second bridge on the same profile", () => {
  it("refuses to start and does not interrupt the live bridge's jobs", async () => {
    const { configPath, stateDir } = await profile(testConfig(), [])
    const options = {
      configPath,
      stateDir,
      bearerToken: "secret",
      environment: {},
      deps: { opencodeClient: new FakeOpencodeClient(), monitorSession: () => new Promise<void>(() => undefined) },
    }
    const live = await startBridge(options)
    bridges.push(live)
    // The live bridge is running a job.
    await live.jobManager.createJob(stored("busy", "accepted").trigger)
    await live.jobManager.markLaunchStarted("busy")
    await live.jobManager.markRunning("busy")

    await expect(startBridge(options)).rejects.toBeInstanceOf(StateLockHeldError)
    expect((await storedStatus(stateDir, "busy")).status).toBe("running")

    // Once the live bridge is gone, a new one starts (and reconciles).
    await live.app.close()
    bridges.splice(0)
    const next = await startBridge(options)
    bridges.push(next)
    expect((await next.jobManager.getJob("busy")).error).toBe(INTERRUPTED_BY_RESTART)
  })
})

describe("startIngressWorker (router ingress)", () => {
  function provisionStore(path: string): void {
    const driver = createSqliteDriver({ path, create: true })
    driver.exec(`
      CREATE TABLE ingress_outbox (
        job_id TEXT PRIMARY KEY, subject_job_id TEXT NOT NULL, route TEXT NOT NULL,
        schema_version TEXT NOT NULL, payload_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
        next_attempt_at_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0, claim_token TEXT,
        claimed_at_ms INTEGER,
        status TEXT NOT NULL CHECK (status IN ('pending','sending','acknowledged','failed')),
        last_error TEXT, terminal_error TEXT, CHECK (attempts >= 0));
    `)
    driver.close()
  }

  it("reconciles and relaunches before draining, and holds the profile lock until stop()", async () => {
    const base = testConfig()
    const config: BridgeConfig = {
      ...base,
      bridge: { ...base.bridge, ingress_mode: "router" },
      security: {
        ...base.security,
        allowed_sources: [{ source_agent_id: "dev-main", capabilities: ["testing", "deployment"], requires_plan_approval: [] }],
      },
      projects: [{ id: "app", path: "/srv/apps/app", capabilities: ["testing", "deployment"] }],
    }
    const { configPath, stateDir } = await profile(config, [
      stored("fresh", "accepted"),
      stored("running", "running", { launchStartedAt: T0, opencodeSessionId: "ses_old" }),
      stored("gated", "accepted", {}, "deployment"),
    ])
    const storePath = join(stateDir, "ingress.sqlite")
    provisionStore(storePath)
    const opencode = new FakeOpencodeClient()
    const options = {
      configPath,
      stateDir,
      storePath,
      bearerToken: "secret",
      environment: {},
      pollIntervalMs: 60_000,
      deps: { opencodeClient: opencode, monitorSession: () => new Promise<void>(() => undefined) },
    }
    try {
      const worker = await startIngressWorker(options)
      workers.push(worker)

      // Relaunch is done by the time the worker is returned.
      expect(worker.restartReconcile.relaunch.map((job) => job.id)).toEqual(["fresh"])
      expect(opencode.createdSessions).toBe(1)
      expect((await worker.jobManager.getJob("fresh")).status).toBe("running")
      expect((await worker.jobManager.getJob("running")).error).toBe(INTERRUPTED_BY_RESTART)
      expect((await worker.jobManager.getJob("gated")).error).toBe(
        "not relaunched after restart: this node now requires operator approval for it (never started)",
      )

      // A second worker on the same profile refuses and touches nothing.
      await expect(startIngressWorker(options)).rejects.toBeInstanceOf(StateLockHeldError)
      expect(opencode.createdSessions).toBe(1)
      expect((await storedStatus(stateDir, "fresh")).status).toBe("running")

      worker.stop()
      workers.splice(0)
      expect(existsSync(join(stateDir, STATE_LOCK_FILE))).toBe(false)
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${storePath}${suffix}`, { force: true })
    }
  })
})

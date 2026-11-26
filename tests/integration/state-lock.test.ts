/**
 * Review of PR #27: one executing process per profile. A second `aibr serve`
 * or `aibr worker` on the same state directory refuses to start and touches
 * no job, instead of interrupting the live process's jobs. Also covers the
 * restart pass of `startIngressWorker` (router ingress).
 */
import { existsSync, rmSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { startBridge, type BridgeInstance } from "../../src/bridge.js"
import type { BridgeConfig } from "../../src/config/types.js"
import { acquireStateLock, STATE_LOCK_FILE, StateLockHeldError } from "../../src/host/state-lock.js"
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
    expect(existsSync(join(stateDir, STATE_LOCK_FILE))).toBe(false)
    acquireStateLock(stateDir).release()
  })

  it("replaces a lock whose holder is dead", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-lock-"))
    await writeFile(join(stateDir, STATE_LOCK_FILE), "999999 stale-token\n")
    const lock = acquireStateLock(stateDir, { isAlive: (pid) => pid !== 999999 })
    expect((await readFile(join(stateDir, STATE_LOCK_FILE), "utf8")).startsWith(`${process.pid} `)).toBe(true)
    lock.release()
  })

  it("release never removes a lock another process took over", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "aibridge-lock-"))
    const lock = acquireStateLock(stateDir)
    await writeFile(join(stateDir, STATE_LOCK_FILE), "424242 someone-else\n")
    lock.release()
    expect(existsSync(join(stateDir, STATE_LOCK_FILE))).toBe(true)
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
        `${INTERRUPTED_BY_RESTART}; not relaunched: this node now requires operator approval for it`,
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

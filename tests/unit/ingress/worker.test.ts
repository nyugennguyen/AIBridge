/**
 * M7.7: `aibr worker` as a process.
 *
 * The drain loop had unit coverage as a class and NO coverage as a thing that
 * runs, which is the gap this file closes: nothing constructed an
 * `IngressDrainer` outside a test, so "the worker drains the queue" was a
 * statement about a class rather than about a program.
 *
 * What is asserted here is the process contract, not the drain semantics (those
 * live in `drainer.test.ts`):
 *
 * 1. The store path rules are the router's rules — unset and relative are refused.
 * 2. A missing store is an error, never a created file and never a memory queue.
 * 3. A pending row admitted by a router-shaped writer reaches a job.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  startIngressWorker,
  resolveStorePath,
  INGRESS_OUTBOX_ENV,
  type IngressWorkerHandle,
} from "../../../src/ingress/worker.js"
import { createSqliteDriver, type SqliteDriver } from "../../../src/orchestration/event-store/sqlite-driver.js"
import { FakeOpencodeClient, testConfig } from "../../integration/fixtures.js"
import type { JobRecord } from "../../../src/jobs/types.js"

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ingress_outbox (
    job_id             TEXT    PRIMARY KEY,
    subject_job_id     TEXT    NOT NULL,
    route              TEXT    NOT NULL,
    schema_version     TEXT    NOT NULL,
    payload_json       TEXT    NOT NULL,
    created_at_ms      INTEGER NOT NULL,
    next_attempt_at_ms INTEGER,
    attempts           INTEGER NOT NULL DEFAULT 0,
    claim_token        TEXT,
    claimed_at_ms      INTEGER,
    status             TEXT    NOT NULL CHECK (status IN ('pending','sending','acknowledged','failed')),
    last_error         TEXT,
    terminal_error     TEXT,
    CHECK (attempts >= 0)
  );
  CREATE INDEX IF NOT EXISTS ingress_outbox_claimable
    ON ingress_outbox (status, next_attempt_at_ms);
`

describe("M7.7 ingress worker process", () => {
  let dir: string
  let storePath: string
  let driver: SqliteDriver
  let worker: IngressWorkerHandle | undefined
  const monitored: JobRecord[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aibr-worker-"))
    storePath = join(dir, "ingress-outbox.sqlite")
    driver = createSqliteDriver({ path: storePath, create: true })
    driver.exec(SCHEMA)
    monitored.length = 0
  })

  afterEach(async () => {
    worker?.stop()
    await worker?.stopped
    worker = undefined
    driver.close()
    await rm(dir, { recursive: true, force: true })
  })

  function writeConfig(): Promise<string> {
    const config = testConfig()
    // The trigger below is admitted for this project and this source only.
    config.projects = [{ id: "app", path: dir, capabilities: ["testing"] }]
    const configPath = join(dir, "config.json")
    return writeFile(configPath, JSON.stringify(config), "utf8").then(() => configPath)
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error("condition was not met before the timeout")
  }

  describe("store path resolution", () => {
    it("reads AIBRIDGE_INGRESS_OUTBOX when no explicit path is given", () => {
      expect(resolveStorePath(undefined, { [INGRESS_OUTBOX_ENV]: "/var/lib/aibridge/queue.db" })).toBe(
        "/var/lib/aibridge/queue.db",
      )
    })

    it("refuses to invent a default when the variable is unset", () => {
      expect(() => resolveStorePath(undefined, {})).toThrow(/AIBRIDGE_INGRESS_OUTBOX/)
    })

    it("refuses an empty value rather than treating it as unset-and-defaulted", () => {
      expect(() => resolveStorePath("", { [INGRESS_OUTBOX_ENV]: "/tmp/x.db" })).toThrow(
        /AIBRIDGE_INGRESS_OUTBOX/,
      )
    })

    it("refuses a relative path, because two working directories mean two empty queues", () => {
      expect(() => resolveStorePath("queue.db", {})).toThrow(/absolute/)
    })

    it("prefers an explicit path over the environment", () => {
      expect(resolveStorePath("/explicit/queue.db", { [INGRESS_OUTBOX_ENV]: "/env/queue.db" })).toBe(
        "/explicit/queue.db",
      )
    })
  })

  describe("refusals", () => {
    it("throws when the store does not exist instead of creating it", async () => {
      const configPath = await writeConfig()
      const missing = join(dir, "never-provisioned.sqlite")

      await expect(
        startIngressWorker({
          configPath,
          stateDir: dir,
          bearerToken: "secret",
          environment: {},
          storePath: missing,
        }),
      ).rejects.toThrow(/aibr-router --init-store/)

      expect(existsSync(missing)).toBe(false)
    })

    it("never falls back to memory when the store is unusable", async () => {
      const configPath = await writeConfig()
      const notADatabase = join(dir, "not-a-database.sqlite")
      await writeFile(notADatabase, "this is not sqlite", "utf8")

      await expect(
        startIngressWorker({
          configPath,
          stateDir: dir,
          bearerToken: "secret",
          environment: {},
          storePath: notADatabase,
        }),
      ).rejects.toThrow()
    })
  })

  describe("draining", () => {
    it("executes a row the router admitted and acknowledges it", async () => {
      const configPath = await writeConfig()
      const opencode = new FakeOpencodeClient()
      const payload = {
        schemaVersion: "v1",
        job_id: "worker-job-1",
        source_agent_id: "dev-main",
        target_agent_id: "test-vps",
        capability: "testing",
        project_dir: dir,
        prompt: "do the thing",
        callback_url: "http://dev-main.tailnet:8787/report",
        timeout_seconds: 60,
      }
      driver.run(
        `INSERT INTO ingress_outbox
           (job_id, subject_job_id, route, schema_version, payload_json, created_at_ms, status)
         VALUES (?, ?, 'POST /trigger', 'v1', ?, ?, 'pending')`,
        "worker-job-1",
        "worker-job-1",
        JSON.stringify(payload),
        Date.now(),
      )

      worker = await startIngressWorker({
        configPath,
        stateDir: join(dir, "state"),
        bearerToken: "secret",
        environment: {},
        storePath,
        pollIntervalMs: 25,
        deps: {
          opencodeClient: opencode,
          monitorSession: async (job) => {
            monitored.push(job)
          },
        },
      })

      await waitFor(() => {
        const row = driver.get<{ status: string }>(
          "SELECT status FROM ingress_outbox WHERE job_id = ?",
          "worker-job-1",
        )
        return row?.status === "acknowledged"
      })

      expect(opencode.createdSessions).toBe(1)
      expect(monitored).toHaveLength(1)
      expect(monitored[0]!.id).toBe("worker-job-1")
    })

    it("stops cleanly and leaves no claim in flight", async () => {
      const configPath = await writeConfig()
      worker = await startIngressWorker({
        configPath,
        stateDir: join(dir, "state"),
        bearerToken: "secret",
        environment: {},
        storePath,
        pollIntervalMs: 25,
        deps: { opencodeClient: new FakeOpencodeClient(), monitorSession: async () => {} },
      })

      worker.stop()
      await worker.stopped
      const sending = driver.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM ingress_outbox WHERE status = 'sending'",
      )
      expect(sending?.n).toBe(0)
    })
  })
})

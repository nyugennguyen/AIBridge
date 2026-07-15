import { mkdtemp, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { JsonFileJobStore } from "../../../src/jobs/store.js"
import type { JobRecord, JobStatus } from "../../../src/jobs/types.js"
import { trigger } from "./fixtures.js"

function makeJob(id: string, status: JobStatus): JobRecord {
  return {
    id,
    trigger: trigger({ job_id: id }),
    status,
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
  }
}

describe("JsonFileJobStore", () => {
  it("writes and reloads job JSON files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aibridge-jobs-"))
    const store = new JsonFileJobStore(dir)
    const job: JobRecord = {
      id: "job_1",
      trigger: trigger({ job_id: "job_1" }),
      status: "accepted",
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
    }

    await store.save(job)

    const raw = await readFile(join(dir, "job_1.json"), "utf8")
    expect(JSON.parse(raw).id).toBe("job_1")

    const reloaded = new JsonFileJobStore(dir)
    expect((await reloaded.get("job_1"))?.status).toBe("accepted")
  })

  describe("listByStatus", () => {
    it("returns only jobs matching the requested status", async () => {
      const dir = await mkdtemp(join(tmpdir(), "aibridge-jobs-"))
      const store = new JsonFileJobStore(dir)
      await store.save(makeJob("job_running_1", "running"))
      await store.save(makeJob("job_running_2", "running"))
      await store.save(makeJob("job_completed_1", "completed"))
      await store.save(makeJob("job_failed_1", "failed"))

      const running = await store.listByStatus("running")
      expect(running).toHaveLength(2)
      expect(running.map((j) => j.id).sort()).toEqual(["job_running_1", "job_running_2"])
    })

    it("returns empty array when no jobs match the status", async () => {
      const dir = await mkdtemp(join(tmpdir(), "aibridge-jobs-"))
      const store = new JsonFileJobStore(dir)
      await store.save(makeJob("job_1", "accepted"))
      await store.save(makeJob("job_2", "running"))

      const timedOut = await store.listByStatus("timed_out")
      expect(timedOut).toHaveLength(0)
    })

    it("returns empty array when store has no jobs", async () => {
      const dir = await mkdtemp(join(tmpdir(), "aibridge-jobs-"))
      const store = new JsonFileJobStore(dir)

      const result = await store.listByStatus("completed")
      expect(result).toHaveLength(0)
    })

    it("survives reload from disk for listByStatus", async () => {
      const dir = await mkdtemp(join(tmpdir(), "aibridge-jobs-"))
      const store = new JsonFileJobStore(dir)
      await store.save(makeJob("job_a", "blocked"))
      await store.save(makeJob("job_b", "completed"))
      await store.save(makeJob("job_c", "blocked"))

      const reloaded = new JsonFileJobStore(dir)
      const blocked = await reloaded.listByStatus("blocked")
      expect(blocked).toHaveLength(2)
      expect(blocked.map((j) => j.id).sort()).toEqual(["job_a", "job_c"])
    })
  })
})

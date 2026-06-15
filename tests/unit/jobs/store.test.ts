import { mkdtemp, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { JsonFileJobStore } from "../../../src/jobs/store.js"
import type { JobRecord } from "../../../src/jobs/types.js"
import { trigger } from "./fixtures.js"

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
})

/**
 * v3.2.0 hardening, review follow-up: creating a job is atomic in the store.
 *
 * Two concurrent creates of ids that differ only in case (or of one id)
 * used to both pass the duplicate check, then write the same temporary file;
 * on a case-insensitive filesystem the surviving job file could be corrupt,
 * and the next start of the store failed on `JSON.parse`. Now exactly one
 * create succeeds, the other is refused ("Job already exists", 409 on
 * `/trigger`), the store reloads cleanly, and a corrupt job file no longer
 * stops the others from loading.
 */
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { TriggerRequest } from "../../src/config/types.js"
import { InMemoryJobEventLog } from "../../src/jobs/events.js"
import { JobManager } from "../../src/jobs/manager.js"
import { JsonFileJobStore } from "../../src/jobs/store.js"
import type { JobRecord } from "../../src/jobs/types.js"
import { validTrigger } from "../integration/fixtures.js"
import { jobApiApp } from "../integration/job-api-fixtures.js"

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "aibr-create-race-"))
}

/** Reloads the directory in a new store, as a restart would, after checking every job file parses. */
async function reload(dir: string): Promise<string[]> {
  for (const entry of (await readdir(dir)).filter((name) => name.endsWith(".json"))) {
    const raw = await readFile(join(dir, entry), "utf8")
    expect(() => JSON.parse(raw), entry).not.toThrow()
  }
  return (await new JsonFileJobStore(dir, { onUnreadable: (file) => expect.fail(`unreadable ${file}`) }).list()).map((job) => job.id).sort()
}

async function race(ids: readonly [string, string]): Promise<{ dir: string; settled: PromiseSettledResult<JobRecord>[] }> {
  const dir = await freshDir()
  const manager = new JobManager(new JsonFileJobStore(dir))
  const settled = await Promise.allSettled(ids.map((id) => manager.createJob(validTrigger({ job_id: id }) as TriggerRequest)))
  return { dir, settled }
}

describe("concurrent job creates", () => {
  for (const ids of [
    ["CaseX", "casex"],
    ["casex", "CASEX"],
    ["same_id", "same_id"],
  ] as const) {
    it(`exactly one of ${ids.join(" / ")} succeeds and the store reloads cleanly`, async () => {
      const { dir, settled } = await race(ids)
      const won = settled.filter((outcome) => outcome.status === "fulfilled")
      const lost = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
      expect(won).toHaveLength(1)
      expect(lost).toHaveLength(1)
      expect(String(lost[0]!.reason)).toMatch(/Job already exists/)
      const winner = (won[0] as PromiseFulfilledResult<JobRecord>).value.id
      expect(await reload(dir)).toEqual([winner])
      // No temporary file is left behind.
      expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    })
  }

  it("many concurrent creates of case variants: one job, one readable file", async () => {
    const dir = await freshDir()
    const manager = new JobManager(new JsonFileJobStore(dir))
    const variants = ["abc", "ABC", "Abc", "aBc", "abC", "ABc", "aBC", "AbC", "abc", "ABC"]
    const settled = await Promise.allSettled(variants.map((id) => manager.createJob(validTrigger({ job_id: id }) as TriggerRequest)))
    expect(settled.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    expect(await reload(dir)).toHaveLength(1)
  })

  it("a failed write releases the reservation, so the id can be created again", async () => {
    const dir = await freshDir()
    const store = new JsonFileJobStore(join(dir, "jobs"))
    const manager = new JobManager(store)
    await manager.createJob(validTrigger({ job_id: "first" }) as TriggerRequest) // loads the store
    // Make the directory unwritable for one create by replacing it with a file.
    const { rename, rm } = await import("node:fs/promises")
    await rename(join(dir, "jobs"), join(dir, "jobs-moved"))
    await writeFile(join(dir, "jobs"), "not a directory")
    await expect(manager.createJob(validTrigger({ job_id: "retry_me" }) as TriggerRequest)).rejects.toThrow()
    await rm(join(dir, "jobs"))
    await rename(join(dir, "jobs-moved"), join(dir, "jobs"))
    await expect(manager.createJob(validTrigger({ job_id: "retry_me" }) as TriggerRequest)).resolves.toMatchObject({ id: "retry_me" })
  })

  it("two concurrent POST /trigger with case-variant ids: one 202, one 409", async () => {
    const dir = await freshDir()
    const events = new InMemoryJobEventLog()
    const jobManager = new JobManager(new JsonFileJobStore(dir), { events })
    const h = await jobApiApp({ signing: "required", jobManager, events })
    const responses = await Promise.all([h.triggerAs("dev-main", { job_id: "CaseX" }), h.triggerAs("dev-main", { job_id: "casex" })])
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409])
    expect(await reload(dir)).toHaveLength(1)
  })
})

describe("a corrupt job file", () => {
  it("does not stop the other jobs from loading; it is reported and set aside", async () => {
    const dir = await freshDir()
    const manager = new JobManager(new JsonFileJobStore(dir))
    await manager.createJob(validTrigger({ job_id: "good_1" }) as TriggerRequest)
    await manager.createJob(validTrigger({ job_id: "good_2" }) as TriggerRequest)
    await writeFile(join(dir, "truncated.json"), '{"id": "truncated", "status": "runn\0')
    await writeFile(join(dir, "null.json"), "null")
    await writeFile(join(dir, "noid.json"), '{"status": "running"}')

    const reported: string[] = []
    const store = new JsonFileJobStore(dir, { onUnreadable: (file) => reported.push(file) })
    expect((await store.list()).map((job) => job.id).sort()).toEqual(["good_1", "good_2"])
    expect(reported.map((file) => file.slice(dir.length + 1)).sort()).toEqual(["noid.json", "null.json", "truncated.json"])
    expect((await readdir(dir)).sort()).toEqual(
      ["good_1.json", "good_2.json", "noid.json.unreadable", "null.json.unreadable", "truncated.json.unreadable"].sort(),
    )
    // Set aside once: the next start does not report it again.
    const again: string[] = []
    await new JsonFileJobStore(dir, { onUnreadable: (file) => again.push(file) }).list()
    expect(again).toEqual([])
  })

  it("concurrent first reads share one load", async () => {
    const dir = await freshDir()
    await new JobManager(new JsonFileJobStore(dir)).createJob(validTrigger({ job_id: "only" }) as TriggerRequest)
    await writeFile(join(dir, "bad.json"), "{")
    const reported: string[] = []
    const store = new JsonFileJobStore(dir, { onUnreadable: (file) => reported.push(file) })
    const lists = await Promise.all([store.list(), store.list(), store.get("only")])
    expect(lists[0].map((job) => job.id)).toEqual(["only"])
    expect(reported).toHaveLength(1)
  })
})

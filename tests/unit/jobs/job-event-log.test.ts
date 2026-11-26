import { mkdtemp, readdir, readFile, writeFile, appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FileJobEventLog, InMemoryJobEventLog, jobEventsFileName } from "../../../src/jobs/events.js"
import { JobManager } from "../../../src/jobs/manager.js"
import { JsonFileJobStore } from "../../../src/jobs/store.js"
import type { TriggerRequest } from "../../../src/config/types.js"
import { validTrigger } from "../../integration/fixtures.js"
import { describeJobEventLogContract } from "./job-event-log-contract.js"

describeJobEventLogContract("InMemoryJobEventLog", async (options) => ({ log: new InMemoryJobEventLog(options) }))

describeJobEventLogContract("FileJobEventLog", async (options) => {
  const directory = await mkdtemp(join(tmpdir(), "aibr-job-events-"))
  return { log: new FileJobEventLog(directory, options), reopen: () => new FileJobEventLog(directory, options) }
})

describe("FileJobEventLog on disk", () => {
  it("writes one JSON line per event to <jobsDir>/<id>.events.jsonl", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibr-job-events-"))
    const log = new FileJobEventLog(directory)
    await log.append("job_1", { type: "status", data: { status: "accepted" } })
    await log.append("job_1", { type: "tool", data: { detail: "Tool call: Read" } })
    const lines = (await readFile(join(directory, "job_1.events.jsonl"), "utf8")).trimEnd().split("\n")
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      { seq: 1, type: "status", data: { status: "accepted" } },
      { seq: 2, type: "tool", data: { detail: "Tool call: Read" } },
    ])
  })

  it("keeps a job id that is not a plain file name inside the directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibr-job-events-"))
    const log = new FileJobEventLog(directory)
    for (const id of ["../../escape", "a/b", ".hidden", "_sha256-x", "x\ny"]) {
      expect(jobEventsFileName(id)).toMatch(/^_sha256-[0-9a-f]{64}\.events\.jsonl$/)
      await log.append(id, { type: "message", data: { id } })
      expect((await log.read(id, 0, 10)).events).toHaveLength(1)
    }
    expect(jobEventsFileName("job_1")).toBe("job_1.events.jsonl")
    expect((await readdir(directory)).every((entry) => entry.endsWith(".events.jsonl"))).toBe(true)
    expect(await readdir(directory)).toHaveLength(5)
  })

  it("skips a line cut short by a crash and numbers on from the last whole event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibr-job-events-"))
    const log = new FileJobEventLog(directory)
    await log.append("job", { type: "status", data: { status: "running" } })
    await appendFile(join(directory, "job.events.jsonl"), '{"seq":2,"at":"2026-')
    const reopened = new FileJobEventLog(directory)
    expect((await reopened.read("job", 0, 10)).events).toHaveLength(1)
    // The partial line stays; the next event starts on its own line and is readable.
    expect((await reopened.append("job", { type: "message", data: { after: "crash" } }))?.seq).toBe(2)
    const page = await new FileJobEventLog(directory).read("job", 0, 10)
    expect(page.events.map((event) => [event.seq, event.type])).toEqual([
      [1, "status"],
      [2, "message"],
    ])
  })
})

describe("JsonFileJobStore and the events files", () => {
  it("never loads a *.events.jsonl file as a job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibr-job-store-events-"))
    const events = new FileJobEventLog(directory)
    const manager = new JobManager(new JsonFileJobStore(directory), { events })
    await manager.createJob(validTrigger({ job_id: "job_1" }) as TriggerRequest)
    await manager.markLaunchStarted("job_1")
    await manager.markRunning("job_1")
    await events.append("job_1", { type: "message", data: { detail: "{\"id\":\"fake\",\"status\":\"running\"}" } })
    // A file whose content parses as a job record but whose name is an events log.
    await writeFile(join(directory, "job_2.events.jsonl"), `${JSON.stringify({ id: "job_2", status: "running", trigger: validTrigger() })}\n`)
    expect((await readdir(directory)).sort()).toEqual(["job_1.events.jsonl", "job_1.json", "job_2.events.jsonl"])

    const reloaded = new JsonFileJobStore(directory)
    const jobs = await reloaded.list()
    expect(jobs.map((job) => job.id)).toEqual(["job_1"])
    expect(await reloaded.get("job_2")).toBeUndefined()
  })
})

describe("JobManager status events", () => {
  it("records the status a job is created in and every status it enters, with the terminal error", async () => {
    const events = new InMemoryJobEventLog()
    const manager = new JobManager(new JsonFileJobStore(await mkdtemp(join(tmpdir(), "aibr-status-events-"))), {
      events,
      redactError: (text) => text.replaceAll("s3cret", "[REDACTED]"),
    })
    await manager.createJob(validTrigger({ job_id: "job_1" }) as TriggerRequest)
    await manager.markLaunchStarted("job_1")
    await manager.markRunning("job_1")
    await manager.markFailed("job_1", "boom with s3cret")
    const page = await events.read("job_1", 0, 10)
    expect(page.events.map((event) => [event.type, event.data])).toEqual([
      ["status", { status: "accepted" }],
      ["status", { status: "running", from: "accepted" }],
      ["status", { status: "failed", from: "running", error: "boom with [REDACTED]" }],
    ])
  })

  it("does not fail a transition when the log cannot be written", async () => {
    const broken = new InMemoryJobEventLog()
    broken.append = async () => {
      throw new Error("disk full")
    }
    const manager = new JobManager(new JsonFileJobStore(await mkdtemp(join(tmpdir(), "aibr-status-events-"))), { events: broken })
    await manager.createJob(validTrigger({ job_id: "job_1" }) as TriggerRequest)
    expect((await manager.markCompleted("job_1")).status).toBe("completed")
  })
})

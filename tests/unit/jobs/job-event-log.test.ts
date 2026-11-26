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
  it("writes one JSON line per event, carrying the job id, to <jobsDir>/<sha256(id)>.events.jsonl", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibr-job-events-"))
    const log = new FileJobEventLog(directory)
    await log.append("job_1", { type: "status", data: { status: "accepted" } })
    await log.append("job_1", { type: "tool", data: { detail: "Tool call: Read" } })
    expect(jobEventsFileName("job_1")).toMatch(/^[0-9a-f]{64}\.events\.jsonl$/)
    expect(await readdir(directory)).toEqual([jobEventsFileName("job_1")])
    const lines = (await readFile(log.pathFor("job_1"), "utf8")).trimEnd().split("\n")
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      { job_id: "job_1", seq: 1, type: "status", data: { status: "accepted" } },
      { job_id: "job_1", seq: 2, type: "tool", data: { detail: "Tool call: Read" } },
    ])
  })

  it("names every file by the hash of the exact id, so no id can leave the directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibr-job-events-"))
    const log = new FileJobEventLog(directory)
    const ids = ["../../escape", "a/b", ".hidden", "x\ny", "job_1"]
    for (const id of ids) {
      expect(jobEventsFileName(id)).toMatch(/^[0-9a-f]{64}\.events\.jsonl$/)
      await log.append(id, { type: "message", data: { id } })
      expect((await log.read(id, 0, 10)).events).toHaveLength(1)
    }
    expect((await readdir(directory)).sort()).toEqual(ids.map(jobEventsFileName).sort())
  })

  it("keeps ids that differ only in case apart, on disk and on read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibr-job-events-"))
    const log = new FileJobEventLog(directory)
    await log.append("abc", { type: "message", data: { owner: "A" } })
    await log.append("ABC", { type: "message", data: { owner: "B" } })
    await log.append("ABC", { type: "message", data: { owner: "B" } })
    // Two files, even on a case-insensitive filesystem.
    expect(await readdir(directory)).toHaveLength(2)
    for (const reader of [log, new FileJobEventLog(directory)]) {
      expect((await reader.read("abc", 0, 10)).events.map((event) => [event.seq, event.data.owner])).toEqual([[1, "A"]])
      expect((await reader.read("ABC", 0, 10)).events.map((event) => [event.seq, event.data.owner])).toEqual([
        [1, "B"],
        [2, "B"],
      ])
    }
  })

  it("drops lines of another job found in a job's file (defence in depth)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibr-job-events-"))
    const log = new FileJobEventLog(directory)
    await log.append("abc", { type: "message", data: { owner: "A" } })
    const foreign = { job_id: "ABC", seq: 2, at: "2026-11-26T00:00:00.000Z", type: "message", data: { owner: "B" } }
    await appendFile(log.pathFor("abc"), `${JSON.stringify(foreign)}\n`)
    const reopened = new FileJobEventLog(directory)
    expect((await reopened.read("abc", 0, 10)).events.map((event) => event.data.owner)).toEqual(["A"])
    expect((await reopened.append("abc", { type: "message", data: { owner: "A" } }))?.seq).toBe(2)
  })

  it("reads incrementally: a follower parses only the bytes appended since its last read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibr-job-events-"))
    const writer = new FileJobEventLog(directory)
    for (let index = 0; index < 200; index += 1) await writer.append("job", { type: "message", data: { index } })
    // A reader in another process sees the writer's appends through the file alone.
    const reader = new FileJobEventLog(directory)
    expect((await reader.read("job", 0, 1_000)).events).toHaveLength(200)
    const afterFirstRead = reader.bytesRead
    const appended = await writer.append("job", { type: "message", data: { index: 200 } })
    const page = await reader.read("job", 200, 1_000)
    expect(page.events.map((event) => event.seq)).toEqual([201])
    expect(reader.bytesRead - afterFirstRead).toBe(Buffer.byteLength(`${JSON.stringify(appended)}\n`, "utf8"))
    // Nothing new: nothing read.
    await reader.read("job", 201, 1_000)
    expect(reader.bytesRead - afterFirstRead).toBe(Buffer.byteLength(`${JSON.stringify(appended)}\n`, "utf8"))
  })

  it("skips a line cut short by a crash and numbers on from the last whole event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aibr-job-events-"))
    const log = new FileJobEventLog(directory)
    await log.append("job", { type: "status", data: { status: "running" } })
    await appendFile(log.pathFor("job"), '{"job_id":"job","seq":2,"at":"2026-')
    const reopened = new FileJobEventLog(directory)
    expect((await reopened.read("job", 0, 10)).events).toHaveLength(1)
    // The partial line stays; the next event starts on its own line and is readable.
    expect((await reopened.append("job", { type: "message", data: { after: "crash" } }))?.seq).toBe(2)
    for (const reader of [reopened, new FileJobEventLog(directory)]) {
      const page = await reader.read("job", 0, 10)
      expect(page.events.map((event) => [event.seq, event.type])).toEqual([
        [1, "status"],
        [2, "message"],
      ])
    }
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
    expect((await readdir(directory)).sort()).toEqual([jobEventsFileName("job_1"), "job_1.json", "job_2.events.jsonl"].sort())

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

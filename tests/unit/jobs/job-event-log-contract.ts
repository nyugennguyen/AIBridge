/**
 * The `JobEventLog` contract, written against the interface only, so the
 * same suite runs against every implementation: the 3.2.0 file log and the
 * in-memory log today, the event store (ADR 0003) in 3.3.0.
 *
 * Usage: `describeJobEventLogContract("FileJobEventLog", async (options) => ...)`.
 */
import { describe, expect, it } from "vitest"
import { MAX_EVENT_STRING_LENGTH, type JobEvent, type JobEventLog } from "../../../src/jobs/events.js"

export interface ContractLogOptions {
  readonly redact?: (text: string) => string
  readonly maxEvents?: number
  readonly maxBytes?: number
}

export interface ContractSubject {
  readonly log: JobEventLog
  /** A fresh instance over the same storage (a restarted bridge), when the implementation persists. */
  readonly reopen?: () => JobEventLog
}

export function describeJobEventLogContract(name: string, create: (options: ContractLogOptions) => Promise<ContractSubject>): void {
  describe(`JobEventLog contract: ${name}`, () => {
    it("numbers events from 1, per job, and stores them with their type, data and time", async () => {
      const { log } = await create({})
      const first = await log.append("job-a", { type: "status", data: { status: "accepted" } })
      const second = await log.append("job-a", { type: "message", data: { detail: "hello" } })
      const other = await log.append("job-b", { type: "status", data: { status: "running" } })
      expect(first).toMatchObject({ seq: 1, type: "status", data: { status: "accepted" } })
      expect(second).toMatchObject({ seq: 2, type: "message", data: { detail: "hello" } })
      expect(other?.seq).toBe(1)
      expect(Number.isNaN(Date.parse(first!.at))).toBe(false)
      const page = await log.read("job-a", 0, 10)
      expect(page.events.map((event) => event.seq)).toEqual([1, 2])
      expect(page.next).toBe(2)
    })

    it("keeps ids that differ only in case apart: separate numbering, events and subscribers", async () => {
      const subject = await create({})
      const lower: JobEvent[] = []
      subject.log.subscribe("abc", (event) => lower.push(event))
      await subject.log.append("abc", { type: "message", data: { owner: "A" } })
      await subject.log.append("ABC", { type: "message", data: { owner: "B" } })
      await subject.log.append("ABC", { type: "message", data: { owner: "B" } })
      const readers = [subject.log, ...(subject.reopen !== undefined ? [subject.reopen()] : [])]
      for (const reader of readers) {
        const a = await reader.read("abc", 0, 10)
        const b = await reader.read("ABC", 0, 10)
        expect(a.events.map((event) => [event.job_id, event.seq, event.data.owner])).toEqual([["abc", 1, "A"]])
        expect(b.events.map((event) => [event.job_id, event.seq, event.data.owner])).toEqual([
          ["ABC", 1, "B"],
          ["ABC", 2, "B"],
        ])
      }
      expect(lower.map((event) => event.data.owner)).toEqual(["A"])
    })

    it("reads after a cursor, at most `limit`, oldest first; `next` continues the read", async () => {
      const { log } = await create({})
      for (let index = 0; index < 5; index += 1) await log.append("job", { type: "message", data: { index } })
      const first = await log.read("job", 0, 2)
      expect(first.events.map((event) => event.data.index)).toEqual([0, 1])
      const second = await log.read("job", first.next, 2)
      expect(second.events.map((event) => event.data.index)).toEqual([2, 3])
      const third = await log.read("job", second.next, 2)
      expect(third.events.map((event) => event.data.index)).toEqual([4])
      const done = await log.read("job", third.next, 2)
      expect(done).toEqual({ events: [], next: third.next })
    })

    it("reads an unknown job as empty, keeping the cursor", async () => {
      const { log } = await create({})
      expect(await log.read("nobody", 0, 10)).toEqual({ events: [], next: 0 })
      expect(await log.read("nobody", 7, 10)).toEqual({ events: [], next: 7 })
    })

    it("redacts every string of the data, nested ones and keys included, before it is stored", async () => {
      const { log } = await create({ redact: (text) => text.replaceAll("hunter2", "[REDACTED]") })
      await log.append("job", {
        type: "tool",
        data: { detail: "password hunter2", nested: { list: ["a hunter2 b"], hunter2: "key" }, count: 3, ok: true },
      })
      const [event] = (await log.read("job", 0, 10)).events
      expect(JSON.stringify(event)).not.toContain("hunter2")
      expect(event!.data).toEqual({ detail: "password [REDACTED]", nested: { list: ["a [REDACTED] b"], "[REDACTED]": "key" }, count: 3, ok: true })
    })

    it("cuts a very long string after redaction", async () => {
      const { log } = await create({})
      await log.append("job", { type: "result", data: { summary: "x".repeat(MAX_EVENT_STRING_LENGTH * 2) } })
      const [event] = (await log.read("job", 0, 1)).events
      expect(String(event!.data.summary).length).toBe(MAX_EVENT_STRING_LENGTH)
    })

    it("ends a full log (lines) with one `truncated` event and drops every later append", async () => {
      const { log } = await create({ maxEvents: 5 })
      const results: Array<JobEvent | undefined> = []
      for (let index = 0; index < 8; index += 1) results.push(await log.append("job", { type: "message", data: { index } }))
      expect(results.slice(0, 4).every((event) => event !== undefined)).toBe(true)
      expect(results.slice(4).every((event) => event === undefined)).toBe(true)
      const page = await log.read("job", 0, 100)
      expect(page.events).toHaveLength(5)
      expect(page.events.at(-1)).toMatchObject({ seq: 5, type: "truncated", data: { reason: "max_events" } })
      expect(page.events.filter((event) => event.type === "truncated")).toHaveLength(1)
    })

    it("ends a full log (bytes) with one `truncated` event", async () => {
      const { log } = await create({ maxBytes: 2_048 })
      for (let index = 0; index < 20; index += 1) await log.append("job", { type: "message", data: { detail: "y".repeat(300) } })
      const page = await log.read("job", 0, 100)
      expect(page.events.at(-1)).toMatchObject({ type: "truncated", data: { reason: "max_bytes" } })
      expect(page.events.filter((event) => event.type === "truncated")).toHaveLength(1)
      expect(JSON.stringify(page.events).length).toBeLessThan(2_048 + 512)
    })

    it("keeps numbering contiguous under concurrent appends", async () => {
      const { log } = await create({})
      await Promise.all(Array.from({ length: 40 }, (_, index) => log.append("job", { type: "message", data: { index } })))
      const page = await log.read("job", 0, 100)
      expect(page.events.map((event) => event.seq)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1))
      expect(new Set(page.events.map((event) => event.data.index)).size).toBe(40)
    })

    it("tells subscribers about each stored event in order, until they unsubscribe", async () => {
      const { log } = await create({ maxEvents: 4 })
      const seen: JobEvent[] = []
      const unsubscribe = log.subscribe("job", (event) => seen.push(event))
      const elsewhere: JobEvent[] = []
      log.subscribe("other", (event) => elsewhere.push(event))
      for (let index = 0; index < 3; index += 1) await log.append("job", { type: "message", data: { index } })
      await log.append("job", { type: "message", data: { index: 3 } })
      expect(seen.map((event) => [event.seq, event.type])).toEqual([
        [1, "message"],
        [2, "message"],
        [3, "message"],
        [4, "truncated"],
      ])
      unsubscribe()
      await log.append("job", { type: "message", data: { index: 4 } })
      expect(seen).toHaveLength(4)
      expect(elsewhere).toHaveLength(0)
    })

    it("continues numbering and keeps a full log full across a restart (persistent implementations)", async () => {
      const subject = await create({ maxEvents: 4 })
      if (subject.reopen === undefined) return
      await subject.log.append("job", { type: "status", data: { status: "accepted" } })
      await subject.log.append("job", { type: "status", data: { status: "running" } })
      const reopened = subject.reopen()
      expect((await reopened.append("job", { type: "message", data: {} }))?.seq).toBe(3)
      expect(await reopened.append("job", { type: "message", data: {} })).toBeUndefined()
      const again = subject.reopen()
      expect(await again.append("job", { type: "message", data: {} })).toBeUndefined()
      const page = await again.read("job", 0, 100)
      expect(page.events.map((event) => event.type)).toEqual(["status", "status", "message", "truncated"])
    })
  })
}

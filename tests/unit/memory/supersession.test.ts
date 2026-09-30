/**
 * M5.2 — supersession: a correction appends, it never edits.
 *
 * This file exists because the failure it guards against is invisible in normal
 * use. An implementation that "handles supersession" by setting
 * `supersededByMemoryId` on the old record passes every functional test: the
 * active view is right, the history view is right, the TUI shows the right
 * thing. What it destroys is the property the whole milestone rests on — that
 * history is *evidence*. Once a record's bytes can be rewritten, "what did the
 * agent know at the time" stops being answerable, and a correction becomes
 * indistinguishable from a cover-up.
 *
 * So the central assertion here is byte equality: the raw bytes of a
 * superseded record, read before the correction, are exactly the bytes read
 * after it. `getRaw` is the unauthorized read that returns stored bytes with no
 * projection, because a projection is free to add a derived back-pointer and
 * that is precisely the thing that must not be mistaken for stored state.
 *
 * Tombstoning is tested here too, and deliberately as a *different* thing. The
 * plan separates them explicitly ("physical deletion for an explicit
 * retention/privacy operation must leave a non-sensitive tombstone event and is
 * designed separately from ordinary supersession"), and the two have opposite
 * effects on the original bytes: supersession preserves them, tombstoning
 * erases them. A test file that treated them as two flavours of the same
 * operation would assert the contradiction.
 */

import { describe, expect, it } from "vitest"

import { MEMORY_ERROR_CODES } from "../../../src/memory/repository-errors.js"
import { verifyMemoryRecord } from "../../../src/memory/record.js"
import {
  PROJECT_A,
  T_INSTANT,
  T_PLUS_ONE,
  T_PLUS_TWO,
  acceptedInput,
  createRepository,
  expectError,
  expectOk,
  queryFor,
  reader,
  runScope,
  tombstoneRequest,
  type RepositoryHarness,
} from "./fixtures.js"

/** The stored bytes, exactly as they sit in the store. */
async function rawBytes(harness: RepositoryHarness, memoryId: string): Promise<string> {
  const raw = await harness.repository.getRaw(memoryId)
  if (raw === null) throw new Error(`expected '${memoryId}' to still be stored`)
  return JSON.stringify(raw)
}

describe("supersession: the original record's bytes never change", () => {
  it("returns byte-identical raw bytes before and after a correction", async () => {
    const harness = createRepository()
    const original = expectOk(await harness.repository.append(acceptedInput({ content: "deploys are manual" }))).record
    const before = await rawBytes(harness, original.memoryId)

    const correction = expectOk(
      await harness.repository.supersede(original.memoryId, acceptedInput({ content: "deploys are automated" })),
    )

    const after = await rawBytes(harness, original.memoryId)
    expect(after).toBe(before)
    expect(correction.superseded).toEqual(original)
    // The correction names its target and nothing about the target changed.
    expect(correction.record.supersedesMemoryId).toBe(original.memoryId)
    expect(original.supersededByMemoryId).toBeUndefined()
  })

  it("keeps the original's content hash valid, because its content is intact", async () => {
    const harness = createRepository()
    const original = expectOk(await harness.repository.append(acceptedInput({ content: "deploys are manual" }))).record
    expectOk(await harness.repository.supersede(original.memoryId, acceptedInput({ content: "deploys are automated" })))

    const stored = await harness.repository.getRaw(original.memoryId)

    expect(stored).not.toBeNull()
    expect(verifyMemoryRecord(stored!)).toBe(true)
    expect(stored!.schemaVersion).toBe(2)
  })

  it("keeps every prior version readable, not just the first one", async () => {
    const harness = createRepository()
    const v1 = expectOk(await harness.repository.append(acceptedInput({ content: "v1", createdAt: T_INSTANT }))).record
    const v2 = expectOk(await harness.repository.supersede(v1.memoryId, acceptedInput({ content: "v2", createdAt: T_PLUS_ONE })))
    const v3 = expectOk(await harness.repository.supersede(v2.record.memoryId, acceptedInput({ content: "v3", createdAt: T_PLUS_TWO })))

    const history = expectOk(await harness.repository.query(queryFor(PROJECT_A, { includeSuperseded: true }), reader()))

    expect(history.records.map((record) => record.content)).toEqual(["v1", "v2", "v3"])
    expect(history.records.map((record) => record.memoryId)).toEqual([v1.memoryId, v2.record.memoryId, v3.record.memoryId])
    expect(history.withheld).toEqual([])
  })

  it("never mutates an earlier record when a later one is appended", async () => {
    const harness = createRepository()
    const first = expectOk(await harness.repository.append(acceptedInput({ content: "first" }))).record
    const firstBytes = await rawBytes(harness, first.memoryId)

    expectOk(await harness.repository.append(acceptedInput({ content: "unrelated second fact" })))
    expectOk(await harness.repository.supersede(first.memoryId, acceptedInput({ content: "corrected" })))

    expect(await rawBytes(harness, first.memoryId)).toBe(firstBytes)
  })

  it("refuses to supersede a record the store does not hold, and writes nothing", async () => {
    const harness = createRepository()

    const error = expectError(await harness.repository.supersede("memory.0000000000000000000000000000000000000000", acceptedInput()))

    expect(error.code).toBe(MEMORY_ERROR_CODES.unknownSupersession)
    expect(await harness.repository.listProjectUnscoped(PROJECT_A)).toHaveLength(0)
  })
})

describe("supersession: the active view", () => {
  it("shows only the newest link in a chain, by default", async () => {
    const harness = createRepository()
    const v1 = expectOk(await harness.repository.append(acceptedInput({ content: "v1" }))).record
    const v2 = expectOk(await harness.repository.supersede(v1.memoryId, acceptedInput({ content: "v2" })))
    const v3 = expectOk(await harness.repository.supersede(v2.record.memoryId, acceptedInput({ content: "v3" })))

    const active = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))

    expect(active.records.map((record) => record.memoryId)).toEqual([v3.record.memoryId])
  })

  it("marks the back-pointer in the view while leaving it out of the stored bytes", async () => {
    const harness = createRepository()
    const v1 = expectOk(await harness.repository.append(acceptedInput({ content: "v1" }))).record
    const v2 = expectOk(await harness.repository.supersede(v1.memoryId, acceptedInput({ content: "v2" })))

    const history = expectOk(await harness.repository.query(queryFor(PROJECT_A, { includeSuperseded: true }), reader()))
    const original = history.records.find((record) => record.memoryId === v1.memoryId)

    // The view knows the record was superseded...
    expect(original?.supersededByMemoryId).toBe(v2.record.memoryId)
    // ...and the stored bytes do not, because that is a derived fact.
    const stored = await harness.repository.getRaw(v1.memoryId)
    expect(stored !== null && "supersededByMemoryId" in stored).toBe(false)
  })

  it("serves a superseded record by id, because a by-id read is a history read", async () => {
    const harness = createRepository()
    const v1 = expectOk(await harness.repository.append(acceptedInput({ content: "v1" }))).record
    expectOk(await harness.repository.supersede(v1.memoryId, acceptedInput({ content: "v2" })))

    const record = expectOk(await harness.repository.get(v1.memoryId, reader()))

    expect(record?.content).toBe("v1")
    expect(record?.supersededByMemoryId).toBeDefined()
  })

  it("hides every link but the newest when a correction is itself corrected", async () => {
    const harness = createRepository()
    const v1 = expectOk(await harness.repository.append(acceptedInput({ content: "v1" }))).record
    const v2 = expectOk(await harness.repository.supersede(v1.memoryId, acceptedInput({ content: "v2" })))
    const v3 = expectOk(await harness.repository.supersede(v2.record.memoryId, acceptedInput({ content: "v3" })))

    const active = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))

    // v1 was superseded by v2, and v2 was superseded by v3. v2 is no more active
    // than v1 is; a chain has exactly one head, and it is the newest link.
    expect(active.records.map((record) => record.memoryId)).toEqual([v3.record.memoryId])
    expect(active.withheld.map((entry) => entry.memoryId).sort()).toEqual([v1.memoryId, v2.record.memoryId].sort())
  })
})

describe("supersession and tombstoning are different operations", () => {
  it("supersession preserves the original; a tombstone erases it", async () => {
    const preserved = createRepository()
    const original = expectOk(await preserved.repository.append(acceptedInput({ content: "kept forever" }))).record
    expectOk(await preserved.repository.supersede(original.memoryId, acceptedInput({ content: "corrected" })))
    expect(await preserved.repository.getRaw(original.memoryId)).not.toBeNull()

    const deleted = createRepository()
    const doomed = expectOk(await deleted.repository.append(acceptedInput({ content: "deleted by request" }))).record
    expectOk(await deleted.repository.tombstone(tombstoneRequest({ memoryId: doomed.memoryId })))
    expect(await deleted.repository.getRaw(doomed.memoryId)).toBeNull()
  })

  it("a tombstone is not a supersession: it leaves no active replacement and no correction link", async () => {
    const harness = createRepository()
    const record = expectOk(await harness.repository.append(acceptedInput({ content: "deleted by request" }))).record

    const tombstone = expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: record.memoryId })))

    expect(tombstone).not.toHaveProperty("supersedesMemoryId")
    expect(tombstone).not.toHaveProperty("supersededByMemoryId")
    const result = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))
    expect(result.records).toEqual([])
    expect(result.withheld.map((entry) => entry.reason)).toEqual(["tombstoned"])
  })

  it("a superseded record is not tombstoned, and a tombstoned record cannot be superseded", async () => {
    const harness = createRepository()
    const original = expectOk(await harness.repository.append(acceptedInput({ content: "corrected later" }))).record
    const correction = expectOk(await harness.repository.supersede(original.memoryId, acceptedInput({ content: "corrected" })))

    expect(await harness.repository.listTombstonesUnscoped(PROJECT_A)).toEqual([])
    const beforeDeletion = await harness.repository.get(correction.record.memoryId, reader())
    expect(beforeDeletion.ok).toBe(true)

    expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: correction.record.memoryId })))
    expect(expectError(await harness.repository.get(correction.record.memoryId, reader())).code).toBe(MEMORY_ERROR_CODES.tombstoned)
    // The original is still stored: deleting the correction deletes the
    // correction, not the history.
    expect(await harness.repository.getRaw(original.memoryId)).not.toBeNull()
  })

  it("does not silently revive a record whose only correction was deleted", async () => {
    const harness = createRepository()
    const original = expectOk(await harness.repository.append(acceptedInput({ content: "v1" }))).record
    const correction = expectOk(await harness.repository.supersede(original.memoryId, acceptedInput({ content: "v2" })))
    expectOk(await harness.repository.tombstone(tombstoneRequest({ memoryId: correction.record.memoryId })))

    const active = expectOk(await harness.repository.query(queryFor(PROJECT_A), reader()))

    expect(active.records).toEqual([])
    expect(active.withheld.find((entry) => entry.memoryId === original.memoryId)?.reason).toBe("superseded")
  })
})

describe("supersession: scope and project", () => {
  it("supersedes within a scope without changing the scope of the record", async () => {
    const harness = createRepository()
    const original = expectOk(
      await harness.repository.append(acceptedInput({ scope: runScope("run-1"), content: "run-1 finding" })),
    ).record
    const correction = expectOk(
      await harness.repository.supersede(original.memoryId, acceptedInput({ scope: runScope("run-1"), content: "run-1 finding, corrected" })),
    )

    expect(correction.record.scope).toEqual(runScope("run-1"))
    const active = expectOk(await harness.repository.query(queryFor(PROJECT_A, { runId: "run-1" }), reader({ scope: runScope("run-1") })))
    expect(active.records.map((record) => record.memoryId)).toEqual([correction.record.memoryId])
  })
})

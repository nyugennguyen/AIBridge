import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SqliteEventStore } from "../../../src/orchestration/event-store/event-store.js"
import {
  DuplicateEventError,
  StreamProjectMismatchError,
} from "../../../src/orchestration/event-store/errors.js"
import type { OutboxRecord } from "../../../src/orchestration/event-store/types.js"
import { makeCommand } from "./fixtures.js"
import {
  T0,
  T1,
  T2,
  T29,
  T30,
  T31,
  T60,
  T5M,
  cleanupPaths,
  describeEachBackend,
  makeTempPath,
  openStore,
  seedOutbox,
  type Backend,
} from "./outbox-helpers.js"

function makeFinishedEvent(options: {
  eventId: string
  commandId: string
  runId?: string
}): any {
  return {
    schemaVersion: 1,
    eventId: options.eventId,
    projectId: "project-alpha",
    runId: options.runId ?? "run-101",
    actor: { kind: "system", name: "kernel" },
    occurredAt: "2026-09-17T00:00:01.000Z",
    correlationId: "corr-test",
    causation: null,
    controllerEpoch: 1,
    commandId: options.commandId,
    type: "dispatch.finished",
    payload: { dispatchId: "disp-test", outcome: "completed" },
  }
}

describeEachBackend("B7: outbox claim/lease/recovery primitives", (backend: Backend) => {
  let path: string
  let store: SqliteEventStore
  const temps: string[] = []

  beforeEach(() => {
    path = makeTempPath(`outbox-${backend}`)
    temps.push(path)
    store = openStore(backend, path)
  })

  afterEach(() => {
    store.close()
    cleanupPaths(temps)
  })

  describe("append-time scoping", () => {
    it("stamps run, project, command and sequence provenance on each outbox row", () => {
      seedOutbox(store, [{ outboxId: "out-1", destination: "node-a", runId: "run-101" }])

      const record = store.getOutboxRecord("out-1")!
      expect(record.runId).toBe("run-101")
      expect(record.projectId).toBe("project-alpha")
      expect(record.commandId).toBe("cmd-out-1")
      expect(record.status).toBe("pending")
      expect(record.attempts).toBe(0)
      expect(record.claimToken).toBeUndefined()
      expect(record.leaseExpiresAt).toBeUndefined()
    })

    it("refuses a second outbox row carrying the same command, destination and payload", () => {
      // Two rows in one command with the same delivery key: the second insert
      // must abort the whole append transaction.
      const command = makeCommand({ commandId: "cmd-dup" })
      expect(() => {
        store.append({
          command,
          events: [],
          outboxRecords: [
            { outboxId: "out-a", destination: "node-a", payload: { p: 1 } },
            { outboxId: "out-b", destination: "node-a", payload: { p: 1 } },
          ],
        })
      }).toThrow(/UNIQUE constraint failed/)

      // The rejected command left nothing behind.
      expect(store.getCommandReceipt("project-alpha", "run-101", "cmd-dup")).toBeUndefined()
      expect(store.countOutbox()).toBe(0)
    })

    it("allows the same command to target two different destinations", () => {
      const command = makeCommand({ commandId: "cmd-fanout" })
      store.append({
        command,
        events: [],
        outboxRecords: [
          { outboxId: "out-a", destination: "node-a", payload: { p: 1 } },
          { outboxId: "out-b", destination: "node-b", payload: { p: 1 } },
        ],
      })

      expect(store.countOutbox()).toBe(2)
    })

    it("rejects an outbox record scoped to a different project than its command", () => {
      const command = makeCommand({ commandId: "cmd-mismatch" })
      expect(() => {
        store.append({
          command,
          events: [],
          outboxRecords: [
            { outboxId: "out-x", destination: "node-a", payload: { p: 1 }, projectId: "project-beta" as any },
          ],
        })
      }).toThrow(StreamProjectMismatchError)
    })
  })

  describe("claimPendingOutbox", () => {
    beforeEach(() => {
      seedOutbox(store, [
        { outboxId: "out-1", destination: "node-a", runId: "run-101", createdAt: T0 },
        { outboxId: "out-2", destination: "node-b", runId: "run-101", createdAt: T1 },
        { outboxId: "out-3", destination: "node-a", runId: "run-202", createdAt: T2 },
      ])
    })

    it("moves claimed rows to sending, increments attempts, and stamps the lease", () => {
      const claim = store.claimPendingOutbox({ now: T0, leaseMs: 30_000, limit: 10 })

      expect(claim.records).toHaveLength(3)
      expect(claim.token).toBeTruthy()
      expect(claim.claimedAt).toBe(T0)
      expect(claim.leaseExpiresAt).toBe(T30)

      for (const record of claim.records) {
        expect(record.status).toBe("sending")
        expect(record.attempts).toBe(1)
        expect(record.claimToken).toBe(claim.token)
        expect(record.leaseExpiresAt).toBe(claim.leaseExpiresAt)
        expect(record.lastAttemptedAt).toBe(T0)
      }

      expect(store.listPendingOutbox()).toHaveLength(0)
    })

    it("never hands the same record to a second claim", () => {
      const first = store.claimPendingOutbox({ now: T0, leaseMs: 30_000, limit: 10 })
      const second = store.claimPendingOutbox({ now: T0, leaseMs: 30_000, limit: 10 })

      expect(first.records).toHaveLength(3)
      expect(second.records).toHaveLength(0)

      // attempts was incremented exactly once per record
      for (const record of first.records) {
        expect(store.getOutboxRecord(record.outboxId)?.attempts).toBe(1)
      }
    })

    it("honours limit and claims oldest first", () => {
      const claim = store.claimPendingOutbox({ now: T0, leaseMs: 30_000, limit: 2 })
      expect(claim.records.map((r) => r.outboxId)).toEqual(["out-1", "out-2"])
      expect(store.getOutboxRecord("out-3")?.status).toBe("pending")
    })

    it("filters by run so a single-run worker can be built", () => {
      const claim = store.claimPendingOutbox({ now: T0, leaseMs: 30_000, runId: "run-202" })
      expect(claim.records.map((r) => r.outboxId)).toEqual(["out-3"])
      expect(store.getOutboxRecord("out-1")?.status).toBe("pending")
    })

    it("filters by destination", () => {
      const claim = store.claimPendingOutbox({ now: T0, leaseMs: 30_000, destination: "node-b" })
      expect(claim.records.map((r) => r.outboxId)).toEqual(["out-2"])
    })

    it("filters by project", () => {
      seedOutbox(store, [
        { outboxId: "out-p2", destination: "node-a", projectId: "project-beta", runId: "run-303" },
      ])
      const claim = store.claimPendingOutbox({ now: T0, leaseMs: 30_000, projectId: "project-beta" })
      expect(claim.records.map((r) => r.outboxId)).toEqual(["out-p2"])
    })

    it("does not claim records still inside their backoff window", () => {
      // out-1 fails once and is requeued with a backoff deadline of T5M.
      const firstClaim = store.claimPendingOutbox({ now: T0, leaseMs: 30_000, limit: 1 })
      expect(firstClaim.records.map((r) => r.outboxId)).toEqual(["out-1"])
      store.markOutboxFailed("out-1", new Error("transient"), {
        claimToken: firstClaim.token,
        nextAttemptAt: T5M,
        now: T1,
      })
      expect(store.getOutboxRecord("out-1")?.status).toBe("pending")
      expect(store.getOutboxRecord("out-1")?.attempts).toBe(1)

      const early = store.claimPendingOutbox({ now: T60, leaseMs: 30_000 })
      expect(early.records.map((r) => r.outboxId)).toEqual(["out-2", "out-3"])

      const late = store.claimPendingOutbox({ now: T5M, leaseMs: 30_000 })
      expect(late.records.map((r) => r.outboxId)).toEqual(["out-1"])
      expect(store.getOutboxRecord("out-1")?.attempts).toBe(2)
    })
  })

  describe("markOutboxSending", () => {
    it("extends the lease for the holder and refuses a stale token", () => {
      seedOutbox(store, [{ outboxId: "out-1", destination: "node-a" }])
      const claim = store.claimPendingOutbox({ now: T0, leaseMs: 30_000 })

      const extended = store.markOutboxSending("out-1", claim.token, { now: T30, leaseMs: 60_000 })
      expect(extended.changed).toBe(true)
      expect(extended.record?.leaseExpiresAt).toBe("2026-09-17T00:01:30.000Z")

      const stolen = store.markOutboxSending("out-1", "not-the-token", { now: T30 })
      expect(stolen.changed).toBe(false)
      expect(stolen.record?.leaseExpiresAt).toBe("2026-09-17T00:01:30.000Z")
    })
  })

  describe("markOutboxAcknowledged", () => {
    it("clears the claim and records the acknowledgement time", () => {
      seedOutbox(store, [{ outboxId: "out-1", destination: "node-a" }])
      store.claimPendingOutbox({ now: T0, leaseMs: 30_000 })

      const res = store.markOutboxAcknowledged("out-1", T30)
      expect(res.changed).toBe(true)
      expect(res.record?.status).toBe("acknowledged")
      expect(res.record?.acknowledgedAt).toBe(T30)
      expect(res.record?.claimToken).toBeUndefined()
      expect(res.record?.leaseExpiresAt).toBeUndefined()

      // A second acknowledgement is a no-op, not an error.
      expect(store.markOutboxAcknowledged("out-1", T31).changed).toBe(false)
    })
  })

  describe("markOutboxFailed", () => {
    it("requeues with backoff when nextAttemptAt is supplied", () => {
      seedOutbox(store, [{ outboxId: "out-1", destination: "node-a" }])
      store.claimPendingOutbox({ now: T0, leaseMs: 30_000 })

      const res = store.markOutboxFailed("out-1", new Error("ECONNRESET"), {
        claimToken: store.getOutboxRecord("out-1")!.claimToken,
        nextAttemptAt: T5M,
        now: T30,
      })

      expect(res.changed).toBe(true)
      expect(res.record?.status).toBe("pending")
      expect(res.record?.nextAttemptAt).toBe(T5M)
      expect(res.record?.lastError).toContain("ECONNRESET")
      expect(res.record?.attempts).toBe(1)
      expect(res.record?.claimToken).toBeUndefined()
    })

    it("moves to the terminal failed state when no backoff is supplied", () => {
      seedOutbox(store, [{ outboxId: "out-1", destination: "node-a" }])
      const claim = store.claimPendingOutbox({ now: T0, leaseMs: 30_000 })

      const res = store.markOutboxFailed("out-1", new Error("permanent"), {
        claimToken: claim.token,
        now: T30,
      })

      expect(res.record?.status).toBe("failed")
      expect(res.record?.failedAt).toBe(T30)
      expect(res.record?.nextAttemptAt).toBeUndefined()

      // Terminal: it is no longer claimable.
      expect(store.claimPendingOutbox({ now: T5M, leaseMs: 30_000 }).records).toHaveLength(0)
    })

    it("refuses a failure report from a claim token that no longer holds the record", () => {
      seedOutbox(store, [{ outboxId: "out-1", destination: "node-a" }])
      const claim = store.claimPendingOutbox({ now: T0, leaseMs: 30_000 })

      const res = store.markOutboxFailed("out-1", new Error("late"), { claimToken: "stale", now: T30 })
      expect(res.changed).toBe(false)
      expect(res.record?.status).toBe("sending")
      expect(claim.token).not.toBe("stale")
    })

    it("truncates an enormous error string", () => {
      seedOutbox(store, [{ outboxId: "out-1", destination: "node-a" }])
      store.claimPendingOutbox({ now: T0, leaseMs: 30_000 })
      const res = store.markOutboxFailed("out-1", "x".repeat(50_000), { now: T30 })
      expect(res.record!.lastError!.length).toBeLessThanOrEqual(2000)
    })
  })

  describe("recoverStaleOutbox (plan failure boundaries 5 and 6)", () => {
    it("requeues a record whose claim lease expired", () => {
      seedOutbox(store, [{ outboxId: "out-1", destination: "node-a" }])
      store.claimPendingOutbox({ now: T0, leaseMs: 30_000 })

      // Not yet expired: the lease runs to exactly T30.
      expect(store.recoverStaleOutbox({ now: T29 }).recovered).toHaveLength(0)
      expect(store.getOutboxRecord("out-1")?.status).toBe("sending")

      const result = store.recoverStaleOutbox({ now: T31 })
      expect(result.recovered).toEqual(["out-1"])
      expect(result.requeuedCount).toBe(1)

      const record = store.getOutboxRecord("out-1")!
      expect(record.status).toBe("pending")
      expect(record.claimToken).toBeUndefined()
      expect(record.leaseExpiresAt).toBeUndefined()
      expect(record.lastError).toContain("lease expired")
      expect(record.attempts).toBe(1)
    })

    it("does not touch an acknowledged record", () => {
      seedOutbox(store, [{ outboxId: "out-1", destination: "node-a" }])
      store.claimPendingOutbox({ now: T0, leaseMs: 30_000 })
      store.markOutboxAcknowledged("out-1", T1)

      expect(store.recoverStaleOutbox({ now: T5M }).recovered).toHaveLength(0)
      expect(store.getOutboxRecord("out-1")?.status).toBe("acknowledged")
    })

    it("does not touch a terminally failed record", () => {
      seedOutbox(store, [{ outboxId: "out-1", destination: "node-a" }])
      store.claimPendingOutbox({ now: T0, leaseMs: 30_000 })
      store.markOutboxFailed("out-1", new Error("nope"), { now: T1 })

      expect(store.recoverStaleOutbox({ now: T5M }).recovered).toHaveLength(0)
      expect(store.getOutboxRecord("out-1")?.status).toBe("failed")
    })

    it("leaves a record that is still inside its lease alone, even under a concurrent claim", () => {
      seedOutbox(store, [{ outboxId: "out-1", destination: "node-a" }])
      store.claimPendingOutbox({ now: T0, leaseMs: 300_000 })

      expect(store.recoverStaleOutbox({ now: T60 }).recovered).toHaveLength(0)
      expect(store.getOutboxRecord("out-1")?.status).toBe("sending")
    })

    it("is idempotent: running recovery twice requeues once", () => {
      seedOutbox(store, [{ outboxId: "out-1", destination: "node-a" }])
      store.claimPendingOutbox({ now: T0, leaseMs: 30_000 })

      expect(store.recoverStaleOutbox({ now: T31 }).requeuedCount).toBe(1)
      expect(store.recoverStaleOutbox({ now: T31 }).requeuedCount).toBe(0)
      expect(store.getOutboxRecord("out-1")?.attempts).toBe(1)
    })

    it("filters recovery by run", () => {
      seedOutbox(store, [
        { outboxId: "out-1", destination: "node-a", runId: "run-101" },
        { outboxId: "out-2", destination: "node-a", runId: "run-202" },
      ])
      store.claimPendingOutbox({ now: T0, leaseMs: 30_000 })

      const result = store.recoverStaleOutbox({ now: T31, runId: "run-101" })
      expect(result.recovered).toEqual(["out-1"])
      expect(store.getOutboxRecord("out-2")?.status).toBe("sending")
    })
  })

  describe("two concurrent controllers on one authoritative store", () => {
    it("partitions the pending set with no double claim", async () => {
      const seeds = Array.from({ length: 24 }, (_, i) => ({
        outboxId: `out-${i}`,
        destination: `node-${i % 3}`,
        runId: i % 2 === 0 ? "run-101" : "run-202",
      }))
      seedOutbox(store, seeds)

      // A second connection to the SAME authoritative file, as ADR 0004
      // requires for two controllers racing on one authority.
      const other = openStore(backend, path)

      const claim = (s: SqliteEventStore, now: any) => s.claimPendingOutbox({ now, leaseMs: 30_000, limit: 12 })
      const a = claim(store, T0)
      const b = claim(other, T0)

      const ids = [...a.records, ...b.records].map((r: OutboxRecord) => r.outboxId)
      expect(new Set(ids).size).toBe(ids.length)
      expect(a.records).toHaveLength(12)
      expect(b.records).toHaveLength(12)
      expect(a.token).not.toBe(b.token)

      // Every record is owned by exactly one controller and bumped exactly once.
      for (const id of ids) {
        expect(store.getOutboxRecord(id)?.attempts).toBe(1)
      }
      expect(store.countOutbox({ status: "pending" })).toBe(0)
      expect(store.countOutbox({ status: "sending" })).toBe(24)

      other.close()
    })

    it("keeps a controller from acknowledging a record it no longer holds", async () => {
      seedOutbox(store, [{ outboxId: "out-1", destination: "node-a" }])
      const first = store.claimPendingOutbox({ now: T0, leaseMs: 1_000 })

      // Lease expires and the second controller recovers + re-claims it.
      store.recoverStaleOutbox({ now: T2 })
      const second = store.claimPendingOutbox({ now: T2, leaseMs: 30_000 })
      expect(second.records.map((r) => r.outboxId)).toEqual(["out-1"])
      expect(second.token).not.toBe(first.token)

      // The original holder's failure report is rejected; the new owner is intact.
      const staleFailure = store.markOutboxFailed("out-1", new Error("stale"), {
        claimToken: first.token,
        now: T2,
      })
      expect(staleFailure.changed).toBe(false)
      expect(store.getOutboxRecord("out-1")?.status).toBe("sending")
    })
  })

  describe("exhaustOutbox (poison message)", () => {
    it("moves a repeatedly failing record to failed and stops claiming it", () => {
      seedOutbox(store, [{ outboxId: "out-1", destination: "node-a" }])

      for (let i = 0; i < 3; i++) {
        const claim = store.claimPendingOutbox({ now: T0, leaseMs: 30_000, limit: 1 })
        expect(claim.records).toHaveLength(1)
        store.markOutboxFailed("out-1", new Error(`attempt ${i}`), { nextAttemptAt: T0, now: T0 })
      }

      expect(store.getOutboxRecord("out-1")?.attempts).toBe(3)

      const res = store.exhaustOutbox("out-1", new Error("max attempts reached"), { now: T1 })
      expect(res.changed).toBe(true)
      expect(res.record?.status).toBe("failed")
      expect(res.record?.lastError).toContain("max attempts reached")

      expect(store.claimPendingOutbox({ now: T5M, leaseMs: 30_000 }).records).toHaveLength(0)
      // The record is retained as evidence, never deleted.
      expect(store.getOutboxRecord("out-1")).toBeDefined()
    })
  })

  describe("atomicity with the event transaction", () => {
    it("rolls the outbox insert back when the event batch fails", () => {
      // Reuse of an already-stored eventId forces the append to fail.
      seedOutbox(store, [{ outboxId: "out-seed", destination: "node-a", runId: "run-101" }])

      const command = makeCommand({ commandId: "cmd-rollback", runId: "run-101" })
      const badEvent = makeFinishedEvent({ eventId: "ev-dup", commandId: command.commandId })

      // Pre-seed the colliding event id via a separate command in another run.
      const otherRun = makeCommand({ commandId: "cmd-collide", runId: "run-999" })
      store.append({
        command: otherRun,
        events: [makeFinishedEvent({ eventId: "ev-dup", commandId: otherRun.commandId, runId: "run-999" })],
      })

      expect(() => {
        store.append({
          command,
          events: [badEvent],
          outboxRecords: [{ outboxId: "out-bad", destination: "node-a", payload: { p: 1 } }],
        })
      }).toThrow(DuplicateEventError)

      expect(store.getOutboxRecord("out-bad")).toBeUndefined()
      expect(store.getCommandReceipt("project-alpha", "run-101", "cmd-rollback")).toBeUndefined()
      expect(store.countOutbox()).toBe(1)
    })
  })
})

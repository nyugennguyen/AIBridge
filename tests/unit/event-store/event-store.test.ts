import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { orchestrationCommandSchema, orchestrationEventSchema } from "../../../src/orchestration/schemas.js"
import type { OrchestrationCommand, OrchestrationEvent } from "../../../src/orchestration/types.js"
import {
  DuplicateEventError,
  FingerprintConflictError,
  SequenceMismatchError,
  StreamProjectMismatchError,
  UnsupportedSchemaVersionError,
} from "../../../src/orchestration/event-store/errors.js"
import { SqliteEventStore } from "../../../src/orchestration/event-store/event-store.js"
import {
  createSqliteDriver,
  openInMemoryDriver,
  type SqliteDriver,
} from "../../../src/orchestration/event-store/sqlite-driver.js"
import { CURRENT_SCHEMA_VERSION } from "../../../src/orchestration/event-store/schema.js"

function makeCommand(options: {
  commandId: string
  projectId?: string
  runId?: string
  epoch?: number
  reason?: string
}): OrchestrationCommand {
  const projectId = (options.projectId ?? "project-alpha") as any
  const runId = (options.runId ?? "run-101") as any
  return orchestrationCommandSchema.parse({
    schemaVersion: 1,
    commandId: options.commandId,
    projectId,
    runId,
    actor: { kind: "user", userId: "user-test" },
    controllerNodeId: "node-test",
    controllerEpoch: options.epoch ?? 1,
    leaseId: "lease-test",
    issuedAt: "2026-09-17T00:00:00.000Z",
    expiresAt: "2026-09-17T00:10:00.000Z",
    correlationId: "corr-test",
    causation: null,
    type: "run.cancel",
    payload: {
      reason: options.reason ?? "Test cancel reason",
    },
  })
}

function makeEvent(options: {
  eventId: string
  commandId?: string
  projectId?: string
  runId?: string
  sequence?: number
  epoch?: number
  type?: "dispatch.finished"
  outcome?: "completed" | "failed" | "timed_out" | "cancelled"
  summary?: string
}): any {
  const projectId = (options.projectId ?? "project-alpha") as any
  const runId = (options.runId ?? "run-101") as any
  const event: any = {
    schemaVersion: 1,
    eventId: options.eventId,
    projectId,
    runId,
    actor: { kind: "system", name: "kernel" },
    occurredAt: "2026-09-17T00:00:01.000Z",
    correlationId: "corr-test",
    causation: null,
    controllerEpoch: options.epoch ?? 1,
    commandId: options.commandId ?? "cmd-1",
    type: "dispatch.finished",
    payload: {
      dispatchId: "disp-test",
      outcome: options.outcome ?? "completed",
      summary: options.summary ?? "Finished dispatch",
    },
  }
  if (options.sequence !== undefined) {
    event.sequence = options.sequence
  }
  return event
}

describe("SqliteEventStore", () => {
  let driver: SqliteDriver
  let store: SqliteEventStore
  let tempFiles: string[] = []

  beforeEach(() => {
    driver = openInMemoryDriver()
    store = new SqliteEventStore(driver)
  })

  afterEach(() => {
    if (driver.isOpen()) {
      driver.close()
    }
    for (const f of tempFiles) {
      if (existsSync(f)) {
        try {
          rmSync(f, { force: true })
        } catch {
          // ignore
        }
      }
    }
    tempFiles = []
  })

  describe("WAL mode, foreign keys, and transaction rollbacks", () => {
    it("enforces SQLite pragmas on the underlying driver", () => {
      const fk = driver.get<{ foreign_keys: number }>("PRAGMA foreign_keys")
      const sync = driver.get<{ synchronous: number }>("PRAGMA synchronous")
      const timeout = driver.get<{ timeout: number }>("PRAGMA busy_timeout")

      expect(fk?.foreign_keys).toBe(1)
      expect(sync?.synchronous).toBe(2)
      expect(timeout?.timeout).toBe(5000)
    })

    it("rolls back the entire append batch when an error occurs during execution", () => {
      const cmd1 = makeCommand({ commandId: "cmd-success" })
      const ev1 = makeEvent({ eventId: "ev-1", commandId: cmd1.commandId })
      store.append({ command: cmd1, events: [ev1] })

      const cmd2 = makeCommand({ commandId: "cmd-fail" })
      const ev2 = makeEvent({ eventId: "ev-2", commandId: cmd2.commandId })
      const ev3Duplicate = makeEvent({ eventId: "ev-1", commandId: cmd2.commandId }) // Duplicate eventId!

      expect(() => {
        store.append({ command: cmd2, events: [ev2, ev3Duplicate] })
      }).toThrow(DuplicateEventError)

      // Verify stream head is still at 1 and cmd-fail was never committed
      const head = store.getStreamHead("run-101")
      expect(head?.lastSequence).toBe(1)

      const streamEvents = store.readStream("run-101")
      expect(streamEvents).toHaveLength(1)
      expect(streamEvents[0].eventId).toBe("ev-1")

      const receipt = store.getCommandReceipt("project-alpha", "run-101", "cmd-fail")
      expect(receipt).toBeUndefined()
    })
  })

  describe("Single & multi-event appends with contiguous sequences", () => {
    it("appends a single event and assigns sequence 1", () => {
      const cmd = makeCommand({ commandId: "cmd-single" })
      const ev = makeEvent({ eventId: "ev-1", commandId: cmd.commandId })

      const result = store.append({ command: cmd, events: [ev] })

      expect(result.duplicate).toBe(false)
      expect(result.startSequence).toBe(1)
      expect(result.endSequence).toBe(1)
      expect(result.events).toHaveLength(1)
      expect(result.events[0].sequence).toBe(1)
      expect(result.events[0].globalPosition).toBe(1)

      const head = store.getStreamHead("run-101")
      expect(head?.lastSequence).toBe(1)
      expect(head?.currentEpoch).toBe(1)
    })

    it("appends multiple events in one transaction allocating contiguous sequences", () => {
      const cmd1 = makeCommand({ commandId: "cmd-init" })
      const ev1 = makeEvent({ eventId: "ev-1", commandId: cmd1.commandId })
      store.append({ command: cmd1, events: [ev1] })

      const cmd2 = makeCommand({ commandId: "cmd-multi" })
      const ev2 = makeEvent({ eventId: "ev-2", commandId: cmd2.commandId })
      const ev3 = makeEvent({ eventId: "ev-3", commandId: cmd2.commandId })
      const ev4 = makeEvent({ eventId: "ev-4", commandId: cmd2.commandId })

      const result = store.append({ command: cmd2, events: [ev2, ev3, ev4] })

      expect(result.startSequence).toBe(2)
      expect(result.endSequence).toBe(4)
      expect(result.events.map((e) => e.sequence)).toEqual([2, 3, 4])

      const head = store.getStreamHead("run-101")
      expect(head?.lastSequence).toBe(4)

      const allEvents = store.readStream("run-101")
      expect(allEvents.map((e) => e.sequence)).toEqual([1, 2, 3, 4])
      expect(allEvents.map((e) => e.eventId)).toEqual(["ev-1", "ev-2", "ev-3", "ev-4"])
    })

    it("verifies and rejects non-contiguous sequences supplied in batch", () => {
      const cmd = makeCommand({ commandId: "cmd-gap" })
      const ev1 = makeEvent({ eventId: "ev-1", commandId: cmd.commandId, sequence: 1 })
      const ev3Gap = makeEvent({ eventId: "ev-3", commandId: cmd.commandId, sequence: 3 }) // Missing sequence 2!

      expect(() => {
        store.append({ command: cmd, events: [ev1, ev3Gap] })
      }).toThrow(SequenceMismatchError)

      const head = store.getStreamHead("run-101")
      expect(head).toBeUndefined()
    })
  })

  describe("Optimistic sequence mismatch detection", () => {
    it("succeeds when expectedSequence matches the stream head", () => {
      const cmd1 = makeCommand({ commandId: "cmd-1" })
      const ev1 = makeEvent({ eventId: "ev-1", commandId: cmd1.commandId })
      store.append({ command: cmd1, events: [ev1], expectedSequence: 0 })

      const cmd2 = makeCommand({ commandId: "cmd-2" })
      const ev2 = makeEvent({ eventId: "ev-2", commandId: cmd2.commandId })
      const res = store.append({ command: cmd2, events: [ev2], expectedSequence: 1 })

      expect(res.receipt.startSequence).toBe(2)
      expect(res.receipt.endSequence).toBe(2)
    })

    it("throws SequenceMismatchError when expectedSequence does not match", () => {
      const cmd1 = makeCommand({ commandId: "cmd-1" })
      const ev1 = makeEvent({ eventId: "ev-1", commandId: cmd1.commandId })
      store.append({ command: cmd1, events: [ev1] })

      const cmd2 = makeCommand({ commandId: "cmd-2" })
      const ev2 = makeEvent({ eventId: "ev-2", commandId: cmd2.commandId })

      expect(() => {
        store.append({ command: cmd2, events: [ev2], expectedSequence: 0 }) // Expected 0, but head is 1
      }).toThrow(SequenceMismatchError)

      try {
        store.append({ command: cmd2, events: [ev2], expectedSequence: 5 })
      } catch (err: any) {
        expect(err).toBeInstanceOf(SequenceMismatchError)
        expect(err.code).toBe("concurrency.sequence_mismatch")
        expect(err.expectedSequence).toBe(5)
        expect(err.actualSequence).toBe(1)
        expect(err.toContractError().category).toBe("conflict")
      }
    })
  })

  describe("Command receipt duplicate detection", () => {
    it("returns idempotent duplicate result when identical command is submitted", () => {
      const cmd = makeCommand({ commandId: "cmd-idempotent" })
      const ev = makeEvent({ eventId: "ev-1", commandId: cmd.commandId })

      const firstResult = store.append({
        command: cmd,
        events: [ev],
        commandResult: { success: true, processedItems: 5 },
      })

      expect(firstResult.duplicate).toBe(false)
      expect(firstResult.receipt.status).toBe("completed")
      expect(firstResult.receipt.result).toEqual({ success: true, processedItems: 5 })

      // Second append with identical command
      const secondResult = store.append({
        command: cmd,
        events: [ev],
        commandResult: { success: true, processedItems: 5 },
      })

      expect(secondResult.duplicate).toBe(true)
      expect(secondResult.receipt.commandId).toBe(cmd.commandId)
      expect(secondResult.receipt.status).toBe("completed")
      expect(secondResult.receipt.result).toEqual({ success: true, processedItems: 5 })
      expect(secondResult.events).toHaveLength(0)

      // Ensure no new events were appended
      const allEvents = store.readStream("run-101")
      expect(allEvents).toHaveLength(1)
    })

    it("throws FingerprintConflictError when command ID is reused with different content", () => {
      const cmd1 = makeCommand({ commandId: "cmd-reused", reason: "Reason one" })
      const ev1 = makeEvent({ eventId: "ev-1", commandId: cmd1.commandId })
      store.append({ command: cmd1, events: [ev1] })

      const cmdAltered = makeCommand({ commandId: "cmd-reused", reason: "Altered reason" })
      const ev2 = makeEvent({ eventId: "ev-2", commandId: cmdAltered.commandId })

      expect(() => {
        store.append({ command: cmdAltered, events: [ev2] })
      }).toThrow(FingerprintConflictError)

      try {
        store.append({ command: cmdAltered, events: [ev2] })
      } catch (err: any) {
        expect(err).toBeInstanceOf(FingerprintConflictError)
        expect(err.code).toBe("command.fingerprint_conflict")
        expect(err.commandId).toBe("cmd-reused")
        expect(err.toContractError().category).toBe("conflict")
      }

      // Verify original receipt is intact
      const receipt = store.getCommandReceipt("project-alpha", "run-101", "cmd-reused")
      expect(receipt).toBeDefined()
      expect(receipt?.commandFingerprint).toBeDefined()
    })
  })

  describe("Global and stream reads with pagination", () => {
    beforeEach(() => {
      // Create 2 runs with 3 events each
      const cmdRun1A = makeCommand({ commandId: "cmd-r1-a", runId: "run-1" })
      const evR1_1 = makeEvent({ eventId: "ev-r1-1", runId: "run-1", commandId: cmdRun1A.commandId })
      const evR1_2 = makeEvent({ eventId: "ev-r1-2", runId: "run-1", commandId: cmdRun1A.commandId })
      store.append({ command: cmdRun1A, events: [evR1_1, evR1_2] })

      const cmdRun1B = makeCommand({ commandId: "cmd-r1-b", runId: "run-1" })
      const evR1_3 = makeEvent({ eventId: "ev-r1-3", runId: "run-1", commandId: cmdRun1B.commandId })
      store.append({ command: cmdRun1B, events: [evR1_3] })

      const cmdRun2 = makeCommand({ commandId: "cmd-r2", runId: "run-2" })
      const evR2_1 = makeEvent({ eventId: "ev-r2-1", runId: "run-2", commandId: cmdRun2.commandId })
      const evR2_2 = makeEvent({ eventId: "ev-r2-2", runId: "run-2", commandId: cmdRun2.commandId })
      store.append({ command: cmdRun2, events: [evR2_1, evR2_2] })
    })

    it("reads stream events filtered by fromSequence and toSequence", () => {
      const slice = store.readStream("run-1", { fromSequence: 2, toSequence: 3 })
      expect(slice).toHaveLength(2)
      expect(slice.map((e) => e.sequence)).toEqual([2, 3])
      expect(slice.map((e) => e.eventId)).toEqual(["ev-r1-2", "ev-r1-3"])
    })

    it("reads stream events with limit pagination", () => {
      const page1 = store.readStream("run-1", { fromSequence: 1, limit: 2 })
      expect(page1).toHaveLength(2)
      expect(page1.map((e) => e.sequence)).toEqual([1, 2])

      const page2 = store.readStream("run-1", { fromSequence: 3, limit: 2 })
      expect(page2).toHaveLength(1)
      expect(page2[0].sequence).toBe(3)
    })

    it("reads global events across runs ordered by global_position", () => {
      const allGlobal = store.readGlobal()
      expect(allGlobal).toHaveLength(5)
      expect(allGlobal.map((e) => e.globalPosition)).toEqual([1, 2, 3, 4, 5])
      expect(allGlobal.map((e) => e.runId)).toEqual(["run-1", "run-1", "run-1", "run-2", "run-2"])
    })

    it("reads global events with fromPosition and limit pagination", () => {
      const page = store.readGlobal({ fromPosition: 3, limit: 2 })
      expect(page).toHaveLength(2)
      expect(page.map((e) => e.globalPosition)).toEqual([3, 4])
      expect(page.map((e) => e.eventId)).toEqual(["ev-r1-3", "ev-r2-1"])
    })
  })

  describe("Unsupported future schema version fail-closed behavior", () => {
    it("fails closed when opening database with higher schema version", () => {
      const testPath = join(tmpdir(), `test-future-schema-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
      tempFiles.push(testPath)

      const d = createSqliteDriver(testPath)
      try {
        new SqliteEventStore(d)

        // Inject future version into schema_migrations
        const futureVersion = CURRENT_SCHEMA_VERSION + 1
        d.run(
          "INSERT INTO schema_migrations (version, applied_at, name) VALUES (?, ?, ?)",
          futureVersion,
          new Date().toISOString(),
          "unsupported_future_migration"
        )
      } finally {
        d.close()
      }

      // Reopening the database with the current version code must fail closed
      const reopenDriver = createSqliteDriver(testPath)
      try {
        expect(() => {
          new SqliteEventStore(reopenDriver)
        }).toThrow(UnsupportedSchemaVersionError)

        try {
          new SqliteEventStore(reopenDriver)
        } catch (err: any) {
          expect(err).toBeInstanceOf(UnsupportedSchemaVersionError)
          expect(err.code).toBe("schema.unsupported_version")
          expect(err.dbVersion).toBe(CURRENT_SCHEMA_VERSION + 1)
          expect(err.supportedVersion).toBe(CURRENT_SCHEMA_VERSION)
          expect(err.toContractError().category).toBe("internal_failure")
        }
      } finally {
        reopenDriver.close()
      }
    })
  })

  describe("Database backup and recovery", () => {
    it("creates a consistent backup that can be opened, queried, and appended to", async () => {
      const dbPath = join(tmpdir(), `test-live-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
      const backupPath = join(tmpdir(), `test-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
      tempFiles.push(dbPath, backupPath)

      const liveDriver = createSqliteDriver(dbPath)
      const liveStore = new SqliteEventStore(liveDriver)

      try {
        const cmd1 = makeCommand({ commandId: "cmd-live-1" })
        const ev1 = makeEvent({ eventId: "ev-live-1", commandId: cmd1.commandId })
        liveStore.append({ command: cmd1, events: [ev1] })

        const cmd2 = makeCommand({ commandId: "cmd-live-2" })
        const ev2 = makeEvent({ eventId: "ev-live-2", commandId: cmd2.commandId })
        liveStore.append({ command: cmd2, events: [ev2] })

        await liveStore.backup(backupPath)

        // Verify restored store from backup
        const restoredDriver = createSqliteDriver(backupPath)
        const restoredStore = new SqliteEventStore(restoredDriver)

        try {
          const head = restoredStore.getStreamHead("run-101")
          expect(head?.lastSequence).toBe(2)

          const events = restoredStore.readStream("run-101")
          expect(events).toHaveLength(2)
          expect(events[0].eventId).toBe("ev-live-1")
          expect(events[1].eventId).toBe("ev-live-2")

          const receipt = restoredStore.getCommandReceipt("project-alpha", "run-101", "cmd-live-1")
          expect(receipt).toBeDefined()

          // Append new event to the backup to verify writeability
          const cmd3 = makeCommand({ commandId: "cmd-backup-3" })
          const ev3 = makeEvent({ eventId: "ev-backup-3", commandId: cmd3.commandId })
          const appendRes = restoredStore.append({ command: cmd3, events: [ev3] })

          expect(appendRes.startSequence).toBe(3)
          expect(restoredStore.getStreamHead("run-101")?.lastSequence).toBe(3)
        } finally {
          restoredStore.close()
        }
      } finally {
        liveStore.close()
      }
    })
  })

  describe("Outbox records", () => {
    it("atomically commits outbox records with append and manages lifecycle", () => {
      const cmd = makeCommand({ commandId: "cmd-outbox" })
      const ev = makeEvent({ eventId: "ev-outbox", commandId: cmd.commandId })

      store.append({
        command: cmd,
        events: [ev],
        outboxRecords: [
          {
            outboxId: "out-1",
            destination: "worker-node-1",
            payload: { message: "dispatch task" },
          },
        ],
      })

      const pending = store.listPendingOutbox()
      expect(pending).toHaveLength(1)
      expect(pending[0].outboxId).toBe("out-1")
      expect(pending[0].destination).toBe("worker-node-1")
      expect(pending[0].status).toBe("pending")

      store.markOutboxAcknowledged("out-1")

      const updated = store.getOutboxRecord("out-1")
      expect(updated?.status).toBe("acknowledged")
      expect(updated?.acknowledgedAt).toBeDefined()
      expect(store.listPendingOutbox()).toHaveLength(0)
    })
  })

  describe("Snapshots", () => {
    it("saves and retrieves aggregate snapshots", () => {
      store.saveSnapshot({
        projectId: "project-alpha" as any,
        runId: "run-101" as any,
        aggregateType: "run",
        aggregateId: "run-101",
        sequence: 10,
        state: { state: "active", tasksCompleted: 3 },
        digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as any,
        createdAt: "2026-09-17T00:05:00.000Z" as any,
      })

      const snap = store.getSnapshot("project-alpha", "run-101", "run", "run-101")
      expect(snap).toBeDefined()
      expect(snap?.sequence).toBe(10)
      expect(snap?.state).toEqual({ state: "active", tasksCompleted: 3 })

      // Update snapshot at later sequence
      store.saveSnapshot({
        projectId: "project-alpha" as any,
        runId: "run-101" as any,
        aggregateType: "run",
        aggregateId: "run-101",
        sequence: 15,
        state: { state: "completed", tasksCompleted: 5 },
        digest: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" as any,
        createdAt: "2026-09-17T00:10:00.000Z" as any,
      })

      const updatedSnap = store.getSnapshot("project-alpha", "run-101", "run", "run-101")
      expect(updatedSnap?.sequence).toBe(15)
      expect(updatedSnap?.state).toEqual({ state: "completed", tasksCompleted: 5 })
    })
  })

  describe("Cross-project isolation", () => {
    it("rejects commands targeting an existing run under a different project ID", () => {
      const cmd1 = makeCommand({ commandId: "cmd-p1", projectId: "project-alpha", runId: "shared-run" })
      const ev1 = makeEvent({ eventId: "ev-p1", projectId: "project-alpha", runId: "shared-run", commandId: cmd1.commandId })
      store.append({ command: cmd1, events: [ev1] })

      const cmdForeign = makeCommand({ commandId: "cmd-p2", projectId: "project-beta", runId: "shared-run" })
      const evForeign = makeEvent({ eventId: "ev-p2", projectId: "project-beta", runId: "shared-run", commandId: cmdForeign.commandId })

      expect(() => {
        store.append({ command: cmdForeign, events: [evForeign] })
      }).toThrow(StreamProjectMismatchError)

      try {
        store.append({ command: cmdForeign, events: [evForeign] })
      } catch (err: any) {
        expect(err).toBeInstanceOf(StreamProjectMismatchError)
        expect(err.code).toBe("stream.project_mismatch")
        expect(err.runId).toBe("shared-run")
        expect(err.existingProjectId).toBe("project-alpha")
        expect(err.incomingProjectId).toBe("project-beta")
      }
    })
  })
})

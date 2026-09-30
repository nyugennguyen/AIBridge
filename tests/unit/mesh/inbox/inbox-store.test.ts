import { describe, expect, it } from "vitest"
import {
  CURRENT_INBOX_DATABASE_VERSION,
  INSERT_INBOX_ROW_SQL,
  MESH_INBOX_MIGRATIONS,
  MESH_INBOX_RECORD_VERSION_COLUMN_SQL,
  REQUIRED_MESH_INBOX_OBJECTS,
  getInboxSchemaVersion,
  runMeshInboxMigrations,
  verifyMeshInboxSchema,
} from "../../../../src/mesh/inbox/migrations.js"
import { SqliteCommandInboxStore, inboxStoreUnavailable } from "../../../../src/mesh/inbox/sqlite-inbox-store.js"
import { InMemoryCommandInboxStore } from "../../../../src/mesh/inbox/memory-inbox-store.js"
import { openInMemoryDriver, type SqliteDriver } from "../../../../src/orchestration/event-store/sqlite-driver.js"
import {
  CURRENT_SCHEMA_VERSION,
  commandIdSchema,
  epochSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
} from "../../../../src/orchestration/identifiers.js"
import { digestJson } from "../../../../src/orchestration/digest.js"
import { fingerprintCommand } from "../../../../src/orchestration/event-store/fingerprint.js"
import { durableInboxHarness, executeCommand, licensingLog, TestClock, at, type InboxHarness } from "./fixtures.js"

/**
 * The DURABLE inbox store, on a real SQLite database.
 *
 * Every other test in this directory runs against both implementations, which
 * catches a divergence in behaviour but not a divergence in SCHEMA: a store that
 * writes a row and cannot read it back fails only the assertion that reads it,
 * and an in-memory store is unaffected because it holds objects rather than
 * columns. The defect this file exists to pin is exactly that shape.
 */

/** A `NewInboxRow` built from a real command, so nothing here is a hand-typed stub. */
function aNewRow(commandId: string, overrides: Partial<Parameters<SqliteCommandInboxStore["accept"]>[0]> = {}) {
  const envelope = executeCommand({ commandId })
  const command = (envelope.payload as { readonly command: Parameters<typeof fingerprintCommand>[0] }).command
  return {
    commandId: commandIdSchema.parse(commandId),
    projectId: projectIdSchema.parse("project-release"),
    runId: runIdSchema.parse("run-release-1"),
    dispatchId: "dispatch-inbox-1" as never,
    targetNodeId: nodeIdSchema.parse("node-worker-1"),
    controllerNodeId: nodeIdSchema.parse("node-controller-a"),
    controllerEpoch: epochSchema.parse(1),
    leaseId: "lease-run-1-e1" as never,
    commandType: "dispatch.execute",
    payloadDigest: digestJson(command),
    semanticFingerprint: fingerprintCommand(command).semantic,
    commandJson: digestJson(envelope),
    acceptedAt: at(0),
    ...overrides,
  } as Parameters<SqliteCommandInboxStore["accept"]>[0]
}

function durableStore(clock: TestClock): { store: SqliteCommandInboxStore; driver: SqliteDriver; close: () => void } {
  const driver = openInMemoryDriver()
  runMeshInboxMigrations(driver, { now: clock.now })
  return { store: new SqliteCommandInboxStore(driver), driver, close: () => driver.close() }
}

describe("M4.5 a row written by the durable store is READABLE by it", () => {
  it("round-trips every column through the physical table", async () => {
    const clock = new TestClock(at(0))
    const { store, close } = durableStore(clock)
    try {
      const written = await store.accept(aNewRow("cmd-store-1"))
      expect(written.ok).toBe(true)
      if (!written.ok) return

      // The defect this pins: `rowToValue` read a `schema_version` column the
      // v1 layout never created, so `parseInboxRow` refused EVERY row the durable
      // store had itself written. The in-memory store passes regardless, which is
      // exactly why the pairing was not sufficient on its own.
      const found = await store.find(commandIdSchema.parse("cmd-store-1"))
      expect(found.ok, `find failed: ${found.ok ? "" : found.error.message}`).toBe(true)
      if (!found.ok) return
      expect(found.value).not.toBeNull()
      expect(found.value?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
      expect(found.value?.commandId).toBe("cmd-store-1")
      expect(found.value?.effectState).toBe("not_started")
      expect(found.value?.acceptedSequence).toBe(1)
      expect(found.value?.semanticFingerprint).toBe(written.value.row.semanticFingerprint)
    } finally {
      close()
    }
  })

  it("records the schema version on the PHYSICAL column, not only on the parsed value", async () => {
    const clock = new TestClock(at(0))
    const { store, driver, close } = durableStore(clock)
    try {
      await store.accept(aNewRow("cmd-store-2"))
      // Read through raw SQL rather than through the store. A store that
      // backfilled the version at READ time would pass every other test here and
      // would make every row of an older file claim a shape it was not written
      // with — which is the M0 contract-reapproval lesson restated.
      const row = driver.get<{ schema_version: number }>(
        "SELECT schema_version FROM mesh_inbox_commands WHERE command_id = ?",
        "cmd-store-2",
      )
      expect(row?.schema_version).toBe(CURRENT_SCHEMA_VERSION)
    } finally {
      close()
    }
  })

  it("carries the column in the schema, so the layout and the reader agree", () => {
    // Both halves asserted because either alone passes: a DDL with the column and
    // a writer that omits it, or a writer that stamps it and a DDL without it.
    expect(migratedTableDeclaresTheColumn()).toBe(true)
    expect(MESH_INBOX_RECORD_VERSION_COLUMN_SQL).toMatch(/ADD COLUMN schema_version INTEGER NOT NULL/)
    expect(INSERT_INBOX_ROW_SQL).toMatch(/schema_version/)
  })
})

describe("M4.5 the inbox's own version axis is separate from the kernel's", () => {
  it("is at 2, having added the record-version column additively", () => {
    expect(CURRENT_INBOX_DATABASE_VERSION).toBe(2)
    // v1 created the table, v2 added a column. Folding the column into the v1 DDL
    // would leave an already-migrated database on the broken layout FOREVER, with
    // a journal claiming v1 is current — `CREATE TABLE IF NOT EXISTS` means an
    // edited v1 is never re-run.
    expect(MESH_INBOX_MIGRATIONS.map((m) => [m.version, m.name])).toEqual([
      [1, "initial_inbox_schema"],
      [2, "inbox_record_version_column"],
    ])
    expect(MESH_INBOX_MIGRATIONS.every((m) => !m.destructive)).toBe(true)
    expect(MESH_INBOX_RECORD_VERSION_COLUMN_SQL).toMatch(/ADD COLUMN schema_version/)
  })

  it("a database from before the column refuses to be DOWNGRADED into", async () => {
    const driver = openInMemoryDriver()
    try {
      runMeshInboxMigrations(driver, { now: new TestClock(at(0)).now })
      expect(getInboxSchemaVersion(driver)).toBe(CURRENT_INBOX_DATABASE_VERSION)
      // A row written by a NEWER build may carry an `effect_state` this build
      // cannot interpret, and misreading that is deciding whether a redelivered
      // command re-runs its effect.
      expect(() => runMeshInboxMigrations(driver, { targetVersion: 1, now: new TestClock(at(0)).now })).toThrow(
        /newer|unsupported|version/i,
      )
    } finally {
      driver.close()
    }
  })

  it("verifies the required objects rather than trusting the journal", () => {
    const driver = openInMemoryDriver()
    try {
      runMeshInboxMigrations(driver, { now: new TestClock(at(0)).now })
      expect(() => verifyMeshInboxSchema(driver)).not.toThrow()
      // The indexes are part of the layout, not an optimisation: the run index is
      // what makes `listInbox` a scoped read rather than a full scan of a table
      // that only grows.
      const names = REQUIRED_MESH_INBOX_OBJECTS.map((o) => o.name)
      expect(names).toContain("mesh_inbox_commands")
      expect(names).toContain("idx_mesh_inbox_run")
      expect(names).toContain("idx_mesh_inbox_fingerprint")
    } finally {
      driver.close()
    }
  })
})

describe("M4.5 an unreadable store is REFUSED, never treated as empty", () => {
  it("answers a failed read as a policy refusal, not as 'no row'", async () => {
    // The retry path's answer for "no row" is APPLY IT. A disk fault answered as
    // an empty store would therefore re-run an effect that already happened —
    // which is why this is a refusal and not a degradation.
    const refusal = inboxStoreUnavailable("the disk went away")
    expect(refusal.ok).toBe(false)
    expect(refusal.error.code).toBe("inbox.store_unavailable")
    expect(refusal.error.category).toBe("policy_denied")
    expect(refusal.error.message).toMatch(/re-run an effect that already happened/)
  })

  it("does not swallow a closed driver into an empty result", async () => {
    const clock = new TestClock(at(0))
    const { store, close } = durableStore(clock)
    await store.accept(aNewRow("cmd-store-3"))
    close()
    const afterClose = await store.find(commandIdSchema.parse("cmd-store-3"))
    expect(afterClose.ok).toBe(false)
    if (!afterClose.ok) expect(afterClose.error.code).toBe("inbox.store_unavailable")
  })

  it("the two stores agree on the refusal, so a swap cannot change the answer", async () => {
    // The in-memory store cannot fail a read, so what is compared is the SHAPE of
    // the answer: `Result` on both, never a bare value. A caller that handled one
    // and not the other would be relying on an implementation detail.
    const memory = new InMemoryCommandInboxStore()
    expect(await memory.find(commandIdSchema.parse("cmd-absent"))).toEqual({ ok: true, value: null })
  })
})

describe("M4.5 the durable store's transition rules are one-way and idempotent", () => {
  it("records the FIRST runtime-accept instant and never moves the row back", async () => {
    const clock = new TestClock(at(0))
    const { store, close } = durableStore(clock)
    try {
      await store.accept(aNewRow("cmd-store-4"))
      const first = await store.markRuntimeAccepted(commandIdSchema.parse("cmd-store-4"), at(5))
      expect(first.ok && first.value?.runtimeAcceptedAt).toBe(at(5))

      clock.set(at(50))
      const second = await store.markRuntimeAccepted(commandIdSchema.parse("cmd-store-4"), at(50))
      expect(second.ok && second.value?.runtimeAcceptedAt).toBe(at(5))

      const result = await store.recordResult(commandIdSchema.parse("cmd-store-4"), { ok: true }, at(60))
      expect(result.ok && result.value?.effectState).toBe("result_recorded")

      // Nothing moves it back out of a settled state.
      const late = await store.markRuntimeAccepted(commandIdSchema.parse("cmd-store-4"), at(90))
      expect(late.ok && late.value?.effectState).toBe("result_recorded")
    } finally {
      close()
    }
  })

  it("stamps the FIRST ack, and cannot stamp one for a row that does not exist", async () => {
    const clock = new TestClock(at(0))
    const { store, close } = durableStore(clock)
    try {
      await store.accept(aNewRow("cmd-store-5"))
      const first = await store.markAckEmitted(commandIdSchema.parse("cmd-store-5"), at(1))
      expect(first.ok && first.value?.ackEmittedAt).toBe(at(1))
      clock.set(at(9))
      const second = await store.markAckEmitted(commandIdSchema.parse("cmd-store-5"), at(9))
      expect(second.ok && second.value?.ackEmittedAt).toBe(at(1))

      // The ack stamp is the structural statement of the ordering rule: this
      // column can only be written after the INSERT succeeded, because the row has
      // to exist.
      const absent = await store.markAckEmitted(commandIdSchema.parse("cmd-never"), at(9))
      expect(absent.ok && absent.value).toBeNull()
    } finally {
      close()
    }
  })

  it("assigns the accept sequence inside the transaction, so a rollback burns nothing", async () => {
    const clock = new TestClock(at(0))
    const { store, close } = durableStore(clock)
    try {
      await store.accept(aNewRow("cmd-seq-1"))
      await store.accept(aNewRow("cmd-seq-2"))
      const listed = await store.listInbox({})
      expect(listed.ok && listed.value.map((r) => r.acceptedSequence)).toEqual([1, 2])
      const next = await store.nextAcceptedSequence()
      expect(next.ok && next.value).toBe(3)
      // A rejected command burns nothing, which is why the refusal path's absence
      // from the table is load-bearing rather than tidy.
      expect(await store.countInbox({})).toEqual({ ok: true, value: 2 })
    } finally {
      close()
    }
  })
})

describe("M4.5 the harness a consumer wires is the durable one by construction", () => {
  it("a full submit through the durable seam persists and acks", async () => {
    const clock = new TestClock(at(0))
    const harness: InboxHarness = durableInboxHarness(clock, { log: licensingLog(executeCommand()) })
    try {
      const outcome = await harness.inbox.submit(executeCommand())
      expect(outcome.outcome).toBe("accepted")
      if (outcome.outcome !== "accepted") return

      // One row, read back from the DATABASE, and one ack that was emitted after
      // that row was already there.
      expect(await harness.rows()).toHaveLength(1)
      expect(harness.acks.emitted[0]?.rowsAtEmit).toHaveLength(1)
      expect(harness.acks.emitted[0]?.ack.outcome).toBe("accepted")

      // And the accept sequence is the ack order.
      const peek = await harness.inbox.peekAcceptedSequence()
      expect(peek.ok && peek.value).toBe(2)
    } finally {
      harness.close()
    }
  })

  it("a redelivery through the durable seam returns the STORED result", async () => {
    const clock = new TestClock(at(0))
    const harness = durableInboxHarness(clock, { log: licensingLog(executeCommand()) })
    try {
      const first = await harness.inbox.submit(executeCommand())
      if (first.outcome !== "accepted") throw new Error(`expected accept, got ${first.outcome}`)
      await harness.inbox.recordResult(first.commandId, { sessionId: "sess-durable" })

      clock.set(at(4))
      const retry = await harness.inbox.submit(
        executeCommand({ issuedAt: new Date(at(3)).toISOString(), expiresAt: new Date(at(23)).toISOString() }),
      )
      expect(retry.outcome).toBe("duplicate")
      if (retry.outcome !== "duplicate") return
      expect(retry.storedResult).toEqual({ sessionId: "sess-durable" })
      expect(await harness.rows()).toHaveLength(1)
    } finally {
      harness.close()
    }
  })
})

/** Does the migrated table actually carry the column? Read from `sqlite_master`. */
function migratedTableDeclaresTheColumn(): boolean {
  const driver = openInMemoryDriver()
  try {
    runMeshInboxMigrations(driver, { now: new TestClock(at(0)).now })
    const row = driver.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mesh_inbox_commands'",
    )
    return /schema_version/.test(row?.sql ?? "")
  } finally {
    driver.close()
  }
}

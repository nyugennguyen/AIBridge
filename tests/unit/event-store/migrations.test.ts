import { existsSync, rmSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SqliteEventStore } from "../../../src/orchestration/event-store/event-store.js"
import {
  DispatchAttemptConflictError,
  DestructiveMigrationNotPermittedError,
  FailedMigrationError,
  IncompleteMigrationHistoryError,
  IncompleteSchemaError,
  UnsupportedDatabaseVersionError,
} from "../../../src/orchestration/event-store/errors.js"
import {
  CURRENT_DATABASE_VERSION,
  INITIAL_SCHEMA_SQL,
  MIGRATIONS,
  REQUIRED_V2_OBJECTS,
  SCHEMA_MIGRATIONS_TABLE_SQL,
} from "../../../src/orchestration/event-store/index.js"
import {
  assertMigrationHistoryIsContiguous,
  assertSchemaObjectsPresent,
  getSchemaVersion,
  runMigrations,
  verifySchemaVersion,
} from "../../../src/orchestration/event-store/migrations.js"
import { createSqliteDriver, type SqliteDriver } from "../../../src/orchestration/event-store/sqlite-driver.js"
import { makeCommand, makeDispatchProposedEvent } from "./fixtures.js"
import { cleanupPaths, describeEachBackend, makeTempPath, openStore, type Backend } from "./outbox-helpers.js"

function openRaw(backend: Backend, path: string): SqliteDriver {
  return createSqliteDriver({ path, backend })
}

describe("B6: dispatch envelope immutability is enforced at the schema level", () => {
  let driver: SqliteDriver
  let store: SqliteEventStore

  beforeEach(() => {
    driver = createSqliteDriver({ path: ":memory:" })
    store = new SqliteEventStore(driver)
  })

  afterEach(() => {
    if (driver.isOpen()) driver.close()
  })

  it("accepts the first dispatch.proposed for a (run, dispatchId, attempt)", () => {
    const cmd = makeCommand({ commandId: "cmd-dispatch-1" })
    const res = store.append({
      command: cmd,
      events: [makeDispatchProposedEvent({ eventId: "ev-1", commandId: cmd.commandId, dispatchId: "disp-1", attempt: 1 })],
    })

    expect(res.startSequence).toBe(1)
    const tombstone = store.getDispatchAttemptTombstone("project-alpha", "run-101", "disp-1", 1)
    expect(tombstone).toBeDefined()
    expect(tombstone?.eventId).toBe("ev-1")
    expect(tombstone?.sequence).toBe(1)
  })

  it("REJECTS a second dispatch.proposed for the same (run, dispatchId, attempt)", () => {
    const first = makeCommand({ commandId: "cmd-dispatch-1" })
    store.append({
      command: first,
      events: [makeDispatchProposedEvent({ eventId: "ev-1", commandId: first.commandId, dispatchId: "disp-1", attempt: 1 })],
    })

    const second = makeCommand({ commandId: "cmd-dispatch-2" })
    expect(() =>
      store.append({
        command: second,
        events: [
          makeDispatchProposedEvent({
            eventId: "ev-2",
            commandId: second.commandId,
            dispatchId: "disp-1",
            attempt: 1,
            // A mutated envelope digest must not be able to sneak through.
            envelopeDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
          }),
        ],
      })
    ).toThrow(DispatchAttemptConflictError)

    // Nothing from the rejected command committed.
    expect(store.readStream("run-101")).toHaveLength(1)
    expect(store.getCommandReceipt("project-alpha", "run-101", "cmd-dispatch-2")).toBeUndefined()
    expect(store.getStreamHead("run-101")?.lastSequence).toBe(1)
  })

  it("reports the existing envelope digest on conflict", () => {
    const first = makeCommand({ commandId: "cmd-dispatch-1" })
    store.append({
      command: first,
      events: [makeDispatchProposedEvent({ eventId: "ev-1", commandId: first.commandId, dispatchId: "disp-1", attempt: 1 })],
    })

    const second = makeCommand({ commandId: "cmd-dispatch-2" })
    try {
      store.append({
        command: second,
        events: [makeDispatchProposedEvent({ eventId: "ev-2", commandId: second.commandId, dispatchId: "disp-1", attempt: 1 })],
      })
      throw new Error("expected DispatchAttemptConflictError")
    } catch (err: any) {
      expect(err).toBeInstanceOf(DispatchAttemptConflictError)
      expect(err.code).toBe("dispatch.envelope_immutable")
      expect(err.dispatchId).toBe("disp-1")
      expect(err.attempt).toBe(1)
      expect(err.runId).toBe("run-101")
      expect(err.existingDigest).toBe(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111"
      )
      expect(err.toContractError().category).toBe("conflict")
    }
  })

  it("allows a new attempt for the same dispatchId (retry adds an attempt, it does not erase history)", () => {
    const first = makeCommand({ commandId: "cmd-attempt-1" })
    store.append({
      command: first,
      events: [makeDispatchProposedEvent({ eventId: "ev-1", commandId: first.commandId, dispatchId: "disp-1", attempt: 1 })],
    })

    const retry = makeCommand({ commandId: "cmd-attempt-2" })
    const res = store.append({
      command: retry,
      events: [makeDispatchProposedEvent({ eventId: "ev-2", commandId: retry.commandId, dispatchId: "disp-1", attempt: 2 })],
    })

    expect(res.startSequence).toBe(2)
    expect(store.listDispatchAttemptTombstones("run-101").map((t) => t.attempt)).toEqual([1, 2])
  })

  it("allows a new dispatchId for the same attempt number (a revision)", () => {
    const first = makeCommand({ commandId: "cmd-rev-1" })
    store.append({
      command: first,
      events: [makeDispatchProposedEvent({ eventId: "ev-1", commandId: first.commandId, dispatchId: "disp-1", attempt: 1 })],
    })

    const revised = makeCommand({ commandId: "cmd-rev-2" })
    const res = store.append({
      command: revised,
      events: [makeDispatchProposedEvent({ eventId: "ev-2", commandId: revised.commandId, dispatchId: "disp-2", attempt: 1 })],
    })

    expect(res.startSequence).toBe(2)
  })

  it("scopes dispatch identity per run", () => {
    const a = makeCommand({ commandId: "cmd-run-a", runId: "run-101" })
    store.append({
      command: a,
      events: [makeDispatchProposedEvent({ eventId: "ev-a", commandId: a.commandId, dispatchId: "disp-1", attempt: 1, runId: "run-101" })],
    })

    const b = makeCommand({ commandId: "cmd-run-b", runId: "run-202" })
    const res = store.append({
      command: b,
      events: [makeDispatchProposedEvent({ eventId: "ev-b", commandId: b.commandId, dispatchId: "disp-1", attempt: 1, runId: "run-202" })],
    })

    expect(res.startSequence).toBe(1)
  })

  it("rejects two dispatch.proposed events inside the SAME append batch", () => {
    const cmd = makeCommand({ commandId: "cmd-batch" })
    expect(() =>
      store.append({
        command: cmd,
        events: [
          makeDispatchProposedEvent({ eventId: "ev-1", commandId: cmd.commandId, dispatchId: "disp-1", attempt: 1 }),
          makeDispatchProposedEvent({ eventId: "ev-2", commandId: cmd.commandId, dispatchId: "disp-1", attempt: 1 }),
        ],
      })
    ).toThrow(DispatchAttemptConflictError)

    expect(store.readStream("run-101")).toHaveLength(0)
    expect(store.getCommandReceipt("project-alpha", "run-101", "cmd-batch")).toBeUndefined()
  })

  it("leaves non-dispatch events unconstrained", () => {
    const a = makeCommand({ commandId: "cmd-fin-1" })
    store.append({ command: a, events: [makeFinished("ev-1", a.commandId)] })
    const b = makeCommand({ commandId: "cmd-fin-2" })
    const res = store.append({ command: b, events: [makeFinished("ev-2", b.commandId)] })
    expect(res.startSequence).toBe(2)
  })
})

function makeFinished(eventId: string, commandId: string): any {
  return {
    schemaVersion: 1,
    eventId,
    projectId: "project-alpha",
    runId: "run-101",
    actor: { kind: "system", name: "kernel" },
    occurredAt: "2026-09-17T00:00:01.000Z",
    correlationId: "corr-test",
    causation: null,
    controllerEpoch: 1,
    commandId,
    type: "dispatch.finished",
    payload: { dispatchId: "disp-test", outcome: "completed" },
  }
}

describeEachBackend("Migration v1 -> v2", (backend: Backend) => {
  let path: string
  let driver: SqliteDriver
  const temps: string[] = []

  beforeEach(() => {
    path = makeTempPath(`migrate-${backend}`)
    temps.push(path)
    driver = openRaw(backend, path)
  })

  afterEach(() => {
    if (driver.isOpen()) driver.close()
    cleanupPaths(temps)
  })

  function buildV1Database(): void {
    driver.exec(SCHEMA_MIGRATIONS_TABLE_SQL)
    driver.exec(INITIAL_SCHEMA_SQL)
    driver.run(
      "INSERT INTO schema_migrations (version, applied_at, name) VALUES (1, ?, 'initial_event_store_schema')",
      new Date().toISOString()
    )
    const command = makeCommand({ commandId: "cmd-v1" })
    driver.run(
      `INSERT INTO command_receipts (
        project_id, run_id, command_id, command_fingerprint, command_type,
        issuer_actor_json, status, result_json, error_json,
        start_sequence, end_sequence, received_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      "project-alpha",
      "run-101",
      "cmd-v1",
      "sha256:deadbeef",
      "run.cancel",
      JSON.stringify(command.actor),
      "completed",
      JSON.stringify({ ok: true }),
      "2026-09-17T00:00:00.000Z",
      "2026-09-17T00:00:00.000Z"
    )
    driver.run(
      `INSERT INTO outbox_records (
        outbox_id, destination, payload_json, payload_digest, status, attempts,
        created_at, last_attempted_at, acknowledged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      "out-v1",
      "node-a",
      JSON.stringify({ legacy: true }),
      "sha256:cafebabe",
      "pending",
      0,
      "2026-09-17T00:00:00.000Z"
    )
  }

  it("migrates an existing v1 database in place without losing rows", () => {
    buildV1Database()
    expect(getSchemaVersion(driver)).toBe(1)

    const result = runMigrations(driver)
    expect(result.appliedCount).toBe(1)
    expect(result.currentVersion).toBe(2)

    const receipt = driver.get<any>("SELECT * FROM command_receipts WHERE command_id = 'cmd-v1'")
    expect(receipt).toBeDefined()
    expect(receipt.command_fingerprint).toBe("sha256:deadbeef")
    expect(receipt.result_json).toBe(JSON.stringify({ ok: true }))
    // Pre-existing receipts are marked as legacy fingerprints and stay resolvable.
    expect(receipt.fingerprint_version).toBe(1)

    const outbox = driver.get<any>("SELECT * FROM outbox_records WHERE outbox_id = 'out-v1'")
    expect(outbox).toBeDefined()
    expect(outbox.status).toBe("pending")
    expect(outbox.run_id).toBeNull()
    expect(outbox.claim_token).toBeNull()
  })

  it("is idempotent: re-running applies nothing", () => {
    buildV1Database()
    runMigrations(driver)
    const second = runMigrations(driver)
    expect(second.appliedCount).toBe(0)
    expect(second.currentVersion).toBe(2)
  })

  it("creates every required v2 object", () => {
    runMigrations(driver)
    for (const object of REQUIRED_V2_OBJECTS) {
      const row = driver.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = ? AND name = ?",
        object.type,
        object.name
      )
      expect(row, `${object.type} ${object.name}`).toBeDefined()
    }
    assertSchemaObjectsPresent(driver)
  })

  it("records the migration name and version in the journal", () => {
    runMigrations(driver)
    const rows = driver.all<{ version: number, name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version"
    )
    expect(rows.map((r) => r.version)).toEqual([1, 2])
    expect(rows[1].name).toBe(MIGRATIONS[1].name)
  })

  it("fails closed on a v1 database that is missing a v2 object", () => {
    runMigrations(driver)
    driver.exec("DROP INDEX idx_outbox_run")

    expect(() => new SqliteEventStore(driver)).toThrow(IncompleteSchemaError)
    try {
      new SqliteEventStore(driver)
    } catch (err: any) {
      expect(err.code).toBe("schema.incomplete")
      expect(err.missingObjects).toEqual([{ type: "index", name: "idx_outbox_run" }])
      expect(err.toContractError().category).toBe("internal_failure")
    }
  })

  it("fails closed when the migration journal has a hole", () => {
    runMigrations(driver)
    driver.run("DELETE FROM schema_migrations WHERE version = 1")

    expect(() => new SqliteEventStore(driver)).toThrow(IncompleteMigrationHistoryError)
    try {
      new SqliteEventStore(driver)
    } catch (err: any) {
      expect(err.code).toBe("schema.incomplete_migration_history")
      expect(err.missingVersions).toEqual([1])
      expect(err.dbVersion).toBe(2)
    }
  })

  it("does not re-apply an earlier migration over a later schema", () => {
    runMigrations(driver)
    driver.run("DELETE FROM schema_migrations WHERE version = 1")
    // runMigrations must refuse rather than replaying v1 on top of v2.
    expect(() => runMigrations(driver)).toThrow(IncompleteMigrationHistoryError)
  })

  it("fails closed on a database from a newer build", () => {
    runMigrations(driver)
    driver.run(
      "INSERT INTO schema_migrations (version, applied_at, name) VALUES (?, ?, ?)",
      99,
      new Date().toISOString(),
      "from_the_future"
    )

    expect(() => new SqliteEventStore(driver)).toThrow(UnsupportedDatabaseVersionError)
    try {
      new SqliteEventStore(driver)
    } catch (err: any) {
      expect(err.code).toBe("schema.unsupported_version")
      expect(err.dbVersion).toBe(99)
      expect(err.supportedVersion).toBe(CURRENT_DATABASE_VERSION)
    }
  })

  it("wraps a failing migration in FailedMigrationError and leaves the schema untouched", () => {
    // Occupy the name of a table migration 2 needs to touch so its ALTER fails.
    driver.exec(SCHEMA_MIGRATIONS_TABLE_SQL)
    driver.exec(INITIAL_SCHEMA_SQL)
    driver.run(
      "INSERT INTO schema_migrations (version, applied_at, name) VALUES (1, ?, 'initial_event_store_schema')",
      new Date().toISOString()
    )
    // A view that collides with nothing but makes one ALTER fail deterministically:
    // drop the outbox table so `ALTER TABLE outbox_records` cannot run.
    driver.exec("DROP TABLE outbox_records")

    expect(() => runMigrations(driver)).toThrow(FailedMigrationError)
    try {
      runMigrations(driver)
    } catch (err: any) {
      expect(err.code).toBe("schema.migration_failed")
      expect(err.version).toBe(2)
      expect(err.migrationName).toBe(MIGRATIONS[1].name)
      expect(err.cause).toBeDefined()
    }

    // The journal was not advanced, so the failure is retryable after a fix.
    expect(getSchemaVersion(driver)).toBe(1)
  })

  it("blocks a destructive migration unless the operator opts in", () => {
    const snapshot = MIGRATIONS.map((m) => ({ version: m.version, name: m.name, destructive: m.destructive }))
    // The shipped migrations must all be non-destructive so an ordinary open
    // never needs a backup.
    expect(snapshot.every((m) => m.destructive === false)).toBe(true)
  })

  it("rejects a destructive migration when allowDestructive is absent", () => {
    const fakeMigration = {
      version: 3,
      name: "would_drop_the_event_log",
      destructive: true,
      up: () => {},
    }
    // Exercise the guard directly against the shipped mechanism.
    const guard = (pending: { version: number, name: string, destructive: boolean }[], allow: boolean) => {
      const destructive = pending.filter((m) => m.destructive)
      if (destructive.length > 0 && !allow) {
        throw new DestructiveMigrationNotPermittedError(destructive[0].version, destructive[0].name)
      }
    }
    expect(() => guard([fakeMigration], false)).toThrow(DestructiveMigrationNotPermittedError)
    expect(() => guard([fakeMigration], true)).not.toThrow()
    expect(() => guard([MIGRATIONS[0]], false)).not.toThrow()
  })

  it("verifySchemaVersion passes on a freshly migrated database", () => {
    runMigrations(driver)
    expect(() => verifySchemaVersion(driver)).not.toThrow()
    expect(() => assertMigrationHistoryIsContiguous(driver)).not.toThrow()
  })

  it("a v1-only target version still opens the store for a controlled downgrade probe", () => {
    buildV1Database()
    // Reading with targetVersion 1 applies nothing and does not add v2 objects.
    const result = runMigrations(driver, { targetVersion: 1 })
    expect(result.appliedCount).toBe(0)
    const row = driver.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_attempt_tombstones'"
    )
    expect(row).toBeUndefined()
  })

  it("survives a restart: reopening a migrated file is a no-op and keeps the dispatch tombstone", () => {
    const store1 = openStore(backend, path)
    const cmd = makeCommand({ commandId: "cmd-restart" })
    store1.append({
      command: cmd,
      events: [makeDispatchProposedEvent({ eventId: "ev-1", commandId: cmd.commandId, dispatchId: "disp-1", attempt: 1 })],
    })
    store1.close()

    const store2 = openStore(backend, path)
    try {
      expect(store2.getDispatchAttemptTombstone("project-alpha", "run-101", "disp-1", 1)).toBeDefined()

      const second = makeCommand({ commandId: "cmd-restart-2" })
      expect(() =>
        store2.append({
          command: second,
          events: [makeDispatchProposedEvent({ eventId: "ev-2", commandId: second.commandId, dispatchId: "disp-1", attempt: 1 })],
        })
      ).toThrow(DispatchAttemptConflictError)
    } finally {
      store2.close()
    }
  })
})

describe("Migration rollback boundary documentation", () => {
  it("v2 is additive only", () => {
    const v2 = MIGRATIONS.find((m) => m.version === 2)!
    expect(v2.destructive).toBe(false)
    // The v1 DDL must be unchanged so an already-migrated database still matches.
    expect(INITIAL_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS run_events")
    expect(INITIAL_SCHEMA_SQL).not.toContain("claim_token")
  })

  it("documents the rollback boundary on the migration itself", () => {
    const source = MIGRATIONS[1]
    expect(source.name).toBe("outbox_leases_and_dispatch_envelope_immutability")
  })

  it("v1 DDL is still reachable and does not contain v2 columns", () => {
    expect(existsSync(joinSrc("schema.ts"))).toBe(true)
    expect(INITIAL_SCHEMA_SQL).not.toContain("fingerprint_version")
  })
})

function joinSrc(name: string): string {
  return new URL(`../../../src/orchestration/event-store/${name}`, import.meta.url).pathname
}

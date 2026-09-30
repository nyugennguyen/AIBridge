import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FingerprintConflictError } from "../../../src/orchestration/event-store/errors.js"
import { SqliteEventStore } from "../../../src/orchestration/event-store/event-store.js"
import {
  CURRENT_COMMAND_FINGERPRINT_VERSION,
  NON_SEMANTIC_COMMAND_FIELDS,
  fingerprintCommand,
} from "../../../src/orchestration/event-store/fingerprint.js"
import {
  CURRENT_DATABASE_VERSION,
  INITIAL_SCHEMA_SQL,
  SCHEMA_MIGRATIONS_TABLE_SQL,
} from "../../../src/orchestration/event-store/schema.js"
import { openInMemoryDriver, type SqliteDriver } from "../../../src/orchestration/event-store/sqlite-driver.js"
import { makeCommand } from "./fixtures.js"

function makeEvent(options: { eventId: string, commandId: string, sequence?: number }): any {
  const event: any = {
    schemaVersion: 1,
    eventId: options.eventId,
    projectId: "project-alpha",
    runId: "run-101",
    actor: { kind: "system", name: "kernel" },
    occurredAt: "2026-09-17T00:00:01.000Z",
    correlationId: "corr-test",
    causation: null,
    controllerEpoch: 1,
    commandId: options.commandId,
    type: "dispatch.finished",
    payload: { dispatchId: "disp-test", outcome: "completed", summary: "done" },
  }
  if (options.sequence !== undefined) event.sequence = options.sequence
  return event
}

describe("B8: duplicate-command idempotency across transport-envelope fields", () => {
  let driver: SqliteDriver
  let store: SqliteEventStore

  beforeEach(() => {
    driver = openInMemoryDriver()
    store = new SqliteEventStore(driver)
  })

  afterEach(() => {
    if (driver.isOpen()) driver.close()
  })

  it("excludes exactly commandId, issuedAt and expiresAt from the semantic fingerprint", () => {
    expect([...NON_SEMANTIC_COMMAND_FIELDS]).toEqual(["commandId", "issuedAt", "expiresAt"])
  })

  it("identical retry returns the original recorded result without appending events", () => {
    const cmd = makeCommand({ commandId: "cmd-idem" })
    const result = { ok: true, sessionId: "sess-1" }

    const first = store.append({
      command: cmd,
      events: [makeEvent({ eventId: "ev-1", commandId: cmd.commandId })],
      commandResult: result,
    })
    expect(first.duplicate).toBe(false)

    const retry = store.append({
      command: cmd,
      events: [makeEvent({ eventId: "ev-1", commandId: cmd.commandId })],
      commandResult: result,
    })

    expect(retry.duplicate).toBe(true)
    expect(retry.receipt.result).toEqual(result)
    expect(retry.receipt.startSequence).toBe(1)
    expect(retry.receipt.endSequence).toBe(1)
    expect(retry.events).toHaveLength(0)
    expect(store.readStream("run-101")).toHaveLength(1)
    expect(store.getStreamHead("run-101")?.lastSequence).toBe(1)
  })

  it("retry with a freshly generated issuedAt/expiresAt window is treated as a duplicate, not a conflict", () => {
    const cmd = makeCommand({
      commandId: "cmd-retry-window",
      issuedAt: "2026-09-17T00:00:00.000Z",
      expiresAt: "2026-09-17T00:10:00.000Z",
    })
    const result = { ok: true, launchId: "launch-1" }

    store.append({
      command: cmd,
      events: [makeEvent({ eventId: "ev-a", commandId: cmd.commandId })],
      commandResult: result,
    })

    // The client timed out and re-sent, regenerating the expiry window.
    const retried = makeCommand({
      commandId: "cmd-retry-window",
      issuedAt: "2026-09-17T00:03:17.412Z",
      expiresAt: "2026-09-17T00:13:17.412Z",
    })

    const res = store.append({
      command: retried,
      events: [makeEvent({ eventId: "ev-a", commandId: retried.commandId })],
      commandResult: result,
    })

    expect(res.duplicate).toBe(true)
    expect(res.receipt.result).toEqual(result)
    expect(store.readStream("run-101")).toHaveLength(1)
  })

  it("a brand new commandId with identical semantic content is NOT a duplicate (dispatch uniqueness must not be evaded)", () => {
    // ADR 0003: "A fresh command ID does not evade dispatch uniqueness". This
    // is the boundary of the B8 fix — the receipt is keyed on commandId, so a
    // new id is a new command and must be admitted normally.
    const original = makeCommand({ commandId: "cmd-original" })
    store.append({
      command: original,
      events: [makeEvent({ eventId: "ev-1", commandId: original.commandId })],
    })

    const fresh = makeCommand({ commandId: "cmd-fresh" })
    const res = store.append({
      command: fresh,
      events: [makeEvent({ eventId: "ev-2", commandId: fresh.commandId })],
    })

    expect(res.duplicate).toBe(false)
    expect(res.startSequence).toBe(2)
    expect(store.readStream("run-101")).toHaveLength(2)
  })

  describe("genuine content changes still conflict under a reused commandId", () => {
    const mutations: { label: string, build: () => any }[] = [
      {
        label: "payload mutated",
        build: () => makeCommand({ commandId: "cmd-mut", reason: "Completely different reason" }),
      },
      {
        label: "actor mutated",
        build: () =>
          makeCommand({ commandId: "cmd-mut", actor: { kind: "user", userId: "attacker" } }),
      },
      {
        label: "controller epoch mutated",
        build: () => makeCommand({ commandId: "cmd-mut", epoch: 2 }),
      },
      {
        label: "controller node mutated",
        build: () => makeCommand({ commandId: "cmd-mut", controllerNodeId: "node-other" }),
      },
      {
        label: "lease id mutated",
        build: () => makeCommand({ commandId: "cmd-mut", leaseId: "lease-other" }),
      },
      {
        label: "correlation id mutated",
        build: () => makeCommand({ commandId: "cmd-mut", correlationId: "corr-other" }),
      },
    ]

    for (const mutation of mutations) {
      it(`rejects a retry whose ${mutation.label}`, () => {
        const cmd = makeCommand({ commandId: "cmd-mut" })
        store.append({
          command: cmd,
          events: [makeEvent({ eventId: "ev-1", commandId: cmd.commandId })],
          commandResult: { ok: true },
        })

        const mutated = mutation.build()
        expect(fingerprintCommand(mutated).semantic).not.toBe(fingerprintCommand(cmd).semantic)

        expect(() =>
          store.append({
            command: mutated,
            events: [makeEvent({ eventId: "ev-2", commandId: "cmd-mut" })],
          })
        ).toThrow(FingerprintConflictError)

        // The original receipt survives untouched.
        const receipt = store.getCommandReceipt("project-alpha", "run-101", "cmd-mut")
        expect(receipt?.result).toEqual({ ok: true })
        expect(store.readStream("run-101")).toHaveLength(1)
      })
    }
  })

  it("a cross-scope reuse of the same commandId does not reach the fingerprint check", () => {
    // projectId/runId are part of the receipt key, so a foreign-scope reuse
    // simply does not collide with the original receipt.
    const cmd = makeCommand({ commandId: "cmd-shared", runId: "run-101" })
    store.append({ command: cmd, events: [makeEvent({ eventId: "ev-1", commandId: "cmd-shared" })] })

    const other = makeCommand({ commandId: "cmd-shared", runId: "run-202" })
    const res = store.append({
      command: other,
      events: [{ ...makeEvent({ eventId: "ev-2", commandId: "cmd-shared" }), runId: "run-202" }],
    })

    expect(res.duplicate).toBe(false)
    expect(res.startSequence).toBe(1)
  })

  it("stores the semantic fingerprint with the current fingerprint version", () => {
    const cmd = makeCommand({ commandId: "cmd-version" })
    const res = store.append({ command: cmd, events: [makeEvent({ eventId: "ev-1", commandId: "cmd-version" })] })

    expect(res.receipt.commandFingerprint).toBe(fingerprintCommand(cmd).semantic)
    const row = driver.get<{ fingerprint_version: number, command_fingerprint: string }>(
      "SELECT fingerprint_version, command_fingerprint FROM command_receipts WHERE command_id = ?",
      "cmd-version"
    )
    expect(row?.fingerprint_version).toBe(CURRENT_COMMAND_FINGERPRINT_VERSION)
    expect(row?.command_fingerprint).not.toBe(fingerprintCommand(cmd).legacy)
  })

  it("still resolves legacy v1 whole-command receipts written before migration 2", () => {
    // A v1 database stored digestJson(wholeCommand). An exact resend of that
    // same command must still be recognised as a duplicate.
    const legacyDriver = openInMemoryDriver()
    legacyDriver.exec(SCHEMA_MIGRATIONS_TABLE_SQL)
    legacyDriver.exec(INITIAL_SCHEMA_SQL)
    legacyDriver.run(
      "INSERT INTO schema_migrations (version, applied_at, name) VALUES (1, ?, 'initial_event_store_schema')",
      new Date().toISOString()
    )

    const legacyStore = new SqliteEventStore(legacyDriver)

    const cmd = makeCommand({ commandId: "cmd-legacy" })
    const { legacy } = fingerprintCommand(cmd)
    legacyDriver.run(
      `INSERT INTO command_receipts (
        project_id, run_id, command_id, command_fingerprint, command_type,
        issuer_actor_json, status, result_json, error_json,
        start_sequence, end_sequence, received_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      "project-alpha",
      "run-101",
      "cmd-legacy",
      legacy,
      "run.cancel",
      JSON.stringify(cmd.actor),
      "completed",
      JSON.stringify({ ok: true, from: "v1" }),
      "2026-09-17T00:00:00.000Z",
      "2026-09-17T00:00:00.000Z"
    )

    const res = legacyStore.append({
      command: cmd,
      events: [makeEvent({ eventId: "ev-1", commandId: "cmd-legacy" })],
    })

    expect(res.duplicate).toBe(true)
    expect(res.receipt.result).toEqual({ ok: true, from: "v1" })

    // A migrated v1 database is now at v2 and the pre-existing receipt keeps
    // resolving as a duplicate rather than becoming a false conflict.
    legacyDriver.close()
  })

  it("rejects a legacy-fingerprint commandId reused with different content", () => {
    const legacyDriver = openInMemoryDriver()
    legacyDriver.exec(SCHEMA_MIGRATIONS_TABLE_SQL)
    legacyDriver.exec(INITIAL_SCHEMA_SQL)
    legacyDriver.run(
      "INSERT INTO schema_migrations (version, applied_at, name) VALUES (1, ?, 'initial_event_store_schema')",
      new Date().toISOString()
    )
    const legacyStore = new SqliteEventStore(legacyDriver)

    const original = makeCommand({ commandId: "cmd-legacy-2", reason: "Original" })
    legacyDriver.run(
      `INSERT INTO command_receipts (
        project_id, run_id, command_id, command_fingerprint, command_type,
        issuer_actor_json, status, result_json, error_json,
        start_sequence, end_sequence, received_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      "project-alpha",
      "run-101",
      "cmd-legacy-2",
      fingerprintCommand(original).legacy,
      "run.cancel",
      JSON.stringify(original.actor),
      "completed",
      JSON.stringify({ ok: true }),
      "2026-09-17T00:00:00.000Z",
      "2026-09-17T00:00:00.000Z"
    )

    const mutated = makeCommand({ commandId: "cmd-legacy-2", reason: "Mutated" })
    expect(() =>
      legacyStore.append({ command: mutated, events: [makeEvent({ eventId: "ev-1", commandId: "cmd-legacy-2" })] })
    ).toThrow(FingerprintConflictError)

    legacyDriver.close()
  })

  it("current schema version is 2", () => {
    expect(CURRENT_DATABASE_VERSION).toBe(2)
    const row = driver.get<{ max_version: number }>("SELECT MAX(version) as max_version FROM schema_migrations")
    expect(row?.max_version).toBe(2)
  })
})

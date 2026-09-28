/**
 * Cross-backend parity runner.
 *
 * Executed two ways:
 *  - in-process, when the requested SQLite driver is loadable in the current
 *    runtime (bun test -> bun:sqlite, vitest/node -> node:sqlite);
 *  - as a child process, when it is not (so a bun run can still prove
 *    `node:sqlite`, and a node run can still prove `bun:sqlite`).
 *
 * It exercises the SQL semantics that the two backends could plausibly differ
 * on: multi-row UPDATE with an IN list, `changes` reporting, `lastInsertRowid`,
 * partial/expression UNIQUE indexes, ALTER TABLE ADD COLUMN on a populated
 * table, `sqlite_master` introspection, savepoint nesting, and BEGIN IMMEDIATE
 * write serialisation between two connections.
 *
 * Prints a single JSON verdict on stdout. Exit code 0 means parity held.
 */
import { createSqliteDriver, type SqliteDriver } from "../../../src/orchestration/event-store/sqlite-driver.js"
import { OutboxStore } from "../../../src/orchestration/event-store/outbox-store.js"
import { SqliteEventStore } from "../../../src/orchestration/event-store/event-store.js"
import { getSchemaVersion, runMigrations } from "../../../src/orchestration/event-store/migrations.js"
import { makeCommand } from "./fixtures.js"

interface Check {
  name: string
  ok: boolean
  detail?: string
}

const checks: Check[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    checks.push({ name, ok: true })
  } catch (err) {
    checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) })
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`)
}

const backend = (process.argv[2] ?? "auto") as "node" | "bun" | "auto"
const resolved: "node" | "bun" =
  backend === "auto" ? (typeof (globalThis as any).Bun !== "undefined" ? "bun" : "node") : backend

const T0 = "2026-09-17T00:00:00.000Z" as any
const T30 = "2026-09-17T00:00:30.000Z" as any
const T31 = "2026-09-17T00:00:31.000Z" as any
const T5M = "2026-09-17T00:05:00.000Z" as any

// --- Driver level -----------------------------------------------------------

const memDriver: SqliteDriver = createSqliteDriver({ path: ":memory:", backend: resolved })

check("journal_mode is wal on a file database", () => {
  const path = `/tmp/aibridge-parity-${resolved}-${process.pid}.db`
  const fileDriver = createSqliteDriver({ path, backend: resolved })
  try {
    const mode = fileDriver.get<{ journal_mode: string }>("PRAGMA journal_mode")
    assertEqual(mode?.journal_mode.toLowerCase(), "wal", "journal_mode")
  } finally {
    fileDriver.close()
  }
})

check("run().changes counts matched rows for a multi-row UPDATE ... IN (...)", () => {
  memDriver.exec("CREATE TABLE p (id TEXT PRIMARY KEY, n INTEGER NOT NULL, tok TEXT)")
  for (const id of ["a", "b", "c", "d"]) {
    memDriver.run("INSERT INTO p (id, n, tok) VALUES (?, ?, ?)", id, 0, null)
  }
  const res = memDriver.run(
    "UPDATE p SET n = n + 1, tok = ? WHERE n = 0 AND id IN (?, ?, ?)",
    "claim-token",
    "a",
    "b",
    "d"
  )
  assertEqual(res.changes, 3, "changes for a 3-element IN list")
  const rows = memDriver.all<{ id: string, n: number, tok: string | null }>(
    "SELECT id, n, tok FROM p ORDER BY id"
  )
  assertEqual(rows.map((r) => r.n), [1, 1, 0, 1], "incremented rows")
  assertEqual(rows.map((r) => r.tok), ["claim-token", "claim-token", null, "claim-token"], "tokens")
})

check("run().changes is 0 (not negative) when nothing matches", () => {
  const res = memDriver.run("UPDATE p SET n = n WHERE id = 'does-not-exist'")
  assertEqual(res.changes, 0, "changes for a no-op UPDATE")
})

check("lastInsertRowid is a number for AUTOINCREMENT inserts", () => {
  const res = memDriver.run("INSERT INTO p (id, n) VALUES (?, ?)", "rowid-test", 5)
  assert(typeof res.lastInsertRowid === "number" || typeof res.lastInsertRowid === "bigint", "lastInsertRowid type")
  assert(Number(res.lastInsertRowid) > 0, "lastInsertRowid is positive")
})

check("partial UNIQUE index (WHERE ...) is enforced and ignores NULL keys", () => {
  memDriver.exec("CREATE TABLE u (a TEXT, b TEXT, c TEXT)")
  memDriver.run("CREATE UNIQUE INDEX u_key ON u (a, b, c) WHERE a IS NOT NULL")
  memDriver.run("INSERT INTO u (a, b, c) VALUES (NULL, 'x', 'y')")
  memDriver.run("INSERT INTO u (a, b, c) VALUES (NULL, 'x', 'y')")
  let threw = false
  try {
    memDriver.run("INSERT INTO u (a, b, c) VALUES ('k', 'x', 'y')")
    memDriver.run("INSERT INTO u (a, b, c) VALUES ('k', 'x', 'y')")
  } catch {
    threw = true
  }
  assert(threw, "duplicate non-NULL key must violate the partial unique index")
})

check("UNIQUE constraint error message is stable", () => {
  let message = ""
  try {
    memDriver.run("INSERT INTO u (a, b, c) VALUES ('k2', 'x', 'y')")
    memDriver.run("INSERT INTO u (a, b, c) VALUES ('k2', 'x', 'y')")
  } catch (err: any) {
    message = String(err?.message ?? "")
  }
  assert(message.includes("UNIQUE constraint failed"), `expected a UNIQUE error, got: ${message}`)
})

check("ALTER TABLE ADD COLUMN on a populated table preserves existing rows", () => {
  memDriver.exec("CREATE TABLE alt (id TEXT PRIMARY KEY, v INTEGER)")
  for (const id of ["1", "2", "3"]) memDriver.run("INSERT INTO alt (id, v) VALUES (?, ?)", id, 1)
  memDriver.exec("ALTER TABLE alt ADD COLUMN note TEXT")
  const rows = memDriver.all<{ id: string, v: number, note: string | null }>("SELECT * FROM alt ORDER BY id")
  assertEqual(rows.length, 3, "row count after ALTER")
  assertEqual(rows.every((r) => r.note === null), true, "new column defaults to NULL")
})

check("ALTER TABLE ADD COLUMN with NOT NULL DEFAULT backfills existing rows", () => {
  memDriver.exec("CREATE TABLE alt2 (id TEXT PRIMARY KEY)")
  memDriver.run("INSERT INTO alt2 (id) VALUES ('a')")
  memDriver.run("INSERT INTO alt2 (id) VALUES ('b')")
  memDriver.exec("ALTER TABLE alt2 ADD COLUMN fpv INTEGER NOT NULL DEFAULT 1")
  const rows = memDriver.all<{ fpv: number }>("SELECT fpv FROM alt2")
  assertEqual(rows.map((r) => r.fpv), [1, 1], "backfilled default")
})

check("sqlite_master exposes tables and indexes by type", () => {
  const tables = memDriver.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
  const indexes = memDriver.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
  assert(tables.some((r) => r.name === "p"), "table p is listed")
  assert(indexes.some((r) => r.name === "u_key"), "index u_key is listed")
})

check("nested savepoints roll back independently", () => {
  memDriver.exec("CREATE TABLE sp (id TEXT PRIMARY KEY)")
  memDriver.transaction(() => {
    memDriver.run("INSERT INTO sp (id) VALUES ('outer')")
    try {
      memDriver.transaction(() => {
        memDriver.run("INSERT INTO sp (id) VALUES ('inner')")
        throw new Error("inner abort")
      })
    } catch {
      /* expected */
    }
    memDriver.run("INSERT INTO sp (id) VALUES ('outer-2')")
  })
  const ids = memDriver.all<{ id: string }>("SELECT id FROM sp ORDER BY id").map((r) => r.id)
  assertEqual(ids, ["outer", "outer-2"], "inner savepoint rolled back, outer committed")
})

check("ISO-8601 timestamps round-trip through TEXT comparison unchanged", () => {
  memDriver.exec("CREATE TABLE ts (t TEXT)")
  for (const t of [T0, T30, T31, T5M]) memDriver.run("INSERT INTO ts (t) VALUES (?)", t)
  const ordered = memDriver.all<{ t: string }>("SELECT t FROM ts WHERE t > ? ORDER BY t", T30).map((r) => r.t)
  assertEqual(ordered, [T31, T5M], "lexicographic ISO comparison")
})

// --- Store level ------------------------------------------------------------

check("migrations reach v2 and expose every required object", () => {
  const path = `/tmp/aibridge-parity-store-${resolved}-${process.pid}.db`
  const store = new SqliteEventStore(createSqliteDriver({ path, backend: resolved }))
  try {
    assertEqual(getSchemaVersion(store.driver), 2, "schema version")
    const names = store.driver
      .all<{ name: string }>("SELECT name FROM sqlite_master")
      .map((r) => r.name)
    for (const required of [
      "dispatch_attempt_tombstones",
      "idx_outbox_claim",
      "idx_outbox_run",
      "idx_outbox_destination",
      "idx_outbox_command_destination",
      "idx_command_receipts_fingerprint",
    ]) {
      assert(names.includes(required), `missing ${required}`)
    }
  } finally {
    store.close()
  }
})

check("outbox claim increments attempts exactly once per claim", () => {
  const path = `/tmp/aibridge-parity-claim-${resolved}-${process.pid}.db`
  const store = new SqliteEventStore(createSqliteDriver({ path, backend: resolved }))
  try {
    const command = makeCommand({ commandId: "cmd-parity" })
    store.append({
      command,
      events: [],
      outboxRecords: [
        { outboxId: "p-1", destination: "node-a", payload: { a: 1 } },
        { outboxId: "p-2", destination: "node-b", payload: { a: 2 } },
      ],
    })

    const first = store.claimPendingOutbox({ now: T0, leaseMs: 30_000 })
    assertEqual(first.records.length, 2, "first claim size")
    assertEqual(first.records.map((r) => r.attempts), [1, 1], "attempts after first claim")
    assertEqual(first.records.map((r) => r.status), ["sending", "sending"], "status after claim")
    assertEqual(first.leaseExpiresAt, T30, "lease expiry")

    const second = store.claimPendingOutbox({ now: T0, leaseMs: 30_000 })
    assertEqual(second.records.length, 0, "second claim is empty")

    const recovered = store.recoverStaleOutbox({ now: T31 })
    assertEqual(recovered.recovered.length, 2, "recovered count")
    assertEqual(recovered.requeuedCount, 2, "requeued count")
    assertEqual(store.getOutboxRecord("p-1")?.attempts, 1, "attempts are not reset by recovery")
  } finally {
    store.close()
  }
})

check("two connections to one file partition the claim set", () => {
  const path = `/tmp/aibridge-parity-race-${resolved}-${process.pid}.db`
  const a = new SqliteEventStore(createSqliteDriver({ path, backend: resolved }))
  const b = new SqliteEventStore(createSqliteDriver({ path, backend: resolved }))
  try {
    for (let i = 0; i < 10; i++) {
      const command = makeCommand({ commandId: `cmd-race-${i}` })
      a.append({
        command,
        events: [],
        outboxRecords: [{ outboxId: `race-${i}`, destination: "node-a", payload: { i } }],
      })
    }

    const ca = a.claimPendingOutbox({ now: T0, leaseMs: 30_000, limit: 5 })
    const cb = b.claimPendingOutbox({ now: T0, leaseMs: 30_000, limit: 5 })
    const ids = [...ca.records, ...cb.records].map((r) => r.outboxId)
    assertEqual(ids.length, 10, "total claimed")
    assertEqual(new Set(ids).size, 10, "no double claim")
    assertEqual(a.countOutbox({ status: "sending" }), 10, "all sending")
    assertEqual(a.countOutbox({ status: "pending" }), 0, "none pending")
  } finally {
    a.close()
    b.close()
  }
})

check("transaction rollback discards outbox writes made inside it", () => {
  const path = `/tmp/aibridge-parity-rollback-${resolved}-${process.pid}.db`
  const store = new SqliteEventStore(createSqliteDriver({ path, backend: resolved }))
  const outbox = new OutboxStore(store.driver)
  try {
    try {
      store.driver.transaction(() => {
        store.driver.run(
          `INSERT INTO outbox_records (outbox_id, destination, payload_json, payload_digest, status, attempts, created_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
          "rb-1",
          "node-a",
          "{}",
          "sha256:aa",
          T0
        )
        throw new Error("abort")
      })
    } catch {
      /* expected */
    }
    assertEqual(outbox.getOutboxRecord("rb-1"), undefined, "rolled back row must be gone")
  } finally {
    store.close()
  }
})

check("re-running migrations on an already-migrated file is a no-op", () => {
  const path = `/tmp/aibridge-parity-remigrate-${resolved}-${process.pid}.db`
  const store = new SqliteEventStore(createSqliteDriver({ path, backend: resolved }))
  try {
    const result = runMigrations(store.driver)
    assertEqual(result.appliedCount, 0, "appliedCount")
    assertEqual(result.currentVersion, 2, "currentVersion")
  } finally {
    store.close()
  }
})

memDriver.close()

const failed = checks.filter((c) => !c.ok)
const verdict = {
  backend: resolved,
  runtime: typeof (globalThis as any).Bun !== "undefined" ? "bun" : "node",
  total: checks.length,
  failed: failed.length,
  checks,
  ok: failed.length === 0,
}

process.stdout.write(`${JSON.stringify(verdict)}\n`)
process.exit(failed.length === 0 ? 0 : 1)

import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMigrations } from "../../../../src/orchestration/event-store/migrations.js"
import { createSqliteDriver, type SqliteDriver } from "../../../../src/orchestration/event-store/sqlite-driver.js"

/**
 * Durable-database helpers for the outbox tests.
 *
 * Every database here is a real SQLite file, never `:memory:`. The outbox's
 * durability IS the claim under test — "a record entered the outbox before
 * transmission", "a stranded claim is reclaimed after a restart" — and an
 * in-memory database cannot survive the process that made the claim, so it would
 * silently agree with any assertion.
 *
 * `:memory:` is used only where the test genuinely does not need the file to
 * outlive a restart, and those tests say so.
 */

export interface Database {
  readonly driver: SqliteDriver
  readonly path: string
  close(): void
  /** Drops the file and its WAL siblings. */
  remove(): void
}

let counter = 0

/**
 * A migrated kernel database at a FRESH path.
 *
 * The kernel's own migrations, not a mesh-specific schema: the outbox rows live
 * in the kernel's `outbox_records` table, because the dispatch coordinator's
 * effect records and a worker's `mesh.event` records are the same kind of thing
 * — a payload that must be transmitted and stays until it is acknowledged — and
 * a second table would be a second answer to "what is an unacknowledged
 * delivery".
 */
export function durable(label: string): Database {
  const path = join(tmpdir(), `aibridge-${label}-${process.pid}-${(counter += 1)}.db`)
  return open(path, { fresh: true })
}

/**
 * Reopens an EXISTING path, migrating only what is still missing.
 *
 * The asymmetry with {@link durable} is the whole point and it is easy to get
 * wrong: this does NOT clear the file. A restart assertion that reuses `durable`
 * opens a new empty database, every row "survives" vacuously, and the test passes
 * while proving nothing about durability.
 */
export function reopen(path: string): Database {
  return open(path, { fresh: false })
}

function open(path: string, options: { readonly fresh: boolean }): Database {
  if (options.fresh) removeFiles(path)
  const driver = createSqliteDriver({ path })
  runMigrations(driver)
  let closed = false
  return {
    driver,
    path,
    close: () => {
      if (closed) return
      closed = true
      driver.close()
    },
    remove: () => {
      if (!closed) {
        closed = true
        driver.close()
      }
      removeFiles(path)
    },
  }
}

export function removeFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${path}${suffix}`
    if (existsSync(target)) {
      try {
        rmSync(target, { force: true })
      } catch {
        // best effort; tmpdir is the OS's problem after this
      }
    }
  }
}

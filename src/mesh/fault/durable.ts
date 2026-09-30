/**
 * M4.9 — durable handles for a node's own databases.
 *
 * Every node in the harness owns REAL SQLite files, and that is the whole reason
 * a restart in this harness means anything. The M4.5 outbox tests already made the
 * argument in their own words: an in-memory store that survived a restart would
 * make every durability assertion vacuous, and one that did not survive would be
 * a cache. The same applies here, one level up — a "restarted" mesh node whose
 * inbox was a `Map` would prove nothing about a mesh node.
 *
 * ### Why the harness owns the files rather than each seam
 *
 * A production node opens its own databases at startup and closes them at
 * shutdown. A harness that wants to interrupt a node mid-operation has to be able
 * to close the handles from OUTSIDE the seam, because the seam is what crashed.
 * So the path and the driver lifecycle belong to the harness and the seams take a
 * `SqliteDriver` by injection — which is exactly how every one of them is already
 * built.
 */
import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMigrations } from "../../orchestration/event-store/migrations.js"
import { createSqliteDriver, type SqliteDriver } from "../../orchestration/event-store/sqlite-driver.js"
import { runMeshInboxMigrations } from "../../mesh/inbox/migrations.js"
import { runMeshLeaseMigrations } from "../../mesh/lease/migrations.js"
import { runMeshRegistryMigrations } from "../../mesh/registry/migrations.js"

export interface DurableNodeFiles {
  /** The kernel event store: commands, events, outbox rows, snapshots. */
  readonly kernelPath: string
  /** M4.5's command inbox. */
  readonly inboxPath: string
  /** M4.4's controller lease. */
  readonly leasePath: string
  /** M4.3's node registry. */
  readonly registryPath: string
}

let sequence = 0

/** A fresh set of paths. Distinct per node and per call, so two nodes never share a file. */
export function freshNodeFiles(label: string): DurableNodeFiles {
  const stamp = `${label}-${process.pid}-${(sequence += 1)}`
  return {
    kernelPath: join(tmpdir(), `aibridge-fault-kernel-${stamp}.db`),
    inboxPath: join(tmpdir(), `aibridge-fault-inbox-${stamp}.db`),
    leasePath: join(tmpdir(), `aibridge-fault-lease-${stamp}.db`),
    registryPath: join(tmpdir(), `aibridge-fault-registry-${stamp}.db`),
  }
}

export interface OpenDatabase {
  readonly driver: SqliteDriver
  readonly path: string
}

/**
 * The harness's own durable record of PEER events a node ingested.
 *
 * It exists because the kernel's `append` takes a COMMAND, and a `mesh.event`
 * arriving from a peer is not one: it is a report about a session, minted by the
 * worker, with no command of ours behind it. `MeshEventIngestor` is therefore
 * given a store that writes here, and the controller derives its stream window
 * and its "what did I ingest" answer from this table rather than from an array
 * that dies with the process.
 *
 * The alternative — a `MeshEvent[]` beside the seam — is what this replaced. It
 * reported pre-restart ingests as the current process's own, and it left the
 * gateway with no way to rebuild its positions, so a client resuming after a
 * restart was told `cursor_ahead` when it was reading the same stream.
 *
 * `global_position` is the identity the gateway's `position` is derived from, and
 * it is assigned by SQLite's autoincrement rather than by a counter held in
 * memory, so it survives a restart the same way a row does.
 */
export const PEER_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS fault_peer_events (
  global_position INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  source_node_id TEXT NOT NULL,
  local_sequence INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL
);
`

interface PeerEventRow {
  global_position: number
  event_id: string
  source_node_id: string
  local_sequence: number
  project_id: string
  run_id: string
  event_type: string
  event_json: string
}

/** Every peer event this node has ingested, oldest first. */
export function readPeerEvents(database: OpenDatabase): PeerEventRow[] {
  return database.driver.all<PeerEventRow>(
    "SELECT * FROM fault_peer_events ORDER BY global_position ASC",
  )
}

/**
 * Records a peer event, or returns the row already recorded under its id.
 *
 * `INSERT OR IGNORE` on the `event_id` unique index rather than a read-then-write,
 * so a redelivery after a restart is idempotent for the same reason it is
 * everywhere else in the mesh: the identity is in the index, not in a check the
 * caller could forget to make.
 */
export function writePeerEvent(database: OpenDatabase, event: {
  readonly eventId: string
  readonly sourceNodeId: string
  readonly localSequence: number
  readonly projectId: string
  readonly runId: string
  readonly eventType: string
  readonly eventJson: string
}): void {
  database.driver.run(
    `INSERT OR IGNORE INTO fault_peer_events (
       event_id, source_node_id, local_sequence, project_id, run_id, event_type, event_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    event.eventId,
    event.sourceNodeId,
    event.localSequence,
    event.projectId,
    event.runId,
    event.eventType,
    event.eventJson,
  )
}

/**
 * Opens one of a node's databases and migrates whatever is missing.
 *
 * `reopen` and NOT a fresh file, and the asymmetry is the entire point: a restart
 * assertion that reopens a FRESH path finds an empty database, every row
 * "survives" vacuously, and the test passes while proving nothing.
 */
export function openNodeDatabase(path: string, migrate: (driver: SqliteDriver) => void): OpenDatabase {
  const driver = createSqliteDriver({ path })
  migrate(driver)
  return { driver, path }
}

/**
 * A migrated KERNEL database: `outbox_records` and `snapshots` live here.
 *
 * The one opener in this file that takes no clock, and the asymmetry is
 * `runMigrations`'s: the kernel's schema statements are plain DDL, whereas the
 * inbox, lease and registry migrations each stamp rows with the instant they were
 * written. Accepting a `now` here and discarding it would have let a caller
 * believe the kernel log was time-stamped at open, which it is not.
 */
export function openKernelDatabase(path: string): OpenDatabase {
  return openNodeDatabase(path, (driver) => {
    runMigrations(driver)
    // The harness's own table, alongside the kernel's. Additive and separate so
    // nothing the kernel asserts about its own layout is touched by it, and so a
    // reader can tell at a glance which rows are peer reports and which are the
    // kernel's own decisions.
    driver.exec(PEER_EVENTS_TABLE_SQL)
  })
}

export function openInboxDatabase(path: string, now: () => number): OpenDatabase {
  return openNodeDatabase(path, (driver) => {
    runMeshInboxMigrations(driver, { now })
  })
}

export function openLeaseDatabase(path: string, now: () => number): OpenDatabase {
  return openNodeDatabase(path, (driver) => {
    runMeshLeaseMigrations(driver, { now })
  })
}

export function openRegistryDatabase(path: string, now: () => number): OpenDatabase {
  return openNodeDatabase(path, (driver) => {
    runMeshRegistryMigrations(driver, { now })
  })
}

/** Closes a set of databases. Called by a restart, and by a scenario's teardown. */
export function closeDatabases(databases: readonly OpenDatabase[]): void {
  for (const database of databases) {
    try {
      database.driver.close()
    } catch {
      // A closed handle is the state a restart wants; a driver that throws on a
      // second close must not stop the other handles from closing.
    }
  }
}

/** Drops the files and their WAL siblings. Teardown, not a restart. */
export function removeNodeFiles(files: DurableNodeFiles): void {
  for (const path of Object.values(files)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${path}${suffix}`
      if (!existsSync(target)) continue
      try {
        rmSync(target, { force: true })
      } catch {
        // tmpdir is the operating system's problem after the test ends.
      }
    }
  }
}

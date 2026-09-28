import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "vitest"
import { SqliteEventStore } from "../../../src/orchestration/event-store/event-store.js"
import { createSqliteDriver } from "../../../src/orchestration/event-store/sqlite-driver.js"
import { makeCommand } from "./fixtures.js"

export const BACKENDS = ["node", "bun"] as const
export type Backend = (typeof BACKENDS)[number]

/**
 * A backend is only exercised when its driver module actually loads in the
 * current runtime. Under vitest only `node:sqlite` is present; under `bun test`
 * both are. Skipping (rather than silently testing one) keeps the parity claim
 * honest.
 */
export function backendAvailable(backend: Backend): boolean {
  try {
    const driver = createSqliteDriver({ path: ":memory:", backend })
    driver.close()
    return true
  } catch {
    return false
  }
}

export function makeTempPath(label: string): string {
  return join(tmpdir(), `aibridge-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}

export function cleanupPaths(paths: readonly string[]): void {
  for (const path of paths) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${path}${suffix}`
      if (existsSync(target)) {
        try {
          rmSync(target, { force: true })
        } catch {
          // best effort
        }
      }
    }
  }
}

export function openStore(backend: Backend, path: string): SqliteEventStore {
  return new SqliteEventStore(createSqliteDriver({ path, backend }))
}

export interface OutboxSeed {
  readonly outboxId: string
  readonly destination: string
  readonly runId?: string
  readonly projectId?: string
  readonly payload?: unknown
  readonly createdAt?: string
}

/** Commits one outbox row per seed through the real append transaction. */
export function seedOutbox(store: SqliteEventStore, seeds: readonly OutboxSeed[]): void {
  for (const seed of seeds) {
    const command = makeCommand({
      commandId: `cmd-${seed.outboxId}`,
      ...(seed.runId !== undefined ? { runId: seed.runId } : {}),
      ...(seed.projectId !== undefined ? { projectId: seed.projectId } : {}),
    })
    store.append({
      command,
      events: [],
      outboxRecords: [
        {
          outboxId: seed.outboxId,
          destination: seed.destination,
          payload: seed.payload ?? { message: seed.outboxId },
          ...(seed.createdAt !== undefined ? { createdAt: seed.createdAt as any } : {}),
        },
      ],
    })
  }
}

/**
 * Runs `body` for every SQLite backend that is loadable in this runtime, so the
 * same assertions prove the UPDATE/transaction semantics on both `node:sqlite`
 * and `bun:sqlite`.
 */
export function describeEachBackend(name: string, body: (backend: Backend) => void): void {
  for (const backend of BACKENDS) {
    if (!backendAvailable(backend)) {
      describe.skip(`${name} [${backend} driver unavailable in this runtime]`, () => {
        it.skip("skipped because the driver cannot be loaded", () => {})
      })
      continue
    }
    describe(`${name} [${backend}]`, () => body(backend))
  }
}

// Fixed clock instants so lease expiry and backoff are deterministic.
// A claim taken at T0 with leaseMs=30_000 expires exactly at T30.
export const T0 = "2026-09-17T00:00:00.000Z" as any
export const T1 = "2026-09-17T00:00:01.000Z" as any
export const T2 = "2026-09-17T00:00:02.000Z" as any
export const T29 = "2026-09-17T00:00:29.000Z" as any
export const T30 = "2026-09-17T00:00:30.000Z" as any
export const T31 = "2026-09-17T00:00:31.000Z" as any
export const T60 = "2026-09-17T00:01:00.000Z" as any
export const T5M = "2026-09-17T00:05:00.000Z" as any
export const T10M = "2026-09-17T00:10:00.000Z" as any


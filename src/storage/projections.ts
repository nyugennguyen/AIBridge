/**
 * Projection rebuild tooling from immutable authoritative event store (M8.2).
 *
 * Invariant: Repair tooling must never rewrite, fabricate, or delete authoritative
 * events. Projections are derived views and may be safely rebuilt from the event log.
 */

import { SqliteEventStore } from "../orchestration/event-store/event-store.js"
import {
  createSqliteDriver,
  type SqliteDriver,
} from "../orchestration/event-store/sqlite-driver.js"
import { ProjectionEngine } from "../orchestration/projections/projection-engine.js"
import type { ProjectionRebuildRunResult, RebuildProjectionsResult } from "./types.js"

export async function rebuildAllProjections(
  storeOrDriverOrPath: SqliteEventStore | SqliteDriver | string,
): Promise<RebuildProjectionsResult> {
  let store: SqliteEventStore
  let shouldClose = false

  if (storeOrDriverOrPath instanceof SqliteEventStore) {
    store = storeOrDriverOrPath
  } else if (typeof storeOrDriverOrPath === "string") {
    const driver = createSqliteDriver({ path: storeOrDriverOrPath, create: false })
    store = new SqliteEventStore(driver)
    shouldClose = true
  } else {
    store = new SqliteEventStore(storeOrDriverOrPath)
  }

  try {
    const engine = new ProjectionEngine(store)
    const runRows = store.driver.all<{ run_id: string }>(
      "SELECT run_id FROM run_streams ORDER BY created_at ASC",
    )

    const results: ProjectionRebuildRunResult[] = []

    for (const { run_id } of runRows) {
      const state = await engine.rebuildRun(run_id, { updateCache: true })
      const verified = await engine.verifyReplayEquivalence(run_id)
      results.push({
        runId: run_id,
        eventsCount: state.lastAppliedSequence,
        verified,
      })
    }

    return {
      rebuiltRuns: results.length,
      runs: results,
    }
  } finally {
    if (shouldClose) {
      store.driver.close()
    }
  }
}

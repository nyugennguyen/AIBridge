import { canonicalJson } from "../digest.js"
import type { SqliteEventStore } from "../event-store/event-store.js"
import type { StoredRunEvent } from "../event-store/types.js"
import type { OrchestrationEvent } from "../types.js"
import { reduceEvent, stripUndefined } from "./reducer.js"
import type { RunProjectionState } from "./types.js"

export interface ProjectionEngineOptions {
  readonly store?: SqliteEventStore
}

export class ProjectionEngine {
  private readonly store?: SqliteEventStore
  private readonly projections = new Map<string, RunProjectionState>()

  constructor(options?: SqliteEventStore | ProjectionEngineOptions) {
    if (options && "driver" in options) {
      this.store = options
    } else if (options && "store" in options) {
      this.store = options.store
    }
  }

  getProjection(runId: string): RunProjectionState | undefined {
    return this.projections.get(runId)
  }

  hasProjection(runId: string): boolean {
    return this.projections.has(runId)
  }

  setProjection(runId: string, state: RunProjectionState): void {
    this.projections.set(runId, state)
  }

  clear(): void {
    this.projections.clear()
  }

  applyEvent(runId: string, event: StoredRunEvent | OrchestrationEvent): RunProjectionState {
    const current = this.projections.get(runId) ?? null
    const next = reduceEvent(current, event)
    this.projections.set(runId, next)
    return next
  }

  async rebuildRun(runId: string, options?: { updateCache?: boolean }): Promise<RunProjectionState> {
    if (!this.store) {
      throw new Error("SqliteEventStore is required to rebuild run projections")
    }

    const events = this.store.readStream(runId, { fromSequence: 1 })
    if (events.length === 0) {
      throw new Error(`No events found to rebuild projection for run ${runId}`)
    }

    let state: RunProjectionState | null = null
    for (const event of events) {
      state = reduceEvent(state, event)
    }

    if (!state) {
      throw new Error(`Failed to rebuild projection for run ${runId}`)
    }

    if (options?.updateCache) {
      this.projections.set(runId, state)
    }

    return state
  }

  async verifyReplayEquivalence(runId: string): Promise<boolean> {
    const incremental = this.projections.get(runId)
    if (!incremental) {
      throw new Error(`No incremental projection found for run ${runId}`)
    }

    const replayed = await this.rebuildRun(runId)

    if (incremental.stateDigest !== replayed.stateDigest) {
      throw new Error(
        `Replay equivalence failure for run ${runId}: incremental digest ${incremental.stateDigest} !== replayed digest ${replayed.stateDigest}`
      )
    }

    const incrementalCanonical = canonicalJson(stripUndefined(incremental))
    const replayedCanonical = canonicalJson(stripUndefined(replayed))
    if (incrementalCanonical !== replayedCanonical) {
      throw new Error(
        `Replay equivalence byte mismatch for run ${runId}: canonical JSON representations differ`
      )
    }

    return true
  }
}

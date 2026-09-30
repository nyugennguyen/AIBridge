/**
 * M4-B hook 7 — `EffectBoundary.duringProjectionUpdate` is invoked, injectable, and
 * is the ONLY hook this directory calls.
 *
 * Three assertions, and each is a different defect:
 *
 *   1. **It fires.** The hook was declared, typed and never invoked, which is the
 *      whole of the M4-B carry-forward for this milestone. A test that asserted the
 *      updater saves a snapshot would pass whether or not the hook exists.
 *   2. **It fires BEFORE the reduce.** A crash at the hook leaves the projection
 *      exactly as it was — a clean miss-and-replay. A crash after the reduce and
 *      before the snapshot write leaves the in-memory projection AHEAD of the
 *      persisted one, which is the case that needs a rebuild. Both are real; the
 *      first is cheaper, and a hook that fired afterwards could never reproduce it.
 *      The only way to see the difference is to read the projection from inside the
 *      hook, which is what the "before" test does.
 *   3. **The other seven hooks are never called.** The coordinator's boundary is one
 *      object with eight members, and a directory that widened its own type to the
 *      whole interface could reach any of them. Passing a full `EffectBoundary` and
 *      recording every call is the structural version of "and ONLY hook 7".
 *
 * Nothing sleeps. The clock is injected.
 */
import { describe, expect, it } from "vitest"
import {
  MeshProjectionUpdater,
  RUN_AGGREGATE_TYPE,
  type ProjectionUpdaterDependencies,
} from "../../../../../src/mesh/gateway/events/index.js"
import { ProjectionEngine } from "../../../../../src/orchestration/projections/projection-engine.js"
import { SqliteEventStore } from "../../../../../src/orchestration/event-store/event-store.js"
import type { EffectBoundary } from "../../../../../src/orchestration/coordinator/types.js"
import { revisedSameDispatchId } from "../../../orchestration/fixtures/recorded-events.js"
import { PROJECT, RUN, TestClock, aRunCreateCommand, aRunLog } from "../fixtures.js"

/** A boundary that records EVERY hook, so "only hook 7" is observable. */
class RecordingBoundary implements EffectBoundary {
  readonly calls: string[] = []
  /** The projection's sequence as the hook saw it, which is the "before" assertion. */
  readonly sequenceSeenInsideHook: number[] = []
  readonly #engine: ProjectionEngine
  readonly #runId: string

  constructor(engine: ProjectionEngine, runId: string) {
    this.#engine = engine
    this.#runId = runId
  }

  beforeValidate(): void {
    this.calls.push("beforeValidate")
  }
  afterValidate(): void {
    this.calls.push("afterValidate")
  }
  duringAppend(): void {
    this.calls.push("duringAppend")
  }
  afterCommit(): void {
    this.calls.push("afterCommit")
  }
  beforeDeliver(): void {
    this.calls.push("beforeDeliver")
  }
  afterRuntimeAccept(): void {
    this.calls.push("afterRuntimeAccept")
  }
  duringProjectionUpdate(): void {
    this.calls.push("duringProjectionUpdate")
    this.sequenceSeenInsideHook.push(this.#engine.getProjection(this.#runId)?.lastAppliedSequence ?? 0)
  }
  duringTranslation(): void {
    this.calls.push("duringTranslation")
  }
}

function aHarness(boundary: EffectBoundary) {
  const store = SqliteEventStore.createInMemory()
  const engine = new ProjectionEngine(store)
  const clock = new TestClock()
  const dependencies: ProjectionUpdaterDependencies = { engine, snapshots: store, boundary, now: clock.now }
  return { store, engine, clock, updater: new MeshProjectionUpdater(dependencies) }
}

describe("M4-B hook 7 fires, and it is injectable", () => {
  it("fires once per applied event, carrying that event", () => {
    const store = SqliteEventStore.createInMemory()
    const engine = new ProjectionEngine(store)
    const seen: string[] = []
    const updater = new MeshProjectionUpdater({
      engine,
      snapshots: store,
      now: new TestClock().now,
      boundary: { duringProjectionUpdate: (event) => seen.push(event.eventId) },
    })
    for (const [index, event] of revisedSameDispatchId().slice(0, 3).entries()) {
      updater.apply({ ...event, globalPosition: index + 1, event })
    }
    // The hook receives the KERNEL event, not the mesh wrapper and not the stored
    // row: a fault harness crashing at this boundary wants the domain event, because
    // the boundary is inside the projection update and nothing there knows about the
    // mesh.
    expect(seen).toEqual(revisedSameDispatchId().slice(0, 3).map((event) => event.eventId))
  })

  it("fires on the REBUILD path too, so a crash there is injectable as well", () => {
    const store = SqliteEventStore.createInMemory()
    const engine = new ProjectionEngine(store)
    const boundary = new RecordingBoundary(engine, RUN)
    const updater = new MeshProjectionUpdater({ engine, snapshots: store, now: new TestClock().now, boundary })
    // A rebuild reads the DURABLE log, so the log has to have something in it —
    // `rebuildFromLog` filters `readGlobal()` down to the scope and a store with no
    // rows would return `null` without reaching the hook at all.
    store.append({ command: aRunCreateCommand(), events: aRunLog() })
    expect(updater.rebuildFromLog({ projectId: PROJECT, runId: RUN })).not.toBeNull()
    // A rebuild that did not fire the hook would be a path M4.9's fault harness
    // cannot crash in, and the crash boundary it needs is the one that leaves the
    // projection half-advanced.
    expect(boundary.calls.filter((call) => call === "duringProjectionUpdate")).toHaveLength(3)
  })

  it("BEFORE the reduce: the hook sees the state as it was, not as it is about to be", () => {
    const store = SqliteEventStore.createInMemory()
    const engine = new ProjectionEngine(store)
    const boundary = new RecordingBoundary(engine, RUN)
    const updater = new MeshProjectionUpdater({ engine, snapshots: store, now: new TestClock().now, boundary })
    for (const [index, event] of revisedSameDispatchId().slice(0, 3).entries()) {
      updater.apply({ ...event, globalPosition: index + 1, event })
    }
    // 0, 1, 2 — each hook saw the sequence the projection was at BEFORE its own event.
    // A hook that fired after the reduce would see 1, 2, 3, and the crash window it
    // exists to reproduce (projection advanced, snapshot not yet written) would be
    // indistinguishable from a clean one.
    expect(boundary.sequenceSeenInsideHook).toEqual([0, 1, 2])
  })

  it("a crash at the hook leaves NO snapshot, which is the recoverable half", () => {
    const store = SqliteEventStore.createInMemory()
    const engine = new ProjectionEngine(store)
    const boundary = new RecordingBoundary(engine, RUN)
    const updater = new MeshProjectionUpdater({ engine, snapshots: store, now: new TestClock().now, boundary })
    // The crash is modelled by throwing from the hook, which is the whole point of
    // making it injectable rather than something a harness monkey-patches.
    boundary.duringProjectionUpdate = () => {
      throw new Error("crash injected at EffectBoundary.duringProjectionUpdate")
    }
    expect(() => updater.apply({ ...revisedSameDispatchId()[0]!, globalPosition: 1, event: revisedSameDispatchId()[0]! })).toThrow(
      /crash injected at EffectBoundary.duringProjectionUpdate/,
    )
    // Nothing was persisted and nothing was projected: a clean miss-and-replay.
    expect(store.getSnapshot(PROJECT, RUN, RUN_AGGREGATE_TYPE, RUN)).toBeUndefined()
    expect(engine.getProjection(RUN)).toBeUndefined()
  })

  it("a no-op apply still fires the hook, because the boundary is the PATH and not the effect", () => {
    // The alternative — firing only when the state advances — would make the hook
    // unreachable for exactly the redeliveries a mesh produces, and M4.9's harness
    // would never crash on one.
    const { updater, boundary } = aHarnessWithBoundary()
    const event = { ...revisedSameDispatchId()[0]!, globalPosition: 1, event: revisedSameDispatchId()[0]! }
    expect(updater.apply(event).saved).toBe(true)
    expect(updater.apply(event).saved).toBe(false)
    expect(boundary.calls.filter((call) => call === "duringProjectionUpdate")).toHaveLength(2)
  })

  it("the other SEVEN hooks are never called from this directory", () => {
    // The structural version of "and ONLY hook 7". A full `EffectBoundary` is passed
    // — the production type, not a narrowed one — so a future widening of
    // `ProjectionBoundary` to the whole interface is a failure here rather than a
    // thing a reviewer has to notice.
    const { updater, boundary } = aHarnessWithBoundary()
    for (const [index, event] of revisedSameDispatchId().entries()) {
      updater.apply({ ...event, globalPosition: index + 1, event })
    }
    updater.rebuildFromLog({ projectId: PROJECT, runId: RUN })
    expect([...new Set(boundary.calls)]).toEqual(["duringProjectionUpdate"])
    expect(boundary.calls).not.toContain("beforeValidate")
    expect(boundary.calls).not.toContain("afterValidate")
    expect(boundary.calls).not.toContain("duringAppend")
    expect(boundary.calls).not.toContain("afterCommit")
    // 5 and 6 belong to M4.5's deliverer, 8 to the legacy translation. Calling one of
    // them from here would mean two owners for the same crash boundary.
    expect(boundary.calls).not.toContain("beforeDeliver")
    expect(boundary.calls).not.toContain("afterRuntimeAccept")
    expect(boundary.calls).not.toContain("duringTranslation")
  })

  it("the updater works with NO boundary at all, because a boundary is optional", () => {
    const store = SqliteEventStore.createInMemory()
    const engine = new ProjectionEngine(store)
    const updater = new MeshProjectionUpdater({ engine, snapshots: store, now: new TestClock().now })
    expect(updater.apply({ ...revisedSameDispatchId()[0]!, globalPosition: 1, event: revisedSameDispatchId()[0]! }).saved).toBe(true)
  })
})

function aHarnessWithBoundary() {
  const store = SqliteEventStore.createInMemory()
  const engine = new ProjectionEngine(store)
  const boundary = new RecordingBoundary(engine, RUN)
  const updater = new MeshProjectionUpdater({ engine, snapshots: store, now: new TestClock().now, boundary })
  return { store, engine, updater, boundary }
}

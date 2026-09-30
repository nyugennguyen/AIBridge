/**
 * M4-S — the snapshot policy: a client that cannot resume from a cursor gets an
 * EXPLICIT re-base, never a silent gap.
 *
 * The load-bearing assertion in this file is not that a fallback is PRODUCED. It is
 * that a client can DETECT that it got one. A fallback that arrived as an ordinary
 * `mesh.event`, or as an extra field on one, would be invisible to a conforming
 * client — the `event:` name is the only thing a client is required to branch on —
 * and a client that ignored it would apply a snapshot over its own state and produce
 * a projection derived from a stream it never saw. So the detectability test reads
 * the BYTES and branches the way a client does.
 *
 * The second load-bearing assertion is the digest: the client recomputes
 * `computeStateDigest(state)` and compares it to `snapshotFallback.stateDigest`, and
 * a mismatch is a re-base it must refuse. Without that check the fallback is a
 * pointer to a state this node cannot vouch for, and "the client trusts the
 * controller's arithmetic" is a much weaker contract than M4-S needs.
 *
 * The third is R3. A same-`dispatchId` revision REPLACES the envelope, so the
 * superseded envelope is not rebuildable from a projection — and therefore the
 * policy must not promise per-attempt envelope history, in the response OR in any
 * type the response is built from.
 *
 * `saveSnapshot` / `getSnapshot` / `readGlobal` were implemented, tested and called
 * from nowhere before M4.6. Every test here drives a REAL `SqliteEventStore`, because
 * a Map would agree with any assertion and would not catch the two defects this
 * policy exists over: a digest that does not match the state, and a snapshot filed
 * under the wrong scope.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  RUN_AGGREGATE_TYPE,
  SSE_SNAPSHOT_EVENT_NAME,
  MeshProjectionUpdater,
  ProjectionSnapshotFallback,
  SSE_FRAME_NAMES,
  decodeFrames,
  encodeEventFrame,
  encodePreamble,
  encodeSnapshotFrame,
  type SnapshotRebase,
} from "../../../../../src/mesh/gateway/events/index.js"
import { computeStateDigest } from "../../../../../src/orchestration/projections/reducer.js"
import { ProjectionEngine } from "../../../../../src/orchestration/projections/projection-engine.js"
import type { RunProjectionState } from "../../../../../src/orchestration/projections/types.js"
import { SqliteEventStore } from "../../../../../src/orchestration/event-store/event-store.js"
import { revisedSameDispatchId } from "../../../orchestration/fixtures/recorded-events.js"
import { snapshotFallbackSchema } from "../../../../../src/mesh/protocol/reconciliation.js"
import { OTHER_RUN, PROJECT, RUN, TestClock, aRunCreateCommand, aRunLog, aStoredEvent, aMeshEvent } from "../fixtures.js"

const UPDATER_SOURCE = readFileSync(join(import.meta.dirname, "../../../../../src/mesh/gateway/events/projection-updater.ts"), "utf8")
const TYPES_SOURCE = readFileSync(join(import.meta.dirname, "../../../../../src/mesh/gateway/events/types.ts"), "utf8")
const PROJECTION_TYPES_SOURCE = readFileSync(
  join(import.meta.dirname, "../../../../../src/orchestration/projections/types.ts"),
  "utf8",
)

/**
 * The member names an interface DECLARES, read out of the source.
 *
 * A structural check rather than a list typed into the test, because the property
 * being defended is "the shape has no such member" and only the shape knows what its
 * members are. It reads the interface body between its braces, which is enough for
 * the flat interfaces this asserts against and deliberately not a TypeScript parser:
 * a test that could silently read the WRONG block would be worse than a test that
 * reads a narrow one, so the match is anchored on the declaration itself.
 */
function declaredMembers(source: string, interfaceName: string): string[] {
  const declaration = new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`)
  const body = declaration.exec(source)?.[1]
  if (body === undefined) throw new Error(`interface ${interfaceName} was not found in the source under test`)
  return [...body.matchAll(/^\s{2}readonly (\w+)[?:]/gm)].map((match) => match[1]!).sort()
}

/**
 * A source file's COMMENTS as one line of prose.
 *
 * The leading `*` of a JSDoc line is stripped before the whitespace is collapsed,
 * because `\\s+` does not match an asterisk: collapsing first would leave
 * "REPLACES the * envelope" and every prose assertion in this file would have to
 * know about comment syntax to say anything about the sentence.
 */
function prose(source: string): string {
  return source
    .replace(/\n\s*\*/g, "\n")
    .replace(/\s+/g, " ")
}

/** A writer, a reader and a real store, over the same kernel database. */
function aPolicyHarness(clock: TestClock = new TestClock()) {
  const store = SqliteEventStore.createInMemory()
  const engine = new ProjectionEngine(store)
  const updater = new MeshProjectionUpdater({ engine, snapshots: store, now: clock.now })
  const reader = new ProjectionSnapshotFallback(store)
  return { store, engine, updater, reader, clock }
}

describe("M4-S the fallback a client gets is one it can detect and check", () => {
  it("a re-base arrives on a DIFFERENT event: name, and that is the whole mechanism", () => {
    const rebase: SnapshotRebase = {
      snapshotFallback: { runId: RUN, lastAppliedSequence: 7, stateDigest: `sha256:${"b".repeat(64)}` as never },
      state: { marker: "rebase" },
    }
    const continuation = encodeEventFrame({
      position: 12,
      eventId: "evt-frame-1" as never,
      sourceNodeId: "node-worker-1" as never,
      localSequence: 1,
      projectId: PROJECT,
      runId: RUN,
      eventType: "dispatch.started",
      retainedFromMs: 0,
      payload: aMeshEvent({ eventId: "evt-frame-1", localSequence: 1 }),
    })

    const body = `${encodePreamble()}${encodeSnapshotFrame(rebase)}${continuation}`
    const frames = decodeFrames(body)

    // A conforming client switches on `event:`. Two names, and the re-base is on the
    // one it is required to recognise.
    expect(frames.map((frame) => frame.event)).toEqual([SSE_SNAPSHOT_EVENT_NAME, "mesh.event"])
    expect([...SSE_FRAME_NAMES]).toEqual(expect.arrayContaining(["mesh.event", SSE_SNAPSHOT_EVENT_NAME]))
    expect(SSE_SNAPSHOT_EVENT_NAME).toBe("mesh.reconciliation")

    // THE assertion a client makes. A client that reads the first frame and finds a
    // name it does not know is being re-based; it does not apply the second frame's
    // event over the state it had.
    const first = frames[0]
    expect(first?.event === SSE_SNAPSHOT_EVENT_NAME).toBe(true)
  })

  it("the re-base frame carries NO id, so a client is not told it consumed up to there", () => {
    // The second half of detectability, and it is a different defect. An `id:` on a
    // snapshot would tell the client that everything after that point is accounted
    // for — which is exactly the false claim the fallback exists to avoid, and it
    // would be false in the one case that matters.
    const rebase: SnapshotRebase = {
      snapshotFallback: { runId: RUN, lastAppliedSequence: 7, stateDigest: `sha256:${"c".repeat(64)}` as never },
      state: { marker: "rebase" },
    }
    const [frame] = decodeFrames(encodeSnapshotFrame(rebase))
    expect(frame?.id).toBeNull()
    // And a continuation DOES carry one, or the absence proves nothing.
    const continuation = decodeFrames(
      encodeEventFrame({
        position: 12,
        eventId: "evt-frame-2" as never,
        sourceNodeId: "node-worker-1" as never,
        localSequence: 1,
        projectId: PROJECT,
        runId: RUN,
        eventType: "dispatch.started",
        retainedFromMs: 0,
        payload: aMeshEvent({ eventId: "evt-frame-2", localSequence: 1 }),
      }),
    )
    expect(continuation[0]?.id).toBe("12")
  })

  it("the fallback payload is the PROTOCOL's shape, and validates with the protocol's own schema", () => {
    // Not a widening. `meshReconciliationResponseSchema` is `.strict()`, and a
    // `SnapshotRebase` folded into `snapshotFallbackSchema` would make this directory
    // a second definition of a wire field M4.1 froze.
    const parsed = snapshotFallbackSchema.safeParse({ runId: RUN, lastAppliedSequence: 41, stateDigest: `sha256:${"d".repeat(64)}` })
    expect(parsed.success).toBe(true)
    expect(Object.keys(snapshotFallbackSchema.shape).sort()).toEqual(["lastAppliedSequence", "runId", "stateDigest"])
    // The re-base is a SIBLING of the fallback, not a member of it.
    expect(parsed.data).not.toHaveProperty("state")
  })

  it("a client can verify the re-base: the state digests to the digest the fallback claims", async () => {
    const { store, engine, updater } = aPolicyHarness()
    for (let index = 1; index <= 3; index += 1) {
      updater.apply(aStoredEvent(aMeshEvent({ eventId: `evt-snap-${index}`, localSequence: index, runSequence: index })))
    }
    const rebase = await new ProjectionSnapshotFallback(store).fallbackFor({ projectId: PROJECT, runId: RUN })
    expect(rebase.ok).toBe(true)
    if (!rebase.ok || rebase.value === null) return

    // THE client's check, run exactly as a client would: the state minus its own
    // `stateDigest`, digested. `stateDigest` is removed because it is a function OF
    // the rest, and a digest that covered itself could never be reproduced.
    const { stateDigest: _recorded, ...domainState } = rebase.value.state as Record<string, unknown>
    void _recorded
    expect(computeStateDigest(domainState as never)).toBe(rebase.value.snapshotFallback.stateDigest)
    expect(engine.getProjection(RUN)?.lastAppliedSequence).toBe(3)
    expect(rebase.value.snapshotFallback.lastAppliedSequence).toBe(3)
  })

  it("REFUSES a snapshot whose stored digest does not match its stored state", async () => {
    // The defect this is here for: a row written by something this build does not
    // understand. Serving it would hand a client a re-base onto a state nobody can
    // vouch for, and the client would stop asking for the events it is missing.
    const { store, updater } = aPolicyHarness()
    updater.apply(aStoredEvent(aMeshEvent({ eventId: "evt-tamper-1", localSequence: 1, runSequence: 1 })))
    const good = store.getSnapshot(PROJECT, RUN, RUN_AGGREGATE_TYPE, RUN)
    expect(good).toBeDefined()
    store.saveSnapshot({ ...good!, digest: `sha256:${"e".repeat(64)}` as never, createdAt: good!.createdAt })

    const rebase = await new ProjectionSnapshotFallback(store).fallbackFor({ projectId: PROJECT, runId: RUN })
    expect(rebase.ok).toBe(false)
    if (rebase.ok) return
    expect(rebase.error.code).toBe("mesh.snapshot_digest_mismatch")
    // And it says why serving it would be worse than not serving it.
    expect(rebase.error.message).toContain("worse than no re-base")
  })

  it("returns null for a run it has no snapshot of, which the caller must treat as a refusal", async () => {
    // `null` is a REAL answer and not a silent gap. The gateway turns it into
    // `refused` / `snapshot_unavailable`; the point of this assertion is that the
    // reader does not answer with the head, or with another run's state.
    const { store } = aPolicyHarness()
    const rebase = await new ProjectionSnapshotFallback(store).fallbackFor({ projectId: PROJECT, runId: RUN })
    expect(rebase.ok).toBe(true)
    if (!rebase.ok) return
    expect(rebase.value).toBeNull()
    expect(store.getSnapshot(PROJECT, OTHER_RUN, RUN_AGGREGATE_TYPE, OTHER_RUN)).toBeUndefined()
  })

  it("REFUSES a scope whose ids are not well-formed, rather than keying a read on them", async () => {
    const { store } = aPolicyHarness()
    // A scope that crossed a process boundary is a structural claim rather than a
    // verified one, which is the whole reason the reader re-parses both ids. The cast
    // here is the DEFECT being modelled — it is what a caller that skipped the schemas
    // would hand over — and it is written as `as never` so the compiler refuses to
    // let a well-typed value reach this line by accident.
    const rebase = await new ProjectionSnapshotFallback(store).fallbackFor({ projectId: "not a project id!" as never, runId: RUN })
    expect(rebase.ok).toBe(false)
    if (rebase.ok) return
    expect(rebase.error.code).toBe("mesh.snapshot_scope_invalid")
    // And it says the cursor is still not honoured, because that is what the caller
    // is about to report and the two must not read as different incidents.
    expect(rebase.error.message).toContain("still not honoured")
  })

  it("keeps two runs apart: a request for one never answers with the other's state", async () => {
    // The cross-run disclosure. Convenience causes it: a reader that inferred the
    // scope from whatever it happened to be holding would hand a client asking about
    // run B the state of run A, and nobody would have chosen to do that.
    const { store, updater, reader } = aPolicyHarness()
    updater.apply(aStoredEvent(aMeshEvent({ eventId: "evt-run-a", localSequence: 1, runSequence: 1 })))
    const mine = await reader.fallbackFor({ projectId: PROJECT, runId: RUN })
    const theirs = await reader.fallbackFor({ projectId: PROJECT, runId: OTHER_RUN })
    expect(mine.ok && mine.value?.snapshotFallback.runId).toBe(RUN)
    expect(theirs.ok && theirs.value).toBeNull()
  })
})

describe("M4-S the three kernel primitives are reachable from both ends", () => {
  it("saveSnapshot is written by the projection updater, keyed by the run's own aggregate id", async () => {
    const { store, updater } = aPolicyHarness()
    const result = updater.apply(aStoredEvent(aMeshEvent({ eventId: "evt-write-1", localSequence: 1, runSequence: 1 })))
    expect(result.saved).toBe(true)
    expect(result.snapshot?.aggregateType).toBe(RUN_AGGREGATE_TYPE)
    expect(result.snapshot?.aggregateId).toBe(RUN)
    expect(store.getSnapshot(PROJECT, RUN, RUN_AGGREGATE_TYPE, RUN)?.digest).toBe(result.snapshot?.digest)
  })

  it("getSnapshot is read by the fallback source, and the two agree on the digest", async () => {
    const { store, updater, reader } = aPolicyHarness()
    const written = updater.apply(aStoredEvent(aMeshEvent({ eventId: "evt-round-1", localSequence: 1, runSequence: 1 })))
    const rebase = await reader.fallbackFor({ projectId: PROJECT, runId: RUN })
    expect(rebase.ok && rebase.value?.snapshotFallback.stateDigest).toBe(written.snapshot?.digest)
  })

  it("readGlobal is reachable: a run with no snapshot is REBUILT from the log, then served", async () => {
    // The node that lost its snapshot to a crash between "event committed" and
    // "snapshot written". Without a rebuild the only honest answer would be
    // `refused`, and M4-S would degrade into "no fallback exists" for exactly the
    // node that lost one.
    const store = SqliteEventStore.createInMemory()
    const engine = new ProjectionEngine(store)
    const clock = new TestClock()
    const updater = new MeshProjectionUpdater({ engine, snapshots: store, now: clock.now })
    const reader = new ProjectionSnapshotFallback(store)

    // The log is written by the kernel's own append, which is the ONLY thing that
    // puts rows in `run_events` — the projection updater reduces and snapshots, it
    // does not append. A rebuild with nothing in the log would prove nothing.
    store.append({ command: aRunCreateCommand(), events: aRunLog() })
    expect(store.readGlobal().filter((event) => event.runId === RUN)).toHaveLength(3)
    // No snapshot has been written yet, because the crash happened before the first
    // `duringProjectionUpdate`.
    expect(store.getSnapshot(PROJECT, RUN, RUN_AGGREGATE_TYPE, RUN)).toBeUndefined()
    expect((await reader.fallbackFor({ projectId: PROJECT, runId: RUN })).ok && true).toBe(true)

    const rebuilt = updater.rebuildFromLog({ projectId: PROJECT, runId: RUN })
    expect(rebuilt?.state.lastAppliedSequence).toBe(3)
    expect(store.getSnapshot(PROJECT, RUN, RUN_AGGREGATE_TYPE, RUN)).toBeDefined()

    const served = await reader.fallbackFor({ projectId: PROJECT, runId: RUN })
    expect(served.ok).toBe(true)
    if (!served.ok || served.value === null) return
    const { stateDigest: _recorded, ...domainState } = served.value.state as Record<string, unknown>
    void _recorded
    expect(computeStateDigest(domainState as never)).toBe(served.value.snapshotFallback.stateDigest)
  })

  it("a rebuild for a run with NO events writes nothing and reports nothing", async () => {
    // A snapshot at sequence 0 with an empty run is a claim that this node has
    // established a state for a run it has never seen, and a client re-basing onto it
    // would be re-basing onto nothing while being told it had a position.
    const { updater } = aPolicyHarness()
    expect(updater.rebuildFromLog({ projectId: PROJECT, runId: OTHER_RUN })).toBeNull()
  })
})

describe("R3: the policy does not promise per-attempt envelope history", () => {
  it("a same-dispatchId revision REPLACES the envelope, so the superseded one is not rebuildable", () => {
    // The kernel's own statement of the property, replayed through this seam because
    // everything downstream of it depends on it. `revisedSameDispatchId()` proposes
    // `disp-rev-1` at attempt 1, has it fail, and re-proposes the SAME `dispatchId`
    // at attempt 2 with a different prompt.
    const { store, engine, updater } = aPolicyHarness()
    for (const [index, event] of revisedSameDispatchId().entries()) {
      updater.apply({ ...event, globalPosition: index + 1, event })
    }

    const state = engine.getProjection(RUN)
    expect(state).toBeDefined()
    // ONE entry for the dispatch id. A projection that kept both attempts' envelopes
    // would be a place to look for the superseded one, and R3 says it is not
    // rebuildable from here.
    expect(Object.keys(state?.dispatches ?? {})).toEqual(["disp-rev-1"])
    const dispatch = state?.dispatches["disp-rev-1"]
    expect(dispatch?.attempt).toBe(2)
    expect(dispatch?.envelope.prompt).toContain("toolchain pinned to 1.2.3")

    // And the SNAPSHOT of that state has the same shape — one dispatch, the current
    // envelope — so a client re-basing onto it is re-basing onto a state that does
    // not pretend to be an audit trail.
    const snapshot = store.getSnapshot(PROJECT, RUN, RUN_AGGREGATE_TYPE, RUN)
    expect(snapshot).toBeDefined()
    const snapshotState = snapshot!.state as RunProjectionState
    expect(Object.keys(snapshotState.dispatches)).toEqual(["disp-rev-1"])
    expect(snapshotState.dispatches["disp-rev-1"]?.attempt).toBe(2)
    // The ATTEMPT history is a different thing and IS legitimate: one record per
    // `(dispatchId, attempt)`, added by a retry, each with its own recorded digest.
    expect(snapshotState.tasks["task-a"]?.attemptHistory.map((entry) => entry.attempt)).toEqual([1, 2])
  })

  it("no member of the re-base or its type IMPLIES envelope history", () => {
    // A field called `attemptHistory` or `supersededEnvelopes` on a re-base would be
    // a promise this data structure cannot keep, and a client that trusted it would
    // render an audit view with holes in it. The members are READ OUT of the
    // declaration rather than listed in this test, so widening the interface is a
    // failure here and not merely a thing a reviewer might notice.
    expect(declaredMembers(TYPES_SOURCE, "SnapshotRebase")).toEqual(["snapshotFallback", "state"])
    for (const name of ["attemptHistory", "supersededEnvelope", "envelopeByAttempt", "previousEnvelopes", "envelopeHistory"]) {
      expect(declaredMembers(TYPES_SOURCE, "SnapshotRebase"), `SnapshotRebase must not carry '${name}'`).not.toContain(name)
    }
    // And the writer stores the kernel's own `RunProjectionState` unchanged, so it
    // cannot have widened the snapshot's state with a history field either.
    const projectionMembers = declaredMembers(PROJECTION_TYPES_SOURCE, "RunProjectionState")
    expect(projectionMembers).not.toContain("attemptHistory")
    expect(projectionMembers).not.toContain("envelopeHistory")
    expect(projectionMembers).toContain("dispatches")
  })

  it("and the module says WHY, in a comment a reader can disagree with", () => {
    // The reasoning is the deliverable as much as the negative assertion: a future
    // change to the snapshot shape has to be argued with, and an argument needs the
    // reason to be there to disagree with.
    expect(UPDATER_SOURCE).toMatch(/R3/)
    expect(UPDATER_SOURCE).toMatch(/revision/i)
    expect(prose(UPDATER_SOURCE)).toMatch(/REPLACES the envelope/)
    // And the distinction it draws with the projection's own attempt history, which
    // IS legitimate: one record per `(dispatchId, attempt)`, added by a retry rather
    // than produced by a revision replacing one.
    expect(UPDATER_SOURCE).toMatch(/attemptHistory/)
    expect(prose(UPDATER_SOURCE)).toMatch(/not a contradiction/)
  })
})

describe("the writer and the reader are the same policy from both ends", () => {
  it("what the writer stores is what the reader serves, byte for byte", async () => {
    const { store, updater, reader } = aPolicyHarness()
    const written = updater.apply(aStoredEvent(aMeshEvent({ eventId: "evt-same-1", localSequence: 1, runSequence: 1 })))
    const rebase = await reader.fallbackFor({ projectId: PROJECT, runId: RUN })
    expect(rebase.ok && rebase.value?.snapshotFallback.lastAppliedSequence).toBe(written.snapshot?.sequence)
    expect(rebase.ok && rebase.value?.snapshotFallback.runId).toBe(written.snapshot?.runId)
    expect(rebase.ok && rebase.value?.snapshotFallback.stateDigest).toBe(written.snapshot?.digest)
  })

  it("a re-apply that does not advance the state does NOT move the snapshot forward", () => {
    // Rewriting the snapshot for a no-op would move `createdAt` forward for a
    // projection that did not change, which is a lie about when the state was
    // computed — and `createdAt` is what an operator reads to decide whether a
    // re-base is recent.
    const { updater, clock } = aPolicyHarness()
    const event = aStoredEvent(aMeshEvent({ eventId: "evt-noop-1", localSequence: 1, runSequence: 1 }))
    const first = updater.apply(event)
    expect(first.saved).toBe(true)
    const firstCreatedAt = first.snapshot?.createdAt

    clock.advance(60_000)
    const second = updater.apply(event)
    expect(second.saved).toBe(false)
    expect(second.snapshot).toBeNull()
    expect(firstCreatedAt).not.toBe(second.snapshot?.createdAt)
  })
})

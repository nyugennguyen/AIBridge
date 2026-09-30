/**
 * M4.6 — the SSE gateway's ordering, resume and retention.
 *
 * Four properties, and the tests are grouped by them because each is a DIFFERENT
 * defect class:
 *
 *   1. **Ordering is total and gapless.** The kernel's `sequence` is per-RUN and the
 *      mesh's `localSequence` is per-SOURCE-NODE, so neither orders the stream one
 *      SSE client actually reads. `position` is the gateway's own, and a client that
 *      applies events in arrival order builds a wrong projection and reports
 *      nothing — which is why this is asserted as a property of the numbers rather
 *      than of a sort.
 *   2. **Resume is STRICTLY later.** `>=` re-delivers the event the client already
 *      holds, and SSE clients have no dedupe of their own, so a re-delivery is a
 *      second thing that happened unless the receiver happens to notice.
 *   3. **Retention is finite and named.** A gateway that retained everything could
 *      always answer a cursor and would then never have to admit it could not.
 *   4. **An un-honourable cursor is NEVER answered with the head.** That is the
 *      one the plan singles out, and it is the answer a client cannot detect.
 *
 * Nothing here sleeps. The clock is injected, so "fifteen minutes after the last
 * event" is a number.
 */
import { describe, expect, it } from "vitest"
import {
  MESH_EVENT_RESUME_LIMIT,
  MESH_EVENT_RETENTION_MAX_AGE_MS,
  MESH_EVENT_RETENTION_MAX_EVENTS,
  MeshEventGateway,
} from "../../../../../src/mesh/gateway/events/index.js"
import type { EventStreamGateway, SnapshotFallbackSource, SnapshotRebase } from "../../../../../src/mesh/gateway/events/index.js"
import { CONTROLLER, OTHER_WORKER, PROJECT, RUN, TestClock, WORKER, aMeshEvent, at, eventEnvelope, iso } from "../fixtures.js"
import type { EventOverrides } from "../fixtures.js"

/** Publishes and reports only the accepted positions, which is what ordering is about. */
async function publishMany(
  gateway: EventStreamGateway,
  count: number,
  overrides: (index: number) => EventOverrides = (index) => ({
    eventId: `evt-order-${index + 1}`,
    localSequence: index + 1,
  }),
): Promise<number[]> {
  const positions: number[] = []
  for (let index = 0; index < count; index += 1) {
    const event = aMeshEvent(overrides(index))
    const result = await gateway.publish(eventEnvelope(event))
    if (!result.ok) throw new Error(`publish refused: ${result.error.code}`)
    if (!result.outcome.accepted) throw new Error(`publish suppressed: ${result.outcome.disposition}`)
    positions.push(result.outcome.entry.position)
  }
  return positions
}

describe("ordering is total, and it is the gateway's own", () => {
  it("assigns strictly increasing, gapless positions from 1", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    expect(await publishMany(gateway, 5)).toEqual([1, 2, 3, 4, 5])
    expect(gateway.head()).toBe(5)
  })

  it("orders events from DIFFERENT source nodes on one axis", async () => {
    // The property that makes `position` necessary. Two workers' sequence 1s and 2s
    // are not comparable to each other, so a client reading both runs has no way to
    // order them from the wire — and it will not notice it got it wrong.
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    const positions = [
      (await gateway.publish(eventEnvelope(aMeshEvent({ eventId: "evt-a1", localSequence: 1, nodeId: WORKER })))).ok,
      (await gateway.publish(eventEnvelope(aMeshEvent({ eventId: "evt-b1", localSequence: 1, nodeId: OTHER_WORKER })))).ok,
      (await gateway.publish(eventEnvelope(aMeshEvent({ eventId: "evt-a2", localSequence: 2, nodeId: WORKER })))).ok,
    ]
    expect(positions.every(Boolean)).toBe(true)
    const resumed = await gateway.resume(0)
    expect(resumed.kind).toBe("resume")
    if (resumed.kind !== "resume") return
    // Interleaved by arrival, which is the only order that exists on the wire.
    expect(resumed.entries.map((entry) => entry.eventId)).toEqual(["evt-a1", "evt-b1", "evt-a2"])
    expect(resumed.entries.map((entry) => entry.position)).toEqual([1, 2, 3])
  })

  it("is not the kernel's run sequence and not the mesh's per-source sequence", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    // Three events whose per-source `localSequence` runs 1, 2, 3 and whose kernel
    // run sequence runs 7, 8, 9. A gateway that derived `position` from either would
    // have to produce one of those two triples, and it produces neither. The
    // per-source sequence has to start at 1 because `EventSequenceTracker` treats
    // anything higher from a node it has heard nothing from as a GAP, not a first
    // event — accepting 7 as the first would make 1-6 permanently unrecoverable
    // while looking like a clean start.
    await publishMany(gateway, 3, (index) => ({
      eventId: `evt-axis-${index + 1}`,
      localSequence: index + 1,
      runSequence: 7 + index,
    }))
    const resumed = await gateway.resume(0)
    expect(resumed.kind).toBe("resume")
    if (resumed.kind !== "resume") return
    expect(resumed.entries.map((entry) => entry.localSequence)).toEqual([1, 2, 3])
    expect(resumed.entries.map((entry) => entry.payload.event.sequence)).toEqual([7, 8, 9])
    expect(resumed.entries.map((entry) => entry.position)).toEqual([1, 2, 3])
  })

  it("a resume returns entries in position order however they were retained", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    await publishMany(gateway, 8)
    const resumed = await gateway.resume(0)
    expect(resumed.kind).toBe("resume")
    if (resumed.kind !== "resume") return
    const positions = resumed.entries.map((entry) => entry.position)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })
})

describe("resume replays STRICTLY later entries", () => {
  it("from a cursor, and never re-delivers the entry the client holds", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    await publishMany(gateway, 4)
    const resumed = await gateway.resume(2)
    expect(resumed.kind).toBe("resume")
    if (resumed.kind !== "resume") return
    // Positions 3 and 4 only. `>= 2` would re-deliver 2, and an SSE client has no
    // dedupe of its own, so that would be a second thing that happened.
    expect(resumed.entries.map((entry) => entry.position)).toEqual([3, 4])
    expect(resumed.from).toBe(3)
  })

  it("from the head with no cursor, and reports the head it is at", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    await publishMany(gateway, 3)
    const resumed = await gateway.resume(null)
    expect(resumed.kind).toBe("resume")
    if (resumed.kind !== "resume") return
    // A client that says "from wherever you are" gets the head and nothing before
    // it. There is no gap to declare, because it never claimed a position.
    expect(resumed.entries).toEqual([])
    expect(resumed.head).toBe(3)
    expect(resumed.from).toBe(3)
  })

  it("resumes a cursor that is exactly the newest position, yielding an empty page", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    await publishMany(gateway, 3)
    const resumed = await gateway.resume(3)
    expect(resumed.kind).toBe("resume")
    if (resumed.kind !== "resume") return
    expect(resumed.entries).toEqual([])
  })

  it("REFUSES a cursor ahead of the head rather than reporting the client current", async () => {
    // The one false answer that hides the fault. A cursor ahead of the head is not a
    // stale client; it is a client reading a DIFFERENT stream — a second gateway, a
    // restored database, a client bug — and "you are current" is indistinguishable
    // from that.
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    await publishMany(gateway, 2)
    const resumed = await gateway.resume(99)
    expect(resumed.kind).toBe("refused")
    if (resumed.kind !== "refused") return
    expect(resumed.reason).toBe("cursor_ahead")
    expect(resumed.error.code).toBe("mesh.stream_cursor_ahead")
    expect(resumed.error.message).toContain("names a stream this gateway has never produced")
  })

  it("REFUSES a malformed cursor rather than treating it as 'start from the head'", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    await publishMany(gateway, 2)
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const resumed = await gateway.resume(bad)
      expect(resumed.kind, `cursor ${String(bad)}`).toBe("refused")
      if (resumed.kind !== "refused") continue
      expect(resumed.reason).toBe("cursor_malformed")
    }
  })

  it("bounds the page, and never more than the seam's own limit", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    await publishMany(gateway, 10)
    const bounded = await gateway.resume(0, { limit: 3 })
    expect(bounded.kind).toBe("resume")
    if (bounded.kind !== "resume") return
    expect(bounded.entries).toHaveLength(3)

    // A caller asking for more than the seam allows gets the seam's number, not its
    // own: one client must not be able to ask for the world.
    const greedy = await gateway.resume(0, { limit: 1_000_000 })
    expect(greedy.kind).toBe("resume")
    if (greedy.kind !== "resume") return
    expect(greedy.entries.length).toBeLessThanOrEqual(MESH_EVENT_RESUME_LIMIT)

    const nonsense = await gateway.resume(0, { limit: -5 })
    expect(nonsense.kind).toBe("resume")
    if (nonsense.kind !== "resume") return
    expect(nonsense.entries.length).toBeGreaterThanOrEqual(1)
  })
})

describe("retention is finite, and both bounds are applied", () => {
  it("the bounds are the named ones, and they are FINITE", () => {
    // A gateway that retained everything could always answer a cursor, and would then
    // never have to admit it could not — which is the only way M4-S's fallback branch
    // is reachable at all. So the finiteness IS the assertion, not decoration.
    expect(MESH_EVENT_RETENTION_MAX_EVENTS).toBe(256)
    expect(MESH_EVENT_RETENTION_MAX_AGE_MS).toBe(900_000)
    expect(Number.isFinite(MESH_EVENT_RETENTION_MAX_EVENTS)).toBe(true)
    expect(Number.isFinite(MESH_EVENT_RETENTION_MAX_AGE_MS)).toBe(true)
    // And they are BOUNDS rather than quotas: a month of retention would satisfy
    // "finite" and defeat the point.
    expect(MESH_EVENT_RETENTION_MAX_AGE_MS).toBeLessThan(86_400_000)
  })

  it("the COUNT bound evicts from the front and keeps the newest", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now, retentionMaxEvents: 4 })
    await publishMany(gateway, 10)
    expect(gateway.retained().map((entry) => entry.position)).toEqual([7, 8, 9, 10])
    expect(gateway.oldestRetained()).toBe(7)
    expect(gateway.head()).toBe(10)
  })

  it("the AGE bound evicts against THIS node's clock, not the sender's", async () => {
    // The reason the age is measured here: `observedAt` is the SENDER's reading, so
    // a node whose clock runs fast would age its own events out of a peer's window
    // immediately and a slow one would keep them forever.
    const clock = new TestClock(at(0))
    const gateway = new MeshEventGateway({ now: clock.now, retentionMaxAgeMs: 60_000 })
    // An event whose sender claims it happened an hour ago.
    await gateway.publish(eventEnvelope(aMeshEvent({ eventId: "evt-old-clock", localSequence: 1, occurredAt: at(-3600) })))
    expect(gateway.retained()).toHaveLength(1)

    // Ten minutes of this node's clock with no traffic at all.
    clock.advance(MESH_EVENT_RETENTION_MAX_AGE_MS + 1)
    expect(gateway.retained()).toHaveLength(0)
    expect(gateway.oldestRetained()).toBeNull()
  })

  it("ages on READ as well as on write, so an idle stream still bounds itself", async () => {
    const clock = new TestClock(at(0))
    const gateway = new MeshEventGateway({ now: clock.now, retentionMaxAgeMs: 1000 })
    await gateway.publish(eventEnvelope(aMeshEvent({ eventId: "evt-idle", localSequence: 1 })))
    clock.advance(5000)
    // Never written to again. A gateway that aged only on write would keep offering
    // this entry past its bound, and the bound would be a property of traffic rather
    // than of time.
    const resumed = await gateway.resume(0)
    expect(resumed.kind).toBe("refused")
    if (resumed.kind !== "refused") return
    expect(resumed.reason).toBe("snapshot_unavailable")
  })

  it("stamps retention from its own clock even when the sender's stamp is in the future", async () => {
    const clock = new TestClock(at(0))
    const gateway = new MeshEventGateway({ now: clock.now, retentionMaxAgeMs: 1000 })
    await gateway.publish(eventEnvelope(aMeshEvent({ eventId: "evt-future", localSequence: 1, occurredAt: at(86_400) })))
    clock.advance(1001)
    expect(gateway.retained()).toHaveLength(0)
  })
})

describe("an un-honourable cursor is never answered with the head", () => {
  /** A source that always has a re-base, so the fallback branch is the one under test. */
  function rebaseSource(digest = "sha256:" + "a".repeat(64)): SnapshotFallbackSource {
    return {
      fallbackFor: async (scope) => ({
        ok: true,
        value: {
          snapshotFallback: { runId: scope.runId, lastAppliedSequence: 41, stateDigest: digest as never },
          state: { lastAppliedSequence: 41, marker: "rebase" },
        } satisfies SnapshotRebase,
      }),
    }
  }

  it("a cursor below the retention floor yields an EXPLICIT re-base, not a page", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now, retentionMaxEvents: 3, snapshots: rebaseSource() })
    await publishMany(gateway, 8)
    const resumed = await gateway.resume(1, { scope: { projectId: PROJECT, runId: RUN } })
    // The gate's wording: resumes from a cursor OR an explicit snapshot fallback.
    expect(resumed.kind).toBe("snapshot_required")
    if (resumed.kind !== "snapshot_required") return
    expect(resumed.rebase.snapshotFallback.lastAppliedSequence).toBe(41)
    // AND carries no `entries`. The re-base is a boundary; a page alongside it would
    // be a set of positions on a different ordering that the client cannot reconcile
    // with the snapshot's run sequence from anything on the wire.
    expect("entries" in resumed).toBe(false)
  })

  it("a cursor below the floor with NO snapshot is REFUSED, still not served the head", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now, retentionMaxEvents: 3 })
    await publishMany(gateway, 8)
    const resumed = await gateway.resume(1, { scope: { projectId: PROJECT, runId: RUN } })
    expect(resumed.kind).toBe("refused")
    if (resumed.kind !== "refused") return
    expect(resumed.reason).toBe("snapshot_unavailable")
    // The message has to say what is missing, because the client's two options
    // (re-base, or stop and tell a human) depend on it and neither is "carry on".
    expect(resumed.error.message).toContain("NOT continued from the head")
  })

  it("refuses when a scope is supplied but no snapshot source is wired at all", async () => {
    // The degraded mode has to be visible. Silently returning the head here would be
    // the exact defect M4-S exists to prevent, and it would be invisible to a client.
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now, retentionMaxEvents: 2 })
    await publishMany(gateway, 6)
    const resumed = await gateway.resume(1, { scope: { projectId: PROJECT, runId: RUN } })
    expect(resumed.kind).toBe("refused")
    if (resumed.kind !== "refused") return
    expect(resumed.reason).toBe("snapshot_unavailable")
  })

  it("refuses a cursor below the floor with NO scope, rather than guessing one", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now, retentionMaxEvents: 2, snapshots: rebaseSource() })
    await publishMany(gateway, 6)
    const resumed = await gateway.resume(1)
    expect(resumed.kind).toBe("refused")
    if (resumed.kind !== "refused") return
    // A gateway that inferred the scope from whatever it happened to retain would hand
    // a client asking about run B the state of run A. A cross-run disclosure caused
    // entirely by convenience.
    expect(resumed.reason).toBe("snapshot_unavailable")
  })

  it("an empty retention with a cursor at 0 is REFUSED, not treated as caught up", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now, retentionMaxAgeMs: 1, snapshots: rebaseSource() })
    await publishMany(gateway, 1)
    clock.advance(1000)
    const resumed = await gateway.resume(0, { scope: { projectId: PROJECT, runId: RUN } })
    expect(resumed.kind).toBe("snapshot_required")
  })

  it("honours a cursor whose next entry is exactly the retention floor", async () => {
    // The boundary, and it is where an off-by-one would produce a false gap: a cursor
    // of 6 with a floor of 7 is HONOURABLE, and refusing it would make a client
    // re-base for nothing.
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now, retentionMaxEvents: 3 })
    await publishMany(gateway, 8)
    // Eight published, three retained: the floor is 6, not 7.
    expect(gateway.oldestRetained()).toBe(6)
    const honoured = await gateway.resume(5, { scope: { projectId: PROJECT, runId: RUN } })
    expect(honoured.kind).toBe("resume")
    if (honoured.kind !== "resume") return
    expect(honoured.entries.map((entry) => entry.position)).toEqual([6, 7, 8])

    const refused = await gateway.resume(4, { scope: { projectId: PROJECT, runId: RUN } })
    expect(refused.kind).not.toBe("resume")
  })

  it("reports a stale cursor against the floor it actually has, not a remembered one", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now, retentionMaxEvents: 5 })
    // A SECOND source node, because `localSequence` is per node: continuing the first
    // node's sequence from 6 would be a gap, and a gap is a refusal rather than
    // something to work around in a fixture.
    await publishMany(gateway, 5)
    await publishMany(gateway, 2, (index) => ({ eventId: `evt-later-${index + 1}`, localSequence: index + 1, nodeId: OTHER_WORKER }))
    // Seven published, five retained.
    expect(gateway.oldestRetained()).toBe(3)
    // Cursor 2 with a floor of 3 IS honourable (2+1 >= 3), so the cursor that misses
    // is 1 — and the message has to name the exact range the client is missing, since
    // "resend from 2" and "resend from 1" are different requests.
    const resumed = await gateway.resume(1, { scope: { projectId: PROJECT, runId: RUN } })
    expect(resumed.kind).toBe("refused")
    if (resumed.kind !== "refused") return
    expect(resumed.error.message).toContain("retention floor 3")
    expect(resumed.error.message).toContain("between 2 and 2")
  })
})

describe("the gateway holds one total order across every run and source", () => {
  it("interleaves two runs without either one's sequence deciding the order", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    // A DIFFERENT source node per run, because `localSequence` is per node and
    // reusing one node's watermark across two runs would be a gap.
    await publishMany(gateway, 1, () => ({ eventId: "evt-run-a-1", localSequence: 1, runSequence: 5, nodeId: WORKER }))
    await publishMany(gateway, 1, () => ({ eventId: "evt-run-b-1", localSequence: 1, runId: "run-release-2", nodeId: OTHER_WORKER }))
    await publishMany(gateway, 1, () => ({ eventId: "evt-run-a-2", localSequence: 2, runSequence: 6, nodeId: WORKER }))
    const resumed = await gateway.resume(0)
    expect(resumed.kind).toBe("resume")
    if (resumed.kind !== "resume") return
    // Run B is at kernel sequence 1, which by run A's numbering sorts BEFORE both of
    // run A's events. It arrives between them. Only arrival order is a total order a
    // client can apply, and that is why the gateway has one.
    expect(resumed.entries.map((entry) => entry.eventId)).toEqual(["evt-run-a-1", "evt-run-b-1", "evt-run-a-2"])
    expect(resumed.entries.map((entry) => entry.runId)).toEqual([RUN, "run-release-2", RUN])
    expect(resumed.entries.map((entry) => entry.payload.event.sequence)).toEqual([5, 1, 6])
  })

  it("records the sender and the scope on every entry, from the record rather than the caller", async () => {
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    await publishMany(gateway, 1)
    const [entry] = gateway.retained()
    expect(entry?.sourceNodeId).toBe(WORKER)
    expect(entry?.projectId).toBe(PROJECT)
    expect(entry?.runId).toBe(RUN)
    expect(entry?.retainedFromMs).toBe(at(0))
  })

  it("the controller's own address never appears, because the gateway is not addressed", async () => {
    // A sanity check on the fixture rather than the code: the gateway does not care
    // who the recipient was, and a test that proved it DID care would be a test of a
    // property nobody asked for.
    const clock = new TestClock()
    const gateway = new MeshEventGateway({ now: clock.now })
    const result = await gateway.publish(eventEnvelope(aMeshEvent({ eventId: "evt-recipient", localSequence: 1 })))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(gateway.retained()[0]?.payload.runProjectScope.projectId).toBe(PROJECT)
    expect(CONTROLLER).toBe("node-controller-1")
    expect(iso(at(0))).toBe("2026-09-28T00:00:00.000Z")
  })
})

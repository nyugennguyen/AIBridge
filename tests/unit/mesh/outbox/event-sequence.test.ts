import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  EventSequenceTracker,
  checkLocalSequence,
  nextLocalSequence,
} from "../../../../src/mesh/protocol/event.js"
import { createContractError, type Result } from "../../../../src/orchestration/errors.js"
import type { EventId } from "../../../../src/orchestration/identifiers.js"
import { MeshEventIngestor, gapRefusal, idsRetiredThrough, type EventIngestStore } from "../../../../src/mesh/outbox/ingest.js"
import { MESH_OUTBOX_CLAIM_LEASE_MS } from "../../../../src/mesh/outbox/policy.js"
import {
  CONTROLLER,
  FakeTransport,
  RecordingBoundary,
  RestartableOutbox,
  WORKER,
  TestClock,
  aMeshEvent,
  at as eventAt,
  iso,
  outboxHarness,
} from "./fixtures.js"

import type { MeshEvent } from "../../../../src/mesh/protocol/event.js"

/**
 * `localSequence`: a gap must be SURFACED, never silently skipped.
 *
 * The protocol's own words are the requirement, and they are worth restating
 * because the failure they describe is invisible: at-least-once delivery plus a
 * crash between "event persisted" and "sequence advanced" means a controller can
 * legitimately observe a hole. The correct response is to ask for the missing
 * range. Continuing across it builds a projection that INVENTS the missing
 * state — and `dispatch.started` is exactly the event whose absence makes a
 * running session look un-run, which is the reading that makes an operator press
 * retry, which is the duplicate this whole mesh exists to prevent.
 *
 * The two mechanisms are separate and are tested separately:
 * `EventSequenceTracker` answers "is there a hole", and the ingestor answers "is
 * this a redelivery". Neither subsumes the other, because a duplicate is keyed on
 * `eventId` and a hole is keyed on position.
 */

const SEQUENCE_SOURCE = readFileSync(join(import.meta.dirname, "../../../../src/mesh/protocol/event.ts"), "utf8")
const INGEST_SOURCE = readFileSync(join(import.meta.dirname, "../../../../src/mesh/outbox/ingest.ts"), "utf8")

describe("M4.5 the first event from a node must be sequence 1", () => {
  it("accepts 1 and refuses 7, because accepting 7 makes 1..6 unrecoverable", () => {
    // A "first seen" accept is the trap. It looks like a clean start and it
    // makes the six events before it permanently unrecoverable while reporting
    // nothing wrong.
    expect(nextLocalSequence(null, 1).status).toBe("in-order")
    const jumped = nextLocalSequence(null, 7)
    expect(jumped.status).toBe("gap")
    if (jumped.status === "gap") {
      expect(jumped.missingFrom).toBe(1)
      expect(jumped.missingTo).toBe(6)
      expect(jumped.missingCount).toBe(6)
    }
  })

  it("names the range to request, and says not to continue", () => {
    const verdict = nextLocalSequence(3, 6)
    if (verdict.status !== "gap") throw new Error("expected a gap")
    expect(verdict.error.code).toBe("mesh.event_sequence_gap")
    expect(verdict.error.message).toContain("4-5")
    expect(verdict.error.message).toMatch(/do not continue/i)
    // The error is a `conflict`, so nothing automatic may retry it — a controller
    // cannot fix a missing event by trying harder.
    expect(verdict.error.category).toBe("conflict")
    expect(verdict.error.retryable).toBe(false)
  })
})

describe("M4.5 the tracker records the HIGHEST sequence, not the last", () => {
  it("an out-of-order arrival cannot move the watermark backwards", () => {
    const tracker = new EventSequenceTracker(WORKER)
    expect(tracker.evaluate(1).status).toBe("in-order")
    expect(tracker.evaluate(2).status).toBe("in-order")
    // Sequence 1 again: a duplicate, and the watermark stays at 2.
    expect(tracker.evaluate(1).status).toBe("duplicate")
    expect(tracker.highestAccepted).toBe(2)
    // 3 fits, which it would not if the watermark had been lowered to 1.
    expect(tracker.evaluate(3).status).toBe("in-order")
    expect(tracker.highestAccepted).toBe(3)
  })

  it("a gap does NOT advance the watermark, so the hole is still reported afterwards", () => {
    const tracker = new EventSequenceTracker(WORKER)
    tracker.evaluate(1)
    expect(tracker.evaluate(5).status).toBe("gap")
    // The whole point: a tracker that advanced over the hole would make the
    // missing range look already-seen, and the controller would never ask for it.
    expect(tracker.highestAccepted).toBe(1)
    // 2..4 are still missing, and 5 arriving first has not hidden them.
    expect(tracker.evaluate(2).status).toBe("in-order")
    expect(tracker.evaluate(3).status).toBe("in-order")
    expect(tracker.evaluate(4).status).toBe("in-order")
    // And now 5 fits, with no operator action beyond the resend.
    expect(tracker.evaluate(5).status).toBe("in-order")
    expect(tracker.highestAccepted).toBe(5)
  })

  it("reports the missing range as an inclusive span", () => {
    const verdict = nextLocalSequence(1, 4)
    expect(EventSequenceTracker.missingRange(verdict)).toEqual({ from: 2, to: 3 })
    expect(EventSequenceTracker.missingRange(nextLocalSequence(1, 2))).toBeNull()
  })

  it("rebases ONLY when told a node restarted", () => {
    const tracker = new EventSequenceTracker(WORKER)
    tracker.evaluate(9)
    // A restart RESETS the sender's sequence, so its events arrive at 1 again.
    tracker.rebaseAfterRestart()
    expect(tracker.highestAccepted).toBeNull()
    expect(tracker.evaluate(1).status).toBe("in-order")
    // And the rebase is EXPLICIT: called on any "hello", it would lower the
    // watermark under a node that did not restart and make a genuinely lost
    // sequence look still-expected.
    expect(SEQUENCE_SOURCE).toMatch(/separate method rather than something `evaluate` does on its own/)
  })
})

describe("M4.5 checkLocalSequence is the Result flavour of the same decision", () => {
  it("agrees with the verdict in all three cases", () => {
    const first = checkLocalSequence(null, 1)
    const inOrder = checkLocalSequence(2, 3)
    const gapped = checkLocalSequence(2, 9)
    const duplicate = checkLocalSequence(3, 2)

    expect(first.ok).toBe(true)
    expect(inOrder.ok).toBe(true)
    expect(gapped.ok).toBe(false)
    expect(duplicate.ok).toBe(false)
    // A duplicate is reported as a duplicate code rather than folded into the gap
    // one, so a caller can tell "resent" from "something is missing".
    if (!gapped.ok) expect(gapped.error.code).toBe("mesh.event_sequence_gap")
    if (!duplicate.ok) expect(duplicate.error.code).toBe("mesh.event_sequence_duplicate")
  })
})

describe("M4.5 ingestion is idempotent on eventId AND gap-aware on localSequence", () => {
  it("applies a contiguous stream, and reports each arrival", async () => {
    const store = new RecordingIngestStore()
    const ingestor = new MeshEventIngestor({ store })
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      const outcome = await ingestor.ingest(aMeshEvent({ eventId: `evt-seq-${sequence}`, localSequence: sequence, occurredAt: eventAt(sequence) }))
      expect(outcome.ok && outcome.value.status, `sequence ${sequence}`).toBe("applied")
    }
    expect(store.applied).toHaveLength(4)
    expect(ingestor.trackerFor(WORKER).highestAccepted).toBe(4)
  })

  it("refuses to apply across a hole, does not advance, and names the range", async () => {
    const store = new RecordingIngestStore()
    const ingestor = new MeshEventIngestor({ store })
    await ingestor.ingest(aMeshEvent({ eventId: "evt-seq-1", localSequence: 1 }))

    const gapped = await ingestor.ingest(aMeshEvent({ eventId: "evt-seq-4", localSequence: 4, occurredAt: eventAt(4) }))
    expect(gapped.ok && gapped.value.status).toBe("gap")
    if (gapped.ok && gapped.value.status === "gap") {
      expect(gapped.value.missingFrom).toBe(2)
      expect(gapped.value.missingTo).toBe(3)
      expect(gapped.value.error.code).toBe("mesh.event_sequence_gap")
    }
    // Not applied. A controller that applied 4 while 2..3 were missing would hold
    // a projection derived from a stream with a hole, and the hole is invisible
    // afterwards.
    expect(store.applied).toHaveLength(1)
    expect(ingestor.trackerFor(WORKER).highestAccepted).toBe(1)

    // The resend closes the hole with no operator action beyond the request.
    for (const sequence of [2, 3, 4]) {
      const outcome = await ingestor.ingest(
        aMeshEvent({ eventId: `evt-seq-${sequence}`, localSequence: sequence, occurredAt: eventAt(sequence) }),
      )
      expect(outcome.ok && outcome.value.status, `sequence ${sequence}`).toBe("applied")
    }
    expect(store.applied).toHaveLength(4)
  })

  it("an event whose APPLY failed does not advance the watermark", async () => {
    // A failed apply that still advanced would turn a retryable storage fault
    // into a permanent hole the controller would then refuse to continue across.
    const store = new RecordingIngestStore({ failApplyAtSequence: 2 })
    const ingestor = new MeshEventIngestor({ store })
    await ingestor.ingest(aMeshEvent({ eventId: "evt-seq-1", localSequence: 1 }))

    const failed = await ingestor.ingest(aMeshEvent({ eventId: "evt-seq-2", localSequence: 2, occurredAt: eventAt(2) }))
    expect(failed.ok).toBe(false)
    expect(ingestor.trackerFor(WORKER).highestAccepted).toBe(1)

    // With storage healthy again, the retry fits and applies.
    store.failApplyAtSequence = null
    const retried = await ingestor.ingest(aMeshEvent({ eventId: "evt-seq-2", localSequence: 2, occurredAt: eventAt(2) }))
    expect(retried.ok && retried.value.status).toBe("applied")
    expect(store.applied).toHaveLength(2)
  })

  it("a redelivery of an applied event is a DUPLICATE and applies nothing", async () => {
    const store = new RecordingIngestStore()
    const ingestor = new MeshEventIngestor({ store })
    await ingestor.ingest(aMeshEvent({ localSequence: 1 }))
    await ingestor.ingest(aMeshEvent({ localSequence: 2, eventId: "evt-seq-2", occurredAt: eventAt(2) }))

    // The retry of event 1, arriving after the watermark moved to 2. Classified
    // through the sequence check it would be a DUPLICATE verdict, and through a
    // naive gap check it could read as an anomaly — the `eventId` check comes
    // first precisely so neither happens.
    const retry = await ingestor.ingest(aMeshEvent({ localSequence: 1 }))
    expect(retry.ok && retry.value.status).toBe("duplicate")
    expect(store.applied).toHaveLength(2)
  })

  it("a DIFFERENT event claiming an already-passed sequence is a duplicate, not a second application", async () => {
    const store = new RecordingIngestStore()
    const ingestor = new MeshEventIngestor({ store })
    await ingestor.ingest(aMeshEvent({ eventId: "evt-seq-1", localSequence: 1 }))
    await ingestor.ingest(aMeshEvent({ eventId: "evt-seq-2", localSequence: 2, occurredAt: eventAt(2) }))

    // Sequence 1 under a NEW id. The watermark says this node has been through
    // position 1, and re-applying would put the stream backwards. Reported as a
    // duplicate rather than applied, and REPORTED rather than folded into a
    // boolean so a caller can tell "resent" from "a second event claiming an old
    // slot".
    const impostor = await ingestor.ingest(aMeshEvent({ eventId: "evt-seq-1-again", localSequence: 1 }))
    expect(impostor.ok && impostor.value.status).toBe("duplicate")
    expect(store.applied).toHaveLength(2)
  })

  it("a restart is recorded EXPLICITLY, and a node that did not restart is unaffected", async () => {
    const store = new RecordingIngestStore()
    const ingestor = new MeshEventIngestor({ store })
    await ingestor.ingest(aMeshEvent({ eventId: "evt-seq-1", localSequence: 1 }))
    await ingestor.ingest(aMeshEvent({ eventId: "evt-seq-2", localSequence: 2, occurredAt: eventAt(2) }))

    // A node that did NOT restart is still sending high sequences. Rebasing on
    // every "hello" would lower the watermark under it and make a genuinely lost
    // sequence look still-expected.
    expect(ingestor.ingest(aMeshEvent({ eventId: "evt-seq-3", localSequence: 3, occurredAt: eventAt(3) })).then((r) => r.ok)).resolves.toBe(true)

    ingestor.recordRestart(WORKER)
    expect(ingestor.trackerFor(WORKER).highestAccepted).toBeNull()
  })

  it("the `eventId` check comes FIRST, and the tracker is untouched by a duplicate", () => {
    // The order is load-bearing and easy to reorder by accident: both checks read
    // a `Result`, both can refuse, and the "cleaner" looking order is the wrong
    // one.
    const body = INGEST_SOURCE.slice(INGEST_SOURCE.indexOf("async ingest"))
    expect(body.indexOf("this.#store.seen(eventId)")).toBeLessThan(body.indexOf("this.trackerFor(sourceNodeId)"))
  })
})

describe("M4.5 a gap in the DELIVERED stream is surfaced end to end", () => {
  it("a sender-side gap is REFUSED at enqueue, so it never becomes a controller-side hole", async () => {
    const clock = new TestClock(eventAt(0))
    const transport = new FakeTransport(clock.now)
    const worker = new RestartableOutbox(clock, transport)
    try {
      await worker.harness.outbox.enqueue({ event: aMeshEvent({ eventId: "evt-hole-1", localSequence: 1 }), destination: CONTROLLER })

      // The worker's emitter advanced past 2 without 2 ever reaching the outbox —
      // a failed write, or a bug. Storing 3 would create a hole the CONTROLLER
      // cannot close, because asking this node to resend 2 would produce nothing:
      // the node never had it.
      const skipped = await worker.harness.outbox.enqueue({
        event: aMeshEvent({ eventId: "evt-hole-3", localSequence: 3, occurredAt: eventAt(3) }),
        destination: CONTROLLER,
      })
      expect(skipped.ok).toBe(false)
      if (!skipped.ok) expect(skipped.error.code).toBe("mesh.outbox_sequence_gap")

      // Only sequence 1 is transmissible, so the controller's stream is contiguous
      // and the gap never leaves this node.
      await worker.harness.deliverer().pumpOnce()
      expect(transport.sent.map((entry) => entry.localSequence)).toEqual([1])
      expect(worker.harness.store.count()).toBe(1)
    } finally {
      worker.destroy()
    }
  })

  it("a controller-side gap is SURFACED, not skipped, when a hole reaches it anyway", async () => {
    // A hole can still arrive from a node this build did not write, or from a
    // store whose rows were pruned. The controller's answer is the same either
    // way: report the exact range and do not apply across it.
    const clock = new TestClock(eventAt(0))
    const transport = new FakeTransport(clock.now)
    const worker = new RestartableOutbox(clock, transport)
    try {
      // Sequence 3 is written through the STORE rather than through `enqueue`,
      // standing in for a row from a build whose enqueue did not carry the
      // sender-side gap check. The controller cannot tell where a row came from,
      // so its own obligation stands regardless of whether the sender was
      // careful.
      const three = aMeshEvent({ eventId: "evt-hole-3", localSequence: 3, occurredAt: eventAt(3) })
      await worker.harness.outbox.enqueue({
        event: aMeshEvent({ eventId: "evt-hole-1", localSequence: 1 }),
        destination: CONTROLLER,
      })
      worker.harness.store.enqueue({
        outboxId: "mevt-evt-hole-3",
        destination: CONTROLLER,
        eventId: three.eventId,
        projectId: three.runProjectScope.projectId,
        runId: three.runProjectScope.runId,
        localSequence: 3,
        eventJson: JSON.stringify(three),
        payloadDigest: `sha256:${"a".repeat(64)}`,
        createdAt: iso(eventAt(3)),
      })

      await worker.harness.deliverer().pumpOnce()
      expect(transport.sent.map((entry) => entry.localSequence)).toEqual([1, 3])
    } finally {
      worker.destroy()
    }

    const controller = new RecordingIngestStore()
    const ingestor = new MeshEventIngestor({ store: controller })
    const first = await ingestor.ingest(aMeshEvent({ eventId: "evt-hole-1", localSequence: 1 }))
    expect(first.ok && first.value.status).toBe("applied")

    const third = await ingestor.ingest(aMeshEvent({ eventId: "evt-hole-3", localSequence: 3, occurredAt: eventAt(3) }))
    expect(third.ok && third.value.status).toBe("gap")
    if (third.ok && third.value.status === "gap") {
      expect([third.value.missingFrom, third.value.missingTo]).toEqual([2, 2])
      expect(third.value.error.code).toBe("mesh.event_sequence_gap")
    }
    // The hole is visible, and nothing downstream was built over it.
    expect(controller.applied).toHaveLength(1)
  })

  it("a crash between 'event persisted' and 'sequence advanced' leaves a gap the controller sees", async () => {
    // This is the exact scenario the protocol's `localSequence` documentation
    // describes, and it is reachable: the crash is at hook 5, so event 1's row is
    // stranded and only event 2 goes out in the first cycle.
    const clock = new TestClock(eventAt(0))
    const transport = new FakeTransport(clock.now)
    const worker = new RestartableOutbox(clock, transport)
    try {
      for (const sequence of [1, 2]) {
        await worker.harness.outbox.enqueue({
          event: aMeshEvent({ eventId: `evt-crash-${sequence}`, localSequence: sequence, occurredAt: eventAt(sequence) }),
          destination: CONTROLLER,
        })
      }
      // Crash after the first record was claimed and delivered, before the second
      // was reached. The pump iterates its claim in order, so the crash lands
      // between them.
      const crashing = new RecordingBoundary(null)
      crashing.afterRuntimeAccept = (): void => {
        if (transport.sent.length >= 2) throw new Error("crash injected mid-batch")
      }
      await expect(worker.harness.deliverer({ boundary: crashing }).pumpOnce()).rejects.toThrow(/mid-batch/)
      // Both were claimed, so BOTH are stranded and neither has been acked. The
      // gap is therefore NOT created by this crash — which is the honest
      // observation: the claim is a batch, and at-least-once redelivers the whole
      // batch.
      expect(worker.harness.store.find("mevt-evt-crash-1")?.status).toBe("acknowledged")
      expect(worker.harness.store.find("mevt-evt-crash-2")?.status).toBe("sending")

      worker.restart()
      clock.set(eventAt(MESH_OUTBOX_CLAIM_LEASE_MS / 1000 + 1))
      const controller = new RecordingIngestStore()
      const ingestor = new MeshEventIngestor({ store: controller })
      await worker.harness.deliverer().pumpOnce()

      // The controller sees 1, then 2. No gap, because nothing was lost — and the
      // redelivery of 1 (which the pump sends again, since its ack was lost with
      // the crash) is deduped rather than treated as an anomaly.
      for (const event of [
        aMeshEvent({ eventId: "evt-crash-1", localSequence: 1 }),
        aMeshEvent({ eventId: "evt-crash-1", localSequence: 1 }),
        aMeshEvent({ eventId: "evt-crash-2", localSequence: 2, occurredAt: eventAt(2) }),
      ]) {
        await ingestor.ingest(event)
      }
      expect(controller.applied.map((event) => event.localSequence)).toEqual([1, 2])
      expect(ingestor.trackerFor(WORKER).highestAccepted).toBe(2)
    } finally {
      worker.destroy()
    }
  })
})

describe("M4.5 a cumulative ack retires every event up to its position", () => {
  it("converts `acknowledgedThroughLocalSequence` into the ids a worker may retire", () => {
    // The position is only computable if the outbox row still knows which
    // position it holds, which is why `localSequence` is a column rather than
    // something re-derived from the payload on every claim.
    const records = [
      { outboxId: "mevt-1", localSequence: 1 },
      { outboxId: "mevt-2", localSequence: 2 },
      { outboxId: "mevt-3", localSequence: 3 },
    ]
    expect(idsRetiredThrough(records, 2)).toEqual(["mevt-1", "mevt-2"])
    expect(idsRetiredThrough(records, 3)).toEqual(["mevt-1", "mevt-2", "mevt-3"])
    // Nothing is retired by a position below the first event, and a row with no
    // recorded position is never retired by inference.
    expect(idsRetiredThrough(records, 0)).toEqual([])
    expect(idsRetiredThrough([{ outboxId: "mevt-x", localSequence: null }], 99)).toEqual([])
  })

  it("says why a gap must not be continued across", () => {
    const error = gapRefusal(WORKER, 4, 9)
    expect(error.code).toBe("mesh.event_sequence_gap")
    expect(error.message).toContain("node-worker-1")
    expect(error.message).toContain("4-9")
    expect(error.message).toMatch(/not continued across the hole/i)
  })
})

describe("M4.5 the outbox ASSIGNS the local sequence, and a caller cannot spend one twice", () => {
  it("accepts a contiguous run and refuses a first event above 1", async () => {
    const clock = new TestClock(eventAt(0))
    const harness = outboxHarness(clock)
    try {
      // A store that accepted 7 as the first event would make 1..6 permanently
      // unrecoverable while looking like a clean start.
      const jumped = await harness.outbox.enqueue({
        event: aMeshEvent({ eventId: "evt-assign-7", localSequence: 7, occurredAt: eventAt(7) }),
        destination: CONTROLLER,
      })
      expect(jumped.ok).toBe(false)
      if (!jumped.ok) {
        expect(jumped.error.code).toBe("mesh.outbox_sequence_gap")
        expect(jumped.error.message).toContain("1-6")
      }
      expect(harness.store.count()).toBe(0)

      for (const sequence of [1, 2, 3]) {
        const enqueued = await harness.outbox.enqueue({
          event: aMeshEvent({ eventId: `evt-assign-${sequence}`, localSequence: sequence, occurredAt: eventAt(sequence) }),
          destination: CONTROLLER,
        })
        expect(enqueued.ok, `sequence ${sequence}`).toBe(true)
      }
      expect(harness.store.count()).toBe(3)
    } finally {
      harness.close()
    }
  })

  it("a REPLAYED sequence is refused rather than stored as a second event at a spent position", async () => {
    const clock = new TestClock(eventAt(0))
    const harness = outboxHarness(clock)
    try {
      await harness.outbox.enqueue({ event: aMeshEvent({ localSequence: 1 }), destination: CONTROLLER })
      // A DIFFERENT event id claiming sequence 1. The controller has already
      // accepted position 1, so storing this would put two events at one
      // position — and `localSequence` is meaningless the moment it is not unique.
      const replay = await harness.outbox.enqueue({
        event: aMeshEvent({ eventId: "evt-replay-1", localSequence: 1 }),
        destination: CONTROLLER,
      })
      expect(replay.ok).toBe(false)
      if (!replay.ok) expect(replay.error.code).toBe("mesh.outbox_sequence_replay")
      expect(harness.store.count()).toBe(1)
    } finally {
      harness.close()
    }
  })

  it("a re-enqueue of the SAME event converges and does not advance the sequence", async () => {
    const clock = new TestClock(eventAt(0))
    const harness = outboxHarness(clock)
    try {
      const first = await harness.outbox.enqueue({ event: aMeshEvent({ localSequence: 1 }), destination: CONTROLLER })
      expect(first.ok && first.value.written).toBe(true)

      // A redelivery or a double-enqueue must NOT consume sequence 2. A caller
      // that retries after a crash would otherwise burn a position the controller
      // then sees as a gap.
      const again = await harness.outbox.enqueue({ event: aMeshEvent({ localSequence: 1 }), destination: CONTROLLER })
      expect(again.ok && again.value.written).toBe(false)
      expect(harness.store.count()).toBe(1)

      // And sequence 2 is still available.
      const next = await harness.outbox.enqueue({
        event: aMeshEvent({ eventId: "evt-assign-2", localSequence: 2, occurredAt: eventAt(2) }),
        destination: CONTROLLER,
      })
      expect(next.ok).toBe(true)
      expect(harness.store.count()).toBe(2)
    } finally {
      harness.close()
    }
  })

  it("an ACKNOWLEDGED record still holds its sequence", async () => {
    const clock = new TestClock(eventAt(0))
    const harness = outboxHarness(clock)
    try {
      await harness.outbox.enqueue({ event: aMeshEvent({ localSequence: 1 }), destination: CONTROLLER })
      await harness.deliverer().pumpOnce()
      expect(harness.store.find("mevt-evt-outbox-1")?.status).toBe("acknowledged")

      // A store that forgot acknowledged rows would re-issue a position the
      // controller has already applied, and the gap check would then fire against
      // this node's own history.
      const afterAck = await harness.outbox.enqueue({
        event: aMeshEvent({ eventId: "evt-assign-3", localSequence: 3, occurredAt: eventAt(3) }),
        destination: CONTROLLER,
      })
      expect(afterAck.ok).toBe(false)
      if (!afterAck.ok) expect(afterAck.error.message).toContain("2-2")
    } finally {
      harness.close()
    }
  })

  it("refuses an event minted at a protocol version this build does not speak", async () => {
    const clock = new TestClock(eventAt(0))
    const harness = outboxHarness(clock)
    try {
      // A stored event nobody can parse is an outbox row that blocks its own
      // reconciliation for ever, so the version is checked BEFORE the write.
      const wrongVersion = { ...aMeshEvent({ localSequence: 1 }), meshProtocolVersion: 99 }
      const refused = await harness.outbox.enqueue({ event: wrongVersion as never, destination: CONTROLLER })
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.error.code).toBe("mesh.outbox_entry_malformed")
      expect(harness.store.count()).toBe(0)
    } finally {
      harness.close()
    }
  })

  it("a transport write is never attempted for an event that was not stored", async () => {
    // "Enters a durable outbox BEFORE transmission" is enforced by the order of
    // two named calls, and this is the assertion that the second one has nothing
    // to transmit when the first refused.
    const clock = new TestClock(eventAt(0))
    const harness = outboxHarness(clock)
    try {
      const refused = await harness.outbox.enqueue({
        event: { ...aMeshEvent({ localSequence: 9 }), meshProtocolVersion: 99 } as never,
        destination: CONTROLLER,
      })
      expect(refused.ok).toBe(false)
      expect((await harness.deliverer().pumpOnce()).claimed).toBe(0)
      expect(harness.transport.sent).toHaveLength(0)
    } finally {
      harness.close()
    }
  })
})

describe("M4.5 the inbox's accept sequence and the mesh's localSequence are different axes", () => {
  it("the protocol says so, and they live in different tables", () => {
    // Two sequences that both happen to be monotonic. The inbox's is the ACK
    // ORDER on a worker; the mesh's is the ARRIVAL ORDER from a node. A controller
    // ingesting worker events has no inbox, and a worker admitting commands has no
    // local sequence — which is why they are separate columns in separate tables
    // rather than one shared counter.
    expect(SEQUENCE_SOURCE).toMatch(/Per source node, monotonic/)
    expect(SEQUENCE_SOURCE).toMatch(/per source node, monotonic, gapless from the controller's point of view/i)
  })
})

/**
 * A controller-side ingest store that records what it applied, and can be made
 * to fail one apply.
 *
 * `applied` is the assertion target for "no duplicate session": one entry per
 * EVENT rather than one per transmission is the whole content of idempotent
 * ingestion.
 */
class RecordingIngestStore implements EventIngestStore {
  readonly applied: MeshEvent[] = []
  failApplyAtSequence: number | null = null
  readonly #seen = new Set<string>()

  constructor(options: { readonly failApplyAtSequence?: number | null } = {}) {
    this.failApplyAtSequence = options.failApplyAtSequence ?? null
  }

  async seen(eventId: EventId): Promise<Result<boolean>> {
    return { ok: true, value: this.#seen.has(eventId) }
  }

  async apply(event: MeshEvent): Promise<Result<void>> {
    if (this.failApplyAtSequence !== null && event.localSequence === this.failApplyAtSequence) {
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "projection.unavailable",
          "The controller's projection could not be written.",
          true,
        ),
      }
    }
    this.#seen.add(event.eventId)
    this.applied.push(event)
    return { ok: true, value: undefined }
  }
}

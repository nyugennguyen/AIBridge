import { describe, expect, it } from "vitest"
import { eventIdSchema, type EventId } from "../../../../src/orchestration/identifiers.js"
import { MESH_OUTBOX_CLAIM_LEASE_MS } from "../../../../src/mesh/outbox/policy.js"
import { MeshEventIngestor, type EventIngestStore } from "../../../../src/mesh/outbox/ingest.js"
import {
  CONTROLLER,
  FakeTransport,
  RecordingBoundary,
  RestartableOutbox,
  TestClock,
  WORKER,
  aMeshEvent,
  at,
  outboxHarness,
  type OutboxHarness,
} from "./fixtures.js"

import type { MeshEvent } from "../../../../src/mesh/protocol/event.js"

/**
 * Crash boundaries, and the convergence each one must reach.
 *
 * The sequence diagrams' requirement is literal: "for each of the eight
 * `EffectBoundary` hooks, crash there, restart, and assert convergence. Hooks 5
 * (before deliver) and 6 (after runtime accept, before ack) are the two that
 * produce a *redelivery*, and both must be idempotent." This file covers the
 * M4.5 half of those — the inbox's four boundaries and the outbox's — and each
 * one asserts the SAME three things, because those three are what convergence
 * means on a mesh:
 *
 *   1. **no duplicate session** — the command was applied once
 *   2. **no lost event** — every event the worker reported was ingested
 *   3. **no unbounded growth** — the row and outbox counts are what they would
 *      be if nothing had ever crashed
 *
 * A restart is a real one: the SQLite file is closed and reopened. An
 * in-memory store that survived would make every assertion here vacuous, and one
 * that did not survive would be a cache rather than a durable outbox.
 *
 * A crash is a THROW from inside the boundary hook, because that is the only
 * point at which "the process died" is faithful: the claim is durable, the
 * delivery is recorded, and nothing after the hook ran. A flag that made the pump
 * return early would not be a crash.
 */

describe("boundary 1 — crash BEFORE the command is persisted", () => {
  it("nothing exists, so a redelivery is a first arrival", async () => {
    const clock = new TestClock(at(0))
    const worker = new RestartableOutbox(clock)
    try {
      // A crash at the very first step: no row, no ack, no event. The controller
      // resends and this node treats it as new work — which is correct, because
      // nothing was started.
      expect(worker.harness.store.count()).toBe(0)
      worker.restart()
      expect(worker.harness.store.count()).toBe(0)
    } finally {
      worker.destroy()
    }
  })
})

describe("boundary 2 — crash AFTER the command is persisted, BEFORE the ack", () => {
  it("the row survives the restart and a redelivery is a DUPLICATE, not a second session", async () => {
    const clock = new TestClock(at(0))
    const worker = new RestartableOutbox(clock)
    try {
      // The inbox side of this boundary is asserted in
      // `inbox-ordering.test.ts`; what is asserted here is the OUTBOX's half, and
      // that the pair converges: a durable command produces exactly one event.
      await worker.harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      const before = await worker.harness.outbox.listAll()
      expect(before.ok && before.value).toHaveLength(1)

      // Crash: the process stops with the row durable and nothing transmitted.
      worker.restart()

      const after = await worker.harness.outbox.listAll()
      expect(after.ok && after.value).toHaveLength(1)
      // Same event id, same row. A restart that re-minted the row would make the
      // controller see a second event that never happened.
      expect(after.ok && after.value[0]?.outboxId).toBe("mevt-evt-outbox-1")

      // The redelivery: the pump claims it and the controller ingests it once.
      const controller = new RecordingController()
      const report = await worker.harness.deliverer().pumpOnce()
      expect(report.acknowledged).toBe(1)
      await controller.ingest(aMeshEvent())

      expect(controller.applied, "no duplicate session").toHaveLength(1)
      expect(worker.transport.sentEventIds).toEqual([eventIdSchema.parse("evt-outbox-1")])
    } finally {
      worker.destroy()
    }
  })
})

describe("boundary 5 — crash at EffectBoundary.beforeDeliver", () => {
  it("the claim is stranded, the restart reclaims it, and the event arrives ONCE", async () => {
    const clock = new TestClock(at(0))
    const transport = new FakeTransport(clock.now)
    const worker = new RestartableOutbox(clock, transport)
    try {
      await worker.harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })

      // The claim is durable and the process dies before the socket.
      const crashing = new RecordingBoundary("beforeDeliver")
      await expect(worker.harness.deliverer({ boundary: crashing }).pumpOnce()).rejects.toThrow(/beforeDeliver/)
      expect(transport.sent, "nothing reached the wire").toHaveLength(0)

      const stranded = worker.harness.store.find("mevt-evt-outbox-1")
      expect(stranded?.status).toBe("sending")
      expect(stranded?.attempts).toBe(1)

      // Restart. The row is still there, still `sending`, still counted.
      worker.restart()
      expect(worker.harness.store.find("mevt-evt-outbox-1")?.status).toBe("sending")
      expect(worker.harness.store.find("mevt-evt-outbox-1")?.attempts).toBe(1)

      // Before the lease expires, nothing reclaims it: the record may still be in
      // flight in another process, and requeueing it would duplicate a delivery
      // that is about to succeed.
      expect((await worker.harness.deliverer().recoverOnStartup()).recovered).toHaveLength(0)

      // After the lease expires, the redelivery is the FIRST that reached the
      // wire — so the controller sees the event exactly once.
      clock.set(at(MESH_OUTBOX_CLAIM_LEASE_MS / 1000 + 1))
      const controller = new RecordingController()
      const report = await worker.harness.deliverer().pumpOnce()
      expect(report.reclaimed).toEqual(["mevt-evt-outbox-1"])
      expect(report.acknowledged).toBe(1)
      expect(transport.sentEventIds).toEqual([eventIdSchema.parse("evt-outbox-1")])

      await controller.ingest(aMeshEvent())
      expect(controller.applied, "no duplicate session").toHaveLength(1)
      // `attempts` counted BOTH the stranded claim and the redelivery. It is
      // never reset, which is what makes the threshold reachable.
      expect(worker.harness.store.find("mevt-evt-outbox-1")?.attempts).toBe(2)
      // And no growth: one row, one event, one application.
      expect(worker.harness.store.count()).toBe(1)
    } finally {
      worker.destroy()
    }
  })
})

describe("boundary 6 — crash at EffectBoundary.afterRuntimeAccept, before the ack commit", () => {
  it("the redelivery is IDEMPOTENT on eventId, and the controller applies nothing twice", async () => {
    const clock = new TestClock(at(0))
    const transport = new FakeTransport(clock.now)
    const worker = new RestartableOutbox(clock, transport)
    try {
      await worker.harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })

      // The peer HAS taken the effect, and the acknowledgement is NOT committed.
      // This is the ambiguous-delivery window and the one the plan names as the
      // dangerous one.
      const crashing = new RecordingBoundary("afterRuntimeAccept")
      await expect(worker.harness.deliverer({ boundary: crashing }).pumpOnce()).rejects.toThrow(/afterRuntimeAccept/)
      // It DID reach the wire — that is the whole point of this boundary.
      expect(transport.sentEventIds).toEqual([eventIdSchema.parse("evt-outbox-1")])

      const stranded = worker.harness.store.find("mevt-evt-outbox-1")
      expect(stranded?.status).toBe("sending")
      expect(stranded?.attempts).toBe(1)

      // The controller applied it before the crash — from its point of view the
      // event arrived, because it did.
      const controller = new RecordingController()
      await controller.ingest(aMeshEvent())
      expect(controller.applied).toHaveLength(1)

      // Restart and reclaim. The redelivery is unavoidable and harmless.
      worker.restart()
      clock.set(at(MESH_OUTBOX_CLAIM_LEASE_MS / 1000 + 1))
      const report = await worker.harness.deliverer().pumpOnce()
      expect(report.acknowledged).toBe(1)
      expect(transport.sentEventIds).toHaveLength(2)

      // The redelivery carries the SAME event id, and the controller dedupes on
      // it. This is the whole content of "both must be idempotent".
      const again = await controller.ingest(aMeshEvent())
      expect(again.ok && again.value.status).toBe("duplicate")
      expect(controller.applied, "no duplicate session").toHaveLength(1)
      expect(controller.ingestedEventIds).toEqual([eventIdSchema.parse("evt-outbox-1")])

      // No lost event, and no growth: the row is retired, not duplicated.
      expect(worker.harness.store.count()).toBe(1)
      expect(worker.harness.store.find("mevt-evt-outbox-1")?.status).toBe("acknowledged")
    } finally {
      worker.destroy()
    }
  })

  it("a redelivered event is refused as a DUPLICATE without even consulting the sequence tracker", async () => {
    // The order of the two ingestion checks is load-bearing. A duplicate must be
    // answered WITHOUT touching the tracker, because evaluating a resent event
    // through the sequence check would classify it as a gap once the watermark
    // had moved past it — which is exactly what happens after the very
    // redelivery the protocol requires to be harmless.
    const controller = new RecordingController()
    const ingestor = new MeshEventIngestor({ store: controller })

    expect((await ingestor.ingest(aMeshEvent({ localSequence: 1 }))).ok).toBe(true)
    const retry = await ingestor.ingest(aMeshEvent({ localSequence: 1 }))
    expect(retry.ok && retry.value.status).toBe("duplicate")
    // The tracker is untouched by the duplicate.
    expect(ingestor.trackerFor(WORKER).highestAccepted).toBe(1)
  })
})

describe("boundary 7 — crash AFTER the ack commit, BEFORE the pump returns", () => {
  it("the acknowledgement is durable, so nothing is redelivered", async () => {
    const clock = new TestClock(at(0))
    const transport = new FakeTransport(clock.now)
    const worker = new RestartableOutbox(clock, transport)
    try {
      await worker.harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      await worker.harness.deliverer().pumpOnce()
      expect(worker.harness.store.find("mevt-evt-outbox-1")?.status).toBe("acknowledged")
      expect(transport.sentEventIds).toHaveLength(1)

      // The process dies before it could report what it did. The ack is already
      // committed, so a restart must not touch the record.
      worker.restart()
      clock.advance(3600_000)
      for (let cycle = 0; cycle < 5; cycle += 1) {
        expect((await worker.harness.deliverer().pumpOnce()).claimed, `cycle ${cycle}`).toBe(0)
      }
      expect(transport.sentEventIds, "an acknowledged record is never redelivered").toHaveLength(1)
      expect(worker.harness.store.count(), "no unbounded growth").toBe(1)
    } finally {
      worker.destroy()
    }
  })
})

describe("boundary 8 — crash DURING ack persistence", () => {
  it("a write that did not commit leaves the record retryable, with attempts intact", async () => {
    const clock = new TestClock(at(0))
    const transport = new FakeTransport(clock.now)
    const worker = new RestartableOutbox(clock, transport)
    try {
      await worker.harness.outbox.enqueue({ event: aMeshEvent({ localSequence: 1 }), destination: CONTROLLER })
      await worker.harness.outbox.enqueue({
        event: aMeshEvent({ eventId: "evt-outbox-2", localSequence: 2, occurredAt: at(2) }),
        destination: CONTROLLER,
      })

      // A pump that dies after the FIRST ack is committed, mid-batch. The second
      // record is left `sending` by the same claim.
      const crashing = new RecordingBoundary(null)
      crashing.afterRuntimeAccept = (): void => {
        if (transport.sent.length >= 2) throw new Error("crash injected during ack persistence")
      }
      await expect(worker.harness.deliverer({ boundary: crashing }).pumpOnce()).rejects.toThrow(/ack persistence/)

      // The first is committed. The second is stranded, because the crash landed
      // between its claim and its acknowledgement.
      expect(worker.harness.store.find("mevt-evt-outbox-1")?.status).toBe("acknowledged")
      expect(worker.harness.store.find("mevt-evt-outbox-2")?.status).toBe("sending")
      expect(worker.harness.store.find("mevt-evt-outbox-2")?.attempts).toBe(1)

      // Restart, reclaim, and finish. The controller sees the FIRST event once
      // and the SECOND once — a partial batch is not a lost batch, and it is not a
      // duplicated one either.
      worker.restart()
      clock.set(at(MESH_OUTBOX_CLAIM_LEASE_MS / 1000 + 1))
      const controller = new RecordingController()
      const report = await worker.harness.deliverer().pumpOnce()
      expect(report.reclaimed).toEqual(["mevt-evt-outbox-2"])
      expect(report.claimed).toBe(1)

      await controller.ingest(aMeshEvent({ localSequence: 1 }))
      await controller.ingest(aMeshEvent({ eventId: "evt-outbox-2", localSequence: 2, occurredAt: at(2) }))
      expect(controller.applied).toHaveLength(2)
      expect(worker.harness.store.count(), "no unbounded growth").toBe(2)
      expect(worker.harness.store.find("mevt-evt-outbox-2")?.attempts).toBe(2)
    } finally {
      worker.destroy()
    }
  })
})

describe("a repeated crash at the same boundary still terminates", () => {
  it("a message that crashes every attempt reaches the threshold, not for ever", async () => {
    const clock = new TestClock(at(0))
    const transport = new FakeTransport(clock.now, "throw")
    const worker = new RestartableOutbox(clock, transport)
    try {
      await worker.harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      const crashing = new RecordingBoundary("beforeDeliver")

      // Eight crashes, one per attempt, with a restart between each. This is the
      // case a pump that reclaimed without counting would retry for ever.
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        const wake = await worker.harness.deliverer({ boundary: crashing }).nextWakeAtMs()
        if (wake !== null) clock.advance(wake)
        await expect(worker.harness.deliverer({ boundary: crashing }).pumpOnce()).rejects.toThrow()
        worker.restart()
        clock.advance(MESH_OUTBOX_CLAIM_LEASE_MS + 1)
        await worker.harness.deliverer().recoverOnStartup()
        // `attempts` survived every restart.
        expect(worker.harness.store.find("mevt-evt-outbox-1")?.attempts, `after crash ${attempt}`).toBe(attempt)
      }

      // A healthy process now: the transport comes back AND the boundary stops
      // throwing. Both are needed — the record has survived eight attempts, and
      // this asserts it is still DELIVERABLE rather than terminal, which is the
      // property that separates "the crash window is recoverable" from "the
      // record was written off".
      transport.setMode("accept")
      const healthy = new RecordingBoundary(null)
      const report = await worker.harness.deliverer({ boundary: healthy }).pumpOnce()
      expect(report.acknowledged).toBe(1)
      expect(worker.harness.store.find("mevt-evt-outbox-1")?.status).toBe("acknowledged")
      expect(transport.sentEventIds).toHaveLength(1)
    } finally {
      worker.destroy()
    }
  })
})

describe("a fresh database and a REOPENED one agree on every crash boundary", () => {
  it("the same crash sequence produces the same row count, attempt count and event count", async () => {
    // A divergence between a database that has just been opened and one that has
    // been closed and reopened is the defect this pairing exists to catch, and it
    // only shows up ACROSS a restart — a fresh connection would agree with itself.
    const outcomes: string[][] = []

    const runCrashSequence = async (restartable: boolean): Promise<string[]> => {
      const clock = new TestClock(at(0))
      const transport = new FakeTransport(clock.now)
      const worker = restartable ? new RestartableOutbox(clock, transport) : null
      const standalone = worker ? null : outboxHarness(clock, transport)
      // A FUNCTION for the restartable case, a captured seam for the fresh one.
      // `RestartableOutbox.harness` binds a store to the CURRENT connection, so
      // a captured one is a handle to a closed database after a restart — and the
      // failure that produces is a confusing "connection is closed" rather than
      // an assertion about durability. The fresh case has no such hazard and
      // needs the SAME seam every time, or each call would open another database.
      const seam = (): OutboxHarness => worker?.harness ?? standalone!
      try {
        await seam().outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
        const crashing = new RecordingBoundary("beforeDeliver")
        await expect(seam().deliverer({ boundary: crashing }).pumpOnce()).rejects.toThrow()
        worker?.restart()
        clock.set(at(MESH_OUTBOX_CLAIM_LEASE_MS / 1000 + 1))

        const controller = new RecordingController()
        const report = await seam().deliverer().pumpOnce()
        await controller.ingest(aMeshEvent())

        return [
          `claimed:${report.claimed}`,
          `acknowledged:${report.acknowledged}`,
          `reclaimed:${report.reclaimed.length}`,
          `attempts:${seam().store.find("mevt-evt-outbox-1")?.attempts}`,
          `status:${seam().store.find("mevt-evt-outbox-1")?.status}`,
          `rows:${seam().store.count()}`,
          `sent:${transport.sentEventIds.join(",")}`,
          `applied:${controller.applied.length}`,
        ]
      } finally {
        if (worker) worker.destroy()
        else standalone?.close()
      }
    }

    outcomes.push(await runCrashSequence(false))
    outcomes.push(await runCrashSequence(true))
    expect(outcomes[0], "a fresh and a reopened database disagree").toEqual(outcomes[1]!)
  })
})

/**
 * A controller-side ingest store that records what it applied.
 *
 * `applied` is the assertion target for "no duplicate session": a `MeshEventIngestor`
 * that applied the same event twice would be a second thing that happened, and
 * the whole at-least-once discipline converges on this array having one entry per
 * event rather than one per transmission.
 */
class RecordingController implements EventIngestStore {
  /** Every event actually applied, in order. One entry per EVENT, not per send. */
  readonly applied: MeshEvent[] = []
  readonly #seen = new Set<string>()
  /**
   * ONE ingestor for the controller's lifetime.
   *
   * A controller is a long-lived thing, and its sequence tracker is part of it.
   * A fresh ingestor per call would make every test in this file start its
   * watermark at zero, which turns "the second event was ingested" into "the
   * second event was refused as a gap" — a failure that looks like a convergence
   * bug and is really a fixture that forgot what a controller is.
   */
  readonly #ingestor: MeshEventIngestor

  constructor() {
    this.#ingestor = new MeshEventIngestor({ store: this })
  }

  /** The event ids this controller has ingested, applied or deduped. */
  get ingestedEventIds(): readonly string[] {
    return [...this.#seen]
  }

  async seen(eventId: EventId): Promise<{ ok: true; value: boolean }> {
    return { ok: true, value: this.#seen.has(eventId) }
  }

  async apply(event: MeshEvent): Promise<{ ok: true; value: undefined }> {
    this.#seen.add(event.eventId)
    this.applied.push(event)
    return { ok: true, value: undefined }
  }

  ingest(event: MeshEvent): Promise<Awaited<ReturnType<MeshEventIngestor["ingest"]>>> {
    return this.#ingestor.ingest(event)
  }
}

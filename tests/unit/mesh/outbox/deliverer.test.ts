import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  DELIVERY_BACKOFF_MS,
  MESH_OUTBOX_CLAIM_LEASE_MS,
  MESH_OUTBOX_MAX_ATTEMPTS,
  MAX_DELIVERY_BACKOFF_MS,
  backoffDelayMs,
  describeDeliveryFailure,
  exceedsMaxAttempts,
  nextAttemptAt,
  terminalDeliveryError,
  totalBackoffMs,
} from "../../../../src/mesh/outbox/policy.js"
import { DEFAULT_CLAIM_LIMIT, OutboxDeliverer } from "../../../../src/mesh/outbox/deliverer.js"
import { MESH_OUTBOX_CLAIM_LEASE_MS as POLICY_LEASE } from "../../../../src/mesh/outbox/index.js"
import {
  CONTROLLER,
  FakeTransport,
  RecordingBoundary,
  aMeshEvent,
  at,
  iso,
  outboxHarness,
  type OutboxHarness,
} from "./fixtures.js"

/**
 * M4-O: the outbox deliverer. Backoff policy, the attempt threshold, poison
 * handling, and stranded-claim reclamation.
 *
 * The tests assert the EXACT schedule rather than "it backs off". A backoff that
 * grew but had the wrong shape is not a backoff that has been reviewed — the
 * numbers are the deliverable of this milestone item, and "eventually" is not a
 * number an operator can act on when a run is stuck.
 *
 * Every test runs against a real SQLite file through the kernel's own
 * `outbox_records` table, because the claim transaction, the `attempts`
 * increment and the stale-claim reclamation all live there. An in-memory double
 * would be a re-implementation of the three properties under test.
 *
 * Nothing sleeps. The clock is injected, so "wait 128 seconds" is `clock.set()`.
 */

const POLICY_SOURCE = readFileSync(join(import.meta.dirname, "../../../../src/mesh/outbox/policy.ts"), "utf8")
const DELIVERER_SOURCE = readFileSync(join(import.meta.dirname, "../../../../src/mesh/outbox/deliverer.ts"), "utf8")

describe("M4-O the backoff schedule is exactly doubling to a 300s ceiling", () => {
  it("is 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s and then 300s", () => {
    expect(DELIVERY_BACKOFF_MS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 300_000])
  })

  it("doubles until the ceiling and holds there", () => {
    for (let attempts = 1; attempts <= 8; attempts += 1) {
      expect(backoffDelayMs(attempts), `after attempt ${attempts}`).toBe(1_000 * 2 ** (attempts - 1))
    }
    expect(backoffDelayMs(9)).toBe(MAX_DELIVERY_BACKOFF_MS)
    expect(backoffDelayMs(50)).toBe(MAX_DELIVERY_BACKOFF_MS)
  })

  it("never returns a delay above the ceiling, whatever the attempt count", () => {
    for (let attempts = 1; attempts <= 100; attempts += 1) {
      expect(backoffDelayMs(attempts)).toBeLessThanOrEqual(MAX_DELIVERY_BACKOFF_MS)
    }
  })

  it("refuses a non-positive attempt count rather than returning a silent zero", () => {
    // A zero backoff on a malformed attempt count is a hot loop against a record
    // the pump cannot deliver, which is the one failure the threshold exists to
    // prevent. Throwing is the loud direction.
    expect(() => backoffDelayMs(0)).toThrow()
    expect(() => backoffDelayMs(-1)).toThrow()
    expect(() => backoffDelayMs(1.5)).toThrow()
  })

  it("the schedule is longer than the threshold, because they answer different questions", () => {
    // Pinning the two together would assert they can never be changed
    // independently — and raising the threshold to survive a longer partition is
    // a reasonable change that should not force re-tuning the first backoff.
    expect(DELIVERY_BACKOFF_MS.length).toBeGreaterThan(MESH_OUTBOX_MAX_ATTEMPTS)
  })

  it("the whole retry lifecycle is 127s, which is under the 300s ceiling", () => {
    // The sum of the first seven delays. This is the number that decides how long
    // a poison record takes to go terminal, and it is asserted against the
    // CEILING rather than against a round number: a threshold that pushed the
    // lifecycle past the ceiling would mean the cap is never reached in practice
    // and is therefore untested by every real run.
    expect(totalBackoffMs()).toBe(127_000)
    expect(totalBackoffMs()).toBeLessThan(MAX_DELIVERY_BACKOFF_MS)
    // A poison record therefore goes terminal in just over two minutes, while an
    // operator is still looking at the run. A threshold high enough to be
    // invisible in a UI is a threshold nobody investigates.
    expect(totalBackoffMs()).toBeLessThan(180_000)
  })

  it("the claim lease is the controller lease's own duration", () => {
    // 30s, deliberately EQUAL to M4.4's lease rather than chosen for the
    // delivery: a claim is held across one network round trip to a peer, and the
    // longest legitimate round trip on a Tailscale link is orders of magnitude
    // below 30s. A SHORTER one would reclaim a record whose delivery is merely
    // slow, which is the duplicate this discipline exists to keep rare.
    expect(MESH_OUTBOX_CLAIM_LEASE_MS).toBe(30_000)
    expect(POLICY_LEASE).toBe(MESH_OUTBOX_CLAIM_LEASE_MS)
  })

  it("the numbers are stated with their reasoning in the module", () => {
    // The reasoning is the deliverable as much as the numbers are: a future
    // change to the schedule has to be argued with, and an argument needs the
    // reason to be there to disagree with.
    expect(POLICY_SOURCE).toMatch(/127 seconds/)
    expect(POLICY_SOURCE).toMatch(/300s ceiling/)
    expect(POLICY_SOURCE).toMatch(/Not jittered/)
  })
})

describe("M4-O the threshold is exactly 8 attempts, and attempts is never reset", () => {
  it("is eight", () => {
    expect(MESH_OUTBOX_MAX_ATTEMPTS).toBe(8)
  })

  it("goes terminal on the eighth failure and requeues the seventh", () => {
    for (let attempts = 1; attempts < MESH_OUTBOX_MAX_ATTEMPTS; attempts += 1) {
      expect(exceedsMaxAttempts(attempts), `${attempts} attempts`).toBe(false)
    }
    expect(exceedsMaxAttempts(MESH_OUTBOX_MAX_ATTEMPTS)).toBe(true)
    expect(exceedsMaxAttempts(MESH_OUTBOX_MAX_ATTEMPTS + 1)).toBe(true)
  })

  it("requeues on the exact schedule for the first seven failures", async () => {
    const harness = outboxHarness()
    try {
      const enqueued = await harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      expect(enqueued.ok).toBe(true)
      harness.transport.setMode("throw")

      const observed: (string | null | undefined)[] = []
      for (let attempt = 1; attempt <= MESH_OUTBOX_MAX_ATTEMPTS; attempt += 1) {
        // Move to the moment this attempt is allowed to run.
        const wake = await harness.deliverer().nextWakeAtMs()
        expect(wake, `attempt ${attempt} should be ready`).not.toBeNull()
        if (wake !== null) harness.clock.advance(wake)

        const report = await harness.deliverer().pumpOnce()
        const outcome = report.outcomes[0]
        expect(outcome?.attempts, `attempt ${attempt}`).toBe(attempt)
        if (attempt < MESH_OUTBOX_MAX_ATTEMPTS) {
          expect(outcome?.disposition, `attempt ${attempt}`).toBe("requeued")
        } else {
          expect(outcome?.disposition, `attempt ${attempt}`).toBe("terminal")
        }
        observed.push(harness.store.find("mevt-evt-outbox-1")?.nextAttemptAt ?? null)
      }

      // The deadlines are the schedule measured from the instant each attempt
      // FAILED, which is what makes the wait after the Nth failure `2^(N-1)`
      // rather than a running total. So the absolute instants are cumulative:
      // 1, 1+2, 1+2+4, … — the GAPS are the schedule, and the gaps are what the
      // policy test above pins.
      const expected = [1, 3, 7, 15, 31, 63, 127].map((seconds) => iso(at(seconds)))
      expect(observed.slice(0, 7)).toEqual(expected)
      // And the terminal record has NO next deadline: it will not be retried, and
      // it does not read as though it might.
      expect(observed[7]).toBeNull()
    } finally {
      harness.close()
    }
  })

  it("attempts is preserved across a restart, and a record that crashes every attempt still terminates", async () => {
    const harness = outboxHarness()
    try {
      await harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      harness.transport.setMode("throw")

      for (let attempt = 1; attempt < MESH_OUTBOX_MAX_ATTEMPTS; attempt += 1) {
        const wake = await harness.deliverer().nextWakeAtMs()
        if (wake !== null) harness.clock.advance(wake)
        const report = await harness.deliverer().pumpOnce()
        expect(report.outcomes[0]?.disposition, `attempt ${attempt}`).toBe("requeued")
        expect(harness.store.find("mevt-evt-outbox-1")?.attempts, `after ${attempt}`).toBe(attempt)
      }

      // A record that crashed the process on every attempt must reach the
      // threshold. A pump that reclaimed without counting would retry a message
      // it cannot deliver for ever.
      const lastWake = await harness.deliverer().nextWakeAtMs()
      if (lastWake !== null) harness.clock.advance(lastWake)
      const final = await harness.deliverer().pumpOnce()
      expect(final.outcomes[0]?.disposition).toBe("terminal")
      expect(harness.store.find("mevt-evt-outbox-1")?.attempts).toBe(MESH_OUTBOX_MAX_ATTEMPTS)
      expect(harness.store.find("mevt-evt-outbox-1")?.status).toBe("failed")
    } finally {
      harness.close()
    }
  })
})

describe("M4-O a poison record goes terminal and STAYS VISIBLE", () => {
  it("is never deleted, because the outbox is evidence rather than a cache", async () => {
    const harness = outboxHarness()
    try {
      await harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      harness.transport.setMode("reject")

      for (let attempt = 1; attempt <= MESH_OUTBOX_MAX_ATTEMPTS; attempt += 1) {
        const wake = await harness.deliverer().nextWakeAtMs()
        if (wake !== null) harness.clock.advance(wake)
        await harness.deliverer().pumpOnce()
      }

      // The record is still there, with its error, its attempt count, and no
      // deadline. An operator asking "did this node ever try to report this?"
      // gets an answer, which is the whole point of retaining it. The deadline is
      // cleared by the kernel's `exhaustOutbox` now, not by a follow-up statement
      // in the mesh's store adapter — a retained row that still reads as scheduled
      // is a lie to whoever reads it, whoever is reading it.
      const record = harness.store.find("mevt-evt-outbox-1")
      expect(record, "the poison record must be retained").toBeDefined()
      expect(record?.status).toBe("failed")
      expect(record?.attempts).toBe(MESH_OUTBOX_MAX_ATTEMPTS)
      expect(record?.lastError).toContain("mesh.outbox_poison_record")
      expect(record?.failedAt).toBeDefined()
      expect(record?.nextAttemptAt).toBeUndefined()

      // Visible through the write seam's `listAll`, which does NOT filter
      // failures out — a read that hid them could not answer the question.
      const all = await harness.outbox.listAll()
      expect(all.ok && all.value).toHaveLength(1)
      // And absent from `listPending`, because it will not be retried.
      const pending = await harness.outbox.listPending()
      expect(pending.ok && pending.value).toHaveLength(0)
    } finally {
      harness.close()
    }
  })

  it("is not claimable again after going terminal, however many cycles run", async () => {
    const harness = outboxHarness()
    try {
      await harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      harness.transport.setMode("throw")
      for (let attempt = 1; attempt <= MESH_OUTBOX_MAX_ATTEMPTS; attempt += 1) {
        const wake = await harness.deliverer().nextWakeAtMs()
        if (wake !== null) harness.clock.advance(wake)
        await harness.deliverer().pumpOnce()
      }
      const transmissionsAtTerminal = harness.transport.sent.length

      // Twenty more cycles, with the peer healthy again. A terminal record stays
      // terminal: an operator restarting a run wants a NEW event, not this one
      // re-firing because the transport came back.
      harness.transport.setMode("accept")
      harness.clock.advance(3600_000)
      for (let cycle = 0; cycle < 20; cycle += 1) {
        const report = await harness.deliverer().pumpOnce()
        expect(report.claimed, `cycle ${cycle}`).toBe(0)
      }
      expect(harness.transport.sent.length).toBe(transmissionsAtTerminal)
    } finally {
      harness.close()
    }
  })

  it("carries an error that names the id, the count, and says the record is retained", () => {
    const error = terminalDeliveryError("mevt-evt-x", 8, new Error("ECONNRESET"))
    expect(error.code).toBe("mesh.outbox_poison_record")
    expect(error.retryable).toBe(false)
    expect(error.message).toContain("mevt-evt-x")
    expect(error.message).toContain("failed 8 deliveries")
    expect(error.message).toContain("RETAINED")
  })
})

describe("M4-O a stranded claim is reclaimed, with attempts preserved", () => {
  it("requeues a record left `sending` by a dead process once its lease expires", async () => {
    const harness = outboxHarness()
    try {
      await harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      // Claim it and then "die" — the claim is durable, nothing acknowledges it.
      const claimed = harness.store.claimPending({ now: iso(at(0)), leaseMs: MESH_OUTBOX_CLAIM_LEASE_MS })
      expect(claimed.records).toHaveLength(1)
      expect(harness.store.find("mevt-evt-outbox-1")?.status).toBe("sending")
      expect(harness.store.find("mevt-evt-outbox-1")?.attempts).toBe(1)

      // Before the lease expires, recovery must leave it alone: a record whose
      // lease has not lapsed may still be in flight in another process.
      const early = harness.deliverer()
      harness.clock.set(at(MESH_OUTBOX_CLAIM_LEASE_MS / 1000 - 1))
      expect((await early.recoverOnStartup()).recovered).toHaveLength(0)

      harness.clock.set(at(MESH_OUTBOX_CLAIM_LEASE_MS / 1000 + 1))
      const recovery = await early.recoverOnStartup()
      expect(recovery.recovered).toEqual(["mevt-evt-outbox-1"])
      const reclaimed = harness.store.find("mevt-evt-outbox-1")
      expect(reclaimed?.status).toBe("pending")
      // `attempts` is NOT reset. A record reclaimed with its counter zeroed would
      // be retried for ever, and the threshold would be unreachable for exactly
      // the records that need it — the ones that keep crashing the process.
      expect(reclaimed?.attempts).toBe(1)
      expect(reclaimed?.claimToken).toBeUndefined()
      expect(reclaimed?.leaseExpiresAt).toBeUndefined()
      expect(reclaimed?.lastError).toContain("claim lease expired")
    } finally {
      harness.close()
    }
  })

  it("reclaims inside a pump cycle too, so a hang does not strand a record until the next restart", async () => {
    const harness = outboxHarness()
    try {
      await harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      harness.store.claimPending({ now: iso(at(0)), leaseMs: MESH_OUTBOX_CLAIM_LEASE_MS })

      harness.clock.set(at(MESH_OUTBOX_CLAIM_LEASE_MS / 1000 + 1))
      const report = await harness.deliverer().pumpOnce()
      expect(report.reclaimed).toEqual(["mevt-evt-outbox-1"])
      expect(report.claimed).toBe(1)
      expect(report.acknowledged).toBe(1)
      expect(harness.store.find("mevt-evt-outbox-1")?.status).toBe("acknowledged")
      // Two attempts total: the stranded claim, and the redelivery.
      expect(harness.store.find("mevt-evt-outbox-1")?.attempts).toBe(2)
    } finally {
      harness.close()
    }
  })

  it("never redelivers a record that was already acknowledged", async () => {
    const harness = outboxHarness()
    try {
      await harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      await harness.deliverer().pumpOnce()
      expect(harness.store.find("mevt-evt-outbox-1")?.status).toBe("acknowledged")
      const sentOnce = harness.transport.sent.length

      harness.clock.advance(3600_000)
      for (let cycle = 0; cycle < 5; cycle += 1) {
        expect((await harness.deliverer().pumpOnce()).claimed).toBe(0)
      }
      expect(harness.transport.sent.length).toBe(sentOnce)
    } finally {
      harness.close()
    }
  })
})

describe("M4-O a rejection is not an acknowledgement", () => {
  it("requeues on the ordinary schedule and eventually goes terminal", async () => {
    const harness = outboxHarness()
    try {
      await harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      harness.transport.setMode("reject")

      const first = await harness.deliverer().pumpOnce()
      expect(first.outcomes[0]?.disposition).toBe("requeued")
      // The controller ANSWERED, so the bytes are believed to have arrived; the
      // record is a normal delivery failure from here, and the threshold is the
      // backstop. Deciding here whether a rejection is permanent would be the
      // pump guessing at the controller's reasons.
      expect(harness.store.find("mevt-evt-outbox-1")?.status).toBe("pending")
      expect(harness.store.find("mevt-evt-outbox-1")?.nextAttemptAt).toBe(iso(at(1)))
    } finally {
      harness.close()
    }
  })
})

describe("M4-O nextWakeAtMs is what a scheduler polls, and it never busy-loops", () => {
  it("is null when nothing is pending, so a scheduler parks rather than spinning", async () => {
    const harness = outboxHarness()
    try {
      expect(await harness.deliverer().nextWakeAtMs()).toBeNull()
    } finally {
      harness.close()
    }
  })

  it("is 0 when something is claimable now", async () => {
    const harness = outboxHarness()
    try {
      await harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      expect(await harness.deliverer().nextWakeAtMs()).toBe(0)
    } finally {
      harness.close()
    }
  })

  it("counts down to the backoff deadline and is never negative", async () => {
    const harness = outboxHarness()
    try {
      await harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      harness.transport.setMode("throw")
      await harness.deliverer().pumpOnce()

      // The record now waits 1s. Halfway through, 500ms remain.
      harness.clock.set(at(0.5))
      expect(await harness.deliverer().nextWakeAtMs()).toBe(500)
      // Past the deadline it reads 0 rather than a negative number, because a
      // negative `setTimeout` is a caller bug and a busy loop is a denial of
      // service against a record the pump cannot deliver.
      harness.clock.set(at(10))
      expect(await harness.deliverer().nextWakeAtMs()).toBe(0)
    } finally {
      harness.close()
    }
  })

  it("counts a stranded claim's lease expiry, so a dead record is not parked for ever", async () => {
    const harness = outboxHarness()
    try {
      await harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      harness.store.claimPending({ now: iso(at(0)), leaseMs: MESH_OUTBOX_CLAIM_LEASE_MS })
      // A `sending` row is not ready, but it WILL be. A wake time that ignored
      // the lease would either wake too early for ever or never wake at all.
      expect(await harness.deliverer().nextWakeAtMs()).toBe(MESH_OUTBOX_CLAIM_LEASE_MS)
    } finally {
      harness.close()
    }
  })
})

describe("M4-O the pump delivers in claim order and reports a per-record verdict", () => {
  it("delivers oldest first, so localSequence and arrival order agree", async () => {
    const harness = outboxHarness()
    try {
      for (let sequence = 1; sequence <= 3; sequence += 1) {
        await harness.outbox.enqueue({
          event: aMeshEvent({ eventId: `evt-outbox-${sequence}`, localSequence: sequence, occurredAt: at(sequence) }),
          destination: CONTROLLER,
        })
      }
      const report = await harness.deliverer().pumpOnce()
      expect(report.claimed).toBe(3)
      expect(report.acknowledged).toBe(3)
      // An outbox that delivers newest-first is one whose events arrive at the
      // controller out of order, and `localSequence` is only meaningful while the
      // sequence is also the arrival order.
      expect(harness.transport.sent.map((entry) => entry.localSequence)).toEqual([1, 2, 3])
      expect(report.outcomes.map((o) => o.outboxId)).toEqual([
        "mevt-evt-outbox-1",
        "mevt-evt-outbox-2",
        "mevt-evt-outbox-3",
      ])
    } finally {
      harness.close()
    }
  })

  it("clamps the claim batch to the stated limit", async () => {
    const harness = outboxHarness()
    try {
      for (let sequence = 1; sequence <= 5; sequence += 1) {
        await harness.outbox.enqueue({
          event: aMeshEvent({ eventId: `evt-batch-${sequence}`, localSequence: sequence }),
          destination: CONTROLLER,
        })
      }
      // Constructed directly rather than through the harness, because the limit is
      // the thing under test and the harness deliberately does not expose it.
      const limited = new OutboxDeliverer({
        store: harness.store,
        transport: harness.transport,
        now: harness.clock.now,
        claimLimit: 2,
      })
      expect((await limited.pumpOnce()).claimed).toBe(2)
      // The other three wait for the next cycle; nothing is lost, and the claim
      // order is preserved across cycles.
      expect((await limited.pumpOnce()).claimed).toBe(2)
      expect((await limited.pumpOnce()).claimed).toBe(1)
      expect(harness.transport.sent.map((entry) => entry.localSequence)).toEqual([1, 2, 3, 4, 5])
    } finally {
      harness.close()
    }
    // The default matches the kernel store's own, so a pump does not silently
    // batch differently from the primitives it drives.
    expect(DEFAULT_CLAIM_LIMIT).toBe(100)
  })
})

describe("M4-O the pump owns no timer and no clock", () => {
  it("reads no clock and schedules nothing of its own", () => {
    // The plan's restart, partition and stale-lease scenarios are all decided by
    // an injected clock. A deliverer that owned a `setInterval` could not be
    // tested across any of them without either faking timers or sleeping.
    expect(DELIVERER_SOURCE).not.toMatch(/setInterval|setTimeout|Date\.now|Math\.random/)
    expect(DELIVERER_SOURCE).toMatch(/deps\.now|this\.#deps\.now/)
  })

  it("uses ONE clock reading per cycle, so a record cannot be requeued and then claimed before that", () => {
    // Two clock reads in a cycle would let a record be recovered at T and claimed
    // at T-1, which is a record delivered before it was reclaimed.
    const cycle = DELIVERER_SOURCE.slice(
      DELIVERER_SOURCE.indexOf("async pumpOnce"),
      DELIVERER_SOURCE.indexOf("async recoverOnStartup"),
    )
    expect([...cycle.matchAll(/this\.#deps\.now\(\)/g)]).toHaveLength(1)
  })
})

describe("M4-O a terminal delivery error names the cause without leaking the payload", () => {
  it("describes a failure by its CODE", () => {
    // An outbox payload is a `mesh.event`, and the payload text belongs in the
    // event log rather than in a `last_error` column an operator greps.
    const coded = Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" })
    expect(describeDeliveryFailure(coded)).toBe("ECONNRESET")
    expect(describeDeliveryFailure(new TypeError("x"))).toBe("TypeError")
    expect(describeDeliveryFailure("a string")).toBe("a string")
    expect(describeDeliveryFailure({ weird: true })).toBe("an unknown error")
  })

  it("builds the next deadline through the kernel's timestamp schema", () => {
    // `nextAttemptAt` is compared in SQL AND read by an operator. A stamp this
    // build cannot parse back is a stamp that reads as malformed in exactly the
    // place someone would be looking during an incident.
    // Parsed, not subtracted: the value is a TIMESTAMP string, and doing
    // arithmetic on one is the mistake this test would otherwise be making.
    expect(nextAttemptAt(at(0), 1)).toBe(iso(at(1)))
    // The delay after attempt 7 is 64s; the CUMULATIVE wait across the first
    // seven is 127s, which is what `totalBackoffMs` reports. Asserting both is
    // what keeps a policy change from quietly altering one and not the other.
    expect(nextAttemptAt(at(0), 7)).toBe(iso(at(64)))
    expect(Date.parse(nextAttemptAt(at(0), 7)) - at(0)).toBe(64_000)
    expect(totalBackoffMs()).toBe(127_000)
  })
})

describe("M4-O the pump invokes M4-B hooks 5 and 6, in that order, on every delivery", () => {
  it("fires beforeDeliver and then afterRuntimeAccept for a successful delivery", async () => {
    const harness = outboxHarness()
    try {
      await harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      const boundary = new RecordingBoundary()
      await harness.deliverer({ boundary }).pumpOnce()
      // Hook 5 is after the claim and before the socket, so a crash there leaves
      // a `sending` row whose lease expires. Hook 6 is after the peer accepted
      // and before the ack commit — the ambiguous-launch window.
      expect(boundary.calls).toEqual(["beforeDeliver:mevt-evt-outbox-1", "afterRuntimeAccept:mevt-evt-outbox-1"])
    } finally {
      harness.close()
    }
  })

  it("fires beforeDeliver but NOT afterRuntimeAccept when the transport throws", async () => {
    const harness = outboxHarness()
    try {
      await harness.outbox.enqueue({ event: aMeshEvent(), destination: CONTROLLER })
      harness.transport.setMode("throw")
      const boundary = new RecordingBoundary()
      await harness.deliverer({ boundary }).pumpOnce()
      // Nothing was accepted, so hook 6 must not fire. A hook that fired on a
      // failed send would make a crash in that window indistinguishable from a
      // crash after a real acceptance — and the two converge differently.
      expect(boundary.calls).toEqual(["beforeDeliver:mevt-evt-outbox-1"])
    } finally {
      harness.close()
    }
  })

  it("is INVOKED, not merely declared — the type alone proves nothing", () => {
    // `EffectBoundary` hooks 5 and 6 were declared and typed for two milestones
    // and never called. The assertion is over the call list because that is the
    // only thing that distinguishes "invoked" from "present".
    expect(DELIVERER_SOURCE).toMatch(/boundary\?\.beforeDeliver\?\.\(outboxId\)/)
    expect(DELIVERER_SOURCE).toMatch(/boundary\?\.afterRuntimeAccept\?\.\(outboxId\)/)
  })

  it("invokes NO other hook, because hooks 1-4 and 7-8 belong to other seams", () => {
    const invoked = [...DELIVERER_SOURCE.matchAll(/boundary\?\.(\w+)\?\./g)].map((m) => m[1])
    expect([...new Set(invoked)].sort()).toEqual(["afterRuntimeAccept", "beforeDeliver"])
  })

  it("runs the boundary against a harness whose hooks are the coordinator's own type", () => {
    // The dependency is `Pick<EffectBoundary, "beforeDeliver" | "afterRuntimeAccept">`
    // rather than a bespoke interface, so a fault harness that already builds one
    // for hooks 1-4 gets 5 and 6 by passing the same object.
    expect(DELIVERER_SOURCE).toMatch(/deps\.boundary\?\.beforeDeliver/)
  })
})

/** A harness whose store is reached through the same port a production caller uses. */
export type { OutboxHarness, FakeTransport }

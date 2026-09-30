import { describe, expect, it } from "vitest"
import { CONTROLLER_B, LEASE_1, LEASE_2, OTHER_RUN_ID, PROJECT_ID, RUN_ID, WORKER_1 } from "./fixtures.js"
import { leaseIdSchema } from "../../../../src/orchestration/identifiers.js"
import type { LeaseRecord } from "../../../../src/mesh/lease/schemas.js"
import {
  EPOCH_1,
  EPOCH_2,
  TestClock,
  at,
  bothLeaseHarnesses,
  claimAt,
  claimEnvelope,
  durableLeaseHarness,
  iso,
  leaseEnvelope,
  memoryLeaseHarness,
  releaseEnvelope,
  renewEnvelope,
  scopeFor,
  storedLease,
  takeoverEnvelope,
} from "./fixtures.js"

/**
 * Claim, renew, release.
 *
 * Run against BOTH store implementations, because the in-memory store is the
 * specification the durable one has to match and a semantic that lives in only one
 * of them is a semantic that will disagree in production.
 */
describe("M4.4 a claim takes an unheld run and is durable", () => {
  for (const { label, make } of bothLeaseHarnesses()) {
    describe(label, () => {
      it("stores the lease with every field the takeover audit has to read back", async () => {
        const harness = make(new TestClock(at(0)))
        try {
          const claimed = await claimAt(harness, { leaseId: LEASE_1 })
          expect(claimed.outcome).toBe("accepted")

          const stored = await storedLease(harness)
          expect(stored).toMatchObject({
            leaseId: LEASE_1,
            projectId: PROJECT_ID,
            runId: RUN_ID,
            controllerNodeId: "node-controller-a",
            epoch: EPOCH_1,
            operation: "claim",
            durationSeconds: 30,
            issuedAt: iso(at(0)),
            expiresAt: iso(at(30)),
            // Nullable, not absent: "a claim named no predecessor" and "the
            // predecessor was dropped by a bug" must not read the same.
            predecessorLeaseId: null,
            predecessorEpoch: null,
            takeoverReason: null,
            acknowledgedUnreconciledNodeIds: [],
            recordedAt: at(0),
          })
        } finally {
          harness.close()
        }
      })

      it("refuses a second claim that repeats the epoch of a LIVE lease, and names the holder", async () => {
        const harness = make(new TestClock(at(5)))
        try {
          await claimAt(harness, { leaseId: LEASE_1 })
          const second = await harness.lease.claim(
            claimEnvelope({ leaseId: LEASE_2, controllerNodeId: "node-controller-b", epoch: EPOCH_1 }),
          )
          expect(second.outcome).toBe("refused")
          if (second.outcome !== "refused") return
          expect(second.reason).toBe("held_by_another_controller")
          // Decided by `evaluateLease`'s epoch check, which is the one place this
          // rule lives now. It used to be asserted a second time in the operation
          // switch, where it was unreachable and free to drift from the copy that
          // actually ran.
          expect(second.error.code).toBe("lease.already_held")
          // Refused as a repeat of the SAME epoch, and the message says so rather
          // than implying the run is simply taken. The distinction is the
          // operator's next action: a claim at the same epoch has to become a
          // takeover to acquire anything, and a claim at a higher epoch is
          // refused as the automatic election the plan forbids.
          expect(second.error.message).toMatch(/does not raise the epoch/)
          // And the refusal names the epoch in force, so an operator reading the
          // log can tell which claim they are looking at.
          expect(second.error.message).toContain("epoch 1")
          // And nothing was written: the refusal is before the write, so the
          // stored lease is still the first one.
          expect((await storedLease(harness))?.leaseId).toBe(LEASE_1)
        } finally {
          harness.close()
        }
      })

      it("refuses a claim that tries to RAISE the epoch, because that is the takeover's job alone", async () => {
        // A second, distinct guard from the one above, and the one the plan's
        // "do not accept a higher controller epoch without the explicit takeover
        // flow" guardrail is about. Same-epoch is "you already hold it"; higher is
        // "you are trying to take it", and only the takeover answers that.
        const harness = make(new TestClock(at(5)))
        try {
          await claimAt(harness, { leaseId: LEASE_1 })
          const second = await harness.lease.claim(
            claimEnvelope({ leaseId: LEASE_2, controllerNodeId: "node-controller-b", epoch: EPOCH_2 }),
          )
          expect(second.outcome).toBe("refused")
          if (second.outcome !== "refused") return
          expect(second.reason).toBe("epoch_unregistered")
          expect(second.error.code).toBe("epoch.unregistered")
          expect((await storedLease(harness))?.epoch).toBe(EPOCH_1)
        } finally {
          harness.close()
        }
      })

      it("scopes the lease to one run, so a claim for another run does not disturb this one", async () => {
        const harness = make(new TestClock(at(0)))
        try {
          await claimAt(harness, { leaseId: LEASE_1 })
          const other = await harness.lease.claim(claimEnvelope({ leaseId: LEASE_2, runId: OTHER_RUN_ID, epoch: EPOCH_1 }))
          expect(other.outcome).toBe("accepted")
          expect((await storedLease(harness, scopeFor(RUN_ID)))?.leaseId).toBe(LEASE_1)
          expect((await storedLease(harness, scopeFor(OTHER_RUN_ID)))?.leaseId).toBe(LEASE_2)
        } finally {
          harness.close()
        }
      })

      it("records the claim in the audit trail, so a later takeover has something to point at", async () => {
        const harness = make(new TestClock(at(0)))
        try {
          await claimAt(harness, { leaseId: LEASE_1 })
          const history = await harness.store.leaseHistory(scopeFor())
          expect(history.ok && history.value).toHaveLength(1)
          expect(history.ok && history.value[0]).toMatchObject({ leaseId: LEASE_1, epoch: EPOCH_1, operation: "claim" })
        } finally {
          harness.close()
        }
      })

      it("converges on a redelivered claim rather than duplicating the audit row", async () => {
        const harness = make(new TestClock(at(0)))
        try {
          await claimAt(harness, { leaseId: LEASE_1 })
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const again = await harness.lease.claim(claimEnvelope({ leaseId: LEASE_1 }))
            // A redelivered lease record is the ordinary case after a partition
            // heal. Whether it is `accepted` or `refused` does not matter here;
            // what matters is that neither the authority nor the audit trail
            // gained a second copy.
            expect(["accepted", "refused"]).toContain(again.outcome)
          }
          const history = await harness.store.leaseHistory(scopeFor())
          expect(history.ok && history.value).toHaveLength(1)
          expect((await storedLease(harness))?.leaseId).toBe(LEASE_1)
        } finally {
          harness.close()
        }
      })
    })
  }
})

describe("M4.4 renewal extends without changing the epoch", () => {
  for (const { label, make } of bothLeaseHarnesses()) {
    describe(label, () => {
      it("moves expiresAt forward and leaves epoch, leaseId and controller untouched", async () => {
        const clock = new TestClock(at(20))
        const harness = make(clock)
        try {
          await claimAt(harness, { leaseId: LEASE_1 })
          const renewed = await harness.lease.renew(
            renewEnvelope({ leaseId: LEASE_1, issuedAt: iso(at(20)), expiresAt: iso(at(50)), durationSeconds: 30 }),
          )
          expect(renewed.outcome).toBe("accepted")
          if (renewed.outcome !== "accepted") return
          expect(renewed.standing).toBe("current")
          expect(renewed.permitsNewWork).toBe(true)

          const stored = await storedLease(harness)
          expect(stored).toMatchObject({
            leaseId: LEASE_1,
            epoch: EPOCH_1,
            controllerNodeId: "node-controller-a",
            operation: "renew",
            expiresAt: iso(at(50)),
          })
        } finally {
          harness.close()
        }
      })

      it("refuses a renewal of a lease this node does not hold at all", async () => {
        // Its own reason, not the release's: "there is nothing to release" reads
        // as though the caller had given something up, and the remedy for a lost
        // lease is reconciliation rather than a release.
        const harness = make(new TestClock(at(0)))
        try {
          const renewed = await harness.lease.renew(renewEnvelope({ leaseId: LEASE_1 }))
          expect(renewed.outcome).toBe("refused")
          if (renewed.outcome !== "refused") return
          expect(renewed.reason).toBe("no_lease_to_renew")
          expect((await storedLease(harness))).toBeNull()
        } finally {
          harness.close()
        }
      })

      it("refuses a renewal naming a lease this node does not hold", async () => {
        const harness = make(new TestClock(at(5)))
        try {
          await claimAt(harness, { leaseId: LEASE_1 })
          const foreign = await harness.lease.renew(
            renewEnvelope({ leaseId: LEASE_2, issuedAt: iso(at(5)), expiresAt: iso(at(35)), durationSeconds: 30 }),
          )
          expect(foreign.outcome).toBe("refused")
          if (foreign.outcome !== "refused") return
          expect(foreign.reason).toBe("predecessor_mismatch")
          expect((await storedLease(harness))?.operation).toBe("claim")
        } finally {
          harness.close()
        }
      })

      it("refuses a renewal routed through a method whose operation it does not carry", async () => {
        // `claim()` and `applyLease()` are different entry points, and a takeover
        // smuggled through the claim path would be evaluated under the claim's
        // rules — which are not the takeover's.
        const clock = new TestClock(at(0))
        const harness = make(clock)
        try {
          await claimAt(harness, { leaseId: LEASE_1 })
          const mismatched = await harness.lease.claim(
            takeoverEnvelope({ leaseId: LEASE_2, epoch: EPOCH_2, acknowledgedUnreconciledNodeIds: [WORKER_1] }),
          )
          expect(mismatched.outcome).toBe("refused")
          if (mismatched.outcome !== "refused") return
          expect(mismatched.reason).toBe("record_unreadable")
          expect(mismatched.error.code).toBe("lease.operation_mismatch")
          expect((await storedLease(harness))?.epoch).toBe(EPOCH_1)
        } finally {
          harness.close()
        }
      })
    })
  }
})

describe("M4.4 release is accepted and grants nothing", () => {
  for (const { label, make } of bothLeaseHarnesses()) {
    describe(label, () => {
      it("is accepted, reports permitsNewWork false, and leaves the record in place", async () => {
        const clock = new TestClock(at(5))
        const harness = make(clock)
        try {
          await claimAt(harness, { leaseId: LEASE_1 })
          const released = await harness.lease.release(releaseEnvelope({ leaseId: LEASE_1 }))
          expect(released.outcome).toBe("accepted")
          if (released.outcome !== "accepted") return
          // The field is on the accepted outcome specifically so a release cannot
          // be read as a renewal. Reporting it as `true` would let the operator's
          // "hand the run over" look like "keep driving it".
          expect(released.permitsNewWork).toBe(false)

          // The record is NOT deleted. Deleting it would raise the run's "no
          // lease" state to a fresh claim at epoch 1, which is a rewind of the
          // authority order; keeping it means the epoch in force is still the one
          // every other node is fenced against.
          const stored = await storedLease(harness)
          expect(stored?.operation).toBe("release")
          expect(stored?.epoch).toBe(EPOCH_1)
        } finally {
          harness.close()
        }
      })

      it("refuses a release of a lease this node does not hold", async () => {
        const harness = make(new TestClock(at(0)))
        try {
          const released = await harness.lease.release(releaseEnvelope({ leaseId: LEASE_1 }))
          expect(released.outcome).toBe("refused")
          if (released.outcome !== "refused") return
          expect(released.reason).toBe("no_lease_to_release")
          expect((await storedLease(harness))).toBeNull()
        } finally {
          harness.close()
        }
      })
    })
  }
})

/**
 * The stored form of a takeover superseding `predecessor`.
 *
 * Written out rather than produced by a helper on the seam, because these tests
 * drive the STORE port and the seam's whole job on this path is to refuse; a
 * fixture that went through the seam could not reach the race at all.
 */
function takeoverRecord(predecessor: LeaseRecord, leaseId: string): LeaseRecord {
  return {
    ...predecessor,
    // Branded through the kernel's schema rather than cast: the store is the one
    // place that must not accept an id it could not join on.
    leaseId: leaseIdSchema.parse(leaseId),
    controllerNodeId: CONTROLLER_B,
    epoch: EPOCH_2,
    operation: "takeover",
    issuedAt: iso(at(1)),
    expiresAt: iso(at(31)),
    durationSeconds: 30,
    predecessorLeaseId: predecessor.leaseId,
    predecessorEpoch: predecessor.epoch,
    takeoverReason: "operator moved control after inspecting the degraded nodes",
    acknowledgedUnreconciledNodeIds: [WORKER_1],
    recordedAt: at(1),
  }
}

describe("M4.4 the store's compare-and-set is the fencing mechanism", () => {
  it("refuses a write whose expected epoch is not the epoch in force, and reports the current one", async () => {
    // Driven through the STORE port directly, because the point is the transaction
    // and the seam above it would (correctly) refuse the record before it got
    // there. Two controllers taking over from the same epoch is the race this
    // exists for.
    const clock = new TestClock(at(0))
    const memory = memoryLeaseHarness(clock)
    const durable = durableLeaseHarness(clock)
    try {
      for (const harness of [memory, durable]) {
        await claimAt(harness, { leaseId: LEASE_1 })
        const current = await storedLease(harness)
        expect(current).not.toBeNull()
        if (current === null) continue

        const staleWrite = await harness.store.writeLease({
          scope: scopeFor(),
          record: { ...current, leaseId: LEASE_2, epoch: EPOCH_2, recordedAt: at(1) },
          // The epoch the writer READ, which is no longer the one stored.
          expectedEpoch: EPOCH_1 - 1,
        })
        expect(staleWrite.ok && staleWrite.value.written).toBe(false)
        expect(staleWrite.ok && !staleWrite.value.written && staleWrite.value.current?.epoch).toBe(EPOCH_1)
      }
    } finally {
      memory.close()
      durable.close()
    }
  })

  it("lets exactly one of two writes that expect the same epoch through", async () => {
    const clock = new TestClock(at(0))
    for (const harness of [memoryLeaseHarness(clock), durableLeaseHarness(clock)]) {
      try {
        await claimAt(harness, { leaseId: LEASE_1 })
        const current = await storedLease(harness)
        if (current === null) continue
        // Two contenders, same expected epoch, issued together — which is
        // precisely the window a network partition turns from microseconds into
        // minutes. Both records are takeover-shaped, because a takeover is the only
        // record a controller may legitimately write at a higher epoch.
        const [a, b] = await Promise.all([
          harness.store.writeLease({ scope: scopeFor(), record: takeoverRecord(current, LEASE_2), expectedEpoch: EPOCH_1 }),
          harness.store.writeLease({ scope: scopeFor(), record: takeoverRecord(current, "lease-run-1-e2b"), expectedEpoch: EPOCH_1 }),
        ])
        const written = [a, b].filter((result) => result.ok && result.value.written).length
        expect(written).toBe(1)
        expect((await storedLease(harness))?.epoch).toBe(EPOCH_2)
      } finally {
        harness.close()
      }
    }
  })

  it("refuses a non-takeover write that changes the epoch, so a renewal cannot move the authority", async () => {
    const clock = new TestClock(at(0))
    const harness = memoryLeaseHarness(clock)
    try {
      await claimAt(harness, { leaseId: LEASE_1 })
      const current = await storedLease(harness)
      if (current === null) return
      const sneaky = await harness.store.writeLease({
        scope: scopeFor(),
        record: { ...current, operation: "renew", epoch: EPOCH_2, expiresAt: iso(at(90)), durationSeconds: 60, recordedAt: at(1) },
        expectedEpoch: EPOCH_1,
      })
      expect(sneaky.ok && sneaky.value.written).toBe(false)
      expect((await storedLease(harness))?.epoch).toBe(EPOCH_1)
    } finally {
      harness.close()
    }
  })
})

describe("M4.4 a record the seam cannot parse is refused before it is evaluated", () => {
  const cases: { label: string; value: unknown }[] = [
    { label: "a command offered to the lease seam", value: leaseEnvelope({ operation: "claim", recordType: "mesh.command" }) },
    { label: "an unknown record family", value: { recordType: "mesh.unknown", schemaVersion: 2, payload: {} } },
    { label: "a lease with a future schema version", value: { ...claimEnvelope(), schemaVersion: 99 } },
    { label: "a lease with no schema version at all", value: { ...claimEnvelope(), schemaVersion: undefined } },
  ]

  for (const { label, value } of cases) {
    it(`refuses ${label} and writes nothing`, async () => {
      const harness = memoryLeaseHarness(new TestClock(at(0)))
      try {
        const outcome = await harness.lease.claim(value)
        expect(outcome.outcome).toBe("refused")
        if (outcome.outcome !== "refused") return
        expect(outcome.reason).toBe("record_unreadable")
        // Nothing persisted, and the refusal is NOT retryable — an unparseable
        // record is one no number of retries will make parseable.
        expect(outcome.error.retryable).toBe(false)
        expect(await storedLease(harness)).toBeNull()
      } finally {
        harness.close()
      }
    })
  }

  it("refuses a takeover record that is missing a wire-level precondition, naming the field", async () => {
    // The wire schema is the first gate, and it is a different gate from the
    // user-inspection precondition. Both have to hold; a test that only exercised
    // the second would pass even if the first had been removed.
    const harness = memoryLeaseHarness(new TestClock(at(0)))
    try {
      await claimAt(harness, { leaseId: LEASE_1 })
      const noReason = await harness.lease.takeover(
        takeoverEnvelope({ leaseId: LEASE_2, epoch: EPOCH_2, takeoverReason: undefined }),
      )
      expect(noReason.outcome).toBe("refused")
      expect(noReason.outcome === "refused" && noReason.reason).toBe("record_unreadable")
      expect((await storedLease(harness))?.epoch).toBe(EPOCH_1)
    } finally {
      harness.close()
    }
  })
})

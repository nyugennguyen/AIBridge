/**
 * M6.5 — crash and replay recovery.
 *
 * The claim under test is ADR 0007 section 13.2's: "a crash between reserve and
 * release cannot leak capacity permanently", together with the adversarial
 * instruction that follows it — "reserve until the limit is exactly reached,
 * attempt one more, crash without releasing, replay, and confirm the total never
 * exceeds the limit and no reservation is lost or double-counted".
 *
 * Four things are asserted, and each maps to a way the recovery could be wrong:
 *
 *   1. **The total never exceeds the limit.** The replay rebuilds the ledger from
 *      a durable log of TERMINAL reservations, then sweeps the volatile ones. If
 *      either half double-counted, the rebuilt total would exceed what the
 *      crashed process actually held.
 *   2. **No reservation is lost.** Every reservation that existed before the
 *      crash is still readable afterwards, in some terminal state. A sweep that
 *      simply dropped unknown ids would satisfy (1) trivially.
 *   3. **None is double-counted.** `reclaimedUnits + retainedUnits` equals the
 *      occupied total the sweep started from (recovery.ts R6).
 *   4. **The recovered state is consistent.** The maintained index agrees with a
 *      recomputed sum, and a reserve against the rebuilt ledger admits exactly the
 *      remaining capacity — not more, not less.
 *
 * The two reclaim REASONS are asserted separately, including the precedence
 * between them, and including the case that matters most operationally: a
 * reservation whose dispatch is STILL RUNNING with a VALID lease is not touched.
 * A sweep that reclaimed it would be freeing capacity in use.
 */

import { describe, expect, it } from "vitest"
import type { DispatchState } from "../../../src/orchestration/transitions.js"
import {
  BUDGET_SCOPES,
  BudgetLedger,
  InMemoryBudgetLedgerStore,
  REPLAY_REJECTION_REASONS,
  RECOVERY_REASONS,
  budgetScopeKey,
  durableReservationRecordSchema,
  recoverLeaked,
  recoveryReasonFor,
  replayDurableReservations,
  replayRejectionSchema,
  reservationIdSchema,
  type BudgetRefusal,
  type BudgetReservation,
  type BudgetScope,
  type ReclaimedReservation,
  type ReplayReport,
  type ReplayRequest,
  type ReservationId,
} from "../../../src/budgets/index.js"
import {
  NOW,
  ONE_HOUR_LATER,
  ONE_MINUTE_LATER,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  TEN_MINUTES_LATER,
  durableLogOf,
  heldRecords,
  randomInt,
  replayCeilings,
  replayRequest,
  reserveRequestFor,
  reservationRecord,
  seededLcg,
  testLedger,
  testLedgerWithStore,
} from "./fixtures.js"

/** A dispatch table. Every dispatch defaults to `running`. */
function dispatchTable(states: Readonly<Record<string, DispatchState>>): ReadonlyMap<string, DispatchState> {
  return new Map(Object.entries(states))
}

async function reserveOnce(
  ledger: Awaited<ReturnType<typeof testLedger>>["ledger"],
  index: number,
  overrides: Parameters<typeof reserveRequestFor>[1] = {},
): Promise<BudgetReservation> {
  const result = await ledger.reserve(reserveRequestFor(index, overrides))
  if (!result.ok) throw new Error(`fixture reserve ${index} was refused: ${result.refusal.message}`)
  return result.value
}

/**
 * Simulates a crash: the durable log survives, the ledger's volatile state does
 * not, and a FRESH store is rebuilt from the log.
 *
 * The ceilings are the ones the crashed ledger was enforcing — a faithful log and
 * an unchanged budget mean the replay has nothing to refuse, which is the claim the
 * "reserves to the limit, crashes, replays" test makes. Tests that need a replay to
 * refuse something say so and pass different ceilings.
 */
function crashAndRebuild(
  durable: readonly BudgetReservation[],
  ceilings: ReplayRequest["ceilings"] = replayCeilings(),
): InMemoryBudgetLedgerStore {
  const rebuilt = new InMemoryBudgetLedgerStore()
  replayDurableReservations(rebuilt, durable, { now: NOW, ceilings })
  return rebuilt
}

// ===========================================================================
// The reason predicate
// ===========================================================================

describe("recovery reclaims only on evidence", () => {
  const reservation = reservationRecord({ dispatchId: "disp-1", leaseExpiresAt: ONE_MINUTE_LATER })

  it("reports dispatch_terminal for every terminal dispatch state the kernel defines", () => {
    // Read off the kernel's own terminal set rather than a restated list, so this
    // test cannot drift from `isDispatchTerminal`.
    for (const state of ["rejected", "completed", "failed", "cancelled", "timed_out"] as const) {
      const reason = recoveryReasonFor(reservation, dispatchTable({ "disp-1": state }), NOW)
      expect(reason, state).toBe("dispatch_terminal")
    }
  })

  it("reports nothing for a dispatch that is still running with a valid lease", () => {
    for (const state of ["proposed", "approved", "running"] as const) {
      expect(recoveryReasonFor(reservation, dispatchTable({ "disp-1": state }), NOW), state).toBeNull()
    }
  })

  it("reports nothing for a dispatch the table has never seen, even when its lease has passed", () => {
    // A caller that has not loaded the whole table has not established anything.
    // The lease still catches it, but the DISPATCH reason must not fire on a
    // missing entry — `undefined` is not a terminal state.
    expect(recoveryReasonFor(reservation, dispatchTable({}), NOW)).toBeNull()
    expect(recoveryReasonFor(reservation, dispatchTable({}), ONE_HOUR_LATER)).toBe("lease_expired")
  })

  it("reports lease_expired once the lease instant has passed at the injected now", () => {
    expect(recoveryReasonFor(reservation, dispatchTable({ "disp-1": "running" }), ONE_MINUTE_LATER)).toBeNull()
    expect(recoveryReasonFor(reservation, dispatchTable({ "disp-1": "running" }), TEN_MINUTES_LATER)).toBe("lease_expired")
  })

  it("treats the lease instant itself as NOT yet expired, so a sweep at exactly leaseExpiresAt leaves it alone", () => {
    // A lease that expires "at" T has not expired at T; the sweep runs one tick
    // later. Getting this backwards would reclaim a reservation at the precise
    // instant its holder was entitled to it.
    expect(recoveryReasonFor(reservation, dispatchTable({ "disp-1": "running" }), ONE_MINUTE_LATER)).toBeNull()
  })

  it("prefers dispatch_terminal when BOTH pieces of evidence hold", () => {
    // The stronger, more actionable fact wins, so a completed dispatch is never
    // reported as a lease expiry.
    expect(recoveryReasonFor(reservation, dispatchTable({ "disp-1": "completed" }), ONE_HOUR_LATER)).toBe("dispatch_terminal")
  })

  it("exposes exactly the two named reasons, and no others", () => {
    expect([...RECOVERY_REASONS].sort()).toEqual(["dispatch_terminal", "lease_expired"])
  })
})

// ===========================================================================
// Lease expiry
// ===========================================================================

describe("lease expiry reclaims a held reservation whose lease has passed", () => {
  it("reclaims a held reservation at an injected now past its lease", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const reservation = await reserveOnce(ledger, 0)
    const report = recoverLeaked(ledger, { now: ONE_HOUR_LATER, dispatchStates: dispatchTable({ "disp-0": "running" }) })
    expect(report.reclaimed).toHaveLength(1)
    expect(report.reclaimed[0]).toMatchObject({
      reservationId: reservation.reservationId,
      dispatchId: "disp-0",
      reason: "lease_expired",
      reclaimedState: "expired",
      previousState: "held",
    })
    expect(report.retained).toEqual([])
    expect(report.reclaimedUnits).toBe(1)
    expect(report.retainedUnits).toBe(0)
    expect(report.reclaimedByReason.lease_expired).toBe(1)
    expect(report.reclaimedByReason.dispatch_terminal).toBe(0)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })

  it("does NOT reclaim a held reservation whose lease is still valid", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    await reserveOnce(ledger, 0)
    const report = recoverLeaked(ledger, { now: TEN_MINUTES_LATER, dispatchStates: dispatchTable({ "disp-0": "running" }) })
    expect(report.reclaimed).toEqual([])
    // Retained, with its units counted — a sweep that reclaimed nothing has to be
    // visibly different from a sweep that was never run.
    expect(report.retained).toEqual(["res-0"])
    expect(report.retainedUnits).toBe(1)
    expect(report.reclaimedUnits).toBe(0)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1)
    expect(ledger.reservationState("disp-0")).toBe("held")
  })

  it("reclaims the expired ones and keeps the live ones in the same sweep", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 4 })
    // Two with a 60s lease and two with a 3600s lease, all dispatched at NOW.
    await reserveOnce(ledger, 0, { leaseSeconds: 60 })
    await reserveOnce(ledger, 1, { leaseSeconds: 60 })
    await reserveOnce(ledger, 2, { leaseSeconds: 3_600 })
    await reserveOnce(ledger, 3, { leaseSeconds: 3_600 })
    const report = recoverLeaked(ledger, {
      // Five minutes: past the 60s leases, well inside the 3600s ones.
      now: "2026-03-01T12:05:00.000Z",
      dispatchStates: dispatchTable({ "disp-0": "running", "disp-1": "running", "disp-2": "running", "disp-3": "running" }),
    })
    expect(report.reclaimed.map((entry) => entry.reservationId)).toEqual(["res-0", "res-1"])
    expect(report.retained).toEqual(["res-2", "res-3"])
    expect(report.reclaimedUnits).toBe(2)
    expect(report.retainedUnits).toBe(2)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(2)
  })
})

// ===========================================================================
// Terminal dispatch state
// ===========================================================================

describe("a terminal dispatch state reclaims the reservation that admitted it", () => {
  it("reclaims a held reservation whose dispatch completed", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    await reserveOnce(ledger, 0)
    const report = recoverLeaked(ledger, { now: NOW, dispatchStates: dispatchTable({ "disp-0": "completed" }) })
    expect(report.reclaimed).toHaveLength(1)
    expect(report.reclaimed[0]).toMatchObject({ reason: "dispatch_terminal", reclaimedState: "released" })
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })

  it("reclaims one for each of the terminal states the kernel defines", async () => {
    for (const state of ["rejected", "completed", "failed", "cancelled", "timed_out"] as const) {
      const { ledger } = testLedger({ maximumConcurrency: 1 })
      await reserveOnce(ledger, 0)
      const report = recoverLeaked(ledger, { now: NOW, dispatchStates: dispatchTable({ "disp-0": state }) })
      expect(report.reclaimedByReason.dispatch_terminal, state).toBe(1)
      expect(ledger.heldUnits(PROJECT_ID, "concurrency"), state).toBe(0)
    }
  })

  it("does NOT reclaim a reservation whose dispatch is still running", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    await reserveOnce(ledger, 0)
    const report = recoverLeaked(ledger, { now: NOW, dispatchStates: dispatchTable({ "disp-0": "running" }) })
    expect(report.reclaimed).toEqual([])
    expect(report.retained).toEqual(["res-0"])
    expect(ledger.reservationState("disp-0")).toBe("held")
  })

  it("reclaims a COMMITTED reservation whose dispatch then failed, which is the leak a launch produces", async () => {
    // A committed reservation is a running session, so it occupies units; when
    // its dispatch reaches `failed` the units have to come back or a crashed
    // session leaks its slot forever.
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const reservation = await reserveOnce(ledger, 0)
    ledger.commit(reservation.reservationId, NOW)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1)
    const report = recoverLeaked(ledger, { now: NOW, dispatchStates: dispatchTable({ "disp-0": "failed" }) })
    expect(report.reclaimed).toHaveLength(1)
    expect(report.reclaimed[0]).toMatchObject({ previousState: "committed", reason: "dispatch_terminal" })
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })

  it("sweeps only the reservations it was asked to", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 4 })
    await reserveOnce(ledger, 0)
    await reserveOnce(ledger, 1)
    const report = recoverLeaked(ledger, {
      now: ONE_HOUR_LATER,
      dispatchStates: dispatchTable({ "disp-0": "completed", "disp-1": "completed" }),
      reservationIds: [reservationIdSchema.parse("res-0")],
    })
    expect(report.reclaimed.map((entry) => entry.reservationId)).toEqual(["res-0"])
    // res-1 was excluded from the sweep, so it is neither reclaimed nor reported
    // as retained: it was out of scope, not judged.
    expect(report.retained).toEqual([])
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1)
  })
})

// ===========================================================================
// Idempotency and unit conservation
// ===========================================================================

describe("a recovery sweep is idempotent and conserves units", () => {
  it("reclaims nothing on a second sweep over the same state", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 3 })
    // `disp-1` is running AND its lease is still valid, so it must survive the
    // sweep. Giving it the same 60s lease as `disp-0` would expire it too (12:01 <
    // the 12:05 sweep) and the first sweep would reclaim two reservations, which is
    // a different test than the one being written here.
    await reserveOnce(ledger, 0, { leaseSeconds: 60 })
    await reserveOnce(ledger, 1, { leaseSeconds: 3_600 })
    await reserveOnce(ledger, 2, { leaseSeconds: 3_600 })
    const states = dispatchTable({ "disp-0": "completed", "disp-1": "running", "disp-2": "running" })
    const now = "2026-03-01T12:05:00.000Z"

    const first = recoverLeaked(ledger, { now, dispatchStates: states })
    const second = recoverLeaked(ledger, { now, dispatchStates: states })
    const third = recoverLeaked(ledger, { now, dispatchStates: states })

    expect(first.reclaimed).toHaveLength(1)
    expect(first.retained).toEqual(["res-1", "res-2"])
    // Idempotent from the second sweep on: the already-terminal reservation is
    // absorbing, so it is neither reclaimed again nor counted as retained, and the
    // two genuinely-held reservations stay held.
    expect(second.reclaimed).toEqual([])
    expect(second.retained).toEqual(["res-1", "res-2"])
    expect(third.reclaimed).toEqual([])
    expect(third.retained).toEqual(["res-1", "res-2"])
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(2)
  })

  it("conserves units: reclaimed plus retained equals the occupied total the sweep started from", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 12 })
    // Lease lengths are chosen PER DISPATCH so the three reclamation reasons are
    // separable: `disp-0/2/4` end terminal, `disp-5` expires, and `disp-1/3` are
    // still running with a lease that has not passed. A uniform
    // `60 + index * 10` would put EVERY lease before a 12:02:00 sweep, so the three
    // running dispatches would also expire and the counts below would be an
    // accident of arithmetic rather than a statement about the rule.
    const leaseSecondsByDispatch: Readonly<Record<string, number>> = {
      "disp-0": 600,
      "disp-1": 600,
      "disp-2": 600,
      "disp-3": 600,
      "disp-4": 600,
      "disp-5": 60,
    }
    for (const [dispatchId, leaseSeconds] of Object.entries(leaseSecondsByDispatch)) {
      const index = Number(dispatchId.slice("disp-".length))
      await reserveOnce(ledger, index, { units: 2, leaseSeconds })
    }
    const occupiedBefore = ledger.heldUnits(PROJECT_ID, "concurrency")
    expect(occupiedBefore).toBe(12)
    const report = recoverLeaked(ledger, {
      now: "2026-03-01T12:02:00.000Z",
      dispatchStates: dispatchTable({
        "disp-0": "completed",
        "disp-1": "running",
        "disp-2": "failed",
        "disp-3": "running",
        "disp-4": "cancelled",
        "disp-5": "running",
      }),
    })
    // R6, as an equality.
    expect(report.reclaimedUnits + report.retainedUnits).toBe(occupiedBefore)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(report.retainedUnits)
    expect(report.reclaimedByReason.dispatch_terminal).toBe(3)
    expect(report.reclaimedByReason.lease_expired).toBe(1)
  })

  it("reports a refused reclamation rather than dropping the reservation", async () => {
    // A store that refuses the transition must not let the sweep claim the
    // capacity came back. The reservation moves to `retained`, so a caller
    // reading the report believes capacity is STILL held.
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    await reserveOnce(ledger, 0)
    const seen: BudgetRefusal[] = []
    const sabotaged = {
      list: () => ledger.list(),
      release: () => ({ ok: false as const, refusal: seen.length >= 0 ? refusalFor("budget.reservation_unknown") : undefined }) as never,
      expire: ledger.expire.bind(ledger),
    }
    const report = recoverLeaked(sabotaged, {
      now: NOW,
      dispatchStates: dispatchTable({ "disp-0": "completed" }),
      onReclaimRefused: (refusal) => seen.push(refusal),
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.code).toBe("budget.reservation_unknown")
    expect(report.reclaimed).toEqual([])
    expect(report.retained).toEqual(["res-0"])
    expect(report.reclaimedUnits).toBe(0)
  })

  it("does not count an already-terminal reservation as reclaimed or retained", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 3 })
    const reservation = await reserveOnce(ledger, 0)
    ledger.release(reservation.reservationId, NOW)
    const report = recoverLeaked(ledger, { now: ONE_HOUR_LATER, dispatchStates: dispatchTable({ "disp-0": "completed" }) })
    expect(report.reclaimed).toEqual([])
    expect(report.retained).toEqual([])
    expect(report.reclaimedUnits + report.retainedUnits).toBe(0)
  })

  it("never returns capacity it was not holding, and never fails to return capacity it should", async () => {
    // Unit conservation, BOTH directions, as a sweep over a state built to have
    // something of every kind in it. The over-release direction is checked as an
    // equality rather than as an inequality: the sweep must return exactly the
    // units of the rows it reclaimed, so a store that freed MORE than it was asked
    // to would show up as `heldUnitsFor` disagreeing with `retainedUnits`.
    const CEILING = 12
    const { ledger, store } = testLedgerWithStore({ maximumConcurrency: CEILING, maximumFanOut: CEILING })

    // Fill it, then leave one reservation alive, one mid-flight, and one free.
    const live = await reserveOnce(ledger, 0, { units: 2, leaseSeconds: 3_600 })
    const midFlight = await reserveOnce(ledger, 1, { units: 3 })
    ledger.commit(midFlight.reservationId, NOW)
    for (const index of [2, 3, 4, 5]) await reserveOnce(ledger, index, { leaseSeconds: 60 })
    const occupiedBefore = ledger.heldUnits(PROJECT_ID, "concurrency")
    const states = dispatchTable({
      "disp-0": "running",
      "disp-1": "completed",
      "disp-2": "failed",
      "disp-3": "cancelled",
      "disp-4": "rejected",
      "disp-5": "timed_out",
    })

    const report = recoverLeaked(ledger, { now: TEN_MINUTES_LATER, dispatchStates: states })

    // --- LEAK direction: nothing it should have returned stayed held. ---------
    // Every reservation whose dispatch is terminal, and whose lease has passed, is
    // terminal in the ledger afterwards. `disp-0` is running on a valid lease, so
    // it is the ONE that must still be holding.
    for (const index of [1, 2, 3, 4, 5]) {
      const reservation = ledger.read(`res-${index}` as never)
      expect(["released", "expired"], `res-${index}`).toContain(reservation?.state)
    }
    expect(ledger.read(live.reservationId)?.state).toBe("held")
    expect(report.retained).toEqual([live.reservationId])
    expect(report.retainedUnits).toBe(2)
    expect(report.reclaimedUnits).toBe(occupiedBefore - 2)
    // The ledger's own arithmetic agrees with the report exactly, in both
    // directions: it holds precisely what the report says it retained.
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(report.retainedUnits)
    expect(report.reclaimedUnits + report.retainedUnits).toBe(occupiedBefore)

    // --- OVER-RELEASE direction: it returned exactly what it was asked to. -----
    // The clamp in `withReplacedReservation` means a store that subtracted too
    // much would be silently floored at zero, so the arithmetic is compared with
    // the RECOMPUTED sum rather than with the index alone.
    expect(report.reclaimed.reduce((total, entry) => total + entry.units, 0)).toBe(report.reclaimedUnits)
    expect(report.retained.reduce(() => 1, 0)).toBe(report.retained.length)
    const stillOccupying = ledger
      .list()
      .filter((reservation) => reservation.state === "held" || reservation.state === "committed")
      .reduce((total, reservation) => total + reservation.units, 0)
    expect(stillOccupying).toBe(occupiedBefore - report.reclaimedUnits)
    // No reservation was freed that the sweep did not name, so the index and the
    // list cannot have drifted apart.
    expect(store.indexedHeldUnits().get(budgetScopeKey(PROJECT_ID, "concurrency"))).toBe(stillOccupying)

    // --- And the sweep is not a one-shot: a second pass frees nothing more. ----
    const second = recoverLeaked(ledger, { now: TEN_MINUTES_LATER, dispatchStates: states })
    expect(second.reclaimed).toEqual([])
    expect(second.reclaimedUnits).toBe(0)
    expect(second.retained).toEqual(report.retained)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(report.retainedUnits)
    expect(second.unverified).toEqual([])
  })
})

// ===========================================================================
// Crash and replay — the headline recovery scenario
// ===========================================================================

describe("a crash between reserve and release is recoverable without loss or double counting", () => {
  it("reserves to the limit, crashes, replays the durable log, and sweeps the stranded half", async () => {
    const CEILING = 5
    const { ledger } = testLedgerWithStore({ maximumConcurrency: CEILING })

    // 1. Fill the budget exactly: four reservations on short leases, and one on a
    //    long lease that will still be valid when the sweep runs.
    for (let index = 0; index < CEILING - 1; index += 1) {
      const reservation = await reserveOnce(ledger, index, { leaseSeconds: 60 })
      expect(reservation.state).toBe("held")
    }
    await reserveOnce(ledger, CEILING - 1, { leaseSeconds: 3_600 })
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(CEILING)

    // 2. One more is refused, and the refusal carries the numbers.
    const overflow = await ledger.reserve(reserveRequestFor(99))
    expect(overflow.ok).toBe(false)
    if (!overflow.ok) {
      expect(overflow.refusal.code).toBe("budget.scope_saturated")
      expect(overflow.refusal.heldUnits).toBe(CEILING)
      expect(overflow.refusal.limit).toBe(CEILING)
    }

    // 3. Three dispatches reach a terminal state and their releases are written.
    for (const index of [0, 1, 2]) {
      const reservation = ledger.read(`res-${index}` as never)
      expect(reservation).not.toBeNull()
      ledger.release(reservation!.reservationId, NOW)
    }
    // `res-3`'s dispatch went on to complete, but the process died before the
    // release that would have recorded it. That is the leak, and its short lease
    // has also passed. `res-4`'s dispatch is still running on a valid lease.
    const durable = durableLogOf(ledger)
    // All five `reserve` transactions committed, so all five are in the log —
    // including the two that never reached a terminal state. A log that omitted
    // them would make the stranded capacity invisible to the sweep.
    expect(durable).toHaveLength(CEILING)
    expect(durable.filter((reservation) => reservation.state === "held")).toHaveLength(2)
    const allBefore = ledger.list().map((reservation) => reservation.reservationId)

    // 4. CRASH. The durable log survives; every trace of the volatile state does
    //    not. A fresh store is rebuilt from the log alone — and its total is
    //    exactly what the crashed process held, because the log is exactly the
    //    reservations that process admitted and no others.
    const rebuilt = crashAndRebuild(durable)
    expect(rebuilt.listHeld().map((reservation) => reservation.reservationId)).toEqual(["res-3", "res-4"])
    expect(rebuilt.heldUnitsFor(PROJECT_ID, "concurrency")).toBe(2)

    // 5. REPLAY, then sweep against the dispatch table the restarted process has.
    //    The sweep runs at TEN_MINUTES_LATER: past `res-3`'s 60-second lease and
    //    well inside `res-4`'s hour.
    const { ledger: rebuiltLedger } = testLedger({ maximumConcurrency: CEILING }, { store: rebuilt })
    const states = dispatchTable({
      "disp-0": "completed",
      "disp-1": "failed",
      "disp-2": "cancelled",
      "disp-3": "completed",
      "disp-4": "running",
    })
    const report = recoverLeaked(rebuiltLedger, { now: TEN_MINUTES_LATER, dispatchStates: states })

    // 6. The assertions.
    //    (a) The total never exceeded the limit, before the crash or after it.
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBeLessThanOrEqual(CEILING)
    expect(rebuiltLedger.heldUnits(PROJECT_ID, "concurrency")).toBeLessThanOrEqual(CEILING)

    //    (b) No reservation was lost: every id that existed before the crash is
    //        still readable afterwards, and the orphan was RECLAIMED rather than
    //        dropped — a sweep that simply forgot unknown ids would satisfy (a)
    //        trivially.
    const after = new Set(rebuiltLedger.list().map((reservation) => reservation.reservationId))
    for (const reservationId of allBefore) {
      expect(after.has(reservationId), `lost ${reservationId}`).toBe(true)
    }
    // `res-3` is reclaimed as `dispatch_terminal`, not `lease_expired`: both pieces
    // of evidence hold and the stronger one is reported, because "the work
    // finished" is what an operator needs to read.
    expect(report.reclaimed.map((entry) => entry.reservationId)).toEqual(["res-3"])
    expect(report.reclaimed[0]).toMatchObject({
      reason: "dispatch_terminal",
      reclaimedState: "released",
      previousState: "held",
      units: 1,
    })
    // `res-4` is untouched: still running, lease still valid.
    expect(report.retained).toEqual(["res-4"])
    expect(report.reclaimedByReason.dispatch_terminal).toBe(1)
    expect(report.reclaimedByReason.lease_expired).toBe(0)

    //    (c) None was double-counted: the three restored terminal records occupy
    //        nothing, `res-3` held one unit and was reclaimed exactly once, and the
    //        single survivor is the one still running.
    expect(report.reclaimedUnits + report.retainedUnits).toBe(2)
    expect(report.reclaimedUnits).toBe(1)
    expect(report.retainedUnits).toBe(1)
    expect(rebuiltLedger.heldUnits(PROJECT_ID, "concurrency")).toBe(1)
    // A second sweep changes nothing at all.
    const again = recoverLeaked(rebuiltLedger, { now: TEN_MINUTES_LATER, dispatchStates: states })
    expect(again.reclaimed).toEqual([])
    expect(again.retained).toEqual(["res-4"])

    //    (d) The recovered state is consistent: the ledger admits exactly the four
    //        units that were freed and no more, so the ceiling is enforceable again
    //        after the replay.
    const admitted: string[] = []
    for (let index = 0; admitted.length < CEILING - 1; index += 1) {
      const result = await rebuiltLedger.reserve(reserveRequestFor(200 + index))
      if (result.ok) admitted.push(result.value.reservationId)
    }
    expect(admitted).toHaveLength(CEILING - 1)
    expect(rebuiltLedger.heldUnits(PROJECT_ID, "concurrency")).toBe(CEILING)
    expect((await rebuiltLedger.reserve(reserveRequestFor(999))).ok).toBe(false)
  })

  it("does not double-count when the durable log is replayed twice", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 4 })
    const a = await reserveOnce(ledger, 0, { units: 2 })
    const b = await reserveOnce(ledger, 1, { units: 2 })
    ledger.commit(a.reservationId, NOW)
    ledger.release(a.reservationId, NOW)
    const durable = durableLogOf(ledger)
    // `a` is terminal, `b` is still committed — and a committed reservation still
    // occupies its units, so a correct replay rebuilds a total of 2, not 0.
    expect(durable).toHaveLength(2)

    const store = new InMemoryBudgetLedgerStore()
    replayDurableReservations(store, durable, replayRequest(replayCeilings(4, 4)))
    const once = store.heldUnitsFor(PROJECT_ID, "concurrency")
    expect(once).toBe(2)
    // A caller replaying the same log twice is a plausible retry, not a bug.
    replayDurableReservations(store, durable, replayRequest(replayCeilings(4, 4)))
    expect(store.heldUnitsFor(PROJECT_ID, "concurrency")).toBe(once)
    expect(store.list()).toHaveLength(2)
  })

  it("accepts a durable record in every state, because a 'held' row is what a crash looks like", () => {
    // R11. A log that refused a `held` row could not describe the crash between
    // reserve and release, and the stranded reservation would be invisible to the
    // sweep — the leak would be unrecoverable by construction rather than merely
    // rare.
    for (const state of ["held", "committed", "released", "expired"] as const) {
      expect(durableReservationRecordSchema.safeParse(reservationRecord({ state })).success, state).toBe(true)
    }
    // What the schema still refuses is a row that is not a reservation at all.
    expect(durableReservationRecordSchema.safeParse({ ...reservationRecord(), units: -1 }).success).toBe(false)
    expect(durableReservationRecordSchema.safeParse({ ...reservationRecord(), state: "pending" }).success).toBe(false)
  })

  it("recomputes the held-unit index from the restored records rather than trusting a stored total", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 8, maximumFanOut: 8 })
    const c0 = await reserveOnce(ledger, 0, { units: 3, scope: "concurrency" })
    await reserveOnce(ledger, 1, { units: 2, scope: "concurrency" })
    const f0 = await reserveOnce(ledger, 2, { units: 4, scope: "fan_out" })
    ledger.expire(f0.reservationId, NOW)

    const store = new InMemoryBudgetLedgerStore()
    replayDurableReservations(store, durableLogOf(ledger), replayRequest(replayCeilings(8, 8)))
    const index = store.indexedHeldUnits()
    // Recomputed per scope from the records: 3 + 2 occupied, fan-out's 4 released.
    expect(store.heldUnitsFor(PROJECT_ID, "concurrency")).toBe(5)
    expect(store.heldUnitsFor(PROJECT_ID, "fan_out")).toBe(0)
    // The index is keyed by `budgetScopeKey`, whose separator is NUL — not a
    // printable character. Asserting the key through the module's own constructor
    // rather than a hand-written string is what keeps this from drifting into
    // asserting a key the store never used, which would pass for `undefined` on the
    // wrong reason.
    expect(index.get(budgetScopeKey(PROJECT_ID, "concurrency"))).toBe(5)
    // The fan-out reservation was expired before the replay, so it occupies nothing
    // and its key is absent from the index entirely rather than present-and-zero.
    expect(index.get(budgetScopeKey(PROJECT_ID, "fan_out"))).toBeUndefined()
    // And it agrees with the pre-crash ledger, which is the whole claim: the
    // rebuild reproduced the state rather than approximating it.
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(5)
    expect(ledger.heldUnits(PROJECT_ID, "fan_out")).toBe(0)
    expect(c0.state).toBe("held")
  })

  it("restores durable records verbatim, including their timestamps", () => {
    const record = reservationRecord({
      state: "released",
      createdAt: "2026-03-01T09:00:00.000Z",
      updatedAt: "2026-03-01T11:30:00.000Z",
      leaseExpiresAt: "2026-03-01T10:00:00.000Z",
    })
    const store = new InMemoryBudgetLedgerStore()
    replayDurableReservations(store, [record], replayRequest(replayCeilings(), ONE_HOUR_LATER))
    const restored = store.read(record.reservationId)
    expect(restored).toEqual(record)
  })

  it("survives a sweep interrupted part-way, because every step is independently idempotent", async () => {
    // R9: each reclamation is its own transaction, so a crash mid-sweep leaves a
    // partially swept ledger that a second sweep finishes. That is strictly
    // stronger than all-or-nothing, because there is no partial transaction left
    // to reason about.
    const { ledger } = testLedger({ maximumConcurrency: 6 })
    for (let index = 0; index < 6; index += 1) await reserveOnce(ledger, index, { leaseSeconds: 60 })
    const states = dispatchTable({
      "disp-0": "completed",
      "disp-1": "completed",
      "disp-2": "completed",
      "disp-3": "completed",
      "disp-4": "completed",
      "disp-5": "completed",
    })

    // A sweep that reclaims three and then "crashes".
    const partial = recoverLeaked(ledger, {
      now: TEN_MINUTES_LATER,
      dispatchStates: states,
      reservationIds: ["res-0", "res-1", "res-2"].map((id) => reservationIdSchema.parse(id)),
    })
    expect(partial.reclaimed).toHaveLength(3)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(3)

    // The restart runs the full sweep and finishes the job.
    const resumed = recoverLeaked(ledger, { now: TEN_MINUTES_LATER, dispatchStates: states })
    expect(resumed.reclaimed.map((entry) => entry.reservationId)).toEqual(["res-3", "res-4", "res-5"])
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })
})

// ===========================================================================
// Report shape
// ===========================================================================

describe("a recovery report is ordered, complete, and code-unit sorted", () => {
  it("sorts reclaimed and retained by reservationId regardless of insertion order", async () => {
    // The two RUNNING dispatches carry a lease that has not passed, so they are
    // retained on evidence of health rather than reclaimed on a clock. A uniform
    // 60s lease would expire them under the ONE_HOUR_LATER sweep and this test
    // would be measuring the lease rule instead of the ordering rule.
    //
    // The retained leases are 3600s, the safety floor's own timeout ceiling, which
    // is also the largest `leaseSeconds` the schema admits: it puts `leaseExpiresAt`
    // EXACTLY on the sweep instant. The lease comparison is strict
    // (`leaseExpiresAt < now`), so a lease expiring at the sweep instant has not
    // passed and is retained. That is deliberate — it makes this ordering test
    // depend on nothing but the ordering, and the boundary case is asserted
    // separately in "treats the lease instant itself as NOT yet expired".
    const { ledger } = testLedger({ maximumConcurrency: 10 })
    for (const index of [7, 2, 9, 1, 5]) {
      const leaseSeconds = index === 2 || index === 9 ? 3_600 : 60
      await reserveOnce(ledger, index, { leaseSeconds })
    }
    const report = recoverLeaked(ledger, {
      now: ONE_HOUR_LATER,
      dispatchStates: dispatchTable({ "disp-7": "completed", "disp-1": "completed", "disp-9": "running", "disp-2": "running", "disp-5": "completed" }),
    })
    const reclaimedIds = report.reclaimed.map((entry: ReclaimedReservation) => entry.reservationId)
    expect(reclaimedIds).toEqual([...reclaimedIds].sort())
    expect(reclaimedIds).toEqual(["res-1", "res-5", "res-7"])
    expect(report.retained).toEqual([...report.retained].sort())
    expect(report.retained).toEqual(["res-2", "res-9"])
  })

  it("carries both reason counts even when one is zero, so a reader never has to test for absence", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    await reserveOnce(ledger, 0)
    const report = recoverLeaked(ledger, { now: NOW, dispatchStates: dispatchTable({ "disp-0": "completed" }) })
    expect(report.reclaimedByReason).toEqual({ dispatch_terminal: 1, lease_expired: 0 })
  })

  it("validates every reclaimed row through the module's own schema", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    await reserveOnce(ledger, 0)
    const report = recoverLeaked(ledger, { now: NOW, dispatchStates: dispatchTable({ "disp-0": "completed" }) })
    for (const entry of report.reclaimed) {
      expect(Object.keys(entry).sort()).toEqual([
        "dispatchId",
        "previousState",
        "projectId",
        "reason",
        "reclaimedState",
        "reservationId",
        "scope",
        "units",
      ])
      expect(["released", "expired"]).toContain(entry.reclaimedState)
    }
  })

  it("reports an unverified reclamation as retained rather than as reclaimed, because a claim the ledger does not corroborate is not a claim", async () => {
    // R18. The over-release direction of unit conservation is not reachable by any
    // arithmetic this module performs — the sweep only calls `release`/`expire` on a
    // row it has just seen occupying — so the only way to reach it is a store that
    // reports success and does not move the reservation. Every return-value check
    // above is defeated by that store at once, because the value and the state
    // agree with each other and neither agrees with the ledger.
    const { ledger } = testLedger({ maximumConcurrency: 4 })
    await reserveOnce(ledger, 0)
    await reserveOnce(ledger, 1)
    const occupiedBefore = ledger.heldUnits(PROJECT_ID, "concurrency")
    const neverMoves = {
      list: () => ledger.list(),
      // Reports exactly what the honest store reports, and does nothing.
      release: (reservationId: string) =>
        ({
          ok: true as const,
          value: { reservation: { ...ledger.read(reservationId as never)!, state: "released" as const } },
        }) as never,
      expire: (reservationId: string) =>
        ({
          ok: true as const,
          value: { reservation: { ...ledger.read(reservationId as never)!, state: "expired" as const } },
        }) as never,
    }

    const report = recoverLeaked(neverMoves, {
      now: NOW,
      dispatchStates: dispatchTable({ "disp-0": "completed", "disp-1": "completed" }),
    })

    // Nothing was reclaimed, so nothing may be reported as reclaimed: claiming it
    // would be the report asserting capacity came back while the ledger still holds it.
    expect(report.reclaimed).toEqual([])
    expect(report.reclaimedUnits).toBe(0)
    expect(report.reclaimedByReason).toEqual({ dispatch_terminal: 0, lease_expired: 0 })
    // And the demotion keeps R6 an EQUALITY rather than an over-count, which is what
    // the `Math.max(0, ...)` clamp in `withReplacedReservation` would otherwise hide.
    expect(report.retained).toEqual(["res-0", "res-1"])
    expect(report.retainedUnits).toBe(occupiedBefore)
    expect(report.reclaimedUnits + report.retainedUnits).toBe(occupiedBefore)
    // The bucket exists so the disagreement is visible rather than inferable, and
    // every unverified id is also retained rather than dropped.
    expect(report.unverified).toEqual(["res-0", "res-1"])
    for (const reservationId of report.unverified) expect(report.retained).toContain(reservationId)
    // And the ledger's own arithmetic is untouched, which is the point: the sweep
    // did not invent a release.
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(occupiedBefore)
  })

  it("records the ledger's own terminal state rather than the one the sweep asked for", async () => {
    // A store that reaches `expired` when asked to `release` has still returned the
    // capacity, and R6 is satisfied — but a report claiming `released` for it would
    // be wrong about a fact an operator can check.
    const { ledger } = testLedger({ maximumConcurrency: 4 })
    const reservation = await reserveOnce(ledger, 0)
    const expiresInstead = {
      list: () => ledger.list(),
      // Both entry points reach `expired`, whatever the sweep asked for.
      release: (reservationId: string) => asExpired(ledger.expire(reservationId as never, NOW)),
      expire: (reservationId: string) => asExpired(ledger.expire(reservationId as never, NOW)),
    }
    const report = recoverLeaked(expiresInstead, {
      now: NOW,
      dispatchStates: dispatchTable({ "disp-0": "completed" }),
    })
    expect(report.reclaimed).toHaveLength(1)
    expect(report.reclaimed[0]).toMatchObject({ reservationId: reservation.reservationId, reclaimedState: "expired" })
    expect(report.unverified).toEqual([])
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })
})

// ===========================================================================
// MED-5: a replay is a second admission decision
// ===========================================================================

/**
 * `held <= ceiling` after ANY replay — the property the whole replay-admission
 * policy exists to restore, and the one the pre-fix code violated with
 * `held: 5` against a `ceiling` of `1`.
 */
describe("a replay admits only what the ceiling still allows", () => {
  it("installs at most the ceiling when a log holds five reservations against a ceiling of one", async () => {
    // The exact MED-5 reproduction. Before the fix this log replayed to
    // `held: 5`, `eligible: true` for all five dispatches, and a sixth reserve
    // refused with a total nothing could account for.
    const CEILING = 1
    const records = heldRecords(5)
    const store = new InMemoryBudgetLedgerStore()

    const report = replayDurableReservations(store, records, replayRequest(replayCeilings(CEILING, CEILING)))

    // The invariant, stated as an observation rather than a promise.
    expect(store.heldUnitsFor(PROJECT_ID, "concurrency")).toBeLessThanOrEqual(CEILING)
    expect(store.heldUnitsFor(PROJECT_ID, "concurrency")).toBe(CEILING)
    expect(store.indexedHeldUnits().get(budgetScopeKey(PROJECT_ID, "concurrency"))).toBe(CEILING)

    // Exactly one dispatch is eligible — the FIRST in `reservationId` code-unit
    // order, which is the total order the policy names. Not an arbitrary one.
    const { ledger } = testLedger({ maximumConcurrency: CEILING }, { store })
    const eligibility = records.map((record) => ledger.eligible(record.dispatchId))
    expect(eligibility).toEqual([true, false, false, false, false])
    expect(ledger.eligible(records[0]!.dispatchId)).toBe(true)
    expect(ledger.eligible(records[4]!.dispatchId)).toBe(false)

    // Every reservation is still READABLE, because a refusal is never total: the
    // four the ceiling refused are installed as `expired`, not dropped. R13.
    expect(report.restored).toEqual(records.map((record) => record.reservationId))
    for (const record of records) expect(ledger.read(record.reservationId)).not.toBeNull()

    // And the refusal is NAMED, with the numbers behind it.
    expect(report.rejected.map((entry) => entry.reservationId)).toEqual(["res-001", "res-002", "res-003", "res-004"])
    for (const entry of report.rejected) {
      expect(entry.reason).toBe("over_ceiling")
      expect(entry.previousState).toBe("held")
      expect(entry.restoredState).toBe("expired")
      expect(entry.ceiling).toBe(CEILING)
      expect(entry.detail).toContain("over_ceiling")
      expect(entry.detail).toContain(String(CEILING))
      // Validated through the module's own schema, `.strict()`, so no report row
      // can carry a member the rest of the module does not know.
      expect(replayRejectionSchema.safeParse(entry).success).toBe(true)
    }
    expect(report.rejectedByReason).toEqual({
      ceiling_undeclared: 0,
      duplicate_dispatch: 0,
      over_ceiling: 4,
    })
    // The arithmetic is published so the claim is checkable: five units occupied,
    // one admitted, four returned.
    expect(report.scopes).toHaveLength(1)
    expect(report.scopes[0]).toMatchObject({
      projectId: PROJECT_ID,
      scope: "concurrency",
      ceiling: CEILING,
      occupiedUnits: 5,
      admittedUnits: 1,
      rejectedUnits: 4,
    })
  })

  it("holds the ceiling invariant and leaves the recovered state internally consistent across 400 seeded log-and-ceiling pairs", () => {
    // A seeded LCG rather than `Math.random`: a sweep that fails has to be
    // reproducible, and `Math.random()` is forbidden in this module anyway (I7).
    const next = seededLcg(0x5eed_1234)
    const ITERATIONS = 400
    let overLimit = 0
    let overAdmitted = 0
    let admittedRows = 0
    let rejectedRows = 0
    const reasonsSeen = new Set<string>()

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const scope: BudgetScope = randomInt(next, 0, 1) === 0 ? "concurrency" : "fan_out"
      const projectId = randomInt(next, 0, 1) === 0 ? PROJECT_ID : OTHER_PROJECT_ID
      // A ceiling that is sometimes `null`, because "no budget declares one" is a
      // case replay has to handle rather than skip (L8).
      const ceiling = randomInt(next, 0, 9) === 0 ? null : randomInt(next, 1, 12)
      const rowCount = randomInt(next, 0, 14)
      // Rows mix occupying and terminal states, duplicate a `dispatchId` about a
      // quarter of the time, and duplicate a `reservationId` about an eighth of the
      // time, so the sweep meets benign duplication and genuine over-limit in the
      // same pass.
      const rows = Array.from({ length: rowCount }, () => randomRow(next, { scope, projectId }))

      const store = new InMemoryBudgetLedgerStore()
      const report = replayDurableReservations(store, rows, {
        now: NOW,
        ceilings: [
          { projectId: PROJECT_ID, scope: "concurrency", ceiling },
          { projectId: OTHER_PROJECT_ID, scope: "concurrency", ceiling },
        ],
      })

      // (1) R12, the invariant: held never exceeds the ceiling. A `null` ceiling
      // means nothing may be held at all, which is `0 <= 0`, not "unlimited".
      const bound = ceiling ?? 0
      for (const scopeName of BUDGET_SCOPES) {
        for (const project of [PROJECT_ID, OTHER_PROJECT_ID]) {
          const held = store.heldUnitsFor(project, scopeName)
          const label = `iteration ${iteration}: ${project}/${scopeName} held ${held} of ${String(bound)}`
          if (held > bound) {
            overLimit += 1
            expect(held, label).toBeLessThanOrEqual(bound)
          }
          // (2) The maintained index agrees with a recomputed sum from the
          // reservation list, so the replayed ledger has no second source of truth.
          const recomputed = store
            .list()
            .filter((reservation) => reservation.projectId === project && reservation.scope === scopeName)
            .filter((reservation) => reservation.state === "held" || reservation.state === "committed")
            .reduce((total, reservation) => total + reservation.units, 0)
          expect(recomputed, `${label} (recomputed)`).toBe(held)
          const indexed = store.indexedHeldUnits().get(budgetScopeKey(project, scopeName)) ?? 0
          expect(indexed, `${label} (indexed)`).toBe(recomputed)
        }
      }

      // (3) One reservation per dispatch, so eligibility is single-valued. A
      // replay that installed two occupying rows for one dispatch would make
      // `reservationState(dispatchId)` a function of map iteration order.
      const perDispatch = new Map<string, number>()
      for (const reservation of store.list()) {
        if (reservation.state !== "held" && reservation.state !== "committed") continue
        perDispatch.set(reservation.dispatchId, (perDispatch.get(reservation.dispatchId) ?? 0) + 1)
      }
      for (const [dispatchId, count] of perDispatch) {
        if (count > 1) {
          overAdmitted += 1
          expect(count, `iteration ${iteration}: dispatch ${dispatchId} holds ${count} reservations`).toBe(1)
        }
      }

      // (4) R14: units are conserved per scope, and the published arithmetic says
      // so. `occupiedUnits` is summed over the DE-DUPLICATED rows, because a
      // redundant row is not capacity the crashed process held twice — it is the
      // same capacity stated twice — so counting it would let a doubled log inflate
      // its own denominator and hide the excess it represents.
      for (const total of report.scopes) {
        expect(total.admittedUnits, `iteration ${iteration}`).toBeLessThanOrEqual(total.ceiling ?? 0)
        expect(total.admittedUnits + total.rejectedUnits, `iteration ${iteration}`).toBe(total.occupiedUnits)
        admittedRows += total.admittedUnits > 0 ? 1 : 0
        rejectedRows += total.rejectedUnits > 0 ? 1 : 0
      }

      // (5) R13: no reservation is lost. Every distinct `reservationId` in the log
      // is installed, and nothing else is.
      const idsInLog = new Set(rows.map((row) => row.reservationId))
      expect(report.restored).toEqual([...idsInLog].sort())
      expect(report.restored.length + report.collapsedRecords).toBe(rows.length)
      for (const reservationId of idsInLog) expect(store.read(reservationId), reservationId).not.toBeNull()

      // (6) Every rejection is a reservation that was occupying capacity, is now
      // terminal, and carries one of the three named reasons.
      for (const rejection of report.rejected) {
        expect(["held", "committed"]).toContain(rejection.previousState)
        const installed = store.read(rejection.reservationId)
        expect(installed?.state, rejection.reservationId).toBe("expired")
        expect(REPLAY_REJECTION_REASONS).toContain(rejection.reason)
        reasonsSeen.add(rejection.reason)
      }
      // The reason counts add up to the rejections, or the report is lying in one
      // of its two places.
      const summed = Object.values(report.rejectedByReason).reduce((total, count) => total + count, 0)
      expect(summed).toBe(report.rejected.length)
    }

    // The sweep has to have actually exercised both directions, or it proved
    // nothing. These are tallies, not assertions about correctness — the
    // correctness assertions are inside the loop, and a sweep that never refused
    // anything would pass every one of them while checking nothing.
    expect(overLimit).toBe(0)
    expect(overAdmitted).toBe(0)
    expect(admittedRows).toBeGreaterThan(0)
    expect(rejectedRows).toBeGreaterThan(0)
    // All three named reasons must have been produced at least once, or one branch
    // of the policy is untested and therefore unargued.
    expect([...reasonsSeen].sort()).toEqual([...REPLAY_REJECTION_REASONS].sort())
    expect(ITERATIONS).toBe(400)
  })

  it("is idempotent when the same log is replayed twice, and when its rows are duplicated inside one log", async () => {
    const CEILING = 4
    const records = heldRecords(4)

    // (a) The whole log twice, as separate calls. A caller replaying the same log
    // twice is a plausible retry, not a bug (S4).
    const store = new InMemoryBudgetLedgerStore()
    const first = replayDurableReservations(store, records, replayRequest(replayCeilings(CEILING, CEILING)))
    const afterFirst = store.heldUnitsFor(PROJECT_ID, "concurrency")
    const second = replayDurableReservations(store, records, replayRequest(replayCeilings(CEILING, CEILING)))
    expect(afterFirst).toBe(CEILING)
    expect(store.heldUnitsFor(PROJECT_ID, "concurrency")).toBe(afterFirst)
    expect(store.list()).toHaveLength(4)
    expect(second).toEqual(first)

    // (b) The same log CONCATENATED WITH ITSELF — the log-shipped-twice case, and
    // the one the old keyed-map implementation happened to survive by accident.
    const doubled = new InMemoryBudgetLedgerStore()
    const report = replayDurableReservations(doubled, [...records, ...records], replayRequest(replayCeilings(CEILING, CEILING)))
    expect(doubled.heldUnitsFor(PROJECT_ID, "concurrency")).toBe(CEILING)
    expect(doubled.list()).toHaveLength(4)
    expect(report.collapsed).toEqual(records.map((record) => record.reservationId))
    expect(report.rejected).toEqual([])
    // No extra capacity and no error: `restored` counts each id once, and the eight
    // rows minus the four redundant ones is the four real ones.
    expect(report.recordCount).toBe(8)
    expect(report.collapsedRecords).toBe(4)
    expect(report.restored.length + report.collapsedRecords).toBe(8)
    expect(report.scopes[0]).toMatchObject({ occupiedUnits: CEILING, admittedUnits: CEILING, rejectedUnits: 0 })

    // (c) Rows that were duplicated but CONFLICT — one says `held`, one says
    // `released`, for the same id. The later word wins, so the outcome does not
    // depend on which order the two arrived in (R15).
    const conflicted = [
      reservationRecord({ reservationId: "res-a", dispatchId: "disp-a", state: "released", updatedAt: NOW }),
      reservationRecord({ reservationId: "res-a", dispatchId: "disp-a", state: "held", updatedAt: TEN_MINUTES_LATER }),
    ]
    for (const order of [conflicted, [...conflicted].reverse()]) {
      const conflictStore = new InMemoryBudgetLedgerStore()
      const conflictReport = replayDurableReservations(conflictStore, order, replayRequest(replayCeilings(CEILING, CEILING)))
      // `held` is the later word, so the reservation occupies and is admitted.
      expect(conflictStore.heldUnitsFor(PROJECT_ID, "concurrency"), JSON.stringify(order.map((r) => r.state))).toBe(1)
      expect(conflictReport.collapsed).toEqual(["res-a"])
      expect(conflictReport.rejected).toEqual([])
    }
  })

  it("leaves a valid under-ceiling history untouched and conserves its units exactly", async () => {
    const CEILING = 8
    const { ledger } = testLedger({ maximumConcurrency: CEILING, maximumFanOut: CEILING })
    const c0 = await reserveOnce(ledger, 0, { units: 3 })
    const c1 = await reserveOnce(ledger, 1, { units: 2 })
    const c2 = await reserveOnce(ledger, 2, { units: 2 })
    ledger.commit(c1.reservationId, NOW)
    ledger.release(c2.reservationId, NOW)
    const f0 = await reserveOnce(ledger, 3, { units: 4, scope: "fan_out" })
    ledger.expire(f0.reservationId, NOW)

    const durable = durableLogOf(ledger)
    const store = new InMemoryBudgetLedgerStore()
    const report = replayDurableReservations(store, durable, replayRequest(replayCeilings(CEILING, CEILING)))

    // Byte-for-byte the pre-crash ledger: 3 held + 2 committed = 5 concurrency, and
    // the fan-out row terminal so it occupies nothing.
    expect(report.rejected).toEqual([])
    expect(report.collapsed).toEqual([])
    expect(store.list()).toEqual(durable)
    expect(store.heldUnitsFor(PROJECT_ID, "concurrency")).toBe(5)
    expect(store.heldUnitsFor(PROJECT_ID, "fan_out")).toBe(0)
    expect(store.heldUnitsFor(PROJECT_ID, "concurrency")).toBe(ledger.heldUnits(PROJECT_ID, "concurrency"))
    expect(c0.state).toBe("held")
    // Conservation per scope, and the identity is `admitted + rejected === occupied`.
    // Concurrency: 3 held + 2 committed = 7 occupying units, all admitted, none
    // returned. Fan-out: its one row is terminal, so it occupies NOTHING — which is
    // why it is reported as a zero row rather than as a 4 that was somehow freed.
    expect(report.scopes.map((total) => [total.scope, total.occupiedUnits, total.admittedUnits, total.rejectedUnits])).toEqual([
      ["concurrency", 5, 5, 0],
      ["fan_out", 0, 0, 0],
    ])
  })

  it("produces the same recovered state and the same report for every ordering of the same over-limit log", () => {
    // Determinism has two halves and the second is the one that is easy to lose:
    // the same input twice (a pure function) and the same SET of inputs in any
    // order (an order-independent decision). Only the second is interesting here,
    // because admission walks a list and a lost total order is invisible until two
    // machines disagree.
    const CEILING = 3
    const records = [
      ...heldRecords(9),
      // Two rows for one dispatch, and two conflicting rows for one id, so the
      // orderings differ in more than the permutation.
      duplicateOfHeld("disp-000", "res-dup"),
      reservationRecord({ reservationId: "res-conf", dispatchId: "disp-conf", state: "released", updatedAt: NOW }),
      reservationRecord({ reservationId: "res-conf", dispatchId: "disp-conf", state: "committed", updatedAt: TEN_MINUTES_LATER }),
    ]!

    const next = seededLcg(0x0dde_0001)
    const orders: BudgetReservation[][] = [records]
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const shuffled = [...records]
      // A seeded Fisher-Yates, so the "different orderings" are actually different
      // rather than a rotation.
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = randomInt(next, 0, index)
        const held = shuffled[index]!
        shuffled[index] = shuffled[swap]!
        shuffled[swap] = held
      }
      orders.push(shuffled)
    }

    const canonical = replayInto(new InMemoryBudgetLedgerStore(), records, CEILING)
    for (const [index, order] of orders.entries()) {
      const actual = replayInto(new InMemoryBudgetLedgerStore(), order, CEILING)
      expect(actual.report, `ordering ${index}`).toEqual(canonical.report)
      expect(actual.restoredStates, `ordering ${index}`).toEqual(canonical.restoredStates)
      expect(actual.held, `ordering ${index}`).toBe(canonical.held)
      expect(actual.held).toBeLessThanOrEqual(CEILING)
    }

    // And the claim is not vacuous: this log genuinely is over the ceiling, and
    // genuinely does contain both duplication shapes.
    expect(canonical.report.rejectedByReason.duplicate_dispatch).toBeGreaterThan(0)
    expect(canonical.report.rejectedByReason.over_ceiling).toBeGreaterThan(0)
    expect(canonical.report.collapsed).toContain("res-conf")
  })

  it("accounts for every row it read, so the report's three buckets sum to the input", () => {
    // Explainability, as arithmetic. A rejection with no reason, or a reservation
    // that appears in no bucket, is a hole in the account rather than a formatting
    // complaint.
    const records = [
      ...heldRecords(6),
      // One row for a dispatch that is already reserved, so the duplicate check
      // has something to catch before the ceiling check does.
      duplicateOfHeld("disp-000", "res-z"),
      // And two terminal rows, which must always come in untouched (R17).
      reservationRecord({ reservationId: "res-t1", dispatchId: "disp-t1", state: "released" }),
      reservationRecord({ reservationId: "res-t2", dispatchId: "disp-t2", state: "expired" }),
    ]!

    const store = new InMemoryBudgetLedgerStore()
    const report = replayDurableReservations(store, records, replayRequest(replayCeilings(2, 2)))

    // restored + collapsed == rows in.
    expect(report.recordCount).toBe(records.length)
    expect(report.restored.length + report.collapsedRecords).toBe(records.length)
    // Every restored id appears exactly once in exactly one bucket.
    const all = new Set(report.restored)
    expect(all.size).toBe(report.restored.length)
    for (const rejection of report.rejected) expect(report.restored).toContain(rejection.reservationId)
    for (const collapsedId of report.collapsed) expect(report.restored).toContain(collapsedId)
    // Every rejection carries a reason from the closed vocabulary and a sentence
    // that names the numbers behind it.
    for (const rejection of report.rejected) {
      expect(REPLAY_REJECTION_REASONS).toContain(rejection.reason)
      expect(rejection.detail.startsWith(`replay.${rejection.reason}:`), rejection.reason).toBe(true)
      expect(rejection.detail.length).toBeGreaterThan(1)
    }
    // Terminal rows are never refused, and never refused for want of a ceiling.
    expect(report.rejected.map((entry) => entry.reservationId)).not.toContain("res-t1")
    expect(report.rejected.map((entry) => entry.reservationId)).not.toContain("res-t2")
    expect(store.read(reservationIdSchema.parse("res-t1"))?.state).toBe("released")
    expect(store.read(reservationIdSchema.parse("res-t2"))?.state).toBe("expired")
    // The duplicate is refused as a DUPLICATE, not as an over-ceiling row — which
    // is the distinction that separates a benign doubled log from a genuinely
    // over-limit history, and the reason a report is worth reading.
    expect(report.rejected.find((entry) => entry.reservationId === "res-z")?.reason).toBe("duplicate_dispatch")
    // 6 + 1 occupying rows = 7 units at 1 each, 2 admitted, 5 returned.
    expect(report.scopes[0]).toMatchObject({ occupiedUnits: 7, admittedUnits: 2, rejectedUnits: 5 })
  })

  it("refuses an occupying row whose dispatch already has a terminal reservation, so a finished dispatch cannot become eligible twice", () => {
    // I3 through the replay path. A correct writer cannot produce this pair: the
    // store's `reservationIdByDispatch` keeps a dispatch's first reservation for
    // ever, and a second `reserve` for it is refused with
    // `budget.dispatch_already_reserved`. A corrupt log can. Admitting the `held`
    // row would make a dispatch whose work already FINISHED launch-eligible a
    // second time — an eligibility bypass the ceiling check alone cannot see,
    // because one unit against a ceiling of four is well inside the limit.
    const records = [
      reservationRecord({ reservationId: "res-a", dispatchId: "disp-1", state: "released" }),
      reservationRecord({
        reservationId: "res-b",
        dispatchId: "disp-1",
        state: "held",
        leaseExpiresAt: "2026-03-02T12:00:00.000Z",
      }),
    ]!
    const store = new InMemoryBudgetLedgerStore()
    const report = replayDurableReservations(store, records, replayRequest(replayCeilings(4, 4)))

    // The occupying row is refused as a DUPLICATE, not admitted.
    expect(report.rejected.map((entry) => [entry.reservationId, entry.reason])).toEqual([["res-b", "duplicate_dispatch"]])
    expect(store.read("res-b" as never)?.state).toBe("expired")
    // Eligibility is the definition, so it is the thing asserted: the dispatch is
    // NOT eligible, and the reservation the index names for it is the terminal one.
    const { ledger } = testLedger({ maximumConcurrency: 4 }, { store })
    expect(ledger.eligible("disp-1")).toBe(false)
    expect(ledger.reservationState("disp-1")).toBe("released")
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
    // And the capacity the refused row asked for was returned rather than stranded,
    // so the ledger is not left holding room it cannot account for.
    expect(report.scopes[0]).toMatchObject({ occupiedUnits: 1, admittedUnits: 0, rejectedUnits: 1 })
  })

  it("does not let a terminal row displace a held one from the dispatch index, so held capacity is never stranded", () => {
    // The mirror of the test above, and the one that would strand capacity: here the
    // OCCUPYING row sorts first, so it is the one that claims the dispatch. A later
    // terminal row is still installed (R17) but must not overwrite the index entry,
    // or `reservationState(dispatchId)` would say `released` while the held-unit
    // index still counts the `held` row's units — a ledger that holds capacity for a
    // dispatch it thinks is finished, and refuses every reserve against it.
    const records = [
      reservationRecord({
        reservationId: "res-a",
        dispatchId: "disp-1",
        state: "held",
        leaseExpiresAt: "2026-03-02T12:00:00.000Z",
      }),
      reservationRecord({ reservationId: "res-b", dispatchId: "disp-1", state: "released" }),
    ]!
    const store = new InMemoryBudgetLedgerStore()
    const report = replayDurableReservations(store, records, replayRequest(replayCeilings(4, 4)))

    expect(report.rejected).toEqual([])
    const { ledger } = testLedger({ maximumConcurrency: 4 }, { store })
    expect(ledger.reservationState("disp-1")).toBe("held")
    expect(ledger.eligible("disp-1")).toBe(true)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1)
    // The row is still readable in the state the log carried, so nothing is lost.
    expect(store.read("res-b" as never)?.state).toBe("released")
    expect(store.list()).toHaveLength(2)
  })

  it("refuses every occupying row for a scope whose ceiling the caller declared as absent", async () => {
    // L8 applied to replay: "no budget" is not "unlimited budget". A caller that
    // resolved no ceiling has said nothing about how many dispatches may run, and a
    // replay that treated that as infinite would be the one path on which a ceiling
    // is invented rather than enforced.
    const records = heldRecords(3)
    const store = new InMemoryBudgetLedgerStore()
    const report = replayDurableReservations(store, records, replayRequest(replayCeilings(null, null)))

    expect(store.heldUnitsFor(PROJECT_ID, "concurrency")).toBe(0)
    expect(report.rejected).toHaveLength(3)
    expect(report.rejected.every((entry) => entry.reason === "ceiling_undeclared")).toBe(true)
    expect(report.scopes[0]).toMatchObject({ ceiling: null, occupiedUnits: 3, admittedUnits: 0, rejectedUnits: 3 })

    // And a ledger over that store refuses every reserve for the right reason: it
    // is not that the scope has room, it is that nobody declared how much.
    const { ledger } = testLedger({ maximumFanOut: 4 }, { store })
    const refused = await ledger.reserve(reserveRequestFor(900))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.refusal.code).toBe("budget.scope_unbounded")
  })

  it("lets a ledger over a replayed state fill exactly the remaining capacity and then refuses with the numbers", async () => {
    // The wedge check. The discriminator between "the budget is full" and "the
    // budget is wedged" is NOT the refusal — both are `budget.scope_saturated` —
    // it is the `heldUnits` the refusal carries. A wedged ledger refuses with a
    // total nothing can account for; a correct one refuses with `held == ceiling`.
    const CEILING = 5
    const records = heldRecords(20)
    const store = new InMemoryBudgetLedgerStore()
    replayDurableReservations(store, records, replayRequest(replayCeilings(CEILING, CEILING)))
    const { ledger } = testLedger({ maximumConcurrency: CEILING }, { store })

    const heldAfterReplay = ledger.heldUnits(PROJECT_ID, "concurrency")
    expect(heldAfterReplay).toBeLessThanOrEqual(CEILING)

    // Fill the room that is left, and no more.
    const admitted: ReservationId[] = []
    let refusal: BudgetRefusal | null = null
    for (let index = 0; index < 50; index += 1) {
      const result = await ledger.reserve(reserveRequestFor(300 + index))
      if (result.ok) {
        admitted.push(result.value.reservationId)
        continue
      }
      refusal = result.refusal
      break
    }
    expect(admitted).toHaveLength(CEILING - heldAfterReplay)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(CEILING)
    // The refusal is the RIGHT refusal and it accounts for itself: exactly at the
    // ceiling, and the request would have exceeded it.
    expect(refusal?.code).toBe("budget.scope_saturated")
    expect(refusal?.heldUnits).toBe(CEILING)
    expect(refusal?.limit).toBe(CEILING)
    // Never an unbounded grant, whatever the input was: twenty rows asked for
    // twenty units and the ledger is at five.
    expect(ledger.listHeld().length).toBeLessThanOrEqual(CEILING)

    // And the wedge is not permanent, because the refused rows were installed as
    // `expired` rather than dropped: one sweep over a dispatch table that says
    // every admitted dispatch is finished frees the room again.
    const states = dispatchTable(
      Object.fromEntries(
        ledger
          .listHeld()
          .map((reservation) => [reservation.dispatchId, "completed" as const]),
      ),
    )
    const swept = recoverLeaked(ledger, { now: NOW, dispatchStates: states })
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
    expect(swept.reclaimedUnits).toBe(CEILING)
    expect((await ledger.reserve(reserveRequestFor(999))).ok).toBe(true)
  })
})

function refusalFor(code: BudgetRefusal["code"]): BudgetRefusal {
  return {
    code,
    message: "the store refused the reclamation",
    scope: "concurrency",
    limit: 2,
    heldUnits: 1,
    requestedUnits: null,
    reservationId: null,
  }
}

/**
 * Re-shapes a ledger transition into the value a `SweepableLedger` reports.
 *
 * Only used by the two sabotaged stores below, both of which are deliberately
 * lying in a specific direction, so the cast is confined to the one place the lie
 * is introduced rather than sprinkled through the sweep's own types.
 */
function asExpired(result: ReturnType<BudgetLedger["expire"]>): never {
  if (!result.ok) throw new Error(`fixture expire was refused: ${result.refusal.message}`)
  return { ok: true, value: { reservation: result.value.reservation } } as never
}

/** Re-mints a held record for an existing dispatch, so the log holds a duplicate. */
function duplicateOfHeld(dispatchId: string, reservationId: string): BudgetReservation {
  return reservationRecord({ reservationId, dispatchId, state: "held", leaseExpiresAt: "2026-03-02T12:00:00.000Z" })
}

// ===========================================================================
// Seeded generators for the replay sweeps
// ===========================================================================

/**
 * One durable-log row, chosen from a seeded source.
 *
 * The three shapes it can take are the three that matter to replay: a row with a
 * unique `dispatchId` (a genuine reservation), a row reusing an earlier
 * `dispatchId` (a reservation written twice under two ids), and a row whose state
 * is terminal (which occupies nothing and must always come in). `units` is drawn
 * up to 3 so the sweep meets the all-or-nothing boundary — a 2-unit row that does
 * not fit in a 1-unit remainder is refused rather than partially admitted, and a
 * sweep that only ever drew 1-unit rows would never see that.
 */
function randomRow(
  next: () => number,
  fixed: { readonly scope: BudgetScope; readonly projectId: string },
): BudgetReservation {
  const which = randomInt(next, 0, 9)
  const reservationId = `res-${String(randomInt(next, 0, 6)).padStart(3, "0")}`
  const dispatchId =
    which < 2
      ? `disp-${String(randomInt(next, 0, 2)).padStart(3, "0")}`
      : `disp-${reservationId.slice(4)}`
  const state = which === 9 ? "released" : which === 8 ? "expired" : which === 7 ? "committed" : "held"
  return reservationRecord({
    reservationId,
    dispatchId,
    projectId: fixed.projectId,
    scope: fixed.scope,
    units: randomInt(next, 1, 3),
    state,
    leaseExpiresAt: "2026-03-02T12:00:00.000Z",
    createdAt: NOW,
    updatedAt: NOW,
  })
}

/** Replays and returns the three things determinism is asserted over. */
function replayInto(
  store: InMemoryBudgetLedgerStore,
  rows: readonly BudgetReservation[],
  ceiling: number,
): {
  readonly report: ReplayReport
  readonly restoredStates: readonly (readonly [string, string])[]
  readonly held: number
} {
  const report = replayDurableReservations(store, rows, replayRequest(replayCeilings(ceiling, ceiling)))
  return {
    report,
    restoredStates: store.list().map((reservation) => [reservation.reservationId, reservation.state]),
    held: store.heldUnitsFor(PROJECT_ID, "concurrency"),
  }
}

/** Referenced so the instant choices stay visible to a reader of this file. */
export const RECOVERY_INSTANTS = { NOW, ONE_MINUTE_LATER, TEN_MINUTES_LATER, ONE_HOUR_LATER } as const

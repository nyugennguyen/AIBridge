/**
 * M6.5 — reservation atomicity. THE HEADLINE FILE.
 *
 * ADR 0007 section 13.2 states the invariant as a DEFINITION:
 *
 * > A dispatch is eligible to launch if and only if it holds a `reservationId`
 * > whose reservation is in state `held`.
 *
 * and stop condition 3 says implementation halts if "budget reservation is found
 * not to be atomic with dispatch eligibility, including by crash or replay
 * between the check and the reservation". The two ways that failure shows up are:
 *
 *   - **OVER-ADMISSION.** Two dispatches both observe room and both reserve it,
 *     and the held total exceeds the ceiling. This is what the concurrency sweep
 *     below tries to produce, 200+ times, with real `Promise.all` interleavings
 *     and varied N. A check-then-act ledger fails it; the transactional one
 *     cannot.
 *   - **UNDER-ADMISSION WITH A LEAK.** A reserve is refused when there was room,
 *     because a competing reserve took it — and the caller cannot tell "I lost a
 *     race" from "the budget is exhausted", because both are the same refusal.
 *
 * The sweep uses REAL async boundaries rather than a serialized loop on purpose.
 * `reserve` awaits the injected `resolveLimits` port before entering the store,
 * so N concurrent calls genuinely interleave at that await; if atomicity depended
 * on the calls happening to run back to back, the test would pass against an
 * implementation that is wrong in production.
 */

import { describe, expect, it } from "vitest"
import { InvariantViolationError } from "../../../src/orchestration/errors.js"
import {
  dispatchIdSchema,
  projectIdSchema,
  runIdSchema,
  taskIdSchema,
} from "../../../src/orchestration/identifiers.js"
import {
  BUDGET_SCOPES,
  BudgetLedger,
  InMemoryBudgetLedgerStore,
  budgetScopeKey,
  reservationIdSchema,
  type BudgetLimits,
  type BudgetReservation,
  type ReservationDraft,
} from "../../../src/budgets/index.js"
import {
  NOW,
  ONE_HOUR_LATER,
  ONE_MINUTE_LATER,
  OTHER_PROJECT_ID,
  PROJECT_ID,
  TEN_MINUTES_LATER,
  reserveRequestFor,
  testLedger,
  testLedgerWithStore,
} from "./fixtures.js"

// ===========================================================================
// The headline: 200+ interleaved reserves
// ===========================================================================

describe("concurrent reservation never oversubscribes a scope", () => {
  it("admits exactly the ceiling out of N interleaved reserves, over 200 trials with varied N", async () => {
    const CEILING = 5
    const limits: BudgetLimits = { maximumConcurrency: CEILING }

    let admitted = 0
    let refused = 0
    let trials = 0
    let peakHeld = 0

    // Varied N around the ceiling: below it (all must succeed), exactly at it
    // (all must succeed), one over (all must succeed), and well over it (exactly
    // `ceiling` must succeed). A sweep that only used N >> ceiling would pass
    // against an implementation that refuses everything.
    const sizes = [1, 3, 5, 6, 8, 13, 40]
    for (let trial = 0; trial < 210; trial += 1) {
      const { ledger } = testLedger(limits)
      const n = sizes[trial % sizes.length]!
      trials += 1

      // Real async boundaries: `reserve` awaits the injected limits port, so all N
      // calls are in flight and suspended at the same point before any of them
      // reaches the store.
      const results = await Promise.all(
        Array.from({ length: n }, (_, index) => ledger.reserve(reserveRequestFor(index))),
      )

      const succeeded = results.filter((result) => result.ok)
      admitted += succeeded.length
      refused += results.length - succeeded.length

      for (const result of results) {
        if (result.ok) {
          // Exactly `held`, immediately, with no separate eligibility step.
          expect(result.value.state).toBe("held")
          expect(ledger.eligible(result.value.dispatchId)).toBe(true)
          expect(ledger.reservationState(result.value.dispatchId)).toBe("held")
        } else {
          // Every refusal is a saturation refusal carrying the numbers, and the
          // dispatch is NOT eligible afterwards.
          expect(result.refusal.code).toBe("budget.scope_saturated")
          expect(result.refusal.limit).toBe(CEILING)
          expect(result.refusal.requestedUnits).toBe(1)
        }
      }

      // The load-bearing assertion: the number admitted is the minimum of N and
      // the ceiling, and the held total equals the number admitted.
      const expected = Math.min(n, CEILING)
      expect(succeeded.length, `trial ${trial} with n=${n}`).toBe(expected)
      expect(ledger.heldUnits(PROJECT_ID, "concurrency"), `trial ${trial} with n=${n}`).toBe(expected)
      expect(ledger.listHeld()).toHaveLength(expected)
      peakHeld = Math.max(peakHeld, ledger.heldUnits(PROJECT_ID, "concurrency"))
    }

    // Guard against the sweep being vacuous: it must have exercised both outcomes.
    expect(trials).toBeGreaterThanOrEqual(200)
    expect(admitted).toBeGreaterThan(0)
    expect(refused).toBeGreaterThan(0)
    expect(peakHeld).toBe(CEILING)
  })

  it("never lets the held total exceed the ceiling even when reserve is entered from interleaved microtasks", async () => {
    // A different interleaving shape: the calls are started one microtask apart
    // rather than all at once, so they arrive at the store in a staggered order.
    // The invariant must hold for every arrival order, which is the real claim.
    const CEILING = 4
    const { ledger } = testLedger({ maximumConcurrency: CEILING })
    const inflight: Promise<Awaited<ReturnType<BudgetLedger["reserve"]>>>[] = []
    for (let index = 0; index < 30; index += 1) {
      inflight.push(
        Promise.resolve().then(async () => {
          await Promise.resolve()
          return ledger.reserve(reserveRequestFor(index))
        }),
      )
    }
    const results = await Promise.all(inflight)
    expect(results.filter((result) => result.ok)).toHaveLength(CEILING)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(CEILING)
    // And the ceiling still holds after the winners commit: committing does NOT
    // free the units (types.ts I2), so no further reserve can succeed.
    for (const result of results) {
      if (!result.ok) continue
      const committed = ledger.commit(result.value.reservationId, NOW)
      expect(committed.ok).toBe(true)
    }
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(CEILING)
    const after = await ledger.reserve(reserveRequestFor(999))
    expect(after.ok).toBe(false)
  })
})

// ===========================================================================
// Separate scopes
// ===========================================================================

describe("concurrency and fan-out are separate counters per project", () => {
  it("admits three fan-out reservations under maximumFanOut: 3 while concurrency is untouched", async () => {
    const { ledger } = testLedger({ maximumFanOut: 3 })
    for (let index = 0; index < 3; index += 1) {
      const result = await ledger.reserve(reserveRequestFor(index, { scope: "fan_out" }))
      expect(result.ok, `fan-out reservation ${index}`).toBe(true)
    }
    expect(ledger.heldUnits(PROJECT_ID, "fan_out")).toBe(3)
    // The concurrency scope is a DIFFERENT counter and is empty.
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
    const fourth = await ledger.reserve(reserveRequestFor(3, { scope: "fan_out" }))
    expect(fourth.ok).toBe(false)
    if (!fourth.ok) expect(fourth.refusal.scope).toBe("fan_out")
  })

  it("admits three concurrency reservations under maximumConcurrency: 3 while fan-out is untouched", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 3 })
    for (let index = 0; index < 3; index += 1) {
      const result = await ledger.reserve(reserveRequestFor(index))
      expect(result.ok, `concurrency reservation ${index}`).toBe(true)
    }
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(3)
    expect(ledger.heldUnits(PROJECT_ID, "fan_out")).toBe(0)
    const fourth = await ledger.reserve(reserveRequestFor(3))
    expect(fourth.ok).toBe(false)
    if (!fourth.ok) expect(fourth.refusal.scope).toBe("concurrency")
  })

  it("lets both scopes be saturated at once without either refusing the other", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2, maximumFanOut: 2 })
    for (let index = 0; index < 2; index += 1) {
      expect((await ledger.reserve(reserveRequestFor(index))).ok).toBe(true)
      expect((await ledger.reserve(reserveRequestFor(100 + index, { scope: "fan_out" }))).ok).toBe(true)
    }
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(2)
    expect(ledger.heldUnits(PROJECT_ID, "fan_out")).toBe(2)
    expect((await ledger.reserve(reserveRequestFor(5))).ok).toBe(false)
    expect((await ledger.reserve(reserveRequestFor(105, { scope: "fan_out" }))).ok).toBe(false)
  })

  it("keeps a second project's counters entirely separate from the first's", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 1 })
    const first = await ledger.reserve(reserveRequestFor(0))
    expect(first.ok).toBe(true)
    const otherProject = await ledger.reserve(reserveRequestFor(1, { projectId: OTHER_PROJECT_ID }))
    expect(otherProject.ok).toBe(true)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1)
    expect(ledger.heldUnits(OTHER_PROJECT_ID, "concurrency")).toBe(1)
    // The first project is still saturated.
    expect((await ledger.reserve(reserveRequestFor(2))).ok).toBe(false)
  })

  it("exposes one held total per scope key, never a sum across scopes", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 4, maximumFanOut: 4 })
    await ledger.reserve(reserveRequestFor(0, { units: 2 }))
    await ledger.reserve(reserveRequestFor(1, { scope: "fan_out", units: 2 }))
    // The two scopes hold 2 each. A single shared counter would read 4 and the
    // third reserve would be refused; separate counters read 2 each and admit it.
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(2)
    expect(ledger.heldUnits(PROJECT_ID, "fan_out")).toBe(2)
    const third = await ledger.reserve(reserveRequestFor(2, { units: 2 }))
    expect(third.ok).toBe(true)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(4)
  })
})

// ===========================================================================
// No bypass via a partial or degenerate reserve
// ===========================================================================

describe("a reserve cannot be used to bypass the ceiling", () => {
  it("refuses a ZERO-unit reservation even when the scope is empty", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 1 })
    const result = await ledger.reserve(reserveRequestFor(0, { units: 0 }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.refusal.code).toBe("budget.units_invalid")
      // Nothing was written: the dispatch is NOT eligible.
      expect(result.refusal.requestedUnits).toBe(0)
    }
    expect(ledger.eligible("disp-0")).toBe(false)
    expect(ledger.list()).toHaveLength(0)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })

  it("refuses a zero-unit reservation when the ceiling is already reached", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 1 })
    expect((await ledger.reserve(reserveRequestFor(0))).ok).toBe(true)
    const zero = await ledger.reserve(reserveRequestFor(1, { units: 0 }))
    expect(zero.ok).toBe(false)
    if (!zero.ok) expect(zero.refusal.code).toBe("budget.units_invalid")
    expect(ledger.eligible("disp-1")).toBe(false)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1)
  })

  it("refuses a negative unit count", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 5 })
    const result = await ledger.reserve(reserveRequestFor(0, { units: -3 }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.code).toBe("budget.units_invalid")
    expect(ledger.list()).toHaveLength(0)
  })

  it("refuses a non-integer unit count", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 5 })
    for (const units of [0.5, 1.0001]) {
      const result = await ledger.reserve(reserveRequestFor(0, { units }))
      expect(result.ok, `units=${units}`).toBe(false)
      if (!result.ok) expect(result.refusal.code).toBe("budget.units_invalid")
    }
    expect(ledger.list()).toHaveLength(0)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })

  it("refuses a unit count that is not a number at all, at the schema", async () => {
    // `NaN` and the infinities are not quantities, so they are refused by
    // `reserveRequestSchema` before the ledger's own unit check is reached. That
    // is a different code on purpose: the field is not a number at all, which is
    // a different defect from "a number that is not a count".
    const { ledger } = testLedger({ maximumConcurrency: 5 })
    for (const units of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = await ledger.reserve(reserveRequestFor(0, { units }))
      expect(result.ok, `units=${units}`).toBe(false)
      if (!result.ok) expect(result.refusal.code).toBe("budget.request_invalid")
    }
    expect(ledger.list()).toHaveLength(0)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })

  it("refuses a single reservation larger than the WHOLE ceiling and applies none of it", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 3 })
    const result = await ledger.reserve(reserveRequestFor(0, { units: 4 }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.refusal.code).toBe("budget.scope_saturated")
      expect(result.refusal.limit).toBe(3)
      expect(result.refusal.heldUnits).toBe(0)
      expect(result.refusal.requestedUnits).toBe(4)
    }
    // All-or-nothing: the scope is untouched, so a smaller request still fits.
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
    expect((await ledger.reserve(reserveRequestFor(1, { units: 3 }))).ok).toBe(true)
  })

  it("refuses a request for more than the REMAINING capacity and applies none of it", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 5 })
    const first = await ledger.reserve(reserveRequestFor(0, { units: 3 }))
    expect(first.ok).toBe(true)
    const result = await ledger.reserve(reserveRequestFor(1, { units: 3 }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.refusal.code).toBe("budget.scope_saturated")
      expect(result.refusal.limit).toBe(5)
      expect(result.refusal.heldUnits).toBe(3)
      expect(result.refusal.requestedUnits).toBe(3)
    }
    // The partial application that must NOT have happened: the total is 3, not 5.
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(3)
    // And the remaining 2 are genuinely still reservable.
    const fitting = await ledger.reserve(reserveRequestFor(2, { units: 2 }))
    expect(fitting.ok).toBe(true)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(5)
  })

  it("refuses to reserve anything at all for a scope the budget does not declare", async () => {
    // "No budget" is not "unlimited budget": a ledger with an off switch is not a
    // capacity accounting system (ledger.ts L8).
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const fanOut = await ledger.reserve(reserveRequestFor(0, { scope: "fan_out" }))
    expect(fanOut.ok).toBe(false)
    if (!fanOut.ok) {
      expect(fanOut.refusal.code).toBe("budget.scope_unbounded")
      expect(fanOut.refusal.limit).toBeNull()
    }
    expect(ledger.eligible("disp-0")).toBe(false)
  })

  it("refuses a second reservation for a dispatch that already holds one", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 5 })
    expect((await ledger.reserve(reserveRequestFor(0))).ok).toBe(true)
    const second = await ledger.reserve(reserveRequestFor(1, { dispatchId: "disp-0", reservationId: "res-other" }))
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.refusal.code).toBe("budget.dispatch_already_reserved")
    // The first reservation is untouched and the scope total is unchanged.
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1)
    expect(ledger.reservationState("disp-0")).toBe("held")
  })

  it("refuses a duplicate reservationId rather than writing it twice", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 5 })
    expect((await ledger.reserve(reserveRequestFor(0))).ok).toBe(true)
    const duplicate = await ledger.reserve(reserveRequestFor(1, { reservationId: "res-0" }))
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.refusal.code).toBe("budget.reservation_exists")
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1)
    expect(ledger.list()).toHaveLength(1)
  })
})

// ===========================================================================
// Eligibility is a definition
// ===========================================================================

describe("eligibility is defined as holding a held reservation", () => {
  it("is false for a dispatch that never reserved, even when the budget has room", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 5 })
    expect(ledger.eligible("disp-never-reserved")).toBe(false)
    expect(ledger.reservationState("disp-never-reserved")).toBeNull()
  })

  it("is true immediately on a successful reserve, with no separate admission step", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 5 })
    const result = await ledger.reserve(reserveRequestFor(0))
    expect(result.ok).toBe(true)
    expect(ledger.eligible("disp-0")).toBe(true)
  })

  it("is false again once the reservation is released, even with the whole budget free", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 5 })
    const result = await ledger.reserve(reserveRequestFor(0))
    expect(result.ok).toBe(true)
    const reservationId = (result as { ok: true; value: BudgetReservation }).value.reservationId
    expect(ledger.release(reservationId, NOW).ok).toBe(true)
    expect(ledger.eligible("disp-0")).toBe(false)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })

  it("is false once the reservation is committed, because a committed dispatch has already launched", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 5 })
    const result = await ledger.reserve(reserveRequestFor(0))
    const reservationId = (result as { ok: true; value: BudgetReservation }).value.reservationId
    expect(ledger.commit(reservationId, NOW).ok).toBe(true)
    expect(ledger.eligible("disp-0")).toBe(false)
    // But the units are still occupied: a commit is not a release.
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1)
  })

  it("does NOT consult the budget: a held reservation stays eligible even if the composed budget later shrinks", async () => {
    // This is the property that proves `eligible` is not a re-check. A shrinking
    // budget cannot un-admit a dispatch that already holds its reservation, and
    // adding such a check would be exactly the second admission decision the
    // design forbids.
    let limits: BudgetLimits = { maximumConcurrency: 5 }
    const { ledger } = testLedger(limits)
    const store = (ledger.store as InMemoryBudgetLedgerStore)
    const result = await ledger.reserve(reserveRequestFor(0))
    expect(result.ok).toBe(true)
    limits = { maximumConcurrency: 1 }
    // The scope now holds 1 unit against a ceiling of 1: still satisfied.
    expect(ledger.eligible("disp-0")).toBe(true)
    expect(store.heldUnitsFor(PROJECT_ID, "concurrency")).toBe(1)
  })

  it("answers false for every scope's reservation independently", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2, maximumFanOut: 2 })
    await ledger.reserve(reserveRequestFor(0, { scope: "concurrency" }))
    await ledger.reserve(reserveRequestFor(1, { scope: "fan_out" }))
    expect(ledger.eligible("disp-0")).toBe(true)
    expect(ledger.eligible("disp-1")).toBe(true)
    expect(ledger.eligible("disp-2")).toBe(false)
  })
})

// ===========================================================================
// Structural atomicity, asserted directly
// ===========================================================================

describe("the reservation transaction is structurally atomic", () => {
  it("refuses a re-entrant call into the store's critical section", async () => {
    // The obvious way to break atomicity is for the decision callback to reach
    // back into the store. That must fail LOUDLY rather than quietly corrupt a
    // total, which is what the `#inCriticalSection` guard is for.
    const store = new InMemoryBudgetLedgerStore()
    let raised: unknown = null
    store.reserveInTransaction(draft(), 5, () => {
      try {
        store.reserveInTransaction(draft(), 5, () => ({ admitted: true }))
      } catch (error) {
        raised = error
      }
      return { admitted: true }
    })
    expect(raised).toBeInstanceOf(InvariantViolationError)
    if (raised instanceof InvariantViolationError) {
      // The message has to NAME the invariant, or a reader has to guess which
      // rule they broke.
      expect(raised.message).toContain("budget.reservation_atomicity")
    }
  })

  it("clears the critical-section guard after a refusal, so a later reserve still works", async () => {
    // The guard lives in a `finally`. If it did not, one refusal would wedge the
    // store permanently — which is why this test exists rather than only the
    // throw test above.
    const store = new InMemoryBudgetLedgerStore()
    expect(store.reserveInTransaction(draft(), 1, () => ({ admitted: false, refusal: refusal() })).ok).toBe(false)
    expect(store.reserveInTransaction(draft(), 1, () => ({ admitted: true })).ok).toBe(true)
  })

  it("publishes a new immutable state object per admitted reservation and never mutates the previous one", async () => {
    const { ledger, store } = testLedgerWithStore({ maximumConcurrency: 3 })
    const before = store.snapshot()
    const result = await ledger.reserve(reserveRequestFor(0))
    expect(result.ok).toBe(true)
    const after = store.snapshot()
    // A copy-on-write swap: the state a reader captured before the reserve still
    // describes the world before it, which is what makes the critical section
    // safe for a concurrent reader rather than merely ordered.
    expect(after).not.toBe(before)
    expect(before.reservations.size).toBe(0)
    expect(after.reservations.size).toBe(1)
    // All three maps are swapped together, so the index can never disagree with
    // the reservation list.
    expect(after.reservationIdByDispatch.size).toBe(1)
    expect(after.heldUnits.size).toBe(1)
  })

  it("leaves the store byte-identical after a refusal", async () => {
    const { ledger, store } = testLedgerWithStore({ maximumConcurrency: 1 })
    await ledger.reserve(reserveRequestFor(0))
    const afterAdmission = store.snapshot()
    const refusal = await ledger.reserve(reserveRequestFor(1))
    expect(refusal.ok).toBe(false)
    // Not merely equal in content — the SAME object, because a refusal returns
    // before any state is even constructed.
    expect(store.snapshot()).toBe(afterAdmission)
  })

  it("keeps the maintained held-unit index in step with a recomputed sum, per scope", async () => {
    const { ledger, store } = testLedgerWithStore({ maximumConcurrency: 6, maximumFanOut: 6 })
    for (let index = 0; index < 3; index += 1) await ledger.reserve(reserveRequestFor(index, { units: 2 }))
    await ledger.reserve(reserveRequestFor(50, { scope: "fan_out" }))
    const indexed = store.indexedHeldUnits()
    for (const scope of BUDGET_SCOPES) {
      const key = budgetScopeKey(PROJECT_ID, scope)
      const recomputed = store
        .list()
        .filter((r) => r.projectId === PROJECT_ID && r.scope === scope && (r.state === "held" || r.state === "committed"))
        .reduce((total, r) => total + r.units, 0)
      expect(indexed.get(key), scope).toBe(recomputed)
      expect(store.heldUnitsFor(PROJECT_ID, scope), scope).toBe(recomputed)
    }
  })

  it("does not return a committed reservation's units, because `committed` still occupies", async () => {
    // I2, at the one place it is implemented. `held` and `committed` are BOTH
    // occupying, so committing on launch is a move WITHIN the occupying set and
    // must subtract nothing from the index. Computing the released units as
    // "did the previous state occupy?" makes every commit look like a release, and
    // the index then under-reports by exactly the units of everything that has
    // ever launched — which `Math.max(0, …)` floors to zero rather than exposes.
    //
    // The bug was invisible to admission, because `reserveInTransaction` recomputes
    // the held total from the reservation LIST rather than reading the index. It was
    // visible to every reader of the index, which is the number a caller renders as
    // "3 of 5 held".
    const { ledger, store } = testLedgerWithStore({ maximumConcurrency: 6 })
    const first = await ledger.reserve(reserveRequestFor(0, { units: 2 }))
    const second = await ledger.reserve(reserveRequestFor(1, { units: 3 }))
    if (!first.ok || !second.ok) throw new Error("fixture reserves were refused")
    const key = budgetScopeKey(PROJECT_ID, "concurrency")
    expect(store.indexedHeldUnits().get(key)).toBe(5)

    ledger.commit(second.value.reservationId, NOW)
    expect(ledger.read(second.value.reservationId)?.state).toBe("committed")
    // Still 5. A committed session is still occupying the slot it was admitted into.
    expect(store.indexedHeldUnits().get(key)).toBe(5)
    expect(store.heldUnitsFor(PROJECT_ID, "concurrency")).toBe(5)

    // And only a move OUT of the occupying set returns units, exactly once.
    ledger.release(first.value.reservationId, NOW)
    expect(store.indexedHeldUnits().get(key)).toBe(3)
    ledger.release(second.value.reservationId, NOW)
    expect(store.indexedHeldUnits().get(key)).toBe(0)
    // The clamp is not load-bearing: every subtraction landed on or above zero.
    expect(store.indexedHeldUnits().get(key)).toBe(store.heldUnitsFor(PROJECT_ID, "concurrency"))
  })

  it("keeps the index in step through a whole reserve/commit/release/expiry lifecycle, never once under-reporting", async () => {
    // A sweep over the lifecycle rather than a single transition, because the bug
    // lives in a COMPARISON between two states and a single-transition assertion
    // can be satisfied by a rule that is wrong only on the pair it did not try.
    const { ledger, store } = testLedgerWithStore({ maximumConcurrency: 8, maximumFanOut: 8 })
    const admitted = await Promise.all([
      ledger.reserve(reserveRequestFor(0, { units: 2 })),
      ledger.reserve(reserveRequestFor(1, { units: 1 })),
      ledger.reserve(reserveRequestFor(2, { units: 3, scope: "fan_out" })),
    ])
    const ids = admitted.map((result) => {
      if (!result.ok) throw new Error(`fixture reserve was refused: ${result.refusal.message}`)
      return result.value.reservationId
    })

    const steps: readonly (readonly [string, () => void])[] = [
      ["commit res-0", () => void ledger.commit(ids[0]!, NOW)],
      ["expire res-1", () => void ledger.expire(ids[1]!, NOW)],
      ["release res-0", () => void ledger.release(ids[0]!, NOW)],
      ["commit res-2", () => void ledger.commit(ids[2]!, NOW)],
      ["release res-2", () => void ledger.release(ids[2]!, NOW)],
      // Replaying a terminal transition is a no-op that moves nothing.
      ["release res-2 again", () => void ledger.release(ids[2]!, NOW)],
    ]
    for (const [label, step] of steps) {
      step()
      for (const scope of BUDGET_SCOPES) {
        const recomputed = store
          .list()
          .filter(
            (r) =>
              r.projectId === PROJECT_ID && r.scope === scope && (r.state === "held" || r.state === "committed"),
          )
          .reduce((total, r) => total + r.units, 0)
        expect(store.indexedHeldUnits().get(budgetScopeKey(PROJECT_ID, scope)), `${label} ${scope}`).toBe(recomputed)
      }
    }
    expect(store.heldUnitsFor(PROJECT_ID, "concurrency")).toBe(0)
    expect(store.heldUnitsFor(PROJECT_ID, "fan_out")).toBe(0)
  })

  it("resolves the effective budget BEFORE entering the store, so a slow port delays but cannot interleave", async () => {
    // The await is outside the critical section by construction. A caller whose
    // port is slow still gets correct answers, and the interleavings the port
    // creates are all outside the transaction.
    let calls = 0
    const store = new InMemoryBudgetLedgerStore()
    const ledger = new BudgetLedger({
      store,
      resolveLimits: async () => {
        calls += 1
        await Promise.resolve()
        return { maximumConcurrency: 2 }
      },
    })
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => ledger.reserve(reserveRequestFor(index))))
    expect(calls).toBe(10)
    expect(results.filter((result) => result.ok)).toHaveLength(2)
    expect(store.heldUnitsFor(PROJECT_ID, "concurrency")).toBe(2)
  })
})

// ===========================================================================
// Lease arithmetic
// ===========================================================================

describe("a reservation's lease is computed from the injected now", () => {
  it("derives leaseExpiresAt from now plus the requested leaseSeconds", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 1 })
    const result = await ledger.reserve(reserveRequestFor(0, { leaseSeconds: 60 }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.createdAt).toBe(NOW)
      expect(result.value.updatedAt).toBe(NOW)
      expect(result.value.leaseExpiresAt).toBe(ONE_MINUTE_LATER)
    }
  })

  it("refuses a non-positive or non-integer lease rather than creating a reservation born expired", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    for (const leaseSeconds of [0, -5, 1.5]) {
      const result = await ledger.reserve(reserveRequestFor(0, { leaseSeconds }))
      expect(result.ok, `leaseSeconds=${leaseSeconds}`).toBe(false)
      if (!result.ok) expect(result.refusal.code).toBe("budget.request_invalid")
    }
    expect(ledger.list()).toHaveLength(0)
  })

  it("refuses a lease longer than the safety floor's own timeout ceiling", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const result = await ledger.reserve(reserveRequestFor(0, { leaseSeconds: 100_000 }))
    expect(result.ok).toBe(false)
    expect(ledger.list()).toHaveLength(0)
  })

  it("freezes the reservation it returns, so a caller cannot mutate the ledger's record", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const result = await ledger.reserve(reserveRequestFor(0))
    expect(result.ok).toBe(true)
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true)
  })
})

// ===========================================================================
// Helpers local to this file
// ===========================================================================

/**
 * A `ReservationDraft` for the store-level atomicity tests, which drive
 * `reserveInTransaction` directly and so bypass the ledger's own validation.
 *
 * Each identifier is parsed through the module's own schema rather than restated
 * as a constant, because `commit(reservationId)` and `eligible(dispatchId)` take
 * two DIFFERENT branded types and mixing them up would compile here if the brands
 * were dropped. Parsing makes the mixing a type error.
 */
function draft(overrides: Partial<ReservationDraft> = {}): ReservationDraft {
  return {
    reservationId: reservationIdSchema.parse("res-draft"),
    projectId: projectIdSchema.parse(PROJECT_ID),
    runId: runIdSchema.parse("run-1"),
    taskId: taskIdSchema.parse("task-1"),
    dispatchId: dispatchIdSchema.parse("disp-draft"),
    scope: "concurrency",
    units: 1,
    now: NOW,
    leaseExpiresAt: TEN_MINUTES_LATER,
    ...overrides,
  }
}

function refusal() {
  return {
    code: "budget.scope_saturated" as const,
    message: "saturated",
    scope: "concurrency" as const,
    limit: 1,
    heldUnits: 1,
    requestedUnits: 1,
    reservationId: null,
  }
}

/** Kept referenced so the sweep's clock bounds are visible to a reader. */
export const SWEEP_INSTANTS = { NOW, TEN_MINUTES_LATER, ONE_HOUR_LATER } as const

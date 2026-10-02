/**
 * M6.5 — the ledger's ordinary behaviour: transitions, idempotency, and the
 * capacity accounting around them.
 *
 * `reservation.test.ts` owns the atomicity claim. This file owns everything the
 * ledger does AFTER a reservation exists, and in particular the property that
 * makes a crash-and-replay safe: **every transition is idempotent and every
 * terminal state is absorbing.**
 *
 * Why that is the load-bearing property rather than a nicety: a crash between
 * reserve and release means the orchestrator will re-issue whatever transition it
 * was in the middle of. If `release` decremented the held total twice, a replay
 * would INCREASE the available capacity — the ledger would be inventing room that
 * no budget declared. If `commit` after `release` resurrected a terminal
 * reservation, a replay would make an already-finished dispatch eligible to launch
 * again. Both are the kind of bug a single-call test cannot see, so each is
 * asserted at least twice here: once directly, and once through the total.
 *
 * The occupancy rule asserted throughout is types.ts I2: `held` AND `committed`
 * both occupy; `released` AND `expired` both free. A committed reservation is a
 * session that has LAUNCHED, so releasing its units at commit would let the next
 * dispatch start while the previous one still holds a session.
 */

import { describe, expect, it } from "vitest"
import {
  BUDGET_SCOPES,
  OCCUPYING_RESERVATION_STATES,
  RESERVATION_STATES,
  RESERVATION_TRANSITIONS,
  TERMINAL_RESERVATION_STATES,
  budgetRefusalSchema,
  budgetReservationSchema,
  isHeld,
  isTerminalReservationState,
  occupiesCapacity,
  reservationIdSchema,
  toContractError,
  type BudgetReservation,
  type ReservationId,
  type ReservationState,
} from "../../../src/budgets/index.js"
import { NOW, ONE_MINUTE_LATER, PROJECT_ID, reserveRequestFor, testLedger, testLedgerWithStore } from "./fixtures.js"

/** Reserves once and returns the reservation, failing loudly if it did not. */
async function reserveOnce(
  ledger: Awaited<ReturnType<typeof testLedger>>["ledger"],
  index: number,
  overrides: Parameters<typeof reserveRequestFor>[1] = {},
): Promise<BudgetReservation> {
  const result = await ledger.reserve(reserveRequestFor(index, overrides))
  if (!result.ok) throw new Error(`fixture reserve ${index} was refused: ${result.refusal.message}`)
  return result.value
}

function reservationIdOf(index: number): ReservationId {
  return reservationIdSchema.parse(`res-${index}`)
}

// ===========================================================================
// Transitions
// ===========================================================================

describe("commit, release and expire move a reservation and return its units", () => {
  it("commits a held reservation on launch, keeping its units occupied", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const reservation = await reserveOnce(ledger, 0)
    const committed = ledger.commit(reservation.reservationId, NOW)
    expect(committed.ok).toBe(true)
    if (committed.ok) {
      expect(committed.value.changed).toBe(true)
      expect(committed.value.previousState).toBe("held")
      expect(committed.value.reservation.state).toBe("committed")
    }
    // A launch does not free the slot it was admitted into.
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1)
    expect(ledger.reservationState("disp-0")).toBe("committed")
  })

  it("releases a committed reservation on a terminal dispatch state, returning its units", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const reservation = await reserveOnce(ledger, 0)
    ledger.commit(reservation.reservationId, NOW)
    const released = ledger.release(reservation.reservationId, ONE_MINUTE_LATER)
    expect(released.ok).toBe(true)
    if (released.ok) expect(released.value.reservation.state).toBe("released")
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
    expect(ledger.eligible("disp-0")).toBe(false)
  })

  it("releases a HELD reservation directly, without a commit in between", async () => {
    // A dispatch that was approved and reserved but then cancelled never launched.
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const reservation = await reserveOnce(ledger, 0)
    const released = ledger.release(reservation.reservationId, NOW)
    expect(released.ok).toBe(true)
    if (released.ok) expect(released.value.previousState).toBe("held")
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })

  it("expires a held reservation when its lease passes", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const reservation = await reserveOnce(ledger, 0)
    const expired = ledger.expire(reservation.reservationId, ONE_MINUTE_LATER)
    expect(expired.ok).toBe(true)
    if (expired.ok) {
      expect(expired.value.reservation.state).toBe("expired")
      // The `updatedAt` moves with the transition, so an audit can tell when the
      // reclamation happened rather than only when the reservation was made.
      expect(expired.value.reservation.updatedAt).toBe(ONE_MINUTE_LATER)
      expect(expired.value.reservation.createdAt).toBe(NOW)
    }
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })

  it("stamps updatedAt on every transition and leaves createdAt alone", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const reservation = await reserveOnce(ledger, 0)
    ledger.commit(reservation.reservationId, "2026-03-01T12:00:10.000Z")
    const afterCommit = ledger.read(reservation.reservationId)
    expect(afterCommit?.createdAt).toBe(NOW)
    expect(afterCommit?.updatedAt).toBe("2026-03-01T12:00:10.000Z")
    ledger.release(reservation.reservationId, "2026-03-01T12:00:20.000Z")
    const afterRelease = ledger.read(reservation.reservationId)
    expect(afterRelease?.createdAt).toBe(NOW)
    expect(afterRelease?.updatedAt).toBe("2026-03-01T12:00:20.000Z")
  })

  it("refuses a transition on a reservation that does not exist, as a Result", async () => {
    // A replay legitimately names reservations that were never written, so this
    // must not be a throw.
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const result = ledger.release(reservationIdSchema.parse("res-never-written"), NOW)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.code).toBe("budget.reservation_unknown")
  })

  it("refuses a transition into 'held', because that would make a dispatch eligible without reserving capacity", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const reservation = await reserveOnce(ledger, 0)
    ledger.release(reservation.reservationId, NOW)
    const attempt = ledger.transition(reservation.reservationId, "held" as never, NOW)
    expect(attempt.ok).toBe(false)
    if (!attempt.ok) expect(attempt.refusal.code).toBe("budget.request_invalid")
    // The terminal state survived the attempt.
    expect(ledger.reservationState("disp-0")).toBe("released")
  })

  it("exposes a transition vocabulary that cannot name 'held'", () => {
    expect([...RESERVATION_TRANSITIONS].sort()).toEqual(["committed", "expired", "released"])
    expect(RESERVATION_TRANSITIONS).not.toContain("held")
  })

  it("classifies states the same way everywhere: occupying, terminal, held", () => {
    for (const state of RESERVATION_STATES) {
      const occupying = occupiesCapacity(state)
      const terminal = isTerminalReservationState(state)
      const held = isHeld(state)
      // Exactly two states occupy, exactly two are terminal, one is held, and the
      // classifications partition the four states with no overlaps beyond `held`
      // being occupying.
      expect(occupying, state).toBe(state === "held" || state === "committed")
      expect(terminal, state).toBe(state === "released" || state === "expired")
      expect(held, state).toBe(state === "held")
      expect(occupying && terminal, state).toBe(false)
      expect(held && !occupying, state).toBe(false)
    }
    expect([...OCCUPYING_RESERVATION_STATES].sort()).toEqual(["committed", "held"])
    expect([...TERMINAL_RESERVATION_STATES].sort()).toEqual(["expired", "released"])
    expect(BUDGET_SCOPES).toHaveLength(2)
  })
})

// ===========================================================================
// Idempotency — the crash-replay property
// ===========================================================================

describe("every transition is idempotent and terminal states are absorbing", () => {
  it("committing twice is a no-op the second time and moves no units", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const reservation = await reserveOnce(ledger, 0)
    const first = ledger.commit(reservation.reservationId, NOW)
    expect(first.ok && first.value.changed).toBe(true)
    const second = ledger.commit(reservation.reservationId, "2026-03-01T12:00:05.000Z")
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.value.changed).toBe(false)
      expect(second.value.previousState).toBe("committed")
      // The `updatedAt` of the second call must NOT be applied: a replayed
      // transition that restamped the record would make the history a function of
      // how many times it was retried.
      expect(second.value.reservation.updatedAt).toBe(NOW)
    }
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1)
  })

  it("releasing twice is a no-op the second time and does not increase available capacity", async () => {
    // The specific failure this guards: a replayed `release` decrementing the
    // total twice would leave the ledger claiming MORE room than the budget
    // declares, which is capacity nobody granted.
    const { ledger } = testLedger({ maximumConcurrency: 3 })
    const reservation = await reserveOnce(ledger, 0, { units: 2 })
    expect(ledger.release(reservation.reservationId, NOW).ok).toBe(true)
    const replay = ledger.release(reservation.reservationId, ONE_MINUTE_LATER)
    expect(replay.ok).toBe(true)
    if (replay.ok) expect(replay.value.changed).toBe(false)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
    // And the total is not merely plausible — it is exactly the ceiling, so the
    // whole budget is available and not a unit more.
    const probe = await ledger.reserve(reserveRequestFor(99, { units: 3 }))
    expect(probe.ok).toBe(true)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(3)
    expect((await ledger.reserve(reserveRequestFor(100, { units: 1 }))).ok).toBe(false)
  })

  it("expiring after a release is a no-op and does not resurrect the reservation", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const reservation = await reserveOnce(ledger, 0)
    expect(ledger.release(reservation.reservationId, NOW).ok).toBe(true)
    const expired = ledger.expire(reservation.reservationId, ONE_MINUTE_LATER)
    expect(expired.ok).toBe(true)
    if (expired.ok) {
      expect(expired.value.changed).toBe(false)
      // Still `released`: a terminal state is absorbing, and the second
      // transition did not even move it to its own target state.
      expect(expired.value.reservation.state).toBe("released")
    }
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })

  it("releasing after an expire is a no-op", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const reservation = await reserveOnce(ledger, 0)
    expect(ledger.expire(reservation.reservationId, NOW).ok).toBe(true)
    const released = ledger.release(reservation.reservationId, ONE_MINUTE_LATER)
    expect(released.ok).toBe(true)
    if (released.ok) {
      expect(released.value.changed).toBe(false)
      expect(released.value.reservation.state).toBe("expired")
    }
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })

  it("committing after a release does not make the dispatch eligible again", async () => {
    // The failure this guards: a replayed `commit` resurrecting a terminal
    // reservation would make a finished dispatch eligible to launch a second
    // time.
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const reservation = await reserveOnce(ledger, 0)
    ledger.release(reservation.reservationId, NOW)
    const lateCommit = ledger.commit(reservation.reservationId, ONE_MINUTE_LATER)
    expect(lateCommit.ok).toBe(true)
    if (lateCommit.ok) {
      expect(lateCommit.value.changed).toBe(false)
      expect(lateCommit.value.reservation.state).toBe("released")
    }
    expect(ledger.eligible("disp-0")).toBe(false)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })

  it("survives a long interleaved replay of every transition without changing the total", async () => {
    // Twenty replays of each transition, in an interleaved order, against a total
    // of 4. The total must be exactly what the non-replayed sequence produces.
    const { ledger } = testLedger({ maximumConcurrency: 4 })
    const reservation = await reserveOnce(ledger, 0, { units: 2 })
    const id = reservation.reservationId
    ledger.commit(id, NOW)
    for (let round = 0; round < 20; round += 1) {
      ledger.commit(id, ONE_MINUTE_LATER)
      ledger.release(id, ONE_MINUTE_LATER)
      ledger.expire(id, ONE_MINUTE_LATER)
      ledger.commit(id, ONE_MINUTE_LATER)
      ledger.release(id, ONE_MINUTE_LATER)
    }
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
    expect(ledger.reservationState("disp-0")).toBe("released")
    expect(ledger.eligible("disp-0")).toBe(false)
    // The full budget is available — exactly the ceiling, no more.
    const probe = await ledger.reserve(reserveRequestFor(50, { units: 4 }))
    expect(probe.ok).toBe(true)
    expect((await ledger.reserve(reserveRequestFor(51, { units: 1 }))).ok).toBe(false)
  })

  it("refuses to commit a reservation that already released, even when the refusal path would be idempotent", async () => {
    // Belt and braces on L6: the store refuses a `committed` transition out of a
    // non-`held` state, and the ledger surfaces it as a refusal rather than an
    // exception reaching a caller mid-orchestration.
    const { ledger, store } = testLedgerWithStore({ maximumConcurrency: 2 })
    const reservation = await reserveOnce(ledger, 0)
    ledger.release(reservation.reservationId, NOW)
    const raw = store.transition(reservation.reservationId, "committed", ONE_MINUTE_LATER)
    expect(raw.changed).toBe(false)
    expect(raw.reservation.state).toBe("released")
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })
})

// ===========================================================================
// Capacity accounting
// ===========================================================================

describe("the held total tracks only OCCUPYING reservations", () => {
  it("counts held and committed, and excludes released and expired", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 20 })
    const held = await reserveOnce(ledger, 0, { units: 1 })
    const committed = await reserveOnce(ledger, 1, { units: 2 })
    const released = await reserveOnce(ledger, 2, { units: 4 })
    const expired = await reserveOnce(ledger, 3, { units: 8 })
    ledger.commit(committed.reservationId, NOW)
    ledger.release(released.reservationId, NOW)
    ledger.expire(expired.reservationId, NOW)
    // 1 (held) + 2 (committed) = 3; the released 4 and the expired 8 are gone.
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(3)
    // Only the HELD one is launch-eligible.
    expect(ledger.eligible("disp-0")).toBe(true)
    expect(ledger.eligible("disp-1")).toBe(false)
    expect(ledger.listHeld().map((reservation) => reservation.dispatchId)).toEqual(["disp-0"])
    // But all four are still listed: a terminal reservation is auditable, not
    // deleted.
    expect(ledger.list()).toHaveLength(4)
    expect(held.state).toBe("held")
  })

  it("counts units, not reservations, so a multi-unit reservation weighs more", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 5 })
    await reserveOnce(ledger, 0, { units: 3 })
    await reserveOnce(ledger, 1, { units: 2 })
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(5)
    expect(ledger.listHeld()).toHaveLength(2)
    expect((await ledger.reserve(reserveRequestFor(2))).ok).toBe(false)
  })

  it("keeps the two scopes' totals independent through a mixed sequence of transitions", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 4, maximumFanOut: 4 })
    const c0 = await reserveOnce(ledger, 0, { units: 2, scope: "concurrency" })
    const c1 = await reserveOnce(ledger, 1, { units: 2, scope: "concurrency" })
    const f0 = await reserveOnce(ledger, 2, { units: 3, scope: "fan_out" })
    ledger.commit(c0.reservationId, NOW)
    ledger.release(c1.reservationId, NOW)
    ledger.expire(f0.reservationId, NOW)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(2)
    expect(ledger.heldUnits(PROJECT_ID, "fan_out")).toBe(0)
    // Concurrency still has 2 free, fan-out has all 4.
    expect((await ledger.reserve(reserveRequestFor(3, { units: 2, scope: "concurrency" }))).ok).toBe(true)
    expect((await ledger.reserve(reserveRequestFor(4, { units: 4, scope: "fan_out" }))).ok).toBe(true)
    expect((await ledger.reserve(reserveRequestFor(5, { units: 1, scope: "concurrency" }))).ok).toBe(false)
    expect((await ledger.reserve(reserveRequestFor(6, { units: 1, scope: "fan_out" }))).ok).toBe(false)
  })
})

// ===========================================================================
// Ordering and reporting
// ===========================================================================

describe("ledger listings are code-unit ordered and de-duplicated", () => {
  it("lists reservations sorted by reservationId, not by insertion order", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 10 })
    // Inserted out of order on purpose: 'res-9' before 'res-1' would sort wrongly
    // under any comparator that treats the digits as text in a surprising way.
    for (const index of [9, 1, 5, 3, 7]) await reserveOnce(ledger, index)
    expect(ledger.list().map((reservation) => reservation.reservationId)).toEqual([
      "res-1",
      "res-3",
      "res-5",
      "res-7",
      "res-9",
    ])
  })

  it("orders case-differing identifiers by code unit rather than by locale", async () => {
    // `localeCompare` sorts 'a' before 'B' under most ICU locales; code-unit
    // order puts every uppercase letter first, and digits before letters. A
    // report whose order is machine-dependent is a report nobody can diff, which
    // is why the assertion is against `Array.prototype.sort`'s default rather than
    // against a hand-written expectation.
    //
    // The identifiers stay inside the kernel's opaque-id alphabet
    // (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`), so this is a real ordering test and
    // not a test of whether the schema accepts a non-ASCII character.
    const { ledger } = testLedger({ maximumConcurrency: 10 })
    const order = ["b", "B", "a", "A", "Z", "z", "0", "9", "-", "."]
    for (const [index, suffix] of order.entries()) {
      await reserveOnce(ledger, index, { reservationId: `res-${suffix}`, dispatchId: `disp-${suffix}` })
    }
    const ids = ledger.list().map((reservation) => reservation.reservationId)
    const expected = [...ids].sort()
    expect(ids).toEqual(expected)
  })

  it("filters listHeld to state 'held' alone", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 10 })
    const a = await reserveOnce(ledger, 0)
    const b = await reserveOnce(ledger, 1)
    ledger.commit(a.reservationId, NOW)
    ledger.release(b.reservationId, NOW)
    expect(ledger.listHeld()).toEqual([])
    expect(ledger.list()).toHaveLength(2)
  })
})

// ===========================================================================
// The injected port
// ===========================================================================

describe("the ledger composes the budget its resolver returns, per project", () => {
  it("applies a per-project ceiling and refuses a project the resolver does not bound", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 1 })
    expect((await ledger.reserve(reserveRequestFor(0))).ok).toBe(true)
    expect((await ledger.reserve(reserveRequestFor(1))).ok).toBe(false)
  })

  it("reads the budget for the request's OWN project, not a remembered one", async () => {
    const store = testLedger({ maximumConcurrency: 1 }).store
    const { BudgetLedger } = await import("../../../src/budgets/index.js")
    const ledger = new BudgetLedger({
      store,
      resolveLimits: (projectId) => (projectId === PROJECT_ID ? { maximumConcurrency: 1 } : { maximumConcurrency: 5 }),
    })
    expect((await ledger.reserve(reserveRequestFor(0))).ok).toBe(true)
    expect((await ledger.reserve(reserveRequestFor(1, { projectId: "proj-other" }))).ok).toBe(true)
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(1)
    expect(ledger.heldUnits("proj-other", "concurrency")).toBe(1)
  })

  it("reports the composed budget without reserving anything", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 4 })
    const limits = await ledger.budgetFor(PROJECT_ID)
    expect(limits).toEqual({ maximumConcurrency: 4 })
    // Reading a budget is not a reservation and must leave the ledger untouched.
    expect(ledger.list()).toEqual([])
    expect(ledger.heldUnits(PROJECT_ID, "concurrency")).toBe(0)
  })
})

// ===========================================================================
// Refusal shape
// ===========================================================================

describe("every refusal is a named code with structured detail, never a throw", () => {
  it("validates a refusal through its own schema, so an unknown code cannot be constructed", () => {
    const refusal = budgetRefusalSchema.parse({
      code: "budget.scope_saturated",
      message: "concurrency is at 5 of 5",
      scope: "concurrency",
      limit: 5,
      heldUnits: 5,
      requestedUnits: 1,
      reservationId: null,
    })
    expect(refusal.code).toBe("budget.scope_saturated")
    expect(() => budgetRefusalSchema.parse({ ...refusal, code: "budget.made_up" })).toThrow()
  })

  it("carries null rather than an absent member for refusals with no arithmetic behind them", async () => {
    const { ledger } = testLedger({})
    // The default request scope is `concurrency`, and an empty budget bounds
    // neither scope — so the refusal is the unbounded one.
    const result = await ledger.reserve(reserveRequestFor(0))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.refusal.scope).toBe("concurrency")
      expect(result.refusal.limit).toBeNull()
      expect(result.refusal.heldUnits).toBeNull()
      expect(result.refusal.requestedUnits).toBe(1)
      expect(result.refusal.reservationId).toBeNull()
    }
  })

  it("bridges a refusal to the kernel's ContractError shape for the M0 error path", () => {
    const { ledger } = testLedger({ maximumConcurrency: 1 })
    // A bridge, not a throw: the point is that this module never throws.
    expect(typeof toContractError).toBe("function")
    const bridged = toContractError({ code: "budget.scope_saturated", message: "x".repeat(5_000) })
    expect(bridged.category).toBe("policy_denied")
    expect(bridged.retryable).toBe(false)
    // The kernel caps a message at 4096 characters; a longer one is truncated
    // rather than refused, so a refusal never becomes an unserialisable error.
    expect(bridged.message.length).toBe(4_096)
  })
})

// ===========================================================================
// Schemas
// ===========================================================================

describe("the reservation schema refuses the shapes a reservation must not have", () => {
  it("refuses an unknown key", () => {
    const base = {
      reservationId: "res-1",
      projectId: PROJECT_ID,
      runId: "run-1",
      taskId: "task-1",
      dispatchId: "disp-1",
      scope: "concurrency",
      units: 1,
      state: "held" as const,
      leaseExpiresAt: ONE_MINUTE_LATER,
      createdAt: NOW,
      updatedAt: NOW,
    }
    expect(budgetReservationSchema.safeParse(base).success).toBe(true)
    expect(budgetReservationSchema.safeParse({ ...base, extra: true }).success).toBe(false)
    expect(budgetReservationSchema.safeParse({ ...base, units: 0 }).success).toBe(false)
    expect(budgetReservationSchema.safeParse({ ...base, state: "pending" }).success).toBe(false)
  })

  it("refuses a held reservation whose lease expired before it was created", () => {
    // Such a reservation would be launch-eligible and reclaimable at the same
    // instant, which is a state no caller should be able to create.
    const result = budgetReservationSchema.safeParse({
      reservationId: "res-1",
      projectId: PROJECT_ID,
      runId: "run-1",
      taskId: "task-1",
      dispatchId: "disp-1",
      scope: "concurrency",
      units: 1,
      state: "held",
      leaseExpiresAt: "2026-03-01T11:00:00.000Z",
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(result.success).toBe(false)
  })
})

// ===========================================================================
// Purity
// ===========================================================================

describe("the ledger reads no clock and no random source", () => {
  it("produces identical reservations for identical requests", async () => {
    const first = testLedger({ maximumConcurrency: 2 })
    const second = testLedger({ maximumConcurrency: 2 })
    const a = await reserveOnce(first.ledger, 0)
    const b = await reserveOnce(second.ledger, 0)
    expect(a).toEqual(b)
  })

  it("derives every timestamp from the injected now, never from the host clock", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 })
    const reservation = await reserveOnce(ledger, 0, { now: "2031-07-04T00:00:00.000Z", leaseSeconds: 120 })
    expect(reservation.createdAt).toBe("2031-07-04T00:00:00.000Z")
    expect(reservation.updatedAt).toBe("2031-07-04T00:00:00.000Z")
    expect(reservation.leaseExpiresAt).toBe("2031-07-04T00:02:00.000Z")
  })

  it("uses the ledger's default lease when the request does not state one", async () => {
    const { ledger } = testLedger({ maximumConcurrency: 2 }, { defaultLeaseSeconds: 45 })
    // The fixture normally supplies a 600-second lease; this is the one test that
    // needs the member genuinely ABSENT, because a stated `leaseSeconds: undefined`
    // would be refused by the `.strict()` schema instead of falling through to the
    // ledger's default.
    const reservation = await reserveOnce(ledger, 0, { omitLeaseSeconds: true })
    expect(reservation.leaseExpiresAt).toBe("2026-03-01T12:00:45.000Z")
  })
})

/** Keeps the state union referenced so a rename fails here rather than silently. */
export const KNOWN_RESERVATION_STATES: readonly ReservationState[] = RESERVATION_STATES

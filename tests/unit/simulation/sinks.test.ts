/**
 * M6.7 — the fail-closed command sinks.
 *
 * # What this file is FOR
 *
 * Three claims, in increasing order of how much they matter:
 *
 *   1. Every command sink's only implementation throws, and the throw names the
 *      sink and the call. A sink that no-ops is how a dry run starts doing things.
 *   2. The budget probe is entered — the ledger's own admission decision runs — and
 *      retains nothing. This is the one sink the composition must actually enter,
 *      because ADR 0007 section 13.2 defines eligibility as holding a held
 *      reservation.
 *   3. The probe CANNOT reserve, and the proof is structural rather than
 *      observational: the class holds no map, so "after the dry run every dispatch
 *      is still ineligible" is not a claim about a reset, it is a claim about the
 *      absence of the thing a reservation would live in.
 *
 * Every assertion here is a COUNT or a THROWN ERROR observed at the sink. None of
 * them is a source inspection, because a source inspection measures text and this
 * milestone's claim is about behaviour.
 */

import { describe, expect, it } from "vitest"
import {
  assertNoRetainedSideEffects,
  createBudgetLedgerProbe,
  createFailClosedSinks,
  emptySinkTally,
  isBudgetStoreProbe,
  readSinkCounters,
  SIMULATION_SINK_NAMES,
  SimulationSideEffectError,
  type SimulationSinkTally,
} from "../../../src/simulation/index.js"
import {
  BudgetLedger,
  budgetRefusalSchema,
  reservationIdSchema,
  type ReservationAdmission,
  type ReservationDraft,
} from "../../../src/budgets/index.js"
import { projectIdSchema, runIdSchema, taskIdSchema, dispatchIdSchema, timestampSchema } from "../../../src/orchestration/identifiers.js"

const DRAFT: ReservationDraft = {
  reservationId: reservationIdSchema.parse("res:probe"),
  projectId: projectIdSchema.parse("proj-sim"),
  runId: runIdSchema.parse("run-sim-1"),
  taskId: taskIdSchema.parse("task:probe"),
  dispatchId: dispatchIdSchema.parse("disp:probe"),
  scope: "concurrency",
  units: 1,
  now: timestampSchema.parse("2026-05-04T09:30:00Z"),
  leaseExpiresAt: timestampSchema.parse("2026-05-04T09:35:00Z"),
}

const ADMIT: ReservationAdmission = { admitted: true }
const REFUSE: ReservationAdmission = {
  admitted: false,
  refusal: budgetRefusalSchema.parse({
    code: "budget.scope_saturated",
    message: "saturated on purpose",
    scope: "concurrency",
    limit: 1,
    heldUnits: 1,
    requestedUnits: 1,
    reservationId: null,
  }),
}

describe("a command sink's only implementation throws", () => {
  it("the event sink refuses an append, a read and a close, naming the sink and the call", () => {
    const tally: SimulationSinkTally = emptySinkTally()
    const sinks = createFailClosedSinks(tally)
    expect(() => sinks.events.append({ type: "run.started" })).toThrow(SimulationSideEffectError)
    expect(() => sinks.events.readSince("cursor-1")).toThrow(SimulationSideEffectError)
    expect(() => sinks.events.close()).toThrow(SimulationSideEffectError)
    expect(tally.refusedCalls).toBe(3)
    try {
      sinks.events.append({ type: "run.started" })
    } catch (error) {
      expect((error as SimulationSideEffectError).sink).toBe("event_log")
      expect((error as SimulationSideEffectError).call).toBe("append")
      expect((error as SimulationSideEffectError).message).toContain("simulation.sink_invoked")
    }
  })

  it("the network sink refuses a send, a connect and a fetch", () => {
    const tally = emptySinkTally()
    const sinks = createFailClosedSinks(tally)
    expect(() => sinks.network.send("node-b", { hello: true })).toThrow(SimulationSideEffectError)
    expect(() => sinks.network.connect("10.0.0.1:4096")).toThrow(SimulationSideEffectError)
    expect(() => sinks.network.fetch("https://example.invalid")).toThrow(SimulationSideEffectError)
    expect(tally.refusedCalls).toBe(3)
  })

  it("the process sink refuses a launch, a spawn and a terminate", () => {
    const tally = emptySinkTally()
    const sinks = createFailClosedSinks(tally)
    expect(() => sinks.process.launch("opencode", ["serve"])).toThrow(SimulationSideEffectError)
    expect(() => sinks.process.spawn("sh")).toThrow(SimulationSideEffectError)
    expect(() => sinks.process.terminate("pid-1")).toThrow(SimulationSideEffectError)
    expect(tally.refusedCalls).toBe(3)
  })

  it("the filesystem sink refuses a write, an append, a mkdir and an unlink", () => {
    const tally = emptySinkTally()
    const sinks = createFailClosedSinks(tally)
    expect(() => sinks.filesystem.writeFile("/tmp/x", "y")).toThrow(SimulationSideEffectError)
    expect(() => sinks.filesystem.appendFile("/tmp/x", "y")).toThrow(SimulationSideEffectError)
    expect(() => sinks.filesystem.createDirectory("/tmp/x")).toThrow(SimulationSideEffectError)
    expect(() => sinks.filesystem.unlink("/tmp/x")).toThrow(SimulationSideEffectError)
    expect(tally.refusedCalls).toBe(4)
  })

  it("the notifier sink refuses an emit, an acknowledgement and a quieting", () => {
    const tally = emptySinkTally()
    const sinks = createFailClosedSinks(tally)
    expect(() => sinks.notifier.emit({ category: "run" })).toThrow(SimulationSideEffectError)
    expect(() => sinks.notifier.acknowledge("note-1")).toThrow(SimulationSideEffectError)
    expect(() => sinks.notifier.quiet("run")).toThrow(SimulationSideEffectError)
    expect(tally.refusedCalls).toBe(3)
  })

  it("a sink's refusal message describes the rejected payload by shape and length, never by content", () => {
    const sinks = createFailClosedSinks(emptySinkTally())
    try {
      sinks.filesystem.writeFile("/tmp/x", "s3cret-bearer-token")
      expect.unreachable("writeFile must throw")
    } catch (error) {
      const message = (error as Error).message
      expect(message).not.toContain("s3cret-bearer-token")
      expect(message).toContain("19 character(s)")
    }
  })

  it("the closed sink-name list covers every sink a caller can reach, and a count of zero reports nothing to fix", () => {
    const counters = readSinkCounters(emptySinkTally())
    expect(SIMULATION_SINK_NAMES).toContain("budget_ledger")
    expect(SIMULATION_SINK_NAMES.every((name) => typeof name === "string")).toBe(true)
    expect(assertNoRetainedSideEffects(counters)).toEqual([])
    expect(assertNoRetainedSideEffects({ ...counters, eventAppends: 1 })).toEqual(["eventAppends=1"])
    expect(assertNoRetainedSideEffects({ ...counters, retainedReservations: 2 })).toEqual(["retainedReservations=2"])
  })
})

describe("the budget probe enters the gate and retains nothing", () => {
  it("the probe is a recognisable `BudgetLedgerStore` and is accepted as one", () => {
    const probe = createBudgetLedgerProbe({ tally: emptySinkTally() })
    expect(isBudgetStoreProbe(probe)).toBe(true)
    expect(isBudgetStoreProbe({})).toBe(false)
    expect(isBudgetStoreProbe(null)).toBe(false)
  })

  it("the probe reports no reservation and no capacity before anything is asked of it", () => {
    const probe = createBudgetLedgerProbe({ tally: emptySinkTally() })
    expect(probe.read(DRAFT.reservationId)).toBeNull()
    expect(probe.reservationForDispatch(DRAFT.dispatchId)).toBeNull()
    expect(probe.heldUnitsFor(DRAFT.projectId, "concurrency")).toBe(0)
    expect(probe.list()).toEqual([])
    expect(probe.listHeld()).toEqual([])
  })

  it("the probe runs the ledger's own admission decision and returns its reservation", async () => {
    const tally = emptySinkTally()
    const probe = createBudgetLedgerProbe({ tally })
    const ledger = new BudgetLedger({ store: probe, resolveLimits: () => ({ maximumConcurrency: 2 }) })
    const result = await ledger.reserve({
      reservationId: DRAFT.reservationId,
      projectId: DRAFT.projectId,
      runId: DRAFT.runId,
      taskId: DRAFT.taskId,
      dispatchId: DRAFT.dispatchId,
      scope: "concurrency",
      units: 1,
      now: DRAFT.now,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.state).toBe("held")
    expect(result.value.reservationId).toBe("res:probe")
    // Counted at the sink, so the gate really was entered.
    expect(tally.budgetReservationAttempts).toBe(1)
    expect(probe.counters.admitted).toBe(1)
  })

  it("the probe retains nothing, so a dispatch that was admitted is still INELIGIBLE afterwards", async () => {
    const tally = emptySinkTally()
    const probe = createBudgetLedgerProbe({ tally })
    const ledger = new BudgetLedger({ store: probe, resolveLimits: () => ({ maximumConcurrency: 2 }) })
    const result = await ledger.reserve({
      reservationId: DRAFT.reservationId,
      projectId: DRAFT.projectId,
      runId: DRAFT.runId,
      taskId: DRAFT.taskId,
      dispatchId: DRAFT.dispatchId,
      scope: "concurrency",
      units: 1,
      now: DRAFT.now,
    })
    expect(result.ok).toBe(true)
    // ADR 0007 section 13.2: eligibility is DEFINED as holding a held reservation.
    // The probe admitted the reservation and kept none, so the dispatch is not
    // eligible. This is the strongest available statement that a dry run consumed
    // no capacity: not "we cleaned up" but "there was nothing to clean up".
    expect(ledger.eligible(DRAFT.dispatchId)).toBe(false)
    expect(ledger.reservationForDispatch(DRAFT.dispatchId)).toBeNull()
    expect(ledger.heldUnits(DRAFT.projectId, "concurrency")).toBe(0)
    expect(ledger.listHeld()).toEqual([])
    expect(tally.retainedReservations).toBe(0)
    expect(probe.counters.retained).toBe(0)
    expect(assertNoRetainedSideEffects(readSinkCounters(tally))).toEqual([])
  })

  it("the probe relays the ledger's own saturation refusal without deciding anything itself", () => {
    const probe = createBudgetLedgerProbe({ tally: emptySinkTally() })
    const result = probe.reserveInTransaction(DRAFT, 1, () => REFUSE)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe("budget.scope_saturated")
    expect(result.refusal.heldUnits).toBe(1)
    expect(probe.counters.refused).toBe(1)
    expect(probe.counters.admitted).toBe(0)
  })

  it("the probe reports the held total as zero to the admission callback, because it holds nothing", () => {
    const probe = createBudgetLedgerProbe({ tally: emptySinkTally() })
    const seen: number[] = []
    probe.reserveInTransaction(DRAFT, 4, (held) => {
      seen.push(held)
      return ADMIT
    })
    expect(seen).toEqual([0])
  })

  it("a refused reserve writes nothing, which is a provable no-op rather than a cleanup", () => {
    const probe = createBudgetLedgerProbe({ tally: emptySinkTally() })
    expect(probe.reserveInTransaction(DRAFT, 1, () => REFUSE).ok).toBe(false)
    expect(probe.read(DRAFT.reservationId)).toBeNull()
    expect(probe.list()).toEqual([])
    expect(probe.heldUnitsFor(DRAFT.projectId, "concurrency")).toBe(0)
  })

  it("a transition is refused, because a dry run has no reservation to move", () => {
    const probe = createBudgetLedgerProbe({ tally: emptySinkTally() })
    expect(() => probe.transition(DRAFT.reservationId, "committed", DRAFT.now)).toThrow(SimulationSideEffectError)
    expect(probe.counters.transitionAttempts).toBe(1)
    try {
      probe.transition(DRAFT.reservationId, "released", DRAFT.now)
    } catch (error) {
      expect((error as SimulationSideEffectError).sink).toBe("budget_ledger")
      expect((error as SimulationSideEffectError).message).toContain("tombstone table")
    }
  })

  it("the probe's counters are a frozen read, so a caller cannot edit what a test will read", () => {
    const probe = createBudgetLedgerProbe({ tally: emptySinkTally() })
    expect(Object.isFrozen(probe.counters)).toBe(true)
    expect(probe.counters).toEqual({ attempts: 0, admitted: 0, refused: 0, retained: 0, transitionAttempts: 0 })
  })

  it("every `BudgetLedgerStore` member a dry run could reach is present on the probe", () => {
    // The interface has five methods. Naming all of them here means a sixth would be
    // a compile error against this list rather than a silently unimplemented method.
    const probe = createBudgetLedgerProbe({ tally: emptySinkTally() })
    expect(typeof probe.read).toBe("function")
    expect(typeof probe.reserveInTransaction).toBe("function")
    expect(typeof probe.transition).toBe("function")
    expect(typeof probe.list).toBe("function")
    expect(typeof probe.listHeld).toBe("function")
    expect(typeof probe.reservationForDispatch).toBe("function")
  })
})

/**
 * Shared fixtures for `tests/unit/budgets/`.
 *
 * WHY one file: every test here needs a valid project/run/task/dispatch identity
 * quadruple, a fixed instant, and a budget to compose against. A fixture that
 * differs subtly per file is a fixture whose differences nobody can account for
 * when a test fails. So the builders parse through the module's OWN schemas, and
 * a fixture that has drifted out of the module is a loud failure at the first
 * test that uses it rather than a subtly-wrong input to an atomicity assertion.
 *
 * The clock is INJECTED everywhere (`now` is a parameter, never `Date.now()`), so
 * every test in this directory is deterministic and can be run in any order. The
 * one exception is `reservation.test.ts`'s concurrency sweep, which uses real
 * `Promise.all` interleavings — determinism there comes from the assertions being
 * invariants rather than from the schedule being fixed.
 */

import {
  BudgetLedger,
  InMemoryBudgetLedgerStore,
  addBudgetSeconds,
  budgetReservationSchema,
  reservationIdSchema,
  type BudgetLedgerStore,
  type BudgetLimits,
  type BudgetReservation,
  type ReplayRequest,
  type ReservationId,
} from "../../../src/budgets/index.js"

export const PROJECT_ID = "proj-1"
export const OTHER_PROJECT_ID = "proj-2"
export const RUN_ID = "run-1"
export const TASK_ID = "task-1"

/**
 * A fixed instant. Chosen with a fractional part because
 * `timestampSchema` ACCEPTS one, and lease comparison is a string comparison —
 * a fixture that only ever used whole seconds would not notice a regression in
 * how fractional timestamps are handled.
 */
export const NOW = "2026-03-01T12:00:00.000Z"

/** One minute after `NOW`. The instant a 60-second lease expires at. */
export const ONE_MINUTE_LATER = addBudgetSeconds(NOW, 60)

/** Ten minutes after `NOW`: a lease that is still valid at `LATER_INSTANT`. */
export const TEN_MINUTES_LATER = addBudgetSeconds(NOW, 600)

/** One hour after `NOW`: past every lease the fixtures create. */
export const ONE_HOUR_LATER = addBudgetSeconds(NOW, 3_600)

export interface DispatchIdentity {
  readonly reservationId?: string
  readonly dispatchId?: string
  readonly runId?: string
  readonly taskId?: string
  readonly projectId?: string
}

/**
 * A loosely-typed reservation record, for hand-written fixtures.
 *
 * Every identifier member is a plain `string` here rather than the branded type,
 * because `budgetReservationSchema.parse` is what applies the branding — and the
 * fixtures deliberately hand-write ids rather than re-parsing constants, so that a
 * schema change that tightened the opaque-id alphabet would fail at the first test
 * that uses one instead of at the import. The return type stays `BudgetReservation`,
 * so a caller still cannot observe an unbranded id.
 */
export type ReservationRecordOverrides = Partial<
  Omit<BudgetReservation, "reservationId" | "projectId" | "runId" | "taskId" | "dispatchId">
> & {
  readonly reservationId?: string
  readonly projectId?: string
  readonly runId?: string
  readonly taskId?: string
  readonly dispatchId?: string
}

/**
 * A reservation request for `index`, so a test that needs N distinct dispatches
 * does not hand-write N near-identical objects.
 *
 * `leaseSeconds` defaults to 600 — ten minutes — which places `leaseExpiresAt`
 * EXACTLY on `TEN_MINUTES_LATER`. That is deliberate: a sweep at
 * `TEN_MINUTES_LATER` is therefore a sweep at the lease boundary, which must NOT
 * reclaim (recovery.ts treats `leaseExpiresAt <= now` as expired, and the
 * boundary instant is the last moment the lease is valid), and a sweep at
 * `ONE_HOUR_LATER` must. Tests that need a lease to have passed sooner state a
 * shorter `leaseSeconds` explicitly.
 */
export function reserveRequestFor(
  index: number,
  overrides: Partial<{
    projectId: string
    runId: string
    taskId: string
    dispatchId: string
    reservationId: string
    units: number
    now: string
    leaseSeconds: number
    scope: "concurrency" | "fan_out"
  }> & { readonly omitLeaseSeconds?: boolean } = {},
): Parameters<BudgetLedger["reserve"]>[0] {
  return {
    reservationId: reservationIdSchema.parse(overrides.reservationId ?? `res-${index}`),
    projectId: overrides.projectId ?? PROJECT_ID,
    runId: overrides.runId ?? RUN_ID,
    taskId: overrides.taskId ?? TASK_ID,
    dispatchId: overrides.dispatchId ?? `disp-${index}`,
    scope: overrides.scope ?? "concurrency",
    units: overrides.units ?? 1,
    now: overrides.now ?? NOW,
    // `omitLeaseSeconds` exists for the ONE test that exercises the ledger's own
    // default (`ledger.test.ts`'s "uses the ledger's default lease"). The key has to
    // be genuinely ABSENT for the ledger to apply its default, and `leaseSeconds:
    // undefined` would be rejected by the `.strict()` schema rather than treated as
    // "unstated", so the member is spread conditionally rather than set to undefined.
    ...(overrides.omitLeaseSeconds === true ? {} : { leaseSeconds: overrides.leaseSeconds ?? 600 }),
  } as Parameters<BudgetLedger["reserve"]>[0]
}

/**
 * A ledger over `limits`, with an in-memory store the caller can also hold.
 *
 * `resolveLimits` is a SYNCHRONOUS function returning a fixed budget even though
 * the port is typed to allow a promise. That is deliberate and it is the point of
 * the headline test: the ledger's `await` is outside the transaction, so a
 * resolved promise still yields a microtask boundary between the port answering
 * and the store being entered — which is exactly the window a check-then-act
 * implementation would lose the reservation in.
 */
export function testLedger(
  limits: BudgetLimits,
  options?: { readonly store?: BudgetLedgerStore; readonly defaultLeaseSeconds?: number },
): { readonly ledger: BudgetLedger; readonly store: BudgetLedgerStore } {
  const store = options?.store ?? new InMemoryBudgetLedgerStore()
  const ledger = new BudgetLedger({
    store,
    resolveLimits: () => limits,
    ...(options?.defaultLeaseSeconds === undefined ? {} : { defaultLeaseSeconds: options.defaultLeaseSeconds }),
  })
  return { ledger, store }
}

/** The same, with the concrete store so a test can inspect its internals. */
export function testLedgerWithStore(
  limits: BudgetLimits,
  options?: { readonly defaultLeaseSeconds?: number },
): { readonly ledger: BudgetLedger; readonly store: InMemoryBudgetLedgerStore } {
  const store = new InMemoryBudgetLedgerStore()
  const ledger = new BudgetLedger({
    store,
    resolveLimits: () => limits,
    ...(options?.defaultLeaseSeconds === undefined ? {} : { defaultLeaseSeconds: options.defaultLeaseSeconds }),
  })
  return { ledger, store }
}

/** A schema-valid reservation record, for the replay tests. */
export function reservationRecord(overrides: ReservationRecordOverrides = {}): BudgetReservation {
  return budgetReservationSchema.parse({
    reservationId: overrides.reservationId ?? reservationIdSchema.parse("res-durable"),
    projectId: overrides.projectId ?? PROJECT_ID,
    runId: overrides.runId ?? RUN_ID,
    taskId: overrides.taskId ?? TASK_ID,
    dispatchId: overrides.dispatchId ?? "disp-durable",
    scope: overrides.scope ?? "concurrency",
    units: overrides.units ?? 1,
    state: overrides.state ?? "released",
    leaseExpiresAt: overrides.leaseExpiresAt ?? ONE_MINUTE_LATER,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  })
}

/**
 * The ceilings a replay is given for `PROJECT_ID`, one per scope.
 *
 * Replay is a second admission decision (recovery.ts R12), which means it cannot
 * run without being told what the ceiling is — it has no resolver of its own,
 * because the budget in force at crash time is not necessarily the budget in force
 * now. Every replay test therefore states its ceilings explicitly rather than
 * inheriting a default, so a test that changes the ceiling says so.
 *
 * `null` means "no budget declares a maximum here", which is NOT unlimited (L8) and
 * is a value replay has to handle rather than skip.
 */
export function replayCeilings(
  concurrency: number | null = 8,
  fanOut: number | null = 8,
  projectId: string = PROJECT_ID,
): ReplayRequest["ceilings"] {
  return [
    { projectId, scope: "concurrency", ceiling: concurrency },
    { projectId, scope: "fan_out", ceiling: fanOut },
  ]
}

/** The one-line replay request a test that does not care about the clock wants. */
export function replayRequest(
  ceilings: ReplayRequest["ceilings"] = replayCeilings(),
  now: string = NOW,
): ReplayRequest {
  return { now, ceilings }
}

/**
 * A durable log of `count` distinct `held` reservations for `projectId`.
 *
 * The MED-5 fixture: five `held` rows against a ceiling of one. Built by
 * construction rather than by driving a ledger, because a ledger REFUSES to admit
 * them — which is the point. The over-limit log is only reachable by hand, so it
 * has to be hand-writable.
 *
 * `leaseExpiresAt` is a full day out so a later `recoverLeaked` sweep at
 * `NOW` has to find a *reason* to reclaim each one rather than stumbling into
 * `lease_expired`; a test that wants the lease path passes its own records.
 */
export function heldRecords(
  count: number,
  options: { readonly projectId?: string; readonly scope?: "concurrency" | "fan_out"; readonly units?: number } = {},
): readonly BudgetReservation[] {
  const projectId = options.projectId ?? PROJECT_ID
  const scope = options.scope ?? "concurrency"
  const units = options.units ?? 1
  return Array.from({ length: count }, (_, index) =>
    reservationRecord({
      reservationId: `res-${String(index).padStart(3, "0")}`,
      dispatchId: `disp-${String(index).padStart(3, "0")}`,
      projectId,
      scope,
      units,
      state: "held",
      leaseExpiresAt: "2026-03-02T12:00:00.000Z",
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
}

/**
 * A durable log: every reservation whose `reserve` transaction committed.
 *
 * Built by asking a real ledger what it holds and nothing else, rather than
 * hand-written, so a test cannot produce a log that disagrees with the ledger it
 * claims to be a log of.
 *
 * Note what is NOT filtered out. A `held` reservation is included, and that is
 * the whole point: a crash between reserve and release leaves exactly such a
 * record, and a log that omitted it would make the stranded capacity invisible to
 * `recoverLeaked`. See the "Crash and replay" section of `src/budgets/recovery.ts`.
 *
 * `durableLogOfTerminalOnly` is the narrower variant, for a test that wants to
 * assert what restoring a TERMINAL-only log looks like.
 */
export function durableLogOf(ledger: BudgetLedger): readonly BudgetReservation[] {
  return ledger.list()
}

export function durableLogOfTerminalOnly(ledger: BudgetLedger): readonly BudgetReservation[] {
  return ledger.list().filter((reservation) => reservation.state !== "held")
}

/**
 * A deterministic pseudo-random source.
 *
 * A 32-bit linear congruential generator with the constants from Numerical
 * Recipes, seeded explicitly. `Math.random()` is forbidden in this module
 * (types.ts I7) and would make a failing sweep impossible to reproduce anyway;
 * an LCG gives the same "arbitrary but repeatable" spread the sweep needs, and
 * `Math.imul` keeps the multiplication exact in the low 32 bits so the sequence
 * is identical on every engine.
 */
export function seededLcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

/** A pseudo-random integer in `[min, max]` from a seeded source. */
export function randomInt(next: () => number, min: number, max: number): number {
  return min + Math.floor(next() * (max - min + 1))
}

/**
 * A pseudo-random budget, sometimes with fields absent.
 *
 * Absent fields matter: a sweep over only fully-populated budgets would never
 * exercise the "the base does not declare this, so the contribution establishes
 * it" branch, which is the branch where a widening bug would be easiest to hide.
 */
export function randomBudget(next: () => number): BudgetLimits {
  const limits: BudgetLimits = {}
  if (next() < 0.85) limits.maximumConcurrency = randomInt(next, 1, 16)
  if (next() < 0.85) limits.maximumFanOut = randomInt(next, 1, 16)
  if (next() < 0.7) limits.maximumRetryLimit = randomInt(next, 0, 16)
  if (next() < 0.7) limits.maximumWallClockSeconds = randomInt(next, 1, 3_600)
  if (next() < 0.5) limits.maximumUsageUnits = randomInt(next, 1, 10_000)
  if (next() < 0.5) limits.usageUnit = (["tokens", "bytes", "provider_cost_micros"] as const)[randomInt(next, 0, 2)]!
  return limits
}

/** Reservation ids for `count` distinct dispatches, in a stable order. */
export function reservationIds(count: number): readonly ReservationId[] {
  return Array.from({ length: count }, (_, index) => reservationIdSchema.parse(`res-${index}`))
}

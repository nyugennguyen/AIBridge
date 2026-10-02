/**
 * M6.5 — budgets and admission control. Types, schemas, and the refusals.
 *
 * # What this module is
 *
 * Two questions that have to be unanswerable-by-construction:
 *
 *   1. **What is the budget in force for this dispatch?** The answer is
 *      `composeBudgets` (see `./compose.js`), and it is elementwise `min` over
 *      present keys. A contribution that is GREATER than the current budget is
 *      a widening attempt: recorded, named, and never applied.
 *   2. **May this dispatch launch?** The answer is NOT "is there room". The
 *      answer is "does it hold a reservation that is in state `held`". There is
 *      no code path in this module that answers question 2 by consulting a
 *      budget, because a check followed by a separate reservation is the
 *      check-then-act gap ADR 0007 section 13.2 exists to close.
 *
 * # Named invariants
 *
 * - **I1 — Eligibility is a DEFINITION, not a check.** `BudgetLedger.eligible`
 *      is `reservationState(dispatchId) === "held"` and nothing else. It does
 *      not re-read a limit, does not count held units, and cannot be made to
 *      answer "yes" for a dispatch that does not hold a reservation. The
 *      capacity decision happened once, atomically, inside `reserve`.
 * - **I2 — `held` and `committed` both OCCUPY capacity; `released` and `expired`
 *      both FREE it.** The ADR names four states but does not say which ones
 *      count against `maximumConcurrency`. A `committed` reservation is a
 *      session that is RUNNING, so freeing its units at commit would let the
 *      next dispatch start while the previous one still holds a session — which
 *      is exactly the thing a concurrency budget exists to prevent. Releasing
 *      happens on a terminal dispatch state, or when a lease expires.
 * - **I3 — One reservation per dispatch.** `reservationState(dispatchId)` is
 *      single-valued, so a second `held` reservation for the same `dispatchId`
 *      is refused inside the transaction (`budget.dispatch_already_reserved`)
 *      rather than creating an ambiguity the eligibility definition would then
 *      have to resolve arbitrarily.
 * - **I4 — Reserve is the ONLY transition into `held`.** `release`, `commit`,
 *      and `expire` can never produce a `held` reservation, so there is no way
 *      to make an ineligible dispatch eligible other than by reserving capacity
 *      for it.
 * - **I5 — Every transition is idempotent and terminal states are ABSORBING.**
 *      A replay after a crash re-issues the same `commit`/`release`/`expire` and
 *      must not double-apply. `reserve` returns the stored reservation, so a
 *      replayed reserve is not a second unit of capacity; and a transition out
 *      of a terminal state reports `changed: false` rather than resurrecting it.
 * - **I6 — Enforceability comes from OBSERVATION, never from a budget being
 *      set.** `maximumUsageUnits` is `enforceable` only when the runtime
 *      adapter reported reliable usage for the run in progress AND the unit is
 *      declared AND the units agree. Otherwise it is `not_enforceable`, a
 *      warning names the budget, and NOTHING is refused — a module that refuses
 *      a cost budget it cannot measure is lying about what it knows, and a
 *      module that reported `enforceable` with no measurement behind it would be
 *      lying in the other direction. The same rule is applied to
 *      `maximumRetryLimit` and its retry counter, which is why the default
 *      observation is "nothing was reported".
 * - **I7 — Nothing here reads a clock, a random source, a file, a socket, or a
 *      process.** `now` arrives on every request. The ledger's async boundary
 *      is the injected `resolveLimits` port and it sits DELIBERATELY OUTSIDE
 *      the transaction, so concurrency in the port cannot become concurrency
 *      inside the critical section.
 * - **I8 — Code-unit ordering, never `localeCompare`.** Every list this module
 *      emits (warnings, reclaimed reservations, refusal codes, field names) is
 *      sorted by UTF-16 code unit and de-duplicated, so two machines with
 *      different locale data produce byte-identical reports.
 * - **I9 — Expected outcomes are `Result`, never throws.** A saturated scope, a
 *      non-integer unit count, a replayed transition and an unknown reservation
 *      are all named refusals. The one throw in this module is a re-entrant call
 *      into a critical section, which is a programming error rather than an
 *      outcome, and it raises `InvariantViolationError` naming the invariant.
 * - **I10 — The store is IN-MEMORY and that is a recorded deferral, not an
 *      oversight.** See the note on `InMemoryBudgetLedgerStore` in `./ledger.js`.
 *      Nothing in this module adds a SQLite table, a migration, or a
 *      persistence format, and `BudgetLedgerStore` is the seam a durable
 *      implementation would fill without changing `BudgetLedger`.
 * - **I11 — A REPLAYED ledger is bounded by the same ceiling a live one is.**
 *      `REPLAY_REJECTION_REASONS` exists because the durable log is a record of
 *      decisions that were each individually valid when written, and replay is
 *      the one path that installs `held` rows without consulting a live budget.
 *      Replaying is therefore a SECOND ADMISSION DECISION, and the only safe
 *      thing it can do with a record that no longer fits is refuse it and say so.
 *      The full argument is on `replayDurableReservations` in `./recovery.js`;
 *      what belongs here is that the vocabulary of refusal is CLOSED and
 *      ENUMERABLE, so "what did the replay throw away and why" has a finite
 *      answer.
 * - **I12 — A rejection returns capacity, it does not strand it.** A rejected
 *      record is installed as `expired`, so the units it was occupying come back
 *      and the recovered ledger admits new reservations up to the ceiling. A
 *      replay that refused over-limit rows without restoring them as terminal
 *      would leave the ledger WEDGED — refusing every future reserve because a
 *      recovered total it cannot explain is sitting in its own state. Wedging is
 *      an availability failure disguised as a safety property.
 *
 * # Stop conditions
 *
 *   - **S1 — Stop if reservation can be found not atomic with eligibility**,
 *     including by a crash or a replay between the check and the reservation
 *     (ADR 0007 stop condition 3). The answer this module gives is that the
 *     check and the write are the same synchronous statement sequence in the
 *     store, and `tests/unit/budgets/reservation.test.ts` tries to falsify it
 *     with hundreds of interleaved reserves.
 *   - **S2 — Stop if a budget is ever found reportable as enforceable without a
 *     measurement behind it.** `maximumUsageUnits` with no adapter usage must
 *     produce `not_enforceable` plus a warning, and never a refusal.
 *   - **S3 — Stop if a transition is ever found able to move a terminal
 *     reservation back to `held`,** or to double-count a unit.
 *   - **S4 — Stop if a caller's declared unit count can be partially applied.**
 *     A reservation is all-or-nothing; there is no "reserve what fits".
 *   - **S5 — Stop if a replay can install a held total above a declared
 *     ceiling,** or if it can refuse over-limit rows in a way that leaves the
 *     recovered ledger unable to accept any reserve at all (I11, I12).
 */

import { z } from "zod"
import { SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS } from "../orchestration/policy/types.js"
import {
  capabilitySchema,
  dispatchIdSchema,
  projectIdSchema,
  runIdSchema,
  taskIdSchema,
  timestampSchema,
} from "../orchestration/identifiers.js"

// ===========================================================================
// Value domain
// ===========================================================================

/**
 * Ceiling on any fan-out value a budget may name. ADR 0007 section 9.
 *
 * Restated here rather than imported from `src/rules/limits.ts`, because the
 * dependency edge this module is allowed is `budgets -> orchestration` and NOT
 * `budgets -> rules`: a budget is an INPUT to rule evaluation (a rule narrows a
 * budget), so a budget module that imported the rule module would invert the
 * narrowing direction. The cost of restating is one number that could drift;
 * the cost of the wrong edge is a cycle between two modules that are both
 * supposed to sit between the kernel and the caller.
 */
export const BUDGET_MAX_FAN_OUT = 256

/** Ceiling on any concurrency value a budget may name. ADR 0007 section 9. */
export const BUDGET_MAX_CONCURRENCY = 256

/** A retry limit above this is a defect, not a policy. ADR 0007 section 9. */
export const BUDGET_MAX_RETRY_LIMIT = 16

/**
 * Longest wall-clock a budget may name. Reuses the safety floor's own timeout
 * ceiling rather than inventing a second number: a budget that could authorise a
 * longer run than the safety floor permits would be a budget that can widen the
 * floor, and the floor is the one thing this milestone cannot let a budget touch.
 */
export const BUDGET_MAX_WALL_CLOCK_SECONDS = SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS

/** The unit a `maximumUsageUnits` budget is denominated in. */
export const USAGE_UNITS = ["tokens", "bytes", "provider_cost_micros"] as const

export const usageUnitSchema = z.enum(USAGE_UNITS)

export type UsageUnit = z.infer<typeof usageUnitSchema>

/**
 * The budget fields, in UTF-16 code-unit order.
 *
 * Order is code-unit order rather than the order ADR 0007 section 13.1 happens
 * to list them in, because every list this module emits is walked in this order
 * and two different orders would mean two different digests for the same budget.
 */
export const BUDGET_FIELDS = [
  "maximumConcurrency",
  "maximumFanOut",
  "maximumRetryLimit",
  "maximumUsageUnits",
  "maximumWallClockSeconds",
  "usageUnit",
] as const

export type BudgetField = (typeof BUDGET_FIELDS)[number]

/** The five fields whose composition is elementwise `min`. `usageUnit` is not one of them. */
export const BUDGET_NUMERIC_FIELDS = [
  "maximumConcurrency",
  "maximumFanOut",
  "maximumRetryLimit",
  "maximumUsageUnits",
  "maximumWallClockSeconds",
] as const

export type BudgetNumericField = (typeof BUDGET_NUMERIC_FIELDS)[number]

/**
 * ADR 0007 section 13.1's `BudgetLimits`.
 *
 * `.strict()` at the top level: an unknown key in a budget is a compile error
 * with a named refusal, not a field silently dropped on the floor. A dropped
 * field is the mechanism by which "I wrote `maximumUsageUnits: 0`" and "I wrote
 * nothing" become the same budget.
 *
 * Every numeric member is an INTEGER with a closed range. `maximumRetryLimit`
 * admits `0` because "do not retry at all" is a real, expressible, strict
 * budget; the rest start at `1` because a limit of zero concurrent dispatches is
 * a stopped project, not a budget, and `reserve` refuses a zero-UNIT request
 * for the same reason.
 */
export const budgetLimitsSchema = z
  .object({
    maximumConcurrency: z.number().int().min(1).max(BUDGET_MAX_CONCURRENCY).safe().optional(),
    maximumFanOut: z.number().int().min(1).max(BUDGET_MAX_FAN_OUT).safe().optional(),
    maximumRetryLimit: z.number().int().min(0).max(BUDGET_MAX_RETRY_LIMIT).safe().optional(),
    maximumWallClockSeconds: z.number().int().min(1).max(BUDGET_MAX_WALL_CLOCK_SECONDS).safe().optional(),
    maximumUsageUnits: z.number().int().min(1).safe().optional(),
    usageUnit: usageUnitSchema.optional(),
  })
  .strict()

export type BudgetLimits = z.infer<typeof budgetLimitsSchema>

export const budgetEnforceabilitySchema = z.enum(["enforceable", "not_enforceable"])

export type BudgetEnforceability = z.infer<typeof budgetEnforceabilitySchema>

/**
 * Which subsystem can actually enforce each field.
 *
 * This table exists because "enforceable" is a claim about the RUNNING SYSTEM,
 * not about the document: `maximumConcurrency` is enforced here, by a
 * transaction in this module; `maximumUsageUnits` is enforced by the runtime
 * adapter's usage report, and only if that adapter produced one. The table is
 * what makes I6 mechanical rather than aspirational — adding a field without
 * naming its enforcer stops the build.
 */
export const BUDGET_FIELD_OWNERS = {
  maximumConcurrency: "budget_ledger",
  maximumFanOut: "budget_ledger",
  maximumRetryLimit: "dispatch_retry_counter",
  maximumWallClockSeconds: "reservation_lease",
  maximumUsageUnits: "runtime_adapter_usage",
  usageUnit: "runtime_adapter_usage",
} as const satisfies Readonly<Record<BudgetField, BudgetEnforcementOwner>>

export const BUDGET_ENFORCEMENT_OWNERS = [
  "budget_ledger",
  "dispatch_retry_counter",
  "reservation_lease",
  "runtime_adapter_usage",
] as const

export type BudgetEnforcementOwner = (typeof BUDGET_ENFORCEMENT_OWNERS)[number]

export const budgetEnforceabilityRecordSchema = z
  .object({
    maximumConcurrency: budgetEnforceabilitySchema,
    maximumFanOut: budgetEnforceabilitySchema,
    maximumRetryLimit: budgetEnforceabilitySchema,
    maximumUsageUnits: budgetEnforceabilitySchema,
    maximumWallClockSeconds: budgetEnforceabilitySchema,
    usageUnit: budgetEnforceabilitySchema,
  })
  .strict()

export type BudgetEnforceabilityRecord = z.infer<typeof budgetEnforceabilityRecordSchema>

/**
 * ADR 0007 section 13.1's `BudgetDecision`, exactly.
 *
 * `enforceability` carries an entry for EVERY key of `BudgetLimits`, including
 * the keys that are absent. An absent field is `not_enforceable` by
 * construction: there is no limit in force, so there is nothing to enforce, and
 * reporting `enforceable` for an absent limit would be a claim about a budget
 * nobody set.
 */
/**
 * An upper bound on the number of warnings a decision may carry.
 *
 * A warning list is a function of the fields and the observation, so its length
 * is bounded by construction; the bound exists so a caller rendering the list
 * into an audit view has a known worst case rather than discovering one.
 */
export const BUDGET_MAX_WARNINGS = 32

export const budgetDecisionSchema = z
  .object({
    limits: budgetLimitsSchema,
    enforceability: budgetEnforceabilityRecordSchema,
    warnings: z.array(z.string().min(1)).max(BUDGET_MAX_WARNINGS),
  })
  .strict()

export type BudgetDecision = z.infer<typeof budgetDecisionSchema>

// ===========================================================================
// Observations
// ===========================================================================

/**
 * What the RUNTIME ADAPTER reported about usage for the run in progress.
 *
 * `reported` and `reliable` are SEPARATE fields, and collapsing them would be
 * the exact dishonesty this module is built to avoid: a provider that returns a
 * usage figure that is estimated, delayed by a billing window, or partial has
 * `reported: true, reliable: false`, and a budget checked against it would be a
 * budget checked against a guess. `consumedUnits` is nullable rather than
 * defaulted to `0` because "nothing consumed yet" and "we did not measure" are
 * different facts with different consequences.
 */
export const usageObservationSchema = z
  .object({
    reported: z.boolean(),
    reliable: z.boolean(),
    unit: usageUnitSchema.nullable(),
    consumedUnits: z.number().int().nonnegative().safe().nullable(),
  })
  .strict()

export type UsageObservation = z.infer<typeof usageObservationSchema>

/**
 * Everything this module knows about whether a budget CAN be enforced right now.
 *
 * `retryCounting` is the same discipline applied to `maximumRetryLimit`: this
 * module does not count retries, the dispatcher does, and if the dispatcher has
 * not said it is counting them then the limit is not being enforced by anyone.
 * It defaults to `false` under `NO_BUDGET_OBSERVATION`, which is the point — the
 * default is the pessimistic answer, so a caller that forgets to pass an
 * observation gets a warning instead of a silent claim.
 */
export const budgetObservationSchema = z
  .object({
    usage: usageObservationSchema,
    retryCounting: z.boolean(),
  })
  .strict()

export type BudgetObservation = z.infer<typeof budgetObservationSchema>

/**
 * The observation used when a caller supplies none: nothing was reported.
 *
 * Every `not_enforceable` warning this module can produce for a budget that IS
 * set is reachable from here, which is what makes "the pessimistic default" a
 * testable statement rather than a comment.
 */
export const NO_BUDGET_OBSERVATION: BudgetObservation = Object.freeze({
  usage: Object.freeze({
    reported: false,
    reliable: false,
    unit: null,
    consumedUnits: null,
  }),
  retryCounting: false,
})

/** An observation in which the adapter reported reliable usage in `unit`. */
export function reportedUsageObservation(
  consumedUnits: number,
  unit: UsageUnit,
  options?: { readonly reliable?: boolean },
): BudgetObservation {
  return Object.freeze({
    usage: Object.freeze({
      reported: true,
      reliable: options?.reliable ?? true,
      unit,
      consumedUnits,
    }),
    retryCounting: true,
  })
}

// ===========================================================================
// Composition
// ===========================================================================

/** One contributor's declared budget and the name to attribute a widening attempt to. */
export interface BudgetContribution {
  /** An identifier: a rule id, a layer id, or any caller-chosen label. */
  readonly source: string
  readonly limits: BudgetLimits
}

/** A rejected widening attempt: a declared value the effective budget refused. */
export interface BudgetWideningAttempt {
  readonly source: string
  readonly field: BudgetNumericField
  readonly attempted: number
  readonly current: number
}

/**
 * The composed budget.
 *
 * An ADDITIVE extension of ADR 0007 section 13.1's `BudgetDecision`: the three
 * ADR members are present and unchanged, and `rejectedWidening` is the same
 * information the warnings carry in machine-readable form. A `BudgetComposition`
 * is assignable to a `BudgetDecision`, so a caller that only wants the ADR shape
 * can take it without a second function. Documented in the handoff as the only
 * shape deviation in this module.
 */
export interface BudgetComposition extends BudgetDecision {
  readonly rejectedWidening: readonly BudgetWideningAttempt[]
}

// ===========================================================================
// Reservations
// ===========================================================================

/** The two counters a reservation may occupy. They are never summed together. */
export const BUDGET_SCOPES = ["concurrency", "fan_out"] as const

export const budgetScopeSchema = z.enum(BUDGET_SCOPES)

export type BudgetScope = z.infer<typeof budgetScopeSchema>

/** ADR 0007 section 13.2's four reservation states. */
export const RESERVATION_STATES = ["held", "released", "committed", "expired"] as const

export const reservationStateSchema = z.enum(RESERVATION_STATES)

export type ReservationState = z.infer<typeof reservationStateSchema>

/**
 * The states whose units are counted against the scope's limit. See I2.
 *
 * `held` is a reservation for a dispatch that has not launched. `committed` is a
 * session that HAS launched and is still occupying the slot it was admitted
 * into. The two non-occupying states are the two ways capacity comes back:
 * a terminal dispatch state (`released`) and an expired lease (`expired`).
 */
export const OCCUPYING_RESERVATION_STATES = ["held", "committed"] as const

export type OccupyingReservationState = (typeof OCCUPYING_RESERVATION_STATES)[number]

/** The states from which no further transition is possible. */
export const TERMINAL_RESERVATION_STATES = ["released", "expired"] as const

export type TerminalReservationState = (typeof TERMINAL_RESERVATION_STATES)[number]

const OCCUPYING_SET: ReadonlySet<ReservationState> = new Set(OCCUPYING_RESERVATION_STATES)
const TERMINAL_SET: ReadonlySet<ReservationState> = new Set(TERMINAL_RESERVATION_STATES)

/** Whether a reservation in this state counts against its scope's limit. */
export function occupiesCapacity(state: ReservationState): boolean {
  return OCCUPYING_SET.has(state)
}

/** Whether a reservation in this state can be transitioned again at all. */
export function isTerminalReservationState(state: ReservationState): boolean {
  return TERMINAL_SET.has(state)
}

/** Whether a reservation in this state makes its dispatch eligible to launch. */
export function isHeld(state: ReservationState): boolean {
  return state === "held"
}

/**
 * A reservation id.
 *
 * Branded like every other identifier in this repository (`src/orchestration/
 * identifiers.ts`), because `commit(reservationId)` and `eligible(dispatchId)`
 * take two DIFFERENT identifier types and mixing them up would compile. The
 * alphabet is the kernel's opaque-id alphabet, reused through `capabilitySchema`
 * rather than restated: a second alphabet for "some opaque id" is a second thing
 * that can drift.
 */
export const reservationIdSchema = capabilitySchema.brand<"ReservationId">()

export type ReservationId = z.infer<typeof reservationIdSchema>

/** ADR 0007 section 13.2's `BudgetReservation`, verbatim, `.strict()`. */
export const budgetReservationSchema = z
  .object({
    reservationId: reservationIdSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    taskId: taskIdSchema,
    dispatchId: dispatchIdSchema,
    scope: budgetScopeSchema,
    units: z.number().int().min(1).safe(),
    state: reservationStateSchema,
    leaseExpiresAt: timestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((reservation) => reservation.state !== "held" || reservation.leaseExpiresAt >= reservation.createdAt, {
    message:
      "A held reservation must have a lease that expires at or after its creation; a reservation born expired would be launch-eligible and reclaimable at the same instant",
  })

export type BudgetReservation = z.infer<typeof budgetReservationSchema>

/**
 * What `reserve` is asked for.
 *
 * `leaseSeconds` rather than a computed `leaseExpiresAt`, so the caller states a
 * DURATION and the ledger applies it to the injected `now`. A caller that
 * supplied an absolute instant instead would have to compute it against the same
 * `now` it passed in, and getting the two out of step produces a reservation
 * whose lease is already in the past — a shape this module refuses to create
 * but cannot prevent a caller from computing.
 */
export const reserveRequestSchema = z
  .object({
    reservationId: reservationIdSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    taskId: taskIdSchema,
    dispatchId: dispatchIdSchema,
    scope: budgetScopeSchema,
    /**
     * A NUMBER, deliberately not `.int()`.
     *
     * The unit-count validity check lives in `BudgetLedger.reserve`, which
     * refuses a non-integer or non-positive count with `budget.units_invalid` —
     * a code that says what is wrong. Constraining it here would make the same
     * defect surface as `budget.request_invalid`, which is true but useless: an
     * operator reading that has to go looking for which field of which request
     * failed. `z.number()` still rejects `NaN` and the infinities, which are not
     * quantities at all.
     */
    units: z.number(),
    now: timestampSchema,
    leaseSeconds: z.number().min(1).max(BUDGET_MAX_WALL_CLOCK_SECONDS).safe().optional(),
  })
  .strict()

export type ReserveRequest = z.infer<typeof reserveRequestSchema>

/**
 * The reservation a `reserve` would write if it were admitted.
 *
 * It carries no `state`: only a successful `reserveInTransaction` may produce a
 * `held` reservation (I4), so the state is added by the store that performed the
 * write, not by the caller that asked for it. `leaseExpiresAt` is the ledger's
 * arithmetic on the caller's `now` and `leaseSeconds`, so it appears here rather
 * than in the request — a caller supplying an absolute instant would have to
 * compute it against the same `now` it passed in, and the two getting out of step
 * produces a reservation that is born already reclaimable.
 */
export const reservationDraftSchema = reserveRequestSchema
  .omit({ leaseSeconds: true })
  .extend({ leaseExpiresAt: timestampSchema })
  .strict()

export type ReservationDraft = z.infer<typeof reservationDraftSchema>

/**
 * The transitions a caller may request.
 *
 * `held` is absent on purpose (I4). A caller that could ask to transition into
 * `held` could make a dispatch eligible without occupying capacity.
 */
export const RESERVATION_TRANSITIONS = ["committed", "released", "expired"] as const

export const reservationTransitionSchema = z.enum(RESERVATION_TRANSITIONS)

export type ReservationTransition = z.infer<typeof reservationTransitionSchema>

// ===========================================================================
// Refusals
// ===========================================================================

/**
 * Every named way this module says no, in UTF-16 code-unit order.
 *
 * Closed, because "the budget said no" is a statement an operator has to be able
 * to read, render, and diff. An open-ended refusal vocabulary is a vocabulary
 * nobody can enumerate.
 */
export const BUDGET_REFUSALS = [
  "budget.dispatch_already_reserved",
  "budget.project_budget_invalid",
  "budget.request_invalid",
  "budget.reservation_exists",
  "budget.reservation_unknown",
  "budget.scope_saturated",
  "budget.scope_unbounded",
  "budget.units_invalid",
  "budget.usage_exceeded",
] as const

export type BudgetRefusalCode = (typeof BUDGET_REFUSALS)[number]

/**
 * A refusal, carrying the numbers that explain it.
 *
 * Structured rather than a bare `ContractError` message because a caller has to
 * be able to render "concurrency 5 is full: 5 held, 1 requested" as data. The
 * `scope`, `limit`, `heldUnits` and `requestedUnits` members are `null` for
 * refusals that have no arithmetic behind them, never absent, so a consumer can
 * read them without a `in` check.
 *
 * `toContractError` (in `./ledger.js`) converts one into the kernel's shape for
 * callers on the M0 error path. Nothing in this module throws one.
 */
export const budgetRefusalSchema = z
  .object({
    code: z.enum(BUDGET_REFUSALS),
    message: z.string().min(1).max(2_048),
    scope: budgetScopeSchema.nullable(),
    limit: z.number().int().nonnegative().safe().nullable(),
    heldUnits: z.number().int().nonnegative().safe().nullable(),
    requestedUnits: z.number().int().safe().nullable(),
    reservationId: reservationIdSchema.nullable(),
  })
  .strict()

export type BudgetRefusal = z.infer<typeof budgetRefusalSchema>

/**
 * `Result<T>` over `BudgetRefusal`.
 *
 * Same discriminant as the kernel's `Result<T>` (`src/orchestration/errors.ts`),
 * with `refusal` in place of `error` because the refusal carries structured
 * members the kernel's `ContractError` has no room for. `toContractError` bridges
 * the two for callers that must speak the kernel shape.
 */
export type BudgetResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: BudgetRefusal }

export function budgetOk<T>(value: T): BudgetResult<T> {
  return { ok: true, value }
}

/** The detail a refusal may carry. Every member defaults to `null`, never absent. */
export interface BudgetRefusalDetail {
  readonly scope?: BudgetScope | null
  readonly limit?: number | null
  readonly heldUnits?: number | null
  readonly requestedUnits?: number | null
  readonly reservationId?: ReservationId | null
}

/**
 * Builds a refusal.
 *
 * Validated through `budgetRefusalSchema`, so a caller cannot invent a code
 * outside `BUDGET_REFUSALS` or emit a message over the length bound — the closed
 * vocabulary is enforced at construction rather than by discipline.
 */
export function budgetRefusal(code: BudgetRefusalCode, message: string, detail?: BudgetRefusalDetail): BudgetRefusal {
  return budgetRefusalSchema.parse({
    code,
    message,
    scope: detail?.scope ?? null,
    limit: detail?.limit ?? null,
    heldUnits: detail?.heldUnits ?? null,
    requestedUnits: detail?.requestedUnits ?? null,
    reservationId: detail?.reservationId ?? null,
  })
}

/** The `Result` form, for a caller whose path returns one. */
export function budgetRefuse(code: BudgetRefusalCode, message: string, detail?: BudgetRefusalDetail): BudgetResult<never> {
  return { ok: false, refusal: budgetRefusal(code, message, detail) }
}

// ===========================================================================
// Usage admission
// ===========================================================================

/**
 * Why a usage request was admitted or refused.
 *
 * Code-unit ordered, and every member is reachable from either an observation
 * or a limits object, so a test can drive each reason by construction rather
 * than by hoping a branch is covered.
 */
export const USAGE_ADMISSION_REASONS = [
  "usage_budget_exceeded",
  "usage_figure_unreported",
  "usage_no_budget",
  "usage_not_reported",
  "usage_reliable",
  "usage_unit_mismatch",
  "usage_unit_undeclared",
  "usage_unit_unreported",
  "usage_unreliable",
  "usage_within_budget",
] as const

export type UsageAdmissionReason = (typeof USAGE_ADMISSION_REASONS)[number]

export type UsageAdmission =
  | {
      readonly admitted: true
      readonly enforceability: BudgetEnforceability
      readonly reason: UsageAdmissionReason
      readonly warnings: readonly string[]
      readonly observed: UsageObservation
    }
  | {
      readonly admitted: false
      readonly enforceability: BudgetEnforceability
      readonly reason: UsageAdmissionReason
      readonly warnings: readonly string[]
      readonly observed: UsageObservation
      readonly refusal: BudgetRefusal
    }

// ===========================================================================
// Recovery
// ===========================================================================

/** Why a reservation was reclaimed. Both reasons are evidence, not a guess. */
export const RECOVERY_REASONS = ["dispatch_terminal", "lease_expired"] as const

export type RecoveryReason = (typeof RECOVERY_REASONS)[number]

const terminalReservationStateSchema = z.enum(TERMINAL_RESERVATION_STATES)

export const reclaimedReservationSchema = z
  .object({
    reservationId: reservationIdSchema,
    dispatchId: dispatchIdSchema,
    projectId: projectIdSchema,
    scope: budgetScopeSchema,
    units: z.number().int().min(1).safe(),
    previousState: reservationStateSchema,
    /** The state the reclamation left it in: `released` or `expired`. */
    reclaimedState: terminalReservationStateSchema,
    reason: z.enum(RECOVERY_REASONS),
  })
  .strict()

export type ReclaimedReservation = z.infer<typeof reclaimedReservationSchema>

/**
 * The outcome of a recovery sweep.
 *
 * `reclaimed` is sorted by `reservationId` and `retained` is sorted the same
 * way, so two recovery runs over the same state produce byte-identical reports
 * and a diff of two reports is meaningful.
 *
 * `unverified` is the mirror-image guard on R6: a reservation the sweep applied a
 * transition to and then could NOT confirm is terminal by reading the ledger back.
 * Such a reservation appears in `retained` with its units counted, never in
 * `reclaimed`, because the only claim `reclaimed` makes is that the capacity came
 * back and a claim the store has not confirmed is the one kind of report a budget
 * must not make.
 */
export interface RecoveryReport {
  readonly reclaimed: readonly ReclaimedReservation[]
  /** Reservation ids that still occupy capacity, sorted by code unit. */
  readonly retained: readonly ReservationId[]
  /**
   * Reservation ids the sweep transitioned but could not verify, sorted. Each is
   * ALSO in `retained`; the bucket exists so "the sweep thought it freed this and
   * the ledger disagrees" is a thing a reader can see rather than infer.
   */
  readonly unverified: readonly ReservationId[]
  readonly reclaimedUnits: number
  readonly retainedUnits: number
  readonly reclaimedByReason: Readonly<Record<RecoveryReason, number>>
}

// ===========================================================================
// Replay
// ===========================================================================

/**
 * Why a replay refused to restore an OCCUPYING record at the state the log
 * carried it in. Code-unit ordered.
 *
 * Closed, and the closure is the fix. An open-ended "we did not take this one"
 * vocabulary is a vocabulary an operator cannot enumerate, and the whole point of
 * reporting a rejection is that a reader can tell a DUPLICATED log (benign, the
 * writer said the same thing twice) from a GENUINELY over-limit history (the
 * crashed process held more than its budget allowed) without re-running the
 * replay. See the R12-R17 block on `replayDurableReservations`.
 */
export const REPLAY_REJECTION_REASONS = ["ceiling_undeclared", "duplicate_dispatch", "over_ceiling"] as const

export type ReplayRejectionReason = (typeof REPLAY_REJECTION_REASONS)[number]

const occupyingReservationStateSchema = z.enum(OCCUPYING_RESERVATION_STATES)

/**
 * One occupying record a replay declined to restore as-is.
 *
 * `previousState` is the state the LOG carried and `restoredState` is the state
 * the reservation was actually installed in, which is always `expired`. Carrying
 * both is what makes the report an account rather than a count: the reader can
 * see that `res-7` was recorded `committed` and replayed as `expired`, which is a
 * materially different claim from `res-7` having been recorded `expired`.
 */
export const replayRejectionSchema = z
  .object({
    reservationId: reservationIdSchema,
    dispatchId: dispatchIdSchema,
    projectId: projectIdSchema,
    scope: budgetScopeSchema,
    units: z.number().int().min(1).safe(),
    /** The state the durable record carried. Always an OCCUPYING state. */
    previousState: occupyingReservationStateSchema,
    /** The state replay installed it in. Always `expired`. */
    restoredState: terminalReservationStateSchema,
    reason: z.enum(REPLAY_REJECTION_REASONS),
    /** The ceiling in force for this scope, or `null` when none was declared. */
    ceiling: z.number().int().nonnegative().safe().nullable(),
    /** Units already admitted for this scope at the moment of the decision. */
    admittedUnits: z.number().int().nonnegative().safe(),
    /** A human-readable sentence naming the numbers behind the decision. */
    detail: z.string().min(1).max(2_048),
  })
  .strict()

export type ReplayRejection = z.infer<typeof replayRejectionSchema>

/**
 * The arithmetic for one `(projectId, scope)`, so the ceiling check is
 * checkable rather than asserted.
 *
 * `occupiedUnits` is what the log ASKED for, `admittedUnits` is what the replay
 * could honour, and `rejectedUnits` is the difference — which is exactly the
 * capacity the replay returned rather than stranding. The invariant a sweep test
 * asserts is `admittedUnits <= ceiling` and
 * `admittedUnits + rejectedUnits === occupiedUnits`, and neither is expressible
 * without these three numbers.
 */
export const replayScopeTotalSchema = z
  .object({
    projectId: projectIdSchema,
    scope: budgetScopeSchema,
    ceiling: z.number().int().nonnegative().safe().nullable(),
    occupiedUnits: z.number().int().nonnegative().safe(),
    admittedUnits: z.number().int().nonnegative().safe(),
    rejectedUnits: z.number().int().nonnegative().safe(),
  })
  .strict()

export type ReplayScopeTotal = z.infer<typeof replayScopeTotalSchema>

/**
 * What a replay refused, and what it installed.
 *
 * The conservation identity is `restored.length + collapsedRecords === recordCount`,
 * and it holds by construction: every log row either defines a reservation id that
 * ended up in the target, or is a REDUNDANT row for an id that already did.
 * `rejected` is a SUBSET of `restored` — a rejected reservation is still installed,
 * in state `expired` — so the buckets partition the rows without any reservation
 * appearing in two of them.
 *
 * Every list is code-unit sorted, so two replays of the same set of records
 * produce byte-identical reports no matter what order the rows arrived in
 * (R15).
 */
export interface ReplayReport {
  /** Every reservation id present in the target after the replay, code-unit sorted. */
  readonly restored: readonly ReservationId[]
  /** Occupying records replay installed as `expired`, sorted by `reservationId`. */
  readonly rejected: readonly ReplayRejection[]
  /**
   * Reservation ids that appeared in the log MORE THAN ONCE, sorted. The extra
   * rows were dropped; the id itself is also in `restored`. This is the list an
   * operator diffs to recognise a doubled or re-minted log.
   */
  readonly collapsed: readonly ReservationId[]
  /**
   * How many ROWS were redundant, as opposed to how many ids were. Separate because
   * an id stated three times contributes one to `collapsed` and two here, and the
   * conservation identity is about rows.
   */
  readonly collapsedRecords: number
  /** Rows read in, including every redundant row. */
  readonly recordCount: number
  /** Per-scope arithmetic, sorted by `budgetScopeKey` (projectId, then NUL, then scope). */
  readonly scopes: readonly ReplayScopeTotal[]
  readonly rejectedByReason: Readonly<Record<ReplayRejectionReason, number>>
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Recursively frozen.
 *
 * Local rather than imported from `src/routing/` or `src/memory/`, for the
 * reason recorded on `deepFreezeRouting`: ADR 0007 section 1 gives this module
 * one downward edge, and a deep freeze is not worth a second edge for a source
 * scan to be taught about.
 */
export function deepFreezeBudgets<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  if (Object.isFrozen(value)) return value
  for (const member of Object.values(value as Record<string, unknown>)) {
    deepFreezeBudgets(member)
  }
  return Object.freeze(value)
}

/**
 * Sorted and de-duplicated, by UTF-16 code unit. Never `localeCompare` (I8).
 *
 * Returns a mutable array rather than a frozen one so the result satisfies
 * `z.infer<typeof budgetDecisionSchema>`'s `string[]` directly; the freezing this
 * module actually promises happens in `deepFreezeBudgets` at the boundary where a
 * value is handed to a caller.
 */
export function sortedUniqueBudgets(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

/** Sorted and de-duplicated identifiers, by UTF-16 code unit. */
export function sortedUniqueIds<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort()
}

/**
 * Adds whole seconds to a UTC timestamp.
 *
 * Uses `Date` only to ARITHMETIC on a supplied instant and to format the result.
 * It never reads the host clock, so the function is pure in the sense I7
 * requires; `new Date(x).getTime() + n` and `toISOString()` are both total
 * functions of `x` and `n`.
 */
export function addBudgetSeconds(timestamp: string, seconds: number): string {
  const milliseconds = Date.parse(timestamp)
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`addBudgetSeconds was given an unparseable timestamp: ${timestamp}`)
  }
  return new Date(milliseconds + seconds * 1_000).toISOString()
}

/** The composite key under which a scope's held-unit total is stored. */
export function budgetScopeKey(projectId: string, scope: BudgetScope): string {
  return `${projectId}\u0000${scope}`
}

/**
 * M6.5 — the reservation ledger. The one place capacity is taken.
 *
 * # What this module is
 *
 * `BudgetLedger` is the only object in this milestone that can make a dispatch
 * eligible to launch, and it does so by WRITING a `held` reservation — never by
 * reporting that a check passed.
 *
 * # Why the transaction is STRUCTURALLY atomic
 *
 * This is the part the design lives or dies on, so it is spelled out rather than
 * asserted.
 *
 * The obvious implementation is the one ADR 0007 section 13.2 names as the thing
 * to avoid:
 *
 * ```ts
 * // WRONG. This is check-then-act.
 * const held = store.heldUnits(projectId, scope)
 * if (held + units > limit) return refuse(...)
 * return store.insert(reservation)
 * ```
 *
 * Two problems, and the second is the fatal one. First, the `if` and the
 * `insert` are two operations, so any interleaving between them is a window in
 * which two dispatches both saw `held = 4` against a limit of 5. Second — and
 * this is the one a test cannot easily catch — the check happens at the LEDGER
 * level, where it is `await`-able, and the write happens at the STORE level,
 * where it is not. The moment `heldUnits` becomes a port with a network hop in
 * it, the window becomes a network round trip.
 *
 * So this module inverts the relationship. `BudgetLedgerStore` exposes
 * `reserveInTransaction(draft, decide)`, and `decide` is a SYNCHRONOUS callback
 * that receives the held total as an ARGUMENT and returns an admission:
 *
 * ```ts
 * reserveInTransaction(draft, decide) {
 *   // -- one synchronous critical section, entered and left by this frame --
 *   const held = heldUnitsFor(this.#state, draft.projectId, draft.scope)
 *   const verdict = decide(held)            // no await, no I/O, no re-entry
 *   if (!verdict.admitted) return { ok: false, refusal: verdict.refusal }   // NOTHING was written
 *   this.#state = commitReservation(this.#state, reservation)               // one assignment
 *   // -- critical section over --
 * }
 * ```
 *
 * Three properties make that atomic rather than merely ordered:
 *
 *   1. **The read and the write are in the same synchronous frame.** JavaScript
 *      is single-threaded, so no other `reserveInTransaction` can observe the
 *      state between the `heldUnitsFor` read and the `#state` assignment. There
 *      is no `await` in the critical section, so there is no yield point in it,
 *      and therefore no interleaving to reason about. This holds for an unbounded
 *      number of concurrent callers.
 *   2. **The state is COPY-ON-WRITE and swapped by ONE assignment.**
 *      `commitReservation` builds a fresh immutable state and returns it; the
 *      store then assigns it to `this.#state`. A reader that captured the old
 *      state object before the swap sees a consistent snapshot, never a
 *      half-applied reservation. A refusal returns before any state object is
 *      even constructed, so a refused reserve is provably a no-op on the store.
 *   3. **Re-entering the critical section THROWS.** A `#inCriticalSection` flag is
 *      set on entry and cleared in a `finally`, and a second entry while it is
 *      set raises `InvariantViolationError` naming the invariant. A callback that
 *      reached back into the store — the obvious way to break atomicity — fails
 *      loudly instead of quietly corrupting a total. `tests/unit/budgets/
 *      reservation.test.ts` asserts that throw.
 *
 * The consequence is the invariant ADR 0007 section 13.2 states as a definition:
 * there is no moment at which a dispatch has been checked and not yet reserved,
 * because the check IS the reservation.
 *
 * # Named invariants
 *
 * - **L1 — `eligible` is `reservationState(dispatchId) === "held"`.** It does
 *   not consult a limit, count units, or take a budget. Adding a budget check
 *   here would reintroduce exactly the check-then-act gap the design forbids, and
 *   it would be a check against a state that is already wrong by then.
 * - **L2 — Reservation is all-or-nothing.** A request for more units than remain
 *   is refused with the numbers attached; there is no "reserve what fits" and no
 *   partial application. A caller that wanted a partial reservation would be
 *   asking for capacity nobody agreed to give it.
 * - **L3 — A zero or non-positive or non-integer unit count is refused** with
 *   `budget.units_invalid`, before any state is consulted. A zero-unit
 *   reservation is a way to make a dispatch eligible without consuming capacity,
 *   which would be an eligibility bug, not a budget feature.
 * - **L4 — One reservation per dispatch** (types.ts I3), enforced INSIDE the
 *   transaction, so two concurrent reserves for one `dispatchId` cannot both be
 *   admitted and leave `reservationState` ambiguous.
 * - **L5 — Idempotent transitions, absorbing terminal states** (types.ts I5).
 *   `commit` twice, `release` twice, `expire` after `release` — each is a no-op
 *   the second time, reports `changed: false`, and moves no units. This is what
 *   makes a crash-and-replay safe: the replayed transition cannot double-apply.
 * - **L6 — `commit`/`release`/`expire` cannot produce `held`** (types.ts I4). The
 *   transition vocabulary has no `held` member, so no sequence of transitions can
 *   make an ineligible dispatch eligible.
 * - **L7 — Concurrency and fan-out are SEPARATE counters per project.** The
 *   scope key is `projectId + scope`, so a `maximumFanOut: 3` cannot deny a
 *   concurrency reservation and a `maximumConcurrency: 3` cannot deny a fan-out
 *   reservation. A single shared counter would make the two limits
 *   interchangeable, which is the opposite of what they mean.
 * - **L8 — No unbounded reservation.** A scope with no ceiling declared is
 *   REFUSED (`budget.scope_unbounded`), not admitted. "No budget" is not "infinite
 *   budget": the caller has to say what the limit is, and a ledger that admitted
 *   unreserved capacity would be a capacity accounting system with an off
 *   switch.
 * - **L9 — The async boundary is OUTSIDE the transaction.** `reserve` awaits
 *   `resolveLimits` (an injected port) before calling the store, so a slow or
 *   concurrent budget lookup can delay a reserve but can never be interleaved
 *   into one. This is deliberate: putting the await inside the critical section
 *   would trade atomicity for nothing.
 * - **L10 — No clock, no randomness, no I/O.** `now` arrives on the request.
 *   Reservation ids are CALLER-SUPPLIED, because an id generated here would need
 *   either a clock or a random source and both are forbidden; the caller that
 *   owns the dispatch already has a stable id.
 * - **L11 — Code-unit ordering on every emitted list** (types.ts I8).
 * - **L12 — Expected outcomes are `Result`, never throws** (types.ts I9). The
 *   single throw is re-entering a critical section, which is a defect.
 *
 * # Persistence: an in-memory store, and why that is a recorded deferral
 *
 * `InMemoryBudgetLedgerStore` holds reservations in a plain `Map` inside one
 * immutable state object. There is no SQLite table, no migration, no file
 * format, and nothing in this module touches `src/orchestration/event-store/`.
 *
 * That is a deferral with a reason, not an omission. Budget state is DERIVED from
 * dispatch state: every reservation names a `dispatchId`, and a reservation whose
 * dispatch is terminal or whose lease has expired is capacity that should not be
 * held regardless of what a ledger persisted. Making the store durable before
 * there is a consumer that survives a restart would mean inventing a migration and
 * a record version for a subsystem whose entire recovery story is "ask the
 * dispatcher what actually happened" — and ADR 0007 section 16 requires the dry
 * run to take a fail-closed fake anyway, so the production store is not yet on any
 * exercised path. `BudgetLedgerStore` is the seam: a durable implementation
 * satisfies the same four methods and `BudgetLedger` does not change, and because
 * the transaction is expressed as `reserveInTransaction(draft, decide)` rather than
 * as read-then-write calls, a durable implementation gets
 * `BEGIN IMMEDIATE ... decide(held) ... COMMIT` for free from the same shape.
 *
 * # Stop conditions
 *
 *   - **S1 — Stop if a dispatch can be found eligible without holding a `held`
 *     reservation**, or ineligible while holding one.
 *   - **S2 — Stop if the held total for a `(projectId, scope)` can be observed
 *     above its ceiling,** by any interleaving, crash, or replay.
 *   - **S3 — Stop if a transition is found able to double-apply or to resurrect a
 *     terminal reservation.**
 *   - **S4 — Stop if the transaction ever needs an `await` inside it.** That is
 *     the moment atomicity becomes a hope rather than a property.
 */

import { InvariantViolationError, type ContractError } from "../orchestration/errors.js"
import { composeBudgets, scopeCeiling } from "./compose.js"
import {
  RESERVATION_TRANSITIONS,
  addBudgetSeconds,
  budgetRefuse,
  budgetRefusalSchema,
  budgetReservationSchema,
  budgetScopeKey,
  deepFreezeBudgets,
  isHeld,
  isTerminalReservationState,
  occupiesCapacity,
  reservationTransitionSchema,
  reserveRequestSchema,
  sortedUniqueIds,
  type BudgetLimits,
  type BudgetRefusal,
  type BudgetReservation,
  type BudgetResult,
  type BudgetScope,
  type ReservationDraft,
  type ReservationId,
  type ReservationState,
  type ReservationTransition,
} from "./types.js"

// ===========================================================================
// The store seam
// ===========================================================================

/**
 * The immutable state of a ledger.
 *
 * ONE object holding the reservations, the per-scope totals, and the
 * dispatch-to-reservation index, so that a single assignment swaps all three
 * consistently. Holding the index in a separate mutable map would be the classic
 * way to make a copy-on-write store inconsistent: the reservations could be
 * swapped while the index still pointed at the previous generation.
 */
export interface LedgerState {
  readonly reservations: ReadonlyMap<ReservationId, BudgetReservation>
  /** `(projectId, scope)` composite key -> units occupied by OCCUPYING reservations. */
  readonly heldUnits: ReadonlyMap<string, number>
  readonly reservationIdByDispatch: ReadonlyMap<string, ReservationId>
}

/**
 * The synchronous verdict returned from inside the transaction.
 *
 * A refusal, not a thrown error, even here: "there is no room" is the expected
 * outcome of a saturated scope and the store must be able to return it without
 * unwinding the critical section (types.ts I9).
 */
export type ReservationAdmission = { readonly admitted: true } | { readonly admitted: false; readonly refusal: BudgetRefusal }

/** A transition that was applied, or that was correctly a no-op. */
export interface ReservationTransitionResult {
  readonly reservation: BudgetReservation
  readonly previousState: ReservationState
  /** `false` for a replayed transition or any transition out of a terminal state. */
  readonly changed: boolean
}

/**
 * The persistence seam.
 *
 * Four methods, and the shape of `reserveInTransaction` is the whole design: it
 * takes the DECISION as a synchronous callback rather than returning a total for
 * the caller to compare against. A store whose interface were
 * `heldUnits(...)` + `insert(...)` could not offer atomicity, because its own
 * interface would permit the interleaving.
 *
 * `transition` is separate from `reserveInTransaction` rather than a special
 * case of it because a transition moves units OUT, and a transaction that can
 * both take and release has two more failure modes (release of a reservation
 * that a concurrent sweep is also releasing) for no benefit.
 */
export interface BudgetLedgerStore {
  read(reservationId: ReservationId): BudgetReservation | null
  /**
   * Atomically compare the held total for `(draft.projectId, draft.scope)`
   * against `ceiling` and, if admitted, write a `held` reservation.
   *
   * `decide` is called ONCE, synchronously, inside the critical section, with the
   * held total as it is at that instant. It MUST NOT await, perform I/O, or call
   * back into this store; a store that detects re-entry must fail loudly.
   *
   * A refusal MUST leave the store byte-identical.
   */
  reserveInTransaction(
    draft: ReservationDraft,
    ceiling: number,
    decide: (held: number) => ReservationAdmission,
  ): BudgetResult<BudgetReservation>
  /**
   * Move a reservation to `to`, releasing its units if it was occupying them.
   *
   * Idempotent: applying a transition to a reservation already in a terminal
   * state returns `changed: false` and moves nothing (L5).
   */
  transition(reservationId: ReservationId, to: ReservationTransition, now: string): ReservationTransitionResult
  /** Every reservation, sorted by `reservationId` in code-unit order. */
  list(): readonly BudgetReservation[]
  /** Reservations in state `held`, sorted by `reservationId`. */
  listHeld(): readonly BudgetReservation[]
}

// ===========================================================================
// In-memory store
// ===========================================================================

function emptyLedgerState(): LedgerState {
  return {
    reservations: new Map<ReservationId, BudgetReservation>(),
    heldUnits: new Map<string, number>(),
    reservationIdByDispatch: new Map<string, ReservationId>(),
  }
}

/**
 * Sums the units of every OCCUPYING reservation in a scope.
 *
 * Reads `state.reservations` rather than the `heldUnits` index because the
 * reservation list is the thing the operator can audit, and an index that could
 * disagree with it would be a second source of truth. The map is kept for
 * O(1) reporting and is asserted equal to this sum by the invariant test.
 */
function sumHeldUnits(state: LedgerState, projectId: string, scope: BudgetScope): number {
  let total = 0
  for (const reservation of state.reservations.values()) {
    if (reservation.projectId !== projectId) continue
    if (reservation.scope !== scope) continue
    if (!occupiesCapacity(reservation.state)) continue
    total += reservation.units
  }
  return total
}

/**
 * Builds the NEXT state with one reservation added. Pure; the caller assigns it.
 *
 * Copy-on-write of all three maps. The copy of `reservations` and the copy of
 * `reservationIdByDispatch` are made unconditionally rather than mutated, so a
 * state object captured by a concurrent reader is never altered underneath it —
 * which is the property that lets `heldUnitsFor` be called from inside the
 * critical section without the snapshot being unstable.
 */
function withReservation(
  state: LedgerState,
  reservation: BudgetReservation,
  deltaUnits: number,
): LedgerState {
  const reservations = new Map(state.reservations)
  const reservationIdByDispatch = new Map(state.reservationIdByDispatch)
  const heldUnits = new Map(state.heldUnits)
  reservations.set(reservation.reservationId, reservation)
  reservationIdByDispatch.set(reservation.dispatchId, reservation.reservationId)
  const key = budgetScopeKey(reservation.projectId, reservation.scope)
  heldUnits.set(key, Math.max(0, (state.heldUnits.get(key) ?? 0) + deltaUnits))
  return { reservations, heldUnits, reservationIdByDispatch }
}

function withReplacedReservation(
  state: LedgerState,
  reservation: BudgetReservation,
  releasedUnits: number,
): LedgerState {
  const reservations = new Map(state.reservations)
  const heldUnits = new Map(state.heldUnits)
  reservations.set(reservation.reservationId, reservation)
  const key = budgetScopeKey(reservation.projectId, reservation.scope)
  heldUnits.set(key, Math.max(0, (state.heldUnits.get(key) ?? 0) - releasedUnits))
  return { reservations, heldUnits, reservationIdByDispatch: state.reservationIdByDispatch }
}

/**
 * The transactional in-memory store.
 *
 * The transaction is the method body between the flag being set and the flag
 * being cleared. There is no `await` in it, no callback that is handed anything
 * it could await on, and one assignment that publishes the new state. That is
 * the whole atomicity argument and it is structural rather than disciplinary: a
 * future edit would have to insert an `await` into `reserveInTransaction` to
 * break it, and the re-entry guard turns the other obvious way of breaking it
 * into a thrown `InvariantViolationError`.
 */
export class InMemoryBudgetLedgerStore implements BudgetLedgerStore {
  #state: LedgerState = emptyLedgerState()
  #inCriticalSection = false

  read(reservationId: ReservationId): BudgetReservation | null {
    return this.#state.reservations.get(reservationId) ?? null
  }

  reserveInTransaction(
    draft: ReservationDraft,
    ceiling: number,
    decide: (held: number) => ReservationAdmission,
  ): BudgetResult<BudgetReservation> {
    if (this.#inCriticalSection) {
      throw new InvariantViolationError(
        "budget.reservation_atomicity",
        `reserveInTransaction for '${draft.reservationId}' was entered while another reservation transaction was in flight. The critical section must contain no await, no I/O, and no call back into the store; a re-entrant call is how a compare-and-set stops being one.`,
      )
    }
    this.#inCriticalSection = true
    try {
      // ---- critical section: synchronous from here to the assignment ----
      const key = budgetScopeKey(draft.projectId, draft.scope)
      const held = sumHeldUnits(this.#state, draft.projectId, draft.scope)

      if (this.#state.reservations.has(draft.reservationId)) {
        return budgetRefuse(
          "budget.reservation_exists",
          `budget.reservation_exists: reservation '${draft.reservationId}' is already recorded; a replayed reserve is refused rather than written twice`,
          { scope: draft.scope, reservationId: draft.reservationId },
        )
      }
      const existing = this.#state.reservationIdByDispatch.get(draft.dispatchId)
      if (existing !== undefined) {
        return budgetRefuse(
          "budget.dispatch_already_reserved",
          `budget.dispatch_already_reserved: dispatch '${draft.dispatchId}' already holds reservation '${existing}'; one dispatch holds at most one reservation so that its eligibility is single-valued`,
          { scope: draft.scope, reservationId: existing },
        )
      }

      const verdict = decide(held)
      if (!verdict.admitted) {
        // Nothing has been written at this point, and nothing will be. A refused
        // reserve is a provable no-op on the store.
        return { ok: false, refusal: verdict.refusal }
      }

      const reservation = budgetReservationSchema.parse({
        reservationId: draft.reservationId,
        projectId: draft.projectId,
        runId: draft.runId,
        taskId: draft.taskId,
        dispatchId: draft.dispatchId,
        scope: draft.scope,
        units: draft.units,
        state: "held" as const,
        leaseExpiresAt: draft.leaseExpiresAt,
        createdAt: draft.now,
        updatedAt: draft.now,
      })
      this.#state = withReservation(this.#state, reservation, reservation.units)
      // ---- critical section over ----
      return { ok: true, value: deepFreezeBudgets(reservation) }
    } finally {
      this.#inCriticalSection = false
    }
  }

  transition(
    reservationId: ReservationId,
    to: ReservationTransition,
    now: string,
  ): ReservationTransitionResult {
    if (this.#inCriticalSection) {
      throw new InvariantViolationError(
        "budget.reservation_atomicity",
        `transition of '${reservationId}' was attempted while a reservation transaction was in flight. Transitions and reserves must not interleave.`,
      )
    }
    const current = this.#state.reservations.get(reservationId)
    if (current === undefined) {
      throw new InvariantViolationError(
        "budget.reservation_unknown",
        `transition of '${reservationId}' found no such reservation. Callers must check with read() or use BudgetLedger.transition(), which returns a Result rather than throwing.`,
      )
    }
    // L5: a terminal reservation is absorbing. Any further transition is a
    // correctly-reported no-op, which is what makes a replayed `commit` after a
    // `release` safe rather than a resurrection.
    if (isTerminalReservationState(current.state)) {
      return { reservation: deepFreezeBudgets(current), previousState: current.state, changed: false }
    }
    if (current.state === to) {
      return { reservation: deepFreezeBudgets(current), previousState: current.state, changed: false }
    }
    // `committed` is only reachable from `held`: a reservation that already
    // released or expired cannot be launched afterwards, and I4 means nothing may
    // put it back into `held`.
    if (to === "committed" && !isHeld(current.state)) {
      throw new InvariantViolationError(
        "budget.invalid_transition",
        `reservation '${reservationId}' cannot move from '${current.state}' to 'committed'; only a held reservation can be committed on launch`,
      )
    }
    const next = budgetReservationSchema.parse({
      ...current,
      state: to,
      updatedAt: now,
    })
    // I2, and this is the whole content of it: `held` and `committed` BOTH occupy
    // capacity, so only a move OUT of the occupying set returns units. Committing a
    // reservation on launch is a move WITHIN that set and must subtract nothing —
    // computing this as `occupiesCapacity(current.state) ? units : 0` makes every
    // commit look like a release, and the maintained index then under-reports the
    // held total by exactly the units of everything that has ever launched.
    //
    // The consequence of getting it wrong is bounded, and it is worth stating why
    // it is not worse: `reserveInTransaction` recomputes the held total from the
    // reservation LIST rather than reading this index, so admission was never
    // affected. What was wrong was the index — the value a caller reads to render
    // "3 of 5 held" — which is precisely the over-release direction of unit
    // conservation, and which `Math.max(0, …)` below would floor to zero rather
    // than expose.
    const releasedUnits = occupiesCapacity(current.state) && !occupiesCapacity(next.state) ? current.units : 0
    this.#state = withReplacedReservation(this.#state, deepFreezeBudgets(next), releasedUnits)
    return { reservation: deepFreezeBudgets(next), previousState: current.state, changed: true }
  }

  list(): readonly BudgetReservation[] {
    return sortedUniqueIds(this.#state.reservations.keys())
      .map((reservationId) => this.#state.reservations.get(reservationId))
      .filter((reservation): reservation is BudgetReservation => reservation !== undefined)
      .map((reservation) => deepFreezeBudgets(reservation))
  }

  listHeld(): readonly BudgetReservation[] {
    return this.list().filter((reservation) => isHeld(reservation.state))
  }

  // -- ledger-facing extras ------------------------------------------------

  /** The reservation for a dispatch, or `null`. The only lookup `eligible` needs. */
  reservationForDispatch(dispatchId: string): BudgetReservation | null {
    const reservationId = this.#state.reservationIdByDispatch.get(dispatchId)
    if (reservationId === undefined) return null
    return this.#state.reservations.get(reservationId) ?? null
  }

  /**
   * Units currently occupying `(projectId, scope)`.
   *
   * Recomputed from the reservations rather than read off the index, so this
   * method can be called from inside a transaction without the index being a
   * second source of truth. The index is kept in step by `withReservation` and is
   * cross-checked by the invariant test.
   */
  heldUnitsFor(projectId: string, scope: BudgetScope): number {
    return sumHeldUnits(this.#state, projectId, scope)
  }

  /** The maintained index, exposed so the invariant test can cross-check it. */
  indexedHeldUnits(): ReadonlyMap<string, number> {
    return new Map(this.#state.heldUnits)
  }

  /**
   * Replaces the whole state. Exists for the crash/replay test, which builds a
   * fresh ledger from a durable record rather than mutating one.
   */
  restore(state: LedgerState): void {
    this.#state = state
  }

  /** A snapshot of the current state, for the same reason. */
  snapshot(): LedgerState {
    return this.#state
  }
}

// ===========================================================================
// The ledger
// ===========================================================================

/** Resolves the budget in force for a project. The one async edge, and it is outside the transaction (L9). */
export type BudgetLimitResolver = (projectId: string) => Promise<BudgetLimits> | BudgetLimits

export interface BudgetLedgerOptions {
  readonly store?: BudgetLedgerStore
  readonly resolveLimits: BudgetLimitResolver
  /**
   * Default lease duration in seconds, applied when a request does not state one.
   *
   * Bounded by the safety floor's own timeout ceiling so a lease can never
   * outlive the run it reserves capacity for; a lease longer than the maximum
   * permitted run would hold capacity for a dispatch that could not exist.
   */
  readonly defaultLeaseSeconds?: number
}

/**
 * Reservation and admission.
 *
 * `reserve` is `async` for exactly one reason: `resolveLimits` is an injected
 * port, and a real caller's port is a store read. The `await` sits between
 * validating the request and entering the transaction, so a slow port delays the
 * reserve and cannot be interleaved into it (L9).
 */
export class BudgetLedger {
  readonly #store: BudgetLedgerStore & Partial<InMemoryBudgetLedgerStore>
  readonly #resolveLimits: BudgetLimitResolver
  readonly #defaultLeaseSeconds: number

  constructor(options: BudgetLedgerOptions) {
    this.#resolveLimits = options.resolveLimits
    this.#defaultLeaseSeconds = options.defaultLeaseSeconds ?? 300
    const store = options.store ?? new InMemoryBudgetLedgerStore()
    // The ledger needs `heldUnitsFor` for its own reporting and `reservationForDispatch`
    // for eligibility. Both are part of the concrete store's surface rather than
    // the interface, because a durable store can answer them from its own index
    // and requiring them on the interface would over-constrain it; the ledger
    // degrades to a refusal naming the missing capability rather than to a wrong
    // answer if a custom store omits them.
    this.#store = store as BudgetLedgerStore & Partial<InMemoryBudgetLedgerStore>
    if (typeof this.#store.reservationForDispatch !== "function") {
      throw new InvariantViolationError(
        "budget.store_capability",
        "BudgetLedger requires a store that implements reservationForDispatch(dispatchId): eligibility is DEFINED as holding a held reservation, so the ledger must be able to look a reservation up by dispatch.",
      )
    }
  }

  get store(): BudgetLedgerStore {
    return this.#store
  }

  /**
   * The budget in force for a project, composed from the resolver's answer.
   *
   * Exposed so a caller (M6.7's dry run in particular) can render the decision
   * it will enforce WITHOUT reserving anything — reading a budget is not a
   * reservation and must never be treated as one.
   */
  async budgetFor(
    projectId: string,
    contributions: readonly { readonly source: string; readonly limits: BudgetLimits }[] = [],
    observation?: Parameters<typeof composeBudgets>[2],
  ): Promise<BudgetLimits> {
    const limits = await this.#resolveLimits(projectId)
    return composeBudgets(limits, contributions, observation).limits
  }

  /**
   * Atomically reserve capacity for a dispatch.
   *
   * Returns the new `held` reservation, or a refusal naming the limit that was
   * hit, the units already held, and the units requested. `eligible` becomes true
   * for this dispatch at the moment this returns `ok`, and at no moment before.
   */
  async reserve(request: Parameters<typeof reserveRequestSchema.parse>[0]): Promise<BudgetResult<BudgetReservation>> {
    const parsed = reserveRequestSchema.safeParse(request)
    if (!parsed.success) {
      return budgetRefuse(
        "budget.request_invalid",
        `budget.request_invalid: a reservation request that does not satisfy reserveRequestSchema is refused rather than half-evaluated: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      )
    }
    const draft = parsed.data

    // L3: a unit count that cannot be added is refused BEFORE any state is read,
    // so there is no path by which a zero-unit reservation makes a dispatch
    // eligible without consuming capacity.
    if (!Number.isSafeInteger(draft.units) || draft.units < 1) {
      return budgetRefuse(
        "budget.units_invalid",
        `budget.units_invalid: a reservation for ${draft.units} unit(s) was refused; units must be a positive safe integer, because a zero-unit reservation would make a dispatch eligible without consuming capacity`,
        { scope: draft.scope, requestedUnits: Number.isSafeInteger(draft.units) ? draft.units : null },
      )
    }

    const leaseSeconds = draft.leaseSeconds ?? this.#defaultLeaseSeconds
    if (!Number.isFinite(leaseSeconds) || !Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
      return budgetRefuse(
        "budget.request_invalid",
        `budget.request_invalid: leaseSeconds=${draft.leaseSeconds} is not a positive safe integer; a reservation whose lease is already in the past would be eligible and reclaimable at the same instant`,
        { scope: draft.scope },
      )
    }

    // ---- the one await, and it is OUTSIDE the transaction (L9) ----
    const composed = composeBudgets(await this.#resolveLimits(draft.projectId))
    const ceiling = scopeCeiling(composed.limits, draft.scope)
    if (ceiling === null) {
      // L8: no budget declared is not an infinite budget.
      return budgetRefuse(
        "budget.scope_unbounded",
        `budget.scope_unbounded: the composed budget for project '${draft.projectId}' declares no maximum for the '${draft.scope}' scope, so nothing may be reserved against it; 'no budget' is not 'unlimited budget'`,
        { scope: draft.scope, limit: null, heldUnits: null, requestedUnits: draft.units },
      )
    }

    const withLease: ReservationDraft = {
      ...draft,
      units: draft.units,
      leaseExpiresAt: addBudgetSeconds(draft.now, leaseSeconds),
    }

    // ---- the compare-and-set. One synchronous frame. (types.ts docblock) ----
    return this.#store.reserveInTransaction(withLease, ceiling, (held) => {
      const saturated = (message: string): ReservationAdmission => ({
        admitted: false,
        refusal: budgetRefusalSchema.parse({
          code: "budget.scope_saturated" as const,
          message,
          scope: draft.scope,
          limit: ceiling,
          heldUnits: held,
          requestedUnits: draft.units,
          reservationId: null,
        }),
      })
      if (draft.units > ceiling) {
        return saturated(
          `budget.scope_saturated: reserving ${draft.units} unit(s) of '${draft.scope}' exceeds the entire ceiling of ${ceiling}; a reservation is all-or-nothing and is never partially applied`,
        )
      }
      if (held + draft.units > ceiling) {
        return saturated(
          `budget.scope_saturated: '${draft.scope}' is at ${held} of ${ceiling} held unit(s), and reserving ${draft.units} more would reach ${held + draft.units}; refused`,
        )
      }
      return { admitted: true }
    })
  }

  /** The state of the reservation a dispatch holds, or `null` if it holds none. */
  reservationState(dispatchId: string): ReservationState | null {
    const reservation = this.#store.reservationForDispatch?.(dispatchId) ?? null
    return reservation === null ? null : reservation.state
  }

  /**
   * Is this dispatch eligible to launch?
   *
   * THE DEFINITION. `reservationState(dispatchId) === "held"` and nothing else —
   * no limit, no held total, no budget. Any additional check here would be a
   * second admission decision made after the atomic one, which is the
   * check-then-act gap ADR 0007 section 13.2 exists to close (L1).
   */
  eligible(dispatchId: string): boolean {
    return this.reservationState(dispatchId) === "held"
  }

  /** The reservation a dispatch holds, or `null`. */
  reservationForDispatch(dispatchId: string): BudgetReservation | null {
    return this.#store.reservationForDispatch?.(dispatchId) ?? null
  }

  read(reservationId: ReservationId): BudgetReservation | null {
    return this.#store.read(reservationId)
  }

  /**
   * Move a reservation to `to`.
   *
   * Idempotent (L5): a replayed call after a crash reports `changed: false` and
   * moves no units. An unknown reservation is a named refusal rather than a
   * throw, because a replay legitimately references reservations that were never
   * written.
   */
  transition(reservationId: ReservationId, to: ReservationTransition, now: string): BudgetResult<ReservationTransitionResult> {
    const parsed = reservationTransitionSchema.safeParse(to)
    if (!parsed.success) {
      return budgetRefuse(
        "budget.request_invalid",
        `budget.request_invalid: '${to}' is not a reservation transition. Only ${RESERVATION_TRANSITIONS.join(", ")} may be requested: a transition into 'held' would make a dispatch eligible without reserving capacity.`,
        { reservationId },
      )
    }
    if (this.#store.read(reservationId) === null) {
      return budgetRefuse(
        "budget.reservation_unknown",
        `budget.reservation_unknown: no reservation '${reservationId}' exists; a replayed transition may legitimately name one that was never written`,
        { reservationId },
      )
    }
    try {
      return { ok: true, value: this.#store.transition(reservationId, parsed.data, now) }
    } catch (error) {
      if (error instanceof InvariantViolationError) {
        return budgetRefuse("budget.reservation_unknown", error.message, { reservationId })
      }
      throw error
    }
  }

  /** Called on launch. A committed reservation keeps occupying its units (types.ts I2). */
  commit(reservationId: ReservationId, now: string): BudgetResult<ReservationTransitionResult> {
    return this.transition(reservationId, "committed", now)
  }

  /** Called on any terminal dispatch state. Returns the units to the scope. */
  release(reservationId: ReservationId, now: string): BudgetResult<ReservationTransitionResult> {
    return this.transition(reservationId, "released", now)
  }

  /** Called when a lease passes. Returns the units to the scope. */
  expire(reservationId: ReservationId, now: string): BudgetResult<ReservationTransitionResult> {
    return this.transition(reservationId, "expired", now)
  }

  /** Units occupying `(projectId, scope)`. Zero for a store without the capability. */
  heldUnits(projectId: string, scope: BudgetScope): number {
    return this.#store.heldUnitsFor?.(projectId, scope) ?? 0
  }

  /** Every reservation, code-unit sorted. */
  list(): readonly BudgetReservation[] {
    return this.#store.list()
  }

  /** Every `held` reservation, code-unit sorted. */
  listHeld(): readonly BudgetReservation[] {
    return this.#store.listHeld()
  }
}

/**
 * Bridges a `BudgetRefusal` to the kernel's `ContractError`.
 *
 * The two shapes coexist because this module's refusals carry structured numbers
 * (`limit`, `heldUnits`, `requestedUnits`) that `ContractError` has no room for,
 * and a caller on the M0 error path needs the kernel's shape. Nothing in this
 * module throws a refusal (types.ts I9); this exists for the boundary.
 */
export function toContractError(refusal: { readonly code: string; readonly message: string }): ContractError {
  return {
    schemaVersion: 1,
    category: "policy_denied",
    code: refusal.code,
    message: refusal.message.slice(0, 4_096),
    retryable: false,
  }
}

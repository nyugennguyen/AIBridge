/**
 * M6.5 — crash and replay recovery.
 *
 * # What this module is
 *
 * The answer to "a process died between reserve and release — where did the
 * capacity go?". It is `recoverLeaked`, a sweep that reclaims a `held`
 * reservation on exactly two pieces of evidence and on nothing else, plus
 * `replayDurableReservations`, which rebuilds a ledger from the durable half of
 * its history before the sweep runs.
 *
 * # The two pieces of evidence
 *
 *   - **The owning dispatch reached a TERMINAL state.** A reservation exists to
 *     admit one dispatch. When that dispatch is `completed`, `failed`,
 *     `cancelled`, `rejected`, or `timed_out`, the reservation's purpose is over
 *     and its units belong to the scope again. This is not a heuristic: it is
 *     `isDispatchTerminal` read off `src/orchestration/transitions.ts`, the same
 *     predicate the kernel uses, so this module cannot drift from the kernel's
 *     idea of "finished".
 *   - **The lease passed.** A reservation carries `leaseExpiresAt`, and a lease
 *     is a promise that the holder will reach a terminal state by then. A lease
 *     that has passed at an injected `now` is a promise that was broken, and
 *     capacity cannot be held forever on the strength of a broken promise — that
 *     is ADR 0007 section 13.2's "a crash between reserve and release cannot leak
 *     capacity permanently".
 *
 * There is no third reason. In particular a sweep does NOT reclaim a reservation
 * whose dispatch is absent from the state map, and does NOT reclaim one whose
 * lease is still valid. Both would be guesses, and a guess that frees capacity
 * someone is using is worse than a leak a later sweep fixes.
 *
 * # Crash and replay: the shape of the durable record
 *
 * A crash takes a ledger's IN-MEMORY state and leaves whatever was written down.
 * So the question "what does a durable reservation log contain?" has exactly one
 * answer that makes recovery work, and it is the answer this module takes:
 *
 *   - **The durable half is the `reserve` DECISION.** Every reservation that was
 *     admitted is a record: it existed, it consumed units, and admitting it is
 *     precisely what `reserveInTransaction` did atomically. A log that omitted
 *     `held` reservations would omit exactly the ones a crash strands, and
 *     `recoverLeaked` would have nothing to reclaim — the leak would be
 *     unrecoverable by construction. That is why `durableReservationRecordSchema`
 *     accepts ALL FOUR states, and why the "committed reservations only" phrasing
 *     is read as "reservations whose reserve transaction COMMITTED", not as
 *     "reservations in state `committed`". The state a reservation is restored
 *     into is the state the record carries.
 *   - **The volatile half is the absence of a terminal transition.** A `held`
 *     record with no later record saying otherwise is a reservation whose owner
 *     died. The sweep is what resolves it, from the dispatch table.
 *
 * `replayDurableReservations` therefore restores records in whatever state each
 * carries, and `recoverLeaked` runs over the result.
 *
 * # What replay is now ALSO responsible for, and why "verbatim" was not enough
 *
 * An earlier version of this module restored every row in the state the log
 * carried it and argued that the rebuild therefore "cannot invent capacity,
 * because it restores the same reservations the crashed process admitted and no
 * others". That argument holds only for a log that is a FAITHFUL history, and a
 * log is not entitled to be one: a writer that re-emits rows, a log shipped twice
 * and concatenated, a writer that minted a fresh `reservationId` per attempt, a
 * log truncated at the wrong offset, and a budget narrowed since the crash all
 * describe a total that exceeds any ceiling. Restoring them verbatim installed
 * `held: 5` against a ceiling of `1`.
 *
 * The consequence was not a bypass. `reserveInTransaction` computes `5 + 1 > 1`
 * and refuses — and refuses every later reserve too. The budget was WEDGED, which
 * is an availability failure wearing a safety costume, and `held <= ceiling` held
 * in steady state and failed after a crash, which is the worst possible time for a
 * budget to stop being a budget.
 *
 * So replay is now a SECOND ADMISSION DECISION, made against ceilings the caller
 * resolves, in a deterministic order, and every refusal is reported with a named
 * reason. The full argument, and the argument against refusing the whole replay,
 * is on `replayDurableReservations` (R12-R17). The two rules that make it safe are
 * that a refusal is never TOTAL (every row ends up installed, so no reservation is
 * lost) and that a refusal RETURNS capacity (the row is installed as `expired`, so
 * the recovered ledger can still accept reserves).
 *
 * What makes "no reservation is lost" hold is unchanged by any of that: every
 * admitted reservation is in the log, every reclaimed one is still readable in
 * its terminal state afterwards, and every REFUSED one is still readable too — as
 * `expired`, with the log's own state preserved in the report.
 *
 * # Named invariants
 *
 * - **R1 — Reclamation is evidence-gated and the evidence is named.** Every
 *   reclaimed entry carries the reason and the state it was in, so an operator
 *   reading the report can tell "the work finished" from "the process vanished"
 *   without re-running the sweep.
 * - **R2 — A terminal dispatch beats an expired lease, and the reason says so.**
 *   When both hold, the entry is reclaimed as `dispatch_terminal`, because "the
 *   work finished" is the stronger and more actionable fact and a report calling
 *   a completed dispatch `lease_expired` would be actively misleading. The
 *   precedence is in the code, not a consequence of iteration order.
 * - **R3 — A still-running dispatch with a valid lease is NOT reclaimed.** It is
 *   reported in `retained` with its units counted, so a sweep that reclaimed
 *   nothing is visibly different from a sweep that was never run.
 * - **R4 — Recovery cannot raise a total.** Nothing in `recoverLeaked` writes a
 *   `held` reservation; every write it makes moves a reservation to `released` or
 *   `expired`. Replay may PRESERVE a `held` the log already carried, but it can
 *   only ever move an OCCUPYING record towards a terminal state, never the other
 *   way (I4). Neither path is a way to manufacture eligibility.
 * - **R5 — Idempotent.** A sweep over an already-swept state reclaims nothing and
 *   reports the same retained set, because every reclaim goes through the ledger's
 *   idempotent transition and terminal states are absorbing. The replay analogue
 *   is R15: the same rows in any order install the same state.
 * - **R6 — Units are conserved across a sweep.** Every occupied reservation is
 *   either reclaimed (its units returned) or retained (its units counted), so
 *   `reclaimedUnits + retainedUnits` equals the occupied total the sweep started
 *   from. A sweep that lost a reservation breaks this, which is what makes "no
 *   reservation was lost" checkable rather than asserted. The replay analogue is
 *   R14: `admittedUnits + rejectedUnits === occupiedUnits`, per scope.
 * - **R18 — A sweep CONFIRMS its own claims by reading the ledger back.** The
 *   over-release direction of R6 — the report saying capacity came back when it did
 *   not — is not reachable by any arithmetic this module performs, because the
 *   sweep only ever calls `release`/`expire` on a row it has just observed
 *   occupying. It IS reachable through a store that reports success and does not
 *   move the reservation, which no return-value check can catch. So the sweep
 *   re-reads the ledger once and demotes every claim the ledger does not
 *   corroborate, in BOTH directions: the entry leaves `reclaimed`, its reason
 *   count is decremented, its units go back to `retainedUnits`, and its id appears
 *   in `unverified`. This is the defence in the direction that had none.
 * - **R7 — Sorted, de-duplicated output.** `reclaimed` and `retained` are both in
 *   `reservationId` code-unit order, so two sweeps over the same state produce
 *   byte-identical reports and a diff of two reports means something.
 * - **R8 — Pure with respect to everything but the ledger.** `now` and the
 *   dispatch state map are injected. No clock, no network, no read of the
 *   orchestrator's own aggregates — the dispatch table arrives as a value the
 *   caller already holds, because `src/budgets/` must not take an upward edge
 *   into dispatch storage to learn whether a dispatch finished.
 * - **R9 — A sweep is resumable, and does not need to be atomic.** Each
 *   reclamation is its own transaction, so a sweep interrupted after the third of
 *   five entries leaves three reclaimed and two held; running it again finishes
 *   the job (R5). Independent idempotent steps are a strictly stronger
 *   recoverability property than all-or-nothing, because a crash cannot leave a
 *   partial transaction to reason about.
 * - **R10 — Replay never re-derives history.** A restored record keeps the
 *   timestamps and the unit count the log carried. A replay that recomputed a
 *   lease, or re-counted units, or re-derived the budget in force at crash time,
 *   would be a second derivation of history from inputs that are gone. The ONE
 *   member replay may change is `state`, and only from an occupying state to
 *   `expired` (R16).
 * - **R11 — The durable log accepts every state, including `held`.** A log that
 *   refused a `held` record could not describe a crash that happened between
 *   reserve and release, which is the one crash this milestone exists to survive.
 *   Refusing it would make the leak unrecoverable rather than merely rare.
 * - **R12-R17 and R19** are stated in full on `replayDurableReservations`, because
 *   they are arguments about a decision rather than properties of a value. In one
 *   line each: the ceiling bounds the replay; a refusal is never total; a refusal
 *   returns capacity; the outcome is a function of the set of rows and not their
 *   order; nothing is restamped; terminal rows always come in; one dispatch has one
 *   reservation.
 *
 * # Stop conditions
 *
 *   - **S1 — Stop if a sweep can ever reclaim a reservation whose dispatch is
 *     running and whose lease is still valid.** That would be freeing capacity in
 *     use, and it is the failure every "be tidy on startup" implementation
 *     eventually ships.
 *   - **S2 — Stop if a sweep can lose a reservation**, or leave the retained set
 *     inconsistent with the occupied total (R6).
 *   - **S3 — Stop if a sweep can ever create a `held` reservation** (R4), or if a
 *     replay can turn a non-occupying record into an occupying one (R16).
 *   - **S4 — Stop if replay can double-count.** Restoring a durable record twice
 *     must be a no-op, because a caller replaying the same log twice is a
 *     plausible retry, not a bug (R15, and `ReplayReport.collapsed`).
 *   - **S5 — Stop if a replay can install a held total above a declared ceiling**,
 *     or refuse over-limit rows in a way that leaves the recovered ledger unable to
 *     accept any reserve at all. Both were reachable before R12; the second is the
 *     one that looks like a safety property and is not (I11, I12).
 */

import { isDispatchTerminal, type DispatchState } from "../orchestration/transitions.js"
import {
  BUDGET_SCOPES,
  REPLAY_REJECTION_REASONS,
  RECOVERY_REASONS,
  budgetRefusalSchema,
  budgetReservationSchema,
  budgetScopeKey,
  occupiesCapacity,
  reclaimedReservationSchema,
  replayRejectionSchema,
  replayScopeTotalSchema,
  sortedUniqueIds,
  type BudgetRefusal,
  type BudgetReservation,
  type BudgetScope,
  type OccupyingReservationState,
  type ReclaimedReservation,
  type RecoveryReason,
  type RecoveryReport,
  type ReplayRejection,
  type ReplayRejectionReason,
  type ReplayReport,
  type ReplayScopeTotal,
  type ReservationId,
  type ReservationState,
} from "./types.js"

/**
 * The shape `recoverLeaked` reads from a ledger.
 *
 * Structural rather than `BudgetLedger` so a caller can sweep a subset — a
 * project, a run — without this module having to know how a ledger is built, and
 * so a test can sweep a fake.
 */
export interface SweepableLedger {
  list(): readonly BudgetReservation[]
  release(reservationId: ReservationId, now: string): { readonly ok: true; readonly value: { readonly reservation: BudgetReservation } } | { readonly ok: false; readonly refusal: BudgetRefusal }
  expire(reservationId: ReservationId, now: string): { readonly ok: true; readonly value: { readonly reservation: BudgetReservation } } | { readonly ok: false; readonly refusal: BudgetRefusal }
}

/** The dispatch terminality oracle. A value, not a port, so a sweep is pure. */
export interface DispatchStateTable {
  readonly states: ReadonlyMap<string, DispatchState>
}

export interface RecoveryPorts {
  /**
   * The state of each dispatch, or absent for one this build has never seen.
   *
   * An absent dispatch is NOT terminal and is NOT a reason to reclaim: a caller
   * that has not loaded the whole table has not established anything.
   */
  readonly dispatchStates: ReadonlyMap<string, DispatchState>
  /** Reservations to consider. Defaults to everything the ledger holds. */
  readonly reservationIds?: readonly ReservationId[]
  /** Called for each reclamation the ledger refused. Never silently dropped. */
  readonly onReclaimRefused?: (refusal: BudgetRefusal) => void
}

export interface RecoverLeakedRequest extends RecoveryPorts {
  readonly now: string
}

function emptyReasonCounts(): Record<RecoveryReason, number> {
  const counts = {} as Record<RecoveryReason, number>
  for (const reason of RECOVERY_REASONS) counts[reason] = 0
  return counts
}

/**
 * Every rejection reason present and zero, so a reader never has to test for
 * absence — the same reasoning as `emptyReasonCounts`, and kept separate because
 * the two vocabularies are separate: a sweep reclaims and a replay refuses, and
 * merging them into one counter map would make `over_ceiling: 0` mean something
 * about a sweep that never had a ceiling to consult.
 */
function emptyRejectionCounts(): Record<ReplayRejectionReason, number> {
  const counts = {} as Record<ReplayRejectionReason, number>
  for (const reason of REPLAY_REJECTION_REASONS) counts[reason] = 0
  return counts
}

/**
 * Why (if at all) this reservation may be reclaimed, or `null`.
 *
 * `null` is the ONLY safe answer for a running dispatch with a valid lease (R3).
 * The order of the two checks IS the precedence of R2: terminal dispatch first,
 * and it wins.
 *
 * The lease comparison is a STRING comparison, which is chronological only
 * because every timestamp these schemas accept is UTC with the same fixed-width
 * layout (`src/orchestration/identifiers.ts:105-123` rejects anything else). That
 * makes the schema's strictness a correctness requirement for this function and
 * not merely tidiness — worth stating, because the next reader will otherwise be
 * tempted to "fix" it with `Date.parse`.
 *
 * The comparison is STRICT (`leaseExpiresAt < now`), so the lease instant itself
 * is still valid. ADR 0007 section 13.2 says a reservation is reclaimed when its
 * lease "passed", and a lease that expires AT `T` has not passed at `T`. Getting
 * this backwards would reclaim a reservation at the precise instant its holder was
 * still entitled to it, which on a sweep scheduled at a round instant is the
 * common case rather than an edge one.
 */
export function recoveryReasonFor(
  reservation: Pick<BudgetReservation, "dispatchId" | "leaseExpiresAt">,
  dispatchStates: ReadonlyMap<string, DispatchState>,
  now: string,
): RecoveryReason | null {
  const dispatchState = dispatchStates.get(reservation.dispatchId)
  if (dispatchState !== undefined && isDispatchTerminal(dispatchState)) {
    return "dispatch_terminal"
  }
  if (reservation.leaseExpiresAt < now) {
    return "lease_expired"
  }
  return null
}

/**
 * Reclaims leaked reservations and reports exactly what it did.
 *
 * `now` is injected and compared against `leaseExpiresAt` as a string (see
 * `recoveryReasonFor`).
 *
 * Each reclamation is a separate `release`/`expire` through the ledger, so a
 * sweep interrupted part-way is resumable (R5, R9) and no single transaction ever
 * holds the whole sweep's worth of state.
 *
 * Three failure paths are all VISIBLE rather than dropped:
 *
 *   - the ledger refused the transition -> reported through `onReclaimRefused`,
 *     and the reservation is counted as RETAINED rather than reclaimed;
 *   - the ledger reported success but the reservation is not in a terminal state
 *     -> retained, because claiming a reclamation that did not happen would be a
 *     lie about capacity;
 *   - the ledger reported success in a value AND did not move the reservation ->
 *     caught by the READ-BACK below, which is the only defence against a store
 *     that lies consistently (R18);
 *   - the reservation was already terminal when the sweep reached it -> not
 *     counted at all, because its units are held by nobody and were not returned
 *     by this sweep (which is what keeps R6 an equality rather than an
 *     over-count).
 */
export function recoverLeaked(ledger: SweepableLedger, request: RecoverLeakedRequest): RecoveryReport {
  const selected =
    request.reservationIds === undefined
      ? null
      : new Set(request.reservationIds)
  const reclaimed: ReclaimedReservation[] = []
  const retainedIds: ReservationId[] = []
  const reclaimedByReason = emptyReasonCounts()
  let reclaimedUnits = 0
  let retainedUnits = 0

  // `ledger.list()` is already code-unit sorted by every implementation in this
  // module; sorting again here would be redundant, and depending on that is a
  // coupling worth not having, so the ORDER of application is the ledger's and the
  // REPORT is sorted at the end (R7).
  for (const reservation of ledger.list()) {
    if (selected !== null && !selected.has(reservation.reservationId)) continue
    if (!occupiesCapacity(reservation.state)) continue

    const reason = recoveryReasonFor(reservation, request.dispatchStates, request.now)
    if (reason === null) {
      retainedIds.push(reservation.reservationId)
      retainedUnits += reservation.units
      continue
    }

    const applied =
      reason === "dispatch_terminal"
        ? ledger.release(reservation.reservationId, request.now)
        : ledger.expire(reservation.reservationId, request.now)

    if (!applied.ok) {
      request.onReclaimRefused?.(budgetRefusalSchema.parse(applied.refusal))
      retainedIds.push(reservation.reservationId)
      retainedUnits += reservation.units
      continue
    }
    const finalState = applied.value.reservation.state
    if (finalState !== "released" && finalState !== "expired") {
      retainedIds.push(reservation.reservationId)
      retainedUnits += reservation.units
      continue
    }

    // Validated through the module's own schema rather than assembled loose, so a
    // report row cannot carry a `reason`/`state` pair the rest of the module does
    // not recognise.
    reclaimed.push(
      reclaimedReservationSchema.parse({
        reservationId: reservation.reservationId,
        dispatchId: reservation.dispatchId,
        projectId: reservation.projectId,
        scope: reservation.scope,
        units: reservation.units,
        previousState: reservation.state,
        reclaimedState: finalState,
        reason,
      }),
    )
    reclaimedByReason[reason] += 1
    reclaimedUnits += reservation.units
  }

  // R18 — CONFIRM the claim against the ledger before returning it.
  //
  // Everything above trusts the store's RETURN VALUE. A store that reports
  // `{ ok: true, reservation: { state: "released" } }` and leaves the reservation
  // `held` defeats every check above at once, because the value and the state
  // agree with each other and neither agrees with the ledger. That is the
  // over-release direction of unit conservation: the report would say capacity
  // came back, the budget would then admit against the freed room, and the
  // reservation would still be sitting there holding it.
  //
  // So the sweep reads the ledger back ONCE and demotes any claim the ledger does
  // not corroborate. A demotion moves the entry from `reclaimed` to `retained`,
  // decrements its reason count, and returns its units to `retainedUnits`, so R6
  // stays an equality in the demoted case too rather than becoming an
  // over-count — which is precisely the failure the `Math.max(0, …)` clamp in
  // `withReplacedReservation` would otherwise hide.
  const unverifiedIds: ReservationId[] = []
  if (reclaimed.length > 0) {
    const observed = new Map(ledger.list().map((reservation) => [reservation.reservationId, reservation.state]))
    for (let index = reclaimed.length - 1; index >= 0; index -= 1) {
      const entry = reclaimed[index]
      if (entry === undefined) continue
      const state = observed.get(entry.reservationId)
      if (state === "released" || state === "expired") {
        // Corroborated. The ledger's own word replaces the claimed one, so a store
        // that reached `expired` when the sweep asked for `released` is reported
        // accurately rather than as what was requested.
        entry.reclaimedState = state
        continue
      }
      reclaimed.splice(index, 1)
      reclaimedByReason[entry.reason] -= 1
      reclaimedUnits -= entry.units
      retainedIds.push(entry.reservationId)
      retainedUnits += entry.units
      unverifiedIds.push(entry.reservationId)
    }
  }

  reclaimed.sort((left, right) =>
    left.reservationId < right.reservationId ? -1 : left.reservationId > right.reservationId ? 1 : 0,
  )

  return {
    reclaimed,
    retained: sortedUniqueIds(retainedIds),
    unverified: sortedUniqueIds(unverifiedIds),
    reclaimedUnits,
    retainedUnits,
    reclaimedByReason,
  }
}

// ===========================================================================
// Replay
// ===========================================================================

/**
 * One row of a durable reservation log.
 *
 * Every state is representable, and that is the load-bearing decision (R11). The
 * row records that a `reserve` TRANSACTION COMMITTED — not that the reservation
 * reached a particular state later. A log that only accepted terminal rows would
 * be unable to describe the crash between reserve and release, and the stranded
 * `held` reservation would be unrecoverable rather than merely swept: the leak
 * would be invisible to `recoverLeaked` because the sweep would have nothing to
 * look at.
 *
 * A row in state `held` is therefore NORMAL, not a defect — it is what a crash
 * looks like in a log. What would be a defect is a log with no record at all for
 * an admitted reservation, and that is the property a durable implementation of
 * `BudgetLedgerStore` has to guarantee, not something this schema can check.
 *
 * What this schema deliberately does NOT do is bound the total the rows describe.
 * A single log can contain more `held` units than any budget allows, and a
 * schema cannot see the ceiling; `replayDurableReservations` is where the ceiling
 * is applied (R12).
 */
export const durableReservationRecordSchema = budgetReservationSchema

export type DurableReservationRecord = BudgetReservation

/**
 * The state a replay installs, and the store operations it needs.
 *
 * `restore` rather than a mutation-per-row because restoring is ONE assignment:
 * a replay that appended rows one at a time would be a second implementation of
 * the ledger's write path, with its own atomicity story, and a crash midway
 * through it would leave a half-replayed ledger whose totals nobody can account
 * for.
 */
export interface ReplayTarget {
  restore(state: {
    readonly reservations: ReadonlyMap<ReservationId, BudgetReservation>
    readonly heldUnits: ReadonlyMap<string, number>
    readonly reservationIdByDispatch: ReadonlyMap<string, ReservationId>
  }): void
}

/**
 * The ceiling for one `(projectId, scope)`, as the caller resolved it.
 *
 * A RESOLVER result rather than a `BudgetLimits`, because the caller is the only
 * party that knows whether rule contributions and observations narrow the base
 * budget (`composeBudgets`), and a replay that re-resolved them would be a second
 * derivation of the budget in force at crash time — which may not be the budget in
 * force now. `budgetScopeKey` is the key, so a caller can pass a map it already
 * built for reporting.
 */
export interface ReplayCeiling {
  readonly projectId: string
  readonly scope: BudgetScope
  /** `null` means "no budget declares a maximum here", which is NOT unlimited (L8). */
  readonly ceiling: number | null
}

export interface ReplayRequest {
  /**
   * Accepted and applied to NOTHING; see the note on `replayDurableReservations`.
   */
  readonly now: string
  /** The ceilings in force for the replay. Missing entries mean `ceiling: null`. */
  readonly ceilings: readonly ReplayCeiling[]
}

/**
 * Rebuilds a ledger's state from its durable reservation log, ADMITTING only what
 * the ceiling still allows.
 *
 * # What changed, and why it had to
 *
 * This used to restore every record verbatim and argue that a verbatim replay
 * cannot over-admit, because the log "is exactly the reservations the crashed
 * process admitted and no others". That argument is wrong in the two cases that
 * matter, and both of them are the interesting ones:
 *
 *   1. **A log is not necessarily a faithful history.** A writer that re-emits
 *      rows, a log shipped twice and concatenated, a writer that minted a fresh
 *      `reservationId` on each attempt, or a log truncated at the wrong offset —
 *      all of them describe more held units than any budget allowed. Verbatim
 *      replay installs all of them.
 *   2. **The budget is not necessarily the same budget.** `ceilings` is a
 *      caller-supplied value, and a caller may have narrowed the ceiling since the
 *      crash (a rule contribution that did not exist then). Replaying against the
 *      crashed process's budget rather than the current one is how a ledger ends
 *      up holding `5` against a ceiling of `1`.
 *
 * And the consequence of over-admitting is not a bypass. With `held = 5` against a
 * `ceiling` of `1`, `reserveInTransaction` computes `5 + 1 > 1` and refuses, and
 * refuses every future reserve too. The budget is not exceeded; it is WEDGED, and
 * wedging is an availability failure wearing a safety costume: the invariant
 * `held <= ceiling` fails after a crash, which is the worst possible time for a
 * budget to stop being a budget, and the operator sees a saturated scope with no
 * saturation to show for it.
 *
 * # The policy, and why this one
 *
 * Replay sees records that were each individually valid when written. The process
 * that answered "was this allowed?" is dead, so replay cannot ask. The candidates
 * were:
 *
 *   - **(a) Refuse the whole replay** when the restored total exceeds the ceiling.
 *     Simple and obviously safe. Rejected because it is safe in the wrong
 *     direction: to "refuse" it must either install nothing (so `held = 0` and the
 *     ledger then admits `ceiling` fresh dispatches while up to `ceiling` were
 *     genuinely held at crash — an over-admission of the worst kind, silent, with
 *     a `scope_saturated` refusal nowhere in sight) or throw (so the process crash
 *     loops at startup until an operator edits the log by hand). Both are strictly
 *     worse than admitting a bounded prefix, because both make a corrupt log
 *     unrecoverable by the module that exists to recover from one.
 *   - **(b) Admit a prefix up to the ceiling and mark the rest `expired`,** in a
 *     deterministic order. Correct on the invariant and non-wedging, but it
 *     cannot tell a DUPLICATED log from a GENUINELY over-limit history, so it
 *     reports `over_ceiling` for a log that merely said the same thing twice — a
 *     report that cries wolf on the benign case and so trains an operator to
 *     ignore it on the serious one.
 *   - **(c) Admit only when the excess is EXPLAINABLE, and refuse otherwise.**
 *     This is what the code does, and it is (b) plus the distinction. A row is
 *     refused for one of three named reasons, and the reason says which kind of
 *     wrong log this is: `ceiling_undeclared` (the caller resolved no maximum for
 *     this scope, and L8 says no budget is not unlimited), `duplicate_dispatch`
 *     (two rows, one `dispatchId` — the same reservation written twice under two
 *     ids, which would otherwise make `reservationState(dispatchId)`
 *     single-valued in name only), and `over_ceiling` (the rows are all distinct
 *     dispatches and there is simply more of them than the budget permits).
 *
 * The thing that makes (c) safe rather than merely reasonable is the ORDER of the
 * checks and the fact that refusal is never total. A duplicate is refused FIRST,
 * because a duplicate consumed no capacity that the original did not already
 * consume, so refusing it is free and refusing the original would be a real loss.
 * Only then does the running admitted total get compared against the ceiling. And
 * a refusal installs the row as `expired` rather than dropping it, which means the
 * reservation is still auditable, still reachable by `read`, still present in
 * `list()` — and, crucially, still holding NOTHING, so the recovered ledger can
 * accept reserves again.
 *
 * # Named invariants
 *
 * - **R12 — `held <= ceiling` after ANY replay.** This is the property the whole
 *   fix exists to restore, stated as an equality of obligation: it must hold for
 *   every log, including logs this code has never seen, including logs a test
 *   generates. The per-scope arithmetic in `ReplayReport` is published so the
 *   property is checkable rather than asserted.
 * - **R13 — Refusal is never total.** Every row read is either installed or
 *   collapsed into a row already installed. A replay cannot lose a reservation,
 *   because losing one is how a log stops describing history at all — and a
 *   replay that loses reservations is the failure mode option (a) was rejected
 *   for.
 * - **R14 — A refusal RETURNS capacity.** Rejected rows are installed as
 *   `expired`, so `admittedUnits + rejectedUnits === occupiedUnits` per scope and
 *   a reserve against the recovered ledger is answered from the ceiling rather
 *   than from a total nobody can account for.
 * - **R15 — Replay is a FUNCTION OF THE SET OF RECORDS, not of their order.**
 *   Rows are grouped by `reservationId`, each group is reduced to a canonical
 *   row by a total order, and admission walks that reduced set in `reservationId`
 *   code-unit order. Two replays of the same rows in different orders, on
 *   different machines, in different processes, install the same reservations in
 *   the same states and produce byte-identical reports.
 * - **R16 — Replay never restamps and never invents.** `now` is applied to
 *   nothing. Timestamps are the log's. A refusal changes exactly one member —
 *   `state`, from an occupying state to `expired` — and nothing else, so
 *   `previousState` in the report is the log's word and `restoredState` is
 *   replay's.
 * - **R17 — Terminal rows are always installed.** A `released` or `expired` row
 *   occupies nothing, so it cannot breach any ceiling, so replay installs it
 *   without consulting one. A log of a hundred terminal rows against a project
 *   with no budget declared replays intact.
 * - **R19 — One dispatch, one reservation, and the FIRST row wins.** The
 *   `reservationIdByDispatch` index is written exactly once per `dispatchId`, by
 *   the first row in `reservationId` order, whatever state that row carries. Two
 *   consequences, both of which are eligibility rather than capacity: an OCCUPYING
 *   row whose dispatch is already claimed is refused as `duplicate_dispatch` (so a
 *   dispatch whose work finished cannot be made launch-eligible a second time), and
 *   a TERMINAL row does not displace a claimed dispatch (so held capacity is never
 *   stranded behind a reservation the index says is finished). A correct writer
 *   produces neither shape — the store keeps a dispatch's first reservation for
 *   ever — so both are refusals of corrupt logs rather than of legitimate ones.
 *
 * # What replay still does not do
 *
 * It does not ask whether a record was *allowed* when written. It cannot: that
 * judgement lives in a process that no longer exists. Everything here is about
 * making the RECONSTRUCTED state defensible, which is a strictly weaker claim
 * than "the log is faithful" and is the only claim a restarted process can
 * honestly make.
 */
export function replayDurableReservations(
  target: ReplayTarget,
  records: readonly BudgetReservation[],
  request: ReplayRequest,
): ReplayReport {
  void request.now
  const ceilingByKey = new Map<string, number | null>()
  for (const entry of request.ceilings) {
    if (!Number.isSafeInteger(entry.ceiling ?? 0) || (entry.ceiling ?? 0) < 0) {
      throw new RangeError(
        `replayDurableReservations was given a non-integer or negative ceiling for '${entry.projectId}'/'${entry.scope}': ${String(entry.ceiling)}. A ceiling is either a non-negative safe integer or null for "no budget declares one", and replay will not guess which.`,
      )
    }
    ceilingByKey.set(budgetScopeKey(entry.projectId, entry.scope), entry.ceiling)
  }

  // R15: reduce the rows to one canonical row per reservation id FIRST, so that
  // admission never depends on the order the caller happened to read the log in.
  const rowsById = new Map<ReservationId, BudgetReservation>()
  const duplicatedIds = new Set<ReservationId>()
  for (const record of records) {
    const parsed = durableReservationRecordSchema.parse(record)
    const existing = rowsById.get(parsed.reservationId)
    if (existing === undefined) {
      rowsById.set(parsed.reservationId, parsed)
      continue
    }
    duplicatedIds.add(parsed.reservationId)
    if (compareRecords(existing, parsed) < 0) rowsById.set(parsed.reservationId, parsed)
  }

  const ordered = [...rowsById.values()].sort((left, right) =>
    left.reservationId < right.reservationId ? -1 : left.reservationId > right.reservationId ? 1 : 0,
  )

  const reservations = new Map<ReservationId, BudgetReservation>()
  const reservationIdByDispatch = new Map<string, ReservationId>()
  // Every dispatch the walk has already SEEN, not merely every dispatch it admitted.
  // The difference is a dispatch whose FIRST row (in `reservationId` order) is
  // terminal and whose second row occupies: that is not a reservation written twice,
  // it is a dispatch whose work FINISHED and then got a second reservation — which a
  // correct writer cannot produce, because `reservationIdByDispatch` keeps the
  // dispatch's first reservation for ever and a second `reserve` for it is refused
  // with `budget.dispatch_already_reserved`. Admitting the occupying row would make
  // an already-finished dispatch launch-eligible a second time, which is an
  // eligibility bypass that the ceiling check alone does not catch.
  const claimedDispatchByRow = new Map<string, ReservationId>()
  const rejected: ReplayRejection[] = []
  const occupied = new Map<string, number>()
  const admitted = new Map<string, number>()
  const rejectedUnits = new Map<string, number>()
  const scopeMeta = new Map<string, { readonly projectId: string; readonly scope: BudgetScope }>()
  const rejectedByReason = emptyRejectionCounts()

  for (const row of ordered) {
    const key = budgetScopeKey(row.projectId, row.scope)
    scopeMeta.set(key, { projectId: row.projectId, scope: row.scope })
    // The FIRST row for a dispatch, in `reservationId` code-unit order, is the one
    // that speaks for it — whatever state it carries. Recorded here rather than at
    // the point of admission, so the index can never name a DIFFERENT reservation for
    // a dispatch than the one the walk treated as first.
    const claimingDispatch = !claimedDispatchByRow.has(row.dispatchId)
    if (claimingDispatch) claimedDispatchByRow.set(row.dispatchId, row.reservationId)

    if (!occupiesCapacity(row.state)) {
      // R17. Installed as-is: a terminal row cannot breach a ceiling, and it must
      // not be refused for want of one. It does NOT displace the dispatch's first
      // row in the index, so a log holding both a released and a held row for one
      // dispatch cannot demote the held one out of `reservationState(dispatchId)`
      // and strand the capacity it is still counted as holding.
      reservations.set(row.reservationId, row)
      if (claimingDispatch) reservationIdByDispatch.set(row.dispatchId, row.reservationId)
      continue
    }

    occupied.set(key, (occupied.get(key) ?? 0) + row.units)
    const ceiling = ceilingByKey.get(key) ?? null
    const admittedHere = admitted.get(key) ?? 0

    // A duplicate is checked BEFORE the ceiling, deliberately. Two rows for one
    // `dispatchId` are one dispatch stated twice, so the second row's units were
    // never capacity the first did not already hold; refusing the second is free,
    // whereas refusing the first would discard a real reservation. And this is the
    // check that catches the terminal-then-occupying pair, because it fires on the
    // FIRST SEEN dispatch rather than on the first ADMITTED one.
    const duplicateOf = !claimingDispatch
    const overCeiling = ceiling !== null && admittedHere + row.units > ceiling
    const undeclared = ceiling === null

    if (!duplicateOf && !overCeiling && !undeclared) {
      admitted.set(key, admittedHere + row.units)
      reservations.set(row.reservationId, row)
      reservationIdByDispatch.set(row.dispatchId, row.reservationId)
      continue
    }

    const reason: ReplayRejectionReason = duplicateOf
      ? "duplicate_dispatch"
      : undeclared
        ? "ceiling_undeclared"
        : "over_ceiling"
    rejectedUnits.set(key, (rejectedUnits.get(key) ?? 0) + row.units)
    rejectedByReason[reason] += 1

    // R16: `state` is the ONLY member replay changes. `expired` is chosen over
    // `released` because `released` asserts a terminal dispatch state, which is a
    // fact replay has no evidence for, and `expired` asserts only that this
    // reservation is not holding capacity — which is exactly true.
    const installed = budgetReservationSchema.parse({ ...row, state: "expired" as const })
    reservations.set(row.reservationId, installed)
    // The index keeps the FIRST row for a dispatch in `reservationId` order (R19).
    // A refused row claims its dispatch ONLY if it was the first one, and a refusal
    // that claims it still leaves the dispatch ineligible — which is the correct
    // answer, because nothing was admitted for it. A refused LATER row must not
    // displace the claim, or `reservationState(dispatchId)` would name a
    // reservation holding nothing.
    if (claimingDispatch) reservationIdByDispatch.set(row.dispatchId, row.reservationId)

    rejected.push(
      replayRejectionSchema.parse({
        reservationId: row.reservationId,
        dispatchId: row.dispatchId,
        projectId: row.projectId,
        scope: row.scope,
        units: row.units,
        previousState: row.state as OccupyingReservationState,
        restoredState: "expired",
        reason,
        ceiling,
        admittedUnits: admittedHere,
        detail: detailFor(reason, row, ceiling, admittedHere),
      }),
    )
  }

  rejected.sort((left, right) =>
    left.reservationId < right.reservationId ? -1 : left.reservationId > right.reservationId ? 1 : 0,
  )

  const scopes: ReplayScopeTotal[] = [...scopeMeta.keys()]
    .sort()
    .map((key) => {
      const meta = scopeMeta.get(key)!
      return replayScopeTotalSchema.parse({
        projectId: meta.projectId,
        scope: meta.scope,
        ceiling: ceilingByKey.get(key) ?? null,
        occupiedUnits: occupied.get(key) ?? 0,
        admittedUnits: admitted.get(key) ?? 0,
        rejectedUnits: rejectedUnits.get(key) ?? 0,
      })
    })

  target.restore({
    reservations,
    heldUnits: occupiedUnitsFrom(reservations.values()),
    reservationIdByDispatch,
  })

  return {
    restored: sortedUniqueIds(reservations.keys()),
    rejected,
    collapsed: sortedUniqueIds(duplicatedIds),
    collapsedRecords: records.length - reservations.size,
    recordCount: records.length,
    scopes,
    rejectedByReason,
  }
}

/**
 * A TOTAL order over reservation rows, used only to pick a canonical row when a
 * log states the same `reservationId` more than once with differing content.
 *
 * The first key is `updatedAt`, so the winner is the LATEST word the log has on
 * that reservation — a durable log is append-only in intent, and the last row
 * about a reservation supersedes the earlier ones. The remaining keys exist only
 * to make the order TOTAL, because `reservationId` alone does not separate two
 * rows that share it, and a comparator that can return `0` for two different rows
 * would reintroduce input-order dependence (R15).
 *
 * `state` compares by code unit rather than by any severity order, because
 * severity is not a property of a log row: choosing the more-occupying of two
 * conflicting rows would be a second admission decision made by string
 * comparison, which is exactly the kind of decision R12 exists to bound.
 */
function compareRecords(left: BudgetReservation, right: BudgetReservation): number {
  const strings: readonly (readonly [string, string])[] = [
    [left.updatedAt, right.updatedAt],
    [left.state, right.state],
    [left.leaseExpiresAt, right.leaseExpiresAt],
    [left.createdAt, right.createdAt],
    [left.projectId, right.projectId],
    [left.runId, right.runId],
    [left.taskId, right.taskId],
    [left.dispatchId, right.dispatchId],
    [left.scope, right.scope],
  ]
  for (const [a, b] of strings) {
    if (a < b) return -1
    if (a > b) return 1
  }
  if (left.units !== right.units) return left.units < right.units ? -1 : 1
  return 0
}

/**
 * The sentence a reader gets instead of a code. Carries the numbers, because a
 * rejection an operator cannot check against the budget is a rejection they have
 * to take on faith — which is the position this whole fix exists to move away
 * from.
 */
function detailFor(
  reason: ReplayRejectionReason,
  row: BudgetReservation,
  ceiling: number | null,
  admittedUnits: number,
): string {
  const where = `'${row.projectId}'/'${row.scope}'`
  if (reason === "duplicate_dispatch") {
    return `replay.duplicate_dispatch: '${row.reservationId}' is a second '${row.state}' row for dispatch '${row.dispatchId}', which already holds a reservation; two rows for one dispatch would make that dispatch's reservation state ambiguous, so the later row is installed as 'expired' and its ${row.units} unit(s) are returned to ${where}`
  }
  if (reason === "ceiling_undeclared") {
    return `replay.ceiling_undeclared: '${row.reservationId}' occupies ${row.units} unit(s) of ${where} and no ceiling was declared for it; 'no budget' is not 'unlimited budget', so the reservation is installed as 'expired' and its units are returned`
  }
  return `replay.over_ceiling: ${where} admits a ceiling of ${String(ceiling)}, ${admittedUnits} unit(s) are already admitted from this log, and '${row.reservationId}' asks for ${row.units} more, which would reach ${admittedUnits + row.units}; the reservation is installed as 'expired' and its units are returned, so the recovered ledger can still accept reserves`
}

/**
 * Sums units per `(projectId, scope)` over the OCCUPYING reservations.
 *
 * Shared with nothing else on purpose — `InMemoryBudgetLedgerStore` has its own
 * copy because it sums from a live state object under a critical section and this
 * one runs over an argument — but the two are asserted equal by the tests, so a
 * divergence fails rather than accumulating.
 */
function occupiedUnitsFrom(reservations: Iterable<BudgetReservation>): ReadonlyMap<string, number> {
  const heldUnits = new Map<string, number>()
  for (const reservation of reservations) {
    if (!occupiesCapacity(reservation.state)) continue
    const key = budgetScopeKey(reservation.projectId, reservation.scope)
    heldUnits.set(key, (heldUnits.get(key) ?? 0) + reservation.units)
  }
  return heldUnits
}

/**
 * The scopes a project can hold units in, as a frozen list.
 *
 * Re-exported from the types module rather than restated, so the sweep's notion
 * of "a scope" cannot drift from the ledger's. Present here because a caller
 * building a report wants to iterate scopes in a defined order and this module is
 * the one place recovery-shaped ordering lives.
 */
export const RECOVERY_SCOPES: readonly BudgetScope[] = BUDGET_SCOPES

/**
 * A `ReservationState` narrowed to the occupying states, or `null`.
 *
 * Exported because a caller assembling a recovery report needs to say "this
 * reservation is still holding capacity" in one expression, and writing
 * `state === "held" || state === "committed"` at a call site is how the two
 * lists drift apart (types.ts I2).
 */
export function occupyingStateOf(reservation: BudgetReservation): ReservationState | null {
  return occupiesCapacity(reservation.state) ? reservation.state : null
}

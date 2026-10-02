/**
 * The M6.5 budget and admission-control barrel.
 *
 * # What this milestone's surface is FOR
 *
 * Two questions, answered once each and never re-answered anywhere else:
 *
 *   1. **What is the budget in force, and can this run enforce it?**
 *      `composeBudgets` (pure, `./compose.js`).
 *   2. **May this dispatch launch?** *It holds a reservation that is `held`.*
 *      `BudgetLedger` (transactional, `./ledger.js`). This is a DEFINITION
 *      rather than a check — see the module docblock in `./ledger.ts`, which
 *      argues in full why the reservation and the capacity decision are one
 *      synchronous frame.
 *
 * The third member, `recoverLeaked` (`./recovery.js`), exists because a crash
 * between reserve and release is the case where a reservation either leaks
 * capacity forever or is reclaimed too eagerly. Both failure modes are prevented
 * by requiring EVIDENCE — a terminal dispatch or a passed lease — rather than a
 * heuristic. `replayDurableReservations` is the other half of the same problem:
 * a sweep can only reclaim what it can see, so the state has to be rebuilt first,
 * and rebuilding it is itself an admission decision — which is why it is handed the
 * ceilings rather than given none.
 *
 * # The dependency edges this module is allowed
 *
 * `budgets -> orchestration` and nothing else. Specifically:
 *
 *   - It reads `src/orchestration/identifiers.ts` for the branded identifier and
 *     timestamp schemas, and `SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS` from
 *     `src/orchestration/policy/types.ts` so a budget can never authorise a run
 *     longer than the safety floor permits.
 *   - It reads `isDispatchTerminal` from `src/orchestration/transitions.ts`, so
 *     "this dispatch finished" means the kernel's meaning of it and not this
 *     module's.
 *   - It does NOT import `src/rules`. Rule contributions cross the boundary
 *     STRUCTURALLY, through `BudgetContribution` (`./types.ts` C7): a budget is an
 *     INPUT to rule evaluation, so an edge from budgets to rules would invert the
 *     narrowing direction, and a budget module that knew what a rule was would be
 *     one edit away from being a second rule evaluator.
 *   - It does NOT import `src/routing`, `src/workflows`, `src/context`,
 *     `src/memory`, `src/mesh`, or anything that owns persistence.
 *     `tests/unit/budgets/barrel.test.ts` asserts all of this by source scan,
 *     because an import cycle is exactly the thing a type checker accepts happily.
 *
 * # Persistence is deliberately absent
 *
 * There is no SQLite table, no migration, and no file format here, and the reason
 * is recorded at length on `InMemoryBudgetLedgerStore` in `./ledger.ts`: budget
 * state is DERIVED from dispatch state, so a durable ledger would need a record
 * version for a subsystem whose recovery story is "ask the dispatcher what
 * happened", before there is a consumer that survives a restart. The store
 * interface is the seam and the seam is narrow.
 *
 * # What M6.7 (dry run) should import from here
 *
 *     composeBudgets, composeBudgetsOrRefuse, admitUsage,   // decisions, pure
 *     BudgetLedger, InMemoryBudgetLedgerStore,               // the gate
 *     recoverLeaked, replayDurableReservations,              // recovery
 *     budgetLimitsSchema, budgetDecisionSchema, budgetReservationSchema,
 *     NO_BUDGET_OBSERVATION, reportedUsageObservation,
 *     BudgetLedgerStore, LedgerState, RecoveryReport, ReplayReport,
 *     BudgetComposition, BudgetDecision, BudgetLimits, BudgetRefusalCode,
 *     BudgetReservation
 *
 * A dry run must not reserve anything, so it takes `composeBudgets` and
 * `admitUsage` for the DECISION and a `BudgetLedgerStore` FAKE for the gate: ADR
 * 0007 section 16 requires the simulator to be the same planners with every sink
 * replaced by a fail-closed fake, and the store is the sink that matters here.
 * `BudgetLedgerStore` is exported for exactly that reason.
 *
 * # The one signature here that is not "pass a value in, get a value out"
 *
 * `replayDurableReservations(target, records, request)` takes a CEILING, because
 * replay is a second admission decision and an admission decision with no limit to
 * consult is the bug this milestone's security review found: a durable log restored
 * verbatim installed `held: 5` against a ceiling of `1`, and the resulting ledger
 * refused every subsequent reserve for a total nothing could account for. A caller
 * that recovers a ledger therefore has to resolve the ceilings — from the same
 * `composeBudgets` path `BudgetLedger.reserve` uses, not from a restated number — and
 * hand them in. What replay will NOT do is resolve them itself: the budget in force
 * at crash time is not necessarily the budget in force now, and a replay that
 * re-derived the first from the second would be guessing. See the R12-R17 block on
 * `replayDurableReservations` in `./recovery.js` for the policy and the argument
 * against the two alternatives.
 *
 * # Re-export order
 *
 * Pipeline order, not alphabetical: types, then the composition algebra, then the
 * ledger, then recovery. A reader follows the data as it flows, and a name
 * collision introduced later shows up against the pipeline rather than the
 * alphabet.
 */

export * from "./types.js"
export * from "./compose.js"
export * from "./ledger.js"
export * from "./recovery.js"

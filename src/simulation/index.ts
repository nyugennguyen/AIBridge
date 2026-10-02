/**
 * The M6.7 dry-run barrel.
 *
 * # What this module is FOR
 *
 * One question, answered without performing anything: **what would this run do,
 * and what would stop it?** ADR 0007 section 16's answer, and the milestone's
 * structural claim, which is the order of the re-exports below:
 *
 *   1. `types.js` — the shapes, the closed refusal and warning vocabularies, and
 *      the request schema. A caller composes a request here.
 *   2. `sinks.js` — the fail-closed command sinks. A caller wires the budget
 *      probe here, and nothing else, because nothing else is reachable.
 *   3. `expand.js` — template expansion, through the production expander.
 *   4. `plan.js` — the composer, `simulateDryRun`, the plan interface and its
 *      digest function.
 *
 * # The two properties this barrel is asserting
 *
 * **Reachability.** The repo's convention is that callers import through a module's
 * barrel, and this file earns the convention for the same reason
 * `src/rules/index.ts` does: a caller who deep-imports `./plan.js` still gets the
 * shipped surface, but every test in `tests/unit/simulation/` goes through here, so
 * the surface that is exercised is the surface that exists.
 *
 * **Direction.** ADR 0007 section 1 gives this module the edges `rules, workflows,
 * budgets, routing, orchestration, context` and nothing else, and says that nothing
 * under `src/orchestration/` may import any of the six M6 modules.
 * `tests/unit/simulation/barrel.test.ts` asserts that by source scan, because an
 * import cycle is exactly what a type checker will happily accept — and here the
 * cycle that mattered most would be a `dryRun` flag reaching backwards into
 * production code.
 *
 * # What M6.8 (TUI) and the integration tests import from here
 *
 * `simulateDryRun`, `DryRunPlan`, `computeDryRunPlanDigest`, `dryRunPlanDigestInput`,
 * `createFailClosedSinks`, `emptySinkTally`, `readSinkCounters`,
 * `assertNoRetainedSideEffects`, `createBudgetLedgerProbe`, `SimulationPorts`,
 * `SimulationRequest`, `SimulationResult`, `SimulationRefusal`, `SimulationRefusalCode`,
 * `SIMULATION_REFUSALS`, `SimulationWarning`, `SimulationWarningKind`,
 * `SIMULATION_WARNING_KINDS`, `simulationWarning`, `simulationRefuse`,
 * `SimulationSideEffectError`, `SIMULATION_SINK_NAMES`, `expandRunTemplate`,
 * `derivedTaskId`, `derivedDispatchId`, and every `simulated*` schema and type.
 */

export * from "./types.js"
export * from "./sinks.js"
export * from "./expand.js"
export * from "./plan.js"

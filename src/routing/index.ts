/**
 * The M6.6 routing barrel.
 *
 * The repo convention is that callers import through a module's barrel rather than
 * by deep path, and this file earns that convention three times over:
 *
 *   1. REACHABILITY. `buildRoutingSnapshot` and `rankNodes` are the only two ways
 *      to produce a snapshot and the only way to produce an answer. A deep import
 *      of `./rank.js` can still be written, but every test in
 *      `tests/unit/routing/` goes through here, so the shipped surface is the
 *      exercised one.
 *   2. DIRECTION. ADR 0007 section 1 gives `routing` exactly two downward edges:
 *      `orchestration` and `mesh/registry`. Nothing else. In particular routing
 *      does NOT import `src/rules` — the unioned preference crosses the boundary
 *      by STRUCTURE (`RoutingPreference` is shape-compatible with
 *      `RuleRoutingComposition`), because an edge to `rules` from routing would put
 *      the rule language underneath the thing that ranks nodes, and the rule
 *      language is the layer whose narrowing is supposed to reach routing as
 *      input, not the other way round.
 *      `tests/unit/routing/barrel.test.ts` asserts the direction by source scan,
 *      because an import cycle is exactly what a type checker will happily accept.
 *   3. NO STORE. Routing is an adapter over a registry, not a registry owner. No
 *      module here imports `src/mesh/registry/migrations.ts`, `sqlite-registry.ts`,
 *      `memory-registry.ts`, or anything else that owns persistence, and the same
 *      test asserts it.
 *
 * Re-export order is PIPELINE order, not alphabetical: types, then the adapter,
 * then the ranker. A reader follows the data as it flows, and a name collision
 * introduced later shows up against the pipeline rather than the alphabet.
 */

export * from "./types.js"
export * from "./snapshot.js"
export * from "./rank.js"

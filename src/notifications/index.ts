/**
 * The M6.9 notification barrel.
 *
 * The repo's convention is that callers import through a module's barrel rather than
 * by deep path, and this file earns that convention twice over.
 *
 * 1. REACHABILITY. A module reachable only by deep path is a module nobody wired up,
 *    and the tests that use it prove nothing about the shipped surface. Every test in
 *    `tests/unit/notifications/` goes through here.
 * 2. DIRECTION. ADR 0007 section 1 declares `notifications -> (no orchestration,
 *    mesh, memory, or runtime imports)`, and section 17 restates it as the mechanism
 *    that makes "delivery never affects orchestration state" true rather than
 *    aspirational. `tests/unit/notifications/barrel.test.ts` asserts the edge by
 *    SOURCE SCAN, because an import cycle is exactly what a type checker will happily
 *    accept, and a notification subsystem that could reach the kernel would be a
 *    second control path.
 *
 * RE-EXPORT ORDER IS MODULE ORDER, NOT ALPHABETICAL, and deliberately so: types (the
 * payload contract and its audit), then store (the inbox and the quieting rule), then
 * bus (the one entry point), then the TUI adapter (the only implementation of the
 * adapter interface). That is the order a notification moves through this module: it
 * is declared, stored, emitted, and rendered. A reader arriving here can follow the
 * pipeline in the order the data flows, and a name collision introduced later would
 * be visible against the pipeline rather than against the alphabet.
 *
 * WHAT IS DELIBERATELY NOT RE-EXPORTED: anything from `src/tui/`. The notice shape
 * this module produces is `string | null`, which is structurally
 * `TuiUiState.notice`, and the M6.8 integration is an import in `src/tui/` of
 * `src/notifications/` — the correct direction. Re-exporting a TUI type here would
 * make the dependency edge point the wrong way and would be a cycle the moment the
 * shell imported this barrel. See `tui-adapter.ts` S4.
 */

export * from "./types.js"
export * from "./store.js"
export * from "./bus.js"
export * from "./tui-adapter.js"

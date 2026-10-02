/**
 * The M6 run-template barrel.
 *
 * WHY A BARREL, TWICE OVER.
 *
 *   1. REACHABILITY. A module reachable only by deep path is a module nobody
 *      wired up, and the tests that use it prove nothing about the shipped
 *      surface. `tests/unit/workflows/` imports through here, and
 *      `tests/unit/workflows/barrel.test.ts` asserts that everything below is
 *      reachable from here.
 *   2. DIRECTION. ADR 0007 section 1 declares `workflows -> rules,
 *      orchestration`, and states that "nothing under `src/orchestration/` may
 *      import from any of the six". An import cycle is exactly what a type
 *      checker will happily accept, so `barrel.test.ts` asserts the edges by
 *      SOURCE SCAN over the real `from "..."` statements.
 *
 * RE-EXPORT ORDER IS MODULE ORDER, NOT ALPHABETICAL, and deliberately so:
 * types (the document and its refusals), then repository (the versioned store),
 * then instantiate (the one entry point that makes a snapshot). A reader
 * arriving at this file follows the pipeline in the order the data flows, and a
 * name collision introduced later shows up against the pipeline rather than
 * against the alphabet.
 *
 * THE KERNEL NAMES RE-EXPORTED AT THE BOTTOM. A caller of this module composes
 * with the safety floor, with the digest helpers, and with the scheduler's cycle
 * vocabulary, and it must be able to name those without a second import path. They
 * are re-exported rather than restated so this module never becomes a second
 * owner of a value the kernel owns.
 *
 * WHAT IS DELIBERATELY NOT RE-EXPORTED: anything from `src/rules/`. A template
 * refers to a rule set by DIGEST, never by document, and re-exporting the rule
 * compiler here would invite a caller to build a `CompiledRuleSet` through the
 * template barrel and would make the two modules' barrels ambiguous to star
 * import. A caller that has a rule set imports it from `src/rules/index.js`.
 */

export * from "./types.js"
export * from "./repository.js"
export * from "./instantiate.js"

// Kernel values this module composes with, re-exported so a caller needs one
// import path and so this module is never mistaken for their owner.
export { SAFETY_FLOOR } from "../orchestration/policy/floor.js"
export { SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS, safetyFloorSchema } from "../orchestration/policy/types.js"
export { actorSchema } from "../orchestration/schemas.js"
export { projectPathIdSchema } from "../orchestration/identifiers.js"
export { canonicalJson, digestJson } from "../orchestration/digest.js"
export { DanglingDependencyError, DependencyCycleError } from "../orchestration/scheduler/types.js"
export type { CycleType } from "../orchestration/scheduler/types.js"
export type { PermissionNarrowing, SafetyFloor } from "../orchestration/policy/types.js"
export type { ContractError, ErrorCategory, Result } from "../orchestration/errors.js"
export type { ProjectPathId } from "../orchestration/identifiers.js"

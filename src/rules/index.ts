/**
 * The M6 rule language barrel.
 *
 * The repo's convention is that callers import through a module's barrel rather
 * than by deep path, and this file earns that convention twice over:
 *
 *   1. REACHABILITY. `compileRuleSet` and `evaluateRules` are the ONLY two ways
 *      to produce and consume a compiled rule set. A caller that deep-imports
 *      `compile.js` directly can still do so, but every test in
 *      `tests/unit/rules/` goes through here, so the shipped surface is the one
 *      that is exercised.
 *
 *   2. DIRECTION. The dependency edges of this module are declared by ADR 0007
 *      section 1: `rules -> orchestration, mesh/protocol/safe-pattern,
 *      memory/ontology`, and nothing else. `tests/unit/rules/barrel.test.ts`
 *      asserts that by source scan, because an import cycle is exactly what a
 *      type checker will happily accept.
 *
 * The re-export order below is the MODULE order, not alphabetical, and it is
 * deliberate: limits, then schemas, then compile, then evaluate, then explain, then
 * preview — which is the order a rule moves through this module, since preview
 * consumes the compiled artifact and the evaluator and adds nothing to either.
 * A reader arriving at this file can follow the pipeline in the order the data
 * flows, and a name collision introduced later would be visible against the
 * pipeline rather than against the alphabet.
 *
 * The barrel also re-exports the kernel types an M6 caller legitimately needs —
 * the M0 `Rule` a compiled rule projects into, and the M0 `PolicyEvaluation` the
 * kernel returns when asked to decide. A caller of this module must be able to
 * name those types without a second import path, and re-exporting them here
 * rather than making every caller reach into `src/orchestration/` is what keeps
 * the M6 surface one surface.
 */

export * from "./limits.js"
export * from "./types.js"
export * from "./compile.js"
export * from "./evaluate.js"
export * from "./explain.js"
export * from "./preview.js"

// Re-exported so a caller of the M6 surface can name the M0 shapes it composes
// with, without a second import path and without this module claiming to own
// them.
export { SAFETY_FLOOR, SAFETY_FLOOR_NARROWING, narrowPolicyState, seedPolicyState } from "../orchestration/policy/floor.js"
export { SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS } from "../orchestration/policy/types.js"
export { evaluatePolicy, renderPolicyExplanation } from "../orchestration/policy/evaluate.js"
export { ruleSchema, dispatchEnvelopeSchema } from "../orchestration/schemas.js"
export { compileSafePattern, matchesBounded, MAX_BOUNDED_NESTING_DEPTH } from "../mesh/protocol/safe-pattern.js"
export { SENSITIVITY_LEVELS, SENSITIVITY_RANK, isRenderable, mayReadSensitivity, sensitivitySchema } from "../memory/ontology.js"
export type { Rule, DispatchEnvelope } from "../orchestration/types.js"
export type {
  EffectivePolicyState,
  NarrowingOutcome,
  PermissionNarrowing,
  PolicyDecision,
  PolicyDenial,
  PolicyEvaluation,
  PolicyEvaluationInput,
  PolicyExplanationNode,
  ProjectPolicy,
} from "../orchestration/policy/types.js"
export type { Result, ContractError } from "../orchestration/errors.js"
export type { Digest, ProjectId, RoleId, RuleId, Timestamp } from "../orchestration/identifiers.js"
export type { Sensitivity } from "../memory/ontology.js"
export type { SafePattern } from "../mesh/protocol/safe-pattern.js"

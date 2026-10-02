/**
 * M6 rule-language complexity limits (ADR 0007 section 9).
 *
 * WHY this file exists separately from the schemas and the compiler: the ADR
 * states that "a limit that only exists inside a handler is a limit nobody can
 * assert", and the same reasoning is already recorded at
 * `src/mesh/protocol/bounds.ts`. Every value below is a named export, every
 * value below is APPLIED by `compileRule` / `compileRuleSet` / the explanation
 * renderer, and `tests/unit/rules/limits.test.ts` crosses each one by exactly
 * one and asserts the refusal — plus asserts that the value at the boundary is
 * ACCEPTED, because a limit that rejects its own boundary is a different limit
 * from the one documented here.
 *
 * WHERE each limit is applied, so the table can be audited:
 *
 *   limit                                    applied by
 *   ---------------------------------------  ----------------------------------
 *   MAX_PREDICATES_PER_RULE                   compile.ts (compiler limit pass)
 *   MAX_PREDICATE_DEPTH                       compile.ts (compiler limit pass)
 *   MAX_COMBINATOR_NODES_PER_RULE             compile.ts (compiler limit pass)
 *   MAX_RULES_PER_SET                         compile.ts (compileRuleSet)
 *   MAX_ACTIONS_PER_RULE                      compile.ts (compiler limit pass)
 *   MAX_ENUMERATED_MEMBERS                    compile.ts (compiler limit pass)
 *   MAX_LABEL_MEMBERS                         compile.ts (compiler limit pass)
 *   MAX_SCHEDULE_WINDOWS_PER_RULE             compile.ts (compiler limit pass)
 *   MAX_RULE_PATTERN_LENGTH                   compile.ts via compileSafePattern
 *   MAX_RULE_PATTERN_NESTING_DEPTH            compile.ts via compileSafePattern
 *   MAX_RULE_NAME_LENGTH                      types.ts (schema: string domain)
 *   MAX_RULE_REASON_LENGTH                    types.ts (schema: string domain)
 *   MAX_RULE_NOTE_LENGTH                      types.ts (schema: string domain)
 *   MAX_COMPILED_RULE_SET_CANONICAL_BYTES     compile.ts (compileRuleSet)
 *   MAX_EXPLANATION_TEXT_CHARS                explain.ts (renderRuleExplanation)
 *   MAX_FAN_OUT                               types.ts (schema: value domain)
 *   MAX_CONCURRENCY                           types.ts (schema: value domain)
 *   MAX_RETRY_LIMIT                           types.ts (schema: value domain)
 *   MAX_RULE_EXPIRY_DAYS                      compile.ts (compiler limit pass)
 *
 * Two of the rows are DOMAIN limits (a number that is not a legal fan-out) and
 * are therefore enforced by the value schema rather than by a compiler pass; the
 * compiler still refuses them, but with `rule.invalid_source` rather than
 * `rule.limit_exceeded`, because the value is out of the language's domain
 * rather than over a complexity budget. Every other row is a COMPLEXITY or
 * FORMAT limit and carries `rule.limit_exceeded`.
 *
 * Two rows are REUSED rather than re-decided, and the reuse is asserted rather
 * than trusted: `MAX_RULE_PATTERN_LENGTH` is the mesh protocol's own bound and
 * `MAX_RULE_PATTERN_NESTING_DEPTH` is `MAX_BOUNDED_NESTING_DEPTH`. If either
 * upstream value moved, `limits.test.ts` fails instead of the two silently
 * becoming different numbers.
 */

import { MAX_ENVELOPE_BYTES, MAX_RULE_PATTERN_LENGTH as MESH_MAX_RULE_PATTERN_LENGTH } from "../mesh/protocol/bounds.js"
import { MAX_BOUNDED_NESTING_DEPTH } from "../mesh/protocol/safe-pattern.js"

/**
 * Surface predicates in one rule's top-level `predicates` array.
 *
 * A rule a person cannot read on one screen is a rule nobody audits, and the
 * disclosure that has to justify a pre-approval renders exactly this list.
 */
export const MAX_PREDICATES_PER_RULE = 64

/**
 * Maximum nesting depth of the predicate AST, counting a top-level predicate as
 * depth 1. Bounds recursion; deep trees are for encoding, not for matching.
 */
export const MAX_PREDICATE_DEPTH = 6

/**
 * Total number of predicate nodes in one rule, including the top-level ones.
 *
 * Bounded independently of `MAX_PREDICATES_PER_RULE` because the two bound
 * different costs: the first bounds how much a human reads, the second bounds
 * what a traversal visits. A rule with 8 top-level `any` combinators over 32
 * leaves each is 264 nodes and is refused by this limit while staying well
 * inside the surface limit.
 */
export const MAX_COMBINATOR_NODES_PER_RULE = 256

/** Rules in one compiled set. Bounds compile and evaluation time linearly. */
export const MAX_RULES_PER_SET = 512

/**
 * Actions in one rule. Actions compose into four different subsystems
 * (policy, budgets, routing, disclosure), so an unbounded action list is an
 * unbounded cross-subsystem composition problem.
 */
export const MAX_ACTIONS_PER_RULE = 16

/**
 * Members in any enumerated set: `in`, `any`, `all`, `none`, `approvedCapabilities`,
 * `deniedCapabilities`, `allowedCapabilities`, `preferredNodeIds`, and so on.
 */
export const MAX_ENUMERATED_MEMBERS = 64

/**
 * Members in a `taskLabel` set. Labels are free-form, so they would otherwise
 * dominate the enumerated-member bound and make it meaningless.
 */
export const MAX_LABEL_MEMBERS = 32

/** Schedule windows in one `scheduleWindow` predicate. */
export const MAX_SCHEDULE_WINDOWS_PER_RULE = 8

/**
 * Pattern source length. Reused from `src/mesh/protocol/bounds.ts:35`; the M6
 * compiler does not re-derive a length bound, it hands the source to
 * `compileSafePattern`, which is the only pattern compiler in the system.
 */
export const MAX_RULE_PATTERN_LENGTH: number = MESH_MAX_RULE_PATTERN_LENGTH

/**
 * Bounded quantifier nesting depth accepted in a rule pattern. Reused from
 * `MAX_BOUNDED_NESTING_DEPTH` (`src/mesh/protocol/safe-pattern.ts:410`); the
 * M6 compiler does not re-derive a nesting analysis either.
 */
export const MAX_RULE_PATTERN_NESTING_DEPTH: number = MAX_BOUNDED_NESTING_DEPTH

/** Rule name length. Matches `shortTextSchema` elsewhere in the kernel. */
export const MAX_RULE_NAME_LENGTH = 256

/**
 * Reason and description length. A reason must fit an audit view; this is the
 * kernel's own `TEXT_MAX` (`src/orchestration/policy/types.ts:26`) under a name
 * that says what it bounds in this module.
 */
export const MAX_RULE_REASON_LENGTH = 4_096

/**
 * Predicate note length. Notes are annotations for a human reader, are never
 * evaluated, and are deliberately excluded from `normalizedPredicate` and from
 * the compiled rule's digest so that editing a comment cannot invalidate an
 * approval. See ADR 0007 section 6.
 */
export const MAX_RULE_NOTE_LENGTH = 512

/**
 * Canonical byte length of one compiled rule set.
 *
 * Measured against CANONICAL JSON, not against one serializer's framing, for
 * the reason recorded at `src/mesh/protocol/bounds.ts:11-15`: a limit defined
 * against one encoding is a limit the next encoding silently evades, and
 * canonical bytes are exactly what the set digest covers. Reuses
 * `MAX_ENVELOPE_BYTES` so the size the limit is checked against and the size
 * the digest covers are the same size.
 */
export const MAX_COMPILED_RULE_SET_CANONICAL_BYTES: number = MAX_ENVELOPE_BYTES

/**
 * Rendered explanation length, in characters.
 *
 * The one limit in the table measured in characters rather than bytes: it
 * bounds a RENDERED string, and the reader of that string is a screen, not a
 * digest. Reuses the kernel's own bound on `policyEvaluation.explanationText`
 * (`src/orchestration/policy/types.ts:254`); `limits.test.ts` asserts the two
 * are the same number by probing the kernel schema rather than trusting the
 * comment. The citation above was off by one for a while, which is precisely
 * the failure mode a prose line number cannot catch: the test reads the VALUE
 * from the schema and was green the whole time while the pointer was wrong.
 * A `file:line` in a comment is a convenience, not a claim under test.
 */
export const MAX_EXPLANATION_TEXT_CHARS = 65_536

/** Ceiling on any fan-out value a predicate or a budget may name. */
export const MAX_FAN_OUT = 256

/** Ceiling on any concurrency value. */
export const MAX_CONCURRENCY = 256

/** A retry limit above this is a defect, not a policy. */
export const MAX_RETRY_LIMIT = 16

/**
 * Longest gap between `createdAt` and `expiresAt` a rule may express.
 *
 * `"no expiry"` remains expressible as `expiresAt: null` and is warned about in
 * the disclosure (ADR 0007 section 11); what this bound removes is the other
 * shape of the same statement, a date far enough out that it reads as "no
 * expiry" while looking like a bounded one.
 */
export const MAX_RULE_EXPIRY_DAYS = 3_655

/**
 * Parse-shape guard on every array in the rule language.
 *
 * THIS IS NOT A POLICY LIMIT. It exists so the Zod parse has a finite shape
 * before the compiler runs its own limit pass, which is what lets every real
 * limit in the table above be reported as `rule.limit_exceeded` (naming the
 * constant) instead of as a generic shape error. It is set two orders of
 * magnitude above the largest real limit so it can never be the limit that
 * fires; `limits.test.ts` asserts that by crossing every real limit and
 * observing the real code.
 */
export const PARSE_SHAPE_ARRAY_GUARD = 1_024

/**
 * The whole table, as one frozen value.
 *
 * `CompiledRuleSet.limits` carries this so that a compiled artifact states the
 * budget it was compiled under: a rule set compiled by a build with a larger
 * fan-out ceiling is not silently comparable to one compiled by a build with a
 * smaller one, and an artifact that does not say which is which cannot be
 * audited. Frozen because it is shared across every compiled set and a
 * mutation would be invisible in one of them.
 */
export const ruleLimits = Object.freeze({
  MAX_PREDICATES_PER_RULE,
  MAX_PREDICATE_DEPTH,
  MAX_COMBINATOR_NODES_PER_RULE,
  MAX_RULES_PER_SET,
  MAX_ACTIONS_PER_RULE,
  MAX_ENUMERATED_MEMBERS,
  MAX_LABEL_MEMBERS,
  MAX_SCHEDULE_WINDOWS_PER_RULE,
  MAX_RULE_PATTERN_LENGTH,
  MAX_RULE_PATTERN_NESTING_DEPTH,
  MAX_RULE_NAME_LENGTH,
  MAX_RULE_REASON_LENGTH,
  MAX_RULE_NOTE_LENGTH,
  MAX_COMPILED_RULE_SET_CANONICAL_BYTES,
  MAX_EXPLANATION_TEXT_CHARS,
  MAX_FAN_OUT,
  MAX_CONCURRENCY,
  MAX_RETRY_LIMIT,
  MAX_RULE_EXPIRY_DAYS,
})

/** The section 9 table, as a type. Derived, never hand-written. */
export type RuleLimits = typeof ruleLimits

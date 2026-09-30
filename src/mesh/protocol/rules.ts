import { z } from "zod"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import {
  capabilitySchema,
  projectIdSchema,
  ruleIdSchema,
  schemaVersionSchema,
  timestampSchema,
} from "../../orchestration/identifiers.js"
import { actorSchema, ruleSchema } from "../../orchestration/schemas.js"
import { MAX_RULE_PATTERN_LENGTH } from "./bounds.js"
import { compileSafePattern, matchesBounded, type SafePattern } from "./safe-pattern.js"

/**
 * The remote rule-authoring seam (R7, second half).
 *
 * The milestone fixed two things about rules on a mesh: a pattern must be vetted
 * before it is ever run, and being able to REACH a node is not the authority to
 * author a rule that changes policy evaluation. The second is the one that is
 * easy to get wrong, because a rule pattern is not obviously an escalation —
 * until you notice that a `pre_approve` rule with a broad title pattern
 * pre-approves capabilities for every task in the project, which is exactly what
 * the safety floor exists to prevent.
 *
 * So: until a node is enrolled AND its operator has granted `policy.ruleAuthor`,
 * a rule carrying a `taskTitlePattern` is refused outright. Not "sanitised", not
 * "compiled and stored for later" — refused, because a stored pattern is one
 * policy-evaluation call away from being run.
 */

/** The capability a node's operator must grant before it may author title patterns. */
export const RULE_AUTHOR_CAPABILITY = "policy.ruleAuthor"

export interface RuleAuthorContext {
  /**
   * Whether the authoring node has completed enrollment. Reachability on
   * Tailscale is NOT enrollment, and enrollment is not authority — both are
   * required, which is why this is a separate field rather than folded into the
   * capability check.
   */
  readonly enrolled: boolean
  readonly grantedCapabilities: readonly string[]
  readonly authorNodeId: string
}

/**
 * A rule as it arrives from a remote author, carrying the raw pattern string.
 *
 * This is NOT `ruleSchema`. The kernel's `ruleMatchSchema.taskTitlePattern` is a
 * 256-character string with no other constraint, and a schema that accepts it
 * unchanged is the reason R7 existed. This shape applies the tightened bound at
 * the door; the compiled form is then attached by {@link prepareRule}.
 */
export const remoteRuleMatchSchema = z
  .object({
    taskTitlePattern: z.string().min(1).max(MAX_RULE_PATTERN_LENGTH).optional(),
    requestedCapabilitiesAny: z.array(capabilitySchema).max(128).optional(),
    runtimeKinds: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/))
      .max(128)
      .optional(),
  })
  .strict()

/**
 * A rule write as it crosses the node boundary.
 *
 * `schemaVersion` is required, not defaulted. A remote write with no version is
 * a write whose shape this build is guessing at, and the whole M4-V argument
 * applies to authoring traffic as much as to event traffic.
 */
export const ruleWriteSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    ruleId: ruleIdSchema,
    projectId: projectIdSchema,
    templateVersion: z.number().int().positive().safe(),
    enabled: z.boolean(),
    match: remoteRuleMatchSchema,
    effect: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("restrict"),
          deniedCapabilities: z.array(capabilitySchema).max(128),
          requireApprovalForDestructiveEffects: z.boolean(),
          requireApprovalForExternalEffects: z.boolean(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("pre_approve"),
          approvedCapabilities: z.array(capabilitySchema).min(1).max(128),
          maximumTimeoutSeconds: z.number().int().positive().max(86_400).safe(),
          allowDestructiveEffects: z.boolean(),
          allowExternalEffects: z.boolean(),
        })
        .strict(),
    ]),
    author: actorSchema,
    createdAt: timestampSchema,
  })
  .strict()

export type RuleWrite = z.infer<typeof ruleWriteSchema>

/** A rule that has passed the authoring gate, with its pattern compiled. */
export interface PreparedRule {
  readonly rule: RuleWrite
  /** `null` when the rule matches on capabilities or runtime kinds only. */
  readonly compiledPattern: SafePattern | null
}

/**
 * The gate itself, so a UI can say WHY a write was refused without parsing a
 * message.
 */
export type RuleWriteRefusal =
  | "not_enrolled"
  | "not_rule_author"
  | "pattern_unsafe"
  | "pattern_too_long"

export type RuleWriteFailure = {
  readonly ok: false
  readonly refusal: RuleWriteRefusal
  readonly error: ContractError
}

export type RuleWriteResult = { readonly ok: true; readonly value: PreparedRule } | RuleWriteFailure

/**
 * Validates and prepares a remote rule write.
 *
 * The order is: enrollment, then authority, then the pattern. Authority before
 * pattern so that a node without `policy.ruleAuthor` cannot use this function's
 * refusals as a pattern-oracle — telling an unauthorised peer "that pattern has a
 * nested quantifier" is a small but free piece of information, and the rule here
 * is that a peer who may not write rules learns nothing about the analyser.
 *
 * The returned `PreparedRule` is what the caller persists. The compiled pattern
 * is what the matcher uses; the raw string is retained only for audit, because a
 * rule whose stored pattern and stored regex can disagree is a rule whose
 * behaviour depends on which one the evaluator happened to read.
 */
export function authorizeRuleWrite(
  write: unknown,
  context: RuleAuthorContext,
): RuleWriteResult {
  if (!context.enrolled) {
    return {
      ok: false,
      refusal: "not_enrolled",
      error: createContractError(
        "policy_denied",
        "rule.author_not_enrolled",
        `Node '${context.authorNodeId}' attempted to author a rule before completing enrollment. Tailscale reachability is not enrollment, and enrollment is not authoring authority.`,
      ),
    }
  }

  const parsed = ruleWriteSchema.safeParse(write)
  if (!parsed.success) {
    return {
      ok: false,
      refusal: "pattern_too_long",
      error: createContractError(
        "validation",
        "rule.write_invalid",
        `Rule write does not satisfy its shape: ${parsed.error.issues
          .slice(0, 8)
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("; ")}`,
      ),
    }
  }
  const rule = parsed.data

  const hasPattern = rule.match.taskTitlePattern !== undefined
  const isRuleAuthor = context.grantedCapabilities.includes(RULE_AUTHOR_CAPABILITY)

  if (hasPattern && !isRuleAuthor) {
    return {
      ok: false,
      refusal: "not_rule_author",
      error: createContractError(
        "policy_denied",
        "rule.pattern_requires_rule_author",
        `Rule '${rule.ruleId}' carries a taskTitlePattern and its author '${context.authorNodeId}' does not hold '${RULE_AUTHOR_CAPABILITY}'. A title pattern decides which tasks a policy effect applies to, which is authoring authority, not connectivity.`,
      ),
    }
  }

  if (rule.match.taskTitlePattern === undefined) {
    return { ok: true, value: { rule, compiledPattern: null } }
  }

  const compiled = compileSafePattern(rule.match.taskTitlePattern)
  if (!compiled.ok) {
    return {
      ok: false,
      refusal: rule.match.taskTitlePattern.length > MAX_RULE_PATTERN_LENGTH ? "pattern_too_long" : "pattern_unsafe",
      error: compiled.error,
    }
  }

  return { ok: true, value: { rule, compiledPattern: compiled.value } }
}

/**
 * Evaluates a prepared rule's title pattern against a title.
 *
 * `null` is returned for "no opinion" rather than `false`, because a rule with no
 * pattern is not a rule that failed to match — collapsing the two would let a
 * capability-only rule be reported as "did not match" in an explanation tree and
 * turn an absent matcher into a debugging session.
 */
export function matchesRuleTitle(prepared: PreparedRule, title: string): Result<boolean | null> {
  if (prepared.compiledPattern === null) return { ok: true, value: null }
  return matchesBounded(prepared.compiledPattern, title)
}

/**
 * Converts a prepared rule into the kernel's own `ruleSchema` value.
 *
 * Only reachable for rules that already passed the gate. A rule whose pattern
 * compiled to something the kernel's 256-character `taskTitlePattern` would
 * accept is the happy path; the compile happens first precisely so this
 * conversion is a pure re-shaping and not a second, weaker validation.
 */
export function toKernelRule(prepared: PreparedRule): z.infer<typeof ruleSchema> {
  return ruleSchema.parse({
    schemaVersion: prepared.rule.schemaVersion,
    ruleId: prepared.rule.ruleId,
    templateVersion: prepared.rule.templateVersion,
    projectId: prepared.rule.projectId,
    enabled: prepared.rule.enabled,
    match: prepared.rule.match,
    effect: prepared.rule.effect,
    author: prepared.rule.author,
    createdAt: prepared.rule.createdAt,
  })
}

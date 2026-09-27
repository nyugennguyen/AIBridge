import { z } from "zod"
import { createContractError, type ContractError, type ErrorCategory } from "../errors.js"
import {
  approvalIdSchema,
  capabilitySchema,
  digestSchema,
  projectIdSchema,
  roleIdSchema,
  ruleIdSchema,
  timestampSchema,
  type ApprovalId,
  type Digest,
  type DispatchId,
  type ProjectId,
  type RoleId,
  type RuleId,
  type RunId,
  type TaskId,
  type Timestamp,
} from "../identifiers.js"
import { dispatchEnvelopeSchema } from "../schemas.js"
import { APPROVAL_STATES } from "../transitions.js"
import type { Actor, DispatchEnvelope, Rule } from "../types.js"

const ARRAY_MAX = 128
const TEXT_MAX = 4_096

const shortTextSchema = z.string().min(1).max(256).refine((value) => value === value.trim(), "Must not have surrounding whitespace")
const reasonSchema = z.string().min(1).max(TEXT_MAX)
const positiveSafeIntegerSchema = z.number().int().positive().safe()
const capabilityListSchema = z.array(capabilitySchema).max(ARRAY_MAX)
const ruleCodeSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)

// --- Layers ---

/**
 * Precedence order, widest (most restrictive baseline) first:
 *
 *   1. `safety_floor` — unconditional, non-overridable baseline
 *   2. `project`      — project policy snapshot
 *   3. `role`         — role template `permissionRestrictions`
 *   4. `rule`         — matched rule snapshots from the dispatch envelope
 *   5. `dispatch`     — the dispatch envelope's own `permissionEnvelope`
 *
 * Every layer may only *narrow* the effective permission set produced by the
 * layers above it. `policy` is the synthetic root node id and never appears as a
 * narrowing layer.
 */
export const POLICY_LAYER_IDS = ["safety_floor", "project", "role", "rule", "dispatch"] as const

export const policyLayerIdSchema = z.enum(["policy", "safety_floor", "project", "role", "rule", "dispatch"])

export type PolicyLayerId = z.infer<typeof policyLayerIdSchema>

/** The narrowing layers in precedence order, excluding the synthetic root. */
export const POLICY_PRECEDENCE: readonly PolicyLayerId[] = POLICY_LAYER_IDS

// --- Safety Floor ---

export const SAFETY_FLOOR_MAXIMUM_TIMEOUT_SECONDS = 3_600

/**
 * The shipped default safety floor.
 *
 * It is unconditional: it is not part of the caller-supplied input surface, so
 * no role template, project policy, rule, or pre-approval can relax it. The
 * shipped default of the kernel is "approval required for every dispatch",
 * expressed as `requireApprovalForDispatch: true`.
 */
export const safetyFloorSchema = z
  .object({
    requireApprovalForDispatch: z.literal(true),
    requireApprovalForDestructiveEffects: z.literal(true),
    requireApprovalForExternalEffects: z.literal(true),
    allowDestructiveEffects: z.literal(false),
    allowExternalEffects: z.literal(false),
    maximumTimeoutSeconds: positiveSafeIntegerSchema,
  })
  .strict()

export type SafetyFloor = z.infer<typeof safetyFloorSchema>

// --- Layer narrowing ---

/**
 * A single layer's declared restriction. Every field is monotone: a layer can
 * only remove capabilities, only add approvals, only disable effect flags, and
 * only lower the timeout ceiling. Widening is impossible by construction.
 */
export const permissionNarrowingSchema = z
  .object({
    allowedCapabilities: capabilityListSchema.optional(),
    deniedCapabilities: capabilityListSchema.default([]),
    requireApprovalForDispatch: z.boolean().optional(),
    requireApprovalForDestructiveEffects: z.boolean().optional(),
    requireApprovalForExternalEffects: z.boolean().optional(),
    requireApprovalForCapabilities: capabilityListSchema.default([]),
    allowDestructiveEffects: z.boolean().optional(),
    allowExternalEffects: z.boolean().optional(),
    maximumTimeoutSeconds: positiveSafeIntegerSchema.optional(),
  })
  .strict()

export type PermissionNarrowing = z.infer<typeof permissionNarrowingSchema>

export const projectPolicySchema = z
  .object({
    projectId: projectIdSchema,
    label: shortTextSchema,
    narrowing: permissionNarrowingSchema,
  })
  .strict()

export type ProjectPolicy = z.infer<typeof projectPolicySchema>

// --- Effective state ---

export const effectivePolicyStateSchema = z
  .object({
    allowedCapabilities: capabilityListSchema,
    deniedCapabilities: capabilityListSchema,
    approvalRequiredCapabilities: capabilityListSchema,
    dispatchApprovalDemands: z.array(policyLayerIdSchema).max(8),
    requireApprovalForDestructiveEffects: z.boolean(),
    requireApprovalForExternalEffects: z.boolean(),
    allowDestructiveEffects: z.boolean(),
    allowExternalEffects: z.boolean(),
    maximumTimeoutSeconds: positiveSafeIntegerSchema,
    destructiveEffectsRequested: z.boolean(),
    externalEffectsRequested: z.boolean(),
  })
  .strict()

export type EffectivePolicyState = z.infer<typeof effectivePolicyStateSchema>

export interface NarrowingOutcome {
  readonly state: EffectivePolicyState
  readonly removedCapabilities: readonly string[]
  readonly deniedCapabilities: readonly string[]
  readonly wideningAttempts: readonly string[]
  readonly changed: boolean
}

// --- Explanation tree ---

export const policyExplanationNodeSchema: z.ZodType<PolicyExplanationNode> = z.lazy(() =>
  z
    .object({
      nodeId: shortTextSchema,
      layer: policyLayerIdSchema,
      subject: shortTextSchema.optional(),
      ruleVersion: positiveSafeIntegerSchema.optional(),
      applied: z.boolean(),
      outcome: z.enum([
        "narrowed",
        "unchanged",
        // The node recorded at least one widening attempt and every attempt it
        // made was rejected. This is deliberately distinct from `unchanged`,
        // which means the node genuinely had nothing to contribute: a rejected
        // escalation attempt must never read as a no-op in an audit view.
        "widening_rejected",
        "skipped",
        "pre_approved",
        "pre_approval_rejected",
        "superseded",
      ]),
      reason: reasonSchema,
      removedCapabilities: capabilityListSchema,
      deniedCapabilities: capabilityListSchema,
      grantedPreApprovals: capabilityListSchema,
      rejectedPreApprovals: capabilityListSchema,
      wideningAttempts: z.array(reasonSchema).max(64),
      effective: effectivePolicyStateSchema,
      children: z.array(policyExplanationNodeSchema).max(ARRAY_MAX),
    })
    .strict(),
)

export interface PolicyExplanationNode {
  readonly nodeId: string
  readonly layer: PolicyLayerId
  readonly subject?: string
  readonly ruleVersion?: number
  readonly applied: boolean
  readonly outcome:
    | "narrowed"
    | "unchanged"
    | "widening_rejected"
    | "skipped"
    | "pre_approved"
    | "pre_approval_rejected"
    | "superseded"
  readonly reason: string
  readonly removedCapabilities: readonly string[]
  readonly deniedCapabilities: readonly string[]
  readonly grantedPreApprovals: readonly string[]
  readonly rejectedPreApprovals: readonly string[]
  readonly wideningAttempts: readonly string[]
  readonly effective: EffectivePolicyState
  readonly children: readonly PolicyExplanationNode[]
}

// --- Decision ---

export const policyDecisionSchema = z.enum(["allow", "require_approval", "deny"])

export type PolicyDecision = z.infer<typeof policyDecisionSchema>

export const policyDenialSchema = z
  .object({
    code: ruleCodeSchema,
    message: reasonSchema,
    capabilities: capabilityListSchema,
    layer: policyLayerIdSchema.optional(),
    subject: shortTextSchema.optional(),
  })
  .strict()

export type PolicyDenial = z.infer<typeof policyDenialSchema>

export const preApprovalBasisSchema = z
  .object({
    ruleId: ruleIdSchema,
    ruleVersion: positiveSafeIntegerSchema,
  })
  .strict()

export type PreApprovalBasis = z.infer<typeof preApprovalBasisSchema>

export const policyEvaluationSchema = z
  .object({
    dispatchId: z.string(),
    projectId: projectIdSchema,
    runId: z.string(),
    taskId: z.string(),
    roleId: roleIdSchema,
    envelopeDigest: digestSchema,
    decision: policyDecisionSchema,
    allowed: z.boolean(),
    effective: effectivePolicyStateSchema,
    declaredTimeoutSeconds: positiveSafeIntegerSchema,
    effectiveTimeoutSeconds: positiveSafeIntegerSchema,
    preApprovalClearedDefault: z.boolean(),
    grantedPreApprovals: capabilityListSchema,
    preApprovalBasis: preApprovalBasisSchema.nullable(),
    outstandingApprovals: z.array(reasonSchema).max(ARRAY_MAX),
    denials: z.array(policyDenialSchema).max(ARRAY_MAX),
    // The root node of `explanation` aggregates every widening attempt recorded
    // anywhere in the subtree, sorted and de-duplicated, so an auditor can read
    // `evaluation.explanation.wideningAttempts` without walking the tree. It is
    // deliberately not duplicated as a top-level field: a second copy of a
    // derivable value is a second thing that can drift.
    explanation: policyExplanationNodeSchema,
    explanationText: z.string().min(1).max(65_536),
    decisionDigest: digestSchema,
  })
  .strict()

export type PolicyEvaluation = z.infer<typeof policyEvaluationSchema>

export const policyEvaluationInputSchema = z
  .object({
    envelope: dispatchEnvelopeSchema,
    taskTitle: shortTextSchema.optional(),
    projectPolicy: projectPolicySchema.optional(),
  })
  .strict()

export type PolicyEvaluationInput = z.infer<typeof policyEvaluationInputSchema>

// --- Rule matching ---

export const ruleMatchContextSchema = z
  .object({
    taskTitle: z.string().min(1).max(256).nullable(),
    requestedCapabilities: capabilityListSchema,
    runtimeKind: z.string().min(1).max(128),
  })
  .strict()

export type RuleMatchContext = z.infer<typeof ruleMatchContextSchema>

export const ruleMatchOutcomeSchema = z
  .object({
    matched: z.boolean(),
    reason: reasonSchema,
  })
  .strict()

export type RuleMatchOutcome = z.infer<typeof ruleMatchOutcomeSchema>

// --- Digest-bound approval ---

export const approvalStateSchema = z.enum(APPROVAL_STATES)

export const approvalVerificationSchema = z
  .object({
    approvalId: approvalIdSchema,
    projectId: projectIdSchema,
    runId: z.string(),
    dispatchId: z.string(),
    decision: z.enum(["approved", "rejected"]),
    recordedEnvelopeDigest: digestSchema,
    computedEnvelopeDigest: digestSchema,
    state: approvalStateSchema,
    valid: z.boolean(),
    reasons: z.array(reasonSchema).max(16),
    codes: z.array(ruleCodeSchema).max(16),
    error: z.unknown().optional(),
  })
  .strict()

export type ApprovalVerification = z.infer<typeof approvalVerificationSchema>

export const createApprovalInputSchema = z
  .object({
    envelope: dispatchEnvelopeSchema,
    approvalId: approvalIdSchema,
    decision: z.enum(["approved", "rejected"]),
    basis: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("user") }).strict(),
      z
        .object({
          kind: z.literal("rule"),
          ruleId: ruleIdSchema,
          ruleVersion: positiveSafeIntegerSchema,
        })
        .strict(),
    ]),
    actor: z.unknown(),
    decidedAt: timestampSchema,
    evaluation: z.unknown().optional(),
  })
  .strict()

export type CreateApprovalInput = {
  readonly envelope: DispatchEnvelope
  readonly approvalId: ApprovalId
  readonly decision: "approved" | "rejected"
  readonly basis: { readonly kind: "user" } | { readonly kind: "rule"; readonly ruleId: RuleId; readonly ruleVersion: number }
  readonly actor: Actor
  readonly decidedAt: Timestamp
  /** Optional policy evaluation. When supplied, an `approved` decision is refused unless it allows the dispatch. */
  readonly evaluation?: PolicyEvaluation
}

// --- Errors ---

export class PolicyEngineError extends Error {
  readonly code: string
  readonly category: ErrorCategory

  constructor(message: string, code: string, category: ErrorCategory = "validation") {
    super(message)
    this.name = "PolicyEngineError"
    this.code = code
    this.category = category
  }

  toContractError(): ContractError {
    return createContractError(this.category, this.code, this.message)
  }
}

export class PolicyProjectScopeError extends PolicyEngineError {
  readonly projectId: string
  readonly expectedProjectId: string

  constructor(projectId: string, expectedProjectId: string) {
    super(
      `policy.project_scope_mismatch: Project policy scope '${projectId}' does not match dispatch project '${expectedProjectId}'`,
      "policy.project_scope_mismatch",
      "policy_denied",
    )
    this.name = "PolicyProjectScopeError"
    this.projectId = projectId
    this.expectedProjectId = expectedProjectId
  }
}

export class PolicyApprovalError extends PolicyEngineError {
  readonly code: string
  readonly category: ErrorCategory

  constructor(message: string, code: string, category: ErrorCategory = "validation") {
    super(message, code, category)
    this.name = "PolicyApprovalError"
    this.code = code
    this.category = category
  }
}

// --- Helpers ---

export function findRuleSnapshot(envelope: DispatchEnvelope, ruleId: string, ruleVersion: number): Rule | undefined {
  return envelope.ruleSnapshots.find((rule) => rule.ruleId === ruleId && rule.templateVersion === ruleVersion)
}

export type { DispatchId, ProjectId, RoleId, RunId, TaskId, Digest, ApprovalId, Timestamp, RuleId }

import { digestDispatchEnvelope } from "../digest.js"
import { createContractError, type Result } from "../errors.js"
import { validateApprovalDigest } from "../invariants.js"
import { approvalSchema } from "../schemas.js"
import { tryTransitionApproval, type ApprovalState } from "../transitions.js"
import type { Approval, DispatchEnvelope, Rule } from "../types.js"
import {
  findRuleSnapshot,
  type ApprovalVerification,
  type CreateApprovalInput,
  type PolicyEvaluation,
} from "./types.js"

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

type Basis = Approval["basis"]

function fail(category: Parameters<typeof createContractError>[0], code: string, message: string) {
  return { ok: false as const, error: createContractError(category, code, message) }
}

/**
 * A pre-approval basis must name a rule snapshot that is actually present on the
 * envelope being approved. Anything else would let an approval claim a
 * provenance the dispatch never carried.
 */
export function validateApprovalBasis(approval: Approval, envelope: DispatchEnvelope): Result<Basis> {
  return checkRuleBasis(approval.basis, envelope)
}

function checkRuleBasis(basis: Basis, envelope: DispatchEnvelope): Result<Basis> {
  if (basis.kind === "user") {
    return ok(basis)
  }
  const rule: Rule | undefined = findRuleSnapshot(envelope, basis.ruleId, basis.ruleVersion)
  if (rule === undefined) {
    return fail(
      "validation",
      "approval.unknown_rule_basis",
      `Approval basis references rule '${basis.ruleId}' version ${basis.ruleVersion}, which is not among the dispatch envelope's ${envelope.ruleSnapshots.length} rule snapshot(s)`,
    )
  }
  if (rule.effect.kind !== "pre_approve") {
    return fail(
      "policy_denied",
      "approval.ineligible_rule_basis",
      `Approval basis references rule '${rule.ruleId}' version ${rule.templateVersion}, whose effect kind is '${rule.effect.kind}' and cannot pre-approve a dispatch`,
    )
  }
  return ok(basis)
}

/**
 * Constructs a digest-bound approval for an envelope.
 *
 * The approval records the exact canonical digest of the envelope it was
 * decided against, together with the envelope's own project, run and dispatch
 * identity, so a later mutation of any material field is detectable.
 */
export function createApproval(input: CreateApprovalInput): Result<Approval> {
  const envelope = input.envelope
  const basisCheck = checkRuleBasis(input.basis, envelope)
  if (!basisCheck.ok) return basisCheck

  const envelopeDigest = digestDispatchEnvelope(envelope)

  if (input.decision === "approved" && input.evaluation !== undefined) {
    if (input.evaluation.decision !== "allow") {
      return fail(
        input.evaluation.decision === "deny" ? "policy_denied" : "approval_required",
        input.evaluation.decision === "deny" ? "policy.approval_denied" : "policy.approval_not_satisfiable",
        `Cannot record an 'approved' decision for dispatch '${envelope.dispatchId}': policy decision is '${input.evaluation.decision}'`,
      )
    }
    if (input.evaluation.envelopeDigest !== envelopeDigest) {
      return fail(
        "conflict",
        "approval.evaluation_digest_mismatch",
        `Policy evaluation was computed for envelope digest '${input.evaluation.envelopeDigest}' but the envelope now digests to '${envelopeDigest}'`,
      )
    }
  }

  const approval = approvalSchema.parse({
    schemaVersion: 1,
    approvalId: input.approvalId,
    projectId: envelope.projectId,
    runId: envelope.runId,
    dispatchId: envelope.dispatchId,
    envelopeDigest,
    decision: input.decision,
    basis: input.basis,
    actor: input.actor,
    decidedAt: input.decidedAt,
  })

  return ok(approval)
}

/**
 * Verifies a digest-bound approval against an envelope and derives the approval
 * state. A scope mismatch, a digest mismatch or an unknown rule basis all
 * resolve to the `invalidated` state; a rejection keeps its terminal `rejected`
 * state.
 */
export function verifyApproval(approval: Approval, envelope: DispatchEnvelope): ApprovalVerification {
  const computedEnvelopeDigest = digestDispatchEnvelope(envelope)

  // `validateApprovalDigest` checks the decision last, so reaching that branch
  // proves the scope and digest checks already passed.
  const digestCheck = validateApprovalDigest(approval, { envelope })
  const scopeAndDigestOk = digestCheck.ok || digestCheck.error.code === "approval.not_approved"

  const basisCheck = checkRuleBasis(approval.basis, envelope)

  // `valid` means "this approval still binds to this envelope", independently of
  // the decision it recorded. A rejection of a different envelope is therefore
  // not valid, even though its state stays terminally `rejected`.
  const valid = scopeAndDigestOk && basisCheck.ok

  const state: ApprovalState =
    approval.decision === "rejected" ? "rejected" : valid ? "approved" : "invalidated"

  const reasons: string[] = []
  const codes: string[] = []
  if (!digestCheck.ok && digestCheck.error.code !== "approval.not_approved") {
    reasons.push(digestCheck.error.message)
    codes.push(digestCheck.error.code)
  }
  if (!basisCheck.ok) {
    reasons.push(basisCheck.error.message)
    codes.push(basisCheck.error.code)
  }

  const bindingError = scopeAndDigestOk ? undefined : digestCheck.error

  return {
    approvalId: approval.approvalId,
    projectId: approval.projectId,
    runId: approval.runId,
    dispatchId: approval.dispatchId,
    decision: approval.decision,
    recordedEnvelopeDigest: approval.envelopeDigest,
    computedEnvelopeDigest,
    state,
    valid,
    reasons,
    codes,
    ...(bindingError === undefined ? {} : { error: bindingError }),
  }
}

/**
 * Invalidates a prior approval after an envelope mutation.
 *
 * Uses the approval state machine: only `pending` and `approved` can be
 * invalidated, and `invalidated` is terminal. Invalidation is only warranted
 * when the approval no longer binds to the envelope, so an unchanged envelope is
 * reported rather than silently marked invalid.
 */
export function invalidateApproval(
  approval: Approval,
  envelope: DispatchEnvelope,
  previousState: ApprovalState,
): Result<ApprovalState> {
  const transition = tryTransitionApproval(previousState, "invalidated")
  if (!transition.ok) return transition

  const verification = verifyApproval(approval, envelope)
  if (verification.valid) {
    return fail(
      "conflict",
      "approval.invalidation_unwarranted",
      `Approval '${approval.approvalId}' still binds to the current envelope digest '${verification.computedEnvelopeDigest}' and cannot be invalidated`,
    )
  }

  return ok(transition.value)
}

/**
 * Resolves the approval state for a known prior state, routing any invalidation
 * through the approval state machine so illegal transitions are rejected rather
 * than silently applied.
 */
export function resolveApprovalState(
  approval: Approval,
  envelope: DispatchEnvelope,
  previousState: ApprovalState,
): Result<ApprovalState> {
  const verification = verifyApproval(approval, envelope)
  if (verification.state !== "invalidated") {
    return ok(verification.state)
  }
  return invalidateApproval(approval, envelope, previousState)
}

/**
 * Extracts the machine-readable policy evaluation recorded alongside an
 * approval projection, when one is present and structurally recognizable.
 */
export function policyResultOf(projection: { readonly policyResult: unknown }): PolicyEvaluation | null {
  const raw: unknown = projection.policyResult
  if (raw === null || typeof raw !== "object") return null
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.decision !== "string") return null
  if (candidate.explanation === null || typeof candidate.explanation !== "object") return null
  return raw as PolicyEvaluation
}

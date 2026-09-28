import { evaluatePolicy } from "../policy/evaluate.js"
import type { PolicyEvaluation } from "../policy/types.js"
import type { DispatchEnvelope } from "../types.js"
import type { DispatchPolicyProjection } from "./types.js"

/**
 * Where a policy derivation came from, and what it produced.
 *
 * `evaluation` is the full `PolicyEvaluation` — the structured tree plus its
 * rendered `explanationText` — and is what an approval projection retains. It
 * is `null` exactly when `policy.status` is `unavailable`.
 */
export interface DispatchPolicyDerivation {
  readonly policy: DispatchPolicyProjection
  readonly evaluation: PolicyEvaluation | null
}

const UNAVAILABLE = (reason: string): DispatchPolicyProjection => ({
  status: "unavailable",
  decision: null,
  decisionDigest: null,
  explanationText: null,
  outstandingApprovals: [],
  denials: [],
  declaredTimeoutSeconds: null,
  effectiveTimeoutSeconds: null,
  roleId: null,
  roleVersion: null,
  reason,
})

/**
 * The "no decision available" record, for a projection that must carry a
 * policy field for a dispatch it has no envelope for.
 */
export function unavailableDispatchPolicy(reason: string): DispatchPolicyProjection {
  return UNAVAILABLE(reason)
}

/**
 * Replays the policy engine over a dispatch envelope snapshot.
 *
 * This is a DERIVATION, not a second source of truth: `evaluatePolicy` is a
 * pure function of the envelope, and the envelope is immutable once
 * `dispatch.proposed` has recorded it. So the decision, its denials, its
 * outstanding approvals and the rendered explanation tree can be rebuilt from
 * the event log alone — which is exactly what a read model is for, and what
 * makes a TUI audit view able to show a real decision rather than a
 * placeholder.
 *
 * A missing envelope is reported, never defaulted: a dispatch reconstructed
 * from a bare `dispatch.finished` has no envelope to evaluate, and saying
 * "allow" for it would be a fabricated permission.
 */
export function deriveDispatchPolicy(
  envelope: DispatchEnvelope | null,
  unavailableReason: string,
): DispatchPolicyDerivation {
  if (envelope === null) {
    return { policy: UNAVAILABLE(unavailableReason), evaluation: null }
  }

  let evaluation: PolicyEvaluation
  try {
    evaluation = evaluatePolicy({ envelope })
  } catch (error) {
    // A projection must never fail to build because one envelope is not
    // evaluatable. The reason is retained so an audit view says why, rather
    // than the run silently losing its policy explanation.
    const reason = error instanceof Error ? error.message : String(error)
    return { policy: UNAVAILABLE(`Policy evaluation failed for envelope: ${reason}`), evaluation: null }
  }

  return {
    policy: {
      status: "evaluated",
      decision: evaluation.decision,
      decisionDigest: evaluation.decisionDigest,
      explanationText: evaluation.explanationText,
      outstandingApprovals: evaluation.outstandingApprovals,
      denials: evaluation.denials,
      declaredTimeoutSeconds: evaluation.declaredTimeoutSeconds,
      effectiveTimeoutSeconds: evaluation.effectiveTimeoutSeconds,
      roleId: evaluation.roleId,
      roleVersion: envelope.roleSnapshot.templateVersion,
      reason: null,
    },
    evaluation,
  }
}

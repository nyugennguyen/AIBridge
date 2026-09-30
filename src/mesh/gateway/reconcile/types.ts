import type { ContractError, Result } from "../../../orchestration/errors.js"
import type { DispatchId, Epoch, NodeId, SessionId } from "../../../orchestration/identifiers.js"
import type { LeaseScope } from "../../lease/schemas.js"
import type {
  ReconciliationStepVerdict,
  MeshReconciliationResponse,
  UnreconciledEntry,
  UnreconciledReason,
} from "../../protocol/reconciliation.js"
import type { UnacknowledgedSource } from "../events/types.js"

/**
 * M4.6 — reconciliation's ports.
 *
 * Four of them, and the split is the design:
 *
 *   - {@link ReconcileLeaseReader} — step 3's ONLY source of the accepted epoch.
 *     Declared as a two-method read of M4.4's `ControllerLease` rather than the
 *     whole seam, so a reconciler cannot reach `takeover`. That matters more than
 *     it looks: step 6 is "mark unexplained differences for user review; do not
 *     silently adopt or terminate", and a reconciliation that could RAISE AN EPOCH
 *     would be a second path to the one thing the plan fences hardest.
 *   - {@link UnacknowledgedSource} — step 4's resend lists, read from M4.5's
 *     durable queues. Declared in `./events/types.ts` because the SSE gateway and
 *     the reconciler answer the same question about the same rows, and a second
 *     list of "what has not been acknowledged" kept beside the reconciler is a
 *     second answer to a question the durable queues already answer.
 *   - {@link DispatchProjectionReader} — step 5's other side of the diff. The
 *     worker reports its live sessions as an OBSERVATION; this is where the
 *     controller's own dispatch projections come from, and the two are compared.
 *   - {@link ReconcileSnapshotSource} — M4-S. The same `snapshotFallback` the SSE
 *     route serves, read through the same port, so a client that reconnects over
 *     SSE and a peer that reconciles over the wire are told the same thing by the
 *     same rule.
 */

/**
 * M4.4's lease, reduced to what reconciliation is allowed to ask it.
 *
 * `heldLease` and nothing else. There is deliberately no `takeover` here, and the
 * reason is the plan's guardrail "do not accept a higher controller epoch without
 * the explicit takeover flow": a reconciler that could raise the epoch would make
 * the epoch a function of who reconciled first, which is the automatic election the
 * milestone forbids. The epoch reconciliation REPORTS comes from this read; the
 * epoch that BINDS comes from `evaluateLease` on a takeover record a user made.
 */
export interface ReconcileLeaseReader {
  heldLease(scope: LeaseScope): Promise<Result<{ readonly epoch: Epoch } | null>>
  /**
   * Records what reconciliation found, so a later takeover knows which nodes have
   * not been reconciled. M4.4 owns the set and this is its only mutator; the
   * reconciler supplies ids and never decides what they MEAN.
   */
  setUnreconciledNodeIds(scope: LeaseScope, nodeIds: readonly NodeId[]): void
}

/** One session the worker says is live, as step 5 receives it. */
export interface ReportedSession {
  readonly sessionId: SessionId
  readonly dispatchId: DispatchId
}

/**
 * The controller's own view of a dispatch, for step 5's diff.
 *
 * A MINIMUM, and the reason is R3-adjacent and worth stating: this reader answers
 * "does the controller believe this dispatch produced this session", and nothing
 * else. It deliberately does not return the envelope, because a same-`dispatchId`
 * revision REPLACES the envelope (R3) — a diff that compared envelopes would report
 * a revision as a divergence every time one happened, and would train an operator
 * to read `unreconciled` entries as "nothing important".
 */
export interface DispatchProjectionReader {
  /** The session the controller believes `dispatchId` produced, or `null`. */
  sessionForDispatch(scope: LeaseScope, dispatchId: DispatchId): Promise<Result<SessionId | null>>
}

/** The result of one reconciliation pass. */
export type ReconcileOutcome =
  | {
      readonly ok: true
      readonly response: MeshReconciliationResponse
      /** The six steps, in order, as the protocol evaluator reported them. */
      readonly steps: readonly ReconciliationStepVerdict[]
      /**
       * The node ids this pass marked as not-yet-reconciled.
       *
       * Reported, and NOT acted on. It has already been handed to
       * `ReconcileLeaseReader.setUnreconciledNodeIds`, which is the whole of what
       * "mark for user review" means: a fact the next takeover's user-inspection
       * precondition is evaluated against. There is no member here that could
       * adopt or terminate anything, and that is the property the response type
       * exists to make structural.
       */
      readonly unreconciledNodeIds: readonly NodeId[]
    }
  | {
      readonly ok: false
      /**
       * The step THIS node refused at, or `null` when the peer's own refusal is
       * what came back.
       *
       * `null` is load-bearing and is the protocol evaluator's own convention:
       * attributing a peer's refusal to a step on this side sends an operator to
       * the wrong node of the mesh, which is the exact confusion the per-step
       * detail exists to prevent.
       */
      readonly failedStep: 1 | 2 | 3 | null
      readonly steps: readonly ReconciliationStepVerdict[]
      readonly error: ContractError
    }

export type { UnacknowledgedSource, UnreconciledEntry, UnreconciledReason }

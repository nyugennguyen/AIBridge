import { createContractError, type ContractError, type Result } from "../../../orchestration/errors.js"
import { dispatchIdSchema, projectIdSchema, runIdSchema } from "../../../orchestration/identifiers.js"
import { ARRAY_MAX } from "../../protocol/identifiers.js"
import { supportedProtocolVersions } from "../../protocol/negotiation.js"
import { safeParseMeshEnvelope } from "../../protocol/registry.js"
import {
  meshReconciliationResponseSchema,
  verifyReconciliationPair,
  type MeshReconciliationRequest,
  type MeshReconciliationResponse,
  type ReconciliationStepVerdict,
  type UnreconciledEntry,
} from "../../protocol/reconciliation.js"
import type { LeaseScope } from "../../lease/schemas.js"
import { RECONCILE_RESEND_LIMIT } from "./constants.js"
import type { DispatchProjectionReader, ReconcileLeaseReader, ReconcileOutcome } from "./types.js"
import type { SnapshotFallbackSource, UnacknowledgedSource } from "../events/types.js"

/**
 * M4.6 — the six reconciliation steps, in the plan's order, over real seams.
 *
 * ### What is reimplemented here, and what is not
 *
 * Almost nothing. The step LOGIC — version compatibility, the reconcile-id
 * correlation, the epoch comparison in both directions, the per-step verdict
 * records — belongs to `verifyReconciliationPair` in `src/mesh/protocol/`, and this
 * class CALLS it rather than restating it. A second implementation of step 3 would
 * be a second epoch rule, and the plan's fence ("a higher epoch is never accepted
 * without the explicit takeover flow") is only checkable if there is one place to
 * check it. `checkReconciliationPair` is the same evaluator behind a `Result`; this
 * seam needs the `failedStep` and the per-step verdicts, so it uses the
 * discriminated form directly and re-exports the `Result` flavour in `./index.ts`
 * for callers that do not.
 *
 * What this class adds is the three things a pure protocol package cannot have:
 * storage (M4.4's lease, M4.5's durable queues, the controller's dispatch
 * projections), a namespace (the `(projectId, runId)` a request is about), and the
 * WIRING of steps 4 and 5 to those stores.
 *
 * ### The order, and why it is this order
 *
 * Steps run 1 → 6 and a refusal STOPS. The order that is not the plan's own is step
 * 3, which is evaluated FIRST here — and that is an ordering of SIDE EFFECTS, not of
 * logic. Steps 4 and 5 read durable rows and produce resend lists; a superseded
 * controller must not cause either, because its resend list is a set of decisions
 * taken against a projection that no longer exists. So:
 *
 *   - the accepted epoch is read from **M4.4's lease**, and handed to the protocol
 *     evaluator as its right-hand side. That is what "step 3 rejects stale-
 *     controller traffic via M4.4's lease, not a second epoch rule" means in code:
 *     one epoch rule, and the lease is where its right-hand side comes from.
 *   - the evaluator then walks 1, 2 and 3 in ITS order, and only a pass at all
 *     three lets this class read a queue.
 *   - **4 before 5, both before 6.** Resending closes a gap in what the peer HAS;
 *     the inventory diff finds a gap in what it BELIEVES. Marking a difference
 *     before the resend lists are known would put `unreconciled` entries in front of
 *     a human for differences step 4 was about to close by itself.
 *
 * ### Step 6 is structural, not disciplined
 *
 * The response this class builds has no member that could adopt or terminate a
 * session, and none is added here. `meshReconciliationResponseSchema` is `.strict()`
 * and the response is PARSED before it is returned, so an invented field — an
 * `adopt`, a `terminate` — is a parse failure at that line rather than a field on
 * the wire. `unreconciled[]` is the only channel a difference takes to a human, and
 * the node ids it names are handed to M4.4's `setUnreconciledNodeIds` so a later
 * takeover's user-inspection precondition is evaluated against a fact rather than
 * against nothing. Nothing is adopted. Nothing is terminated.
 */

export interface MeshReconcilerDependencies {
  /** M4.4's lease, narrowed to a read and the unreconciled-set write. */
  readonly lease: ReconcileLeaseReader
  /** M4.5's durable queues, for step 4's resend lists. */
  readonly unacknowledged: UnacknowledgedSource
  /** The controller's dispatch projections, for step 5's diff. */
  readonly projections: DispatchProjectionReader
  /** The protocol versions this build speaks. Defaults to the negotiation module's. */
  readonly supportedProtocolVersions?: readonly number[]
  /** How many ids a resend list may carry. Bounded, because it crosses a wire. */
  readonly resendLimit?: number
  /**
   * M4-S. The same `SnapshotFallbackSource` the SSE route uses, so a client that
   * reconnects over SSE and a peer that reconciles over the wire are answered by
   * one rule and cannot drift apart.
   *
   * Omitting it means a reconciliation never carries a `snapshotFallback`. That is a
   * legitimate configuration and not a silent gap: the response's `outcome` reports
   * what this node CAN see — the positions and the inventory — and the decision about
   * whether a cursor can be honoured belongs to the SSE route, which is the only seam
   * that holds one. A source that FAILS is a different thing entirely and refuses the
   * pass, because reporting convergence over a re-base nobody could produce is the one
   * answer that hides a fault.
   */
  readonly snapshots?: SnapshotFallbackSource
}

export class MeshReconciler {
  readonly #deps: MeshReconcilerDependencies
  readonly #versions: readonly number[]
  readonly #resendLimit: number

  constructor(dependencies: MeshReconcilerDependencies) {
    this.#deps = dependencies
    this.#versions = dependencies.supportedProtocolVersions ?? supportedProtocolVersions()
    // Clamped to `ARRAY_MAX` because the response schema bounds these lists and a
    // limit above the schema's own would be a number the wire refuses for a reason
    // that reads as a protocol bug rather than as a policy.
    this.#resendLimit = Math.max(1, Math.min(dependencies.resendLimit ?? RECONCILE_RESEND_LIMIT, ARRAY_MAX))
  }

  /**
   * Runs one `mesh.reconciliation.request` through the six steps.
   *
   * Takes the RAW wire value for the reason every other mesh seam does: M4-V is
   * that there is exactly one parse entry point, and a parameter typed
   * `MeshReconciliationRequest` would be an invitation to add a second. A caller
   * that has already parsed has a second parse site, and a record carrying a version
   * outside `SCHEMA_VERSIONS` would be partially read on the way here.
   */
  async reconcile(value: unknown): Promise<ReconcileOutcome> {
    const parsed = safeParseMeshEnvelope(value)
    if (!parsed.ok) return refusal(null, [], parsed.error)
    const envelope = parsed.value
    if (envelope.recordType !== "mesh.reconciliation.request") {
      return refusal(
        null,
        [],
        createContractError(
          "validation",
          "mesh.reconcile_not_a_request",
          `Reconciliation received a '${envelope.recordType}'. This seam evaluates reconciliation requests and nothing else; a command or a lease offered here is a caller wiring defect, not a record this seam should interpret, and the lease evaluator's rules do not apply to a command.`,
        ),
      )
    }
    const request = envelope.payload

    // The scope comes from the RECORD, and both ids are re-parsed through the
    // kernel's own schemas before they key anything. Same reason as the lease: the
    // scope decides which durable rows are read and which run's dispatch
    // projections are compared, so a scope that cannot be verified must not be
    // allowed to select either.
    const scope = scopeOf(request)
    if (scope === null) {
      return refusal(
        null,
        [],
        createContractError(
          "validation",
          "mesh.reconcile_scope_unreadable",
          `Reconciliation '${request.reconcileId}' does not carry a well-formed (projectId, runId) pair. It is refused rather than reconciled against a scope read from somewhere else, because the scope decides which queues are read and which run's dispatch projections are compared.`,
        ),
      )
    }

    // Step 3's right-hand side, read from M4.4's lease. Nothing is read from a
    // durable queue before this returns, which is the whole point: a node with no
    // lease has no accepted epoch, and a superseded controller has one that is too
    // low. Either way, the answer is a refusal and no queue was touched.
    const held = await this.#deps.lease.heldLease(scope)
    if (!held.ok) return refusal(null, [], held.error)
    if (held.value === null) {
      return refusal(
        null,
        [],
        createContractError(
          "conflict",
          "mesh.reconcile_no_lease",
          `Reconciliation '${request.reconcileId}' names run ${scope.runId}, and this node holds no lease for it. There is no accepted controller epoch to reconcile against, and a node with no lease has no authority to acknowledge positions, resend work, or judge a session inventory.`,
        ),
      )
    }
    const acceptedControllerEpoch = held.value.epoch

    // Steps 1, 2 and 3, in the evaluator's own order, over a well-formed scaffold.
    // The scaffold is ONLY a vehicle for the gate: its resend lists and
    // `unreconciled` are empty because steps 4 and 5 have not run, and the verdict
    // it produces is re-walked below over the response that is actually returned.
    const gate = verifyReconciliationPair(request, scaffoldResponse(request, acceptedControllerEpoch), {
      supportedProtocolVersions: this.#versions,
      acceptedControllerEpoch,
      nowMs: 0,
    })
    if (!gate.ok) return { ok: false, failedStep: gate.failedStep, steps: gate.steps, error: gate.error }

    // Step 4. Resend lists, as IDS. Ids and not payloads is what makes the resend
    // idempotent: the receiver dedupes on `commandId` / `eventId`, so a resend of
    // something already applied converges onto the stored result instead of
    // appending a second thing that happened.
    const commands = await this.#deps.unacknowledged.commandIds(
      scope,
      request.controllerLastAcknowledgedInboxSequence,
      this.#resendLimit,
    )
    if (!commands.ok) return refusal(3, gate.steps, commands.error)
    const events = await this.#deps.unacknowledged.eventIds(
      scope,
      request.controllerLastAcknowledgedOutboxSequence,
      this.#resendLimit,
    )
    if (!events.ok) return refusal(3, gate.steps, events.error)

    // Step 5. The peer's live sessions against this node's dispatch projections.
    // A difference becomes an `unreconciled` entry. It NEVER becomes an action.
    const diff = await this.#compareInventory(request, scope)
    if (!diff.ok) return refusal(3, gate.steps, diff.error)

    // M4-S. The re-base this node OFFERS. Asked for here rather than inferred, and
    // the response's `snapshotFallback` is the PROTOCOL's field produced by the same
    // source the SSE route uses, so a client that reconnects over SSE and a peer that
    // reconciles over the wire are told the same thing by one rule.
    //
    // It is an OFFER and not a decision, and the reason is a fact about the wire: a
    // `mesh.reconciliation.request` carries no cursor, so this node cannot know that
    // the peer is behind and cannot know that the peer NEEDS a re-base. Deciding
    // whether a cursor can be honoured is the SSE route's job — it is the only seam
    // that holds a cursor — and the two asking one source is what stops them from
    // disagreeing about what "explicit fallback" means.
    const rebase = await this.#fallbackFor(scope)
    if (!rebase.ok) return refusal(3, gate.steps, rebase.error)
    const snapshotFallback = rebase.value === null ? undefined : rebase.value.snapshotFallback

    // PARSED, not constructed and returned. `.strict()` plus a parse is what makes
    // step 6 structural here rather than a promise: a member invented in this file
    // — an `adopt`, a `terminate` — fails at this line instead of reaching a peer.
    const built = meshReconciliationResponseSchema.safeParse({
      reconcileId: request.reconcileId,
      outcome: outcomeFor(diff.value.length, snapshotFallback !== undefined),
      acceptedControllerEpoch,
      resendCommandIds: commands.value,
      resendEventIds: events.value,
      unreconciled: diff.value,
      ...(snapshotFallback === undefined ? {} : { snapshotFallback }),
    })
    if (!built.success) {
      return refusal(
        3,
        gate.steps,
        createContractError(
          "internal_failure",
          "mesh.reconcile_response_unrepresentable",
          `The reconciliation response this node built for '${request.reconcileId}' does not satisfy the protocol's response shape (${built.error.issues[0]?.message ?? "unparseable"}). It is refused rather than sent: a response that does not parse is a record no peer can trust, and the only fields it could have been carrying are the ones the plan forbids adding.`,
        ),
      )
    }

    // Step 6's write. The marked node ids go to M4.4 so a later takeover's
    // user-inspection precondition is evaluated against a fact. It is the ONLY
    // write in this method, which is why it sits after the gate: a superseded
    // controller must not be able to change what a successor is told it has to
    // inspect, because that list is a precondition a human then acts on.
    const unreconciledNodeIds = [...new Set(diff.value.map((entry) => entry.nodeId))]
    this.#deps.lease.setUnreconciledNodeIds(scope, unreconciledNodeIds)

    // The six steps over the pair ACTUALLY produced, so steps 4, 5 and 6 are on
    // the record with the real resend lists and the real difference count rather
    // than with the scaffold's empty ones.
    const verdict = verifyReconciliationPair(request, built.data, {
      supportedProtocolVersions: this.#versions,
      acceptedControllerEpoch,
      nowMs: 0,
    })
    if (!verdict.ok) return { ok: false, failedStep: verdict.failedStep, steps: verdict.steps, error: verdict.error }
    return { ok: true, response: built.data, steps: verdict.steps, unreconciledNodeIds }
  }

  /**
   * Step 5's diff, in full.
   *
   * Two outcomes per reported session, and both are ENTRIES rather than actions:
   *
   *   - the controller has no dispatch for it → `session_not_in_projection`. A
   *     session running that this node's own log has no dispatch for is either a
   *     partition that lost the proposal or work this node did not authorise, and
   *     the two are not distinguishable from here — so the entry says so rather
   *     than picking one.
   *   - the controller believes a DIFFERENT session for that dispatch → the same
   *     reason, because from this node's side the session it was told about is the
   *     one it cannot account for. Two live sessions for one dispatch is the
   *     duplicate-work defect; both are left running and the difference is marked,
   *     because only someone who can see both nodes can say which one to stop.
   *
   * A read that FAILS refuses the whole pass rather than reporting the rest as
   * converged. A diff that skipped one unreadable dispatch and said "converged" for
   * everything else would be a clean bill of health for the part of the inventory
   * nobody looked at, and the operator reading it has no way to know.
   */
  async #compareInventory(
    request: MeshReconciliationRequest,
    scope: LeaseScope,
  ): Promise<Result<readonly UnreconciledEntry[]>> {
    const entries: UnreconciledEntry[] = []
    for (const reported of request.activeSessionInventory) {
      const dispatch = dispatchIdSchema.safeParse(reported.dispatchId)
      if (!dispatch.success) {
        return {
          ok: false,
          error: createContractError(
            "validation",
            "mesh.reconcile_dispatch_unreadable",
            `The reconciliation inventory names dispatch '${reported.dispatchId}', which is not a well-formed mesh dispatch id. Step 5 cannot compare a session against a dispatch it cannot name, and the whole pass is refused rather than reported as converged for the inventory it did read.`,
          ),
        }
      }
      const expected = await this.#deps.projections.sessionForDispatch(scope, dispatch.data)
      if (!expected.ok) return expected
      if (expected.value === null || expected.value !== reported.sessionId) {
        entries.push({
          nodeId: request.peerNodeId,
          reason: "session_not_in_projection",
          detail: this.#describeMismatch(reported, expected.value, dispatch.data),
        })
      }
    }
    return { ok: true, value: entries }
  }

  #describeMismatch(
    reported: { readonly sessionId: string; readonly dispatchId: string },
    expected: string | null,
    dispatch: string,
  ): string {
    if (expected === null) {
      return `Peer reports session '${reported.sessionId}' for dispatch '${dispatch}', and this node's dispatch projections record no session for that dispatch. A running session with no recorded dispatch is either a partition that lost the proposal or work this node did not authorise; reconciliation marks it for review and does not resolve it.`
    }
    return `Dispatch '${dispatch}' is recorded as having produced session '${expected}', but the peer reports '${reported.sessionId}' for it. Two live sessions for one dispatch is the duplicate-work defect; both are left running and the difference is marked, because only someone who can see both nodes can say which one to stop.`
  }

  async #fallbackFor(scope: LeaseScope): Promise<Result<{ readonly snapshotFallback: NonNullable<MeshReconciliationResponse["snapshotFallback"]> } | null>> {
    if (this.#deps.snapshots === undefined) return { ok: true, value: null }
    const rebase = await this.#deps.snapshots.fallbackFor(scope)
    if (!rebase.ok) return rebase
    return { ok: true, value: rebase.value === null ? null : { snapshotFallback: rebase.value.snapshotFallback } }
  }
}

/**
 * The outcome, and the rule that decides it.
 *
 * `degraded` when there is a difference, because the peer's view and this node's
 * disagree and a caller that reads `converged` there stops reconciling. Otherwise
 * `snapshot_required` when a re-base is attached — the peer is behind and is being
 * told exactly where to resume from — and `converged` when there is nothing to say.
 *
 * The third case is `converged` and NOT `degraded` when no re-base is attached, and
 * that is a deliberate limit rather than an oversight: a node with no
 * `SnapshotFallbackSource` wired cannot know whether it HAS a snapshot, and a policy
 * that answered `degraded` for a node that has not finished M4-S would train an
 * operator to read `degraded` as "this deployment is incomplete". A node that HAS the
 * source and finds it empty does report `degraded` — that one knows.
 */
function outcomeFor(differences: number, snapshotAttached: boolean): "converged" | "degraded" | "snapshot_required" {
  if (differences > 0) return "degraded"
  if (snapshotAttached) return "snapshot_required"
  return "converged"
}

/**
 * The scope, re-parsed.
 *
 * `null` rather than a partial scope: a request whose project id is unreadable and
 * whose run id is not is still a request about a run, and answering it with the
 * half that parsed would be answering about a run nobody named.
 */
function scopeOf(request: MeshReconciliationRequest): LeaseScope | null {
  const projectId = projectIdSchema.safeParse(request.projectId)
  if (!projectId.success) return null
  const runId = runIdSchema.safeParse(request.runId)
  if (!runId.success) return null
  return { projectId: projectId.data, runId: runId.data }
}

/**
 * An empty-but-well-formed response, used only to walk steps 1–3.
 *
 * `outcome: "converged"` with empty lists is VALID here precisely because the
 * verdict it produces is a GATE and not an answer: the caller re-walks the
 * evaluator over the real response afterwards, and that second walk is what the
 * caller is handed. A scaffold that claimed `degraded` here would put a difference
 * count of zero on the record as an answer.
 */
function scaffoldResponse(request: MeshReconciliationRequest, acceptedControllerEpoch: number): MeshReconciliationResponse {
  return {
    reconcileId: request.reconcileId,
    outcome: "converged",
    acceptedControllerEpoch,
    resendCommandIds: [],
    resendEventIds: [],
    unreconciled: [],
  }
}

function refusal(
  failedStep: 1 | 2 | 3 | null,
  steps: readonly ReconciliationStepVerdict[],
  error: ContractError,
): ReconcileOutcome {
  return { ok: false, failedStep, steps, error }
}

export type { ReconcileOutcome }

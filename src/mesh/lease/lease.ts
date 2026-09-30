import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { CURRENT_SCHEMA_VERSION, type NodeId } from "../../orchestration/identifiers.js"
import { validateEpochMonotonicity } from "../../orchestration/invariants.js"
import { evaluateLease, permitsNewWork, type LeaseOperation, type MeshLease } from "../protocol/lease.js"
import { safeParseMeshEnvelope } from "../protocol/registry.js"
import { heldLeaseOf, leaseRecordSchema, type LeaseRecord, type LeaseScope } from "./schemas.js"
import type {
  ControllerLease,
  ControllerLeaseDependencies,
  LeaseOperationOutcome,
  NewWorkPermit,
  UnreconciledNodeSource,
} from "./types.js"

/**
 * M4.4 — the controller lease, and the only operations that may raise an epoch.
 *
 * This module deliberately re-implements NOTHING from
 * `src/mesh/protocol/lease.ts`. Every question about whether a lease record is
 * admissible is answered by `evaluateLease`; every question about whether new work
 * is permitted is answered by `permitsNewWork`; every question about whether a
 * takeover raised the epoch far enough is answered by `validateEpochMonotonicity`
 * from the kernel. What is added here is the three things a protocol package
 * cannot have:
 *
 *   1. **Storage.** The protocol package is pure by design (§1 of the spec), so
 *      it cannot answer "what does this node actually hold?".
 *   2. **A compare-and-set on the write.** `evaluateLease` decides admissibility
 *      against a lease the CALLER passed in. Between that read and the write, the
 *      epoch can move, and the window is exactly the width of one partition. The
 *      store's `expectedEpoch` closes it, and the loser of that race is told
 *      which epoch beat it.
 *   3. **A NAMED SURFACE with exactly one epoch-raising operation.** The plan's
 *      guardrail is "do not implement auto-election, quorum, gossip, or
 *      consensus", and a guardrail against something that is ABSENT is only
 *      checkable against a surface a reader can enumerate. `claim`, `renew`,
 *      `release` and `takeover` are methods, not string constants, and only
 *      `takeover` can move the epoch.
 *
 * There is nothing here that restates a protocol rule. That was once untrue: this
 * directory carried its own "a takeover needs something to take over FROM" guard
 * because `evaluateLease` skipped the predecessor comparison when no lease was
 * held, and the split-brain model test found what that admitted. The rule now
 * lives in `evaluateLease` — where it is one copy rather than two, and where a
 * pure caller is fenced too — and the seam below simply forwards its refusal.
 *
 * The consequence of (3) is the property `split-brain.test.ts` asserts: there is
 * no code path from "a node wants to drive this run" to "the epoch is higher"
 * other than a user-initiated takeover that names the lease it fences and carries
 * the user's acknowledgement of the nodes that have not been reconciled.
 */

/** The unreconciled set for a run, as this node last established it. */
class InMemoryUnreconciledNodeSource implements UnreconciledNodeSource {
  readonly #byRun = new Map<string, readonly NodeId[]>()

  unreconciledNodeIds(scope: LeaseScope): readonly NodeId[] {
    return this.#byRun.get(keyOf(scope)) ?? []
  }

  set(scope: LeaseScope, nodeIds: readonly NodeId[]): void {
    this.#byRun.set(keyOf(scope), Object.freeze([...nodeIds]))
  }
}

function keyOf(scope: LeaseScope): string {
  return `${scope.projectId} ${scope.runId}`
}

export class MeshControllerLease implements ControllerLease {
  readonly #store: ControllerLeaseDependencies["store"]
  readonly #unreconciled: ControllerLeaseDependencies["unreconciled"]
  readonly #now: () => number

  constructor(dependencies: ControllerLeaseDependencies) {
    this.#store = dependencies.store
    this.#unreconciled = dependencies.unreconciled
    this.#now = dependencies.now
  }

  async claim(value: unknown): Promise<LeaseOperationOutcome> {
    return this.#apply("claim", value)
  }

  async renew(value: unknown): Promise<LeaseOperationOutcome> {
    return this.#apply("renew", value)
  }

  async release(value: unknown): Promise<LeaseOperationOutcome> {
    return this.#apply("release", value)
  }

  async takeover(value: unknown): Promise<LeaseOperationOutcome> {
    return this.#apply("takeover", value)
  }

  /**
   * The single entry point. Every named operation funnels here.
   *
   * The `expected` argument is what makes the named methods worth having: a
   * caller that reaches `takeover()` with a record whose `operation` says `renew`
   * is refused, so a switch statement on the operation in a gateway cannot be the
   * thing that decides which rules applied.
   */
  async applyLease(value: unknown): Promise<LeaseOperationOutcome> {
    return this.#apply(null, value)
  }

  async lease(scope: LeaseScope): Promise<Result<LeaseRecord | null>> {
    return this.#store.activeLease(scope)
  }

  async heldLease(scope: LeaseScope) {
    const found = await this.#store.activeLease(scope)
    if (!found.ok) return found
    return { ok: true as const, value: found.value === null ? null : heldLeaseOf(found.value) }
  }

  async permitsNewWork(scope: LeaseScope): Promise<Result<NewWorkPermit>> {
    const found = await this.#store.activeLease(scope)
    if (!found.ok) return found
    const record = found.value
    // `permitsNewWork` decides, from the lease in force and the injected clock.
    // The record is re-read here purely so the caller can see WHICH lease the
    // answer came from, because "no new work" without the lease it was decided
    // from is not an answer an operator can act on. The narrowing is spelled out
    // rather than inferred so that a fourth case added to the protocol evaluator
    // becomes a compile error here instead of a silently mislabelled permit.
    const verdict = permitsNewWork(record === null ? null : heldLeaseOf(record), this.#now())
    if (verdict.permitted) {
      // `permitted: true` with no record is unreachable — `permitsNewWork` needs a
      // lease to be current — but the narrowing is written so that if the protocol
      // evaluator ever grew a fourth case, this becomes a compile error here rather
      // than a permit handed out with a null lease attached to it.
      if (record === null) {
        return {
          ok: false,
          error: createContractError(
            "internal_failure",
            "lease.permit_without_lease",
            "The lease evaluator reported the lease as current while this node read no lease at all. The two disagree, and a permit with no lease behind it is not a permit.",
          ),
        }
      }
      return { ok: true, value: { permitted: true, reason: "current", lease: record } }
    }
    // `permitsNewWork` returns a plain object rather than a discriminated union, so
    // narrowing on `permitted` alone leaves `reason` un-narrowed. The two
    // assertions below are therefore explicit: a `current` reason reported with
    // `permitted: false` is the evaluator contradicting itself, and forwarding it
    // would put a `current` label on a refusal in an operator-facing view.
    if (verdict.reason === "current") {
      return {
        ok: false,
        error: createContractError(
          "internal_failure",
          "lease.permit_contradiction",
          "The lease evaluator reported the lease as current and as not permitting new work. The two cannot both be true, and this seam refuses rather than pick one for the operator.",
        ),
      }
    }
    return { ok: true, value: { permitted: false, reason: verdict.reason, lease: record } }
  }

  setUnreconciledNodeIds(scope: LeaseScope, nodeIds: readonly NodeId[]): void {
    if (this.#unreconciled instanceof InMemoryUnreconciledNodeSource) {
      this.#unreconciled.set(scope, nodeIds)
      return
    }
    // A caller that supplied its own `UnreconciledNodeSource` owns the write. The
    // port is read-only BY DESIGN (see `./types.js`), so there is nothing to fail
    // here and nothing to pretend: the seam either has the local set or it does
    // not, and a second write path would be a second source of truth about which
    // nodes a user has been shown.
    return
  }

  async #apply(expected: LeaseOperation | null, value: unknown): Promise<LeaseOperationOutcome> {
    // Parsed through the ONE entry point, here rather than by the caller, for the
    // same reason `MeshNodeRegistry.recordHeartbeat` does it: handing out a
    // "pre-parsed payload" parameter would make every gateway a second parse site,
    // and the whole of M4-V is that there is one.
    const parsed = safeParseMeshEnvelope(value)
    if (!parsed.ok) return unreadable(parsed.error)
    const envelope = parsed.value
    if (envelope.recordType !== "mesh.lease") {
      return unreadable(
        createContractError(
          "validation",
          "lease.not_a_lease",
          `Expected a mesh.lease and received '${envelope.recordType}'. The lease seam evaluates lease records and nothing else; a command offered here is a caller wiring defect, not a record this seam should interpret.`,
        ),
      )
    }

    const lease = envelope.payload
    if (expected !== null && lease.operation !== expected) {
      return unreadable(
        createContractError(
          "validation",
          "lease.operation_mismatch",
          `The lease seam was asked for a '${expected}' and the record is a '${lease.operation}'. A takeover routed through the claim path would be evaluated under the claim's rules, which are not the takeover's.`,
        ),
        lease.operation,
      )
    }

    // SCOPE, resolved from the RECORD rather than trusted from the payload. The
    // ids come back out of the envelope, so a caller that passed a record for
    // another run gets a refusal naming that run instead of a lease silently
    // filed under the wrong one.
    const scope = { projectId: lease.projectId, runId: lease.runId }
    const stored = await this.#store.activeLease(scope)
    if (!stored.ok) return stored as unknown as LeaseOperationOutcome
    const current = stored.value

    // The rules. `evaluateLease` decides admissibility, expiry standing, the
    // user-inspection precondition and the epoch comparison, all four. It is
    // called with this node's OWN unreconciled set — never the record's — so the
    // acknowledgement is checked against a fact and not against the claimant's own
    // list, which is the recorded-log rule applied to the one field whose whole
    // purpose is to be an assertion about what a human saw.
    const evaluation = evaluateLease(lease, {
      held: current === null ? null : heldLeaseOf(current),
      unreconciledNodeIds: this.#unreconciled.unreconciledNodeIds(scope),
      nowMs: this.#now(),
    })
    if (evaluation.outcome === "refused") {
      return {
        outcome: "refused",
        operation: evaluation.role,
        reason: evaluation.reason,
        standing: evaluation.standing,
        error: evaluation.error,
      }
    }

    const record = this.#toRecord(lease, scope)
    if (record === null) return unreadable(invalidRecord(lease, scope))

    // A second, INDEPENDENT epoch check before the write, and only when there IS
    // a lease in force — `validateEpochMonotonicity` requires a positive
    // `currentEpoch` and has no representation for "no lease yet", which is a
    // first claim. That case is fenced differently and correctly: the store's
    // `expectedEpoch: null` refuses the write unless the run is still unleased.
    //
    // `evaluateLease` already decided the epoch is admissible, so this cannot
    // refuse anything it accepted. It exists because the write below is where a
    // stale controller's record would actually LAND, and the rule that a takeover
    // must strictly increase the epoch is the KERNEL's
    // (`validateEpochMonotonicity`), not this directory's restatement of it. A
    // renewal and an expired-claim legitimately carry the SAME epoch, which is
    // what `allowSameEpoch` says.
    const monotonic =
      current === null
        ? null
        : validateEpochMonotonicity(current.epoch, record.epoch, {
            allowSameEpoch: record.operation !== "takeover",
          })
    if (monotonic !== null && !monotonic.ok) {
      return {
        outcome: "refused",
        operation: record.operation,
        reason: record.operation === "takeover" ? "epoch_not_increasing" : "epoch_stale",
        standing: evaluation.standing,
        error: monotonic.error,
      }
    }

    const written = await this.#store.writeLease({
      scope,
      record,
      // The compare-and-set. `null` means "there must still be no lease for this
      // run": the first claim and every later write go through one statement, and
      // the path for "no previous lease" is the one nobody would otherwise test.
      expectedEpoch: current?.epoch ?? null,
    })
    if (!written.ok) return written as unknown as LeaseOperationOutcome
    if (!written.value.written) {
      return {
        outcome: "write_lost",
        operation: record.operation,
        current: written.value.current,
        error: createContractError(
          "conflict",
          "lease.write_lost",
          `A '${record.operation}' for run ${scope.runId} at epoch ${record.epoch} was NOT applied: the lease moved from epoch ${current?.epoch ?? "(none)"} to ${written.value.current?.epoch ?? "(none)"} between this node's read and its write. Another controller is ahead; re-read the lease and decide again. Nothing was written.`,
        ),
      }
    }

    return {
      outcome: "accepted",
      operation: record.operation,
      standing: evaluation.standing,
      // Straight from the evaluator, so a `release` reports `false` here rather
      // than being normalised into "accepted, and you may now create work".
      permitsNewWork: evaluation.permitsNewWork,
      lease: written.value.lease,
    }
  }

  /**
   * The stored form of an accepted record.
   *
   * `unreconciledNodeIds` is filled from THIS node's own reconciliation rather
   * than from the record, which is the only way the audit trail can answer "was
   * the user actually shown these nodes" — the record carries the answer the user
   * gave, and nothing carries the question that was asked.
   */
  #toRecord(lease: MeshLease, scope: LeaseScope): LeaseRecord | null {
    const candidate = leaseRecordSchema.safeParse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      leaseId: lease.leaseId,
      projectId: lease.projectId,
      runId: lease.runId,
      controllerNodeId: lease.controllerNodeId,
      epoch: lease.epoch,
      operation: lease.operation,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt,
      durationSeconds: lease.durationSeconds,
      predecessorLeaseId: lease.predecessorLeaseId ?? null,
      predecessorEpoch: lease.predecessorEpoch ?? null,
      takeoverReason: lease.takeoverReason ?? null,
      acknowledgedUnreconciledNodeIds: [...lease.acknowledgedUnreconciledNodeIds],
      unreconciledNodeIds: [...this.#unreconciled.unreconciledNodeIds(scope)],
      recordedAt: this.#now(),
    })
    if (!candidate.success) return null
    // Scope is re-asserted here rather than only in the schema, because the schema
    // cannot know that the record is about to be filed under a scope the CALLER
    // chose. The store checks it too; asserting it at construction is what stops
    // the mismatch from being built in the first place.
    if (candidate.data.projectId !== scope.projectId || candidate.data.runId !== scope.runId) return null
    return Object.freeze(candidate.data)
  }
}

function unreadable(error: ContractError, operation: LeaseOperation | null = null): LeaseOperationOutcome {
  return {
    outcome: "refused",
    operation,
    reason: "record_unreadable",
    standing: "none",
    error,
  }
}

function invalidRecord(lease: MeshLease, scope: LeaseScope) {
  return createContractError(
    "validation",
    "lease.record_not_storable",
    `The accepted lease '${lease.leaseId}' for ${scope.projectId}/${scope.runId} does not satisfy leaseRecordSchema. It was admissible under the wire schema and is not storable, which means the two shapes disagree about this record; nothing was written.`,
  )
}

/**
 * A ready-made unreconciled source for callers that have no reconciliation yet.
 *
 * Exported so a controller that has not implemented M4.6 does not have to
 * implement the port with a stub, AND so the limitation is visible at the import
 * site: with this source the set is always empty, which means the takeover's
 * user-inspection precondition is decided entirely by the CONTROLLER performing
 * the takeover. That is correct — only the node the user was sitting at knows what
 * was on their screen — and it is also the reason a worker's copy of the set must
 * never be populated from a wire record.
 */
export function createEmptyUnreconciledNodeSource(): ControllerLeaseDependencies["unreconciled"] {
  return new InMemoryUnreconciledNodeSource()
}

export function createUnreconciledNodeSource(): {
  readonly source: ControllerLeaseDependencies["unreconciled"]
  set(scope: LeaseScope, nodeIds: readonly NodeId[]): void
} {
  const source = new InMemoryUnreconciledNodeSource()
  return { source, set: (scope, nodeIds) => source.set(scope, nodeIds) }
}

export { InMemoryUnreconciledNodeSource }

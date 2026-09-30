import { z } from "zod"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import {
  epochSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  timestampSchema,
  type Epoch,
  type LeaseId,
  type NodeId,
  type ProjectId,
  type RunId,
  type Timestamp,
} from "../../orchestration/identifiers.js"
import { defineFamily, sameId } from "./envelope.js"
import { ARRAY_MAX } from "./identifiers.js"

/**
 * `mesh.lease` — who may create new work for a run, and until when.
 *
 * The lease is run-scoped and epoch-scoped, and the epoch is the ONLY thing
 * that orders controllers. There is no election, no quorum and no gossip: a
 * higher epoch is accepted through an explicit, user-initiated `takeover` and
 * through nothing else. That single rule is what makes the split-brain scenario
 * decidable — at most one controller can mint work for a run, and the test that
 * proves it is a partition matrix rather than a timing observation.
 *
 * Expiry stops NEW work and does not stop running agents. That asymmetry is
 * written into the guardrail list precisely because the intuitive reading is the
 * wrong one: killing agents because a controller vanished would destroy work
 * whose only remaining record is the agent itself.
 *
 * **Error codes are the kernel's, not a second vocabulary.** `validateCommandLease`
 * in `src/orchestration/invariants.ts` is frozen by the M0 contract digest and
 * spells these same three facts `epoch.stale`, `epoch.unregistered` and
 * `lease.expired`; this module, `command-gate.ts`, `command.ts` and
 * `reconciliation.ts` used to spell them `stale_epoch.epoch.stale`,
 * `conflict.epoch.unregistered` and `stale_epoch.lease_expired`. Two spellings of
 * one fact mean a caller that reaches the kernel function directly — which is what
 * every non-mesh caller does — sorts, alerts and dashboards on strings the mesh
 * never emits, and an alert keyed on an error code is exactly the thing that stops
 * matching during an incident. The mesh conforms to the kernel: the `category`
 * field already carries `stale_epoch` / `conflict`, so repeating it as a code
 * prefix bought nothing and cost a vocabulary.
 */

const MAX_DURATION_SECONDS = 86_400

export const LEASE_OPERATIONS = ["claim", "renew", "release", "takeover"] as const
export type LeaseOperation = (typeof LEASE_OPERATIONS)[number]

export const meshLeaseSchema = z
  .object({
    leaseId: leaseIdSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    controllerNodeId: nodeIdSchema,
    epoch: epochSchema,
    operation: z.enum(LEASE_OPERATIONS),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    durationSeconds: z.number().int().positive().max(MAX_DURATION_SECONDS).safe(),
    predecessorLeaseId: leaseIdSchema.optional(),
    predecessorEpoch: epochSchema.optional(),
    takeoverReason: z.string().min(1).max(4_096).optional(),
    /**
     * The record of the user's inspection of unreconciled nodes.
     *
     * Named `acknowledged...` rather than `inspected...` because it is the
     * operative fact: the user has been shown these nodes and has accepted them
     * as degraded, or waited for them. A bare list of inspected node ids with no
     * consequence would be a log line; this list is the precondition the
     * evaluation below refuses without.
     */
    acknowledgedUnreconciledNodeIds: z.array(nodeIdSchema).max(ARRAY_MAX),
  })
  .strict()
  .superRefine((lease, ctx) => {
    const issued = Date.parse(lease.issuedAt)
    const expires = Date.parse(lease.expiresAt)
    if (expires <= issued) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Lease expiry must be strictly later than issue time" })
    } else if (Math.round((expires - issued) / 1000) !== lease.durationSeconds) {
      // `durationSeconds` is the field a renewing controller schedules against,
      // and the field a reader reasons about. If it can disagree with the
      // timestamps, a caller that trusts it will believe a lease lasts longer
      // than it does — and believing that is how two controllers end up
      // creating work for the same run.
      ctx.addIssue({
        code: "custom",
        path: ["durationSeconds"],
        message: `durationSeconds ${lease.durationSeconds} disagrees with the ${(expires - issued) / 1000}s implied by issuedAt/expiresAt`,
      })
    }

    if (lease.operation === "takeover") {
      if (lease.predecessorLeaseId === undefined) {
        ctx.addIssue({ code: "custom", path: ["predecessorLeaseId"], message: "A takeover must name the lease it supersedes; an unnamed predecessor cannot be fenced" })
      }
      if (lease.predecessorEpoch === undefined) {
        ctx.addIssue({ code: "custom", path: ["predecessorEpoch"], message: "A takeover must name the epoch it supersedes, so the fencing comparison has a left-hand side" })
      }
      if (lease.takeoverReason === undefined) {
        ctx.addIssue({ code: "custom", path: ["takeoverReason"], message: "A takeover must record why the user moved control; the reason is what an audit reads later" })
      }
    } else {
      if (lease.predecessorLeaseId !== undefined) {
        ctx.addIssue({ code: "custom", path: ["predecessorLeaseId"], message: "Only a takeover supersedes a predecessor; a renewal that names one is a takeover wearing the wrong operation" })
      }
      if (lease.predecessorEpoch !== undefined) {
        ctx.addIssue({ code: "custom", path: ["predecessorEpoch"], message: "Only a takeover supersedes a predecessor epoch" })
      }
      if (lease.takeoverReason !== undefined) {
        ctx.addIssue({ code: "custom", path: ["takeoverReason"], message: "Only a takeover carries a takeover reason" })
      }
      if (lease.acknowledgedUnreconciledNodeIds.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["acknowledgedUnreconciledNodeIds"],
          message: "Acknowledging unreconciled nodes is a takeover precondition; on a claim or a renewal it is an unexplained list of node ids",
        })
      }
    }

    const unique = new Set(lease.acknowledgedUnreconciledNodeIds)
    if (unique.size !== lease.acknowledgedUnreconciledNodeIds.length) {
      ctx.addIssue({ code: "custom", path: ["acknowledgedUnreconciledNodeIds"], message: "Acknowledged node ids must be unique" })
    }
  })

export const leaseFamily = defineFamily({
  recordType: "mesh.lease",
  payloadSchema: meshLeaseSchema,
  refine: (envelope, ctx) => {
    if (!sameId(envelope.senderNodeId, envelope.payload.controllerNodeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["senderNodeId"],
        message: `A lease is sent by the controller claiming it; '${envelope.senderNodeId}' cannot claim '${envelope.payload.controllerNodeId}'`,
      })
    }
  },
})

export type MeshLease = z.infer<typeof meshLeaseSchema>
export type MeshLeaseEnvelope = z.infer<typeof leaseFamily.envelopeSchema>

// --- Evaluation ----------------------------------------------------------

/** The lease this node currently holds, if any. */
export interface HeldLease {
  readonly leaseId: LeaseId
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly controllerNodeId: NodeId
  readonly epoch: Epoch
  readonly expiresAt: Timestamp
}

export interface LeaseEvaluationContext {
  /** The lease currently in force, or null if the node holds none. */
  readonly held: HeldLease | null
  /**
   * Nodes whose state has not been reconciled, from the most recent
   * reconciliation. A takeover offered while this is non-empty must have
   * acknowledged every id in it.
   */
  readonly unreconciledNodeIds: readonly NodeId[]
  /** Caller-supplied clock reading in epoch milliseconds. */
  readonly nowMs: number
}

/**
 * The answer, always with a reason.
 *
 * `outcome` is the verdict on THIS record; `standing` is the verdict on the
 * lease already in force. They are separate axes because they fail separately:
 * a `takeover` can be refused because the incoming epoch is stale (this record
 * is wrong) while the held lease is perfectly current (this node is fine), and
 * collapsing the two would tell the caller to go looking at the wrong object.
 */
export type LeaseEvaluation =
  | {
      readonly outcome: "accepted"
      readonly role: LeaseOperation
      /** Whether the lease in force is live at `nowMs`. */
      readonly standing: "current" | "expired" | "none"
      /** Whether this record, once accepted, permits NEW work. */
      readonly permitsNewWork: boolean
      readonly epoch: Epoch
      readonly leaseId: LeaseId
      readonly expiresAt: Timestamp
    }
  | {
      readonly outcome: "refused"
      readonly role: LeaseOperation
      readonly reason: LeaseRefusalReason
      readonly standing: "current" | "expired" | "none"
      readonly error: ContractError
    }

export const LEASE_REFUSAL_REASONS = [
  "epoch_stale",
  "epoch_unregistered",
  "epoch_not_increasing",
  "predecessor_mismatch",
  "unreconciled_nodes_not_acknowledged",
  "renewal_after_expiry",
  "lease_scope_mismatch",
  "controller_mismatch",
  "held_by_another_controller",
  "no_lease_to_renew",
  "no_lease_to_release",
  "no_lease_to_fence",
] as const

export type LeaseRefusalReason = (typeof LEASE_REFUSAL_REASONS)[number]

function refused(
  role: LeaseOperation,
  reason: LeaseRefusalReason,
  standing: "current" | "expired" | "none",
  category: Parameters<typeof createContractError>[0],
  code: string,
  message: string,
): LeaseEvaluation {
  return { outcome: "refused", role, reason, standing, error: createContractError(category, code, message) }
}

/**
 * Decides what an incoming `mesh.lease` record does, given the lease in force.
 *
 * Every question the milestone asks about a lease is answered here, and none of
 * them is answered by a boolean:
 *
 *   - is the lease in force current?          → `standing`
 *   - has it expired?                         → `standing: "expired"`
 *   - is this a valid takeover?               → there is a lease to fence AND it
 *                                                is the one named AND the epoch
 *                                                is strictly higher AND every
 *                                                unreconciled node is acknowledged
 *   - did a renewal arrive in time?           → `renewal_after_expiry`
 *
 * Expiry grants `permitsNewWork: false` and says nothing about running agents.
 * That is the plan guardrail "do not terminate agents because a controller or
 * network disappeared", and it is why this function returns no field, no code
 * and no variant that could be read as "stop the sessions": there is nothing to
 * read.
 *
 * The order of the checks is: scope → predecessor → epoch → the operation's own
 * precondition. Epoch comes before the operation's precondition so that a stale
 * renewal is reported as stale rather than as "renewed the wrong lease", and
 * both come before the expiry test so that a record which is wrong in two ways
 * reports the one that is about AUTHORITY, which is the one that decides
 * whether this node is under attack.
 */
export function evaluateLease(lease: MeshLease, context: LeaseEvaluationContext): LeaseEvaluation {
  const held = context.held
  const standing: "current" | "expired" | "none" = held === null ? "none" : context.nowMs < Date.parse(held.expiresAt) ? "current" : "expired"

  // Scope first: a lease for another run is not a lease for this one, and
  // comparing epochs across runs is meaningless.
  if (held !== null) {
    if (!sameId(lease.projectId, held.projectId) || !sameId(lease.runId, held.runId)) {
      return refused(
        lease.operation,
        "lease_scope_mismatch",
        standing,
        "validation",
        "lease.scope_mismatch",
        `Lease covers ${lease.projectId}/${lease.runId}; the lease in force covers ${held.projectId}/${held.runId}`,
      )
    }
  }

  if (lease.operation === "takeover") {
    // A takeover asserts "I am replacing THIS authority", so it is only a claim
    // about anything at a node that holds one. Skipping this comparison when
    // `held` is null — which is what this function used to do — made the epoch in
    // a takeover an UNBACKED ASSERTION at every node that knows nothing about the
    // run, and the partition matrix turned that into the plan's stop condition: a
    // controller cut off from the run broadcasts a takeover, the nodes holding the
    // real lease refuse it because the predecessor does not match, the nodes
    // holding nothing accept it, and the mesh ends with one controller per worker
    // and TWO controllers driving one run.
    //
    // The operational cost of refusing is real and is stated rather than hidden: a
    // node that lost its lease store cannot be brought onto a new epoch by a
    // takeover until reconciliation re-delivers the lease, and the remedy for a
    // run nobody has ever leased is a `claim` — the operation that means "I am
    // starting". Failing closed on an authority decision is the right direction
    // even when the recovery path costs a round trip, because the alternative is a
    // run with two controllers.
    if (held === null) {
      return refused(
        "takeover",
        "no_lease_to_fence",
        standing,
        "conflict",
        "lease.no_lease_to_fence",
        `Takeover claims epoch ${lease.epoch} for ${lease.projectId}/${lease.runId}, naming predecessor '${lease.predecessorLeaseId ?? "(none)"}' at epoch ${lease.predecessorEpoch ?? "(none)"} — but this node holds no lease for that run, so it has nothing to fence. A takeover says "I am replacing this authority"; a node that knows of no authority cannot say that, and admitting it here would let a controller that was never told about the run seize it at any epoch. Drive an unheld run with a claim, which is the operation that means "I am starting".`,
      )
    }
    // A takeover must name the lease it fences. Without the predecessor there is
    // nothing to compare against, and a takeover that could omit the predecessor
    // would be a way to seize a run by asserting a high epoch alone.
    if (lease.predecessorLeaseId === undefined || !sameId(lease.predecessorLeaseId, held.leaseId)) {
      return refused(
        "takeover",
        "predecessor_mismatch",
        standing,
        "conflict",
        "lease.predecessor_mismatch",
        `Takeover names predecessor '${lease.predecessorLeaseId ?? "(none)"}' but the lease in force is '${held.leaseId}'`,
      )
    }
    // Narrowed to non-null by the refusal above, so the comparison has a
    // left-hand side in every branch that can reach it.
    if (lease.predecessorEpoch !== held.epoch) {
      return refused(
        "takeover",
        "predecessor_mismatch",
        standing,
        "conflict",
        "lease.predecessor_mismatch",
        `Takeover names predecessor epoch ${lease.predecessorEpoch} but the epoch in force is ${held.epoch}`,
      )
    }
  }

  // Epoch. A LOWER epoch is stale and a HIGHER one is unregistered. Both are
  // refusals and neither is "accept it and sort it out later": the plan
  // guardrail is explicit that a higher epoch is only ever accepted through the
  // explicit takeover flow, so a `claim` or a `renew` that carries a higher
  // epoch is exactly the automatic election this milestone forbids.
  const epochRefusal = checkEpoch(lease, held, standing)
  if (epochRefusal !== null) {
    const [reason, category, code, message] = epochRefusal
    return refused(lease.operation, reason, standing, category, code, message)
  }

  // Operation preconditions.
  switch (lease.operation) {
    case "claim": {
      // Nothing left to decide here, and that is deliberate. A claim that would
      // displace a LIVE lease is refused by `checkEpoch` above — same epoch while
      // current is `held_by_another_controller` / `lease.already_held`, and a
      // higher one is `epoch_unregistered` — so a second copy of that rule below
      // this switch could only ever be unreachable code, and a second copy of a
      // rule is a second thing to keep in step with the first.
      break
    }
    case "renew": {
      if (held === null) {
        // Its own reason rather than the release's: a renewal failed to RENEW, and
        // an operator reading `no_lease_to_release` has to work out that the word
        // "release" was not the operation they performed. The distinction decides
        // the next action too — nothing was given up here, something was lost.
        return refused(
          "renew",
          "no_lease_to_renew",
          standing,
          "conflict",
          "lease.none_held",
          `Controller '${lease.controllerNodeId}' renews a lease it does not hold`,
        )
      }
      if (!sameId(lease.leaseId, held.leaseId)) {
        return refused(
          "renew",
          "predecessor_mismatch",
          standing,
          "conflict",
          "lease.mismatched",
          `Renewal names lease '${lease.leaseId}' but the lease in force is '${held.leaseId}'`,
        )
      }
      if (standing === "expired") {
        return refused(
          "renew",
          "renewal_after_expiry",
          standing,
          "stale_epoch",
          "lease.expired",
          `Renewal for lease '${held.leaseId}' arrived after it expired at ${held.expiresAt}. A lease that has expired must be re-claimed or taken over, not renewed: renewing it would resurrect authority nobody fenced.`,
        )
      }
      break
    }
    case "release": {
      if (held === null) {
        return refused(
          "release",
          "no_lease_to_release",
          standing,
          "conflict",
          "lease.none_held",
          `Controller '${lease.controllerNodeId}' releases a lease it does not hold`,
        )
      }
      if (!sameId(lease.leaseId, held.leaseId)) {
        return refused(
          "release",
          "predecessor_mismatch",
          standing,
          "conflict",
          "lease.mismatched",
          `Release names lease '${lease.leaseId}' but the lease in force is '${held.leaseId}'`,
        )
      }
      break
    }
    case "takeover": {
      // The user-inspection precondition. Refused with the node ids named, so
      // the operator can be shown exactly what they have not looked at yet
      // rather than being told "there are some".
      const missing = context.unreconciledNodeIds.filter(
        (nodeId) => !lease.acknowledgedUnreconciledNodeIds.some((acknowledged) => sameId(acknowledged, nodeId)),
      )
      if (missing.length > 0) {
        return refused(
          "takeover",
          "unreconciled_nodes_not_acknowledged",
          standing,
          "policy_denied",
          "lease.takeover_unreconciled",
          `Takeover acknowledges [${lease.acknowledgedUnreconciledNodeIds.join(", ")}] but ${missing.length} unreconciled node(s) remain: [${missing.join(", ")}]. The user must inspect them and accept them as degraded, or wait for them.`,
        )
      }
      break
    }
  }

  return {
    outcome: "accepted",
    role: lease.operation,
    standing,
    // A `release` is accepted but grants nothing: after it, no controller may
    // create new work until someone claims. Reporting it as `true` would let a
    // release read as a renewal.
    permitsNewWork: lease.operation !== "release",
    epoch: lease.epoch,
    leaseId: lease.leaseId,
    expiresAt: lease.expiresAt,
  }
}

/**
 * Returns the refusal triple, or null when the epoch is acceptable.
 *
 * `standing` is a parameter rather than recomputed because the equal-epoch
 * question genuinely depends on it: a claim at the epoch already in force
 * displaces a LIVE lease and is therefore a takeover wearing the wrong
 * operation, while the same claim against an EXPIRED lease is the ordinary way a
 * partitioned run is picked back up. Deciding that without knowing whether the
 * held lease is still current would refuse the recovery path while claiming to
 * be safe.
 *
 * A HIGHER epoch is refused for everything EXCEPT the explicit takeover, which
 * is what the plan guardrail means: there is exactly one operation through which
 * a controller may raise the epoch, and it is the one that names the lease it
 * fences and carries the user's acknowledgement of unreconciled nodes — both
 * checked by the caller before this runs. Refusing the higher epoch for a
 * takeover too would make a takeover impossible, which is the opposite of what
 * "only through the explicit flow" says.
 */
function checkEpoch(
  lease: MeshLease,
  held: HeldLease | null,
  standing: "current" | "expired" | "none",
): [LeaseRefusalReason, Parameters<typeof createContractError>[0], string, string] | null {
  if (held === null) return null
  if (lease.epoch === held.epoch) {
    // Same epoch is legitimate for `renew` and `release` — those are the SAME
    // controller continuing — and never legitimate for `takeover`, whose entire
    // purpose is to move to a strictly higher epoch.
    if (lease.operation === "takeover") {
      return [
        "epoch_not_increasing",
        "conflict",
        "lease.takeover_not_increasing",
        `Takeover claims epoch ${lease.epoch}, which is the epoch already in force. A takeover that does not increase the epoch cannot fence the controller it replaces.`,
      ]
    }
    if (lease.operation === "claim" && standing === "current") {
      return [
        "held_by_another_controller",
        "conflict",
        "lease.already_held",
        `Claim repeats epoch ${lease.epoch} without superseding the lease in force; a claim that does not raise the epoch does not take anything`,
      ]
    }
    return null
  }
  if (lease.epoch < held.epoch) {
    return [
      "epoch_stale",
      "stale_epoch",
      "epoch.stale",
      `Lease claims epoch ${lease.epoch}, below the epoch ${held.epoch} in force. Stale-controller traffic is refused, not queued.`,
    ]
  }
  if (lease.operation === "takeover") return null
  return [
    "epoch_unregistered",
    "conflict",
    "epoch.unregistered",
    `Lease claims epoch ${lease.epoch} above the epoch ${held.epoch} in force via '${lease.operation}'. A higher epoch is only ever accepted through an explicit takeover.`,
  ]
}

export function checkLease(lease: MeshLease, context: LeaseEvaluationContext): Result<MeshLease> {
  const evaluation = evaluateLease(lease, context)
  if (evaluation.outcome === "accepted") return { ok: true, value: lease }
  return { ok: false, error: evaluation.error }
}

/**
 * Whether new work may be created for this run at `nowMs`.
 *
 * Separate from {@link evaluateLease} because the QUESTION is different and is
 * asked at a different place: the lease is evaluated when a lease record
 * arrives, and this is asked by the command seam before every dispatch, retry
 * and policy mutation. An expired lease answers `false` here while leaving every
 * running agent completely untouched.
 */
export function permitsNewWork(held: HeldLease | null, nowMs: number): { readonly permitted: boolean; readonly reason: "no_lease" | "current" | "expired" } {
  if (held === null) return { permitted: false, reason: "no_lease" }
  return nowMs < Date.parse(held.expiresAt) ? { permitted: true, reason: "current" } : { permitted: false, reason: "expired" }
}

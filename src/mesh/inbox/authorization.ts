import { digestDispatchEnvelope } from "../../orchestration/digest.js"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import type {
  ApprovalId,
  Digest,
  DispatchId,
  Epoch,
  LeaseId,
  NodeId,
  ProjectId,
  RunId,
  Timestamp,
} from "../../orchestration/identifiers.js"
import { approvalIdSchema } from "../../orchestration/identifiers.js"
import type { CommandType } from "../../orchestration/invariants.js"
import type { OrchestrationCommand } from "../../orchestration/types.js"
import type { ApprovalState, DispatchState } from "../../orchestration/transitions.js"
import { dispatchIdOf } from "../protocol/command.js"

/**
 * The recorded-log authorization step — Milestone 4's second half of the
 * command seam, and the one the plan quotes verbatim:
 *
 * > **A command is authorized against the recorded log, never against its own
 * > payload.** A caller-supplied approval, dispatch or lease is a *pointer*; the
 * > grant is whatever the event log recorded.
 *
 * M4.4's `MeshCommandEpochGate` already decided the LEASE and the recorded
 * STATES. What it deliberately left unresolved is in `VerifiedIncomingCommand`'s
 * own words: the approval and dispatch ids are carried as `authorizationClaims`,
 * "explicitly unverified", because the protocol layer has no access to the log.
 * This module is the access. It turns those pointers into facts by reading the
 * log, and it is the ONLY place in the mesh that does so.
 *
 * **What it is not.** It is not a second `COMMAND_MATRIX`. The matrix states
 * which LIFECYCLE STATES a command type may act in; M4.4 consults it against
 * recorded state and has done so. What the matrix cannot express — and what the
 * payload could trivially lie about — is whether the approval a payload names
 * EXISTS at all and is still authorized. So this module answers three questions
 * and only three: does the named approval exist, does the named dispatch exist,
 * does the named lease exist, and do the recorded digests of the first two bind
 * to each other and to the envelope that would actually be launched.
 */

/**
 * The approval, as the LOG recorded it.
 *
 * `envelopeDigest` and `state` are the two fields that decide anything. They are
 * read from the log and never from the payload — a payload that carries an
 * `approvalSchema`-valid approval with `state: "approved"` is, for this module,
 * indistinguishable from a payload that carries no approval at all.
 */
export interface RecordedApproval {
  readonly approvalId: ApprovalId
  readonly state: ApprovalState
  readonly decision: "approved" | "rejected"
  readonly envelopeDigest: Digest
  readonly dispatchId: DispatchId
}

/** The dispatch, as the LOG recorded it. `state` is the recorded lifecycle state. */
export interface RecordedDispatch {
  readonly dispatchId: DispatchId
  readonly state: DispatchState
  readonly envelopeDigest: Digest
  readonly projectId: ProjectId
  readonly runId: RunId
}

/** The lease, as the LOG recorded it. The M4.4 lease store is one such reader. */
export interface RecordedLease {
  readonly leaseId: LeaseId
  readonly controllerNodeId: NodeId
  readonly epoch: Epoch
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly expiresAt: Timestamp
}

/**
 * What a payload's pointers resolve to in the log.
 *
 * Deliberately mirrors `VerifiedIncomingCommand.authorizationClaims` field for
 * field. It is a separate type rather than a reuse so that a future edit to the
 * wire's claim shape cannot silently change what this module reads — the two are
 * on opposite sides of the trust boundary, and the whole finding of M3.8 and
 * M4.0 was a type crossing it.
 */
export interface AuthorizationPointers {
  readonly approvalId: string | null
  readonly dispatchId: DispatchId | null
  readonly leaseId: LeaseId
  readonly controllerEpoch: Epoch
  readonly controllerNodeId: NodeId
}

/**
 * The read port.
 *
 * Separate from M4.4's `RecordedCommandStateResolver` on purpose. That port
 * answers "what state is the aggregate in", which is a projection question; this
 * one answers "does this named record exist and what does it say", which is a
 * log question. A controller wiring them to the same reader is fine; a worker
 * reading the LEASE store through this port and the STATES through a projection is
 * the correct arrangement, and nothing here prevents the wrong one because the
 * wrong one is only wrong if it reads the payload — which it cannot.
 */
export interface RecordedLogReader {
  approval(approvalId: ApprovalId): Promise<Result<RecordedApproval | null>>
  dispatch(dispatchId: DispatchId): Promise<Result<RecordedDispatch | null>>
  lease(leaseId: LeaseId): Promise<Result<RecordedLease | null>>
}

/**
 * The decision, with every fact that justified it.
 *
 * Carried on the outcome rather than recomputed by the caller because an audit
 * question — "on what grounds did this node launch?" — has one answer, and a
 * gateway that re-derived it from the payload would be answering with the claim.
 */
export interface RecordedAuthorization {
  readonly commandType: CommandType
  readonly commandId: string
  /** The pointers exactly as the payload stated them. The CLAIM. */
  readonly pointers: AuthorizationPointers
  /** The recorded approval, when one was required and found. */
  readonly approval: RecordedApproval | null
  /** The recorded dispatch, when one was required and found. */
  readonly dispatch: RecordedDispatch | null
  /** The recorded lease, always resolved. A command without one is refused. */
  readonly lease: RecordedLease
  /** The digest the approval and the dispatch were checked against each other on. */
  readonly bindingDigest: Digest | null
}

/**
 * Command types whose payload CREATES the record its approval pointer names.
 *
 * Stated as an exhaustive `Record<CommandType, ...>` for the reason
 * `COMMAND_MATRIX` is: adding a command type is a compile error until someone
 * says whether it consumes or creates an approval, and a command type nobody
 * classified would otherwise fall through `=== "dispatch.approve"` and be treated
 * as a CREATOR by accident — which would skip the recorded-approval check on the
 * one command type where skipping it launches unapproved work.
 *
 * `dispatch.approve` is the only such type, for the reason its own `COMMAND_MATRIX`
 * row gives: this command CREATES the approval record, so the payload's approval
 * state is the command's RESULT and not a precondition. Requiring a recorded
 * approval first would make the first approval in a run impossible.
 */
export const APPROVAL_CREATING_COMMAND_TYPES: Readonly<Record<CommandType, boolean>> = Object.freeze({
  "run.create": false,
  "run.pause": false,
  "run.resume": false,
  "run.cancel": false,
  "dispatch.propose": false,
  "dispatch.approve": true,
  "dispatch.retry": false,
  "dispatch.timeout.request": false,
  "dispatch.execute": false,
  "session.prompt": false,
  "session.respond": false,
  "session.interrupt": false,
  "session.terminate": false,
})

/**
 * Command types whose payload CREATES the dispatch it names.
 *
 * Same exhaustiveness argument as above. `dispatch.propose` is the only creator;
 * requiring a recorded dispatch before a proposal would make the first dispatch
 * in a run impossible, and `dispatch.retry`'s own matrix row names only terminal
 * dispatch states — a state the previous attempt reaches, not one this command
 * creates.
 */
export const DISPATCH_CREATING_COMMAND_TYPES: Readonly<Record<CommandType, boolean>> = Object.freeze({
  "run.create": false,
  "run.pause": false,
  "run.resume": false,
  "run.cancel": false,
  "dispatch.propose": true,
  "dispatch.approve": false,
  "dispatch.retry": false,
  "dispatch.timeout.request": false,
  "dispatch.execute": false,
  "session.prompt": false,
  "session.respond": false,
  "session.interrupt": false,
  "session.terminate": false,
})

/** Whether this command's payload creates the approval it points at. */
export function approvalIsCreatedBy(command: OrchestrationCommand): boolean {
  return APPROVAL_CREATING_COMMAND_TYPES[command.type]
}

/** Whether this command's payload creates the dispatch it points at. */
export function dispatchIsCreatedBy(command: OrchestrationCommand): boolean {
  return DISPATCH_CREATING_COMMAND_TYPES[command.type]
}

function refusal(code: string, message: string, category: ContractError["category"] = "policy_denied"): Result<never> {
  return { ok: false, error: createContractError(category, code, message) }
}

/**
 * Resolves a command's authorization pointers against the RECORDED LOG.
 *
 * The order is lease → approval → dispatch → digest binding, and the reasons are
 * not arbitrary:
 *
 *   1. **Lease first.** A command whose authority the log does not record is not
 *      a command this node may apply, whatever else it names. Answering a missing
 *      approval first would tell an operator to go and approve something on a run
 *      nobody is driving.
 *   2. **Approval before dispatch.** The approval is the narrower fact and the
 *      stronger one: it is the only thing that authorizes a launch at all.
 *   3. **Digest binding LAST**, after both records exist. It is the only step
 *      that compares two facts, and comparing against a record that turned out
 *      not to exist would produce a digest error where the honest answer is "there
 *      is no such approval".
 *
 * Nothing here consults `command.payload` for a grant. It consults it for exactly
 * two things, and both are CLAIMS to be checked rather than believed: which
 * dispatch the command names, and what envelope it would launch. The envelope's
 * digest is compared AGAINST the recorded one, and the recorded one wins.
 */
export async function authorizeAgainstRecordedLog(
  command: OrchestrationCommand,
  pointers: AuthorizationPointers,
  recorded: RecordedLogReader,
): Promise<Result<RecordedAuthorization>> {
  const scope = `${command.projectId}/${command.runId}`

  const leaseRead = await recorded.lease(pointers.leaseId)
  if (!leaseRead.ok) return leaseRead as Result<RecordedAuthorization>
  const lease = leaseRead.value
  if (lease === null) {
    return refusal(
      "inbox.lease_not_recorded",
      `Command '${command.commandId}' names lease '${pointers.leaseId}' and the recorded log holds no such lease. The lease in a command payload is a POINTER; a pointer to a lease that was never recorded authorizes nothing. NOTHING is persisted.`,
    )
  }
  if (lease.projectId !== command.projectId || lease.runId !== command.runId) {
    return refusal(
      "inbox.lease_scope_mismatch",
      `Recorded lease '${lease.leaseId}' covers ${lease.projectId}/${lease.runId} but command '${command.commandId}' is scoped to ${scope}. A lease that fences a different run cannot authorize this one.`,
    )
  }
  if (lease.epoch !== pointers.controllerEpoch) {
    return refusal(
      "inbox.lease_epoch_mismatch",
      `Recorded lease '${lease.leaseId}' is at epoch ${lease.epoch} while command '${command.commandId}' claims epoch ${pointers.controllerEpoch}. The recorded epoch is the grant; the claim is only a pointer to it.`,
    )
  }
  if (lease.controllerNodeId !== pointers.controllerNodeId) {
    return refusal(
      "inbox.lease_controller_mismatch",
      `Recorded lease '${lease.leaseId}' was issued to controller '${lease.controllerNodeId}' while command '${command.commandId}' claims '${pointers.controllerNodeId}'.`,
    )
  }

  const createsApproval = approvalIsCreatedBy(command)
  let approval: RecordedApproval | null = null
  if (pointers.approvalId !== null) {
    // Branded through the kernel's own schema rather than cast. A cast would let
    // any string reach a `RecordedLogReader` and then be used as a lookup key,
    // and the lookup is the whole authorization: a reader that received an
    // unvalidated id could answer `null` for a malformed key and for an absent
    // record, collapsing "not addressable" into "not granted" — the honest
    // distinction, because the first is a wire defect and the second is a policy
    // decision. Refusing the wire defect is this module's job.
    let approvalId: ApprovalId
    try {
      approvalId = approvalIdSchema.parse(pointers.approvalId)
    } catch (cause) {
      return refusal(
        "inbox.approval_id_malformed",
        `Command '${command.commandId}' names approval '${pointers.approvalId}', which is not a valid approval id. A pointer that cannot address a record grants nothing. NOTHING is persisted.`,
        "validation",
      )
    }
    const read = await recorded.approval(approvalId)
    if (!read.ok) return read as Result<RecordedAuthorization>
    approval = read.value
    if (approval === null && !createsApproval) {
      // The forged-approval case, and the reason this port exists at all. The
      // payload may be internally perfect — a schema-valid approval, digest-bound
      // to an envelope it carries, decision `approved` — and it still grants
      // nothing, because the log never recorded it.
      return refusal(
        "inbox.approval_not_recorded",
        `Command '${command.commandId}' points at approval '${pointers.approvalId}' and the recorded log holds no such approval. An approval supplied by a command payload is a POINTER; the grant is whatever the event log recorded. NOTHING is persisted.`,
      )
    }
  } else if (!createsApproval && command.type === "dispatch.execute") {
    // Belt and braces, and it is load-bearing: a `dispatch.execute` with no
    // approval pointer at all must not sail past the `pointers.approvalId !== null`
    // branch above and reach the digest check with `approval === null`.
    return refusal(
      "inbox.approval_not_recorded",
      `Command '${command.commandId}' is a launch and names no approval at all. A launch with no recorded approval behind it is exactly the defect the digest-bound approval invariant was closed for.`,
    )
  }

  if (approval !== null) {
    if (approval.state !== "approved" || approval.decision !== "approved") {
      return refusal(
        "inbox.approval_not_authorized",
        `Recorded approval '${approval.approvalId}' is state '${approval.state}' with decision '${approval.decision}'. An approval that was decided against, or invalidated afterwards, authorizes nothing — a digest that still matches is necessary but not sufficient.`,
        "approval_required",
      )
    }
    if (!createsApproval && approval.dispatchId !== dispatchIdOf(command)) {
      return refusal(
        "inbox.approval_dispatch_mismatch",
        `Recorded approval '${approval.approvalId}' authorizes dispatch '${approval.dispatchId}' but command '${command.commandId}' acts on '${dispatchIdOf(command) ?? "no dispatch"}'.`,
      )
    }
  }

  const createsDispatch = dispatchIsCreatedBy(command)
  const namedDispatch = pointers.dispatchId ?? dispatchIdOf(command)
  let dispatch: RecordedDispatch | null = null
  if (namedDispatch !== null && !createsDispatch) {
    const read = await recorded.dispatch(namedDispatch)
    if (!read.ok) return read as Result<RecordedAuthorization>
    dispatch = read.value
    if (dispatch === null) {
      return refusal(
        "inbox.dispatch_not_recorded",
        `Command '${command.commandId}' names dispatch '${namedDispatch}' and the recorded log holds no such dispatch. A dispatch supplied by a command payload is a POINTER; the grant is whatever the event log recorded.`,
      )
    }
    if (dispatch.projectId !== command.projectId || dispatch.runId !== command.runId) {
      return refusal(
        "inbox.dispatch_scope_mismatch",
        `Recorded dispatch '${dispatch.dispatchId}' belongs to ${dispatch.projectId}/${dispatch.runId} but command '${command.commandId}' is scoped to ${scope}.`,
      )
    }
  }

  // Digest binding. This is the step a payload cannot forge, because both sides of
  // the comparison are recorded facts except for the envelope, and the envelope is
  // the thing BEING authorized rather than a source of authority. A payload whose
  // envelope digests to something other than the recorded dispatch's
  // `envelopeDigest` is a launch of work no approval was ever given for, and it is
  // refused here rather than at the runtime.
  let bindingDigest: Digest | null = null
  if (dispatch !== null && approval !== null) {
    if (approval.envelopeDigest !== dispatch.envelopeDigest) {
      return refusal(
        "inbox.approval_digest_mismatch",
        `Recorded approval '${approval.approvalId}' carries envelope digest ${approval.envelopeDigest} while recorded dispatch '${dispatch.dispatchId}' carries ${dispatch.envelopeDigest}. The approval does not authorize the dispatch it is filed against.`,
        "approval_required",
      )
    }
    bindingDigest = dispatch.envelopeDigest
    const payloadDigest = digestOfCommandEnvelope(command)
    if (payloadDigest !== null && payloadDigest !== dispatch.envelopeDigest) {
      return refusal(
        "inbox.dispatch_envelope_digest_mismatch",
        `Command '${command.commandId}' would launch an envelope digesting to ${payloadDigest}, but the recorded dispatch '${dispatch.dispatchId}' is ${dispatch.envelopeDigest}. The recorded digest wins: a payload carrying an unapproved envelope is refused rather than narrowed.`,
        "approval_required",
      )
    }
  }

  return {
    ok: true,
    value: {
      commandType: command.type,
      commandId: command.commandId,
      pointers,
      approval,
      dispatch,
      lease,
      bindingDigest,
    },
  }
}

/**
 * The canonical digest of the envelope a command would launch, or `null`.
 *
 * Only the four command types that carry one have a digest to compare; the rest
 * return `null` and are not digest-bound, which is correct — there is nothing to
 * bind. Kept as a `switch` over the four rather than a structural probe so a
 * future command type that gains an envelope is a compile error here instead of a
 * silent `null`.
 */
function digestOfCommandEnvelope(command: OrchestrationCommand): Digest | null {
  switch (command.type) {
    case "dispatch.propose":
    case "dispatch.approve":
    case "dispatch.execute":
    case "dispatch.retry":
      return digestDispatchEnvelope(command.payload.dispatch.envelope)
    case "dispatch.timeout.request":
    case "run.create":
    case "run.pause":
    case "run.resume":
    case "run.cancel":
    case "session.prompt":
    case "session.respond":
    case "session.interrupt":
    case "session.terminate":
      return null
  }
}

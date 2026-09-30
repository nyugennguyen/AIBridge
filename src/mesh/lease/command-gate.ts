import { createContractError, type ContractError } from "../../orchestration/errors.js"
import type { NodeId } from "../../orchestration/identifiers.js"
import { COMMAND_MATRIX, validateCommandStateByType, type AggregateStateContext, type CommandType } from "../../orchestration/invariants.js"
import type { ApprovalState, DispatchState, RunState, SessionState, TaskState } from "../../orchestration/transitions.js"
import { verifyIncomingCommand, type IncomingCommandExpectation } from "../protocol/command.js"
import { safeParseMeshEnvelope } from "../protocol/registry.js"
import type { LeaseRecord, LeaseScope } from "./schemas.js"
import type {
  CommandAdmission,
  CommandEpochGate,
  CommandEpochGateDependencies,
  CommandGateOutcome,
  CommandGateRefusal,
  CommandGateStage,
  CommandMatrixDecision,
} from "./types.js"

/**
 * The epoch gate: ONE choke point for "may this `mesh.command` be persisted".
 *
 * This is M4.4's central deliverable and the plan states four requirements for it
 * that pull in different directions, so the ORDER below is the design.
 *
 * **It does not persist.** The gate answers; M4.5's inbox writes. That separation
 * is what makes "a stale command is refused and NOTHING is persisted" a property
 * of the control flow rather than a claim about a rollback: there is no write to
 * roll back, because a refused command never reaches one. It is also why the gate
 * takes no store other than the lease read — a seam that both decided and wrote
 * would make every future caller responsible for remembering which half it had.
 *
 * **The order, and why it is this order.**
 *
 *   1. PARSE, through `safeParseMeshEnvelope`. One parse site (M4-V).
 *   2. LEASE, then EXPIRY, then the EPOCH, in that order.
 *   3. `verifyIncomingCommand` — integrity, addressing, self-consistency, time.
 *   3b. THE LEASE WINDOW, against the command's own expiry.
 *   4. `COMMAND_MATRIX`, resolved against RECORDED state.
 *
 * Steps 2's three parts are ordered, and the reason is that they have different
 * owners:
 *
 *   - **Absent lease before expired lease.** `no_lease` and `expired` are
 *     different incidents with different remedies — "nobody is driving this run"
 *     versus "the controller you were using is gone" — and a node that reports
 *     both as "no authority" sends its operator to guess.
 *   - **Both before the epoch comparison.** A node whose lease has expired accepts
 *     no commands AT ALL, and telling it about a stale epoch first would be
 *     answering a question it is not in a position to adjudicate. It also gives
 *     the plan's partition diagram its exact code: after `expiresAt`, every
 *     command that would create new work is refused with `lease.expired`.
 *   - **Epoch before `verifyIncomingCommand`'s own epoch check** is NOT a
 *     contradiction of that function's documented order (integrity first). It is a
 *     deliberate second, earlier statement of the same rule at the seam, and the
 *     reason is diagnostic: a stale controller's traffic is the ROUTINE event
 *     after a partition, so it should be answered with the code that says "you
 *     were superseded" rather than with whatever a tampered-looking record fails
 *     first. `verifyIncomingCommand` re-checks the epoch afterwards as defence in
 *     depth; a command that fails either check is refused by both, so nothing is
 *     traded for diagnosis.
 *
 *   - **3b AFTER integrity, and the reason is that it compares a byte.** The
 *     lease-window rule (spec §4.4 invariant 7) reads `command.expiresAt` off the
 *     record, and an unverified record's `expiresAt` is exactly the field a
 *     forger would move. Answering a tampered command with "your expiry outlived
 *     the lease" would report a lease problem for what is an integrity problem, so
 *     the comparison waits until `verifyIncomingCommand` has recomputed the
 *     digest and the wire schema has cross-checked the record's `expiresAt`
 *     against the payload's. It is still before the matrix and before the
 *     recorded-log read, because it is a comparison of two numbers this node
 *     already holds and a projection read is not worth spending to reach it.
 *
 * **The matrix is the ONLY source of allowed states.** Step 4 calls
 * `validateCommandStateByType` and nothing else decides states. The one rule this
 * module adds is a COMPLETENESS rule, not a state rule, and it is derived from
 * the matrix's own row rather than from a list kept here: see
 * {@link requiredRecordedStateEntities}.
 */

const MATRIX_ARM_BY_RULE_KEY = {
  allowedRunStates: "run",
  allowedTaskStates: "task",
  allowedDispatchStates: "dispatch",
  allowedApprovalStates: "approval",
  allowedSessionStates: "session",
} as const

type MatrixArm = (typeof MATRIX_ARM_BY_RULE_KEY)[keyof typeof MATRIX_ARM_BY_RULE_KEY]

const CONTEXT_KEY_BY_ARM: Readonly<Record<MatrixArm, keyof AggregateStateContext>> = {
  run: "runState",
  task: "taskState",
  dispatch: "dispatchState",
  approval: "approvalState",
  session: "sessionState",
}

/**
 * Copies one recorded state into the context, one arm at a time.
 *
 * A hand-written arm per case rather than a computed key, for two reasons. A
 * computed assignment is invisible at the call site — a dropped arm reads exactly
 * like an unconstrained one, and "unconstrained" is the reading that lets
 * everything through. And the cast is confined to this one function instead of
 * being spread across the loop that decides which arms were supplied.
 */
function withRecordedArm(context: AggregateStateContext, arm: MatrixArm, state: unknown): void {
  switch (arm) {
    case "run":
      context.runState = state as RunState
      return
    case "task":
      context.taskState = state as TaskState
      return
    case "dispatch":
      context.dispatchState = state as DispatchState
      return
    case "approval":
      context.approvalState = state as ApprovalState
      return
    case "session":
      context.sessionState = state as SessionState
      return
  }
}

/**
 * The aggregates whose state a command type's matrix entry actually constrains.
 *
 * DERIVED from `COMMAND_MATRIX`, never restated, and that is the whole point of
 * exporting it. `validateCommandStateByType` treats an `undefined` arm as
 * unconstrained, which is right for the kernel and wrong for a remote
 * authorization decision: a resolver that returned `{}` would license every
 * command type in the mesh. So the gate requires the arms the matrix names, and it
 * learns which arms those are by reading the matrix row.
 *
 * Exported for a TUI (M4.8) so "which states did you check?" has one answer that
 * is not a second copy of the rules.
 */
export function requiredRecordedStateEntities(commandType: CommandType): readonly MatrixArm[] {
  const rule = COMMAND_MATRIX[commandType]
  if (rule === undefined) return []
  const out: MatrixArm[] = []
  for (const [ruleKey, arm] of Object.entries(MATRIX_ARM_BY_RULE_KEY)) {
    if (rule[ruleKey as keyof typeof rule] !== undefined) out.push(arm)
  }
  return Object.freeze(out)
}

export class MeshCommandEpochGate implements CommandEpochGate {
  readonly #lease: CommandEpochGateDependencies["lease"]
  readonly #recordedState: CommandEpochGateDependencies["recordedState"]
  readonly #now: () => number
  readonly #recipientNodeId: CommandEpochGateDependencies["recipientNodeId"]

  constructor(dependencies: CommandEpochGateDependencies) {
    this.#lease = dependencies.lease
    this.#recordedState = dependencies.recordedState
    this.#now = dependencies.now
    this.#recipientNodeId = dependencies.recipientNodeId
  }

  async authorize(value: unknown): Promise<CommandGateOutcome> {
    // 1. Parse. One entry point, here, for the reason the registry gives: a
    // gateway that parsed for itself is a second parse site, and M4-V is that
    // there is one.
    const parsed = safeParseMeshEnvelope(value)
    if (!parsed.ok) return this.#refuse("parse", "not_a_command", parsed.error, null)
    const envelope = parsed.value
    if (envelope.recordType !== "mesh.command") {
      return this.#refuse(
        "parse",
        "not_a_command",
        createContractError(
          "validation",
          "lease.not_a_command",
          `Expected a mesh.command and received '${envelope.recordType}'. The epoch gate commands and nothing else; a lease offered here is a caller wiring defect.`,
        ),
        null,
      )
    }
    const record = envelope.payload

    // The scope comes from the RECORD, and the lease is looked up by that scope
    // rather than by anything the caller supplied. This is the recorded-log rule
    // in its simplest form: the grant is whatever this node holds for the run the
    // command names, and a command cannot nominate a run to be judged against a
    // lease for a different one.
    const scope: LeaseScope = { projectId: record.projectId, runId: record.runId }

    // 2a. Absent lease.
    const stored = await this.#lease.lease(scope)
    if (!stored.ok) return this.#refuse("parse", "no_lease", stored.error, null)
    const lease = stored.value
    if (lease === null) {
      return this.#refuse(
        "lease_absent",
        "no_lease",
        createContractError(
          "conflict",
          "lease.none_held",
          `Command '${record.commandId}' names run ${scope.projectId}/${scope.runId}, and this node holds no lease for it. A node that holds no lease has no authority to create work, and the remedy is a claim — never a command that arrives first.`,
        ),
        null,
      )
    }

    // 2b. Expiry, BEFORE the epoch comparison. See the module comment: an expired
    // lease refuses everything, so reporting a stale epoch first would be
    // answering a question this node is not in a position to adjudicate, and it
    // would not give the operator the plan's partition-diagram code.
    const permitted = await this.#lease.permitsNewWork(scope)
    if (!permitted.ok) return this.#refuse("lease_expired", "lease_expired", permitted.error, lease)
    if (!permitted.value.permitted) {
      const reason = permitted.value.reason
      return this.#refuse(
        "lease_expired",
        "lease_expired",
        createContractError(
          "stale_epoch",
          "lease.expired",
          `Command '${record.commandId}' for run ${scope.runId} was refused: the lease held by '${lease.controllerNodeId}' at epoch ${lease.epoch} expired at ${lease.expiresAt} (${reason}). No new dispatch, no retry and no policy mutation is permitted while it is expired. Nothing about any running agent changes — an expiry is a pause of new work, never a termination of existing work.`,
        ),
        lease,
      )
    }

    // 2c. THE EPOCH GATE. Two refusals, and both are "drop it", never "queue it
    // for later": a command minted under a superseded controller was decided
    // against a projection that no longer exists, so applying it under a successor
    // would apply a decision to a world it never saw. Nothing is persisted on
    // either branch, and neither branch has a retryable error, so a stale
    // controller cannot even reach a retry loop by trying again.
    if (record.controllerEpoch < lease.epoch) {
      return this.#refuse(
        "epoch_stale",
        "epoch_stale",
        createContractError(
          "stale_epoch",
          "epoch.stale",
          `Command '${record.commandId}' was minted at epoch ${record.controllerEpoch}, below the epoch ${lease.epoch} this node accepts. It is DROPPED, not stored for later: it was decided against a projection that no longer exists. NOTHING is persisted.`,
        ),
        lease,
      )
    }
    if (record.controllerEpoch > lease.epoch) {
      return this.#refuse(
        "epoch_unregistered",
        "epoch_unregistered",
        createContractError(
          "conflict",
          "epoch.unregistered",
          `Command '${record.commandId}' claims epoch ${record.controllerEpoch}, above the epoch ${lease.epoch} this node accepts. A higher epoch is only ever accepted through an explicit lease takeover, never by a command arriving first. NOTHING is persisted.`,
        ),
        lease,
      )
    }

    // 3. The rest of the seam. Integrity, addressing, scope self-consistency and
    // the replay window, in `verifyIncomingCommand`'s own order. Everything it
    // decides comes from THIS node's lease and clock, never from the record.
    const expectation: IncomingCommandExpectation = {
      recipientNodeId: this.#recipientNodeId,
      controllerNodeId: lease.controllerNodeId,
      projectId: lease.projectId,
      runId: lease.runId,
      acceptedEpoch: lease.epoch,
      nowMs: this.#now(),
    }
    const verified = verifyIncomingCommand(record, expectation)
    if (!verified.ok) {
      return this.#refuse("integrity", "not_verified", verified.error, lease)
    }

    // 3b. A COMMAND MAY NOT OUTLIVE THE LEASE THAT MINTS IT. Spec §4.4
    // invariant 7, and the kernel states it too in `validateCommandLease` — which
    // this gate does not call, because that function re-decides scope, controller,
    // lease id and epoch against a `ControllerLease` this directory does not have,
    // and a second caller of it here would mean two owners for the same refusals.
    // So the rule is stated once more at the seam, and the seam is where it has to
    // be: nothing below the gate ever compares the two windows.
    //
    // The rule is ABSOLUTE, not "must still be valid when this record is read", and
    // the difference is the whole content of it. A command is minted against one
    // specific lease window, so a comparison against the clock would admit every
    // command whose window extends past the end of the authority that issued it —
    // and the interesting case is precisely the one the clock agrees about, since
    // both windows are still open at the moment the record is read.
    //
    // It binds RETROACTIVELY, which is the consequence worth stating because it
    // surprises callers: a renewal that SHORTENS the window retroactively
    // invalidates a command that was minted legally under the longer one. Failing
    // a command that was admissible a moment ago is the cheap direction; the
    // alternative is accepting a command whose authority has ended.
    //
    // The comparison is against `verified.command`, not `record`: the payload is
    // the half whose digest was just recomputed, and `meshCommandSchema` refuses a
    // record whose two `expiresAt` values disagree, so this is the expiry of bytes
    // the gate has actually checked.
    if (Date.parse(verified.value.command.expiresAt) > Date.parse(lease.expiresAt)) {
      return this.#refuse(
        "lease_window",
        "command_expiry_exceeds_lease",
        createContractError(
          "validation",
          "command.expiry_exceeds_lease",
          `Command '${verified.value.commandId}' expires at ${verified.value.command.expiresAt}, past the end of the lease window it was minted under ('${lease.leaseId}', epoch ${lease.epoch}, expiring ${lease.expiresAt}). A command may not outlive the authority that authorised it, so it is refused even though the clock is still inside both windows. Re-mint it against the lease you actually hold.`,
        ),
        lease,
      )
    }

    // 4. COMMAND_MATRIX, against RECORDED state. The `authorizationClaims` the
    // verification deliberately left unresolved are NOT resolved here either: the
    // grant is whatever the event log recorded, and the recorded-state resolver is
    // the only thing in this directory that reads the log.
    const recorded = await this.#recordedState.resolve(record.command, scope)
    if (!recorded.ok) {
      return this.#refuse(
        "recorded_state",
        "recorded_state_unavailable",
        recorded.error,
        lease,
      )
    }

    const required = requiredRecordedStateEntities(record.command.type)
    const recordedEntities: string[] = []
    const missing: string[] = []
    const context: AggregateStateContext = {}
    for (const arm of required) {
      const state = recorded.value[CONTEXT_KEY_BY_ARM[arm]]
      if (state === undefined) {
        // Collected rather than refused on the first one, so a single refusal
        // names EVERY arm the resolver failed to supply. A resolver that fixed
        // one arm at a time would otherwise take as many round trips as it has
        // aggregates, against a peer that is waiting on the answer.
        missing.push(arm)
        continue
      }
      recordedEntities.push(arm)
      withRecordedArm(context, arm, state)
    }
    if (missing.length > 0) {
      return this.#refuse(
        "recorded_state",
        "recorded_state_missing_run",
        createContractError(
          "validation",
          "lease.recorded_state_incomplete",
          `Command '${record.commandId}' of type '${record.command.type}' is constrained by COMMAND_MATRIX on [${missing.join(", ")}], and the recorded log did not supply ${missing.length === 1 ? "it" : "them"}. The command is refused rather than licensed against an absent state: \`validateCommandStateByType\` skips an undefined arm, so a resolver that returned an empty context would license every command type in the mesh.`,
        ),
        lease,
        { commandType: record.command.type, constrainedEntities: required, recordedEntities },
      )
    }

    const matrixVerdict = validateCommandStateByType(record.command.type, context)
    const matrix: CommandMatrixDecision = {
      commandType: record.command.type,
      constrainedEntities: required,
      recordedEntities,
    }
    if (!matrixVerdict.ok) {
      return this.#refuse("matrix", "matrix_refused", matrixVerdict.error, lease, matrix)
    }

    const admission: CommandAdmission = {
      admitted: true,
      stage: "admitted",
      verified: verified.value,
      lease,
      matrix,
    }
    return admission
  }

  #refuse(
    stage: CommandGateStage,
    reason: CommandGateRefusal,
    error: ContractError,
    lease: LeaseRecord | null,
    matrix: CommandMatrixDecision | null = null,
  ): CommandGateOutcome {
    return { admitted: false, stage, reason, error, lease, matrix }
  }
}

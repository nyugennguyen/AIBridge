import { digestDispatchEnvelope } from "./digest.js"
import {
  createContractError,
  InvalidStateTransitionError,
  InvariantViolationError,
  type ContractError,
  type Result,
} from "./errors.js"
import type {
  Approval,
  ControllerLease,
  Dispatch,
  DispatchEnvelope,
  OrchestrationCommand,
  Run,
  Session,
  Task,
} from "./types.js"
import {
  isApprovalTerminal,
  isDispatchTerminal,
  isRunTerminal,
  isSessionTerminal,
  isTaskTerminal,
  isTerminalState,
  type AggregateEntity,
  type ApprovalState,
  type DispatchState,
  type RunState,
  type SessionState,
  type TaskState,
} from "./transitions.js"

export type CommandType = OrchestrationCommand["type"]

export interface AggregateStateContext {
  runState?: RunState
  taskState?: TaskState
  dispatchState?: DispatchState
  approvalState?: ApprovalState
  sessionState?: SessionState
}

export interface CommandStateRule {
  readonly allowedRunStates: readonly RunState[]
  readonly allowedDispatchStates?: readonly DispatchState[]
  readonly allowedApprovalStates?: readonly ApprovalState[]
  readonly allowedTaskStates?: readonly TaskState[]
  readonly allowedSessionStates?: readonly SessionState[]
}

export const COMMAND_MATRIX: Readonly<Record<CommandType, CommandStateRule>> = {
  "run.create": {
    // A create command is what brings the run stream into existence, so no
    // prior run state can constrain it. The rule exists to force an explicit
    // decision here rather than to omit the entry: an exhaustive
    // `Record<CommandType, ...>` makes adding a command type a compile error
    // until someone states the states it may act in.
    allowedRunStates: ["draft"],
  },
  "dispatch.propose": {
    // A first proposal for a task. The run must be live (not terminal) and the
    // task must be ready, so a dispatch cannot be proposed for work that is
    // still blocked on its dependencies or for a finished run.
    allowedRunStates: ["draft", "active"],
    allowedTaskStates: ["ready"],
  },
  "run.pause": {
    // A run-level gate on work that has not finished. Pausing a terminal run is
    // refused by `runSchema` and by the coordinator, so only live states appear.
    allowedRunStates: ["draft", "active"],
  },
  "run.resume": {
    // Clearing the gate is the only way back to schedulable work, so it is an
    // explicit evented decision rather than an implicit re-derivation.
    allowedRunStates: ["draft", "active"],
  },
  "dispatch.approve": {
    // M4-M. `approved` is added because a REVISION re-approves an envelope that
    // is already `approved` in the recorded log: `dispatch.approve` records a
    // new `dispatch.proposed` for the changed digest plus the new decision, and
    // the old state it acts on is `approved`, not `proposed`. Under the
    // lifecycle-only vocabulary the matrix made that revision unapprovable, which
    // is why the matrix could not simply be switched on.
    allowedRunStates: ["draft", "active"],
    allowedDispatchStates: ["proposed", "approved"],
    // Every approval lifecycle state is listed, and that is deliberate rather
    // than decorative: this command CREATES the approval record, so the
    // payload's approval state is the command's *result*, not a precondition.
    // A `rejected` decision legitimately arrives as `state: "rejected"`, and
    // refusing it would make rejecting a dispatch impossible. The genuine
    // preconditions here are the dispatch state and the task state; the
    // approval state that actually gates a launch is enforced on
    // `dispatch.execute`, against the RECORDED approval.
    allowedApprovalStates: ["pending", "approved", "rejected", "invalidated"],
    allowedTaskStates: ["ready"],
  },
  "dispatch.retry": {
    // Retry is deliberately NOT gated on the task being `failed`: the
    // retryability rule (dependencies, attempt monotonicity) belongs to the
    // scheduler, and the matrix only constrains which lifecycle states a command
    // may act in. The run must be non-terminal, and the previous attempt's
    // dispatch must be terminal so failure history is settled.
    //
    // This entry previously carried `allowedTaskStates: ["failed"]` while its own
    // comment said it did not. M4.0 discovered the contradiction the only way it
    // can be discovered — by switching the matrix on. Nothing in the kernel moves
    // a task to `failed` when its dispatch reports one (the reducer records the
    // dispatch outcome; task lifecycle is the scheduler's), so the entry made
    // EVERY retry unreachable and the matrix could not be enforced at all. The
    // preconditions that genuinely belong here are the run state and the previous
    // dispatch's terminal state.
    allowedRunStates: ["draft", "active"],
    allowedDispatchStates: ["failed", "cancelled", "timed_out", "completed"],
  },
  "dispatch.timeout.request": {
    allowedRunStates: ["draft", "active"],
    allowedDispatchStates: ["proposed", "approved", "running"],
    allowedSessionStates: ["launching", "running", "idle"],
  },
  "run.cancel": {
    allowedRunStates: ["draft", "active"],
  },
  "dispatch.execute": {
    allowedRunStates: ["draft", "active"],
    allowedDispatchStates: ["approved"],
    allowedApprovalStates: ["approved"],
    allowedTaskStates: ["ready"],
  },
  "session.prompt": {
    allowedRunStates: ["active"],
    allowedSessionStates: ["idle"],
  },
  "session.respond": {
    allowedRunStates: ["active"],
    allowedSessionStates: ["running", "idle"],
  },
  "session.interrupt": {
    allowedRunStates: ["active"],
    allowedSessionStates: ["running"],
  },
  "session.terminate": {
    allowedRunStates: ["draft", "active"],
    allowedSessionStates: ["launching", "running", "idle"],
  },
}

// --- Command Matrix Validation ---

/**
 * The one place the "is this state terminal, and is that fatal?" question is
 * answered, so all five aggregate arms cannot drift apart.
 *
 * Membership is checked FIRST and terminality second, and that ordering is
 * load-bearing rather than cosmetic. `dispatch.retry`'s allowed dispatch states
 * are `["failed", "cancelled", "timed_out", "completed"]` — every one of them
 * terminal — because retry acts on a *finished* attempt in order to add the
 * next one. Under the previous order (terminal check first) the terminal guard
 * fired before the allowlist was consulted, so the one command whose entire
 * purpose is to follow a terminal state could never be licensed.
 */
function checkAggregateState<S extends string>(
  commandType: CommandType,
  entity: AggregateEntity,
  state: S,
  allowed: readonly S[] | undefined,
  isTerminal: (value: S) => boolean,
  unit: string,
): Result<void> {
  if (allowed === undefined) return { ok: true, value: undefined }
  if (allowed.includes(state)) return { ok: true, value: undefined }
  if (isTerminal(state)) {
    return {
      ok: false,
      error: createContractError(
        "conflict",
        "command.terminal_state_immutable",
        `Cannot execute command '${commandType}': ${entity} is in terminal state '${state}'`,
      ),
    }
  }
  return {
    ok: false,
    error: createContractError(
      "conflict",
      `command.invalid_${unit}_state`,
      `Command '${commandType}' requires ${entity} state to be one of [${allowed.join(", ")}], but received '${state}'`,
    ),
  }
}

export function isCommandAllowedForStates(commandType: CommandType, context: AggregateStateContext): boolean {
  return validateCommandStateByType(commandType, context).ok
}

export function validateCommandStateByType(commandType: CommandType, context: AggregateStateContext): Result<void> {
  const rule = COMMAND_MATRIX[commandType]
  if (!rule) {
    return {
      ok: false,
      error: createContractError("validation", "command.unknown_type", `Unknown command type: ${commandType}`),
    }
  }

  if (context.runState !== undefined) {
    const result = checkAggregateState(commandType, "run", context.runState, rule.allowedRunStates, isRunTerminal, "run")
    if (!result.ok) return result
  }
  if (context.dispatchState !== undefined) {
    const result = checkAggregateState(
      commandType,
      "dispatch",
      context.dispatchState,
      rule.allowedDispatchStates,
      isDispatchTerminal,
      "dispatch",
    )
    if (!result.ok) return result
  }
  if (context.approvalState !== undefined) {
    const result = checkAggregateState(
      commandType,
      "approval",
      context.approvalState,
      rule.allowedApprovalStates,
      isApprovalTerminal,
      "approval",
    )
    if (!result.ok) return result
  }
  if (context.taskState !== undefined) {
    const result = checkAggregateState(commandType, "task", context.taskState, rule.allowedTaskStates, isTaskTerminal, "task")
    if (!result.ok) return result
  }
  if (context.sessionState !== undefined) {
    const result = checkAggregateState(
      commandType,
      "session",
      context.sessionState,
      rule.allowedSessionStates,
      isSessionTerminal,
      "session",
    )
    if (!result.ok) return result
  }

  return { ok: true, value: undefined }
}

export function validateCommandState(command: OrchestrationCommand, context: AggregateStateContext): Result<void> {
  return validateCommandStateByType(command.type, context)
}

export function assertCommandState(command: OrchestrationCommand, context: AggregateStateContext): void {
  const result = validateCommandState(command, context)
  if (!result.ok) {
    throw new InvariantViolationError("command_matrix", result.error.message, {
      category: result.error.category,
      code: result.error.code,
    })
  }
}

// --- Terminal State Invariants ---

export function validateNonTerminal(entity: AggregateEntity, state: string, operation?: string): Result<void> {
  if (isTerminalState(entity, state)) {
    const op = operation ? ` for operation '${operation}'` : ""
    return {
      ok: false,
      error: createContractError(
        "conflict",
        "state.terminal_immutable",
        `Cannot mutate ${entity} in terminal state '${state}'${op}: terminal states are strictly immutable`,
      ),
    }
  }
  return { ok: true, value: undefined }
}

export function assertNonTerminal(entity: AggregateEntity, state: string, operation?: string): void {
  if (isTerminalState(entity, state)) {
    throw new InvalidStateTransitionError(entity, state, state, {
      isTerminal: true,
      reason: operation ? `Operation '${operation}' rejected: terminal states are strictly immutable` : undefined,
    })
  }
}

// --- Digest-Bound Approval Invariant ---

export type DispatchOrEnvelope =
  | Dispatch
  | { envelope: DispatchEnvelope; envelopeDigest?: string }

export function isApprovalDigestValid(approval: Approval, target: DispatchOrEnvelope): boolean {
  return validateApprovalDigest(approval, target).ok
}

export function validateApprovalDigest(approval: Approval, target: DispatchOrEnvelope): Result<void> {
  const envelope = target.envelope
  const expectedDigest = digestDispatchEnvelope(envelope)

  // Scope identity checks
  if (approval.projectId !== envelope.projectId) {
    return {
      ok: false,
      error: createContractError(
        "conflict",
        "approval.project_mismatch",
        `Approval project ID '${approval.projectId}' does not match dispatch project '${envelope.projectId}'`,
      ),
    }
  }

  if (approval.runId !== envelope.runId) {
    return {
      ok: false,
      error: createContractError(
        "conflict",
        "approval.run_mismatch",
        `Approval run ID '${approval.runId}' does not match dispatch run '${envelope.runId}'`,
      ),
    }
  }

  if (approval.dispatchId !== envelope.dispatchId) {
    return {
      ok: false,
      error: createContractError(
        "conflict",
        "approval.dispatch_mismatch",
        `Approval dispatch ID '${approval.dispatchId}' does not match dispatch ID '${envelope.dispatchId}'`,
      ),
    }
  }

  // Digest checks
  if (approval.envelopeDigest !== expectedDigest) {
    return {
      ok: false,
      error: createContractError(
        "conflict",
        "approval.digest_mismatch",
        `Approval envelope digest '${approval.envelopeDigest}' does not match canonical dispatch digest '${expectedDigest}'`,
      ),
    }
  }

  if (target.envelopeDigest !== undefined && target.envelopeDigest !== expectedDigest) {
    return {
      ok: false,
      error: createContractError(
        "conflict",
        "dispatch.digest_mismatch",
        `Dispatch recorded digest '${target.envelopeDigest}' does not match computed envelope digest '${expectedDigest}'`,
      ),
    }
  }

  // Decision check
  if (approval.decision !== "approved") {
    return {
      ok: false,
      error: createContractError(
        "approval_required",
        "approval.not_approved",
        `Approval decision is '${approval.decision}', but execution requires 'approved'`,
      ),
    }
  }

  // Durable lifecycle check. A digest that still matches is necessary but not
  // sufficient: once the approval has been recorded as invalidated, it no
  // longer authorizes anything, even if the envelope happens to digest back to
  // the recorded value. Otherwise an invalidation could be silently undone.
  if (approval.state !== "approved") {
    return {
      ok: false,
      error: createContractError(
        "approval_required",
        "approval.invalidated",
        `Approval '${approval.approvalId}' is in state '${approval.state}' and no longer authorizes execution`,
      ),
    }
  }

  return { ok: true, value: undefined }
}

export function assertApprovalDigestBound(approval: Approval, target: DispatchOrEnvelope): void {
  const result = validateApprovalDigest(approval, target)
  if (!result.ok) {
    throw new InvariantViolationError("digest_bound_approval", result.error.message, {
      category: result.error.category,
      code: result.error.code,
    })
  }
}

export function deriveApprovalState(approval: Approval, target?: DispatchOrEnvelope): ApprovalState {
  if (approval.decision === "rejected") return "rejected"
  if (approval.state === "invalidated") return "invalidated"
  if (target !== undefined) {
    const result = validateApprovalDigest(approval, target)
    if (!result.ok) return "invalidated"
  }
  return "approved"
}

// --- Controller Epoch & Lease Checks ---

export interface EpochMonotonicityOptions {
  readonly allowSameEpoch?: boolean
}

export function validateEpochMonotonicity(
  currentEpoch: number,
  nextEpoch: number,
  options?: EpochMonotonicityOptions,
): Result<void> {
  if (!Number.isSafeInteger(currentEpoch) || currentEpoch < 1) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "epoch.invalid_current",
        `Current epoch must be a positive safe integer; received ${currentEpoch}`,
      ),
    }
  }

  if (!Number.isSafeInteger(nextEpoch) || nextEpoch < 1) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "epoch.invalid_next",
        `Next epoch must be a positive safe integer; received ${nextEpoch}`,
      ),
    }
  }

  if (options?.allowSameEpoch) {
    if (nextEpoch < currentEpoch) {
      return {
        ok: false,
        error: createContractError(
          "stale_epoch",
          "epoch.stale",
          `Epoch must be monotonic; received next epoch ${nextEpoch} < current epoch ${currentEpoch}`,
        ),
      }
    }
  } else {
    if (nextEpoch <= currentEpoch) {
      return {
        ok: false,
        error: createContractError(
          "stale_epoch",
          "epoch.not_monotonic",
          `Next epoch must be strictly greater than predecessor; received next epoch ${nextEpoch} <= current epoch ${currentEpoch}`,
        ),
      }
    }
  }

  return { ok: true, value: undefined }
}

export function assertEpochMonotonicity(
  currentEpoch: number,
  nextEpoch: number,
  options?: EpochMonotonicityOptions,
): void {
  const result = validateEpochMonotonicity(currentEpoch, nextEpoch, options)
  if (!result.ok) {
    throw new InvariantViolationError("epoch_monotonicity", result.error.message, {
      category: result.error.category,
      code: result.error.code,
    })
  }
}

export interface CommandLeaseValidationOptions {
  readonly now?: string
}

/**
 * The codes below — `epoch.stale`, `epoch.unregistered`, `lease.expired` — are the
 * vocabulary the whole codebase answers to, and the mesh protocol conforms to them
 * rather than inventing category-prefixed spellings of the same three facts. They
 * are written here without a prefix because `ContractError.category` already
 * carries `stale_epoch` / `conflict`; a code that repeated its own category was a
 * second thing to keep in step, and it drifted. Nothing downstream may treat a
 * particular spelling as private to the file that raises it.
 */

export function validateCommandLease(
  command: OrchestrationCommand,
  activeLease: ControllerLease,
  options?: CommandLeaseValidationOptions,
): Result<void> {
  // 1. Scope matching
  if (command.projectId !== activeLease.projectId || command.runId !== activeLease.runId) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "lease.scope_mismatch",
        `Command scope (${command.projectId}/${command.runId}) does not match lease scope (${activeLease.projectId}/${activeLease.runId})`,
      ),
    }
  }

  // 2. Controller node matching
  if (command.controllerNodeId !== activeLease.controllerNodeId) {
    return {
      ok: false,
      error: createContractError(
        "policy_denied",
        "lease.controller_mismatch",
        `Command controllerNodeId '${command.controllerNodeId}' does not match lease controllerNodeId '${activeLease.controllerNodeId}'`,
      ),
    }
  }

  // 3. Lease ID matching
  if (command.leaseId !== activeLease.leaseId) {
    return {
      ok: false,
      error: createContractError(
        "conflict",
        "lease.mismatched",
        `Command leaseId '${command.leaseId}' does not match active leaseId '${activeLease.leaseId}'`,
      ),
    }
  }

  // 4. Epoch matching
  if (command.controllerEpoch < activeLease.epoch) {
    return {
      ok: false,
      error: createContractError(
        "stale_epoch",
        "epoch.stale",
        `Command controllerEpoch ${command.controllerEpoch} is stale; active lease epoch is ${activeLease.epoch}`,
      ),
    }
  }

  if (command.controllerEpoch > activeLease.epoch) {
    return {
      ok: false,
      error: createContractError(
        "conflict",
        "epoch.unregistered",
        `Command controllerEpoch ${command.controllerEpoch} is ahead of active lease epoch ${activeLease.epoch}`,
      ),
    }
  }

  // 5. Expiry and timing checks
  const checkTime = options?.now ?? command.issuedAt
  const checkTimeMs = Date.parse(checkTime)
  const leaseIssuedMs = Date.parse(activeLease.issuedAt)
  const leaseExpiresMs = Date.parse(activeLease.expiresAt)
  const commandIssuedMs = Date.parse(command.issuedAt)
  const commandExpiresMs = Date.parse(command.expiresAt)

  if (checkTimeMs >= leaseExpiresMs) {
    return {
      ok: false,
      error: createContractError(
        "stale_epoch",
        "lease.expired",
        `Active lease expired at ${activeLease.expiresAt}; current verification time is ${checkTime}`,
      ),
    }
  }

  // 5b. A command may not OUTLIVE the lease that mints it. The rule is deliberately
  // absolute rather than "must still be valid at check time": a command is minted
  // against one specific lease window, so its own expiry may never sit past that
  // window's end. Anything looser would leave work whose authority had already
  // lapsed still queued to be applied under whoever holds the run next.
  //
  // The consequence is worth stating because it surprises callers: this comparison
  // is against the lease as handed in, so a RENEWAL that shortens the window
  // retroactively invalidates a command that was minted legally under the longer
  // one. A renewal may only extend, and a controller that mints commands against
  // the maximum possible duration has to re-mint against the lease it actually
  // holds. Failing a command that was valid a moment ago is the cheap direction —
  // the alternative is accepting a command whose authority has ended.
  if (commandExpiresMs > leaseExpiresMs) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "command.expiry_exceeds_lease",
        `Command expiresAt ${command.expiresAt} exceeds active lease expiresAt ${activeLease.expiresAt}`,
      ),
    }
  }

  if (commandIssuedMs < leaseIssuedMs) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "command.issued_before_lease",
        `Command issuedAt ${command.issuedAt} precedes lease issuedAt ${activeLease.issuedAt}`,
      ),
    }
  }

  if (checkTimeMs >= commandExpiresMs) {
    return {
      ok: false,
      error: createContractError(
        "timeout",
        "command.expired",
        `Command expired at ${command.expiresAt}; current verification time is ${checkTime}`,
      ),
    }
  }

  return { ok: true, value: undefined }
}

export function assertCommandLease(
  command: OrchestrationCommand,
  activeLease: ControllerLease,
  options?: CommandLeaseValidationOptions,
): void {
  const result = validateCommandLease(command, activeLease, options)
  if (!result.ok) {
    throw new InvariantViolationError("command_lease_authority", result.error.message, {
      category: result.error.category,
      code: result.error.code,
    })
  }
}

// --- Aggregate Invariant Validation ---

export function validateRunInvariants(run: Run): Result<void> {
  const createdMs = Date.parse(run.createdAt)
  const updatedMs = Date.parse(run.updatedAt)

  if (updatedMs < createdMs) {
    return {
      ok: false,
      error: createContractError("validation", "run.invalid_timestamps", "Run updatedAt cannot precede createdAt"),
    }
  }

  return { ok: true, value: undefined }
}

export function validateTaskInvariants(task: Task, context?: { runState?: RunState }): Result<void> {
  if (context?.runState !== undefined && isRunTerminal(context.runState)) {
    if (!isTaskTerminal(task.state)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "task.run_terminal",
          `Task cannot be in non-terminal state '${task.state}' when run is in terminal state '${context.runState}'`,
        ),
      }
    }
  }

  return { ok: true, value: undefined }
}

export function validateDispatchInvariants(
  dispatch: Dispatch,
  context?: { runState?: RunState; taskState?: TaskState },
): Result<void> {
  const computedDigest = digestDispatchEnvelope(dispatch.envelope)
  if (dispatch.envelopeDigest !== computedDigest) {
    return {
      ok: false,
      error: createContractError(
        "conflict",
        "dispatch.digest_mismatch",
        `Dispatch envelopeDigest '${dispatch.envelopeDigest}' does not match computed canonical digest '${computedDigest}'`,
      ),
    }
  }

  if (context?.runState !== undefined && isRunTerminal(context.runState)) {
    if (!isDispatchTerminal(dispatch.state)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "dispatch.run_terminal",
          `Dispatch cannot be in non-terminal state '${dispatch.state}' when run is in terminal state '${context.runState}'`,
        ),
      }
    }
  }

  return { ok: true, value: undefined }
}

export function validateApprovalInvariants(approval: Approval, dispatch?: Dispatch): Result<void> {
  if (dispatch !== undefined) {
    return validateApprovalDigest(approval, dispatch)
  }
  return { ok: true, value: undefined }
}

export function validateSessionInvariants(
  session: Session,
  context?: { runState?: RunState; dispatchState?: DispatchState },
): Result<void> {
  if (context?.runState !== undefined && isRunTerminal(context.runState)) {
    if (!isSessionTerminal(session.lifecycleState)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "session.run_terminal",
          `Session cannot be in non-terminal lifecycle state '${session.lifecycleState}' when run is in terminal state '${context.runState}'`,
        ),
      }
    }
  }

  return { ok: true, value: undefined }
}

export { InvalidStateTransitionError, InvariantViolationError }

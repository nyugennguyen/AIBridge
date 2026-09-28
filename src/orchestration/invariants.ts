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
  "dispatch.approve": {
    allowedRunStates: ["draft", "active"],
    allowedDispatchStates: ["proposed"],
    allowedApprovalStates: ["pending", "approved", "invalidated"],
    allowedTaskStates: ["ready"],
  },
  "dispatch.retry": {
    // Retry is deliberately NOT gated on the task being `failed` here: the
    // retryability rule (dependencies, attempt monotonicity) belongs to the
    // scheduler, and the matrix only constrains which lifecycle states a
    // command may act in. The run must be non-terminal, and the previous
    // attempt's dispatch must be terminal so failure history is settled.
    allowedRunStates: ["draft", "active"],
    allowedDispatchStates: ["failed", "cancelled", "timed_out", "completed"],
    allowedTaskStates: ["failed"],
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

  // 1. Run state checks
  if (context.runState !== undefined) {
    if (isRunTerminal(context.runState)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "command.terminal_state_immutable",
          `Cannot execute command '${commandType}': run is in terminal state '${context.runState}'`,
        ),
      }
    }
    if (!rule.allowedRunStates.includes(context.runState)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "command.invalid_run_state",
          `Command '${commandType}' requires run state to be one of [${rule.allowedRunStates.join(", ")}], but received '${context.runState}'`,
        ),
      }
    }
  }

  // 2. Dispatch state checks
  if (context.dispatchState !== undefined && rule.allowedDispatchStates !== undefined) {
    if (isDispatchTerminal(context.dispatchState)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "command.terminal_state_immutable",
          `Cannot execute command '${commandType}': dispatch is in terminal state '${context.dispatchState}'`,
        ),
      }
    }
    if (!rule.allowedDispatchStates.includes(context.dispatchState)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "command.invalid_dispatch_state",
          `Command '${commandType}' requires dispatch state to be one of [${rule.allowedDispatchStates.join(", ")}], but received '${context.dispatchState}'`,
        ),
      }
    }
  }

  // 3. Approval state checks
  if (context.approvalState !== undefined && rule.allowedApprovalStates !== undefined) {
    if (isApprovalTerminal(context.approvalState)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "command.terminal_state_immutable",
          `Cannot execute command '${commandType}': approval is in terminal state '${context.approvalState}'`,
        ),
      }
    }
    if (!rule.allowedApprovalStates.includes(context.approvalState)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "command.invalid_approval_state",
          `Command '${commandType}' requires approval state to be one of [${rule.allowedApprovalStates.join(", ")}], but received '${context.approvalState}'`,
        ),
      }
    }
  }

  // 4. Task state checks
  if (context.taskState !== undefined && rule.allowedTaskStates !== undefined) {
    if (isTaskTerminal(context.taskState)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "command.terminal_state_immutable",
          `Cannot execute command '${commandType}': task is in terminal state '${context.taskState}'`,
        ),
      }
    }
    if (!rule.allowedTaskStates.includes(context.taskState)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "command.invalid_task_state",
          `Command '${commandType}' requires task state to be one of [${rule.allowedTaskStates.join(", ")}], but received '${context.taskState}'`,
        ),
      }
    }
  }

  // 5. Session state checks
  if (context.sessionState !== undefined && rule.allowedSessionStates !== undefined) {
    if (isSessionTerminal(context.sessionState)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "command.terminal_state_immutable",
          `Cannot execute command '${commandType}': session is in terminal state '${context.sessionState}'`,
        ),
      }
    }
    if (!rule.allowedSessionStates.includes(context.sessionState)) {
      return {
        ok: false,
        error: createContractError(
          "conflict",
          "command.invalid_session_state",
          `Command '${commandType}' requires session state to be one of [${rule.allowedSessionStates.join(", ")}], but received '${context.sessionState}'`,
        ),
      }
    }
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

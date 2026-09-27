import { InvalidStateTransitionError, type ContractError, type Result } from "./errors.js"

export type AggregateEntity = "run" | "task" | "dispatch" | "approval" | "session"

export const AGGREGATE_ENTITIES = ["run", "task", "dispatch", "approval", "session"] as const

// --- Run ---
export const RUN_STATES = ["draft", "active", "completed", "failed", "cancelled"] as const
export type RunState = (typeof RUN_STATES)[number]
export const RUN_TERMINAL_STATES = ["completed", "failed", "cancelled"] as const
export type RunTerminalState = (typeof RUN_TERMINAL_STATES)[number]

export const RUN_STATE_SET: ReadonlySet<RunState> = new Set(RUN_STATES)
export const RUN_TERMINAL_SET: ReadonlySet<RunState> = new Set(RUN_TERMINAL_STATES)

export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  draft: ["active", "cancelled"],
  active: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
}

// --- Task ---
export const TASK_STATES = [
  "draft",
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const
export type TaskState = (typeof TASK_STATES)[number]
export const TASK_TERMINAL_STATES = ["completed", "failed", "cancelled", "skipped"] as const
export type TaskTerminalState = (typeof TASK_TERMINAL_STATES)[number]

export const TASK_STATE_SET: ReadonlySet<TaskState> = new Set(TASK_STATES)
export const TASK_TERMINAL_SET: ReadonlySet<TaskState> = new Set(TASK_TERMINAL_STATES)

export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  draft: ["pending", "cancelled"],
  pending: ["ready", "failed", "cancelled", "skipped"],
  ready: ["running", "cancelled", "skipped"],
  running: ["completed", "failed", "cancelled", "ready"],
  completed: [],
  failed: [],
  cancelled: [],
  skipped: [],
}

// --- Dispatch ---
export const DISPATCH_STATES = [
  "proposed",
  "approved",
  "rejected",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const
export type DispatchState = (typeof DISPATCH_STATES)[number]
export const DISPATCH_TERMINAL_STATES = ["rejected", "completed", "failed", "cancelled", "timed_out"] as const
export type DispatchTerminalState = (typeof DISPATCH_TERMINAL_STATES)[number]

export const DISPATCH_STATE_SET: ReadonlySet<DispatchState> = new Set(DISPATCH_STATES)
export const DISPATCH_TERMINAL_SET: ReadonlySet<DispatchState> = new Set(DISPATCH_TERMINAL_STATES)

export const DISPATCH_TRANSITIONS: Readonly<Record<DispatchState, readonly DispatchState[]>> = {
  proposed: ["approved", "rejected", "cancelled"],
  approved: ["running", "cancelled"],
  rejected: [],
  running: ["completed", "failed", "cancelled", "timed_out"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
}

// --- Approval ---
export const APPROVAL_STATES = ["pending", "approved", "rejected", "invalidated"] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]
export const APPROVAL_TERMINAL_STATES = ["rejected", "invalidated"] as const
export type ApprovalTerminalState = (typeof APPROVAL_TERMINAL_STATES)[number]

export const APPROVAL_STATE_SET: ReadonlySet<ApprovalState> = new Set(APPROVAL_STATES)
export const APPROVAL_TERMINAL_SET: ReadonlySet<ApprovalState> = new Set(APPROVAL_TERMINAL_STATES)

export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalState, readonly ApprovalState[]>> = {
  pending: ["approved", "rejected", "invalidated"],
  approved: ["invalidated"],
  rejected: [],
  invalidated: [],
}

// --- Session ---
export const SESSION_STATES = [
  "launching",
  "running",
  "idle",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const
export type SessionState = (typeof SESSION_STATES)[number]
export const SESSION_TERMINAL_STATES = ["completed", "failed", "cancelled", "timed_out"] as const
export type SessionTerminalState = (typeof SESSION_TERMINAL_STATES)[number]

export const SESSION_STATE_SET: ReadonlySet<SessionState> = new Set(SESSION_STATES)
export const SESSION_TERMINAL_SET: ReadonlySet<SessionState> = new Set(SESSION_TERMINAL_STATES)

export const SESSION_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  launching: ["running", "failed", "cancelled", "timed_out"],
  running: ["idle", "completed", "failed", "cancelled", "timed_out"],
  idle: ["running", "completed", "failed", "cancelled", "timed_out"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
}

// --- Terminal State Predicates ---

export function isRunTerminal(state: RunState): boolean {
  return RUN_TERMINAL_SET.has(state)
}

export function isTaskTerminal(state: TaskState): boolean {
  return TASK_TERMINAL_SET.has(state)
}

export function isDispatchTerminal(state: DispatchState): boolean {
  return DISPATCH_TERMINAL_SET.has(state)
}

export function isApprovalTerminal(state: ApprovalState): boolean {
  return APPROVAL_TERMINAL_SET.has(state)
}

export function isSessionTerminal(state: SessionState): boolean {
  return SESSION_TERMINAL_SET.has(state)
}

export function isTerminalState(entity: AggregateEntity, state: string): boolean {
  switch (entity) {
    case "run":
      return RUN_TERMINAL_SET.has(state as RunState)
    case "task":
      return TASK_TERMINAL_SET.has(state as TaskState)
    case "dispatch":
      return DISPATCH_TERMINAL_SET.has(state as DispatchState)
    case "approval":
      return APPROVAL_TERMINAL_SET.has(state as ApprovalState)
    case "session":
      return SESSION_TERMINAL_SET.has(state as SessionState)
  }
}

// --- Transition Possibility Predicates ---

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from]?.includes(to) ?? false
}

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false
}

export function canTransitionDispatch(from: DispatchState, to: DispatchState): boolean {
  return DISPATCH_TRANSITIONS[from]?.includes(to) ?? false
}

export function canTransitionApproval(from: ApprovalState, to: ApprovalState): boolean {
  return APPROVAL_TRANSITIONS[from]?.includes(to) ?? false
}

export function canTransitionSession(from: SessionState, to: SessionState): boolean {
  return SESSION_TRANSITIONS[from]?.includes(to) ?? false
}

export function canTransition(entity: AggregateEntity, from: string, to: string): boolean {
  switch (entity) {
    case "run":
      return canTransitionRun(from as RunState, to as RunState)
    case "task":
      return canTransitionTask(from as TaskState, to as TaskState)
    case "dispatch":
      return canTransitionDispatch(from as DispatchState, to as DispatchState)
    case "approval":
      return canTransitionApproval(from as ApprovalState, to as ApprovalState)
    case "session":
      return canTransitionSession(from as SessionState, to as SessionState)
  }
}

// --- State Machine Transition Functions (throw InvalidStateTransitionError) ---

export function transitionRun(from: RunState, to: RunState): RunState {
  if (!RUN_STATE_SET.has(from)) {
    throw new InvalidStateTransitionError("run", from, to, { reason: `Unknown source state '${from}'` })
  }
  if (!RUN_STATE_SET.has(to)) {
    throw new InvalidStateTransitionError("run", from, to, { reason: `Unknown target state '${to}'` })
  }
  if (isRunTerminal(from)) {
    throw new InvalidStateTransitionError("run", from, to, { isTerminal: true })
  }
  if (!canTransitionRun(from, to)) {
    throw new InvalidStateTransitionError("run", from, to)
  }
  return to
}

export function transitionTask(from: TaskState, to: TaskState): TaskState {
  if (!TASK_STATE_SET.has(from)) {
    throw new InvalidStateTransitionError("task", from, to, { reason: `Unknown source state '${from}'` })
  }
  if (!TASK_STATE_SET.has(to)) {
    throw new InvalidStateTransitionError("task", from, to, { reason: `Unknown target state '${to}'` })
  }
  if (isTaskTerminal(from)) {
    throw new InvalidStateTransitionError("task", from, to, { isTerminal: true })
  }
  if (!canTransitionTask(from, to)) {
    throw new InvalidStateTransitionError("task", from, to)
  }
  return to
}

export function transitionDispatch(from: DispatchState, to: DispatchState): DispatchState {
  if (!DISPATCH_STATE_SET.has(from)) {
    throw new InvalidStateTransitionError("dispatch", from, to, { reason: `Unknown source state '${from}'` })
  }
  if (!DISPATCH_STATE_SET.has(to)) {
    throw new InvalidStateTransitionError("dispatch", from, to, { reason: `Unknown target state '${to}'` })
  }
  if (isDispatchTerminal(from)) {
    throw new InvalidStateTransitionError("dispatch", from, to, { isTerminal: true })
  }
  if (!canTransitionDispatch(from, to)) {
    throw new InvalidStateTransitionError("dispatch", from, to)
  }
  return to
}

export function transitionApproval(from: ApprovalState, to: ApprovalState): ApprovalState {
  if (!APPROVAL_STATE_SET.has(from)) {
    throw new InvalidStateTransitionError("approval", from, to, { reason: `Unknown source state '${from}'` })
  }
  if (!APPROVAL_STATE_SET.has(to)) {
    throw new InvalidStateTransitionError("approval", from, to, { reason: `Unknown target state '${to}'` })
  }
  if (isApprovalTerminal(from)) {
    throw new InvalidStateTransitionError("approval", from, to, { isTerminal: true })
  }
  if (!canTransitionApproval(from, to)) {
    throw new InvalidStateTransitionError("approval", from, to)
  }
  return to
}

export function transitionSession(from: SessionState, to: SessionState): SessionState {
  if (!SESSION_STATE_SET.has(from)) {
    throw new InvalidStateTransitionError("session", from, to, { reason: `Unknown source state '${from}'` })
  }
  if (!SESSION_STATE_SET.has(to)) {
    throw new InvalidStateTransitionError("session", from, to, { reason: `Unknown target state '${to}'` })
  }
  if (isSessionTerminal(from)) {
    throw new InvalidStateTransitionError("session", from, to, { isTerminal: true })
  }
  if (!canTransitionSession(from, to)) {
    throw new InvalidStateTransitionError("session", from, to)
  }
  return to
}

export function transitionAggregate(entity: AggregateEntity, from: string, to: string): string {
  switch (entity) {
    case "run":
      return transitionRun(from as RunState, to as RunState)
    case "task":
      return transitionTask(from as TaskState, to as TaskState)
    case "dispatch":
      return transitionDispatch(from as DispatchState, to as DispatchState)
    case "approval":
      return transitionApproval(from as ApprovalState, to as ApprovalState)
    case "session":
      return transitionSession(from as SessionState, to as SessionState)
  }
}

// --- Result-based Transition Functions ---

export function tryTransitionRun(from: RunState, to: RunState): Result<RunState> {
  try {
    return { ok: true, value: transitionRun(from, to) }
  } catch (error) {
    if (error instanceof InvalidStateTransitionError) {
      return { ok: false, error: error.toContractError() }
    }
    throw error
  }
}

export function tryTransitionTask(from: TaskState, to: TaskState): Result<TaskState> {
  try {
    return { ok: true, value: transitionTask(from, to) }
  } catch (error) {
    if (error instanceof InvalidStateTransitionError) {
      return { ok: false, error: error.toContractError() }
    }
    throw error
  }
}

export function tryTransitionDispatch(from: DispatchState, to: DispatchState): Result<DispatchState> {
  try {
    return { ok: true, value: transitionDispatch(from, to) }
  } catch (error) {
    if (error instanceof InvalidStateTransitionError) {
      return { ok: false, error: error.toContractError() }
    }
    throw error
  }
}

export function tryTransitionApproval(from: ApprovalState, to: ApprovalState): Result<ApprovalState> {
  try {
    return { ok: true, value: transitionApproval(from, to) }
  } catch (error) {
    if (error instanceof InvalidStateTransitionError) {
      return { ok: false, error: error.toContractError() }
    }
    throw error
  }
}

export function tryTransitionSession(from: SessionState, to: SessionState): Result<SessionState> {
  try {
    return { ok: true, value: transitionSession(from, to) }
  } catch (error) {
    if (error instanceof InvalidStateTransitionError) {
      return { ok: false, error: error.toContractError() }
    }
    throw error
  }
}

export function tryTransitionAggregate(entity: AggregateEntity, from: string, to: string): Result<string> {
  try {
    return { ok: true, value: transitionAggregate(entity, from, to) }
  } catch (error) {
    if (error instanceof InvalidStateTransitionError) {
      return { ok: false, error: error.toContractError() }
    }
    throw error
  }
}

export { InvalidStateTransitionError }

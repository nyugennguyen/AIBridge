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
  // `launching -> idle` and `launching -> completed` exist because a provider can
  // legitimately report a session as idle (started, awaiting input) or finished
  // (fast task, or a lost status event) without the kernel ever observing it
  // `running`. These transitions were unreachable while callers assigned session
  // state directly instead of going through this machine; now that they must, the
  // gaps have to be closed rather than papered over.
  launching: ["running", "idle", "completed", "failed", "cancelled", "timed_out"],
  running: ["idle", "completed", "failed", "cancelled", "timed_out"],
  idle: ["running", "completed", "failed", "cancelled", "timed_out"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
}

// --- Session provider observation vocabulary ---
//
// A provider reports what its process is doing; the kernel records what the
// dispatch lifecycle is. The two vocabularies are different axes and are never
// merged: `SessionObservedState` is an observation and never drives lifecycle on
// its own. Only `mapObservedSessionLifecycle` translates between them.

export const SESSION_OBSERVED_STATES = [
  "starting",
  "idle",
  "working",
  "blocked",
  "completed",
  "failed",
  "unknown",
] as const
export type SessionObservedState = (typeof SESSION_OBSERVED_STATES)[number]

export const SESSION_OBSERVED_STATE_SET: ReadonlySet<string> = new Set(SESSION_OBSERVED_STATES)

export class UnhandledSessionObservationError extends Error {
  readonly observedState: string

  constructor(observedState: string) {
    super(
      `Unhandled session observation '${observedState}': every provider observation must map to a kernel session lifecycle state or explicitly to no lifecycle claim. Known observations: ${SESSION_OBSERVED_STATES.join(", ")}.`,
    )
    this.name = "UnhandledSessionObservationError"
    this.observedState = observedState
  }
}

export function isSessionObservedState(value: string): value is SessionObservedState {
  return SESSION_OBSERVED_STATE_SET.has(value)
}

/**
 * Total translation from provider observation vocabulary to kernel session
 * lifecycle. `unknown` deliberately yields `null`: an observation that carries
 * no information must not move the lifecycle, and the kernel must never invent
 * a lifecycle claim from it.
 *
 * The switch is exhaustive over the provider vocabulary and throws for anything
 * outside it, so a new provider state cannot be silently absorbed.
 */
export function mapObservedSessionLifecycle(observed: SessionObservedState): SessionState | null {
  switch (observed) {
    case "starting":
      return "launching"
    case "working":
      return "running"
    case "idle":
      return "idle"
    case "blocked":
      return "idle"
    case "completed":
      return "completed"
    case "failed":
      return "failed"
    case "unknown":
      return null
    default:
      throw new UnhandledSessionObservationError(observed)
  }
}

/**
 * Applies a provider observation to the kernel session lifecycle, always through
 * the machine. A terminal lifecycle is absorbing and a lifecycle-less
 * observation is a no-op, so no observation can corrupt a finished dispatch.
 */
export function advanceSessionLifecycle(current: SessionState, observed: SessionObservedState): SessionState {
  const target = mapObservedSessionLifecycle(observed)
  if (target === null || target === current) return current
  if (isSessionTerminal(current)) return current
  return transitionSession(current, target)
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

// --- Legal-path resolution (projections derive states; the machine validates them) ---

/**
 * Walks the machine's own transition table breadth-first to find a legal path
 * from `from` to `to`, applying every hop through the throwing transition
 * function. A projection may therefore only ever write a state the aggregate
 * can actually reach, and every intermediate hop is machine-validated.
 *
 * When no path exists the direct transition function is invoked so the caller
 * receives the canonical `InvalidStateTransitionError` (including terminal
 * immutability) rather than a bespoke error.
 */
function resolveThroughMachine<S extends string>(
  from: S,
  to: S,
  table: Readonly<Record<S, readonly S[]>>,
  step: (from: S, to: S) => S,
): S {
  if (from === to) return from

  const queue: S[][] = [[from]]
  const visited: Set<S> = new Set([from])

  while (queue.length > 0) {
    const path = queue.shift() as S[]
    const tail = path[path.length - 1] as S
    for (const next of table[tail] ?? []) {
      if (next === to) {
        let state = from
        for (const hop of [...path.slice(1), next]) state = step(state, hop)
        return state
      }
      if (!visited.has(next)) {
        visited.add(next)
        queue.push([...path, next])
      }
    }
  }

  return step(from, to)
}

export function resolveRunState(from: RunState, to: RunState): RunState {
  return resolveThroughMachine(from, to, RUN_TRANSITIONS, transitionRun)
}

export function resolveTaskState(from: TaskState, to: TaskState): TaskState {
  return resolveThroughMachine(from, to, TASK_TRANSITIONS, transitionTask)
}

export function resolveDispatchState(from: DispatchState, to: DispatchState): DispatchState {
  return resolveThroughMachine(from, to, DISPATCH_TRANSITIONS, transitionDispatch)
}

export function resolveSessionState(from: SessionState, to: SessionState): SessionState {
  return resolveThroughMachine(from, to, SESSION_TRANSITIONS, transitionSession)
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

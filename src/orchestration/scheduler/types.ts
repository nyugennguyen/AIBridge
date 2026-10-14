import { type ContractError, type ErrorCategory, createContractError } from "../errors.js"
import type {
  DispatchId,
  ProjectId,
  RunId,
  TaskId,
  Timestamp,
} from "../identifiers.js"
import type { Dispatch, DispatchEnvelope, TaskDependency } from "../types.js"
import type {
  DispatchProjection,
  ProjectionTaskState,
  RunProjectionState,
  TaskProjection,
} from "../projections/types.js"

// --- Error Classes ---

export class SchedulerError extends Error {
  readonly code: string
  readonly category: ErrorCategory

  constructor(message: string, code: string, category: ErrorCategory = "validation") {
    super(message)
    this.name = "SchedulerError"
    this.code = code
    this.category = category
  }

  toContractError(): ContractError {
    return createContractError(this.category, this.code, this.message)
  }
}

export type CycleType = "self" | "direct" | "indirect"

export class DependencyCycleError extends SchedulerError {
  readonly cycle: readonly TaskId[]
  readonly cycleType: CycleType

  constructor(cycle: readonly (TaskId | string)[], cycleType?: CycleType) {
    const cyclePath = cycle.join(" -> ")
    const detectedType: CycleType = cycleType ?? (
      cycle.length === 2 && cycle[0] === cycle[1]
        ? "self"
        : cycle.length === 3 && cycle[0] === cycle[2]
          ? "direct"
          : "indirect"
    )
    const msg = detectedType === "self"
      ? `Self-dependency detected for task '${cycle[0]}': a task cannot depend on itself (${cyclePath})`
      : `${detectedType === "direct" ? "Direct" : "Indirect"} cycle detected in task dependencies: ${cyclePath}`
    super(msg, "scheduler.cycle_detected", "validation")
    this.name = "DependencyCycleError"
    this.cycle = cycle as readonly TaskId[]
    this.cycleType = detectedType
  }
}

export class DanglingDependencyError extends SchedulerError {
  readonly taskId: TaskId
  readonly dependencyTaskId: TaskId
  readonly missingDependencyId: TaskId

  constructor(taskId: TaskId | string, dependencyTaskId: TaskId | string) {
    super(
      `Task '${taskId}' depends on non-existent task '${dependencyTaskId}' in the run`,
      "scheduler.missing_dependency",
      "validation",
    )
    this.name = "DanglingDependencyError"
    this.taskId = taskId as TaskId
    this.dependencyTaskId = dependencyTaskId as TaskId
    this.missingDependencyId = dependencyTaskId as TaskId
  }
}

export class DependencyEditForbiddenError extends SchedulerError {
  readonly taskId: TaskId
  readonly currentState: string

  constructor(taskId: TaskId | string, currentState: string) {
    super(
      `Cannot modify dependencies for task '${taskId}' in state '${currentState}': dependencies can only be modified while a task is in 'draft' state`,
      "scheduler.dependency_edit_forbidden",
      "conflict",
    )
    this.name = "DependencyEditForbiddenError"
    this.taskId = taskId as TaskId
    this.currentState = currentState
  }
}

export class TaskNotFoundError extends SchedulerError {
  readonly taskId: TaskId

  constructor(taskId: TaskId | string) {
    super(`Task '${taskId}' was not found in the run projection`, "scheduler.task_not_found", "validation")
    this.name = "TaskNotFoundError"
    this.taskId = taskId as TaskId
  }
}

export class TaskNotRetryableError extends SchedulerError {
  readonly taskId: TaskId
  readonly currentState: string

  constructor(taskId: TaskId | string, currentState: string, reason?: string) {
    super(
      reason ?? `Task '${taskId}' in state '${currentState}' cannot be retried: only failed tasks can be retried`,
      "scheduler.task_not_retryable",
      "conflict",
    )
    this.name = "TaskNotRetryableError"
    this.taskId = taskId as TaskId
    this.currentState = currentState
  }
}

// Aliases for alternate naming conventions
export {
  DependencyCycleError as CycleDetectedError,
  DanglingDependencyError as MissingDependencyError,
  DependencyEditForbiddenError as InvalidDependencyModificationError,
}

// --- Failure Policy Types ---

export type FailurePolicy = "fail_fast" | "continue" | "skip"
export type ConfiguredFailurePolicy = FailurePolicy | "fail" | "block"

// --- DAG Analysis Types ---

export interface TaskGraphNode {
  readonly taskId: TaskId
  readonly dependencies: readonly TaskDependency[]
  readonly state?: ProjectionTaskState
  readonly failurePolicy?: "block" | "fail" | null
}

export interface ExecutionStage {
  readonly stageIndex: number
  readonly taskIds: readonly TaskId[]
}

export interface DagAnalysis {
  readonly taskIds: readonly TaskId[]
  readonly topologicalOrder: readonly TaskId[]
  readonly stages: readonly (readonly TaskId[])[]
  readonly inDegree: Readonly<Record<string, number>>
  readonly outDegree: Readonly<Record<string, number>>
  readonly adjacencyList: Readonly<Record<string, readonly TaskId[]>>
  readonly reverseAdjacencyList: Readonly<Record<string, readonly TaskId[]>>
}

// --- Scheduler Types ---

export interface SchedulerOptions {
  readonly maxConcurrency?: number
  readonly defaultFailurePolicy?: FailurePolicy
}

export type TaskReadinessStatus =
  | "ready"
  | "waiting"
  | "skipped"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export interface TaskReadiness {
  readonly taskId: TaskId
  readonly status: TaskReadinessStatus
  readonly currentTaskState: ProjectionTaskState
  readonly unsatisfiedDependencies: readonly TaskId[]
  readonly failedDependencies: readonly TaskId[]
  readonly failurePolicy: FailurePolicy
  readonly reason?: string
}

export interface TaskToSkip {
  readonly taskId: TaskId
  readonly targetState: "skipped" | "cancelled"
  readonly failedDependencies: readonly TaskId[]
  readonly reason: string
}

export interface ScheduleResult {
  readonly eligibleTasks: readonly TaskProjection[]
  readonly deferredTasks: readonly TaskProjection[]
  readonly tasksToSkip: readonly TaskToSkip[]
  readonly runningCount: number
  readonly availableCapacity: number
  readonly readiness: Readonly<Record<string, TaskReadiness>>
}

// --- Retry Types ---

export interface RetryTaskOptions {
  readonly dispatchId?: DispatchId
  readonly envelopeOverrides?: Partial<DispatchEnvelope>
  /**
   * Base envelope for the new attempt when the projection carries no historical
   * envelope to inherit from — for example a dispatch projection reconstructed
   * from a bare `dispatch.finished` event. When omitted, the most recent
   * historical envelope is used; when neither exists the task is not
   * retryable.
   */
  readonly baseEnvelope?: DispatchEnvelope
  /** Injected clock. Retry must be deterministic, so this is never defaulted to `Date.now()`. */
  readonly now?: string
}

export interface RetryTaskResult {
  readonly taskId: TaskId
  readonly nextAttempt: number
  readonly nextDispatchId: DispatchId
  readonly dispatchEnvelope: DispatchEnvelope
  readonly updatedTask: TaskProjection
}

// --- Budget Ledger Port Types ---

/**
 * Shape of a budget refusal, structurally compatible with BudgetRefusal from src/budgets/
 * without importing src/budgets/ directly (layering rule: budgets -> orchestration).
 */
export interface BudgetRefusalShape {
  readonly code: string
  readonly message: string
  readonly scope?: string | null
  readonly limit?: number | null
  readonly heldUnits?: number | null
  readonly requestedUnits?: number | null
  readonly reservationId?: string | null
}

export type BudgetReservationResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: BudgetRefusalShape }

export interface BudgetReserveParams {
  readonly reservationId: string
  readonly projectId: string
  readonly runId: string
  readonly taskId: string
  readonly dispatchId: string
  readonly scope: "concurrency" | "fan_out"
  readonly units: number
  readonly now: string
  readonly leaseSeconds?: number
  readonly subScope?: string
}

/**
 * The budget ledger port consumed by the scheduler.
 * Injected interface so orchestration does not depend on src/budgets/.
 */
export interface BudgetLedgerPort {
  reserve(request: BudgetReserveParams): Promise<BudgetReservationResult> | BudgetReservationResult
  reserveSync?(request: BudgetReserveParams, limits?: unknown): BudgetReservationResult
  heldUnits?(projectId: string, scope: "concurrency" | "fan_out", subScope?: string): number
  eligible?(dispatchId: string): boolean
}

// --- Fan-Out Planning Types ---

export interface PlanFanOutOptions {
  readonly parentDispatch: Dispatch
  readonly fanOut?: number
  readonly now?: string
  readonly budgetLedger?: BudgetLedgerPort
  readonly leaseSeconds?: number
  readonly envelopeOverrides?: readonly Partial<DispatchEnvelope>[]
}

export interface PlanFanOutSyncOptions {
  readonly parentDispatch: Dispatch
  readonly fanOut?: number
  readonly now?: string
  readonly budgetLedger?: BudgetLedgerPort
  readonly leaseSeconds?: number
  readonly envelopeOverrides?: readonly Partial<DispatchEnvelope>[]
}

export interface RefusedSiblingDispatch {
  readonly siblingDispatchId: DispatchId
  readonly index: number
  readonly refusal: BudgetRefusalShape
}

export interface PlanFanOutResult {
  readonly parentDispatchId: DispatchId
  readonly requestedFanOut: number
  readonly plannedDispatches: readonly Dispatch[]
  readonly refusedDispatches: readonly RefusedSiblingDispatch[]
}

// --- Sibling Cancellation Types ---

export interface SiblingCancellationResult {
  readonly updatedRunState: RunProjectionState
  readonly cancelledDispatchIds: readonly DispatchId[]
  readonly parentDispatchId: DispatchId | null
}

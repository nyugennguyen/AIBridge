import { digestDispatchEnvelope, digestJson } from "../digest.js"
import type { DispatchId, TaskId } from "../identifiers.js"
import type { DispatchEnvelope } from "../types.js"
import type {
  DispatchProjection,
  ProjectionTaskState,
  RunProjectionState,
  TaskProjection,
} from "../projections/types.js"
import { validateDag } from "./dag.js"
import {
  type ConfiguredFailurePolicy,
  type FailurePolicy,
  type RetryTaskOptions,
  type RetryTaskResult,
  type ScheduleResult,
  type SchedulerOptions,
  type TaskReadiness,
  type TaskToSkip,
  TaskNotFoundError,
  TaskNotRetryableError,
} from "./types.js"

/**
 * Normalizes a failure policy configuration to canonical "fail_fast" | "continue" | "skip".
 * Maps schema values:
 * - "fail" -> "fail_fast"
 * - "block" -> "skip"
 * - "fail_fast" -> "fail_fast"
 * - "continue" -> "continue"
 * - "skip" -> "skip"
 */
export function normalizeFailurePolicy(
  policy?: ConfiguredFailurePolicy | null,
  fallback: FailurePolicy = "fail_fast",
): FailurePolicy {
  if (!policy) return fallback
  switch (policy) {
    case "fail":
    case "fail_fast":
      return "fail_fast"
    case "block":
    case "skip":
      return "skip"
    case "continue":
      return "continue"
    default:
      return fallback
  }
}

/**
 * Evaluates the readiness of all tasks in a RunProjectionState according to DAG dependencies
 * and failure policies.
 *
 * Rules:
 * - A task is ready when in 'pending' or 'draft' (or 'blocked') state and ALL prerequisite dependencies
 *   are 'completed' (or satisfied under 'continue' policy).
 * - Default fail-fast: if any dependency fails, is cancelled, or is skipped, dependent tasks
 *   cascade to 'skipped'.
 * - Continue-on-failure: if a dependency fails/cancels and policy is 'continue', the task may still proceed.
 * - In-flight dependencies cause the task to wait.
 */
export function evaluateTaskReadiness(
  runState: RunProjectionState,
  options?: SchedulerOptions,
): Readonly<Record<string, TaskReadiness>> {
  const dag = validateDag(runState)
  const defaultPolicy = options?.defaultFailurePolicy ?? "fail_fast"

  const readiness: Record<string, TaskReadiness> = {}
  const toSkipMap = new Map<string, TaskToSkip>()

  // Process in topological order so prerequisite failure states cascade downstream
  for (const taskId of dag.topologicalOrder) {
    const task = runState.tasks[taskId]
    if (!task) continue

    const currentState = task.state

    // Terminal or already running tasks preserve their existing state
    if (
      currentState === "completed" ||
      currentState === "running" ||
      currentState === "failed" ||
      currentState === "cancelled" ||
      currentState === "skipped"
    ) {
      readiness[taskId] = {
        taskId,
        status: currentState,
        currentTaskState: currentState,
        unsatisfiedDependencies: [],
        failedDependencies: [],
        failurePolicy: normalizeFailurePolicy(task.failurePolicy, defaultPolicy),
        reason: `Task is already in state '${currentState}'`,
      }
      continue
    }

    // Task is in 'draft', 'pending', 'ready', or 'blocked'
    const dependencies = task.dependencies ?? []
    const unsatisfiedDependencies: TaskId[] = []
    const failedDependencies: TaskId[] = []
    let taskMustBeSkipped = false
    let dominantPolicy: FailurePolicy = normalizeFailurePolicy(task.failurePolicy, defaultPolicy)

    for (const dep of dependencies) {
      const depTaskId = dep.taskId
      const depTask = runState.tasks[depTaskId]
      const depPolicy = normalizeFailurePolicy(dep.failurePolicy ?? task.failurePolicy, defaultPolicy)

      const isDepFailedOrSkipped =
        toSkipMap.has(depTaskId) ||
        (depTask !== undefined &&
          (depTask.state === "failed" || depTask.state === "cancelled" || depTask.state === "skipped"))

      const isDepCompleted = depTask !== undefined && depTask.state === "completed"

      if (isDepFailedOrSkipped) {
        failedDependencies.push(depTaskId)
        if (depPolicy === "fail_fast" || depPolicy === "skip") {
          taskMustBeSkipped = true
          dominantPolicy = depPolicy
        }
      } else if (isDepCompleted) {
        // Prerequisite completed successfully
      } else {
        // Prerequisite is still running, pending, or waiting
        unsatisfiedDependencies.push(depTaskId)
      }
    }

    if (taskMustBeSkipped) {
      const toSkipRecord: TaskToSkip = {
        taskId,
        targetState: "skipped",
        failedDependencies,
        reason: `Prerequisite dependency [${failedDependencies.join(", ")}] failed under policy '${dominantPolicy}'`,
      }
      toSkipMap.set(taskId, toSkipRecord)

      readiness[taskId] = {
        taskId,
        status: "skipped",
        currentTaskState: currentState,
        unsatisfiedDependencies,
        failedDependencies,
        failurePolicy: dominantPolicy,
        reason: toSkipRecord.reason,
      }
    } else if (failedDependencies.length > 0 && dominantPolicy === "continue") {
      // Continue-on-failure: prerequisites reached terminal state, allow task to proceed if no in-flight prerequisites remain
      if (unsatisfiedDependencies.length === 0) {
        readiness[taskId] = {
          taskId,
          status: "ready",
          currentTaskState: currentState,
          unsatisfiedDependencies: [],
          failedDependencies,
          failurePolicy: "continue",
          reason: `All prerequisites satisfied (failed prerequisites [${failedDependencies.join(", ")}] permitted under continue policy)`,
        }
      } else {
        readiness[taskId] = {
          taskId,
          status: "waiting",
          currentTaskState: currentState,
          unsatisfiedDependencies,
          failedDependencies,
          failurePolicy: "continue",
          reason: `Waiting for in-flight prerequisites: ${unsatisfiedDependencies.join(", ")}`,
        }
      }
    } else if (unsatisfiedDependencies.length === 0) {
      // All prerequisites completed successfully (or task has 0 prerequisites)
      readiness[taskId] = {
        taskId,
        status: "ready",
        currentTaskState: currentState,
        unsatisfiedDependencies: [],
        failedDependencies: [],
        failurePolicy: dominantPolicy,
        reason: dependencies.length === 0 ? "No prerequisites" : "All prerequisites completed",
      }
    } else {
      // Waiting for active prerequisites
      readiness[taskId] = {
        taskId,
        status: "waiting",
        currentTaskState: currentState,
        unsatisfiedDependencies,
        failedDependencies: [],
        failurePolicy: dominantPolicy,
        reason: `Waiting for active prerequisites: ${unsatisfiedDependencies.join(", ")}`,
      }
    }
  }

  return readiness
}

/**
 * Checks whether a single task in a run is currently ready for dispatch.
 */
export function isTaskReady(
  task: TaskProjection,
  runState: RunProjectionState,
  options?: SchedulerOptions,
): boolean {
  const readiness = evaluateTaskReadiness(runState, options)
  return readiness[task.taskId]?.status === "ready"
}

/**
 * Main scheduler entry point:
 * 1. Analyzes DAG readiness across all tasks in the run.
 * 2. Propagates failures according to failure policies (fail_fast, continue, skip).
 * 3. Enforces maxConcurrency limits to select eligible tasks for immediate dispatch.
 * 4. Defers excess ready tasks when concurrency capacity is exhausted.
 */
export function schedule(
  runState: RunProjectionState,
  options?: SchedulerOptions,
): ScheduleResult {
  const dag = validateDag(runState)
  const readiness = evaluateTaskReadiness(runState, options)

  // Identify currently running tasks
  const runningTasks = Object.values(runState.tasks).filter((t) => t.state === "running")
  const runningCount = runningTasks.length

  // Build a lookup map of task stage for deterministic ordering
  const taskStageMap = new Map<string, number>()
  dag.stages.forEach((stageTaskIds, stageIndex) => {
    for (const id of stageTaskIds) {
      taskStageMap.set(id, stageIndex)
    }
  })

  // Filter ready tasks that are not yet actively running or terminal
  const readyTasks: TaskProjection[] = []
  const tasksToSkip: TaskToSkip[] = []

  for (const taskId of dag.topologicalOrder) {
    const task = runState.tasks[taskId]
    if (!task) continue

    const r = readiness[taskId]
    if (!r) continue

    if (r.status === "ready" && task.state !== "running" && task.state !== "completed") {
      readyTasks.push(task)
    } else if (
      r.status === "skipped" &&
      task.state !== "skipped" &&
      task.state !== "failed" &&
      task.state !== "cancelled"
    ) {
      tasksToSkip.push({
        taskId: task.taskId,
        targetState: "skipped",
        failedDependencies: r.failedDependencies,
        reason: r.reason ?? "Prerequisite dependency failed",
      })
    }
  }

  // Deterministic sorting of ready tasks:
  // 1. Earlier topological stage first
  // 2. Earlier createdAt timestamp
  // 3. Alphabetical taskId
  readyTasks.sort((a, b) => {
    const stageA = taskStageMap.get(a.taskId) ?? 0
    const stageB = taskStageMap.get(b.taskId) ?? 0
    if (stageA !== stageB) return stageA - stageB

    const timeA = Date.parse(a.createdAt)
    const timeB = Date.parse(b.createdAt)
    if (timeA !== timeB) return timeA - timeB

    return a.taskId.localeCompare(b.taskId)
  })

  // Concurrency limit allocation
  const maxConcurrency = options?.maxConcurrency
  let availableCapacity: number
  let eligibleTasks: TaskProjection[]
  let deferredTasks: TaskProjection[]

  if (typeof maxConcurrency === "number" && maxConcurrency > 0) {
    availableCapacity = Math.max(0, maxConcurrency - runningCount)
    eligibleTasks = readyTasks.slice(0, availableCapacity)
    deferredTasks = readyTasks.slice(availableCapacity)
  } else {
    availableCapacity = Number.POSITIVE_INFINITY
    eligibleTasks = readyTasks
    deferredTasks = []
  }

  return {
    eligibleTasks,
    deferredTasks,
    tasksToSkip,
    runningCount,
    availableCapacity,
    readiness,
  }
}

/**
 * Returns tasks ready for execution in the run projection.
 */
export function getReadyTasks(
  runState: RunProjectionState,
  options?: SchedulerOptions,
): readonly TaskProjection[] {
  const sched = schedule(runState, options)
  return [...sched.eligibleTasks, ...sched.deferredTasks]
}

/**
 * Returns tasks immediately eligible for dispatch honoring concurrency limit.
 */
export function getEligibleTasks(
  runState: RunProjectionState,
  options?: SchedulerOptions,
): readonly TaskProjection[] {
  return schedule(runState, options).eligibleTasks
}

/**
 * Returns tasks that should transition to 'skipped' due to dependency failure.
 */
export function getTasksToSkip(
  runState: RunProjectionState,
  options?: SchedulerOptions,
): readonly TaskToSkip[] {
  return schedule(runState, options).tasksToSkip
}

/**
 * Retry semantics for failed tasks:
 * Retrying a failed task transitions it to 'ready' and creates a new dispatch attempt
 * without erasing past attempt history.
 *
 * Rules:
 * 1. Task must exist and be in 'failed' state.
 * 2. Prerequisite dependencies must be satisfied (or permitted under continue policy).
 * 3. Next attempt number is monotonically incremented past all previous attempts.
 * 4. A new dispatch attempt proposal is generated; past dispatches remain intact in history.
 */
export function retryTask(
  runState: RunProjectionState,
  taskId: TaskId | string,
  options?: RetryTaskOptions,
): RetryTaskResult {
  const id = taskId as TaskId
  const task = runState.tasks[id]

  if (!task) {
    throw new TaskNotFoundError(id)
  }

  if (task.state !== "failed") {
    throw new TaskNotRetryableError(
      id,
      task.state,
      `Task '${id}' is in state '${task.state}', but only 'failed' tasks can be retried`,
    )
  }

  // Validate that prerequisites do not block retrying
  for (const dep of task.dependencies ?? []) {
    const depTaskId = dep.taskId
    const depTask = runState.tasks[depTaskId]
    const depPolicy = normalizeFailurePolicy(dep.failurePolicy ?? task.failurePolicy, "fail_fast")

    const isDepFailed =
      depTask !== undefined &&
      (depTask.state === "failed" || depTask.state === "cancelled" || depTask.state === "skipped")

    if (isDepFailed && (depPolicy === "fail_fast" || depPolicy === "skip")) {
      throw new TaskNotRetryableError(
        id,
        task.state,
        `Cannot retry task '${id}' because prerequisite dependency '${depTaskId}' has failed under policy '${depPolicy}'`,
      )
    }

    if (!depTask || depTask.state !== "completed") {
      if (depPolicy !== "continue") {
        throw new TaskNotRetryableError(
          id,
          task.state,
          `Cannot retry task '${id}' because prerequisite dependency '${depTaskId}' is not completed (current state: '${depTask?.state ?? "missing"}')`,
        )
      }
    }
  }

  // Compute next attempt number monotonically
  const pastDispatches = Object.values(runState.dispatches).filter((d) => d.taskId === id)
  const pastAttempts = pastDispatches.map((d) => d.attempt)
  const maxAttempt = Math.max(task.dispatchAttempts ?? 0, ...pastAttempts, 0)
  const nextAttempt = maxAttempt + 1

  // Find the most recent dispatch for this task to inherit envelope configuration
  const latestDispatch = pastDispatches.sort((a, b) => b.attempt - a.attempt)[0]

  const nextDispatchId = (
    options?.dispatchId ??
    options?.envelopeOverrides?.dispatchId ??
    `${id}-dispatch-${nextAttempt}`
  ) as DispatchId

  const baseEnvelope = latestDispatch?.envelope
  if (!baseEnvelope) {
    throw new TaskNotRetryableError(
      id,
      task.state,
      `Cannot retry task '${id}': no historical dispatch envelope found to recreate attempt`,
    )
  }

  const newEnvelope: DispatchEnvelope = {
    ...baseEnvelope,
    dispatchId: nextDispatchId,
    attempt: nextAttempt,
    ...options?.envelopeOverrides,
  }

  const updatedTask: TaskProjection = {
    ...task,
    state: "ready",
    currentDispatchId: nextDispatchId,
    dispatchAttempts: nextAttempt,
    updatedAt: new Date().toISOString(),
  }

  return {
    taskId: id,
    nextAttempt,
    nextDispatchId,
    dispatchEnvelope: newEnvelope,
    updatedTask,
  }
}

function stripUndefined<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T
  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (val !== undefined) {
      result[key] = stripUndefined(val)
    }
  }
  return result as T
}

/**
 * Applies a RetryTaskResult directly to a RunProjectionState, returning an updated state.
 *
 * Guarantees that ALL historical dispatches (including previous failed attempts)
 * are preserved intact, and the new dispatch attempt is appended with state 'proposed'.
 */
export function applyRetryToRunState(
  runState: RunProjectionState,
  retryResult: RetryTaskResult,
  now = new Date().toISOString(),
): RunProjectionState {
  const newDispatchProjection: DispatchProjection = {
    dispatchId: retryResult.nextDispatchId,
    taskId: retryResult.taskId,
    runId: runState.run.runId,
    projectId: runState.run.projectId,
    envelopeDigest: digestDispatchEnvelope(retryResult.dispatchEnvelope),
    envelope: retryResult.dispatchEnvelope,
    state: "proposed",
    approvalId: null,
    sessionId: null,
    attempt: retryResult.nextAttempt,
    createdAt: now,
    updatedAt: now,
    outcome: null,
    summary: null,
  }

  const nextDispatches: Record<string, DispatchProjection> = {
    ...runState.dispatches,
    [retryResult.nextDispatchId]: newDispatchProjection,
  }

  const nextTasks: Record<string, TaskProjection> = {
    ...runState.tasks,
    [retryResult.taskId]: retryResult.updatedTask,
  }

  const stateWithoutDigest = {
    run: { ...runState.run, updatedAt: now },
    tasks: nextTasks,
    dispatches: nextDispatches,
    approvals: runState.approvals,
    sessions: runState.sessions,
    artifacts: runState.artifacts,
    lastAppliedSequence: runState.lastAppliedSequence + 1,
    lastAppliedPosition: runState.lastAppliedPosition,
  }

  const stateDigest = digestJson(stripUndefined(stateWithoutDigest))

  return {
    ...stateWithoutDigest,
    stateDigest,
  }
}

import type { TaskId } from "../identifiers.js"
import type { TaskDependency } from "../types.js"
import type { RunProjectionState } from "../projections/types.js"
import {
  type CycleType,
  type DagAnalysis,
  type TaskGraphNode,
  DanglingDependencyError,
  DependencyCycleError,
  DependencyEditForbiddenError,
  TaskNotFoundError,
} from "./types.js"

export type DagInput =
  | Record<string, TaskGraphNode>
  | readonly TaskGraphNode[]
  | RunProjectionState
  | Map<string, TaskGraphNode>

function isRunProjectionState(input: unknown): input is RunProjectionState {
  return (
    typeof input === "object" &&
    input !== null &&
    "run" in input &&
    "tasks" in input &&
    typeof (input as RunProjectionState).tasks === "object"
  )
}

function isDagAnalysis(input: unknown): input is DagAnalysis {
  return (
    typeof input === "object" &&
    input !== null &&
    "topologicalOrder" in input &&
    "adjacencyList" in input &&
    "reverseAdjacencyList" in input
  )
}

/**
 * Extracts a normalized map of TaskGraphNode from various supported input representations:
 * - RunProjectionState
 * - Record<string, TaskGraphNode>
 * - readonly TaskGraphNode[]
 * - Map<string, TaskGraphNode>
 */
export function extractTaskNodes(input: DagInput): Map<string, TaskGraphNode> {
  if (input instanceof Map) {
    return new Map(input)
  }

  if (isRunProjectionState(input)) {
    const map = new Map<string, TaskGraphNode>()
    for (const [key, task] of Object.entries(input.tasks)) {
      map.set(key, task as TaskGraphNode)
    }
    return map
  }

  if (Array.isArray(input)) {
    const map = new Map<string, TaskGraphNode>()
    for (const node of input) {
      map.set(node.taskId, node)
    }
    return map
  }

  const map = new Map<string, TaskGraphNode>()
  for (const [key, node] of Object.entries(input)) {
    map.set(key, node as TaskGraphNode)
  }

  return map
}

/**
 * Normalizes dependency inputs (TaskDependency objects or plain string/TaskId identifiers)
 * into canonical TaskDependency objects.
 */
export function normalizeDependencies(
  dependencies: readonly (TaskDependency | TaskId | string)[],
): readonly TaskDependency[] {
  const seen = new Set<string>()
  const result: TaskDependency[] = []

  for (const dep of dependencies) {
    const taskId = typeof dep === "string" ? (dep as TaskId) : dep.taskId
    const failurePolicy = typeof dep === "string" ? "fail" : dep.failurePolicy ?? "fail"
    if (!seen.has(taskId)) {
      seen.add(taskId)
      result.push({ taskId, failurePolicy })
    }
  }

  return result
}

/**
 * Validates a DAG of tasks, checking for:
 * 1. Missing / dangling dependencies (task depends on non-existent taskId in the run).
 * 2. Self-dependencies (A -> A).
 * 3. Direct cycles (A -> B -> A).
 * 4. Indirect cycles (A -> B -> C -> A).
 *
 * Computes topological layers (stages) and linear topological execution order.
 * Throws DanglingDependencyError or DependencyCycleError on invalid graphs.
 */
export function validateDag(input: DagInput): DagAnalysis {
  const nodes = extractTaskNodes(input)
  const taskIds = Array.from(nodes.keys()).sort() as TaskId[]
  const taskIdSet = new Set(nodes.keys())

  // 1. Check for dangling dependencies and self-dependencies
  for (const [id, node] of nodes.entries()) {
    const deps = node.dependencies ?? []
    for (const dep of deps) {
      if (dep.taskId === id) {
        throw new DependencyCycleError([id as TaskId, id as TaskId], "self")
      }
      if (!taskIdSet.has(dep.taskId)) {
        throw new DanglingDependencyError(id, dep.taskId)
      }
    }
  }

  // 2. Cycle detection via DFS with 3-color marking and path tracking
  // Edges followed: Task -> its prerequisites (what it depends on)
  const visited = new Set<string>()
  const visiting = new Set<string>()

  function detectCycleDfs(current: string, path: string[]): void {
    visiting.add(current)

    const node = nodes.get(current)
    const rawDeps = node?.dependencies ?? []
    // Deterministic traversal: sort dependencies by taskId
    const deps = rawDeps
      .map((d) => d.taskId)
      .filter((depId) => taskIdSet.has(depId))
      .sort()

    for (const depId of deps) {
      if (visiting.has(depId)) {
        const cycleStartIndex = path.indexOf(depId)
        const cycle = [...path.slice(cycleStartIndex), depId] as TaskId[]
        const cycleType: CycleType =
          cycle.length === 2 && cycle[0] === cycle[1]
            ? "self"
            : cycle.length === 3 && cycle[0] === cycle[2]
              ? "direct"
              : "indirect"
        throw new DependencyCycleError(cycle, cycleType)
      }

      if (!visited.has(depId)) {
        detectCycleDfs(depId, [...path, depId])
      }
    }

    visiting.delete(current)
    visited.add(current)
  }

  for (const taskId of taskIds) {
    if (!visited.has(taskId)) {
      detectCycleDfs(taskId, [taskId])
    }
  }

  // 3. Build adjacency lists and compute in-degree / out-degree for execution order
  // Execution direction: Prerequisite -> Dependent (Task A completes -> enables Task B)
  const adjacencyList: Record<string, TaskId[]> = {}
  const reverseAdjacencyList: Record<string, TaskId[]> = {}
  const inDegree: Record<string, number> = {}
  const outDegree: Record<string, number> = {}

  for (const taskId of taskIds) {
    adjacencyList[taskId] = []
    reverseAdjacencyList[taskId] = []
    inDegree[taskId] = 0
    outDegree[taskId] = 0
  }

  for (const [id, node] of nodes.entries()) {
    const deps = node.dependencies ?? []
    const prereqs = deps.map((d) => d.taskId as TaskId).sort()
    reverseAdjacencyList[id] = prereqs
    inDegree[id] = prereqs.length

    for (const prereq of prereqs) {
      adjacencyList[prereq].push(id as TaskId)
    }
  }

  // Sort adjacency lists for deterministic traversal
  for (const taskId of taskIds) {
    adjacencyList[taskId].sort()
    outDegree[taskId] = adjacencyList[taskId].length
  }

  // 4. Compute topological execution stages (Kahn's layer-by-layer algorithm)
  const inDegreeCopy: Record<string, number> = { ...inDegree }
  const stages: TaskId[][] = []
  let processedCount = 0

  // Stage 0: tasks with 0 prerequisites
  let currentStage = taskIds.filter((id) => inDegreeCopy[id] === 0).sort()

  while (currentStage.length > 0) {
    stages.push(currentStage)
    processedCount += currentStage.length

    const nextStageCandidates = new Set<TaskId>()
    for (const completedTaskId of currentStage) {
      for (const dependentId of adjacencyList[completedTaskId]) {
        inDegreeCopy[dependentId] -= 1
        if (inDegreeCopy[dependentId] === 0) {
          nextStageCandidates.add(dependentId)
        }
      }
    }

    currentStage = Array.from(nextStageCandidates).sort()
  }

  if (processedCount < taskIds.length) {
    // Should be impossible here due to prior DFS cycle check, but guard defensively
    throw new DependencyCycleError([], "indirect")
  }

  const topologicalOrder = stages.flat()

  return {
    taskIds,
    topologicalOrder,
    stages,
    inDegree,
    outDegree,
    adjacencyList,
    reverseAdjacencyList,
  }
}

/**
 * Checks whether the task graph contains any cycle without throwing.
 * Returns the cycle path and type if detected, or null if acyclic.
 */
export function detectCycle(
  input: DagInput,
): { cycle: readonly TaskId[], cycleType: CycleType } | null {
  try {
    validateDag(input)
    return null
  } catch (error) {
    if (error instanceof DependencyCycleError) {
      return { cycle: error.cycle, cycleType: error.cycleType }
    }
    throw error
  }
}

/**
 * Returns the linear topological execution order for a DAG.
 */
export function getTopologicalOrder(input: DagInput): readonly TaskId[] {
  return validateDag(input).topologicalOrder
}

/**
 * Returns the parallel execution stages for a DAG.
 */
export function getTopologicalStages(input: DagInput): readonly (readonly TaskId[])[] {
  return validateDag(input).stages
}

/**
 * Dependency editing rule:
 * Dependencies can ONLY be modified while a task is in 'draft' state,
 * and requires full graph revalidation.
 *
 * If the task is in any state other than 'draft', throws DependencyEditForbiddenError.
 * If the new dependencies introduce cycles or dangling references, revalidation throws
 * DependencyCycleError or DanglingDependencyError.
 */
export function validateDependencyEdit(
  taskId: TaskId | string,
  newDependencies: readonly (TaskDependency | TaskId | string)[],
  allTasks: DagInput,
): DagAnalysis {
  const nodes = extractTaskNodes(allTasks)
  const existingTask = nodes.get(String(taskId))

  if (!existingTask) {
    throw new TaskNotFoundError(taskId)
  }

  const currentState = existingTask.state ?? "draft"
  if (currentState !== "draft") {
    throw new DependencyEditForbiddenError(taskId, currentState)
  }

  const normalized = normalizeDependencies(newDependencies)
  const updatedTask: TaskGraphNode = {
    ...existingTask,
    dependencies: normalized,
  }

  const updatedNodes = new Map(nodes)
  updatedNodes.set(String(taskId), updatedTask)

  return validateDag(updatedNodes)
}

/**
 * Returns the direct prerequisites of a task.
 */
export function getPrerequisites(
  taskId: TaskId | string,
  input: DagInput | DagAnalysis,
): readonly TaskId[] {
  const dag = isDagAnalysis(input) ? input : validateDag(input)
  return dag.reverseAdjacencyList[String(taskId)] ?? []
}

/**
 * Returns the direct dependents of a task (tasks that depend on this task).
 */
export function getDependents(
  taskId: TaskId | string,
  input: DagInput | DagAnalysis,
): readonly TaskId[] {
  const dag = isDagAnalysis(input) ? input : validateDag(input)
  return dag.adjacencyList[String(taskId)] ?? []
}

/**
 * Returns all transitive prerequisites (ancestors) of a task in topological order.
 */
export function getTransitivePrerequisites(
  taskId: TaskId | string,
  input: DagInput | DagAnalysis,
): readonly TaskId[] {
  const dag = isDagAnalysis(input) ? input : validateDag(input)
  const idStr = String(taskId)
  const visited = new Set<string>()
  const queue: string[] = [...(dag.reverseAdjacencyList[idStr] ?? [])]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (!visited.has(current)) {
      visited.add(current)
      for (const parent of dag.reverseAdjacencyList[current] ?? []) {
        if (!visited.has(parent)) {
          queue.push(parent)
        }
      }
    }
  }

  return dag.topologicalOrder.filter((id) => visited.has(id))
}

/**
 * Returns all transitive dependents (descendants) of a task in topological order.
 */
export function getTransitiveDependents(
  taskId: TaskId | string,
  input: DagInput | DagAnalysis,
): readonly TaskId[] {
  const dag = isDagAnalysis(input) ? input : validateDag(input)
  const idStr = String(taskId)
  const visited = new Set<string>()
  const queue: string[] = [...(dag.adjacencyList[idStr] ?? [])]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (!visited.has(current)) {
      visited.add(current)
      for (const child of dag.adjacencyList[current] ?? []) {
        if (!visited.has(child)) {
          queue.push(child)
        }
      }
    }
  }

  return dag.topologicalOrder.filter((id) => visited.has(id))
}

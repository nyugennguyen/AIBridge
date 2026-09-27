import { describe, expect, it } from "vitest"
import { digestDispatchEnvelope, digestJson } from "../../../src/orchestration/digest.js"
import type {
  DispatchId,
  ProjectId,
  RunId,
  TaskId,
} from "../../../src/orchestration/identifiers.js"
import type {
  DispatchProjection,
  RunProjectionState,
  TaskProjection,
} from "../../../src/orchestration/projections/types.js"
import type { DispatchEnvelope, TaskDependency } from "../../../src/orchestration/types.js"
import {
  CycleDetectedError,
  DanglingDependencyError,
  DependencyCycleError,
  DependencyEditForbiddenError,
  InvalidDependencyModificationError,
  MissingDependencyError,
  TaskNotFoundError,
  TaskNotRetryableError,
  applyRetryToRunState,
  detectCycle,
  evaluateTaskReadiness,
  getDependents,
  getEligibleTasks,
  getPrerequisites,
  getReadyTasks,
  getTasksToSkip,
  getTopologicalOrder,
  getTopologicalStages,
  getTransitiveDependents,
  getTransitivePrerequisites,
  normalizeFailurePolicy,
  retryTask,
  schedule,
  validateDag,
  validateDependencyEdit,
} from "../../../src/orchestration/scheduler/index.js"

const PROJECT_ID = "proj-test" as ProjectId
const RUN_ID = "run-test" as RunId

function makeEnvelope(options: {
  dispatchId: string
  taskId: string
  attempt?: number
}): DispatchEnvelope {
  return {
    schemaVersion: 1,
    dispatchId: options.dispatchId as DispatchId,
    attempt: options.attempt ?? 1,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    taskId: options.taskId as TaskId,
    targetNodeId: "node-1" as any,
    installationId: "install-1" as any,
    runtimeKind: "opencode" as any,
    projectPathId: "path-1" as any,
    prompt: `Execute task ${options.taskId}`,
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "role-1" as any,
      templateVersion: 1,
      projectId: PROJECT_ID,
      name: "Runner",
      purpose: "Execution",
      instructions: "Execute",
      requiredCapabilities: ["read" as any],
      preferredRuntimeKinds: ["opencode" as any],
      contextSelectionPolicyReference: { namespace: "test", id: "ref" },
      permissionRestrictions: {
        allowedCapabilities: ["read" as any],
        deniedCapabilities: [],
        approvalRequirements: {
          destructiveEffects: false,
          externalEffects: false,
          capabilities: [],
        },
      },
      author: { kind: "user", userId: "tester" as any },
      createdAt: "2026-09-27T00:00:00.000Z" as any,
    },
    ruleSnapshots: [],
    contextManifest: {
      references: [],
      manifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as any,
    },
    requestedCapabilities: ["read" as any],
    permissionEnvelope: {
      allowedCapabilities: ["read" as any],
      deniedCapabilities: [],
      approvalRequirements: {
        destructiveEffects: false,
        externalEffects: false,
        capabilities: [],
      },
    },
    dependencies: [],
    timeoutSeconds: 120,
    controllerEpoch: 1,
  }
}

function makeTask(options: {
  taskId: string
  state?: TaskProjection["state"]
  dependencies?: { taskId: string, failurePolicy?: "block" | "fail" }[]
  failurePolicy?: "block" | "fail" | null
  dispatchAttempts?: number
  currentDispatchId?: string | null
  createdAt?: string
}): TaskProjection {
  const deps: TaskDependency[] = (options.dependencies ?? []).map((d) => ({
    taskId: d.taskId as TaskId,
    failurePolicy: (d.failurePolicy ?? options.failurePolicy ?? null) as any,
  }))

  return {
    taskId: options.taskId as TaskId,
    runId: RUN_ID,
    projectId: PROJECT_ID,
    title: `Task ${options.taskId}`,
    description: `Description for ${options.taskId}`,
    state: options.state ?? "draft",
    dependencies: deps,
    failurePolicy: options.failurePolicy ?? null,
    currentDispatchId: (options.currentDispatchId as DispatchId) ?? null,
    dispatchAttempts: options.dispatchAttempts ?? 0,
    createdAt: (options.createdAt ?? "2026-09-27T00:00:00.000Z") as any,
    updatedAt: (options.createdAt ?? "2026-09-27T00:00:00.000Z") as any,
  }
}

function makeDispatch(options: {
  dispatchId: string
  taskId: string
  attempt?: number
  state?: DispatchProjection["state"]
  outcome?: DispatchProjection["outcome"]
}): DispatchProjection {
  const envelope = makeEnvelope({
    dispatchId: options.dispatchId,
    taskId: options.taskId,
    attempt: options.attempt ?? 1,
  })

  return {
    dispatchId: options.dispatchId as DispatchId,
    taskId: options.taskId as TaskId,
    runId: RUN_ID,
    projectId: PROJECT_ID,
    envelopeDigest: digestDispatchEnvelope(envelope),
    envelope,
    state: options.state ?? "proposed",
    approvalId: null,
    sessionId: null,
    attempt: options.attempt ?? 1,
    createdAt: "2026-09-27T00:00:00.000Z" as any,
    updatedAt: "2026-09-27T00:00:00.000Z" as any,
    outcome: options.outcome ?? null,
    summary: null,
  }
}

function makeRunState(
  tasks: TaskProjection[],
  dispatches: DispatchProjection[] = [],
): RunProjectionState {
  const tasksRecord: Record<string, TaskProjection> = {}
  for (const t of tasks) {
    tasksRecord[t.taskId] = t
  }

  const dispatchesRecord: Record<string, DispatchProjection> = {}
  for (const d of dispatches) {
    dispatchesRecord[d.dispatchId] = d
  }

  const stateWithoutDigest = {
    run: {
      runId: RUN_ID,
      projectId: PROJECT_ID,
      state: "active" as const,
      controllerNodeId: "node-1" as any,
      controllerEpoch: 1,
      activeLeaseId: null,
      createdAt: "2026-09-27T00:00:00.000Z" as any,
      updatedAt: "2026-09-27T00:00:00.000Z" as any,
      completedAt: null,
    },
    tasks: tasksRecord,
    dispatches: dispatchesRecord,
    approvals: {},
    sessions: {},
    artifacts: {},
    lastAppliedSequence: 1,
  }

  return {
    ...stateWithoutDigest,
    stateDigest: digestJson(stateWithoutDigest),
  }
}

describe("Task Graph Scheduler", () => {
  describe("1. DAG Validation & Cycle Detection", () => {
    it("identifies self-dependencies (A -> A) and throws DependencyCycleError", () => {
      const taskA = makeTask({
        taskId: "task-A",
        dependencies: [{ taskId: "task-A" }],
      })

      expect(() => validateDag([taskA])).toThrow(DependencyCycleError)

      try {
        validateDag([taskA])
      } catch (err) {
        expect(err).toBeInstanceOf(DependencyCycleError)
        expect(err).toBeInstanceOf(CycleDetectedError)
        const cycleErr = err as DependencyCycleError
        expect(cycleErr.cycleType).toBe("self")
        expect(cycleErr.cycle).toEqual(["task-A", "task-A"])
        expect(cycleErr.code).toBe("scheduler.cycle_detected")
        expect(cycleErr.category).toBe("validation")

        const contractErr = cycleErr.toContractError()
        expect(contractErr.category).toBe("validation")
        expect(contractErr.code).toBe("scheduler.cycle_detected")
        expect(contractErr.message).toContain("Self-dependency detected for task 'task-A'")
      }
    })

    it("identifies direct cycles (A -> B -> A) and throws DependencyCycleError", () => {
      const taskA = makeTask({
        taskId: "task-A",
        dependencies: [{ taskId: "task-B" }],
      })
      const taskB = makeTask({
        taskId: "task-B",
        dependencies: [{ taskId: "task-A" }],
      })

      expect(() => validateDag([taskA, taskB])).toThrow(DependencyCycleError)

      try {
        validateDag([taskA, taskB])
      } catch (err) {
        expect(err).toBeInstanceOf(DependencyCycleError)
        const cycleErr = err as DependencyCycleError
        expect(cycleErr.cycleType).toBe("direct")
        expect(cycleErr.cycle.length).toBe(3)
        expect(cycleErr.cycle[0]).toBe(cycleErr.cycle[2])
        expect(cycleErr.message).toContain("Direct cycle detected")
      }
    })

    it("identifies indirect cycles (A -> B -> C -> A) and throws DependencyCycleError", () => {
      // task-A depends on task-C, task-B depends on task-A, task-C depends on task-B
      const taskA = makeTask({
        taskId: "task-A",
        dependencies: [{ taskId: "task-C" }],
      })
      const taskB = makeTask({
        taskId: "task-B",
        dependencies: [{ taskId: "task-A" }],
      })
      const taskC = makeTask({
        taskId: "task-C",
        dependencies: [{ taskId: "task-B" }],
      })

      expect(() => validateDag([taskA, taskB, taskC])).toThrow(DependencyCycleError)

      try {
        validateDag([taskA, taskB, taskC])
      } catch (err) {
        expect(err).toBeInstanceOf(DependencyCycleError)
        const cycleErr = err as DependencyCycleError
        expect(cycleErr.cycleType).toBe("indirect")
        expect(cycleErr.cycle.length).toBe(4)
        expect(cycleErr.cycle[0]).toBe(cycleErr.cycle[3])
        expect(cycleErr.message).toContain("Indirect cycle detected")
      }
    })

    it("detectCycle returns cycle details or null without throwing", () => {
      const acyclic = [
        makeTask({ taskId: "t1" }),
        makeTask({ taskId: "t2", dependencies: [{ taskId: "t1" }] }),
      ]
      expect(detectCycle(acyclic)).toBeNull()

      const cyclic = [
        makeTask({ taskId: "t1", dependencies: [{ taskId: "t2" }] }),
        makeTask({ taskId: "t2", dependencies: [{ taskId: "t1" }] }),
      ]
      const result = detectCycle(cyclic)
      expect(result).not.toBeNull()
      expect(result?.cycleType).toBe("direct")
    })
  })

  describe("2. Dangling / Missing Dependency Detection", () => {
    it("rejects task that depends on non-existent taskId in the run", () => {
      const taskA = makeTask({
        taskId: "task-A",
        dependencies: [{ taskId: "ghost-task" }],
      })

      expect(() => validateDag([taskA])).toThrow(DanglingDependencyError)

      try {
        validateDag([taskA])
      } catch (err) {
        expect(err).toBeInstanceOf(DanglingDependencyError)
        expect(err).toBeInstanceOf(MissingDependencyError)
        const dangErr = err as DanglingDependencyError
        expect(dangErr.taskId).toBe("task-A")
        expect(dangErr.dependencyTaskId).toBe("ghost-task")
        expect(dangErr.missingDependencyId).toBe("ghost-task")
        expect(dangErr.code).toBe("scheduler.missing_dependency")
        expect(dangErr.category).toBe("validation")

        const contractErr = dangErr.toContractError()
        expect(contractErr.category).toBe("validation")
        expect(contractErr.code).toBe("scheduler.missing_dependency")
        expect(contractErr.message).toContain("depends on non-existent task 'ghost-task'")
      }
    })
  })

  describe("3. Topological Sorting & Graph Topologies", () => {
    it("sorts linear chains (A -> B -> C)", () => {
      const taskA = makeTask({ taskId: "task-A" })
      const taskB = makeTask({ taskId: "task-B", dependencies: [{ taskId: "task-A" }] })
      const taskC = makeTask({ taskId: "task-C", dependencies: [{ taskId: "task-B" }] })

      const stages = getTopologicalStages([taskA, taskB, taskC])
      expect(stages).toEqual([["task-A"], ["task-B"], ["task-C"]])

      const order = getTopologicalOrder([taskA, taskB, taskC])
      expect(order).toEqual(["task-A", "task-B", "task-C"])
    })

    it("sorts diamond graphs (A -> B, A -> C, B -> D, C -> D)", () => {
      const taskA = makeTask({ taskId: "task-A" })
      const taskB = makeTask({ taskId: "task-B", dependencies: [{ taskId: "task-A" }] })
      const taskC = makeTask({ taskId: "task-C", dependencies: [{ taskId: "task-A" }] })
      const taskD = makeTask({
        taskId: "task-D",
        dependencies: [{ taskId: "task-B" }, { taskId: "task-C" }],
      })

      const stages = getTopologicalStages([taskA, taskB, taskC, taskD])
      expect(stages).toEqual([["task-A"], ["task-B", "task-C"], ["task-D"]])

      const order = getTopologicalOrder([taskA, taskB, taskC, taskD])
      expect(order).toEqual(["task-A", "task-B", "task-C", "task-D"])
    })

    it("sorts fan-out graphs (A -> B, C, D)", () => {
      const taskA = makeTask({ taskId: "task-A" })
      const taskB = makeTask({ taskId: "task-B", dependencies: [{ taskId: "task-A" }] })
      const taskC = makeTask({ taskId: "task-C", dependencies: [{ taskId: "task-A" }] })
      const taskD = makeTask({ taskId: "task-D", dependencies: [{ taskId: "task-A" }] })

      const stages = getTopologicalStages([taskA, taskB, taskC, taskD])
      expect(stages).toEqual([["task-A"], ["task-B", "task-C", "task-D"]])
    })

    it("sorts fan-in graphs (A, B, C -> D)", () => {
      const taskA = makeTask({ taskId: "task-A" })
      const taskB = makeTask({ taskId: "task-B" })
      const taskC = makeTask({ taskId: "task-C" })
      const taskD = makeTask({
        taskId: "task-D",
        dependencies: [{ taskId: "task-A" }, { taskId: "task-B" }, { taskId: "task-C" }],
      })

      const stages = getTopologicalStages([taskA, taskB, taskC, taskD])
      expect(stages).toEqual([["task-A", "task-B", "task-C"], ["task-D"]])
    })

    it("sorts disconnected graphs (A -> B, C -> D)", () => {
      const taskA = makeTask({ taskId: "task-A" })
      const taskB = makeTask({ taskId: "task-B", dependencies: [{ taskId: "task-A" }] })
      const taskC = makeTask({ taskId: "task-C" })
      const taskD = makeTask({ taskId: "task-D", dependencies: [{ taskId: "task-C" }] })

      const stages = getTopologicalStages([taskA, taskB, taskC, taskD])
      expect(stages).toEqual([["task-A", "task-C"], ["task-B", "task-D"]])
    })

    it("computes direct and transitive dependencies and dependents", () => {
      const taskA = makeTask({ taskId: "task-A" })
      const taskB = makeTask({ taskId: "task-B", dependencies: [{ taskId: "task-A" }] })
      const taskC = makeTask({ taskId: "task-C", dependencies: [{ taskId: "task-B" }] })

      const tasks = [taskA, taskB, taskC]
      expect(getPrerequisites("task-B", tasks)).toEqual(["task-A"])
      expect(getDependents("task-A", tasks)).toEqual(["task-B"])
      expect(getTransitivePrerequisites("task-C", tasks)).toEqual(["task-A", "task-B"])
      expect(getTransitiveDependents("task-A", tasks)).toEqual(["task-B", "task-C"])
    })
  })

  describe("4. Dependency Editing Rule", () => {
    it("allows modifying dependencies while task is in 'draft' state and revalidates graph", () => {
      const taskA = makeTask({ taskId: "task-A", state: "draft" })
      const taskB = makeTask({ taskId: "task-B", state: "draft" })

      // Add dependency B -> A while B is draft
      const analysis = validateDependencyEdit("task-B", [{ taskId: "task-A" as TaskId, failurePolicy: "fail" }], [taskA, taskB])
      expect(analysis.stages).toEqual([["task-A"], ["task-B"]])
    })

    it("rejects modifying dependencies when task is not in 'draft' state", () => {
      const nonDraftStates = ["pending", "ready", "running", "completed", "failed", "cancelled", "skipped"] as const

      for (const state of nonDraftStates) {
        const task = makeTask({ taskId: "task-X", state })
        expect(() =>
          validateDependencyEdit("task-X", [], [task])
        ).toThrow(DependencyEditForbiddenError)

        try {
          validateDependencyEdit("task-X", [], [task])
        } catch (err) {
          expect(err).toBeInstanceOf(DependencyEditForbiddenError)
          expect(err).toBeInstanceOf(InvalidDependencyModificationError)
          const editErr = err as DependencyEditForbiddenError
          expect(editErr.taskId).toBe("task-X")
          expect(editErr.currentState).toBe(state)
          expect(editErr.code).toBe("scheduler.dependency_edit_forbidden")
        }
      }
    })

    it("throws TaskNotFoundError when editing dependency of non-existent task", () => {
      expect(() => validateDependencyEdit("unknown-task", [], [])).toThrow(TaskNotFoundError)
    })

    it("revalidates full graph during edit and catches introduced cycles", () => {
      const taskA = makeTask({ taskId: "task-A", state: "draft" })
      const taskB = makeTask({ taskId: "task-B", state: "draft", dependencies: [{ taskId: "task-A" }] })

      // Editing task-A to depend on task-B creates a cycle
      expect(() =>
        validateDependencyEdit("task-A", [{ taskId: "task-B" as TaskId, failurePolicy: "fail" }], [taskA, taskB])
      ).toThrow(DependencyCycleError)
    })
  })

  describe("5. Task Readiness & Derivation from RunProjectionState", () => {
    it("derives task readiness: ready when pending/draft and all dependencies completed", () => {
      const taskRoot = makeTask({ taskId: "root", state: "completed" })
      const taskChild = makeTask({
        taskId: "child",
        state: "pending",
        dependencies: [{ taskId: "root" }],
      })
      const taskWaiting = makeTask({
        taskId: "waiting",
        state: "pending",
        dependencies: [{ taskId: "child" }],
      })

      const runState = makeRunState([taskRoot, taskChild, taskWaiting])
      const readiness = evaluateTaskReadiness(runState)

      expect(readiness["root"].status).toBe("completed")
      expect(readiness["child"].status).toBe("ready")
      expect(readiness["waiting"].status).toBe("waiting")
      expect(readiness["waiting"].unsatisfiedDependencies).toEqual(["child"])

      const readyTasks = getReadyTasks(runState)
      expect(readyTasks.map((t) => t.taskId)).toEqual(["child"])
    })

    it("considers task with no dependencies ready when draft or pending", () => {
      const taskDraft = makeTask({ taskId: "draft-task", state: "draft" })
      const taskPending = makeTask({ taskId: "pending-task", state: "pending" })

      const runState = makeRunState([taskDraft, taskPending])
      const readiness = evaluateTaskReadiness(runState)

      expect(readiness["draft-task"].status).toBe("ready")
      expect(readiness["pending-task"].status).toBe("ready")
    })
  })

  describe("6. Dependency Failure Propagation (Fail-Fast, Continue, Skip)", () => {
    it("fail-fast / abort: dependency failure cascades to 'skipped' transitively", () => {
      // Chain: A -> B -> C -> D
      const taskA = makeTask({ taskId: "task-A", state: "failed" })
      const taskB = makeTask({
        taskId: "task-B",
        state: "pending",
        dependencies: [{ taskId: "task-A" }],
        failurePolicy: "fail",
      })
      const taskC = makeTask({
        taskId: "task-C",
        state: "pending",
        dependencies: [{ taskId: "task-B" }],
        failurePolicy: "fail",
      })
      const taskD = makeTask({
        taskId: "task-D",
        state: "pending",
        dependencies: [{ taskId: "task-C" }],
        failurePolicy: "fail",
      })

      const runState = makeRunState([taskA, taskB, taskC, taskD])
      const result = schedule(runState, { defaultFailurePolicy: "fail_fast" })

      expect(result.eligibleTasks.length).toBe(0)
      expect(result.tasksToSkip.length).toBe(3)

      const skippedIds = result.tasksToSkip.map((s) => s.taskId)
      expect(skippedIds).toContain("task-B")
      expect(skippedIds).toContain("task-C")
      expect(skippedIds).toContain("task-D")

      expect(result.readiness["task-B"].status).toBe("skipped")
      expect(result.readiness["task-C"].status).toBe("skipped")
      expect(result.readiness["task-D"].status).toBe("skipped")
    })

    it("continue-on-failure: permits dependent task to become ready even if prerequisite failed", () => {
      const taskPrereq = makeTask({ taskId: "task-prereq", state: "failed" })
      const taskDependent = makeTask({
        taskId: "task-dependent",
        state: "pending",
        dependencies: [{ taskId: "task-prereq" }],
      })

      const runState = makeRunState([taskPrereq, taskDependent])

      // With default fail_fast: dependent is skipped
      const failFastResult = schedule(runState, { defaultFailurePolicy: "fail_fast" })
      expect(failFastResult.readiness["task-dependent"].status).toBe("skipped")

      // With continue policy: dependent becomes ready
      const continueResult = schedule(runState, { defaultFailurePolicy: "continue" })
      expect(continueResult.readiness["task-dependent"].status).toBe("ready")
      expect(continueResult.eligibleTasks.map((t) => t.taskId)).toEqual(["task-dependent"])
    })

    it("diamond graph: one failed branch skips dependent under fail-fast", () => {
      // Diamond: root -> (branch1, branch2) -> sink
      const taskRoot = makeTask({ taskId: "root", state: "completed" })
      const branch1 = makeTask({ taskId: "branch1", state: "completed", dependencies: [{ taskId: "root" }] })
      const branch2 = makeTask({ taskId: "branch2", state: "failed", dependencies: [{ taskId: "root" }] })
      const sink = makeTask({
        taskId: "sink",
        state: "pending",
        dependencies: [{ taskId: "branch1" }, { taskId: "branch2" }],
      })

      const runState = makeRunState([taskRoot, branch1, branch2, sink])
      const result = schedule(runState)

      expect(result.readiness["sink"].status).toBe("skipped")
      expect(result.readiness["sink"].failedDependencies).toContain("branch2")
      expect(result.tasksToSkip.map((t) => t.taskId)).toContain("sink")
    })

    it("normalizes failure policies from schema and alternate spellings", () => {
      expect(normalizeFailurePolicy("fail")).toBe("fail_fast")
      expect(normalizeFailurePolicy("fail_fast")).toBe("fail_fast")
      expect(normalizeFailurePolicy("block")).toBe("skip")
      expect(normalizeFailurePolicy("skip")).toBe("skip")
      expect(normalizeFailurePolicy("continue")).toBe("continue")
      expect(normalizeFailurePolicy(null)).toBe("fail_fast")
    })
  })

  describe("7. Concurrency Limit Allocation (maxConcurrency)", () => {
    it("allocates eligible tasks up to maxConcurrency and defers the rest", () => {
      const t1 = makeTask({ taskId: "t1", state: "pending", createdAt: "2026-09-27T00:00:01.000Z" })
      const t2 = makeTask({ taskId: "t2", state: "pending", createdAt: "2026-09-27T00:00:02.000Z" })
      const t3 = makeTask({ taskId: "t3", state: "pending", createdAt: "2026-09-27T00:00:03.000Z" })
      const t4 = makeTask({ taskId: "t4", state: "pending", createdAt: "2026-09-27T00:00:04.000Z" })

      const runState = makeRunState([t1, t2, t3, t4])

      const result = schedule(runState, { maxConcurrency: 2 })
      expect(result.runningCount).toBe(0)
      expect(result.availableCapacity).toBe(2)
      expect(result.eligibleTasks.length).toBe(2)
      expect(result.deferredTasks.length).toBe(2)

      expect(result.eligibleTasks.map((t) => t.taskId)).toEqual(["t1", "t2"])
      expect(result.deferredTasks.map((t) => t.taskId)).toEqual(["t3", "t4"])
    })

    it("accounts for currently running tasks when evaluating concurrency capacity", () => {
      const running1 = makeTask({ taskId: "running-1", state: "running" })
      const ready1 = makeTask({ taskId: "ready-1", state: "pending" })
      const ready2 = makeTask({ taskId: "ready-2", state: "pending" })

      const runState = makeRunState([running1, ready1, ready2])

      // maxConcurrency 2 with 1 running => 1 eligible, 1 deferred
      const result = schedule(runState, { maxConcurrency: 2 })
      expect(result.runningCount).toBe(1)
      expect(result.availableCapacity).toBe(1)
      expect(result.eligibleTasks.length).toBe(1)
      expect(result.deferredTasks.length).toBe(1)

      // maxConcurrency 1 with 1 running => 0 eligible, 2 deferred
      const saturated = schedule(runState, { maxConcurrency: 1 })
      expect(saturated.runningCount).toBe(1)
      expect(saturated.availableCapacity).toBe(0)
      expect(saturated.eligibleTasks.length).toBe(0)
      expect(saturated.deferredTasks.length).toBe(2)
    })

    it("schedules all ready tasks when maxConcurrency is unlimited", () => {
      const t1 = makeTask({ taskId: "t1", state: "pending" })
      const t2 = makeTask({ taskId: "t2", state: "pending" })
      const t3 = makeTask({ taskId: "t3", state: "pending" })

      const runState = makeRunState([t1, t2, t3])
      const result = schedule(runState)

      expect(result.availableCapacity).toBe(Number.POSITIVE_INFINITY)
      expect(result.eligibleTasks.length).toBe(3)
      expect(result.deferredTasks.length).toBe(0)
    })

    it("prioritizes tasks by earlier topological stage deterministically", () => {
      // Stage 0: s0-a, s0-b
      // Stage 1: s1-a (depends on s0-a)
      // When s0-a completes:
      // s0-b is stage 0
      // s1-a is stage 1
      const s0a = makeTask({ taskId: "s0-a", state: "completed" })
      const s0b = makeTask({ taskId: "s0-b", state: "pending" })
      const s1a = makeTask({ taskId: "s1-a", state: "pending", dependencies: [{ taskId: "s0-a" }] })

      const runState = makeRunState([s0a, s0b, s1a])
      const result = schedule(runState, { maxConcurrency: 1 })

      // s0-b is in stage 0, so it should be scheduled before s1-a (stage 1)
      expect(result.eligibleTasks.map((t) => t.taskId)).toEqual(["s0-b"])
      expect(result.deferredTasks.map((t) => t.taskId)).toEqual(["s1-a"])
    })
  })

  describe("8. Retry Semantics", () => {
    it("retrying a failed task transitions it to ready and creates a new dispatch attempt without erasing past attempt history", () => {
      // Task failed on attempt 1
      const task = makeTask({
        taskId: "flaky-task",
        state: "failed",
        dispatchAttempts: 1,
        currentDispatchId: "disp-1",
      })
      const dispatch1 = makeDispatch({
        dispatchId: "disp-1",
        taskId: "flaky-task",
        attempt: 1,
        state: "failed",
        outcome: "failed",
      })

      const runState = makeRunState([task], [dispatch1])

      // Retry the task
      const retryResult = retryTask(runState, "flaky-task")

      expect(retryResult.taskId).toBe("flaky-task")
      expect(retryResult.nextAttempt).toBe(2)
      expect(retryResult.nextDispatchId).toBe("flaky-task-dispatch-2")
      expect(retryResult.updatedTask.state).toBe("ready")
      expect(retryResult.updatedTask.dispatchAttempts).toBe(2)
      expect(retryResult.updatedTask.currentDispatchId).toBe("flaky-task-dispatch-2")
      expect(retryResult.dispatchEnvelope.attempt).toBe(2)
      expect(retryResult.dispatchEnvelope.dispatchId).toBe("flaky-task-dispatch-2")

      // Apply retry to run state
      const updatedRunState = applyRetryToRunState(runState, retryResult)

      // Verify that past dispatch attempt 1 is STILL intact and preserved
      expect(updatedRunState.dispatches["disp-1"]).toBeDefined()
      expect(updatedRunState.dispatches["disp-1"].attempt).toBe(1)
      expect(updatedRunState.dispatches["disp-1"].state).toBe("failed")
      expect(updatedRunState.dispatches["disp-1"].outcome).toBe("failed")

      // Verify that new dispatch attempt 2 was appended
      expect(updatedRunState.dispatches["flaky-task-dispatch-2"]).toBeDefined()
      expect(updatedRunState.dispatches["flaky-task-dispatch-2"].attempt).toBe(2)
      expect(updatedRunState.dispatches["flaky-task-dispatch-2"].state).toBe("proposed")
      expect(updatedRunState.dispatches["flaky-task-dispatch-2"].outcome).toBeNull()

      // Total dispatches count increased from 1 to 2
      expect(Object.keys(updatedRunState.dispatches).length).toBe(2)

      // Task is now ready and has dispatchAttempts = 2
      expect(updatedRunState.tasks["flaky-task"].state).toBe("ready")
      expect(updatedRunState.tasks["flaky-task"].dispatchAttempts).toBe(2)
      expect(updatedRunState.tasks["flaky-task"].currentDispatchId).toBe("flaky-task-dispatch-2")

      // Scheduler now recognizes the task as ready and eligible
      const sched = schedule(updatedRunState)
      expect(sched.eligibleTasks.map((t) => t.taskId)).toEqual(["flaky-task"])
    })

    it("rejects retrying non-failed tasks (running, completed, pending, etc.)", () => {
      const runningTask = makeTask({ taskId: "t-running", state: "running" })
      const completedTask = makeTask({ taskId: "t-completed", state: "completed" })
      const pendingTask = makeTask({ taskId: "t-pending", state: "pending" })

      const runState = makeRunState([runningTask, completedTask, pendingTask])

      expect(() => retryTask(runState, "t-running")).toThrow(TaskNotRetryableError)
      expect(() => retryTask(runState, "t-completed")).toThrow(TaskNotRetryableError)
      expect(() => retryTask(runState, "t-pending")).toThrow(TaskNotRetryableError)
    })

    it("rejects retrying non-existent tasks", () => {
      const runState = makeRunState([])
      expect(() => retryTask(runState, "unknown-task")).toThrow(TaskNotFoundError)
    })

    it("rejects retrying a failed task whose prerequisites have failed under fail-fast", () => {
      const prereq = makeTask({ taskId: "prereq", state: "failed" })
      const task = makeTask({
        taskId: "child",
        state: "failed",
        dependencies: [{ taskId: "prereq" }],
        dispatchAttempts: 1,
        currentDispatchId: "disp-child-1",
      })
      const dispatch = makeDispatch({
        dispatchId: "disp-child-1",
        taskId: "child",
        attempt: 1,
        state: "failed",
        outcome: "failed",
      })

      const runState = makeRunState([prereq, task], [dispatch])

      expect(() => retryTask(runState, "child")).toThrow(TaskNotRetryableError)
      try {
        retryTask(runState, "child")
      } catch (err) {
        expect(err).toBeInstanceOf(TaskNotRetryableError)
        expect((err as TaskNotRetryableError).message).toContain("prerequisite dependency 'prereq' has failed")
      }
    })
  })
})

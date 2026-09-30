import { beforeEach, describe, expect, it } from "vitest"
import { canonicalJson } from "../../../src/orchestration/digest.js"
import { SqliteEventStore } from "../../../src/orchestration/event-store/event-store.js"
import { openInMemoryDriver } from "../../../src/orchestration/event-store/sqlite-driver.js"
import type { StoredRunEvent } from "../../../src/orchestration/event-store/types.js"
import type {
  DispatchEnvelope,
  OrchestrationCommand,
  OrchestrationEvent,
} from "../../../src/orchestration/types.js"
import { orchestrationCommandSchema, orchestrationEventSchema } from "../../../src/orchestration/schemas.js"
import { ProjectionEngine } from "../../../src/orchestration/projections/projection-engine.js"
import { computeStateDigest, reduceEvent, stripUndefined } from "../../../src/orchestration/projections/reducer.js"
import type { RunProjectionState } from "../../../src/orchestration/projections/types.js"

const PROJECT_ID = "project-alpha"
const RUN_ID = "run-101"

function makeCommand(options: {
  commandId: string
  projectId?: string
  runId?: string
  epoch?: number
  reason?: string
}): OrchestrationCommand {
  return orchestrationCommandSchema.parse({
    schemaVersion: 1,
    commandId: options.commandId,
    projectId: options.projectId ?? PROJECT_ID,
    runId: options.runId ?? RUN_ID,
    actor: { kind: "user", userId: "user-tester" },
    controllerNodeId: "node-test",
    controllerEpoch: options.epoch ?? 1,
    leaseId: "lease-test",
    issuedAt: "2026-09-17T00:00:00.000Z",
    expiresAt: "2026-09-17T00:10:00.000Z",
    correlationId: "corr-test",
    causation: null,
    type: "run.cancel",
    payload: {
      reason: options.reason ?? "Test cancel reason",
    },
  })
}

function makeEnvelope(options: {
  dispatchId: string
  taskId: string
  runId?: string
  projectId?: string
  attempt?: number
  epoch?: number
}): DispatchEnvelope {
  return {
    schemaVersion: 1,
    dispatchId: options.dispatchId as any,
    attempt: options.attempt ?? 1,
    projectId: (options.projectId ?? PROJECT_ID) as any,
    runId: (options.runId ?? RUN_ID) as any,
    taskId: options.taskId as any,
    targetNodeId: "node-test" as any,
    installationId: "install-test" as any,
    runtimeKind: "contract-fake",
    projectPathId: "path-test" as any,
    prompt: "Execute task prompt",
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "role-test" as any,
      templateVersion: 1,
      projectId: (options.projectId ?? PROJECT_ID) as any,
      name: "Tester",
      purpose: "Testing",
      instructions: "Run tests",
      requiredCapabilities: ["read" as any],
      preferredRuntimeKinds: ["contract-fake"],
      contextSelectionPolicyReference: { namespace: "test", id: "ref-1" },
      permissionRestrictions: {
        allowedCapabilities: ["read" as any],
        deniedCapabilities: ["write" as any],
        approvalRequirements: {
          destructiveEffects: true,
          externalEffects: true,
          capabilities: ["read" as any],
        },
      },
      author: { kind: "user", userId: "user-tester" as any },
      createdAt: "2026-09-17T00:00:00.000Z" as any,
    },
    ruleSnapshots: [],
    contextManifest: {
      references: [],
      manifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as any,
    },
    requestedCapabilities: ["read" as any],
    permissionEnvelope: {
      allowedCapabilities: ["read" as any],
      deniedCapabilities: ["write" as any],
      approvalRequirements: {
        destructiveEffects: true,
        externalEffects: true,
        capabilities: ["read" as any],
      },
    },
    dependencies: [],
    timeoutSeconds: 300,
    controllerEpoch: options.epoch ?? 1,
  }
}

function makeEvent(raw: Record<string, unknown>): OrchestrationEvent {
  return orchestrationEventSchema.parse(raw)
}

describe("Projection Reducer and Projection Engine", () => {
  let store: SqliteEventStore
  let engine: ProjectionEngine

  beforeEach(() => {
    store = new SqliteEventStore(openInMemoryDriver())
    engine = new ProjectionEngine(store)
  })

  describe("Lifecycle reduction sequence", () => {
    it("walks through complete lifecycle: run.created to dispatch.finished", () => {
      let state: RunProjectionState | null = null

      // Step 1: run.created
      const runCreatedEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-01",
        sequence: 1,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:01.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "run.created",
        payload: {
          run: {
            schemaVersion: 1,
            runId: RUN_ID,
            projectId: PROJECT_ID,
            goal: "Complete orchestration lifecycle",
            state: "draft",
            paused: false,
            createdAt: "2026-09-17T00:00:01.000Z",
            updatedAt: "2026-09-17T00:00:01.000Z",
            externalReferences: [],
          },
        },
      })
      state = reduceEvent(state, runCreatedEvt)

      expect(state.run.runId).toBe(RUN_ID)
      expect(state.run.projectId).toBe(PROJECT_ID)
      expect(state.run.state).toBe("draft")
      expect(state.run.controllerNodeId).toBe("node-test")
      expect(state.run.controllerEpoch).toBe(1)
      expect(state.run.activeLeaseId).toBeNull()
      expect(state.run.completedAt).toBeNull()
      expect(state.lastAppliedSequence).toBe(1)
      expect(state.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(Object.keys(state.tasks).length).toBe(0)
      const digest1 = state.stateDigest

      // Step 2: task.created (task without dependencies defaults to draft)
      const taskCreatedEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-02",
        sequence: 2,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:02.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "task.created",
        payload: {
          task: {
            schemaVersion: 1,
            taskId: "task-01",
            runId: RUN_ID,
            projectId: PROJECT_ID,
            title: "First task",
            description: "Build artifact",
            failurePolicy: "block",
            state: "pending",
            dependencies: [],
            externalReferences: [],
          },
        },
      })
      state = reduceEvent(state, taskCreatedEvt)

      expect(state.tasks["task-01"]).toBeDefined()
      expect(state.tasks["task-01"].taskId).toBe("task-01")
      expect(state.tasks["task-01"].state).toBe("draft")
      expect(state.tasks["task-01"].dispatchAttempts).toBe(0)
      expect(state.tasks["task-01"].currentDispatchId).toBeNull()
      expect(state.lastAppliedSequence).toBe(2)
      expect(state.stateDigest).not.toBe(digest1)
      const digest2 = state.stateDigest

      // Step 3: dispatch.proposed
      const envelope = makeEnvelope({ dispatchId: "disp-01", taskId: "task-01" })
      const dispatchProposedEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-03",
        sequence: 3,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:03.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.proposed",
        payload: {
          dispatch: {
            schemaVersion: 1,
            envelope,
            envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            state: "proposed",
            createdAt: "2026-09-17T00:00:03.000Z",
            externalReferences: [],
          },
        },
      })
      state = reduceEvent(state, dispatchProposedEvt)

      expect(state.dispatches["disp-01"]).toBeDefined()
      expect(state.dispatches["disp-01"].state).toBe("proposed")
      expect(state.dispatches["disp-01"].attempt).toBe(1)
      expect(state.tasks["task-01"].currentDispatchId).toBe("disp-01")
      expect(state.tasks["task-01"].dispatchAttempts).toBe(1)
      expect(state.lastAppliedSequence).toBe(3)
      expect(state.stateDigest).not.toBe(digest2)
      const digest3 = state.stateDigest

      // Step 4: approval.decided
      const approvalDecidedEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-04",
        sequence: 4,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "user", userId: "user-approver" },
        occurredAt: "2026-09-17T00:00:04.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "approval.decided",
        payload: {
          approval: {
            schemaVersion: 1,
            approvalId: "appr-01",
            projectId: PROJECT_ID,
            runId: RUN_ID,
            dispatchId: "disp-01",
            envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            decision: "approved",            state: "approved",
            basis: { kind: "user" },
            actor: { kind: "user", userId: "user-approver" },
            decidedAt: "2026-09-17T00:00:04.000Z",
          },
        },
      })
      state = reduceEvent(state, approvalDecidedEvt)

      expect(state.approvals["appr-01"]).toBeDefined()
      expect(state.approvals["appr-01"].decision).toBe("approved")
      expect(state.dispatches["disp-01"].state).toBe("approved")
      expect(state.dispatches["disp-01"].approvalId).toBe("appr-01")
      expect(state.run.state).toBe("active")
      expect(state.lastAppliedSequence).toBe(4)
      expect(state.stateDigest).not.toBe(digest3)
      const digest4 = state.stateDigest

      // Step 5: dispatch.started
      const dispatchStartedEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-05",
        sequence: 5,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:05.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.started",
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: "sess-01",
            projectId: PROJECT_ID,
            runId: RUN_ID,
            taskId: "task-01",
            dispatchId: "disp-01",
            nodeId: "node-test",
            installationId: "install-test",
            runtimeKind: "contract-fake",
            lifecycleState: "running",            observedState: "working",
          },
        },
      })
      state = reduceEvent(state, dispatchStartedEvt)

      expect(state.dispatches["disp-01"].state).toBe("running")
      expect(state.dispatches["disp-01"].sessionId).toBe("sess-01")
      expect(state.tasks["task-01"].state).toBe("running")
      expect(state.sessions["sess-01"]).toBeDefined()
      expect(state.sessions["sess-01"].state).toBe("running")
      expect(state.lastAppliedSequence).toBe(5)
      expect(state.stateDigest).not.toBe(digest4)
      const digest5 = state.stateDigest

      // Step 6: session.observed
      const sessionObservedEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-06",
        sequence: 6,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:06.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "session.observed",
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: "sess-01",
            projectId: PROJECT_ID,
            runId: RUN_ID,
            taskId: "task-01",
            dispatchId: "disp-01",
            nodeId: "node-test",
            installationId: "install-test",
            runtimeKind: "contract-fake",
            lifecycleState: "idle",            observedState: "idle",
          },
        },
      })
      state = reduceEvent(state, sessionObservedEvt)

      expect(state.sessions["sess-01"].state).toBe("idle")
      expect(state.lastAppliedSequence).toBe(6)
      expect(state.stateDigest).not.toBe(digest5)
      const digest6 = state.stateDigest

      // Step 7: artifact.registered
      const artifactRegisteredEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-07",
        sequence: 7,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:07.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "artifact.registered",
        payload: {
          artifact: {
            schemaVersion: 1,
            artifactId: "art-01",
            projectId: PROJECT_ID,
            runId: RUN_ID,
            dispatchId: "disp-01",
            sessionId: "sess-01",
            name: "output.log",
            mediaType: "text/plain",
            digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            byteCount: 256,
            source: { kind: "session", sessionId: "sess-01" },
            location: { kind: "locator", locator: "file:///artifacts/output.log" },
          },
        },
      })
      state = reduceEvent(state, artifactRegisteredEvt)

      expect(state.artifacts["art-01"]).toBeDefined()
      expect(state.artifacts["art-01"].artifactId).toBe("art-01")
      expect(state.artifacts["art-01"].name).toBe("output.log")
      expect(state.lastAppliedSequence).toBe(7)
      expect(state.stateDigest).not.toBe(digest6)
      const digest7 = state.stateDigest

      // Step 8: controller.lease.changed
      const leaseChangedEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-08",
        sequence: 8,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test-2" },
        occurredAt: "2026-09-17T00:00:08.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 2,
        type: "controller.lease.changed",
        payload: {
          lease: {
            schemaVersion: 1,
            leaseId: "lease-02",
            projectId: PROJECT_ID,
            runId: RUN_ID,
            controllerNodeId: "node-test-2",
            epoch: 2,
            issuedAt: "2026-09-17T00:00:08.000Z",
            expiresAt: "2026-09-17T00:18:00.000Z",
          },
        },
      })
      state = reduceEvent(state, leaseChangedEvt)

      expect(state.run.activeLeaseId).toBe("lease-02")
      expect(state.run.controllerEpoch).toBe(2)
      expect(state.run.controllerNodeId).toBe("node-test-2")
      expect(state.lastAppliedSequence).toBe(8)
      expect(state.stateDigest).not.toBe(digest7)
      const digest8 = state.stateDigest

      // Step 9: dispatch.finished (completed)
      const dispatchFinishedEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-09",
        sequence: 9,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test-2" },
        occurredAt: "2026-09-17T00:00:09.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 2,
        type: "dispatch.finished",
        payload: {
          dispatchId: "disp-01",
          sessionId: "sess-01",
          outcome: "completed",
          summary: "Task finished successfully",
        },
      })
      state = reduceEvent(state, dispatchFinishedEvt)

      expect(state.dispatches["disp-01"].state).toBe("completed")
      expect(state.dispatches["disp-01"].outcome).toBe("completed")
      expect(state.dispatches["disp-01"].summary).toBe("Task finished successfully")
      expect(state.tasks["task-01"].state).toBe("completed")
      expect(state.sessions["sess-01"].state).toBe("completed")
      expect(state.sessions["sess-01"].outcome).toBe("completed")
      expect(state.run.state).toBe("completed")
      expect(state.run.completedAt).toBe("2026-09-17T00:00:09.000Z")
      expect(state.lastAppliedSequence).toBe(9)
      expect(state.stateDigest).not.toBe(digest8)
    })
  })

  describe("Determinism and Byte-for-Byte Replay Test with SqliteEventStore", () => {
    it("guarantees incrementalState.stateDigest === replayedState.stateDigest and canonical byte equality", async () => {
      const envelope = makeEnvelope({ dispatchId: "disp-replay-1", taskId: "task-replay-1" })

      const events: OrchestrationEvent[] = [
        makeEvent({
          schemaVersion: 1,
          eventId: "evt-rep-01",
          sequence: 1,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          actor: { kind: "node", nodeId: "node-test" },
          occurredAt: "2026-09-17T00:00:01.000Z",
          correlationId: "corr-1",
          causation: null,
          controllerEpoch: 1,
          type: "run.created",
          payload: {
            run: {
              schemaVersion: 1,
              runId: RUN_ID,
              projectId: PROJECT_ID,
              goal: "Verify determinism and replay",
              state: "draft",
              paused: false,
              createdAt: "2026-09-17T00:00:01.000Z",
              updatedAt: "2026-09-17T00:00:01.000Z",
              externalReferences: [],
            },
          },
        }),
        makeEvent({
          schemaVersion: 1,
          eventId: "evt-rep-02",
          sequence: 2,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          actor: { kind: "node", nodeId: "node-test" },
          occurredAt: "2026-09-17T00:00:02.000Z",
          correlationId: "corr-1",
          causation: null,
          controllerEpoch: 1,
          type: "task.created",
          payload: {
            task: {
              schemaVersion: 1,
              taskId: "task-replay-1",
              runId: RUN_ID,
              projectId: PROJECT_ID,
              title: "Replay task",
              description: "Validate replay",
              failurePolicy: "block",
              state: "ready",
              dependencies: [],
              externalReferences: [],
            },
          },
        }),
        makeEvent({
          schemaVersion: 1,
          eventId: "evt-rep-03",
          sequence: 3,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          actor: { kind: "node", nodeId: "node-test" },
          occurredAt: "2026-09-17T00:00:03.000Z",
          correlationId: "corr-1",
          causation: null,
          controllerEpoch: 1,
          type: "dispatch.proposed",
          payload: {
            dispatch: {
              schemaVersion: 1,
              envelope,
              envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
              state: "proposed",
              createdAt: "2026-09-17T00:00:03.000Z",
              externalReferences: [],
            },
          },
        }),
        makeEvent({
          schemaVersion: 1,
          eventId: "evt-rep-04",
          sequence: 4,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          actor: { kind: "user", userId: "user-tester" },
          occurredAt: "2026-09-17T00:00:04.000Z",
          correlationId: "corr-1",
          causation: null,
          controllerEpoch: 1,
          type: "approval.decided",
          payload: {
            approval: {
              schemaVersion: 1,
              approvalId: "appr-rep-1",
              projectId: PROJECT_ID,
              runId: RUN_ID,
              dispatchId: "disp-replay-1",
              envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
              decision: "approved",              state: "approved",
              basis: { kind: "user" },
              actor: { kind: "user", userId: "user-tester" },
              decidedAt: "2026-09-17T00:00:04.000Z",
            },
          },
        }),
        makeEvent({
          schemaVersion: 1,
          eventId: "evt-rep-05",
          sequence: 5,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          actor: { kind: "node", nodeId: "node-test" },
          occurredAt: "2026-09-17T00:00:05.000Z",
          correlationId: "corr-1",
          causation: null,
          controllerEpoch: 1,
          type: "dispatch.started",
          payload: {
            session: {
              schemaVersion: 1,
              sessionId: "sess-rep-1",
              projectId: PROJECT_ID,
              runId: RUN_ID,
              taskId: "task-replay-1",
              dispatchId: "disp-replay-1",
              nodeId: "node-test",
              installationId: "install-test",
              runtimeKind: "contract-fake",
              lifecycleState: "running",              observedState: "working",
            },
          },
        }),
        makeEvent({
          schemaVersion: 1,
          eventId: "evt-rep-06",
          sequence: 6,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          actor: { kind: "node", nodeId: "node-test" },
          occurredAt: "2026-09-17T00:00:06.000Z",
          correlationId: "corr-1",
          causation: null,
          controllerEpoch: 1,
          type: "dispatch.finished",
          payload: {
            dispatchId: "disp-replay-1",
            sessionId: "sess-rep-1",
            outcome: "completed",
            summary: "Replay dispatch done",
          },
        }),
      ]

      // Incrementally append each event and feed stored event to engine
      let expectedSeq = 0
      for (let i = 0; i < events.length; i += 1) {
        const cmd = makeCommand({ commandId: `cmd-rep-${i + 1}` })
        const res = store.append({
          command: cmd,
          events: [events[i]],
          expectedSequence: expectedSeq,
        })
        expect(res.events.length).toBe(1)
        expectedSeq += 1

        const storedEvent = res.events[0]
        engine.applyEvent(RUN_ID, storedEvent)
      }

      const incremental = engine.getProjection(RUN_ID)!
      expect(incremental).toBeDefined()
      expect(incremental.lastAppliedSequence).toBe(6)
      expect(incremental.run.state).toBe("completed")

      // Rebuild from sequence 1 from SQLite
      const replayed = await engine.rebuildRun(RUN_ID)

      // Assert equivalence
      expect(incremental.stateDigest).toBe(replayed.stateDigest)
      expect(canonicalJson(stripUndefined(incremental))).toBe(canonicalJson(stripUndefined(replayed)))
      expect(incremental).toEqual(replayed)

      // verifyReplayEquivalence method asserts byte-for-byte and returns true
      const isEquivalent = await engine.verifyReplayEquivalence(RUN_ID)
      expect(isEquivalent).toBe(true)
    })
  })

  describe("Edge cases and domain branches", () => {
    it("handles multiple tasks with dependency-based default states and ordered execution", async () => {
      // Task 1: no dependencies -> draft
      // Task 2: depends on Task 1 -> pending
      const task1Evt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-multi-1",
        sequence: 1,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:01.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "run.created",
        payload: {
          run: {
            schemaVersion: 1,
            runId: RUN_ID,
            projectId: PROJECT_ID,
            goal: "Multiple tasks DAG test",
            state: "draft",
            paused: false,
            createdAt: "2026-09-17T00:00:01.000Z",
            updatedAt: "2026-09-17T00:00:01.000Z",
            externalReferences: [],
          },
        },
      })
      const task2Evt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-multi-2",
        sequence: 2,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:02.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "task.created",
        payload: {
          task: {
            schemaVersion: 1,
            taskId: "task-root",
            runId: RUN_ID,
            projectId: PROJECT_ID,
            title: "Root task",
            description: "No dependencies",
            failurePolicy: "block",
            state: "pending",
            dependencies: [],
            externalReferences: [],
          },
        },
      })
      const task3Evt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-multi-3",
        sequence: 3,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:03.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "task.created",
        payload: {
          task: {
            schemaVersion: 1,
            taskId: "task-child",
            runId: RUN_ID,
            projectId: PROJECT_ID,
            title: "Child task",
            description: "Depends on root",
            failurePolicy: "block",
            state: "pending",
            dependencies: [{ taskId: "task-root" as any, failurePolicy: "fail" }],
            externalReferences: [],
          },
        },
      })

      let state = reduceEvent(null, task1Evt)
      state = reduceEvent(state, task2Evt)
      state = reduceEvent(state, task3Evt)

      expect(state.tasks["task-root"].state).toBe("draft")
      expect(state.tasks["task-child"].state).toBe("pending")
      expect(state.tasks["task-child"].dependencies.length).toBe(1)

      // Finish task-root
      const dispRoot = makeEnvelope({ dispatchId: "disp-root", taskId: "task-root" })
      const dispPropEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-multi-4",
        sequence: 4,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:04.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.proposed",
        payload: {
          dispatch: {
            schemaVersion: 1,
            envelope: dispRoot,
            envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            state: "proposed",
            createdAt: "2026-09-17T00:00:04.000Z",
            externalReferences: [],
          },
        },
      })
      const dispFinRootEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-multi-5",
        sequence: 5,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:05.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.finished",
        payload: {
          dispatchId: "disp-root",
          outcome: "completed",
        },
      })

      state = reduceEvent(state, dispPropEvt)
      state = reduceEvent(state, dispFinRootEvt)

      expect(state.tasks["task-root"].state).toBe("completed")
      // Run is not yet completed because task-child is still pending!
      expect(state.run.state).toBe("draft")

      // Finish task-child
      const dispChild = makeEnvelope({ dispatchId: "disp-child", taskId: "task-child" })
      const dispChildPropEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-multi-6",
        sequence: 6,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:06.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.proposed",
        payload: {
          dispatch: {
            schemaVersion: 1,
            envelope: dispChild,
            envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            state: "proposed",
            createdAt: "2026-09-17T00:00:06.000Z",
            externalReferences: [],
          },
        },
      })
      const dispFinChildEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-multi-7",
        sequence: 7,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:07.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.finished",
        payload: {
          dispatchId: "disp-child",
          outcome: "completed",
        },
      })

      state = reduceEvent(state, dispChildPropEvt)
      state = reduceEvent(state, dispFinChildEvt)

      expect(state.tasks["task-child"].state).toBe("completed")
      // Now all tasks are completed, so run completes!
      expect(state.run.state).toBe("completed")
      expect(state.run.completedAt).toBe("2026-09-17T00:00:07.000Z")
    })

    it("handles multiple dispatches and retry without erasing prior attempt history", () => {
      let state: RunProjectionState | null = null

      const runEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-retry-1",
        sequence: 1,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:01.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "run.created",
        payload: {
          run: {
            schemaVersion: 1,
            runId: RUN_ID,
            projectId: PROJECT_ID,
            goal: "Retry demonstration",
            state: "draft",
            paused: false,
            createdAt: "2026-09-17T00:00:01.000Z",
            updatedAt: "2026-09-17T00:00:01.000Z",
            externalReferences: [],
          },
        },
      })
      const taskEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-retry-2",
        sequence: 2,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:02.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "task.created",
        payload: {
          task: {
            schemaVersion: 1,
            taskId: "task-flaky",
            runId: RUN_ID,
            projectId: PROJECT_ID,
            title: "Flaky task",
            description: "Will fail first attempt",
            failurePolicy: "block",
            state: "pending",
            dependencies: [],
            externalReferences: [],
          },
        },
      })

      state = reduceEvent(state, runEvt)
      state = reduceEvent(state, taskEvt)

      // Attempt 1: proposed -> started -> failed
      const env1 = makeEnvelope({ dispatchId: "disp-att-1", taskId: "task-flaky", attempt: 1 })
      const prop1 = makeEvent({
        schemaVersion: 1,
        eventId: "evt-retry-3",
        sequence: 3,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:03.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.proposed",
        payload: {
          dispatch: {
            schemaVersion: 1,
            envelope: env1,
            envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            state: "proposed",
            createdAt: "2026-09-17T00:00:03.000Z",
            externalReferences: [],
          },
        },
      })
      const start1 = makeEvent({
        schemaVersion: 1,
        eventId: "evt-retry-4",
        sequence: 4,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:04.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.started",
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: "sess-1",
            projectId: PROJECT_ID,
            runId: RUN_ID,
            taskId: "task-flaky",
            dispatchId: "disp-att-1",
            nodeId: "node-test",
            installationId: "install-test",
            runtimeKind: "contract-fake",
            lifecycleState: "running",            observedState: "working",
          },
        },
      })
      const fin1 = makeEvent({
        schemaVersion: 1,
        eventId: "evt-retry-5",
        sequence: 5,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:05.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.finished",
        payload: {
          dispatchId: "disp-att-1",
          sessionId: "sess-1",
          outcome: "failed",
          summary: "Network glitch",
        },
      })

      state = reduceEvent(state, prop1)
      state = reduceEvent(state, start1)
      state = reduceEvent(state, fin1)

      expect(state.tasks["task-flaky"].state).toBe("failed")
      expect(state.tasks["task-flaky"].dispatchAttempts).toBe(1)
      expect(state.dispatches["disp-att-1"].state).toBe("failed")
      expect(state.sessions["sess-1"].state).toBe("failed")

      // Attempt 2: retry proposed -> started -> completed
      const env2 = makeEnvelope({ dispatchId: "disp-att-2", taskId: "task-flaky", attempt: 2 })
      const prop2 = makeEvent({
        schemaVersion: 1,
        eventId: "evt-retry-6",
        sequence: 6,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:06.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.proposed",
        payload: {
          dispatch: {
            schemaVersion: 1,
            envelope: env2,
            envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            state: "proposed",
            createdAt: "2026-09-17T00:00:06.000Z",
            externalReferences: [],
          },
        },
      })
      const start2 = makeEvent({
        schemaVersion: 1,
        eventId: "evt-retry-7",
        sequence: 7,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:07.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.started",
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: "sess-2",
            projectId: PROJECT_ID,
            runId: RUN_ID,
            taskId: "task-flaky",
            dispatchId: "disp-att-2",
            nodeId: "node-test",
            installationId: "install-test",
            runtimeKind: "contract-fake",
            lifecycleState: "running",            observedState: "working",
          },
        },
      })
      const fin2 = makeEvent({
        schemaVersion: 1,
        eventId: "evt-retry-8",
        sequence: 8,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:08.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.finished",
        payload: {
          dispatchId: "disp-att-2",
          sessionId: "sess-2",
          outcome: "completed",
          summary: "Retry succeeded",
        },
      })

      state = reduceEvent(state, prop2)
      expect(state.tasks["task-flaky"].currentDispatchId).toBe("disp-att-2")
      expect(state.tasks["task-flaky"].dispatchAttempts).toBe(2)

      state = reduceEvent(state, start2)
      state = reduceEvent(state, fin2)

      // Both dispatches are recorded and preserved
      expect(state.dispatches["disp-att-1"].state).toBe("failed")
      expect(state.dispatches["disp-att-2"].state).toBe("completed")
      expect(state.tasks["task-flaky"].state).toBe("completed")
      expect(state.run.state).toBe("completed")
    })

    it("does not end the run while a task is still retryable, and settles it on the next attempt", () => {
      // Regression for the defect M4-M surfaced. `dispatch.finished` already
      // recorded `retryable: true` on a failed attempt and already said in a
      // comment that such an attempt "must not end the run", but the
      // run-termination test consulted task STATE alone. So a run whose only
      // task failed once went `failed` — and because a terminal run is
      // absorbing, `dispatch.retry` was then unlicensed at the command seam
      // (`COMMAND_MATRIX` requires a non-terminal run), making "a retry ADDS a
      // dispatch attempt rather than erasing failure history" unreachable.
      let state: RunProjectionState | null = null

      const runEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-rt-1",
        sequence: 1,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:01.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "run.created",
        payload: {
          run: {
            schemaVersion: 1,
            runId: RUN_ID,
            projectId: PROJECT_ID,
            goal: "Retryable failure",
            state: "draft",
            paused: false,
            createdAt: "2026-09-17T00:00:01.000Z",
            updatedAt: "2026-09-17T00:00:01.000Z",
            externalReferences: [],
          },
        },
      })
      const taskEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-rt-2",
        sequence: 2,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:02.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "task.created",
        payload: {
          task: {
            schemaVersion: 1,
            taskId: "task-rt",
            runId: RUN_ID,
            projectId: PROJECT_ID,
            title: "Retryable task",
            description: "Fails once",
            failurePolicy: "block",
            state: "pending",
            dependencies: [],
            externalReferences: [],
          },
        },
      })
      const env1 = makeEnvelope({ dispatchId: "disp-rt-1", taskId: "task-rt", attempt: 1 })
      const prop1 = makeEvent({
        schemaVersion: 1,
        eventId: "evt-rt-3",
        sequence: 3,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:03.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.proposed",
        payload: {
          dispatch: {
            schemaVersion: 1,
            envelope: env1,
            envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            state: "proposed",
            createdAt: "2026-09-17T00:00:03.000Z",
            externalReferences: [],
          },
        },
      })
      const start1 = makeEvent({
        schemaVersion: 1,
        eventId: "evt-rt-3b",
        sequence: 4,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:04.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.started",
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: "sess-rt-1",
            projectId: PROJECT_ID,
            runId: RUN_ID,
            taskId: "task-rt",
            dispatchId: "disp-rt-1",
            nodeId: "node-test",
            installationId: "install-test",
            runtimeKind: "contract-fake",
            lifecycleState: "running",
            observedState: "working",
          },
        },
      })
      const fin1 = makeEvent({
        schemaVersion: 1,
        eventId: "evt-rt-4",
        sequence: 5,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:04.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.finished",
        payload: { dispatchId: "disp-rt-1", outcome: "failed", summary: "transient" },
      })

      state = reduceEvent(state, runEvt)
      state = reduceEvent(state, taskEvt)
      state = reduceEvent(state, prop1)
      state = reduceEvent(state, start1)
      state = reduceEvent(state, fin1)

      // The failure is recorded in full; nothing is erased.
      expect(state.dispatches["disp-rt-1"].state).toBe("failed")
      expect(state.tasks["task-rt"].state).toBe("failed")
      expect(state.tasks["task-rt"].retryable).toBe(true)
      expect(state.tasks["task-rt"].attemptHistory).toHaveLength(1)
      // ...but the run is still live, so a retry remains licensed.
      expect(state.run.state).toBe("active")
      expect(state.run.completedAt).toBeNull()

      const env2 = makeEnvelope({ dispatchId: "disp-rt-2", taskId: "task-rt", attempt: 2 })
      const prop2 = makeEvent({
        schemaVersion: 1,
        eventId: "evt-rt-5",
        sequence: 6,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:05.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.proposed",
        payload: {
          dispatch: {
            schemaVersion: 1,
            envelope: env2,
            envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            state: "proposed",
            createdAt: "2026-09-17T00:00:05.000Z",
            externalReferences: [],
          },
        },
      })
      const fin2 = makeEvent({
        schemaVersion: 1,
        eventId: "evt-rt-6",
        sequence: 7,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:06.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.finished",
        payload: { dispatchId: "disp-rt-2", outcome: "completed", summary: "second time lucky" },
      })

      state = reduceEvent(state, prop2)
      // The proposal consumes the retry eligibility and re-opens the task.
      expect(state.tasks["task-rt"].state).toBe("ready")
      expect(state.tasks["task-rt"].retryable).toBe(false)

      state = reduceEvent(state, fin2)
      // The next attempt is what settles the run, and the first failure is
      // still there to be read.
      expect(state.run.state).toBe("completed")
      expect(state.run.completedAt).toBe("2026-09-17T00:00:06.000Z")
      expect(state.dispatches["disp-rt-1"].state).toBe("failed")
      expect(state.tasks["task-rt"].attemptHistory).toHaveLength(2)
    })

    it("still ends the run on a cancelled attempt, because a cancel is not a retryable failure", () => {
      // The counterweight to the rule above. If a retryable task kept the run
      // alive forever, a cancelled run would never settle either — the rule is
      // specifically about a FAILED attempt being recoverable, not about
      // suppressing run termination generally.
      let state: RunProjectionState | null = null

      state = reduceEvent(
        state,
        makeEvent({
          schemaVersion: 1,
          eventId: "evt-cx-1",
          sequence: 1,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          actor: { kind: "node", nodeId: "node-test" },
          occurredAt: "2026-09-17T00:00:01.000Z",
          correlationId: "corr-1",
          causation: null,
          controllerEpoch: 1,
          type: "run.created",
          payload: {
            run: {
              schemaVersion: 1,
              runId: RUN_ID,
              projectId: PROJECT_ID,
              goal: "Cancel settles",
              state: "draft",
              paused: false,
              createdAt: "2026-09-17T00:00:01.000Z",
              updatedAt: "2026-09-17T00:00:01.000Z",
              externalReferences: [],
            },
          },
        }),
      )
      state = reduceEvent(
        state,
        makeEvent({
          schemaVersion: 1,
          eventId: "evt-cx-2",
          sequence: 2,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          actor: { kind: "node", nodeId: "node-test" },
          occurredAt: "2026-09-17T00:00:02.000Z",
          correlationId: "corr-1",
          causation: null,
          controllerEpoch: 1,
          type: "task.created",
          payload: {
            task: {
              schemaVersion: 1,
              taskId: "task-cx",
              runId: RUN_ID,
              projectId: PROJECT_ID,
              title: "Cancellable task",
              description: "Will be cancelled",
              failurePolicy: "block",
              state: "pending",
              dependencies: [],
              externalReferences: [],
            },
          },
        }),
      )
      state = reduceEvent(
        state,
        makeEvent({
          schemaVersion: 1,
          eventId: "evt-cx-3",
          sequence: 3,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          actor: { kind: "node", nodeId: "node-test" },
          occurredAt: "2026-09-17T00:00:03.000Z",
          correlationId: "corr-1",
          causation: null,
          controllerEpoch: 1,
          type: "dispatch.proposed",
          payload: {
            dispatch: {
              schemaVersion: 1,
              envelope: makeEnvelope({ dispatchId: "disp-cx", taskId: "task-cx", attempt: 1 }),
              envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
              state: "proposed",
              createdAt: "2026-09-17T00:00:03.000Z",
              externalReferences: [],
            },
          },
        }),
      )
      state = reduceEvent(
        state,
        makeEvent({
          schemaVersion: 1,
          eventId: "evt-cx-4",
          sequence: 4,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          actor: { kind: "node", nodeId: "node-test" },
          occurredAt: "2026-09-17T00:00:04.000Z",
          correlationId: "corr-1",
          causation: null,
          controllerEpoch: 1,
          type: "dispatch.finished",
          payload: { dispatchId: "disp-cx", outcome: "cancelled", summary: "operator" },
        }),
      )

      expect(state.tasks["task-cx"].retryable).toBe(false)
      expect(state.run.state).toBe("cancelled")
    })

    it("handles timed_out dispatch setting task to failed and session to timed_out", () => {
      let state: RunProjectionState | null = null

      const runEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-to-1",
        sequence: 1,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:01.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "run.created",
        payload: {
          run: {
            schemaVersion: 1,
            runId: RUN_ID,
            projectId: PROJECT_ID,
            goal: "Timeout test",
            state: "draft",
            paused: false,
            createdAt: "2026-09-17T00:00:01.000Z",
            updatedAt: "2026-09-17T00:00:01.000Z",
            externalReferences: [],
          },
        },
      })
      const taskEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-to-2",
        sequence: 2,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:02.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "task.created",
        payload: {
          task: {
            schemaVersion: 1,
            taskId: "task-to",
            runId: RUN_ID,
            projectId: PROJECT_ID,
            title: "Timing out task",
            description: "Will exceed timeout",
            failurePolicy: "block",
            state: "pending",
            dependencies: [],
            externalReferences: [],
          },
        },
      })
      const env = makeEnvelope({ dispatchId: "disp-to", taskId: "task-to" })
      const propEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-to-3",
        sequence: 3,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:03.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.proposed",
        payload: {
          dispatch: {
            schemaVersion: 1,
            envelope: env,
            envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            state: "proposed",
            createdAt: "2026-09-17T00:00:03.000Z",
            externalReferences: [],
          },
        },
      })
      const startEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-to-4",
        sequence: 4,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:04.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.started",
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: "sess-to",
            projectId: PROJECT_ID,
            runId: RUN_ID,
            taskId: "task-to",
            dispatchId: "disp-to",
            nodeId: "node-test",
            installationId: "install-test",
            runtimeKind: "contract-fake",
            lifecycleState: "running",            observedState: "working",
          },
        },
      })
      const finEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-to-5",
        sequence: 5,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:05.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.finished",
        payload: {
          dispatchId: "disp-to",
          sessionId: "sess-to",
          outcome: "timed_out",
          summary: "Exceeded 300s limit",
        },
      })

      state = reduceEvent(state, runEvt)
      state = reduceEvent(state, taskEvt)
      state = reduceEvent(state, propEvt)
      state = reduceEvent(state, startEvt)
      state = reduceEvent(state, finEvt)

      expect(state.dispatches["disp-to"].state).toBe("timed_out")
      expect(state.tasks["task-to"].state).toBe("failed")
      expect(state.sessions["sess-to"].state).toBe("timed_out")
      // The run is NOT `failed` here, and the change is M4.0's, not a
      // regression: a `timed_out` attempt marks the task `retryable`, and
      // `dispatch.finished` refuses to end a run while a task is retryable. The
      // run therefore stays `active` until a later attempt settles it or an
      // operator cancels it. Previously this line read `failed`, which made the
      // terminal run ABSORBING and so made `dispatch.retry` unlicensed at the
      // command seam — the plan's "a retry ADDS a dispatch attempt rather than
      // erasing failure history" was unreachable for the run lifecycle.
      expect(state.tasks["task-to"].retryable).toBe(true)
      expect(state.run.state).toBe("active")
      expect(state.run.completedAt).toBeNull()
    })

    it("handles cancelled runs when dispatch is cancelled", () => {
      let state: RunProjectionState | null = null

      const runEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-c-1",
        sequence: 1,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:01.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "run.created",
        payload: {
          run: {
            schemaVersion: 1,
            runId: RUN_ID,
            projectId: PROJECT_ID,
            goal: "Cancellation test",
            state: "draft",
            paused: false,
            createdAt: "2026-09-17T00:00:01.000Z",
            updatedAt: "2026-09-17T00:00:01.000Z",
            externalReferences: [],
          },
        },
      })
      const taskEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-c-2",
        sequence: 2,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:02.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "task.created",
        payload: {
          task: {
            schemaVersion: 1,
            taskId: "task-c",
            runId: RUN_ID,
            projectId: PROJECT_ID,
            title: "Task to cancel",
            description: "Will be cancelled",
            failurePolicy: "block",
            state: "pending",
            dependencies: [],
            externalReferences: [],
          },
        },
      })
      const env = makeEnvelope({ dispatchId: "disp-c", taskId: "task-c" })
      const propEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-c-3",
        sequence: 3,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:03.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.proposed",
        payload: {
          dispatch: {
            schemaVersion: 1,
            envelope: env,
            envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            state: "proposed",
            createdAt: "2026-09-17T00:00:03.000Z",
            externalReferences: [],
          },
        },
      })
      const finEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-c-4",
        sequence: 4,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:04.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.finished",
        payload: {
          dispatchId: "disp-c",
          outcome: "cancelled",
          summary: "User requested cancellation",
        },
      })

      state = reduceEvent(state, runEvt)
      state = reduceEvent(state, taskEvt)
      state = reduceEvent(state, propEvt)
      state = reduceEvent(state, finEvt)

      expect(state.dispatches["disp-c"].state).toBe("cancelled")
      expect(state.tasks["task-c"].state).toBe("cancelled")
      expect(state.run.state).toBe("cancelled")
      expect(state.run.completedAt).toBe("2026-09-17T00:00:04.000Z")
    })

    it("idempotently handles duplicate events with sequence <= lastAppliedSequence", () => {
      const runEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-dup-1",
        sequence: 1,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:01.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "run.created",
        payload: {
          run: {
            schemaVersion: 1,
            runId: RUN_ID,
            projectId: PROJECT_ID,
            goal: "Idempotency test",
            state: "draft",
            paused: false,
            createdAt: "2026-09-17T00:00:01.000Z",
            updatedAt: "2026-09-17T00:00:01.000Z",
            externalReferences: [],
          },
        },
      })

      const state1 = reduceEvent(null, runEvt)
      const state2 = reduceEvent(state1, runEvt)

      expect(state2).toBe(state1)
      expect(state2.stateDigest).toBe(state1.stateDigest)
    })

    it("ignores events from a different runId without altering state", () => {
      const runEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-diff-1",
        sequence: 1,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:01.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "run.created",
        payload: {
          run: {
            schemaVersion: 1,
            runId: RUN_ID,
            projectId: PROJECT_ID,
            goal: "Run isolation test",
            state: "draft",
            paused: false,
            createdAt: "2026-09-17T00:00:01.000Z",
            updatedAt: "2026-09-17T00:00:01.000Z",
            externalReferences: [],
          },
        },
      })
      const otherRunEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-diff-2",
        sequence: 2,
        projectId: PROJECT_ID,
        runId: "run-OTHER" as any,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:02.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "task.created",
        payload: {
          task: {
            schemaVersion: 1,
            taskId: "task-other",
            runId: "run-OTHER" as any,
            projectId: PROJECT_ID,
            title: "Foreign task",
            description: "Foreign",
            failurePolicy: "block",
            state: "pending",
            dependencies: [],
            externalReferences: [],
          },
        },
      })

      const state1 = reduceEvent(null, runEvt)
      const state2 = reduceEvent(state1, otherRunEvt)

      expect(state2).toBe(state1)
      expect(state2.tasks["task-other"]).toBeUndefined()
    })

    it("handles out-of-order events gracefully without throwing unhandled exceptions", () => {
      // dispatch.started arrives before task.created or dispatch.proposed
      const startedEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-ooo-1",
        sequence: 1,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:01.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "dispatch.started",
        payload: {
          session: {
            schemaVersion: 1,
            sessionId: "sess-ooo",
            projectId: PROJECT_ID,
            runId: RUN_ID,
            taskId: "task-unknown",
            dispatchId: "disp-unknown",
            nodeId: "node-test",
            installationId: "install-test",
            runtimeKind: "contract-fake",
            lifecycleState: "running",            observedState: "working",
          },
        },
      })

      // Must not crash when starting from null state
      const state = reduceEvent(null, startedEvt)
      expect(state).toBeDefined()
      expect(state.sessions["sess-ooo"]).toBeDefined()
      expect(state.tasks["task-unknown"]).toBeDefined()
      expect(state.tasks["task-unknown"].state).toBe("running")
      expect(state.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    })

    it("handles unhandled event types like legacy.imported gracefully", () => {
      const runEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-unh-1",
        sequence: 1,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:01.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "run.created",
        payload: {
          run: {
            schemaVersion: 1,
            runId: RUN_ID,
            projectId: PROJECT_ID,
            goal: "Import test",
            state: "draft",
            paused: false,
            createdAt: "2026-09-17T00:00:01.000Z",
            updatedAt: "2026-09-17T00:00:01.000Z",
            externalReferences: [],
          },
        },
      })
      const importedEvt = makeEvent({
        schemaVersion: 1,
        eventId: "evt-unh-2",
        sequence: 2,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        actor: { kind: "node", nodeId: "node-test" },
        occurredAt: "2026-09-17T00:00:02.000Z",
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        type: "legacy.imported",
        payload: {
          recordKind: "job",
          reference: { namespace: "legacy", id: "job-99" },
          disposition: "historical",
        },
      })

      const state1 = reduceEvent(null, runEvt)
      const state2 = reduceEvent(state1, importedEvt)

      expect(state2.lastAppliedSequence).toBe(2)
      expect(state2.run.updatedAt).toBe("2026-09-17T00:00:02.000Z")
      expect(state2.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    })

    it("throws appropriate errors on ProjectionEngine misuse", async () => {
      const bareEngine = new ProjectionEngine()

      // Rebuild without store
      await expect(bareEngine.rebuildRun("run-no-store")).rejects.toThrow(
        "SqliteEventStore is required to rebuild run projections"
      )

      // Rebuild with store but non-existent run
      await expect(engine.rebuildRun("run-non-existent")).rejects.toThrow(
        "No events found to rebuild projection for run run-non-existent"
      )

      // Equivalence on missing projection
      await expect(engine.verifyReplayEquivalence("run-missing")).rejects.toThrow(
        "No incremental projection found for run run-missing"
      )
    })
  })
})

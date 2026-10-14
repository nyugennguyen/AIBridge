import { describe, expect, it } from "vitest"
import { BudgetLedger } from "../../../../src/budgets/ledger.js"
import { digestDispatchEnvelope } from "../../../../src/orchestration/digest.js"
import {
  commandIdSchema,
  correlationIdSchema,
  dispatchIdSchema,
  epochSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  sessionIdSchema,
  taskIdSchema,
  userIdSchema,
  type DispatchId,
  type ProjectId,
  type RunId,
  type TaskId,
} from "../../../../src/orchestration/identifiers.js"
import {
  dispatchEnvelopeSchema,
  dispatchSchema,
} from "../../../../src/orchestration/schemas.js"
import type {
  Approval,
  Dispatch,
  DispatchEnvelope,
  OrchestrationCommand,
  OrchestrationEvent,
  Run,
  Task,
} from "../../../../src/orchestration/types.js"
import type {
  DispatchProjection,
  RunProjectionState,
  TaskProjection,
} from "../../../../src/orchestration/projections/types.js"
import { reduceEvent } from "../../../../src/orchestration/projections/reducer.js"
import {
  deriveSiblingDispatchId,
  getSiblingDispatches,
  parseParentDispatchId,
  planFanOutDispatches,
  planFanOutDispatchesSync,
  cancelSiblingsOnFailure,
} from "../../../../src/orchestration/scheduler/index.js"
import { DispatchCoordinator } from "../../../../src/orchestration/coordinator/coordinator.js"
import type { CommandLog } from "../../../../src/orchestration/coordinator/types.js"
import type { EventInput, OutboxRecordInput } from "../../../../src/orchestration/event-store/types.js"

const PROJECT = projectIdSchema.parse("proj-fan-out")
const RUN = runIdSchema.parse("run-fan-out")
const NOW = "2026-10-13T12:00:00.000Z"
const ACTOR = { kind: "user" as const, userId: userIdSchema.parse("tester") }

function makeEnvelope(overrides: Record<string, unknown> = {}): DispatchEnvelope {
  return dispatchEnvelopeSchema.parse({
    schemaVersion: 1,
    dispatchId: "disp-parent",
    attempt: 1,
    projectId: PROJECT,
    runId: RUN,
    taskId: taskIdSchema.parse("task-1"),
    targetNodeId: "node-1",
    installationId: "inst-1",
    runtimeKind: "opencode",
    projectPathId: "path-1",
    prompt: "execute fan-out task",
    roleSnapshot: {
      schemaVersion: 1,
      roleId: "role-1",
      templateVersion: 1,
      projectId: PROJECT,
      name: "Runner",
      purpose: "run",
      instructions: "run",
      requiredCapabilities: ["fs.read"],
      preferredRuntimeKinds: ["opencode"],
      contextSelectionPolicyReference: { namespace: "t", id: "r" },
      permissionRestrictions: {
        allowedCapabilities: ["fs.read"],
        deniedCapabilities: [],
        approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
      },
      author: ACTOR,
      createdAt: NOW,
    },
    ruleSnapshots: [],
    contextManifest: { references: [], manifestDigest: `sha256:${"0".repeat(64)}` },
    requestedCapabilities: ["fs.read"],
    permissionEnvelope: {
      allowedCapabilities: ["fs.read"],
      deniedCapabilities: [],
      approvalRequirements: { destructiveEffects: false, externalEffects: false, capabilities: [] },
    },
    dependencies: [],
    timeoutSeconds: 600,
    controllerEpoch: 1,
    ...overrides,
  })
}

function makeDispatch(
  overrides: Record<string, unknown> = {},
  envelopeOverrides: Record<string, unknown> = {},
): Dispatch {
  const envelope = makeEnvelope(envelopeOverrides)
  return dispatchSchema.parse({
    schemaVersion: 1,
    envelope,
    envelopeDigest: digestDispatchEnvelope(envelope),
    state: "proposed",
    createdAt: NOW,
    externalReferences: [],
    ...overrides,
  })
}

function makeTask(): Task {
  return {
    schemaVersion: 1,
    taskId: taskIdSchema.parse("task-1"),
    runId: RUN,
    projectId: PROJECT,
    title: "Fan-out task",
    description: "Multi-sibling task",
    state: "ready",
    dependencies: [],
    failurePolicy: "fail",
    externalReferences: [],
  }
}

function makeRun(): Run {
  return {
    schemaVersion: 1,
    runId: RUN,
    projectId: PROJECT,
    goal: "Fan-out execution run",
    state: "active",
    paused: false,
    createdAt: NOW,
    updatedAt: NOW,
    externalReferences: [],
  }
}

function makeCommand(
  type: OrchestrationCommand["type"],
  payload: unknown,
  commandId = `cmd-${type}-1`,
): OrchestrationCommand {
  const parsed = {
    schemaVersion: 1 as const,
    commandId: commandIdSchema.parse(commandId),
    type,
    projectId: PROJECT,
    runId: RUN,
    actor: ACTOR,
    controllerNodeId: nodeIdSchema.parse("node-1"),
    controllerEpoch: epochSchema.parse(1),
    leaseId: leaseIdSchema.parse("lease-1"),
    issuedAt: NOW,
    expiresAt: "2026-10-13T13:00:00.000Z",
    correlationId: correlationIdSchema.parse("corr-1"),
    causation: null,
    payload,
  }
  return parsed as unknown as OrchestrationCommand
}

function makeApproval(dispatch: Dispatch): Approval {
  return {
    schemaVersion: 1,
    approvalId: "appr-1" as unknown as Approval["approvalId"],
    projectId: PROJECT,
    runId: RUN,
    dispatchId: dispatch.envelope.dispatchId,
    envelopeDigest: dispatch.envelopeDigest,
    decision: "approved",
    state: "approved",
    basis: { kind: "user" },
    actor: ACTOR,
    decidedAt: NOW,
  }
}

describe("Fan-out dispatch and sibling lifecycle (DoD #6)", () => {
  describe("deterministic sibling derivation", () => {
    it("derives stable sibling IDs from parent ID and index", () => {
      const parentId = dispatchIdSchema.parse("disp-parent")
      const sib0 = deriveSiblingDispatchId(parentId, 0)
      const sib1 = deriveSiblingDispatchId(parentId, 1)
      const sib2 = deriveSiblingDispatchId(parentId, 2)

      expect(sib0).toBe("disp-parent-sibling-0")
      expect(sib1).toBe("disp-parent-sibling-1")
      expect(sib2).toBe("disp-parent-sibling-2")

      // Determinism across multiple invocations
      expect(deriveSiblingDispatchId(parentId, 0)).toBe(sib0)
      expect(deriveSiblingDispatchId(parentId, 1)).toBe(sib1)
    })

    it("parses parent dispatch ID from sibling dispatch ID", () => {
      expect(parseParentDispatchId("disp-parent-sibling-0")).toBe("disp-parent")
      expect(parseParentDispatchId("disp-parent-sibling-42")).toBe("disp-parent")
      expect(parseParentDispatchId("disp-parent")).toBeNull()
      expect(parseParentDispatchId("not-a-sibling-format")).toBeNull()
    })
  })

  describe("N-sibling fan-out planning", () => {
    it("plans N sibling dispatches derived from parent dispatch", async () => {
      const parentDispatch = makeDispatch({}, { fanOut: 3 })
      const result = await planFanOutDispatches({ parentDispatch, fanOut: 3 })

      expect(result.parentDispatchId).toBe("disp-parent")
      expect(result.requestedFanOut).toBe(3)
      expect(result.plannedDispatches).toHaveLength(3)
      expect(result.refusedDispatches).toHaveLength(0)

      const ids = result.plannedDispatches.map((d) => d.envelope.dispatchId)
      expect(ids).toEqual([
        "disp-parent-sibling-0",
        "disp-parent-sibling-1",
        "disp-parent-sibling-2",
      ])

      for (let i = 0; i < result.plannedDispatches.length; i += 1) {
        const sibling = result.plannedDispatches[i]
        expect(sibling.envelope.parentDispatchId).toBe("disp-parent")
        expect(sibling.envelope.fanOut).toBe(1)
        expect(sibling.envelope.projectId).toBe(PROJECT)
        expect(sibling.envelope.runId).toBe(RUN)
        expect(sibling.envelopeDigest).toBe(digestDispatchEnvelope(sibling.envelope))
      }

      // Digest uniqueness: each sibling has a unique canonical digest
      const digests = new Set(result.plannedDispatches.map((d) => d.envelopeDigest))
      expect(digests.size).toBe(3)
    })

    it("handles single-dispatch planning when fanOut is 1 or omitted", () => {
      const parentDispatch = makeDispatch()
      const result = planFanOutDispatchesSync({ parentDispatch })

      expect(result.plannedDispatches).toHaveLength(1)
      expect(result.plannedDispatches[0].envelope.dispatchId).toBe("disp-parent-sibling-0")
    })
  })

  describe("budget ledger integration — DoD #6: refuses the seventh at ceiling 6", () => {
    it("reserves fan-out capacity separately and refuses the seventh sibling at ceiling 6", async () => {
      const ledger = new BudgetLedger({
        resolveLimits: () => ({ maximumFanOut: 6, maximumConcurrency: 6 }),
      })

      const parentDispatch = makeDispatch({}, { fanOut: 7 })
      const plan = await planFanOutDispatches({
        parentDispatch,
        fanOut: 7,
        budgetLedger: ledger,
      })

      // Exactly 6 planned, 1 refused
      expect(plan.plannedDispatches).toHaveLength(6)
      expect(plan.refusedDispatches).toHaveLength(1)

      const refused = plan.refusedDispatches[0]
      expect(refused.siblingDispatchId).toBe("disp-parent-sibling-6")
      expect(refused.index).toBe(6)
      expect(refused.refusal.code).toBe("budget.scope_saturated")
      expect(refused.refusal.limit).toBe(6)
      expect(refused.refusal.heldUnits).toBe(6)

      // Verified separate counters: fan_out is at ceiling 6, concurrency is 0
      expect(ledger.heldUnits(PROJECT, "fan_out")).toBe(6)
      expect(ledger.heldUnits(PROJECT, "concurrency")).toBe(0)
    })

    it("synchronous planning also enforces ceiling 6 and refuses the seventh", () => {
      const ledger = new BudgetLedger({
        resolveLimits: () => ({ maximumFanOut: 6 }),
      })

      const parentDispatch = makeDispatch({}, { fanOut: 7 })
      const plan = planFanOutDispatchesSync({
        parentDispatch,
        fanOut: 7,
        budgetLedger: ledger,
      })

      expect(plan.plannedDispatches).toHaveLength(6)
      expect(plan.refusedDispatches).toHaveLength(1)
      expect(ledger.heldUnits(PROJECT, "fan_out")).toBe(6)
      expect(ledger.heldUnits(PROJECT, "concurrency")).toBe(0)
    })
  })

  describe("sibling cancellation on failure", () => {
    function setupProjectionWithSiblings(count = 3): RunProjectionState {
      let state: RunProjectionState | null = null
      const seedEvent = (type: string, payload: unknown, seq: number): OrchestrationEvent =>
        ({
          schemaVersion: 1,
          eventId: `evt-${seq}`,
          sequence: seq,
          projectId: PROJECT,
          runId: RUN,
          actor: { kind: "system", name: "kernel" },
          occurredAt: NOW,
          correlationId: "corr-1",
          causation: null,
          controllerEpoch: 1,
          commandId: "cmd-seed",
          type,
          payload,
        } as unknown as OrchestrationEvent)

      state = reduceEvent(state, seedEvent("run.created", { run: makeRun() }, 1))
      state = reduceEvent(state, seedEvent("task.created", { task: makeTask() }, 2))

      for (let i = 0; i < count; i += 1) {
        const sibDispatch = makeDispatch(
          { state: "proposed" },
          { dispatchId: `disp-parent-sibling-${i}`, parentDispatchId: "disp-parent" },
        )
        state = reduceEvent(state, seedEvent("dispatch.proposed", { dispatch: sibDispatch }, 3 + i * 2))

        const session = {
          schemaVersion: 1,
          sessionId: sessionIdSchema.parse(`sess-sib-${i}`),
          projectId: PROJECT,
          runId: RUN,
          taskId: taskIdSchema.parse("task-1"),
          dispatchId: sibDispatch.envelope.dispatchId,
          nodeId: sibDispatch.envelope.targetNodeId,
          installationId: sibDispatch.envelope.installationId,
          runtimeKind: sibDispatch.envelope.runtimeKind,
          lifecycleState: "running" as const,
          observedState: "working" as const,
        }
        state = reduceEvent(state, seedEvent("dispatch.started", { session }, 4 + i * 2))
      }

      return state
    }

    it("cancels remaining siblings when one sibling fails terminally in the reducer", () => {
      let state = setupProjectionWithSiblings(3)

      expect(state.dispatches["disp-parent-sibling-0"].state).toBe("running")
      expect(state.dispatches["disp-parent-sibling-1"].state).toBe("running")
      expect(state.dispatches["disp-parent-sibling-2"].state).toBe("running")

      // Sibling 1 fails terminally
      const failureEvent: OrchestrationEvent = {
        schemaVersion: 1,
        eventId: "evt-failure",
        sequence: 10,
        projectId: PROJECT,
        runId: RUN,
        actor: { kind: "system", name: "kernel" },
        occurredAt: NOW,
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        commandId: "cmd-failure",
        type: "dispatch.finished",
        payload: {
          dispatchId: dispatchIdSchema.parse("disp-parent-sibling-1"),
          outcome: "failed",
          summary: "Execution defect in sibling 1",
          sessionId: sessionIdSchema.parse("sess-sib-1"),
        },
      } as unknown as OrchestrationEvent

      state = reduceEvent(state, failureEvent)

      // Sibling 1 is failed
      expect(state.dispatches["disp-parent-sibling-1"].lifecycleState).toBe("failed")
      expect(state.dispatches["disp-parent-sibling-1"].state).toBe("failed")

      // Siblings 0 and 2 are cancelled by sibling cancellation policy
      expect(state.dispatches["disp-parent-sibling-0"].lifecycleState).toBe("cancelled")
      expect(state.dispatches["disp-parent-sibling-0"].state).toBe("cancelled")
      expect(state.dispatches["disp-parent-sibling-0"].outcome).toBe("cancelled")

      expect(state.dispatches["disp-parent-sibling-2"].lifecycleState).toBe("cancelled")
      expect(state.dispatches["disp-parent-sibling-2"].state).toBe("cancelled")
      expect(state.dispatches["disp-parent-sibling-2"].outcome).toBe("cancelled")

      // Their active sessions are also marked cancelled
      expect(state.sessions["sess-sib-0"].state).toBe("cancelled")
      expect(state.sessions["sess-sib-2"].state).toBe("cancelled")
    })

    it("cancelSiblingsOnFailure is idempotent and absorbs already terminal dispatches", () => {
      const state = setupProjectionWithSiblings(3)

      // First cancellation
      const firstResult = cancelSiblingsOnFailure(state, "disp-parent-sibling-1")
      expect(firstResult.cancelledDispatchIds).toEqual([
        "disp-parent-sibling-0",
        "disp-parent-sibling-2",
      ])

      // Second call on the same state produces no additional cancellations
      const secondResult = cancelSiblingsOnFailure(firstResult.updatedRunState, "disp-parent-sibling-1")
      expect(secondResult.cancelledDispatchIds).toEqual([])
    })

    it("preserves already completed siblings without overwriting their terminal state", () => {
      let state = setupProjectionWithSiblings(3)

      // Sibling 0 finishes completed before sibling 1 fails
      const completedEvent: OrchestrationEvent = {
        schemaVersion: 1,
        eventId: "evt-complete",
        sequence: 10,
        projectId: PROJECT,
        runId: RUN,
        actor: { kind: "system", name: "kernel" },
        occurredAt: NOW,
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        commandId: "cmd-complete",
        type: "dispatch.finished",
        payload: {
          dispatchId: dispatchIdSchema.parse("disp-parent-sibling-0"),
          outcome: "completed",
          summary: "Finished successfully",
          sessionId: sessionIdSchema.parse("sess-sib-0"),
        },
      } as unknown as OrchestrationEvent

      state = reduceEvent(state, completedEvent)
      expect(state.dispatches["disp-parent-sibling-0"].state).toBe("completed")

      // Now sibling 1 fails
      const failureEvent: OrchestrationEvent = {
        schemaVersion: 1,
        eventId: "evt-failure",
        sequence: 11,
        projectId: PROJECT,
        runId: RUN,
        actor: { kind: "system", name: "kernel" },
        occurredAt: NOW,
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        commandId: "cmd-failure",
        type: "dispatch.finished",
        payload: {
          dispatchId: dispatchIdSchema.parse("disp-parent-sibling-1"),
          outcome: "failed",
          summary: "Defect",
          sessionId: sessionIdSchema.parse("sess-sib-1"),
        },
      } as unknown as OrchestrationEvent

      state = reduceEvent(state, failureEvent)

      // Completed sibling remains completed!
      expect(state.dispatches["disp-parent-sibling-0"].state).toBe("completed")
      expect(state.dispatches["disp-parent-sibling-0"].lifecycleState).toBe("completed")

      // Live sibling 2 is cancelled
      expect(state.dispatches["disp-parent-sibling-2"].state).toBe("cancelled")
    })
  })

  describe("coordinator wiring: dispatch.execute fan-out planning", () => {
    function makeHarness(projection: RunProjectionState, ledger?: BudgetLedger) {
      const calls: {
        command: OrchestrationCommand
        events: readonly EventInput[]
        outboxRecords: readonly OutboxRecordInput[]
      }[] = []

      const log: CommandLog = {
        append(options) {
          calls.push({
            command: options.command,
            events: options.events,
            outboxRecords: options.outboxRecords ?? [],
          })
          return { duplicate: false, events: options.events }
        },
      }

      let currentProjection = projection
      const coordinator = new DispatchCoordinator({
        log,
        now: () => NOW,
        newEventId: () => "evt-coord",
        readRun: () => currentProjection,
        budgetLedger: ledger,
      })

      return {
        coordinator,
        calls,
        setProjection: (p: RunProjectionState) => {
          currentProjection = p
        },
      }
    }

    function createApprovedProjection(envelopeOverrides: Record<string, unknown> = {}): {
      projection: RunProjectionState
      dispatch: Dispatch
      approval: Approval
    } {
      let state: RunProjectionState | null = null
      const seedEvent = (type: string, payload: unknown, seq: number): OrchestrationEvent =>
        ({
          schemaVersion: 1,
          eventId: `evt-${seq}`,
          sequence: seq,
          projectId: PROJECT,
          runId: RUN,
          actor: { kind: "system", name: "kernel" },
          occurredAt: NOW,
          correlationId: "corr-1",
          causation: null,
          controllerEpoch: 1,
          commandId: "cmd-seed",
          type,
          payload,
        } as unknown as OrchestrationEvent)

      state = reduceEvent(state, seedEvent("run.created", { run: makeRun() }, 1))
      state = reduceEvent(state, seedEvent("task.created", { task: makeTask() }, 2))

      const dispatch = makeDispatch({ state: "approved" }, envelopeOverrides)
      state = reduceEvent(state, seedEvent("dispatch.proposed", { dispatch }, 3))

      const approval = makeApproval(dispatch)
      state = reduceEvent(state, seedEvent("approval.decided", { approval }, 4))

      return { projection: state, dispatch, approval }
    }

    it("plans N siblings when envelope requests fanOut > 1", async () => {
      const ledger = new BudgetLedger({
        resolveLimits: () => ({ maximumFanOut: 10 }),
      })
      const { projection, dispatch, approval } = createApprovedProjection({ fanOut: 3 })
      const harness = makeHarness(projection, ledger)

      const cmd = makeCommand("dispatch.execute", { dispatch, approval })
      const result = await harness.coordinator.submit(cmd)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.events).toHaveLength(3)
        // All events are dispatch.started
        for (const ev of result.value.events) {
          expect(ev).toBe("dispatch.started")
        }
      }

      // Check log call
      expect(harness.calls).toHaveLength(1)
      const call = harness.calls[0]
      expect(call.events).toHaveLength(3)
      expect(call.outboxRecords).toHaveLength(3)

      // Verified 3 sibling sessions were launched
      const sessionIds = call.events.map((e) => {
        const payload = e.payload as { session: { sessionId: string } }
        return payload.session.sessionId
      })
      expect(sessionIds).toEqual([
        "sess-cmd-dispatch.execute-1-sibling-0",
        "sess-cmd-dispatch.execute-1-sibling-1",
        "sess-cmd-dispatch.execute-1-sibling-2",
      ])

      // Verified ledger recorded 3 fan-out reservations
      expect(ledger.heldUnits(PROJECT, "fan_out")).toBe(3)
      expect(ledger.heldUnits(PROJECT, "concurrency")).toBe(0)
    })

    it("single-dispatch regression: envelopes without fanOut behave identically to before", async () => {
      const { projection, dispatch, approval } = createApprovedProjection()
      const harness = makeHarness(projection)

      const cmd = makeCommand("dispatch.execute", { dispatch, approval })
      const result = await harness.coordinator.submit(cmd)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.events).toEqual(["dispatch.started"])
      }

      expect(harness.calls).toHaveLength(1)
      expect(harness.calls[0].events).toHaveLength(1)
      expect(harness.calls[0].outboxRecords).toHaveLength(1)
    })

    it("refuses execution if a sibling dispatch has already failed terminally", async () => {
      const { projection, dispatch, approval } = createApprovedProjection({ fanOut: 2 })

      // Seed a failed sibling in projection
      const failedSibling = makeDispatch(
        { state: "failed" },
        { dispatchId: "disp-parent-sibling-0", parentDispatchId: "disp-parent" },
      )
      const failureEvent = {
        schemaVersion: 1,
        eventId: "evt-failed-sib",
        sequence: 10,
        projectId: PROJECT,
        runId: RUN,
        actor: { kind: "system", name: "kernel" },
        occurredAt: NOW,
        correlationId: "corr-1",
        causation: null,
        controllerEpoch: 1,
        commandId: "cmd-failed",
        type: "dispatch.finished",
        payload: {
          dispatchId: failedSibling.envelope.dispatchId,
          outcome: "failed",
          summary: "Defect",
        },
      } as unknown as OrchestrationEvent

      const updatedProjection = reduceEvent(
        reduceEvent(
          projection,
          {
            ...failureEvent,
            type: "dispatch.proposed",
            payload: { dispatch: failedSibling },
          } as unknown as OrchestrationEvent,
        ),
        failureEvent,
      )

      const harness = makeHarness(updatedProjection)
      const cmd = makeCommand("dispatch.execute", { dispatch, approval })

      const result = await harness.coordinator.submit(cmd)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe("coordinator.sibling_failed")
      }
    })
  })
})

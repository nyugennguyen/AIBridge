import { describe, expect, it } from "vitest"
import { SqliteEventStore } from "../../../src/orchestration/event-store/event-store.js"
import { openInMemoryDriver } from "../../../src/orchestration/event-store/sqlite-driver.js"
import { policyResultOf } from "../../../src/orchestration/policy/approval.js"
import {
  approvalSchema,
  dispatchSchema,
  orchestrationCommandSchema,
  runSchema,
  sessionSchema,
  taskSchema,
} from "../../../src/orchestration/schemas.js"
import { ProjectionEngine } from "../../../src/orchestration/projections/projection-engine.js"
import { reduceEvent } from "../../../src/orchestration/projections/reducer.js"
import {
  deriveRunAuditView,
  deriveRunSnapshot,
  type RunAuditView,
} from "../../../src/orchestration/projections/tui-adapter.js"
import type { RunProjectionState } from "../../../src/orchestration/projections/types.js"
import type { OrchestrationEvent } from "../../../src/orchestration/types.js"
import {
  approvalWithoutCommandId,
  cancelRequestedThenAnswered,
  cancelledMidFlight,
  cyclicTaskGraph,
  deniedByPolicy,
  PROJECT_ID,
  revisedSameDispatchId,
  RUN_ID,
  shipReleaseWithRetry,
} from "./fixtures/recorded-events.js"

/** Folds a recorded event log. This is the only way a view is ever produced. */
function fold(events: readonly OrchestrationEvent[], upTo: number = events.length): RunProjectionState {
  let state: RunProjectionState | null = null
  for (const event of events.slice(0, upTo)) {
    state = reduceEvent(state, event)
  }
  if (state === null) throw new Error("Cannot fold an empty event log")
  return state
}

/** Drops the store-assigned stream position, which a raw event has no answer for. */
function withoutStreamPosition(state: RunProjectionState): Omit<RunProjectionState, "stateDigest" | "lastAppliedPosition"> {
  const { stateDigest, lastAppliedPosition, ...rest } = state
  void stateDigest
  void lastAppliedPosition
  return rest
}

/** Drops the read model's own digest, which covers the stream position. */
function withoutStateDigest(view: RunAuditView): Omit<RunAuditView, "stateDigest"> {
  const { stateDigest, ...rest } = view
  void stateDigest
  return rest
}

function viewOf(events: readonly OrchestrationEvent[], upTo?: number) {
  return deriveRunAuditView(fold(events, upTo))
}

describe("TUI run/audit adapter, from recorded event fixtures", () => {
  describe("Reconstructing the run view from the event log", () => {
    const events = shipReleaseWithRetry()
    const view = viewOf(events)

    it("reports the run's lifecycle and the derived facts the TUI needs", () => {
      expect(view.runId).toBe(RUN_ID)
      expect(view.projectId).toBe(PROJECT_ID)
      expect(view.goal).toBe("Ship release 4.2.0 with a verified changelog")
      expect(view.state).toBe("completed")
      expect(view.lifecycleState).toBe("completed")
      expect(view.paused).toBe(false)
      expect(view.completedAt).toBe("2026-09-28T00:00:25.000Z")
      expect(view.currentDispatchId).toBe("disp-c-2")
      expect(view.lastAppliedSequence).toBe(events.length)
      expect(view.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(view.graph).toEqual({ status: "valid", reason: null })
    })

    it("shows the task graph with its dependency edges and attempt history", () => {
      expect(view.tasks.map((task) => task.taskId)).toEqual(["task-a", "task-b", "task-c"])
      expect(
        view.tasks.map((task) => ({
          taskId: task.taskId,
          state: task.state,
          dependencies: task.dependencies,
          dependents: task.dependents,
          dispatchAttempts: task.dispatchAttempts,
        })),
      ).toEqual([
        { taskId: "task-a", state: "completed", dependencies: [], dependents: ["task-b", "task-c"], dispatchAttempts: 1 },
        { taskId: "task-b", state: "completed", dependencies: ["task-a"], dependents: ["task-c"], dispatchAttempts: 1 },
        { taskId: "task-c", state: "completed", dependencies: ["task-a", "task-b"], dependents: [], dispatchAttempts: 2 },
      ])
    })

    it("shows the role snapshot in force, bound to the envelope digest", () => {
      // The current dispatch is the newest proposal in the log: the retry.
      const current = view.dispatches.find((dispatch) => dispatch.isCurrent)
      expect(current?.dispatchId).toBe("disp-c-2")
      expect(current?.attempt).toBe(2)
      expect(current?.role).toMatchObject({
        roleId: "role-release-engineer",
        templateVersion: 4,
        name: "Release engineer",
        requiredCapabilities: ["fs.read", "fs.write"],
        allowedCapabilities: ["fs.read", "fs.write"],
        deniedCapabilities: [],
        approvalRequirements: { destructiveEffects: true, externalEffects: true, capabilities: [] },
      })
      expect(current?.role?.envelopeDigest).toBe(current?.envelopeDigest)
      expect(current?.role?.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    })

    it("shows sessions with both the kernel lifecycle and the provider observation", () => {
      // A terminal lifecycle is never paired with a live provider report. The
      // earlier expectations here asserted exactly that contradiction
      // (`completed` + `working`), which `sessionSchema` now refuses; the
      // recorded outcome is the observed fact, so it is written to both axes.
      expect(view.sessions.map((session) => [session.sessionId, session.state, session.observedState])).toEqual([
        ["sess-a-1", "completed", "completed"],
        ["sess-b-1", "completed", "completed"],
        ["sess-c-1", "failed", "failed"],
        ["sess-c-2", "completed", "completed"],
      ])
      // The invariant itself: no session claims to be finished and still live.
      for (const session of view.sessions) {
        if (["completed", "failed", "cancelled", "timed_out"].includes(session.state)) {
          expect(["completed", "failed", "unknown"]).toContain(session.observedState)
        }
      }
      expect(view.sessions[0]).toMatchObject({ nodeId: "node-worker-1", runtimeKind: "opencode", terminalId: "term-release-1" })
    })

    it("shows artifacts as placeholders — identity, size, digest, locator, never content", () => {
      expect(view.artifacts).toEqual([
        {
          artifactId: "art-changelog",
          name: "RELEASE-NOTES-4.2.0.md",
          mediaType: "text/markdown",
          digest: `sha256:${"a".repeat(64)}`,
          byteCount: 4_182,
          dispatchId: "disp-c-2",
          sessionId: "sess-c-2",
          taskId: "task-c",
          locator: "file:///var/aibridge/artifacts/RELEASE-NOTES-4.2.0.md",
          registeredAt: "2026-09-28T00:00:24.000Z",
        },
      ])
      expect(view.tasks[2].artifacts).toEqual(["art-changelog"])
      expect(view.sessions[3].artifacts).toEqual(["art-changelog"])
    })
  })

  describe("Derived blocked state", () => {
    const events = shipReleaseWithRetry()

    it("marks the tasks whose dependencies are unsatisfied as blocked while the plan is in flight", () => {
      // Event 4 is the last `task.created`: task-a is ready, and the other two
      // exist only because their predecessors have not finished.
      const view = viewOf(events, 4)
      expect(view.tasks.map((task) => [task.taskId, task.state, task.lifecycleState, task.blocked, task.unsatisfiedDependencies])).toEqual([
        ["task-a", "ready", "ready", false, []],
        ["task-b", "blocked", "pending", true, ["task-a"]],
        ["task-c", "blocked", "pending", true, ["task-a", "task-b"]],
      ])
      expect(view.tasks[2].readiness).toMatchObject({ status: "waiting" })
    })

    it("clears blocked as the dependencies complete, and never rewrites the kernel lifecycle", () => {
      // Event 11 is task-b's approval: task-a has completed, so task-b is free
      // while task-c still waits on both of its prerequisites.
      const view = viewOf(events, 11)
      expect(view.tasks.map((task) => [task.taskId, task.state, task.lifecycleState, task.blocked])).toEqual([
        ["task-a", "completed", "completed", false],
        ["task-b", "ready", "ready", false],
        ["task-c", "blocked", "pending", true],
      ])
      const finished = viewOf(events)
      expect(finished.tasks.every((task) => !task.blocked)).toBe(true)
    })

    it("reports a graph it cannot validate instead of inventing readiness", () => {
      const view = viewOf(cyclicTaskGraph())
      expect(view.graph.status).toBe("invalid")
      expect(view.graph.reason).toContain("cycle")
      expect(view.tasks.map((task) => task.taskId)).toEqual(["task-a", "task-b"])
      expect(view.tasks.every((task) => task.readiness === null)).toBe(true)
    })
  })

  describe("Retry history", () => {
    it("ADDS an attempt for a retry and keeps the prior failure", () => {
      const taskC = viewOf(shipReleaseWithRetry()).tasks.find((task) => task.taskId === "task-c")
      expect(taskC?.attempts).toHaveLength(2)
      expect(
        taskC?.attempts.map((attempt) => [attempt.attempt, attempt.dispatchId, attempt.state, attempt.outcome, attempt.summary]),
      ).toEqual([
        [1, "disp-c-1", "failed", "failed", "The provider refused to publish without a signed token"],
        [2, "disp-c-2", "completed", "completed", "Release notes published"],
      ])
      // The failure is still reachable after the retry succeeded, and the
      // approval and envelope each attempt was bound to are still named.
      expect(taskC?.attempts.map((attempt) => attempt.approvalId)).toEqual(["appr-c-1", "appr-c-2"])
      expect(taskC?.attempts[0].envelopeDigest).not.toBe(taskC?.attempts[1].envelopeDigest)
      expect(taskC?.dispatchAttempts).toBe(2)
      expect(taskC?.retryable).toBe(false)
    })

    it("keeps the prior attempt when the SAME dispatch id is proposed again at a higher attempt", () => {
      // The event store's `(runId, dispatchId, attempt)` tombstone allows this,
      // and `dispatches` is keyed by dispatch id alone — so this is exactly the
      // case where a keyed map alone would erase the failure.
      const view = viewOf(revisedSameDispatchId())
      const task = view.tasks[0]
      expect(task.attempts.map((attempt) => [attempt.attempt, attempt.dispatchId, attempt.state, attempt.outcome])).toEqual([
        [1, "disp-rev-1", "failed", "failed"],
        [2, "disp-rev-1", "proposed", null],
      ])
      expect(view.approvals).toEqual([
        expect.objectContaining({
          approvalId: "appr-rev-1",
          decision: "approved",
          state: "invalidated",
          invalidatedReason: "dispatch retried with a new envelope attempt",
        }),
      ])
      expect(view.launchAdmission).toMatchObject({
        state: "not-requested",
        reason: expect.stringContaining("has no approved approval to launch"),
      })
    })
  })

  describe("Policy decision and explanation", () => {
    it("shows a real decision with its rendered explanation tree for an approvable dispatch", () => {
      const view = viewOf(shipReleaseWithRetry())
      expect(view.policy).toMatchObject({
        status: "evaluated",
        decision: "require_approval",
        outstandingApprovals: ["destructive_effects", "dispatch_approval", "external_effects"],
        denials: [],
        declaredTimeoutSeconds: 900,
        effectiveTimeoutSeconds: 900,
        roleId: "role-release-engineer",
        roleVersion: 4,
        reason: null,
      })
      const text = view.policy?.explanationText ?? ""
      expect(text).toContain("policy: unchanged — policy evaluation over layers [safety_floor > project > role > rule > dispatch]")
      expect(text).toContain("safety_floor: narrowed — unconditional baseline: approval required for every dispatch")
      expect(text).toContain("rule rule-release-restrictions@2: unchanged — rule rule-release-restrictions@2 matched")
      expect(text).toContain("decision: require_approval")
      expect(text).toContain("- dispatch_approval")
      expect(view.policy?.decisionDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    })

    it("shows a denial, and its reason, rather than a placeholder", () => {
      const view = viewOf(deniedByPolicy())
      expect(view.policy).toMatchObject({ status: "evaluated", decision: "deny" })
      expect(view.policy?.denials).toEqual([
        {
          code: "policy.capability_denied",
          message: "Requested capability 'net.publish' is denied by the effective policy and cannot be granted by any layer or pre-approval",
          capabilities: ["net.publish"],
        },
      ])
      expect(view.policy?.explanationText).toContain("denials:\n  - policy.capability_denied")
      // The attempt line carries the decision too, so a history row is readable
      // without the full explanation.
      expect(view.tasks[0].attempts[0].policyDecision).toBe("deny")
      expect(view.approvals[0]).toMatchObject({ decision: "rejected", policyDecision: "deny" })
    })

    it("exposes the full evaluation on the approval, so policyResultOf is no longer empty", () => {
      const state = fold(deniedByPolicy())
      const approval = state.approvals["appr-deny-1"]
      const evaluation = policyResultOf(approval)
      expect(evaluation).not.toBeNull()
      expect(evaluation?.decision).toBe("deny")
      expect(evaluation?.explanation.nodeId).toBe("policy")
    })

    it("carries the decision on every attempt of a retried task", () => {
      const attempts = viewOf(shipReleaseWithRetry()).tasks[2].attempts
      expect(attempts.map((attempt) => attempt.policyDecision)).toEqual(["require_approval", "require_approval"])
    })
  })

  describe("Launch admission, derived from the events that exist", () => {
    const events = shipReleaseWithRetry()

    it("is 'not-requested' until an approval authorizes a launch", () => {
      // Event 5 is the proposal: nothing has authorized it yet.
      expect(viewOf(events, 5).launchAdmission).toEqual({
        state: "not-requested",
        reason: "Dispatch 'disp-a-1' (attempt 1) is 'proposed' and has no approved approval to launch",
      })
    })

    it("is 'pending' once an approval exists but no `dispatch.started` has been observed", () => {
      expect(viewOf(events, 6).launchAdmission).toEqual({
        state: "pending",
        dispatchId: "disp-a-1",
        approvalId: "appr-a-1",
        commandId: "cmd-approve-a-1",
      })
    })

    it("is 'started' only because a `dispatch.started` was observed", () => {
      expect(viewOf(events, 7).launchAdmission).toEqual({
        state: "started",
        dispatchId: "disp-a-1",
        approvalId: "appr-a-1",
        commandId: "cmd-execute-a-1",
        sessionId: "sess-a-1",
      })
      expect(viewOf(events).launchAdmission).toEqual({
        state: "started",
        dispatchId: "disp-c-2",
        approvalId: "appr-c-2",
        commandId: "cmd-execute-c-2",
        sessionId: "sess-c-2",
      })
    })

    it("never reports 'unknown' or 'failed': no event records a launch command outcome", () => {
      for (const upTo of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, events.length]) {
        expect(["not-requested", "pending", "started"]).toContain(viewOf(events, upTo).launchAdmission.state)
      }
      expect(viewOf(deniedByPolicy()).launchAdmission.state).toBe("not-requested")
    })
  })

  describe("Cancellation, derived from the events that exist", () => {
    it("is 'none' while no cancellation has been requested", () => {
      expect(viewOf(shipReleaseWithRetry()).cancellation).toEqual({ state: "none" })
    })

    it("is 'pending' for a `dispatch.cancel.requested` whose outcome is unobserved", () => {
      // Event 6 of the cancel log is the request; the run is still active.
      const view = viewOf(cancelledMidFlight(), 6)
      expect(view.cancellation).toEqual({
        state: "pending",
        commandId: "cmd-cancel-x-1",
        dispatchIds: ["disp-x-1"],
      })
      expect(view.dispatches[0]).toMatchObject({ state: "running", cancelRequested: true, outcome: null })
    })

    it("becomes 'confirmed' on `run.cancelled`, and outranks the request", () => {
      expect(viewOf(cancelledMidFlight()).cancellation).toEqual({
        state: "confirmed",
        commandId: "cmd-cancel-run-1",
        reason: "Migration is unsafe on production data",
      })
    })

    it("clears once the runtime answers the request, with no run-level decision", () => {
      expect(viewOf(cancelRequestedThenAnswered(), 6).cancellation).toEqual({
        state: "pending",
        commandId: "cmd-cancel-s-1",
        dispatchIds: ["disp-s-1"],
      })
      const answered = viewOf(cancelRequestedThenAnswered())
      expect(answered.cancellation).toEqual({ state: "none" })
      expect(answered.dispatches[0]).toMatchObject({ state: "cancelled", cancelRequested: false, outcome: "cancelled" })
    })
  })

  describe("RunSnapshot compatibility bridge", () => {
    it("rebuilds records that satisfy the orchestration contracts, with nothing invented", () => {
      const { snapshot } = deriveRunSnapshot(fold(shipReleaseWithRetry()))
      expect(snapshot).not.toBeNull()
      // Each rebuilt aggregate is re-parsed by its own strict schema: a
      // fabricated field would fail here.
      expect(runSchema.parse(snapshot?.run)).toMatchObject({ state: "completed", paused: false })
      expect(taskSchema.parse(snapshot?.task)).toMatchObject({ taskId: "task-c", state: "completed", failurePolicy: "block" })
      expect(dispatchSchema.parse(snapshot?.currentProposal?.dispatch)).toMatchObject({ state: "completed" })
      expect(approvalSchema.parse(snapshot?.currentProposal?.approval)).toMatchObject({ approvalId: "appr-c-2", state: "approved" })
      expect(sessionSchema.parse(snapshot?.session)).toMatchObject({ sessionId: "sess-c-2", lifecycleState: "completed" })
    })

    it("maps the current task's attempts onto currentProposal and proposalHistory, oldest first", () => {
      const { snapshot } = deriveRunSnapshot(fold(shipReleaseWithRetry()))
      // The failed attempt is still a first-class proposal: the retry ADDS the
      // current one rather than replacing it.
      expect(snapshot?.proposalHistory.map((proposal) => [
        proposal.draftRevision,
        proposal.dispatch.envelope.dispatchId,
        proposal.dispatch.state,
        proposal.launchAdmission.state,
        proposal.approval?.approvalId,
      ])).toEqual([[1, "disp-c-1", "failed", "started", "appr-c-1"]])
      expect(snapshot?.currentProposal).toMatchObject({
        draftRevision: 2,
        launchAdmission: { state: "started", commandId: "cmd-execute-c-2", sessionId: "sess-c-2" },
        dispatch: { state: "completed" },
        approval: { approvalId: "appr-c-2" },
      })
      expect(snapshot?.draft).toMatchObject({
        taskId: "task-c",
        revision: 2,
        proposalRequired: true,
        fields: { prompt: "Publish the release notes with the signed token", timeoutSeconds: 900 },
      })
    })

    it("reports a superseded same-id attempt's envelope as a gap rather than a proposal", () => {
      // Re-proposing a dispatch id replaces its entry in the dispatch map, so
      // only the digest, outcome and decision of the earlier attempt survive.
      const { snapshot, gaps } = deriveRunSnapshot(fold(revisedSameDispatchId()))
      expect(gaps.map((gap) => gap.field)).toContain("proposalHistory[disp-rev-1#1].dispatch")
      expect(snapshot?.proposalHistory).toEqual([])
      expect(snapshot?.currentProposal).toMatchObject({ draftRevision: 2, launchAdmission: { state: "not-requested" } })
    })

    it("derives the draft revision from the attempt number, which is the kernel's revision counter", () => {
      expect(deriveRunSnapshot(fold(shipReleaseWithRetry())).snapshot?.draft.revision).toBe(2)
      expect(deriveRunSnapshot(fold(revisedSameDispatchId())).snapshot?.draft.revision).toBe(2)
      expect(deriveRunSnapshot(fold(cancelledMidFlight())).snapshot?.draft.revision).toBe(1)
    })

    it("reports the fields the event log cannot supply instead of inventing them", () => {
      const { gaps } = deriveRunSnapshot(fold(shipReleaseWithRetry()))
      expect(gaps.map((gap) => gap.field).sort()).toEqual(["draft.fields.model", "result"])
      expect(gaps.find((gap) => gap.field === "result")?.reason).toContain("No orchestration event records an agent result")
    })

    it("reports a live permission request as a gap, because it is not an orchestration event", () => {
      // Event 17 is the blocked observation: the live session is idle, the run
      // is active, and nothing in the log names the request.
      const blocked = deriveRunSnapshot(fold(shipReleaseWithRetry(), 17))
      expect(blocked.gaps.map((gap) => gap.field).sort()).toEqual(["draft.fields.model", "pendingRequest"])
      expect(blocked.gaps.find((gap) => gap.field === "pendingRequest")?.reason).toContain(
        "not an orchestration event",
      )
      // Event 18 is the runtime's answer: the session is terminal, so there is
      // no outstanding request to report any more.
      expect(deriveRunSnapshot(fold(shipReleaseWithRetry(), 18)).gaps.map((gap) => gap.field)).not.toContain(
        "pendingRequest",
      )
    })

    it("refuses to name a launch request the event never gave a command id for", () => {
      const { snapshot, gaps } = deriveRunSnapshot(fold(approvalWithoutCommandId()))
      expect([...gaps.map((gap) => gap.field)].sort()).toEqual([
        "currentProposal.launchAdmission.commandId",
        "draft.fields.model",
        "proposalHistory[disp-noid-1#1].launchAdmission.commandId",
      ])
      // The draft is still describable, so the snapshot survives — but the
      // launch admission of the approved dispatch is reported, not invented.
      expect(snapshot?.draft.taskId).toBe("task-a")
      expect(snapshot?.currentProposal).toBeUndefined()
      expect(gaps.find((gap) => gap.field === "currentProposal.launchAdmission.commandId")?.reason).toContain(
        "carried no `commandId`",
      )
    })

    it("refuses to emit a snapshot at all when a REQUIRED field has no event source", () => {
      // No `task.created` and no `dispatch.proposed` were ever recorded.
      const { snapshot, gaps } = deriveRunSnapshot(fold(shipReleaseWithRetry(), 1))
      expect(snapshot).toBeNull()
      expect(gaps.map((gap) => gap.field)).toEqual(["draft"])
    })
  })

  describe("Determinism", () => {
    it("produces the same view for the same event sequence", () => {
      const first = deriveRunAuditView(fold(shipReleaseWithRetry()))
      const second = deriveRunAuditView(fold(shipReleaseWithRetry()))
      expect(second).toEqual(first)
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
      expect(deriveRunSnapshot(fold(shipReleaseWithRetry())).snapshot).toEqual(
        deriveRunSnapshot(fold(shipReleaseWithRetry())).snapshot,
      )
    })

    it("is reconstructible from the durable event stream, not just from an in-memory fold", async () => {
      const events = shipReleaseWithRetry()
      const [runCreated] = events
      if (runCreated === undefined || runCreated.type !== "run.created") {
        throw new Error("The recorded fixture must begin with run.created")
      }
      const store = new SqliteEventStore(openInMemoryDriver())
      const engine = new ProjectionEngine(store)
      let expectedSequence = 0
      for (const [index, event] of events.entries()) {
        store.append({
          command: orchestrationCommandSchema.parse({
            schemaVersion: 1,
            commandId: `cmd-replay-${index + 1}`,
            projectId: PROJECT_ID,
            runId: RUN_ID,
            actor: { kind: "user", userId: "user-release-manager" },
            controllerNodeId: "node-worker-1",
            controllerEpoch: 3,
            leaseId: "lease-release-1",
            issuedAt: "2026-09-28T00:00:00.000Z",
            expiresAt: "2026-09-28T01:00:00.000Z",
            correlationId: "corr-release-1",
            causation: null,
            type: "run.create",
            // The command envelope is only the store's idempotency key here;
            // the payload has to satisfy the command schema all the same.
            payload: { run: runCreated.payload.run, tasks: [] },
          }),
          events: [event],
          expectedSequence,
        })
        expectedSequence += 1
      }

      const rebuilt = await engine.rebuildRun(RUN_ID)
      const folded = fold(events)
      // A stored event carries a global insertion position the raw fixture does
      // not. That cursor is a read-lag report, not part of the run's identity, so
      // `stateDigest` is the SAME for the replayed and the folded projection: the
      // digest is a function of the events, not of how they were delivered.
      expect(rebuilt.stateDigest).toBe(folded.stateDigest)
      expect(withoutStreamPosition(rebuilt)).toEqual(withoutStreamPosition(folded))
      // The view a TUI renders is a pure function of the log, so a restart that
      // rebuilds from SQLite produces exactly the same audit view.
      expect(withoutStateDigest(deriveRunAuditView(rebuilt))).toEqual(withoutStateDigest(deriveRunAuditView(folded)))
    })
  })
})

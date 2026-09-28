import { digestDispatchEnvelope, digestJson } from "../digest.js"
import type { Digest, Timestamp } from "../identifiers.js"
import { verifyApproval } from "../policy/approval.js"
import type { Approval, DispatchEnvelope, OrchestrationEvent } from "../types.js"
import type { StoredRunEvent } from "../event-store/types.js"
import {
  RUN_TERMINAL_SET,
  canTransitionTask,
  isRunTerminal,
  isSessionTerminal,
  transitionApproval,
  type RunState,
} from "../transitions.js"
import type {
  ApprovalProjection,
  ArtifactProjection,
  DispatchProjection,
  ProjectionDispatchState,
  ProjectionRunState,
  ProjectionSessionState,
  ProjectionTaskState,
  RunProjection,
  RunProjectionState,
  SessionProjection,
  TaskProjection,
} from "./types.js"

/**
 * Derives the durable approval lifecycle from the events alone.
 *
 * A `dispatch.proposed` for a dispatch that already has an approval is either
 * the first proposal (nothing to invalidate) or a revision. A revision changes
 * the envelope digest, so every approval bound to the previous digest stops
 * binding — this is the Milestone 3 criterion "approval becomes invalid after
 * any envelope mutation", and deriving it here (rather than trusting an
 * event's word) is what keeps the read model replayable and stops a projection
 * from becoming a second source of truth.
 *
 * The route is the approval state machine: only a non-terminal approval can be
 * invalidated, and the verdict comes from `verifyApproval` rather than a
 * hand-rolled digest comparison.
 */
function invalidateApprovalsForEnvelope(
  approvals: Record<string, ApprovalProjection>,
  dispatchId: string,
  envelope: DispatchEnvelope,
  occurredAt: Timestamp,
): Record<string, ApprovalProjection> {
  let changed = false
  const next: Record<string, ApprovalProjection> = { ...approvals }

  for (const [approvalId, approval] of Object.entries(approvals)) {
    if (approval.dispatchId !== dispatchId) continue

    // Re-verify against the *record*, not the projection, so the check is the
    // same one `authorizeDispatch` performs at execution time.
    const record: Approval = {
      schemaVersion: 1,
      approvalId: approval.approvalId,
      projectId: approval.projectId,
      runId: approval.runId,
      dispatchId: approval.dispatchId,
      envelopeDigest: approval.envelopeDigest,
      decision: approval.decision,
      state: approval.state,
      basis: approval.basis,
      actor: approval.actor,
      decidedAt: approval.decidedAt,
    }

    const verification = verifyApproval(record, envelope)
    if (verification.state !== "invalidated" || approval.state === "invalidated") continue

    const transitioned = transitionApproval(approval.state, "invalidated")
    next[approvalId] = {
      ...approval,
      state: transitioned,
      invalidatedReason:
        verification.reasons[0] ??
        `Approval '${approvalId}' no longer binds to envelope digest '${verification.computedEnvelopeDigest}'`,
    }
    changed = true
  }

  return changed ? next : approvals
}

export function stripUndefined<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T
  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) {
      result[key] = stripUndefined(val)
    }
  }
  return result as T
}

export function computeStateDigest(state: Omit<RunProjectionState, "stateDigest">): Digest {
  return digestJson(stripUndefined(state))
}

function getGlobalPosition(event: OrchestrationEvent | StoredRunEvent): number | undefined {
  if ("globalPosition" in event && typeof (event as StoredRunEvent).globalPosition === "number") {
    return (event as StoredRunEvent).globalPosition
  }
  return undefined
}

export function reduceEvent(
  currentState: RunProjectionState | null,
  event: OrchestrationEvent | StoredRunEvent
): RunProjectionState {
  if (currentState !== null) {
    if (event.runId !== currentState.run.runId) {
      return currentState
    }
    if (event.sequence <= currentState.lastAppliedSequence) {
      return currentState
    }
  }

  let nextRun: RunProjection = currentState
    ? { ...currentState.run }
    : {
        runId: event.runId,
        projectId: event.projectId,
        state: "draft",
        controllerNodeId: event.actor.kind === "node" ? event.actor.nodeId : null,
        controllerEpoch: event.controllerEpoch,
        activeLeaseId: null,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
        completedAt: null,
      }

  const nextTasks: Record<string, TaskProjection> = currentState
    ? { ...currentState.tasks }
    : {}
  const nextDispatches: Record<string, DispatchProjection> = currentState
    ? { ...currentState.dispatches }
    : {}
  let nextApprovals: Record<string, ApprovalProjection> = currentState
    ? { ...currentState.approvals }
    : {}
  const nextSessions: Record<string, SessionProjection> = currentState
    ? { ...currentState.sessions }
    : {}
  const nextArtifacts: Record<string, ArtifactProjection> = currentState
    ? { ...currentState.artifacts }
    : {}

  switch (event.type) {
    case "run.created": {
      const runPayload = event.payload.run
      const isTerminal = isRunTerminal(runPayload.state)
      nextRun = {
        runId: runPayload.runId,
        projectId: runPayload.projectId,
        state: runPayload.state,
        // `paused` is a run-level gate recorded on the aggregate, surfaced in the
        // projection as the derived `paused` state the scheduler consults before
        // dispatching. It is never a lifecycle state and never drives a
        // transition through the machine.
        ...(runPayload.paused ? { state: "paused" as ProjectionRunState } : {}),
        controllerNodeId: event.actor.kind === "node" ? event.actor.nodeId : nextRun.controllerNodeId,
        controllerEpoch: event.controllerEpoch,
        activeLeaseId: nextRun.activeLeaseId,
        createdAt: runPayload.createdAt,
        updatedAt: runPayload.updatedAt,
        completedAt: isTerminal ? runPayload.updatedAt : null,
        goal: runPayload.goal,
        externalReferences: runPayload.externalReferences,
      }
      break
    }

    case "task.created": {
      const taskPayload = event.payload.task
      const dependencies = taskPayload.dependencies ?? []
      const hasDependencies = dependencies.length > 0
      let taskState: ProjectionTaskState
      if (taskPayload.state && taskPayload.state !== "draft" && taskPayload.state !== "pending") {
        taskState = taskPayload.state as ProjectionTaskState
      } else {
        taskState = hasDependencies ? "pending" : "draft"
      }

      const taskProjection: TaskProjection = {
        taskId: taskPayload.taskId,
        runId: taskPayload.runId,
        projectId: taskPayload.projectId,
        title: taskPayload.title,
        description: taskPayload.description,
        state: taskState,
        dependencies,
        // `failurePolicy` is a real field on `taskSchema`; reading it directly is
        // what makes the scheduler's dependency-failure behaviour driven by the
        // event log rather than silently falling back to a default.
        failurePolicy: taskPayload.failurePolicy ?? null,
        currentDispatchId: null,
        dispatchAttempts: 0,
        retryable: false,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      }
      nextTasks[taskPayload.taskId] = taskProjection
      nextRun = { ...nextRun, updatedAt: event.occurredAt }
      break
    }

    case "dispatch.proposed": {
      const dispatchPayload = event.payload.dispatch
      const dispatchId = dispatchPayload.envelope.dispatchId
      const taskId = dispatchPayload.envelope.taskId

      // A proposal for a dispatch that already carries an approval is either the
      // first proposal (nothing to invalidate) or a revision. A revision changes
      // the envelope digest, and every approval bound to the previous digest
      // stops binding. That is derived here from the events alone so the read
      // model agrees with the recorded `approval.invalidated` events a
      // coordinator writes in the same transaction.
      nextApprovals = invalidateApprovalsForEnvelope(
        nextApprovals,
        dispatchId,
        dispatchPayload.envelope,
        event.occurredAt,
      )

      const dispatchProjection: DispatchProjection = {
        dispatchId,
        taskId,
        runId: dispatchPayload.envelope.runId,
        projectId: dispatchPayload.envelope.projectId,
        envelopeDigest: dispatchPayload.envelopeDigest,
        envelope: dispatchPayload.envelope,
        state: (dispatchPayload.state ?? "proposed") as ProjectionDispatchState,
        approvalId: null,
        sessionId: null,
        attempt: dispatchPayload.envelope.attempt,
        createdAt: dispatchPayload.createdAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
        outcome: null,
        summary: null,
        cancelRequested: false,
        timeoutRequested: false,
      }
      nextDispatches[dispatchId] = dispatchProjection

      const existingTask = nextTasks[taskId]
      if (existingTask) {
        // A dispatch proposal means the task is being attempted, so it is `ready`
        // for that attempt. A task whose previous attempt `failed` is re-opened
        // explicitly: `failed` is terminal in the lifecycle machine, and retry is
        // an *evented* decision by the coordinator, never a spontaneous
        // resurrection. The failed attempt itself is preserved in the dispatch
        // projection, which is where the plan says failure history lives.
        const reopens = existingTask.state === "failed"
        const proposedState: ProjectionTaskState =
          reopens || existingTask.state === "blocked" || canTransitionTask(existingTask.state, "ready")
            ? "ready"
            : existingTask.state
        nextTasks[taskId] = {
          ...existingTask,
          state: proposedState,
          currentDispatchId: dispatchId,
          dispatchAttempts: Math.max(existingTask.dispatchAttempts + 1, dispatchPayload.envelope.attempt),
          // A new attempt consumes the task's retry eligibility. A *proposed*
          // dispatch is not a running task: the task is `ready` until the
          // dispatch actually starts.
          retryable: false,
          updatedAt: event.occurredAt,
        }
      } else {
        nextTasks[taskId] = {
          taskId,
          runId: dispatchPayload.envelope.runId,
          projectId: dispatchPayload.envelope.projectId,
          title: `Task ${taskId}`,
          description: "",
          state: "pending",
          dependencies: [],
          failurePolicy: null,
          retryable: false,
          currentDispatchId: dispatchId,
          dispatchAttempts: dispatchPayload.envelope.attempt,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        }
      }
      // A retry proposal re-opens a run that had already gone terminal on this
      // task's failure. This is an EXPLICIT, evented decision by the coordinator
      // (the proposal is a real event in the log), not the reducer deciding on
      // its own that a failure is recoverable. The failed attempt is preserved
      // in the dispatch projection, which is where failure history belongs.
      if (existingTask?.state === "failed" && RUN_TERMINAL_SET.has(nextRun.state as RunState)) {
        nextRun = { ...nextRun, state: "active" as RunState, completedAt: null, updatedAt: event.occurredAt }
      }
      nextRun = { ...nextRun, updatedAt: event.occurredAt }
      break
    }

    case "approval.decided": {
      const approvalPayload = event.payload.approval
      const existingApproval = nextApprovals[approvalPayload.approvalId]
      const approvalProjection: ApprovalProjection = {
        approvalId: approvalPayload.approvalId,
        dispatchId: approvalPayload.dispatchId,
        runId: approvalPayload.runId,
        projectId: approvalPayload.projectId,
        decision: approvalPayload.decision,
        state: approvalPayload.state,
        envelopeDigest: approvalPayload.envelopeDigest,
        actor: approvalPayload.actor,
        basis: approvalPayload.basis,
        policyResult: (approvalPayload as any).policyResult ?? (approvalPayload.basis ? { basis: approvalPayload.basis } : null),
        decidedAt: approvalPayload.decidedAt ?? event.occurredAt,
        // A decision event may be re-recorded for an approval that was already
        // invalidated. Replaying the decision must not resurrect it: the later
        // invalidation wins, because the digest it names is the current one.
        ...(existingApproval?.state === "invalidated" && existingApproval.invalidatedReason !== undefined
          ? { state: "invalidated" as const, invalidatedReason: existingApproval.invalidatedReason }
          : {}),
      }
      nextApprovals[approvalPayload.approvalId] = approvalProjection

      const existingDispatch = nextDispatches[approvalPayload.dispatchId]
      if (existingDispatch) {
        nextDispatches[approvalPayload.dispatchId] = {
          ...existingDispatch,
          state: approvalPayload.decision === "approved" ? "approved" : "rejected",
          approvalId: approvalPayload.approvalId,
          updatedAt: event.occurredAt,
        }
      }

      if (approvalPayload.decision === "approved" && nextRun.state === "draft") {
        nextRun = {
          ...nextRun,
          state: "active",
          updatedAt: event.occurredAt,
        }
      } else {
        nextRun = { ...nextRun, updatedAt: event.occurredAt }
      }
      break
    }

    case "dispatch.started": {
      const sessionPayload = event.payload.session
      const existingDispatch = nextDispatches[sessionPayload.dispatchId]
      if (existingDispatch) {
        nextDispatches[sessionPayload.dispatchId] = {
          ...existingDispatch,
          state: "running",
          sessionId: sessionPayload.sessionId,
          updatedAt: event.occurredAt,
        }
      }

      const existingTask = nextTasks[sessionPayload.taskId]
      if (existingTask) {
        nextTasks[sessionPayload.taskId] = {
          ...existingTask,
          state: "running",
          currentDispatchId: sessionPayload.dispatchId,
          updatedAt: event.occurredAt,
        }
      } else {
        nextTasks[sessionPayload.taskId] = {
          taskId: sessionPayload.taskId,
          runId: sessionPayload.runId,
          projectId: sessionPayload.projectId,
          title: `Task ${sessionPayload.taskId}`,
          description: "",
          state: "running",
          dependencies: [],
          failurePolicy: null,
          retryable: false,
          currentDispatchId: sessionPayload.dispatchId,
          dispatchAttempts: 1,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        }
      }

      const existingSession = nextSessions[sessionPayload.sessionId]
      nextSessions[sessionPayload.sessionId] = {
        sessionId: sessionPayload.sessionId,
        dispatchId: sessionPayload.dispatchId,
        runId: sessionPayload.runId,
        projectId: sessionPayload.projectId,
        // `dispatch.started` is itself the lifecycle fact: a dispatch that
        // started has a session in `running` (or `launching` if the provider
        // has not yet confirmed). The payload carries it; do not re-derive it.
        state: sessionPayload.lifecycleState,
        observedState: sessionPayload.observedState,
        adapterMetadata: (sessionPayload as { adapterMetadata?: Record<string, unknown> }).adapterMetadata ?? null,
        createdAt: existingSession?.createdAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
        outcome: existingSession?.outcome ?? null,
      }

      if (nextRun.state === "draft") {
        nextRun = {
          ...nextRun,
          state: "active",
          updatedAt: event.occurredAt,
        }
      } else {
        nextRun = { ...nextRun, updatedAt: event.occurredAt }
      }
      break
    }

    case "session.observed": {
      const sessionPayload = event.payload.session
      const existingSession = nextSessions[sessionPayload.sessionId]

      // The event already carries the kernel lifecycle, validated by the
      // aggregate machine when it was recorded. The projection does not
      // re-derive it from the provider's observation vocabulary — that is the
      // conflation this split exists to prevent. It only enforces the machine's
      // terminal-absorbing rule so a late non-terminal observation cannot
      // resurrect a finished session.
      const recorded: ProjectionSessionState = sessionPayload.lifecycleState
      const mappedState: ProjectionSessionState =
        existingSession !== undefined && isSessionTerminal(existingSession.state) && !isSessionTerminal(recorded)
          ? existingSession.state
          : recorded
      const outcome = isSessionTerminal(mappedState) ? mappedState : (existingSession?.outcome ?? null)

      nextSessions[sessionPayload.sessionId] = {
        sessionId: sessionPayload.sessionId,
        dispatchId: sessionPayload.dispatchId,
        runId: sessionPayload.runId,
        projectId: sessionPayload.projectId,
        state: mappedState,
        observedState: sessionPayload.observedState,
        adapterMetadata: (sessionPayload as { adapterMetadata?: Record<string, unknown> }).adapterMetadata
          ?? existingSession?.adapterMetadata
          ?? null,
        createdAt: existingSession?.createdAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
        outcome,
      }
      nextRun = { ...nextRun, updatedAt: event.occurredAt }
      break
    }

    case "dispatch.finished": {
      const finishedPayload = event.payload
      const existingDispatch = nextDispatches[finishedPayload.dispatchId]
      const outcome = finishedPayload.outcome
      const sessionId = finishedPayload.sessionId ?? existingDispatch?.sessionId ?? null

      if (existingDispatch) {
        nextDispatches[finishedPayload.dispatchId] = {
          ...existingDispatch,
          state: outcome,
          outcome,
          summary: finishedPayload.summary ?? existingDispatch.summary ?? null,
          sessionId,
          updatedAt: event.occurredAt,
          // The observed outcome supersedes the request flags: a request that
          // was never answered is no longer pending.
          cancelRequested: outcome === "cancelled" ? false : existingDispatch.cancelRequested,
          timeoutRequested: outcome === "timed_out" ? false : existingDispatch.timeoutRequested,
        }
      } else {
        nextDispatches[finishedPayload.dispatchId] = {
          dispatchId: finishedPayload.dispatchId,
          taskId: "task-unknown" as any,
          runId: event.runId,
          projectId: event.projectId,
          envelopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as any,
          envelope: null as any,
          state: outcome,
          approvalId: null,
          sessionId,
          attempt: 1,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
          outcome,
          summary: finishedPayload.summary ?? null,
          cancelRequested: false,
          timeoutRequested: false,
        }
      }

      const targetTaskId = existingDispatch?.taskId ?? Object.values(nextTasks).find((t) => t.currentDispatchId === finishedPayload.dispatchId)?.taskId
      if (targetTaskId && nextTasks[targetTaskId]) {
        const existingTask = nextTasks[targetTaskId]
        let taskState: ProjectionTaskState
        if (outcome === "completed") {
          taskState = "completed"
        } else if (outcome === "cancelled") {
          taskState = "cancelled"
        } else {
          taskState = "failed"
        }
        nextTasks[targetTaskId] = {
          ...existingTask,
          state: taskState,
          // A failed attempt that the plan permits to be retried must not end the
          // run: a retry adds an attempt rather than erasing the failure.
          retryable: outcome === "failed" || outcome === "timed_out",
          updatedAt: event.occurredAt,
        }
      }

      if (sessionId && nextSessions[sessionId]) {
        const existingSession = nextSessions[sessionId]
        const isTerminal = ["completed", "failed", "cancelled", "timed_out"].includes(existingSession.state)
        if (!isTerminal) {
          nextSessions[sessionId] = {
            ...existingSession,
            state: outcome,
            outcome,
            updatedAt: event.occurredAt,
          }
        }
      }

      const taskList = Object.values(nextTasks)
      // `paused` is a derived read-model state, not a lifecycle state, so it is
      // checked against the machine's terminal set explicitly rather than being
      // coerced into `RunState`.
      if (RUN_TERMINAL_SET.has(nextRun.state as RunState)) {
        // Terminal runs are absorbing. A `dispatch.finished` that arrives after
        // a cancel must record the dispatch/session outcome it actually
        // observed, but it must not recompute the run's lifecycle.
        nextRun = { ...nextRun, updatedAt: event.occurredAt }
      } else if (taskList.length > 0) {
        const allTerminal = taskList.every((t) => ["completed", "failed", "cancelled", "skipped"].includes(t.state))
        if (allTerminal) {
          const allCompleted = taskList.every((t) => t.state === "completed" || t.state === "skipped")
          const allCancelled = taskList.every((t) => t.state === "cancelled")
          if (allCompleted) {
            nextRun = {
              ...nextRun,
              state: "completed",
              completedAt: event.occurredAt,
              updatedAt: event.occurredAt,
            }
          } else if (allCancelled) {
            nextRun = {
              ...nextRun,
              state: "cancelled",
              completedAt: event.occurredAt,
              updatedAt: event.occurredAt,
            }
          } else {
            nextRun = {
              ...nextRun,
              state: "failed",
              completedAt: event.occurredAt,
              updatedAt: event.occurredAt,
            }
          }
        } else {
          nextRun = { ...nextRun, updatedAt: event.occurredAt }
        }
      } else {
        if (outcome === "cancelled") {
          nextRun = {
            ...nextRun,
            state: "cancelled",
            completedAt: event.occurredAt,
            updatedAt: event.occurredAt,
          }
        } else {
          nextRun = { ...nextRun, updatedAt: event.occurredAt }
        }
      }
      break
    }

    case "controller.lease.changed": {
      const leasePayload = event.payload.lease
      nextRun = {
        ...nextRun,
        activeLeaseId: leasePayload.leaseId,
        controllerEpoch: leasePayload.epoch,
        controllerNodeId: leasePayload.controllerNodeId,
        updatedAt: event.occurredAt,
      }
      break
    }

    case "artifact.registered": {
      const artifactPayload = event.payload.artifact
      const artifactProjection: ArtifactProjection = {
        artifactId: artifactPayload.artifactId,
        projectId: artifactPayload.projectId,
        runId: artifactPayload.runId,
        dispatchId: artifactPayload.dispatchId,
        sessionId: artifactPayload.sessionId ?? null,
        name: artifactPayload.name,
        mediaType: artifactPayload.mediaType,
        digest: artifactPayload.digest,
        byteCount: artifactPayload.byteCount,
        source: artifactPayload.source,
        location: artifactPayload.location,
        createdAt: event.occurredAt,
      }
      nextArtifacts[artifactPayload.artifactId] = artifactProjection
      nextRun = { ...nextRun, updatedAt: event.occurredAt }
      break
    }

    case "approval.invalidated": {
      const invalidated = event.payload
      const existing = nextApprovals[invalidated.approvalId]
      if (existing !== undefined) {
        nextApprovals[invalidated.approvalId] = {
          ...existing,
          // Routing through the machine means a re-delivered invalidation for
          // an already-terminal approval cannot move it anywhere.
          state: transitionApproval(existing.state, "invalidated"),
          invalidatedReason: invalidated.reason,
        }
      }
      nextRun = { ...nextRun, updatedAt: event.occurredAt }
      break
    }

    case "run.cancelled": {
      // A run cancel is a controller decision about the kernel's own intent,
      // and `RUN_TRANSITIONS` already allows `draft|active -> cancelled`, so the
      // run lifecycle moves now. What this event does NOT claim is that the
      // runtime terminated anything: each session reaches a terminal lifecycle
      // only when a `dispatch.finished` reports the observed outcome.
      //
      // Reaching a terminal run state is absorbing, so a late
      // `dispatch.finished` cannot drag the run back to `completed`/`failed`
      // (see the guard in that case).
      nextRun = {
        ...nextRun,
        state: "cancelled",
        completedAt: nextRun.completedAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
      }
      break
    }

    case "dispatch.cancel.requested": {
      const request = event.payload
      const existingDispatch = nextDispatches[request.dispatchId]
      if (existingDispatch !== undefined) {
        nextDispatches[request.dispatchId] = {
          ...existingDispatch,
          // Recorded as a request only. The dispatch stays `running` until a
          // `dispatch.finished` reports what the runtime actually did.
          cancelRequested: true,
          updatedAt: event.occurredAt,
        }
      }
      nextRun = { ...nextRun, updatedAt: event.occurredAt }
      break
    }

    case "dispatch.timeout.requested": {
      const request = event.payload
      const existingDispatch = nextDispatches[request.dispatchId]
      if (existingDispatch !== undefined) {
        nextDispatches[request.dispatchId] = {
          ...existingDispatch,
          timeoutRequested: true,
          updatedAt: event.occurredAt,
        }
      }
      nextRun = { ...nextRun, updatedAt: event.occurredAt }
      break
    }

    default:
      nextRun = { ...nextRun, updatedAt: event.occurredAt }
      break
  }

  const lastAppliedSequence = Math.max(currentState?.lastAppliedSequence ?? 0, event.sequence)
  const eventPosition = getGlobalPosition(event)
  const lastAppliedPosition = eventPosition !== undefined
    ? Math.max(currentState?.lastAppliedPosition ?? 0, eventPosition)
    : currentState?.lastAppliedPosition

  const baseState: Omit<RunProjectionState, "stateDigest"> = {
    run: nextRun,
    tasks: nextTasks,
    dispatches: nextDispatches,
    approvals: nextApprovals,
    sessions: nextSessions,
    artifacts: nextArtifacts,
    lastAppliedSequence,
    ...(lastAppliedPosition !== undefined ? { lastAppliedPosition } : {}),
  }

  const stateDigest = computeStateDigest(baseState)

  return {
    ...baseState,
    stateDigest,
  }
}

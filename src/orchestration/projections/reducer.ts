import { digestDispatchEnvelope, digestJson } from "../digest.js"
import type { CommandId, Digest, DispatchId, Timestamp } from "../identifiers.js"
import { verifyApproval } from "../policy/approval.js"
import type { Approval, DispatchEnvelope, OrchestrationEvent } from "../types.js"
import type { StoredRunEvent } from "../event-store/types.js"
import {
  canTransitionTask,
  isRunTerminal,
  isSessionTerminal,
  transitionApproval,
  type RunState,
  type TaskState,
} from "../transitions.js"
import { deriveDispatchPolicy, unavailableDispatchPolicy } from "./policy-view.js"
import type {
  ApprovalProjection,
  ArtifactProjection,
  DispatchAttemptProjection,
  DispatchPolicyProjection,
  DispatchProjection,
  ProjectionCancellation,
  ProjectionDispatchState,
  ProjectionLaunchAdmission,
  ProjectionRunState,
  ProjectionSessionState,
  ProjectionTaskState,
  RunProjection,
  RunProjectionState,
  SessionProjection,
  TaskProjection,
} from "./types.js"

const POLICY_UNAVAILABLE_NO_ENVELOPE =
  "No dispatch envelope is recorded for this dispatch, so no policy decision can be derived"

/** The digest a projection uses when a dispatch has no envelope of its own. */
const ZERO_DIGEST = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

/** Newest proposal first is *not* what the read model wants; this orders oldest to newest. */
function compareDispatchRecency(a: DispatchProjection, b: DispatchProjection): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  if (a.attempt !== b.attempt) return a.attempt - b.attempt
  return a.dispatchId.localeCompare(b.dispatchId)
}

/**
 * Derives the run's launch admission from the dispatch projections.
 *
 * The only launch outcome the event log records is `dispatch.started`, and the
 * only thing that authorizes a launch is an `approved` `approval.decided`. Both
 * are therefore read here rather than invented: a dispatch with a recorded
 * start is `started`, a dispatch that is approved but has not started is
 * `pending` (the launch is authorized and unobserved), and anything else is
 * `not-requested`. The newest proposal wins, because that is the dispatch a
 * launch command would act on — the TUI's `currentProposal`.
 */
export function deriveLaunchAdmission(
  dispatches: Readonly<Record<string, DispatchProjection>>,
): ProjectionLaunchAdmission {
  const ordered = Object.values(dispatches).sort(compareDispatchRecency)

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const dispatch = ordered[index]
    if (dispatch.startedAt === null || dispatch.sessionId === null) continue
    return {
      state: "started",
      dispatchId: dispatch.dispatchId,
      approvalId: dispatch.approvalId,
      commandId: dispatch.startCommandId,
      sessionId: dispatch.sessionId,
    }
  }

  const current = ordered.at(-1)
  if (current === undefined) {
    return { state: "not-requested", reason: "No dispatch has been proposed for this run yet" }
  }
  if (current.state === "approved" && current.approvalId !== null) {
    return {
      state: "pending",
      dispatchId: current.dispatchId,
      approvalId: current.approvalId,
      commandId: current.approvalCommandId,
    }
  }
  return {
    state: "not-requested",
    reason: `Dispatch '${current.dispatchId}' (attempt ${current.attempt}) is '${current.lifecycleState}' and has no approved approval to launch`,
  }
}

/**
 * Upserts one attempt record, keyed by `(dispatchId, attempt)`.
 *
 * A retry proposes a new attempt number and therefore a new key, so it APPENDS
 * and the prior attempt's recorded failure survives. Only a re-proposal of the
 * very same attempt — which the event store's tombstone rejects — rewrites in
 * place.
 */
function upsertAttempt(
  history: readonly DispatchAttemptProjection[],
  record: DispatchAttemptProjection,
): readonly DispatchAttemptProjection[] {
  const index = history.findIndex(
    (attempt) => attempt.dispatchId === record.dispatchId && attempt.attempt === record.attempt,
  )
  if (index < 0) return [...history, record]
  const existing = history[index]
  const next = history.slice()
  // Facts that only ever accumulate for one attempt are never cleared by a
  // later event: once an attempt has started or finished, a re-recorded
  // proposal or decision for the same attempt number cannot un-start or
  // un-finish it.
  next[index] = {
    ...record,
    sessionId: record.sessionId ?? existing.sessionId,
    outcome: record.outcome ?? existing.outcome,
    summary: record.summary ?? existing.summary,
    startedAt: record.startedAt ?? existing.startedAt,
    finishedAt: record.finishedAt ?? existing.finishedAt,
  }
  return next
}

function attemptRecord(input: {
  readonly dispatchId: DispatchId
  readonly attempt: number
  readonly state: ProjectionDispatchState
  readonly outcome: DispatchProjection["outcome"]
  readonly summary: string | null
  readonly sessionId: DispatchProjection["sessionId"]
  readonly approvalId: DispatchProjection["approvalId"]
  readonly envelopeDigest: Digest
  readonly policy: DispatchPolicyProjection
  readonly proposedAt: Timestamp
  readonly startedAt: Timestamp | null
  readonly finishedAt: Timestamp | null
}): DispatchAttemptProjection {
  return {
    dispatchId: input.dispatchId,
    attempt: input.attempt,
    state: input.state,
    outcome: input.outcome,
    summary: input.summary,
    sessionId: input.sessionId,
    approvalId: input.approvalId,
    envelopeDigest: input.envelopeDigest,
    policyDecision: input.policy.decision,
    policyDecisionDigest: input.policy.decisionDigest,
    proposedAt: input.proposedAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  }
}


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

/**
 * Digests the run's DOMAIN state.
 *
 * `lastAppliedPosition` is deliberately EXCLUDED. It is the store's global
 * insertion cursor, and it is present only on events read back from
 * `readStream` (`StoredRunEvent`) — a live `OrchestrationEvent` has no such
 * field. Including it would make `stateDigest` a function of *how* the same
 * events were delivered rather than of the events themselves, and the plan's
 * completion criterion "incremental and full-replay projections are identical"
 * would fail for a projection fed live events versus one rebuilt from the store.
 * The cursor is still reported on the state; it is just not an identity of the
 * state.
 */
export function computeStateDigest(state: Omit<RunProjectionState, "stateDigest">): Digest {
  const { lastAppliedPosition: _cursor, ...domainState } = state
  void _cursor
  return digestJson(stripUndefined(domainState))
}

/**
 * Collapses the derived `paused` read-model state back to a lifecycle state so
 * the machine's terminal set can be consulted honestly. `paused` is a run-level
 * gate, not a lifecycle state, and a paused run is still `active` work.
 */
function runLifecycleOf(state: ProjectionRunState): RunState {
  return state === "paused" ? "active" : state
}

function getGlobalPosition(event: OrchestrationEvent | StoredRunEvent): number | undefined {  if ("globalPosition" in event && typeof (event as StoredRunEvent).globalPosition === "number") {
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
        lifecycleState: "draft",
        state: "draft",
        paused: false,
        controllerNodeId: event.actor.kind === "node" ? event.actor.nodeId : null,
        controllerEpoch: event.controllerEpoch,
        activeLeaseId: null,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
        completedAt: null,
        launchAdmission: { state: "not-requested", reason: "No dispatch has been proposed for this run yet" },
        cancellation: { state: "none" },
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

  // The `commandId` of a cancel request seen in THIS event, carried into the
  // run's derived cancellation record below. It is fold-local because the
  // record it feeds is recomputed on every event.
  let cancelRequestCommandId: CommandId | null = null

  switch (event.type) {
    case "run.created": {
      const runPayload = event.payload.run
      const isTerminal = isRunTerminal(runPayload.state)
      nextRun = {
        runId: runPayload.runId,
        projectId: runPayload.projectId,
        // The lifecycle is retained separately from the derived `state` so a
        // paused run can still say whether it is `draft` or `active`. Keeping
        // only the derived value made the aggregate unreconstructable.
        lifecycleState: runPayload.state,
        state: runPayload.state,
        // `paused` is a run-level gate recorded on the aggregate, surfaced in the
        // projection as the derived `paused` state the scheduler consults before
        // dispatching. It is never a lifecycle state and never drives a
        // transition through the machine.
        ...(runPayload.paused ? { state: "paused" as ProjectionRunState } : {}),
        paused: runPayload.paused,
        controllerNodeId: event.actor.kind === "node" ? event.actor.nodeId : nextRun.controllerNodeId,
        controllerEpoch: event.controllerEpoch,
        activeLeaseId: nextRun.activeLeaseId,
        createdAt: runPayload.createdAt,
        updatedAt: runPayload.updatedAt,
        completedAt: isTerminal ? runPayload.updatedAt : null,
        goal: runPayload.goal,
        externalReferences: runPayload.externalReferences,
        // Admission and cancellation belong to the run, not to the `run.created`
        // event, so a re-recorded run leaves them where the fold put them.
        launchAdmission: nextRun.launchAdmission,
        cancellation: nextRun.cancellation,
      }
      break
    }

    case "task.created": {
      const taskPayload = event.payload.task
      const dependencies = taskPayload.dependencies ?? []
      const hasDependencies = dependencies.length > 0
      // `taskSchema.state` is already a kernel `TaskState`, so the recorded
      // lifecycle is used verbatim; only `draft`/`pending` are refined by the
      // declared dependencies (a task that depends on something is not yet
      // draft work).
      let taskState: TaskState
      if (taskPayload.state && taskPayload.state !== "draft" && taskPayload.state !== "pending") {
        taskState = taskPayload.state
      } else {
        taskState = hasDependencies ? "pending" : "draft"
      }

      const taskProjection: TaskProjection = {
        taskId: taskPayload.taskId,
        runId: taskPayload.runId,
        projectId: taskPayload.projectId,
        title: taskPayload.title,
        description: taskPayload.description,
        lifecycleState: taskState,
        state: taskState,
        dependencies,
        // `failurePolicy` is a real field on `taskSchema`; reading it directly is
        // what makes the scheduler's dependency-failure behaviour driven by the
        // event log rather than silently falling back to a default.
        failurePolicy: taskPayload.failurePolicy ?? null,
        externalReferences: taskPayload.externalReferences ?? [],
        currentDispatchId: null,
        dispatchAttempts: 0,
        attemptHistory: [],
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

      const { policy } = deriveDispatchPolicy(dispatchPayload.envelope, POLICY_UNAVAILABLE_NO_ENVELOPE)
      const dispatchState = (dispatchPayload.state ?? "proposed") as DispatchProjection["lifecycleState"]
      const createdAt = dispatchPayload.createdAt ?? event.occurredAt

      const dispatchProjection: DispatchProjection = {
        dispatchId,
        taskId,
        runId: dispatchPayload.envelope.runId,
        projectId: dispatchPayload.envelope.projectId,
        envelopeDigest: dispatchPayload.envelopeDigest,
        envelope: dispatchPayload.envelope,
        lifecycleState: dispatchState,
        state: dispatchState,
        approvalId: null,
        sessionId: null,
        attempt: dispatchPayload.envelope.attempt,
        createdAt,
        updatedAt: event.occurredAt,
        outcome: null,
        summary: null,
        externalReferences: dispatchPayload.externalReferences ?? [],
        policy,
        approvalCommandId: null,
        startCommandId: null,
        startedAt: null,
        cancelRequested: false,
        timeoutRequested: false,
      }
      nextDispatches[dispatchId] = dispatchProjection

      // The attempt record is written for the proposal itself, so the history
      // exists from the moment the attempt was made — and a retry, which
      // proposes a higher attempt number, appends a second record instead of
      // replacing the first.
      const proposalAttempt = attemptRecord({
        dispatchId,
        attempt: dispatchPayload.envelope.attempt,
        state: dispatchState,
        outcome: null,
        summary: null,
        sessionId: null,
        approvalId: null,
        envelopeDigest: dispatchPayload.envelopeDigest,
        policy,
        proposedAt: createdAt,
        startedAt: null,
        finishedAt: null,
      })

      const existingTask = nextTasks[taskId]
      if (existingTask) {
        // A dispatch proposal means the task is being attempted, so it is `ready`
        // for that attempt. A task whose previous attempt `failed` is re-opened
        // explicitly: `failed` is terminal in the lifecycle machine, and retry is
        // an *evented* decision by the coordinator, never a spontaneous
        // resurrection. The failed attempt itself is preserved in the dispatch
        // projection, which is where the plan says failure history lives.
        const reopens = existingTask.state === "failed"
        // A derived `blocked` is not a lifecycle state, so readiness for the
        // attempt is decided from the lifecycle, never from the derived value.
        const proposedLifecycle: TaskState =
          reopens || existingTask.state === "blocked" || canTransitionTask(existingTask.lifecycleState, "ready")
            ? "ready"
            : existingTask.lifecycleState
        const proposedState: ProjectionTaskState = proposedLifecycle
        nextTasks[taskId] = {
          ...existingTask,
          lifecycleState: proposedLifecycle,
          state: proposedState,
          currentDispatchId: dispatchId,
          dispatchAttempts: Math.max(existingTask.dispatchAttempts + 1, dispatchPayload.envelope.attempt),
          attemptHistory: upsertAttempt(existingTask.attemptHistory, proposalAttempt),
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
          lifecycleState: "pending",
          state: "pending",
          dependencies: [],
          failurePolicy: null,
          externalReferences: [],
          retryable: false,
          currentDispatchId: dispatchId,
          dispatchAttempts: dispatchPayload.envelope.attempt,
          attemptHistory: [proposalAttempt],
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        }
      }
      // A retry proposal re-opens a run that had already gone terminal on this
      // task's failure. This is an EXPLICIT, evented decision by the coordinator
      // (the proposal is a real event in the log), not the reducer deciding on
      // its own that a failure is recoverable. The failed attempt is preserved
      // in the dispatch projection, which is where failure history belongs.
      if (existingTask?.state === "failed" && isRunTerminal(runLifecycleOf(nextRun.state))) {
        nextRun = { ...nextRun, state: "active" as RunState, completedAt: null, updatedAt: event.occurredAt }
      }
      nextRun = { ...nextRun, updatedAt: event.occurredAt }
      break
    }

    case "approval.decided": {
      const approvalPayload = event.payload.approval
      const existingApproval = nextApprovals[approvalPayload.approvalId]
      const approvedDispatch = nextDispatches[approvalPayload.dispatchId]
      // The evaluation the decision was taken against is replayed from the
      // envelope the approval names, so an audit view can show the real
      // decision, denials and explanation rather than a placeholder. A
      // re-recorded decision keeps the evaluation already recorded for it: the
      // same approval id cannot legitimately have been decided against a
      // different digest.
      const policyResult =
        existingApproval?.policyResult ??
        deriveDispatchPolicy(
          approvedDispatch?.envelope ?? null,
          `No dispatch envelope is recorded for dispatch '${approvalPayload.dispatchId}', so the approval's policy evaluation cannot be derived`,
        ).evaluation

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
        policyResult,
        decidedAt: approvalPayload.decidedAt ?? event.occurredAt,
        // A decision event may be re-recorded for an approval that was already
        // invalidated. Replaying the decision must not resurrect it: the later
        // invalidation wins, because the digest it names is the current one.
        ...(existingApproval?.state === "invalidated" && existingApproval.invalidatedReason !== undefined
          ? { state: "invalidated" as const, invalidatedReason: existingApproval.invalidatedReason }
          : {}),
      }
      nextApprovals[approvalPayload.approvalId] = approvalProjection

      if (approvedDispatch) {
        const dispatchState: DispatchProjection["lifecycleState"] =
          approvalPayload.decision === "approved" ? "approved" : "rejected"
        nextDispatches[approvalPayload.dispatchId] = {
          ...approvedDispatch,
          lifecycleState: dispatchState,
          state: dispatchState,
          approvalId: approvalPayload.approvalId,
          approvalCommandId: event.commandId ?? approvedDispatch.approvalCommandId,
          updatedAt: event.occurredAt,
        }

        // The attempt that carries this approval is the dispatch's current
        // attempt, so the history line can name who authorized it.
        const task = nextTasks[approvedDispatch.taskId]
        if (task !== undefined) {
          nextTasks[approvedDispatch.taskId] = {
            ...task,
            attemptHistory: upsertAttempt(
              task.attemptHistory,
              attemptRecord({
                dispatchId: approvedDispatch.dispatchId,
                attempt: approvedDispatch.attempt,
                state: dispatchState,
                outcome: approvedDispatch.outcome,
                summary: approvedDispatch.summary,
                sessionId: approvedDispatch.sessionId,
                approvalId: approvalPayload.approvalId,
                envelopeDigest: approvedDispatch.envelopeDigest,
                policy: approvedDispatch.policy,
                proposedAt: approvedDispatch.createdAt,
                startedAt: approvedDispatch.startedAt,
                finishedAt: null,
              }),
            ),
          }
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
          lifecycleState: "running",
          state: "running",
          sessionId: sessionPayload.sessionId,
          startCommandId: event.commandId ?? existingDispatch.startCommandId,
          startedAt: event.occurredAt,
          updatedAt: event.occurredAt,
        }
      }

      const startedAttempt = attemptRecord({
        dispatchId: sessionPayload.dispatchId,
        attempt: existingDispatch?.attempt ?? 1,
        state: "running",
        outcome: null,
        summary: null,
        sessionId: sessionPayload.sessionId,
        approvalId: existingDispatch?.approvalId ?? null,
        envelopeDigest: existingDispatch?.envelopeDigest ?? (ZERO_DIGEST as Digest),
        policy: existingDispatch?.policy ?? unavailableDispatchPolicy(POLICY_UNAVAILABLE_NO_ENVELOPE),
        proposedAt: existingDispatch?.createdAt ?? event.occurredAt,
        startedAt: event.occurredAt,
        finishedAt: null,
      })

      const existingTask = nextTasks[sessionPayload.taskId]
      if (existingTask) {
        nextTasks[sessionPayload.taskId] = {
          ...existingTask,
          lifecycleState: "running",
          state: "running",
          currentDispatchId: sessionPayload.dispatchId,
          attemptHistory: upsertAttempt(existingTask.attemptHistory, startedAttempt),
          updatedAt: event.occurredAt,
        }
      } else {
        nextTasks[sessionPayload.taskId] = {
          taskId: sessionPayload.taskId,
          runId: sessionPayload.runId,
          projectId: sessionPayload.projectId,
          title: `Task ${sessionPayload.taskId}`,
          description: "",
          lifecycleState: "running",
          state: "running",
          dependencies: [],
          failurePolicy: null,
          externalReferences: [],
          retryable: false,
          currentDispatchId: sessionPayload.dispatchId,
          dispatchAttempts: 1,
          attemptHistory: [startedAttempt],
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
        taskId: sessionPayload.taskId,
        nodeId: sessionPayload.nodeId,
        installationId: sessionPayload.installationId,
        runtimeKind: sessionPayload.runtimeKind,
        terminalId: sessionPayload.terminalId ?? null,
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
        // The identity fields are re-read from every observation, so a stream
        // that begins at a `session.observed` (no `dispatch.started` in the
        // fold) still yields a reconstructable session.
        taskId: sessionPayload.taskId,
        nodeId: sessionPayload.nodeId,
        installationId: sessionPayload.installationId,
        runtimeKind: sessionPayload.runtimeKind,
        terminalId: sessionPayload.terminalId ?? existingSession?.terminalId ?? null,
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
          lifecycleState: outcome,
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
          lifecycleState: outcome,
          state: outcome,
          approvalId: null,
          sessionId,
          attempt: 1,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
          outcome,
          summary: finishedPayload.summary ?? null,
          externalReferences: [],
          policy: unavailableDispatchPolicy(POLICY_UNAVAILABLE_NO_ENVELOPE),
          approvalCommandId: null,
          startCommandId: event.commandId ?? null,
          startedAt: null,
          cancelRequested: false,
          timeoutRequested: false,
        }
      }

      const finishedAttempt = attemptRecord({
        dispatchId: finishedPayload.dispatchId,
        attempt: nextDispatches[finishedPayload.dispatchId].attempt,
        state: outcome,
        outcome,
        summary: finishedPayload.summary ?? null,
        sessionId,
        approvalId: nextDispatches[finishedPayload.dispatchId].approvalId,
        envelopeDigest: nextDispatches[finishedPayload.dispatchId].envelopeDigest,
        policy: nextDispatches[finishedPayload.dispatchId].policy,
        proposedAt: nextDispatches[finishedPayload.dispatchId].createdAt,
        startedAt: nextDispatches[finishedPayload.dispatchId].startedAt,
        finishedAt: event.occurredAt,
      })

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
          lifecycleState: taskState,
          state: taskState,
          // A failed attempt that the plan permits to be retried must not end the
          // run: a retry adds an attempt rather than erasing the failure.
          retryable: outcome === "failed" || outcome === "timed_out",
          attemptHistory: upsertAttempt(existingTask.attemptHistory, finishedAttempt),
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
      // `paused` is a derived read-model state, not a lifecycle state, so the
      // machine's terminal set is consulted with it collapsed away.
      if (isRunTerminal(runLifecycleOf(nextRun.state))) {
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
      const request = event.payload
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
        // The cancellation itself is derived from this event, and it is the
        // controller's DECISION: nothing here claims a runtime terminated.
        cancellation: { state: "confirmed", commandId: event.commandId ?? null, reason: request.reason },
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
      // A run-level cancel decision outranks a dispatch-level request and is
      // never downgraded by one; otherwise the run's outstanding cancellation
      // work is recomputed from the dispatch flags after the switch, so a
      // request the runtime has since answered stops being outstanding.
      cancelRequestCommandId = event.commandId ?? cancelRequestCommandId
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

  // --- Derived run facts, reconciled once per event ---
  //
  // These are recomputed from the dispatches rather than written at each call
  // site, so no event handler can leave them stale, and a replay produces
  // exactly the same values as an incremental update.

  if (nextRun.state !== "paused") {
    // Every write to `state` other than the derived `paused` IS a lifecycle
    // write, so this is where the two are reconciled — one place, instead of a
    // dozen that could drift apart.
    nextRun = { ...nextRun, lifecycleState: nextRun.state }
  }

  nextRun = { ...nextRun, launchAdmission: deriveLaunchAdmission(nextDispatches) }

  if (nextRun.cancellation.state !== "confirmed") {
    const outstanding = Object.values(nextDispatches)
      .filter((dispatch) => dispatch.cancelRequested)
      .map((dispatch) => dispatch.dispatchId)
      .sort((left, right) => left.localeCompare(right))
    const previousCommandId = nextRun.cancellation.state === "pending" ? nextRun.cancellation.commandId : null
    const cancellation: ProjectionCancellation =
      outstanding.length > 0
        ? { state: "pending", commandId: cancelRequestCommandId ?? previousCommandId, dispatchIds: outstanding }
        : { state: "none" }
    nextRun = { ...nextRun, cancellation }
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

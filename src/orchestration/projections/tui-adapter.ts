import type {
  ControlRecord,
  DraftFields,
  DraftSnapshot,
  LaunchAdmission,
  ProposalSnapshot,
  RunSnapshot,
} from "../../application/types.js"
import { digestJson } from "../digest.js"
import type {
  ApprovalId,
  ArtifactId,
  DispatchId,
  NodeId,
  SessionId,
  TaskId,
} from "../identifiers.js"
import { policyResultOf } from "../policy/approval.js"
import type { PolicyDecision } from "../policy/types.js"
import { evaluateTaskReadiness } from "../scheduler/scheduler.js"
import type { TaskReadiness } from "../scheduler/types.js"
import {
  isRunTerminal,
  isSessionTerminal,
  type DispatchState,
  type RunState,
  type TaskState,
} from "../transitions.js"
import type { Approval, Dispatch, Run, Session, Task } from "../types.js"
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
  ProjectionTaskState,
  RunProjection,
  RunProjectionState,
  SessionProjection,
  TaskProjection,
} from "./types.js"

/**
 * The TUI adapter.
 *
 * The TUI's state contract is `RunSnapshot`, a single-run/single-task form model
 * owned by the application service, while the kernel's read model is
 * `RunProjectionState`: a run-scoped, task-graph read model rebuilt by folding
 * events. The two are NOT isomorphic, so this module is the one place the
 * difference is made explicit:
 *
 * - Facts the read model derives (`launchAdmission`, `cancellation`) live on
 *   the projection, because a derived fact belongs in the read model, and the
 *   TUI then receives them rather than recomputing them from events it cannot
 *   see.
 * - Facts with no event source are reported as {@link SnapshotGap}s instead of
 *   being invented. Every rule below names the event it reads.
 */

// --- Audit view ---

export interface RoleInForce {
  readonly roleId: string
  readonly templateVersion: number
  readonly name: string
  readonly purpose: string
  readonly requiredCapabilities: readonly string[]
  readonly allowedCapabilities: readonly string[]
  readonly deniedCapabilities: readonly string[]
  readonly approvalRequirements: {
    readonly destructiveEffects: boolean
    readonly externalEffects: boolean
    readonly capabilities: readonly string[]
  }
  /** Digest of the whole immutable role snapshot on the envelope. */
  readonly snapshotDigest: string
  /** Digest of the envelope the snapshot was captured for. */
  readonly envelopeDigest: string
}

export interface TaskGraphNode {
  readonly taskId: TaskId
  readonly title: string
  readonly description: string
  /** Read-model state; `blocked` is derived from unsatisfied dependencies. */
  readonly state: ProjectionTaskState
  /** Kernel lifecycle. Never `blocked`. */
  readonly lifecycleState: TaskState
  readonly blocked: boolean
  readonly dependencies: readonly TaskId[]
  readonly dependents: readonly TaskId[]
  readonly unsatisfiedDependencies: readonly TaskId[]
  readonly failedDependencies: readonly TaskId[]
  readonly failurePolicy: "block" | "fail" | null
  readonly retryable: boolean
  readonly dispatchAttempts: number
  readonly currentDispatchId: DispatchId | null
  /** Oldest first. A retry appends; the prior failure is never rewritten. */
  readonly attempts: readonly DispatchAttemptProjection[]
  readonly artifacts: readonly ArtifactId[]
  /** The scheduler's own readiness verdict, when the graph validates. */
  readonly readiness: {
    readonly status: string
    readonly reason: string | null
  } | null
}

export interface DispatchAudit {
  readonly dispatchId: DispatchId
  readonly taskId: TaskId
  readonly attempt: number
  readonly state: ProjectionDispatchState
  readonly lifecycleState: DispatchState
  readonly outcome: DispatchProjection["outcome"]
  readonly summary: string | null
  readonly approvalId: ApprovalId | null
  readonly sessionId: SessionId | null
  readonly startedAt: string | null
  readonly createdAt: string
  readonly cancelRequested: boolean
  readonly timeoutRequested: boolean
  readonly envelopeDigest: string
  readonly role: RoleInForce | null
  readonly policy: DispatchPolicyProjection
  readonly isCurrent: boolean
}

export interface ApprovalAudit {
  readonly approvalId: ApprovalId
  readonly dispatchId: DispatchId
  readonly attempt: number | null
  readonly decision: "approved" | "rejected"
  readonly state: ApprovalProjection["state"]
  readonly envelopeDigest: string
  readonly decidedAt: string
  readonly basis: ApprovalProjection["basis"]
  readonly invalidatedReason: string | null
  /** Read from the recorded evaluation via `policyResultOf`. */
  readonly policyDecision: PolicyDecision | null
  readonly policyDecisionDigest: string | null
  readonly policyExplanationText: string | null
  readonly policyOutstandingApprovals: readonly string[]
}

export interface SessionAudit {
  readonly sessionId: SessionId
  readonly dispatchId: DispatchId
  readonly taskId: TaskId | null
  readonly state: SessionProjection["state"]
  readonly observedState: SessionProjection["observedState"]
  readonly nodeId: NodeId | null
  readonly runtimeKind: string | null
  readonly terminalId: string | null
  readonly outcome: string | null
  readonly artifacts: readonly ArtifactId[]
}

/**
 * An artifact as the TUI may show it: identity, size, digest and locator only.
 *
 * The event log deliberately never carries artifact bytes or terminal output
 * (Milestone 3 guardrail), so this is a placeholder by construction — a row
 * that says "this exists, this is how big, fetch it from here", never an
 * inlined body.
 */
export interface ArtifactPlaceholder {
  readonly artifactId: ArtifactId
  readonly name: string
  readonly mediaType: string
  readonly digest: string
  readonly byteCount: number
  readonly dispatchId: DispatchId
  readonly sessionId: SessionId | null
  readonly taskId: TaskId | null
  readonly locator: string
  readonly registeredAt: string
}

export interface RunAuditView {
  readonly runId: RunProjection["runId"]
  readonly projectId: RunProjection["projectId"]
  readonly goal: string | null
  readonly state: ProjectionRunState
  readonly lifecycleState: RunState
  readonly paused: boolean
  readonly completedAt: string | null
  readonly controllerNodeId: NodeId | null
  readonly controllerEpoch: number
  readonly lastAppliedSequence: number
  readonly stateDigest: RunProjectionState["stateDigest"]
  readonly launchAdmission: ProjectionLaunchAdmission
  readonly cancellation: ProjectionCancellation
  readonly graph: { readonly status: "valid" | "invalid"; readonly reason: string | null }
  readonly tasks: readonly TaskGraphNode[]
  readonly dispatches: readonly DispatchAudit[]
  readonly approvals: readonly ApprovalAudit[]
  readonly sessions: readonly SessionAudit[]
  readonly artifacts: readonly ArtifactPlaceholder[]
  readonly currentDispatchId: DispatchId | null
  /** Policy of the current dispatch: the decision a reader most wants to see. */
  readonly policy: DispatchPolicyProjection | null
}

function byText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function compareDispatchRecency(left: DispatchProjection, right: DispatchProjection): number {
  if (left.createdAt !== right.createdAt) return byText(left.createdAt, right.createdAt)
  if (left.attempt !== right.attempt) return left.attempt - right.attempt
  return byText(left.dispatchId, right.dispatchId)
}

function orderedDispatches(state: RunProjectionState): DispatchProjection[] {
  return Object.values(state.dispatches).sort(compareDispatchRecency)
}

/** The dispatch a launch command would act on: the newest proposal. */
export function currentDispatchOf(state: RunProjectionState): DispatchProjection | null {
  return orderedDispatches(state).at(-1) ?? null
}

function roleInForce(dispatch: DispatchProjection | null): RoleInForce | null {
  const role = dispatch?.envelope?.roleSnapshot
  if (dispatch === null || role === undefined) return null
  return {
    roleId: role.roleId,
    templateVersion: role.templateVersion,
    name: role.name,
    purpose: role.purpose,
    requiredCapabilities: role.requiredCapabilities,
    allowedCapabilities: role.permissionRestrictions.allowedCapabilities,
    deniedCapabilities: role.permissionRestrictions.deniedCapabilities,
    approvalRequirements: role.permissionRestrictions.approvalRequirements,
    snapshotDigest: digestJson(role),
    envelopeDigest: dispatch.envelopeDigest,
  }
}

function artifactLocator(artifact: ArtifactProjection): string {
  return artifact.location.kind === "locator"
    ? artifact.location.locator
    : `${artifact.location.reference.namespace}:${artifact.location.reference.id}`
}

function dependentsOf(state: RunProjectionState, taskId: TaskId): TaskId[] {
  return Object.values(state.tasks)
    .filter((task) => task.dependencies.some((dependency) => dependency.taskId === taskId))
    .map((task) => task.taskId)
    .sort(byText)
}

function taskOrder(left: TaskProjection, right: TaskProjection): number {
  if (left.createdAt !== right.createdAt) return byText(left.createdAt, right.createdAt)
  return byText(left.taskId, right.taskId)
}

function deriveTaskGraph(
  state: RunProjectionState,
  dispatches: readonly DispatchProjection[],
  artifacts: readonly ArtifactProjection[],
): { readonly graph: RunAuditView["graph"]; readonly tasks: readonly TaskGraphNode[] } {
  // Readiness is the SCHEDULER's verdict, not a second implementation here:
  // `evaluateTaskReadiness` already owns dependency satisfaction and failure
  // policy, so the TUI's `blocked` cannot drift from what will actually be
  // dispatched. A graph it rejects outright (cycle, dangling dependency) is
  // reported as invalid rather than rendered with invented readiness.
  let readiness: Readonly<Record<string, TaskReadiness>> = {}
  let graph: RunAuditView["graph"] = { status: "valid", reason: null }
  try {
    readiness = evaluateTaskReadiness(state)
  } catch (error) {
    graph = { status: "invalid", reason: error instanceof Error ? error.message : String(error) }
  }

  const artifactTaskIds = new Map<TaskId, ArtifactId[]>()
  for (const artifact of artifacts) {
    const taskId = dispatches.find((dispatch) => dispatch.dispatchId === artifact.dispatchId)?.taskId
    if (taskId === undefined) continue
    const bucket = artifactTaskIds.get(taskId) ?? []
    bucket.push(artifact.artifactId)
    artifactTaskIds.set(taskId, bucket)
  }

  const tasks = Object.values(state.tasks)
    .sort(taskOrder)
    .map<TaskGraphNode>((task) => {
      const verdict = readiness[task.taskId]
      // `waiting` is the scheduler's word for "dependencies are not satisfied
      // yet"; that is precisely the derived `blocked` read-model state.
      const blocked = verdict?.status === "waiting"
      return {
        taskId: task.taskId,
        title: task.title,
        description: task.description,
        state: blocked ? "blocked" : task.state,
        lifecycleState: task.lifecycleState,
        blocked,
        dependencies: task.dependencies.map((dependency) => dependency.taskId),
        dependents: dependentsOf(state, task.taskId),
        unsatisfiedDependencies: verdict?.unsatisfiedDependencies ?? [],
        failedDependencies: verdict?.failedDependencies ?? [],
        failurePolicy: task.failurePolicy,
        retryable: task.retryable,
        dispatchAttempts: task.dispatchAttempts,
        currentDispatchId: task.currentDispatchId,
        attempts: task.attemptHistory,
        artifacts: artifactTaskIds.get(task.taskId) ?? [],
        readiness:
          verdict === undefined
            ? null
            : { status: verdict.status, reason: verdict.reason ?? null },
      }
    })

  return { graph, tasks }
}

/**
 * Rebuilds the run/audit view from the read model.
 *
 * Total and deterministic: the same event sequence always produces the same
 * view, every collection is explicitly ordered rather than relying on object
 * key insertion order, and nothing here can throw on a hostile projection (an
 * invalid task graph is reported, not raised).
 */
export function deriveRunAuditView(state: RunProjectionState): RunAuditView {
  const dispatches = orderedDispatches(state)
  const current = dispatches.at(-1) ?? null
  const artifacts = Object.values(state.artifacts).sort((left, right) => {
    if (left.createdAt !== right.createdAt) return byText(left.createdAt, right.createdAt)
    return byText(left.artifactId, right.artifactId)
  })

  const { graph, tasks } = deriveTaskGraph(state, dispatches, artifacts)

  const approvals = Object.values(state.approvals)
    .map<ApprovalAudit>((approval) => {
      const evaluation = policyResultOf(approval)
      // The attempt is found by the digest the decision was taken against, not
      // by the dispatch id: a dispatch id proposed again at a higher attempt
      // would otherwise report the wrong attempt for an earlier decision.
      const attempt = Object.values(state.tasks)
        .flatMap((task) => task.attemptHistory)
        .find((candidate) => candidate.dispatchId === approval.dispatchId && candidate.envelopeDigest === approval.envelopeDigest)
      return {
        approvalId: approval.approvalId,
        dispatchId: approval.dispatchId,
        attempt: attempt?.attempt ?? null,
        decision: approval.decision,
        state: approval.state,
        envelopeDigest: approval.envelopeDigest,
        decidedAt: approval.decidedAt,
        basis: approval.basis,
        invalidatedReason: approval.invalidatedReason ?? null,
        policyDecision: evaluation?.decision ?? null,
        policyDecisionDigest: evaluation?.decisionDigest ?? null,
        policyExplanationText: evaluation?.explanationText ?? null,
        policyOutstandingApprovals: evaluation?.outstandingApprovals ?? [],
      }
    })
    .sort((left, right) => {
      if (left.decidedAt !== right.decidedAt) return byText(left.decidedAt, right.decidedAt)
      return byText(left.approvalId, right.approvalId)
    })

  const sessions = Object.values(state.sessions)
    .map<SessionAudit>((session) => ({
      sessionId: session.sessionId,
      dispatchId: session.dispatchId,
      taskId: session.taskId,
      state: session.state,
      observedState: session.observedState,
      nodeId: session.nodeId,
      runtimeKind: session.runtimeKind,
      terminalId: session.terminalId,
      outcome: session.outcome,
      artifacts: artifacts
        .filter((artifact) => artifact.sessionId === session.sessionId)
        .map((artifact) => artifact.artifactId),
    }))
    .sort((left, right) => byText(left.sessionId, right.sessionId))

  return {
    runId: state.run.runId,
    projectId: state.run.projectId,
    goal: state.run.goal ?? null,
    state: state.run.state,
    lifecycleState: state.run.lifecycleState,
    paused: state.run.paused,
    completedAt: state.run.completedAt,
    controllerNodeId: state.run.controllerNodeId,
    controllerEpoch: state.run.controllerEpoch,
    lastAppliedSequence: state.lastAppliedSequence,
    stateDigest: state.stateDigest,
    launchAdmission: state.run.launchAdmission,
    cancellation: state.run.cancellation,
    graph,
    tasks,
    dispatches: dispatches.map<DispatchAudit>((dispatch) => ({
      dispatchId: dispatch.dispatchId,
      taskId: dispatch.taskId,
      attempt: dispatch.attempt,
      state: dispatch.state,
      lifecycleState: dispatch.lifecycleState,
      outcome: dispatch.outcome,
      summary: dispatch.summary,
      approvalId: dispatch.approvalId,
      sessionId: dispatch.sessionId,
      startedAt: dispatch.startedAt,
      createdAt: dispatch.createdAt,
      cancelRequested: dispatch.cancelRequested,
      timeoutRequested: dispatch.timeoutRequested,
      envelopeDigest: dispatch.envelopeDigest,
      role: roleInForce(dispatch),
      policy: dispatch.policy,
      isCurrent: dispatch.dispatchId === current?.dispatchId && dispatch.attempt === current.attempt,
    })),
    approvals,
    sessions,
    artifacts: artifacts.map<ArtifactPlaceholder>((artifact) => ({
      artifactId: artifact.artifactId,
      name: artifact.name,
      mediaType: artifact.mediaType,
      digest: artifact.digest,
      byteCount: artifact.byteCount,
      dispatchId: artifact.dispatchId,
      sessionId: artifact.sessionId,
      taskId: dispatches.find((dispatch) => dispatch.dispatchId === artifact.dispatchId)?.taskId ?? null,
      locator: artifactLocator(artifact),
      registeredAt: artifact.createdAt,
    })),
    currentDispatchId: current?.dispatchId ?? null,
    policy: current?.policy ?? null,
  }
}

// --- RunSnapshot compatibility bridge ---

/**
 * A `RunSnapshot` field the event log cannot supply.
 *
 * Reported rather than filled: a fabricated value here would be a TUI showing
 * a fact the kernel never recorded.
 */
export interface SnapshotGap {
  readonly field: string
  readonly reason: string
}

export interface RunSnapshotDerivation {
  /** `null` when a REQUIRED field had no event source. */
  readonly snapshot: RunSnapshot | null
  readonly gaps: readonly SnapshotGap[]
}

function toLaunchAdmission(
  admission: ProjectionLaunchAdmission,
): { readonly value: LaunchAdmission | null; readonly gap: SnapshotGap | null } {
  switch (admission.state) {
    case "not-requested":
      return { value: { state: "not-requested" }, gap: null }
    case "pending":
      // `LaunchAdmission.pending` requires the command id. The projection keeps
      // it null when the source event carried none, and the TUI's type has no
      // honest way to express "pending without a command", so this is a gap.
      return admission.commandId === null
        ? {
            value: null,
            gap: {
              field: "currentProposal.launchAdmission.commandId",
              reason:
                "The approving `approval.decided` event carried no `commandId`, so the launch request it authorized cannot be named",
            },
          }
        : {
            value: { state: "pending", commandId: admission.commandId },
            gap: null,
          }
    case "started":
      return admission.commandId === null
        ? {
            value: null,
            gap: {
              field: "currentProposal.launchAdmission.commandId",
              reason:
                "The `dispatch.started` event carried no `commandId`, so the launch that produced the session cannot be named",
            },
          }
        : {
            value: {
              state: "started",
              commandId: admission.commandId,
              sessionId: admission.sessionId,
            },
            gap: null,
          }
  }
}

function toControlRecord(
  cancellation: ProjectionCancellation,
): { readonly value: ControlRecord | null; readonly gap: SnapshotGap | null } {
  switch (cancellation.state) {
    case "none":
      return { value: { state: "none" }, gap: null }
    case "pending":
      return cancellation.commandId === null
        ? {
            value: null,
            gap: {
              field: "cancellation.commandId",
              reason:
                "The `dispatch.cancel.requested` event carried no `commandId`, so the outstanding cancel request cannot be named",
            },
          }
        : { value: { state: "pending", commandId: cancellation.commandId }, gap: null }
    case "confirmed":
      return cancellation.commandId === null
        ? {
            value: null,
            gap: {
              field: "cancellation.commandId",
              reason: "The `run.cancelled` event carried no `commandId`, so the cancel decision cannot be named",
            },
          }
        : { value: { state: "confirmed", commandId: cancellation.commandId }, gap: null }
  }
}

function toRun(run: RunProjection): { readonly value: Run | null; readonly gap: SnapshotGap | null } {
  if (run.goal === undefined) {
    return { value: null, gap: { field: "run.goal", reason: "No `run.created` event recorded a goal for this run" } }
  }
  if (run.externalReferences === undefined) {
    return {
      value: null,
      gap: {
        field: "run.externalReferences",
        reason: "No `run.created` event recorded external references for this run",
      },
    }
  }
  return {
    // `lifecycleState`, not `state`: a paused run is still `draft` or `active`,
    // and `paused` is a separate flag on the aggregate.
    value: {
      schemaVersion: 1,
      runId: run.runId,
      projectId: run.projectId,
      goal: run.goal,
      state: run.lifecycleState,
      paused: run.paused,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      externalReferences: [...run.externalReferences],
    },
    gap: null,
  }
}

function toTask(task: TaskProjection): { readonly value: Task | null; readonly gap: SnapshotGap | null } {
  if (task.failurePolicy === null) {
    return {
      value: null,
      gap: {
        field: "task.failurePolicy",
        reason: `No 'task.created' event recorded a failure policy for task '${task.taskId}'`,
      },
    }
  }
  return {
    value: {
      schemaVersion: 1,
      taskId: task.taskId,
      runId: task.runId,
      projectId: task.projectId,
      title: task.title,
      description: task.description,
      state: task.lifecycleState,
      failurePolicy: task.failurePolicy,
      dependencies: [...task.dependencies],
      externalReferences: [...task.externalReferences],
    },
    gap: null,
  }
}

function toSession(
  session: SessionProjection,
): { readonly value: Session | null; readonly gap: SnapshotGap | null } {
  if (session.taskId === null || session.nodeId === null || session.installationId === null || session.runtimeKind === null) {
    return {
      value: null,
      gap: {
        field: "session",
        reason: `Session '${session.sessionId}' has no recorded task, node, installation or runtime, so it cannot be rebuilt as a session record`,
      },
    }
  }
  return {
    value: {
      schemaVersion: 1,
      sessionId: session.sessionId,
      projectId: session.projectId,
      runId: session.runId,
      taskId: session.taskId,
      dispatchId: session.dispatchId,
      nodeId: session.nodeId,
      installationId: session.installationId,
      runtimeKind: session.runtimeKind,
      lifecycleState: session.state,
      observedState: session.observedState,
      ...(session.terminalId === null ? {} : { terminalId: session.terminalId }),
    },
    gap: null,
  }
}

function toDispatch(
  dispatch: DispatchProjection,
): { readonly value: Dispatch | null; readonly gap: SnapshotGap | null } {
  if (dispatch.envelope === null) {
    return {
      value: null,
      gap: {
        field: "currentProposal.dispatch",
        reason: `Dispatch '${dispatch.dispatchId}' has no recorded envelope (it was reconstructed from a bare 'dispatch.finished'), so no dispatch record can be rebuilt`,
      },
    }
  }
  return {
    value: {
      schemaVersion: 1,
      envelope: dispatch.envelope,
      envelopeDigest: dispatch.envelopeDigest,
      state: dispatch.lifecycleState,
      createdAt: dispatch.createdAt,
      externalReferences: [...dispatch.externalReferences],
    },
    gap: null,
  }
}

function toApproval(approval: ApprovalProjection): Approval {
  return {
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
}

/**
 * The launch admission of ONE attempt, derived from the same events as the
 * run's. An attempt is `started` when its own `dispatch.started` was observed,
 * `pending` when it carries a live approved approval and no start, and
 * `not-requested` otherwise.
 */
function attemptLaunchAdmission(
  dispatch: DispatchProjection,
): { readonly value: LaunchAdmission | null; readonly gap: SnapshotGap | null } {
  if (dispatch.startedAt !== null && dispatch.sessionId !== null) {
    return dispatch.startCommandId === null
      ? {
          value: null,
          gap: {
            field: `proposalHistory[${dispatch.dispatchId}#${dispatch.attempt}].launchAdmission.commandId`,
            reason: `The 'dispatch.started' event for '${dispatch.dispatchId}' carried no 'commandId'`,
          },
        }
      : {
          value: { state: "started", commandId: dispatch.startCommandId, sessionId: dispatch.sessionId },
          gap: null,
        }
  }
  if (dispatch.state === "approved" && dispatch.approvalId !== null) {
    return dispatch.approvalCommandId === null
      ? {
          value: null,
          gap: {
            field: `proposalHistory[${dispatch.dispatchId}#${dispatch.attempt}].launchAdmission.commandId`,
            reason: `The 'approval.decided' event for '${dispatch.dispatchId}' carried no 'commandId'`,
          },
        }
      : { value: { state: "pending", commandId: dispatch.approvalCommandId }, gap: null }
  }
  return { value: { state: "not-requested" }, gap: null }
}

/**
 * Derives a `RunSnapshot` from the read model.
 *
 * `RunSnapshot` is a single-task form model, so the snapshot is built for the
 * run's current task (the task of the newest proposal). Every field names the
 * event it came from:
 *
 * - `draft.revision`     — the highest attempt proposed for the current task;
 *   a kernel revision IS an immutable `(dispatchId, attempt)` envelope.
 * - `draft.fields`       — the task's own recorded title/description and the
 *   current envelope's prompt, timeout and model.
 * - `draft.proposalRequired` — the current envelope's derived policy decision
 *   (`require_approval`), which is the safety floor's shipped default.
 * - `proposalHistory`    — every earlier attempt, oldest first. `currentProposal`
 *   is the newest, so a retry is visible as history plus a new current.
 * - `cancellation`       — the projection's derived control record.
 *
 * `result` and `pendingRequest` have NO event source (a run result and a
 * live runtime permission request are not orchestration events), so they are
 * reported as gaps instead of being invented.
 */
export function deriveRunSnapshot(state: RunProjectionState): RunSnapshotDerivation {
  const gaps: SnapshotGap[] = []
  const dispatches = orderedDispatches(state)
  const current = dispatches.at(-1) ?? null
  const currentTask = current === null
    ? Object.values(state.tasks).sort(taskOrder)[0] ?? null
    : state.tasks[current.taskId] ?? null

  const run = toRun(state.run)
  if (run.gap !== null) gaps.push(run.gap)

  const task = currentTask === null
    ? { value: null, gap: null as SnapshotGap | null }
    : toTask(currentTask)
  if (task.gap !== null) gaps.push(task.gap)

  // --- Proposal chain for the current task ---
  //
  // Built from the task's ATTEMPT HISTORY, not from the dispatch map, so a retry
  // is visible as one entry per attempt even though a revision under the same
  // dispatch id replaces the map entry.
  const taskAttempts = currentTask?.attemptHistory ?? []
  const taskDispatches = taskAttempts
    .map((attempt) => dispatches.find(
      (dispatch) => dispatch.dispatchId === attempt.dispatchId && dispatch.attempt === attempt.attempt,
    ) ?? null)
  const proposalChain: ProposalSnapshot[] = []
  for (const [index, attempt] of taskAttempts.entries()) {
    const dispatch = taskDispatches[index] ?? null
    if (dispatch === null) {
      gaps.push({
        field: `proposalHistory[${attempt.dispatchId}#${attempt.attempt}].dispatch`,
        reason: `Dispatch '${attempt.dispatchId}' no longer retains attempt ${attempt.attempt}'s envelope; only its digest, outcome and policy decision survive in the read model`,
      })
      continue
    }
    const record = toDispatch(dispatch)
    if (record.gap !== null) {
      gaps.push(record.gap)
      continue
    }
    if (record.value === null) continue
    const admission = attemptLaunchAdmission(dispatch)
    if (admission.gap !== null) {
      gaps.push(admission.gap)
      continue
    }
    if (admission.value === null) continue
    const approval = Object.values(state.approvals)
      .filter((candidate) => candidate.dispatchId === dispatch.dispatchId && candidate.envelopeDigest === attempt.envelopeDigest)
      .sort((left, right) => byText(left.decidedAt, right.decidedAt))
      .at(-1)
    proposalChain.push({
      // A kernel revision is an immutable `(dispatchId, attempt)` envelope, and
      // `attempt` is monotonic per task, so the attempt IS the revision.
      draftRevision: attempt.attempt,
      dispatch: record.value,
      ...(approval === undefined ? {} : { approval: toApproval(approval) }),
      launchAdmission: admission.value,
    })
  }

  const currentProposal = proposalChain.at(-1) ?? null
  const proposalHistory = proposalChain.slice(0, -1)

  // --- Draft ---
  let draft: DraftSnapshot | null = null
  if (currentTask === null) {
    gaps.push({
      field: "draft",
      reason: "No 'task.created' event was observed for this run, so there is no draft to describe",
    })
  } else if (current === null) {
    gaps.push({
      field: "draft",
      reason: "No 'dispatch.proposed' event was observed, so no prompt, timeout or policy decision exists to describe the draft",
    })
  } else {
    const fields: DraftFields = {
      goal: state.run.goal ?? "",
      taskTitle: currentTask.title,
      taskDescription: currentTask.description,
      prompt: current.envelope?.prompt ?? "",
      timeoutSeconds: current.envelope?.timeoutSeconds ?? 0,
      ...(current.envelope?.model === undefined ? {} : { model: current.envelope.model }),
    }
    if (state.run.goal === undefined) {
      gaps.push({ field: "draft.fields.goal", reason: "No 'run.created' event recorded a goal" })
    }
    if (current.envelope?.model === undefined) {
      gaps.push({
        field: "draft.fields.model",
        reason: `The envelope for dispatch '${current.dispatchId}' records no model, so the draft's model cannot be shown`,
      })
    }
    const policy = current.policy
    if (policy.decision === null) {
      gaps.push({
        field: "draft.proposalRequired",
        reason: policy.reason ?? "No policy decision is available for the current dispatch",
      })
    }
    draft = {
      projectId: state.run.projectId,
      runId: state.run.runId,
      taskId: currentTask.taskId,
      revision: taskAttempts.reduce((highest, attempt) => Math.max(highest, attempt.attempt), 0),
      fields,
      proposalRequired: policy.decision === "require_approval",
    }
  }

  // --- Control records ---
  const control = toControlRecord(state.run.cancellation)
  if (control.gap !== null) gaps.push(control.gap)

  const admission = toLaunchAdmission(state.run.launchAdmission)
  if (admission.gap !== null) gaps.push(admission.gap)

  // --- Session ---
  // The session of the CURRENT attempt, named by the attempt record itself, so a
  // finished earlier attempt's session can never be presented as the live one.
  const currentAttempt = taskAttempts.at(-1) ?? null
  const currentSession = currentAttempt?.sessionId === null || currentAttempt?.sessionId === undefined
    ? undefined
    : state.sessions[currentAttempt.sessionId]
  let session: Session | null = null
  if (currentSession !== undefined) {
    const record = toSession(currentSession)
    if (record.gap !== null) gaps.push(record.gap)
    session = record.value
  }

  // --- Fields the event log genuinely cannot supply ---
  if (isRunTerminal(state.run.lifecycleState)) {
    gaps.push({
      field: "result",
      reason:
        "No orchestration event records an agent result; only the 'dispatch.finished' summary is in the log, and the TUI's result evidence has no event source",
    })
  }
  if (
    currentSession !== undefined &&
    currentSession.observedState === "blocked" &&
    !isSessionTerminal(currentSession.state) &&
    !isRunTerminal(state.run.lifecycleState)
  ) {
    gaps.push({
      field: "pendingRequest",
      reason:
        "A live runtime permission request is not an orchestration event; the event log records only the resulting session observation",
    })
  }

  // `draft` and `cancellation` are REQUIRED members of `RunSnapshot`, so a gap
  // in either makes the whole snapshot unrepresentable rather than partial.
  if (draft === null || control.value === null) {
    return { snapshot: null, gaps }
  }

  return {
    snapshot: {
      ...(run.value === null ? {} : { run: run.value }),
      ...(task.value === null ? {} : { task: task.value }),
      draft,
      ...(currentProposal === null ? {} : { currentProposal }),
      proposalHistory,
      ...(session === null ? {} : { session }),
      cancellation: control.value,
    },
    gaps,
  }
}

import type {
  ApprovalId,
  ArtifactId,
  CommandId,
  Digest,
  DispatchId,
  Epoch,
  InstallationId,
  LeaseId,
  NodeId,
  ProjectId,
  RunId,
  SessionId,
  TaskId,
  TerminalId,
  Timestamp,
} from "../identifiers.js"
import type {
  Actor,
  Approval,
  Artifact,
  DispatchEnvelope,
  ExternalReference,
  TaskDependency,
} from "../types.js"
import type { PolicyDecision, PolicyDenial, PolicyEvaluation } from "../policy/types.js"
import type {
  ApprovalState,
  DispatchState,
  RunState,
  SessionObservedState,
  SessionState,
  TaskState,
} from "../transitions.js"

// The projection's `state` fields carry the kernel lifecycle. The extra members
// are DERIVED, read-model conveniences the scheduler/TUI consume (a task blocked
// by unsatisfied dependencies, a dispatch queued for a slot, a run held paused) —
// none of them are ever persisted, and none of them bypass the lifecycle machine
// to be written. A session's provider vocabulary lives in `SessionProjection
// .observedState`, never in `.state`.
export type ProjectionRunState = RunState | "paused"
export type ProjectionTaskState = TaskState | "blocked"
export type ProjectionDispatchState = DispatchState | "queued"
export type ProjectionSessionState = SessionState

/**
 * How far the run's most recent dispatch proposal has got towards a launch,
 * derived from the events that exist.
 *
 * The event log records exactly one launch outcome — `dispatch.started`, which
 * carries the session — and one authorization to launch — `approval.decided`
 * with an `approved` decision. The `unknown`/`failed` members of the TUI's
 * `LaunchAdmission` describe the OUTCOME OF A LAUNCH COMMAND the runtime
 * never acknowledged; the kernel has no such event, so deriving them here
 * would invent a source of truth. They are reported as gaps by
 * `tui-adapter.ts` instead.
 */
export type ProjectionLaunchAdmission =
  | { readonly state: "not-requested"; readonly reason: string }
  | {
      readonly state: "pending"
      readonly dispatchId: DispatchId
      readonly approvalId: ApprovalId | null
      readonly commandId: CommandId | null
    }
  | {
      readonly state: "started"
      readonly dispatchId: DispatchId
      readonly approvalId: ApprovalId | null
      readonly commandId: CommandId | null
      readonly sessionId: SessionId
    }

/**
 * Run-scoped cancellation, derived from `run.cancelled` (a recorded controller
 * decision) and `dispatch.cancel.requested` (a recorded request whose runtime
 * termination outcome has not necessarily been observed yet).
 *
 * As with {@link ProjectionLaunchAdmission}, the `unknown`/`failed` control
 * states have no event source and are never produced.
 */
export type ProjectionCancellation =
  | { readonly state: "none" }
  | { readonly state: "pending"; readonly commandId: CommandId | null; readonly dispatchIds: readonly DispatchId[] }
  | { readonly state: "confirmed"; readonly commandId: CommandId | null; readonly reason: string }

export interface RunProjection {
  readonly runId: RunId
  readonly projectId: ProjectId
  /** Kernel lifecycle from `../transitions.ts`. Never the derived `paused`. */
  readonly lifecycleState: RunState
  readonly state: ProjectionRunState
  readonly paused: boolean
  readonly controllerNodeId: NodeId | null
  readonly controllerEpoch: Epoch
  readonly activeLeaseId: LeaseId | null
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
  readonly completedAt: Timestamp | null
  readonly goal?: string
  readonly externalReferences?: readonly ExternalReference[]
  readonly launchAdmission: ProjectionLaunchAdmission
  readonly cancellation: ProjectionCancellation
}

/**
 * One `(dispatchId, attempt)` pair as the attempt history saw it.
 *
 * `dispatches` is keyed by `dispatchId` alone and therefore holds only the
 * CURRENT attempt of a dispatch id, while the event store's
 * `(runId, dispatchId, attempt)` tombstone explicitly allows the same dispatch
 * id to be proposed again at a higher attempt. This record is the append-only
 * history that survives that: a retry ADDS a record and never rewrites the one
 * before it, which is what "a retry adds a dispatch attempt; it does not erase
 * failure history" means in a read model.
 */
export interface DispatchAttemptProjection {
  readonly dispatchId: DispatchId
  readonly attempt: number
  readonly state: ProjectionDispatchState
  readonly outcome: DispatchProjection["outcome"]
  readonly summary: string | null
  readonly sessionId: SessionId | null
  readonly approvalId: ApprovalId | null
  /**
   * The envelope digest this attempt was proposed with. Retained per attempt so
   * an audit view can still name the exact envelope a decision was taken
   * against after the dispatch id has been proposed again at a higher attempt.
   */
  readonly envelopeDigest: Digest
  readonly policyDecision: PolicyDecision | null
  readonly policyDecisionDigest: Digest | null
  readonly proposedAt: Timestamp
  readonly startedAt: Timestamp | null
  readonly finishedAt: Timestamp | null
}

export interface TaskProjection {
  readonly taskId: TaskId
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly title: string
  readonly description: string
  /** Kernel lifecycle from `../transitions.ts`. Never the derived `blocked`. */
  readonly lifecycleState: TaskState
  readonly state: ProjectionTaskState
  readonly dependencies: readonly TaskDependency[]
  readonly failurePolicy: "block" | "fail" | null
  readonly externalReferences: readonly ExternalReference[]
  readonly currentDispatchId: DispatchId | null
  readonly dispatchAttempts: number
  /** Append-only, oldest first. One record per `(dispatchId, attempt)`. */
  readonly attemptHistory: readonly DispatchAttemptProjection[]
  /**
   * Whether a failed task is still eligible for another attempt. A `failed`
   * attempt does NOT by itself end the run: the plan states that a retry adds a
   * dispatch attempt rather than erasing failure history, so a task that failed
   * but can be retried must not drive the run terminal. This is tracked
   * explicitly rather than inferred from `dispatchAttempts`, because "how many
   * attempts so far" and "may it be attempted again" are different questions.
   */
  readonly retryable: boolean
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

/**
 * The policy decision in force for a dispatch envelope, as the read model
 * retains it.
 *
 * `approval.decided` carries only the approval record — the `approvalSchema` is
 * strict and has no policy field — so the evaluation is DERIVED by replaying
 * `evaluatePolicy` over the immutable envelope snapshot that `dispatch.proposed`
 * recorded. That is why this is sound: the envelope is the whole input, the
 * engine is pure, and the same events always yield the same decision. It is
 * also why a `deny` with its denials and a `require_approval` with its
 * outstanding approvals are renderable, rather than a placeholder.
 */
export interface DispatchPolicyProjection {
  readonly status: "evaluated" | "unavailable"
  readonly decision: PolicyDecision | null
  readonly decisionDigest: Digest | null
  /** Human-readable rendering of the full explanation tree. */
  readonly explanationText: string | null
  readonly outstandingApprovals: readonly string[]
  readonly denials: readonly PolicyDenial[]
  readonly declaredTimeoutSeconds: number | null
  readonly effectiveTimeoutSeconds: number | null
  readonly roleId: string | null
  readonly roleVersion: number | null
  /** Why no decision is available, when `status` is `unavailable`. */
  readonly reason: string | null
}

export interface DispatchProjection {
  readonly dispatchId: DispatchId
  readonly taskId: TaskId
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly envelopeDigest: Digest
  readonly envelope: DispatchEnvelope
  /** Kernel lifecycle from `../transitions.ts`. Never the derived `queued`. */
  readonly lifecycleState: DispatchState
  readonly state: ProjectionDispatchState
  readonly approvalId: ApprovalId | null
  readonly sessionId: SessionId | null
  readonly attempt: number
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
  readonly outcome: "completed" | "failed" | "timed_out" | "cancelled" | null
  readonly summary: string | null
  readonly externalReferences: readonly ExternalReference[]
  readonly policy: DispatchPolicyProjection
  /** The `approval.decided` event's `commandId`, when it carried one. */
  readonly approvalCommandId: CommandId | null
  /** The `dispatch.started` event's `commandId`, when it carried one. */
  readonly startCommandId: CommandId | null
  /** When `dispatch.started` was observed. The only evidence of a launch. */
  readonly startedAt: Timestamp | null
  /**
   * A cancel/timeout REQUEST has been recorded but the runtime termination
   * outcome has not yet been observed. Derived from the request events, never
   * a lifecycle state: the dispatch stays `running` until a `dispatch.finished`
   * says otherwise.
   */
  readonly cancelRequested: boolean
  readonly timeoutRequested: boolean
}

export interface ApprovalProjection {
  readonly approvalId: ApprovalId
  readonly dispatchId: DispatchId
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly decision: "approved" | "rejected"
  /**
   * Durable approval lifecycle, mirroring the machine in `../transitions.js`.
   * `decision` is what the actor chose; `state` is whether that choice still
   * binds. An approval whose envelope was mutated after the decision moves to
   * `invalidated` and can never again authorize the dispatch.
   */
  readonly state: ApprovalState
  readonly envelopeDigest: Digest
  readonly actor: Actor
  /**
   * The basis the decision was taken on. Retained so the reducer can rebuild a
   * full `Approval` record and re-verify it against a later envelope without
   * inventing a basis.
   */
  readonly basis: Approval["basis"]
  /**
   * The full policy evaluation the decision was taken against, or `null` when
   * no envelope was available to evaluate. This is what `policyResultOf()` in
   * `../policy/approval.js` reads; it was previously always `{ basis }`, which
   * the function correctly refuses as an evaluation, so an audit view had
   * nothing to show.
   */
  readonly policyResult: PolicyEvaluation | null
  readonly decidedAt: Timestamp
  /** Recorded only when `state` is `invalidated`, so an audit view can say why. */
  readonly invalidatedReason?: string
}

export interface SessionProjection {
  readonly sessionId: SessionId
  readonly dispatchId: DispatchId
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly state: ProjectionSessionState
  /**
   * What the provider last reported, kept separate from the kernel lifecycle in
   * `state`. Retaining both means a `blocked`/`unknown` provider report is
   * auditable without ever having masqueraded as a lifecycle state.
   */
  readonly observedState: SessionObservedState
  /**
   * The remaining `sessionSchema` identity fields, retained so a read model can
   * rebuild the exact `Session` record the `dispatch.started` / `session.observed`
   * event carried. They are in the event payload; keeping only a subset is what
   * previously made the record unreconstructable.
   */
  readonly taskId: TaskId | null
  readonly nodeId: NodeId | null
  readonly installationId: InstallationId | null
  readonly runtimeKind: string | null
  readonly terminalId: TerminalId | null
  readonly adapterMetadata: Record<string, unknown> | null
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
  readonly outcome: string | null
}

export interface ArtifactProjection {
  readonly artifactId: ArtifactId
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly dispatchId: DispatchId
  readonly sessionId: SessionId | null
  readonly name: string
  readonly mediaType: string
  readonly digest: Digest
  readonly byteCount: number
  readonly source: Artifact["source"]
  readonly location: Artifact["location"]
  readonly createdAt: Timestamp
}

export interface RunProjectionState {
  readonly run: RunProjection
  readonly tasks: Record<string, TaskProjection>
  readonly dispatches: Record<string, DispatchProjection>
  readonly approvals: Record<string, ApprovalProjection>
  readonly sessions: Record<string, SessionProjection>
  readonly artifacts: Record<string, ArtifactProjection>
  readonly lastAppliedSequence: number
  readonly lastAppliedPosition?: number
  readonly stateDigest: Digest
}

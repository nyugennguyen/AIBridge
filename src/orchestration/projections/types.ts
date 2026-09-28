import type {
  ApprovalId,
  ArtifactId,
  Digest,
  DispatchId,
  Epoch,
  LeaseId,
  NodeId,
  ProjectId,
  RunId,
  SessionId,
  TaskId,
  Timestamp,
} from "../identifiers.js"
import type {
  Actor,
  Artifact,
  DispatchEnvelope,
  ExternalReference,
  TaskDependency,
} from "../types.js"
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

export interface RunProjection {
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly state: ProjectionRunState
  readonly controllerNodeId: NodeId | null
  readonly controllerEpoch: Epoch
  readonly activeLeaseId: LeaseId | null
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
  readonly completedAt: Timestamp | null
  readonly goal?: string
  readonly externalReferences?: readonly ExternalReference[]
}

export interface TaskProjection {
  readonly taskId: TaskId
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly title: string
  readonly description: string
  readonly state: ProjectionTaskState
  readonly dependencies: readonly TaskDependency[]
  readonly failurePolicy: "block" | "fail" | null
  readonly currentDispatchId: DispatchId | null
  readonly dispatchAttempts: number
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export interface DispatchProjection {
  readonly dispatchId: DispatchId
  readonly taskId: TaskId
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly envelopeDigest: Digest
  readonly envelope: DispatchEnvelope
  readonly state: ProjectionDispatchState
  readonly approvalId: ApprovalId | null
  readonly sessionId: SessionId | null
  readonly attempt: number
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
  readonly outcome: "completed" | "failed" | "timed_out" | "cancelled" | null
  readonly summary: string | null
}

export interface ApprovalProjection {
  readonly approvalId: ApprovalId
  readonly dispatchId: DispatchId
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly decision: "approved" | "rejected"
  readonly envelopeDigest: Digest
  readonly actor: Actor
  readonly policyResult: unknown
  readonly decidedAt: Timestamp
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

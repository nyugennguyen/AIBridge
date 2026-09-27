import type { ContractError, Result } from "../orchestration/errors.js"
import type {
  ApprovalId,
  CommandId,
  CorrelationId,
  Digest,
  DispatchId,
  InstallationId,
  LeaseId,
  NodeId,
  ProjectId,
  ProjectPathId,
  RunId,
  SessionId,
  TaskId,
  TerminalClientId,
  TerminalId,
  Timestamp,
  UserId,
} from "../orchestration/identifiers.js"
import type {
  Approval,
  ContextManifest,
  Dispatch,
  OrchestrationEvent,
  PermissionEnvelope,
  Project,
  RoleTemplate,
  Rule,
  Run,
  Session,
  Task,
} from "../orchestration/types.js"
import type { AgentInstallation, AgentResult, NodeContext } from "../runtime/types.js"

export interface ApplicationClock {
  now(): string
}

export interface ApplicationIdSource {
  next(kind: string): string
}

export interface LocalControllerAuthority {
  readonly controllerNodeId: NodeId
  readonly controllerEpoch: number
  readonly leaseId: LeaseId
}

/**
 * Canonical, already-authorized inputs used to build a local proposal. The
 * application service validates this value again; merely returning it does
 * not authorize an external effect.
 */
export interface LocalProjectDefinition {
  readonly project: Project
  readonly projectPathId: ProjectPathId
  readonly nodeContext: NodeContext
  readonly installation: AgentInstallation
  readonly roleSnapshot: RoleTemplate
  readonly ruleSnapshots: readonly Rule[]
  readonly contextManifest: ContextManifest
  readonly requestedCapabilities: readonly string[]
  readonly permissionEnvelope: PermissionEnvelope
  readonly availableModels: readonly string[]
  readonly controller: LocalControllerAuthority
}

export interface LaunchPathAuthorization {
  readonly projectId: ProjectId
  readonly projectPathId: ProjectPathId
  readonly nodeId: NodeId
  readonly configuredPath: string
  /** The filesystem-resolved path checked against the worker's allowlist. */
  readonly realPath: string
}

export interface LaunchPathAuthorizationRequest {
  readonly projectId: ProjectId
  readonly projectPathId: ProjectPathId
  readonly nodeId: NodeId
  readonly configuredPath: string
}

/**
 * Project discovery and the worker-side launch authorization boundary.
 * `authorizeLaunchPath` must perform a fresh realpath/allowlist check each
 * time it is called and must fail closed if resolution is unavailable.
 */
export interface LocalProjectRegistry {
  listAuthorizedProjects(): Promise<Result<readonly LocalProjectDefinition[]>>
  getAuthorizedProject(projectId: ProjectId): Promise<Result<LocalProjectDefinition>>
  authorizeLaunchPath(request: LaunchPathAuthorizationRequest): Promise<Result<LaunchPathAuthorization>>
}

export interface ProjectSummary {
  readonly projectId: ProjectId
  readonly name: string
  readonly projectPathId: ProjectPathId
  readonly pathLabel: string
  readonly nodeId: NodeId
  readonly installationId: InstallationId
  readonly runtimeKind: string
  readonly runtimeName: string
  readonly availableModels: readonly string[]
}

export interface ProjectSelection {
  readonly project: ProjectSummary
}

export interface DraftFields {
  readonly goal: string
  readonly taskTitle: string
  readonly taskDescription: string
  readonly prompt: string
  readonly model?: string
  readonly timeoutSeconds: number
}

export type DraftPatch = Partial<DraftFields>

export interface DraftSnapshot {
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly taskId: TaskId
  readonly revision: number
  readonly fields: DraftFields
  readonly proposalRequired: boolean
}

export type LaunchAdmission =
  | { readonly state: "not-requested" }
  | { readonly state: "pending"; readonly commandId: CommandId }
  | { readonly state: "started"; readonly commandId: CommandId; readonly sessionId: SessionId }
  | { readonly state: "unknown"; readonly commandId: CommandId; readonly error: ContractError }
  | { readonly state: "failed"; readonly commandId: CommandId; readonly error: ContractError }

export type ControlRecord =
  | { readonly state: "none" }
  | { readonly state: "pending"; readonly commandId: CommandId }
  | { readonly state: "confirmed"; readonly commandId: CommandId }
  | { readonly state: "unknown"; readonly commandId: CommandId; readonly error: ContractError }
  | { readonly state: "failed"; readonly commandId: CommandId; readonly error: ContractError }

export interface ProposalSnapshot {
  readonly draftRevision: number
  readonly dispatch: Dispatch
  readonly approval?: Approval
  readonly launchAdmission: LaunchAdmission
}

export interface RunSnapshot {
  readonly run?: Run
  readonly task?: Task
  readonly draft: DraftSnapshot
  readonly currentProposal?: ProposalSnapshot
  readonly proposalHistory: readonly ProposalSnapshot[]
  readonly session?: Session
  readonly result?: AgentResult
  readonly cancellation: ControlRecord
  readonly pendingRequest?: { readonly requestId: string; readonly permission: string }
}

export type LaunchOutcome =
  | { readonly outcome: "started"; readonly snapshot: RunSnapshot }
  | { readonly outcome: "unknown"; readonly snapshot: RunSnapshot; readonly error: ContractError }
  | { readonly outcome: "failed"; readonly snapshot: RunSnapshot; readonly error: ContractError }

export type ControlOutcome =
  | { readonly outcome: "confirmed"; readonly snapshot: RunSnapshot }
  | { readonly outcome: "unknown"; readonly snapshot: RunSnapshot; readonly error: ContractError }
  | { readonly outcome: "failed"; readonly snapshot: RunSnapshot; readonly error: ContractError }

export interface ResultSnapshot {
  readonly snapshot: RunSnapshot
  readonly result: AgentResult
}

export interface RecoverySummary {
  readonly projectId: ProjectId
  readonly projectName: string
  readonly nodeId: NodeId
  readonly sessionId: SessionId
  readonly terminalId: TerminalId
  readonly runtimeState: Session["state"]
  readonly historyAvailable: boolean
  readonly mutationAllowed: boolean
  readonly attachmentMode: "read-only"
}

export interface RecoveryList {
  readonly sessions: readonly RecoverySummary[]
  readonly quarantinedCount: number
}

interface ReadCommand {
  readonly correlationId: CorrelationId
}

interface MutationCommand extends ReadCommand {
  readonly operationId: CommandId
}

export type ApplicationCommand =
  | ({ readonly type: "projects.list" } & ReadCommand)
  | ({ readonly type: "projects.select"; readonly projectId: ProjectId } & ReadCommand)
  | ({ readonly type: "draft.create"; readonly projectId: ProjectId; readonly timeoutSeconds?: number } & MutationCommand)
  | ({ readonly type: "draft.edit"; readonly runId: RunId; readonly expectedRevision: number; readonly patch: DraftPatch } & MutationCommand)
  | ({ readonly type: "proposal.create"; readonly runId: RunId; readonly expectedRevision: number } & MutationCommand)
  | ({ readonly type: "proposal.begin-revision"; readonly runId: RunId; readonly dispatchId: DispatchId; readonly envelopeDigest: Digest } & MutationCommand)
  | ({ readonly type: "proposal.revise"; readonly runId: RunId; readonly dispatchId: DispatchId; readonly envelopeDigest: Digest; readonly patch: DraftPatch } & MutationCommand)
  | ({
      readonly type: "proposal.decide"
      readonly runId: RunId
      readonly dispatchId: DispatchId
      readonly attempt: number
      readonly envelopeDigest: Digest
      readonly decision: "approved" | "rejected"
      readonly userId: UserId
    } & MutationCommand)
  | ({ readonly type: "run.get"; readonly runId: RunId } & ReadCommand)
  | ({
      readonly type: "dispatch.launch"
      readonly runId: RunId
      readonly dispatchId: DispatchId
      readonly envelopeDigest: Digest
      readonly approvalId: ApprovalId
    } & MutationCommand)
  | ({ readonly type: "run.cancel"; readonly runId: RunId; readonly reason: string } & MutationCommand)
  | ({ readonly type: "session.refresh"; readonly runId: RunId } & MutationCommand)
  | ({ readonly type: "session.respond"; readonly runId: RunId; readonly requestId: string; readonly decision: "allow_once" | "allow_always" | "deny"; readonly reason?: string } & MutationCommand)
  | ({ readonly type: "session.interrupt"; readonly runId: RunId; readonly reason: string } & MutationCommand)
  | ({ readonly type: "session.terminate"; readonly runId: RunId; readonly reason: string } & MutationCommand)
  | ({ readonly type: "result.get"; readonly runId: RunId } & MutationCommand)
  | ({ readonly type: "sessions.recover"; readonly clientId: TerminalClientId } & MutationCommand)

export type ApplicationCommandResult<C extends ApplicationCommand> = Promise<
  C extends { type: "projects.list" }
    ? Result<readonly ProjectSummary[]>
    : C extends { type: "projects.select" }
      ? Result<ProjectSelection>
      : C extends { type: "draft.create" | "draft.edit" }
        ? Result<DraftSnapshot>
        : C extends { type: "proposal.create" | "proposal.begin-revision" | "proposal.revise" | "proposal.decide" | "run.get" | "session.refresh" }
          ? Result<RunSnapshot>
          : C extends { type: "dispatch.launch" }
            ? Result<LaunchOutcome>
            : C extends { type: "run.cancel" | "session.respond" | "session.interrupt" | "session.terminate" }
              ? Result<ControlOutcome>
              : C extends { type: "result.get" }
                ? Result<ResultSnapshot>
                : C extends { type: "sessions.recover" }
                  ? Result<RecoveryList>
                  : never
>

export interface LocalApplicationService {
  execute<C extends ApplicationCommand>(command: C): ApplicationCommandResult<C>
  /** Test/diagnostic read; returned events are validated canonical M0 events. */
  events(runId: RunId): readonly OrchestrationEvent[]
}

export interface LocalApplicationDependencies {
  readonly runtime: import("../runtime/types.js").AgentRuntimeAdapter
  readonly terminal: import("../terminal/types.js").TerminalBackend
  readonly clock: ApplicationClock
  readonly ids: ApplicationIdSource
  readonly projects: LocalProjectRegistry
}

export interface InternalRunIdentity {
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly taskId: TaskId
  readonly projectPathId: ProjectPathId
  readonly nodeId: NodeId
}

export type { ContractError, Result, Timestamp }

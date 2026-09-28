import { resolve } from "node:path"
import { digestDispatchEnvelope, digestJson } from "../orchestration/digest.js"
import { contractErrorSchema, type ContractError, type Result } from "../orchestration/errors.js"
import {
  approvalIdSchema,
  dispatchIdSchema,
  eventIdSchema,
  runIdSchema,
  taskIdSchema,
  terminalClientIdSchema,
  terminalIdSchema,
  timestampSchema,
  userIdSchema,
  type CommandId,
  type CorrelationId,
  type ProjectId,
  type RunId,
} from "../orchestration/identifiers.js"
import {
  approvalSchema,
  contextManifestSchema,
  dispatchEnvelopeSchema,
  dispatchSchema,
  orchestrationEventSchema,
  permissionEnvelopeSchema,
  projectSchema,
  roleTemplateSchema,
  ruleSchema,
  runSchema,
  sessionSchema,
  taskSchema,
} from "../orchestration/schemas.js"
import type {
  Approval,
  Dispatch,
  OrchestrationEvent,
  Run,
  Session,
  SessionObservedState,
  Task,
} from "../orchestration/types.js"
import { advanceSessionLifecycle } from "../orchestration/transitions.js"
import {
  agentInstallationSchema,
  agentResponseSchema,
  agentResultSchema,
  agentRuntimeEventSchema,
  launchAgentRequestSchema,
  nodeContextSchema,
  runtimeOperationContextSchema,
  type AgentResult,
} from "../runtime/schemas.js"
import { createTerminalRequestSchema, terminalOperationContextSchema, terminalReferenceSchema } from "../terminal/schemas.js"
import type {
  ApplicationCommand,
  ApplicationCommandResult,
  ControlOutcome,
  ControlRecord,
  DraftFields,
  DraftPatch,
  DraftSnapshot,
  LaunchAdmission,
  LaunchOutcome,
  LaunchPathAuthorizationRequest,
  LocalApplicationDependencies,
  LocalApplicationService,
  LocalProjectDefinition,
  ProjectSelection,
  ProjectSummary,
  ProposalSnapshot,
  RecoveryList,
  RecoverySummary,
  ResultSnapshot,
  RunSnapshot,
} from "./types.js"

const DEFAULT_TIMEOUT_SECONDS = 3_600
const MAX_TIMEOUT_SECONDS = 86_400
const EVENT_SUMMARY_MAX = 4_096

interface InternalProposal {
  draftRevision: number
  dispatch: Dispatch
  approval?: Approval
  launchAdmission: LaunchAdmission
}

interface InternalRun {
  definition: LocalProjectDefinition
  draft: DraftSnapshot
  run?: Run
  task?: Task
  proposals: InternalProposal[]
  session?: Session
  result?: AgentResult
  pendingRequest?: { requestId: string; permission: string }
  cancellation: ControlRecord
  events: OrchestrationEvent[]
  sequence: number
}

interface Receipt {
  fingerprint: string
  result: Promise<Result<unknown>>
}

function success<T>(value: T): Result<T> {
  return { ok: true, value }
}

function failure(
  category: ContractError["category"],
  code: string,
  message: string,
  correlationId?: CorrelationId,
): Result<never> {
  return {
    ok: false,
    error: contractErrorSchema.parse({
      schemaVersion: 1,
      category,
      code,
      message,
      retryable: ["transient_transport", "timeout", "runtime_failure", "internal_failure"].includes(category),
      ...(correlationId ? { correlationId } : {}),
    }),
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function serializedFingerprint(value: unknown): string {
  return digestJson(JSON.parse(JSON.stringify(value)))
}

function normalizeThrown(correlationId: CorrelationId, code: string, message: string): ContractError {
  const result = failure("internal_failure", code, message, correlationId)
  if (result.ok) throw new Error("unreachable")
  return result.error
}

function uncertainCategory(error: ContractError): boolean {
  return ["transient_transport", "timeout", "internal_failure"].includes(error.category)
}

/**
 * M1's single-process projection. It deliberately does not claim restart-safe
 * authority or effect receipts; recovered sessions without this live history
 * are exposed as read-only/inspect-only summaries.
 */
export class InMemoryLocalApplicationService implements LocalApplicationService {
  readonly #deps: LocalApplicationDependencies
  readonly #runs = new Map<RunId, InternalRun>()
  readonly #receipts = new Map<CommandId, Receipt>()
  #selectedProjectId?: ProjectId
  #mutationTail: Promise<void> = Promise.resolve()

  constructor(dependencies: LocalApplicationDependencies) {
    this.#deps = dependencies
  }

  execute<C extends ApplicationCommand>(command: C): ApplicationCommandResult<C> {
    const result = command.type === "projects.list" || command.type === "projects.select" || command.type === "run.get"
      ? this.#handle(command)
      : this.#mutate(command)
    return result as ApplicationCommandResult<C>
  }

  events(runId: RunId): readonly OrchestrationEvent[] {
    return clone(this.#runs.get(runId)?.events ?? [])
  }

  #mutate(command: Exclude<ApplicationCommand, { type: "projects.list" | "projects.select" | "run.get" }>): Promise<Result<unknown>> {
    let fingerprint: string
    try {
      fingerprint = serializedFingerprint(command)
    } catch {
      return Promise.resolve(failure("validation", "application.command.invalid", "The application command is not valid.", command.correlationId))
    }

    const existing = this.#receipts.get(command.operationId)
    if (existing) {
      return existing.fingerprint === fingerprint
        ? existing.result
        : Promise.resolve(failure("conflict", "application.command.id_reused", "The operation ID was already used with different content.", command.correlationId))
    }

    const result = this.#mutationTail.then(() => this.#handle(command)).catch(() =>
      failure("internal_failure", "application.command.failed", "The application operation failed safely.", command.correlationId),
    )
    this.#receipts.set(command.operationId, { fingerprint, result })
    this.#mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  async #handle(command: ApplicationCommand): Promise<Result<unknown>> {
    switch (command.type) {
      case "projects.list":
        return this.#listProjects(command.correlationId)
      case "projects.select":
        return this.#selectProject(command.projectId, command.correlationId)
      case "draft.create":
        return this.#createDraft(command)
      case "draft.edit":
        return this.#editDraft(command)
      case "proposal.create":
        return this.#createProposalCommand(command)
      case "proposal.begin-revision":
        return this.#beginProposalRevision(command)
      case "proposal.revise":
        return this.#reviseProposal(command)
      case "proposal.decide":
        return this.#decideProposal(command)
      case "run.get":
        return this.#getRun(command.runId, command.correlationId)
      case "dispatch.launch":
        return this.#launch(command)
      case "run.cancel":
        return this.#cancel(command)
      case "session.refresh":
        return this.#refresh(command)
      case "session.respond":
        return this.#respond(command)
      case "session.interrupt":
        return this.#control(command, "interrupt")
      case "session.terminate":
        return this.#control(command, "terminate")
      case "result.get":
        return this.#getResult(command)
      case "sessions.recover":
        return this.#recover(command)
    }
  }

  async #listProjects(correlationId: CorrelationId): Promise<Result<readonly ProjectSummary[]>> {
    const listed = await this.#safeRegistryCall(
      () => this.#deps.projects.listAuthorizedProjects(),
      correlationId,
      "application.projects.list_failed",
    )
    if (!listed.ok) return listed
    const summaries: ProjectSummary[] = []
    for (const definition of listed.value) {
      const checked = this.#validateDefinition(definition, correlationId)
      if (!checked.ok) return checked
      summaries.push(this.#projectSummary(checked.value))
    }
    summaries.sort((left, right) => left.name.localeCompare(right.name) || left.projectId.localeCompare(right.projectId))
    return success(clone(summaries))
  }

  async #selectProject(projectId: ProjectId, correlationId: CorrelationId): Promise<Result<ProjectSelection>> {
    const definition = await this.#getDefinition(projectId, correlationId)
    if (!definition.ok) return definition
    this.#selectedProjectId = projectId
    return success({ project: clone(this.#projectSummary(definition.value)) })
  }

  async #createDraft(command: Extract<ApplicationCommand, { type: "draft.create" }>): Promise<Result<DraftSnapshot>> {
    if (this.#selectedProjectId !== command.projectId) {
      return failure("conflict", "application.project.not_selected", "Select this project before creating a run.", command.correlationId)
    }
    const definition = await this.#getDefinition(command.projectId, command.correlationId)
    if (!definition.ok) return definition
    const timeoutSeconds = command.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      return failure("validation", "application.draft.timeout", "Timeout must be a whole number from 1 to 86400 seconds.", command.correlationId)
    }

    try {
      const runId = runIdSchema.parse(this.#deps.ids.next("run"))
      const taskId = taskIdSchema.parse(this.#deps.ids.next("task"))
      const draft: DraftSnapshot = {
        projectId: command.projectId,
        runId,
        taskId,
        revision: 1,
        fields: {
          goal: "",
          taskTitle: "",
          taskDescription: "",
          prompt: "",
          timeoutSeconds,
        },
        proposalRequired: true,
      }
      this.#runs.set(runId, {
        definition: definition.value,
        draft,
        proposals: [],
        cancellation: { state: "none" },
        events: [],
        sequence: 0,
      })
      return success(clone(draft))
    } catch {
      return failure("internal_failure", "application.identity.invalid", "The local identity source returned an invalid identifier.", command.correlationId)
    }
  }

  async #editDraft(command: Extract<ApplicationCommand, { type: "draft.edit" }>): Promise<Result<DraftSnapshot>> {
    const record = this.#runs.get(command.runId)
    if (!record) return failure("validation", "application.run.unknown", "The selected run is not available.", command.correlationId)
    if (record.proposals.length > 0) {
      return failure("conflict", "application.draft.proposal_exists", "Revise the current proposal instead of editing its historical draft.", command.correlationId)
    }
    if (record.draft.revision !== command.expectedRevision) {
      return failure("conflict", "application.draft.stale_revision", "The draft changed; refresh it before editing.", command.correlationId)
    }
    const patched = this.#applyPatch(record.draft.fields, command.patch, command.correlationId, false)
    if (!patched.ok) return patched
    if (serializedFingerprint(patched.value) === serializedFingerprint(record.draft.fields)) {
      return failure("validation", "application.draft.no_change", "The edit does not change any draft field.", command.correlationId)
    }
    record.draft = { ...record.draft, revision: record.draft.revision + 1, fields: patched.value, proposalRequired: true }
    return success(clone(record.draft))
  }

  async #createProposalCommand(command: Extract<ApplicationCommand, { type: "proposal.create" }>): Promise<Result<RunSnapshot>> {
    const record = this.#runs.get(command.runId)
    if (!record) return failure("validation", "application.run.unknown", "The selected run is not available.", command.correlationId)
    if (record.draft.revision !== command.expectedRevision) {
      return failure("conflict", "application.draft.stale_revision", "The draft changed; review the current revision.", command.correlationId)
    }
    if (record.proposals.length > 0) {
      return failure("conflict", "application.proposal.already_exists", "The run already has a proposal; revise that proposal instead.", command.correlationId)
    }
    return this.#createProposal(record, 1, command.operationId, command.correlationId)
  }

  #beginProposalRevision(command: Extract<ApplicationCommand, { type: "proposal.begin-revision" }>): Result<RunSnapshot> {
    const current = this.#currentProposal(command.runId, command.dispatchId, command.envelopeDigest, command.correlationId)
    if (!current.ok) return current
    const { record, proposal } = current.value
    if (proposal.launchAdmission.state !== "not-requested") {
      return failure("conflict", "application.proposal.launch_recorded", "A launch was already attempted; create a new run to retry safely.", command.correlationId)
    }

    // Preserve the historical decision for audit while removing its authority
    // before the editor is exposed. A racing stale launch is rejected below.
    record.draft = { ...record.draft, proposalRequired: true }
    return success(this.#snapshot(record))
  }

  async #reviseProposal(command: Extract<ApplicationCommand, { type: "proposal.revise" }>): Promise<Result<RunSnapshot>> {
    const recordResult = this.#currentProposal(command.runId, command.dispatchId, command.envelopeDigest, command.correlationId)
    if (!recordResult.ok) return recordResult
    const { record, proposal } = recordResult.value
    const retryingFailedAttempt = proposal.dispatch.state === "failed" &&
      proposal.launchAdmission.state !== "unknown" && proposal.launchAdmission.state !== "pending"
    if (proposal.launchAdmission.state !== "not-requested" && !retryingFailedAttempt) {
      return failure("conflict", "application.proposal.launch_recorded", "A launch was already attempted; create a new run to retry safely.", command.correlationId)
    }
    const fields = this.#applyPatch(record.draft.fields, command.patch, command.correlationId, true)
    if (!fields.ok) return fields
    record.draft = {
      ...record.draft,
      revision: record.draft.revision + 1,
      fields: fields.value,
      proposalRequired: true,
    }
    if (retryingFailedAttempt) {
      record.run = record.run ? runSchema.parse({ ...record.run, state: "draft", updatedAt: this.#now() }) : undefined
      record.task = record.task ? taskSchema.parse({ ...record.task, state: "ready" }) : undefined
      record.session = undefined
      record.result = undefined
    }
    return this.#createProposal(record, proposal.dispatch.envelope.attempt + 1, command.operationId, command.correlationId)
  }

  #getRun(runId: RunId, correlationId: CorrelationId): Result<RunSnapshot> {
    const record = this.#runs.get(runId)
    return record
      ? success(this.#snapshot(record))
      : failure("validation", "application.run.unknown", "The selected run is not available.", correlationId)
  }

  async #decideProposal(command: Extract<ApplicationCommand, { type: "proposal.decide" }>): Promise<Result<RunSnapshot>> {
    const current = this.#currentProposal(command.runId, command.dispatchId, command.envelopeDigest, command.correlationId)
    if (!current.ok) return current
    const { record, proposal } = current.value
    if (proposal.dispatch.envelope.attempt !== command.attempt) {
      return failure("conflict", "application.proposal.stale_attempt", "The proposal attempt changed; review the current proposal.", command.correlationId)
    }
    if (proposal.approval) {
      return failure("conflict", "application.proposal.already_decided", "This proposal already has a recorded decision.", command.correlationId)
    }
    if (proposal.dispatch.state !== "proposed") {
      return failure("conflict", "application.proposal.not_pending", "This proposal is no longer pending approval.", command.correlationId)
    }
    const currentDefinition = await this.#refreshProposalDefinition(record, proposal, command.correlationId)
    if (!currentDefinition.ok) return currentDefinition
    try {
      const approval = approvalSchema.parse({
        schemaVersion: 1,
        approvalId: approvalIdSchema.parse(this.#deps.ids.next("approval")),
        projectId: record.draft.projectId,
        runId: record.draft.runId,
        dispatchId: proposal.dispatch.envelope.dispatchId,
        envelopeDigest: proposal.dispatch.envelopeDigest,
        decision: command.decision,
        basis: { kind: "user" },
        actor: { kind: "user", userId: userIdSchema.parse(command.userId) },
        decidedAt: this.#now(),
      })
      proposal.approval = approval
      proposal.dispatch = dispatchSchema.parse({
        ...proposal.dispatch,
        state: command.decision === "approved" ? "approved" : "rejected",
      })
      this.#appendEvent(record, "approval.decided", { approval }, command.operationId, command.correlationId, approval.actor)
      return success(this.#snapshot(record))
    } catch {
      return failure("internal_failure", "application.approval.record_failed", "The approval decision could not be recorded safely.", command.correlationId)
    }
  }

  async #launch(command: Extract<ApplicationCommand, { type: "dispatch.launch" }>): Promise<Result<LaunchOutcome>> {
    const current = this.#currentProposal(command.runId, command.dispatchId, command.envelopeDigest, command.correlationId)
    if (!current.ok) return current
    const { record, proposal } = current.value
    if (record.cancellation.state !== "none" || proposal.dispatch.state === "cancelled") {
      return failure("conflict", "application.launch.cancelled", "A cancelled run cannot be launched; create a new reviewed proposal.", command.correlationId)
    }
    if (record.draft.proposalRequired) {
      return failure("approval_required", "application.launch.revision_pending", "The proposal is being revised and requires a new dispatch approval.", command.correlationId)
    }
    if (!proposal.approval || proposal.approval.decision !== "approved" || proposal.approval.approvalId !== command.approvalId) {
      return failure("approval_required", "application.launch.approval_required", "Launch requires the current proposal's exact approval.", command.correlationId)
    }
    if (proposal.approval.envelopeDigest !== proposal.dispatch.envelopeDigest) {
      return failure("approval_required", "application.launch.digest_changed", "The approval does not match the current dispatch digest.", command.correlationId)
    }
    if (proposal.launchAdmission.state !== "not-requested") {
      return failure("conflict", "application.launch.already_attempted", "Launch was already attempted and will not be replayed; refresh or reconcile the session.", command.correlationId)
    }

    const currentDefinition = await this.#refreshProposalDefinition(record, proposal, command.correlationId)
    if (!currentDefinition.ok) return currentDefinition

    const authorized = await this.#authorizeEffect(record, command.correlationId)
    if (!authorized.ok) return authorized

    proposal.launchAdmission = { state: "pending", commandId: command.operationId }
    const operation = this.#runtimeOperation(record, proposal.dispatch, command.operationId, command.correlationId)
    const request = launchAgentRequestSchema.parse({
      schemaVersion: 1,
      operation,
      dispatchEnvelope: proposal.dispatch.envelope,
      dispatchEnvelopeDigest: proposal.dispatch.envelopeDigest,
      approvalId: proposal.approval.approvalId,
    })

    let launched: Awaited<ReturnType<LocalApplicationDependencies["runtime"]["launch"]>>
    try {
      launched = await this.#deps.runtime.launch(request)
    } catch {
      const error = normalizeThrown(command.correlationId, "application.launch.outcome_unknown", "Launch outcome is unknown; reconcile without replaying the command.")
      proposal.launchAdmission = { state: "unknown", commandId: command.operationId, error }
      return success({ outcome: "unknown", snapshot: this.#snapshot(record), error })
    }

    if (!launched.ok) {
      const state = uncertainCategory(launched.error) ? "unknown" : "failed"
      proposal.launchAdmission = { state, commandId: command.operationId, error: launched.error }
      if (state === "failed") this.#markDefiniteLaunchFailure(record, proposal, launched.error.message, command.operationId, command.correlationId)
      return success({ outcome: state, snapshot: this.#snapshot(record), error: launched.error })
    }

    const checked = sessionSchema.safeParse(launched.value)
    if (!checked.success || !this.#sessionMatches(record, proposal.dispatch, checked.success ? checked.data : undefined)) {
      const error = normalizeThrown(command.correlationId, "application.launch.invalid_session", "Launch returned an invalid session binding; the outcome is unknown and will not be replayed.")
      proposal.launchAdmission = { state: "unknown", commandId: command.operationId, error }
      return success({ outcome: "unknown", snapshot: this.#snapshot(record), error })
    }

    // A session that claims to be `completed` the instant it was launched is not
    // credible evidence: we never observed it run. The observation is downgraded
    // to `unknown` (so reconciliation is required) and the lifecycle stays at
    // `launching` rather than being advanced by an unverified claim.
    let session =
      checked.data.observedState === "completed"
        ? this.#observeSession(checked.data, "unknown")
        : checked.data
    if (session.terminalId === undefined) {
      let terminalId
      try {
        terminalId = terminalIdSchema.parse(this.#deps.ids.next("terminal"))
      } catch {
        const error = normalizeThrown(command.correlationId, "application.terminal.identity_invalid", "The terminal identity could not be allocated safely.")
        proposal.launchAdmission = { state: "unknown", commandId: command.operationId, error }
        record.session = session
        return success({ outcome: "unknown", snapshot: this.#snapshot(record), error })
      }
      const terminalRequest = createTerminalRequestSchema.parse({
        schemaVersion: 1,
        operation: {
          schemaVersion: 1,
          commandId: command.operationId,
          correlationId: command.correlationId,
          projectId: record.draft.projectId,
          nodeId: record.definition.nodeContext.nodeId,
          clientId: terminalClientIdSchema.parse(`controller-${record.definition.nodeContext.nodeId}`),
          controllerAuthority: record.definition.controller,
        },
        terminalId,
        sessionId: session.sessionId,
        backendKind: this.#deps.terminal.kind,
        columns: 120,
        rows: 40,
        bufferByteLimit: 1_048_576,
      })
      let createdTerminal
      try {
        createdTerminal = await this.#deps.terminal.create(terminalRequest)
      } catch {
        createdTerminal = failure("internal_failure", "application.terminal.create_unknown", "Terminal creation outcome is unknown; reconcile without replaying launch.", command.correlationId)
      }
      if (!createdTerminal.ok) {
        proposal.launchAdmission = { state: "unknown", commandId: command.operationId, error: createdTerminal.error }
        record.session = session
        return success({ outcome: "unknown", snapshot: this.#snapshot(record), error: createdTerminal.error })
      }
      const terminal = terminalReferenceSchema.safeParse(createdTerminal.value)
      if (!terminal.success || terminal.data.sessionId !== session.sessionId || terminal.data.projectId !== session.projectId || terminal.data.nodeId !== session.nodeId) {
        const error = normalizeThrown(command.correlationId, "application.terminal.binding_invalid", "Terminal creation returned an invalid binding; reconcile without replaying launch.")
        proposal.launchAdmission = { state: "unknown", commandId: command.operationId, error }
        record.session = session
        return success({ outcome: "unknown", snapshot: this.#snapshot(record), error })
      }
      session = sessionSchema.parse({ ...session, terminalId: terminal.data.terminalId })
    }
    record.session = session
    record.run = runSchema.parse({ ...record.run, state: "active", updatedAt: this.#now() })
    record.task = taskSchema.parse({ ...record.task, state: "running" })
    proposal.dispatch = dispatchSchema.parse({ ...proposal.dispatch, state: "running" })
    proposal.launchAdmission = { state: "started", commandId: command.operationId, sessionId: session.sessionId }
    this.#appendEvent(record, "dispatch.started", { session }, command.operationId, command.correlationId)
    return success({ outcome: "started", snapshot: this.#snapshot(record) })
  }

  async #cancel(command: Extract<ApplicationCommand, { type: "run.cancel" }>): Promise<Result<ControlOutcome>> {
    const record = this.#runs.get(command.runId)
    if (!record) return failure("validation", "application.run.unknown", "The selected run is not available.", command.correlationId)
    if (!command.reason.trim()) return failure("validation", "application.cancel.reason", "A cancellation reason is required.", command.correlationId)
    if (!record.session) {
      record.run = record.run ? runSchema.parse({ ...record.run, state: "cancelled", updatedAt: this.#now() }) : undefined
      record.task = record.task ? taskSchema.parse({ ...record.task, state: "cancelled" }) : undefined
      const proposal = record.proposals.at(-1)
      if (proposal && !["rejected", "completed", "failed", "cancelled"].includes(proposal.dispatch.state)) {
        proposal.dispatch = dispatchSchema.parse({ ...proposal.dispatch, state: "cancelled" })
      }
      record.cancellation = { state: "confirmed", commandId: command.operationId }
      return success({ outcome: "confirmed", snapshot: this.#snapshot(record) })
    }
    return this.#performControl(record, command.operationId, command.correlationId, "cancel")
  }

  async #refresh(command: Extract<ApplicationCommand, { type: "session.refresh" }>): Promise<Result<RunSnapshot>> {
    const record = this.#runs.get(command.runId)
    if (!record?.session) return failure("validation", "application.session.unavailable", "The run has no active or recoverable session.", command.correlationId)
    const authorized = await this.#authorizeEffect(record, command.correlationId)
    if (!authorized.ok) return authorized
    const proposal = record.proposals.at(-1)
    if (!proposal) return failure("internal_failure", "application.proposal.missing", "The session has no dispatch proposal.", command.correlationId)
    const operation = this.#runtimeOperation(record, proposal.dispatch, command.operationId, command.correlationId)
    try {
      for await (const observed of this.#deps.runtime.observe(record.session, operation)) {
        if (!observed.ok) {
          if (uncertainCategory(observed.error)) record.session = this.#observeSession(record.session, "unknown")
          return { ok: false, error: observed.error }
        }
        const checked = agentRuntimeEventSchema.safeParse(observed.value)
        if (!checked.success || !this.#eventMatches(record, checked.success ? checked.data : undefined)) {
          return failure("internal_failure", "application.observation.invalid_scope", "The runtime returned an invalid or mismatched observation.", command.correlationId)
        }
        this.#applyRuntimeEvent(record, checked.data, command.operationId, command.correlationId)
        break
      }
      return success(this.#snapshot(record))
    } catch {
      record.session = this.#observeSession(record.session, "unknown")
      return failure("transient_transport", "application.observation.failed", "Session observation failed; refresh to reconcile without replaying effects.", command.correlationId)
    }
  }

  async #respond(command: Extract<ApplicationCommand, { type: "session.respond" }>): Promise<Result<ControlOutcome>> {
    const record = this.#runs.get(command.runId)
    if (!record?.session) return failure("validation", "application.session.unavailable", "The run has no active session.", command.correlationId)
    const proposal = record.proposals.at(-1)
    if (!proposal) return failure("internal_failure", "application.proposal.missing", "The session has no dispatch proposal.", command.correlationId)
    const authorized = await this.#authorizeEffect(record, command.correlationId)
    if (!authorized.ok) return authorized
    const operation = this.#runtimeOperation(record, proposal.dispatch, command.operationId, command.correlationId)
    let response
    try {
      response = agentResponseSchema.parse({
        schemaVersion: 1,
        operation,
        responseId: eventIdSchema.parse(command.requestId),
        kind: "permission",
        value: command.decision,
      })
    } catch {
      return failure("validation", "application.response.invalid", "The response does not identify a valid outstanding request.", command.correlationId)
    }
    try {
      const result = await this.#deps.runtime.respond(record.session, response)
      if (result.ok) {
        record.pendingRequest = undefined
        return success({ outcome: "confirmed", snapshot: this.#snapshot(record) })
      }
      return this.#controlResult(record, command.operationId, result)
    } catch {
      const error = normalizeThrown(command.correlationId, "application.response.unknown", "The response outcome is unknown; do not submit it again automatically.")
      return success({ outcome: "unknown", snapshot: this.#snapshot(record), error })
    }
  }

  async #control(
    command: Extract<ApplicationCommand, { type: "session.interrupt" | "session.terminate" }>,
    action: "interrupt" | "terminate",
  ): Promise<Result<ControlOutcome>> {
    const record = this.#runs.get(command.runId)
    if (!record?.session) return failure("validation", "application.session.unavailable", "The run has no active session.", command.correlationId)
    if (!command.reason.trim()) return failure("validation", `application.${action}.reason`, "A reason is required for this control action.", command.correlationId)
    return this.#performControl(record, command.operationId, command.correlationId, action)
  }

  async #performControl(
    record: InternalRun,
    operationId: CommandId,
    correlationId: CorrelationId,
    action: "cancel" | "interrupt" | "terminate",
  ): Promise<Result<ControlOutcome>> {
    const authorized = await this.#authorizeEffect(record, correlationId)
    if (!authorized.ok) return authorized
    const proposal = record.proposals.at(-1)
    if (!proposal || !record.session) return failure("internal_failure", "application.session.binding_missing", "The session binding is incomplete.", correlationId)
    if (action === "cancel") record.cancellation = { state: "pending", commandId: operationId }
    const operation = this.#runtimeOperation(record, proposal.dispatch, operationId, correlationId)
    try {
      const result = action === "terminate"
        ? await this.#deps.runtime.terminate(record.session, operation)
        : await this.#deps.runtime.interrupt(record.session, operation)
      const outcome = this.#controlResult(record, operationId, result)
      if (action === "cancel" && outcome.ok) {
        if (outcome.value.outcome === "confirmed") {
          record.run = runSchema.parse({ ...record.run, state: "cancelled", updatedAt: this.#now() })
          record.task = taskSchema.parse({ ...record.task, state: "cancelled" })
          record.cancellation = { state: "confirmed", commandId: operationId }
        } else {
          record.cancellation = { state: outcome.value.outcome, commandId: operationId, error: outcome.value.error }
        }
        return success({ ...outcome.value, snapshot: this.#snapshot(record) })
      }
      return outcome
    } catch {
      const error = normalizeThrown(correlationId, `application.${action}.unknown`, `The ${action} outcome is unknown; reconcile before issuing another control action.`)
      if (action === "cancel") record.cancellation = { state: "unknown", commandId: operationId, error }
      if (record.session) record.session = this.#observeSession(record.session, "unknown")
      return success({ outcome: "unknown", snapshot: this.#snapshot(record), error })
    }
  }

  #controlResult(record: InternalRun, operationId: CommandId, result: Result<void>): Result<ControlOutcome> {
    if (result.ok) return success({ outcome: "confirmed", snapshot: this.#snapshot(record) })
    const outcome = uncertainCategory(result.error) ? "unknown" : "failed"
    if (outcome === "unknown" && record.session) record.session = this.#observeSession(record.session, "unknown")
    return success({ outcome, snapshot: this.#snapshot(record), error: result.error })
  }

  async #getResult(command: Extract<ApplicationCommand, { type: "result.get" }>): Promise<Result<ResultSnapshot>> {
    const record = this.#runs.get(command.runId)
    if (!record?.session) return failure("validation", "application.session.unavailable", "The run has no session result to inspect.", command.correlationId)
    if (record.result && record.result.outcome !== "unknown") {
      return success({ snapshot: this.#snapshot(record), result: clone(record.result) })
    }
    const proposal = record.proposals.at(-1)
    if (!proposal) return failure("internal_failure", "application.proposal.missing", "The session has no dispatch proposal.", command.correlationId)
    const operation = this.#runtimeOperation(record, proposal.dispatch, command.operationId, command.correlationId)
    try {
      const result = await this.#deps.runtime.collectResult(record.session, operation)
      if (!result.ok) {
        if (uncertainCategory(result.error)) record.session = this.#observeSession(record.session, "unknown")
        return result
      }
      const checked = agentResultSchema.safeParse(result.value)
      if (!checked.success) return failure("internal_failure", "application.result.invalid", "The runtime returned an invalid result.", command.correlationId)
      this.#applyResult(record, checked.data, command.operationId, command.correlationId)
      return success({ snapshot: this.#snapshot(record), result: clone(checked.data) })
    } catch {
      record.session = this.#observeSession(record.session, "unknown")
      return failure("transient_transport", "application.result.failed", "Result collection failed; the outcome remains unknown.", command.correlationId)
    }
  }

  async #recover(command: Extract<ApplicationCommand, { type: "sessions.recover" }>): Promise<Result<RecoveryList>> {
    const projects = await this.#safeRegistryCall(
      () => this.#deps.projects.listAuthorizedProjects(),
      command.correlationId,
      "application.recovery.projects_failed",
    )
    if (!projects.ok) return projects
    const sessions: RecoverySummary[] = []
    let quarantinedCount = 0
    for (const candidate of projects.value) {
      const definition = this.#validateDefinition(candidate, command.correlationId)
      if (!definition.ok) {
        quarantinedCount += 1
        continue
      }
      const operation = terminalOperationContextSchema.parse({
        schemaVersion: 1,
        commandId: command.operationId,
        correlationId: command.correlationId,
        projectId: definition.value.project.projectId,
        nodeId: definition.value.nodeContext.nodeId,
        clientId: command.clientId,
      })
      let recovered
      try {
        recovered = await this.#deps.terminal.recover(operation)
      } catch {
        return failure("transient_transport", "application.recovery.failed", "Terminal recovery inspection failed safely.", command.correlationId)
      }
      if (!recovered.ok) return recovered
      for (const raw of recovered.value) {
        const reference = terminalReferenceSchema.safeParse(raw)
        if (
          !reference.success ||
          reference.data.projectId !== definition.value.project.projectId ||
          reference.data.nodeId !== definition.value.nodeContext.nodeId
        ) {
          quarantinedCount += 1
          continue
        }
        const known = [...this.#runs.values()].find((entry) =>
          entry.session?.sessionId === reference.data.sessionId &&
          entry.session.projectId === reference.data.projectId &&
          entry.session.nodeId === reference.data.nodeId &&
          entry.session.terminalId === reference.data.terminalId,
        )
        sessions.push({
          projectId: reference.data.projectId,
          projectName: definition.value.project.name,
          nodeId: reference.data.nodeId,
          sessionId: reference.data.sessionId,
          terminalId: reference.data.terminalId,
          runtimeState: known?.session?.observedState ?? "unknown",
          historyAvailable: Boolean(known),
          mutationAllowed: Boolean(known),
          attachmentMode: "read-only",
        })
      }
    }
    sessions.sort((left, right) => left.projectName.localeCompare(right.projectName) || left.sessionId.localeCompare(right.sessionId))
    return success({ sessions: clone(sessions), quarantinedCount })
  }

  async #createProposal(
    record: InternalRun,
    attempt: number,
    operationId: CommandId,
    correlationId: CorrelationId,
  ): Promise<Result<RunSnapshot>> {
    const fresh = await this.#getDefinition(record.draft.projectId, correlationId)
    if (!fresh.ok) return fresh
    record.definition = fresh.value
    const fields = this.#validateCompleteFields(record.draft.fields, record.definition, correlationId)
    if (!fields.ok) return fields
    try {
      const now = this.#now()
      if (!record.run) {
        record.run = runSchema.parse({
          schemaVersion: 1,
          runId: record.draft.runId,
          projectId: record.draft.projectId,
          goal: fields.value.goal,
          state: "draft",
          paused: false,
          createdAt: now,
          updatedAt: now,
          externalReferences: [],
        })
        record.task = taskSchema.parse({
          schemaVersion: 1,
          taskId: record.draft.taskId,
          runId: record.draft.runId,
          projectId: record.draft.projectId,
          title: fields.value.taskTitle,
          description: fields.value.taskDescription,
          state: "ready",
          failurePolicy: "block",
          dependencies: [],
          externalReferences: [],
        })
        this.#appendEvent(record, "run.created", { run: record.run }, operationId, correlationId)
        this.#appendEvent(record, "task.created", { task: record.task }, operationId, correlationId)
      } else {
        record.run = runSchema.parse({ ...record.run, goal: fields.value.goal, updatedAt: now })
        record.task = taskSchema.parse({ ...record.task, title: fields.value.taskTitle, description: fields.value.taskDescription })
      }

      const dispatchId = dispatchIdSchema.parse(this.#deps.ids.next("dispatch"))
      const envelope = dispatchEnvelopeSchema.parse({
        schemaVersion: 1,
        dispatchId,
        attempt,
        projectId: record.draft.projectId,
        runId: record.draft.runId,
        taskId: record.draft.taskId,
        targetNodeId: record.definition.nodeContext.nodeId,
        installationId: record.definition.installation.installationId,
        runtimeKind: record.definition.installation.runtimeKind,
        projectPathId: record.definition.projectPathId,
        prompt: fields.value.prompt,
        roleSnapshot: record.definition.roleSnapshot,
        ruleSnapshots: [...record.definition.ruleSnapshots],
        contextManifest: record.definition.contextManifest,
        requestedCapabilities: [...record.definition.requestedCapabilities],
        permissionEnvelope: record.definition.permissionEnvelope,
        dependencies: [],
        timeoutSeconds: fields.value.timeoutSeconds,
        controllerEpoch: record.definition.controller.controllerEpoch,
        ...(fields.value.model ? { model: fields.value.model } : {}),
      })
      const dispatch = dispatchSchema.parse({
        schemaVersion: 1,
        envelope,
        envelopeDigest: digestDispatchEnvelope(envelope),
        state: "proposed",
        createdAt: now,
        externalReferences: [],
      })
      record.proposals.push({
        draftRevision: record.draft.revision,
        dispatch,
        launchAdmission: { state: "not-requested" },
      })
      record.draft = { ...record.draft, proposalRequired: false }
      this.#appendEvent(record, "dispatch.proposed", { dispatch }, operationId, correlationId)
      return success(this.#snapshot(record))
    } catch {
      return failure("validation", "application.proposal.invalid", "The draft or current project policy cannot form a valid dispatch proposal.", correlationId)
    }
  }

  #applyPatch(
    current: DraftFields,
    patch: DraftPatch,
    correlationId: CorrelationId,
    requireComplete: boolean,
  ): Result<DraftFields> {
    const fields: DraftFields = {
      ...current,
      ...patch,
      ...(patch.model === undefined && Object.prototype.hasOwnProperty.call(patch, "model") ? { model: undefined } : {}),
    }
    if (!Number.isSafeInteger(fields.timeoutSeconds) || fields.timeoutSeconds < 1 || fields.timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      return failure("validation", "application.draft.timeout", "Timeout must be a whole number from 1 to 86400 seconds.", correlationId)
    }
    for (const [name, value, maximum] of [
      ["goal", fields.goal, 65_536],
      ["task title", fields.taskTitle, 256],
      ["task description", fields.taskDescription, 65_536],
      ["prompt", fields.prompt, 65_536],
    ] as const) {
      if (value.length > maximum) return failure("validation", "application.draft.text_too_long", `The ${name} exceeds its ${maximum}-character limit.`, correlationId)
      if (requireComplete && !value.trim()) return failure("validation", "application.draft.required", `The ${name} is required.`, correlationId)
    }
    if (fields.model !== undefined && (!fields.model.trim() || fields.model !== fields.model.trim() || fields.model.length > 256)) {
      return failure("validation", "application.draft.model", "The selected model is not valid.", correlationId)
    }
    return success(fields)
  }

  #validateCompleteFields(fields: DraftFields, definition: LocalProjectDefinition, correlationId: CorrelationId): Result<DraftFields> {
    const checked = this.#applyPatch(fields, {}, correlationId, true)
    if (!checked.ok) return checked
    if (checked.value.model && !definition.installation.capabilities.modelSelection) {
      return failure("unsupported_capability", "application.model.unsupported", "This runtime does not support model selection.", correlationId)
    }
    if (checked.value.model && !definition.availableModels.includes(checked.value.model)) {
      return failure("validation", "application.model.unavailable", "The selected model is not available for this project.", correlationId)
    }
    return checked
  }

  async #getDefinition(projectId: ProjectId, correlationId: CorrelationId): Promise<Result<LocalProjectDefinition>> {
    const loaded = await this.#safeRegistryCall(
      () => this.#deps.projects.getAuthorizedProject(projectId),
      correlationId,
      "application.project.load_failed",
    )
    if (!loaded.ok) return loaded
    return this.#validateDefinition(loaded.value, correlationId)
  }

  #validateDefinition(definition: LocalProjectDefinition, correlationId: CorrelationId): Result<LocalProjectDefinition> {
    try {
      const project = projectSchema.parse(definition.project)
      const nodeContext = nodeContextSchema.parse(definition.nodeContext)
      const installation = agentInstallationSchema.parse(definition.installation)
      const roleSnapshot = roleTemplateSchema.parse(definition.roleSnapshot)
      const ruleSnapshots = definition.ruleSnapshots.map((rule) => ruleSchema.parse(rule))
      const contextManifest = contextManifestSchema.parse(definition.contextManifest)
      const permissionEnvelope = permissionEnvelopeSchema.parse(definition.permissionEnvelope)
      const binding = project.pathBindings.find((candidate) => candidate.projectPathId === definition.projectPathId)
      if (
        !binding || binding.nodeId !== nodeContext.nodeId || installation.nodeId !== nodeContext.nodeId ||
        roleSnapshot.projectId !== project.projectId || ruleSnapshots.some((rule) => rule.projectId !== project.projectId) ||
        installation.runtimeKind !== this.#deps.runtime.kind || definition.controller.controllerNodeId !== nodeContext.nodeId ||
        !Number.isSafeInteger(definition.controller.controllerEpoch) || definition.controller.controllerEpoch < 1
      ) {
        return failure("policy_denied", "application.project.binding_invalid", "The project is not safely bound to this local runtime and node.", correlationId)
      }
      const availableModels = [...definition.availableModels]
      if (availableModels.some((model) => !model.trim() || model !== model.trim() || model.length > 256) || new Set(availableModels).size !== availableModels.length) {
        return failure("validation", "application.project.models_invalid", "The project's model list is invalid.", correlationId)
      }
      return success({
        ...definition,
        project,
        nodeContext,
        installation,
        roleSnapshot,
        ruleSnapshots,
        contextManifest,
        permissionEnvelope,
        requestedCapabilities: [...definition.requestedCapabilities],
        availableModels,
      })
    } catch {
      return failure("validation", "application.project.invalid", "The authorized project configuration is invalid.", correlationId)
    }
  }

  #projectSummary(definition: LocalProjectDefinition): ProjectSummary {
    const binding = definition.project.pathBindings.find((candidate) => candidate.projectPathId === definition.projectPathId)
    if (!binding) throw new Error("validated project binding missing")
    return {
      projectId: definition.project.projectId,
      name: definition.project.name,
      projectPathId: definition.projectPathId,
      pathLabel: binding.configuredPath,
      nodeId: definition.nodeContext.nodeId,
      installationId: definition.installation.installationId,
      runtimeKind: definition.installation.runtimeKind,
      runtimeName: definition.installation.displayName,
      availableModels: [...definition.availableModels],
    }
  }

  async #refreshProposalDefinition(
    record: InternalRun,
    proposal: InternalProposal,
    correlationId: CorrelationId,
  ): Promise<Result<void>> {
    const fresh = await this.#getDefinition(record.draft.projectId, correlationId)
    if (!fresh.ok) return fresh
    if (this.#materialDefinitionFingerprint(fresh.value) !== this.#materialDefinitionFingerprint(record.definition)) {
      record.draft = { ...record.draft, proposalRequired: true }
      return failure(
        "approval_required",
        "application.proposal.configuration_changed",
        "Project policy, context, target, installation, or authority changed; create and approve a new proposal.",
        correlationId,
      )
    }
    // Same-epoch lease renewal is not dispatch material, but subsequent
    // operations must use the registry's current authenticated lease ID.
    record.definition = fresh.value
    if (proposal.dispatch.envelope.controllerEpoch !== fresh.value.controller.controllerEpoch) {
      return failure("stale_epoch", "application.proposal.stale_epoch", "Controller authority changed; reconcile before issuing effects.", correlationId)
    }
    return success(undefined)
  }

  #materialDefinitionFingerprint(definition: LocalProjectDefinition): string {
    const binding = definition.project.pathBindings.find((candidate) => candidate.projectPathId === definition.projectPathId)
    if (!binding) throw new Error("validated project binding missing")
    return digestJson({
      projectId: definition.project.projectId,
      projectPathId: definition.projectPathId,
      configuredPath: binding.configuredPath,
      targetNodeId: definition.nodeContext.nodeId,
      installation: definition.installation,
      roleSnapshot: definition.roleSnapshot,
      ruleSnapshots: definition.ruleSnapshots,
      contextManifest: definition.contextManifest,
      requestedCapabilities: definition.requestedCapabilities,
      permissionEnvelope: definition.permissionEnvelope,
      availableModels: definition.availableModels,
      controllerNodeId: definition.controller.controllerNodeId,
      controllerEpoch: definition.controller.controllerEpoch,
    })
  }

  async #authorizeEffect(record: InternalRun, correlationId: CorrelationId): Promise<Result<void>> {
    const binding = record.definition.project.pathBindings.find((candidate) => candidate.projectPathId === record.definition.projectPathId)
    if (!binding) return failure("policy_denied", "application.path.binding_missing", "The project path binding is no longer available.", correlationId)
    const request: LaunchPathAuthorizationRequest = {
      projectId: record.definition.project.projectId,
      projectPathId: binding.projectPathId,
      nodeId: binding.nodeId,
      configuredPath: binding.configuredPath,
    }
    const authorized = await this.#safeRegistryCall(
      () => this.#deps.projects.authorizeLaunchPath(request),
      correlationId,
      "application.path.authorization_failed",
    )
    if (!authorized.ok) return authorized
    const value = authorized.value
    if (
      value.projectId !== request.projectId || value.projectPathId !== request.projectPathId ||
      value.nodeId !== request.nodeId || value.configuredPath !== request.configuredPath ||
      !value.realPath || value.realPath.includes("\0") || resolve(value.realPath) !== value.realPath
    ) {
      return failure("policy_denied", "application.path.authorization_mismatch", "The resolved project path did not match the authorized launch binding.", correlationId)
    }
    return success(undefined)
  }

  async #safeRegistryCall<T>(
    operation: () => Promise<Result<T>>,
    correlationId: CorrelationId,
    code: string,
  ): Promise<Result<T>> {
    try {
      return await operation()
    } catch {
      return failure("internal_failure", code, "The project authorization service failed safely.", correlationId)
    }
  }

  #currentProposal(runId: RunId, dispatchId: string, digest: string, correlationId: CorrelationId): Result<{ record: InternalRun; proposal: InternalProposal }> {
    const record = this.#runs.get(runId)
    const proposal = record?.proposals.at(-1)
    if (!record || !proposal) return failure("validation", "application.proposal.unavailable", "The selected proposal is not available.", correlationId)
    if (proposal.dispatch.envelope.dispatchId !== dispatchId || proposal.dispatch.envelopeDigest !== digest) {
      return failure("conflict", "application.proposal.stale", "The proposal changed; review the current dispatch and digest.", correlationId)
    }
    return success({ record, proposal })
  }

  #runtimeOperation(record: InternalRun, dispatch: Dispatch, commandId: CommandId, correlationId: CorrelationId) {
    return runtimeOperationContextSchema.parse({
      schemaVersion: 1,
      commandId,
      correlationId,
      projectId: record.draft.projectId,
      runId: record.draft.runId,
      dispatchId: dispatch.envelope.dispatchId,
      nodeId: record.definition.nodeContext.nodeId,
      controllerNodeId: record.definition.controller.controllerNodeId,
      controllerEpoch: dispatch.envelope.controllerEpoch,
      leaseId: record.definition.controller.leaseId,
    })
  }

  #sessionMatches(record: InternalRun, dispatch: Dispatch, session?: Session): boolean {
    return Boolean(session &&
      session.projectId === record.draft.projectId && session.runId === record.draft.runId &&
      session.taskId === record.draft.taskId && session.dispatchId === dispatch.envelope.dispatchId &&
      session.nodeId === record.definition.nodeContext.nodeId &&
      session.installationId === record.definition.installation.installationId &&
      session.runtimeKind === record.definition.installation.runtimeKind)
  }

  #eventMatches(record: InternalRun, event?: import("../runtime/types.js").AgentRuntimeEvent): boolean {
    const session = record.session
    return Boolean(event && session && event.projectId === session.projectId && event.runId === session.runId &&
      event.taskId === session.taskId && event.dispatchId === session.dispatchId &&
      event.sessionId === session.sessionId && event.nodeId === session.nodeId)
  }

  #applyRuntimeEvent(
    record: InternalRun,
    event: import("../runtime/types.js").AgentRuntimeEvent,
    operationId: CommandId,
    correlationId: CorrelationId,
  ): void {
    if (!record.session) return
    if (event.type === "result_available") {
      this.#applyResult(record, event.result, operationId, correlationId)
      return
    }
    if (event.type === "permission_requested") {
      record.pendingRequest = { requestId: event.requestId, permission: event.permission }
      record.session = this.#observeSession(record.session, "blocked")
      return
    }
    if (event.type !== "lifecycle") return
    // A `completed` report arriving as a bare lifecycle observation is not
    // evidence of success: a run is only completed by an observed result. It is
    // recorded as an unknown observation and reconciliation is required.
    const observed = event.state === "completed" ? "unknown" : event.state
    record.session = this.#observeSession(record.session, observed)
    this.#appendEvent(record, "session.observed", { session: record.session }, operationId, correlationId)
  }

  /**
   * Applies a provider observation to a session, keeping the two axes distinct:
   * `observedState` records what the provider reported, while `lifecycleState`
   * is advanced only through the aggregate state machine. An observation that
   * carries no lifecycle claim (`unknown`) leaves the lifecycle untouched rather
   * than inventing one.
   */
  #observeSession(session: Session, observed: SessionObservedState): Session {
    return sessionSchema.parse({
      ...session,
      observedState: observed,
      lifecycleState: advanceSessionLifecycle(session.lifecycleState, observed),
    })
  }

  #applyResult(record: InternalRun, result: AgentResult, operationId: CommandId, correlationId: CorrelationId): void {
    if (!record.session) return
    record.result = result
    const proposal = record.proposals.at(-1)
    if (result.outcome === "unknown") {
      record.session = this.#observeSession(record.session, "unknown")
      this.#appendEvent(record, "session.observed", { session: record.session }, operationId, correlationId)
      return
    }
    const succeeded = result.outcome === "succeeded"
    // An observed result is the authoritative completion signal, so the session
    // lifecycle advances through the machine via the same observation path.
    record.session = this.#observeSession(record.session, succeeded ? "completed" : "failed")
    record.task = taskSchema.parse({ ...record.task, state: succeeded ? "completed" : "failed" })
    record.run = runSchema.parse({ ...record.run, state: succeeded ? "completed" : "failed", updatedAt: this.#now() })
    if (proposal) proposal.dispatch = dispatchSchema.parse({ ...proposal.dispatch, state: succeeded ? "completed" : "failed" })
    this.#appendEvent(record, "session.observed", { session: record.session }, operationId, correlationId)
    if (proposal) {
      this.#appendEvent(record, "dispatch.finished", {
        dispatchId: proposal.dispatch.envelope.dispatchId,
        sessionId: record.session.sessionId,
        outcome: succeeded ? "completed" : "failed",
        summary: result.summary.slice(0, EVENT_SUMMARY_MAX),
      }, operationId, correlationId)
    }
  }

  #markDefiniteLaunchFailure(
    record: InternalRun,
    proposal: InternalProposal,
    summary: string,
    operationId: CommandId,
    correlationId: CorrelationId,
  ): void {
    record.run = runSchema.parse({ ...record.run, state: "failed", updatedAt: this.#now() })
    record.task = taskSchema.parse({ ...record.task, state: "failed" })
    proposal.dispatch = dispatchSchema.parse({ ...proposal.dispatch, state: "failed" })
    this.#appendEvent(record, "dispatch.finished", {
      dispatchId: proposal.dispatch.envelope.dispatchId,
      outcome: "failed",
      summary: summary.slice(0, EVENT_SUMMARY_MAX),
    }, operationId, correlationId)
  }

  #appendEvent(
    record: InternalRun,
    type: OrchestrationEvent["type"],
    payload: unknown,
    commandId: CommandId,
    correlationId: CorrelationId,
    actor: OrchestrationEvent["actor"] = { kind: "system", name: "local-application" },
  ): void {
    record.sequence += 1
    const event = orchestrationEventSchema.parse({
      schemaVersion: 1,
      eventId: eventIdSchema.parse(this.#deps.ids.next("event")),
      sequence: record.sequence,
      projectId: record.draft.projectId,
      runId: record.draft.runId,
      actor,
      occurredAt: this.#now(),
      correlationId,
      causation: { kind: "command", commandId },
      controllerEpoch: record.definition.controller.controllerEpoch,
      commandId,
      type,
      payload,
    })
    record.events.push(event)
  }

  #snapshot(record: InternalRun): RunSnapshot {
    const proposals = record.proposals.map((proposal) => this.#proposalSnapshot(proposal))
    return clone({
      ...(record.run ? { run: record.run } : {}),
      ...(record.task ? { task: record.task } : {}),
      draft: record.draft,
      ...(proposals.length ? { currentProposal: proposals.at(-1) } : {}),
      proposalHistory: proposals.slice(0, -1),
      ...(record.session ? { session: record.session } : {}),
      ...(record.result ? { result: record.result } : {}),
      ...(record.pendingRequest ? { pendingRequest: record.pendingRequest } : {}),
      cancellation: record.cancellation,
    })
  }

  #proposalSnapshot(proposal: InternalProposal): ProposalSnapshot {
    return {
      draftRevision: proposal.draftRevision,
      dispatch: proposal.dispatch,
      ...(proposal.approval ? { approval: proposal.approval } : {}),
      launchAdmission: proposal.launchAdmission,
    }
  }

  #now(): string {
    return timestampSchema.parse(this.#deps.clock.now())
  }
}

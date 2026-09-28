import { digestDispatchEnvelope } from "../digest.js"
import { sessionIdSchema } from "../identifiers.js"
import { createContractError } from "../errors.js"
import { verifyApproval } from "../policy/approval.js"
import { canTransitionDispatch, canTransitionRun, isRunTerminal, isDispatchTerminal, isApprovalTerminal, type RunState, type DispatchState } from "../transitions.js"
import type { Approval, Dispatch, OrchestrationCommand, OrchestrationEvent, Run, Session, Task } from "../types.js"
import type { EventInput, OutboxRecordInput } from "../event-store/types.js"
import type { ProjectionDispatchState } from "../projections/types.js"
import {
  COMMAND_EVENT_ALLOWLIST,
  RUNTIME_DESTINATION,
  type CoordinatorDependencies,
  type CoordinatorResult,
  type Plan,
} from "./types.js"

function ok<T>(value: T): CoordinatorResult<T> {
  return { ok: true, value }
}

function fail(
  category: Parameters<typeof createContractError>[0],
  code: string,
  message: string,
): CoordinatorResult<never> {
  return { ok: false, error: createContractError(category, code, message) }
}

export class CoordinatorContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CoordinatorContractError"
  }
}

const PLANNED_EVENT_TYPES = new Set([
  "run.created",
  "task.created",
  "run.cancelled",
  "approval.decided",
  "approval.invalidated",
  "dispatch.proposed",
  "dispatch.timeout.requested",
  "dispatch.started",
])

/**
 * The command boundary.
 *
 * Every accepted command produces all of its domain events in ONE append
 * transaction, together with any outbox record naming a runtime effect to be
 * delivered afterwards. No external effect ever happens inside that
 * transaction — the outbox is the only path to the runtime, which is what makes
 * the plan's at-least-once-delivery / exactly-once-intent split achievable
 * rather than aspirational.
 */
export class DispatchCoordinator {
  readonly #deps: CoordinatorDependencies

  constructor(dependencies: CoordinatorDependencies) {
    this.#deps = dependencies
  }

  /**
   * Submits a command. Idempotent by `commandId`: a duplicate returns the
   * originally recorded outcome and performs no second append, so a retried
   * command can never launch a second session or submit a second prompt.
   */
  submit(command: OrchestrationCommand): CoordinatorResult<{ readonly events: readonly string[]; readonly duplicate: boolean }> {
    this.#deps.boundary?.beforeValidate?.(command)

    if (COMMAND_EVENT_ALLOWLIST[command.type] === undefined) {
      return fail("validation", "coordinator.command_unknown", `No command type '${command.type}' is handled by the coordinator.`)
    }

    this.#deps.boundary?.afterValidate?.(command)

    const planned = this.#plan(command)
    if (!planned.ok) return planned as CoordinatorResult<never>

    this.#assertLicensed(command, planned.value.events)

    let appended: { duplicate: boolean; events: readonly EventInput[] }
    try {
      appended = this.#deps.log.append({
        command,
        events: planned.value.events,
        ...(planned.value.outboxRecords.length > 0 ? { outboxRecords: planned.value.outboxRecords } : {}),
      })
    } catch (error) {
      // A mid-append failure rolls the whole transaction back, so nothing is
      // half-recorded. The command is not receipted and may be retried safely.
      return fail(
        "conflict",
        "coordinator.append_failed",
        `Command '${command.commandId}' was not committed and may be retried: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    this.#deps.boundary?.afterCommit?.(command, planned.value.result)

    return ok({
      events: appended.duplicate ? [] : planned.value.events.map((event) => event.type),
      duplicate: appended.duplicate,
    })
  }

  /**
   * `SqliteEventStore.append` does not verify that the events match the command
   * being processed, and I confirmed a `run.created` event could be committed
   * under a `run.cancel` command. That would make "one append transaction per
   * accepted command" meaningless, so a mismatched plan is a programming error
   * and throws rather than writing.
   */
  #assertLicensed(command: OrchestrationCommand, events: readonly OrchestrationEvent[]): void {
    const allowed = COMMAND_EVENT_ALLOWLIST[command.type] ?? []
    for (const event of events) {
      if (!PLANNED_EVENT_TYPES.has(event.type)) {
        throw new CoordinatorContractError(`Event '${event.type}' is not a coordinator-emitted event type.`)
      }
      if (!allowed.includes(event.type)) {
        throw new CoordinatorContractError(
          `Command '${command.type}' may not produce event '${event.type}'. Allowed: [${allowed.join(", ")}].`,
        )
      }
    }
  }

  #plan(command: OrchestrationCommand): CoordinatorResult<Plan> {
    switch (command.type) {
      case "run.create":
        return this.#createRun(command)
      case "run.cancel":
        return this.#cancelRun(command)
      case "dispatch.propose":
        return this.#proposeDispatch(command)
      case "dispatch.approve":
        return this.#approveDispatch(command)
      case "dispatch.retry":
        return this.#retryDispatch(command)
      case "dispatch.timeout.request":
        return this.#requestTimeout(command)
      case "dispatch.execute":
        return this.#executeDispatch(command)
      default:
        return fail("validation", "coordinator.command_unsupported", `Command type '${command.type}' is not implemented by this coordinator.`)
    }
  }

  // --- run.create ---

  #createRun(command: Extract<OrchestrationCommand, { type: "run.create" }>): CoordinatorResult<Plan> {
    const { run, tasks } = command.payload
    if (run.projectId !== command.projectId || run.runId !== command.runId) {
      return fail("conflict", "coordinator.run_scope_mismatch", "The run payload must match the command's project and run identity.")
    }
    // A task is an aggregate owned by one project and run. Accepting a task that
    // names a different scope would put another project's work inside this run's
    // stream, where every later read is scoped by this run.
    for (const task of tasks) {
      if (task.projectId !== command.projectId || task.runId !== command.runId) {
        return fail(
          "conflict",
          "coordinator.task_scope_mismatch",
          `Task '${task.taskId}' names ${task.projectId}/${task.runId}, which is outside this command's ${command.projectId}/${command.runId} scope.`,
        )
      }
    }
    return ok({
      events: [this.#event(command, "run.created", { run }), ...tasks.map((task) => this.#event(command, "task.created", { task }))],
      outboxRecords: [],
    })
  }

  // --- run.cancel ---

  #cancelRun(command: Extract<OrchestrationCommand, { type: "run.cancel" }>): CoordinatorResult<Plan> {
    const state = this.#deps.readRun(command.runId)
    if (state === undefined) {
      return fail("validation", "coordinator.run_unknown", `Run '${command.runId}' is not known.`)
    }
    // The projection's `state` may carry the derived `paused` read-model value,
    // which is a run-level gate rather than a lifecycle state. Coerce it back
    // explicitly: `paused` work is still `active` work and remains cancellable.
    const lifecycle: RunState = state.run.state === "paused" ? "active" : state.run.state
    if (isRunTerminal(lifecycle)) {
      // Cancelling an already-finished run converges to a recorded no-op rather
      // than conflicting, so a retried cancel is harmless.
      return ok({ events: [], outboxRecords: [] })
    }
    if (!canTransitionRun(lifecycle, "cancelled")) {
      return fail("conflict", "coordinator.run_not_cancellable", `Run '${command.runId}' in state '${lifecycle}' cannot be cancelled.`)
    }
    return ok({
      events: [this.#event(command, "run.cancelled", { runId: command.runId, reason: command.payload.reason })],
      outboxRecords: [],
    })
  }

  // --- dispatch.propose ---

  /**
   * Records the FIRST dispatch for a task.
   *
   * This is the entry point of the whole kernel and it must be explicit: a
   * proposed dispatch is an immutable envelope that will later need a
   * digest-bound approval before anything may start. `dispatch.retry` cannot
   * serve this role because it requires a prior attempt, and `dispatch.approve`
   * only ever proposes as a revision of an existing one — so without this
   * command there is no way to begin any work at all.
   */
  #proposeDispatch(command: Extract<OrchestrationCommand, { type: "dispatch.propose" }>): CoordinatorResult<Plan> {
    const { dispatch } = command.payload
    const state = this.#deps.readRun(command.runId)
    if (state === undefined) {
      return fail("validation", "coordinator.run_unknown", `Run '${command.runId}' is not known.`)
    }
    const envelope = dispatch.envelope
    if (envelope.projectId !== command.projectId || envelope.runId !== command.runId) {
      return fail("conflict", "coordinator.dispatch_scope_mismatch", "The dispatch envelope must match the command's project and run identity.")
    }
    if (dispatch.state !== "proposed") {
      return fail("conflict", "coordinator.dispatch_not_proposed", `A new dispatch must be in state 'proposed', not '${dispatch.state}'.`)
    }
    if (dispatch.envelopeDigest !== digestDispatchEnvelope(envelope)) {
      return fail("conflict", "coordinator.dispatch_digest_mismatch", "The dispatch envelopeDigest does not match its own canonical envelope digest.")
    }
    if (state.dispatches[envelope.dispatchId] !== undefined) {
      return fail("conflict", "coordinator.dispatch_already_proposed", `Dispatch '${envelope.dispatchId}' has already been proposed; an envelope is immutable, so a change of content is a new attempt.`)
    }
    if (state.tasks[envelope.taskId] === undefined) {
      return fail("validation", "coordinator.task_unknown", `Task '${envelope.taskId}' is not part of run '${command.runId}'.`)
    }
    return ok({ events: [this.#event(command, "dispatch.proposed", { dispatch })], outboxRecords: [] })
  }

  // --- dispatch.approve ---

  #approveDispatch(command: Extract<OrchestrationCommand, { type: "dispatch.approve" }>): CoordinatorResult<Plan> {
    const { dispatch, approval } = command.payload
    const target = dispatch.envelope.dispatchId
    if (dispatch.envelope.projectId !== command.projectId || dispatch.envelope.runId !== command.runId) {
      return fail("conflict", "coordinator.dispatch_scope_mismatch", "The dispatch envelope must match the command's project and run identity.")
    }

    const state = this.#deps.readRun(command.runId)
    if (state === undefined) {
      return fail("validation", "coordinator.run_unknown", `Run '${command.runId}' is not known.`)
    }
    // An approval may only bind to a dispatch the log actually proposed. Without
    // this the command could mint a live approval for an envelope that exists
    // nowhere, and `dispatch.execute` would then have something to launch.
    const existing = Object.values(state.dispatches).find((d) => d.envelope?.dispatchId === target)
    if (existing === undefined) {
      return fail("validation", "coordinator.dispatch_unknown", `Dispatch '${target}' has not been proposed for run '${command.runId}'.`)
    }
    const newDigest = digestDispatchEnvelope(dispatch.envelope)
    // `queued` is a derived read-model value (approved, awaiting a slot), not a
    // lifecycle state; it collapses back to `approved` for machine checks.
    const existingLifecycle: DispatchState | undefined =
      existing === undefined ? undefined : existing.state === "queued" ? "approved" : existing.state
    // A re-approval that keeps the SAME state is only legitimate when it rebinds
    // a DIFFERENT envelope digest — that is an envelope revision, and it is
    // exactly the case that must invalidate the prior approval. A same-state
    // re-approval on an unchanged digest is a no-op and is refused.
    const rebindsSameState =
      existingLifecycle !== undefined && existingLifecycle === dispatch.state && existing !== undefined && existing.envelopeDigest !== newDigest
    if (existingLifecycle !== undefined && !rebindsSameState && !canTransitionDispatch(existingLifecycle, dispatch.state)) {
      return fail("conflict", "coordinator.dispatch_not_approvable", `Dispatch '${target}' in state '${existingLifecycle}' cannot move to '${dispatch.state}'.`)
    }

    // A pre-existing approval for a DIFFERENT digest on the same dispatch is
    // invalidated in the SAME transaction, so the log can never hold two live
    // approvals for one dispatch. This is the plan's criterion "approval becomes
    // invalid after any envelope mutation", made durable.
    const superseded =
      state === undefined
        ? []
        : Object.values(state.approvals).filter(
            (prior) =>
              prior.dispatchId === target &&
              prior.envelopeDigest !== newDigest &&
              (prior.state === "approved" || prior.state === "pending"),
          )

    if (approval.envelopeDigest !== newDigest) {
      return fail(
        "conflict",
        "coordinator.approval_digest_mismatch",
        `Approval '${approval.approvalId}' records digest '${approval.envelopeDigest}' but the dispatch envelope digests to '${newDigest}'.`,
      )
    }
    if (approval.dispatchId !== target || approval.projectId !== command.projectId || approval.runId !== command.runId) {
      return fail("conflict", "coordinator.approval_scope_mismatch", "The approval must reference this exact dispatch, project and run.")
    }

    // A revision is a PROPOSAL as well as a decision. Without recording the
    // revised envelope, the log would still hold the superseded one while the new
    // approval and any later launch used the revised one — the launched envelope
    // would be unrebuildable from history.
    const isRevision = existing.envelopeDigest !== newDigest

    return ok({
      events: [
        ...superseded.map((prior) => this.#event(command, "approval.invalidated", this.#invalidationPayload(prior, "superseded by a decision on a different dispatch envelope digest"))),
        ...(isRevision ? [this.#event(command, "dispatch.proposed", { dispatch })] : []),
        this.#event(command, "approval.decided", { approval }),
      ],
      outboxRecords: [],
    })
  }

  // --- dispatch.retry ---

  #retryDispatch(command: Extract<OrchestrationCommand, { type: "dispatch.retry" }>): CoordinatorResult<Plan> {
    const { dispatch, previousDispatchId, previousAttempt } = command.payload
    const state = this.#deps.readRun(command.runId)
    if (state === undefined) {
      return fail("validation", "coordinator.run_unknown", `Run '${command.runId}' is not known.`)
    }
    // A retried envelope is written into THIS run's stream, so it must name this
    // run and this project. Without the check, a retry could inject another
    // project's dispatch — and an approval — into this run's history.
    if (dispatch.envelope.projectId !== command.projectId || dispatch.envelope.runId !== command.runId) {
      return fail(
        "conflict",
        "coordinator.dispatch_scope_mismatch",
        `The retry envelope names ${dispatch.envelope.projectId}/${dispatch.envelope.runId}, which is outside this command's ${command.projectId}/${command.runId} scope.`,
      )
    }
    if (dispatch.envelope.attempt <= previousAttempt) {
      return fail(
        "conflict",
        "coordinator.retry_attempt_not_advanced",
        `Retry attempt ${dispatch.envelope.attempt} must exceed the previous attempt ${previousAttempt}; a dispatch envelope is immutable per attempt.`,
      )
    }
    const previous = state.dispatches[previousDispatchId]
    if (previous === undefined) {
      return fail("validation", "coordinator.dispatch_unknown", `Previous dispatch '${previousDispatchId}' is not known for run '${command.runId}'.`)
    }
    // A retry ADDS an attempt; it must never run alongside the attempt it
    // replaces. Without this, a `running` dispatch could be retried and the same
    // task would end up holding two live sessions — the plan's "duplicate
    // commands cannot launch duplicate sessions", reached without any duplicate
    // command at all.
    const previousLifecycle: DispatchState = previous.state === "queued" ? "approved" : previous.state
    if (!isDispatchTerminal(previousLifecycle)) {
      return fail(
        "conflict",
        "coordinator.dispatch_not_terminal",
        `Previous dispatch '${previousDispatchId}' is '${previousLifecycle}', not terminal; a retry cannot run alongside the attempt it replaces.`,
      )
    }
    if (previous.attempt !== previousAttempt) {
      return fail(
        "conflict",
        "coordinator.retry_attempt_mismatch",
        `Command claims previous attempt ${previousAttempt} but dispatch '${previousDispatchId}' is recorded at attempt ${previous.attempt}.`,
      )
    }
    // A retry needs a fresh approval: the prior one bound to the prior digest,
    // and any envelope mutation invalidates it.
    const priorApprovals = Object.values(state.approvals).filter(
      (approval) => approval.dispatchId === previousDispatchId && approval.state === "approved",
    )
    return ok({
      events: [
        ...priorApprovals.map((prior) => this.#event(command, "approval.invalidated", this.#invalidationPayload(prior, "dispatch retried with a new envelope attempt"))),
        this.#event(command, "dispatch.proposed", { dispatch }),
      ],
      outboxRecords: [],
    })
  }

  // --- dispatch.timeout.request ---

  #requestTimeout(command: Extract<OrchestrationCommand, { type: "dispatch.timeout.request" }>): CoordinatorResult<Plan> {
    const { dispatchId, reason } = command.payload
    const state = this.#deps.readRun(command.runId)
    const dispatch = state?.dispatches[dispatchId]
    if (dispatch === undefined) {
      return fail("validation", "coordinator.dispatch_unknown", `Dispatch '${dispatchId}' is not known for run '${command.runId}'.`)
    }
    if (dispatch.timeoutRequested) {
      return ok({ events: [], outboxRecords: [] })
    }
    // `queued` is derived, not a lifecycle state; collapse it before the check.
    const lifecycle: DispatchState = dispatch.state === "queued" ? "approved" : dispatch.state
    if (isDispatchTerminal(lifecycle)) {
      return fail("conflict", "coordinator.dispatch_already_terminal", `Dispatch '${dispatchId}' is already '${lifecycle}'; a timeout request would be meaningless.`)
    }
    return ok({
      events: [this.#event(command, "dispatch.timeout.requested", { dispatchId, reason })],
      outboxRecords: [],
    })
  }

  // --- dispatch.execute ---

  #executeDispatch(command: Extract<OrchestrationCommand, { type: "dispatch.execute" }>): CoordinatorResult<Plan> {
    const { dispatch, approval } = command.payload
    const state = this.#deps.readRun(command.runId)
    if (state === undefined) {
      return fail("validation", "coordinator.run_unknown", `Run '${command.runId}' is not known.`)
    }
    const target = dispatch.envelope.dispatchId
    // Everything below is checked against the RECORDED log, not only the command
    // payload. A payload is caller-supplied: a self-consistent approval (right
    // digest, right scope, `approved`) proves only that the caller can compute a
    // hash, never that anyone decided anything. Authorization therefore has to
    // come from an `approval.decided` and a `dispatch.proposed` that are already
    // in the stream.
    const recordedDispatch = state.dispatches[target]
    if (recordedDispatch === undefined) {
      return fail("validation", "coordinator.dispatch_unknown", `Dispatch '${target}' has not been proposed for run '${command.runId}'.`)
    }

    // A dispatch that has ALREADY started answers with the recorded session and
    // nothing else. This is checked against the RECORD, not the payload, so a
    // retry of the very command that launched it still returns the original
    // outcome rather than failing a state precondition it has already passed.
    const recordedSession = Object.values(state.sessions).find((s) => s.dispatchId === target)
    if (recordedSession !== undefined) {
      const recordedLifecycleNow: DispatchState =
        recordedDispatch.state === "queued" ? "approved" : recordedDispatch.state
      if (recordedLifecycleNow === "running" || isDispatchTerminal(recordedLifecycleNow)) {
        return ok({ events: [], outboxRecords: [], result: { sessionId: recordedSession.sessionId } })
      }
    }

    // Starting a dispatch is the single privilege an approval confers. A
    // dispatch that is not `approved` has no authority to start.
    if (dispatch.state !== "approved") {
      return fail("conflict", "coordinator.dispatch_not_approved", `Dispatch '${target}' is '${dispatch.state}', not 'approved'; it cannot be started.`)
    }

    if (approval.state !== "approved" || approval.decision !== "approved") {
      return fail("approval_required", "coordinator.approval_required", `Dispatch '${target}' has no live approved approval (approval is '${approval.state}').`)
    }
    if (approval.dispatchId !== target) {
      return fail("approval_required", "coordinator.approval_scope_mismatch", `Approval '${approval.approvalId}' does not reference dispatch '${target}'.`)
    }
    // The approval must still bind to THIS envelope. A retry or any mutation
    // invalidates it, and an invalidated approval can never authorise a launch.
    const verification = verifyApproval(approval, dispatch.envelope)
    if (!verification.valid || verification.state !== "approved") {
      return fail(
        "approval_required",
        "coordinator.approval_stale",
        `Approval '${approval.approvalId}' no longer binds to dispatch '${target}' (${verification.codes.join(", ") || "envelope digest changed"}).`,
      )
    }

    // The envelope the command asks to launch must be the one the log recorded.
    // Otherwise the approval above is self-consistent over an envelope that only
    // exists in the caller's memory, and the launched effect could not be
    // rebuilt from history.
    if (recordedDispatch.envelopeDigest !== verification.computedEnvelopeDigest) {
      return fail(
        "conflict",
        "coordinator.dispatch_envelope_mismatch",
        `Dispatch '${target}' is recorded with envelope digest '${recordedDispatch.envelopeDigest}' but this command carries an envelope digesting to '${verification.computedEnvelopeDigest}'.`,
      )
    }

    // And the recorded dispatch must itself be approved, not merely the payload's
    // claim. `queued` is the derived read-model form of `approved`.
    const recordedLifecycle: ProjectionDispatchState = recordedDispatch.state
    if (recordedLifecycle !== "approved" && recordedLifecycle !== "queued") {
      return fail(
        "conflict",
        "coordinator.dispatch_not_approved",
        `Dispatch '${target}' is '${recordedLifecycle}' in the recorded log, not 'approved'; it cannot be started.`,
      )
    }

    // Finally: the approval must be one the log actually decided. The payload's
    // approval id is a POINTER, not the grant itself.
    const recordedApproval = state.approvals[approval.approvalId]
    if (recordedApproval === undefined || recordedApproval.dispatchId !== target) {
      return fail(
        "approval_required",
        "coordinator.approval_not_recorded",
        `Approval '${approval.approvalId}' is not a recorded decision for dispatch '${target}'; no 'approval.decided' event authorises this launch.`,
      )
    }
    const recordedVerification = verifyApproval(
      {
        schemaVersion: 1,
        approvalId: recordedApproval.approvalId,
        projectId: recordedApproval.projectId,
        runId: recordedApproval.runId,
        dispatchId: recordedApproval.dispatchId,
        envelopeDigest: recordedApproval.envelopeDigest,
        decision: recordedApproval.decision,
        state: recordedApproval.state,
        basis: recordedApproval.basis,
        actor: recordedApproval.actor,
        decidedAt: recordedApproval.decidedAt,
      },
      recordedDispatch.envelope,
    )
    if (!recordedVerification.valid || recordedVerification.state !== "approved") {
      return fail(
        "approval_required",
        "coordinator.approval_stale",
        `Recorded approval '${approval.approvalId}' no longer authorises dispatch '${target}' (${recordedVerification.codes.join(", ") || "recorded state is not approved"}).`,
      )
    }

    const now = this.#deps.now()
    const session: Session = {
      schemaVersion: 1,
      sessionId: sessionIdSchema.parse(`sess-${command.commandId}`),
      projectId: command.projectId,
      runId: command.runId,
      taskId: dispatch.envelope.taskId,
      dispatchId: target,
      nodeId: dispatch.envelope.targetNodeId,
      installationId: dispatch.envelope.installationId,
      runtimeKind: dispatch.envelope.runtimeKind,
      lifecycleState: "launching",
      observedState: "starting",
    }

    // The runtime effect is NAMED in the outbox inside the transaction but
    // PERFORMED outside it. The outbox id derives from the command id, so a
    // redelivery is recognisable as the same effect and cannot launch twice.
    const outboxId = `obx-${command.commandId}`
    const outboxRecords: readonly OutboxRecordInput[] = [
      {
        outboxId,
        destination: RUNTIME_DESTINATION,
        payload: {
          commandId: command.commandId,
          dispatchId: target,
          sessionId: session.sessionId,
          envelope: dispatch.envelope,
          envelopeDigest: dispatch.envelopeDigest,
          approvalId: approval.approvalId,
        },
        payloadDigest: dispatch.envelopeDigest,
        status: "pending",
        createdAt: now,
        projectId: command.projectId,
        runId: command.runId,
        commandId: command.commandId,
      },
    ]

    return ok({ events: [this.#event(command, "dispatch.started", { session })], outboxRecords })
  }

  #invalidationPayload(approval: { approvalId: string; projectId: string; runId: string; dispatchId: string; envelopeDigest: string }, reason: string) {
    return {
      approvalId: approval.approvalId,
      projectId: approval.projectId,
      runId: approval.runId,
      dispatchId: approval.dispatchId,
      envelopeDigest: approval.envelopeDigest,
      reason,
    }
  }

  #event(command: OrchestrationCommand, type: OrchestrationEvent["type"], payload: unknown): OrchestrationEvent {
    this.#deps.boundary?.duringAppend?.(command, 0)
    return {
      schemaVersion: 1,
      eventId: this.#deps.newEventId(),
      type,
      projectId: command.projectId,
      runId: command.runId,
      occurredAt: this.#deps.now(),
      actor: command.actor,
      controllerEpoch: command.controllerEpoch,
      correlationId: command.correlationId,
      causation: { kind: "command", commandId: command.commandId },
      commandId: command.commandId,
      payload,
    } as OrchestrationEvent
  }
}

export type { CoordinatorDependencies, CoordinatorResult }
export { COMMAND_EVENT_ALLOWLIST, RUNTIME_DESTINATION }

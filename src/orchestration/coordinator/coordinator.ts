import { digestDispatchEnvelope } from "../digest.js"
import { sessionIdSchema } from "../identifiers.js"
import { createContractError } from "../errors.js"
import { verifyApproval } from "../policy/approval.js"
import { canTransitionDispatch, canTransitionRun, isRunTerminal, isDispatchTerminal, isApprovalTerminal, type RunState, type DispatchState } from "../transitions.js"
import type { Approval, Dispatch, OrchestrationCommand, OrchestrationEvent, Run, Session, Task } from "../types.js"
import type { EventInput, OutboxRecordInput } from "../event-store/types.js"
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

  // --- dispatch.approve ---

  #approveDispatch(command: Extract<OrchestrationCommand, { type: "dispatch.approve" }>): CoordinatorResult<Plan> {
    const { dispatch, approval } = command.payload
    const target = dispatch.envelope.dispatchId
    if (dispatch.envelope.projectId !== command.projectId || dispatch.envelope.runId !== command.runId) {
      return fail("conflict", "coordinator.dispatch_scope_mismatch", "The dispatch envelope must match the command's project and run identity.")
    }

    const state = this.#deps.readRun(command.runId)
    const existing = state === undefined ? undefined : Object.values(state.dispatches).find((d) => d.envelope?.dispatchId === target)
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

    return ok({
      events: [
        ...superseded.map((prior) => this.#event(command, "approval.invalidated", this.#invalidationPayload(prior, "superseded by a decision on a different dispatch envelope digest"))),
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

    // Starting a dispatch is the single privilege an approval confers. A
    // dispatch that is not `approved` has no authority to start, and one that
    // already started must never start twice.
    if (dispatch.state !== "approved") {
      if (dispatch.state === "running" || isDispatchTerminal(dispatch.state)) {
        const existing = Object.values(state.sessions).find((s) => s.dispatchId === target)
        if (existing !== undefined) {
          // A duplicate start returns the recorded session rather than
          // launching a second one.
          return ok({ events: [], outboxRecords: [], result: { sessionId: existing.sessionId } })
        }
      }
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

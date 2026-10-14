import { canonicalJson, digestJson } from "../digest.js"
import { eventIdSchema } from "../identifiers.js"
import { RoundtableRepository } from "../roundtable/repository.js"
import type { Post } from "../roundtable/types.js"
import { CharterRepository } from "../charter/repository.js"
import { CharterProposalLifecycle } from "../charter/proposal.js"
import { SAFETY_FLOOR } from "../policy/floor.js"
import type { SafetyFloor } from "../policy/types.js"
import type { Charter } from "../charter/types.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../mesh/protocol/negotiation.js"
import { digestDispatchEnvelope } from "../digest.js"
import { sessionIdSchema, nodeIdSchema, installationIdSchema, taskIdSchema } from "../identifiers.js"
import { createContractError } from "../errors.js"
import { verifyApproval } from "../policy/approval.js"
import { validateCommandStateByType, type AggregateStateContext } from "../invariants.js"
import { canTransitionDispatch, canTransitionRun, isRunTerminal, isDispatchTerminal, isApprovalTerminal, type RunState, type DispatchState } from "../transitions.js"
import type { Approval, Dispatch, OrchestrationCommand, OrchestrationEvent, Run, Session, Task } from "../types.js"
import type { EventInput, OutboxRecordInput } from "../event-store/types.js"
import type { ProjectionDispatchState } from "../projections/types.js"
import {
  COMMAND_EVENT_ALLOWLIST,
  MEMORY_WRITEBACK_DESTINATION,
  RUNTIME_DESTINATION,
  type CoordinatorDependencies,
  type CoordinatorResult,
  type Plan,
  type PromptCompilationResult,
} from "./types.js"
import { getSiblingDispatches, planFanOutDispatchesSync } from "../scheduler/index.js"
import { createRoundtableOutcomeMemoryRecord } from "../roundtable/index.js"
import type { MemoryRepository, AppendMemoryInput } from "../../memory/ports.js"
import { evaluateRoundtableGate } from "../policy/evaluate.js"
import type { BudgetReserveParams, BudgetReservationResult } from "../scheduler/types.js"

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

/**
 * The charter fields an activation payload may legitimately refresh (§7.4):
 * capture metadata, plus `version`/`snapshotDigest`, which the repository
 * computes and stamps itself. Everything else — including the immutable-core
 * stamp — must be byte-equal to the content the human approval vouched for.
 * Classified by key FILTER rather than by whitelist so a future charter field is
 * part of the equality until deliberately added here.
 */
const REVISION_METADATA_FIELDS: Record<string, true> = {
  capturedAt: true,
  author: true,
  version: true,
  snapshotDigest: true,
}

const PLANNED_EVENT_TYPES = new Set([
  "run.created",
  "task.created",
  "run.cancelled",
  "run.paused",
  "run.resumed",
  "approval.decided",
  "approval.invalidated",
  "dispatch.proposed",
  "dispatch.timeout.requested",
  "dispatch.started",
  "session.observed",
  "roundtable.opened",
  "roundtable.posted",
  "roundtable.closed",
  "roundtable.outcome_recorded",
  "charter.proposed",
  "charter.revised",
  "charter.rejected",
])

/**
 * Asserts that the planned events are licensed by the command's allowlist.
 * Throws CoordinatorContractError if any event is unlicensed or unknown.
 */
export function assertLicensed(command: OrchestrationCommand, events: readonly OrchestrationEvent[]): void {
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
  readonly #completedCommandIds = new Set<string>()
  readonly #roundtables: RoundtableRepository
  readonly #charters: CharterRepository
  readonly #proposals: CharterProposalLifecycle
  readonly #safetyFloor: SafetyFloor
  readonly #memoryRepository?: MemoryRepository
  readonly #pendingWriteBacks = new Set<Promise<unknown>>()

  constructor(dependencies: CoordinatorDependencies) {
    this.#deps = dependencies
    this.#roundtables = dependencies.roundtables ?? new RoundtableRepository()
    this.#charters = dependencies.charters ?? new CharterRepository()
    this.#proposals = dependencies.charterProposals ?? new CharterProposalLifecycle({ safetyFloor: dependencies.safetyFloor ?? SAFETY_FLOOR })
    this.#safetyFloor = dependencies.safetyFloor ?? SAFETY_FLOOR
    this.#memoryRepository = dependencies.memoryRepository
  }

  /**
   * Submits a command. Idempotent by `commandId`: a duplicate returns the
   * originally recorded outcome and performs no second append, so a retried
   * command can never launch a second session or submit a second prompt.
   *
   * Authorization order is load-bearing (M4-M):
   *
   *   1. `COMMAND_EVENT_ALLOWLIST` — a programming-error guard, throws.
   *   2. `COMMAND_MATRIX`          — the state preconditions, refuses.
   *   3. the command's own domain preconditions, resolved against the RECORDED
   *      log rather than against the payload.
   *
   * The matrix is consulted before planning so that EVERY command type reaches
   * it, including the session commands the coordinator does not yet implement —
   * a matrix entry that only some command types can reach is a matrix that will
   * silently rot back into decoration.
   */
  submit(
    command: Exclude<OrchestrationCommand, { type: "session.prompt" }>,
  ): CoordinatorResult<{ readonly events: readonly string[]; readonly duplicate: boolean }>
  submit(
    command: OrchestrationCommand,
  ): CoordinatorResult<{ readonly events: readonly string[]; readonly duplicate: boolean }>
  submit(
    command: OrchestrationCommand,
  ): CoordinatorResult<{ readonly events: readonly string[]; readonly duplicate: boolean }> {
    if (command.type === "session.prompt") {
      return fail(
        "validation",
        "coordinator.prompt_use_submit_prompt",
        "Command 'session.prompt' is effectful and must be submitted via submitPrompt().",
      )
    }

    this.#deps.boundary?.beforeValidate?.(command)

    if (COMMAND_EVENT_ALLOWLIST[command.type] === undefined) {
      return fail("validation", "coordinator.command_unknown", `No command type '${command.type}' is handled by the coordinator.`)
    }

    this.#deps.boundary?.afterValidate?.(command)

    const unlicensed = this.#assertMatrixLicensed(command)
    if (unlicensed !== undefined) {
      // The matrix refuses. Two things can still be true, and the distinction
      // decides which error the caller sees.
      const wouldDo = this.#plan(command)

      // (a) The command performs no transition and names no effect at all — a
      // retried `run.cancel` of an already-finished run, a repeated pause of an
      // already-paused run. There is nothing for the matrix to have licensed, so
      // the no-op stands. This matters on a mesh: at-least-once redelivery is
      // the normal case, and answering it with a conflict would turn a retried
      // cancel into an operator-visible failure.
      if (wouldDo.ok && wouldDo.value.events.length === 0 && wouldDo.value.outboxRecords.length === 0) {
        // fall through to the converged no-op
      } else if (!wouldDo.ok) {
        // (b) The coordinator has its own, more specific reason — an unknown run,
        // an approval that is not recorded, a retry of a live attempt. The matrix
        // refusal is still binding and the command is still refused, but the
        // caller gets the error that actually explains the problem instead of a
        // generic state-precondition one.
        return wouldDo as CoordinatorResult<never>
      } else {
        // (c) The coordinator WOULD have planned a real transition. This is the
        // case the matrix exists for: nothing else here refuses it, so the
        // matrix's state precondition is the only thing standing between the
        // command and the log.
        return unlicensed
      }
    }

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
    if (!appended.duplicate && command.type === "roundtable.close" && this.#memoryRepository) {
      this.#writeBackMemory(planned.value)
    }


    return ok({
      events: appended.duplicate ? [] : planned.value.events.map((event) => event.type),
      duplicate: appended.duplicate,
    })
  }

  /**
   * The `COMMAND_MATRIX` gate (M4-M). Returns a refusal, or `undefined` when the
   * matrix licenses the command in the state the RECORDED log is actually in.
   *
   * The context is built from `readRun` — the projection rebuilt by replaying the
   * event log — and never from the command payload. A payload is a claim about
   * what the state is; the projection is the record of what it is. That is the
   * same discipline `#executeDispatch` already applies to approvals, and it is
   * the reason this gate cannot be bypassed by constructing a self-consistent
   * command.
   */
  #assertMatrixLicensed(command: OrchestrationCommand): CoordinatorResult<never> | undefined {
    const context = this.#matrixContext(command)
    const result = validateCommandStateByType(command.type, context)
    if (result.ok) return undefined
    return fail(result.error.category as never, result.error.code, result.error.message)
  }

  /**
   * The aggregate states this command would act in, read from the recorded log.
   *
   * A field is left `undefined` when the command does not name that aggregate, or
   * when the aggregate is not in the log. `undefined` means "this dimension does
   * not constrain the command"; the coordinator's own preconditions then refuse
   * an unknown run, dispatch, or task with a precise error. That is deliberate:
   * inventing a state for something the log has never heard of would let an
   * unknown aggregate slip past the gate as though it were a known one.
   */
  #matrixContext(command: OrchestrationCommand): AggregateStateContext {
    const context: AggregateStateContext = {}
    const state = this.#deps.readRun(command.runId)
    if (state === undefined) return context
    // `lifecycleState`, never the derived `state`: a projection may report a run
    // as `paused` or a dispatch as `queued`, and the matrix speaks the kernel
    // lifecycle vocabulary from `../transitions.js`.
    context.runState = state.run.lifecycleState

    const taskOf = (taskId: string | undefined) =>
      taskId === undefined ? undefined : state.tasks[taskId]?.lifecycleState
    const sessionOf = (sessionId: string | undefined) =>
      sessionId === undefined ? undefined : state.sessions[sessionId]?.state

    switch (command.type) {
      case "dispatch.propose": {
        context.taskState = taskOf(command.payload.dispatch.envelope.taskId)
        break
      }
      case "dispatch.approve": {
        const target = command.payload.dispatch.envelope.dispatchId
        const recorded = state.dispatches[target]
        context.dispatchState = recorded?.lifecycleState
        context.taskState = taskOf(command.payload.dispatch.envelope.taskId)
        // The payload approval is the record this command CREATES, so its state
        // is the result. What the matrix is given instead is the approval the
        // log already recorded for this dispatch, if any.
        const prior = Object.values(state.approvals).find(
          (approval) => approval.dispatchId === target && approval.envelopeDigest !== command.payload.approval.envelopeDigest,
        )
        context.approvalState = prior?.state
        break
      }
      case "dispatch.retry": {
        context.dispatchState = state.dispatches[command.payload.previousDispatchId]?.lifecycleState
        context.taskState = taskOf(command.payload.dispatch.envelope.taskId)
        break
      }
      case "dispatch.execute": {
        const target = command.payload.dispatch.envelope.dispatchId
        context.dispatchState = state.dispatches[target]?.lifecycleState
        context.taskState = taskOf(command.payload.dispatch.envelope.taskId)
        // Deliberately the RECORDED approval's state, never the payload's: the
        // payload's approval is a pointer, and a pointer may claim anything.
        context.approvalState = state.approvals[command.payload.approval.approvalId]?.state
        break
      }
      case "dispatch.timeout.request": {
        const recorded = state.dispatches[command.payload.dispatchId]
        context.dispatchState = recorded?.lifecycleState
        const session = Object.values(state.sessions).find((candidate) => candidate.dispatchId === command.payload.dispatchId)
        context.sessionState = session?.state
        break
      }
      case "session.prompt":
      case "session.respond":
      case "session.interrupt":
      case "session.terminate": {
        context.sessionState = sessionOf(command.payload.sessionId)
        break
      }
      case "run.create":
      case "run.pause":
      case "run.resume":
      case "run.cancel":
        break
    }
    return context
  }

  /**
   * `SqliteEventStore.append` does not verify that the events match the command
   * being processed, and I confirmed a `run.created` event could be committed
   * under a `run.cancel` command. That would make "one append transaction per
   * accepted command" meaningless, so a mismatched plan is a programming error
   * and throws rather than writing.
   */
  #assertLicensed(command: OrchestrationCommand, events: readonly OrchestrationEvent[]): void {
    assertLicensed(command, events)
  }

  #plan(command: OrchestrationCommand): CoordinatorResult<Plan> {
    switch (command.type) {
      case "run.create":
        return this.#createRun(command)
      case "run.cancel":
        return this.#cancelRun(command)
      case "run.pause":
        return this.#setPaused(command, true)
      case "run.resume":
        return this.#setPaused(command, false)
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
      case "session.prompt":
        return this.#promptSession(command)
      case "roundtable.open":
        return this.#openRoundtable(command)
      case "roundtable.post":
        return this.#postRoundtable(command, false)
      case "roundtable.inject_human":
        return this.#postRoundtable(command, true)
      case "roundtable.close":
        return this.#closeRoundtable(command)
      case "charter.propose":
        return this.#proposeCharter(command)
      case "charter.approve":
        return this.#approveCharter(command)
      case "charter.revise":
        return this.#reviseCharter(command)
      case "charter.reject":
        return this.#rejectCharter(command)
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
    // A run is created exactly once. Without this precondition a second
    // `run.create` for an existing `runId` is accepted — a fresh `commandId`
    // evades the command receipt, and the sequence unique-index only constrains
    // position, not identity — and the reducer then overwrites `paused`
    // unconditionally. That let anyone clear the pause gate that protects
    // imported legacy work, simply by re-emitting the creation event.
    if (this.#deps.readRun(command.runId) !== undefined) {
      return fail(
        "conflict",
        "coordinator.run_already_exists",
        `Run '${command.runId}' already exists; a run is created once. Use run.pause/run.resume to change its gate, or run.cancel to end it.`,
      )
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

  // --- run.pause / run.resume ---

  /**
   * Drives the run-level pause gate through events.
   *
   * `paused` used to be written exactly once at creation and never cleared, so a
   * paused run was a permanent tombstone: nothing could ever schedule it again.
   * It now has an owner. Pausing and resuming are explicit, evented decisions
   * like every other lifecycle change, which also means no `run.created` can
   * rewrite the gate after the fact.
   */
  #setPaused(
    command: Extract<OrchestrationCommand, { type: "run.pause" }> | Extract<OrchestrationCommand, { type: "run.resume" }>,
    paused: boolean,
  ): CoordinatorResult<Plan> {
    const state = this.#deps.readRun(command.runId)
    if (state === undefined) {
      return fail("validation", "coordinator.run_unknown", `Run '${command.runId}' is not known.`)
    }
    const lifecycle: RunState = state.run.state === "paused" ? "active" : state.run.state
    if (isRunTerminal(lifecycle)) {
      return fail(
        "conflict",
        "coordinator.run_terminal",
        `Run '${command.runId}' is already '${lifecycle}'; a terminal run can be neither paused nor resumed.`,
      )
    }
    const currentlyPaused = state.run.paused || state.run.state === "paused"
    if (currentlyPaused === paused) {
      // Converge to a recorded no-op so a retried pause/resume is harmless.
      return ok({ events: [], outboxRecords: [] })
    }
    return ok({
      events: [
        this.#event(command, paused ? "run.paused" : "run.resumed", {
          runId: command.runId,
          reason: command.payload.reason,
        }),
      ],
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
    if (envelope.fanOut !== undefined && envelope.fanOut > 1) {
      const plan = planFanOutDispatchesSync({
        parentDispatch: dispatch,
        fanOut: envelope.fanOut,
        now: this.#deps.now(),
        budgetLedger: this.#deps.budgetLedger,
      })
      const events: OrchestrationEvent[] = [
        this.#event(command, "dispatch.proposed", { dispatch }),
        ...plan.plannedDispatches.map((sibling) => this.#event(command, "dispatch.proposed", { dispatch: sibling })),
      ]
      return ok({ events, outboxRecords: [] })
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
    // Sibling failure check: if a sibling has already failed terminally, this dispatch cannot execute.
    const siblings = getSiblingDispatches(state, target)
    const failedSibling = siblings.find(
      (s) => s.dispatchId !== target && (s.lifecycleState === "failed" || s.state === "failed"),
    )
    if (failedSibling !== undefined) {
      return fail(
        "conflict",
        "coordinator.sibling_failed",
        `Cannot execute dispatch '${target}': sibling dispatch '${failedSibling.dispatchId}' has failed terminally.`,
      )
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

    // Rule requiring a closed roundtable before execution dispatch (Phase 5, Change 1)
    const charter =
      this.#deps.charter ??
      (this.#charters.getLatestCharter(command.projectId) ??
        this.#charters.getCharter(command.projectId) ??
        this.#charters.getLatestCharter("default") ??
        this.#charters.listCharters()[0])

    const gateResult = evaluateRoundtableGate({
      envelope: dispatch.envelope,
      charter,
      task: state.tasks[dispatch.envelope.taskId],
      roundtables: this.#roundtables,
    })
    if (!gateResult.ok) {
      return fail(gateResult.error.category as never, gateResult.error.code, gateResult.error.message)
    }

    const now = this.#deps.now()
    // Fan-out execution (N siblings) when envelope requests fanOut > 1
    if (dispatch.envelope.fanOut !== undefined && dispatch.envelope.fanOut > 1) {
      const plan = planFanOutDispatchesSync({
        parentDispatch: dispatch,
        fanOut: dispatch.envelope.fanOut,
        now,
        budgetLedger: this.#deps.budgetLedger,
      })

      if (plan.plannedDispatches.length === 0) {
        const refusal = plan.refusedDispatches[0]?.refusal
        return fail(
          "conflict",
          refusal?.code ?? "coordinator.budget_refused",
          refusal?.message ?? `Budget ledger refused fan-out reservations for dispatch '${target}'.`,
        )
      }

      const events: OrchestrationEvent[] = []
      const outboxRecords: OutboxRecordInput[] = []
      const sessions: Session[] = []

      for (let index = 0; index < plan.plannedDispatches.length; index += 1) {
        const siblingDispatch = plan.plannedDispatches[index]
        const siblingTarget = siblingDispatch.envelope.dispatchId
        const siblingSession: Session = {
          schemaVersion: 1,
          sessionId: sessionIdSchema.parse(`sess-${command.commandId}-sibling-${index}`),
          projectId: command.projectId,
          runId: command.runId,
          taskId: dispatch.envelope.taskId,
          dispatchId: siblingTarget,
          nodeId: siblingDispatch.envelope.targetNodeId,
          installationId: siblingDispatch.envelope.installationId,
          runtimeKind: siblingDispatch.envelope.runtimeKind,
          lifecycleState: "launching",
          observedState: "starting",
        }
        sessions.push(siblingSession)
        events.push(this.#event(command, "dispatch.started", { session: siblingSession }))
        outboxRecords.push({
          outboxId: `obx-${command.commandId}-sibling-${index}`,
          destination: RUNTIME_DESTINATION,
          payload: {
            commandId: command.commandId,
            dispatchId: siblingTarget,
            parentDispatchId: target,
            sessionId: siblingSession.sessionId,
            envelope: siblingDispatch.envelope,
            envelopeDigest: siblingDispatch.envelopeDigest,
            approvalId: approval.approvalId,
          },
          payloadDigest: siblingDispatch.envelopeDigest,
          status: "pending",
          createdAt: now,
          projectId: command.projectId,
          runId: command.runId,
          commandId: command.commandId,
        })
      }

      return ok({
        events,
        outboxRecords,
        result: {
          sessionId: sessions[0]?.sessionId,
          sessions,
          plannedCount: plan.plannedDispatches.length,
          refusedCount: plan.refusedDispatches.length,
        },
      })
    }

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

  // --- session.prompt ---

  #promptSession(command: Extract<OrchestrationCommand, { type: "session.prompt" }>): CoordinatorResult<Plan> {
    const { sessionId } = command.payload
    const state = this.#deps.readRun(command.runId)
    if (state === undefined) {
      return fail("validation", "coordinator.run_unknown", `Run '${command.runId}' is not known.`)
    }

    const recordedSession = state.sessions[sessionId]
    if (recordedSession === undefined) {
      return fail("validation", "coordinator.session_unknown", `Session '${sessionId}' is not known for run '${command.runId}'.`)
    }

    if (command.projectId !== recordedSession.projectId) {
      return fail("conflict", "coordinator.session_scope_mismatch", `Session '${sessionId}' belongs to project '${recordedSession.projectId}', not '${command.projectId}'.`)
    }

    if (state.run.state !== "active") {
      return fail("conflict", "coordinator.run_not_active", `Run '${command.runId}' is '${state.run.state}', not 'active'.`)
    }

    if (recordedSession.state !== "idle") {
      return fail("conflict", "coordinator.session_not_idle", `Session '${sessionId}' is in state '${recordedSession.state}', not 'idle'.`)
    }

    const recordedDispatch = state.dispatches[recordedSession.dispatchId]
    const baseSession = {
      schemaVersion: 1 as const,
      sessionId: recordedSession.sessionId,
      projectId: recordedSession.projectId,
      runId: recordedSession.runId,
      taskId: recordedSession.taskId ?? recordedDispatch?.envelope.taskId ?? taskIdSchema.parse("task-1"),
      dispatchId: recordedSession.dispatchId,
      nodeId: recordedSession.nodeId ?? recordedDispatch?.envelope.targetNodeId ?? nodeIdSchema.parse("node-1"),
      installationId: recordedSession.installationId ?? recordedDispatch?.envelope.installationId ?? installationIdSchema.parse("inst-1"),
      runtimeKind: recordedSession.runtimeKind ?? recordedDispatch?.envelope.runtimeKind ?? "opencode",
      ...(recordedSession.terminalId ? { terminalId: recordedSession.terminalId } : {}),
    }

    const workingSession: Session = {
      ...baseSession,
      lifecycleState: "running",
      observedState: "working",
    }

    const idleSession: Session = {
      ...baseSession,
      lifecycleState: "idle",
      observedState: "idle",
    }
    let promptToSend = command.payload.prompt
    let compiled: PromptCompilationResult | undefined

    const hasRolePayload =
      command.payload.roleAssignments !== undefined ||
      command.payload.roleSnapshot !== undefined

    if (hasRolePayload) {
      const compiler = this.#deps.compilePrompt
      if (!compiler) {
        return fail(
          "validation",
          "coordinator.compiler_not_configured",
          "Prompt compiler is required to execute session.prompt with role payload.",
        )
      }

      const primaryRole = command.payload.roleSnapshot ?? recordedDispatch?.envelope.roleSnapshot
      if (!primaryRole) {
        return fail(
          "validation",
          "coordinator.role_unknown",
          `No primary role found for session '${sessionId}'.`,
        )
      }

      const secondaryRoles = recordedDispatch?.envelope.roleSnapshots?.filter(
        (r) => r.roleId !== primaryRole.roleId,
      )

      const charter =
        this.#charters.getLatestCharter(command.projectId) ??
        this.#charters.getCharter(command.projectId)

      try {
        compiled = compiler({
          primaryRole,
          secondaryRoles,
          roleAssignments: command.payload.roleAssignments,
          charter,
          taskPrompt: command.payload.prompt,
        })
      } catch (error) {
        return fail(
          "validation",
          "coordinator.prompt_compilation_failed",
          `Failed to compile prompt for session '${sessionId}': ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      promptToSend = compiled.systemPrompt
    }

    const now = this.#deps.now()
    const outboxId = `obx-${command.commandId}`
    const outboxPayload = {
      commandId: command.commandId,
      type: "session.prompt",
      effect: "session.prompt",
      sessionId,
      dispatchId: recordedSession.dispatchId,
      prompt: promptToSend,
      ...(compiled !== undefined
        ? {
            compiledPrompt: compiled.systemPrompt,
            promptDigest: compiled.promptDigest,
            compositeDigest: compiled.compositeDigest,
            roleDigests: compiled.roleDigests,
          }
        : {}),
    }

    const outboxRecords: readonly OutboxRecordInput[] = [
      {
        outboxId,
        destination: RUNTIME_DESTINATION,
        payload: outboxPayload,
        payloadDigest: compiled?.compositeDigest ?? digestJson({ sessionId, prompt: promptToSend }),
        status: "pending",
        createdAt: now,
        projectId: command.projectId,
        runId: command.runId,
        commandId: command.commandId,
      },
    ]

    return ok({
      events: [
        this.#event(command, "session.observed", { session: workingSession }),
        this.#event(command, "session.observed", { session: idleSession }),
      ],
      outboxRecords,
      result: {
        session: idleSession,
        prompt: promptToSend,
        ...(compiled !== undefined
          ? {
              compiledPrompt: compiled.systemPrompt,
              promptDigest: compiled.promptDigest,
              compositeDigest: compiled.compositeDigest,
              roleDigests: compiled.roleDigests,
            }
          : {}),
      },
    })
  }

  async submitPrompt(
    command: Extract<OrchestrationCommand, { type: "session.prompt" }>,
  ): Promise<CoordinatorResult<{ readonly events: readonly string[]; readonly duplicate: boolean }>> {
    this.#deps.boundary?.beforeValidate?.(command)

    if (COMMAND_EVENT_ALLOWLIST[command.type] === undefined) {
      return fail("validation", "coordinator.command_unknown", `No command type '${command.type}' is handled by the coordinator.`)
    }

    this.#deps.boundary?.afterValidate?.(command)

    const unlicensed = this.#assertMatrixLicensed(command)
    if (unlicensed !== undefined) {
      const wouldDo = this.#plan(command)
      if (wouldDo.ok && wouldDo.value.events.length === 0 && wouldDo.value.outboxRecords.length === 0) {
        // converged no-op
      } else if (!wouldDo.ok) {
        return wouldDo as CoordinatorResult<never>
      } else {
        return unlicensed
      }
    }

    const planned = this.#plan(command)
    if (!planned.ok) return planned as CoordinatorResult<never>

    this.#assertLicensed(command, planned.value.events)

    const client = this.#deps.opencodeClient
    if (!client) {
      return fail("validation", "coordinator.client_not_configured", "OpencodeClient is required to execute session.prompt.")
    }

    const monitor = this.#deps.sessionMonitor ?? this.#deps.monitorSession
    if (!monitor) {
      return fail("validation", "coordinator.monitor_not_configured", "Session monitor is required to execute session.prompt.")
    }

    const state = this.#deps.readRun(command.runId)!
    const recordedSession = state.sessions[command.payload.sessionId]!
    const recordedDispatch = state.dispatches[recordedSession.dispatchId]

    const projectDir =
      this.#deps.resolveProjectDir?.(command.payload.sessionId, recordedSession, recordedDispatch) ??
      ((recordedSession.adapterMetadata as Record<string, unknown> | null)?.projectDir as string | undefined) ??
      ((recordedSession.adapterMetadata as Record<string, unknown> | null)?.directory as string | undefined) ??
      recordedDispatch?.envelope.projectPathId ??
      ""

    // 1. DURABLE FIRST: Atomically commit to log before any runtime effect runs.
    let appended: { duplicate: boolean; events: readonly EventInput[] }
    try {
      appended = this.#deps.log.append({
        command,
        events: planned.value.events,
        ...(planned.value.outboxRecords.length > 0 ? { outboxRecords: planned.value.outboxRecords } : {}),
      })
    } catch (error) {
      return fail(
        "conflict",
        "coordinator.append_failed",
        `Command '${command.commandId}' was not committed and may be retried: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (appended.duplicate) {
      return ok({ events: [], duplicate: true })
    }

    this.#deps.boundary?.afterCommit?.(command, planned.value.result)

    const promptToSend =
      (planned.value.result as { prompt?: string } | undefined)?.prompt ??
      (planned.value.outboxRecords[0]?.payload as { prompt?: string } | undefined)?.prompt ??
      command.payload.prompt

    // 2. EFFECT: Deliver prompt after durable commit.
    try {
      if (this.#deps.effectTransport) {
        for (const record of planned.value.outboxRecords) {
          this.#deps.boundary?.beforeDeliver?.(record.outboxId)
          await this.#deps.effectTransport.deliver({
            outboxId: record.outboxId,
            destination: record.destination,
            payload: record.payload,
          })
        }
      }
      this.#deps.boundary?.beforeDeliver?.(planned.value.outboxRecords[0]?.outboxId ?? `obx-${command.commandId}`)
      await client.sendPromptAsync(command.payload.sessionId, promptToSend, projectDir)
    } catch (error) {
      return fail(
        "transient_transport",
        "coordinator.prompt_rejected",
        `Failed to send prompt to session '${command.payload.sessionId}': ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    // 3. MONITOR: Hand session to monitor to track to idle.
    const sessionForMonitor: Session = {
      schemaVersion: 1,
      sessionId: recordedSession.sessionId,
      projectId: recordedSession.projectId,
      runId: recordedSession.runId,
      taskId: recordedSession.taskId ?? recordedDispatch?.envelope.taskId ?? taskIdSchema.parse("task-1"),
      dispatchId: recordedSession.dispatchId,
      nodeId: recordedSession.nodeId ?? recordedDispatch?.envelope.targetNodeId ?? nodeIdSchema.parse("node-1"),
      installationId: recordedSession.installationId ?? recordedDispatch?.envelope.installationId ?? installationIdSchema.parse("inst-1"),
      runtimeKind: recordedSession.runtimeKind ?? recordedDispatch?.envelope.runtimeKind ?? "opencode",
      lifecycleState: "running",
      observedState: "working",
      ...(recordedSession.terminalId ? { terminalId: recordedSession.terminalId } : {}),
    }

    try {
      if (typeof monitor === "function") {
        await monitor(sessionForMonitor, projectDir)
      } else {
        await monitor.waitForIdle(sessionForMonitor, projectDir)
      }
    } catch (error) {
      return fail(
        "runtime_failure",
        "coordinator.session_monitor_failed",
        `Session monitor failed while tracking session '${command.payload.sessionId}' to idle: ${error instanceof Error ? error.message : String(error)}`,
      )
    }


    return ok({
      events: planned.value.events.map((event) => event.type),
      duplicate: false,
    })
  }

  get roundtables(): RoundtableRepository {
    return this.#roundtables
  }

  get charters(): CharterRepository {
    return this.#charters
  }

  get charterProposals(): CharterProposalLifecycle {
    return this.#proposals
  }

  // --- roundtable.open ---

  #openRoundtable(command: Extract<OrchestrationCommand, { type: "roundtable.open" }>): CoordinatorResult<Plan> {
    const { roundtable } = command.payload
    const state = this.#deps.readRun(command.runId)
    if (state === undefined) {
      return fail("validation", "coordinator.run_unknown", `Run '${command.runId}' is not known.`)
    }
    if (this.#roundtables.has(roundtable.id)) {
      return fail("conflict", "coordinator.roundtable_already_exists", `Roundtable '${roundtable.id}' already exists; a roundtable is opened once.`)
    }
    if (roundtable.members.length === 0) {
      return fail("validation", "coordinator.roundtable_invalid_members", `Roundtable '${roundtable.id}' must declare at least one member.`)
    }
    const chairInMembers = roundtable.members.some((m) => m.nodeId === roundtable.chairNodeId)
    if (!chairInMembers) {
      return fail("validation", "coordinator.roundtable_invalid_members", `Roundtable chair '${roundtable.chairNodeId}' must be included in members.`)
    }
    const opened = this.#roundtables.open(roundtable)
    if (!opened.ok) {
      return fail(opened.error.category as never, opened.error.code, opened.error.message)
    }
    return ok({
      events: [this.#event(command, "roundtable.opened", { roundtable })],
      outboxRecords: [],
      result: { roundtable },
    })
  }

  // --- roundtable.post / roundtable.inject_human ---

  #postRoundtable(
    command: Extract<OrchestrationCommand, { type: "roundtable.post" | "roundtable.inject_human" }>,
    isHumanInjection: boolean,
  ): CoordinatorResult<Plan> {
    const { post } = command.payload
    const state = this.#deps.readRun(command.runId)
    if (state === undefined) {
      return fail("validation", "coordinator.run_unknown", `Run '${command.runId}' is not known.`)
    }
    const discussion = this.#roundtables.get(post.discussionId)
    if (discussion === undefined) {
      return fail("validation", "coordinator.roundtable_unknown", `Discussion '${post.discussionId}' is not known for run '${command.runId}'.`)
    }
    if (discussion.roundtable.state !== "open") {
      return fail("conflict", "coordinator.roundtable_closed", `Discussion '${post.discussionId}' is closed; posting to a closed discussion is refused.`)
    }
    if (isHumanInjection && post.authorRoleId !== "human") {
      return fail("validation", "coordinator.roundtable_invalid_author", `Author role ID for inject_human must be 'human'.`)
    }
    if (!isHumanInjection) {
      const isMember = discussion.roundtable.members.some(
        (m) => m.nodeId === post.authorNodeId && m.roleId === post.authorRoleId,
      )
      if (!isMember) {
        return fail(
          "conflict",
          "coordinator.roundtable_non_member",
          `Author '${post.authorNodeId}' with role '${post.authorRoleId}' is not a member of discussion '${post.discussionId}'.`,
        )
      }
    }

    const seq = discussion.posts.length + 1
    const finalPost: Post = { ...post, seq }

    // Controller relay: all other member nodes receive the relayed post. Sender node is excluded.
    const recipientNodeIds = Array.from(
      new Set(
        discussion.roundtable.members
          .map((m) => m.nodeId)
          .filter((nodeId) => nodeId !== post.authorNodeId),
      ),
    )

    // Budget gating on roundtable fan-out (Phase 5, Change 2)
    // Parallel roundtable fan-out (posts relayed to N members concurrently / parallel deliberation mode)
    // draws budget from the same ledger that enforces maximumFanOut for dispatches as SEPARATE counters.
    if (discussion.roundtable.mode === "parallel" && this.#deps.budgetLedger) {
      const units = recipientNodeIds.length
      if (units > 0) {
        const charter =
          this.#deps.charter ??
          (this.#charters.getLatestCharter(command.projectId) ??
            this.#charters.getCharter(command.projectId) ??
            this.#charters.getLatestCharter("default") ??
            this.#charters.listCharters()[0])
        const budgetScope = charter?.escalationPolicy?.budgetScope ?? "shared"
        const subScope =
          budgetScope === "per_member"
            ? `roundtable:${post.discussionId}:${post.authorNodeId}`
            : `roundtable:${post.discussionId}`
        const reservationId = `res-roundtable-${post.discussionId}-${seq}-${post.authorNodeId}`
        const now = this.#deps.now()
        const reserveRequest: BudgetReserveParams = {
          reservationId,
          projectId: command.projectId,
          runId: command.runId,
          taskId: discussion.roundtable.taskId ?? "task-roundtable",
          dispatchId: post.postId,
          scope: "fan_out",
          units,
          now,
          subScope,
        }
        const reserveResult = this.#deps.budgetLedger.reserveSync
          ? this.#deps.budgetLedger.reserveSync(reserveRequest)
          : (this.#deps.budgetLedger.reserve(reserveRequest) as BudgetReservationResult)

        if (!reserveResult.ok) {
          const refusal = reserveResult.refusal
          return fail(
            "policy_denied",
            refusal.code ?? "budget.scope_saturated",
            refusal.message ?? `Budget ledger refused roundtable fan-out reservation for discussion '${post.discussionId}'.`,
          )
        }
      }
    }

    const appended = this.#roundtables.post(finalPost, isHumanInjection)
    if (!appended.ok) {
      return fail(appended.error.category as never, appended.error.code, appended.error.message)
    }

    const now = this.#deps.now()
    const event = this.#event(command, "roundtable.posted", { post: finalPost })
    const outboxRecords: readonly OutboxRecordInput[] = recipientNodeIds.map((recipientNodeId) => ({
      outboxId: `obx-${command.commandId}-relay-${recipientNodeId}`,
      destination: recipientNodeId,
      payload: {
        meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
        eventId: eventIdSchema.parse(`evt-${command.commandId}-relay-${recipientNodeId}`),
        sourceNodeId: command.controllerNodeId,
        commandCorrelation: command.commandId,
        localSequence: finalPost.seq,
        observedAt: now,
        runProjectScope: {
          projectId: command.projectId,
          runId: command.runId,
        },
        eventType: "roundtable.posted",
        event,
      },
      payloadDigest: digestJson(finalPost),
      status: "pending",
      createdAt: now,
      projectId: command.projectId,
      runId: command.runId,
      commandId: command.commandId,
    }))

    return ok({
      events: [event],
      outboxRecords,
      result: { post: finalPost, outboxRecords },
    })
  }

  // --- roundtable.close ---

  #closeRoundtable(command: Extract<OrchestrationCommand, { type: "roundtable.close" }>): CoordinatorResult<Plan> {
    const { discussionId, outcome } = command.payload
    const state = this.#deps.readRun(command.runId)
    if (state === undefined) {
      return fail("validation", "coordinator.run_unknown", `Run '${command.runId}' is not known.`)
    }
    const discussion = this.#roundtables.get(discussionId)
    if (discussion === undefined) {
      return fail("validation", "coordinator.roundtable_unknown", `Discussion '${discussionId}' is not known for run '${command.runId}'.`)
    }
    if (discussion.roundtable.state !== "open") {
      return fail("conflict", "coordinator.roundtable_already_closed", `Discussion '${discussionId}' is already closed; closing twice is refused.`)
    }
    const closed = this.#roundtables.close(discussionId, outcome)
    if (!closed.ok) {
      return fail(closed.error.category as never, closed.error.code, closed.error.message)
    }
    // Capture deliberation outcome as a persistent memory record with provenance
    // back to the discussion and all constituent post ids (plan §6.3, §7, §10 row 3).
    // The write-back effect is named in the outbox in the SAME durable commit transaction.
    const { memoryRecord, appendInput } = createRoundtableOutcomeMemoryRecord({
      discussion,
      outcome,
      command,
    })

    const outboxId = `obx-${command.commandId}-memory`
    const outboxRecords: readonly OutboxRecordInput[] = [
      {
        outboxId,
        destination: MEMORY_WRITEBACK_DESTINATION,
        payload: {
          commandId: command.commandId,
          discussionId,
          memory: memoryRecord,
        },
        payloadDigest: memoryRecord.contentDigest,
        status: "pending",
        createdAt: command.issuedAt,
        projectId: command.projectId,
        runId: command.runId,
        commandId: command.commandId,
      },
    ]

    return ok({
      events: [this.#event(command, "roundtable.outcome_recorded", { discussionId, outcome })],
      outboxRecords,
      result: { outcome, memory: memoryRecord, appendInput },
    })
  }

  // --- charter.propose ---

  #proposeCharter(command: Extract<OrchestrationCommand, { type: "charter.propose" }>): CoordinatorResult<Plan> {
    const { proposal, proposalId } = command.payload

    const proposed = this.#proposals.propose({
      proposal,
      proposalId,
      actor: command.actor,
      proposedAt: command.issuedAt,
      safetyFloor: this.#safetyFloor,
    })

    if (!proposed.ok) {
      return fail(proposed.error.category as never, proposed.error.code, proposed.error.message)
    }

    return ok({
      events: [
        this.#event(command, "charter.proposed", {
          proposal,
          proposalId: proposed.value.proposalId,
        }),
      ],
      outboxRecords: [],
      result: { proposal: proposed.value },
    })
  }

  // --- charter.approve ---

  #approveCharter(command: Extract<OrchestrationCommand, { type: "charter.approve" }>): CoordinatorResult<Plan> {
    const { charterId, version, proposalId, comment } = command.payload

    // Human-only approval (settled §15)
    if (command.actor.kind !== "user") {
      return fail(
        "policy_denied",
        "charter.unauthorized_approval",
        `Charter revision approval requires human authority (actor.kind must be 'user', got '${command.actor.kind}'). Agent-authored proposals cannot approve themselves.`,
      )
    }

    const approved = this.#proposals.approve({
      proposalId,
      charterId,
      version,
      actor: command.actor,
      decidedAt: command.issuedAt,
      comment,
    })

    if (!approved.ok) {
      return fail(approved.error.category as never, approved.error.code, approved.error.message)
    }

    const record = approved.value

    // Flow through charter.revise: activate new version in repository
    let newCharter: Charter
    try {
      if (this.#charters.hasCharter(record.proposal.charter.charterId)) {
        newCharter = this.#charters.reviseCharter(record.proposal.charter.charterId, {
          purpose: record.proposal.charter.purpose,
          globalRules: record.proposal.charter.globalRules,
          communicationPolicy: record.proposal.charter.communicationPolicy,
          escalationPolicy: record.proposal.charter.escalationPolicy,
          roleCatalog: record.proposal.charter.roleCatalog,
          author: "human",
          capturedAt: command.issuedAt,
        })
      } else {
        newCharter = this.#charters.registerCharter({
          ...record.proposal.charter,
          author: "human",
          capturedAt: command.issuedAt,
        })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return fail("conflict", "charter.revision_failed", `Failed to activate charter revision: ${message}`)
    }

    this.#proposals.markRevised(record.proposalId, newCharter.version)

    return ok({
      events: [
        this.#event(command, "charter.revised", {
          charter: newCharter,
          proposalId: record.proposalId,
        }),
      ],
      outboxRecords: [],
      result: { charter: newCharter, proposalId: record.proposalId },
    })
  }

  // --- charter.revise ---

  #reviseCharter(command: Extract<OrchestrationCommand, { type: "charter.revise" }>): CoordinatorResult<Plan> {
    const { charter, proposalId } = command.payload

    if (proposalId) {
      const record = this.#proposals.getProposal(proposalId)
      if (!record) {
        return fail("validation", "charter.proposal_not_found", `Proposal '${proposalId}' does not exist.`)
      }
      if (record.status === "refused_core_violation") {
        return fail(
          "policy_denied",
          "charter_core_violation",
          "Proposal was refused as an immutable core violation and can never be activated.",
        )
      }
      // Approval is the authority (§7.4): an agent may re-drive the activation
      // of an APPROVED proposal (e.g. retry after a version conflict), and a
      // human may revise charters directly (the no-proposalId path below) — but
      // activation THROUGH a proposal applies EXACTLY the content the approval
      // vouched for. A payload charter that differs would activate content that
      // never passed the pre-pending core gate — the one place
      // `assertCharterDoesNotRelaxCore` runs (§7.3, DoD #4) — under the
      // approved proposal's authority.
      if (record.status !== "approved") {
        return fail(
          "conflict",
          "charter.revision_not_approved",
          `Proposal '${proposalId}' is '${record.status}', not 'approved'; only an approved proposal can be activated. Content changes are new proposals (§7.3).`,
        )
      }
      const payloadContent = Object.fromEntries(
        Object.entries(charter).filter(([key]) => !(key in REVISION_METADATA_FIELDS)),
      )
      const approvedContent = Object.fromEntries(
        Object.entries(record.proposal.charter).filter(([key]) => !(key in REVISION_METADATA_FIELDS)),
      )
      if (canonicalJson(payloadContent) !== canonicalJson(approvedContent)) {
        return fail(
          "conflict",
          "charter.revision_content_mismatch",
          `Revision payload does not match the content of approved proposal '${proposalId}'. Submit a new charter.propose for changed content (§7.3).`,
        )
      }
    } else if (command.actor.kind !== "user") {
      return fail(
        "policy_denied",
        "charter.unauthorized_approval",
        `Direct charter revision requires human authority (actor.kind must be 'user', got '${command.actor.kind}').`,
      )
    }

    let revisedCharter: Charter
    try {
      if (this.#charters.hasCharter(charter.charterId)) {
        revisedCharter = this.#charters.reviseCharter(charter.charterId, {
          purpose: charter.purpose,
          globalRules: charter.globalRules,
          communicationPolicy: charter.communicationPolicy,
          escalationPolicy: charter.escalationPolicy,
          roleCatalog: charter.roleCatalog,
          author: charter.author,
          capturedAt: command.issuedAt,
        })
      } else {
        revisedCharter = this.#charters.registerCharter({
          ...charter,
          capturedAt: command.issuedAt,
        })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return fail("conflict", "charter.revision_failed", `Failed to revise charter: ${message}`)
    }

    if (proposalId) {
      this.#proposals.markRevised(proposalId, revisedCharter.version)
    }

    return ok({
      events: [
        this.#event(command, "charter.revised", {
          charter: revisedCharter,
          proposalId,
        }),
      ],
      outboxRecords: [],
      result: { charter: revisedCharter, proposalId },
    })
  }

  // --- charter.reject ---

  #rejectCharter(command: Extract<OrchestrationCommand, { type: "charter.reject" }>): CoordinatorResult<Plan> {
    const { charterId, version, proposalId, rationale } = command.payload

    const rejected = this.#proposals.reject({
      proposalId,
      charterId,
      version,
      rationale,
      actor: command.actor,
      decidedAt: command.issuedAt,
    })

    if (!rejected.ok) {
      return fail(rejected.error.category as never, rejected.error.code, rejected.error.message)
    }

    return ok({
      events: [
        this.#event(command, "charter.rejected", {
          charterId,
          version: rejected.value.proposal.charter.version,
          proposalId: rejected.value.proposalId,
          rationale,
        }),
      ],
      outboxRecords: [],
      result: { proposal: rejected.value },
    })
  }

  async submitPost(
    command: Extract<OrchestrationCommand, { type: "roundtable.post" | "roundtable.inject_human" }>,
  ): Promise<CoordinatorResult<{ readonly events: readonly string[]; readonly duplicate: boolean }>> {
    this.#deps.boundary?.beforeValidate?.(command)

    if (COMMAND_EVENT_ALLOWLIST[command.type] === undefined) {
      return fail("validation", "coordinator.command_unknown", `No command type '${command.type}' is handled by the coordinator.`)
    }

    this.#deps.boundary?.afterValidate?.(command)

    const unlicensed = this.#assertMatrixLicensed(command)
    if (unlicensed !== undefined) {
      const wouldDo = this.#plan(command)
      if (wouldDo.ok && wouldDo.value.events.length === 0 && wouldDo.value.outboxRecords.length === 0) {
        // converged no-op
      } else if (!wouldDo.ok) {
        return wouldDo as CoordinatorResult<never>
      } else {
        return unlicensed
      }
    }

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
      return fail(
        "conflict",
        "coordinator.append_failed",
        `Command '${command.commandId}' was not committed and may be retried: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (appended.duplicate) {
      return ok({ events: [], duplicate: true })
    }

    this.#deps.boundary?.afterCommit?.(command, planned.value.result)

    if (this.#deps.effectTransport) {
      for (const record of planned.value.outboxRecords) {
        try {
          await this.#deps.effectTransport.deliver({
            outboxId: record.outboxId,
            destination: record.destination,
            payload: record.payload,
          })
        } catch (error) {
          return fail(
            "transient_transport",
            "coordinator.relay_delivery_failed",
            `Failed to relay post to destination '${record.destination}': ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }

    return ok({
      events: planned.value.events.map((event) => event.type),
      duplicate: false,
    })
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

  /**
   * Writes back the deliberation outcome to the memory repository post-commit.
   *
   * Crucial semantic invariant (§10 row 3 acceptance):
   * A failed memory write does NOT corrupt, roll back, or fail the outcome commit.
   * The domain event `roundtable.outcome_recorded` and the outbox row are already
   * durably committed. Any write-back failure (synchronous throw or rejected promise)
   * is isolated; the outbox record remains in the store for recovery/replay.
   */
  #writeBackMemory(plan: Plan): void {
    if (!this.#memoryRepository) return
    const planResult = plan.result as { appendInput?: AppendMemoryInput } | undefined
    if (!planResult?.appendInput) return

    try {
      const pending = this.#memoryRepository.append(planResult.appendInput)
      if (pending && typeof (pending as Promise<unknown>).then === "function") {
        const tracked = (pending as Promise<unknown>)
          .catch(() => {
            // Memory write failure is isolated: outcome commit is already durable.
          })
          .finally(() => {
            this.#pendingWriteBacks.delete(tracked)
          })
        this.#pendingWriteBacks.add(tracked)
      }
    } catch {
      // Synchronous failure caught: outcome commit remains intact.
    }
  }

  get memoryRepository(): MemoryRepository | undefined {
    return this.#memoryRepository
  }

  /**
   * Flushes any pending memory write-back promises.
   * Useful for tests or shutdown hooks to ensure all asynchronous write-backs have settled.
   */
  async flushMemoryWriteBacks(): Promise<void> {
    await Promise.all(Array.from(this.#pendingWriteBacks))
  }

  /**
   * Submits a roundtable.close command and awaits any post-commit memory write-back.
   */
  async submitClose(
    command: Extract<OrchestrationCommand, { type: "roundtable.close" }>,
  ): Promise<CoordinatorResult<{ readonly events: readonly string[]; readonly duplicate: boolean }>> {
    const result = this.submit(command)
    await this.flushMemoryWriteBacks()
    return result
  }
}

export type { CoordinatorDependencies, CoordinatorResult }
export { COMMAND_EVENT_ALLOWLIST, MEMORY_WRITEBACK_DESTINATION, RUNTIME_DESTINATION }

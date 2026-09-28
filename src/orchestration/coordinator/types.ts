import type { Timestamp } from "../identifiers.js"
import type { OrchestrationCommand, OrchestrationEvent } from "../types.js"
import type { EventInput, OutboxRecordInput } from "../event-store/types.js"
import type { Dispatch, Run, Session, Task, Approval } from "../types.js"
import type { RunProjectionState } from "../projections/types.js"

/**
 * The transport contract a coordinator depends on: the subset of
 * `SqliteEventStore` the kernel needs, so a fake can drive every failure
 * boundary in the plan's recovery matrix without a database.
 */
export interface CommandLog {
  append(options: {
    readonly command: OrchestrationCommand
    readonly events: readonly EventInput[]
    readonly expectedSequence?: number
    readonly commandResult?: unknown
    readonly commandError?: unknown
    readonly outboxRecords?: readonly OutboxRecordInput[]
  }): { readonly duplicate: boolean; readonly events: readonly EventInput[] }
}

/**
 * A destination the coordinator can deliver runtime effects to. The outbox gives
 * at-least-once delivery, so this side must be idempotent on `outboxId`, which
 * is why that id is stable across redeliveries.
 */
export interface EffectTransport {
  deliver(record: { readonly outboxId: string; readonly destination: string; readonly payload: unknown }): Promise<void>
}

/**
 * The plan's failure-injection boundaries. Each of the eight boundaries in
 * "Failure and Recovery Tests" maps to a hook here, so a crash is injected at
 * an exact point and restart behaviour asserted without monkey-patching or
 * timing games.
 */
export interface EffectBoundary {
  /** 1. Before command validation. */
  beforeValidate?(command: OrchestrationCommand): void
  /** 2. After validation, before append. */
  afterValidate?(command: OrchestrationCommand): void
  /** 3. During the multi-event append. */
  duringAppend?(command: OrchestrationCommand, index: number): void
  /** 4. After commit, before the response is returned. */
  afterCommit?(command: OrchestrationCommand, result: unknown): void
  /** 5. Before outbox delivery. */
  beforeDeliver?(outboxId: string): void
  /** 6. After the runtime accepted the launch, before acknowledgement. */
  afterRuntimeAccept?(outboxId: string): void
  /** 7. During projection update. */
  duringProjectionUpdate?(event: OrchestrationEvent): void
  /** 8. During callback/legacy translation. */
  duringTranslation?(payload: unknown): void
}

/** What a handler produces before it is committed. */
export interface Plan {
  readonly events: readonly OrchestrationEvent[]
  readonly outboxRecords: readonly OutboxRecordInput[]
  readonly result?: unknown
}

export interface CoordinatorDependencies {
  readonly log: CommandLog
  readonly now: () => Timestamp
  readonly newEventId: () => string
  readonly boundary?: EffectBoundary
  /** The current run projection, used for state preconditions. */
  readonly readRun: (runId: string) => RunProjectionState | undefined
}

export type CoordinatorError = {
  readonly category: string
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export type CoordinatorResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CoordinatorError }

/**
 * Which events a given command is allowed to produce.
 *
 * `SqliteEventStore.append` does not check this, and a `run.created` event can
 * be committed under a `run.cancel` command, which would make "one append
 * transaction per accepted command" meaningless.
 */
export const COMMAND_EVENT_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "run.create": ["run.created", "task.created"],
  "dispatch.propose": ["dispatch.proposed"],
  "run.cancel": ["run.cancelled"],
  // A revision is a proposal: the plan states an edited envelope creates a new
  // digest, so the revised envelope MUST be recorded or the log would no longer
  // contain what was approved/launched.
  "dispatch.approve": ["approval.invalidated", "dispatch.proposed", "approval.decided"],
  "dispatch.retry": ["dispatch.proposed", "approval.invalidated"],
  "dispatch.timeout.request": ["dispatch.timeout.requested"],
  "dispatch.execute": ["dispatch.started"],
  "session.prompt": [],
  "session.respond": [],
  "session.interrupt": [],
  "session.terminate": [],
}

export const RUNTIME_DESTINATION = "runtime.dispatch.execute"

export type { Approval, Dispatch, Run, Session, Task }

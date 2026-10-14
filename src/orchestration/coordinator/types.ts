import type { Timestamp } from "../identifiers.js"
import type { OrchestrationCommand, OrchestrationEvent } from "../types.js"
import type { EventInput, OutboxRecordInput } from "../event-store/types.js"
import type { Dispatch, Run, Session, Task, Approval, RoleTemplate } from "../types.js"
import type { DispatchProjection, RunProjectionState, SessionProjection } from "../projections/types.js"
import type { BudgetLedgerPort } from "../scheduler/types.js"
import type { RoundtableRepository } from "../roundtable/repository.js"
import type { CharterRepository } from "../charter/repository.js"
import type { CharterProposalRepository } from "../charter/proposal.js"
import type { SafetyFloor } from "../policy/types.js"
import type { Digest } from "../identifiers.js"
import type { RoleSnapshot, RoleTemplate as CatalogRoleTemplate } from "../roles/types.js"
import type { RoleAssignment } from "../schemas.js"
import type { Charter } from "../charter/types.js"
import type { MemoryRepository } from "../../memory/ports.js"
import type { OutboxStore } from "../event-store/outbox-store.js"

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

/**
 * Port for sending prompts to an execution runtime (e.g. OpenCode daemon).
 */
export interface OpencodePromptClient {
  sendPromptAsync(sessionId: string, prompt: string, directory: string): Promise<void>
}

/**
 * Functional monitor that observes a session until it reaches an idle state.
 */
export type SessionMonitorFn = (session: Session, directory: string) => Promise<void>

/**
 * Object port that observes a session until it reaches an idle state.
 */
export interface SessionMonitorPort {
  waitForIdle(session: Session, directory: string): Promise<void>
}

export type SessionMonitor = SessionMonitorFn | SessionMonitorPort

/**
 * Stamped result of compiling an effective prompt with role templates and charter.
 */
export interface PromptCompilationResult {
  readonly systemPrompt: string
  readonly promptDigest?: Digest
  readonly compositeDigest?: Digest
  readonly roleDigests?: readonly Digest[]
}

/**
 * Injected prompt compiler function for compiling prompts with role assignments / snapshots.
 * Preserves the M4/M5 module boundary: coordinator does not import runtime/binder directly.
 */
export type PromptCompiler = (options: {
  readonly primaryRole: RoleTemplate | RoleSnapshot | CatalogRoleTemplate
  readonly secondaryRoles?: readonly (RoleTemplate | RoleSnapshot | CatalogRoleTemplate)[]
  readonly roleAssignments?: readonly RoleAssignment[]
  readonly charter?: Charter
  readonly taskPrompt?: string
}) => PromptCompilationResult

export interface CoordinatorDependencies {
  readonly log: CommandLog
  readonly now: () => Timestamp
  readonly newEventId: () => string
  readonly boundary?: EffectBoundary
  /** The current run projection, used for state preconditions. */
  readonly readRun: (runId: string) => RunProjectionState | undefined
  /** OpenCode client for delivering prompts. */
  readonly opencodeClient?: OpencodePromptClient
  /** Monitor that tracks session execution until idle. */
  readonly sessionMonitor?: SessionMonitor
  /** Alias for sessionMonitor matching ingress/runtime convention. */
  readonly monitorSession?: SessionMonitor
  /** Optional directory resolver for the target session. */
  readonly resolveProjectDir?: (
    sessionId: string,
    session?: SessionProjection,
    dispatch?: DispatchProjection,
  ) => string | undefined
  /** Budget ledger port for fan-out and concurrency capacity checks. */
  readonly budgetLedger?: BudgetLedgerPort
  /** Roundtable repository for deliberation sessions. */
  readonly roundtables?: RoundtableRepository
  /** Transport for delivering outbox runtime effects. */
  readonly effectTransport?: EffectTransport
  /** Active charter document for policy evaluation (plan §7, §10 row 1). */
  readonly charter?: Charter
  /** Charter repository storing versioned charter snapshots. */
  readonly charters?: CharterRepository
  /** Proposal repository/lifecycle manager for agent- or human-authored charter proposals. */
  readonly charterProposals?: CharterProposalRepository
  /** Safety floor for evaluating immutable core constraints. */
  readonly safetyFloor?: SafetyFloor
  /** Prompt compiler for compiling prompts with role assignments / snapshots (plan §7.1, §10). */
  readonly compilePrompt?: PromptCompiler
  /** Memory repository for writing back deliberation outcomes (plan §7, §10 row 3). */
  readonly memoryRepository?: MemoryRepository
  /** Durable outbox store backing event store outbox rows. */
  readonly outboxStore?: OutboxStore
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
  "run.pause": ["run.paused"],
  "run.resume": ["run.resumed"],
  "dispatch.propose": ["dispatch.proposed"],
  "run.cancel": ["run.cancelled"],
  // A revision is a proposal: the plan states an edited envelope creates a new
  // digest, so the revised envelope MUST be recorded or the log would no longer
  // contain what was approved/launched.
  "dispatch.approve": ["approval.invalidated", "dispatch.proposed", "approval.decided"],
  "dispatch.retry": ["dispatch.proposed", "approval.invalidated"],
  "dispatch.timeout.request": ["dispatch.timeout.requested"],
  "dispatch.execute": ["dispatch.started"],
  "session.prompt": ["session.observed"],
  "session.respond": [],
  "session.interrupt": [],
  "session.terminate": [],
  "roundtable.open": ["roundtable.opened"],
  "roundtable.post": ["roundtable.posted"],
  "roundtable.inject_human": ["roundtable.posted"],
  "roundtable.close": ["roundtable.outcome_recorded"],
  "charter.propose": ["charter.proposed"],
  "charter.approve": ["charter.revised"],
  "charter.revise": ["charter.revised"],
  "charter.reject": ["charter.rejected"],
}

export const RUNTIME_DESTINATION = "runtime.dispatch.execute"
export const MEMORY_WRITEBACK_DESTINATION = "memory.write_back"


export type { Approval, Dispatch, Run, Session, Task }

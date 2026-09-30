import type { ContractError, Result } from "../../orchestration/errors.js"
import type { Epoch, LeaseId, NodeId } from "../../orchestration/identifiers.js"
import type { AggregateStateContext, CommandType } from "../../orchestration/invariants.js"
import type { OrchestrationCommand } from "../../orchestration/types.js"
import type { HeldLease, LeaseOperation, LeaseRefusalReason } from "../protocol/lease.js"
import type { VerifiedIncomingCommand } from "../protocol/command.js"
import type { LeaseHistoryEntry, LeaseRecord, LeaseScope } from "./schemas.js"

/**
 * The ports. M4.5 (inbox/outbox), M4.6 (SSE + reconciliation), M4.7 (terminal)
 * and M4.8 (TUI) consume ONLY these, which is the point: none of them learns
 * whether a lease lives in SQLite, in a `Map`, or in a test double.
 *
 * Two ports, deliberately, following `src/mesh/registry/types.ts`:
 *
 *   - {@link ControllerLeaseStore} — the WRITE port. Exposed separately so the
 *     durable store can be driven directly, which is the only way "two controllers
 *     racing to take over, exactly one wins" is a tested property of the
 *     transaction rather than a comment about it.
 *   - {@link ControllerLease} — the read/ingest seam a gateway talks to.
 */

/**
 * The compare-and-set a lease write goes through.
 *
 * `expectedEpoch` is the epoch the caller READ, and the write applies only if the
 * stored epoch is still that value. `null` means "there was no lease for this run
 * and there must still be none", which is the same NULL-safe comparison the
 * registry's heartbeat write uses rather than a second statement — a path for
 * "no previous lease" that nobody tests is a path nobody should have written.
 *
 * This single field is what makes split brain DECIDABLE rather than merely
 * unlikely. Two controllers may both believe they are taking over from epoch 4;
 * the store admits one of them, because the other finds the row already at 5. A
 * lease store without this comparison would make the outcome a function of which
 * write landed first, and "which write landed first" is exactly the thing a
 * partition decides.
 */
export interface LeaseWrite {
  readonly scope: LeaseScope
  readonly record: LeaseRecord
  readonly expectedEpoch: Epoch | null
}

export type LeaseWriteOutcome =
  | { readonly written: true; readonly lease: LeaseRecord }
  /**
   * The row moved under the caller: someone else advanced the epoch between the
   * caller's read and its write. `current` is what the row says NOW, so the loser
   * of a takeover race is told which epoch beat it rather than being handed a
   * generic conflict and left to guess.
   */
  | { readonly written: false; readonly current: LeaseRecord | null }

export interface ControllerLeaseStore {
  /** The lease in force for a run, or `null` if the run has never been leased. */
  activeLease(scope: LeaseScope): Promise<Result<LeaseRecord | null>>
  /** The write, under the compare-and-set on the epoch. */
  writeLease(write: LeaseWrite): Promise<Result<LeaseWriteOutcome>>
  /**
   * Every lease ever accepted for a run, oldest first.
   *
   * Not on the read path anything uses for authority — the audit path, and the
   * takeover response, which has to be able to say what it superseded. A takeover
   * that can only report the lease it replaced cannot be audited, and an
   * unauditable fence is not a fence.
   */
  leaseHistory(scope: LeaseScope): Promise<Result<readonly LeaseHistoryEntry[]>>
}

/**
 * Whether new work may be created for a run, and why not if it may not.
 *
 * `reason` is the three-way answer `permitsNewWork` in `src/mesh/protocol/lease.js`
 * produces, re-exported rather than restated. The three cases are genuinely
 * different to an operator: `no_lease` means nobody has ever driven this run,
 * `expired` means whoever did has lost the room, and the difference decides
 * whether the next action is "start a controller" or "the controller you were
 * using is gone".
 */
export type NewWorkPermit =
  | { readonly permitted: true; readonly reason: "current"; readonly lease: LeaseRecord }
  | { readonly permitted: false; readonly reason: "no_lease" | "expired"; readonly lease: LeaseRecord | null }

/**
 * The nodes a node has NOT reconciled for a run.
 *
 * A read-only port, deliberately, and separate from the store. M4.6's
 * reconciliation is the only thing that can establish one, and a lease seam that
 * could set it from a wire record would let a peer decide which nodes it is
 * allowed to take over from — the acknowledgement precondition would then be
 * checking the attacker's list against itself.
 *
 * A node that has never reconciled has an EMPTY set, and that is a real
 * limitation rather than a safe default: at such a node the takeover's
 * user-inspection precondition is not enforceable, because only the node the user
 * was actually sitting at can know what was on their screen. The precondition is
 * therefore decided where the USER is — see `./lease.ts` — and a worker's copy of
 * the set is a record of what reconciliation reported, never a record of a click.
 */
export interface UnreconciledNodeSource {
  unreconciledNodeIds(scope: LeaseScope): readonly NodeId[]
}

/** What an accepted `mesh.lease` did, and what it left in force. */
export interface LeaseOperationAccepted {
  readonly outcome: "accepted"
  readonly operation: LeaseOperation
  /** Whether the lease in force was current, expired, or absent when this arrived. */
  readonly standing: "current" | "expired" | "none"
  /**
   * Whether this record, once accepted, permits NEW work.
   *
   * Straight from the protocol evaluator. A `release` answers `false` here even
   * though it is accepted, and surfacing that is the whole reason the field
   * exists: a release that read as a renewal would be the most consequential
   * possible misreading of a lease record.
   */
  readonly permitsNewWork: boolean
  /** The lease now in force. For a `release` this is the released record. */
  readonly lease: LeaseRecord
}

export interface LeaseOperationRefused {
  readonly outcome: "refused"
  readonly operation: LeaseOperation | null
  /**
   * Why the record was refused.
   *
   * The protocol evaluator's own reasons are re-used verbatim rather than
   * translated, so an operator reading a log can match the message against
   * `evaluateLease`'s own tests. The only additions are SEAM conditions rather
   * than protocol rules, and both are parse failures: `record_unreadable` and
   * `not_a_lease` describe a record this seam never interpreted. Every question
   * about authority is decided by `evaluateLease`, which is why a refusal reason
   * such as `no_lease_to_fence` needs no entry here.
   */
  readonly reason: LeaseRefusalReason | "record_unreadable" | "not_a_lease"
  readonly standing: "current" | "expired" | "none"
  readonly error: ContractError
}

/**
 * The compare-and-set was lost: another record advanced the epoch between this
 * node's read and its write.
 *
 * Its own outcome rather than a `refused`, because the two are different events
 * with different owners. A `refused` is a policy decision about a record; a
 * `write_lost` is a race this node lost, and the node that won is now the
 * authority. Reporting a lost race as a policy refusal would tell an operator
 * their takeover was malformed when it was merely late.
 */
export interface LeaseOperationWriteLost {
  readonly outcome: "write_lost"
  readonly operation: LeaseOperation
  /** The lease in force after the losing write, or `null` if the run has none. */
  readonly current: LeaseRecord | null
  readonly error: ContractError
}

export type LeaseOperationOutcome = LeaseOperationAccepted | LeaseOperationRefused | LeaseOperationWriteLost

/**
 * The read/ingest seam. M4.5, M4.6, M4.7 and M4.8 call this and nothing else.
 *
 * The four named operations exist as METHODS, not only as the record's
 * `operation` field, for two reasons. An operator-facing "take over" that is a
 * string on a record is a takeover that some future caller can reach by
 * constructing a different string; and the guardrail "do not implement
 * auto-election" is only checkable against a NAMED SURFACE — a reader asking
 * "what can raise the epoch here?" should find exactly one method and no other.
 */
export interface ControllerLease {
  /**
   * The single entry point. A record whose `operation` does not match the method
   * that called it is refused, so `claim()` cannot be used to smuggle a takeover
   * past a caller's own switch statement.
   */
  applyLease(value: unknown): Promise<LeaseOperationOutcome>

  /** Take an unheld run, or one whose lease has expired. */
  claim(value: unknown): Promise<LeaseOperationOutcome>
  /** Extend a lease this node already holds. Never changes the epoch. */
  renew(value: unknown): Promise<LeaseOperationOutcome>
  /** Give the run up. Accepted, and grants nothing. */
  release(value: unknown): Promise<LeaseOperationOutcome>
  /** The ONLY operation that may raise the epoch. See `./lease.ts`. */
  takeover(value: unknown): Promise<LeaseOperationOutcome>

  /** The stored lease for a run, or `null`. */
  lease(scope: LeaseScope): Promise<Result<LeaseRecord | null>>
  /** The stored lease reduced to what the protocol evaluator decides on. */
  heldLease(scope: LeaseScope): Promise<Result<HeldLease | null>>
  /** May this node create new work for this run right now? */
  permitsNewWork(scope: LeaseScope): Promise<Result<NewWorkPermit>>

  /**
   * Records what reconciliation reported. The ONLY mutator of the unreconciled
   * set, and it is a write, not a wire read: the set is a fact this node
   * established about itself, never one a peer supplied.
   */
  setUnreconciledNodeIds(scope: LeaseScope, nodeIds: readonly NodeId[]): void
}

export interface ControllerLeaseDependencies {
  readonly store: ControllerLeaseStore
  readonly unreconciled: UnreconciledNodeSource
  readonly now: () => number
}

// --- The command seam ----------------------------------------------------

/**
 * The recorded states a command would act in, read from the EVENT LOG.
 *
 * This port exists because the matrix check has to resolve against recorded
 * state and there is no other honest source. `validateCommandStateByType` skips
 * an arm whose value is `undefined`, which is the right kernel behaviour (an
 * unconstrained arm is genuinely unconstrained) and the wrong thing to hand a
 * REMOTE authorization decision: a resolver that returned `{}` would license
 * every command type. The gate closes that hole from the matrix's own row rather
 * than from a list maintained here — see `requiredRecordedStateEntities`.
 */
export interface RecordedCommandStateResolver {
  resolve(command: OrchestrationCommand, scope: LeaseScope): Promise<Result<AggregateStateContext>>
}

export interface CommandEpochGateDependencies {
  readonly lease: ControllerLease
  readonly recordedState: RecordedCommandStateResolver
  /**
   * This node's own id.
   *
   * Injected rather than read from configuration inside the gate because it is
   * what `verifyIncomingCommand` compares `targetNodeId` against, and a gate that
   * read its own identity from a global would be a gate whose answers depend on
   * which process initialised it first.
   */
  readonly recipientNodeId: NodeId
  readonly now: () => number
}

/**
 * Where a command stopped.
 *
 * A stage rather than a bare error code because the stages have different owners
 * and a caller reacts differently to each: `recorded_state` is M4.6's projection
 * being incomplete, `epoch_stale` is a superseded controller retrying, and
 * `matrix` is a policy question. Collapsing them into one code sends an operator
 * to whichever system they guess.
 */
export const COMMAND_GATE_STAGES = [
  "parse",
  "lease_absent",
  "lease_expired",
  "epoch_stale",
  "epoch_unregistered",
  "integrity",
  "lease_window",
  "recorded_state",
  "matrix",
] as const

export type CommandGateStage = (typeof COMMAND_GATE_STAGES)[number]

export const COMMAND_GATE_REFUSALS = [
  "not_a_command",
  "no_lease",
  "lease_expired",
  "epoch_stale",
  "epoch_unregistered",
  "write_lost",
  "not_verified",
  "command_expiry_exceeds_lease",
  "recorded_state_unavailable",
  "recorded_state_missing_run",
  "matrix_refused",
] as const

export type CommandGateRefusal = (typeof COMMAND_GATE_REFUSALS)[number]

/** What the matrix was actually asked, so a TUI can show it rather than re-derive it. */
export interface CommandMatrixDecision {
  readonly commandType: CommandType
  /**
   * The aggregates the matrix entry constrains, DERIVED from `COMMAND_MATRIX`.
   *
   * Exposed rather than recomputed by the caller: "which states did you check?"
   * has one answer, and a TUI that re-derived it from its own copy of the rules
   * would be a second copy of the rules.
   */
  readonly constrainedEntities: readonly string[]
  readonly recordedEntities: readonly string[]
}

export interface CommandAdmission {
  readonly admitted: true
  readonly stage: "admitted"
  /**
   * The verified command, from `verifyIncomingCommand`.
   *
   * Its `authorizationClaims` are POINTERS and are carried unresolved on purpose —
   * see that function's own note. The grant is whatever the recorded log holds,
   * and this seam has no business resolving a pointer.
   */
  readonly verified: VerifiedIncomingCommand
  /** The lease the decision was made against, for the audit row M4.5 writes. */
  readonly lease: LeaseRecord
  readonly matrix: CommandMatrixDecision
}

export interface CommandRefusal {
  readonly admitted: false
  readonly stage: CommandGateStage
  readonly reason: CommandGateRefusal
  readonly error: ContractError
  /**
   * The lease in force at the moment of the refusal, or `null`.
   *
   * Carried on EVERY refusal, not only the epoch ones, because "which epoch was
   * in force when this was refused" is the first question an operator asks and
   * re-deriving it from a store that may have moved on answers a different one.
   */
  readonly lease: LeaseRecord | null
  readonly matrix: CommandMatrixDecision | null
}

export type CommandGateOutcome = CommandAdmission | CommandRefusal

/**
 * The choke point.
 *
 * ONE method, and it answers exactly one question: may this `mesh.command` be
 * PERSISTED. It does not persist. That separation is deliberate and is the whole
 * reason the stale-epoch rule is provable: a command that fails a check here has
 * not been written anywhere, so "nothing is persisted" is a property of the
 * control flow rather than a claim about a rollback.
 */
export interface CommandEpochGate {
  authorize(value: unknown): Promise<CommandGateOutcome>
}

export type { LeaseHistoryEntry, LeaseId, LeaseRecord, LeaseScope }

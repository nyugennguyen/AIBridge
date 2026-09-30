import type { ContractError, Result } from "../../orchestration/errors.js"
import type {
  CommandId,
  Digest,
  DispatchId,
  Epoch,
  LeaseId,
  NodeId,
  ProjectId,
  RunId,
  SchemaVersion,
} from "../../orchestration/identifiers.js"
import type { MeshAck } from "../protocol/ack.js"
import type { VerifiedIncomingCommand } from "../protocol/command.js"
import type { RecordedAuthorization, RecordedLogReader, AuthorizationPointers } from "./authorization.js"

/**
 * M4.5's ports. M4.6 (SSE gateway and reconciliation), M4.8 (TUI) and M4.9 (the
 * two-node fault harness) consume ONLY these, which is the point: none of them
 * learns whether the inbox is SQLite, a `Map`, or a test double.
 *
 * Four ports, and the split between them is the design rather than a
 * convenience:
 *
 *   - {@link CommandInboxStore} — the WRITE port, exposed separately so the
 *     durable store can be driven directly. "A refused command leaves the table
 *     byte-identical" is a statement about a control flow, so it has to be made
 *     against the thing a write would have changed.
 *   - {@link CommandInbox} — the read/ingest seam a gateway calls.
 *   - {@link RecordedLogReader} — re-exported from `./authorization.js` because
 *     the inbox's second authorization step is a different question from the
 *     gate's and callers wire both.
 *   - {@link CommandAckEmitter} — where an ack goes. Separate so a test can
 *     observe the exact moment an ack was emitted and assert the row was already
 *     durable at it.
 */

/**
 * The scope an inbox row is filed under.
 *
 * Structurally identical to `LeaseScope` in `src/mesh/lease/schemas.ts` and
 * declared separately on purpose: the inbox is a different seam that happens to
 * key on the same two ids, and importing the lease's type would make the inbox's
 * storage layout a function of a lease module's vocabulary. M4.6's reconciliation
 * carries both and would otherwise have to reconcile two structurally identical
 * types.
 */
export interface InboxScope {
  readonly projectId: ProjectId
  readonly runId: RunId
}

/**
 * What happened to a command's RUNTIME EFFECT.
 *
 * The fourth state, `result_recorded`, exists because of R4 and it is the whole
 * point of this enum existing separately from `status`: an admitted command whose
 * effect was accepted by a peer and whose outcome was never observed is the
 * ambiguous launch Milestone 3 could not represent. See `./launch-outcome.ts`.
 *
 * `runtime_accepted` is written at `EffectBoundary.afterRuntimeAccept` — the
 * instant the peer took the effect and before the acknowledgement is committed.
 * A crash in that window leaves a row in exactly this state, which is what makes
 * the ambiguity a durable fact rather than an absence.
 */
export const INBOX_EFFECT_STATES = ["not_started", "runtime_accepted", "result_recorded"] as const

export type InboxEffectState = (typeof INBOX_EFFECT_STATES)[number]

/**
 * One admitted `mesh.command`, as persisted.
 *
 * A stored row is a persisted record and therefore carries `schemaVersion`
 * (M4-V): a row written by a build this one cannot read must be refused rather
 * than partially interpreted.
 *
 * `payloadDigest` and `semanticFingerprint` are BOTH kept, and they are not
 * interchangeable. `payloadDigest` is the wire digest the sender declared and the
 * receiver recomputed; it covers `issuedAt` and `expiresAt`, so it changes every
 * time a controller re-mints an unanswered command. `semanticFingerprint` is the
 * dedupe key, computed by the kernel's own `fingerprintCommand`, and it excludes
 * exactly those three fields. Storing only the wire digest would turn every
 * legitimate at-least-once retry into a `conflict.command_digest_conflict` — the
 * defect recorded as B8 in the Milestone 3 plan and the reason
 * `SqliteEventStore` fingerprints the way it does. See `./dedupe.ts`.
 */
export interface InboxRow {
  readonly schemaVersion: SchemaVersion
  readonly commandId: CommandId
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly dispatchId: DispatchId | null
  readonly targetNodeId: NodeId
  readonly controllerNodeId: NodeId
  readonly controllerEpoch: Epoch
  readonly leaseId: LeaseId
  readonly commandType: string
  /** The sender's declared payload digest, recomputed at the integrity step. */
  readonly payloadDigest: Digest
  /** The dedupe key. Timing fields excluded. See {@link InboxRow.semanticFingerprint}. */
  readonly semanticFingerprint: Digest
  /** Canonical JSON of the whole `mesh.command`, so a redelivery is auditable. */
  readonly commandJson: string
  readonly effectState: InboxEffectState
  /** Injected-clock instant the row became durable. A number, not a wire stamp. */
  readonly acceptedAt: number
  /** Monotonic per inbox. The order acks are emitted in. */
  readonly acceptedSequence: number
  readonly runtimeAcceptedAt: number | null
  readonly resultJson: string | null
  readonly ackEmittedAt: number | null
}

/** A row before it is written. `acceptedSequence` is assigned by the store. */
export interface NewInboxRow {
  readonly commandId: CommandId
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly dispatchId: DispatchId | null
  readonly targetNodeId: NodeId
  readonly controllerNodeId: NodeId
  readonly controllerEpoch: Epoch
  readonly leaseId: LeaseId
  readonly commandType: string
  readonly payloadDigest: Digest
  readonly semanticFingerprint: Digest
  readonly commandJson: string
  readonly acceptedAt: number
}

/**
 * The write's outcome.
 *
 * `written: false` is the CONVERGENCE branch, not an error: a redelivered command
 * that reaches the store before the duplicate check does must land on the same
 * row. Two writers converging on one row is the property at-least-once delivery
 * is built on, and a store that reported it as a conflict would report every
 * successful retry as a failure forever.
 */
export type InboxWriteOutcome =
  | { readonly written: true; readonly row: InboxRow }
  | { readonly written: false; readonly row: InboxRow }

export type InboxRowFilter = Partial<InboxScope> & {
  readonly commandId?: CommandId
  readonly effectState?: InboxEffectState
  readonly limit?: number
}

export interface CommandInboxStore {
  /** Insert, or converge onto the existing row for this `commandId`. */
  accept(row: NewInboxRow): Promise<Result<InboxWriteOutcome>>
  find(commandId: CommandId): Promise<Result<InboxRow | null>>
  listInbox(filter?: InboxRowFilter): Promise<Result<readonly InboxRow[]>>
  countInbox(filter?: InboxRowFilter): Promise<Result<number>>
  /** At `EffectBoundary.afterRuntimeAccept`. See {@link InboxEffectState}. */
  markRuntimeAccepted(commandId: CommandId, now: number): Promise<Result<InboxRow | null>>
  recordResult(commandId: CommandId, result: unknown, now: number): Promise<Result<InboxRow | null>>
  /** Stamped after the ack has been handed to the emitter, never before. */
  markAckEmitted(commandId: CommandId, now: number): Promise<Result<InboxRow | null>>
  /** The next `acceptedSequence`. Monotonic and gapless per store. */
  nextAcceptedSequence(): Promise<Result<number>>
}

/**
 * Where an ack goes.
 *
 * Called ONLY after the row is durable, and only from the inbox's serialized
 * chain, so the emitter sees acks in accept order. A gateway puts a
 * `mesh.ack` envelope on the wire here; a test reads the store from inside
 * `emit` to prove the row was already there.
 */
export interface CommandAckEmitter {
  emit(ack: MeshAck, context: { readonly commandId: CommandId; readonly acceptedSequence: number }): Promise<void>
}

/**
 * Where a command stopped in the inbox, in pipeline order.
 *
 * `authentication` is FIRST and is a stage rather than a caller-side
 * precondition because the plan's order lists it first ("authenticated and
 * authorized before persistence") and a step that lives outside the pipeline is a
 * step nothing asserts. M4.6's gateway authenticates the HTTP request; this
 * stage is the seam that records that the inbox was only ever reached through
 * an authenticated peer, so the ordering is a fact about the control flow rather
 * than a convention a future reader has to infer.
 */
export const INBOX_REFUSAL_STAGES = ["authentication", "gate", "dedupe", "authorization", "persistence"] as const

export type InboxRefusalStage = (typeof INBOX_REFUSAL_STAGES)[number]

export type CommandInboxOutcome =
  | {
      readonly outcome: "accepted"
      readonly commandId: CommandId
      readonly acceptedSequence: number
      readonly ack: MeshAck
      readonly row: InboxRow
    }
  /** The same command again. The STORED result, and nothing appended. */
  | {
      readonly outcome: "duplicate"
      readonly commandId: CommandId
      readonly acceptedSequence: number
      readonly ack: MeshAck
      readonly storedResult: unknown
      readonly row: InboxRow
    }
  /** Same `commandId`, different instructions. Nothing was written. */
  | {
      readonly outcome: "conflict"
      readonly commandId: CommandId
      readonly ack: MeshAck
      readonly error: ContractError
    }
  /** Refused. NOTHING was persisted, and no ack was emitted. */
  | {
      readonly outcome: "refused"
      readonly commandId: CommandId | null
      readonly stage: InboxRefusalStage
      readonly error: ContractError
      readonly authorization: RecordedAuthorization | null
    }

/**
 * The authenticated peer a submission arrived from.
 *
 * Carries the `nodeId` and NOTHING else. A richer claim — roles, capabilities,
 * permissions — would be a second authorization vocabulary, and the plan's rule
 * is that authority comes from the recorded log, so the only thing transport
 * identity may contribute is the answer to "who is this".
 */
export interface AuthenticatedPeer {
  readonly nodeId: NodeId
}

/**
 * The authentication step, injected.
 *
 * M4.2's `IdentityProvider.authenticate` satisfies this directly, including the
 * revocation check — which is why the port takes the raw value and not a parsed
 * envelope: the identity middleware decides before a family schema is consulted,
 * and reordering those two would let a malformed record from a revoked node read
 * as merely malformed.
 */
export interface MeshInboxAuthenticator {
  authenticate(value: unknown): Promise<Result<AuthenticatedPeer>>
}

export interface CommandInboxDependencies {
  /** Step 5. The durable write, injected so tests can drive it directly. */
  readonly store: CommandInboxStore
  /** Step 1. M4.2's identity decision, including revocation. */
  readonly authenticate: MeshInboxAuthenticator
  /** Step 2. M4.4's `MeshCommandEpochGate`. It decides admissibility; this writes. */
  readonly gate: { authorize(value: unknown): Promise<GateOutcomeLike> }
  /** Step 4. The only place a payload's pointers are resolved. */
  readonly recordedLog: RecordedLogReader
  /** Step 6. Reached only after the row is durable. */
  readonly acks: CommandAckEmitter
  readonly now: () => number
}

/**
 * The slice of M4.4's `CommandGateOutcome` the inbox reads.
 *
 * Declared structurally rather than imported so the inbox can be driven by a
 * stub gate in a test that is about the inbox, without a lease store in scope.
 * A structural type here is a widening of M4.4's own declaration, so a change to
 * the real outcome that drops a member the inbox reads is a compile error here
 * rather than a silent `undefined` at runtime.
 */
export interface GateOutcomeLike {
  readonly admitted: boolean
  readonly verified?: VerifiedIncomingCommand
  readonly stage?: string
  readonly reason?: string
  readonly error?: ContractError
}

export interface CommandInbox {
  /**
   * The one entry point. Gate order is fixed inside; see `MeshCommandInbox`.
   */
  submit(value: unknown): Promise<CommandInboxOutcome>
  /** The row for a command, or `null`. */
  lookup(commandId: CommandId): Promise<Result<InboxRow | null>>
  /** Rows for a run, in accept order. */
  list(scope: InboxScope, limit?: number): Promise<Result<readonly InboxRow[]>>
  /** The next sequence the inbox will assign, without assigning it. */
  peekAcceptedSequence(): Promise<Result<number>>
}

/** Re-exported so a consumer wires one import for the whole recorded-log surface. */
export type { AuthorizationPointers, RecordedAuthorization, RecordedLogReader }

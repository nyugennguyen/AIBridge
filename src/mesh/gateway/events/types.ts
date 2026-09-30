import type { EffectBoundary } from "../../../orchestration/coordinator/types.js"
import type { ReadGlobalOptions, SnapshotRecord, StoredRunEvent } from "../../../orchestration/event-store/types.js"
import type {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  RunId,
  Timestamp,
} from "../../../orchestration/identifiers.js"
import type { RunProjectionState } from "../../../orchestration/projections/types.js"
import type { ContractError, Result } from "../../../orchestration/errors.js"
import type { MeshEvent } from "../../protocol/event.js"
import type { SnapshotFallback } from "../../protocol/reconciliation.js"

/**
 * M4.6 — the ports the SSE event gateway, the M4-S snapshot policy and the
 * reconciliation seam are built on.
 *
 * Four of them, and the split is the design:
 *
 *   - {@link StreamedEvent} — one retained event with the gateway's OWN total
 *     order on it. The kernel's `sequence` is per-run and the mesh's
 *     `localSequence` is per-source-node, so NEITHER is a total order across the
 *     events a single SSE client reads. The gateway therefore assigns
 *     `position` at accept time, and that number is the cursor.
 *   - {@link ProjectionSnapshotStore} — the three kernel primitives M4-S wires
 *     up (`saveSnapshot` / `getSnapshot` / `readGlobal`), declared as a port so
 *     the production wiring is `SqliteEventStore` satisfying a structural type
 *     and a test can drive a fake. Declaring it structurally is what makes
 *     "these three are now reachable" a compile-time fact rather than a claim.
 *   - {@link SnapshotFallbackSource} — the ONE implementation of the M4-S
 *     policy, shared by the SSE route and the reconciler, so a cursor that has
 *     fallen out of retention and a reconnect that needs re-basing are answered
 *     by the same rule and cannot drift apart.
 *   - {@link UnacknowledgedSource} — reconciliation step 4's resend lists, read
 *     from M4.5's inbox and outbox rather than from a list kept beside the
 *     reconciler, because a second list of "what has not been acknowledged" is a
 *     second answer to a question the durable queues already answer.
 */

/**
 * The retention bound, in events.
 *
 * FINITE and named, and that is the whole point: a gateway that retained
 * everything could always answer a cursor, and would then never have to admit it
 * could not. The plan's completion criterion is "SSE resumes from a cursor OR
 * uses an explicit snapshot fallback", and the second half is only reachable if
 * the first half can fail.
 */
export const MESH_EVENT_RETENTION_MAX_EVENTS = 256

/**
 * The retention bound, in milliseconds of THIS node's clock.
 *
 * Applied to the instant the gateway accepted the event rather than to the
 * event's own `observedAt`, and the reason is clock mixing: `observedAt` is the
 * SENDER's reading, so a node whose clock runs fast would age its own events out
 * of a peer's retention window immediately, and a node running slow would keep
 * them forever. Retention is a property of the retaining node and is measured
 * with the retaining node's clock.
 */
export const MESH_EVENT_RETENTION_MAX_AGE_MS = 900_000

/** The default page size for a resume. Bounded so one client cannot ask for the world. */
export const MESH_EVENT_RESUME_LIMIT = 256

/** One retained event, carrying the gateway's own total order. */
export interface StreamedEvent {
  /**
   * The gateway's total order. Strictly increasing, gapless, assigned at accept.
   *
   * This is the SSE `id:` field and the value of `Last-Event-ID`. It is NOT the
   * kernel's run `sequence` and NOT the mesh's per-source `localSequence`, and
   * the reason is stated on the type: neither of those is a total order across a
   * stream that mixes runs and sources, and a cursor has to be one.
   */
  readonly position: number
  readonly eventId: EventId
  readonly sourceNodeId: NodeId
  readonly localSequence: number
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly eventType: string
  /** When THIS gateway accepted it, from the injected clock. Never the sender's. */
  readonly retainedFromMs: number
  /** The wire payload, so the SSE `data:` is exactly what a `mesh.event` peer parses. */
  readonly payload: MeshEvent
}

/** Why a record was not admitted to the stream. */
export type GatewayRefusalKind =
  /** The record names a `schemaVersion` this build cannot read. Upgrade the peer. */
  | "version_unsupported"
  /** The record is malformed at a version this build DOES understand. Sender bug. */
  | "record_invalid"
  /** The record parsed and is a known family, but not a `mesh.event`. */
  | "not_an_event"

/**
 * The two refusal answers, kept apart.
 *
 * `versionError` comes from `safeParseMeshEnvelope` and is the field that
 * matters operationally: `true` means the record will never parse on this build
 * however long it is retried, and `false` means the sender emitted bytes that
 * violate a shape both sides already agree on. Collapsing them into one code is
 * how a version-skewed node ends up in a retry loop that can never succeed, and
 * how a sender bug gets diagnosed as "upgrade your peer".
 */
export type GatewayPublishResult =
  | { readonly ok: true; readonly outcome: GatewayPublishOutcome }
  | {
      readonly ok: false
      readonly kind: GatewayRefusalKind
      readonly versionError: boolean
      readonly error: ContractError
    }

/**
 * What admitting (or not admitting) an event did.
 *
 * `duplicate` and `out_of_order` are SUPPRESSIONS, not errors: they carry no
 * `ContractError` because at-least-once delivery and a per-source sequence that
 * arrives behind the watermark are both the expected shape of a mesh, and an
 * error would train an operator to ignore this result. `gap` is different — a
 * position this node never emitted is a real hole, and it is refused rather than
 * skipped, for the reason `src/mesh/outbox/ingest.ts` gives.
 */
export type GatewayPublishOutcome =
  | { readonly accepted: true; readonly entry: StreamedEvent }
  | { readonly accepted: false; readonly disposition: "duplicate"; readonly eventId: EventId; readonly detail: string }
  | { readonly accepted: false; readonly disposition: "out_of_order"; readonly eventId: EventId; readonly detail: string }
  | { readonly accepted: false; readonly disposition: "gap"; readonly eventId: EventId; readonly detail: string; readonly error: ContractError }

/** The cursor. A gateway position, and nothing else. */
export type EventStreamCursor = number

export type GatewayResume =
  /**
   * Everything strictly after the cursor, in order.
   *
   * `from` is the position the next entry carries, and it is stated so a caller
   * can build a `retry:` hint without re-deriving it. `from > cursor + 1` is
   * impossible: if it were true the gateway had evicted an event the client
   * still needed, and that is the `snapshot_required` case instead.
   */
  | {
      readonly kind: "resume"
      readonly from: EventStreamCursor
      readonly head: EventStreamCursor
      readonly entries: readonly StreamedEvent[]
    }
  /**
   * The cursor has fallen out of retention, and a snapshot is served instead.
   *
   * NOT a silent jump to the head. A gateway that answered an un-honourable
   * cursor with the newest events would produce a client whose view is missing
   * everything between its cursor and the head, and nothing on the wire would say
   * so — the client would apply later events over a state it never received the
   * intervening ones for. The two `mesh.event` frames that follow are a
   * CONTINUATION; this one is a RE-BASE, and the SSE `event:` name is what
   * distinguishes them (see `./sse.ts`).
   */
  | {
      readonly kind: "snapshot_required"
      /**
       * The re-base, and why it is two members rather than one.
       *
       * `snapshotFallback` is the PROTOCOL's `mesh.reconciliation` field
       * verbatim — `runId`, `lastAppliedSequence`, `stateDigest` — so a peer
       * validates it with `snapshotFallbackSchema` and nothing in this directory
       * has to be trusted to have kept the shape. `state` is the projection it
       * digests to, and it is a sibling rather than a member of the fallback
       * because adding a field to the protocol's `snapshotFallback` would make
       * this directory's writer a second definition of a wire shape M4.1 owns.
       *
       * The client VERIFIES: `computeStateDigest(state) === stateDigest`. A
       * fallback that carried a digest but no state would be a pointer to a
       * re-base the client cannot perform, and one that carried a state but no
       * digest would be a re-base onto something nobody can vouch for.
       *
       * There is deliberately NO `entries` member. The re-base frame is a
       * CONTINUATION BOUNDARY, and a client that received a snapshot plus the
       * retained entries in one response would have to decide whether the
       * snapshot already covered them; the two are not comparable here, because
       * `lastAppliedSequence` is a per-RUN kernel sequence while `position` is
       * the gateway's cross-run order. A client that re-bases asks for the head
       * again, and the two frames it then reads are unambiguous. Carrying both
       * here would have been an overlap the client has to resolve with information
       * the wire does not give it.
       */
      readonly rebase: SnapshotRebase
      readonly head: EventStreamCursor
    }
  /**
   * The cursor cannot be honoured AND no snapshot could be produced.
   *
   * A distinct outcome from `snapshot_required` because the client's next action
   * differs: one re-bases, the other stops and tells an operator. Neither ever
   * degrades into "here is the head".
   */
  | { readonly kind: "refused"; readonly reason: "cursor_ahead" | "cursor_malformed" | "snapshot_unavailable"; readonly error: ContractError }

export interface EventGatewayDependencies {
  readonly now: () => number
  readonly retentionMaxEvents?: number
  readonly retentionMaxAgeMs?: number
  readonly resumeLimit?: number
  /** M4-S. Omitting it turns every un-honourable cursor into `snapshot_unavailable`. */
  readonly snapshots?: SnapshotFallbackSource
  /**
   * M4-S after a RESTART: the entries this node had already published.
   *
   * Without it a gateway is a cache, and a restarted process is a cache that
   * starts empty. Every position it ever handed a client is gone, so a client
   * resuming with a perfectly good cursor is told `cursor_ahead` — the refusal
   * reserved for "you are reading a different stream" — and the snapshot
   * fallback, which exists for exactly the un-honourable-cursor case, is
   * unreachable for the rest of the process's life.
   *
   * The source is the durable log, so `position` survives the restart that
   * `head()` does not. It MUST be the durable log and not a counter the caller
   * keeps alive: a source that dies with the process restores nothing, and the
   * defect returns wearing the fix's name.
   */
  readonly durableStream?: DurableStreamSource
}

/**
 * What a restarted gateway rebuilds its stream window from.
 *
 * `entries` is read ONCE, in the constructor, and must be the entries this node
 * published, in position order, oldest first. A source that returns them out of
 * order would restore a window whose floor is not its floor.
 */
export interface DurableStreamSource {
  entries(): readonly StreamedEvent[]
}

/**
 * The gateway seam.
 *
 * `publish` takes the RAW wire value, never a pre-parsed payload, for the reason
 * every other mesh seam takes one: M4-V is that there is exactly one parse entry
 * point, and a parameter typed `MeshEvent` would be an invitation to add a
 * second.
 */
export interface EventStreamGateway {
  publish(value: unknown): Promise<GatewayPublishResult>
  resume(cursor: EventStreamCursor | null, options?: GatewayResumeOptions): Promise<GatewayResume>
  /** The newest position held, or `0` when the stream is empty. */
  head(): EventStreamCursor
  /** The oldest position still retained, or `null` when nothing is retained. */
  oldestRetained(): EventStreamCursor | null
  /** The entries still held, oldest first. Retention is visible, not inferred. */
  retained(): readonly StreamedEvent[]
  /**
   * How many event ids are held for deduplication, after the retention bounds are
   * applied.
   *
   * Present because M4.10-H2 was invisible without it: the marks are what makes a
   * redelivery converge, they are private, and before this accessor their growth
   * could only be observed as heap usage — which measures an allocator rather than
   * a bound. A count a test can compare against
   * `MESH_EVENT_RETENTION_MAX_EVENTS` is a statement about the bound.
   */
  dedupeMarkCount(): number
}

/**
 * The `(projectId, runId)` a snapshot is filed under.
 *
 * Supplied by the caller of `resume` and never inferred from the retained
 * window. A gateway that guessed the scope from whatever it happened to be
 * holding would hand a client asking about run B the state of run A — a
 * cross-run disclosure caused entirely by convenience.
 */
export interface ReplayScope {
  readonly projectId: ProjectId
  readonly runId: RunId
}

export interface GatewayResumeOptions {
  readonly limit?: number
  /**
   * Required only when a fallback is needed. Its absence with an un-honourable
   * cursor produces `refused` / `snapshot_unavailable` rather than a guess.
   */
  readonly scope?: ReplayScope
}

// --- M4-S: the snapshot policy --------------------------------------------

/**
 * The three kernel primitives M4-S wires up, and ONLY those three.
 *
 * Structurally a subset of `SqliteEventStore`. Declared as a port rather than
 * imported as a class so that (a) the production wiring is a compile-time
 * assertion that `SqliteEventStore` satisfies it, and (b) a unit test can drive
 * the policy without a database — while the integration test drives it WITH
 * one, so "the policy is defined and used" is evidenced against the real store
 * rather than against a double.
 */
export interface ProjectionSnapshotStore {
  saveSnapshot(snapshot: SnapshotRecord): void
  getSnapshot(projectId: string, runId: string, aggregateType: string, aggregateId: string): SnapshotRecord | undefined
  readGlobal(options?: ReadGlobalOptions): StoredRunEvent[]
}

/**
 * The ONE place the M4-S policy is stated.
 *
 * The SSE route and the reconciler both ask this for a fallback, so "a cursor
 * that cannot be honoured gets an explicit snapshot" is a single rule rather
 * than two implementations that agree today.
 */
export interface SnapshotFallbackSource {
  /**
   * The re-base a client whose cursor cannot be honoured should apply, or `null`
   * when this node has nothing to re-base it onto.
   *
   * `null` is not a silent gap: the caller turns it into
   * `GatewayResume.kind === "refused"` with `reason: "snapshot_unavailable"`.
   * Returning a rebase is the ONLY way a client is told to re-base.
   *
   * It returns the STATE and not just the protocol's `snapshotFallback`, because
   * the three fallback fields describe a position rather than carry one: a client
   * handed `{runId, lastAppliedSequence, stateDigest}` with nothing to verify
   * against would have to trust this node's word for what it is being reset to,
   * and a client that trusted it would be applying a state no digest in the
   * handshake covers. `stateDigest` is the client's check: it recomputes
   * `computeStateDigest(state)` and refuses a mismatch, which is why the reader
   * below recomputes the digest of what it read rather than echoing the stored
   * column.
   */
  fallbackFor(scope: ReplayScope): Promise<Result<SnapshotRebase | null>>
}

/**
 * A re-base: the protocol's `snapshotFallback` plus the state it describes.
 *
 * Deliberately NOT a widening of `snapshotFallbackSchema`. The protocol owns that
 * shape, and a `SnapshotRebase` that had been folded into it would make this
 * directory a second definition of a wire field M4.1 froze.
 */
export interface SnapshotRebase {
  readonly snapshotFallback: SnapshotFallback
  readonly state: unknown
}

/**
 * M4-B hook 7, and ONLY hook 7.
 *
 * The coordinator's own `EffectBoundary` narrowed to the one member M4.6 owns,
 * for the reason M4.5 narrowed its dependency to hooks 5 and 6: a fault harness
 * that already builds a boundary for hooks 1–6 gets this one by passing the same
 * object, and `projection-updater.test.ts` asserts the OTHER seven are never
 * called from this directory.
 */
export type ProjectionBoundary = Pick<EffectBoundary, "duringProjectionUpdate">

export interface ProjectionUpdaterDependencies {
  readonly engine: { applyEvent(runId: string, event: StoredRunEvent): RunProjectionState; getProjection(runId: string): RunProjectionState | undefined; setProjection(runId: string, state: RunProjectionState): void; clear(): void }
  readonly snapshots: ProjectionSnapshotStore
  readonly boundary?: ProjectionBoundary
  readonly now: () => number
  /** Which run the snapshot is filed under when the caller does not say. */
  readonly defaultProjectId?: ProjectId
}

export interface ProjectionUpdateResult {
  readonly state: RunProjectionState
  /** `false` when the event was already applied and the snapshot was not rewritten. */
  readonly saved: boolean
  readonly snapshot: SnapshotRecord | null
}

// --- Reconciliation inputs -------------------------------------------------

export type ReconcileScope = ReplayScope

/**
 * Reconciliation step 4's resend lists, read from M4.5's durable queues.
 *
 * Ids, never payloads, and that is what makes the resend idempotent: the
 * receiver dedupes on `commandId` / `eventId`, so a resend of something already
 * applied converges instead of duplicating it.
 */
export interface UnacknowledgedSource {
  commandIds(scope: ReconcileScope, afterInboxSequence: number, limit: number): Promise<Result<readonly CommandId[]>>
  eventIds(scope: ReconcileScope, afterOutboxSequence: number, limit: number): Promise<Result<readonly EventId[]>>
}

/**
 * The resend lists over M4.5's durable queues, for the reconciler.
 *
 * Re-exported from here rather than declared in `./reconcile/types.ts` because the
 * SSE gateway and the reconciler ask the same two questions of the same rows, and a
 * second interface would be a second answer to "what has not been acknowledged" —
 * the failure mode where the reconciler believes a command is unacknowledged and
 * the gateway believes it is not, and the mesh resends work that was already
 * applied.
 */

export type { SnapshotFallback, SnapshotRecord, StoredRunEvent, RunProjectionState, ProjectId, RunId, NodeId, EventId, CommandId, Timestamp, Result, ContractError }
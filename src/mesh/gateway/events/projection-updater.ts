import { createContractError } from "../../../orchestration/errors.js"
import { timestampSchema, type ProjectId, type RunId, type Timestamp } from "../../../orchestration/identifiers.js"
import { stripUndefined } from "../../../orchestration/projections/reducer.js"
import { computeStateDigest } from "../../../orchestration/projections/reducer.js"
import type { ProjectionSnapshotStore, ProjectionUpdateResult, ProjectionUpdaterDependencies, ReplayScope } from "./types.js"
import type { SnapshotRecord, StoredRunEvent } from "../../../orchestration/event-store/types.js"
import type { RunProjectionState } from "../../../orchestration/projections/types.js"

/**
 * M4-B hook 7, and the WRITER half of M4-S.
 *
 * `ProjectionEngine.applyEvent` was the only thing in the kernel that moved a
 * projection, and nothing called it in production, so `EffectBoundary
 * .duringProjectionUpdate` was declared and typed and never invoked — and
 * `saveSnapshot` / `getSnapshot` were implemented, tested, and unreachable. This
 * class is the seam that makes all three reachable, and it is deliberately the
 * SAME seam for the hook and the write, because the two share a boundary: a
 * crash inside a projection update is the crash where the projection is
 * half-advanced and the snapshot is stale or absent, and M4.9's fault harness
 * needs a boundary that is between those two facts rather than two independent
 * ones.
 *
 * ### Why the hook fires BEFORE the reduce
 *
 * `duringProjectionUpdate` is fired on the way IN, before the reducer touches the
 * state. A crash there leaves the projection exactly as it was — a clean
 * miss-and-replay, which is the recoverable case. A crash after the reduce and
 * before the snapshot write leaves the in-memory projection ahead of the
 * persisted one, which is the case that needs a rebuild. Both are real; the
 * first is the cheaper one, and a hook that fired afterwards could never
 * reproduce it.
 *
 * ### R3: what a snapshot does and does not carry
 *
 * A snapshot is a POSITION plus the STATE at that position, and the state is a
 * `RunProjectionState` — which holds, per `dispatchId`, the CURRENT attempt's
 * envelope. Per Milestone 3's R3, a same-`dispatchId` revision REPLACES the
 * envelope: the superseded envelope is not rebuildable from a projection, and
 * this snapshot therefore must not be read as a place to look for it. The
 * superseded envelope's digest, outcome and decision survive in the EVENT LOG;
 * they do not survive here.
 *
 * So: do not add a member to `SnapshotRecord`, to `RunProjectionState`, or to the
 * `snapshotFallback` the policy emits, that would imply per-attempt envelope
 * history. A field called `attemptHistory` or `supersededEnvelopes` on a
 * snapshot would be a promise this data structure cannot keep, and a client that
 * trusted it would render an audit view with holes in it. The projection's own
 * `TaskProjection.attemptHistory` is a different thing and is not a contradiction:
 * it is the history of ATTEMPTS, each with its own recorded digest, and it is
 * populated by `dispatch.retry` adding an attempt rather than by a revision
 * replacing one.
 */
export class MeshProjectionUpdater {
  readonly #deps: ProjectionUpdaterDependencies
  readonly #defaultProjectId: ProjectId | null

  constructor(dependencies: ProjectionUpdaterDependencies) {
    this.#deps = dependencies
    this.#defaultProjectId = dependencies.defaultProjectId ?? null
  }

  /**
   * Applies one event and persists the resulting projection.
   *
   * `saved: false` when the event did not advance the state — the reducer
   * already declines a sequence at or below `lastAppliedSequence`, and rewriting
   * the snapshot for a no-op would move `createdAt` forward for a projection that
   * did not change, which is a lie about when the state was computed.
   */
  apply(event: StoredRunEvent): ProjectionUpdateResult {
    const previousSequence = this.#deps.engine.getProjection(event.runId)?.lastAppliedSequence ?? 0

    // M4-B hook 7. The one invocation in the mesh, and the reason this class
    // exists alongside the snapshot write. See the module comment for why it is
    // before the reduce.
    this.#deps.boundary?.duringProjectionUpdate?.(event.event)

    const state = this.#deps.engine.applyEvent(event.runId, event)
    if (state.lastAppliedSequence <= previousSequence) {
      return { state, saved: false, snapshot: null }
    }
    const snapshot = this.#snapshotFor(state, event)
    this.#deps.snapshots.saveSnapshot(snapshot)
    return { state, saved: true, snapshot }
  }

  /**
   * Applies a batch, in the order given, and reports how many actually advanced.
   *
   * Exists because the rebuild path and the steady-state path need the same
   * loop, and two loops is where the "was it saved" answer would start to
   * disagree between them.
   */
  applyAll(events: readonly StoredRunEvent[]): { readonly applied: number; readonly state: RunProjectionState | undefined } {
    let applied = 0
    let state: RunProjectionState | undefined
    for (const event of events) {
      const result = this.apply(event)
      state = result.state
      if (result.saved) applied += 1
    }
    return { applied, state }
  }

  /**
   * Rebuilds a run's projection from the durable log and persists the result.
   *
   * This is the path that makes `readGlobal` reachable, and it is a M4-S
   * requirement rather than a convenience: the snapshot policy is only honest if
   * the snapshot can be RECONSTRUCTED, because a node whose snapshot was lost to a
   * crash between "event committed" and "snapshot written" must still be able to
   * answer a client whose cursor it cannot honour. Without a rebuild the only
   * honest answer would be `refused`, and M4-S would degrade into "no fallback
   * exists" for exactly the node that lost one.
   *
   * `readGlobal` rather than `readStream` because the port declares only the three
   * primitives M4-S named, and adding a fourth to the port to make a rebuild
   * possible would be a way of not reaching the one the milestone asked for. The
   * global read is filtered to the run here, which is the reason the filter is
   * written by hand and not trusted to the store: this class is the only thing
   * standing between a global cursor and a cross-run projection.
   *
   * The engine is CLEARED first. A rebuild that appended to whatever the cache
   * happened to hold would produce a projection whose `lastAppliedSequence` is a
   * function of what was in memory, and a re-base built from that would be a state
   * no replay reproduces — which is the replay-equivalence property, restated at
   * the seam that would otherwise break it.
   *
   * Returns `null` for a run with no events rather than writing an empty snapshot.
   * A snapshot at sequence 0 with an empty run is a claim that this node has
   * established a state for a run it has never seen, and a client re-basing onto it
   * would be re-basing onto nothing while being told it had a position.
   */
  rebuildFromLog(scope: ReplayScope): ProjectionUpdateResult | null {
    this.#deps.engine.clear()
    const events = this.#deps.snapshots
      .readGlobal()
      .filter((event) => event.projectId === scope.projectId && event.runId === scope.runId)
      .sort((left, right) => left.sequence - right.sequence)
    if (events.length === 0) return null
    return this.applyAll(events).state === undefined ? null : this.#stateOf(scope)
  }

  /**
   * The state a rebuild produced, read back from the cache.
   *
   * Read rather than carried out of `applyAll` so the caller is handed exactly what
   * a subsequent `fallbackFor` will read from the store. A rebuild that reported a
   * state which had not been persisted would be a re-base offered from memory that
   * a restart would not reproduce.
   */
  #stateOf(scope: ReplayScope): ProjectionUpdateResult | null {
    const state = this.#deps.engine.getProjection(scope.runId)
    if (state === undefined) return null
    return { state, saved: true, snapshot: null }
  }

  /**
   * The snapshot record for a state.
   *
   * The project id is taken from the STATE, not from the caller, for the reason
   * every scope in this codebase is: a caller that supplied it could file this
   * run's projection under another project, and every later read would answer
   * with the wrong project's state.
   */
  #snapshotFor(state: RunProjectionState, event: StoredRunEvent): SnapshotRecord {
    return {
      projectId: state.run.projectId ?? this.#defaultProjectId ?? event.projectId,
      runId: state.run.runId,
      aggregateType: RUN_AGGREGATE_TYPE,
      aggregateId: state.run.runId,
      sequence: state.lastAppliedSequence,
      // `stripUndefined` because the projection carries an optional
      // `lastAppliedPosition` that is absent on a live event and present on a
      // stored one. Canonical JSON cannot encode `undefined`, and a snapshot that
      // cannot be written is a snapshot that silently does not exist.
      state: stripUndefined(withoutStreamPosition(state)),
      digest: state.stateDigest,
      createdAt: this.#createdAt(),
    }
  }

  #createdAt(): Timestamp {
    return timestampSchema.parse(new Date(this.#deps.now()).toISOString())
  }
}

/**
 * The `aggregateType` a run projection is filed under.
 *
 * One constant, and the writer and the reader both use it. Two spellings would
 * make `getSnapshot` miss for a reason that reads as "no snapshot was ever
 * written" — which is the hardest kind of missing snapshot to notice.
 */
export const RUN_AGGREGATE_TYPE = "run"

/**
 * The stored shape, minus the store's own insertion cursor.
 *
 * `lastAppliedPosition` is excluded for the reason `computeStateDigest` excludes
 * it: it is a property of HOW the events were read rather than of the state, and
 * including it would make a snapshot written by the live path differ from one
 * written by a rebuild — which is the replay-equivalence property, restated one
 * level up.
 */
function withoutStreamPosition(state: RunProjectionState): Omit<RunProjectionState, "lastAppliedPosition"> {
  const { lastAppliedPosition: _cursor, ...rest } = state
  void _cursor
  return rest
}

/**
 * The digest a snapshot's `state` digests to, recomputed from the state itself.
 *
 * Exported so the reader can VERIFY a snapshot rather than trust it: a snapshot
 * whose stored `digest` does not match its stored `state` is a row that has been
 * written by something this build does not understand, and handing it to a
 * client as a re-base would be handing it a state nobody can vouch for.
 *
 * **`stateDigest` is removed before digesting, and that is a BUG FIX rather than a
 * nicety.** `computeStateDigest` types its input as
 * `Omit<RunProjectionState, "stateDigest">` but strips only `lastAppliedPosition`
 * from whatever it is handed, so passing the stored state straight through digests a
 * payload that CONTAINS its own digest. The reducer computes `stateDigest` over the
 * state without it, so the two can never agree — and the symptom was that every
 * snapshot this writer produced was refused by this reader, which made the whole
 * M4-S fallback branch unreachable in the one case it exists for. A client performs
 * the identical subtraction before it verifies, so the check a client runs by hand
 * matches the check this reader ran.
 */
export function digestOfSnapshotState(state: unknown): string {
  const { stateDigest: _selfReferential, ...domainState } = (state ?? {}) as Record<string, unknown>
  void _selfReferential
  return computeStateDigest(domainState as unknown as Omit<RunProjectionState, "stateDigest">)
}

/**
 * A snapshot whose `digest` does not match its `state`.
 *
 * Its own function rather than an inline `createContractError` because the SSE
 * route and the reconciler both need it, and two copies of a message an operator
 * will read is two messages they will get subtly wrong.
 */
export function snapshotDigestMismatch(scope: { projectId: ProjectId; runId: RunId }, expected: string, actual: string) {
  return createContractError(
    "internal_failure",
    "mesh.snapshot_digest_mismatch",
    `The stored snapshot for ${scope.projectId}/${scope.runId} records digest ${expected} but its state digests to ${actual}. It is refused rather than served: a re-base onto a state this node cannot vouch for is worse than no re-base, because the client would stop asking for the events it is missing.`,
  )
}

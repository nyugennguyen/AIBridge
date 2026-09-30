import type { Result } from "../../../orchestration/errors.js"
import { projectIdSchema, runIdSchema } from "../../../orchestration/identifiers.js"
import { snapshotFallbackSchema } from "../../protocol/reconciliation.js"
import { digestOfSnapshotState, RUN_AGGREGATE_TYPE, snapshotDigestMismatch } from "./projection-updater.js"
import type { ProjectionSnapshotStore, ReplayScope, SnapshotFallbackSource, SnapshotRebase } from "./types.js"

/**
 * M4-S — the READER half of the snapshot policy.
 *
 * `saveSnapshot` / `getSnapshot` / `readGlobal` were implemented, tested and called
 * from nowhere, and this module plus `./projection-updater.ts` is what makes all
 * three reachable: the updater WRITES, this READS, and the wire between them is a
 * digest the client recomputes.
 *
 * ### The policy, stated once
 *
 * A client whose cursor cannot be honoured is answered with the state at a named
 * position and the digest of that state, and NEVER with the head. Three
 * consequences follow and each one is load-bearing:
 *
 *   1. **The scope comes from the caller.** {@link ReplayScope} is a parameter, not
 *      something inferred from what happens to be retained. A reader that guessed
 *      the scope from its cache would hand a client asking about run B the state of
 *      run A, and that is a cross-run disclosure caused entirely by convenience.
 *   2. **The digest is RECOMPUTED from the state, not read off the row.** The
 *      stored `digest` column is what the row CLAIMS. `getSnapshot` re-parses
 *      `state_json`, and `digestOfSnapshotState` digests the bytes that came back.
 *      A row whose column and whose bytes disagree is refused rather than served,
 *      because a re-base onto a state this node cannot vouch for is worse than no
 *      re-base: the client stops asking for the events it is missing.
 *   3. **`null` is a real answer.** "This node has no snapshot for this run" is
 *      turned by the caller into `refused` / `snapshot_unavailable`, which is a
 *      different operator action from "here is the re-base". Neither degrades into
 *      the head.
 *
 * ### R3 — what a snapshot does NOT carry
 *
 * The state is a `RunProjectionState`, and per Milestone 3's R3 a same-`dispatchId`
 * revision REPLACES the envelope, so a superseded envelope is not rebuildable from
 * a projection. This policy therefore does not promise per-attempt envelope
 * history, and there is deliberately no member here that could imply it: no
 * `attemptHistory`, no `supersededEnvelopes`, no `envelopeByAttempt`. A field of
 * that name would be a promise this data structure cannot keep, and a client that
 * trusted it would render an audit view with holes in it. The superseded
 * envelope's digest, outcome and decision survive in the EVENT LOG, which is where
 * the plan says they survive. `TaskProjection.attemptHistory` is a different thing
 * and is not a contradiction: it is the history of ATTEMPTS, each with its own
 * recorded digest, added by `dispatch.retry` rather than produced by a revision
 * replacing one.
 */
export class ProjectionSnapshotFallback implements SnapshotFallbackSource {
  readonly #store: ProjectionSnapshotStore
  readonly #aggregateType: string

  constructor(store: ProjectionSnapshotStore, aggregateType: string = RUN_AGGREGATE_TYPE) {
    this.#store = store
    this.#aggregateType = aggregateType
  }

  /**
   * Reads and VERIFIES the snapshot for a scope.
   *
   * The scope's ids are re-parsed through the kernel's own `projectIdSchema` /
   * `runIdSchema` rather than trusted as strings. `SnapshotRecord` types them as
   * branded values, but a `SnapshotRecord` that crossed a process boundary or came
   * out of a JSON round trip is a structural claim, not a verified one — and this
   * function's whole value is that what it returns is something a client can act
   * on, so a scope it cannot vouch for is refused before it is used to key a read.
   */
  async fallbackFor(scope: ReplayScope): Promise<Result<SnapshotRebase | null>> {
    const projectId = projectIdSchema.safeParse(scope.projectId)
    if (!projectId.success) return noSnapshot(scope, "the project id is not a well-formed mesh project id")
    const runId = runIdSchema.safeParse(scope.runId)
    if (!runId.success) return noSnapshot(scope, "the run id is not a well-formed mesh run id")

    const record = this.#store.getSnapshot(projectId.data, runId.data, this.#aggregateType, runId.data)
    if (record === undefined) return { ok: true, value: null }

    // The digest is recomputed from the STATE, never taken from the row's column.
    // A column and the bytes it describes that disagree are a row written by
    // something this build does not understand, and the whole M4-S contract is that
    // a client can CHECK what it was handed.
    const computed = digestOfSnapshotState(record.state)
    if (computed !== record.digest) {
      return {
        ok: false,
        error: snapshotDigestMismatch(
          { projectId: projectId.data, runId: runId.data },
          record.digest,
          computed,
        ),
      }
    }

    // `snapshotFallbackSchema.parse` rather than a hand-built literal: the fallback
    // is a WIRE field, and this directory is not allowed to be the thing that
    // decides its shape. A parse failure here is a bug in the writer, so it is
    // reported as one rather than coerced into a well-formed lie.
    const parsed = snapshotFallbackSchema.safeParse({
      runId: record.runId,
      lastAppliedSequence: record.sequence,
      stateDigest: record.digest,
    })
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          schemaVersion: 1,
          category: "internal_failure",
          code: "mesh.snapshot_fallback_unrepresentable",
          message: `The stored snapshot for ${projectId.data}/${runId.data} is at sequence ${record.sequence} and does not fit the protocol's 'snapshotFallback' shape (${parsed.error.issues[0]?.message ?? "unparseable"}). It is refused rather than re-shaped here: this directory does not get to decide what a wire field means.`,
          retryable: false,
        },
      }
    }

    return { ok: true, value: { snapshotFallback: parsed.data, state: record.state } }
  }
}

function noSnapshot(scope: ReplayScope, why: string) {
  return {
    ok: false as const,
    error: {
      schemaVersion: 1 as const,
      category: "validation" as const,
      code: "mesh.snapshot_scope_invalid",
      message: `No snapshot can be served for run ${String(scope.runId)} because ${why}. The client's cursor is still not honoured and the stream is still not continued from the head: a scope this node cannot verify is not a scope it may answer for.`,
      retryable: false,
    },
  }
}

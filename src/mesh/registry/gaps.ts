import { createContractError, type Result } from "../../orchestration/errors.js"
import { nodeIdSchema, type NodeId } from "../../orchestration/identifiers.js"
import type { SequenceGap } from "./types.js"

/**
 * The recorded sequence gaps for a node.
 *
 * A separate port rather than a seventh method on {@link NodeRegistryStore}, for the
 * same reason liveness is derived rather than stored: the ingest seam does not need
 * this, and a method on the write port that nothing on the write path calls is a
 * method the write path and the read path will eventually disagree about. M4.6's
 * reconciliation needs it — a gap is a range the controller has to ASK for — and
 * nothing else does, so it is one small interface both stores satisfy and one
 * function a consumer calls.
 */
export interface NodeRegistryGapReader {
  heartbeatGaps(nodeId: NodeId): SequenceGap[]
}

/**
 * Reads a node's gaps, whatever it is made of.
 *
 * Accepts the port rather than a concrete store so M4.6 depends on the seam and not
 * on SQLite — the same reason the rest of this directory takes a `SqliteDriver` by
 * injection. A refusal rather than an empty list when the reader cannot answer, for
 * the same reason `revocationByKeyId` is: "there are no gaps" and "we could not look"
 * have to be different values, or a storage fault silently becomes a clean
 * reconciliation report.
 */
export function readHeartbeatGaps(reader: NodeRegistryGapReader, nodeId: NodeId): Result<readonly SequenceGap[]> {
  const parsed = nodeIdSchema.safeParse(nodeId)
  if (!parsed.success) {
    return {
      ok: false,
      error: createContractError(
        "validation",
        "registry.gap_node_id_invalid",
        "Gaps were asked for under a node id that is not a wire id, so the question cannot be asked of any store.",
      ),
    }
  }
  try {
    const gaps = reader.heartbeatGaps(parsed.data)
    // Sorted and de-duplicated here rather than trusted from the store, because two
    // stores keeping the same order is one more thing to keep in step, and an
    // out-of-order gap list is exactly what makes a reconciliation resend look like
    // it is going backwards.
    const seen = new Set<number>()
    const out: SequenceGap[] = []
    for (const gap of [...gaps].sort((left, right) => left.from - right.from)) {
      if (seen.has(gap.from)) continue
      seen.add(gap.from)
      out.push(Object.freeze({ from: gap.from, to: gap.to }))
    }
    return { ok: true, value: Object.freeze(out) }
  } catch (error) {
    return {
      ok: false,
      error: createContractError(
        "internal_failure",
        "registry.gaps_unreadable",
        `The recorded heartbeat gaps could not be read (${error instanceof Error ? error.name : "an unknown error"}). Reconciliation must not conclude a node reported nothing unusual because the store that knows otherwise was unavailable.`,
      ),
    }
  }
}

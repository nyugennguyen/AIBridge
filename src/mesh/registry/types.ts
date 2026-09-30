import type { ContractError, Result } from "../../orchestration/errors.js"
import type { MeshId, NodeId } from "../../orchestration/identifiers.js"
import type { NodeKeyId } from "../identity/wire-ids.js"
import type { CapabilityRequest, CapabilityVerdict, NodeCandidate } from "./capability.js"
import type {
  CapabilitySnapshot,
  NodeLiveness,
  NodeRecord,
  RegisteredNode,
  RegistryRevocation,
} from "./schemas.js"

/**
 * The storage port, and the reason M4.4 / M4.6 / M4.7 / M4.8 never learn what a
 * registry is made of.
 *
 * Everything a consumer can ask a registry to do is answered from a `NodeRecord`
 * plus a derived `liveness`. The persistence behind it is an implementation
 * detail on this seam, and it is deliberately a SEPARATE seam from
 * `NodeRegistry` itself so that the durable store can be exercised directly —
 * which is the only way "revocation is written in the same transaction as the
 * node record" is a tested property rather than a comment.
 */

/**
 * What an enrollment writes.
 *
 * `nodeId` and `nodeKeyId` TOGETHER are the convergence key. A repeated
 * enrollment for the same pair converges onto the same row; the same `nodeId`
 * with a DIFFERENT `nodeKeyId` is refused, because §4.1 pins the exact key
 * submitted, and a second pin for one code is the shape of an intercepted
 * enrollment response.
 */
export interface NodeEnrollmentInput {
  readonly meshId: MeshId
  readonly nodeId: NodeId
  readonly nodeKeyId: NodeKeyId
  readonly displayName: string
  readonly enrolledAt: number
}

export type NodeEnrollmentOutcome =
  /** A new row. */
  | { readonly created: true; readonly node: NodeRecord }
  /**
   * The same node and the same key, offered again.
   *
   * Converging rather than erroring is the point: a node whose enrollment
   * response was lost retries, and an error would make a successful enrollment
   * look like a failure forever.
   */
  | { readonly created: false; readonly node: NodeRecord }

/** A run of sequences that were never observed. Reported, never filled in. */
export interface SequenceGap {
  readonly from: number
  readonly to: number
}

/**
 * The compare-and-set that a heartbeat write must go through.
 *
 * `expectedSequence` is the sequence the caller READ. The store applies the write
 * only if the stored sequence is still that value, which is what makes two
 * heartbeats racing on one node converge on one of them instead of both passing a
 * check each performed against its own stale read.
 */
export interface HeartbeatWrite {
  readonly nodeId: NodeId
  readonly expectedSequence: number | null
  readonly snapshot: CapabilitySnapshot
  /** The gap to record alongside, or `null`. */
  readonly sequenceGap: SequenceGap | null
  /**
   * When the gap was DETECTED, from the injected clock.
   *
   * On the write rather than read inside the store because a store that reads a
   * clock is a store whose recorded "when" cannot be asserted, and the whole point
   * of persisting a gap is that somebody can later ask how long the controller was
   * blind.
   */
  readonly detectedAt: number
}

/** `written: false` means the row moved under the caller; the write must be retried. */
export type HeartbeatWriteOutcome = { readonly written: true } | { readonly written: false }

export interface NodeRegistryStore {
  /**
   * Writes the enrollment. Idempotent for the same `(nodeId, nodeKeyId)`.
   *
   * Never called from the heartbeat path: a heartbeat does not enroll a node,
   * because §4.2's invariant is that an accepted enrollment RESPONSE is the only
   * thing that makes a node addressable.
   */
  enrollNode(input: NodeEnrollmentInput): Promise<Result<NodeEnrollmentOutcome>>

  /** The node, or `null` if it is not enrolled. */
  node(nodeId: NodeId): Promise<Result<NodeRecord | null>>

  /** Every enrolled node on a mesh, revoked ones included — the caller filters. */
  nodes(meshId: MeshId): Promise<Result<readonly NodeRecord[]>>

  /**
   * Writes a heartbeat snapshot under a compare-and-set on the sequence.
   *
   * Atomic with the sequence check BY DESIGN: evaluating the sequence verdict and
   * storing the result are two steps, and a registry that read the sequence
   * outside its write transaction would accept two out-of-order heartbeats that
   * each looked in-order against their own stale read.
   */
  writeHeartbeat(write: HeartbeatWrite): Promise<Result<HeartbeatWriteOutcome>>

  /** The revocation covering this KEY, or `null`. */
  revocationByKeyId(nodeKeyId: NodeKeyId): Promise<Result<RegistryRevocation | null>>

  /**
   * Records a revocation.
   *
   * The key index and the node record are written by ONE call so no
   * implementation can populate them separately: a lazily-populated index has
   * exactly the window in which a revoked key gets pinned, and that window is the
   * whole defect `revocationByKeyId` exists to close.
   */
  revokeNode(revocation: RegistryRevocation): Promise<Result<RegistryRevocation>>
}

/**
 * What a caller must supply. There is no default clock, deliberately: a default
 * `Date.now` is one refactor away from a test that sleeps, and a sleeping test is
 * a test that passes on a slow machine and fails on a fast one.
 */
export interface NodeRegistryDependencies {
  readonly store: NodeRegistryStore
  readonly now: () => number
}

/**
 * The read/ingest seam M4.4, M4.6, M4.7 and M4.8 consume.
 *
 * Every method that receives a wire record receives it RAW and reads it through
 * `safeParseMeshEnvelope` itself. Handing out a "pre-parsed payload" parameter
 * would make every gateway a second parse site, and the whole of M4-V is that
 * there is one.
 */
export interface NodeRegistry {
  /**
   * Records a `mesh.heartbeat`.
   *
   * The heartbeat is a CLAIM. This call stores what the node said about itself and
   * derives liveness from it; it does not authenticate the node, does not enroll
   * it, and does not grant it anything. A node that is not enrolled has no row to
   * write, and the refusal says so rather than creating one.
   *
   * Returns the union DIRECTLY rather than as `Result<HeartbeatIngestResult>`: the
   * union already has a `refused` member carrying a `ContractError`, so wrapping it
   * would give a failure two encodings and force every caller to unwrap twice to find
   * out which one it has. A store outage is reported as `refused` too, deliberately
   * — "the registry could not be read" and "this node may not be recorded" have the
   * same correct handling, which is to record nothing, and the `error` distinguishes
   * them for whoever reads the log.
   */
  recordHeartbeat(value: unknown): Promise<HeartbeatIngestResult>

  /** One node with its liveness derived at the injected clock. */
  node(nodeId: NodeId): Promise<Result<RegisteredNode | null>>

  /** Every node on a mesh, each with liveness derived at the injected clock. */
  nodes(meshId: MeshId): Promise<Result<readonly RegisteredNode[]>>

  /** Revokes a node. See {@link NodeRegistryStore.revokeNode} for the transaction. */
  revoke(input: {
    readonly nodeId: NodeId
    readonly meshId: MeshId
    readonly reason: string
    readonly revokedBy: string
    readonly revokedAt: number
  }): Promise<Result<RegistryRevocation>>

  /** The revocation covering a KEY, whatever name its node went by. */
  revocationByKeyId(nodeKeyId: NodeKeyId): Promise<Result<RegistryRevocation | null>>

  /**
   * "Does this node ADVERTISE what this dispatch asks for?"
   *
   * A candidate filter and nothing else. See `./capability.js`.
   */
  canScheduleOn(node: RegisteredNode, request: CapabilityRequest): CapabilityVerdict

  /** Every node whose advertisement matches, each with the verdict that decided it. */
  candidates(meshId: MeshId, request: CapabilityRequest): Promise<Result<readonly NodeCandidate[]>>
}

/**
 * The outcome of one heartbeat.
 *
 * Every state the protocol distinguishes has its own member, because the
 * operator's next action differs in each: a duplicate needs nothing, a gap needs
 * the range asked for, and a regression needs the node reconciled or its sequence
 * treated as forged.
 */
export type HeartbeatIngestResult =
  | {
      readonly outcome: "accepted"
      readonly nodeId: NodeId
      readonly liveness: NodeLiveness
      readonly sequenceStatus: "first" | "in-order"
      readonly negotiatedProtocolVersion: number | null
    }
  /** A retransmission of the last accepted heartbeat. Nothing was written. */
  | {
      readonly outcome: "duplicate"
      readonly nodeId: NodeId
      readonly sequenceStatus: "duplicate"
      readonly lastSequence: number
    }
  /**
   * Sequences in `[from, to]` were never seen.
   *
   * The heartbeat is still recorded — the node is demonstrably talking, and a
   * controller that let a dropped pair of heartbeats push a live node back to
   * `stale` would be refusing work because of its own transport — but the gap is
   * reported and persisted, because the node's liveness between those two instants
   * is genuinely unknown and reconciliation has to be told so.
   */
  | {
      readonly outcome: "gapped"
      readonly nodeId: NodeId
      readonly liveness: NodeLiveness
      readonly from: number
      readonly to: number
      readonly error: ContractError
    }
  /** A sequence behind the last accepted one. Refused, and nothing was written. */
  | {
      readonly outcome: "regressed"
      readonly nodeId: NodeId
      readonly lastSequence: number
      readonly error: ContractError
    }
  /**
   * The node offers no protocol version in common with this build.
   *
   * A distinct outcome from "accepted" because the node is not recorded as
   * compatible, and because a node that keeps heartbeating on an incompatible
   * version is a fact an operator must act on rather than a heartbeat to absorb.
   */
  | {
      readonly outcome: "incompatible"
      readonly nodeId: NodeId
      readonly liveness: NodeLiveness
      readonly error: ContractError
    }
  /** Refused before any write: unknown node, revoked node, wrong mesh, malformed record. */
  | { readonly outcome: "refused"; readonly nodeId: NodeId; readonly error: ContractError }

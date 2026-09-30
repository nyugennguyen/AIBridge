import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { meshIdSchema, nodeIdSchema, CURRENT_SCHEMA_VERSION, type MeshId, type NodeId } from "../../orchestration/identifiers.js"
import { nodeKeyIdSchema, type NodeKeyId } from "../identity/wire-ids.js"
import { capabilitySnapshotSchema, registryRevocationSchema, type NodeRecord, type RegistryRevocation } from "./schemas.js"
import type {
  HeartbeatWrite,
  HeartbeatWriteOutcome,
  NodeEnrollmentInput,
  NodeEnrollmentOutcome,
  NodeRegistryStore,
  SequenceGap,
} from "./types.js"

/**
 * The in-memory store: the reference for the durable one.
 *
 * It exists for two reasons, and the second is the important one.
 *
 *   1. Tests and the TUI (M4.8) can run without a database file. That is the
 *      ordinary reason, and it is not sufficient justification for a second
 *      implementation of a security-relevant store.
 *   2. **It is the specification the durable store is checked against.** Every
 *      semantic in `NodeRegistryStore` — the convergence of repeated enrollment,
 *      the refusal of a second pin for a known node, first-revocation-wins, the
 *      compare-and-set on the sequence — is written here first, in the shape that
 *      makes it obvious, and `SqliteNodeRegistryStore` has to agree with it. A
 *      durable store whose transaction semantics have drifted from the reference is
 *      the defect this pairing is here to prevent, and the way to prevent it is to
 *      have something to drift FROM.
 *
 * It is not a cache and it is not a fast path. Nothing in production may hold node
 * trust in a `Map`: a controller restart would withdraw every revocation, which
 * `node-trust.ts` already argues is worse than not offering revocation at all.
 *
 * NOT a hand-rolled serialization of the durable store either. Rows are not JSON
 * columns here, so a bug where a snapshot survives a round trip through SQLite but
 * not through a `Map` would be invisible in this file — which is exactly why
 * `registry-store.test.ts` runs the same scenarios against BOTH.
 */
export class InMemoryNodeRegistryStore implements NodeRegistryStore {
  readonly #nodes = new Map<string, NodeRecord>()
  /** Mirrors the durable store's key index, maintained in the same transition. */
  readonly #revokedByKey = new Map<string, RegistryRevocation>()
  readonly #lastSequence = new Map<string, number>()
  readonly #gaps = new Map<string, readonly SequenceGap[]>()

  async enrollNode(input: NodeEnrollmentInput): Promise<Result<NodeEnrollmentOutcome>> {
    const meshId = meshIdSchema.safeParse(input.meshId)
    if (!meshId.success) return refusal("registry.enrollment_mesh_id_invalid", "The enrollment named a mesh id that is not a valid identifier.")
    const nodeId = nodeIdSchema.safeParse(input.nodeId)
    if (!nodeId.success) return refusal("registry.enrollment_node_id_invalid", "The enrollment named a node id that is not a valid identifier.")
    const nodeKeyId = nodeKeyIdSchema.safeParse(input.nodeKeyId)
    if (!nodeKeyId.success) return refusal("registry.enrollment_key_id_invalid", "The enrollment named a node key id that is not a valid identifier.")

    const existing = this.#nodes.get(nodeId.data)
    if (existing !== undefined) {
      if (existing.revocation !== null) {
        // Revocation is TERMINAL for a node id, checked before the convergence case
        // below so that a retry of the enrollment that was just revoked cannot
        // resurrect it. A node that legitimately needs to return is a NEW identity:
        // a fresh one-time code derives a fresh `nodeId`.
        return refusal(
          "registry.enrollment_revoked",
          `Node ${nodeId.data} is revoked and cannot be enrolled again. Revocation is terminal for a node id; a machine that legitimately needs to return enrolls with a fresh one-time code, which mints a new node id.`,
        )
      }
      // The same node and the same key offered again CONVERGES. A node whose
      // enrollment response was lost retries, and an error here would make a
      // successful enrollment look like a failure forever.
      if (existing.nodeKeyId === nodeKeyId.data && existing.meshId === meshId.data) {
        return { ok: true, value: { created: false, node: existing } }
      }
      if (existing.nodeKeyId !== nodeKeyId.data) {
        return refusal(
          "registry.key_pin_conflict",
          `Node ${nodeId.data} is already enrolled with a different key. §4.1 pins the EXACT key an enrollment submitted, so a second pin for a known node is the shape of an intercepted enrollment response rather than a retry.`,
        )
      }
      return refusal("registry.enrollment_wrong_mesh", `Node ${nodeId.data} is already enrolled in mesh ${existing.meshId}, not ${meshId.data}.`)
    }

    const keyRevoked = this.#revokedByKey.get(nodeKeyId.data)
    if (keyRevoked !== undefined) {
      return refusal(
        "registry.key_revoked",
        `Key ${nodeKeyId.data} was revoked with node ${keyRevoked.nodeId} and cannot be enrolled again. A node id is derived from an enrollment code, so a revoked machine returning with a fresh code gets a fresh node id — which is why revocation is indexed by KEY and not by name.`,
      )
    }

    const record: NodeRecord = Object.freeze({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      nodeId: nodeId.data,
      meshId: meshId.data,
      nodeKeyId: nodeKeyId.data,
      displayName: input.displayName,
      enrolledAt: input.enrolledAt,
      capability: null,
      revocation: null,
    })
    this.#nodes.set(nodeId.data, record)
    return { ok: true, value: { created: true, node: record } }
  }

  async node(nodeId: NodeId): Promise<Result<NodeRecord | null>> {
    return { ok: true, value: this.#nodes.get(nodeId) ?? null }
  }

  async nodes(meshId: MeshId): Promise<Result<readonly NodeRecord[]>> {
    const out = [...this.#nodes.values()].filter((node) => node.meshId === meshId)
    return { ok: true, value: Object.freeze(out) }
  }

  async writeHeartbeat(write: HeartbeatWrite): Promise<Result<HeartbeatWriteOutcome>> {
    const snapshot = capabilitySnapshotSchema.safeParse(write.snapshot)
    if (!snapshot.success) {
      return refusal(
        "registry.capability_snapshot_invalid",
        "A capability snapshot was refused before storage because it does not satisfy capabilitySnapshotSchema.",
      )
    }
    const current = this.#nodes.get(write.nodeId)
    if (current === undefined) return { ok: true, value: { written: false } }

    // The same comparison the durable store makes in its `WHERE` clause, and for
    // the same reason: a check that is a separate step from the write is two
    // operations, and the gap between them is where two racing heartbeats both
    // look in-order against their own stale read.
    const lastSequence = this.#lastSequence.get(write.nodeId) ?? null
    if (lastSequence !== write.expectedSequence) return { ok: true, value: { written: false } }

    const revoked = existingRevocationFor(current)
    this.#nodes.set(
      write.nodeId,
      Object.freeze({ ...current, capability: Object.freeze(snapshot.data), revocation: revoked }),
    )
    this.#lastSequence.set(write.nodeId, snapshot.data.sequence)
    if (write.sequenceGap !== null) {
      const gaps = this.#gaps.get(write.nodeId) ?? []
      this.#gaps.set(write.nodeId, Object.freeze([...gaps, write.sequenceGap]))
    }
    return { ok: true, value: { written: true } }
  }

  async revocationByKeyId(nodeKeyId: NodeKeyId): Promise<Result<RegistryRevocation | null>> {
    return { ok: true, value: this.#revokedByKey.get(nodeKeyId) ?? null }
  }

  async revokeNode(revocation: RegistryRevocation): Promise<Result<RegistryRevocation>> {
    const parsed = registryRevocationSchema.safeParse(revocation)
    if (!parsed.success) {
      return refusal("registry.revocation_invalid", "A revocation was refused before storage because it does not satisfy registryRevocationSchema.")
    }
    const record = parsed.data

    // First revocation wins, idempotently. A revocation is a terminal fact operators
    // re-apply — a runbook, a retry, a second operator — and returning the ORIGINAL
    // is what stops "was this node trusted at the time of the incident" from having
    // an answer that depends on when somebody re-ran the command.
    const existing = existingRevocationFor(this.#nodes.get(record.nodeId))
    if (existing !== null) return { ok: true, value: existing }

    const keyRevoked = this.#revokedByKey.get(record.revokedKeyId)
    if (keyRevoked !== undefined) {
      return refusal(
        "registry.key_already_revoked",
        `Key ${record.revokedKeyId} is already revoked under node ${keyRevoked.nodeId}, so it cannot also be revoked under node ${record.nodeId}.`,
      )
    }

    const node = this.#nodes.get(record.nodeId)
    if (node === undefined) {
      return refusal("registry.revoke_unknown_node", `Node ${record.nodeId} is not enrolled, so there is nothing to revoke.`)
    }
    if (node.meshId !== record.meshId) {
      return refusal("registry.revoke_wrong_mesh", `Node ${record.nodeId} is enrolled in mesh ${node.meshId}; it cannot be revoked from ${record.meshId}.`)
    }

    // The node record and the key index are written in the SAME transition, and never
    // lazily on read. An enrollment arriving between the two writes is exactly the
    // window in which a revoked key gets pinned, and a lazily-populated index is the
    // kind of thing that is written correctly in the happy path and not in the one
    // that matters.
    const stamped = Object.freeze({ ...record })
    this.#nodes.set(record.nodeId, Object.freeze({ ...node, revocation: stamped }))
    this.#revokedByKey.set(stamped.revokedKeyId, stamped)
    return { ok: true, value: stamped }
  }

  /** Mirrors `SqliteNodeRegistryStore.heartbeatGaps`, for M4.6's reconciliation. */
  heartbeatGaps(nodeId: NodeId): SequenceGap[] {
    return [...(this.#gaps.get(nodeId) ?? [])]
  }

  /** The stored sequence, which is `capability.sequence` once anything is stored. */
  lastSequence(nodeId: NodeId): number | null {
    return this.#lastSequence.get(nodeId) ?? null
  }
}

function existingRevocationFor(record: NodeRecord | undefined): RegistryRevocation | null {
  return record?.revocation ?? null
}

function refusal(code: string, message: string): { ok: false; error: ContractError } {
  return { ok: false, error: createContractError("policy_denied", code, message) }
}

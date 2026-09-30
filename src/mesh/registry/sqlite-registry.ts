import type { SqliteDriver } from "../../orchestration/event-store/sqlite-driver.js"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { CURRENT_SCHEMA_VERSION, meshIdSchema, nodeIdSchema, type MeshId, type NodeId } from "../../orchestration/identifiers.js"
import { nodeKeyIdSchema, type NodeKeyId } from "../identity/wire-ids.js"
import {
  CAS_UPDATE_HEARTBEAT_SQL,
  INSERT_HEARTBEAT_GAP_SQL,
  INSERT_NODE_SQL,
  INSERT_REVOCATION_SQL,
  SELECT_HEARTBEAT_GAPS_SQL,
  SELECT_NODE_BY_ID_SQL,
  SELECT_NODE_ENROLLMENT_SQL,
  SELECT_NODES_BY_MESH_SQL,
  SELECT_REVOCATION_BY_KEY_SQL,
  SELECT_REVOCATION_BY_NODE_SQL,
  type MeshRegistryHeartbeatGapRow,
  type MeshRegistryNodeRow,
  type MeshRegistryRevocationRow,
} from "./migrations.js"
import {
  capabilitySnapshotSchema,
  parseNodeRecord,
  registryRevocationSchema,
  unreadableNodeRecord,
  type CapabilitySnapshot,
  type NodeRecord,
  type RegistryRevocation,
} from "./schemas.js"
import type {
  HeartbeatWrite,
  HeartbeatWriteOutcome,
  NodeEnrollmentInput,
  NodeEnrollmentOutcome,
  NodeRegistryStore,
  SequenceGap,
} from "./types.js"

/**
 * THIS MODULE IS ALLOWED TO TOUCH STORAGE, together with `./migrations.js` and
 * nothing else in `src/mesh/registry/`. The driver is INJECTED rather than opened
 * here, which is not a test convenience: it is what makes the durability the tests
 * exercise the same durability production runs on, rather than a second in-memory
 * path that is "basically the same" until the day the transactions differ.
 *
 * Four properties this file exists to guarantee, each stated as a test in
 * `tests/unit/mesh/registry/registry-store.test.ts`:
 *
 *   1. **The revocation and its key index are one write.** The revocation IS the
 *      key-indexed row; a node's revoked state is a join, not a second copy. So
 *      there is no window in which the node row says "not revoked" while the
 *      index says otherwise, and a revoked key cannot be re-pinned in between
 *      because there is no "in between" to re-pin it in.
 *   2. **A heartbeat write is a compare-and-set.** The sequence check sits in the
 *      `WHERE` clause of the `UPDATE`, so two heartbeats racing on one node cannot
 *      both pass a check each performed against its own stale read.
 *   3. **Repeated enrollment converges.** The same `(nodeId, nodeKeyId)` returns
 *      the existing row; a different key for a known node is refused, because §4.1
 *      pins the EXACT key submitted and a second pin for one node is the shape of
 *      an intercepted enrollment response.
 *   4. **Rows are untrusted on read.** Every row is re-validated through
 *      `parseNodeRecord`. A `capabilities` array this build does not recognise is
 *      not a capability it can honour, and "trust the shape you wrote" is how a
 *      downgrade becomes permanent the first time two versions of this controller
 *      meet.
 */

function failure(detail: string): { ok: false; error: ContractError } {
  return {
    ok: false,
    error: createContractError(
      "internal_failure",
      "registry.store_unavailable",
      `The node registry store could not answer: ${detail}. A registry that cannot be read is refused rather than treated as empty — an empty registry reads as "no nodes are enrolled", which is a claim about the mesh that a disk fault must not be able to make.`,
    ),
  }
}

function refusal(code: string, message: string): { ok: false; error: ContractError } {
  return { ok: false, error: createContractError("policy_denied", code, message) }
}

function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
}

function mapRevocation(row: MeshRegistryRevocationRow | undefined): Result<RegistryRevocation | null> {
  if (row === undefined) return { ok: true, value: null }
  const parsed = registryRevocationSchema.safeParse({
    nodeId: row.node_id,
    meshId: row.mesh_id,
    revokedKeyId: row.revoked_key_id,
    reason: row.reason,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at,
  })
  if (!parsed.success) {
    return {
      ok: false,
      error: unreadableNodeRecord(
        `A stored revocation for node ${row.node_id} does not satisfy registryRevocationSchema (${describeIssues(parsed.error.issues)}). Reading it partially would mean deciding whether a node is revoked from a record this build could not fully understand.`,
      ),
    }
  }
  return { ok: true, value: Object.freeze(parsed.data) }
}

export class SqliteNodeRegistryStore implements NodeRegistryStore {
  readonly #driver: SqliteDriver

  constructor(driver: SqliteDriver) {
    this.#driver = driver
  }

  /** Exposed so the R5/R6 structural test can read the physical columns. */
  get driver(): SqliteDriver {
    return this.#driver
  }

  async enrollNode(input: NodeEnrollmentInput): Promise<Result<NodeEnrollmentOutcome>> {
    // The ids arrive from the enrollment path, which has already parsed them, and
    // they are parsed again rather than trusted. This is the one write in the
    // directory that decides whether a machine is addressable, and an id that is
    // not an id would become a primary key that nothing else can join to.
    const meshId = meshIdSchema.safeParse(input.meshId)
    if (!meshId.success) return refusal("registry.enrollment_mesh_id_invalid", "The enrollment named a mesh id that is not a valid identifier.")
    const nodeId = nodeIdSchema.safeParse(input.nodeId)
    if (!nodeId.success) return refusal("registry.enrollment_node_id_invalid", "The enrollment named a node id that is not a valid identifier.")
    const nodeKeyId = nodeKeyIdSchema.safeParse(input.nodeKeyId)
    if (!nodeKeyId.success) return refusal("registry.enrollment_key_id_invalid", "The enrollment named a node key id that is not a valid identifier.")

    try {
      return this.#driver.transaction((): Result<NodeEnrollmentOutcome> => {
        // Revocation is checked BEFORE the convergence case below, and that ordering
        // is the whole reason the revocation lives in its own table rather than as a
        // column on the node row. A revoked node's row is still on disk — the store
        // never deletes it, because "was this node ever trusted" has to stay
        // answerable — so an enrollment for that id finds an existing row and would
        // otherwise be told "already enrolled, all good" by the very branch that
        // exists to make a LOST RESPONSE converge.
        const revoked = this.#driver.get<{ node_id: string }>(SELECT_REVOCATION_BY_NODE_SQL, nodeId.data)
        if (revoked !== undefined) {
          return refusal(
            "registry.enrollment_revoked",
            `Node ${nodeId.data} is revoked and cannot be enrolled again. Revocation is terminal for a node id; a machine that legitimately needs to return enrolls with a fresh one-time code, which mints a new node id. Clearing a revocation has to be a deliberate act, not a side effect of a retry.`,
          ) as Result<NodeEnrollmentOutcome>
        }

        const existing = this.#driver.get<{ node_key_id: string; mesh_id: string }>(
          SELECT_NODE_ENROLLMENT_SQL,
          nodeId.data,
        )

        if (existing !== undefined) {
          if (existing.node_key_id === nodeKeyId.data && existing.mesh_id === meshId.data) {
            // CONVERGE rather than error. A node whose enrollment response was lost
            // retries, and an error would make a successful enrollment look like a
            // permanent failure forever — the enrollment path is only safe because
            // the controller is expected to be idempotent at exactly this point.
            const row = this.#readNodeRow(nodeId.data)
            if (!row.ok) return row as Result<NodeEnrollmentOutcome>
            return { ok: true, value: { created: false, node: row.value } }
          }
          if (existing.node_key_id !== nodeKeyId.data) {
            return refusal(
              "registry.key_pin_conflict",
              `Node ${nodeId.data} is already enrolled with a different key. §4.1 pins the EXACT key an enrollment submitted, so a second pin for a known node is the shape of an intercepted enrollment response rather than a retry. Rotating a node's key is a revocation followed by a fresh enrollment, not a second pin.`,
            ) as Result<NodeEnrollmentOutcome>
          }
          return refusal(
            "registry.enrollment_wrong_mesh",
            `Node ${nodeId.data} is already enrolled in mesh ${existing.mesh_id}, not ${meshId.data}.`,
          ) as Result<NodeEnrollmentOutcome>
        }

        // The key index, consulted INSIDE the same transaction as the insert. This
        // is the window `verifyKeyNotRevoked` exists to close, re-checked at the
        // storage layer because M4.2's check and M4.3's write are different code
        // paths in different processes on a mesh, and "we already checked" is not a
        // property of a system with a restart in it.
        const keyRevoked = this.#driver.get<{ node_id: string }>(SELECT_REVOCATION_BY_KEY_SQL, nodeKeyId.data)
        if (keyRevoked !== undefined) {
          return refusal(
            "registry.key_revoked",
            `Key ${nodeKeyId.data} was revoked with node ${keyRevoked.node_id} and cannot be enrolled again. A node id is derived from an enrollment code, so a revoked machine returning with a fresh code gets a fresh node id — which is exactly why revocation is indexed by KEY and not by name. Revoking the name while keeping the key would have removed nothing.`,
          ) as Result<NodeEnrollmentOutcome>
        }

        this.#driver.run(
          INSERT_NODE_SQL,
          nodeId.data,
          meshId.data,
          nodeKeyId.data,
          input.displayName,
          input.enrolledAt,
          CURRENT_SCHEMA_VERSION,
        )
        const row = this.#readNodeRow(nodeId.data)
        if (!row.ok) return row as Result<NodeEnrollmentOutcome>
        return { ok: true, value: { created: true, node: row.value } }
      })
    } catch (error) {
      return failure(describeError(error))
    }
  }

  async node(nodeId: NodeId): Promise<Result<NodeRecord | null>> {
    try {
      const row = this.#driver.get<MeshRegistryNodeRow>(SELECT_NODE_BY_ID_SQL, nodeId)
      if (row === undefined) return { ok: true, value: null }
      return mapNodeRow(row)
    } catch (error) {
      return failure(describeError(error))
    }
  }

  async nodes(meshId: MeshId): Promise<Result<readonly NodeRecord[]>> {
    try {
      const rows = this.#driver.all<MeshRegistryNodeRow>(SELECT_NODES_BY_MESH_SQL, meshId)
      const out: NodeRecord[] = []
      for (const row of rows) {
        const mapped = mapNodeRow(row)
        // A single unreadable row fails the WHOLE read. Returning the readable ones
        // would be a filter that silently drops a node whose capability
        // advertisement this build cannot validate, and a node that disappears
        // from the registry is a node that stops being dispatched to — which is the
        // quietest available way to turn a parse error into an outage.
        if (!mapped.ok) return mapped
        out.push(mapped.value)
      }
      return { ok: true, value: Object.freeze(out) }
    } catch (error) {
      return failure(describeError(error))
    }
  }

  async writeHeartbeat(write: HeartbeatWrite): Promise<Result<HeartbeatWriteOutcome>> {
    const snapshot = capabilitySnapshotSchema.safeParse(write.snapshot)
    if (!snapshot.success) {
      return refusal(
        "registry.capability_snapshot_invalid",
        `A capability snapshot was refused before storage because it does not satisfy capabilitySnapshotSchema (${describeIssues(snapshot.error.issues)}). Storing it would put a row on disk that the very next read has to reject.`,
      )
    }
    if (write.sequenceGap !== null && write.sequenceGap.to < write.sequenceGap.from) {
      return refusal("registry.sequence_gap_inverted", "A recorded heartbeat sequence gap has `to` before `from`, which is not a gap.")
    }
    const serialised = JSON.stringify(snapshot.data)

    try {
      return this.#driver.transaction((): Result<HeartbeatWriteOutcome> => {
        const result = this.#driver.run(
          CAS_UPDATE_HEARTBEAT_SQL,
          snapshot.data.sequence,
          serialised,
          write.nodeId,
          write.expectedSequence,
        )
        if (result.changes === 0) {
          // The row moved under the caller. Reported rather than retried inside the
          // store, deliberately: the sequence verdict was evaluated against a read
          // the CALLER made, and only the caller knows whether the sequence it holds
          // is still the one it reasoned about.
          return { ok: true, value: { written: false } }
        }
        if (write.sequenceGap !== null) {
          this.#driver.run(
            INSERT_HEARTBEAT_GAP_SQL,
            write.nodeId,
            write.sequenceGap.from,
            write.sequenceGap.to,
            snapshot.data.observedAt,
            write.detectedAt,
          )
        }
        return { ok: true, value: { written: true } }
      })
    } catch (error) {
      return failure(describeError(error))
    }
  }

  async revocationByKeyId(nodeKeyId: NodeKeyId): Promise<Result<RegistryRevocation | null>> {
    try {
      return mapRevocation(this.#driver.get<MeshRegistryRevocationRow>(SELECT_REVOCATION_BY_KEY_SQL, nodeKeyId))
    } catch (error) {
      return failure(describeError(error))
    }
  }

  async revokeNode(revocation: RegistryRevocation): Promise<Result<RegistryRevocation>> {
    const parsed = registryRevocationSchema.safeParse(revocation)
    if (!parsed.success) {
      return refusal(
        "registry.revocation_invalid",
        `A revocation was refused before storage because it does not satisfy registryRevocationSchema (${describeIssues(parsed.error.issues)}).`,
      )
    }
    const record = parsed.data

    try {
      return this.#driver.transaction((): Result<RegistryRevocation> => {
        // First revocation wins, and repeating one is IDEMPOTENT rather than a
        // conflict. A revocation is a terminal fact that operators re-apply — a
        // runbook, a retry after a timeout, a second operator who did not see the
        // first — and returning the ORIGINAL is what keeps "was this node trusted at
        // the time of the incident" from having an answer that depends on when
        // somebody happened to re-run the command.
        const existing = this.#readRevocationRow(record.nodeId)
        if (!existing.ok) return existing as Result<RegistryRevocation>
        if (existing.value !== null) return { ok: true, value: existing.value }

        // The key index, checked in the same transaction as the insert that creates
        // it. Revoke-then-immediately-re-enrol is both the attack and the ordinary
        // retry, and this ordering is what makes the second one find the index
        // already populated before its own transaction begins.
        const keyRevoked = this.#driver.get<MeshRegistryRevocationRow>(SELECT_REVOCATION_BY_KEY_SQL, record.revokedKeyId)
        if (keyRevoked !== undefined) {
          return refusal(
            "registry.key_already_revoked",
            `Key ${record.revokedKeyId} is already revoked under node ${keyRevoked.node_id}, so it cannot also be revoked under node ${record.nodeId}. Two nodes presenting one key means the second enrollment should never have been accepted; refusing keeps the index single-valued and makes the anomaly visible instead of absorbing it.`,
          ) as Result<RegistryRevocation>
        }

        this.#driver.run(
          INSERT_REVOCATION_SQL,
          record.nodeId,
          record.meshId,
          record.revokedKeyId,
          record.reason,
          record.revokedBy,
          record.revokedAt,
        )
        const stored = this.#readRevocationRow(record.nodeId)
        if (!stored.ok) return stored as Result<RegistryRevocation>
        if (stored.value === null) {
          return failure("a revocation was written but could not be read back in the same transaction")
        }
        return { ok: true, value: stored.value }
      })
    } catch (error) {
      return failure(describeError(error))
    }
  }

  /**
   * The recorded sequence gaps for a node, oldest first. See `./gaps.js` for why
   * this is a separate port rather than a method on {@link NodeRegistryStore}, and
   * `readHeartbeatGaps` for the seam a consumer should actually call.
   */
  heartbeatGaps(nodeId: NodeId): SequenceGap[] {
    const rows = this.#driver.all<MeshRegistryHeartbeatGapRow>(SELECT_HEARTBEAT_GAPS_SQL, nodeId)
    return rows.map((row) => ({ from: row.from_sequence, to: row.to_sequence }))
  }

  #readNodeRow(nodeId: string): Result<NodeRecord> {
    const row = this.#driver.get<MeshRegistryNodeRow>(SELECT_NODE_BY_ID_SQL, nodeId)
    if (row === undefined) {
      return failure(`node ${nodeId} has no row immediately after a write that reported success`)
    }
    return mapNodeRow(row)
  }

  #readRevocationRow(nodeId: string): Result<RegistryRevocation | null> {
    return mapRevocation(this.#driver.get<MeshRegistryRevocationRow>(SELECT_REVOCATION_BY_NODE_SQL, nodeId))
  }
}

function mapNodeRow(row: MeshRegistryNodeRow): Result<NodeRecord> {
  const nodeId = nodeIdSchema.safeParse(row.node_id)
  if (!nodeId.success) {
    return { ok: false, error: unreadableNodeRecord(`node_id column is not a valid node id: ${JSON.stringify(row.node_id)}`) }
  }
  const meshId = meshIdSchema.safeParse(row.mesh_id)
  if (!meshId.success) {
    return { ok: false, error: unreadableNodeRecord(`mesh_id column is not a valid mesh id: ${JSON.stringify(row.mesh_id)}`) }
  }
  const nodeKeyId = nodeKeyIdSchema.safeParse(row.node_key_id)
  if (!nodeKeyId.success) {
    return { ok: false, error: unreadableNodeRecord(`node_key_id column is not a valid node key id: ${JSON.stringify(row.node_key_id)}`) }
  }

  let capability: CapabilitySnapshot | null = null
  if (row.capability_json !== null) {
    let decoded: unknown
    try {
      decoded = JSON.parse(row.capability_json)
    } catch {
      return {
        ok: false,
        error: unreadableNodeRecord(
          `capability_json for node ${row.node_id} is not valid JSON. It is refused rather than repaired: a column this build did not write, or one truncated by a crash mid-write, is not something to guess at.`,
        ),
      }
    }
    const parsed = capabilitySnapshotSchema.safeParse(decoded)
    if (!parsed.success) {
      return {
        ok: false,
        error: unreadableNodeRecord(
          `capability_json for node ${row.node_id} does not satisfy capabilitySnapshotSchema (${describeIssues(parsed.error.issues)}). Reading it partially would mean honouring a capability advertisement this build cannot validate.`,
        ),
      }
    }
    capability = parsed.data
  }

  // The revocation arrives by JOIN, so a node and its revocation are one row and
  // one fact. `last_heartbeat_sequence` is deliberately NOT read into the record:
  // `capability.sequence` is the sequence of the snapshot that was actually stored,
  // and a column that could disagree with the JSON is a second, competing answer to
  // "what is this node's last accepted sequence".
  const revocationResult = mapJoinedRevocation(row)
  if (!revocationResult.ok) return revocationResult

  return parseNodeRecord({
    schemaVersion: row.schema_version,
    nodeId: nodeId.data,
    meshId: meshId.data,
    nodeKeyId: nodeKeyId.data,
    displayName: row.display_name,
    enrolledAt: row.enrolled_at,
    capability,
    revocation: revocationResult.value,
  })
}

/**
 * Reads the revocation half of a LEFT JOIN.
 *
 * A matching join sets every revocation column and a non-matching join sets none, so
 * a PARTIAL row is not a shape the schema produces — it is a row from a table whose
 * columns were changed underneath this build. It is refused rather than filled in
 * with empty strings, because an empty reason on a revocation is indistinguishable
 * from a revocation that was never explained, and that distinction is the whole
 * value of the record to whoever has to audit it.
 */
function mapJoinedRevocation(row: MeshRegistryNodeRow): Result<RegistryRevocation | null> {
  if (row.revocation_node_id === null) return { ok: true, value: null }
  if (
    row.revocation_mesh_id === null ||
    row.revocation_key_id === null ||
    row.revocation_reason === null ||
    row.revocation_by === null ||
    row.revocation_at === null
  ) {
    return {
      ok: false,
      error: unreadableNodeRecord(
        `The revocation join for node ${row.node_id} returned a partial row. Half a revocation is not a revocation this build can act on, and defaulting the missing half to an empty reason or an unattributed actor would manufacture the one record nobody can audit.`,
      ),
    }
  }
  return mapRevocation({
    node_id: row.revocation_node_id,
    mesh_id: row.revocation_mesh_id,
    revoked_key_id: row.revocation_key_id,
    reason: row.revocation_reason,
    revoked_by: row.revocation_by,
    revoked_at: row.revocation_at,
  })
}

/**
 * The `code` of a driver error, never its message.
 *
 * A driver message can embed a fragment of the statement or the row that failed,
 * and a registry row carries a node's display name and key id. The code is the
 * whole of what the caller branches on, exactly as `file-key-store.ts` decides.
 */
function describeError(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code
  }
  return error instanceof Error ? error.name : "an unknown error"
}

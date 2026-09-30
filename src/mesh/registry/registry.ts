import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { meshIdSchema, nodeIdSchema, type MeshId, type NodeId } from "../../orchestration/identifiers.js"
import type { NodeKeyId } from "../identity/wire-ids.js"
import { evaluateHeartbeatFreshness, evaluateHeartbeatSequence, type MeshHeartbeat } from "../protocol/heartbeat.js"
import { safeParseMeshEnvelope } from "../protocol/registry.js"
import { MESH_PROTOCOL_VERSIONS, negotiationMismatch, supportedProtocolVersions } from "../protocol/negotiation.js"
import { defaultNodeCandidateSelector } from "./capability.js"
import type { CapabilityRequest, CapabilityVerdict, NodeCandidate } from "./capability.js"
import { registryRevocationSchema, type CapabilitySnapshot, type NodeRecord, type RegisteredNode, type RegistryRevocation } from "./schemas.js"
import type {
  HeartbeatIngestResult,
  HeartbeatWrite,
  NodeEnrollmentInput,
  NodeEnrollmentOutcome,
  NodeRegistry,
  NodeRegistryDependencies,
} from "./types.js"

/**
 * The node id a refusal carries when the record did not parse far enough to name
 * one.
 *
 * A constant rather than `null` because `HeartbeatIngestResult` is a closed union
 * with a required `nodeId`, and a closed union is worth more than a nullable field:
 * a caller pattern-matching on `outcome` cannot forget the refusal case. The value
 * is branded through the kernel's own schema for the same reason every other id in
 * this codebase is — a cast would put back the type without putting back the check
 * that the value is addressable, and this one is deliberately not.
 */
const UNIDENTIFIED_NODE = nodeIdSchema.parse("node-unidentified")

/**
 * The ingest seam, and the ONLY place a `mesh.heartbeat` becomes registry state.
 *
 * What this module deliberately does not do, because each of these is a
 * re-implementation that would eventually differ from the one it copies:
 *
 *   - **No clock.** `now` is injected. Every time-dependent decision here — TTL
 *     expiry, freshness, the journal's "detected at" — is a function of a number a
 *     caller supplied, which is what makes "ninety-one seconds after the last
 *     heartbeat" a test rather than a `setTimeout`.
 *   - **No re-implementation of freshness or sequence ordering.** Both come from
 *     `src/mesh/protocol/heartbeat.js`. Freshness and ordering answer different
 *     questions (did it arrive in time, did it arrive in order) and merging them
 *     points an operator at the wrong side of the mesh.
 *   - **No re-implementation of version negotiation.** `negotiation.ts` owns it.
 *   - **No authorization.** `canScheduleOn` is a filter; see `./capability.js`.
 *   - **No network, no framework, no filesystem.** The store is injected.
 *
 * What it does add, and why the protocol layer cannot:
 *
 *   - **A GAP is a first-class outcome.** `evaluateHeartbeatSequence` reports one;
 *     the honest thing is to record the range and say so, because the node's
 *     liveness between the two instants it did speak is genuinely unknown. The
 *     alternative — advancing the sequence silently — is the difference between a
 *     controller that can say "I missed 5 and 6" and one that cannot.
 *   - **A heartbeat never enrolls a node.** §4.2's invariant is that an accepted
 *     enrollment RESPONSE is the only thing that makes a node addressable. A node
 *     with no row is refused, and the refusal names the missing row rather than
 *     creating one.
 */

/**
 * How many times one ingest re-reads after losing a compare-and-set.
 *
 * Bounded, and the bound is the point. An unbounded retry loop against a contended
 * row is a resource-exhaustion vector that whoever can make heartbeats race gets to
 * choose the length of; four attempts covers the realistic case (two peers of the
 * same node redelivering after a partition heal) and gives up into a refusal that an
 * operator can see, which is what a redelivered heartbeat deserves.
 */
const MAX_COMPARE_AND_SET_ATTEMPTS = 4

/**
 * The freshness verdict, mapped onto the registry's vocabulary.
 *
 * The ONLY place the two vocabularies meet. `evaluateHeartbeatFreshness` speaks in
 * `fresh | stale | future`; liveness speaks in `live | stale | revoked | never-seen`.
 * A `future` heartbeat is unreachable as a STORED state — `recordHeartbeat` refuses
 * it before it writes — so the only way to read one back is a clock that moved
 * backwards between the write and the read. It maps to `stale` and not to `live`:
 * liveness means "this node spoke recently enough for us to act on what it said",
 * and a timestamp no local clock can corroborate is not that.
 */
export function deriveLiveness(
  record: NodeRecord,
  nowMs: number,
): Pick<RegisteredNode, "liveness" | "lastHeartbeatAt" | "ageMs" | "negotiatedProtocolVersion"> {
  if (record.revocation !== null) {
    // `revoked` is checked first because it is the only one of the four that
    // survives a fresh heartbeat. Checking it anywhere else would let a node that
    // keeps talking after revocation report itself as `live` — which is precisely
    // what a node that does not know it was revoked will do.
    return { liveness: "revoked", lastHeartbeatAt: record.capability?.observedAt ?? null, ageMs: null, negotiatedProtocolVersion: record.capability?.negotiatedProtocolVersion ?? null }
  }
  if (record.capability === null) {
    return { liveness: "never-seen", lastHeartbeatAt: null, ageMs: null, negotiatedProtocolVersion: null }
  }
  const freshness = freshnessOf(record.capability.observedAt, nowMs)
  return {
    liveness: freshness.state === "fresh" ? "live" : "stale",
    lastHeartbeatAt: record.capability.observedAt,
    ageMs: freshness.ageMs,
    negotiatedProtocolVersion: record.capability.negotiatedProtocolVersion,
  }
}

/**
 * `evaluateHeartbeatFreshness` for a STORED observation.
 *
 * The function takes a `MeshHeartbeat` and reads exactly one field of it,
 * `observedAt`, which is why the narrowed argument is safe: a stored snapshot is
 * the heartbeat payload with `meshId`, `nodeId` and the node's own `liveness` claim
 * filtered out (see `./schemas.ts` for why each of those is dropped), and every
 * field the evaluator can reach is present. Re-deriving the comparison here instead
 * would be the thing that later drifts from the protocol package — two TTLs, one of
 * which is the one the tests read.
 */
function freshnessOf(observedAt: string, nowMs: number) {
  return evaluateHeartbeatFreshness({ observedAt } as MeshHeartbeat, nowMs)
}

function toRegisteredNode(record: NodeRecord, nowMs: number): RegisteredNode {
  return Object.freeze({ node: record, ...deriveLiveness(record, nowMs) })
}

function refuse(nodeId: NodeId, error: ContractError): HeartbeatIngestResult {
  return { outcome: "refused", nodeId, error }
}

/**
 * The protocol version this build will act on for a given node.
 *
 * TWO checks, and the second is not redundant with the first. The heartbeat's
 * `protocolVersions[]` is the node's claim about itself; the envelope's
 * `protocolVersion` is the dialect of the record that actually arrived. A node
 * whose payload lists a version this build speaks while its envelope is written at
 * a dialect it does not is a node whose fields cannot be interpreted consistently,
 * and there is no safe way to proceed on "the parts I happen to understand".
 */
function negotiateFor(envelopeProtocolVersion: number, payload: MeshHeartbeat): Result<number> {
  if (!(MESH_PROTOCOL_VERSIONS as readonly number[]).includes(envelopeProtocolVersion)) {
    return {
      ok: false,
      error: createContractError(
        "unsupported_capability",
        "protocol.envelope_version_unsupported",
        `The heartbeat envelope declares mesh protocol version ${envelopeProtocolVersion}, which this build does not speak (it speaks [${MESH_PROTOCOL_VERSIONS.join(", ")}]). The record is stored and reported as incompatible, never partially read and never downgraded onto a version this build happens to parse.`,
      ),
    }
  }
  const negotiated = negotiationMismatch(payload.protocolVersions, supportedProtocolVersions())
  if (!negotiated.ok) return { ok: false, error: negotiated.error }
  return { ok: true, value: negotiated.version }
}

/**
 * The filtered copy of a heartbeat payload that gets stored.
 *
 * Three wire fields are dropped and the reasons are in `./schemas.ts`: `liveness`
 * is the node's claim rather than the controller's answer, and `meshId`/`nodeId`
 * are already the row's identity. `protocolVersions` is kept AND the negotiated
 * version is computed, because "what the node said it speaks" and "what both sides
 * actually agreed" are different facts and an operator debugging a version skew
 * needs the first one to diagnose the second.
 */
function snapshotFor(heartbeat: MeshHeartbeat, negotiatedProtocolVersion: number | null): CapabilitySnapshot {
  return {
    observedAt: heartbeat.observedAt,
    sequence: heartbeat.sequence,
    runtimeKinds: [...heartbeat.runtimeKinds],
    capabilities: [...heartbeat.capabilities],
    projectPathIds: [...heartbeat.projectPathIds],
    maxConcurrentSessions: heartbeat.maxConcurrentSessions,
    agentCount: heartbeat.agentCount,
    load: { ...heartbeat.load },
    offeredProtocolVersions: [...heartbeat.protocolVersions],
    negotiatedProtocolVersion,
  }
}

export class MeshNodeRegistry implements NodeRegistry {
  readonly #store: NodeRegistryDependencies["store"]
  readonly #now: () => number

  constructor(dependencies: NodeRegistryDependencies) {
    this.#store = dependencies.store
    this.#now = dependencies.now
  }

  /**
   * Enrollment.
   *
   * A free function rather than a method on {@link NodeRegistry} on purpose: the
   * read/ingest seam above exists for nodes that are already enrolled, and §4.2
   * makes an accepted enrollment RESPONSE the only thing that makes a node
   * addressable. Putting `enroll` next to `recordHeartbeat` would invite a caller
   * to treat "I have a node id and a key" as equivalent to "this node enrolled",
   * and those are different facts. M4.2's enrollment path takes the STORE seam for
   * exactly this write.
   */
  static enroll(store: NodeRegistryDependencies["store"], input: NodeEnrollmentInput): Promise<Result<NodeEnrollmentOutcome>> {
    return store.enrollNode(input)
  }

  async recordHeartbeat(value: unknown): Promise<HeartbeatIngestResult> {
    // Parsed through the ONE entry point, here rather than by the caller. Handing
    // out a "pre-parsed payload" parameter would make every gateway a second parse
    // site, and the whole of M4-V is that there is one.
    const parsed = safeParseMeshEnvelope(value)
    if (!parsed.ok) return this.#refuseUnparseable(parsed.error)
    const envelope = parsed.value
    if (envelope.recordType !== "mesh.heartbeat") {
      return this.#refuseUnparseable(
        createContractError(
          "validation",
          "registry.not_a_heartbeat",
          `Expected a mesh.heartbeat and received '${envelope.recordType}'. The registry ingests heartbeats and nothing else; a command or a lease offered here is a caller wiring defect, not a record this seam should interpret.`,
        ),
      )
    }

    const heartbeat = envelope.payload
    const nowMs = this.#now()

    // IDENTITY FIRST, then the claim's validity, then the write. A revoked node is
    // told it is revoked whatever its timestamps say: the operator's decision
    // outranks a claim's self-consistency, and a revoked node whose clock has drifted
    // should not be handed a clock-skew error it will try to "fix" by resyncing.
    // Every check below refuses before any write, so the order decides only which
    // refusal an operator reads — and it is the order a reader of the log expects:
    // "who is this" before "is what it said usable".
    const known = await this.#store.node(heartbeat.nodeId)
    if (!known.ok) return refuse(heartbeat.nodeId, known.error)
    const record = known.value
    if (record === null) {
      return refuse(
        heartbeat.nodeId,
        createContractError(
          "policy_denied",
          "registry.node_not_enrolled",
          `Node ${heartbeat.nodeId} sent a heartbeat but has no enrollment record. A heartbeat authenticates nothing, enrolls nothing, and creates nothing: §4.2 makes an accepted enrollment response the only thing that makes a node addressable, and a row created by a heartbeat would be a row created by an unauthenticated peer.`,
        ),
      )
    }
    if (record.revocation !== null) {
      return refuse(
        heartbeat.nodeId,
        createContractError(
          "policy_denied",
          "registry.node_revoked",
          `Node ${heartbeat.nodeId} is revoked and its heartbeat is not recorded. Revocation is terminal, and it is checked on the way in rather than after the write so that a revoked node's liveness never appears to recover.`,
        ),
      )
    }
    if (record.meshId !== heartbeat.meshId) {
      return refuse(
        heartbeat.nodeId,
        createContractError(
          "policy_denied",
          "registry.node_wrong_mesh",
          `Node ${heartbeat.nodeId} is enrolled in mesh ${record.meshId}, not ${heartbeat.meshId}. Tailscale reachability is not a cross-mesh grant, and neither is a heartbeat.`,
        ),
      )
    }

    // FRESHNESS, decided before the write rather than decorating it. A heartbeat
    // observed in the future is refused outright rather than stored: recording it
    // would make the registry report this node as `live` for the whole TTL on the
    // strength of a timestamp no local clock can corroborate, and the node's next
    // honest heartbeat would then arrive as a GAP — which is the correct and visible
    // outcome, and the reason refusing is better than writing even though it costs a
    // sequence number.
    //
    // A heartbeat that is merely STALE is written, and derives to `stale`. The node
    // reached out; the claim is just too old to honour. Refusing it would keep an
    // even older advertisement on file and hide the reach.
    const freshness = evaluateHeartbeatFreshness(heartbeat, nowMs)
    if (freshness.state === "future") return refuse(heartbeat.nodeId, freshness.error)

    const negotiation = negotiateFor(envelope.protocolVersion, heartbeat)
    const negotiatedProtocolVersion = negotiation.ok ? negotiation.value : null

    // The retry loop. Each attempt re-reads the stored sequence and re-evaluates
    // against it, because the alternative — checking once and writing on the result
    // — is a TOCTOU between two heartbeats for the same node, and two of them
    // arriving together is the ordinary case after a partition heal, not an exotic
    // one. Bounded by MAX_COMPARE_AND_SET_ATTEMPTS for the reason given there.
    for (let attempt = 0; attempt < MAX_COMPARE_AND_SET_ATTEMPTS; attempt += 1) {
      let currentRecord: NodeRecord | null = record
      if (attempt > 0) {
        const reread = await this.#store.node(heartbeat.nodeId)
        if (!reread.ok) return refuse(heartbeat.nodeId, reread.error)
        currentRecord = reread.value
      }
      if (currentRecord === null || currentRecord.revocation !== null) {
        return refuse(
          heartbeat.nodeId,
          createContractError(
            "conflict",
            "registry.node_state_changed",
            `Node ${heartbeat.nodeId} changed state while this heartbeat was being ingested. Re-reading and retrying is the caller's next step; nothing was written.`,
          ),
        )
      }
      const previousSequence = currentRecord.capability?.sequence ?? null
      const verdict = evaluateHeartbeatSequence(previousSequence, heartbeat.sequence)

      if (verdict.status === "duplicate") {
        // A retransmission of the last accepted heartbeat. NOTHING is written: the
        // stored advertisement is already the one this heartbeat carries, and
        // rewriting it would move `observedAt` backwards onto a claim that is
        // demonstrably older than the one on file.
        return { outcome: "duplicate", nodeId: heartbeat.nodeId, sequenceStatus: "duplicate", lastSequence: previousSequence ?? 0 }
      }
      if (verdict.status === "regressed") {
        return {
          outcome: "regressed",
          nodeId: heartbeat.nodeId,
          lastSequence: previousSequence ?? 0,
          error: verdict.error ?? createContractError("stale_epoch", "mesh.heartbeat_sequence_regressed", "Heartbeat sequence went backwards."),
        }
      }

      const write: HeartbeatWrite = {
        nodeId: heartbeat.nodeId,
        expectedSequence: previousSequence,
        snapshot: snapshotFor(heartbeat, negotiatedProtocolVersion),
        // A gap is RECORDED WITH the heartbeat, not instead of it. The node is
        // demonstrably talking — refusing its advertisement because the controller's
        // own transport dropped a pair of heartbeats would be refusing work for a
        // reason that is not the node's fault and is not the node's fix. The range
        // goes to disk so reconciliation can ask for it.
        sequenceGap: verdict.status === "gap" ? { from: verdict.from, to: verdict.to } : null,
        detectedAt: nowMs,
      }

      const applied = await this.#store.writeHeartbeat(write)
      if (!applied.ok) return refuse(heartbeat.nodeId, applied.error)
      if (!applied.value.written) continue

      const stored = await this.#store.node(heartbeat.nodeId)
      if (!stored.ok) return refuse(heartbeat.nodeId, stored.error)
      if (stored.value === null) {
        return refuse(
          heartbeat.nodeId,
          createContractError("internal_failure", "registry.node_vanished", `Node ${heartbeat.nodeId} was written and then could not be read back.`),
        )
      }
      const node = toRegisteredNode(stored.value, nowMs)

      if (verdict.status === "gap") {
        return {
          outcome: "gapped",
          nodeId: heartbeat.nodeId,
          liveness: node.liveness,
          from: verdict.from,
          to: verdict.to,
          error: verdict.error ?? createContractError("conflict", "mesh.heartbeat_sequence_gap", "Heartbeat sequence gap."),
        }
      }
      if (!negotiation.ok) {
        return { outcome: "incompatible", nodeId: heartbeat.nodeId, liveness: node.liveness, error: negotiation.error }
      }
      return {
        outcome: "accepted",
        nodeId: heartbeat.nodeId,
        liveness: node.liveness,
        sequenceStatus: verdict.status === "first" ? "first" : "in-order",
        negotiatedProtocolVersion,
      }
    }

    return refuse(
      heartbeat.nodeId,
      createContractError(
        "conflict",
        "registry.heartbeat_contended",
        `Lost the heartbeat compare-and-set ${MAX_COMPARE_AND_SET_ATTEMPTS} times for node ${heartbeat.nodeId}, so nothing was written. The row is being written by someone else at the rate this controller can read; retrying further would be a resource-exhaustion lever on whoever is driving the contention.`,
      ),
    )
  }

  async node(nodeId: NodeId): Promise<Result<RegisteredNode | null>> {
    const found = await this.#store.node(nodeId)
    if (!found.ok) return found
    return { ok: true, value: found.value === null ? null : toRegisteredNode(found.value, this.#now()) }
  }

  async nodes(meshId: MeshId): Promise<Result<readonly RegisteredNode[]>> {
    const found = await this.#store.nodes(meshId)
    if (!found.ok) return found
    const nowMs = this.#now()
    return { ok: true, value: Object.freeze(found.value.map((record) => toRegisteredNode(record, nowMs))) }
  }

  async revoke(input: {
    readonly nodeId: NodeId
    readonly meshId: MeshId
    readonly reason: string
    readonly revokedBy: string
    readonly revokedAt: number
  }): Promise<Result<RegistryRevocation>> {
    const meshId = meshIdSchema.safeParse(input.meshId)
    if (!meshId.success) return invalid("registry.revoke_mesh_id_invalid", "The revocation named a mesh id that is not a valid identifier.")
    const nodeId = nodeIdSchema.safeParse(input.nodeId)
    if (!nodeId.success) return invalid("registry.revoke_node_id_invalid", "The revocation named a node id that is not a valid identifier.")

    const found = await this.#store.node(nodeId.data)
    if (!found.ok) return found
    const record = found.value
    if (record === null) {
      return invalid(
        "registry.revoke_unknown_node",
        `Node ${nodeId.data} is not enrolled, so there is nothing to revoke. Refusing is the point: a typo in a node id must not create a revocation record that an operator later reads as "this machine was removed from the mesh".`,
      )
    }
    if (record.meshId !== meshId.data) {
      return invalid("registry.revoke_wrong_mesh", `Node ${nodeId.data} is enrolled in mesh ${record.meshId}; it cannot be revoked from ${meshId.data}.`)
    }
    // Idempotent, and the ORIGINAL record is returned. See the store's comment: a
    // revocation is a terminal fact operators re-apply, and the audit question it
    // has to answer is "was this node trusted at the time of the incident".
    if (record.revocation !== null) return { ok: true, value: record.revocation }

    // The pinned key is taken from the ENROLLED RECORD, never from the caller. A
    // caller that supplied `revokedKeyId` would be supplying the thing the
    // revocation is supposed to derive, and the key index would then be indexed by
    // whatever the caller felt like writing.
    const candidate = registryRevocationSchema.safeParse({
      nodeId: record.nodeId,
      meshId: record.meshId,
      revokedKeyId: record.nodeKeyId,
      reason: input.reason,
      revokedBy: input.revokedBy,
      revokedAt: input.revokedAt,
    })
    if (!candidate.success) {
      return invalid(
        "registry.revocation_invalid",
        `The revocation was refused because it does not satisfy registryRevocationSchema (${candidate.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}). A revocation must state a reason and name who performed it: an unexplained revocation is indistinguishable from a mistake, and an unattributable one from a compromise of the controller itself.`,
      )
    }
    return this.#store.revokeNode(candidate.data)
  }

  async revocationByKeyId(nodeKeyId: NodeKeyId): Promise<Result<RegistryRevocation | null>> {
    return this.#store.revocationByKeyId(nodeKeyId)
  }

  canScheduleOn(node: RegisteredNode, request: CapabilityRequest): CapabilityVerdict {
    return defaultNodeCandidateSelector.canScheduleOn(node, request)
  }

  async candidates(meshId: MeshId, request: CapabilityRequest): Promise<Result<readonly NodeCandidate[]>> {
    const found = await this.nodes(meshId)
    if (!found.ok) return found
    return { ok: true, value: defaultNodeCandidateSelector.select(found.value, request) }
  }

  async #refuseUnparseable(error: ContractError): Promise<HeartbeatIngestResult> {
    return refuse(UNIDENTIFIED_NODE, error)
  }
}

function invalid(code: string, message: string): { ok: false; error: ContractError } {
  return { ok: false, error: createContractError("policy_denied", code, message) }
}

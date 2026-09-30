import { z } from "zod"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import { meshIdSchema, nodeIdSchema, projectPathIdSchema, timestampSchema } from "../../orchestration/identifiers.js"
import { MAX_HEARTBEAT_AGE_MS } from "./bounds.js"
import { defineFamily, sameId } from "./envelope.js"
import { ARRAY_MAX, protocolVersionListSchema } from "./identifiers.js"

/**
 * `mesh.heartbeat` — what a node says about itself.
 *
 * A heartbeat is a CLAIM, never a grant. Nothing in this record authorizes
 * anything: the project allowlist, `projectPathSchema.allowedCapabilities` and
 * the dispatch envelope's `permissionEnvelope` remain the only authorities, and
 * a node advertising `capabilities: ["*"]` changes nothing. That is written down
 * here rather than in a handler because the tempting implementation — "the
 * controller looks for the node that advertises `fs.write`" — is a
 * capability-negotiation design that would silently move the authority from the
 * recorded log to a heartbeat, which is precisely the M3 blocker M4 must not
 * reintroduce across a node boundary.
 */

export const heartbeatLoadSchema = z
  .object({
    activeSessions: z.number().int().nonnegative().safe(),
    queuedSessions: z.number().int().nonnegative().safe(),
  })
  .strict()

export const meshHeartbeatSchema = z
  .object({
    meshId: meshIdSchema,
    nodeId: nodeIdSchema,
    observedAt: timestampSchema,
    /**
     * Per-node monotonic, starting at 1. A heartbeat whose sequence repeats or
     * goes backwards is a node whose clock or state was rolled back — a
     * restarted process is expected to RESET, which the reconcile path handles
     * explicitly, and silently accepting the reset would let a resurrected node
     * overwrite fresher liveness with stale liveness.
     */
    sequence: z.number().int().positive().safe(),
    /**
     * A single-member literal rather than a bare boolean. The field exists so
     * that adding `draining` or `degraded` later is a VERSION BUMP on a named
     * axis; a bare boolean would have forced those meanings onto the same value
     * space, which is the same unversionable move that broke `session.state` in
     * Milestone 3.
     */
    liveness: z.literal("live"),
    runtimeKinds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)).max(ARRAY_MAX),
    capabilities: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)).max(ARRAY_MAX),
    /**
     * `projectPathId`s, not free-form paths. A path string from a remote node
     * would be an assertion about the remote filesystem that the controller
     * cannot check; a `projectPathId` is resolved against bindings the
     * controller itself recorded, so the reference is verifiable.
     */
    projectPathIds: z.array(projectPathIdSchema).max(ARRAY_MAX),
    maxConcurrentSessions: z.number().int().positive().safe(),
    /** MESH protocol versions this build speaks, for §5 negotiation. */
    protocolVersions: protocolVersionListSchema,
    agentCount: z.number().int().nonnegative().safe(),
    load: heartbeatLoadSchema,
  })
  .strict()
  .superRefine((heartbeat, ctx) => {
    if (heartbeat.load.activeSessions > heartbeat.maxConcurrentSessions) {
      ctx.addIssue({
        code: "custom",
        path: ["load", "activeSessions"],
        message: `A node reporting ${heartbeat.load.activeSessions} active sessions cannot also advertise a ceiling of ${heartbeat.maxConcurrentSessions}; one of the two is a lie`,
      })
    }
    // NOT checked: `activeSessions + queuedSessions <= maxConcurrentSessions`.
    // A node that has already launched a session and has since lowered its own
    // ceiling is over-admitted, not lying, and refusing its heartbeat would hide
    // the sessions that are actually running — which is the exact difference
    // reconciliation step 5 exists to find. Over-admission is a controller
    // decision, not a wire-validity question.
    if (heartbeat.agentCount < heartbeat.load.activeSessions) {
      ctx.addIssue({
        code: "custom",
        path: ["agentCount"],
        message: `agentCount ${heartbeat.agentCount} is below the reported active session count ${heartbeat.load.activeSessions}`,
      })
    }
  })

export const heartbeatFamily = defineFamily({
  recordType: "mesh.heartbeat",
  payloadSchema: meshHeartbeatSchema,
  refine: (envelope, ctx) => {
    // A heartbeat is the one family that is legitimately broadcast, so
    // `recipientNodeId` may be null. When it is NOT null it must be the node the
    // heartbeat claims to be about, or a controller would accept a report about
    // node C that node B sent.
    if (envelope.recipientNodeId !== null && !sameId(envelope.recipientNodeId, envelope.payload.nodeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["recipientNodeId"],
        message: `A heartbeat addressed to a specific node must report on that node; '${envelope.recipientNodeId}' cannot read a report about '${envelope.payload.nodeId}'`,
      })
    }
    if (!sameId(envelope.senderNodeId, envelope.payload.nodeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["senderNodeId"],
        message: `A heartbeat is a first-person report; sender '${envelope.senderNodeId}' cannot report on '${envelope.payload.nodeId}'`,
      })
    }
  },
})

export type MeshHeartbeat = z.infer<typeof meshHeartbeatSchema>
export type HeartbeatLoad = z.infer<typeof heartbeatLoadSchema>

export type HeartbeatFreshness =
  | { readonly state: "fresh"; readonly ageMs: number }
  | { readonly state: "stale"; readonly ageMs: number; readonly error: ContractError }
  | { readonly state: "future"; readonly ageMs: number; readonly error: ContractError }

/**
 * Whether a heartbeat is still inside `MAX_HEARTBEAT_AGE_MS`.
 *
 * `nowMs` is a parameter, not a clock read, so M4.3's "clock-controlled
 * expiration" test advances time without waiting for it. "Stale" is NOT
 * "revoked": a stale node's capabilities are not honoured, but its identity
 * remains valid, because a node that went quiet is a node that will come back
 * and a node that went quiet is not a node that was never trusted.
 */
export function evaluateHeartbeatFreshness(heartbeat: MeshHeartbeat, nowMs: number): HeartbeatFreshness {
  const ageMs = nowMs - Date.parse(heartbeat.observedAt)
  if (ageMs < 0) {
    return {
      state: "future",
      ageMs,
      error: createContractError(
        "validation",
        "protocol.heartbeat_from_the_future",
        `Heartbeat observed at ${heartbeat.observedAt} is ${-ageMs}ms ahead of the controller's clock`,
      ),
    }
  }
  if (ageMs > MAX_HEARTBEAT_AGE_MS) {
    return {
      state: "stale",
      ageMs,
      error: createContractError(
        "stale_epoch",
        "mesh.node_stale",
        `Heartbeat is ${ageMs}ms old, past the ${MAX_HEARTBEAT_AGE_MS}ms freshness bound`,
      ),
    }
  }
  return { state: "fresh", ageMs }
}

export type HeartbeatSequenceVerdict =
  | { readonly status: "first"; readonly accepted: true }
  | { readonly status: "in-order"; readonly accepted: true }
  | { readonly status: "duplicate"; readonly accepted: false; readonly reason: string }
  | { readonly status: "gap"; readonly accepted: false; readonly from: number; readonly to: number; readonly reason: string; readonly error: ContractError }
  | { readonly status: "regressed"; readonly accepted: false; readonly reason: string; readonly error: ContractError }

/**
 * Per-node heartbeat sequence check.
 *
 * Separate from {@link evaluateHeartbeatFreshness} because freshness and
 * ordering answer different questions: a node can send perfectly ordered,
 * perfectly fresh heartbeats forever, and one heartbeat can be fresh and
 * out-of-order. Merging them would let "arrived late" be reported as "arrived
 * out of order", which points an operator at the wrong side of the mesh.
 *
 * A RESTART resets the sequence and is reported as `regressed`, not as an
 * error to retry: the caller is expected to answer a restart by re-running
 * reconciliation, not by dropping the node.
 */
export function evaluateHeartbeatSequence(
  previousSequence: number | null,
  incomingSequence: number,
): HeartbeatSequenceVerdict {
  if (previousSequence === null) return { status: "first", accepted: true }
  if (incomingSequence === previousSequence + 1) return { status: "in-order", accepted: true }
  if (incomingSequence === previousSequence) {
    return { status: "duplicate", accepted: false, reason: `Heartbeat sequence ${incomingSequence} repeats` }
  }
  if (incomingSequence < previousSequence) {
    return {
      status: "regressed",
      accepted: false,
      reason: `Heartbeat sequence ${incomingSequence} is behind the last accepted ${previousSequence}`,
      error: createContractError(
        "stale_epoch",
        "mesh.heartbeat_sequence_regressed",
        `Heartbeat sequence ${incomingSequence} is behind the last accepted ${previousSequence}; either the node restarted (reconcile it) or the sequence was forged`,
      ),
    }
  }
  return {
    status: "gap",
    accepted: false,
    from: previousSequence + 1,
    to: incomingSequence - 1,
    reason: `Heartbeat sequence jumped from ${previousSequence} to ${incomingSequence} with no intervening heartbeat`,
    // A GAP, not a duplicate, and the distinction is the operator's whole next
    // step: heartbeats 5-6 are missing, so this node's liveness between those
    // instants is unknown and the controller must ask for the range. Reporting it
    // as a duplicate — which is what a resent heartbeat looks like — tells the
    // operator the record was already accounted for when in fact its neighbours
    // were never seen at all.
    error: createContractError(
      "conflict",
      "mesh.heartbeat_sequence_gap",
      `Heartbeat sequence jumped from ${previousSequence} to ${incomingSequence}; sequences ${previousSequence + 1}-${incomingSequence - 1} were never seen`,
    ),
  }
}

export function checkHeartbeatFreshness(heartbeat: MeshHeartbeat, nowMs: number): Result<true> {
  const verdict = evaluateHeartbeatFreshness(heartbeat, nowMs)
  return verdict.state === "fresh" ? { ok: true, value: true } : { ok: false, error: verdict.error }
}

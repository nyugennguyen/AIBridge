import { z } from "zod"
import { createContractError, type Result } from "../../orchestration/errors.js"
import {
  meshIdSchema,
  nodeIdSchema,
  schemaVersionSchema,
  timestampSchema,
} from "../../orchestration/identifiers.js"
import { heartbeatLoadSchema, meshHeartbeatSchema } from "../protocol/heartbeat.js"
import { nodeKeyIdSchema } from "../protocol/identifiers.js"

/**
 * M4.3 — node registry and capabilities.
 *
 * The seam is `NodeRegistry` (see `./registry.js`), and everything M4.4 (lease),
 * M4.6 (SSE), M4.7 (terminal) and M4.8 (TUI) need is behind it: enrolled nodes,
 * their pinned key ids, their current capability advertisement, their revocation
 * state, and the liveness the controller derives from an injected clock.
 *
 * Four things a consumer must know before importing anything from here:
 *
 *   1. **`canScheduleOn` is a FILTER, never an authorization.** It answers
 *      "does this node ADVERTISE the runtime kind, capability and project path
 *      this dispatch envelope asks for". The `dispatchEnvelope`'s
 *      `permissionEnvelope` and the project allowlist remain authoritative, and
 *      the verdict type carries `authorizes: false` so a caller cannot read a
 *      positive verdict as a grant even by accident. See `./capability.js`.
 *   2. **A heartbeat is a claim.** `recordHeartbeat` stores what the node said
 *      about itself and derives liveness from it. It never authenticates
 *      anything, never enrolls a node, and never revokes one — those are M4.2's
 *      and are decided on the way in, not after.
 *   3. **Nothing here reads a clock.** Every time value arrives through the
 *      injected `now`, which is what lets "ninety-one seconds after the last
 *      heartbeat" be a test rather than a sleep.
 *   4. **There is no member anywhere in this directory that can express a
 *      cross-agent dependency or a task's retry eligibility** — Milestone 3 R5
 *      and R6 — and that is a property of the shapes, not a convention.
 *      `tests/unit/mesh/registry/no-scheduling-edges.test.ts` asserts it against
 *      the Zod shape and the physical SQLite columns.
 *
 * Purity: only `./sqlite-registry.js` and `./migrations.js` may touch storage,
 * and both take a `SqliteDriver` by injection rather than opening one, so the
 * durability the tests exercise is the durability production runs on.
 */

/**
 * Liveness as the REGISTRY derives it.
 *
 * Deliberately NOT the heartbeat payload's `liveness: "live"` literal, which is
 * the node's claim about itself. This enum is the controller's answer, and it has
 * three states the wire cannot express, because the wire has no way to say "I
 * stopped talking to you" — silence is not a record.
 *
 *   - `never-seen`  enrolled, never heartbeated. Not schedulable: a node that
 *                   has never reported what it can do has not demonstrated that
 *                   it can do anything.
 *   - `live`        a heartbeat inside `MAX_HEARTBEAT_AGE_MS`.
 *   - `stale`       older than that bound. NOT the same as `revoked`: a node
 *                   that went quiet is a node that will come back, and a node
 *                   that went quiet is not a node that was never trusted. Its
 *                   capabilities are simply not honoured until it speaks again.
 *   - `revoked`     terminal, and checked before anything else, because it is
 *                   the only one of the four that survives a fresh heartbeat.
 */
export const NODE_LIVENESS_STATES = ["live", "stale", "revoked", "never-seen"] as const

export const nodeLivenessSchema = z.enum(NODE_LIVENESS_STATES)

export type NodeLiveness = z.infer<typeof nodeLivenessSchema>

/**
 * The wire family's own element schemas, read rather than copied.
 *
 * `capabilities`, `runtimeKinds`, `projectPathIds`, `protocolVersions` and
 * `sequence` are taken off `meshHeartbeatSchema.shape` instead of being restated
 * here. A restated bound is a second bound that can be widened independently, and
 * the widening that matters is the one that admits a capability name, a path id
 * or a runtime kind this build would not otherwise recognise — at which point the
 * registry would be matching a node against a request it cannot itself express.
 */
const wireElements = meshHeartbeatSchema.shape

/**
 * A node's CURRENT capability advertisement.
 *
 * A filtered copy of the heartbeat payload, not the envelope and not the record
 * the node sent, because three of the wire fields are deliberately not stored:
 *
 *   - `liveness` — the node's CLAIM. Superseded by {@link nodeLivenessSchema},
 *     which is derived against the controller's clock. Storing the claim
 *     alongside the answer is how a reader ends up trusting the claim.
 *   - `meshId` / `nodeId` — already the row's own identity. A nested copy that
 *     disagreed with the row it was filed under would be a snapshot describing a
 *     different node than the one the registry holds.
 *
 * `negotiatedProtocolVersion` is the one field here that this controller
 * COMPUTED rather than read, and `null` in it is a stored state rather than a
 * refusal: a node that heartbeats on with no version in common is exactly the
 * node an operator needs to see in order to upgrade it, so dropping the record
 * would hide the failure rather than resolve it.
 */
export const capabilitySnapshotSchema = z
  .object({
    observedAt: timestampSchema,
    sequence: wireElements.sequence,
    runtimeKinds: wireElements.runtimeKinds,
    capabilities: wireElements.capabilities,
    projectPathIds: wireElements.projectPathIds,
    maxConcurrentSessions: wireElements.maxConcurrentSessions,
    agentCount: wireElements.agentCount,
    load: heartbeatLoadSchema,
    /** What the node SAID it speaks. A claim, kept for the audit trail. */
    offeredProtocolVersions: wireElements.protocolVersions,
    /** What BOTH sides speak, or `null` when there is no such version. */
    negotiatedProtocolVersion: z.number().int().positive().safe().nullable(),
  })
  .strict()

export type CapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>

const MAX_REASON_LENGTH = 1024
const MAX_ACTOR_LENGTH = 256
const MAX_DISPLAY_NAME = 256

/**
 * The revocation, as the registry stores it.
 *
 * `revokedKeyId` is the second index and not a redundant copy of the row's
 * `node_key_id`: a `nodeId` is derived from an enrollment code, so a revoked
 * machine can come back with a FRESH code, be minted a DIFFERENT `nodeId`, and be
 * re-enrolled while presenting the very key that was just revoked. Without a
 * key-indexed lookup, "revoke the compromised machine" reduces to "revoke one of
 * its names", and the compromised key walks straight back onto the mesh.
 *
 * It carries the same fact `identity.NodeRevocation` carries. It is spelled with
 * this directory's column names so a durable row round-trips through ONE schema;
 * two schemas for one fact is two things to keep in step, and the one that drifts
 * is the one that decides whether a revoked node is a candidate.
 */
export const registryRevocationSchema = z
  .object({
    nodeId: nodeIdSchema,
    meshId: meshIdSchema,
    revokedKeyId: nodeKeyIdSchema,
    reason: z.string().min(1).max(MAX_REASON_LENGTH),
    revokedBy: z.string().min(1).max(MAX_ACTOR_LENGTH),
    revokedAt: z.number().int().nonnegative().safe(),
  })
  .strict()

export type RegistryRevocation = z.infer<typeof registryRevocationSchema>

/**
 * The durable node record.
 *
 * Read the member list against R5 and R6 and there is nothing that does not
 * belong:
 *
 *   - No cross-agent dependency (R5). Those survive only as compatibility
 *     references; a member here that could hold one would let this registry
 *     present itself as the place where "task B waits for task A on another node"
 *     became a canonical scheduling edge, which is the inference R5 forbids.
 *   - No retry eligibility (R6). `taskSchema.failurePolicy` and per-task retry
 *     eligibility are PROJECTION facts, read from the recorded event log. A
 *     capability advertisement is a node's claim about its own machine and has no
 *     standing to decide whether a task may be retried anywhere.
 *
 * Both are unreachable BY CONSTRUCTION — the shape has nowhere to put them —
 * rather than by the discipline of whoever writes the next field.
 */
export const nodeRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    nodeId: nodeIdSchema,
    meshId: meshIdSchema,
    /** The pinned key id. Enrollment pins the EXACT key submitted (§4.1). */
    nodeKeyId: nodeKeyIdSchema,
    displayName: z
      .string()
      .min(1)
      .max(MAX_DISPLAY_NAME)
      .refine((value) => value === value.trim(), "Must not have surrounding whitespace"),
    enrolledAt: z.number().int().nonnegative().safe(),
    /** `null` until the node's first heartbeat is ACCEPTED. */
    capability: capabilitySnapshotSchema.nullable(),
    /** `null` until the node is revoked. Never cleared. */
    revocation: registryRevocationSchema.nullable(),
  })
  .strict()

export type NodeRecord = z.infer<typeof nodeRecordSchema>

/**
 * A node record plus the liveness the controller derived when it was read.
 *
 * Liveness is COMPUTED AT READ TIME from the injected clock and never persisted.
 * A stored liveness needs a sweeper, and a sweeper that stops running — a crash,
 * a suspended controller, a clock step — leaves every node on the mesh claiming
 * to be `live` forever, which is the failure mode a TTL exists to prevent.
 */
export interface RegisteredNode {
  readonly node: NodeRecord
  readonly liveness: NodeLiveness
  /** When the last accepted heartbeat claimed to have been observed. */
  readonly lastHeartbeatAt: string | null
  /** How old that claim is at the moment of the read. `null` when never seen. */
  readonly ageMs: number | null
  /** `null` means no common protocol version, which is never schedulable. */
  readonly negotiatedProtocolVersion: number | null
}

/** The message a corrupt row is refused with. Names the schema, not the row. */
export function unreadableNodeRecord(detail: string) {
  return createContractError("internal_failure", "registry.node_record_unreadable", detail)
}

/**
 * Parses a row read back from storage.
 *
 * Re-validated on EVERY read, deliberately. A row is untrusted input in exactly
 * the way a wire record is: it may have been written by a build this one cannot
 * read, and a `capabilities` array this build does not recognise is not a
 * capability it can honour. The alternative — trust the shape you wrote — is how
 * a downgrade becomes permanent the first time two versions of this controller
 * meet.
 */
export function parseNodeRecord(value: unknown): Result<NodeRecord> {
  const parsed = nodeRecordSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      error: unreadableNodeRecord(
        `A stored node record was refused because it does not satisfy nodeRecordSchema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}. Reading it partially would mean honouring a capability advertisement this build cannot validate.`,
      ),
    }
  }
  return { ok: true, value: Object.freeze(parsed.data) }
}

import { z } from "zod"
import { createContractError, type Result } from "../../orchestration/errors.js"
import {
  epochSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  schemaVersionSchema,
  timestampSchema,
  type Epoch,
  type LeaseId,
  type NodeId,
  type ProjectId,
  type RunId,
} from "../../orchestration/identifiers.js"
import { LEASE_OPERATIONS, meshLeaseSchema, type HeldLease } from "../protocol/lease.js"
import { ARRAY_MAX } from "../protocol/identifiers.js"

/**
 * The lease AS STORED, which is not the same object as the wire record.
 *
 * Four differences, each of which exists because the stored form is read by a
 * later process and the wire form is not:
 *
 *   1. The wire's `predecessorLeaseId` / `predecessorEpoch` / `takeoverReason` are
 *      OPTIONAL and absent rather than null on a claim. A nullable column and an
 *      absent column are the same thing to SQL and not the same thing to a reader
 *      that has to distinguish "the claim named no predecessor" from "the claim's
 *      predecessor was dropped by a bug". `null` is the second of those and is
 *      stated as a value.
 *   2. `unreconciledNodeIds` is ADDED, and it is the most important addition. The
 *      wire record carries the user's `acknowledgedUnreconciledNodeIds` — the
 *      claim. The store also keeps what the controller's OWN reconciliation
 *      reported at the moment it decided, which is the fact the claim was
 *      checked against. A takeover audit that can only see the acknowledgement
 *      cannot answer "was the user actually shown those nodes", which is the only
 *      question the guard exists to make answerable.
 *   3. `recordedAt` is added: the injected-clock instant the decision was taken,
 *      as a number. The wire's `issuedAt` is the CONTROLLER's clock reading; this
 *      is the one that produced the row.
 *   4. `schemaVersion` is added, because a stored record is a persisted record
 *      and M4-V is that persisted shapes are versioned rather than assumed.
 *
 * The wire element schemas are READ OFF `meshLeaseSchema` rather than restated.
 * A restated bound or vocabulary is a second one that can be edited independently,
 * and the edit that matters here is the one that widens what a stored lease may
 * say about a takeover — which is the guard, not a field.
 */
const wire = meshLeaseSchema.shape

export const leaseRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    leaseId: leaseIdSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    controllerNodeId: nodeIdSchema,
    epoch: epochSchema,
    operation: z.enum(LEASE_OPERATIONS),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    durationSeconds: wire.durationSeconds,
    predecessorLeaseId: leaseIdSchema.nullable(),
    predecessorEpoch: epochSchema.nullable(),
    takeoverReason: z.string().min(1).max(4_096).nullable(),
    /** What the user was shown. The CLAIM. */
    acknowledgedUnreconciledNodeIds: z.array(nodeIdSchema).max(ARRAY_MAX),
    /** What this node's own reconciliation reported. The FACT. */
    unreconciledNodeIds: z.array(nodeIdSchema).max(ARRAY_MAX),
    recordedAt: z.number().int().nonnegative().safe(),
  })
  .strict()
  .superRefine((record, ctx) => {
    // The three takeover-only fields are re-checked here as a GROUP, not just for
    // presence. A row carrying a takeover reason with no predecessor epoch is a
    // row whose audit trail claims a fence that no epoch backs, and reading it
    // back without complaining is how a half-written takeover becomes a fact
    // about who superseded whom.
    const fence = [record.predecessorLeaseId, record.predecessorEpoch, record.takeoverReason]
    const present = fence.filter((member) => member !== null).length
    if (record.operation === "takeover" && present !== 3) {
      ctx.addIssue({
        code: "custom",
        path: ["predecessorLeaseId"],
        message: `A stored takeover must carry all three of predecessorLeaseId, predecessorEpoch and takeoverReason; ${present} of 3 are present`,
      })
    }
    if (record.operation !== "takeover" && present !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["predecessorLeaseId"],
        message: `A stored '${record.operation}' may not carry takeover fields: only a takeover supersedes a predecessor`,
      })
    }
    if (record.operation !== "takeover" && record.acknowledgedUnreconciledNodeIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["acknowledgedUnreconciledNodeIds"],
        message: "Acknowledging unreconciled nodes is a takeover precondition; on a stored claim or renewal it is an unexplained list of node ids",
      })
    }
  })

export type LeaseRecord = z.infer<typeof leaseRecordSchema>

/** The message a corrupt row is refused with. Names the schema, not the row's contents. */
export function unreadableLeaseRecord(detail: string) {
  return createContractError("internal_failure", "lease.record_unreadable", detail)
}

/**
 * Parses a row read back from storage.
 *
 * Re-validated on EVERY read, for the reason `parseNodeRecord` gives: a row is
 * untrusted input in exactly the way a wire record is, and "trust the shape you
 * wrote" is how a downgrade becomes permanent the first time two builds of this
 * controller meet on one database file.
 */
export function parseLeaseRecord(value: unknown): Result<LeaseRecord> {
  const parsed = leaseRecordSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      error: unreadableLeaseRecord(
        `A stored lease record was refused because it does not satisfy leaseRecordSchema: ${describeIssues(parsed.error.issues)}. Reading it partially would mean deciding who may create new work for a run from a record this build cannot fully understand.`,
      ),
    }
  }
  return { ok: true, value: Object.freeze(parsed.data) }
}

function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
}

/**
 * One line of the audit trail.
 *
 * NOT a `LeaseRecord`, and that is the point rather than a shortcut. The audit
 * trail answers "what superseded what, and when did this node decide"; it is not
 * re-authoritative, so it deliberately does not carry the fields that decide
 * authority (`expiresAt` is here because an operator reading a fence wants to see
 * when the superseded lease ran out, but nothing reads it to make a decision).
 * Reconstructing a full record from a history row would mean inventing the
 * values for the fields the history table does not store, and an invented value
 * in a record that a takeover response then reports is how an audit starts
 * answering questions nobody asked.
 */
export const leaseHistoryEntrySchema = z
  .object({
    leaseId: leaseIdSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    controllerNodeId: nodeIdSchema,
    epoch: epochSchema,
    operation: z.enum(LEASE_OPERATIONS),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    recordedAt: z.number().int().nonnegative().safe(),
  })
  .strict()

export type LeaseHistoryEntry = z.infer<typeof leaseHistoryEntrySchema>

/** The key a lease is filed under. The run is the SCOPE; the epoch orders controllers within it. */
export interface LeaseScope {
  readonly projectId: ProjectId
  readonly runId: RunId
}

/**
 * The lease, reduced to what `src/mesh/protocol/lease.ts` decides on.
 *
 * Narrowing rather than passing the whole record, because the protocol evaluator
 * is handed `HeldLease` on purpose: it is a function of the lease in FORCE, and a
 * wider argument would let a later edit start reading `acknowledgedUnreconciledNodeIds`
 * or `recordedAt` from a decision about authority. Those are audit facts about how
 * the lease came to be, not inputs to whether it holds now.
 */
export function heldLeaseOf(record: LeaseRecord): HeldLease {
  return {
    leaseId: record.leaseId,
    projectId: record.projectId,
    runId: record.runId,
    controllerNodeId: record.controllerNodeId,
    epoch: record.epoch,
    expiresAt: record.expiresAt,
  }
}

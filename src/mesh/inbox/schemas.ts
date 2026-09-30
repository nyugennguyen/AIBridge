import { z } from "zod"
import { createContractError, type Result } from "../../orchestration/errors.js"
import {
  commandIdSchema,
  digestSchema,
  dispatchIdSchema,
  epochSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  schemaVersionSchema,
  type CommandId,
  type Digest,
  type DispatchId,
  type Epoch,
  type LeaseId,
  type NodeId,
  type ProjectId,
  type RunId,
  type SchemaVersion,
} from "../../orchestration/identifiers.js"
import { INBOX_EFFECT_STATES, type InboxEffectState, type InboxRow } from "./types.js"

/**
 * The inbox row AS STORED.
 *
 * Re-validated on every read for the reason `parseLeaseRecord` gives and this
 * codebase has now stated four times: a stored row is untrusted input in exactly
 * the way a wire record is, and "trust the shape you wrote" is how a downgrade
 * becomes permanent the first time two builds of a worker meet on one file. The
 * registry, the lease store, and now this.
 *
 * `effectState` is the R4 answer and it is the only field with a cross-field
 * rule. `result_recorded` without a `resultJson` would be a row claiming an
 * outcome that was never stored, and the duplicate path returns `resultJson` as
 * THE stored result — so such a row would answer a retry with `null` and read as
 * "this command ran and produced nothing", which is a fabrication. Refused on
 * read rather than repaired, because the two are indistinguishable after the fact
 * and a repair would pick one.
 */
export const inboxRowSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    commandId: commandIdSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    dispatchId: dispatchIdSchema.nullable(),
    targetNodeId: nodeIdSchema,
    controllerNodeId: nodeIdSchema,
    controllerEpoch: epochSchema,
    leaseId: leaseIdSchema,
    commandType: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    payloadDigest: digestSchema,
    semanticFingerprint: digestSchema,
    commandJson: z.string().min(1),
    effectState: z.enum(INBOX_EFFECT_STATES),
    acceptedAt: z.number().int().nonnegative().safe(),
    acceptedSequence: z.number().int().positive().safe(),
    runtimeAcceptedAt: z.number().int().nonnegative().safe().nullable(),
    resultJson: z.string().nullable(),
    ackEmittedAt: z.number().int().nonnegative().safe().nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.effectState === "result_recorded" && row.resultJson === null) {
      ctx.addIssue({
        code: "custom",
        path: ["resultJson"],
        message:
          "A row in 'result_recorded' must carry the result it recorded. The duplicate path returns resultJson as THE stored answer, so a row claiming an outcome it does not hold would answer a retry with a fabricated 'ran and produced nothing'.",
      })
    }
    if (row.effectState === "runtime_accepted" && row.runtimeAcceptedAt === null) {
      ctx.addIssue({
        code: "custom",
        path: ["runtimeAcceptedAt"],
        message:
          "A row in 'runtime_accepted' must record when the peer accepted the effect. That instant is the whole content of the ambiguous-launch state R4 is about.",
      })
    }
  })

export type StoredInboxRow = z.infer<typeof inboxRowSchema>

/** The message a corrupt row is refused with. Names the schema, not the row's contents. */
export function unreadableInboxRow(detail: string) {
  return createContractError("internal_failure", "inbox.record_unreadable", detail)
}

/**
 * Parses a row read back from storage.
 *
 * Never partially read, for `SqliteEventStore`'s reason applied to a remote
 * authorization decision: a row the build cannot fully understand is a row whose
 * `effectState` it cannot trust, and `effectState` is what decides whether a
 * redelivered command re-runs its effect or returns a stored result.
 */
export function parseInboxRow(value: unknown): Result<InboxRow> {
  const parsed = inboxRowSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      error: unreadableInboxRow(
        `A stored inbox row was refused because it does not satisfy inboxRowSchema: ${describeIssues(parsed.error.issues)}. Reading it partially would mean deciding whether a redelivered command re-runs its effect from a record this build cannot fully understand.`,
      ),
    }
  }
  return { ok: true, value: Object.freeze(parsed.data) as InboxRow }
}

function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
}

/** The physical row, before it is re-validated into an `InboxRow`. */
export interface MeshInboxRowShape {
  schema_version: number
  command_id: string
  project_id: string
  run_id: string
  dispatch_id: string | null
  target_node_id: string
  controller_node_id: string
  controller_epoch: number
  lease_id: string
  command_type: string
  payload_digest: string
  semantic_fingerprint: string
  command_json: string
  effect_state: string
  accepted_at: number
  accepted_sequence: number
  runtime_accepted_at: number | null
  result_json: string | null
  ack_emitted_at: number | null
}

/**
 * The projection of a physical row into the value the schema checks.
 *
 * The column names are snake_case and the schema's are camelCase, so the mapping
 * is stated ONCE here rather than inline at each read site. An inline mapping is
 * a mapping with three copies, and the copy somebody forgets is the one that
 * silently reads a column as `undefined` — which for `effectState` is the
 * difference between re-running an effect and returning its stored result.
 */
export function rowToValue(row: MeshInboxRowShape): Record<string, unknown> {
  return {
    schemaVersion: row.schema_version,
    commandId: row.command_id,
    projectId: row.project_id,
    runId: row.run_id,
    dispatchId: row.dispatch_id,
    targetNodeId: row.target_node_id,
    controllerNodeId: row.controller_node_id,
    controllerEpoch: row.controller_epoch,
    leaseId: row.lease_id,
    commandType: row.command_type,
    payloadDigest: row.payload_digest,
    semanticFingerprint: row.semantic_fingerprint,
    commandJson: row.command_json,
    effectState: row.effect_state,
    acceptedAt: row.accepted_at,
    acceptedSequence: row.accepted_sequence,
    runtimeAcceptedAt: row.runtime_accepted_at,
    resultJson: row.result_json,
    ackEmittedAt: row.ack_emitted_at,
  }
}

export type { CommandId, Digest, DispatchId, Epoch, InboxEffectState, InboxRow, LeaseId, NodeId, ProjectId, RunId, SchemaVersion }

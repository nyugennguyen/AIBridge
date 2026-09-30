/**
 * M4.8 — parsing a mesh snapshot into the shape the view reads.
 *
 * The TUI is handed data assembled from five other directories: M4.3's registry
 * rows, M4.4's stored lease, M4.5's durable outbox rows, M4.6's reconciliation
 * entries, and the kernel's own session record. Every one of those is untrusted
 * input in exactly the way a wire record is, and M4-V's rule — a record whose
 * shape is not understood is refused, never partially read — does not stop
 * applying because the reader happens to be a screen.
 *
 * So there is ONE parse site here, and it composes the OWNERS' schemas rather than
 * restating them. `nodeRecordSchema`, `leaseRecordSchema`, `unreconciledEntrySchema`
 * and `sessionSchema` are imported; a re-typed copy of any of them in this file
 * would be a second definition that could be widened independently, and widening
 * is precisely the failure the import prevents. The two shapes that have no
 * schema of their own — M4.7's `TerminalView` and the kernel's `OutboxRecord` —
 * are declared as narrow Zod objects, and each is stated as a SUBSET: the TUI
 * reads four fields of an outbox row and five of a terminal view, and a snapshot
 * it could not validate field by field would be a snapshot this layer has to
 * trust.
 *
 * Two things are deliberately NOT computed here:
 *
 *   - **Whether an outbox row is poisoned.** M4.5 answers that with
 *     `exceedsMaxAttempts`, and a second threshold in this directory would be a
 *     second number that could be raised independently of the pump's.
 *   - **Which lease standing a record implies.** M4.4 answers that with
 *     `permitsNewWork`, and the snapshot carries the ANSWER. A view that
 *     re-compared `expiresAt` against its own clock would be a view whose notion
 *     of "expired" could disagree with the seam that refuses commands on it.
 */
import { z } from "zod"
import { createContractError, type Result } from "../../orchestration/errors.js"
import {
  meshIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  sessionIdSchema,
  terminalClientIdSchema,
  terminalIdSchema,
  type ProjectId,
  type RunId,
} from "../../orchestration/identifiers.js"
import { sessionSchema } from "../../orchestration/schemas.js"
import { MESH_LAUNCH_OUTCOMES } from "../inbox/launch-outcome.js"
import { leaseRecordSchema } from "../lease/schemas.js"
import { unreconciledEntrySchema } from "../protocol/reconciliation.js"
import { nodeLivenessSchema, nodeRecordSchema } from "../registry/schemas.js"
import { MESH_TUI_NETWORK_STATES, type MeshTuiLeaseSnapshot, type MeshTuiSnapshot } from "./types.js"

/**
 * M4.3's read-time `RegisteredNode`, as a schema.
 *
 * The one piece this directory composes rather than imports, because the registry
 * derives it at read time from a `NodeRecord` and an injected clock and therefore
 * has no stored shape to validate. Its `node` member is checked by the registry's
 * OWN schema, so a capability advertisement this build cannot read is refused by
 * the same code that refuses it on the ingest path.
 */
const registeredNodeSchema = z
  .object({
    node: nodeRecordSchema,
    liveness: nodeLivenessSchema,
    lastHeartbeatAt: z.string().nullable(),
    ageMs: z.number().int().nonnegative().safe().nullable(),
    negotiatedProtocolVersion: z.number().int().positive().safe().nullable(),
  })
  .strict()

/**
 * M4.7's `TerminalView`, narrowed to the members the view renders.
 *
 * A SUBSET on purpose. The full view carries a `TerminalBinding`, and rebuilding
 * that object here would be a second spelling of a shape the gateway owns.
 * Flattening it into this file's own object is not a second definition of the
 * binding — it is the same five ids under names this layer chose — and the ids are
 * still parsed by the kernel's schemas, so an unparseable terminal id is a refusal
 * here rather than a row that renders.
 */
const terminalViewSchema = z
  .object({
    terminalId: terminalIdSchema,
    sessionId: sessionIdSchema,
    nodeId: nodeIdSchema,
    viewerCount: z.number().int().nonnegative().safe(),
    inputOwnerClientId: terminalClientIdSchema.nullable(),
    lossy: z.boolean(),
  })
  .strict()

/**
 * The kernel's `OutboxRecord`, narrowed to what the TUI displays.
 *
 * `destination` is a plain string in the kernel's shape and stays one here, for
 * the reason it is one there: an outbox row is keyed by a storage id, and this
 * layer has no standing to decide that a destination is a well-formed mesh node
 * id. The TUI shows it as an opaque label, and a row whose destination is
 * nonsense is a delivery fault the deliverer already reports.
 */
const outboxRowSchema = z
  .object({
    outboxId: z.string(),
    status: z.string(),
    attempts: z.number().int().nonnegative().safe(),
    destination: z.string(),
    lastError: z.string().optional(),
  })
  .strict()

const leaseSnapshotSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("held"), record: leaseRecordSchema, permitsNewWork: z.literal(true) }),
  z.object({ kind: z.literal("expired"), record: leaseRecordSchema, permitsNewWork: z.literal(false) }),
  z.object({ kind: z.literal("absent") }),
  z.object({ kind: z.literal("superseded"), record: leaseRecordSchema, permitsNewWork: z.literal(false) }),
])

export const meshTuiSnapshotSchema = z
  .object({
    meshId: meshIdSchema,
    localNodeId: nodeIdSchema,
    scope: z.object({ projectId: projectIdSchema, runId: runIdSchema }).strict(),
    lease: leaseSnapshotSchema,
    network: z.enum(MESH_TUI_NETWORK_STATES),
    nodes: z.array(registeredNodeSchema),
    sessions: z
      .array(
        z
          .object({
            session: sessionSchema,
            launchOutcome: z.enum(MESH_LAUNCH_OUTCOMES).nullable(),
            terminal: terminalViewSchema.nullable(),
          })
          .strict(),
      ),
    unreconciled: z.array(unreconciledEntrySchema),
    outbox: z.array(outboxRowSchema),
  })
  .strict()

/**
 * Rejects a snapshot whose scope and lease name different runs.
 *
 * The snapshot's scope is what every intent this layer emits is addressed with,
 * and the lease record names its own `(projectId, runId)`. A snapshot where those
 * differ is one where a takeover confirmation would be presented for one run while
 * the lease it fences belongs to another — the exact incoherence
 * `MeshControllerLease` refuses with `lease_scope_mismatch`, refused here too,
 * because a screen that displayed it would be asking an operator to confirm
 * something they cannot see.
 */
function scopeAgreesWithLease(lease: MeshTuiLeaseSnapshot, projectId: ProjectId, runId: RunId): boolean {
  if (lease.kind === "absent") return true
  return lease.record.projectId === projectId && lease.record.runId === runId
}

/** The message a refused snapshot carries. Names the schema, never the row's contents. */
export function unreadableMeshTuiSnapshot(detail: string) {
  return createContractError("validation", "mesh.tui_snapshot_unreadable", detail)
}

export function parseMeshTuiSnapshot(value: unknown): Result<MeshTuiSnapshot> {
  const parsed = meshTuiSnapshotSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      error: unreadableMeshTuiSnapshot(
        `A mesh snapshot was refused because it does not satisfy meshTuiSnapshotSchema: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}. A view that read it partially would show node health, a lease and a session list that disagree about which run they describe.`,
      ),
    }
  }
  if (!scopeAgreesWithLease(parsed.data.lease, parsed.data.scope.projectId, parsed.data.scope.runId)) {
    const leased = parsed.data.lease.kind === "absent" ? "no lease" : `${parsed.data.lease.record.projectId}/${parsed.data.lease.record.runId}`
    return {
      ok: false,
      error: unreadableMeshTuiSnapshot(
        `The snapshot's scope (${parsed.data.scope.projectId}/${parsed.data.scope.runId}) and the lease it carries (${leased}) name different runs. Refused rather than displayed: every action this view offers is addressed with the snapshot's scope, so a confirmation presented here would fence a lease the operator was never shown.`,
      ),
    }
  }
  return { ok: true, value: Object.freeze(parsed.data) as MeshTuiSnapshot }
}

import { z } from "zod"
import { commandIdSchema, eventIdSchema, timestampSchema, type Timestamp } from "../../orchestration/identifiers.js"
import { fingerprintCommand } from "../../orchestration/event-store/fingerprint.js"
import type { MeshCommand } from "./command.js"
import { defineFamily, sameId, type FamilyEnvelope } from "./envelope.js"

/**
 * `mesh.ack` — the only thing that retires an outbox record.
 *
 * The absence of an ack is therefore a normal, expected state: the sender
 * redelivers, and redelivery must be idempotent. What an ack must never be is
 * ambiguous, which is why `ackKind` decides which of the three id/position
 * fields are PRESENT rather than letting all three be optional. "Accepted",
 * optionally naming what it accepted, would make an ack for the wrong thing
 * structurally expressible.
 *
 * `acknowledgedThroughLocalSequence` is a CUMULATIVE position, not a
 * single-event acknowledgement: acknowledging through N retires every event up to
 * N, so a partition that lost four acks costs one ack on heal rather than four.
 * The cost is that a receiver must never report a position it has not actually
 * applied, which is a rule about the sender, not something the shape can enforce.
 */

export const MESH_ACK_REJECTION_CODES = [
  "payload_digest_mismatch",
  "epoch_stale",
  "epoch_unregistered",
  "record_expired",
  "scope_mismatch",
  "not_authorized",
  "not_persisted",
  "duplicate_conflict",
  "capacity_exhausted",
] as const

export const meshAckSchema = z
  .object({
    acksCommandId: commandIdSchema.optional(),
    acksEventId: eventIdSchema.optional(),
    ackKind: z.enum(["command", "event", "heartbeat"]),
    /** Events only. Cumulative: every event up to and including N is retired. */
    acknowledgedThroughLocalSequence: z.number().int().nonnegative().safe().optional(),
    acknowledgedAt: timestampSchema,
    outcome: z.enum(["accepted", "rejected", "duplicate"]),
    rejectionCode: z.enum(MESH_ACK_REJECTION_CODES).optional(),
  })
  .strict()
  .superRefine((ack, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message })
    }

    // `duplicate` is a first-class outcome precisely because the retry scenario
    // depends on it: a redelivered command must be answered with the STORED
    // result and an ack that says `accepted` would have the controller create
    // new bookkeeping for work that already happened.
    if (ack.outcome === "rejected" && ack.rejectionCode === undefined) {
      issue(["rejectionCode"], "A rejected ack must carry a rejection code; a refusal the sender cannot act on is an ack that never retires anything")
    }
    if (ack.outcome !== "rejected" && ack.rejectionCode !== undefined) {
      issue(["rejectionCode"], "Only a rejected ack carries a rejection code; an accepted ack with a rejection reason reads as a contradiction")
    }

    switch (ack.ackKind) {
      case "command":
        if (ack.acksCommandId === undefined) issue(["acksCommandId"], "A command ack must name the command it acknowledges")
        if (ack.acksEventId !== undefined) issue(["acksEventId"], "A command ack cannot also acknowledge an event")
        if (ack.acknowledgedThroughLocalSequence !== undefined) {
          issue(["acknowledgedThroughLocalSequence"], "A local sequence position belongs to an event ack; a command ack has no sequence")
        }
        break
      case "event":
        if (ack.acksEventId === undefined) issue(["acksEventId"], "An event ack must name the event it acknowledges, or the cumulative position it retires through")
        if (ack.acksCommandId !== undefined) issue(["acksCommandId"], "An event ack cannot also acknowledge a command")
        if (ack.acknowledgedThroughLocalSequence !== undefined && ack.acknowledgedThroughLocalSequence < 1) {
          issue(["acknowledgedThroughLocalSequence"], "A cumulative event position starts at 1; 0 is expressed by omitting it, because 'acknowledged through nothing' and 'acknowledged nothing' must not be two spellings")
        }
        break
      case "heartbeat":
        if (ack.acksCommandId !== undefined) issue(["acksCommandId"], "A heartbeat ack acknowledges no command")
        if (ack.acksEventId !== undefined) issue(["acksEventId"], "A heartbeat ack acknowledges no event")
        if (ack.acknowledgedThroughLocalSequence !== undefined) {
          issue(["acknowledgedThroughLocalSequence"], "A heartbeat ack carries no sequence position")
        }
        break
    }
  })

export const ackFamily = defineFamily({
  recordType: "mesh.ack",
  payloadSchema: meshAckSchema,
  refine: (envelope, ctx) => {
    const ack = envelope.payload
    // Closure: an ack's correlation must be the thing it acknowledges. This is
    // the field a gateway routes on, so an ack that correlates on something else
    // is a record that would be filed under the wrong outbox row — and a
    // redelivery loop that never stops is the observable symptom.
    const acknowledged =
      ack.ackKind === "command" ? ack.acksCommandId : ack.ackKind === "event" ? ack.acksEventId : envelope.correlationId
    if (acknowledged !== undefined && !sameId(envelope.correlationId, acknowledged)) {
      ctx.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: `Ack correlates on '${envelope.correlationId}' but acknowledges '${acknowledged}'`,
      })
    }
  },
})

export type MeshAck = z.infer<typeof meshAckSchema>
export type MeshAckKind = MeshAck["ackKind"]
export type MeshAckOutcome = MeshAck["outcome"]
export type MeshAckRejectionCode = (typeof MESH_ACK_REJECTION_CODES)[number]
export type MeshAckEnvelope = FamilyEnvelope<MeshAck>

/**
 * The decision the retry diagram turns on.
 *
 * Returns a discriminated answer rather than a boolean because the three cases
 * have three different correct behaviours: `apply` persists and runs, `duplicate`
 * returns the STORED result and appends nothing, and `conflict` writes nothing at
 * all. A boolean would collapse `duplicate` into `apply`, which is precisely the
 * second-session defect the convergence test exists to catch.
 *
 * Generic in the row type so the decision hands back the very row it was made
 * against. A caller that had to re-read its store to learn `acceptedSequence`
 * after deciding a command was a duplicate would be racing its own write.
 */
export type CommandReceipt<TRow> =
  | { readonly disposition: "apply"; readonly duplicate: false }
  | { readonly disposition: "return_stored"; readonly duplicate: true; readonly storedResult: unknown; readonly row: TRow }
  | { readonly disposition: "conflict"; readonly duplicate: true; readonly reason: string }

/**
 * What a receipt decision is made against: the row, its SEMANTIC fingerprint, and
 * the row's decoded result.
 *
 * STRUCTURAL rather than the inbox's own `InboxRow`, so the protocol stays a leaf
 * (see `./index.ts`: no mesh protocol module may depend on a seam above it) and so
 * M4.6's gateway and M4.9's fault harness can hand this their own row shape
 * without the inbox being in the import graph. `TRow` is inferred from `row`, so a
 * caller that passes a differently-shaped row gets a differently-shaped receipt
 * rather than a cast.
 *
 * `storedResult` is DECODED by the caller and `null` when the row carries none,
 * which is the `pending` case: admitted, durable, the effect not yet run. `null`
 * rather than `undefined` so "ran and produced nothing" and "has not run yet" are
 * one value a redelivery can be answered with, instead of two the sender has no
 * way to tell apart.
 */
export interface StoredCommandReceipt<TRow> {
  readonly row: TRow
  readonly semanticFingerprint: string
  readonly storedResult: unknown
}

/**
 * What the worker does with a command it has already seen.
 *
 * `stored` is the inbox row for this `commandId`, if there is one. The
 * comparison — and ONLY the comparison — decides between the three outcomes.
 * Authorization is not consulted here and must not be: a command that was refused
 * is not in the inbox, so a refusal is simply absent here and the caller re-runs
 * the full verification.
 *
 * **The comparison is on the SEMANTIC fingerprint, and that is not a detail.**
 * This function used to compare the WIRE `payloadDigest`, which covers
 * `issuedAt` and `expiresAt`. A controller that re-mints an unanswered command —
 * which at-least-once delivery makes it do on the normal path — legitimately
 * produces a different wire digest for the SAME instruction, so a wire-digest
 * comparison answers every legitimate retry with `conflict`, writes nothing, and
 * leaves the sender's outbox row visible for an operator forever. That is defect
 * B8 from the Milestone 3 plan ("duplicate commands cannot launch duplicate
 * sessions") reproduced one layer up, and it fires on the happy path rather than
 * only under load.
 *
 * `fingerprintCommand` is the kernel's own fingerprint, the same one
 * `SqliteEventStore` deduplicates receipts with, so the wire's dedupe and the
 * store's agree by construction rather than by two re-derivations that drift. It
 * is derived HERE, from the command, rather than taken as a parameter: a parameter
 * would put one field-swap away from `verified.recomputedDigest` in every caller,
 * which is the defect this function is.
 */
export function decideCommandReceipt<TRow>(
  incoming: MeshCommand,
  stored: StoredCommandReceipt<TRow> | null,
): CommandReceipt<TRow> {
  if (stored === null) return { disposition: "apply", duplicate: false }
  const semanticFingerprint = fingerprintCommand(incoming.command).semantic
  if (stored.semanticFingerprint === semanticFingerprint) {
    return {
      disposition: "return_stored",
      duplicate: true,
      storedResult: stored.storedResult,
      row: stored.row,
    }
  }
  return {
    disposition: "conflict",
    duplicate: true,
    reason:
      `Command '${incoming.commandId}' was already admitted with semantic fingerprint ${stored.semanticFingerprint} ` +
      `but arrived carrying ${semanticFingerprint}. Two different instructions under one command id is not a ` +
      `retry: at-least-once delivery re-sends the SAME instruction. NOTHING is persisted.`,
  }
}

/**
 * The ack a given receipt implies.
 *
 * `acknowledgedAt` is a parameter rather than a clock read so the ack is a pure
 * function of its inputs, and so a test can assert that the SAME command at the
 * SAME time produces the SAME ack — an ack whose timestamp drifts between the
 * duplicate path and the accept path is two records for one decision, and the
 * outbox dedupe that depends on ack identity would not see them as one.
 *
 * `conflict` acks as REJECTED, not as `duplicate`. The two look similar and are
 * opposites: `duplicate` says "already done, here is the stored result" and lets
 * the sender retire its row, while a conflict says "I already did something ELSE
 * under this id" and must leave the sender's row visible for an operator.
 */
export function ackForReceipt(
  record: MeshCommand,
  receipt: CommandReceipt<unknown>,
  acknowledgedAt: Timestamp,
): MeshAck {
  const base = {
    acksCommandId: record.commandId,
    ackKind: "command" as const,
    acknowledgedAt,
  }
  if (receipt.disposition === "apply") return meshAckSchema.parse({ ...base, outcome: "accepted" })
  if (receipt.disposition === "return_stored") return meshAckSchema.parse({ ...base, outcome: "duplicate" })
  return meshAckSchema.parse({ ...base, outcome: "rejected", rejectionCode: "duplicate_conflict" })
}

import { z } from "zod"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import {
  commandIdSchema,
  eventIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  timestampSchema,
  type CommandId,
  type NodeId,
} from "../../orchestration/identifiers.js"
import { orchestrationEventSchema } from "../../orchestration/schemas.js"
import { MAX_EVENT_PAYLOAD_BYTES, canonicalByteLength } from "./bounds.js"
import { defineFamily, sameId, type FamilyEnvelope } from "./envelope.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "./negotiation.js"

/**
 * `mesh.event` — what a worker reports back.
 *
 * The event enters a durable outbox BEFORE transmission and stays there until
 * the ack is persisted, so redelivery is expected and the controller's ingestion
 * must be idempotent on `eventId`. Two identities therefore have to be stable
 * across a restart: `eventId` (so ingestion dedupes) and `localSequence` (so
 * the controller can tell "resent" from "skipped"). A restart that re-emitted an
 * event under a NEW id would look like a second event that happened, which is
 * how a retried effect becomes a duplicated one four steps later.
 */

export const meshEventSchema = z
  .object({
    meshProtocolVersion: z.number().int().positive().safe(),
    eventId: eventIdSchema,
    sourceNodeId: nodeIdSchema,
    /** The `commandId` this event answers, or null for a node-initiated report. */
    commandCorrelation: commandIdSchema.nullable(),
    /** Per source node, monotonic, gapless from the controller's point of view. */
    localSequence: z.number().int().positive().safe(),
    observedAt: timestampSchema,
    runProjectScope: z
      .object({
        projectId: projectIdSchema,
        runId: runIdSchema,
      })
      .strict(),
    eventType: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    event: orchestrationEventSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    if (!sameId(record.event.eventId, record.eventId)) {
      ctx.addIssue({ code: "custom", path: ["event", "eventId"], message: "Event ID must match the mesh record event ID" })
    }
    if (!sameId(record.event.projectId, record.runProjectScope.projectId)) {
      ctx.addIssue({ code: "custom", path: ["event", "projectId"], message: "Event project ID must match the mesh run/project scope" })
    }
    if (!sameId(record.event.runId, record.runProjectScope.runId)) {
      ctx.addIssue({ code: "custom", path: ["event", "runId"], message: "Event run ID must match the mesh run/project scope" })
    }
    if (record.event.type !== record.eventType) {
      ctx.addIssue({ code: "custom", path: ["eventType"], message: "Declared event type must equal the event payload type" })
    }
    // The kernel event's own `commandId` and the mesh `commandCorrelation` are
    // the same pointer stated twice. They are allowed to DISAGREE only when the
    // kernel event has none at all (a node-initiated report), because a
    // correlation that names a command the event does not is a correlation the
    // controller would use to attribute work to a command that never ran.
    if (record.commandCorrelation !== null) {
      if (record.event.commandId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["commandCorrelation"],
          message: "A mesh command correlation must be mirrored by the event's own commandId",
        })
      } else if (!sameId(record.event.commandId, record.commandCorrelation)) {
        ctx.addIssue({
          code: "custom",
          path: ["commandCorrelation"],
          message: "Mesh command correlation must match the event's own commandId",
        })
      }
    } else if (record.event.commandId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["commandCorrelation"],
        message: "The event names a command, so the mesh correlation cannot be null",
      })
    }

    const bytes = canonicalByteLength(record.event)
    if (bytes > MAX_EVENT_PAYLOAD_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["event"],
        message: `Event payload is ${bytes} canonical bytes, over the ${MAX_EVENT_PAYLOAD_BYTES} byte bound`,
      })
    }
  })

export const eventFamily = defineFamily({
  recordType: "mesh.event",
  payloadSchema: meshEventSchema,
  refine: (envelope, ctx) => {
    if (!sameId(envelope.senderNodeId, envelope.payload.sourceNodeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["senderNodeId"],
        message: `A worker event is first-person; '${envelope.senderNodeId}' cannot report '${envelope.payload.sourceNodeId}'`,
      })
    }
    // An event correlates on the EVENT it is, not on the command it answers. The
    // command is the causation. Conflating the two is how a controller ends up
    // with one correlation id per command and cannot answer "which events came
    // back for command X" without walking the log.
    if (!sameId(envelope.correlationId, envelope.payload.eventId)) {
      ctx.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: `An event envelope correlates on its own event id; got '${envelope.correlationId}' for '${envelope.payload.eventId}'`,
      })
    }
  },
})

export type MeshEvent = z.infer<typeof meshEventSchema>
export type MeshEventEnvelope = FamilyEnvelope<MeshEvent>

/** The mesh-level wrapper for an event minted by a worker. */
export interface MintMeshEventInput {
  readonly event: z.infer<typeof orchestrationEventSchema>
  readonly sourceNodeId: NodeId
  readonly localSequence: number
  readonly commandCorrelation?: CommandId | null
}

/**
 * Minting seam, so the two ids that must stay stable across a restart are set in
 * one place. `meshProtocolVersion` is stamped here rather than passed, because a
 * caller that supplies it can mint a record its own build will refuse.
 */
export function mintMeshEvent(input: MintMeshEventInput): MeshEvent {
  return meshEventSchema.parse({
    meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    eventId: input.event.eventId,
    sourceNodeId: input.sourceNodeId,
    commandCorrelation: input.commandCorrelation === undefined ? (input.event.commandId ?? null) : input.commandCorrelation,
    localSequence: input.localSequence,
    observedAt: input.event.occurredAt,
    runProjectScope: { projectId: input.event.projectId, runId: input.event.runId },
    eventType: input.event.type,
    event: input.event,
  })
}

// --- Sequence tracking ---------------------------------------------------

export type SequenceStatus = "duplicate" | "in-order" | "gap"

export type LocalSequenceVerdict =
  | { readonly status: "in-order"; readonly accepted: true; readonly expected: number; readonly nextExpected: number }
  | { readonly status: "duplicate"; readonly accepted: false; readonly reason: string; readonly highestAccepted: number }
  | {
      readonly status: "gap"
      readonly accepted: false
      /** The first sequence number never seen. */
      readonly missingFrom: number
      /** The last sequence number before the gap, i.e. `incoming - 1`. */
      readonly missingTo: number
      readonly missingCount: number
      readonly error: ContractError
    }

/**
 * Classifies an incoming `localSequence` against the last one accepted from this
 * source node.
 *
 * The whole point of `localSequence` is that a gap is VISIBLE. At-least-once
 * delivery plus a crash between "event persisted" and "sequence advanced" means
 * a controller can legitimately observe a hole, and the correct response is to
 * ask for the missing range — not to continue. A silent skip is the defect this
 * function exists to make impossible: a projection built across a hole is a
 * projection that invents the missing state, and `dispatch.started` is precisely
 * the event whose absence makes a session look un-run while it is running.
 *
 * `previous === null` means the controller has accepted nothing from this node.
 * The first sequence is therefore required to be 1, and anything higher is a gap
 * from 1 — NOT a "first seen" accept. Accepting 7 as the first event would make
 * events 1–6 permanently unrecoverable while looking like a clean start.
 *
 * A `duplicate` is the EXPECTED outcome of at-least-once delivery and is not an
 * error: it is the controller's ingestion dedupe firing. It is still reported
 * rather than folded into a boolean, so a caller cannot mistake "resent" for
 * "new".
 */
export function nextLocalSequence(previous: number | null, incoming: number): LocalSequenceVerdict {
  const expected = previous === null ? 1 : previous + 1
  if (incoming === expected) {
    return { status: "in-order", accepted: true, expected, nextExpected: expected + 1 }
  }
  if (incoming < expected) {
    return {
      status: "duplicate",
      accepted: false,
      reason: `Sequence ${incoming} was already accepted (highest accepted is ${previous})`,
      highestAccepted: previous ?? 0,
    }
  }
  const missingFrom = expected
  const missingTo = incoming - 1
  return {
    status: "gap",
    accepted: false,
    missingFrom,
    missingTo,
    missingCount: missingTo - missingFrom + 1,
    error: createContractError(
      "conflict",
      "mesh.event_sequence_gap",
      `Event sequence jumped from ${previous ?? 0} to ${incoming}; sequences ${missingFrom}-${missingTo} were never seen. Request them; do not continue across the hole.`,
    ),
  }
}

/**
 * Stateful form of {@link nextLocalSequence}, for a controller holding one
 * receiver per peer.
 *
 * The class is a convenience over the pure function and holds no I/O and reads
 * no clock, which is what lets the restart scenario be tested by constructing a
 * tracker over a known history rather than by replaying a real run. It also
 * records the HIGHEST sequence ever accepted rather than the last, so an
 * out-of-order arrival cannot move the watermark backwards and make a
 * permanently-lost sequence look like it is still expected.
 */
export class EventSequenceTracker {
  #highest: number | null = null
  readonly #sourceNodeId: NodeId

  constructor(sourceNodeId: NodeId) {
    this.#sourceNodeId = sourceNodeId
  }

  get highestAccepted(): number | null {
    return this.#highest
  }

  evaluate(incoming: number): LocalSequenceVerdict {
    const verdict = nextLocalSequence(this.#highest, incoming)
    if (verdict.status === "in-order") this.#highest = incoming
    return verdict
  }

  /**
   * Raises the watermark to `sequence` without deciding anything.
   *
   * For RESTORATION, where the caller already knows what this node published
   * because it read it out of a durable log. `evaluate` is the wrong method there
   * for two reasons, and both are correctness rather than style: it can REFUSE
   * (a restored entry would be reported as a gap, which is a claim about history
   * this process did not witness and cannot contradict), and it can leave the
   * watermark alone on a `duplicate` (so a restored run of duplicates would
   * restore a watermark below where the stream actually got to).
   *
   * Monotonic, like `evaluate`: a lower sequence never lowers the watermark, or an
   * out-of-order restore would make a permanently-lost sequence look expected
   * again.
   */
  observe(sequence: number): void {
    if (this.#highest === null || sequence > this.#highest) this.#highest = sequence
  }

  /** The sequences a gap verdict says to ask for, as an inclusive range. */
  static missingRange(verdict: LocalSequenceVerdict): { readonly from: number; readonly to: number } | null {
    if (verdict.status !== "gap") return null
    return { from: verdict.missingFrom, to: verdict.missingTo }
  }

  /**
   * Restores the watermark after a worker restart, which RESETS its sequence.
   *
   * The restart diagram requires that a reconnected node's events keep their
   * stable ids rather than being re-emitted, and those events will arrive
   * carrying sequence numbers from 1 again. The controller must therefore
   * re-baseline explicitly, keeping the old watermark so that a stale high
   * sequence from a node that did NOT restart is still caught. Called blindly on
   * any "I restarted" message it would lower the watermark, which is why it is a
   * separate method rather than something `evaluate` does on its own.
   */
  rebaseAfterRestart(): void {
    this.#highest = null
  }

  toString(): string {
    return `EventSequenceTracker(${this.#sourceNodeId}@${this.#highest ?? "none"})`
  }
}

export function checkLocalSequence(previous: number | null, incoming: number): Result<true> {
  const verdict = nextLocalSequence(previous, incoming)
  return verdict.status === "in-order" ? { ok: true, value: true } : { ok: false, error: gapError(verdict) }
}

function gapError(verdict: LocalSequenceVerdict): ContractError {
  if (verdict.status === "gap") return verdict.error
  if (verdict.status === "duplicate") {
    return createContractError("conflict", "mesh.event_sequence_duplicate", verdict.reason)
  }
  return createContractError("validation", "mesh.event_sequence_unexpected", "Local sequence was evaluated in an impossible state")
}

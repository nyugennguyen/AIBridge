import { z } from "zod"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import {
  commandIdSchema,
  correlationIdSchema,
  eventIdSchema,
  nodeIdSchema,
  schemaVersionSchema,
  timestampSchema,
  type SchemaVersion,
} from "../../orchestration/identifiers.js"
import { CURRENT_SCHEMA_VERSION, type VersionedShapes } from "../../orchestration/versioning.js"
import { MAX_ENVELOPE_BYTES, REPLAY_WINDOW_MS, canonicalByteLength } from "./bounds.js"
import { enrollmentIdSchema, messageIdSchema, protocolVersionSchema } from "./identifiers.js"

/**
 * The record families, as wire strings.
 *
 * There are NINE families (§4.1–§4.9) but ELEVEN `recordType` values, because
 * three of the families are inherently bidirectional and a `recordType` that
 * names a direction is what lets a receiver refuse an inbound `mesh.command`
 * where an outbound one was expected. Collapsing each pair back to one type
 * with a `direction` member would recreate the "union with an ambiguous
 * discriminator" that §4.9 explicitly forbids for terminal frames.
 *
 * The list is the single source of the union: `registry.ts` derives its
 * dispatch table from it and `meshRecordTypeSchema` is derived from it, so a
 * family that is added without a registry entry is a compile error rather than
 * a record that parses as a generic object.
 */
export const MESH_RECORD_TYPES = [
  "mesh.enrollment.request",
  "mesh.enrollment.response",
  "mesh.heartbeat",
  "mesh.command",
  "mesh.ack",
  "mesh.event",
  "mesh.lease",
  "mesh.reconciliation.request",
  "mesh.reconciliation.response",
  "mesh.terminal.control",
  "mesh.terminal.data",
] as const

export type MeshRecordType = (typeof MESH_RECORD_TYPES)[number]

export const meshRecordTypeSchema = z.enum(MESH_RECORD_TYPES)

/**
 * Why this record exists, if it answers something.
 *
 * `null` means "this is the head of a conversation", which is the correct value
 * for a controller's own command and for a first enrollment request. It is NOT
 * an optionality escape hatch: an ack that answered nothing and an ack that
 * forgot to say what it answered are indistinguishable on the wire, and only one
 * of them is auditable.
 */
export const meshCausationSchema = z.union([
  z.null(),
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("command"), commandId: commandIdSchema }).strict(),
    z.object({ kind: z.literal("event"), eventId: eventIdSchema }).strict(),
    z.object({ kind: z.literal("enrollment"), enrollmentId: enrollmentIdSchema }).strict(),
  ]),
])

/**
 * The fields every record carries, in both directions.
 *
 * `.strict()` here as well as on the composed schema in `defineFamily`. The
 * composition needs a plain `ZodObject` to `.extend()`, and the temptation after
 * that is to leave strictness to the caller — which makes "is this envelope
 * strict?" a property of how it was used rather than of what it is. Zod keeps
 * strictness across `.extend()`, so the base can be strict and still be
 * extendable.
 *
 * Deliberately NOT `.superRefine`d here: the cross-field invariants live in
 * {@link assertEnvelopeInvariants} instead, which is applied by `defineFamily` —
 * that way every family gets them without any family being able to forget.
 */
export const meshEnvelopeHeadersSchema = z.object({
  schemaVersion: schemaVersionSchema,
  messageId: messageIdSchema,
  correlationId: correlationIdSchema,
  causation: meshCausationSchema,
  senderNodeId: nodeIdSchema,
  // `null` is reserved for a genuine broadcast (a heartbeat fan-in). It is NOT
  // "unspecified": a record that failed to name its recipient and was silently
  // delivered to everyone is exactly the confusion this column prevents.
  recipientNodeId: nodeIdSchema.nullable(),
  protocolVersion: protocolVersionSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
}).strict()

export type MeshEnvelopeHeaders = z.infer<typeof meshEnvelopeHeadersSchema>

function addIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: "custom", path, message })
}

/**
 * Compares two branded identifiers.
 *
 * The brands are compile-time only and exist to stop a `ProjectId` being passed
 * where a `RunId` is wanted; a *comparison* between two ids of different brands
 * is exactly the question the closure checks below need to ask, so the widening
 * happens here, once, rather than as a cast at every call site.
 */
export function sameId(left: string, right: string): boolean {
  return left === right
}

/**
 * The two envelope-wide invariants.
 *
 * 1. `expiresAt > issuedAt`. The envelope's `expiresAt` is a REPLAY WINDOW, not
 *    a lease, and a zero-width window is a record that is expired the instant it
 *    is sent. A zero-width window does not fail closed — it fails *open* under
 *    any clock disagreement, so it is refused outright.
 *
 * 2. `canonicalByteLength <= MAX_ENVELOPE_BYTES`. Enforced at the ONE parse
 *    entry point rather than in each gateway, because a limit that each transport
 *    has to remember is a limit the next transport forgets.
 *
 * The parameter is a `Pick` of the two timestamps, not the whole header, because
 * that is all invariant 1 needs and it lets a caller state the invariant on its
 * own. Invariant 2 measures whatever it is given, so a caller passing a
 * partial value would under-measure — which is why the only production caller is
 * `defineFamily`, and it always passes a complete envelope.
 */
export function assertEnvelopeInvariants(
  envelope: Pick<MeshEnvelopeHeaders, "issuedAt" | "expiresAt"> & { readonly recordType?: string },
  ctx: z.RefinementCtx,
): void {
  if (Date.parse(envelope.expiresAt) <= Date.parse(envelope.issuedAt)) {
    addIssue(
      ctx,
      ["expiresAt"],
      `Envelope expiry ${envelope.expiresAt} must be strictly later than issue time ${envelope.issuedAt}; a zero-width replay window accepts everything under clock disagreement`,
    )
  }
  const bytes = canonicalByteLength(envelope)
  if (bytes > MAX_ENVELOPE_BYTES) {
    addIssue(
      ctx,
      ["payload"],
      `Envelope is ${bytes} canonical bytes, over the ${MAX_ENVELOPE_BYTES} byte bound; beyond this a record is abuse rather than a dispatch`,
    )
  }
}

export interface FamilyEnvelope<TPayload> extends MeshEnvelopeHeaders {
  readonly recordType: MeshRecordType
  readonly payload: TPayload
}

export interface FamilyDefinition<TPayload> {
  readonly recordType: MeshRecordType
  readonly payloadSchema: z.ZodType<TPayload>
  /**
   * Family-specific closure checks — the invariants that bind the payload to the
   * envelope around it. This is where a family asserts "the correlation id on
   * the envelope is the id of the thing in the payload", which is the only place
   * that question can be answered.
   */
  readonly refine?: (envelope: FamilyEnvelope<TPayload>, ctx: z.RefinementCtx) => void
}

export interface Family<TPayload> {
  readonly recordType: MeshRecordType
  readonly envelopeSchema: z.ZodType<FamilyEnvelope<TPayload>>
  /**
   * The version table handed to `parseVersioned`. Declared at exactly one
   * version on purpose: a family with a single shape is a family that has never
   * had to answer "which version is this", which is the question a multi-version
   * table invites and the question M4.1 exists to force.
   */
  readonly shapes: VersionedShapes
}

function envelopeRefiner<TPayload>(definition: FamilyDefinition<TPayload>) {
  return (envelope: FamilyEnvelope<TPayload>, ctx: z.RefinementCtx): void => {
    assertEnvelopeInvariants(envelope, ctx)
    definition.refine?.(envelope, ctx)
  }
}

/**
 * Wraps one family payload in the common envelope and declares its version table.
 *
 * There is intentionally no way to obtain `payloadSchema` from the returned
 * `Family`: the only handle a caller gets is `envelopeSchema`, which cannot be
 * used without an envelope, and `shapes`, whose only correct consumer is
 * `parseVersioned`. A family that exported its bare payload object for direct
 * `.parse()` would let a caller validate a record that was never bound to a
 * sender, a version, or a replay window — which is how the Milestone 3 shape
 * break was unversionable in the first place.
 */
export function defineFamily<TPayload>(definition: FamilyDefinition<TPayload>): Family<TPayload> {
  const envelopeSchema = meshEnvelopeHeadersSchema
    .extend({ recordType: z.literal(definition.recordType), payload: definition.payloadSchema })
    .strict()
    .superRefine(envelopeRefiner(definition))

  return {
    recordType: definition.recordType,
    envelopeSchema,
    shapes: { [CURRENT_SCHEMA_VERSION]: envelopeSchema },
  }
}

// --- Replay window -------------------------------------------------------

/**
 * `expiresAt` bounds exposure, it does not provide idempotency.
 *
 * A record replayed INSIDE the window is still applied or not according to
 * per-family idempotency (`commandId` + digest, `eventId`, `localSequence`).
 * The window exists so that a captured command cannot be resurrected months
 * later against a projection it was never decided against — and, just as
 * importantly, so the capture is detectable at all.
 */
export type ReplayWindowVerdict =
  | { readonly ok: true; readonly withinWindow: true; readonly nowMs: number; readonly issuedAtMs: number; readonly expiresAtMs: number }
  | {
      readonly ok: false
      readonly reason: "expired" | "not_yet_valid"
      readonly error: ContractError
    }

export interface ReplayWindowOptions {
  /** Overrides `REPLAY_WINDOW_MS`; used by tests, never by a gateway. */
  readonly skewAllowanceMs?: number
}

/**
 * Decides whether an envelope is inside its replay window at `nowMs`.
 *
 * `nowMs` is a parameter, never `Date.now()`. That is not stylistic: the
 * partition and restart scenarios in the sequence diagrams are about what
 * happens minutes after a lease stopped being renewed, and a module that read
 * the clock itself could only be tested by sleeping.
 *
 * A FUTURE `issuedAt` is a separate failure from an expired record, and gets a
 * separate code. Collapsing them would tell an operator to investigate clock
 * skew when the real cause is a replay, or the reverse.
 */
export function evaluateReplayWindow(
  envelope: Pick<MeshEnvelopeHeaders, "issuedAt" | "expiresAt">,
  nowMs: number,
  options?: ReplayWindowOptions,
): ReplayWindowVerdict {
  const skewAllowanceMs = options?.skewAllowanceMs ?? REPLAY_WINDOW_MS
  const issuedAtMs = Date.parse(envelope.issuedAt)
  const expiresAtMs = Date.parse(envelope.expiresAt)

  if (nowMs > expiresAtMs) {
    return {
      ok: false,
      reason: "expired",
      error: createContractError(
        "validation",
        "protocol.record_expired",
        `Record expired at ${envelope.expiresAt}; it is being read at ${new Date(nowMs).toISOString()}. Either a replay attempt or clock skew beyond the window.`,
      ),
    }
  }

  if (nowMs < issuedAtMs - skewAllowanceMs) {
    return {
      ok: false,
      reason: "not_yet_valid",
      error: createContractError(
        "validation",
        "protocol.record_not_yet_valid",
        `Record claims to have been issued at ${envelope.issuedAt}, ${issuedAtMs - nowMs}ms ahead of the reader's clock; the allowance is ${skewAllowanceMs}ms`,
      ),
    }
  }

  return { ok: true, withinWindow: true, nowMs, issuedAtMs, expiresAtMs }
}

/** Convenience for a seam that wants the `Result` shape rather than the verdict. */
export function checkReplayWindow(
  envelope: Pick<MeshEnvelopeHeaders, "issuedAt" | "expiresAt">,
  nowMs: number,
  options?: ReplayWindowOptions,
): Result<true> {
  const verdict = evaluateReplayWindow(envelope, nowMs, options)
  return verdict.ok ? { ok: true, value: true } : { ok: false, error: verdict.error }
}

export type { SchemaVersion }

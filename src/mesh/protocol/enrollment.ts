import { z } from "zod"
import { meshIdSchema, nodeIdSchema, timestampSchema } from "../../orchestration/identifiers.js"
import { defineFamily, sameId, type FamilyEnvelope } from "./envelope.js"
import {
  ARRAY_MAX,
  base64UrlSchema,
  codeHashSchema,
  enrollmentIdSchema,
  keyFingerprintSchema,
  nodeKeyIdSchema,
  provisionalNodeIdSchema,
} from "./identifiers.js"

/**
 * Enrollment is the only path to a node being addressable, so both halves of the
 * exchange are ordinary versioned wire families. If enrollment were an ad-hoc
 * side channel, "enrolled" would be a claim a node makes about itself, and
 * revocation — which the milestone requires to be individual — would have
 * nothing to revoke.
 */

/** One node's pinned ed25519 public key. */
export const peerKeyPinSchema = z
  .object({
    nodeId: nodeIdSchema,
    nodeKeyId: nodeKeyIdSchema,
    /** base64url, unpadded: exactly one spelling per key. */
    publicKey: base64UrlSchema,
    fingerprint: keyFingerprintSchema,
    pinnedAt: timestampSchema,
  })
  .strict()

export const meshEnrollmentRequestSchema = z
  .object({
    meshId: meshIdSchema,
    enrollmentId: enrollmentIdSchema,
    /**
     * sha256 of the one-time code. The raw code is never carried here a second
     * time: it travelled once over an already-authenticated local/admin flow,
     * and putting it on the mesh would turn a single-use secret into a
     * replayable one.
     */
    enrollmentCodeHash: codeHashSchema,
    nodePublicKey: base64UrlSchema,
    nodeDisplayName: z.string().min(1).max(256),
    /** The joining node has no `NodeId` yet; this is what it asks to be called. */
    provisionalNodeId: provisionalNodeIdSchema,
    requestedAt: timestampSchema,
    codeExpiresAt: timestampSchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    if (Date.parse(request.codeExpiresAt) <= Date.parse(request.requestedAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["codeExpiresAt"],
        message: "A one-time code must expire strictly after it is requested; a zero-width code window is an always-valid code",
      })
    }
  })

/**
 * Why an enrollment was refused.
 *
 * A closed list rather than free text: this value lands in a durable log that an
 * operator reads to decide whether a node is misconfigured or hostile, and a
 * free-text reason from an unauthenticated peer is a place to put whatever the
 * peer wants written.
 */
export const ENROLLMENT_REJECTION_REASONS = [
  "unknown_mesh",
  "code_unknown",
  "code_expired",
  "code_already_used",
  "key_mismatch",
  "no_common_protocol_version",
  "mesh_full",
] as const

export const meshEnrollmentResponseSchema = z
  .object({
    enrollmentId: enrollmentIdSchema,
    meshId: meshIdSchema,
    outcome: z.enum(["accepted", "rejected"]),
    /**
     * Required on BOTH outcomes. A rejected response still names the node id the
     * controller would have minted, so a retrying peer can correlate its own
     * attempts; a `nodeId` that only exists on success makes "why did my second
     * attempt behave differently" unanswerable from the wire.
     */
    nodeId: nodeIdSchema,
    nodeKeyId: nodeKeyIdSchema,
    peerKeyPins: z.array(peerKeyPinSchema).max(ARRAY_MAX),
    decidedAt: timestampSchema,
    rejectionReason: z.enum(ENROLLMENT_REJECTION_REASONS).optional(),
  })
  .strict()
  .superRefine((response, ctx) => {
    if (response.outcome === "rejected" && response.rejectionReason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["rejectionReason"],
        message: "A rejected enrollment must say why; a refusal an operator cannot read is indistinguishable from a flaky network",
      })
    }
    if (response.outcome === "accepted" && response.rejectionReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["rejectionReason"],
        message: "An accepted enrollment cannot carry a rejection reason; the two would disagree about whether the node is addressable",
      })
    }
  })

export const enrollmentRequestFamily = defineFamily({
  recordType: "mesh.enrollment.request",
  payloadSchema: meshEnrollmentRequestSchema,
  refine: (envelope, ctx) => {
    // Closure: an enrollment request's own identity is its correlation. An
    // envelope whose correlationId names something else is either a misrouted
    // record or a record deliberately re-labelled, and both must fail before the
    // controller spends a code comparison on it.
    if (!sameId(envelope.correlationId, envelope.payload.enrollmentId)) {
      ctx.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: `Enrollment request correlation '${envelope.correlationId}' must equal the enrollment id '${envelope.payload.enrollmentId}'`,
      })
    }
  },
})

export const enrollmentResponseFamily = defineFamily({
  recordType: "mesh.enrollment.response",
  payloadSchema: meshEnrollmentResponseSchema,
  refine: (envelope, ctx) => {
    if (!sameId(envelope.correlationId, envelope.payload.enrollmentId)) {
      ctx.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: `Enrollment response correlation '${envelope.correlationId}' must equal the enrollment id '${envelope.payload.enrollmentId}'`,
      })
    }
    const causation = envelope.causation
    if (causation !== null && causation.kind !== "enrollment") {
      ctx.addIssue({
        code: "custom",
        path: ["causation"],
        message: `An enrollment response is caused by an enrollment, not by '${causation.kind}'`,
      })
    }
    if (causation?.kind === "enrollment" && !sameId(causation.enrollmentId, envelope.payload.enrollmentId)) {
      ctx.addIssue({
        code: "custom",
        path: ["causation", "enrollmentId"],
        message: "Enrollment causation must name the enrollment this response decides",
      })
    }
  },
})

export type MeshEnrollmentRequest = z.infer<typeof meshEnrollmentRequestSchema>
export type MeshEnrollmentResponse = z.infer<typeof meshEnrollmentResponseSchema>
export type PeerKeyPin = z.infer<typeof peerKeyPinSchema>
export type EnrollmentRejectionReason = (typeof ENROLLMENT_REJECTION_REASONS)[number]
export type MeshEnrollmentRequestEnvelope = FamilyEnvelope<MeshEnrollmentRequest>
export type MeshEnrollmentResponseEnvelope = FamilyEnvelope<MeshEnrollmentResponse>

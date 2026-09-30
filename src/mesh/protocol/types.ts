import type { z } from "zod"
import type { MeshEnvelopeHeaders } from "./envelope.js"
import type { MeshAck } from "./ack.js"
import type { MeshCommand } from "./command.js"
import type { MeshEnrollmentRequest, MeshEnrollmentResponse } from "./enrollment.js"
import type { MeshEvent } from "./event.js"
import type { MeshHeartbeat } from "./heartbeat.js"
import type { MeshLease } from "./lease.js"
import type { MeshReconciliationRequest, MeshReconciliationResponse } from "./reconciliation.js"
import type { MeshTerminalControl, MeshTerminalData } from "./terminal.js"

/**
 * The public type surface of the mesh protocol.
 *
 * Type-only imports, so this module has no runtime identity and cannot become a
 * cycle with the families that will eventually import from here. `MeshEnvelope`
 * is a DISCRIMINATED UNION over the per-family envelope schemas, which is what
 * lets a gateway switch on `recordType` and get a correctly typed payload — a
 * single `payload: unknown` envelope would push that cast to every call site, and
 * a cast at every call site is a cast that will eventually be wrong at one.
 */

export type {
  MeshEnvelopeHeaders,
  FamilyEnvelope,
  ReplayWindowVerdict,
  ReplayWindowOptions,
} from "./envelope.js"
export type { MeshRecordType } from "./envelope.js"
export type { SafePattern, SafePatternRefusal, SafePatternFailure } from "./safe-pattern.js"
export type { RuleWrite, PreparedRule, RuleAuthorContext, RuleWriteRefusal, RuleWriteFailure, RuleWriteResult } from "./rules.js"
export type { HeldLease, LeaseEvaluation, LeaseEvaluationContext, LeaseRefusalReason } from "./lease.js"
export type { IncomingCommandExpectation, VerifiedIncomingCommand, IncomingCommandFailure, VerifyIncomingCommandResult } from "./command.js"
export type { LocalSequenceVerdict, SequenceStatus } from "./event.js"
export type { ReconcileContext, ReconciliationStepVerdict, ReconciliationVerdict, UnreconciledReason } from "./reconciliation.js"
export type { CommandReceipt } from "./ack.js"
export type { TerminalAdmission } from "./terminal.js"
export type { HeartbeatFreshness, HeartbeatSequenceVerdict } from "./heartbeat.js"
export type { NegotiationMismatch } from "./negotiation.js"

/**
 * One member per `recordType`, discriminated so `payload` narrows with it.
 *
 * INTERSECTED with {@link MeshEnvelopeHeaders} rather than being the union of
 * `{recordType, payload}` alone. The headers are what a receiver has to see: a
 * parsed envelope that had dropped `schemaVersion` would leave the caller unable
 * to tell which shape it actually received, and `protocolVersion` unobservable,
 * which is the whole point of the mechanism rather than an incidental field. The
 * previous declaration described only the discriminator and the payload, so every
 * consumer of the parse result had to reach for the untyped input to learn the
 * version — i.e. the type said "read it yourself off the bytes", which is the
 * failure mode M4-V exists to prevent.
 */
export type MeshEnvelope = MeshEnvelopeHeaders &
  (
    | { readonly recordType: "mesh.enrollment.request"; readonly payload: MeshEnrollmentRequest }
    | { readonly recordType: "mesh.enrollment.response"; readonly payload: MeshEnrollmentResponse }
    | { readonly recordType: "mesh.heartbeat"; readonly payload: MeshHeartbeat }
    | { readonly recordType: "mesh.command"; readonly payload: MeshCommand }
    | { readonly recordType: "mesh.ack"; readonly payload: MeshAck }
    | { readonly recordType: "mesh.event"; readonly payload: MeshEvent }
    | { readonly recordType: "mesh.lease"; readonly payload: MeshLease }
    | { readonly recordType: "mesh.reconciliation.request"; readonly payload: MeshReconciliationRequest }
    | { readonly recordType: "mesh.reconciliation.response"; readonly payload: MeshReconciliationResponse }
    | { readonly recordType: "mesh.terminal.control"; readonly payload: MeshTerminalControl }
    | { readonly recordType: "mesh.terminal.data"; readonly payload: MeshTerminalData }
  )

/** The payload carried by a given `recordType`. */
export type MeshPayloadOf<T extends MeshEnvelope["recordType"]> = Extract<MeshEnvelope, { readonly recordType: T }>["payload"]

/**
 * The `payload` of a `mesh.command` or `mesh.event`, which is a canonical
 * `OrchestrationCommand` / `OrchestrationEvent` and not a mesh-specific shape.
 * Alias kept here so a consumer that only imports the protocol surface does not
 * have to reach into `src/orchestration` to name the type it is handling.
 */
export type { OrchestrationCommand, OrchestrationEvent } from "../../orchestration/types.js"

export type { SchemaVersion } from "../../orchestration/identifiers.js"
export type { ContractError, Result } from "../../orchestration/errors.js"
export type { VersionedParseResult } from "../../orchestration/versioning.js"

export type ZodType<T> = z.ZodType<T>

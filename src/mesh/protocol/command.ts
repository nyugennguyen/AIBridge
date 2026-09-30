import { z } from "zod"
import { digestJson } from "../../orchestration/digest.js"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import {
  commandIdSchema,
  digestSchema,
  dispatchIdSchema,
  epochSchema,
  leaseIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  timestampSchema,
  type CommandId,
  type Digest,
  type DispatchId,
  type Epoch,
  type LeaseId,
  type NodeId,
  type ProjectId,
  type RunId,
  type Timestamp,
} from "../../orchestration/identifiers.js"
import { orchestrationCommandSchema } from "../../orchestration/schemas.js"
import type { OrchestrationCommand } from "../../orchestration/types.js"
import { COMMAND_MATRIX } from "../../orchestration/invariants.js"
import { MAX_COMMAND_PAYLOAD_BYTES, canonicalByteLength } from "./bounds.js"
import { defineFamily, evaluateReplayWindow, sameId } from "./envelope.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "./negotiation.js"

/**
 * `mesh.command` — the controller's instruction to one worker.
 *
 * The wire record is the kernel's `OrchestrationCommand` PLUS the delivery
 * envelope the mesh needs and the domain does not: which node it is for, which
 * controller minted it, at which epoch, and a digest of the payload so the
 * receiver can tell a retry from a forgery. The command itself is NOT re-modelled
 * here; a second, mesh-specific command shape would be a second vocabulary to
 * keep in step with `COMMAND_MATRIX`, and the plan's "the matrix is the single
 * source of allowed states" would then be false.
 */

export const meshCommandSchema = z
  .object({
    /**
     * The MESH protocol version this command was minted under, distinct from the
     * `schemaVersion` on the envelope and on the command itself. Three axes, one
     * record: shape (schemaVersion), dialect (protocolVersion), and storage
     * layout (the database version, which must never appear here — it tracks
     * where rows live, not what a peer can understand).
     */
    meshProtocolVersion: z.number().int().positive().safe(),
    commandId: commandIdSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    /** Nullable for run-scoped commands (`run.pause` is not about one dispatch). */
    dispatchId: dispatchIdSchema.nullable(),
    targetNodeId: nodeIdSchema,
    controllerNodeId: nodeIdSchema,
    controllerEpoch: epochSchema,
    leaseId: leaseIdSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    commandType: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    /** sha256 over the canonical `command`. Recomputed by the receiver. */
    payloadDigest: digestSchema,
    command: orchestrationCommandSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    // --- The command's own scope must match the delivery scope. --------------
    // A record whose envelope says project P and whose payload says project Q is
    // the exact shape of "authorize against your own payload": the receiver
    // would resolve a permission decision in P against a dispatch in Q.
    const command = record.command
    if (!sameId(command.projectId, record.projectId)) {
      ctx.addIssue({ code: "custom", path: ["command", "projectId"], message: "Command project ID must match the mesh record scope" })
    }
    if (!sameId(command.runId, record.runId)) {
      ctx.addIssue({ code: "custom", path: ["command", "runId"], message: "Command run ID must match the mesh record scope" })
    }
    if (!sameId(command.commandId, record.commandId)) {
      ctx.addIssue({ code: "custom", path: ["command", "commandId"], message: "Command ID must match the mesh record command ID" })
    }
    if (!sameId(command.controllerNodeId, record.controllerNodeId)) {
      ctx.addIssue({ code: "custom", path: ["command", "controllerNodeId"], message: "Controller node must match the mesh record controller node" })
    }
    if (!sameId(command.leaseId, record.leaseId)) {
      ctx.addIssue({ code: "custom", path: ["command", "leaseId"], message: "Lease ID must match the mesh record lease" })
    }
    if (command.controllerEpoch !== record.controllerEpoch) {
      ctx.addIssue({ code: "custom", path: ["command", "controllerEpoch"], message: "Controller epoch must match the mesh record epoch" })
    }
    if (command.issuedAt !== record.issuedAt) {
      ctx.addIssue({ code: "custom", path: ["command", "issuedAt"], message: "Issued time must match the mesh record issue time; two issue times is one retry window too many" })
    }
    if (command.expiresAt !== record.expiresAt) {
      ctx.addIssue({ code: "custom", path: ["command", "expiresAt"], message: "Expiry must match the mesh record expiry" })
    }
    const payloadDispatchId = dispatchIdOf(command)
    if (record.dispatchId !== null && (payloadDispatchId === null || !sameId(record.dispatchId, payloadDispatchId))) {
      ctx.addIssue({ code: "custom", path: ["dispatchId"], message: "Mesh dispatch ID must match the dispatch named by the command payload" })
    }

    // --- The command type must be one the matrix knows about. ----------------
    // This is a type-level check, not the matrix gate: it stops an unknown
    // command type from being minted at all. Whether the command is allowed in
    // the states it will act in is `COMMAND_MATRIX`'s job at the command seam
    // (M4.4), resolved against RECORDED state, not against this payload.
    if (!(record.commandType in COMMAND_MATRIX)) {
      ctx.addIssue({
        code: "custom",
        path: ["commandType"],
        message: `Command type '${record.commandType}' has no COMMAND_MATRIX entry; a command with no matrix row cannot be licensed`,
      })
    } else if (record.commandType !== command.type) {
      ctx.addIssue({ code: "custom", path: ["commandType"], message: "Declared command type must equal the command payload type" })
    }

    // --- Payload size. -------------------------------------------------------
    const bytes = canonicalByteLength(command)
    if (bytes > MAX_COMMAND_PAYLOAD_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["command"],
        message: `Command payload is ${bytes} canonical bytes, over the ${MAX_COMMAND_PAYLOAD_BYTES} byte bound`,
      })
    }
  })

/**
 * The dispatch a command acts on, or `null` for a run-scoped command.
 *
 * Extracted rather than pattern-matched inline three times, because "which
 * dispatch does this command concern" is a question with exactly one answer and
 * an inline re-derivation is a place for two answers to diverge.
 */
export function dispatchIdOf(command: OrchestrationCommand): DispatchId | null {
  switch (command.type) {
    case "dispatch.propose":
    case "dispatch.approve":
    case "dispatch.execute":
    case "dispatch.retry":
      return command.payload.dispatch.envelope.dispatchId
    case "dispatch.timeout.request":
      return command.payload.dispatchId
    default:
      return null
  }
}

export const commandFamily = defineFamily({
  recordType: "mesh.command",
  payloadSchema: meshCommandSchema,
  refine: (envelope, ctx) => {
    if (!sameId(envelope.correlationId, envelope.payload.commandId)) {
      ctx.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: `A command envelope correlates on its own command id; got '${envelope.correlationId}' for '${envelope.payload.commandId}'`,
      })
    }
    // A command is the head of its conversation. A causation pointing at another
    // command would let a command claim to be a consequence of a command the log
    // never recorded, which is the recorded-log-authority rule with the sign
    // flipped.
    if (envelope.causation !== null && envelope.causation.kind !== "command") {
      ctx.addIssue({
        code: "custom",
        path: ["causation"],
        message: `A mesh.command may only be caused by a command, not by '${envelope.causation.kind}'`,
      })
    }
    if (envelope.causation?.kind === "command" && !sameId(envelope.causation.commandId, envelope.payload.commandId)) {
      ctx.addIssue({
        code: "custom",
        path: ["causation", "commandId"],
        message: "Command causation must name the command it carries; a self-causation is a retry, and a retry is idempotency, not causation",
      })
    }
    if (envelope.recipientNodeId !== null && !sameId(envelope.recipientNodeId, envelope.payload.targetNodeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["recipientNodeId"],
        message: `Command is addressed to '${envelope.recipientNodeId}' but targets '${envelope.payload.targetNodeId}'`,
      })
    }
    if (!sameId(envelope.senderNodeId, envelope.payload.controllerNodeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["senderNodeId"],
        message: `Only the controller node may send a command; '${envelope.senderNodeId}' is not '${envelope.payload.controllerNodeId}'`,
      })
    }
  },
})

export type MeshCommand = z.infer<typeof meshCommandSchema>

/**
 * The exact command minting seam, so a caller cannot build a record that fails
 * its own digest check.
 */
export interface MintMeshCommandInput {
  readonly command: OrchestrationCommand
  readonly targetNodeId: NodeId
  readonly dispatchId?: DispatchId | null
}

/** Builds the wire record for a command, digesting the payload as it goes. */
export function mintMeshCommand(input: MintMeshCommandInput): MeshCommand {
  const { command } = input
  const dispatchId = input.dispatchId === undefined ? dispatchIdOf(command) : input.dispatchId
  return meshCommandSchema.parse({
    meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    commandId: command.commandId,
    projectId: command.projectId,
    runId: command.runId,
    dispatchId,
    targetNodeId: input.targetNodeId,
    controllerNodeId: command.controllerNodeId,
    controllerEpoch: command.controllerEpoch,
    leaseId: command.leaseId,
    issuedAt: command.issuedAt,
    expiresAt: command.expiresAt,
    commandType: command.type,
    payloadDigest: digestJson(command),
    command,
  })
}

// --- Incoming verification ----------------------------------------------

/**
 * What the RECEIVING node already knows before a command arrives.
 *
 * Every field here comes from the receiver's own durable state — its own
 * identity, the lease it accepted, and the clock. Nothing here comes from the
 * incoming record, which is the whole point: `verifyIncomingCommand` compares a
 * claim against a fact, and a "fact" that was read out of the claim verifies
 * nothing.
 */
export interface IncomingCommandExpectation {
  /** This node's own id. A command addressed elsewhere is not ours to run. */
  readonly recipientNodeId: NodeId
  /** The controller this node currently accepts instructions from. */
  readonly controllerNodeId: NodeId
  readonly projectId: ProjectId
  readonly runId: RunId
  /** The epoch of the lease this node currently accepts. */
  readonly acceptedEpoch: Epoch
  /** Caller-supplied clock reading in epoch milliseconds. */
  readonly nowMs: number
}

export interface VerifiedIncomingCommand {
  readonly record: MeshCommand
  readonly command: OrchestrationCommand
  readonly commandId: CommandId
  readonly payloadDigest: Digest
  readonly recomputedDigest: Digest
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly controllerEpoch: Epoch
  readonly dispatchId: DispatchId | null
  /**
   * The payload's AUTHORIZATION POINTERS, explicitly unverified.
   *
   * A command may carry an `approval`, a `dispatch` and a `leaseId`. All three
   * are POINTERS: they say which records the controller believes exist. The
   * grant is whatever the event log recorded, and this protocol layer has no
   * access to it. Naming the field `authorizationClaims` rather than `approval`
   * is deliberate — a name like `authorized` on a value derived from a payload
   * is the defect M3.8 and M4.0 both closed once already, in the same place.
   */
  readonly authorizationClaims: {
    readonly approvalId: string | null
    readonly dispatchId: DispatchId | null
    readonly leaseId: LeaseId
    readonly controllerEpoch: Epoch
  }
}

export type IncomingCommandFailure =
  | "payload_digest_mismatch"
  | "epoch_not_self_consistent"
  | "recipient_mismatch"
  | "controller_mismatch"
  | "project_mismatch"
  | "run_mismatch"
  | "dispatch_scope_mismatch"
  | "epoch_stale"
  | "epoch_unregistered"
  | "expired"
  | "not_yet_valid"

export type VerifyIncomingCommandResult =
  | { readonly ok: true; readonly value: VerifiedIncomingCommand }
  | { readonly ok: false; readonly reason: IncomingCommandFailure; readonly error: ContractError }

/**
 * Re-derives every fact a `mesh.command` asserts and compares it to what this
 * node already believes.
 *
 * WHAT THIS IS NOT: it is not authorization, and it must never be mistaken for
 * it. It confirms that the command is INTACT, ADDRESSED HERE, and MINTED BY THE
 * CONTROLLER THIS NODE ACCEPTS at an epoch this node accepts. It does not check
 * that a dispatch was approved, that the capabilities are permitted, that the
 * task is ready, or that the target node may run this work at all. Those are
 * resolved against the RECORDED log by M4.4's command seam, and the plan's
 * "a command is authorized against the recorded log, never against its own
 * payload" is why this function returns the approval and dispatch ids as CLAIMS
 * rather than resolving them here.
 *
 * ORDER IS LOAD-BEARING and is integrity → addressing → authority → time:
 *
 *   1. digest. If the bytes do not hash to the digest they carry, nothing they
 *      say is worth comparing, and reporting a scope mismatch for a tampered
 *      record would point an operator at the wrong defect.
 *   2. addressing and scope. Cheap, and it decides whether this node should
 *      care at all.
 *   3. epoch. Lower is stale, higher is UNREGISTERED — refused, not queued,
 *      because a command minted under a superseded controller was decided
 *      against a projection that no longer exists.
 *   4. time, last, because an expired command must be reported as expired even
 *      if the clock is also skewed.
 */
export function verifyIncomingCommand(
  record: MeshCommand,
  expected: IncomingCommandExpectation,
): VerifyIncomingCommandResult {
  const fail = (reason: IncomingCommandFailure, error: ContractError): VerifyIncomingCommandResult => ({
    ok: false,
    reason,
    error,
  })

  // 1. Integrity.
  const recomputedDigest = digestJson(record.command)
  if (recomputedDigest !== record.payloadDigest) {
    return fail(
      "payload_digest_mismatch",
      createContractError(
        "conflict",
        "protocol.payload_digest_mismatch",
        `Command '${record.commandId}' declares payload digest ${record.payloadDigest} but its payload canonicalises to ${recomputedDigest}. The record is refused and MUST NOT be persisted.`,
      ),
    )
  }

  // 2. Addressing and scope.
  const payloadDispatchId = dispatchIdOf(record.command)
  if (!sameId(record.targetNodeId, expected.recipientNodeId)) {
    return fail(
      "recipient_mismatch",
      createContractError(
        "policy_denied",
        "protocol.command_not_addressed_here",
        `Command '${record.commandId}' targets node '${record.targetNodeId}', not this node '${expected.recipientNodeId}'`,
      ),
    )
  }
  if (!sameId(record.controllerNodeId, expected.controllerNodeId)) {
    return fail(
      "controller_mismatch",
      createContractError(
        "policy_denied",
        "protocol.command_from_unknown_controller",
        `Command '${record.commandId}' claims controller '${record.controllerNodeId}'; this node accepts instructions from '${expected.controllerNodeId}' only`,
      ),
    )
  }
  if (!sameId(record.projectId, expected.projectId)) {
    return fail(
      "project_mismatch",
      createContractError(
        "policy_denied",
        "protocol.command_project_scope_mismatch",
        `Command '${record.commandId}' is scoped to project '${record.projectId}'; this node's lease covers '${expected.projectId}'`,
      ),
    )
  }
  if (!sameId(record.runId, expected.runId)) {
    return fail(
      "run_mismatch",
      createContractError(
        "policy_denied",
        "protocol.command_run_scope_mismatch",
        `Command '${record.commandId}' is scoped to run '${record.runId}'; this node's lease covers '${expected.runId}'`,
      ),
    )
  }
  if (record.dispatchId !== null && (payloadDispatchId === null || !sameId(record.dispatchId, payloadDispatchId))) {
    return fail(
      "dispatch_scope_mismatch",
      createContractError(
        "policy_denied",
        "protocol.command_dispatch_scope_mismatch",
        `Command '${record.commandId}' names dispatch '${record.dispatchId}' but its payload acts on a different dispatch`,
      ),
    )
  }
  if (record.command.controllerEpoch !== record.controllerEpoch) {
    return fail(
      "epoch_not_self_consistent",
      createContractError(
        "validation",
        "protocol.command_epoch_not_self_consistent",
        `Command '${record.commandId}' carries epoch ${record.controllerEpoch} but its payload carries ${record.command.controllerEpoch}`,
      ),
    )
  }

  // 3. Authority. Both directions are refusals and neither is "queue it".
  if (record.controllerEpoch < expected.acceptedEpoch) {
    return fail(
      "epoch_stale",
      createContractError(
        "stale_epoch",
        "epoch.stale",
        `Command '${record.commandId}' was minted at epoch ${record.controllerEpoch}, below the accepted epoch ${expected.acceptedEpoch}. It is dropped, NOT queued: it was decided against a projection that no longer exists.`,
      ),
    )
  }
  if (record.controllerEpoch > expected.acceptedEpoch) {
    return fail(
      "epoch_unregistered",
      createContractError(
        "conflict",
        "epoch.unregistered",
        `Command '${record.commandId}' claims epoch ${record.controllerEpoch}, above the accepted epoch ${expected.acceptedEpoch}. A higher epoch is only ever accepted through an explicit lease takeover.`,
      ),
    )
  }

  // 4. Time.
  const window = evaluateReplayWindow({ issuedAt: record.issuedAt, expiresAt: record.expiresAt }, expected.nowMs)
  if (!window.ok) {
    return fail(window.reason === "expired" ? "expired" : "not_yet_valid", window.error)
  }

  const payload = record.command
  const approvalId =
    payload.type === "dispatch.approve" || payload.type === "dispatch.execute" ? payload.payload.approval.approvalId : null

  return {
    ok: true,
    value: {
      record,
      command: payload,
      commandId: record.commandId,
      payloadDigest: record.payloadDigest,
      recomputedDigest,
      projectId: record.projectId,
      runId: record.runId,
      controllerEpoch: record.controllerEpoch,
      dispatchId: record.dispatchId,
      authorizationClaims: {
        approvalId,
        dispatchId: record.dispatchId,
        leaseId: record.leaseId,
        controllerEpoch: record.controllerEpoch,
      },
    },
  }
}

/** The `Result` flavour, for seams that prefer it. */
export function checkIncomingCommand(
  record: MeshCommand,
  expected: IncomingCommandExpectation,
): Result<VerifiedIncomingCommand> {
  const verdict = verifyIncomingCommand(record, expected)
  return verdict.ok ? { ok: true, value: verdict.value } : { ok: false, error: verdict.error }
}

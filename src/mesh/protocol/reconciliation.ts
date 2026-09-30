import { z } from "zod"
import { createContractError, type ContractError, type Result } from "../../orchestration/errors.js"
import {
  commandIdSchema,
  digestSchema,
  dispatchIdSchema,
  epochSchema,
  eventIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  sessionIdSchema,
  timestampSchema,
  type Epoch,
} from "../../orchestration/identifiers.js"
import { defineFamily, sameId } from "./envelope.js"
import { ARRAY_MAX, reconcileIdSchema, protocolVersionListSchema } from "./identifiers.js"
import { selectProtocolVersion } from "./negotiation.js"

/**
 * `mesh.reconciliation` — the reconnect protocol, in the plan's six steps.
 *
 * The response type is the load-bearing artefact here, and not for the fields it
 * has but for the ones it does NOT have: there is no `adopt`, no `terminate`, no
 * `adoptSessionIds`, no `kill`, no `closeTerminal`. Step 6 of the plan is "mark
 * unexplained differences for user review; do not silently adopt or terminate",
 * and it is enforced by the ABSENCE OF A MEMBER rather than by the discipline of
 * whoever writes the handler. A handler that wanted to terminate a session would
 * have to invent a field, invent a command, and put it in the same record — all
 * of which are reviewable, and none of which is available by accident.
 *
 * `unreconciled[]` is the only way a difference reaches a human, and it carries a
 * `reason` and a free-text `detail` so the user is shown WHAT was different
 * rather than only that something was.
 */

const MAX_DETAIL_LENGTH = 4_096

export const activeSessionInventoryEntrySchema = z
  .object({
    sessionId: sessionIdSchema,
    dispatchId: dispatchIdSchema,
    startedAt: timestampSchema,
  })
  .strict()

export const meshReconciliationRequestSchema = z
  .object({
    reconcileId: reconcileIdSchema,
    projectId: projectIdSchema,
    runId: runIdSchema,
    controllerNodeId: nodeIdSchema,
    controllerEpoch: epochSchema,
    peerNodeId: nodeIdSchema,
    /** Step 1: the versions this peer speaks, compared before anything else. */
    peerProtocolVersions: protocolVersionListSchema,
    /** Step 2: how far each side's durable queues have got. */
    controllerLastAcknowledgedInboxSequence: z.number().int().nonnegative().safe(),
    controllerLastAcknowledgedOutboxSequence: z.number().int().nonnegative().safe(),
    observedAt: timestampSchema,
    /** Step 5: the worker's live sessions, for the controller to diff. */
    activeSessionInventory: z.array(activeSessionInventoryEntrySchema).max(ARRAY_MAX),
  })
  .strict()
  .superRefine((request, ctx) => {
    const sessionIds = request.activeSessionInventory.map((entry) => entry.sessionId)
    if (new Set(sessionIds).size !== sessionIds.length) {
      ctx.addIssue({ code: "custom", path: ["activeSessionInventory"], message: "Session inventory must be unique by session id" })
    }
    const dispatchIds = request.activeSessionInventory.map((entry) => entry.dispatchId)
    if (new Set(dispatchIds).size !== dispatchIds.length) {
      // Two live sessions for one dispatch is the "second session" defect; if the
      // wire can carry it, the reconciliation that reports it can be the place
      // it is noticed — but it must not be carryable in the first place.
      ctx.addIssue({ code: "custom", path: ["activeSessionInventory"], message: "Session inventory must be unique by dispatch id; two sessions for one dispatch is the duplicate-work defect" })
    }
  })

/**
 * The `unreconciled` entry.
 *
 * A closed set of reasons. The point of this record is that a human decides what
 * to do about it, and a human cannot act on a reason vocabulary that a peer
 * invented; worse, an open vocabulary is a channel for a peer to write arbitrary
 * text into an operator-facing view.
 */
export const UNRECONCILED_REASONS = [
  "session_not_in_projection",
  "projection_without_session",
  "command_unacknowledged",
  "event_unacknowledged",
  "sequence_gap",
  "digest_conflict",
  "epoch_divergence",
  "node_unreachable",
] as const

export type UnreconciledReason = (typeof UNRECONCILED_REASONS)[number]

export const unreconciledEntrySchema = z
  .object({
    nodeId: nodeIdSchema,
    reason: z.enum(UNRECONCILED_REASONS),
    detail: z.string().min(1).max(MAX_DETAIL_LENGTH),
  })
  .strict()

export const snapshotFallbackSchema = z
  .object({
    runId: runIdSchema,
    lastAppliedSequence: z.number().int().nonnegative().safe(),
    stateDigest: digestSchema,
  })
  .strict()

/**
 * The reconciliation RESPONSE.
 *
 * Read the member list and confirm what is missing: there is nothing that names
 * a session in order to change its state, and nothing that names a terminal in
 * order to close it. `activeSessionInventory` appears on the REQUEST, as an
 * observation, and never on the response as an instruction.
 *
 * `outcome` has no `resolved` or `adopted` member for the same reason: there is
 * no way for reconciliation to conclude that a difference is fine and act on it.
 * A difference becomes an `unreconciled` entry and stays one until a human acts.
 */
/**
 * The reconciliation response's member list, held separately from the schema so
 * that `reconciliation.test.ts` can assert the negative against the SAME
 * object the schema is built from. A test that hard-codes the field list proves
 * only that the test agrees with itself.
 */
const reconciliationResponseShape = {
  reconcileId: reconcileIdSchema,
  outcome: z.enum(["converged", "degraded", "snapshot_required", "refused"]),
  acceptedControllerEpoch: epochSchema,
  /** Step 4: resend these, idempotently. A list of ids, not an action. */
  resendCommandIds: z.array(commandIdSchema).max(ARRAY_MAX),
  resendEventIds: z.array(eventIdSchema).max(ARRAY_MAX),
  /** Step 6. The ONLY channel for a difference to reach a human. */
  unreconciled: z.array(unreconciledEntrySchema).max(ARRAY_MAX),
  /** M4-S: an explicit fallback rather than a silent gap. */
  snapshotFallback: snapshotFallbackSchema.optional(),
} as const

export const meshReconciliationResponseSchema = z
  .object(reconciliationResponseShape)
  .strict()
  .superRefine((response, ctx) => {
    if (new Set(response.resendCommandIds).size !== response.resendCommandIds.length) {
      ctx.addIssue({ code: "custom", path: ["resendCommandIds"], message: "Resend command ids must be unique; a duplicate resend is a redelivery decided twice" })
    }
    if (new Set(response.resendEventIds).size !== response.resendEventIds.length) {
      ctx.addIssue({ code: "custom", path: ["resendEventIds"], message: "Resend event ids must be unique" })
    }
    // `converged` while listing something unreconciled is a contradiction the
    // controller would otherwise report to an operator as "all clear" while the
    // list is sitting right there.
    if (response.outcome === "converged" && response.unreconciled.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["unreconciled"],
        message: "A reconciliation cannot report 'converged' while it carries unreconciled entries; the operator would read 'all clear' over a list of differences",
      })
    }
  })

export const reconciliationRequestFamily = defineFamily({
  recordType: "mesh.reconciliation.request",
  payloadSchema: meshReconciliationRequestSchema,
  refine: (envelope, ctx) => {
    if (!sameId(envelope.correlationId, envelope.payload.reconcileId)) {
      ctx.addIssue({ code: "custom", path: ["correlationId"], message: `A reconciliation request correlates on its reconcile id; got '${envelope.correlationId}'` })
    }
    if (envelope.recipientNodeId !== null && !sameId(envelope.recipientNodeId, envelope.payload.peerNodeId)) {
      ctx.addIssue({ code: "custom", path: ["recipientNodeId"], message: `A reconciliation request is addressed to '${envelope.recipientNodeId}' but names peer '${envelope.payload.peerNodeId}'` })
    }
    if (envelope.causation?.kind === "event" && !sameId(envelope.causation.eventId, envelope.payload.reconcileId)) {
      ctx.addIssue({ code: "custom", path: ["causation", "eventId"], message: "Reconciliation causation must name the reconcile it carries" })
    }
  },
})

export const reconciliationResponseFamily = defineFamily({
  recordType: "mesh.reconciliation.response",
  payloadSchema: meshReconciliationResponseSchema,
  refine: (envelope, ctx) => {
    if (!sameId(envelope.correlationId, envelope.payload.reconcileId)) {
      ctx.addIssue({ code: "custom", path: ["correlationId"], message: `A reconciliation response correlates on the reconcile it answers; got '${envelope.correlationId}'` })
    }
    if (envelope.causation?.kind === "event" && !sameId(envelope.causation.eventId, envelope.payload.reconcileId)) {
      ctx.addIssue({ code: "custom", path: ["causation", "eventId"], message: "Reconciliation causation must name the reconcile it answers" })
    }
  },
})

export type MeshReconciliationRequest = z.infer<typeof meshReconciliationRequestSchema>
export type MeshReconciliationResponse = z.infer<typeof meshReconciliationResponseSchema>
export type UnreconciledEntry = z.infer<typeof unreconciledEntrySchema>
export type SnapshotFallback = z.infer<typeof snapshotFallbackSchema>
export type ActiveSessionInventoryEntry = z.infer<typeof activeSessionInventoryEntrySchema>

// --- The six steps, as one pure function --------------------------------

/**
 * The plan's six reconciliation steps, evaluated in order.
 *
 * Each step is a named entry rather than a boolean so a failed step can say
 * WHICH step failed and why. That matters for the operator transcript at the
 * gate: "reconciliation refused" is not actionable, "step 3 refused: controller
 * epoch 4 is below the accepted 5" is.
 *
 * Steps 4 and 5 do not have outcomes here. Step 4 (resend) is what the
 * RESPONSE's `resendCommandIds`/`resendEventIds` carry, and step 5 (compare
 * inventory) is a diff the controller performs against its own projection, which
 * this layer has no access to. Both are reported as `reported` so a reader can
 * see they were reached rather than skipped — a step that silently vanished from
 * a list is a step that quietly stopped happening.
 */
export interface ReconciliationStepVerdict {
  readonly step: 1 | 2 | 3 | 4 | 5 | 6
  readonly name: string
  readonly state: "passed" | "refused" | "reported"
  readonly detail: string
}

export interface ReconcileContext {
  /** The versions THIS node speaks. */
  readonly supportedProtocolVersions: readonly number[]
  /** The epoch this node currently accepts. */
  readonly acceptedControllerEpoch: Epoch
  readonly nowMs: number
}

export type ReconciliationVerdict =
  | {
      readonly ok: true
      readonly steps: readonly ReconciliationStepVerdict[]
      readonly response: MeshReconciliationResponse
    }
  | {
      readonly ok: false
      /**
       * The step THIS node refused at, or `null` when the peer answered
       * `refused`.
       *
       * `null` is load-bearing. The peer's refusal is not a step this node
       * failed; attributing it to a step sends an operator to the wrong side of
       * the mesh, which is the exact confusion the per-step detail exists to
       * avoid.
       */
      readonly failedStep: 1 | 2 | 3 | null
      readonly steps: readonly ReconciliationStepVerdict[]
      readonly error: ContractError
    }

/**
 * Runs the plan's six steps over one request/response pair.
 *
 * PURE: it opens no connection, reads no clock and consults no log. The
 * versions, the epoch and the time are parameters, which is why the partition
 * and restart scenarios can be tested by constructing a request with a
 * particular epoch rather than by simulating a network.
 */
export function verifyReconciliationPair(
  request: MeshReconciliationRequest,
  response: MeshReconciliationResponse,
  context: ReconcileContext,
): ReconciliationVerdict {
  const steps: ReconciliationStepVerdict[] = []

  // Step 1 — authenticate (out of scope: identity) and compare versions.
  const common = selectProtocolVersion(request.peerProtocolVersions, context.supportedProtocolVersions)
  if (common === null) {
    steps.push({
      step: 1,
      name: "version_compatibility",
      state: "refused",
      detail: `peer offered [${request.peerProtocolVersions.join(", ")}], this node speaks [${context.supportedProtocolVersions.join(", ")}]`,
    })
    return {
      ok: false,
      failedStep: 1,
      steps,
      error: createContractError(
        "unsupported_capability",
        "protocol.no_common_version",
        `Reconciliation refused at step 1: peer '${request.peerNodeId}' offered [${request.peerProtocolVersions.join(", ")}], this node speaks [${context.supportedProtocolVersions.join(", ")}]. Reconciliation does not proceed on an unnegotiated version.`,
      ),
    }
  }
  steps.push({ step: 1, name: "version_compatibility", state: "passed", detail: `negotiated protocol version ${common}` })

  if (!sameId(request.reconcileId, response.reconcileId)) {
    steps.push({ step: 2, name: "position_exchange", state: "refused", detail: `response answers reconcile '${response.reconcileId}', not '${request.reconcileId}'` })
    return {
      ok: false,
      failedStep: 2,
      steps,
      error: createContractError(
        "validation",
        "mesh.reconcile_id_mismatch",
        `Reconciliation response answers '${response.reconcileId}' but the request was '${request.reconcileId}'`,
      ),
    }
  }
  steps.push({
    step: 2,
    name: "position_exchange",
    state: "passed",
    detail: `inbox through ${request.controllerLastAcknowledgedInboxSequence}, outbox through ${request.controllerLastAcknowledgedOutboxSequence}, at epoch ${request.controllerEpoch}`,
  })

  // Step 3 — reject stale-controller traffic.
  if (request.controllerEpoch < context.acceptedControllerEpoch) {
    steps.push({
      step: 3,
      name: "stale_controller_rejection",
      state: "refused",
      detail: `controller epoch ${request.controllerEpoch} < accepted ${context.acceptedControllerEpoch}`,
    })
    return {
      ok: false,
      failedStep: 3,
      steps,
      error: createContractError(
        "stale_epoch",
        "epoch.stale",
        `Reconciliation refused at step 3: controller '${request.controllerNodeId}' is at epoch ${request.controllerEpoch}, below the accepted epoch ${context.acceptedControllerEpoch}.`,
      ),
    }
  }
  if (request.controllerEpoch > context.acceptedControllerEpoch) {
    steps.push({
      step: 3,
      name: "stale_controller_rejection",
      state: "refused",
      detail: `controller epoch ${request.controllerEpoch} > accepted ${context.acceptedControllerEpoch}`,
    })
    return {
      ok: false,
      failedStep: 3,
      steps,
      error: createContractError(
        "conflict",
        "epoch.unregistered",
        `Reconciliation refused at step 3: controller claims epoch ${request.controllerEpoch}, above the accepted epoch ${context.acceptedControllerEpoch}. A higher epoch is only ever accepted through an explicit lease takeover.`,
      ),
    }
  }
  if (response.acceptedControllerEpoch !== context.acceptedControllerEpoch) {
    steps.push({
      step: 3,
      name: "stale_controller_rejection",
      state: "refused",
      detail: `response reports accepted epoch ${response.acceptedControllerEpoch}, this node holds ${context.acceptedControllerEpoch}`,
    })
    return {
      ok: false,
      failedStep: 3,
      steps,
      error: createContractError(
        "conflict",
        "mesh.reconcile_epoch_divergence",
        `Reconciliation response reports accepted epoch ${response.acceptedControllerEpoch} but this node holds ${context.acceptedControllerEpoch}; the two sides disagree about who controls the run`,
      ),
    }
  }
  steps.push({ step: 3, name: "stale_controller_rejection", state: "passed", detail: `epoch ${request.controllerEpoch} accepted on both sides` })

  // Step 4 — resend lists, which are ids and therefore inherently idempotent.
  steps.push({
    step: 4,
    name: "idempotent_resend",
    state: "reported",
    detail: `resend ${response.resendCommandIds.length} command(s) and ${response.resendEventIds.length} event(s) by id; the receiver dedupes`,
  })

  // Step 5 — inventory comparison, reported by the worker as an observation.
  steps.push({
    step: 5,
    name: "session_inventory_comparison",
    state: "reported",
    detail: `worker reported ${request.activeSessionInventory.length} live session(s); the controller diffs them against its dispatch projections`,
  })

  // Step 6 — mark, never act.
  steps.push({
    step: 6,
    name: "mark_unreconciled_for_review",
    state: "reported",
    detail:
      response.unreconciled.length === 0
        ? "no unexplained differences"
        : `${response.unreconciled.length} difference(s) marked for user review: [${response.unreconciled.map((entry) => `${entry.nodeId}:${entry.reason}`).join(", ")}]. Nothing is adopted and nothing is terminated.`,
  })

  if (response.outcome === "refused") {
    return {
      ok: false,
      failedStep: null,
      steps,
      error: createContractError(
        "conflict",
        "mesh.reconciliation_refused",
        `The peer refused reconciliation '${request.reconcileId}'; every step on this side passed, so the refusal is the peer's to explain`,
      ),
    }
  }

  return { ok: true, steps, response }
}

/** Every field a reconciliation response is allowed to carry. */
export const RECONCILIATION_RESPONSE_FIELDS: readonly string[] = Object.freeze(
  Object.keys(reconciliationResponseShape),
)

/**
 * The verbs a reconciliation response must NEVER contain as a member.
 *
 * Exported so `reconciliation.test.ts` can assert the negative against the
 * schema's own shape rather than against a hard-coded list in the test. A test
 * that lists the fields itself proves only that the test agrees with itself.
 */
export const FORBIDDEN_RECONCILIATION_VERBS = Object.freeze([
  "adopt",
  "adopted",
  "terminate",
  "terminated",
  "kill",
  "stop",
  "cancel",
  "close",
  "end",
  "action",
  "decision",
] as readonly string[])

/**
 * Splits an identifier into its words.
 *
 * `resendCommandIds` -> `resend`, `command`, `ids`. Needed because the previous
 * implementation matched forbidden verbs as raw SUBSTRINGS, which made it report
 * that the spec's own required members `resendCommandIds` and `resendEventIds`
 * were forbidden — the letters `end` sit inside `resend`. A guard that refuses
 * the shape it is supposed to certify is worse than no guard, because a reader
 * has to decide whether the guard or the schema is wrong, and the guard is
 * cheaper to believe.
 */
function identifierTokens(field: string): readonly string[] {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase())
}

const FORBIDDEN_TOKEN_SET: ReadonlySet<string> = new Set(FORBIDDEN_RECONCILIATION_VERBS.map((verb) => verb.toLowerCase()))

export function isReconciliationResponseFieldAllowed(field: string): boolean {
  return !identifierTokens(field).some(
    // The trailing `s` is stripped because a field is far more often written in
    // the plural (`sessionActions`) than the singular, and a guard that only
    // catches the singular is a guard that is bypassed by grammar.
    (token) => FORBIDDEN_TOKEN_SET.has(token) || FORBIDDEN_TOKEN_SET.has(token.endsWith("s") ? token.slice(0, -1) : token),
  )
}

export function checkReconciliationPair(
  request: MeshReconciliationRequest,
  response: MeshReconciliationResponse,
  context: ReconcileContext,
): Result<readonly ReconciliationStepVerdict[]> {
  const verdict = verifyReconciliationPair(request, response, context)
  return verdict.ok ? { ok: true, value: verdict.steps } : { ok: false, error: verdict.error }
}

import { describe, expect, it } from "vitest"
import { safeParseMeshEnvelope } from "../../../src/mesh/protocol/registry.js"
import {
  FORBIDDEN_RECONCILIATION_VERBS,
  RECONCILIATION_RESPONSE_FIELDS,
  UNRECONCILED_REASONS,
  checkReconciliationPair,
  isReconciliationResponseFieldAllowed,
  meshReconciliationRequestSchema,
  meshReconciliationResponseSchema,
  verifyReconciliationPair,
  type MeshReconciliationRequest,
  type MeshReconciliationResponse,
  type ReconcileContext,
} from "../../../src/mesh/protocol/reconciliation.js"
import { supportedProtocolVersions } from "../../../src/mesh/protocol/negotiation.js"
import { digestJson } from "../../../src/orchestration/digest.js"
import {
  CONTROLLER_ID,
  EPOCH,
  OTHER_WORKER_ID,
  T1,
  reconciliationRequestPayload,
  reconciliationResponsePayload,
  sampleEnvelope,
  WORKER_ID,
} from "./fixtures.js"

/**
 * §4.8 of the spec and §6 of the sequence diagrams: the plan's six reconciliation
 * steps, in order.
 *
 * The load-bearing artefact is the RESPONSE, and not for the members it has but
 * for the ones it does not. Step 6 is "mark unexplained differences for user
 * review; do not silently adopt or terminate", and the implementation of that is
 * the ABSENCE of any member that could name a session in order to change its
 * state. The tests assert that absence against the schema's OWN shape
 * (`RECONCILIATION_RESPONSE_FIELDS`, which the schema is built from) rather than
 * against a list written inside the test — a test that hard-codes the field list
 * proves only that the test agrees with itself.
 */

const T1_MS = Date.parse(T1)

function request(overrides: Record<string, unknown> = {}): MeshReconciliationRequest {
  return meshReconciliationRequestSchema.parse(reconciliationRequestPayload(overrides))
}

function response(overrides: Record<string, unknown> = {}): MeshReconciliationResponse {
  return meshReconciliationResponseSchema.parse(reconciliationResponsePayload(overrides))
}

function context(overrides: Partial<ReconcileContext> = {}): ReconcileContext {
  return {
    supportedProtocolVersions: supportedProtocolVersions(),
    acceptedControllerEpoch: EPOCH,
    nowMs: T1_MS,
    ...overrides,
  }
}

const UNRECONCILED = [{ nodeId: OTHER_WORKER_ID, reason: "session_not_in_projection" as const, detail: "worker reports a session the controller has no dispatch for" }]

describe("the reconciliation wire shapes", () => {
  it("parses both directions through the registry with their own record types", () => {
    // Two record types, not one with a direction member: a receiver that
    // misreads which half it holds is reading a request as a response, and a
    // union with an ambiguous discriminator is what §4.9 forbids for terminal
    // frames for the same reason.
    for (const recordType of ["mesh.reconciliation.request", "mesh.reconciliation.response"] as const) {
      const safe = safeParseMeshEnvelope(sampleEnvelope(recordType))
      expect(safe.ok, recordType).toBe(true)
      expect(safe.ok && safe.value.schemaVersion, recordType).toBe(2)
      expect(safe.ok && safe.value.correlationId, recordType).toBe("rec-1")
    }
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.reconciliation.request", { correlationId: "rec-9" })).ok).toBe(false)
  })

  it("refuses a session inventory that names one dispatch twice, which is the duplicate-work defect", () => {
    // Two live sessions for one dispatch is a second session. If the wire can
    // carry it, reconciliation is the place it gets noticed — but it must not be
    // carryable in the first place.
    expect(() =>
      request({
        activeSessionInventory: [
          { sessionId: "session-1", dispatchId: "dispatch-1", startedAt: T1 },
          { sessionId: "session-2", dispatchId: "dispatch-1", startedAt: T1 },
        ],
      }),
    ).toThrow(/dispatch id/)
    expect(() =>
      request({
        activeSessionInventory: [
          { sessionId: "session-1", dispatchId: "dispatch-1", startedAt: T1 },
          { sessionId: "session-1", dispatchId: "dispatch-2", startedAt: T1 },
        ],
      }),
    ).toThrow(/session id/)
  })

  it("refuses a 'converged' outcome that carries unreconciled entries", () => {
    // Otherwise the controller reports "all clear" to an operator with the list
    // of differences sitting right next to it.
    expect(() => response({ outcome: "converged", unreconciled: UNRECONCILED })).toThrow(/converged/)
    expect(response({ outcome: "degraded", unreconciled: UNRECONCILED }).unreconciled).toHaveLength(1)
  })

  it("refuses a resend list with duplicates, which is a redelivery decided twice", () => {
    expect(() => response({ resendCommandIds: ["cmd-1", "cmd-1"] })).toThrow(/unique/)
    expect(() => response({ resendEventIds: ["evt-1", "evt-1"] })).toThrow(/unique/)
  })

  it("reports unreconciled reasons from a CLOSED vocabulary", () => {
    // A human cannot act on a reason a peer invented, and an open vocabulary is a
    // channel for writing arbitrary text into an operator-facing view.
    expect(() =>
      response({ unreconciled: [{ nodeId: OTHER_WORKER_ID, reason: "because_i_said_so", detail: "x" }] }),
    ).toThrow()
    for (const reason of UNRECONCILED_REASONS) {
      expect(
        response({ outcome: "degraded", unreconciled: [{ nodeId: OTHER_WORKER_ID, reason, detail: "observed" }] }).unreconciled,
        reason,
      ).toHaveLength(1)
    }
  })

  it("carries a snapshot fallback for M4-S, an explicit gap rather than a silent one", () => {
    const fallback = { runId: "run-release-1", lastAppliedSequence: 41, stateDigest: digestJson({ a: 1 }) }
    expect(response({ outcome: "snapshot_required", snapshotFallback: fallback }).snapshotFallback).toEqual(fallback)
    expect(() => response({ snapshotFallback: { ...fallback, stateDigest: "not-a-digest" } })).toThrow()
  })
})

describe("the response type cannot adopt or terminate a session", () => {
  it("has no member that names a session in order to change its state", () => {
    // The property is a property of the TYPE, so it is asserted against the
    // schema's own shape. `activeSessionInventory` belongs on the REQUEST as an
    // observation and must never appear on the response as an instruction.
    expect(RECONCILIATION_RESPONSE_FIELDS).not.toContain("activeSessionInventory")
    expect(RECONCILIATION_RESPONSE_FIELDS).not.toContain("sessions")
    expect(RECONCILIATION_RESPONSE_FIELDS).toEqual([
      "reconcileId",
      "outcome",
      "acceptedControllerEpoch",
      "resendCommandIds",
      "resendEventIds",
      "unreconciled",
      "snapshotFallback",
    ])
  })

  it("carries no verb that could adopt, terminate or resolve a difference", () => {
    for (const field of RECONCILIATION_RESPONSE_FIELDS) {
      expect(isReconciliationResponseFieldAllowed(field), field).toBe(true)
    }
    for (const verb of FORBIDDEN_RECONCILIATION_VERBS) {
      // camelCase, as an identifier would actually be written: `sessionAdopt`
      // splits into two words, which is the whole basis of the guard.
      const compound = `session${verb.charAt(0).toUpperCase()}${verb.slice(1)}`
      expect(isReconciliationResponseFieldAllowed(verb), verb).toBe(false)
      expect(isReconciliationResponseFieldAllowed(compound), compound).toBe(false)
    }
    // The guard matches WORDS, not letters: `resendCommandIds` is a required
    // member and must not be reported as forbidden just because `end` is inside
    // `resend`.
    expect(isReconciliationResponseFieldAllowed("resendCommandIds")).toBe(true)
    expect(isReconciliationResponseFieldAllowed("resendEventIds")).toBe(true)
    expect(isReconciliationResponseFieldAllowed("adoptSessionIds")).toBe(false)
    expect(isReconciliationResponseFieldAllowed("sessionActions")).toBe(false)
    expect(isReconciliationResponseFieldAllowed("closeTerminal")).toBe(false)
  })

  it("refuses such a member at parse time, because `.strict()` is the enforcement", () => {
    for (const field of ["adopt", "adoptSessionIds", "terminateSessionIds", "kill", "closeTerminal", "sessionActions", "decision"]) {
      const safe = safeParseMeshEnvelope({
        ...sampleEnvelope("mesh.reconciliation.response"),
        payload: { ...reconciliationResponsePayload(), [field]: ["session-1"] },
      })
      expect(safe.ok, field).toBe(false)
    }
  })

  it("has no `resolved` or `adopted` member, so a difference cannot conclude itself away", () => {
    expect(RECONCILIATION_RESPONSE_FIELDS).not.toContain("resolved")
    expect(RECONCILIATION_RESPONSE_FIELDS).not.toContain("adopted")
    expect([...UNRECONCILED_REASONS].every((reason) => !/resolved|adopted/.test(reason))).toBe(true)
  })
})

describe("the six steps, in order", () => {
  it("walks steps 1 to 6 for a clean pair, and never skips one", () => {
    const verdict = verifyReconciliationPair(request(), response(), context())
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    // A step that silently vanished from this list is a step that quietly
    // stopped happening, which is the only way a reader can tell.
    expect(verdict.steps.map((step) => step.step)).toEqual([1, 2, 3, 4, 5, 6])
    expect(verdict.steps.map((step) => step.name)).toEqual([
      "version_compatibility",
      "position_exchange",
      "stale_controller_rejection",
      "idempotent_resend",
      "session_inventory_comparison",
      "mark_unreconciled_for_review",
    ])
  })

  it("step 1: refuses a peer with no common protocol version and does not reconcile", () => {
    const alien = request({ peerProtocolVersions: [99] })
    const verdict = verifyReconciliationPair(alien, response(), context())
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.failedStep).toBe(1)
    expect(verdict.error.code).toBe("protocol.no_common_version")
    expect(verdict.error.category).toBe("unsupported_capability")
    expect(verdict.error.retryable).toBe(false)
    expect(verdict.steps).toHaveLength(1)
  })

  it("step 1: negotiates to the highest version both sides speak, and says which", () => {
    const pair = verifyReconciliationPair(request({ peerProtocolVersions: [1, 2] }), response(), context({ supportedProtocolVersions: [1, 2] }))
    expect(pair.ok).toBe(true)
    expect(pair.ok && pair.steps[0]?.detail).toContain("2")
  })

  it("step 2: refuses a response that answers a different reconcile", () => {
    const verdict = verifyReconciliationPair(request({ reconcileId: "rec-1" }), response({ reconcileId: "rec-2" }), context())
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.failedStep).toBe(2)
    expect(verdict.ok === false && verdict.error.code).toBe("mesh.reconcile_id_mismatch")
  })

  it("step 2: reports the positions that were exchanged", () => {
    const pair = request({ controllerLastAcknowledgedInboxSequence: 41, controllerLastAcknowledgedOutboxSequence: 17 })
    const verdict = verifyReconciliationPair(pair, response(), context())
    expect(verdict.ok && verdict.steps[1]?.detail).toContain("inbox through 41")
    expect(verdict.ok && verdict.steps[1]?.detail).toContain("outbox through 17")
  })

  it("step 3: refuses a controller BELOW the accepted epoch as stale", () => {
    const verdict = verifyReconciliationPair(request({ controllerEpoch: EPOCH - 1 }), response(), context())
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.failedStep).toBe(3)
    expect(verdict.error.code).toBe("epoch.stale")
    expect(verdict.error.category).toBe("stale_epoch")
  })

  it("step 3: refuses a controller ABOVE the accepted epoch as unregistered, never as 'sort it out later'", () => {
    const verdict = verifyReconciliationPair(request({ controllerEpoch: EPOCH + 1 }), response(), context())
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.error.code).toBe("epoch.unregistered")
    expect(verdict.error.message).toContain("takeover")
  })

  it("step 3: refuses a pair where the two sides disagree about the accepted epoch", () => {
    const verdict = verifyReconciliationPair(request(), response({ acceptedControllerEpoch: EPOCH + 1 }), context())
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.failedStep).toBe(3)
    expect(verdict.ok === false && verdict.error.code).toBe("mesh.reconcile_epoch_divergence")
  })

  it("step 4: reports the resend lists as ids, which are inherently idempotent", () => {
    const verdict = verifyReconciliationPair(request(), response({ resendCommandIds: ["cmd-1", "cmd-2"], resendEventIds: ["evt-1"] }), context())
    expect(verdict.ok).toBe(true)
    expect(verdict.ok && verdict.steps[3]?.state).toBe("reported")
    expect(verdict.ok && verdict.steps[3]?.detail).toContain("2 command(s)")
    expect(verdict.ok && verdict.steps[3]?.detail).toContain("1 event(s)")
  })

  it("step 5: reports the worker's inventory as an observation the controller diffs", () => {
    const pair = request({
      activeSessionInventory: [
        { sessionId: "session-1", dispatchId: "dispatch-1", startedAt: T1 },
        { sessionId: "session-2", dispatchId: "dispatch-2", startedAt: T1 },
      ],
    })
    const verdict = verifyReconciliationPair(pair, response(), context())
    expect(verdict.ok && verdict.steps[4]?.state).toBe("reported")
    expect(verdict.ok && verdict.steps[4]?.detail).toContain("2 live session(s)")
  })

  it("step 6: marks every difference and says that nothing is adopted or terminated", () => {
    const verdict = verifyReconciliationPair(request(), response({ outcome: "degraded", unreconciled: UNRECONCILED }), context())
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    const step6 = verdict.steps[5]
    expect(step6?.state).toBe("reported")
    expect(step6?.detail).toContain(OTHER_WORKER_ID)
    expect(step6?.detail).toContain("session_not_in_projection")
    expect(step6?.detail).toContain("Nothing is adopted and nothing is terminated")
  })

  it("attributes a peer refusal to the peer, not to a step on this side", () => {
    // Every step here passed, so reporting `failedStep: 1` would send an
    // operator to the wrong node of the mesh.
    const verdict = verifyReconciliationPair(request(), response({ outcome: "refused" }), context())
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.failedStep).toBeNull()
    expect(verdict.error.code).toBe("mesh.reconciliation_refused")
    expect(verdict.steps.every((step) => step.state !== "refused")).toBe(true)
  })

  it("flavours the same refusals through the Result seam", () => {
    expect(checkReconciliationPair(request(), response(), context()).ok).toBe(true)
    const refused = checkReconciliationPair(request({ peerProtocolVersions: [99] }), response(), context())
    expect(refused.ok === false && refused.error.code).toBe("protocol.no_common_version")
  })
})

describe("the restart scenario", () => {
  it("reaches step 6 with a snapshot fallback rather than a silent gap", () => {
    // Scenario 3 and M4-S: a controller that cannot resume from a cursor gets an
    // explicit snapshot. The fallback is a POSITION plus a DIGEST, so the
    // controller can tell "resuming from here" from "guessing".
    const verdict = verifyReconciliationPair(
      request(),
      response({
        outcome: "snapshot_required",
        snapshotFallback: { runId: "run-release-1", lastAppliedSequence: 41, stateDigest: digestJson({ seq: 41 }) },
      }),
      context(),
    )
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.response.snapshotFallback?.lastAppliedSequence).toBe(41)
    expect(verdict.steps[5]?.detail).toContain("no unexplained differences")
  })

  it("reports the peer it is reconciling with, and never acts on its inventory", () => {
    const verdict = verifyReconciliationPair(request({ peerNodeId: WORKER_ID, controllerNodeId: CONTROLLER_ID }), response(), context())
    expect(verdict.ok).toBe(true)
    // The inventory is the REQUEST's member; a response that could restate it as
    // an instruction would be a second place for plan step 6 to be violated.
    expect(RECONCILIATION_RESPONSE_FIELDS).not.toContain("activeSessionInventory")
  })
})

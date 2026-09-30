import { describe, expect, it } from "vitest"
import { safeParseMeshEnvelope } from "../../../src/mesh/protocol/registry.js"
import {
  LEASE_OPERATIONS,
  LEASE_REFUSAL_REASONS,
  checkLease,
  evaluateLease,
  meshLeaseSchema,
  permitsNewWork,
  type HeldLease,
  type LeaseEvaluation,
  type MeshLease,
} from "../../../src/mesh/protocol/lease.js"
import { nodeIdSchema } from "../../../src/orchestration/identifiers.js"
import {
  CONTROLLER_ID,
  EPOCH,
  LEASE_ID,
  OTHER_WORKER_ID,
  PROJECT_ID,
  RUN_ID,
  T0,
  at,
  leasePayload,
  sampleEnvelope,
} from "./fixtures.js"

/**
 * §4.7 of the spec, and scenarios 2 (partition) and 4 (stale epoch).
 *
 * The lease is the only thing that orders controllers. There is no election, no
 * quorum, no gossip, so every question about "who may create work" has to be
 * answerable from the lease record plus the epoch in it, which is what the tests
 * below hold it to.
 *
 * Two of the five §4.7 invariants are the ones a reasonable implementer gets
 * wrong, and both are asserted here rather than described:
 *
 *   4. a takeover needs a strictly higher epoch AND an explicit acknowledgement
 *      of every unreconciled node. Either alone is insufficient.
 *   5. a higher epoch is NEVER accepted without the explicit takeover operation.
 *      `evaluateLease` returning `epoch_unregistered` for a claim or a renewal
 *      carrying a higher epoch is what stops a "helpful" automatic upgrade from
 *      becoming the election the milestone forbids.
 *
 * And invariant 3 — expiry stops NEW work and does not stop running agents — is
 * asserted as an ABSENCE: no verdict member, no error code and no reason string
 * says anything about sessions.
 */

const T0_MS = Date.parse(T0)

function held(overrides: Partial<HeldLease> = {}): HeldLease {
  return {
    leaseId: LEASE_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    controllerNodeId: CONTROLLER_ID,
    epoch: EPOCH,
    expiresAt: at(30),
    ...overrides,
  }
}

function lease(overrides: Record<string, unknown> = {}): MeshLease {
  return meshLeaseSchema.parse(leasePayload(overrides))
}

function context(heldLease: HeldLease | null, unreconciledNodeIds: readonly string[] = [], nowMs = T0_MS + 1_000) {
  // DELIBERATE: the evaluator's context names `NodeId`, and these fixtures are
  // plain strings from a shared table. The parse below is the honest way to get
  // there — an `as NodeId` would defeat the brand the whole point of which is
  // that a wrong id type is a compile error.
  return {
    held: heldLease,
    unreconciledNodeIds: unreconciledNodeIds.map((id) => nodeIdSchema.parse(id)),
    nowMs,
  }
}

function takeover(overrides: Record<string, unknown> = {}): MeshLease {
  return lease({
    operation: "takeover",
    leaseId: "lease-run-2",
    epoch: EPOCH + 1,
    predecessorLeaseId: LEASE_ID,
    predecessorEpoch: EPOCH,
    takeoverReason: "controller A partitioned; user accepted degraded nodes",
    ...overrides,
  })
}

describe("the mesh.lease wire shape", () => {
  it("parses through the registry and carries its own version", () => {
    const safe = safeParseMeshEnvelope(sampleEnvelope("mesh.lease"))
    expect(safe.ok).toBe(true)
    if (!safe.ok) return
    expect(safe.value.schemaVersion).toBe(2)
    expect(safe.value.recordType).toBe("mesh.lease")
    if (safe.value.recordType !== "mesh.lease") return
    expect(safe.value.payload.operation).toBe("claim")
  })

  it("is scoped to one run, and durationSeconds may not disagree with the timestamps", () => {
    // A reader that trusts `durationSeconds` while the timestamps say otherwise
    // believes a lease lasts longer than it does, and believing that is how two
    // controllers end up creating work for the same run.
    expect(() => lease({ durationSeconds: 60 })).toThrow(/durationSeconds/)
    expect(() => lease({ expiresAt: T0 })).toThrow(/strictly later/)
    expect(lease({ durationSeconds: 10, expiresAt: at(10) }).durationSeconds).toBe(10)
  })

  it("confines predecessor fields and the takeover reason to the takeover operation", () => {
    // A renewal that names a predecessor is a takeover wearing the wrong
    // operation, and one that omits the operation cannot be fenced at all.
    for (const operation of ["claim", "renew", "release"] as const) {
      expect(() => lease({ operation, predecessorLeaseId: LEASE_ID }), operation).toThrow()
      expect(() => lease({ operation, predecessorEpoch: EPOCH }), operation).toThrow()
      expect(() => lease({ operation, takeoverReason: "because" }), operation).toThrow()
    }
    for (const field of ["predecessorLeaseId", "predecessorEpoch", "takeoverReason"] as const) {
      expect(() => takeover({ [field]: undefined }), field).toThrow()
    }
  })

  it("allows an acknowledgement only on a takeover, and never with duplicates", () => {
    expect(() => lease({ acknowledgedUnreconciledNodeIds: [OTHER_WORKER_ID] })).toThrow(/takeover precondition/)
    expect(() => takeover({ acknowledgedUnreconciledNodeIds: [OTHER_WORKER_ID, OTHER_WORKER_ID] })).toThrow(/unique/)
    expect(takeover({ acknowledgedUnreconciledNodeIds: [OTHER_WORKER_ID] }).acknowledgedUnreconciledNodeIds).toEqual([
      OTHER_WORKER_ID,
    ])
  })

  it("is sent by the controller that claims it", () => {
    expect(safeParseMeshEnvelope(sampleEnvelope("mesh.lease", { senderNodeId: OTHER_WORKER_ID })).ok).toBe(false)
  })
})

describe("evaluateLease — epoch ordering", () => {
  it("refuses a LOWER epoch as stale and never queues it", () => {
    // Scenario 4: controller A's epoch 4 arriving after B's takeover to 5. It is
    // DROPPED, not stored for later — it was decided against a projection that
    // no longer exists.
    const evaluation = evaluateLease(lease({ operation: "renew", leaseId: LEASE_ID, epoch: EPOCH - 1 }), context(held()))
    expect(evaluation).toMatchObject({ outcome: "refused", reason: "epoch_stale" })
    expect(evaluation.outcome === "refused" && evaluation.error.code).toBe("epoch.stale")
    expect(evaluation.outcome === "refused" && evaluation.error.category).toBe("stale_epoch")
    expect(evaluation.outcome === "refused" && evaluation.standing).toBe("current")
  })

  it("refuses a HIGHER epoch on a claim or a renewal, because only a takeover may raise it", () => {
    // Invariant 5, and the guardrail "do not accept a higher controller epoch
    // without the explicit takeover flow". Accepting one here would be the
    // automatic election the milestone forbids.
    for (const operation of ["claim", "renew"] as const) {
      const evaluation = evaluateLease(lease({ operation, leaseId: LEASE_ID, epoch: EPOCH + 1 }), context(held()))
      expect(evaluation.outcome, operation).toBe("refused")
      expect(evaluation.outcome === "refused" && evaluation.reason, operation).toBe("epoch_unregistered")
      expect(evaluation.outcome === "refused" && evaluation.error.code, operation).toBe("epoch.unregistered")
    }
  })

  it("refuses a takeover that does not strictly increase the epoch", () => {
    const sameEpoch = evaluateLease(takeover({ epoch: EPOCH }), context(held()))
    expect(sameEpoch.outcome === "refused" && sameEpoch.reason).toBe("epoch_not_increasing")
  })

  it("refuses a takeover that does not name the lease and epoch it fences", () => {
    const wrongLease = evaluateLease(takeover({ predecessorLeaseId: "lease-somewhere-else" }), context(held()))
    expect(wrongLease.outcome === "refused" && wrongLease.reason).toBe("predecessor_mismatch")
    const wrongEpoch = evaluateLease(takeover({ predecessorEpoch: EPOCH - 1 }), context(held()))
    expect(wrongEpoch.outcome === "refused" && wrongEpoch.reason).toBe("predecessor_mismatch")
  })

  it("refuses a takeover at a node that holds NO lease, because there is nothing to fence", () => {
    // The release-blocking case, asserted in the pure evaluator as well as through
    // the seam. The predecessor comparison used to be skipped when `held` was null,
    // which made the epoch in a takeover an unbacked assertion at every node that
    // knew nothing about the run: those nodes accept, the nodes holding the real
    // lease refuse on the predecessor, and the run ends with two controllers.
    const evaluation = evaluateLease(takeover({ epoch: EPOCH + 7 }), context(null))
    expect(evaluation).toMatchObject({ outcome: "refused", role: "takeover", reason: "no_lease_to_fence", standing: "none" })
    if (evaluation.outcome !== "refused") return
    expect(evaluation.error.code).toBe("lease.no_lease_to_fence")
    // Named apart from `predecessor_mismatch` because the operator's next action
    // differs: nothing about the record is wrong, this node simply cannot fence.
    expect(evaluation.error.message).toMatch(/claim/)
  })

  it("keeps a CLAIM as the way to drive an unheld run, so the refusal is not a dead end", () => {
    // The guard must not make an unleased run unreachable, or it would refuse the
    // ordinary "nobody is driving this yet" case along with the takeover.
    expect(evaluateLease(lease({ epoch: EPOCH + 7 }), context(null)).outcome).toBe("accepted")
  })

  it("accepts a takeover that does all three: higher epoch, named predecessor, acknowledged nodes", () => {
    const evaluation = evaluateLease(
      takeover({ acknowledgedUnreconciledNodeIds: [OTHER_WORKER_ID] }),
      context(held(), [OTHER_WORKER_ID]),
    )
    expect(evaluation).toEqual({
      outcome: "accepted",
      role: "takeover",
      standing: "current",
      permitsNewWork: true,
      epoch: EPOCH + 1,
      leaseId: "lease-run-2",
      expiresAt: lease().expiresAt,
    })
  })
})

describe("evaluateLease — the user-inspection precondition", () => {
  it("refuses a takeover whose acknowledgement list is empty while nodes remain unreconciled", () => {
    // Invariant 4. An empty list is the shape the precondition is about: it is
    // the record of a user having been shown the nodes, and there is nothing in
    // it if nobody looked.
    const evaluation = evaluateLease(takeover({ acknowledgedUnreconciledNodeIds: [] }), context(held(), [OTHER_WORKER_ID]))
    expect(evaluation).toMatchObject({ outcome: "refused", reason: "unreconciled_nodes_not_acknowledged" })
    expect(evaluation.outcome === "refused" && evaluation.error.code).toBe("lease.takeover_unreconciled")
    // The ids are NAMED, so the operator is shown what they have not looked at
    // rather than being told "there are some".
    expect(evaluation.outcome === "refused" && evaluation.error.message).toContain(OTHER_WORKER_ID)
  })

  it("accepts an empty acknowledgement when there is nothing unreconciled", () => {
    // The precondition is about UNRECONCILED NODES, not about a list that must
    // be non-empty; a mesh in full agreement must still be able to take over.
    const evaluation = evaluateLease(takeover(), context(held(), []))
    expect(evaluation.outcome).toBe("accepted")
  })

  it("requires a strictly higher epoch as well, so neither half of the precondition substitutes for the other", () => {
    const noHigherEpoch = evaluateLease(
      takeover({ epoch: EPOCH, acknowledgedUnreconciledNodeIds: [OTHER_WORKER_ID] }),
      context(held(), [OTHER_WORKER_ID]),
    )
    expect(noHigherEpoch.outcome === "refused" && noHigherEpoch.reason).toBe("epoch_not_increasing")
    const noAcknowledgement = evaluateLease(takeover({ epoch: EPOCH + 1, acknowledgedUnreconciledNodeIds: [] }), context(held(), [OTHER_WORKER_ID]))
    expect(noAcknowledgement.outcome === "refused" && noAcknowledgement.reason).toBe("unreconciled_nodes_not_acknowledged")
  })
})

describe("evaluateLease — claim, renew, release", () => {
  it("lets a claim take an unheld run and refuses one that displaces a live lease", () => {
    expect(evaluateLease(lease(), context(null)).outcome).toBe("accepted")
    const displaced = evaluateLease(lease(), context(held()))
    expect(displaced.outcome === "refused" && displaced.reason).toBe("held_by_another_controller")
  })

  it("lets a claim at the SAME epoch take a run whose lease has EXPIRED, which is the partition recovering", () => {
    // Not a higher epoch: raising the epoch is still the takeover's job alone.
    // What expiry unlocks is a claim at the epoch already in force, which is the
    // ordinary way a partitioned run is picked back up.
    const evaluation = evaluateLease(lease({ epoch: EPOCH }), context(held({ expiresAt: at(-1) }), [], T0_MS + 30_000))
    expect(evaluation).toMatchObject({ outcome: "accepted", standing: "expired", permitsNewWork: true })
  })

  it("refuses a renewal that arrives after expiry, because renewing resurrects authority nobody fenced", () => {
    const evaluation = evaluateLease(
      lease({ operation: "renew", leaseId: LEASE_ID, issuedAt: at(31), expiresAt: at(61), durationSeconds: 30 }),
      context(held({ expiresAt: at(30) }), [], T0_MS + 31_000),
    )
    expect(evaluation).toMatchObject({ outcome: "refused", reason: "renewal_after_expiry", standing: "expired" })
    expect(evaluation.outcome === "refused" && evaluation.error.code).toBe("lease.expired")
  })

  it("accepts a renewal in time and refuses one naming a lease this node does not hold", () => {
    const renewal = lease({ operation: "renew", leaseId: LEASE_ID, issuedAt: at(10), expiresAt: at(40), durationSeconds: 30 })
    expect(evaluateLease(renewal, context(held(), [], T0_MS + 20_000)).outcome).toBe("accepted")
    const foreign = evaluateLease(lease({ operation: "renew", leaseId: "lease-other" }), context(held()))
    expect(foreign.outcome === "refused" && foreign.reason).toBe("predecessor_mismatch")
  })

  it("refuses a renewal against no lease at all, as a renewal rather than as a release", () => {
    // "There is nothing to release" is a true sentence about this refusal and the
    // wrong one for the operator: nothing was given up, something was lost, and the
    // two have different remedies. The reason names the operation that actually
    // failed so a log line can be acted on without cross-referencing the payload.
    const evaluation = evaluateLease(lease({ operation: "renew" }), context(null))
    expect(evaluation).toMatchObject({ outcome: "refused", reason: "no_lease_to_renew", standing: "none" })
    expect(LEASE_REFUSAL_REASONS).toContain("no_lease_to_renew")
  })

  it("treats a release as accepted but as granting nothing", () => {
    // Reporting a release as permitting new work would let it read as a renewal.
    const evaluation = evaluateLease(lease({ operation: "release", leaseId: LEASE_ID }), context(held()))
    expect(evaluation).toMatchObject({ outcome: "accepted", role: "release", permitsNewWork: false })
  })

  it("refuses a lease for another run, before comparing anything about it", () => {
    // Comparing epochs across runs is meaningless, so scope is checked first.
    const evaluation = evaluateLease(lease({ runId: "run-other" }), context(held()))
    expect(evaluation.outcome === "refused" && evaluation.reason).toBe("lease_scope_mismatch")
  })

  it("names every refusal reason it can return, so the union and the implementation cannot drift", () => {
    const observed = new Set<string>()
    for (const leaseRecord of [lease({ epoch: EPOCH - 1 }), lease({ epoch: EPOCH + 1 }), takeover({ predecessorEpoch: EPOCH + 5 })]) {
      const evaluation = evaluateLease(leaseRecord, context(held(), [OTHER_WORKER_ID]))
      if (evaluation.outcome === "refused") observed.add(evaluation.reason)
    }
    for (const reason of observed) expect(LEASE_REFUSAL_REASONS).toContain(reason as never)
  })

  it("covers every operation the wire vocabulary declares", () => {
    expect([...LEASE_OPERATIONS].sort()).toEqual(["claim", "release", "renew", "takeover"])
  })
})

describe("expiry stops new work and nothing else", () => {
  it("reports an expired lease as expired while leaving the held lease itself reported", () => {
    const evaluation: LeaseEvaluation = evaluateLease(lease({ operation: "renew", leaseId: LEASE_ID }), context(held({ expiresAt: at(-1) }), [], T0_MS + 60_000))
    expect(evaluation.standing).toBe("expired")
  })

  it("answers permitsNewWork from the held lease alone, for the command seam", () => {
    expect(permitsNewWork(null, T0_MS)).toEqual({ permitted: false, reason: "no_lease" })
    expect(permitsNewWork(held(), T0_MS + 1)).toEqual({ permitted: true, reason: "current" })
    expect(permitsNewWork(held(), T0_MS + 60_000)).toEqual({ permitted: false, reason: "expired" })
  })

  it("provides no member, reason or code anywhere that could be read as 'stop the sessions'", () => {
    // The plan guardrail is "do not terminate agents because a controller or
    // network disappeared", and a boolean is not a safe way to encode it: a
    // future member named `terminateSessions` would typecheck against this
    // function's return. The refusal is therefore an absence, asserted.
    const accepted = evaluateLease(lease(), context(null))
    const refused = evaluateLease(lease({ epoch: EPOCH - 1 }), context(held()))
    for (const key of Object.keys(accepted)) {
      expect(key.toLowerCase()).not.toMatch(/session|terminate|kill|stop|cancel|agent/)
    }
    for (const reason of LEASE_REFUSAL_REASONS) expect(reason.toLowerCase()).not.toMatch(/session|terminate|kill|stop|cancel/)
    const source = JSON.stringify(refused)
    expect(source).not.toMatch(/terminate|kill|cancelSession/)
  })

  it("flavours the same refusals through the Result seam", () => {
    expect(checkLease(lease(), context(null)).ok).toBe(true)
    const refused = checkLease(lease({ epoch: EPOCH - 1 }), context(held()))
    expect(refused.ok === false && refused.error.code).toBe("epoch.stale")
  })
})

describe("the partition scenario", () => {
  it("refuses every new command once the lease has expired, at the same instant for every caller", () => {
    // Scenario 2. Nothing is queued "for later": a command minted at epoch E
    // must never be applied at epoch E+1 after a takeover, because it was
    // decided against a projection that no longer exists.
    const leaseInForce = held({ expiresAt: at(30) })
    expect(permitsNewWork(leaseInForce, T0_MS + 29_999).permitted).toBe(true)
    expect(permitsNewWork(leaseInForce, T0_MS + 30_000).permitted).toBe(false)
    expect(permitsNewWork(leaseInForce, T0_MS + 30_000)).toEqual({ permitted: false, reason: "expired" })
  })

  it("lets a successor take the run over after expiry, which is how the partition heals", () => {
    const evaluation = evaluateLease(takeover({ acknowledgedUnreconciledNodeIds: [OTHER_WORKER_ID] }), context(held({ expiresAt: at(-1) }), [OTHER_WORKER_ID], T0_MS + 40_000))
    expect(evaluation).toMatchObject({ outcome: "accepted", standing: "expired", permitsNewWork: true })
  })

  it("does not change what the held lease says merely because a record was refused", () => {
    // A stale record is refused; the lease in force is untouched. Reading the two
    // as one object is how a node ends up believing it lost a lease it still
    // holds, or holding one it lost.
    const before = permitsNewWork(held(), T0_MS + 1_000)
    evaluateLease(lease({ epoch: EPOCH - 1 }), context(held()))
    const after = permitsNewWork(held(), T0_MS + 1_000)
    expect(after).toEqual(before)
  })
})

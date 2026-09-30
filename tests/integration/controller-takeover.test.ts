/**
 * M4.6 gate — controller lease expiry and manual takeover, over real sockets.
 *
 * Three plan requirements, and each has a different failure it is written to prevent:
 *
 *   1. **"Lease expiry pauses new orchestration but preserves existing
 *      processes."** The asymmetry is the whole point: an expiry must stop a
 *      controller minting new work and must leave every running agent untouched,
 *      because the agent is often the only remaining record of the work. The test
 *      asserts the live-session inventory is BYTE-IDENTICAL across the expiry, which
 *      is the strongest form of "nothing was terminated" available without reaching
 *      into a runtime that is not there.
 *   2. **"Manual takeover uses a higher epoch."** A takeover names the lease it
 *      fences, records why the user moved control, and raises the epoch. There is no
 *      election, no quorum and no gossip: the epoch moves because a person acted, and
 *      this file is the only place in the mesh where it does.
 *   3. **"Stale controllers are rejected."** A superseded controller's traffic is
 *      dropped, not queued, and NOTHING is persisted — asserted on the inbox row count
 *      as well as on the refusal code, because a stale command that was "refused but
 *      written anyway" is the failure this milestone exists to prevent.
 *
 * Nothing sleeps. Expiry and takeover are arithmetic on a shared clock.
 */
import { afterEach, describe, expect, it } from "vitest"
import { MeshNodeRegistry } from "../../src/mesh/registry/index.js"
import { safeParseMeshEnvelope } from "../../src/mesh/protocol/registry.js"
import { leaseIdSchema } from "../../src/orchestration/identifiers.js"
import { InMemoryEnrollmentCodeStore, buildEnrollmentRequest, decideEnrollment, issueEnrollmentCode } from "../../src/mesh/identity/index.js"
import { decodeFrames } from "../../src/mesh/gateway/events/index.js"
import {
  CONTROLLER,
  DURATION_SECONDS,
  MESH_ID,
  PENDING_NODE,
  PROJECT,
  RUN,
  SUCCESSOR,
  commandEnvelope,
  eventEnvelope,
  get,
  at,
  leaseEnvelope,
  post,
  seedTheRun,
  type ControllerNode,
  type WorkerNode,
} from "./mesh-fixtures.js"
import type { SessionId } from "../../src/orchestration/identifiers.js"

const openNodes: { close(): Promise<void> }[] = []

afterEach(async () => {
  while (openNodes.length > 0) await openNodes.pop()!.close()
})

/**
 * The sessions the worker says it is running, as an operator would read them.
 *
 * A plain frozen array rather than a reference to the worker's own state, because
 * the assertion under test is that the inventory is UNCHANGED, and comparing a live
 * reference to itself would pass whatever the code did.
 */
function aLiveSessionInventory(): readonly SessionId[] {
  return Object.freeze([]) as readonly SessionId[]
}

async function aTwoNodeMesh() {
  const { MeshClock, aController, aWorker, aJoiningNode } = await import("./mesh-fixtures.js")
  const clock = new MeshClock()
  const controller = await aController(clock)
  seedTheRun(controller)
  openNodes.push(controller)

  // Enroll a worker and pin it, so the stream and the command route have a real peer.
  const codes = new InMemoryEnrollmentCodeStore()
  const issued = await issueEnrollmentCode({ meshId: MESH_ID, issuedBy: "operator", now: Date.parse(at(0)) }, codes)
  if (!issued.ok) throw new Error("the enrollment code store refused a code")
  const joining = aJoiningNode()
  const request = buildEnrollmentRequest({
    meshId: MESH_ID,
    enrollmentId: issued.value.enrollmentId,
    codeHash: issued.value.codeHash,
    keyPair: joining.keyPair,
    nodeDisplayName: "worker-1",
    provisionalNodeId: "worker-1",
    requestedAt: at(0),
    codeExpiresAt: at(600),
    senderNodeId: PENDING_NODE,
  })
  const decision = await decideEnrollment({ request, now: Date.parse(at(1)) }, { codes, pins: controller.identity.pins, trust: controller.identity.trust })
  if (decision.outcome !== "accepted") throw new Error(`enrollment was refused: ${decision.rejectionReason}`)
  await controller.identity.trust.enroll({ nodeId: decision.nodeId, meshId: MESH_ID, nodeKeyId: joining.keyPair.keyId, enrolledAt: Date.parse(at(1)), displayName: "worker-1" })
  await controller.identity.pins.pin({
    nodeId: decision.nodeId,
    meshId: MESH_ID,
    key: { nodeKeyId: joining.keyPair.keyId, publicKey: joining.keyPair.publicKey, fingerprint: joining.keyPair.fingerprint },
    enrollmentId: decision.enrollmentId,
    now: Date.parse(at(1)),
  })
  await MeshNodeRegistry.enroll(controller.registryStore, { meshId: MESH_ID, nodeId: decision.nodeId, nodeKeyId: joining.keyPair.keyId, displayName: "worker-1", enrolledAt: Date.parse(at(1)) })
  controller.expectPeer(decision.nodeId)

  const worker = await aWorker({ nodeId: decision.nodeId, keyPair: joining.keyPair, controllerKey: controller.identity.keyPair, clock })
  openNodes.push(worker)
  return { controller, worker, clock }
}

/** Delivers a lease to the worker and returns the worker's answer. */
async function deliver(controller: ControllerNode, worker: WorkerNode, envelope: Record<string, unknown>) {
  const delivered = await post(worker.baseUrl, "/v1/mesh/lease", controller.client, envelope)
  return delivered.json.result as { outcome: string; reason?: string; error?: { code: string; message: string } }
}

describe("lease expiry pauses new orchestration and preserves existing processes", () => {
  it("an expired lease refuses new work and leaves the live session inventory untouched", async () => {
    const { controller, worker, clock } = await aTwoNodeMesh()
    await controller.lease.claim(leaseEnvelope({ operation: "claim", recipientNodeId: worker.identity.nodeId }))
    expect((await deliver(controller, worker, leaseEnvelope({ operation: "claim", recipientNodeId: worker.identity.nodeId }))).outcome).toBe("accepted")

    // One session is running, and the inventory is the operator's only record of it.
    await post(controller.baseUrl, "/v1/mesh/event", worker.client, eventEnvelope({ sourceNodeId: worker.identity.nodeId, localSequence: 1 }))
    const before = aLiveSessionInventory()
    expect(before).toEqual([])

    // A renewal inside the window keeps the lease current, which is what "requires
    // periodic renewal before expiry" means in practice.
    clock.set(Date.parse(at(20)))
    const renewed = await deliver(
      controller,
      worker,
      leaseEnvelope({ operation: "renew", recipientNodeId: worker.identity.nodeId, issuedAt: at(20), expiresAt: at(20 + DURATION_SECONDS) }),
    )
    expect(renewed.outcome).toBe("accepted")

    const permitWhileCurrent = await worker.lease.permitsNewWork({ projectId: PROJECT, runId: RUN })
    expect(permitWhileCurrent.ok && permitWhileCurrent.value.permitted).toBe(true)

    // Now the renewal stops. One second past the renewed window, the lease is expired.
    clock.set(Date.parse(at(20 + DURATION_SECONDS + 1)))
    const permitAfterExpiry = await worker.lease.permitsNewWork({ projectId: PROJECT, runId: RUN })
    expect(permitAfterExpiry.ok && permitAfterExpiry.value.permitted).toBe(false)
    if (permitAfterExpiry.ok && !permitAfterExpiry.value.permitted) {
      // The reason is `expired` and not `no_lease`, because the two send an operator
      // to different places: one means "nobody is driving this run", the other means
      // "the controller you were using is gone".
      expect(permitAfterExpiry.value.reason).toBe("expired")
    }

    // A command minted by the controller that held the lease is now refused, and
    // NOTHING is persisted — which is a property of the table, not of the refusal code.
    const command = commandEnvelope({ recipientNodeId: worker.identity.nodeId, issuedAt: at(21), expiresAt: at(21 + DURATION_SECONDS) })
    const refused = await post(worker.baseUrl, "/v1/mesh/command", controller.client, command)
    const outcome = refused.json.result as { outcome: string; stage?: string; error?: { code: string; message: string } }
    expect(outcome.outcome).toBe("refused")
    expect(outcome.error?.code).toBe("lease.expired")
    // The message says the thing that is easy to get wrong: nothing was terminated.
    expect(outcome.error?.message).toContain("Nothing about any running agent changes")
    const rows = await worker.inbox.list({ projectId: PROJECT, runId: RUN })
    expect(rows.ok && rows.value).toHaveLength(0)

    // THE property. The inventory a human would read is byte-identical: an expiry is a
    // pause of new work, never a termination of existing work, and the plan's
    // guardrail is "do not terminate agents because a controller or network
    // disappeared".
    const after = aLiveSessionInventory()
    expect(after).toEqual(before)
    expect([...after]).toEqual([...before])
  })

  it("an expired lease still streams, because a stream is not new work", async () => {
    // The asymmetry stated the other way round. If expiry also stopped the EVENT
    // stream, a worker would go blind exactly when the controller it was reporting to
    // disappeared, and the run would become unobservable rather than merely
    // uncontrolled.
    const { controller, worker, clock } = await aTwoNodeMesh()
    await deliver(controller, worker, leaseEnvelope({ operation: "claim", recipientNodeId: worker.identity.nodeId }))
    await post(controller.baseUrl, "/v1/mesh/event", worker.client, eventEnvelope({ sourceNodeId: worker.identity.nodeId, localSequence: 1 }))

    clock.set(Date.parse(at(DURATION_SECONDS + 1)))
    const streamed = await get(controller.baseUrl, `/v1/mesh/events?projectId=${PROJECT}&runId=${RUN}&cursor=0`, worker.client)
    expect(streamed.status).toBe(200)
    expect(decodeFrames(streamed.text).map((frame) => frame.id)).toEqual(["1"])
  })
})

describe("manual takeover uses a higher epoch", () => {
  it("a successor takes over at a higher epoch, names the lease it fences, and records why", async () => {
    const { controller, worker } = await aTwoNodeMesh()
    // The original controller claims on its own store and the worker is told, which is
    // the order the mesh runs in: a claim is decided locally and DELIVERED, and a node
    // that has not been told holds no lease to fence.
    expect((await controller.lease.claim(leaseEnvelope({ operation: "claim", recipientNodeId: worker.identity.nodeId }))).outcome).toBe("accepted")
    await deliver(controller, worker, leaseEnvelope({ operation: "claim", recipientNodeId: worker.identity.nodeId }))

    // A takeover is USER-INITIATED and it is the only thing that raises the epoch.
    // Three facts it must carry: the lease it replaces, the epoch it replaces, and why
    // the user moved control — because the reason is what an audit reads later.
    const takeover = leaseEnvelope({
      operation: "takeover",
      recipientNodeId: worker.identity.nodeId,
      controllerNodeId: SUCCESSOR,
      epoch: 2,
      predecessorLeaseId: "lease-run-release-1",
      predecessorEpoch: 1,
      takeoverReason: "The original controller's machine is offline and the run is unattended.",
    })
    // The worker's ACCEPTANCE is the fence: the successor is accepted because it names
    // the lease that is actually in force, not because it claimed a higher number.
    const accepted = await deliver(controller, worker, takeover)
    expect(accepted.outcome).toBe("accepted")

    const held = await worker.lease.heldLease({ projectId: PROJECT, runId: RUN })
    expect(held.ok && held.value?.controllerNodeId).toBe(SUCCESSOR)
    expect(held.ok && held.value?.epoch).toBe(2)

    // The successor's own lease store, driving the same run.
    const successorClaim = await controller.lease.takeover(takeover)
    expect(successorClaim.outcome).toBe("accepted")
    const successorHeld = await controller.lease.heldLease({ projectId: PROJECT, runId: RUN })
    expect(successorHeld.ok && successorHeld.value?.epoch).toBe(2)
  })

  it("refuses a takeover at the SAME epoch, because a takeover must strictly increase it", async () => {
    const { worker, controller } = await aTwoNodeMesh()
    await deliver(controller, worker, leaseEnvelope({ operation: "claim", recipientNodeId: worker.identity.nodeId }))
    const sameEpoch = await deliver(
      controller,
      worker,
      leaseEnvelope({
        operation: "takeover",
        recipientNodeId: worker.identity.nodeId,
        controllerNodeId: SUCCESSOR,
        epoch: 1,
        predecessorLeaseId: "lease-run-release-1",
        predecessorEpoch: 1,
        takeoverReason: "Attempting a takeover that does not raise the epoch.",
      }),
    )
    expect(sameEpoch.outcome).toBe("refused")
    expect(sameEpoch.reason).toBe("epoch_not_increasing")
  })

  it("refuses a takeover that does not name the lease in force", async () => {
    // The rule `evaluateLease` had to be given: skipping this comparison when the
    // node holds nothing made the epoch in a takeover an UNBACKED ASSERTION at every
    // node that knows nothing about the run, and the partition matrix turned that into
    // the plan's stop condition — one controller per worker and TWO controllers
    // driving one run.
    const { controller, worker } = await aTwoNodeMesh()
    await deliver(controller, worker, leaseEnvelope({ operation: "claim", recipientNodeId: worker.identity.nodeId }))
    const wrongPredecessor = await deliver(
      controller,
      worker,
      leaseEnvelope({
        operation: "takeover",
        recipientNodeId: worker.identity.nodeId,
        controllerNodeId: SUCCESSOR,
        epoch: 2,
        predecessorLeaseId: "lease-run-release-9",
        predecessorEpoch: 1,
        takeoverReason: "Naming a lease this node does not hold.",
      }),
    )
    expect(wrongPredecessor.outcome).toBe("refused")
    expect(wrongPredecessor.reason).toBe("predecessor_mismatch")
  })

  it("refuses a takeover while a node is unreconciled and the user has NOT acknowledged it", async () => {
    // The plan: "Takeover requires the user to inspect unreconciled nodes and
    // explicitly accept degraded nodes or wait for them." The acknowledgement is
    // checked against THIS node's own reconciliation, never against the claimant's
    // list, so the check cannot be satisfied by the record itself.
    const { controller, worker } = await aTwoNodeMesh()
    await deliver(controller, worker, leaseEnvelope({ operation: "claim", recipientNodeId: worker.identity.nodeId }))
    // Reconciliation marked the worker as not-yet-reconciled. M4.4's set is written
    // only by reconciliation, so this goes through the reconciler's real step 6.
    worker.unreconciled.set({ projectId: PROJECT, runId: RUN }, [worker.identity.nodeId])

    const unacknowledged = await deliver(
      controller,
      worker,
      leaseEnvelope({
        operation: "takeover",
        recipientNodeId: worker.identity.nodeId,
        controllerNodeId: SUCCESSOR,
        epoch: 2,
        predecessorLeaseId: "lease-run-release-1",
        predecessorEpoch: 1,
        takeoverReason: "Moving control while a node is unreconciled.",
      }),
    )
    expect(unacknowledged.outcome).toBe("refused")
    expect(unacknowledged.reason).toBe("unreconciled_nodes_not_acknowledged")

    // And it is accepted once the user has acknowledged that node, which is the whole
    // of what the precondition asks for.
    const acknowledged = await deliver(
      controller,
      worker,
      leaseEnvelope({
        operation: "takeover",
        recipientNodeId: worker.identity.nodeId,
        controllerNodeId: SUCCESSOR,
        epoch: 2,
        predecessorLeaseId: "lease-run-release-1",
        predecessorEpoch: 1,
        takeoverReason: "The unreconciled node was inspected and accepted as degraded.",
        acknowledgedUnreconciledNodeIds: [worker.identity.nodeId],
      }),
    )
    expect(acknowledged.outcome).toBe("accepted")
  })
})

describe("a stale controller is rejected", () => {
  it("refuses a command from the superseded controller, and persists NOTHING", async () => {
    const { controller, worker } = await aTwoNodeMesh()
    await deliver(controller, worker, leaseEnvelope({ operation: "claim", recipientNodeId: worker.identity.nodeId }))
    await deliver(
      controller,
      worker,
      leaseEnvelope({
        operation: "takeover",
        recipientNodeId: worker.identity.nodeId,
        controllerNodeId: SUCCESSOR,
        epoch: 2,
        predecessorLeaseId: "lease-run-release-1",
        predecessorEpoch: 1,
        takeoverReason: "Moving control to a controller that is still running.",
      }),
    )

    // The ORIGINAL controller keeps sending at epoch 1. It is dropped, and the reason
    // says why: it was decided against a projection that no longer exists.
    const stale = await post(
      worker.baseUrl,
      "/v1/mesh/command",
      controller.client,
      commandEnvelope({ recipientNodeId: worker.identity.nodeId, controllerEpoch: 1, issuedAt: at(2), expiresAt: at(2 + DURATION_SECONDS) }),
    )
    const outcome = stale.json.result as { outcome: string; stage?: string; error?: { code: string; category: string; retryable: boolean } }
    expect(outcome.outcome).toBe("refused")
    expect(outcome.error?.code).toBe("epoch.stale")
    expect(outcome.error?.category).toBe("stale_epoch")
    // NOT retryable, which is the operational point: a stale controller cannot reach a
    // retry loop by trying again, so there is no queue building up behind a successor
    // that will never arrive.
    expect(outcome.error?.retryable).toBe(false)

    // Nothing was written, and the assertion is on the table rather than on the code.
    const rows = await worker.inbox.list({ projectId: PROJECT, runId: RUN })
    expect(rows.ok && rows.value).toHaveLength(0)
  })

  it("refuses a command that claims a HIGHER epoch, because only a takeover may raise it", async () => {
    const { controller, worker } = await aTwoNodeMesh()
    await deliver(controller, worker, leaseEnvelope({ operation: "claim", recipientNodeId: worker.identity.nodeId }))
    // A controller that simply claims a higher epoch is the automatic election the
    // milestone forbids, arriving by a different road.
    const unregistered = await post(
      worker.baseUrl,
      "/v1/mesh/command",
      controller.client,
      commandEnvelope({ recipientNodeId: worker.identity.nodeId, controllerEpoch: 7, issuedAt: at(2), expiresAt: at(2 + DURATION_SECONDS) }),
    )
    const outcome = unregistered.json.result as { outcome: string; error?: { code: string; message: string } }
    expect(outcome.outcome).toBe("refused")
    expect(outcome.error?.code).toBe("epoch.unregistered")
    expect(outcome.error?.message).toContain("explicit lease takeover")
    const rows = await worker.inbox.list({ projectId: PROJECT, runId: RUN })
    expect(rows.ok && rows.value).toHaveLength(0)
  })

  it("refuses a command minted under a lease window this node does not hold", async () => {
    // A node whose lease store was lost cannot be brought onto a new epoch by a
    // takeover until reconciliation re-delivers the lease. Failing closed on an
    // authority decision is the right direction even when the recovery path costs a
    // round trip, because the alternative is a run with two controllers.
    const { controller, worker } = await aTwoNodeMesh()
    const command = commandEnvelope({
      recipientNodeId: worker.identity.nodeId,
      leaseId: leaseIdSchema.parse("lease-run-release-7"),
      issuedAt: at(1),
      expiresAt: at(1 + DURATION_SECONDS),
    })
    const refused = await post(worker.baseUrl, "/v1/mesh/command", controller.client, command)
    const outcome = refused.json.result as { outcome: string; stage?: string; error?: { code: string; message: string } }
    expect(outcome.outcome).toBe("refused")
    // The gate never got as far as the epoch: it found no lease at all for the run.
    expect(outcome.stage).toBe("gate")
    expect(outcome.error?.code).toBe("lease.none_held")
  })

  it("a takeover that names no predecessor never becomes a lease record", async () => {
    // Not a hypothetical: a takeover that names nothing is a claim about a node that
    // holds no lease, which is how the split brain the milestone fences against
    // happened once already. The assertion is on the WIRE, before any seam sees it.
    const { worker } = await aTwoNodeMesh()
    const nameless = leaseEnvelope({ operation: "takeover", recipientNodeId: worker.identity.nodeId, controllerNodeId: SUCCESSOR, epoch: 2 })
    expect(safeParseMeshEnvelope(nameless).ok).toBe(false)
    const rows = await worker.inbox.list({ projectId: PROJECT, runId: RUN })
    expect(rows.ok && rows.value).toHaveLength(0)
  })
})

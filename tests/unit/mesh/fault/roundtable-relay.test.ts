/**
 * Roundtable relay fault harness coverage.
 *
 * Requirements (implementation plan §10 & §11):
 *   1. Dropped post: a relayed post whose delivery is dropped (response lost) is NOT lost —
 *      the durable outbox row survives and redelivery reaches the member exactly once.
 *   2. Replayed post: a replayed/duplicated relay (same command id) is recognisable as the same
 *      effect — the member does not receive the post twice (dedupe by derived outbox id).
 *   3. Mid-relay controller restart: a controller crash between the durable append and relay
 *      delivery, followed by `restartNode`, still delivers every post exactly once;
 *      per-discussion `seq` order is preserved across the restart (no reordering, no gaps).
 *
 * Each scenario enforces structural assertions and NON-VACUITY guards mirroring
 * `boundaries.test.ts`, `partition.test.ts`, and `stale-epoch.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { InjectedCrash } from "../../../../src/mesh/fault/boundary.js"
import { eventEnvelope } from "../../../../src/mesh/fault/records.js"
import { DefaultRoundtablePostRelay } from "../../../../src/mesh/outbox/ingest.js"
import { meshAckSchema } from "../../../../src/mesh/protocol/ack.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../../../src/mesh/protocol/negotiation.js"
import { correlationIdSchema, eventIdSchema, nodeIdSchema } from "../../../../src/orchestration/identifiers.js"
import type { OrchestrationEvent } from "../../../../src/orchestration/types.js"
import type { MeshEvent } from "../../../../src/mesh/protocol/event.js"
import type { Post } from "../../../../src/orchestration/roundtable/index.js"
import {
  aFaultScenario,
  anApprovedScenario,
  faultCode,
} from "./fixtures.js"

/** Catches an InjectedCrash thrown by work(), returning null if work() succeeded. */
async function catching(work: () => unknown): Promise<InjectedCrash | null> {
  try {
    await work()
  } catch (error) {
    if (error instanceof InjectedCrash) return error
    throw error
  }
  return null
}

/** Extracts the Post payload from a roundtable.posted MeshEvent. */
function postOf(event: MeshEvent): Post {
  if (event.event.type !== "roundtable.posted") {
    throw new Error(`expected roundtable.posted event, got ${event.event.type}`)
  }
  return event.event.payload.post
}

describe("roundtable relay fault coverage", () => {
  // ==========================================================================
  // Scenario 1: Dropped post
  // ==========================================================================
  it("dropped post: outbox row survives in pending state and redelivery reaches member exactly once", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh

    try {
      // 1. Open discussion with controller and worker as members
      const openCmd = scenario.openRoundtableCommand(1)
      const opened = mesh.controller.coordinator.submit(openCmd)
      expect(opened.ok).toBe(true)

      const postCmd = scenario.postRoundtableCommand(1, {
        postId: "post-dropped-1",
        body: "deliberation under dropped relay packet",
      })

      // Script the transport proxy to DROP the relayed post
      mesh.script([{ match: { recordType: "mesh.event" }, kind: "drop" }])

      // 2. Submit post: durable append commits inside the transaction, but effectTransport delivery fails
      const postResult = await mesh.controller.coordinator.submitPost(postCmd)
      expect(postResult.ok).toBe(false)
      if (!postResult.ok) {
        expect(postResult.error.code).toBe("coordinator.relay_delivery_failed")
        expect(postResult.error.category).toBe("transient_transport")
      }

      // NON-VACUITY GUARD 1: Verify the drop hook actually matched and dropped the transmission
      const droppedTx = mesh.timeline().find((t) => t.recordType === "mesh.event" && t.fault === "drop")
      expect(droppedTx).toBeDefined()
      expect(droppedTx?.deliveries).toHaveLength(1)
      expect(droppedTx?.deliveries[0]?.outcome).toBe("dropped")

      // NON-VACUITY GUARD 2: The durable outbox row survived in SQLite outboxStore with pending status
      const outboxId = `obx-${postCmd.commandId}-relay-${String(mesh.workerNodeId)}`
      const durableRow = mesh.controller.outboxStore.find(outboxId)
      expect(durableRow).toBeDefined()
      expect(durableRow?.outboxId).toBe(outboxId)
      expect(durableRow?.status).toBe("pending")
      expect(durableRow?.destination).toBe(String(mesh.workerNodeId))

      // NON-VACUITY GUARD 3: The member has not yet received the post (delivery was dropped)
      expect(mesh.worker.ingested().filter((e) => e.eventType === "roundtable.posted")).toHaveLength(0)

      // 3. Clear drop script to heal the transport link
      mesh.script([])

      // Redeliver via outbox deliverer pump
      const pumpReport = await mesh.controller.deliverer().pumpOnce()
      expect(pumpReport.claimed).toBe(1)
      expect(pumpReport.acknowledged).toBe(1)

      // Outbox row is now acknowledged in durable storage
      const postDeliveryRow = mesh.controller.outboxStore.find(outboxId)
      expect(postDeliveryRow?.status).toBe("acknowledged")

      // EXACTLY ONCE: The worker received the relayed post
      const receivedPosts = mesh.worker.ingested().filter((e) => e.eventType === "roundtable.posted")
      expect(receivedPosts).toHaveLength(1)
      expect(postOf(receivedPosts[0]!).postId).toBe("post-dropped-1")
      expect(postOf(receivedPosts[0]!).seq).toBe(1)

      // Additional pump produces no duplicates (converged)
      const secondPump = await mesh.controller.deliverer().pumpOnce()
      expect(secondPump.claimed).toBe(0)
      expect(mesh.worker.ingested().filter((e) => e.eventType === "roundtable.posted")).toHaveLength(1)
    } finally {
      mesh.close()
    }
  })

  // ==========================================================================
  // Scenario 2: Replayed post
  // ==========================================================================
  it("replayed post: duplicated relay is deduplicated by derived id and never received twice", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh

    try {
      const openCmd = scenario.openRoundtableCommand(1)
      expect(mesh.controller.coordinator.submit(openCmd).ok).toBe(true)

      const postCmd = scenario.postRoundtableCommand(1, {
        postId: "post-replayed-1",
        body: "deliberation under duplicated wire packet",
      })

      // Script the proxy to duplicate deliveries (two identical wire copies)
      mesh.script([{ match: { recordType: "mesh.event" }, kind: "duplicate", times: 2 }])

      // Submit post through coordinator
      const postResult = await mesh.controller.coordinator.submitPost(postCmd)
      expect(postResult.ok).toBe(true)

      // NON-VACUITY GUARD 1: Verify the proxy delivered TWO copies across the wire
      const eventTx = mesh.timeline().find((t) => t.recordType === "mesh.event")
      expect(eventTx).toBeDefined()
      expect(eventTx?.fault).toBe("duplicate")
      expect(eventTx?.deliveries).toHaveLength(2)
      expect(eventTx?.deliveries[0]?.outcome).toBe("delivered")
      expect(eventTx?.deliveries[1]?.outcome).toBe("delivered")

      // NON-VACUITY GUARD 2: Deduplication by derived event id (naive path without dedupe would hold 2)
      const derivedEventId = `evt-${postCmd.commandId}-relay-${String(mesh.workerNodeId)}`
      const receivedPosts = mesh.worker.ingested().filter((e) => e.eventType === "roundtable.posted")
      expect(receivedPosts).toHaveLength(1)
      expect(receivedPosts[0]?.eventId).toBe(derivedEventId)
      expect(postOf(receivedPosts[0]!).postId).toBe("post-replayed-1")
      expect(postOf(receivedPosts[0]!).seq).toBe(1)

      // Resend the identical relay record explicitly to verify idempotency on redelivery
      const resendResponse = await mesh.controller.send({
        from: mesh.controllerNodeId,
        to: mesh.workerNodeId,
        record: eventEnvelope(receivedPosts[0]!, mesh.workerNodeId),
      })
      expect(typeof resendResponse).toBe("object")
      expect(resendResponse).not.toBeNull()
      if (resendResponse && typeof resendResponse === "object" && "ack" in resendResponse && "ingested" in resendResponse) {
        const ack = meshAckSchema.parse(resendResponse.ack)
        expect(ack.outcome).toBe("duplicate")
        const ingested = resendResponse.ingested
        if (ingested && typeof ingested === "object" && "status" in ingested) {
          expect(ingested.status).toBe("duplicate")
        }
      }

      // EXACTLY ONCE: Worker still holds strictly 1 post
      expect(mesh.worker.ingested().filter((e) => e.eventType === "roundtable.posted")).toHaveLength(1)
    } finally {
      mesh.close()
    }
  })

  // ==========================================================================
  // Scenario 3: Mid-relay controller restart
  // ==========================================================================
  it("mid-relay controller restart: crash after durable append still delivers every post exactly once with monotonic seq order", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh

    try {
      const openCmd = scenario.openRoundtableCommand(1)
      expect(mesh.controller.coordinator.submit(openCmd).ok).toBe(true)

      // Post 1: Normal append and delivery
      const postCmd1 = scenario.postRoundtableCommand(1, {
        postId: "post-seq-1",
        body: "First post before mid-relay restart",
      })
      const post1Result = await mesh.controller.coordinator.submitPost(postCmd1)
      expect(post1Result.ok).toBe(true)
      expect(mesh.worker.ingested().filter((e) => e.eventType === "roundtable.posted")).toHaveLength(1)

      // Arm boundary crash at afterCommit (fires right after durable append and before effectTransport.deliver)
      const nextOccurrence = mesh.boundary.fired("afterCommit") + 1
      mesh.crashAt("afterCommit", nextOccurrence)

      // Post 2: Crashes mid-relay after durable commit
      const postCmd2 = scenario.postRoundtableCommand(1, {
        postId: "post-seq-2",
        body: "Second post that crashes mid-relay",
      })
      const crash = await catching(() => mesh.controller.coordinator.submitPost(postCmd2))

      // NON-VACUITY GUARD 1: Crash boundary caught InjectedCrash at afterCommit
      expect(crash).toBeInstanceOf(InjectedCrash)
      expect(crash?.hook).toBe("afterCommit")
      expect(crash?.occurrence).toBe(nextOccurrence)
      expect(mesh.boundary.crashes).toEqual([{ hook: "afterCommit", occurrence: nextOccurrence }])
      expect(mesh.boundary.reached("afterCommit")).toBe(true)

      // NON-VACUITY GUARD 2: Post 2 was durably appended to SQLite outbox_records before the crash
      const outboxId2 = `obx-${postCmd2.commandId}-relay-${String(mesh.workerNodeId)}`
      const pendingRowBeforeRestart = mesh.controller.outboxStore.find(outboxId2)
      expect(pendingRowBeforeRestart).toBeDefined()
      expect(pendingRowBeforeRestart?.status).toBe("pending")

      // NON-VACUITY GUARD 3: Member has NOT yet received Post 2 because the crash interrupted delivery
      expect(mesh.worker.ingested().filter((e) => e.eventType === "roundtable.posted")).toHaveLength(1)

      // Restart the controller process over the SAME database files
      await mesh.restartNode(mesh.controllerNodeId)

      // NON-VACUITY GUARD 4: Outbox row and discussion state survived process restart
      const pendingRowAfterRestart = mesh.controller.outboxStore.find(outboxId2)
      expect(pendingRowAfterRestart).toBeDefined()
      expect(pendingRowAfterRestart?.status).toBe("pending")
      const replayedDiscussion = mesh.controller.roundtables.get("disc-fault-1")
      expect(replayedDiscussion).toBeDefined()
      expect(replayedDiscussion?.posts).toHaveLength(2)

      // Outbox deliverer claims and delivers the surviving Post 2 row
      const pumpReport = await mesh.controller.deliverer().pumpOnce()
      expect(pumpReport.claimed).toBe(1)
      expect(pumpReport.acknowledged).toBe(1)
      expect(mesh.controller.outboxStore.find(outboxId2)?.status).toBe("acknowledged")

      // Post 3: Appended and delivered after restart
      const postCmd3 = scenario.postRoundtableCommand(1, {
        postId: "post-seq-3",
        body: "Third post submitted after controller restart",
      })
      const post3Result = await mesh.controller.coordinator.submitPost(postCmd3)
      expect(post3Result.ok).toBe(true)

      // STRUCTURAL ASSERTIONS:
      const allWorkerPosts = mesh.worker.ingested().filter((e) => e.eventType === "roundtable.posted")
      // 1. Exactly-once count
      expect(allWorkerPosts).toHaveLength(3)

      // 2. Monotonic sequence numbers with NO gaps and NO reordering
      const postSeqs = allWorkerPosts.map((p) => postOf(p).seq)
      expect(postSeqs).toEqual([1, 2, 3])

      // 3. Post identity ordering preserved
      const postIds = allWorkerPosts.map((p) => postOf(p).postId)
      expect(postIds).toEqual(["post-seq-1", "post-seq-2", "post-seq-3"])
    } finally {
      mesh.close()
    }
  })

  // ==========================================================================
  // DefaultRoundtablePostRelay unit contract with transport drop and replay
  // ==========================================================================
  it("DefaultRoundtablePostRelay: relays member post with drop failure and replay deduplication", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh

    try {
      const openCmd = scenario.openRoundtableCommand(1)
      expect(mesh.controller.coordinator.submit(openCmd).ok).toBe(true)

      const deliveredTo: string[] = []
      let dropDelivery = true

      const relay = new DefaultRoundtablePostRelay({
        roundtables: mesh.controller.roundtables,
        transport: {
          deliver: async (entry) => {
            if (dropDelivery) {
              throw new Error("simulated transport drop")
            }
            deliveredTo.push(entry.destination)
            // Deliver to worker's receive seam
            await mesh.controller.send({
              from: mesh.controllerNodeId,
              to: entry.destination,
              record: eventEnvelope(entry.event, entry.destination),
            })
          },
        },
      })

      const rawPost = {
        postId: "post-member-1",
        discussionId: "disc-fault-1",
        seq: 1,
        authorNodeId: mesh.controllerNodeId,
        authorRoleId: "chair-role",
        kind: "proposal" as const,
        body: "Post relayed through DefaultRoundtablePostRelay",
        createdAt: new Date(mesh.clock.now()).toISOString(),
      }

      // Add to repository so relay can resolve discussion members
      const posted = mesh.controller.roundtables.post(rawPost, false)
      expect(posted.ok).toBe(true)

      const postEvent: OrchestrationEvent = {
        schemaVersion: 1,
        eventId: eventIdSchema.parse("evt-relay-test-1"),
        sequence: 1,
        type: "roundtable.posted",
        projectId: scenario.mesh.scope.projectId,
        runId: scenario.mesh.scope.runId,
        actor: { kind: "node", nodeId: mesh.controllerNodeId },
        controllerEpoch: 1,
        occurredAt: rawPost.createdAt,
        correlationId: correlationIdSchema.parse("corr-1"),
        causation: null,
        payload: { post: rawPost },
      }

      const meshEvent: MeshEvent = {
        meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
        eventId: eventIdSchema.parse("mevt-incoming-1"),
        sourceNodeId: mesh.controllerNodeId,
        commandCorrelation: null,
        localSequence: 1,
        observedAt: rawPost.createdAt,
        runProjectScope: scenario.mesh.scope,
        eventType: "roundtable.posted",
        event: postEvent,
      }

      // 1. Dropped delivery returns transport failure
      await expect(relay.relay(meshEvent)).rejects.toThrow("simulated transport drop")
      expect(deliveredTo).toHaveLength(0)

      // 2. Heal delivery and retry
      dropDelivery = false
      const relayResult = await relay.relay(meshEvent)
      expect(relayResult.ok).toBe(true)
      expect(deliveredTo).toEqual([String(mesh.workerNodeId)])
      expect(mesh.worker.ingested().filter((e) => e.eventType === "roundtable.posted")).toHaveLength(1)

      // 3. Replay: Re-relaying the same event produces duplicate acknowledgement on the member
      const replayResult = await relay.relay(meshEvent)
      expect(replayResult.ok).toBe(true)
      expect(deliveredTo).toHaveLength(2) // Transport called twice

      // Exactly once on member
      expect(mesh.worker.ingested().filter((e) => e.eventType === "roundtable.posted")).toHaveLength(1)
    } finally {
      mesh.close()
    }
  })

  it("DefaultRoundtablePostRelay: assigns monotonic seq via controller repository and preserves eventId across relay", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh

    try {
      const openCmd = scenario.openRoundtableCommand(1)
      expect(mesh.controller.coordinator.submit(openCmd).ok).toBe(true)

      const deliveredEvents: MeshEvent[] = []
      const relay = new DefaultRoundtablePostRelay({
        roundtables: mesh.controller.roundtables,
        controllerNodeId: mesh.controllerNodeId,
        transport: {
          deliver: async (entry) => {
            deliveredEvents.push(entry.event)
          },
        },
      })

      // Post with seq = 0 (unsequenced from author)
      const rawPost: Post = {
        postId: "post-unsequenced-1",
        discussionId: "disc-fault-1",
        seq: 0,
        authorNodeId: mesh.controllerNodeId,
        authorRoleId: "chair-role",
        kind: "proposal",
        body: "Post needing controller-assigned seq",
        createdAt: new Date(mesh.clock.now()).toISOString(),
      }

      const inputEventId = eventIdSchema.parse("evt-relay-seq-preserve")
      const postEvent: OrchestrationEvent = {
        schemaVersion: 1,
        eventId: inputEventId,
        sequence: 1,
        type: "roundtable.posted",
        projectId: scenario.mesh.scope.projectId,
        runId: scenario.mesh.scope.runId,
        actor: { kind: "node", nodeId: mesh.controllerNodeId },
        controllerEpoch: 1,
        occurredAt: rawPost.createdAt,
        correlationId: correlationIdSchema.parse("corr-seq-1"),
        causation: null,
        payload: { post: rawPost },
      }

      const meshEvent: MeshEvent = {
        meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
        eventId: inputEventId,
        sourceNodeId: mesh.controllerNodeId,
        commandCorrelation: null,
        localSequence: 1,
        observedAt: rawPost.createdAt,
        runProjectScope: scenario.mesh.scope,
        eventType: "roundtable.posted",
        event: postEvent,
      }

      const result = await relay.relay(meshEvent)
      expect(result.ok).toBe(true)
      expect(deliveredEvents).toHaveLength(1)
      const delivered = deliveredEvents[0]!

      // 1. Controller assigned monotonic seq (1)
      const relayedPost = postOf(delivered)
      expect(relayedPost.seq).toBe(1)
      expect(relayedPost.postId).toBe("post-unsequenced-1")

      // 2. Preserves eventId across relay so all nodes' streams have identical event IDs
      expect(delivered.eventId).toBe(inputEventId)
      // 3. Discussion state updated in controller repository
      const discussion = mesh.controller.roundtables.get("disc-fault-1")
      expect(discussion).toBeDefined()
      expect(discussion?.posts).toHaveLength(1)
      expect(discussion?.posts[0]?.seq).toBe(1)
    } finally {
      mesh.close()
    }
  })

  it("DefaultRoundtablePostRelay: filters out controllerNodeId to prevent self-delivery loop", async () => {
    const scenario = await anApprovedScenario()
    const mesh = scenario.mesh

    try {
      const workerCId = nodeIdSchema.parse("node-worker-c")
      const openCmd = scenario.openRoundtableCommand(1, {
        members: [
          { nodeId: mesh.controllerNodeId, roleId: "chair-role" },
          { nodeId: mesh.workerNodeId, roleId: "reviewer-role" },
          { nodeId: workerCId, roleId: "reviewer-c-role" },
        ],
      })
      expect(mesh.controller.coordinator.submit(openCmd).ok).toBe(true)

      const deliveredDestinations: string[] = []
      const relay = new DefaultRoundtablePostRelay({
        roundtables: mesh.controller.roundtables,
        controllerNodeId: mesh.controllerNodeId,
        transport: {
          deliver: async (entry) => {
            deliveredDestinations.push(String(entry.destination))
          },
        },
      })

      // Worker B posts to discussion
      const rawPost: Post = {
        postId: "post-from-worker-b",
        discussionId: "disc-fault-1",
        seq: 1,
        authorNodeId: mesh.workerNodeId,
        authorRoleId: "reviewer-role",
        kind: "proposal",
        body: "Post from worker B",
        createdAt: new Date(mesh.clock.now()).toISOString(),
      }

      const postEvent: OrchestrationEvent = {
        schemaVersion: 1,
        eventId: eventIdSchema.parse("evt-relay-b-1"),
        sequence: 2,
        type: "roundtable.posted",
        projectId: scenario.mesh.scope.projectId,
        runId: scenario.mesh.scope.runId,
        actor: { kind: "node", nodeId: mesh.workerNodeId },
        controllerEpoch: 1,
        occurredAt: rawPost.createdAt,
        correlationId: correlationIdSchema.parse("corr-b-1"),
        causation: null,
        payload: { post: rawPost },
      }

      const meshEvent: MeshEvent = {
        meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
        eventId: eventIdSchema.parse("evt-relay-b-1"),
        sourceNodeId: mesh.workerNodeId,
        commandCorrelation: null,
        localSequence: 1,
        observedAt: rawPost.createdAt,
        runProjectScope: scenario.mesh.scope,
        eventType: "roundtable.posted",
        event: postEvent,
      }

      const result = await relay.relay(meshEvent)
      expect(result.ok).toBe(true)

      // CRITICAL:
      // 1. Worker B (sender) is excluded
      // 2. Controller A (relay hub) is excluded from self-delivery
      // 3. ONLY Worker C receives the relayed post
      expect(deliveredDestinations).toEqual([String(workerCId)])
      expect(deliveredDestinations).not.toContain(String(mesh.controllerNodeId))
      expect(deliveredDestinations).not.toContain(String(mesh.workerNodeId))
    } finally {
      mesh.close()
    }
  })
})

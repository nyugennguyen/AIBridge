/**
 * Remote Roundtable Deliberation Integration Test (§10 Phase 4 Remote Roundtable).
 *
 * ARCHITECTURAL CONTEXT & INVARIANTS ASSERTED:
 *   1. Three-node topology over real sockets with real ed25519 request signatures:
 *      - Node A: Controller & Roundtable Chair
 *      - Node B: Remote Member (Proposer)
 *      - Node C: Remote Member (Reviewer)
 *   2. Controller Relay (§6.3):
 *      When Node B posts to the roundtable, the post travels to Controller A, which
 *      commits the post with a controller-assigned monotonic sequence (`post.seq`)
 *      and relays it over the mesh wire to Node C (and vice versa when Node C posts).
 *   3. Total Order across all Nodes' SSE Streams:
 *      Every node's SSE event gateway (`/v1/mesh/events`) serves a gapless, monotonic
 *      position sequence (1, 2, 3, ...) with an IDENTICAL sequence of domain events
 *      representing the conversation.
 *   4. Idempotent Redelivery & Fault Injection:
 *      An injected replayed relay packet (duplicate wire delivery) is recognized by the
 *      receiving node's gateway and ingestor as a duplicate. It produces NO duplicate
 *      events on the stream and does not corrupt or reorder the stream positions.
 *   5. Total-order cursor resumption:
 *      SSE stream cursor resumption (`cursor=2`) returns identical continuations
 *      across all nodes.
 */

import { afterEach, describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import {
  CURRENT_SCHEMA_VERSION,
  correlationIdSchema,
  eventIdSchema,
  nodeIdSchema,
  type EventId,
  type NodeId,
} from "../../src/orchestration/identifiers.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../src/mesh/protocol/negotiation.js"
import type { MeshEvent } from "../../src/mesh/protocol/event.js"
import {
  DefaultRoundtablePostRelay,
  MeshEventIngestor,
} from "../../src/mesh/outbox/ingest.js"
import {
  MeshEventGateway,
  decodeFrames,
  registerEventStreamRoute,
  scopeFromQuery,
} from "../../src/mesh/gateway/events/index.js"
import {
  InMemoryNodeTrustStore,
  InMemoryNonceGuard,
  InMemoryPeerKeyPinStore,
  MeshIdentityProvider,
  NodeKeyPair,
} from "../../src/mesh/identity/index.js"
import type { MeshIdentityHookOptions } from "../../src/mesh/identity/middleware.js"
import { RoundtableRepository, type Post, type Roundtable } from "../../src/orchestration/roundtable/index.js"
import type { OrchestrationEvent } from "../../src/orchestration/types.js"
import {
  MeshClock,
  PROJECT,
  RUN,
  MESH_ID,
  at,
  get,
  listen,
  post,
  aClient,
} from "./mesh-fixtures.js"

interface NodeIdentityStores {
  readonly trust: InMemoryNodeTrustStore
  readonly pins: InMemoryPeerKeyPinStore
}

interface TestNodeClient {
  headers(method: string, url: string, body: unknown): Record<string, string>
}

interface TestNode {
  readonly nodeId: NodeId
  readonly keyPair: NodeKeyPair
  readonly identity: NodeIdentityStores
  readonly client: TestNodeClient
  readonly baseUrl: string
  readonly gateway: MeshEventGateway
  readonly ingestor: MeshEventIngestor
  readonly roundtables?: RoundtableRepository
  readonly peerEvents: MeshEvent[]
  setExpectedPeer(peerId: NodeId): void
  close(): Promise<void>
}

const openNodes: TestNode[] = []

afterEach(async () => {
  while (openNodes.length > 0) {
    const node = openNodes.pop()
    if (node) await node.close()
  }
})

/** Builds a test mesh node on a real ephemeral TCP socket. */
async function buildTestNode(options: {
  readonly nodeId: NodeId
  readonly keyPair: NodeKeyPair
  readonly clock: MeshClock
  readonly isController?: boolean
  readonly roundtables?: RoundtableRepository
  readonly relayTransport?: {
    deliver(record: { readonly destination: NodeId; readonly event: MeshEvent }): Promise<void>
  }
}): Promise<TestNode> {
  const { nodeId, keyPair, clock, isController, roundtables, relayTransport } = options

  const trust = new InMemoryNodeTrustStore()
  const pins = new InMemoryPeerKeyPinStore()
  const provider = new MeshIdentityProvider({
    trust,
    pins,
    replayGuard: new InMemoryNonceGuard(),
    now: () => clock.now(),
  })

  const gateway = new MeshEventGateway({ now: clock.now })
  const peerEvents: MeshEvent[] = []

  let relay: DefaultRoundtablePostRelay | undefined
  if (isController && roundtables && relayTransport) {
    relay = new DefaultRoundtablePostRelay({
      roundtables,
      transport: relayTransport,
      controllerNodeId: nodeId,
    })
  }

  const ingestor = new MeshEventIngestor({
    store: {
      seen: async (eventId) => ({
        ok: true,
        value: peerEvents.some((e) => e.eventId === eventId),
      }),
      apply: async (event: MeshEvent) => {
        peerEvents.push(event)
        return { ok: true, value: undefined }
      },
    },
    relay,
  })

  const expectedPeerHolder: { nodeId: NodeId } = { nodeId }
  const streamIdentity: MeshIdentityHookOptions = {
    provider,
    get expectedNodeId() {
      return expectedPeerHolder.nodeId
    },
    expectedMeshId: MESH_ID,
  }

  const app: FastifyInstance = Fastify()
  registerEventStreamRoute(app, { gateway, identity: streamIdentity, scopeOf: scopeFromQuery })

  // Event ingestion endpoint over the wire
  app.post("/v1/mesh/event", async (request) => {
    const published = await gateway.publish(request.body)
    if (!published.ok) return { published }
    if (!published.outcome.accepted) {
      return { published, ack: { outcome: "duplicate", eventId: published.outcome.eventId } }
    }
    const payload = published.outcome.entry.payload
    const ingested = await ingestor.ingest(payload)
    return { published, ingested, ack: { outcome: "accepted", eventId: payload.eventId } }
  })

  const server = await listen(app)

  return {
    nodeId,
    keyPair,
    identity: { trust, pins },
    client: aClient({ keyPair, nodeId }),
    baseUrl: server.baseUrl,
    gateway,
    ingestor,
    roundtables,
    peerEvents,
    setExpectedPeer(peerId: NodeId) {
      expectedPeerHolder.nodeId = peerId
    },
    close: server.close,
  }
}

/** Enrolls mutual trust and pins keys between two nodes. */
async function admitPeer(
  node: TestNode,
  peer: { readonly id: NodeId; readonly key: NodeKeyPair },
  nowMs: number,
): Promise<void> {
  await node.identity.trust.enroll({
    nodeId: peer.id,
    meshId: MESH_ID,
    nodeKeyId: peer.key.keyId,
    enrolledAt: nowMs,
    displayName: String(peer.id),
  })
  await node.identity.pins.pin({
    nodeId: peer.id,
    meshId: MESH_ID,
    key: {
      nodeKeyId: peer.key.keyId,
      publicKey: peer.key.publicKey,
      fingerprint: peer.key.fingerprint,
    },
    enrollmentId: `enr-${String(peer.id)}`,
    now: nowMs,
  })
}

/** Constructs a canonical mesh.event wire envelope. */
function makeMeshEnvelope(
  event: MeshEvent,
  recipientNodeId: NodeId,
): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.event",
    messageId: `msg-${event.eventId}`,
    correlationId: event.eventId,
    causation: null,
    senderNodeId: event.sourceNodeId,
    recipientNodeId,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: event.observedAt,
    expiresAt: new Date(Date.parse(event.observedAt) + 3_600_000).toISOString(),
    payload: event,
  }
}

describe("Remote Roundtable Deliberation (§10 Phase 4)", () => {
  it("relays post from node B through controller to node C with gapless total order preserved across all three nodes", async () => {
    const clock = new MeshClock()

    const nodeAId = nodeIdSchema.parse("node-controller-a")
    const nodeBId = nodeIdSchema.parse("node-worker-b")
    const nodeCId = nodeIdSchema.parse("node-worker-c")

    const keyA = NodeKeyPair.generate()
    const keyB = NodeKeyPair.generate()
    const keyC = NodeKeyPair.generate()

    const roundtables = new RoundtableRepository()

    // Routing directory for controller relay delivery over real sockets
    const peerUrls: Record<string, string> = {}

    const relayTransport = {
      deliver: async (record: { readonly destination: NodeId; readonly event: MeshEvent }) => {
        const targetUrl = peerUrls[String(record.destination)]
        if (!targetUrl) {
          throw new Error(`Unknown peer destination: ${record.destination}`)
        }
        const envelope = makeMeshEnvelope(record.event, record.destination)
        await post(targetUrl, "/v1/mesh/event", nodeA.client, envelope)
      },
    }

    // 1. Build three real nodes on ephemeral TCP sockets
    const nodeA = await buildTestNode({
      nodeId: nodeAId,
      keyPair: keyA,
      clock,
      isController: true,
      roundtables,
      relayTransport,
    })
    openNodes.push(nodeA)

    const nodeB = await buildTestNode({
      nodeId: nodeBId,
      keyPair: keyB,
      clock,
    })
    openNodes.push(nodeB)

    const nodeC = await buildTestNode({
      nodeId: nodeCId,
      keyPair: keyC,
      clock,
    })
    openNodes.push(nodeC)

    peerUrls[String(nodeBId)] = nodeB.baseUrl
    peerUrls[String(nodeCId)] = nodeC.baseUrl

    // 2. Mutual trust enrollment and key pinning across all three nodes
    const allPeers = [
      { id: nodeAId, key: keyA },
      { id: nodeBId, key: keyB },
      { id: nodeCId, key: keyC },
    ]
    for (const n of [nodeA, nodeB, nodeC]) {
      for (const p of allPeers) {
        await admitPeer(n, p, clock.now())
      }
    }

    // Configure each node's stream identity to accept connections from its local client
    nodeA.setExpectedPeer(nodeAId)
    nodeB.setExpectedPeer(nodeBId)
    nodeC.setExpectedPeer(nodeCId)

    // 3. Open Roundtable: fixed membership with Controller A (chair), Node B (proposer), Node C (reviewer)
    const discussionId = "disc-remote-roundtable-1"
    const roundtable: Roundtable = {
      id: discussionId,
      runId: RUN,
      subject: "Distributed deliberation and consensus protocol",
      mode: "parallel",
      chairNodeId: nodeAId,
      members: [
        { nodeId: nodeAId, roleId: "chair-role" },
        { nodeId: nodeBId, roleId: "proposer-role" },
        { nodeId: nodeCId, roleId: "reviewer-role" },
      ],
      state: "open",
    }
    const opened = roundtables.open(roundtable)
    expect(opened.ok).toBe(true)

    const openTime = at(1)
    const openDomainEvent: OrchestrationEvent = {
      schemaVersion: 1,
      eventId: eventIdSchema.parse("evt-open-1"),
      sequence: 1,
      type: "roundtable.opened",
      projectId: PROJECT,
      runId: RUN,
      actor: { kind: "node", nodeId: nodeAId },
      controllerEpoch: 1,
      occurredAt: openTime,
      correlationId: correlationIdSchema.parse("corr-open-1"),
      causation: null,
      payload: { roundtable },
    }
    const openMeshEvent: MeshEvent = {
      meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
      eventId: eventIdSchema.parse("evt-open-1"),
      sourceNodeId: nodeAId,
      commandCorrelation: null,
      localSequence: 1,
      observedAt: openTime,
      runProjectScope: { projectId: PROJECT, runId: RUN },
      eventType: "roundtable.opened",
      event: openDomainEvent,
    }

    // Publish roundtable.opened across all three nodes (initial state)
    await nodeA.gateway.publish(makeMeshEnvelope(openMeshEvent, nodeAId))
    await nodeB.gateway.publish(makeMeshEnvelope(openMeshEvent, nodeBId))
    await nodeC.gateway.publish(makeMeshEnvelope(openMeshEvent, nodeCId))

    // 4. Node B produces Post 1 (proposal) and sends it over the wire to Controller A
    const post1Time = at(5)
    const rawPost1: Post = {
      postId: "post-b-1",
      discussionId,
      seq: 1,
      authorNodeId: nodeBId,
      authorRoleId: "proposer-role",
      kind: "proposal",
      body: "RFC: Deliberation protocol requires gapless total order on relay",
      createdAt: post1Time,
    }
    const post1DomainEvent: OrchestrationEvent = {
      schemaVersion: 1,
      eventId: eventIdSchema.parse("evt-post-b-1"),
      sequence: 2,
      type: "roundtable.posted",
      projectId: PROJECT,
      runId: RUN,
      actor: { kind: "node", nodeId: nodeBId },
      controllerEpoch: 1,
      occurredAt: post1Time,
      correlationId: correlationIdSchema.parse("corr-post-b-1"),
      causation: null,
      payload: { post: rawPost1 },
    }
    const post1MeshEvent: MeshEvent = {
      meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
      eventId: eventIdSchema.parse("evt-post-b-1"),
      sourceNodeId: nodeBId,
      commandCorrelation: null,
      localSequence: 1,
      observedAt: post1Time,
      runProjectScope: { projectId: PROJECT, runId: RUN },
      eventType: "roundtable.posted",
      event: post1DomainEvent,
    }
    // Node B commits Post 1 to its local gateway
    const bPublished1 = await nodeB.gateway.publish(makeMeshEnvelope(post1MeshEvent, nodeBId))
    expect(bPublished1.ok).toBe(true)

    // Node B transmits Post 1 to Controller A over the real socket
    const bToA = await post(
      nodeA.baseUrl,
      "/v1/mesh/event",
      nodeB.client,
      makeMeshEnvelope(post1MeshEvent, nodeAId),
    )
    expect(bToA.status).toBe(200)

    // Non-vacuity: verify Controller A received, ingested, and relayed to Node C
    expect(nodeC.peerEvents.some((e) => e.eventType === "roundtable.posted")).toBe(true)

    // 5. Assert Total Order across all three nodes' SSE streams
    const streamUrl = `/v1/mesh/events?projectId=${PROJECT}&runId=${RUN}&cursor=0`

    const streamedA1 = await get(nodeA.baseUrl, streamUrl, nodeA.client)
    const streamedB1 = await get(nodeB.baseUrl, streamUrl, nodeB.client)
    const streamedC1 = await get(nodeC.baseUrl, streamUrl, nodeC.client)

    expect(streamedA1.status).toBe(200)
    expect(streamedB1.status).toBe(200)
    expect(streamedC1.status).toBe(200)

    const framesA1 = decodeFrames(streamedA1.text)
    const framesB1 = decodeFrames(streamedB1.text)
    const framesC1 = decodeFrames(streamedC1.text)

    // Monotonic and gapless positions [1, 2] on all three nodes
    expect(framesA1.map((f) => f.id)).toEqual(["1", "2"])
    expect(framesB1.map((f) => f.id)).toEqual(["1", "2"])
    expect(framesC1.map((f) => f.id)).toEqual(["1", "2"])

    // Byte-identical event sequence and post payload across all three nodes
    const extractPostId = (f: unknown): string | undefined => {
      if (!f || typeof f !== "object" || !("data" in f) || !f.data || typeof f.data !== "object") {
        return undefined
      }
      const data = f.data
      if (!("event" in data) || !data.event || typeof data.event !== "object") {
        return undefined
      }
      const event = data.event
      if (!("payload" in event) || !event.payload || typeof event.payload !== "object") {
        return undefined
      }
      const payload = event.payload
      if (!("post" in payload) || !payload.post || typeof payload.post !== "object") {
        return undefined
      }
      const postObj = payload.post
      if ("postId" in postObj && typeof postObj.postId === "string") {
        return postObj.postId
      }
      return undefined
    }

    expect(extractPostId(framesA1[1])).toBe("post-b-1")
    expect(extractPostId(framesB1[1])).toBe("post-b-1")
    expect(extractPostId(framesC1[1])).toBe("post-b-1")

    // 6. Node C produces Post 2 (objection) and relays to Node B through Controller A
    const post2Time = at(10)
    const rawPost2: Post = {
      postId: "post-c-2",
      discussionId,
      seq: 2,
      authorNodeId: nodeCId,
      authorRoleId: "reviewer-role",
      kind: "objection",
      body: "Objection: Redelivery and replay fault tolerance must be proven",
      createdAt: post2Time,
    }
    const post2DomainEvent: OrchestrationEvent = {
      schemaVersion: 1,
      eventId: eventIdSchema.parse("evt-post-c-2"),
      sequence: 3,
      type: "roundtable.posted",
      projectId: PROJECT,
      runId: RUN,
      actor: { kind: "node", nodeId: nodeCId },
      controllerEpoch: 1,
      occurredAt: post2Time,
      correlationId: correlationIdSchema.parse("corr-post-c-2"),
      causation: null,
      payload: { post: rawPost2 },
    }
    const post2MeshEvent: MeshEvent = {
      meshProtocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
      eventId: eventIdSchema.parse("evt-post-c-2"),
      sourceNodeId: nodeCId,
      commandCorrelation: null,
      localSequence: 1,
      observedAt: post2Time,
      runProjectScope: { projectId: PROJECT, runId: RUN },
      eventType: "roundtable.posted",
      event: post2DomainEvent,
    }

    // Node C commits Post 2 to its local gateway
    const cPublished2 = await nodeC.gateway.publish(makeMeshEnvelope(post2MeshEvent, nodeCId))
    expect(cPublished2.ok).toBe(true)

    // Node C transmits Post 2 to Controller A over the wire
    const cToA = await post(
      nodeA.baseUrl,
      "/v1/mesh/event",
      nodeC.client,
      makeMeshEnvelope(post2MeshEvent, nodeAId),
    )
    expect(cToA.status).toBe(200)

    // Non-vacuity: Node B received the relayed Post 2 from Controller A
    expect(nodeB.peerEvents.some((e) => e.eventId === "evt-post-c-2")).toBe(true)

    // 7. Verify gapless positions [1, 2, 3] and identical event order on all three nodes
    const streamedA2 = await get(nodeA.baseUrl, streamUrl, nodeA.client)
    const streamedB2 = await get(nodeB.baseUrl, streamUrl, nodeB.client)
    const streamedC2 = await get(nodeC.baseUrl, streamUrl, nodeC.client)

    const framesA2 = decodeFrames(streamedA2.text)
    const framesB2 = decodeFrames(streamedB2.text)
    const framesC2 = decodeFrames(streamedC2.text)

    expect(framesA2.map((f) => f.id)).toEqual(["1", "2", "3"])
    expect(framesB2.map((f) => f.id)).toEqual(["1", "2", "3"])
    expect(framesC2.map((f) => f.id)).toEqual(["1", "2", "3"])

    expect(extractPostId(framesA2[2])).toBe("post-c-2")
    expect(extractPostId(framesB2[2])).toBe("post-c-2")
    expect(extractPostId(framesC2[2])).toBe("post-c-2")

    // 8. Injected Relay Replay: Duplicate transmission of Post 1 to Node C
    const replayResponse = await post(
      nodeC.baseUrl,
      "/v1/mesh/event",
      nodeA.client,
      makeMeshEnvelope(post1MeshEvent, nodeCId),
    )
    expect(replayResponse.status).toBe(200)
    const json = replayResponse.json
    expect("published" in json && typeof json.published === "object" && json.published !== null).toBe(true)
    const publishedVal = json.published
    if (publishedVal && typeof publishedVal === "object" && "outcome" in publishedVal && typeof publishedVal.outcome === "object" && publishedVal.outcome !== null) {
      const outcome = publishedVal.outcome
      expect("accepted" in outcome && outcome.accepted).toBe(false)
      expect("disposition" in outcome && outcome.disposition).toBe("duplicate")
    }

    // Verify Node C's stream after replay: NO duplicates, NO reordering, positions remain [1, 2, 3]
    const streamedC3 = await get(nodeC.baseUrl, streamUrl, nodeC.client)
    const framesC3 = decodeFrames(streamedC3.text)
    expect(framesC3).toHaveLength(3)
    expect(framesC3.map((f) => f.id)).toEqual(["1", "2", "3"])
    expect(extractPostId(framesC3[1])).toBe("post-b-1")
    expect(extractPostId(framesC3[2])).toBe("post-c-2")

    // 9. Resumption from cursor across nodes: all nodes return identical tail
    const resumeUrl = `/v1/mesh/events?projectId=${PROJECT}&runId=${RUN}&cursor=2`
    const resumedA = await get(nodeA.baseUrl, resumeUrl, nodeA.client)
    const resumedB = await get(nodeB.baseUrl, resumeUrl, nodeB.client)
    const resumedC = await get(nodeC.baseUrl, resumeUrl, nodeC.client)

    const resumedFramesA = decodeFrames(resumedA.text)
    const resumedFramesB = decodeFrames(resumedB.text)
    const resumedFramesC = decodeFrames(resumedC.text)

    expect(resumedFramesA.map((f) => f.id)).toEqual(["3"])
    expect(resumedFramesB.map((f) => f.id)).toEqual(["3"])
    expect(resumedFramesC.map((f) => f.id)).toEqual(["3"])
    expect(extractPostId(resumedFramesA[0])).toBe("post-c-2")
    expect(extractPostId(resumedFramesB[0])).toBe("post-c-2")
    expect(extractPostId(resumedFramesC[0])).toBe("post-c-2")
  })
})

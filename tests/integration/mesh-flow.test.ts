/**
 * M4.6 gate — two nodes, one run, over real sockets.
 *
 * The plan's completion criterion in one file: "at least two nodes can enroll,
 * advertise capabilities, and execute a run", plus the streaming half — "SSE resumes
 * from a cursor or uses an explicit snapshot fallback".
 *
 * The order below is the run, and each step is a record that had to be accepted by
 * the OTHER node before the next one could happen:
 *
 *   enroll → heartbeat → lease → dispatch → ingest → stream → resume
 *
 * Two properties are asserted at more than one step, because a property that holds
 * once is an observation:
 *
 *   - **Authentication precedes everything.** Every request is a real ed25519
 *     signature over the real request target, and the SSE route runs M4.2's own hook
 *     before it writes a byte. A node that cannot sign gets nothing, including the
 *     stream.
 *   - **The cursor is a total order across sources.** The worker is the only source
 *     in this file, so the total order is asserted against the kernel's per-RUN
 *     sequence and the mesh's per-SOURCE sequence disagreeing with the gateway's
 *     `position` — which is the only way the difference is observable at all.
 *
 * Nothing sleeps. Every instant is `T0` plus a number and the clock is shared, so
 * "ninety-one seconds after the last heartbeat" and "a cursor fifteen minutes old"
 * are both arithmetic.
 */
import { afterEach, describe, expect, it } from "vitest"
import { randomBytes } from "node:crypto"
import { decodeFrames, SSE_SNAPSHOT_EVENT_NAME } from "../../src/mesh/gateway/events/index.js"
import {
  CONTROLLER,
  DURATION_SECONDS,
  MESH_ID,
  MeshClock,
  PROJECT,
  RUN,
  PENDING_NODE,
  aJoiningNode,
  aController,
  aWorker,
  at,
  commandEnvelope,
  eventEnvelope,
  get,
  heartbeatEnvelope,
  leaseEnvelope,
  post,
  seedTheRun,
  type ControllerNode,
  type WorkerNode,
} from "./mesh-fixtures.js"
import { MeshNodeRegistry } from "../../src/mesh/registry/index.js"
import { InMemoryEnrollmentCodeStore, buildEnrollmentRequest, decideEnrollment, issueEnrollmentCode, signMeshRequest, meshBodyDigest } from "../../src/mesh/identity/index.js"
import { CURRENT_SCHEMA_VERSION } from "../../src/orchestration/identifiers.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../src/mesh/protocol/negotiation.js"
import { MESH_IDENTITY_HEADERS } from "../../src/mesh/identity/middleware.js"

const openNodes: { close(): Promise<void> }[] = []

afterEach(async () => {
  while (openNodes.length > 0) await openNodes.pop()!.close()
})

interface AMesh {
  readonly controller: ControllerNode
  readonly clock: MeshClock
  readonly joining: ReturnType<typeof aJoiningNode>
}

async function aMesh(): Promise<AMesh> {
  const clock = new MeshClock()
  const controller = await aController(clock)
  seedTheRun(controller)
  openNodes.push(controller)
  return { controller, clock, joining: aJoiningNode() }
}

/**
 * Enrolls a joining key and brings up the worker with the id the controller derived.
 *
 * The order is the protocol's: a joining node has a KEY and a PROVISIONAL name, not a
 * node id, and the controller mints the real one from the code hash. So the worker
 * cannot be constructed before enrollment, and a harness that picked its id up front
 * would be asserting on a fact the controller is supposed to decide.
 */
async function joinedNode(mesh: Awaited<ReturnType<typeof aMesh>>): Promise<WorkerNode> {
  await enroll(mesh.controller, mesh.joining)
  const enrolled = await mesh.controller.registry.nodes(MESH_ID)
  expect(enrolled.ok).toBe(true)
  if (!enrolled.ok) throw new Error("the registry refused to list the mesh")
  const workerNode = enrolled.value.find((entry) => entry.node.displayName === "worker-1")
  expect(workerNode).toBeDefined()
  if (workerNode === undefined) throw new Error("the enrolled node was not in the registry")
  mesh.controller.expectPeer(workerNode.node.nodeId)
  const worker = await aWorker({
    nodeId: workerNode.node.nodeId,
    keyPair: mesh.joining.keyPair,
    controllerKey: mesh.controller.identity.keyPair,
    clock: mesh.clock,
  })
  openNodes.push(worker)
  return worker
}

/** Enrolls a joining key, which is the only step that MINTS a node id. */
async function enroll(controller: ControllerNode, joining: ReturnType<typeof aJoiningNode>): Promise<void> {
  const codes = new InMemoryEnrollmentCodeStore()
  const issued = await issueEnrollmentCode({ meshId: MESH_ID, issuedBy: "operator", now: Date.parse(at(0)) }, codes)
  expect(issued.ok).toBe(true)
  if (!issued.ok) return
  // The code travels as a HASH and the request carries only the hash, so no path in
  // this flow puts a redeemable credential into an envelope. The hash is the STORE's
  // own `codeHash`, not a digest this test made up: a fixture that derived its own
  // hash would not be exercising the same function the store verifies.
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
  expect(decision.outcome).toBe("accepted")
  // The controller minted the id from the CODE HASH, and it is not the provisional
  // name the node asked to be called — which is the whole point of deriving it.
  expect(decision.nodeId).not.toBe(PENDING_NODE)
  expect(decision.nodeId).toMatch(/^node-enr-[0-9a-f]{24}$/)
  expect(decision.nodeKeyId).toBe(joining.keyPair.keyId)
  // The controller now trusts and pins the EXACT key submitted, which is the only way
  // a later request can be attributed to this node at all, and which is why a second
  // enrollment presenting the same code with a different key would be refused.
  await controller.identity.trust.enroll({
    nodeId: decision.nodeId,
    meshId: MESH_ID,
    nodeKeyId: joining.keyPair.keyId,
    enrolledAt: Date.parse(at(1)),
    displayName: "worker-1",
  })
  await controller.identity.pins.pin({
    nodeId: decision.nodeId,
    meshId: MESH_ID,
    key: { nodeKeyId: joining.keyPair.keyId, publicKey: joining.keyPair.publicKey, fingerprint: joining.keyPair.fingerprint },
    enrollmentId: decision.enrollmentId,
    now: Date.parse(at(1)),
  })
  // And the node is ADDRESSABLE, which is a separate write and a separate fact: §4.2
  // says an accepted enrollment RESPONSE is the only path that makes a node a row.
  // Trust without a registry row is a node that can authenticate and cannot be
  // scheduled, heartbeat, or found by anything that reads the mesh.
  const registered = await MeshNodeRegistry.enroll(controller.registryStore, {
    meshId: MESH_ID,
    nodeId: decision.nodeId,
    nodeKeyId: joining.keyPair.keyId,
    displayName: "worker-1",
    enrolledAt: Date.parse(at(1)),
  })
  expect(registered.ok && registered.value.created).toBe(true)
}

/** A lease the controller claims and the worker is then told about, over the wire. */
async function deliverALease(controller: ControllerNode, worker: WorkerNode): Promise<void> {
  const envelope = leaseEnvelope({ operation: "claim", recipientNodeId: worker.identity.nodeId })
  const claimed = await controller.lease.claim(envelope)
  expect(claimed.outcome).toBe("accepted")
  // Delivered to the worker, which does not claim a lease: it is TOLD which controller
  // drives the run, and its gate compares every command's epoch against that record. A
  // worker that invented its own lease would be a second authority, which is the split
  // brain M4.4 exists to prevent.
  const delivered = await post(worker.baseUrl, "/v1/mesh/lease", controller.client, envelope)
  expect(delivered.status).toBe(200)
  const result = delivered.json.result as { outcome: string }
  expect(result.outcome).toBe("accepted")
}

describe("two nodes, one run, over real sockets", () => {
  it("enrolls, heartbeats, leases, dispatches, ingests, streams, and resumes", async () => {
    const mesh = await aMesh()
    const { controller, clock } = mesh
    const worker = await joinedNode(mesh)

    // 1. ENROLL. The worker presents a code HASH and the controller pins the exact key
    // it submitted, which is §4.1's invariant: a later request presenting the same code
    // with a different key is refused, because the pin is the authority and the code
    // is only the credential.
    const registered = await controller.registry.node(worker.identity.nodeId)
    expect(registered.ok && registered.value?.node.nodeId).toBe(worker.identity.nodeId)

    // 2. HEARTBEAT. A CLAIM about itself, and liveness is derived against the injected
    // clock. At T0+1 the node is live; at T0+91s it is not, and the difference is
    // arithmetic rather than a sleep.
    // The shared clock moves with the node: a heartbeat that claims to have been
    // observed a second in the FUTURE is a node whose clock is ahead, and the registry
    // refuses it rather than storing a liveness derived from a future instant.
    clock.set(Date.parse(at(1)))
    const beat = await post(controller.baseUrl, "/v1/mesh/heartbeat", worker.client, heartbeatEnvelope({ nodeId: worker.identity.nodeId, sequence: 1, observedAt: at(1) }))
    expect(beat.status).toBe(200)
    expect((beat.json.result as { outcome: string }).outcome).toBe("accepted")
    const liveAtOne = await controller.registry.node(worker.identity.nodeId)
    expect(liveAtOne.ok && liveAtOne.value?.liveness).toBe("live")
    clock.set(Date.parse(at(91_000)))
    const staleAtNinetyOne = await controller.registry.node(worker.identity.nodeId)
    expect(staleAtNinetyOne.ok && staleAtNinetyOne.value?.liveness).not.toBe("live")

    // 3. LEASE. Claimed by the controller, delivered to the worker. The epoch is the
    // only thing that orders controllers, and it moved exactly once.
    clock.set(Date.parse(at(0)))
    await deliverALease(controller, worker)
    const held = await worker.lease.heldLease({ projectId: PROJECT, runId: RUN })
    expect(held.ok && held.value?.controllerNodeId).toBe(CONTROLLER)
    expect(held.ok && held.value?.epoch).toBe(1)

    // 4. DISPATCH. A real `mesh.command`, signed by the controller, admitted by the
    // worker's inbox through M4.4's gate and M4.5's recorded-log authorization. The
    // ack is emitted only after the row is durable, which is why the runtime below
    // finds it.
    const command = commandEnvelope({ recipientNodeId: worker.identity.nodeId, issuedAt: at(1), expiresAt: at(DURATION_SECONDS) })
    const dispatched = await post(worker.baseUrl, "/v1/mesh/command", controller.client, command)
    expect(dispatched.status).toBe(200)
    const admitted = dispatched.json.result as { outcome: string; acceptedSequence: number; stage?: string; error?: { code: string; message: string } }
    if (admitted.outcome !== "accepted") console.error("DISPATCH", JSON.stringify(admitted))
    expect(admitted.outcome).toBe("accepted")
    expect(admitted.acceptedSequence).toBe(1)

    const runtime = await post(worker.baseUrl, "/v1/runtime/execute", controller.client, { commandId: "cmd-mesh-pause-1" })
    expect(runtime.json.launched).toBe(true)
    expect(worker.launched).toEqual(["cmd-mesh-pause-1"])

    // A redelivery of the SAME command converges onto the stored row. This is the
    // plan's "duplicate/reordered commands converge without duplicate sessions" and it
    // is checked here because at-least-once delivery is the normal case, not the
    // pathological one.
    const redelivered = await post(worker.baseUrl, "/v1/mesh/command", controller.client, command)
    expect((redelivered.json.result as { outcome: string }).outcome).toBe("duplicate")
    expect(worker.launched).toHaveLength(1)

    // 5. INGEST. The worker reports a `dispatch.started`; the controller publishes it
    // to the stream AND drives the projection updater from the same event, which is
    // what makes the snapshot fallback a state computed from the events the client
    // missed rather than a second source of truth.
    for (const localSequence of [1, 2, 3]) {
      const ingested = await post(controller.baseUrl, "/v1/mesh/event", worker.client, eventEnvelope({ sourceNodeId: worker.identity.nodeId, localSequence }))
      expect(ingested.status).toBe(200)
      const published = ingested.json.published as { ok: boolean; outcome?: { accepted: boolean } }
      expect(published.ok).toBe(true)
      expect(published.outcome?.accepted).toBe(true)
    }
    expect(controller.gateway.head()).toBe(3)
    expect(controller.engine.getProjection(RUN)?.lastAppliedSequence).toBe(3)

    // 6. STREAM. Over a real socket, with the worker's real signature.
    const streamUrl = `/v1/mesh/events?projectId=${PROJECT}&runId=${RUN}&cursor=0`
    const streamed = await get(controller.baseUrl, streamUrl, worker.client)
    expect(streamed.status).toBe(200)
    const frames = decodeFrames(streamed.text)
    expect(frames).toHaveLength(3)
    // The `id` is the GATEWAY's position. The kernel's run sequences here are 1, 2, 3
    // and the mesh's per-source sequence is 1, 2, 3 as well, so the property is
    // asserted below against a run whose two sequences disagree.
    expect(frames.map((frame) => frame.id)).toEqual(["1", "2", "3"])
    expect(frames.every((frame) => frame.event === "mesh.event")).toBe(true)

    // 7. RESUME AFTER A DISCONNECT. The client's last `id` is 2, and it gets
    // STRICTLY later entries only: an SSE client has no dedupe of its own, so a
    // re-delivery would be a second thing that happened.
    const resumeUrl = `/v1/mesh/events?projectId=${PROJECT}&runId=${RUN}&cursor=2`
    const resumed = await get(controller.baseUrl, resumeUrl, worker.client, { "last-event-id": "2" })
    expect(resumed.status).toBe(200)
    const resumedFrames = decodeFrames(resumed.text)
    expect(resumedFrames.map((frame) => frame.id)).toEqual(["3"])

    // And the header form a conforming SSE client sends automatically agrees with the
    // query form, because `Last-Event-ID` is the whole cursor contract.
    const byHeader = await get(controller.baseUrl, `/v1/mesh/events?projectId=${PROJECT}&runId=${RUN}`, worker.client, { "last-event-id": "2" })
    expect(decodeFrames(byHeader.text).map((frame) => frame.id)).toEqual(["3"])
  })

  it("a node that cannot sign gets NOTHING, including the stream", async () => {
    const mesh = await aMesh()
    const { controller } = mesh
    const worker = await joinedNode(mesh)
    const url = `/v1/mesh/events?projectId=${PROJECT}&runId=${RUN}&cursor=0`

    // A request with the shared bridge bearer token and no node signature. The bearer
    // is not an alternative on a mesh route: it is not per-node (so revoking one node
    // means rotating it for every node) and it is not a SIGNATURE (so any hop that can
    // see the header can replay it forever, with nothing bound to method, path or
    // body). Tailscale reachability is not authentication.
    const bearerOnly = await fetch(`${controller.baseUrl}${url}`, {
      method: "GET",
      headers: { authorization: "Bearer shared-secret" },
    })
    expect(bearerOnly.status).toBe(401)
    expect(await bearerOnly.text()).not.toContain("event: ")

    // A FORGED signature over an otherwise well-formed request: every header present,
    // a fresh nonce, and bytes the pinned key did not sign.
    const signature = signMeshRequest(worker.identity.keyPair, {
      method: "GET",
      path: url,
      bodyDigest: meshBodyDigest(null),
      timestamp: Date.parse(at(0)),
      nonce: randomBytes(32).toString("base64url"),
      nodeId: worker.identity.nodeId,
      keyId: worker.identity.keyPair.keyId,
    })
    const forged = await fetch(`${controller.baseUrl}${url}`, {
      method: "GET",
      headers: {
        [MESH_IDENTITY_HEADERS.nodeId]: worker.identity.nodeId,
        [MESH_IDENTITY_HEADERS.keyId]: worker.identity.keyPair.keyId,
        [MESH_IDENTITY_HEADERS.timestamp]: String(Date.parse(at(0))),
        [MESH_IDENTITY_HEADERS.nonce]: signature.nonce,
        [MESH_IDENTITY_HEADERS.signature]: randomBytes(64).toString("base64url"),
        [MESH_IDENTITY_HEADERS.bodyDigest]: meshBodyDigest(null),
      },
    })
    expect(forged.status).toBe(401)
    // The refusal echoes nothing that was sent, which is also why a failing gateway
    // log line can be pasted into a ticket.
    const body = await forged.text()
    expect(body).not.toContain(signature.signature)
    expect(body).not.toContain(worker.identity.keyPair.publicKey)
  })

  it("the stream is a total order the client's own sequences cannot produce", async () => {
    const mesh = await aMesh()
    const { controller } = mesh
    const worker = await joinedNode(mesh)
    // Three events whose per-SOURCE sequence runs 1, 2, 3 and whose kernel RUN
    // sequence runs 40, 41, 42. The gateway's positions are 1, 2, 3, which agrees with
    // neither — and a client resuming on the kernel's number would skip every event,
    // while one resuming on the source's number would replay nothing.
    for (const localSequence of [1, 2, 3]) {
      const ingested = await post(
        controller.baseUrl,
        "/v1/mesh/event",
        worker.client,
        eventEnvelope({ sourceNodeId: worker.identity.nodeId, localSequence, runSequence: 39 + localSequence }),
      )
      expect((ingested.json.published as { ok: boolean }).ok).toBe(true)
    }
    const url = `/v1/mesh/events?projectId=${PROJECT}&runId=${RUN}&cursor=0`
    const streamed = await get(controller.baseUrl, url, worker.client)
    const frames = decodeFrames(streamed.text)
    expect(frames.map((frame) => frame.id)).toEqual(["1", "2", "3"])
    // The kernel's own sequences are visible INSIDE the frames, so a reader can see the
    // two orderings disagree rather than having to take it on trust.
    expect(frames.map((frame) => (frame.data as { event: { sequence: number } }).event.sequence)).toEqual([40, 41, 42])

    // A cursor the gateway never produced is REFUSED, not answered with the head. That
    // is the one false answer that hides the fault: a client reading a different
    // stream would be told it is current.
    const ahead = await get(controller.baseUrl, `/v1/mesh/events?projectId=${PROJECT}&runId=${RUN}&cursor=99`, worker.client)
    expect(ahead.status).toBe(409)
    expect(ahead.text).not.toContain("event: ")
  })

  it("a redelivered event converges, and a GAP is refused rather than skipped", async () => {
    const mesh = await aMesh()
    const { controller } = mesh
    const worker = await joinedNode(mesh)

    const first = eventEnvelope({ sourceNodeId: worker.identity.nodeId, localSequence: 1 })
    expect(((await post(controller.baseUrl, "/v1/mesh/event", worker.client, first)).json.published as { ok: boolean }).ok).toBe(true)
    // The same event again: at-least-once delivery is the normal shape of a mesh, and
    // the stream must not grow a second entry for it.
    const again = await post(controller.baseUrl, "/v1/mesh/event", worker.client, first)
    const suppressed = again.json.published as { ok: boolean; outcome: { accepted: boolean; disposition?: string } }
    expect(suppressed.outcome.accepted).toBe(false)
    expect(suppressed.outcome.disposition).toBe("duplicate")
    expect(controller.gateway.head()).toBe(1)

    // A hole: 3 arrives with 2 unseen. A projection built across a missing
    // `dispatch.started` reports a running session as un-run, and the remedy an
    // operator reaches for — retry — is the duplicate this mesh exists to prevent.
    const gap = await post(controller.baseUrl, "/v1/mesh/event", worker.client, eventEnvelope({ sourceNodeId: worker.identity.nodeId, localSequence: 3 }))
    const refused = gap.json.published as { ok: boolean; outcome: { accepted: boolean; disposition?: string; error?: { code: string } } }
    expect(refused.outcome.accepted).toBe(false)
    expect(refused.outcome.disposition).toBe("gap")
    expect(refused.outcome.error?.code).toBe("mesh.event_sequence_gap")
    expect(controller.gateway.head()).toBe(1)

    // The missing event then fits, and the hole closes with no operator action.
    const filler = await post(controller.baseUrl, "/v1/mesh/event", worker.client, eventEnvelope({ sourceNodeId: worker.identity.nodeId, localSequence: 2 }))
    expect(((filler.json.published as { outcome: { accepted: boolean } }).outcome.accepted)).toBe(true)
  })

  it("a cursor that has aged out of retention gets an EXPLICIT re-base, never a silent gap", async () => {
    const mesh = await aMesh()
    const { controller, clock } = mesh
    const worker = await joinedNode(mesh)
    for (const localSequence of [1, 2, 3]) {
      await post(controller.baseUrl, "/v1/mesh/event", worker.client, eventEnvelope({ sourceNodeId: worker.identity.nodeId, localSequence }))
    }

    // Sixteen minutes of the shared clock, which is past the retention AGE bound. The
    // client's cursor is 1 and the gateway holds nothing from before it.
    clock.advance(16 * 60_000)
    const url = `/v1/mesh/events?projectId=${PROJECT}&runId=${RUN}&cursor=1`
    const stale = await get(controller.baseUrl, url, worker.client)
    expect(stale.status).toBe(200)
    const frames = decodeFrames(stale.text)

    // THE contract. One frame, on a name the client is required to recognise, with no
    // `id:` — and no `mesh.event` frame anywhere in the response for it to apply over a
    // state it never received the intervening events for.
    expect(frames).toHaveLength(1)
    expect(frames[0]?.event).toBe(SSE_SNAPSHOT_EVENT_NAME)
    expect(frames[0]?.id).toBeNull()

    // The payload is the protocol's `snapshotFallback` plus the state it digests to,
    // and the client can CHECK it: the state is the projection the updater computed
    // from the very events the client missed.
    const payload = frames[0]?.data as { snapshotFallback: { runId: string; lastAppliedSequence: number; stateDigest: string }; state: { lastAppliedSequence: number; stateDigest: string } }
    expect(payload.snapshotFallback.runId).toBe(RUN)
    expect(payload.snapshotFallback.lastAppliedSequence).toBe(3)
    expect(payload.state.lastAppliedSequence).toBe(3)
    expect(payload.snapshotFallback.stateDigest).toBe(payload.state.stateDigest)
  })

  it("a request for one run is not a request for another", async () => {
    const mesh = await aMesh()
    const { controller } = mesh
    const worker = await joinedNode(mesh)
    await post(controller.baseUrl, "/v1/mesh/event", worker.client, eventEnvelope({ sourceNodeId: worker.identity.nodeId, localSequence: 1 }))

    // A signature minted for `runId=run-release-1` must not travel to
    // `runId=run-release-2`. The signing string covers the query, which is what stops
    // a run-scoped capability from being a mesh-wide one.
    const scopedUrl = `/v1/mesh/events?projectId=${PROJECT}&runId=${RUN}&cursor=0`
    const otherUrl = `/v1/mesh/events?projectId=${PROJECT}&runId=run-release-2&cursor=0`
    const signedForOne = worker.client.headers("GET", scopedUrl, null)
    const lifted = await fetch(`${controller.baseUrl}${otherUrl}`, { method: "GET", headers: { ...signedForOne, "last-event-id": "0" } })
    expect(lifted.status).toBe(401)

    // And a scope the client does not name is a 400 rather than a read against
    // whatever the gateway happened to retain.
    const unscoped = await get(controller.baseUrl, "/v1/mesh/events", worker.client)
    expect(unscoped.status).toBe(400)
  })

  it("reconciliation over the wire marks a difference and adopts nothing", async () => {
    const mesh = await aMesh()
    const { controller, clock } = mesh
    const worker = await joinedNode(mesh)
    await deliverALease(controller, worker)

    // The worker reports a session the controller's projections know nothing about,
    // because the controller never recorded the dispatch that produced it. That is
    // the shape a partition leaves behind, and the shape a bug leaves behind; the two
    // are not distinguishable from here, so the answer is to MARK it.
    const request = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      recordType: "mesh.reconciliation.request",
      messageId: "msg-rec-1",
      correlationId: "rec-mesh-1",
      causation: null,
      senderNodeId: CONTROLLER,
      recipientNodeId: worker.identity.nodeId,
      protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
      issuedAt: at(1),
      expiresAt: at(3600),
      payload: {
        reconcileId: "rec-mesh-1",
        projectId: PROJECT,
        runId: RUN,
        controllerNodeId: CONTROLLER,
        controllerEpoch: 1,
        peerNodeId: worker.identity.nodeId,
        peerProtocolVersions: [CURRENT_MESH_PROTOCOL_VERSION],
        controllerLastAcknowledgedInboxSequence: 1,
        controllerLastAcknowledgedOutboxSequence: 0,
        observedAt: at(1),
        activeSessionInventory: [{ sessionId: "sess-orphan", dispatchId: "dispatch-unknown", startedAt: at(0) }],
      },
    }
    const reconciled = await post(controller.baseUrl, "/v1/mesh/reconciliation", worker.client, request)
    expect(reconciled.status).toBe(200)
    const outcome = reconciled.json.result as {
      ok: boolean
      steps: { step: number; state: string }[]
      unreconciledNodeIds: string[]
      response: { outcome: string; unreconciled: { reason: string; detail: string }[] }
    }
    expect(outcome.ok).toBe(true)
    expect(outcome.steps.map((step) => step.step)).toEqual([1, 2, 3, 4, 5, 6])
    expect(outcome.response.outcome).toBe("degraded")
    expect(outcome.response.unreconciled[0]?.reason).toBe("session_not_in_projection")
    // Nothing was adopted and nothing was terminated, and the ONLY thing that happened
    // is that the node was marked for a human — which is what a later takeover's
    // user-inspection precondition is evaluated against.
    expect(outcome.unreconciledNodeIds).toEqual([worker.identity.nodeId])
    expect(outcome.response.unreconciled[0]?.detail).toContain("marks it for review and does not resolve it")
    expect(controller.unreconciled.source.unreconciledNodeIds({ projectId: PROJECT, runId: RUN })).toEqual([worker.identity.nodeId])
  })
})

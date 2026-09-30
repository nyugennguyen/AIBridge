/**
 * M4.6 — the SSE route.
 *
 * This is the only file in the milestone that needs a request, and it is here for
 * the four properties that a pure function cannot demonstrate:
 *
 *   1. **Authentication runs before ANY byte is written.** A gateway that verified
 *      the signature and then streamed anyway would pass every test of the pure
 *      functions, so the assertion that matters is the handler never running and the
 *      response never being a stream.
 *   2. **A refusal is a status code and a JSON body, never an SSE stream.** A
 *      conforming client branches on `event:`, so an error delivered as a frame is a
 *      client that believes it is subscribed.
 *   3. **The re-base frame comes FIRST, with no `id:`.** The absence of the id is
 *      what stops the client recording a position it did not reach.
 *   4. **The scope is read from the query and PARSED.** An unparseable scope is a
 *      400 rather than a read keyed on whatever the caller typed.
 *
 * The route is the one module allowed to touch the framework in this directory, so
 * these are also the only assertions that would catch it having grown an
 * authentication shortcut.
 */
import { describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import { randomBytes } from "node:crypto"
import {
  MESH_IDENTITY_HEADERS,
  MeshIdentityProvider,
  InMemoryNodeTrustStore,
  InMemoryPeerKeyPinStore,
  InMemoryNonceGuard,
  type IdentityProvider,
} from "../../../../../src/mesh/identity/index.js"
import { NodeKeyPair, meshBodyDigest, signMeshRequest } from "../../../../../src/mesh/identity/index.js"
import {
  MESH_EVENT_STREAM_PATH,
  MeshEventGateway,
  ProjectionSnapshotFallback,
  SSE_SNAPSHOT_EVENT_NAME,
  decodeFrames,
  registerEventStreamRoute,
  scopeFromQuery,
  type EventStreamGateway,
} from "../../../../../src/mesh/gateway/events/index.js"
import { meshIdSchema } from "../../../../../src/orchestration/identifiers.js"
import { SqliteEventStore } from "../../../../../src/orchestration/event-store/event-store.js"
import { ProjectionEngine } from "../../../../../src/orchestration/projections/projection-engine.js"
import { MeshProjectionUpdater } from "../../../../../src/mesh/gateway/events/projection-updater.js"
import { PROJECT, RUN, TestClock, WORKER, aMeshEvent, aStoredEvent, at, eventEnvelope, iso } from "../fixtures.js"

const MESH_ID = meshIdSchema.parse("mesh-release")
const PEER = "node-controller-1"

/** An enrolled, pinned node, and a client that signs for it. Every time is literal. */
async function aSeam() {
  const trust = new InMemoryNodeTrustStore()
  const pins = new InMemoryPeerKeyPinStore()
  const keyPair = NodeKeyPair.generate()
  await trust.enroll({ nodeId: WORKER, meshId: MESH_ID, nodeKeyId: keyPair.keyId, enrolledAt: at(0), displayName: "worker" })
  await pins.pin({
    nodeId: WORKER,
    meshId: MESH_ID,
    key: { nodeKeyId: keyPair.keyId, publicKey: keyPair.publicKey, fingerprint: keyPair.fingerprint },
    enrollmentId: "enr-1",
    now: at(1),
  })
  const provider: IdentityProvider = new MeshIdentityProvider({
    trust,
    pins,
    replayGuard: new InMemoryNonceGuard(),
    now: () => at(5),
  })
  return { provider, keyPair }
}

/**
 * Headers a `keyPair` signs.
 *
 * The signature covers the FULL request target including the query string, which is
 * the security-relevant part: `?projectId=` and `?runId=` select what work the
 * stream is scoped to, so a "pathname only" spelling would make a signature for one
 * run valid for another.
 */
function signedHeaders(keyPair: NodeKeyPair, url: string, overrides: { signature?: string } = {}) {
  const signature = signMeshRequest(keyPair, {
    method: "GET",
    path: url,
    bodyDigest: meshBodyDigest(null),
    timestamp: at(5),
    nonce: randomBytes(32).toString("base64url"),
    nodeId: WORKER,
    keyId: keyPair.keyId,
  })
  return {
    [MESH_IDENTITY_HEADERS.nodeId]: WORKER,
    [MESH_IDENTITY_HEADERS.keyId]: keyPair.keyId,
    [MESH_IDENTITY_HEADERS.timestamp]: String(at(5)),
    [MESH_IDENTITY_HEADERS.nonce]: signature.nonce,
    [MESH_IDENTITY_HEADERS.signature]: overrides.signature ?? signature.signature,
    [MESH_IDENTITY_HEADERS.bodyDigest]: meshBodyDigest(null),
  }
}

interface Harness {
  readonly app: FastifyInstance
  readonly gateway: EventStreamGateway
  readonly clock: TestClock
  /** The key the route's identity provider actually trusts. */
  readonly keyPair: NodeKeyPair
  publish(event: Parameters<typeof aMeshEvent>[0]): Promise<void>
  close(): Promise<void>
}

async function aRouteHarness(options: { readonly snapshots?: boolean; readonly maxEvents?: number } = {}): Promise<Harness> {
  const { provider, keyPair } = await aSeam()
  const clock = new TestClock()
  const store = SqliteEventStore.createInMemory()
  const engine = new ProjectionEngine(store)
  const updater = new MeshProjectionUpdater({ engine, snapshots: store, now: clock.now })
  const gateway = new MeshEventGateway({
    now: clock.now,
    ...(options.maxEvents === undefined ? {} : { retentionMaxEvents: options.maxEvents }),
    ...(options.snapshots === true ? { snapshots: new ProjectionSnapshotFallback(store) } : {}),
  })
  const app = Fastify()
  registerEventStreamRoute(app, {
    gateway,
    identity: { provider, expectedNodeId: WORKER, expectedMeshId: MESH_ID },
    scopeOf: scopeFromQuery,
  })
  return {
    app,
    gateway,
    clock,
    keyPair,
    publish: async (event) => {
      const result = await gateway.publish(eventEnvelope(aMeshEvent(event)))
      if (!result.ok) throw new Error(`publish refused: ${result.error.code}`)
      if (result.outcome.accepted) {
        updater.apply(aStoredEvent(aMeshEvent(event)))
      }
    },
    close: () => app.close(),
  }
}

const SCOPED_URL = `${MESH_EVENT_STREAM_PATH}?projectId=${PROJECT}&runId=${RUN}`

describe("the stream is authenticated before anything streams", () => {
  it("an unsigned request is refused and the body is NOT an event stream", async () => {
    const harness = await aRouteHarness()
    const response = await harness.app.inject({ method: "GET", url: SCOPED_URL })
    await harness.close()

    // THE assertion a pure-function test cannot make. A `preHandler` that refused and
    // then called `done()` anyway would leave every other test in this milestone
    // green, because they have no handler to check.
    expect(response.statusCode).toBe(401)
    expect(response.headers["content-type"]).toContain("application/json")
    expect(response.body).not.toContain("event: ")
    expect(response.body).toContain("identity.header_missing")
  })

  it("a forged signature is refused, and the reply echoes nothing that was sent", async () => {
    const harness = await aRouteHarness()
    const { keyPair } = harness
    const response = await harness.app.inject({
      method: "GET",
      url: SCOPED_URL,
      headers: signedHeaders(keyPair, SCOPED_URL, { signature: randomBytes(64).toString("base64url") }),
    })
    await harness.close()
    expect(response.statusCode).toBe(401)
    // A forged request gets a refusal containing nothing of what it sent, which is
    // also why a failing gateway log line can be pasted into a ticket.
    expect(response.body).not.toContain(keyPair.publicKey)
    expect(response.body).not.toContain(MESH_IDENTITY_HEADERS.signature)
  })

  it("the bridge's shared BEARER token is not an alternative on a mesh route", async () => {
    const harness = await aRouteHarness()
    const response = await harness.app.inject({ method: "GET", url: SCOPED_URL, headers: { authorization: "Bearer shared-secret" } })
    await harness.close()
    // Not merely "unauthenticated": the route must have no branch that consults it.
    // A bearer is not per-node (so revoking one node means rotating it for every
    // node) and it is not a SIGNATURE (so any hop that can see the header can replay
    // it forever, on any route, with nothing bound to method, path or body).
    expect(response.statusCode).toBe(401)
  })

  it("a genuinely signed request is served, and the stream carries the gateway's positions", async () => {
    const harness = await aRouteHarness()
    const { keyPair } = harness
    await harness.publish({ eventId: "evt-route-1", localSequence: 1, runSequence: 1 })
    await harness.publish({ eventId: "evt-route-2", localSequence: 2, runSequence: 2 })
    const response = await harness.app.inject({ method: "GET", url: `${SCOPED_URL}&cursor=0`, headers: signedHeaders(keyPair, `${SCOPED_URL}&cursor=0`) })
    await harness.close()

    expect(response.statusCode).toBe(200)
    expect(response.headers["content-type"]).toContain("text/event-stream")
    // A proxy that buffers would turn "notified as events happen" into "delivered
    // whenever the buffer fills", which for a low-traffic stream is forever.
    expect(response.headers["x-accel-buffering"]).toBe("no")
    const frames = decodeFrames(response.body)
    expect(frames.map((frame) => frame.id)).toEqual(["1", "2"])
    expect(frames.every((frame) => frame.event === "mesh.event")).toBe(true)
  })
})

describe("a refusal is a status code, never a stream", () => {
  it("a malformed cursor is a 400 with a JSON body", async () => {
    const harness = await aRouteHarness()
    const { keyPair } = harness
    const url = `${SCOPED_URL}&cursor=not-a-number`
    const response = await harness.app.inject({ method: "GET", url, headers: signedHeaders(keyPair, url) })
    await harness.close()

    expect(response.statusCode).toBe(400)
    expect(response.headers["content-type"]).toContain("application/json")
    expect(response.body).not.toContain("event: ")
    expect(JSON.parse(response.body).error.code).toBe("mesh.stream_cursor_malformed")
  })

  it("a missing scope is a 400, and the message says why the scope is required", async () => {
    const harness = await aRouteHarness()
    const { keyPair } = harness
    const url = `${MESH_EVENT_STREAM_PATH}?projectId=${PROJECT}`
    const response = await harness.app.inject({ method: "GET", url, headers: signedHeaders(keyPair, url) })
    await harness.close()
    expect(response.statusCode).toBe(400)
    // The reason a scope is MANDATORY rather than optional is a security property: a
    // scope read out of whatever the gateway happened to retain would answer a
    // question about run B with run A's state. A message that did not carry it would
    // let a future author "helpfully" make the scope optional.
    expect(response.body).toContain("could be answered with another run's state")
    expect(response.body).toContain("'runId'")
  })

  it("an unparseable scope is a 400, not a read keyed on whatever the caller typed", async () => {
    const harness = await aRouteHarness()
    const { keyPair } = harness
    const url = `${MESH_EVENT_STREAM_PATH}?projectId=not%20a%20project%20id&runId=${RUN}`
    const response = await harness.app.inject({ method: "GET", url, headers: signedHeaders(keyPair, url) })
    await harness.close()
    expect(response.statusCode).toBe(400)
    expect(JSON.parse(response.body).error.code).toBe("mesh.stream_scope_required")
  })

  it("a cursor this gateway cannot honour is a 409, not a 200 with a page", async () => {
    const harness = await aRouteHarness({ maxEvents: 2 })
    const { keyPair } = harness
    for (let index = 1; index <= 6; index += 1) {
      await harness.publish({ eventId: `evt-evict-${index}`, localSequence: index, runSequence: index })
    }
    const url = `${SCOPED_URL}&cursor=1`
    const response = await harness.app.inject({ method: "GET", url, headers: signedHeaders(keyPair, url) })
    await harness.close()

    // 409 and not 400: the request was well formed and the answer conflicted with
    // what this gateway holds. A 400 would tell an operator the request was malformed
    // when the request was fine and the answer was no.
    expect(response.statusCode).toBe(409)
    expect(response.headers["content-type"]).toContain("application/json")
    expect(response.body).not.toContain("event: ")
  })
})

describe("the re-base frame is first, and it is not an event", () => {
  it("a client whose cursor aged out receives a re-base and NOTHING else", async () => {
    // The end-to-end shape of M4-S, over a real request. The client asked for a
    // continuation, could not have one, and is told so on a name it is required to
    // recognise — with no `mesh.event` frame anywhere in the response for it to apply
    // over a state it never received the intervening events for.
    const harness = await aRouteHarness({ snapshots: true, maxEvents: 2 })
    const { keyPair } = harness
    for (let index = 1; index <= 5; index += 1) {
      await harness.publish({ eventId: `evt-rebase-${index}`, localSequence: index, runSequence: index })
    }
    const url = `${SCOPED_URL}&cursor=1`
    const response = await harness.app.inject({ method: "GET", url, headers: signedHeaders(keyPair, url) })
    await harness.close()

    expect(response.statusCode).toBe(200)
    const frames = decodeFrames(response.body)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.event).toBe(SSE_SNAPSHOT_EVENT_NAME)
    // No `id:` — the client is not told it consumed up to a position.
    expect(frames[0]?.id).toBeNull()
    // And the payload is the protocol's `snapshotFallback` plus the state it digests
    // to, which is what makes the re-base checkable rather than a promise.
    const payload = frames[0]?.data as { snapshotFallback: { runId: string; lastAppliedSequence: number; stateDigest: string }; state: Record<string, unknown> }
    expect(payload.snapshotFallback.runId).toBe(RUN)
    expect(payload.snapshotFallback.lastAppliedSequence).toBe(5)
    expect(payload.snapshotFallback.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(payload.state).toBeDefined()
  })

  it("a node with NO snapshot refuses rather than serving the head", async () => {
    // The other half of the contract, and the one with no test elsewhere: the route
    // must not degrade into a 200 with a page. A client that received a page here
    // would be applying later events over a state it never received the intervening
    // ones for, with nothing on the wire reporting it.
    const harness = await aRouteHarness({ maxEvents: 2 })
    const { keyPair } = harness
    for (let index = 1; index <= 5; index += 1) {
      await harness.publish({ eventId: `evt-nosnap-${index}`, localSequence: index, runSequence: index })
    }
    const url = `${SCOPED_URL}&cursor=1`
    const response = await harness.app.inject({ method: "GET", url, headers: signedHeaders(keyPair, url) })
    await harness.close()
    expect(response.statusCode).toBe(409)
    expect(response.body).not.toContain("event: ")
    expect(JSON.parse(response.body).error.message).toContain("NOT continued from the head")
  })

  it("the preamble tells the client the retry interval before anything can be missed", async () => {
    const harness = await aRouteHarness()
    const { keyPair } = harness
    const url = `${SCOPED_URL}&cursor=0`
    const response = await harness.app.inject({ method: "GET", url, headers: signedHeaders(keyPair, url) })
    await harness.close()
    expect(response.body.startsWith("retry: ")).toBe(true)
  })
})

describe("the scope is read from the query and parsed, never inferred", () => {
  it("accepts a well-formed pair", () => {
    const scope = scopeFromQuery({ projectId: PROJECT, runId: RUN })
    expect(scope.ok).toBe(true)
    if (!scope.ok) return
    expect(scope.value.projectId).toBe(PROJECT)
    expect(scope.value.runId).toBe(RUN)
  })

  it("refuses each half independently, naming WHICH parameter was wrong", () => {
    // Naming the parameter is the difference between a five-minute fix and an
    // afternoon, and a request that omitted one is the most likely thing a new client
    // sends.
    expect(scopeFromQuery({ runId: RUN }).ok).toBe(false)
    expect(scopeFromQuery({ projectId: PROJECT }).ok).toBe(false)
    expect(scopeFromQuery({}).ok).toBe(false)
    expect(scopeFromQuery(undefined).ok).toBe(false)
    const projectOnly = scopeFromQuery({ projectId: PROJECT })
    expect(projectOnly.ok).toBe(false)
    if (!projectOnly.ok) expect(projectOnly.error.message).toContain("'runId'")
  })

  it("a `Last-Event-ID` header resumes, and the query parameter is the explicit form", async () => {
    const harness = await aRouteHarness()
    const { keyPair } = harness
    for (let index = 1; index <= 3; index += 1) {
      await harness.publish({ eventId: `evt-header-${index}`, localSequence: index, runSequence: index })
    }
    // The header a conforming SSE client sends automatically.
    const withHeader = await harness.app.inject({
      method: "GET",
      url: SCOPED_URL,
      headers: { ...signedHeaders(keyPair, SCOPED_URL), "last-event-id": "1" },
    })
    expect(withHeader.statusCode).toBe(200)
    expect(decodeFrames(withHeader.body).map((frame) => frame.id)).toEqual(["2", "3"])
    await harness.close()
  })

  it("a signed request for one run is not a signed request for another", async () => {
    // The signature covers the query string, so `?runId=` selects what work the
    // stream is scoped to and a signature minted for one run does not travel to
    // another. A "pathname only" signing string would turn a run-scoped capability
    // into a mesh-wide one.
    const harness = await aRouteHarness()
    const { keyPair } = harness
    const otherUrl = `${MESH_EVENT_STREAM_PATH}?projectId=${PROJECT}&runId=run-release-2`
    const signedForOne = signedHeaders(keyPair, SCOPED_URL)
    const lifted = await harness.app.inject({ method: "GET", url: otherUrl, headers: signedForOne })
    await harness.close()
    expect(lifted.statusCode).toBe(401)
  })

  it("the timestamp is signed, so a captured request cannot be replayed forever", async () => {
    const harness = await aRouteHarness()
    const { keyPair } = harness
    const headers = signedHeaders(keyPair, SCOPED_URL)
    const first = await harness.app.inject({ method: "GET", url: SCOPED_URL, headers })
    const second = await harness.app.inject({ method: "GET", url: SCOPED_URL, headers })
    await harness.close()
    // The nonce guard is what makes the second attempt fail. `expiresAt` bounds
    // exposure; it does not provide idempotency, and this is the difference.
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(401)
  })

  it("the frame's `id` is the gateway's position, not the kernel's or the mesh's sequence", async () => {
    const harness = await aRouteHarness()
    const { keyPair } = harness
    await harness.publish({ eventId: "evt-axis-1", localSequence: 1, runSequence: 77 })
    const url = `${SCOPED_URL}&cursor=0`
    const response = await harness.app.inject({ method: "GET", url, headers: signedHeaders(keyPair, url) })
    await harness.close()
    const [frame] = decodeFrames(response.body)
    // The kernel's run sequence is 77 and the mesh's per-source sequence is 1. A
    // `Last-Event-ID` carrying either would not be resumable against the next
    // gateway position.
    expect(frame?.id).toBe("1")
    expect(iso(at(0))).toBe("2026-09-28T00:00:00.000Z")
  })
})

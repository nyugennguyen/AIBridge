/**
 * Two real nodes, on two real sockets, for the M4.6 integration gate.
 *
 * ### Why real sockets
 *
 * `app.inject()` exercises a handler without a socket, which is the right default
 * and the wrong tool for the thing being tested here. The plan's completion
 * criterion is "at least two nodes can enroll, advertise capabilities, and execute a
 * run", and a run executed through `inject` on two app objects is two objects in one
 * process. So both nodes here `listen` on an ephemeral port and every inter-node
 * record travels over `fetch` with a real ed25519 signature over the real request
 * target. A signature is a function of the bytes on the wire, and the two failures
 * this catches — a signing string that does not bind the query, and a header the
 * receiver does not actually read — are both invisible to an in-process call.
 *
 * ### What is REAL and what is a test seam
 *
 * Real: the identity keys, the trust and pin stores, the replay guard, the
 * enrollment code store, the node registry, the controller lease, the command inbox,
 * the event ingestor, the SSE gateway, the kernel's `SqliteEventStore` and the
 * projection reducer.
 *
 * Test seams, and each is named where it is built: the HTTP routes that expose
 * M4.2–M4.5's seams (those seams were built as libraries, not as routes, and adding
 * routes for them is not M4.6's deliverable), the runtime behind a dispatch — the
 * mesh is what is under test, not the agent — and the clock, which is injected
 * everywhere and never read from the wall.
 *
 * Nothing sleeps. Every instant is `T0` plus a number, moved by hand, because the
 * scenarios are "ninety-one seconds after the last heartbeat" and "a cursor that has
 * aged out", and a sleep turns both into a test that passes on a slow machine.
 */
import Fastify, { type FastifyInstance } from "fastify"
import { randomBytes } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { nodeKeyIdSchema } from "../../src/mesh/protocol/identifiers.js"
import type { MeshIdentityHookOptions } from "../../src/mesh/identity/middleware.js"
import type { MeshRequestSignature } from "../../src/mesh/identity/request-signature.js"
import { createContractError, type Result } from "../../src/orchestration/errors.js"
import { SqliteEventStore } from "../../src/orchestration/event-store/event-store.js"
import type { StoredRunEvent } from "../../src/orchestration/event-store/types.js"
import { ProjectionEngine } from "../../src/orchestration/projections/projection-engine.js"
import { MeshProjectionUpdater, ProjectionSnapshotFallback } from "../../src/mesh/gateway/events/index.js"
import { registerEventStreamRoute, scopeFromQuery } from "../../src/mesh/gateway/events/index.js"
import { MeshReconciler } from "../../src/mesh/gateway/reconcile/index.js"
import { MeshEventIngestor } from "../../src/mesh/outbox/ingest.js"
import { MeshEventGateway } from "../../src/mesh/gateway/events/gateway.js"
import {
  MESH_IDENTITY_HEADERS,
  MeshIdentityProvider,
  InMemoryEnrollmentCodeStore,
  InMemoryNodeTrustStore,
  InMemoryNonceGuard,
  InMemoryPeerKeyPinStore,
  NodeKeyPair,
  buildEnrollmentRequest,
  decideEnrollment,
  issueEnrollmentCode,
  meshBodyDigest,
  signMeshRequest,
} from "../../src/mesh/identity/index.js"
import { InMemoryCommandInboxStore, MeshCommandInbox } from "../../src/mesh/inbox/index.js"
import { InMemoryNodeRegistryStore, MeshNodeRegistry } from "../../src/mesh/registry/index.js"
import { InMemoryControllerLeaseStore, MeshControllerLease, createUnreconciledNodeSource } from "../../src/mesh/lease/index.js"
import { MeshCommandEpochGate } from "../../src/mesh/lease/index.js"
import type { RecordedCommandStateResolver } from "../../src/mesh/lease/types.js"
import { mintMeshEvent, type MeshEvent } from "../../src/mesh/protocol/event.js"
import { mintMeshCommand } from "../../src/mesh/protocol/command.js"
import { CURRENT_MESH_PROTOCOL_VERSION } from "../../src/mesh/protocol/negotiation.js"
import { safeParseMeshEnvelope } from "../../src/mesh/protocol/registry.js"
import type { MeshLease } from "../../src/mesh/protocol/lease.js"
import type { RecordedLogReader, RecordedApproval, RecordedDispatch, RecordedLease } from "../../src/mesh/inbox/authorization.js"
import {
  CURRENT_SCHEMA_VERSION,
  approvalIdSchema,
  commandIdSchema,
  correlationIdSchema,
  dispatchIdSchema,
  epochSchema,
  leaseIdSchema,
  meshIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  type ApprovalId,
  type CommandId,
  type DispatchId,
  type Epoch,
  type EventId,
  type LeaseId,
  type MeshId,
  type NodeId,
  type SessionId,
} from "../../src/orchestration/identifiers.js"
import { orchestrationEventSchema, sessionSchema } from "../../src/orchestration/schemas.js"
import { digestJson } from "../../src/orchestration/digest.js"
import { makeCommand } from "../unit/event-store/fixtures.js"
import { revisedSameDispatchId } from "../unit/orchestration/fixtures/recorded-events.js"

export const MESH_ID: MeshId = meshIdSchema.parse("mesh-release")
export const CONTROLLER: NodeId = nodeIdSchema.parse("node-controller-1")
/**
 * The sender a JOINING node uses before it has a node id.
 *
 * A branded placeholder, and casting a provisional id to a `NodeId` would type-check
 * while being a lie about what the two vocabularies mean: the provisional id is what
 * the node ASKS to be called, and the node id is what it IS. Passing the provisional id
 * under the node id's name is how a test ends up correlating an enrollment against an
 * id the controller never minted — and M4.2's envelope schema requires the field, so
 * something has to supply it.
 */
export const PENDING_NODE: NodeId = nodeIdSchema.parse("node-enr-pending")
export const SUCCESSOR: NodeId = nodeIdSchema.parse("node-controller-2")
export const PROJECT = projectIdSchema.parse("project-release")
export const RUN = runIdSchema.parse("run-release-1")
export const LEASE = leaseIdSchema.parse("lease-run-release-1")
export const EPOCH: Epoch = epochSchema.parse(1)
export const DURATION_SECONDS = 30

export const T0_MS = Date.parse("2026-09-28T00:00:00.000Z")

/** A clock every node shares, because they are on one mesh and one wall. */
export class MeshClock {
  #ms: number
  constructor(startMs: number = T0_MS) {
    this.#ms = startMs
  }
  now = (): number => this.#ms
  set(ms: number): void {
    this.#ms = ms
  }
  advance(ms: number): void {
    this.#ms += ms
  }
  iso = (): string => new Date(this.#ms).toISOString()
}

export function at(seconds: number): string {
  return new Date(T0_MS + seconds * 1000).toISOString()
}

// --- Wire plumbing --------------------------------------------------------

/** The identity half of one node: keys, trust, pins, replay, provider. */
export async function anIdentity(nodeId: NodeId) {
  const trust = new InMemoryNodeTrustStore()
  const pins = new InMemoryPeerKeyPinStore()
  const keyPair = NodeKeyPair.generate()
  const provider = new MeshIdentityProvider({
    trust,
    pins,
    replayGuard: new InMemoryNonceGuard(),
    now: () => T0_MS,
  })
  return { nodeId, trust, pins, keyPair, provider }
}

/**
 * A node that has generated a key but has NOT yet enrolled.
 *
 * Separate from {@link anIdentity} because enrollment DERIVES the node id from the
 * code hash: a joining node genuinely has no `NodeId` yet, which is exactly why
 * `buildEnrollmentRequest` takes a branded placeholder as the sender. A harness that
 * picked the worker's id up front and asserted on it would be asserting on a fact the
 * protocol derives rather than on the derivation.
 */
export function aJoiningNode() {
  return { keyPair: NodeKeyPair.generate() }
}

/**
 * The request context the worker's inbox authenticator reads.
 *
 * `AsyncLocalStorage` rather than a single slot on the harness, and the reason is
 * correctness under interleaving: the inbox's authenticator is a PORT that
 * `CommandInbox.submit` calls with the record alone, so the signature has to travel
 * beside it somehow, and one shared field would be read by whichever submission
 * happened to be in flight. A single slot would work only because the inbox
 * serializes submissions — a property this harness should not be relying on to be
 * right about a different thing.
 */
const requestContext = new AsyncLocalStorage<{ readonly signature: MeshRequestSignature }>()

/** Runs a submission with the request's signature in scope. */
export function withRequestSignature<T>(signature: MeshRequestSignature, run: () => T): T {
  return requestContext.run({ signature }, run)
}

/**
 * Lifts the signature headers into the shape M4.2's provider verifies.
 *
 * Lifting is not deciding, and the split is the point: this function reads the
 * `x-aibridge-mesh-*` headers and does nothing else — it never consults a trust
 * store, a pin or a revocation set. Every field is a header value, so a body field
 * can never be the thing that names the sender.
 */
function liftSignature(
  request: { readonly method: string; readonly headers: Record<string, unknown>; readonly url: string },
  node: { readonly keyPair: NodeKeyPair; readonly nodeId: NodeId },
): MeshRequestSignature | null {
  const header = (name: keyof typeof MESH_IDENTITY_HEADERS): string | undefined => {
    const value = request.headers[MESH_IDENTITY_HEADERS[name]]
    return typeof value === "string" ? value : undefined
  }
  const nodeId = header("nodeId")
  const keyId = header("keyId")
  const signature = header("signature")
  const timestamp = header("timestamp")
  const nonce = header("nonce")
  const bodyDigest = header("bodyDigest")
  if (nodeId === undefined || keyId === undefined || signature === undefined || timestamp === undefined || nonce === undefined || bodyDigest === undefined) {
    return null
  }
  return {
    method: request.method,
    path: request.url,
    bodyDigest,
    timestamp: Number(timestamp),
    nonce,
    signature,
    nodeId: nodeIdSchema.parse(nodeId),
    keyId: nodeKeyIdSchema.parse(keyId),
  }
}

function currentSignature(): MeshRequestSignature | undefined {
  return requestContext.getStore()?.signature
}

/** A signed client for a node, for a `method` + `url` on a named server. */
export function aClient(node: { readonly keyPair: NodeKeyPair; readonly nodeId: NodeId }) {
  return {
    headers(method: string, url: string, body: unknown): Record<string, string> {
      const signature = signMeshRequest(node.keyPair, {
        method,
        path: url,
        bodyDigest: meshBodyDigest(body),
        timestamp: T0_MS,
        // RANDOM, not a fixed constant: a deterministic nonce is fine when a test
        // signs one request and actively harmful when a test signs two and expects
        // them to differ, because the replay guard would refuse the second for a
        // reason that has nothing to do with the property under test.
        nonce: randomBytes(32).toString("base64url"),
        nodeId: node.nodeId,
        keyId: node.keyPair.keyId,
      })
      return {
        "content-type": "application/json",
        [MESH_IDENTITY_HEADERS.nodeId]: node.nodeId,
        [MESH_IDENTITY_HEADERS.keyId]: node.keyPair.keyId,
        [MESH_IDENTITY_HEADERS.timestamp]: String(T0_MS),
        [MESH_IDENTITY_HEADERS.nonce]: signature.nonce,
        [MESH_IDENTITY_HEADERS.signature]: signature.signature,
        [MESH_IDENTITY_HEADERS.bodyDigest]: meshBodyDigest(body),
      }
    },
  }
}

/** One HTTP call between two nodes: signed, with the body as the digest's subject. */
export async function post(baseUrl: string, url: string, client: ReturnType<typeof aClient>, body: unknown) {
  const response = await fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: client.headers("POST", url, body),
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

/** One GET between two nodes, signed over the FULL target including the query. */
export async function get(baseUrl: string, url: string, client: ReturnType<typeof aClient>, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${url}`, { method: "GET", headers: { ...client.headers("GET", url, null), ...headers } })
  return { status: response.status, text: await response.text(), headers: response.headers }
}

/** Starts a Fastify server on an ephemeral port and returns its base URL. */
export async function listen(app: FastifyInstance): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await app.listen({ port: 0, host: "127.0.0.1" })
  const address = app.server.address()
  if (address === null || typeof address === "string") throw new Error("the mesh node did not bind a TCP port")
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => app.close() }
}

// --- The controller node --------------------------------------------------

export interface ControllerNode {
  readonly identity: Awaited<ReturnType<typeof anIdentity>>
  readonly baseUrl: string
  readonly registry: MeshNodeRegistry
  readonly registryStore: InMemoryNodeRegistryStore
  readonly lease: MeshControllerLease
  readonly leaseStore: InMemoryControllerLeaseStore
  readonly unreconciled: ReturnType<typeof createUnreconciledNodeSource>
  readonly kernel: SqliteEventStore
  readonly engine: ProjectionEngine
  readonly updater: MeshProjectionUpdater
  readonly gateway: MeshEventGateway
  readonly ingestor: MeshEventIngestor
  readonly reconciler: MeshReconciler
  readonly client: ReturnType<typeof aClient>
  readonly clock: MeshClock
  /**
   * Tells the controller's route which node it is serving.
   *
   * Called once, after enrollment, and the indirection is the protocol's rather than a
   * convenience: a joining node has no id until the controller derives one from the
   * code hash, so the controller cannot be told at construction which peer its stream
   * is for. A harness that picked the id up front would be asserting on a fact the
   * controller is supposed to decide.
   */
  expectPeer(nodeId: NodeId): void
  close(): Promise<void>
}

/**
 * The controller, with M4.6's SSE route and test-local routes for M4.2–M4.5's
 * seams.
 *
 * The test-local routes are named as such in their handlers: those seams were built
 * as libraries, and M4.6's deliverable is the STREAM, not a full mesh router. The
 * route bodies are one call each into the real seam, so what the two nodes exchange
 * is the real record and the real decision.
 */
export async function aController(clock: MeshClock = new MeshClock()): Promise<ControllerNode> {
  const identity = await anIdentity(CONTROLLER)
  const registryStore = new InMemoryNodeRegistryStore()
  const registry = new MeshNodeRegistry({ store: registryStore, now: clock.now })
  const leaseStore = new InMemoryControllerLeaseStore()
  const unreconciled = createUnreconciledNodeSource()
  const lease = new MeshControllerLease({ store: leaseStore, unreconciled: unreconciled.source, now: clock.now })
  const kernel = SqliteEventStore.createInMemory()
  const engine = new ProjectionEngine(kernel)
  const updater = new MeshProjectionUpdater({ engine, snapshots: kernel, now: clock.now })
  const gateway = new MeshEventGateway({ now: clock.now, snapshots: new ProjectionSnapshotFallback(kernel) })

  // The ingestor is fed the SAME event that goes on the stream, and the projection
  // updater is driven by the ingestor. That is the wiring M4-S requires: a real writer
  // driven from the real event path, so a client that re-bases is re-basing onto
  // state that was computed from the events it missed.
  const applied: StoredRunEvent[] = []
  const ingestor = new MeshEventIngestor({
    store: {
      seen: async (eventId) => ({ ok: true, value: applied.some((event) => event.eventId === eventId) }),
      apply: async (event: MeshEvent) => {
        const stored = { ...event.event, globalPosition: applied.length + 1, event: event.event } as StoredRunEvent
        applied.push(stored)
        updater.apply(stored)
        return { ok: true, value: undefined }
      },
    },
  })

  const unacknowledged = {
    commandIds: async (): Promise<Result<readonly CommandId[]>> => ({ ok: true, value: [] }),
    eventIds: async (): Promise<Result<readonly EventId[]>> => ({ ok: true, value: [] }),
  }
  const projections = { sessionForDispatch: async (): Promise<Result<SessionId | null>> => ({ ok: true, value: null }) }
  const reconciler = new MeshReconciler({ lease, unacknowledged, projections, snapshots: new ProjectionSnapshotFallback(kernel) })

  const app = Fastify()
  app.post("/v1/mesh/heartbeat", async (request) => ({ result: await registry.recordHeartbeat(request.body) }))
  app.post("/v1/mesh/reconciliation", async (request) => ({ result: await reconciler.reconcile(request.body) }))
  // The peer is not known until enrollment derives its id, so the hook's expected node
  // is read through a holder rather than frozen at construction.
  const peer: { nodeId: NodeId } = { nodeId: PENDING_NODE }
  const streamIdentity: MeshIdentityHookOptions = {
    provider: identity.provider,
    get expectedNodeId() {
      return peer.nodeId
    },
    expectedMeshId: MESH_ID,
  }
  registerEventStreamRoute(app, { gateway, identity: streamIdentity, scopeOf: scopeFromQuery })
  // The event endpoint. It publishes through the gateway AND the ingestor, in that
  // order, so a record that is refused for its version or its sequence never reaches
  // the stream and never reaches a projection.
  app.post("/v1/mesh/event", async (request) => {
    const published = await gateway.publish(request.body)
    if (!published.ok) return { published }
    if (!published.outcome.accepted) return { published }
    const ingested = await ingestor.ingest(published.outcome.entry.payload)
    return { published, ingested }
  })

  const server = await listen(app)
  return {
    identity,
    baseUrl: server.baseUrl,
    registry,
    registryStore,
    lease,
    leaseStore,
    unreconciled,
    kernel,
    engine,
    updater,
    gateway,
    ingestor,
    reconciler,
    client: aClient(identity),
    clock,
    expectPeer: (nodeId) => {
      peer.nodeId = nodeId
    },
    close: server.close,
  }
}

// --- The worker node ------------------------------------------------------

export interface WorkerNode {
  readonly identity: Awaited<ReturnType<typeof anIdentity>>
  readonly baseUrl: string
  readonly inbox: MeshCommandInbox
  readonly store: InMemoryCommandInboxStore
  readonly lease: MeshControllerLease
  readonly leaseStore: InMemoryControllerLeaseStore
  readonly unreconciled: ReturnType<typeof createUnreconciledNodeSource>
  readonly client: ReturnType<typeof aClient>
  /** The runtime, which is the one thing here that is a test seam. */
  readonly launched: string[]
  close(): Promise<void>
}

/**
 * The worker, with a real lease and a real inbox.
 *
 * The lease on this side is the CONTROLLER's lease, delivered over the wire — a
 * worker does not claim a lease, it is told which controller drives the run, and its
 * gate compares every command's epoch against that record. A worker that invented its
 * own lease would be a second authority, which is the split brain M4.4 exists to
 * prevent.
 */
export async function aWorker(options: {
  readonly nodeId: NodeId
  readonly keyPair: NodeKeyPair
  /** The controller's key, delivered to the worker so the worker can pin it. */
  readonly controllerKey: NodeKeyPair
  readonly clock?: MeshClock
}): Promise<WorkerNode> {
  const { nodeId, keyPair } = options
  const clock = options.clock ?? new MeshClock()
  // A node's trust and pin stores are for its PEERS, not for itself. The worker
  // authenticates the controller's command, so the controller is the row that has to be
  // there — and the controller's key is delivered, not invented, because "the key a
  // node will present" is exactly the fact a pin exists to bind.
  const trust = new InMemoryNodeTrustStore()
  const pins = new InMemoryPeerKeyPinStore()
  await trust.enroll({ nodeId: CONTROLLER, meshId: MESH_ID, nodeKeyId: options.controllerKey.keyId, enrolledAt: 0, displayName: "controller" })
  await pins.pin({
    nodeId: CONTROLLER,
    meshId: MESH_ID,
    key: {
      nodeKeyId: options.controllerKey.keyId,
      publicKey: options.controllerKey.publicKey,
      fingerprint: options.controllerKey.fingerprint,
    },
    enrollmentId: "enr-controller-on-worker",
    now: 0,
  })
  const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: () => T0_MS })
  const identity = { nodeId, trust, pins, keyPair, provider }
  const leaseStore = new InMemoryControllerLeaseStore()
  const unreconciled = createUnreconciledNodeSource()
  const lease = new MeshControllerLease({ store: leaseStore, unreconciled: unreconciled.source, now: clock.now })
  const store = new InMemoryCommandInboxStore()
  const launched: string[] = []

  const gate = new MeshCommandEpochGate({
    lease,
    recipientNodeId: nodeId,
    now: clock.now,
    recordedState: { resolve: async () => ({ ok: true, value: { runState: "active" } }) } as RecordedCommandStateResolver,
  })
  const inbox = new MeshCommandInbox({
    store,
    now: clock.now,
    // The transport identity, decided on the way in and nowhere else — M4.2's rule,
    // and the reason a revoked node is answered with its revocation rather than with
    // whichever schema check its record happens to fail first. The signature is lifted
    // off the request by the ROUTE (which is the only place the framework is), and the
    // provider is asked the one question it exists to answer.
    authenticate: {
      authenticate: async () => {
        const signature = currentSignature()
        if (signature === undefined) {
          return { ok: false, error: createContractError("validation", "inbox.signature_absent", "The submission arrived without a request signature in scope, so no node can be attributed to it.") }
        }
        // `expectedNodeId` is the node that is expected to have SIGNED, not the node
        // the request arrived at — M4.2's middleware takes one per route or transport
        // for exactly that reason. The worker's command route therefore expects the
        // controller, and the worker's trust and pin stores hold the controller's key.
        const verified = await identity.provider.authenticate({ expectedNodeId: CONTROLLER, expectedMeshId: MESH_ID, signature })
        return verified.ok ? { ok: true, value: { nodeId: verified.value.nodeId } } : verified
      },
    },
    gate,
    // The recorded log is the CONTROLLER's, delivered. A payload's lease pointer is
    // a CLAIM; this is the grant, and the two are read from different nodes on
    // purpose.
    recordedLog: leaseBackedRecordedLog(leaseStore),
    acks: { emit: async () => undefined },
  })

  const app = Fastify()
  app.post("/v1/mesh/lease", async (request) => ({ result: await lease.applyLease(request.body) }))
  app.post("/v1/mesh/command", async (request) => {
    // The signature is LIFTED here, at the framework boundary, and nothing is decided
    // here: the decision belongs to the inbox's step 1, through M4.2's own provider.
    // Deciding it twice would mean two answers to "is this node trusted", and the one
    // that skipped the revocation check would be the one nobody notices.
    const signature = liftSignature(request, identity)
    if (signature === null) return { identity: { ok: false, reason: "request_malformed" } }
    return { result: await withRequestSignature(signature, async () => inbox.submit(request.body)) }
  })
  // The runtime. A test seam, and named one: the mesh is what this file exercises, not
  // the agent. What matters is that the row was durable BEFORE the effect ran, so a
  // crash between the two is the crash M4.5's hook 6 exists to describe.
  app.post("/v1/runtime/execute", async (request) => {
    const body = request.body as { commandId: string }
    const commandId = commandIdSchema.parse(body.commandId)
    const row = await inbox.lookup(commandId)
    if (!row.ok || row.value === null) return { launched: false }
    // The clock is the SEAM's, not the caller's: `markRuntimeAccepted` stamps the row
    // itself, so a caller that passed its own instant would be writing two different
    // times into two different places for one decision.
    await inbox.markRuntimeAccepted(commandId)
    launched.push(commandId)
    await inbox.recordResult(commandId, { sessionId: "sess-mesh-1" })
    return { launched: true }
  })

  const server = await listen(app)
  return {
    identity,
    baseUrl: server.baseUrl,
    inbox,
    store,
    lease,
    leaseStore,
    unreconciled,
    client: aClient(identity),
    launched,
    close: server.close,
  }
}

/** The controller's delivered lease, read as the recorded log a command points at. */
function leaseBackedRecordedLog(store: InMemoryControllerLeaseStore): RecordedLogReader {
  return {
    approval: async (approvalId: ApprovalId): Promise<{ ok: true; value: RecordedApproval | null }> => ({ ok: true, value: null }),
    dispatch: async (dispatchId: DispatchId): Promise<{ ok: true; value: RecordedDispatch | null }> => ({ ok: true, value: null }),
    lease: async (leaseId: LeaseId): Promise<Result<RecordedLease | null>> => {
      const records = await store.leaseHistory({ projectId: PROJECT, runId: RUN })
      if (!records.ok) return records
      const found = records.value.find((entry) => entry.leaseId === leaseId)
      if (found === undefined) return { ok: true, value: null }
      return {
        ok: true,
        value: {
          leaseId: found.leaseId,
          projectId: found.projectId,
          runId: found.runId,
          controllerNodeId: found.controllerNodeId,
          epoch: found.epoch,
          // Carried because the command's own `expiresAt` is checked against the
          // RECORDED lease window at the gate, and a recorded lease with no expiry is
          // not a lease — it is a claim about one.
          expiresAt: found.expiresAt,
        },
      }
    },
  }
}

// --- Records the two nodes exchange ---------------------------------------

/** A `mesh.lease` envelope, built raw and left for the receiver's parse. */
export function leaseEnvelope(overrides: {
  readonly operation: "claim" | "renew" | "release" | "takeover"
  /**
   * The node the record is addressed to.
   *
   * REQUIRED and not defaulted, because a joining node's id is minted from the
   * enrollment code hash and a fixture that filled one in would be asserting on a fact
   * the controller decides. A lease or a command addressed to the wrong node is
   * refused at `verifyIncomingCommand`, so getting it wrong here would fail for a
   * reason that has nothing to do with the lease.
   */
  readonly recipientNodeId: NodeId
  readonly controllerNodeId?: NodeId
  readonly epoch?: number
  readonly issuedAt?: string
  readonly expiresAt?: string
  readonly predecessorLeaseId?: string
  readonly predecessorEpoch?: number
  readonly takeoverReason?: string
  readonly acknowledgedUnreconciledNodeIds?: readonly NodeId[]
}): Record<string, unknown> {
  const issuedAt = overrides.issuedAt ?? at(0)
  const expiresAt = overrides.expiresAt ?? at(DURATION_SECONDS)
  const leaseId = leaseIdSchema.parse(`${overrides.operation === "takeover" ? "lease-run-release-1-e2" : "lease-run-release-1"}`)
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.lease",
    messageId: `msg-${leaseId}`,
    correlationId: leaseId,
    causation: null,
    senderNodeId: overrides.controllerNodeId ?? CONTROLLER,
    recipientNodeId: overrides.recipientNodeId,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt,
    expiresAt,
    payload: {
      leaseId,
      projectId: PROJECT,
      runId: RUN,
      controllerNodeId: overrides.controllerNodeId ?? CONTROLLER,
      epoch: overrides.epoch ?? EPOCH,
      operation: overrides.operation,
      issuedAt,
      expiresAt,
      durationSeconds: DURATION_SECONDS,
      ...(overrides.predecessorLeaseId === undefined ? {} : { predecessorLeaseId: overrides.predecessorLeaseId }),
      ...(overrides.predecessorEpoch === undefined ? {} : { predecessorEpoch: overrides.predecessorEpoch }),
      ...(overrides.takeoverReason === undefined ? {} : { takeoverReason: overrides.takeoverReason }),
      acknowledgedUnreconciledNodeIds: overrides.acknowledgedUnreconciledNodeIds ?? [],
    },
  }
}

/** A `mesh.command` envelope for `run.pause`, built raw and left for the parse. */
export function commandEnvelope(overrides: {
  /** The node the command is addressed to. See `leaseEnvelope`'s note on why. */
  readonly recipientNodeId: NodeId
  readonly commandId?: CommandId
  readonly controllerNodeId?: NodeId
  readonly controllerEpoch?: number
  readonly leaseId?: LeaseId
  readonly issuedAt?: string
  readonly expiresAt?: string
}): Record<string, unknown> {
  const commandId = overrides.commandId ?? commandIdSchema.parse("cmd-mesh-pause-1")
  const issuedAt = overrides.issuedAt ?? at(1)
  const expiresAt = overrides.expiresAt ?? at(DURATION_SECONDS)
  // Minted through the KERNEL's own schema and then through the PROTOCOL's own minting
  // seam, so the record this mesh sends is one the receiver would have produced
  // itself. A fixture that hand-wrote a `mesh.command` payload would be a second
  // definition of the wire shape, and its `payloadDigest` would be whatever the fixture
  // happened to write.
  const command = mintMeshCommand({
    command: makeCommand({
      commandId,
      projectId: PROJECT,
      runId: RUN,
      epoch: overrides.controllerEpoch ?? EPOCH,
      issuedAt,
      expiresAt,
      correlationId: correlationIdSchema.parse(commandId),
      // A `system` actor rather than a `node` one: the event-store fixture's command
      // schema is the kernel's own, and a controller driving a run is the kernel's
      // `system` actor.
      actor: { kind: "system", name: "mesh-controller" },
      controllerNodeId: overrides.controllerNodeId ?? CONTROLLER,
      leaseId: overrides.leaseId ?? LEASE,
    }),
    targetNodeId: overrides.recipientNodeId,
  })
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.command",
    messageId: `msg-${commandId}`,
    correlationId: commandId,
    causation: null,
    senderNodeId: overrides.controllerNodeId ?? CONTROLLER,
    recipientNodeId: overrides.recipientNodeId,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt,
    expiresAt,
    payload: command,
  }
}

/** A `mesh.event` envelope carrying a `dispatch.started`, minted through the protocol. */
export function eventEnvelope(overrides: {
  readonly sourceNodeId: NodeId
  readonly eventId?: string
  readonly localSequence: number
  /**
   * The KERNEL's per-run sequence, which is a different axis from the mesh's
   * per-source `localSequence` and from the gateway's `position`.
   *
   * Settable independently so a test can make all three disagree, which is the only
   * way the assertion that `position` is the gateway's OWN order is observable.
   */
  readonly runSequence?: number
  readonly sessionId?: string
  readonly commandId?: CommandId
} ): Record<string, unknown> {
  const eventId = overrides.eventId ?? `evt-mesh-${overrides.localSequence}`
  const commandId = overrides.commandId ?? commandIdSchema.parse("cmd-mesh-pause-1")
  const sessionId = overrides.sessionId ?? `sess-mesh-${overrides.localSequence}`
  const sourceNodeId = overrides.sourceNodeId
  const event = orchestrationEventSchema.parse({
    schemaVersion: 1,
    eventId,
    sequence: overrides.runSequence ?? overrides.localSequence,
    projectId: PROJECT,
    runId: RUN,
    occurredAt: at(overrides.localSequence),
    actor: { kind: "node", nodeId: sourceNodeId },
    correlationId: eventId,
    causation: { kind: "command", commandId },
    controllerEpoch: EPOCH,
    commandId,
    type: "dispatch.started",
    payload: {
      session: sessionSchema.parse({
        schemaVersion: 1,
        sessionId,
        projectId: PROJECT,
        runId: RUN,
        taskId: "task-mesh-1",
        dispatchId: dispatchIdSchema.parse("dispatch-mesh-1"),
        nodeId: sourceNodeId,
        installationId: "install-mesh-1",
        runtimeKind: "opencode",
        lifecycleState: "launching",
        observedState: "starting",
      }),
    },
  })
  const meshEvent = mintMeshEvent({ event, sourceNodeId, localSequence: overrides.localSequence, commandCorrelation: commandId })
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.event",
    messageId: `msg-${eventId}`,
    correlationId: eventId,
    causation: null,
    senderNodeId: sourceNodeId,
    recipientNodeId: CONTROLLER,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: at(overrides.localSequence),
    expiresAt: at(3600),
    payload: meshEvent,
  }
}

/** A `mesh.heartbeat` envelope. Addressed to the node it reports on. */
export function heartbeatEnvelope(overrides: { readonly nodeId: NodeId; readonly sequence: number; readonly observedAt?: string }): Record<string, unknown> {
  const nodeId = overrides.nodeId
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    recordType: "mesh.heartbeat",
    messageId: `msg-hb-${overrides.sequence}`,
    correlationId: `hb-${overrides.sequence}`,
    causation: null,
    senderNodeId: nodeId,
    recipientNodeId: nodeId,
    protocolVersion: CURRENT_MESH_PROTOCOL_VERSION,
    issuedAt: overrides.observedAt ?? at(overrides.sequence),
    expiresAt: at(3600),
    payload: {
      meshId: MESH_ID,
      nodeId,
      observedAt: overrides.observedAt ?? at(overrides.sequence),
      sequence: overrides.sequence,
      liveness: "live",
      runtimeKinds: ["opencode"],
      capabilities: ["session.execute"],
      projectPathIds: ["path-release-1"],
      maxConcurrentSessions: 4,
      protocolVersions: [CURRENT_MESH_PROTOCOL_VERSION],
      agentCount: 1,
      load: { activeSessions: 0, queuedSessions: 0 },
    },
  }
}

/**
 * The controller's durable log for a run, so `run.pause` has a recorded state.
 *
 * The kernel's OWN fixture log rather than a hand-built `run.created`, for the reason
 * every fixture in this repository is built that way: the `run` record inside
 * `run.created` has moved twice since Milestone 3, and a hand-built one here failed to
 * parse for reasons that had nothing to do with the mesh. The first two events are
 * `run.created` and `task.created`, which is the minimum a `run.pause` needs: the
 * matrix row for it constrains the RUN state, and `draft` is one of the two states it
 * may act in.
 */
export function seedTheRun(controller: ControllerNode): void {
  const events = revisedSameDispatchId().slice(0, 2)
  controller.kernel.append({
    command: makeCommand({ commandId: "cmd-seed-run", projectId: PROJECT, runId: RUN, epoch: EPOCH }),
    events,
  })
  for (const [index, event] of controller.kernel.readStream(RUN).entries()) {
    controller.updater.apply({ ...event, globalPosition: index + 1, event: event.event })
  }
}

export { approvalIdSchema, digestJson, safeParseMeshEnvelope }
export type { MeshLease }

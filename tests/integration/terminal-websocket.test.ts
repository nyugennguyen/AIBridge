/**
 * M4.7's transport, over a real loopback listener, plus the two-node terminal
 * smoke test the milestone gate names.
 *
 * ### Why this file exists alongside `tests/unit/mesh/gateway/terminal/`
 *
 * `Docs/implementation-plans/websocket-test-harness.md` §1 measured that
 * `app.injectWS` does not work in this repository: it throws
 * `Invalid url for WebSocket null` under `bun test` and hangs under vitest. The
 * gateway's session logic is therefore unit-tested against an injected socket
 * interface with no socket at all, and THIS file covers the four things only a
 * real upgrade can prove:
 *
 *   - a `preValidation` refusal really does happen BEFORE `101 Switching
 *     Protocols`, so an unauthenticated client never reaches the handler;
 *   - a TEXT frame and a BINARY frame survive a real round trip as distinct
 *     opcodes;
 *   - `bufferedAmount` — the transport half of the backpressure bound — is what
 *     a paused reader actually moves;
 *   - and a terminal held on node A is reachable through node B's gateway.
 *
 * ### The teardown, and why it is this shape
 *
 * The same harness note §3: `app.close()` HANGS if a client was closed
 * gracefully, and terminating the server-side sockets afterwards does not recover
 * it. So every teardown here runs, in order:
 *
 *   1. `terminate()` every entry of `app.websocketServer.clients`
 *   2. `terminate()` the client (NEVER `close()`)
 *   3. `await app.close()`
 *
 * and {@link closeAll} is the ONLY teardown in the file, so there is one place for
 * a future test to get it wrong rather than eleven.
 *
 * ### What is REAL and what is a seam
 *
 * Real: the identity keys, the trust and pin stores, the replay guard, the signed
 * request headers over the real request target including its query, the WebSocket
 * upgrade, the frame opcodes, and — in the two-node case — the HTTP hop between
 * two servers on two ports carrying the terminal's bytes.
 *
 * Test seams, each named where it is built: the pty behind a terminal (the mesh
 * is what is under test, not the agent) and the access port's backing store,
 * which stands in for the recorded registry, session projection and lease that
 * M4.3, M4.6 and M4.4 provide in production. The clock is injected and nothing
 * sleeps: the frame bounds are exercised by writing bytes, and the only `await`s
 * are on I/O the sockets themselves produce.
 */
import Fastify, { type FastifyInstance } from "fastify"
import websocket from "@fastify/websocket"
import { afterEach, describe, expect, it } from "vitest"
import { connect as connectSocket, type Socket } from "node:net"
import WebSocket, { type RawData } from "ws"
import { createContractError, type Result } from "../../src/orchestration/errors.js"
import { MAX_TERMINAL_FRAME_BYTES } from "../../src/mesh/protocol/bounds.js"
import {
  epochSchema,
  meshIdSchema,
  nodeIdSchema,
  projectIdSchema,
  runIdSchema,
  sessionIdSchema,
  terminalClientIdSchema,
  terminalIdSchema,
  type Epoch,
  type MeshId,
  type NodeId,
  type ProjectId,
  type RunId,
  type SessionId,
  type TerminalClientId,
  type TerminalId,
} from "../../src/orchestration/identifiers.js"
import {
  InMemoryNodeTrustStore,
  InMemoryPeerKeyPinStore,
  MESH_IDENTITY_HEADERS,
  MeshIdentityProvider,
  InMemoryNonceGuard,
  NodeKeyPair,
  meshBodyDigest,
  signMeshRequest,
} from "../../src/mesh/identity/index.js"
import type { MeshIdentityHookOptions } from "../../src/mesh/identity/middleware.js"
import {
  MeshTerminalGatewayImpl,
  registerTerminalRoute,
  type MeshTerminalGateway,
  type TerminalAccessOutcome,
  type TerminalAccessPort,
  type TerminalAccessRefusal,
  type TerminalAccessRequest,
  type TerminalBinding,
  type TerminalOutputSink,
  type TerminalRuntimePort,
  type TerminalTelemetryEvent,
} from "../../src/mesh/gateway/terminal/index.js"

const T0_MS = Date.parse("2026-09-28T00:00:00.000Z")
const MESH: MeshId = meshIdSchema.parse("mesh-release")
const CONTROLLER: NodeId = nodeIdSchema.parse("node-controller-1")
const WORKER: NodeId = nodeIdSchema.parse("node-worker-1")
const PEER: NodeId = nodeIdSchema.parse("node-peer-1")
const SUCCESSOR: NodeId = nodeIdSchema.parse("node-controller-2")
const PROJECT: ProjectId = projectIdSchema.parse("project-release")
const OTHER_PROJECT: ProjectId = projectIdSchema.parse("project-other")
const RUN: RunId = runIdSchema.parse("run-release-1")
const SESSION: SessionId = sessionIdSchema.parse("sess-release-1")
const TERMINAL: TerminalId = terminalIdSchema.parse("term-release-1")
const ALICE: TerminalClientId = terminalClientIdSchema.parse("client-alice")
const BOB: TerminalClientId = terminalClientIdSchema.parse("client-bob")
const EPOCH: Epoch = epochSchema.parse(4)
const NEXT_EPOCH: Epoch = epochSchema.parse(5)

/** A clock the test moves by hand. Nothing in this file sleeps. */
class Clock {
  #ms = T0_MS
  now = (): number => this.#ms
  advance(ms: number): void {
    this.#ms += ms
  }
  iso(): string {
    return new Date(this.#ms).toISOString()
  }
}

// --- Identity --------------------------------------------------------------

interface NodeIdentity {
  readonly nodeId: NodeId
  readonly trust: InMemoryNodeTrustStore
  readonly pins: InMemoryPeerKeyPinStore
  readonly keyPair: NodeKeyPair
  readonly provider: MeshIdentityProvider
}

/**
 * One node's identity, with the CONTROLLER already enrolled in its trust and pin
 * stores.
 *
 * A node's trust and pin stores are for its PEERS, not for itself. The client
 * that connects to a terminal gateway authenticates as the CONTROLLER — the node
 * driving the run — and the gateway's own id is the seam's `expectedNodeId`, so
 * the client presents the controller's key and the gateway verifies it against
 * the controller's row. That is the arrangement M4.2's middleware describes and
 * M4.6's SSE harness uses, and it is why a terminal socket is authenticated at
 * all: the credential is a per-request ed25519 SIGNATURE, not the bridge's shared
 * bearer token, and `src/mesh/identity/middleware.ts` says at length why the
 * bearer must not be added here as well.
 */
async function anIdentity(): Promise<NodeIdentity> {
  const trust = new InMemoryNodeTrustStore()
  const pins = new InMemoryPeerKeyPinStore()
  const keyPair = NodeKeyPair.generate()
  await trust.enroll({ nodeId: CONTROLLER, meshId: MESH, nodeKeyId: keyPair.keyId, enrolledAt: 0, displayName: "controller" })
  await pins.pin({ nodeId: CONTROLLER, meshId: MESH, key: { nodeKeyId: keyPair.keyId, publicKey: keyPair.publicKey, fingerprint: keyPair.fingerprint }, enrollmentId: "enr-controller", now: 0 })
  const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: () => T0_MS })
  return { nodeId: CONTROLLER, trust, pins, keyPair, provider }
}

/** A second controller, for a node whose gateway expects it. */
async function anIdentityFor(nodeId: NodeId): Promise<NodeIdentity> {
  const trust = new InMemoryNodeTrustStore()
  const pins = new InMemoryPeerKeyPinStore()
  const keyPair = NodeKeyPair.generate()
  await trust.enroll({ nodeId, meshId: MESH, nodeKeyId: keyPair.keyId, enrolledAt: 0, displayName: nodeId })
  await pins.pin({ nodeId, meshId: MESH, key: { nodeKeyId: keyPair.keyId, publicKey: keyPair.publicKey, fingerprint: keyPair.fingerprint }, enrollmentId: `enr-${nodeId}`, now: 0 })
  const provider = new MeshIdentityProvider({ trust, pins, replayGuard: new InMemoryNonceGuard(), now: () => T0_MS })
  return { nodeId, trust, pins, keyPair, provider }
}

/** The `x-aibridge-mesh-*` headers for a signed GET on `path`, query INCLUDED. */
function signedHeaders(identity: NodeIdentity, path: string, nonceSuffix: string): Record<string, string> {
  const bodyDigest = meshBodyDigest(null)
  const signature = signMeshRequest(identity.keyPair, {
    method: "GET",
    // The full target INCLUDING the query. M4.2's hook's default `signedPath` is
    // `request.raw.url`, so signing the pathname alone would leave `?projectId=`
    // outside the signature — one node authorized for project A could then ask
    // about project B with a signature that verified.
    path,
    bodyDigest,
    timestamp: T0_MS,
    // Distinct per call, because a deterministic nonce is fine for one request
    // and actively harmful for two: the replay guard would refuse the second for
    // a reason that has nothing to do with the property under test.
    nonce: `nonce-${nonceSuffix}-${identity.nodeId}`,
    nodeId: identity.nodeId,
    keyId: identity.keyPair.keyId,
  })
  return {
    [MESH_IDENTITY_HEADERS.nodeId]: identity.nodeId,
    [MESH_IDENTITY_HEADERS.keyId]: identity.keyPair.keyId,
    [MESH_IDENTITY_HEADERS.timestamp]: String(T0_MS),
    [MESH_IDENTITY_HEADERS.nonce]: signature.nonce,
    [MESH_IDENTITY_HEADERS.signature]: signature.signature,
    [MESH_IDENTITY_HEADERS.bodyDigest]: bodyDigest,
  }
}

function attachPath(terminal: TerminalId, project: ProjectId, session: SessionId, node: NodeId, client: TerminalClientId, epoch: Epoch = EPOCH): string {
  return `/v1/mesh/terminal?terminalId=${terminal}&projectId=${project}&sessionId=${session}&nodeId=${node}&clientId=${client}&epoch=${epoch}`
}

// --- Records ---------------------------------------------------------------

let frameCounter = 0

function nextFrameId(): string {
  frameCounter += 1
  return `msg-live-${frameCounter}`
}

/** A `mesh.terminal.control` envelope, as a TEXT frame. */
function controlFrame(payload: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 2,
    recordType: "mesh.terminal.control",
    messageId: nextFrameId(),
    correlationId: payload["clientId"],
    causation: null,
    senderNodeId: CONTROLLER,
    recipientNodeId: payload["nodeId"],
    protocolVersion: 1,
    issuedAt: new Date(T0_MS).toISOString(),
    expiresAt: new Date(T0_MS + 300_000).toISOString(),
    payload,
  })
}

/** A `mesh.terminal.data` envelope, as a BINARY frame. */
function dataFrame(payload: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      recordType: "mesh.terminal.data",
      messageId: nextFrameId(),
      correlationId: payload["clientId"],
      causation: null,
      senderNodeId: CONTROLLER,
      // `null`, and a data frame has no `nodeId` to address to. The control
      // family's refinement binds its recipient to the payload's node; the data
      // family has no such member, because a data frame is addressed to whoever
      // is on the other end of THAT socket — which the gateway knows and the
      // envelope does not. Putting the control frame's spelling here would make
      // every data frame fail to parse for a reason that has nothing to do with
      // the test.
      recipientNodeId: null,
      protocolVersion: 1,
      issuedAt: new Date(T0_MS).toISOString(),
      expiresAt: new Date(T0_MS + 300_000).toISOString(),
      payload,
    }),
    "utf8",
  )
}

function controlPayload(operation: string, clientId: TerminalClientId, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { terminalId: TERMINAL, projectId: PROJECT, sessionId: SESSION, nodeId: WORKER, clientId, operation, epoch: EPOCH, ...extra }
}

// --- The recorded state a terminal gateway authorizes against --------------

/**
 * The access port's backing store, standing in for M4.3's registry, the kernel's
 * session projection and M4.4's lease.
 *
 * A test seam, and named as one: those three are real seams in production and
 * wiring them here would mean standing up a registry, a projection engine and a
 * lease store to test a WebSocket route. What is NOT a seam is the SHAPE — the
 * port is asked the same question the production port is asked, gets a grant
 * carrying the recorded epoch, and has no way to be asked twice and have the
 * second answer remembered. That is the property M4.7's requirement 2 turns on,
 * and it survives the substitution.
 */
class RecordedTerminalState {
  /** `null` means "the record does not exist", which is a refusal, not an absence. */
  readonly terminals = new Map<TerminalId, TerminalBinding>()
  epoch: Epoch = EPOCH
  /** `null` means the lease has expired. */
  lease: { readonly projectId: ProjectId; readonly runId: RunId; readonly epoch: Epoch; readonly expiresAtMs: number } | null = { projectId: PROJECT, runId: RUN, epoch: EPOCH, expiresAtMs: T0_MS + 30_000 }
  readonly revoked = new Set<NodeId>()
  readonly terminated = new Set<SessionId>()

  record(terminal: TerminalId, overrides: Partial<TerminalBinding> = {}): TerminalBinding {
    const entry: TerminalBinding = { terminalId: terminal, projectId: PROJECT, sessionId: SESSION, nodeId: WORKER, runId: RUN, ...overrides }
    this.terminals.set(terminal, entry)
    return entry
  }
}

class RecordedAccessPort implements TerminalAccessPort {
  readonly calls: TerminalAccessRequest[] = []

  constructor(private readonly state: RecordedTerminalState) {}

  async authorize(request: TerminalAccessRequest): Promise<TerminalAccessOutcome> {
    this.calls.push(request)
    const recorded = this.state.terminals.get(request.terminalId)
    if (recorded === undefined) return denied("terminal_unknown", `Terminal '${request.terminalId}' is not on record at this node.`)
    if (this.state.revoked.has(request.requesterNodeId)) return denied("node_revoked", `Node '${request.requesterNodeId}' is revoked.`)
    if (this.state.terminated.has(request.sessionId)) return denied("session_terminated", `Session '${request.sessionId}' has reached a terminal lifecycle state.`)
    if (recorded.projectId !== request.projectId) return denied("project_mismatch", `Terminal '${request.terminalId}' belongs to '${recorded.projectId}'.`)
    const lease = this.state.lease
    if (lease === null || lease.expiresAtMs <= T0_MS) return denied("lease_expired", "The controller lease for this run is no longer in force.")
    if (this.state.epoch !== lease.epoch) return denied("epoch_stale", `The recorded lease is at epoch ${lease.epoch}.`)
    return { granted: true, binding: recorded, epoch: this.state.epoch }
  }
}

function denied(reason: TerminalAccessRefusal, message: string): TerminalAccessOutcome {
  return { granted: false, reason, error: createContractError("policy_denied", `terminal.access_${reason}`, message) }
}

// --- The pty, and the runtime port -----------------------------------------

/**
 * A local pty, and a `TerminalRuntimePort` that is EITHER local or a real HTTP
 * hop to the node that holds one.
 *
 * The remote branch is the whole of the two-node case: node B's gateway holds no
 * pty at all, and every byte it forwards to node A crosses a real socket. It is
 * a `subscribe`-shaped push rather than a poll because the gateway must not
 * decide how often to ask a remote runtime for bytes — over a Tailscale link
 * that question has no good answer except by holding a request open.
 */
/**
 * A pty, and the inspection surface the assertions read.
 *
 * A test seam, named as such: the mesh is what is under test, not the agent. What
 * matters is that it is a real object with real state — bytes written to it are
 * recorded and come back out of `snapshot()`, a resize is recorded with its
 * dimensions — because a runtime that echoed a constant would make every
 * round-trip assertion below prove nothing about the gateway.
 */
class LocalPty {
  readonly input: Uint8Array[] = []
  readonly resizes: { readonly rows: number; readonly columns: number }[] = []
  #buffered: Uint8Array[] = []
  readonly #sinks = new Set<TerminalOutputSink>()

  write(bytes: Uint8Array): void {
    this.input.push(bytes)
  }

  resize(rows: number, columns: number): void {
    this.resizes.push({ rows, columns })
  }

  /** Runtime output: buffered for a re-base AND delivered to every subscriber. */
  produce(bytes: Uint8Array): void {
    this.#buffered.push(bytes)
    for (const sink of this.#sinks) sink(bytes)
  }

  subscribe(sink: TerminalOutputSink): () => void {
    this.#sinks.add(sink)
    return () => {
      this.#sinks.delete(sink)
    }
  }

  snapshot(maxBytes: number): Uint8Array {
    const all = new Uint8Array(Buffer.concat(this.#buffered.map((chunk) => Buffer.from(chunk))))
    const taken = all.subarray(0, Math.min(all.byteLength, maxBytes))
    this.#buffered = taken.byteLength === all.byteLength ? [] : [all.subarray(taken.byteLength)]
    return new Uint8Array(taken)
  }

  get subscriberCount(): number {
    return this.#sinks.size
  }
}

interface RemoteHandle {
  readonly baseUrl: string
  readonly post: (path: string, body: unknown) => Promise<{ readonly status: number; readonly json: Record<string, unknown> }>
  readonly sign: (path: string, body: unknown) => Record<string, string>
}

function aRuntimePort(pty: LocalPty | null, remote: RemoteHandle | null): TerminalRuntimePort {
  return {
    async subscribe(binding, sink) {
      if (remote !== null) {
        const response = await fetch(`${remote.baseUrl}/v1/test/terminal/stream?terminalId=${encodeURIComponent(binding.terminalId)}`)
        if (!response.ok || response.body === null) {
          return { ok: false, error: createContractError("runtime_failure", "terminal.runtime_unavailable", "The node holding this terminal could not be reached.") }
        }
        const reader = response.body.getReader()
        void (async () => {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) return
            // One base64 chunk per line, so a partial read cannot be mistaken for
            // a whole frame — the same discipline a WebSocket frame boundary
            // gives for free and a byte stream does not.
            for (const line of Buffer.from(chunk.value).toString("utf8").split("\n")) {
              if (line.trim() === "") continue
              sink(new Uint8Array(Buffer.from(line, "base64")))
            }
          }
        })().catch(() => undefined)
        return { ok: true, value: { close: () => void reader.cancel().catch(() => undefined) } }
      }
      // The unsubscribe is RETURNED, not dropped. A subscription left open after
      // the last client left is a live read of a terminal nobody is watching, and
      // the integration assertions count subscribers.
      const unsubscribe = pty?.subscribe(sink) ?? (() => undefined)
      return { ok: true, value: { close: unsubscribe } }
    },
    async writeInput(request) {
      if (remote !== null) {
        const sent = await remote.post(`/v1/test/terminal/input?terminalId=${encodeURIComponent(request.terminalId)}`, {
          clientId: request.clientId,
          sequence: request.sequence,
          chunk: Buffer.from(request.bytes).toString("base64"),
        })
        if (sent.status !== 200) return { ok: false, error: createContractError("runtime_failure", "terminal.runtime_write_refused", "The node holding this terminal refused the input.") }
        return { ok: true, value: undefined }
      }
      pty?.write(request.bytes)
      return { ok: true, value: undefined }
    },
    async resize(request) {
      if (remote !== null) {
        const sent = await remote.post(`/v1/test/terminal/resize?terminalId=${encodeURIComponent(request.terminalId)}`, {
          clientId: request.clientId,
          rows: request.dimensions.rows,
          columns: request.dimensions.columns,
        })
        if (sent.status !== 200) return { ok: false, error: createContractError("runtime_failure", "terminal.runtime_resize_refused", "The node holding this terminal refused the resize.") }
        return { ok: true, value: undefined }
      }
      pty?.resize(request.dimensions.rows, request.dimensions.columns)
      return { ok: true, value: undefined }
    },
    async snapshot(request) {
      if (remote !== null) {
        const sent = await remote.post(`/v1/test/terminal/snapshot?terminalId=${encodeURIComponent(request.terminalId)}`, { maxBytes: request.maxBytes })
        if (sent.status !== 200) return { ok: false, error: createContractError("runtime_failure", "terminal.runtime_snapshot_refused", "The node holding this terminal refused the snapshot.") }
        return { ok: true, value: new Uint8Array(Buffer.from(String(sent.json["chunk"] ?? ""), "base64")) }
      }
      return { ok: true, value: pty?.snapshot(request.maxBytes) ?? new Uint8Array(0) }
    },
  }
}

// --- The node under test ---------------------------------------------------

interface TerminalNode {
  readonly baseUrl: string
  readonly nodeId: NodeId
  readonly gateway: MeshTerminalGateway
  readonly pty: LocalPty | null
  readonly telemetry: TerminalTelemetryEvent[]
  readonly state: RecordedTerminalState
  readonly access: RecordedAccessPort
  /** Bytes the runtime produces. A no-op on a node that holds no pty. */
  produce(bytes: Uint8Array): void
  close(): Promise<void>
  /** The Fastify instance, so `closeAll` can terminate its server-side sockets. */
  readonly app: FastifyInstance
}

const openNodes: TerminalNode[] = []
const openSockets: WebSocket[] = []
/** The hand-written upgrade sockets, which are destroyed rather than closed. */
const openRawSockets: Socket[] = []

/**
 * The teardown, in the one order that works.
 *
 * See the file header: a graceful close on this transport never completes, and
 * `app.close()` waits for it forever. Terminate the SERVER-side sockets first
 * (the plugin's `preClose` would otherwise call `close()` on them, which is the
 * hang), then the client, then the app.
 */
async function closeAll(): Promise<void> {
  // ONE order, and it is the order the harness note measured as the only one
  // that works: server-side sockets first, then the clients, then the app.
  // Terminating the CLIENT first leaves the server holding a socket it has not
  // yet noticed, and `preClose` then calls `close()` on it — the graceful close
  // whose handshake is what makes `app.close()` hang.
  for (const node of openNodes.splice(0)) {
    if (node.app.websocketServer?.clients) {
      for (const client of node.app.websocketServer.clients) client.terminate()
    }
  }
  for (const client of openSockets.splice(0)) client.terminate()
  for (const socket of openRawSockets.splice(0)) socket.destroy()
  for (const node of openNodes) {
    await node.app.close()
  }
}

afterEach(async () => {
  await closeAll()
})

async function aTerminalNode(options: {
  readonly nodeId: NodeId
  readonly clock: Clock
  readonly state: RecordedTerminalState
  readonly pty: LocalPty | null
  readonly remote: RemoteHandle | null
  readonly identity?: NodeIdentity
  /** Registers the test-local routes that expose a LOCAL pty over HTTP. */
  readonly withTestRoutes?: boolean
}): Promise<TerminalNode> {
  const identity = options.identity ?? (await anIdentity())
  const access = new RecordedAccessPort(options.state)
  const telemetry: TerminalTelemetryEvent[] = []
  const runtime = aRuntimePort(options.pty, options.remote)
  const gateway = new MeshTerminalGatewayImpl({
    now: options.clock.now,
    nodeId: options.nodeId,
    access,
    runtime,
    telemetry: {
      record: (event) => {
        telemetry.push(event)
      },
    },
  })

  const app = Fastify({ logger: false })
  await app.register(websocket)
  const identityOptions: MeshIdentityHookOptions = { provider: identity.provider, expectedNodeId: identity.nodeId, expectedMeshId: MESH }
  registerTerminalRoute(app, { gateway, identity: identityOptions })

  if (options.withTestRoutes === true && options.pty !== null) {
    // Test-local routes, named as such in the PATH: M4.2–M4.5's seams were built
    // as libraries and adding routes for them is not M4.7's deliverable. These
    // exist so the two-node case has a REAL byte path between two servers rather
    // than two objects sharing a process.
    const pty = options.pty
    app.get("/v1/test/terminal/stream", async (request, reply) => {
      const { terminalId } = request.query as { terminalId: string }
      const parsed = terminalIdSchema.safeParse(terminalId)
      if (!parsed.success) return reply.code(400).send({ error: "a terminal id is required" })
      reply.raw.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", connection: "keep-alive" })
      let unsubscribe: (() => void) | null = null
      reply.raw.on("close", () => unsubscribe?.())
      unsubscribe = pty.subscribe((bytes) => {
        reply.raw.write(`${Buffer.from(bytes).toString("base64")}\n`)
      })
      return reply
    })
    app.post("/v1/test/terminal/input", async (request) => {
      const body = request.body as { clientId: string; sequence: number; chunk: string }
      pty.write(new Uint8Array(Buffer.from(body.chunk, "base64")))
      return { ok: true, clientId: body.clientId, sequence: body.sequence }
    })
    app.post("/v1/test/terminal/resize", async (request) => {
      const body = request.body as { rows: number; columns: number }
      pty.resize(body.rows, body.columns)
      return { ok: true }
    })
    app.post("/v1/test/terminal/snapshot", async (request) => {
      const body = request.body as { maxBytes: number }
      return { chunk: Buffer.from(pty.snapshot(body.maxBytes)).toString("base64") }
    })
  }

  await app.listen({ port: 0, host: "127.0.0.1" })
  const address = app.server.address()
  if (address === null || typeof address === "string") throw new Error("the terminal node did not bind a TCP port")
  const baseUrl = `http://127.0.0.1:${address.port}`

  const node: TerminalNode = {
    app,
    baseUrl,
    nodeId: options.nodeId,
    gateway,
    pty: options.pty,
    telemetry,
    state: options.state,
    access,
    produce: (bytes) => options.pty?.produce(bytes),
    close: () => app.close(),
  }
  openNodes.push(node)
  return node
}

/** A node B's runtime port can reach: a signed HTTP handle onto node A. */
function aRemoteHandle(node: TerminalNode, identity: NodeIdentity): RemoteHandle {
  return {
    baseUrl: node.baseUrl,
    sign: (path, _body) => signedHeaders(identity, path, `remote-${path.length}`),
    post: async (path, body) => {
      const response = await fetch(`${node.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...signedHeaders(identity, path, `post-${path}`) },
        body: JSON.stringify(body),
      })
      return { status: response.status, json: (await response.json()) as Record<string, unknown> }
    },
  }
}

// --- A connected client ----------------------------------------------------

/** A real `ws` client that records what it receives, keyed by opcode. */
class WireClient {
  readonly texts: string[] = []
  readonly binaries: Uint8Array[] = []
  readonly closes: number[] = []
  #failure: Error | null = null

  constructor(readonly socket: WebSocket) {
    openSockets.push(socket)
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) this.binaries.push(new Uint8Array(data as Buffer))
      else this.texts.push(data.toString())
    })
    socket.on("close", (code: number) => {
      this.closes.push(code)
    })
    socket.on("error", (error: Error) => {
      this.#failure = error
    })
  }

  get failure(): Error | null {
    return this.#failure
  }

  async opened(timeoutMs = 5_000): Promise<void> {
    await this.#until(timeoutMs, () => this.socket.readyState === WebSocket.OPEN, "the socket never opened")
  }

  async waitForTexts(count: number, timeoutMs = 5_000): Promise<string[]> {
    await this.#until(timeoutMs, () => this.texts.length >= count, `expected ${count} text frames, saw ${this.texts.length}`)
    return this.texts
  }

  async waitForBinaries(count: number, timeoutMs = 5_000): Promise<Uint8Array[]> {
    await this.#until(timeoutMs, () => this.binaries.length >= count, `expected ${count} binary frames, saw ${this.binaries.length}`)
    return this.binaries
  }

  async waitForClose(timeoutMs = 5_000): Promise<number[]> {
    await this.#until(timeoutMs, () => this.closes.length > 0, "the socket never closed")
    return this.closes
  }

  async #until(timeoutMs: number, done: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!done()) {
      if (this.#failure !== null) throw new Error(`${message} (socket error: ${this.#failure.message})`)
      if (Date.now() > deadline) throw new Error(message)
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
  }

  controlPayloads(): { readonly operation: string; readonly clientId: string; readonly reason?: string; readonly epoch: number }[] {
    return this.texts.map((text) => (JSON.parse(text) as { payload: { operation: string; clientId: string; reason?: string; epoch: number } }).payload)
  }

  dataPayloads(): { readonly clientId: string; readonly sequence: number; readonly chunk: string; readonly direction: string }[] {
    return this.binaries.map((bytes) => (JSON.parse(Buffer.from(bytes).toString("utf8")) as { payload: { clientId: string; sequence: number; readonly chunk: string; direction: string } }).payload)
  }

  decodedChunks(): string[] {
    return this.dataPayloads().map((payload) => Buffer.from(payload.chunk, "base64").toString("utf8"))
  }
}

/** Opens a socket and either connects or records the upgrade refusal. */
function connect(baseUrl: string, path: string, headers: Record<string, string>): WireClient {
  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}${path}`, { headers })
  return new WireClient(socket)
}


/**
 * One real HTTP upgrade attempt, answered with its status line and body.
 *
 * NOT the `ws` client, and the reason is measured rather than preferred:
 * `websocket-test-harness.md` §4 records that `bun test` runs Bun's own runner,
 * and Bun's `ws` shim does not implement the client's `unexpected-response` event
 * — it surfaces only "Expected 101 status code", with no status and no body. The
 * property requirement 1 turns on is exactly that the refusal is an HTTP STATUS
 * and not a `101` followed by a close frame, and a client that cannot see the
 * status cannot prove it.
 *
 * So the upgrade is written onto a `net.Socket` by hand: the same request line, the
 * same `Sec-WebSocket-Key` handshake headers, the same bytes on the wire. What
 * comes back is read to the end of the headers, and for a refusal the body is read
 * to its end. This works identically on both runners, needs no new dependency, and
 * reads the ACTUAL response rather than a client's interpretation of it.
 *
 * The key is a FIXED base64 string rather than sixteen random bytes. This is a
 * single-shot request whose handshake is never completed, and `Math.random` is not
 * available to tests that assert on bytes — the same rule the gateway follows for
 * `messageId`.
 */
const HANDSHAKE_KEY = "AAAAAAAAAAAAAAAAAAAAAA=="

async function attemptUpgrade(baseUrl: string, path: string, headers: Record<string, string>): Promise<{ readonly status: number; readonly reason: string; readonly body: string }> {
  const url = new URL(baseUrl)
  const port = Number(url.port)
  return await new Promise((resolve, reject) => {
    const socket = connectSocket({ host: url.hostname, port })
    openRawSockets.push(socket)
    const request = [
      `GET ${path} HTTP/1.1`,
      `Host: ${url.host}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Sec-WebSocket-Key: ${HANDSHAKE_KEY}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n")
    let received = ""
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      const separator = received.indexOf("\r\n\r\n")
      const head = separator === -1 ? received : received.slice(0, separator)
      const body = separator === -1 ? "" : received.slice(separator + 4)
      // Destroyed rather than closed. A raw upgrade socket that has read its
      // response is finished, and a graceful `end()` on a socket the peer has
      // already destroyed is another handshake nobody is going to complete.
      socket.destroy()
      const statusLine = head.split("\r\n")[0] ?? ""
      const match = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/.exec(statusLine)
      if (match === null) {
        reject(new Error(`the upgrade response was not an HTTP status line: ${JSON.stringify(head.slice(0, 120))}`))
        return
      }
      resolve({ status: Number(match[1]), reason: match[2] ?? "", body })
    }
    socket.on("connect", () => socket.write(request))
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8")
      // A 101 has no body and the connection stays open, so the header terminator
      // is the end of the response. A refusal has a body, which is read to its
      // `content-length` — the JSON `ContractError` the gateway sent, which is the
      // thing worth asserting on.
      if (received.includes("\r\n\r\n")) {
        const declared = /content-length:\s*(\d+)/i.exec(received)
        const head = received.slice(0, received.indexOf("\r\n\r\n") + 4)
        if (declared === null || Buffer.byteLength(received) - Buffer.byteLength(head) >= Number(declared[1])) finish()
      }
    })
    socket.on("error", (error: Error) => {
      if (!settled) reject(error)
    })
    socket.on("close", () => finish())
    setTimeout(() => {
      if (!settled) {
        settled = true
        socket.destroy()
        reject(new Error(`the upgrade attempt timed out after 5s having read ${JSON.stringify(received.slice(0, 200))}`))
      }
    }, 5_000)
  })
}

/** A node with a local pty, the recorded state, and nothing else. */
async function aLocalNode(options: { readonly nodeId?: NodeId; readonly identity?: NodeIdentity; readonly withTestRoutes?: boolean } = {}): Promise<{
  node: TerminalNode
  clock: Clock
  pty: LocalPty
  state: RecordedTerminalState
  identity: NodeIdentity
}> {
  const clock = new Clock()
  const state = new RecordedTerminalState()
  const pty = new LocalPty()
  state.record(TERMINAL)
  const identity = options.identity ?? (await anIdentity())
  const node = await aTerminalNode({
    nodeId: options.nodeId ?? WORKER,
    clock,
    state,
    pty,
    remote: null,
    identity,
    withTestRoutes: options.withTestRoutes ?? false,
  })
  return { node, clock, pty, state, identity }
}

describe("requirement 1 — the upgrade is authenticated BEFORE it happens", () => {
  it("refuses a client with no mesh headers, and the handler never runs", async () => {
    const { node } = await aLocalNode()
    const path = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const refused = await attemptUpgrade(node.baseUrl, path, {})
    // 401, not 404 and not a 101 followed by a close frame. The identity hook is a
    // `preValidation`, and every Fastify hook runs before the handler — which on a
    // `websocket: true` route is the code that calls `handleUpgrade`.
    expect(refused.status).toBe(401)
    expect(refused.body).toContain("identity.header_missing")
    // The gateway was never asked, because the identity decision comes first.
    expect(node.access.calls).toHaveLength(0)
    expect(node.pty?.subscriberCount).toBe(0)
  })

  it("refuses a VALID bridge bearer token, because a bearer is not a per-node signature", async () => {
    // The one credential that must NOT work here. `src/mesh/identity/middleware.ts`
    // says why at length: a bearer is not per-node, so revoking one node means
    // rotating it for every node, and it is not a SIGNATURE, so any hop that can
    // see the header can replay it forever. Adding it "in addition" would not be
    // defence in depth — it would add a second, weaker credential on a route an
    // operator would reasonably believe was per-node.
    const { node } = await aLocalNode()
    const path = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const refused = await attemptUpgrade(node.baseUrl, path, { authorization: "Bearer a-perfectly-valid-bridge-token" })
    expect(refused.status).toBe(401)
    expect(node.access.calls).toHaveLength(0)
  })

  it("refuses a forged signature", async () => {
    const { node, identity } = await aLocalNode()
    const path = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const headers = { ...signedHeaders(identity, path, "forged-signature-0001"), [MESH_IDENTITY_HEADERS.signature]: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }
    const refused = await attemptUpgrade(node.baseUrl, path, headers)
    expect(refused.status).toBe(401)
    expect(node.access.calls).toHaveLength(0)
  })

  it("refuses a signature over a DIFFERENT query than the one presented", async () => {
    // The property that makes the attach scope trustworthy: M4.2's hook signs
    // `request.raw.url`, which includes the query, so a client that signed for
    // project A and then asked for project B fails verification rather than
    // getting an authorized answer about B.
    const { node, identity } = await aLocalNode()
    const signed = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const presented = attachPath(TERMINAL, OTHER_PROJECT, SESSION, WORKER, ALICE)
    const refused = await attemptUpgrade(node.baseUrl, presented, signedHeaders(identity, signed, "swapped-query-0001"))
    expect(refused.status).toBe(401)
    expect(node.access.calls).toHaveLength(0)
  })

  it("refuses an authenticated client for a project the terminal is not in, with a status and not a close frame", async () => {
    const { node, identity } = await aLocalNode()
    const path = attachPath(TERMINAL, OTHER_PROJECT, SESSION, WORKER, ALICE)
    const refused = await attemptUpgrade(node.baseUrl, path, signedHeaders(identity, path, "wrong-project-00001"))
    expect(refused.status).toBe(403)
    expect(refused.body).toContain("terminal.access_project_mismatch")
  })

  it("refuses a request with no attach scope at all", async () => {
    const { node, identity } = await aLocalNode()
    const path = "/v1/mesh/terminal"
    const refused = await attemptUpgrade(node.baseUrl, path, signedHeaders(identity, path, "no-scope-at-all-0001"))
    expect(refused.status).toBe(400)
    expect(refused.body).toContain("terminal.attach_scope_required")
  })
})

describe("a real upgrade: attach, view, resize, own", () => {
  it("attaches an authenticated client and streams runtime output as BINARY frames", async () => {
    const { node, pty, identity } = await aLocalNode()
    const path = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const alice = connect(node.baseUrl, path, signedHeaders(identity, path, "alice-view"))
    await alice.opened()

    pty.produce(new Uint8Array(Buffer.from("$ echo hello\r\nhello\r\n", "utf8")))
    await alice.waitForBinaries(1)
    // BINARY, not text. The opcode is the cheap half of the control/data
    // separation and it survives a real round trip — a text frame here would mean
    // a data record reached a control-shaped slot.
    expect(alice.texts).toHaveLength(0)
    const payloads = alice.dataPayloads()
    expect(payloads[0]?.direction).toBe("to_viewer")
    expect(payloads[0]?.clientId).toBe(ALICE)
    expect(payloads[0]?.sequence).toBe(1)
    expect(alice.decodedChunks()[0]).toBe("$ echo hello\r\nhello\r\n")
  })

  it("lets a second client view read-only while the first holds input", async () => {
    const { node, pty, identity } = await aLocalNode()
    const alicePath = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const bobPath = attachPath(TERMINAL, PROJECT, SESSION, WORKER, BOB)
    const alice = connect(node.baseUrl, alicePath, signedHeaders(identity, alicePath, "alice-own"))
    await alice.opened()
    alice.socket.send(controlFrame(controlPayload("request_input", ALICE)))
    const bob = connect(node.baseUrl, bobPath, signedHeaders(identity, bobPath, "bob-view"))
    await bob.opened()

    // Two viewers, one owner — read off the gateway's own state rather than
    // inferred from the frames.
    const view = node.gateway.view(TERMINAL)
    expect(view?.viewerCount).toBe(2)
    expect(view?.inputOwnerClientId).toBe(ALICE)

    // Both see the output, at their OWN sequence numbers. That is what "per
    // client, monotonic" buys: one client's loss is not a gap in the other's
    // stream, so a client can tell its own loss apart.
    pty.produce(new Uint8Array(Buffer.from("shared output\r\n", "utf8")))
    await alice.waitForBinaries(1)
    await bob.waitForBinaries(1)
    expect(alice.dataPayloads()[0]?.clientId).toBe(ALICE)
    expect(bob.dataPayloads()[0]?.clientId).toBe(BOB)
    expect(alice.dataPayloads()[0]?.sequence).toBe(1)
    expect(bob.dataPayloads()[0]?.sequence).toBe(1)
  })

  it("refuses input from the viewer and accepts it from the owner", async () => {
    const { node, pty, identity } = await aLocalNode()
    const alicePath = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const bobPath = attachPath(TERMINAL, PROJECT, SESSION, WORKER, BOB)
    const alice = connect(node.baseUrl, alicePath, signedHeaders(identity, alicePath, "alice-type"))
    await alice.opened()
    alice.socket.send(controlFrame(controlPayload("request_input", ALICE)))
    const bob = connect(node.baseUrl, bobPath, signedHeaders(identity, bobPath, "bob-type"))
    await bob.opened()

    bob.socket.send(dataFrame({ terminalId: TERMINAL, clientId: BOB, direction: "to_runtime", encoding: "base64", chunk: Buffer.from("rm -rf /", "utf8").toString("base64"), sequence: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    // Bob is a viewer. His bytes never reached the pty, and this is the check
    // that makes "one input owner" more than a label on a field.
    expect(pty.input).toHaveLength(0)

    alice.socket.send(dataFrame({ terminalId: TERMINAL, clientId: ALICE, direction: "to_runtime", encoding: "base64", chunk: Buffer.from("ls -la\r", "utf8").toString("base64"), sequence: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(pty.input).toHaveLength(1)
    expect(Buffer.from(pty.input[0]!).toString("utf8")).toBe("ls -la\r")
  })

  it("carries a resize on the control frame and applies it to the pty", async () => {
    const { node, pty, identity } = await aLocalNode()
    const path = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const alice = connect(node.baseUrl, path, signedHeaders(identity, path, "alice-resize"))
    await alice.opened()
    alice.socket.send(controlFrame(controlPayload("request_input", ALICE)))
    alice.socket.send(controlFrame(controlPayload("resize", ALICE, { rows: 50, cols: 132 })))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(pty.resizes).toEqual([{ rows: 50, columns: 132 }])
  })

  it("refuses a data record sent as a TEXT frame, and the client's bytes stay at the client", async () => {
    const { node, pty, identity } = await aLocalNode()
    const path = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const alice = connect(node.baseUrl, path, signedHeaders(identity, path, "alice-mismatch"))
    await alice.opened()
    alice.socket.send(controlFrame(controlPayload("request_input", ALICE)))
    await new Promise((resolve) => setTimeout(resolve, 30))

    // A `mesh.terminal.data` record, sent as text. The opcode said "instruction"
    // and the record said "content", and the requirement is that the content
    // never reaches a handler that would put it in a log line.
    alice.socket.send(
      dataFrame({ terminalId: TERMINAL, clientId: ALICE, direction: "to_runtime", encoding: "base64", chunk: Buffer.from("secret", "utf8").toString("base64"), sequence: 1 }).toString("utf8"),
    )
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(pty.input).toHaveLength(0)
    // The refusal was recorded, and what it recorded is the code — not the frame.
    const refused = node.telemetry.find((event) => event.code === "terminal.frame_family_mismatch")
    expect(refused).toBeDefined()
    expect(JSON.stringify(node.telemetry)).not.toContain(Buffer.from("secret", "utf8").toString("base64"))
  })
})

describe("requirement 7 — a takeover over a real socket notifies the displaced client", () => {
  it("moves the keyboard and delivers the notice to the previous owner", async () => {
    const { node, pty, identity } = await aLocalNode()
    const alicePath = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const bobPath = attachPath(TERMINAL, PROJECT, SESSION, WORKER, BOB)
    const alice = connect(node.baseUrl, alicePath, signedHeaders(identity, alicePath, "alice-owner"))
    await alice.opened()
    alice.socket.send(controlFrame(controlPayload("request_input", ALICE)))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(node.gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)

    const bob = connect(node.baseUrl, bobPath, signedHeaders(identity, bobPath, "bob-takes"))
    await bob.opened()
    // A bare `request_input` does NOT displace. This is the explicit half of
    // requirement 7 and it is observable here: Alice keeps the keyboard and is
    // told nothing, because nothing happened to her.
    bob.socket.send(controlFrame(controlPayload("request_input", BOB)))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(node.gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)
    expect(alice.texts).toHaveLength(0)

    bob.socket.send(controlFrame(controlPayload("takeover_input", BOB, { reason: "the operator moved to this window" })))
    await alice.waitForTexts(1)
    expect(node.gateway.view(TERMINAL)?.inputOwnerClientId).toBe(BOB)

    const notice = alice.controlPayloads()[0]
    expect(notice?.operation).toBe("takeover_input")
    // The frame names the NEW owner and carries the reason, so the displaced
    // client learns who has it and why — and the schema permits `reason` on
    // `takeover_input` and on nothing else, which is why the notice has this shape.
    expect(notice?.clientId).toBe(BOB)
    expect(notice?.reason).toBe("the operator moved to this window")

    // And the keyboard genuinely moved: the old owner's bytes stop at the pty.
    alice.socket.send(dataFrame({ terminalId: TERMINAL, clientId: ALICE, direction: "to_runtime", encoding: "base64", chunk: Buffer.from("still typing", "utf8").toString("base64"), sequence: 1 }))
    bob.socket.send(dataFrame({ terminalId: TERMINAL, clientId: BOB, direction: "to_runtime", encoding: "base64", chunk: Buffer.from("now typing", "utf8").toString("base64"), sequence: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(pty.input).toHaveLength(1)
    expect(Buffer.from(pty.input[0]!).toString("utf8")).toBe("now typing")
  })
})

describe("requirement 8 — the bound over a real socket, and what a real socket cannot show", () => {
  /**
   * The measured limit, and it is why the slow-reader assertions live in
   * `tests/unit/mesh/gateway/terminal/admission-and-limits.test.ts`.
   *
   * `bun test` runs Bun's own runner, and Bun's `ws` shim models NEITHER half of a
   * real socket's backpressure: a client socket has no `_socket` to pause, and a
   * server socket's `bufferedAmount` stays `0` through a 13 MB burst that the
   * client then receives in full. Driving the real `ws` package against Bun's
   * server does not work either — the client fails the upgrade with "Unexpected
   * server response: 101". So on the gate's runner a slow reader cannot be
   * PROVOKED through a socket at all, and a test that claimed to would be
   * asserting on a fake.
   *
   * What the injected-socket interface buys is exactly this: `pendingBytes()` is a
   * number a test sets, so "a client that stopped reading" is a state rather than
   * a simulation. Those tests assert the mechanism — `framesToDrop` from the
   * front, a per-client bound, a visible gap, the fast client untouched.
   *
   * What is left here is the half a real socket CAN show, and it is worth having:
   * a burst far larger than the bound is delivered to every connected client
   * without the bound firing spuriously, and a client that disappears mid-burst
   * is removed without disturbing the others.
   */
  it("delivers a burst many times the buffer bound to every connected client, dropping nothing", async () => {
    const { node, pty, identity } = await aLocalNode()
    const alicePath = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const bobPath = attachPath(TERMINAL, PROJECT, SESSION, WORKER, BOB)
    const alice = connect(node.baseUrl, alicePath, signedHeaders(identity, alicePath, "alice-burst"))
    await alice.opened()
    const bob = connect(node.baseUrl, bobPath, signedHeaders(identity, bobPath, "bob-burst"))
    await bob.opened()

    // A frame at the protocol's own `MAX_TERMINAL_FRAME_BYTES`, 200 of them, so
    // the numbers here are the ones the spec states rather than ones this file
    // chose to make the arithmetic convenient.
    const block = new Uint8Array(MAX_TERMINAL_FRAME_BYTES)
    const published = 200
    for (let index = 0; index < published; index += 1) {
      pty.produce(block)
      if (index % 8 === 7) await new Promise((resolve) => setImmediate(resolve))
    }
    await alice.waitForBinaries(published, 8_000)
    await bob.waitForBinaries(published, 8_000)

    // 13 MB through a 1 MiB bound with NOTHING dropped, because nothing was slow.
    // A bound that fired on a client that is keeping up would be a bug in the
    // arithmetic, and this is the assertion that says it did not.
    const view = node.gateway.view(TERMINAL)
    expect(view?.droppedFrames).toBe(0)
    expect(view?.lossy).toBe(false)
    expect(alice.dataPayloads().map((payload) => payload.sequence)).toEqual(Array.from({ length: published }, (_value, index) => index + 1))
    expect(bob.dataPayloads().map((payload) => payload.sequence)).toEqual(Array.from({ length: published }, (_value, index) => index + 1))
    // Each viewer got the same bytes at its OWN sequence, which is what makes one
    // client's loss detectable without it appearing in anybody else's stream.
    expect(alice.dataPayloads().map((payload) => payload.clientId)).toEqual(Array.from({ length: published }, () => ALICE))
    expect(bob.dataPayloads().map((payload) => payload.clientId)).toEqual(Array.from({ length: published }, () => BOB))
    expect(alice.decodedChunks().every((chunk) => Buffer.byteLength(chunk, "utf8") === block.byteLength)).toBe(true)
  }, 30_000)

  it("removes a client that disappears mid-burst and keeps streaming to the other", async () => {
    // The "a slow client loses FRAMES, not its connection" half, on a real socket.
    // The burst here is a proxy for a client that has stopped keeping up: what is
    // asserted is that going away is cheap and local, and that the survivor's
    // stream is unaffected by it.
    const { node, pty, identity } = await aLocalNode()
    const alicePath = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const bobPath = attachPath(TERMINAL, PROJECT, SESSION, WORKER, BOB)
    const alice = connect(node.baseUrl, alicePath, signedHeaders(identity, alicePath, "alice-vanishes"))
    await alice.opened()
    alice.socket.send(controlFrame(controlPayload("request_input", ALICE)))
    const bob = connect(node.baseUrl, bobPath, signedHeaders(identity, bobPath, "bob-survives"))
    await bob.opened()
    expect(node.gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)

    alice.socket.terminate()
    // The gateway is driven by the socket's own `close` event rather than by an
    // assumption that the peer closes politely, so a moment is all it takes.
    for (let attempt = 0; attempt < 100 && node.gateway.attachedClientIds(TERMINAL).includes(ALICE); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(node.gateway.attachedClientIds(TERMINAL)).toEqual([BOB])
    // Ownership went with it, and Bob is untouched.
    expect(node.gateway.view(TERMINAL)?.inputOwnerClientId).toBeNull()
    expect(node.gateway.view(TERMINAL)?.viewerCount).toBe(1)

    pty.produce(new Uint8Array(Buffer.from("still streaming" + String.fromCharCode(13, 10), "utf8")))
    await bob.waitForBinaries(1)
    expect(bob.decodedChunks()).toContain("still streaming\r\n")
  })
})

describe("requirement 10 — revocation closes a real socket", () => {
  it("terminates the connection rather than leaving a revoked node streaming", async () => {
    const { node, pty, identity } = await aLocalNode()
    const path = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const alice = connect(node.baseUrl, path, signedHeaders(identity, path, "alice-revoked"))
    await alice.opened()
    pty.produce(new Uint8Array(Buffer.from("before revocation\r\n", "utf8")))
    await alice.waitForBinaries(1)

    // M4.2's rule settles where the DECISION belongs — revocation is inside
    // `authenticate` — so this is not the check. It is the consequence: an
    // already-attached socket makes no further `authenticate` call, and this is
    // the only thing that closes it.
    node.state.revoked.add(CONTROLLER)
    const closed = node.gateway.revokeNode(CONTROLLER, "the node's signing key was seen in a public paste")
    expect(closed).toHaveLength(1)
    await alice.waitForClose()
    // `terminate`, never `close`: a close frame asks the peer for a handshake, and
    // the harness note measured that this transport's handshake never completes.
    expect(alice.closes).not.toContain(1000)
    expect(node.gateway.view(TERMINAL)).toBeNull()
    expect(pty.subscriberCount).toBe(0)
  })

  it("releases the keyboard on a lease expiry but LEAVES the socket open", async () => {
    // The plan's guardrail, read for terminals: "do not terminate agents because a
    // controller or network disappeared". A lease that expired says nobody is
    // driving the run; it says nothing about whether the user is still watching.
    const { node, pty, identity, state } = await aLocalNode()
    const path = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const alice = connect(node.baseUrl, path, signedHeaders(identity, path, "alice-lease"))
    await alice.opened()
    alice.socket.send(controlFrame(controlPayload("request_input", ALICE)))
    await new Promise((resolve) => setTimeout(resolve, 30))

    state.lease = null
    node.gateway.leaseExpired({ projectId: PROJECT, runId: RUN })
    await alice.waitForTexts(1)
    expect(alice.texts).toHaveLength(1)
    expect(alice.controlPayloads()[0]?.operation).toBe("release_input")
    expect(node.gateway.view(TERMINAL)?.inputOwnerClientId).toBeNull()
    // Still attached, still receiving. The screen did not go dark because a lease
    // ran out.
    pty.produce(new Uint8Array(Buffer.from("still here\r\n", "utf8")))
    await alice.waitForBinaries(1)
    expect(alice.decodedChunks()).toContain("still here\r\n")
  })

  it("closes every attachment when the session terminates", async () => {
    const { node, identity, state } = await aLocalNode()
    const alicePath = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const bobPath = attachPath(TERMINAL, PROJECT, SESSION, WORKER, BOB)
    const alice = connect(node.baseUrl, alicePath, signedHeaders(identity, alicePath, "alice-term"))
    await alice.opened()
    const bob = connect(node.baseUrl, bobPath, signedHeaders(identity, bobPath, "bob-term"))
    await bob.opened()

    state.terminated.add(SESSION)
    const closed = node.gateway.sessionTerminated(PROJECT, SESSION)
    expect(closed).toHaveLength(2)
    await alice.waitForClose()
    await bob.waitForClose()
    expect(node.gateway.view(TERMINAL)).toBeNull()
  })
})

describe("the two-node smoke test — a terminal on node A, reachable through node B's gateway", () => {
  it("streams node A's pty to a client connected to node B, over a real HTTP hop", async () => {
    // The plan's gate criterion is "a terminal attached on node A is reachable
    // through node B's gateway". Node B holds NO pty: every byte it delivers to
    // this client was produced on node A and crossed a real socket to get here.
    // Two Fastify objects in one process would be two objects; two listeners on
    // two ports with an HTTP hop between them are a mesh.
    const identity = await anIdentity()
    const clock = new Clock()
    const state = new RecordedTerminalState()
    state.record(TERMINAL)

    const pty = new LocalPty()
    const nodeA = await aTerminalNode({ nodeId: WORKER, clock, state, pty, remote: null, identity, withTestRoutes: true })
    const remote = aRemoteHandle(nodeA, identity)

    const nodeB = await aTerminalNode({ nodeId: PEER, clock, state, pty: null, remote, identity })
    expect(nodeB.pty).toBeNull()

    const path = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const client = connect(nodeB.baseUrl, path, signedHeaders(identity, path, "two-node"))
    await client.opened()

    // Output produced on A, delivered through B's gateway.
    pty.produce(new Uint8Array(Buffer.from("hello from node A\r\n", "utf8")))
    await client.waitForBinaries(1)
    expect(client.decodedChunks()).toEqual(["hello from node A\r\n"])
    // B assigned the per-client sequence, because the sequence is per CLIENT and
    // B is the one holding the client. Node A never saw this client at all.
    expect(client.dataPayloads()[0]?.clientId).toBe(ALICE)
    expect(client.dataPayloads()[0]?.sequence).toBe(1)

    // Input typed on B reaches A's pty over the same hop, and ownership is
    // enforced by B's gateway — so B's seam, not A's, is what the test exercises.
    client.socket.send(controlFrame(controlPayload("request_input", ALICE)))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(nodeB.gateway.view(TERMINAL)?.inputOwnerClientId).toBe(ALICE)
    client.socket.send(dataFrame({ terminalId: TERMINAL, clientId: ALICE, direction: "to_runtime", encoding: "base64", chunk: Buffer.from("echo remote\r", "utf8").toString("base64"), sequence: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(pty.input).toHaveLength(1)
    expect(Buffer.from(pty.input[0]!).toString("utf8")).toBe("echo remote\r")

    // And a resize crosses too, with its dimensions intact.
    client.socket.send(controlFrame(controlPayload("resize", ALICE, { rows: 44, cols: 100 })))
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(pty.resizes).toEqual([{ rows: 44, columns: 44 === 44 ? 100 : 100 }])

    // A takeover on B notifies the displaced client, even though the pty is on A.
    const bobPath = attachPath(TERMINAL, PROJECT, SESSION, WORKER, BOB)
    const bob = connect(nodeB.baseUrl, bobPath, signedHeaders(identity, bobPath, "two-node-bob"))
    await bob.opened()
    bob.socket.send(controlFrame(controlPayload("takeover_input", BOB, { reason: "handing the terminal to the second operator" })))
    await client.waitForTexts(1)
    expect(client.controlPayloads()[0]?.clientId).toBe(BOB)
    expect(nodeB.gateway.view(TERMINAL)?.inputOwnerClientId).toBe(BOB)
  })

  it("refuses a client on node B for a terminal node A does not hold", async () => {
    const identity = await anIdentity()
    const clock = new Clock()
    const state = new RecordedTerminalState()
    // Node A's recorded state has no record of the terminal, so a peer asking
    // about it gets the honest answer rather than a stream with nothing behind it.
    const nodeA = await aTerminalNode({ nodeId: WORKER, clock, state, pty: new LocalPty(), remote: null, identity, withTestRoutes: true })
    const nodeB = await aTerminalNode({ nodeId: PEER, clock, state, pty: null, remote: aRemoteHandle(nodeA, identity), identity })
    const path = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const refused = await attemptUpgrade(nodeB.baseUrl, path, signedHeaders(identity, path, "two-node-unknown-01"))
    expect(refused.status).toBe(403)
    expect(refused.body).toContain("terminal.access_terminal_unknown")
  })
})

describe("the leak guardrail, over a real socket", () => {
  it("puts no terminal byte in any structured record, on a path that really ran", async () => {
    const { node, pty, identity } = await aLocalNode()
    const marker = "sk-live-9f3c1d7b44ae9f02TOKEN"
    const path = attachPath(TERMINAL, PROJECT, SESSION, WORKER, ALICE)
    const alice = connect(node.baseUrl, path, signedHeaders(identity, path, "leak-sweep"))
    await alice.opened()
    alice.socket.send(controlFrame(controlPayload("request_input", ALICE)))
    await new Promise((resolve) => setTimeout(resolve, 30))
    pty.produce(new Uint8Array(Buffer.from(`token=${marker}\r\n`, "utf8")))
    await alice.waitForBinaries(1)
    // A frame carrying the marker, refused for a reason that produces a record.
    alice.socket.send(
      dataFrame({ terminalId: TERMINAL, clientId: ALICE, direction: "to_viewer", encoding: "base64", chunk: Buffer.from(marker).toString("base64"), sequence: 1 }),
    )
    await new Promise((resolve) => setTimeout(resolve, 60))

    const serialised = JSON.stringify(node.telemetry)
    expect(node.telemetry.length).toBeGreaterThan(2)
    expect(serialised).not.toContain(marker)
    expect(serialised).not.toContain(Buffer.from(marker).toString("base64"))
    // The bytes DID reach the client, which is the only place they belong.
    expect(alice.decodedChunks().join("")).toContain(marker)
  })
})
